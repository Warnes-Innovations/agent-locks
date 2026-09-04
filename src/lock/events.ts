/**
 * Module: the append-only event log.
 *
 * WHAT THIS IS FOR, and why it is one log rather than several.
 *
 * Three separate needs converge on the same record:
 *   - staleness tuning needs the inter-touch interval of locks that were reaped,
 *     and — critically — whether each was later REOPENED, which labels it as a
 *     reap that should not have happened;
 *   - done-lock retention needs a never-pruned record of what was compacted away,
 *     or the audit it exists to serve starts lying by omission;
 *   - the pre-commit check needs somewhere to record refusals and overrides.
 *
 * Each of those could have had its own store. They must not: three stores holding
 * overlapping facts about the same locks is three things to keep in sync, and the
 * one that drifts is the one nobody reads. So this is a single JSONL log, one
 * event per line, discriminated by `event`.
 *
 * INVARIANTS — all three are load-bearing, do not relax them:
 *
 * 1. APPEND-ONLY, NEVER PRUNED. Retention (when it lands) may delete done LOCK
 *    files; it may never delete lines here. The whole point of compaction is that
 *    the markdown goes away and the line survives.
 *
 * 2. A LOGGING FAILURE MUST NEVER FAIL THE OPERATION IT DESCRIBES. Telemetry that
 *    can break a reap is worse than no telemetry: it converts an observability
 *    feature into an availability risk on the primary path. So appendEvent
 *    swallows its errors — and RECORDS them in lastEventLogErrors, because a
 *    swallowed error nobody surfaces is how "we have data" and "we have no data"
 *    become indistinguishable.
 *
 * 3. A CORRUPT LINE IS SKIPPED AND REPORTED, never fatal — the same discipline
 *    readAllRecords applies to lock files, for the same reason: one bad line must
 *    not make the whole log unreadable.
 *
 * The log lives inside the shared .git directory alongside the locks, so it is
 * automatically invisible to git and shared across every worktree.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const EVENTS_FILENAME = 'events.jsonl';

interface EventBase {
  /** UTC, same dashed format as lock timestamps. */
  ts: string;
  lock_id: string;
  repository: string;
}

/**
 * A lock was auto-reaped as stale.
 *
 * `idle_seconds` is the quantity the staleness threshold is actually about — the
 * gap since the last TOUCH, not the lock's age. Recording both matters because
 * they are routinely confused, and a threshold tuned against the wrong one is
 * tuned against nothing.
 */
export interface ReapEvent extends EventBase {
  event: 'reap';
  agent_id: string | null;
  created: string;
  /** The last-touch stamp as it stood BEFORE the reap overwrote it. */
  last_touch: string;
  age_seconds: number;
  idle_seconds: number;
  tasks_total: number;
  tasks_done: number;
  threshold_minutes: number;
}

/**
 * A done lock was returned to active.
 *
 * `verdict` is the measurement this record exists for. A reopen by the HOLDER of a
 * lock that REAP finished is direct evidence the threshold was too short for that
 * session, with the interval attached via `idle_at_reap_seconds`. The recovery path
 * doubles as the instrument, so no separate telemetry has to be kept alive.
 *
 * Read it with the false-negative rate in mind, which this log cannot measure: a
 * holder who never notices the lock vanished, or who re-claims instead of reopening,
 * produces no record at all. So the false-positive count is a LOWER BOUND on wrong
 * reaps, never an estimate of them.
 */
export interface ReopenEvent extends EventBase {
  event: 'reopen';
  agent_id: string | null;
  /** How the lock had been finished: 'reap' | 'holder' | 'force' | null if unknown (legacy). */
  finished_by: string | null;
  reason: string | null;
  /**
   * What this reopen says about the staleness threshold. NOT a boolean, because at
   * least four distinct situations were collapsing into `true`/`false` and only one
   * of them is evidence about the threshold:
   *
   * - `false-positive`   the holder came back for a lock REAP took. This, and only
   *                      this, is evidence the threshold was too short.
   * - `reaped-by-other`  a reaped lock reopened by somebody who is not the holder.
   *                      Says nothing about whether the reap was wrong.
   * - `not-a-reap`       revived from a deliberate finish. Not about the threshold.
   * - `unknown`          the lock predates provenance, so how it ended is not
   *                      recoverable. Must NOT be silently scored as either, which
   *                      is what a boolean forced — and it defaulted to the benign
   *                      reading, biasing the measurement toward "60 minutes is fine".
   */
  verdict: 'false-positive' | 'reaped-by-other' | 'not-a-reap' | 'unknown';
  /** Joined from this log's own most recent reap event for this lock; null if none. */
  idle_at_reap_seconds: number | null;
}

/**
 * A lock was touched while ALIVE — the observation the threshold actually needs.
 *
 * WHY THIS EXISTS, and why the log was useless without it. Reap events carry
 * `idle_seconds >= threshold` BY CONSTRUCTION, so a log of reaps alone contains no
 * observation of an interval below the threshold. It can argue the threshold up and
 * never down, which means it cannot settle a question stated as "unvalidated in both
 * directions". The distribution that matters is the gap between touches on locks that
 * turned out to be alive, and this is the only place it is recorded.
 */
