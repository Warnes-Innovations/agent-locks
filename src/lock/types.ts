/** Module: core data shapes for a single agent-locks lock file. */
import { parseTimestamp } from '../timestamp.js';

export type LockStatus = 'active' | 'done';

/**
 * Default staleness threshold, in minutes, used when the caller doesn't
 * specify one and AGENT_LOCKS_STALE_MINUTES isn't set (see store.ts
 * resolveStaleMinutes). An hour is deliberately generous — a human
 * legitimately pausing mid-task should not see their own lock flip stale;
 * this is meant to catch abandoned/crashed work, not brief inactivity.
 */
export const DEFAULT_STALE_MINUTES = 60;

export interface LockFrontmatter {
  /**
   * Canonical id for this lock. By design this is exactly the filename
   * minus its `.md` extension (see README "Timestamp format" for why we
   * chose not to let these drift independently) — e.g. filename
   * `2026-07-17T18-45-12-hindsight-route-tests.md` has
   * `id: 2026-07-17T18-45-12-hindsight-route-tests`.
   */
  id: string;
  /**
   * The calling agent's own id, if it happens to know one from its own
   * context. There is no mechanism for this server to auto-detect it —
   * see README "Honest agent_id / parent_agent_id semantics".
   */
  agent_id: string | null;
  /** The id of whatever spawned the calling agent, if known. Same caveat as agent_id. */
  parent_agent_id: string | null;
  status: LockStatus;
  /** UTC timestamp, same format as timestamp.ts formatTimestamp(). */
  created: string;
  /** UTC timestamp, same format as timestamp.ts formatTimestamp(). Bumped on every mutation. */
  updated: string;
  /** Glob patterns describing which files/paths this lock claims. */
  scope: string[];
  /**
   * Resolved repository root path — the directory returned by
   * `git rev-parse --show-toplevel` when the lock was created. Lets an agent
   * reading a lock summary tell which repository it governs without inferring
   * it from the scope glob. Empty string on lock files created before this
   * field was added (backward compatibility).
   */
  repository: string;
  /**
   * HOW this lock reached `done` — 'holder' (its owner finished it), 'force'
   * (someone else finished it deliberately), or 'reap' (nobody was heard from and
   * it was cleaned up automatically). Null while active, and absent on locks
   * written before this field existed.
   *
   * This is provenance, not decoration. Two things depend on telling a reap from a
   * deliberate finish, and neither can recover it from anywhere else:
   *   - `reopen` is allowed without a reason ONLY for a reap, because reviving a
   *     lock its owner deliberately closed is a different act from recovering one
   *     that was taken from a live session;
   *   - a reopened reap is a LABELLED false positive for the staleness threshold,
   *     which is the only direct evidence that the threshold is wrong.
   *
   * It was briefly tempting to infer this by matching the auto-reap note text.
   * Don't: note text is prose, prose gets reworded, and the inference would then
   * fail silently in the direction of "looks deliberate".
   */
  finished_by?: 'holder' | 'force' | 'reap' | null;
}

export interface LockTask {
  text: string;
  done: boolean;
}

/** A lock file fully parsed into structured data (frontmatter + body). */
export interface ParsedLock {
  frontmatter: LockFrontmatter;
  title: string;
  tasks: LockTask[];
  /** Free-text bullet lines under the `## Notes` heading, oldest first. */
  notes: string[];
}

/** A ParsedLock plus where it currently lives on disk. */
export interface LockRecord extends ParsedLock {
  filePath: string;
}

/** The compact shape returned by lock_query — never the full body text. */
export interface LockSummary {
  id: string;
  title: string;
  status: LockStatus;
  percentComplete: number;
  scope: string[];
  repository: string;
  agent_id: string | null;
  parent_agent_id: string | null;
  /**
   * True when this lock is ACTIVE and hasn't been touched (created,
   * lock_update, or an explicit lock_heartbeat) in longer than the
   * staleness threshold. Always false for a `done` lock — staleness is a
   * property of abandoned in-progress work, not of finished work.
   * Computed fresh on every call; never stored, never mutated as a side
   * effect of computing it (see store.ts "no database, no in-memory
   * cache" — the same principle applies here: reading never mutates).
   */
  stale: boolean;
  /** Seconds since this lock's `updated` field, for display/sorting. Always >= 0. */
  staleForSeconds: number;
  /**
   * Provenance of the `done` transition — see LockFrontmatter.finished_by.
   * Null while active, and null on locks written before the field existed, which
   * is why callers must treat null as "not recorded" rather than "deliberate".
   */
  finished_by: 'holder' | 'force' | 'reap' | null;
}

export function computePercentComplete(tasks: LockTask[]): number {
  if (tasks.length === 0) return 100;
  const done = tasks.filter((t) => t.done).length;
  return Math.round((done / tasks.length) * 100);
}

export interface StalenessOptions {
  /** Defaults to DEFAULT_STALE_MINUTES (see store.ts resolveStaleMinutes for the env-var-aware resolution agents should actually use). */
  staleMinutes?: number;
  /** Defaults to `new Date()`. Injectable so tests don't depend on wall-clock time. */
  now?: Date;
}

export function toSummary(record: LockRecord, options: StalenessOptions = {}): LockSummary {
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const now = options.now ?? new Date();
  const updatedAt = parseTimestamp(record.frontmatter.updated);
  const staleForMs = Math.max(0, now.getTime() - updatedAt.getTime());
  const staleForSeconds = Math.round(staleForMs / 1000);
  const stale = record.frontmatter.status === 'active' && staleForMs > staleMinutes * 60_000;

  return {
    id: record.frontmatter.id,
    title: record.title,
    status: record.frontmatter.status,
    percentComplete: computePercentComplete(record.tasks),
    scope: record.frontmatter.scope,
    repository: record.frontmatter.repository ?? '',
    agent_id: record.frontmatter.agent_id,
    parent_agent_id: record.frontmatter.parent_agent_id,
    stale,
    staleForSeconds,
    finished_by: record.frontmatter.finished_by ?? null,
  };
}