export interface TouchEvent extends EventBase {
  event: 'touch';
  agent_id: string | null;
  /** Seconds since this lock's PREVIOUS touch. The datum the threshold is about. */
  idle_seconds: number;
  /** Which operation bumped it: a task/scope/note update, a bare heartbeat, or the closing finish. */
  via: 'update' | 'heartbeat' | 'finish';
  tasks_total: number;
  tasks_done: number;
}

export type LockEvent = ReapEvent | ReopenEvent | TouchEvent;

/** A log line that could not be parsed. Reported, never silently dropped. */
export interface EventLogError {
  /** 'append' when a write failed, 'read' when a line would not parse. */
  phase: 'append' | 'read';
  reason: string;
}

/**
 * Errors from the most recent event-log operation.
 *
 * Consumed by the CLI's warn banner (`warnEventLog`) on every command that reads OR
 * writes the log. That wiring is not decoration: a previous version of this codebase
 * recorded unreadable LOCKS into a module variable with zero consumers, so the
 * condition was detected and then discarded. Anything added here must be surfaced
 * somewhere a caller sees.
 *
 * NOT yet surfaced over MCP — an earlier version of this comment claimed it was, and
 * `server.ts` did not so much as import this module. State the gap rather than the
 * intention: an agent calling lock_reap over MCP currently cannot tell a logged reap
 * from an unlogged one.
 */
export let lastEventLogErrors: EventLogError[] = [];

export function eventsPath(locksRoot: string): string {
  return path.join(locksRoot, EVENTS_FILENAME);
}

/**
 * Appends one event. Never throws — see invariant 2 above.
 *
 * Uses a single `appendFile` call with the line built up front, which opens with
 * O_APPEND so each write is positioned atomically at the current end of file.
 *
 * DO NOT restate the old justification here: it claimed POSIX guarantees atomicity
 * below PIPE_BUF, which is 512 on macOS while a real reap event measures ~520 bytes —
 * so the cited guarantee did not even cover this log's own records. Interleaving was
 * measured clean at 12 concurrent writers up to 64 KiB, but by the filesystem's
 * behaviour rather than by the standard invoked. A reader must tolerate a torn line
 * regardless, which `readEvents` does: it skips and reports one.
 */
export async function appendEvent(locksRoot: string, event: LockEvent): Promise<void> {
  try {
    await fs.mkdir(locksRoot, { recursive: true });
    await fs.appendFile(eventsPath(locksRoot), JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    lastEventLogErrors = [
      ...lastEventLogErrors,
      { phase: 'append', reason: err instanceof Error ? err.message : String(err) },
    ];
  }
}

export interface ReadEventsOptions {
  /** Only return events of this type. */
  type?: LockEvent['event'];
  /** Only return events for this lock id. */
  lock_id?: string;
  /** Return at most this many events, taking the MOST RECENT ones. */
  limit?: number;
}

/**
 * Reads the log back. Returns oldest-first (the order they were written).
 *
 * A missing log is an empty log, not an error — a repo where nothing has been
 * reaped yet is the normal case, not a fault.
 */
export async function readEvents(locksRoot: string, options: ReadEventsOptions = {}): Promise<LockEvent[]> {
  lastEventLogErrors = [];
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath(locksRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    lastEventLogErrors = [{ phase: 'read', reason: err instanceof Error ? err.message : String(err) }];
    return [];
  }

  const events: LockEvent[] = [];
  const errors: EventLogError[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push({ phase: 'read', reason: `line ${i + 1}: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    // Validate the discriminator specifically. A line that parses as JSON but is
    // not an event is still a corrupt line, and treating it as one is how a
    // half-migrated or hand-edited log stays legible instead of poisoning a scan.
    const candidate = parsed as Partial<LockEvent>;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      (candidate.event !== 'reap' && candidate.event !== 'reopen' && candidate.event !== 'touch') ||
      typeof candidate.lock_id !== 'string'
    ) {
      errors.push({ phase: 'read', reason: `line ${i + 1}: not a recognised lock event` });
      continue;
    }
    events.push(candidate as LockEvent);
  }

  lastEventLogErrors = errors;

  let result = events;
  if (options.type !== undefined) result = result.filter((e) => e.event === options.type);
  if (options.lock_id !== undefined) result = result.filter((e) => e.lock_id === options.lock_id);
  if (options.limit !== undefined && result.length > options.limit) result = result.slice(-options.limit);
  return result;
}

/**
 * The most recent reap event for a lock, or null.
 *
 * Used to attach the reap-time idle interval to a reopen, so the false-positive
 * record is self-contained and a later analysis never has to re-join the log.
 */
export async function lastReapEventFor(locksRoot: string, lockId: string): Promise<ReapEvent | null> {
  const events = await readEvents(locksRoot, { type: 'reap', lock_id: lockId });
  if (events.length === 0) return null;
  return events[events.length - 1] as ReapEvent;
}
