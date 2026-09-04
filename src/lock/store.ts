/**
 * Module: filesystem-backed CRUD + query operations for lock files.
 *
 * There is no database and no in-memory cache here on purpose (see README
 * "No database, no in-memory state") — every exported function reads
 * whatever is currently on disk at call time, so multiple agents (or
 * multiple server processes) always see each other's latest writes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatTimestamp, parseTimestamp, slugify } from '../timestamp.js';
import { parseLockFile, serializeLockFile } from './markdown.js';
import { scopesOverlap } from './globOverlap.js';
import { appendEvent, lastReapEventFor, recordEventLogFailure } from './events.js';
import type { TouchEvent, ReopenVerdict } from './events.js';
import { computePercentComplete, toSummary, DEFAULT_STALE_MINUTES } from './types.js';
import type { LockFrontmatter, LockRecord, LockSummary, LockTask } from './types.js';

const DONE_SUBDIR = 'done';
const STALE_MINUTES_ENV_VAR = 'AGENT_LOCKS_STALE_MINUTES';

/**
 * Resolves the staleness threshold (in minutes) an agent should actually
 * use, in priority order: an explicit override passed by the caller, then
 * AGENT_LOCKS_STALE_MINUTES from the environment (read fresh on every call,
 * never cached — same "no stale cached assumptions" principle as
 * resolveLocksRoot in git.ts), then DEFAULT_STALE_MINUTES.
 *
 * A non-numeric or non-positive env value is treated as unset (falls back
 * to the default) rather than throwing, so a malformed environment can
 * never make every query fail — staleness is an informational feature, not
 * a load-bearing one, and should degrade gracefully.
 */
export function resolveStaleMinutes(override?: number): number {
  if (override !== undefined) return override;
  const raw = process.env[STALE_MINUTES_ENV_VAR];
  if (raw === undefined) return DEFAULT_STALE_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
}


/**
 * Does a stored agent_id match the one being queried?
 *
 * Exact string equality is WRONG here, and the failure is silent. Sessions record
 * their identity as `Name [ref]`, and the NAME IS MUTABLE — a session renamed
 * mid-work leaves locks under its old label, so an exact match returns nothing for
 * a holder that is alive and working. That is not a missing result: callers read it
 * as "no lock", which is how a renamed holder gets its own commit refused, and how
 * "who holds this path?" answers nobody.
 *
 * So: match on the REF when both sides carry one (the ref is stable), accept a bare
 * ref against a full label, and fall back to exact equality otherwise. Deliberately
 * NOT a substring match — that would make one agent's query match another whose name
 * merely contains it.
 */
export function agentMatches(stored: string | null, query: string | null): boolean {
  // A null query is a real query: "locks nobody claimed ownership of". Most existing
  // locks have agent_id null, so this is the common case, not an edge one.
  if (query === null) return stored === null;
  if (stored === null) return false;
  if (stored.trim().toLowerCase() === query.trim().toLowerCase()) return true;

  // A SESSION REF, not "whatever is in the last brackets".
  //
  // TWO WRONG VERSIONS PRECEDED THIS, in opposite directions — worth recording, because
  // the middle is narrow:
  //  1. Any trailing [...] counted, so `--agent 'Codex [main]'` matched `Claude [main]`.
  //  2. Requiring hex `[0-9a-f]{4,}` rejected legitimate refs — `[w7x2k9]`, `[48]`,
  //     `[a1b2-c3d4]` all stopped matching. That alphabet was invented here and appears
  //     in no document; constraining an identifier format we do not own is how a
  //     matcher silently stops finding real holders.
  //
  // So: ref-shaped token AND at least one digit. The digit is the discriminator that
  // both previous attempts lacked — every real session ref carries one (bd9522, w7x2k9,
  // 48, a1b2-c3d4) and the bracketed WORDS that caused the false positives do not
  // (main, beef). It admits refs the hex rule wrongly rejected without admitting words.
  //
  // KNOWN LIMIT, stated rather than hidden: an all-letter ref would be rejected and
  // fall back to exact matching, and two sessions genuinely sharing a ref would still
  // match each other. Neither is solvable in a matcher — identity here is self-asserted
  // and documented as unverified, so this narrows accidents, not impersonation.
  const SESSION_REF = /^(?=.*\d)[A-Za-z0-9_-]{2,}$/;
  const refOf = (v: string): string | null => {
    const m = /\[([^\]]+)\]\s*$/.exec(v.trim());
    if (!m) {
      const bare = v.trim();
      return SESSION_REF.test(bare) ? bare : null;
    }
    const inner = m[1]!.trim();
    return SESSION_REF.test(inner) ? inner : null;
  };

  const storedRef = refOf(stored);
  const queryRef = refOf(query);
  // Case-insensitive per critical rule 8: record verbatim, compare without case.
  // Matching on the REF and not the name is the whole point — names are mutable.
  // Symmetric, so a bare ref finds a labelled lock AND a labelled query finds a
  // bare-ref lock; an earlier version only handled one direction.
  if (storedRef !== null && queryRef !== null) {
    return storedRef.toLowerCase() === queryRef.toLowerCase();
  }
  return false;
}

export class LockNotFoundError extends Error {
  constructor(lockId: string) {
    super(`No lock found with id "${lockId}".`);
    this.name = 'LockNotFoundError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(lockId: string, taskText: string, availableTasks: string[]) {
    super(
      `Lock "${lockId}" has no task with the exact text "${taskText}". ` +
        `Available tasks on this lock: ${
          availableTasks.length > 0 ? availableTasks.map((t) => `"${t}"`).join(', ') : '(none)'
        }. task_text must match an existing task exactly (this tool does not do fuzzy/partial matching).`,
    );
    this.name = 'TaskNotFoundError';
  }
}

export class LockNotOwnedError extends Error {
  constructor(lockId: string, holder: string, caller: string) {
    super(
      `Lock "${lockId}" is held by ${holder}, not by ${caller}. Refusing to finish another ` +
        `session's live claim — that is the failure this system exists to prevent, and ` +
        `finishing it silently is how uncommitted work loses its only marker. ` +
        `Coordinate with the holder first. If you genuinely must end their claim: ` +
        `--force on the CLI, or force:true via MCP. Either is allowed, and either is ` +
        `recorded in the archive.`,
    );
    this.name = 'LockNotOwnedError';
  }
}

export class DuplicateLockIdError extends Error {
  constructor(lockId: string, destination: string, what: string) {
    super(
      `Refusing to ${what} lock "${lockId}": ${destination} already exists. Moving onto it would destroy that lock ` +
        `— its scope, checklist, owner and progress — with no way to recover it. Two lock files share this id, which ` +
        `should be impossible; inspect the store by hand rather than letting a move pick a winner.`,
    );
    this.name = 'DuplicateLockIdError';
  }
}

export class ArchivedLockImmutableError extends Error {
  constructor(lockId: string) {
    super(
      `Lock "${lockId}" is in the done archive and cannot be updated in place. The archive is the record of what was ` +
        `claimed, by whom, and how it ended; rewriting it silently changes that record with nothing to say so. ` +
        `If it genuinely needs to change, reopen it first — that transition is recorded.`,
    );
    this.name = 'ArchivedLockImmutableError';
  }
}

export class LockNotActiveError extends Error {
  constructor(lockId: string) {
    super(`Lock "${lockId}" is not active (it may already be finished), so it cannot be finished again.`);
    this.name = 'LockNotActiveError';
  }
}

function activeDir(locksRoot: string): string {
  return locksRoot;
}

function doneDir(locksRoot: string): string {
  return path.join(locksRoot, DONE_SUBDIR);
}

async function ensureDirs(locksRoot: string): Promise<void> {
  await fs.mkdir(doneDir(locksRoot), { recursive: true });
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((name) => name.endsWith('.md')).map((name) => path.join(dir, name));
}

async function readRecord(filePath: string): Promise<LockRecord> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = parseLockFile(raw);
  return { ...parsed, filePath };
}

/**
 * Writes a lock ATOMICALLY: full contents to a temp file in the same directory,
 * then rename over the target. Rename is atomic within a filesystem, so a reader
 * sees either the old file or the new one — never a half-written one.
 *
 * WHY THIS IS NOT A PLAIN writeFile (do not "simplify" it back):
 * a partial write leaves a lock whose frontmatter will not parse, and one
 * unparseable lock used to throw for the WHOLE store — so every query, conflict
 * check and reap in that repo failed. An ordinary Ctrl-C during a write was
 * enough to reach that state, and the pre-commit check that consumes this store
 * fails open, which turned it into silent repo-wide non-enforcement rather than
 * a visible error. Found by committee review 2026-09-03.
 *
 * The temp file lives in the SAME directory as the target because rename() is
 * only atomic within one filesystem; via os.tmpdir() it can cross a mount and
 * silently degrade to a copy.
 */
async function writeRecord(record: LockRecord): Promise<void> {
  const contents = serializeLockFile(record);
  const dir = path.dirname(record.filePath);
  await fs.mkdir(dir, { recursive: true });
  // The temp name must be unique PER CALL, not per process: two concurrent writes to
  // the same record inside one process would otherwise pick the same temp path, and
  // the loser's rename fails with ENOENT after the winner consumed it. Serialization
  // above makes that rare; a unique name makes it impossible.
  const tmpPath = path.join(
    dir,
    `.${path.basename(record.filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, contents, 'utf8');
    await fs.rename(tmpPath, record.filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Set by reapStaleLocks when the configured floor RAISED the caller's requested
 * threshold, so a caller can report what actually ran rather than what was asked for.
 * null when the request was honoured as given.
 */
export let lastReapFloor: { requested: number; applied: number } | null = null;

/**
 * How many candidates the most recent reap DID NOT take because they stopped being
 * stale (or were finished by someone else) while it queued for their lock.
 *
 * Reported rather than silently dropped: "found 3 stale, reaped 1" is a different
 * statement from "found 1 stale", and a caller that cannot tell them apart cannot
 * tell a healthy race from a broken query.
 */
export let lastReapSkipped = 0;

/** A lock file that could not be read or parsed. Reported, never silently skipped. */
export interface UnreadableLock {
  filePath: string;
  reason: string;
}

/**
 * Lock files that failed to parse on the most recent readAllRecords call.
 * Callers that report status (CLI `status`, MCP lock_query) should surface these:
 * a lock nobody can read is a claim nobody can see, and silently dropping it
 * would make an unreadable store indistinguishable from an empty one.
 */
export let lastUnreadableLocks: UnreadableLock[] = [];

async function readAllRecords(locksRoot: string, status: 'active' | 'done' | 'all'): Promise<LockRecord[]> {
  const dirs: string[] = [];
  if (status === 'active' || status === 'all') dirs.push(activeDir(locksRoot));
  if (status === 'done' || status === 'all') dirs.push(doneDir(locksRoot));

  const files = (await Promise.all(dirs.map(listMarkdownFiles))).flat();

  // One corrupt lock must not take down the whole store. Before this, a single
  // truncated or zero-byte file made every read throw, and the consuming check
  // fails open — so the failure presented as "no locks anywhere" rather than as
  // an error. Skip the unreadable one, keep the rest, and RECORD it so the
  // condition is reportable instead of silent.
  const records: LockRecord[] = [];
  const unreadable: UnreadableLock[] = [];
  for (const filePath of files) {
    try {
      const record = await readRecord(filePath);
      // readRecord does NOT throw on a truncated or empty file — it returns a record
      // whose frontmatter fields are undefined, and the failure then surfaces far away
      // (parseTimestamp on a `stale` computation, or scopesOverlap iterating a missing
      // scope array). Verified by running it against a zero-byte lock. So VALIDATE
      // here; catching around the read alone never fires.
      const fm = record.frontmatter as Partial<LockRecord['frontmatter']> | undefined;
      const missing: string[] = [];
      if (!fm) missing.push('frontmatter');
      else {
        // Validate EXACTLY what the downstream parser requires, not something looser.
        // An earlier attempt accepted a Date-typed value (js-yaml types colon-form
        // ISO-8601 that way) on the theory that it was "well-formed enough" — but
        // parseTimestamp then threw in toSummary, so the fix only MOVED the failure
        // from a reported skip to an uncaught crash. Verified by running it.
        //
        // agent-locks only ever writes the dashed form, so a colon-form stamp is not a
        // lock this tool produced. Rejecting it here is correct — and it is no longer
        // silent, because unreadable locks are now reported (see warnUnreadable in the
        // CLI and unreadable_locks in lock_query).
        const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
        const isStamp = (v: unknown): boolean => typeof v === 'string' && STAMP.test(v.trim());
        if (typeof fm.id !== 'string') missing.push('id');
        if (!isStamp(fm.created)) missing.push('created');
        if (!isStamp(fm.updated)) missing.push('updated');
        if (fm.status !== 'active' && fm.status !== 'done') missing.push('status');
        if (!Array.isArray(fm.scope)) missing.push('scope');
      }
      if (missing.length > 0) {
        unreadable.push({ filePath, reason: `malformed lock: missing or invalid ${missing.join(', ')}` });
        continue;
      }
      records.push(record);
    } catch (err) {
      unreadable.push({ filePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  lastUnreadableLocks = unreadable;
  return records;
}


/**
 * How long a mutation lockfile is honoured before another waiter may break it.
 *
 * A process that dies mid-mutation leaves its lockfile behind. Without a break the
 * store would wedge forever on a crash — turning one crash into a permanent outage of
 * the coordination tool. Generous relative to a mutation, which is a few file
 * operations, and short relative to a human noticing.
 */
const MUTATION_LOCK_STALE_MS = 30_000;

/**
 * How long a waiter queues before giving up.
 *
 * MUST exceed MUTATION_LOCK_STALE_MS, and that is a correctness constraint rather than
 * a tuning preference. When the two were equal, a waiter reached its deadline at the
 * exact moment it became entitled to break the lock, so whichever comparison ran first
 * decided the outcome. Measured: `update` exiting 0 after 30s having deleted the live
 * holder's lockfile.
 */
const MUTATION_LOCK_WAIT_MS = MUTATION_LOCK_STALE_MS * 3;

export class MutationLockTimeoutError extends Error {
  constructor(lockId: string, lockPath: string) {
    super(
      `Timed out after ${MUTATION_LOCK_WAIT_MS / 1000}s waiting to mutate "${lockId}": another process holds ` +
        `${lockPath} and is still refreshing it. Refusing rather than writing concurrently, which would ` +
        `silently discard one of the two changes. If no such process exists, remove that file by hand.`,
    );
    this.name = 'MutationLockTimeoutError';
  }
}

/**
 * Serializes read-modify-write on ONE lock file across processes.
 *
 * WHY THIS IS NOT OPTIONAL. Every mutator here reads the record, changes it in memory,
 * and writes it back. Two concurrent mutations therefore both read the same starting
 * state and the second write erases the first — and because each caller is told what IT
 * wrote, both are told they succeeded. Measured before this existed: 50 concurrent
 * processes, 36 acknowledged writes lost.
 *
 * TAKING THE LOCK IS ONLY HALF OF IT: every caller must also RE-READ the record inside
 * the callback. A record read before the lock was held is exactly the stale starting
 * state this exists to prevent, and a caller that skips the re-read is unserialized in
 * effect while looking serialized. `reapStaleLocks` did precisely that, and archived a
 * lock whose holder had just heartbeated successfully.
 *
 * THREE PROPERTIES, each bought by a demonstrated failure:
 *
 * 1. ATOMIC ACQUISITION — `open(..., 'wx')` is O_CREAT|O_EXCL, so exactly one creator
 *    wins. (NFS caveats do not apply to a local .git directory.)
 * 2. OWNERSHIP TOKEN — the lockfile CONTAINS a unique token and the holder verifies it
 *    before releasing. Without this, a holder that was broken in on deletes the NEW
 *    holder's lockfile on its way out, admitting a third party: two simultaneous
 *    holders and a lost update, the signature this mechanism exists to eliminate.
 * 3. LIVENESS REFRESH — the holder touches its lockfile's mtime while working, so a
 *    slow-but-alive critical section is not mistaken for a dead one. Staleness is meant
 *    to detect a dead process, not a busy one.
 */
async function withRecordLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.dirname(filePath);
  const lockPath = path.join(dir, `.${path.basename(filePath)}.mutation.lock`);
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 12)}`;
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;

  for (;;) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(token, 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > MUTATION_LOCK_STALE_MS) {
          // Break an abandoned lockfile rather than wedging the store on a crash.
          // Only one breaker can then win the exclusive create above.
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // it vanished between EEXIST and stat: retry immediately
      }
      if (Date.now() > deadline) throw new MutationLockTimeoutError(path.basename(filePath), lockPath);
      // Jittered backoff so N waiters do not retry in lockstep.
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }

  // Keep the lockfile visibly alive while we work, so a long critical section is not
  // mistaken for a dead process by a waiter applying the staleness rule.
  const keepAlive = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => {});
  }, Math.floor(MUTATION_LOCK_STALE_MS / 3));
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
    // Release ONLY if we still own it. If we were broken in on, the lockfile now
    // belongs to someone else and removing it would admit a second writer.
    try {
      const held = await fs.readFile(lockPath, 'utf8');
      if (held === token) await fs.rm(lockPath, { force: true });
    } catch {
      // Already gone, or unreadable: nothing of ours left to release.
    }
  }
}

/**
 * Records that a live lock was touched, with the gap since its PREVIOUS touch.
 *
 * This is the observation the staleness threshold is actually about. Reap events
 * carry an interval that exceeded the threshold by construction, so without these the
 * log can only ever argue the threshold UP — it holds no observation of a live lock
 * going quiet for less than the threshold. Call this with the PRE-mutation `updated`
 * stamp, before it is overwritten.
 */
async function recordTouch(
  locksRoot: string,
  record: LockRecord,
  previousUpdated: string,
  via: TouchEvent['via'],
  actor: string | null | undefined,
): Promise<void> {
  // NEVER THROW. This runs AFTER the record has already been written, so an exception
  // here reports failure for a mutation that actually landed — `update` exited 1 with
  // a raw stack trace having appended the note and bumped `updated`. Telemetry may not
  // fail the operation it describes; that is invariant 2 of the event log, and it has
  // to hold on this side of the call too, because parseTimestamp throws on a stamp
  // this function did not write.
  try {
    const idleMs = Date.now() - parseTimestamp(previousUpdated).getTime();
    const holder = record.frontmatter.agent_id;
    await appendEvent(locksRoot, {
      event: 'touch',
      ts: record.frontmatter.updated,
      lock_id: record.frontmatter.id,
      repository: record.frontmatter.repository ?? '',
      agent_id: holder,
      actor: actor ?? null,
      // Only assert "foreign" when BOTH sides are known and differ. Unknown is not
      // evidence of either, and recording it as `false` is how a foreign mutation
      // became invisible in the first place.
      foreign: actor != null && holder != null && !agentMatches(holder, actor),
      idle_seconds: Math.max(0, Math.round(idleMs / 1000)),
      via,
      tasks_total: record.tasks.length,
      tasks_done: record.tasks.filter((t) => t.done).length,
    });
  } catch (err) {
    recordEventLogFailure(err);
  }
}

/**
 * Reads a record, converting the two ordinary concurrent-store conditions into a
 * caller-meaningful outcome instead of a raw exception.
 *
 * `null` means "not usable": the file vanished (another process archived it) or it will
 * not parse. Both were previously raw ENOENT/YAMLException escaping from the mutators
 * and naming an unrelated lock — and the corrupt-lock tolerance added to readAllRecords
 * covered only the READ surfaces, so the documented promise that "a corrupt lock no
 * longer breaks the store" was false for update, finish, heartbeat and reopen.
 */
async function tryReadRecord(filePath: string): Promise<LockRecord | null> {
  try {
    return await readRecord(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    lastUnreadableLocks = [
      ...lastUnreadableLocks,
      { filePath, reason: err instanceof Error ? err.message : String(err) },
    ];
    return null;
  }
}

/** Finds a lock by id, searching active first, then done. Returns null if not found in either. */
async function findRecordById(locksRoot: string, lockId: string): Promise<LockRecord | null> {
  for (const dir of [activeDir(locksRoot), doneDir(locksRoot)]) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const record = await tryReadRecord(filePath);
      if (record !== null && record.frontmatter.id === lockId) return record;
    }
  }
  return null;
}

/**
 * Writes a NEW lock, choosing the first free id, in ONE atomic step per attempt.
 *
 * TWO FAILURES SHAPED THIS — do not "simplify" it back to probe-then-write.
 *
 * 1. CHECKING ONLY THE ACTIVE DIR LOSES DATA. An id becomes free again the moment its
 *    lock is archived, so a later claim in the same second with the same title is
 *    issued the SAME id as an archived lock; `reopen` then renames `done/<id>.md` over
 *    `active/<id>.md` and the live claim is gone, exit 0, no warning.
 *
 * 2. PROBING FOR A FREE NAME AND THEN WRITING IT IS A TOCTOU. 50 concurrent claims
 *    produced 31 unique ids: the losers each held an id for a claim that no longer
 *    existed, all reporting success. An intermediate fix reserved the id by creating
 *    an EMPTY file first — which fixed the race and introduced a worse artefact,
 *    because a process killed between reserve and write left a zero-byte `.md` that
 *    every reader reports as a corrupt lock, forever, with nothing able to clean it.
 *
 * So the full contents are written by the same `open(..., 'wx')` that claims the name.
 * There is no window in which a file exists without being a valid lock.
 */
async function writeNewLock(
  activeDirPath: string,
  doneDirPath: string,
  timestamp: string,
  slug: string,
  build: (id: string) => LockRecord,
): Promise<{ record: LockRecord; id: string }> {
  let suffix = 0;
  for (;;) {
    const candidateId = suffix === 0 ? `${timestamp}-${slug}` : `${timestamp}-${slug}-${suffix + 1}`;

    // The archive is checked by a plain probe: an archived id is never re-issued, and
    // nothing else is competing to create files in there.
    let archived = false;
    try {
      await fs.access(path.join(doneDirPath, `${candidateId}.md`));
      archived = true;
    } catch {
      archived = false;
    }
    if (archived) {
      suffix += 1;
      continue;
    }

    const filePath = path.join(activeDirPath, `${candidateId}.md`);
    const record = build(candidateId);
    record.filePath = filePath;
    const contents = serializeLockFile(record);
    try {
      const handle = await fs.open(filePath, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
      } finally {
        await handle.close();
      }
      return { record, id: candidateId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      suffix += 1;
    }
  }
}

/**
 * Refuses to rename a lock file over an existing one.
 *
 * Belt and suspenders with uniqueFilePath above: that one stops the id from being
 * REISSUED, this one stops a move from silently clobbering if a duplicate ever
 * arises another way (a hand-edited store, a restored backup, two processes
 * racing). A destructive move must never be the fallback for an unexpected state.
 */
async function assertDestinationFree(destination: string, lockId: string, what: string): Promise<void> {
  try {
    await fs.access(destination);
  } catch {
    return; // ENOENT: free, as expected
  }
  throw new DuplicateLockIdError(lockId, destination, what);
}

export interface CreateLockParams {
  title: string;
  scope: string[];
  tasks: string[];
  agent_id?: string | null;
  parent_agent_id?: string | null;
  /** Canonical repository root path, recorded at creation time so lock summaries always carry it. Defaults to empty string for backward compat. */
  repository?: string;
}

export interface CreateLockResult {
  id: string;
  filePath: string;
}

export async function createLock(locksRoot: string, params: CreateLockParams): Promise<CreateLockResult> {
  await ensureDirs(locksRoot);
  const now = formatTimestamp();
  const slug = slugify(params.title);

  const { id, record } = await writeNewLock(activeDir(locksRoot), doneDir(locksRoot), now, slug, (candidateId) => {
    const frontmatter: LockFrontmatter = {
      id: candidateId,
      agent_id: params.agent_id ?? null,
      parent_agent_id: params.parent_agent_id ?? null,
      status: 'active',
      created: now,
      updated: now,
      scope: params.scope,
      repository: params.repository ?? '',
      // Written explicitly as null rather than left absent, so an active lock and a
      // pre-provenance legacy lock are distinguishable on disk. Both read back as
      // null; only one of them was ever written by a version that knew the field.
      finished_by: null,
    };
    return {
      filePath: '', // set by writeNewLock once the id is settled
      frontmatter,
      title: params.title,
      tasks: params.tasks.map((text): LockTask => ({ text, done: false })),
      notes: [],
    };
  });

  return { id, filePath: record.filePath };
}

export interface QueryLocksParams {
  status?: 'active' | 'done' | 'all';
  scope?: string | string[];
  agent_id?: string | null;
  text?: string;
  /** Staleness threshold override, in minutes. Defaults per resolveStaleMinutes(). */
  stale_minutes?: number;
}

/**
 * Hard requirement: when `status` is omitted, done locks MUST be excluded.
 * `readAllRecords`'s default branch below is what enforces that — see the
 * accompanying test `query excludes done locks by default`.
 */
export async function queryLocks(locksRoot: string, params: QueryLocksParams): Promise<LockSummary[]> {
  const status = params.status ?? 'active';
  const records = await readAllRecords(locksRoot, status);

  const scopeFilter = params.scope === undefined ? undefined : ([] as string[]).concat(params.scope);
  const textFilter = params.text?.trim().toLowerCase();

  const filtered = records.filter((record) => {
    if (params.agent_id !== undefined && !agentMatches(record.frontmatter.agent_id, params.agent_id)) {
      return false;
    }
    if (scopeFilter && !scopesOverlap(scopeFilter, record.frontmatter.scope)) {
      return false;
    }
    if (textFilter) {
      const haystack = [record.title, ...record.notes].join('\n').toLowerCase();
      if (!haystack.includes(textFilter)) return false;
    }
    return true;
  });

  const staleMinutes = resolveStaleMinutes(params.stale_minutes);
  return filtered.map((record) => toSummary(record, { staleMinutes }));
}

/**
 * Returns every *active* lock whose scope glob-overlaps `scope`, using the
 * heuristic in globOverlap.ts. This is informational only: it never raises,
 * never blocks, and lock_create never consults it — the calling agent
 * decides what, if anything, to do with the result.
 */
export async function checkConflicts(locksRoot: string, scope: string[], staleMinutesOverride?: number): Promise<LockSummary[]> {
  const records = await readAllRecords(locksRoot, 'active');
  const conflicting = records.filter((record) => scopesOverlap(scope, record.frontmatter.scope));
  const staleMinutes = resolveStaleMinutes(staleMinutesOverride);
  return conflicting.map((record) => toSummary(record, { staleMinutes }));
}

export interface UpdateLockParams {
  lock_id: string;
  /**
   * The identity of whoever is updating, if known. Same contract as finishLock:
   * enforced only where BOTH sides are known, so no existing null-agent lock becomes
   * unmutatable.
   */
  agent_id?: string | null;
  /** Deliberately update a lock held by someone else. Recorded in the lock's notes. */
  force?: boolean;
  /** Exact text of an existing task to flip. Optional — omit for a scope-only update. */
  task_text?: string;
  /** Required when task_text is given. */
  done?: boolean;
  note?: string;
  /** Glob patterns to ADD to this lock's scope. Duplicates are ignored. */
  add_scope?: string[];
  /** Glob patterns to REMOVE from this lock's scope. Each must currently be present. */
  remove_scope?: string[];
}

export interface UpdateLockResult {
  id: string;
  percentComplete: number;
  /** The lock's scope AFTER this update. Returned always, so a caller never has to re-query to confirm a scope change landed. */
  scope: string[];
}

export class NoOpUpdateError extends Error {
  constructor(lockId: string) {
    super(
      `Update to "${lockId}" would change nothing — either no mutation was given, or every one requested was already ` +
        `the lock's current state (a task already in that position, a scope pattern already held or already absent). ` +
        `Refusing rather than silently bumping the lock's timestamp — that would be a heartbeat wearing an update's name, ` +
        `and it would let a caller keep a claim alive while appearing to make progress on it. Use \`heartbeat\` if that is what you meant.`,
    );
    this.name = 'NoOpUpdateError';
  }
}

export class ScopeNotHeldError extends Error {
  constructor(lockId: string, pattern: string, held: string[]) {
    super(
      `Lock "${lockId}" does not hold scope pattern "${pattern}", so it cannot be removed. Currently held: ${held.join(', ') || '(none)'}. ` +
        `This is an error rather than a silent no-op on purpose: a caller who believes it released a path it still holds is exactly ` +
        `the state this tool exists to prevent.`,
    );
    this.name = 'ScopeNotHeldError';
  }
}

export class EmptyScopeError extends Error {
  constructor(lockId: string) {
    super(
      `Refusing to remove the last scope pattern from lock "${lockId}". A lock claiming nothing is worse than no lock: it still ` +
        `appears in queries and still reads as an active claim, while covering no path and blocking nothing. Finish the lock instead.`,
    );
    this.name = 'EmptyScopeError';
  }
}

/**
 * Mutates an active or done lock: flips a task, appends a note, and/or CHANGES ITS SCOPE.
 *
 * SCOPE MUTATION IS TRANSITION 5 of the lock state machine (see the README table), and
 * it was missing for the tool's whole life while three separate design decisions
 * assumed it existed. The protocol's normal path is "claim, then discover the job
 * touches one more file" — so without this, the most common case had no correct
 * implementation and the workaround was to create a SECOND lock for one job, which
 * splits the task checklist and leaves a window where the new paths are unclaimed.
 */
export async function updateLock(locksRoot: string, params: UpdateLockParams): Promise<UpdateLockResult> {
  const found = await findRecordById(locksRoot, params.lock_id);
  if (!found) throw new LockNotFoundError(params.lock_id);

  // Serialize, then RE-READ inside the lock. Re-reading is the half that matters: a
  // record fetched before acquiring the lock is exactly the stale starting state that
  // makes concurrent updates erase each other.
  // The done archive is an AUDIT RECORD and is not rewritable in place. Before this,
  // `update` found a lock by id in either directory and happily rewrote an archived
  // one's scope, tasks and notes — silently altering the record of what was claimed
  // and by whom, with nothing in the event log to say so. `heartbeat` already refused
  // done locks for a weaker reason. Reopen it if it genuinely needs to change.
  if (found.frontmatter.status === 'done') throw new ArchivedLockImmutableError(params.lock_id);

  return withRecordLock(found.filePath, async () => {
  const reread = await tryReadRecord(found.filePath);
  // Finished, reaped or corrupted by someone else between the lookup and the lock.
  if (reread === null) throw new LockNotFoundError(params.lock_id);
  const record: LockRecord = reread;
  if (record.frontmatter.status === 'done') throw new ArchivedLockImmutableError(params.lock_id);

  // OWNERSHIP. `remove_scope` can SHRINK a claim, which frees a path for everyone
  // else while the lock still reads as actively held — strictly worse than ending
  // it outright, because nothing disappears to signal the change. Shipping a
  // claim-shrinking verb on a claim-tracking tool with no ownership check made an
  // anonymous caller able to unclaim another session's paths, silently. Enforced
  // exactly as far as finishLock does and no further: refuse only when both
  // identities are known and differ, so a null-agent lock stays mutable.
  const holder = record.frontmatter.agent_id;
  const foreign = params.agent_id != null && holder != null && !agentMatches(holder, params.agent_id);
  if (foreign && !params.force) {
    throw new LockNotOwnedError(params.lock_id, holder, params.agent_id!);
  }

  // Work out what would ACTUALLY change before deciding this is a no-op. Asking only
  // "did the caller pass a flag?" let `--add-scope <pattern-already-held>` through: it
  // changed nothing, bumped `updated`, and so was a heartbeat wearing an update's
  // name — precisely what NoOpUpdateError exists to prevent, reachable through the
  // check itself.
  const wantsTask = params.task_text !== undefined;
  const wantsNote = params.note !== undefined && params.note !== '';

  let nextScope: string[] | null = null;
  if ((params.add_scope?.length ?? 0) > 0 || (params.remove_scope?.length ?? 0) > 0) {
    // Scope changes are validated FULLY before any is applied, so a partially-applied
    // scope edit is not a reachable state. A lock left half-way through a scope change
    // is a claim whose extent nobody can state, which is the failure this whole tool is
    // supposed to remove rather than introduce.
    const candidate = [...record.frontmatter.scope];
    for (const pattern of params.remove_scope ?? []) {
      const at = candidate.indexOf(pattern);
      if (at === -1) throw new ScopeNotHeldError(params.lock_id, pattern, record.frontmatter.scope);
      candidate.splice(at, 1);
    }
    for (const pattern of params.add_scope ?? []) {
      if (!candidate.includes(pattern)) candidate.push(pattern);
    }
    if (candidate.length === 0) throw new EmptyScopeError(params.lock_id);
    nextScope = candidate;
  }
  const scopeChanged =
    nextScope !== null &&
    (nextScope.length !== record.frontmatter.scope.length ||
      nextScope.some((pattern, i) => pattern !== record.frontmatter.scope[i]));

  let taskChanged = false;
  if (wantsTask) {
    if (params.done === undefined) {
      throw new TypeError(`update to "${params.lock_id}" gave task_text without done; say which way to flip it`);
    }
    const task = record.tasks.find((t) => t.text === params.task_text);
    if (!task) {
      throw new TaskNotFoundError(
        params.lock_id,
        params.task_text!,
        record.tasks.map((t) => t.text),
      );
    }
    taskChanged = task.done !== params.done;
    task.done = params.done;
  }

  if (!taskChanged && !scopeChanged && !wantsNote) throw new NoOpUpdateError(params.lock_id);

  const wantsScope = scopeChanged;
  if (nextScope !== null) record.frontmatter.scope = nextScope;

  if (foreign) {
    record.notes.push(
      `Force-updated by ${params.agent_id}, which is NOT the holder (${holder}).` +
        (wantsScope ? ` Scope is now: ${record.frontmatter.scope.join(', ')}.` : ''),
    );
  }

  if (params.note) {
    record.notes.push(params.note);
  }

  const previousUpdated = record.frontmatter.updated;
  record.frontmatter.updated = formatTimestamp();
  await writeRecord(record);
  await recordTouch(locksRoot, record, previousUpdated, 'update', params.agent_id);

  return {
    id: record.frontmatter.id,
    percentComplete: computePercentComplete(record.tasks),
    scope: record.frontmatter.scope,
  };
  });
}

export interface FinishLockParams {
  lock_id: string;
  summary?: string;
  /**
   * The identity of whoever is finishing this lock, if known. Optional, because most
   * existing locks carry no agent_id and requiring a match would make them
   * unfinishable — a fix worse than the defect.
   */
  agent_id?: string | null;
  /**
   * Deliberately finish a lock held by someone else. Required when both identities are
   * known and differ; the reason is recorded in the archive.
   */
  force?: boolean;
}

export interface FinishLockResult {
  id: string;
  filePath: string;
}

export async function finishLock(locksRoot: string, params: FinishLockParams): Promise<FinishLockResult> {
  await ensureDirs(locksRoot);
  const activeFiles = await listMarkdownFiles(activeDir(locksRoot));

  let found: LockRecord | null = null;
  for (const filePath of activeFiles) {
    const candidate = await tryReadRecord(filePath);
    if (candidate !== null && candidate.frontmatter.id === params.lock_id) {
      found = candidate;
      break;
    }
  }

  if (!found) {
    // Distinguish "never existed" from "exists but already done" for a clearer error.
    const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
    for (const filePath of doneFiles) {
      const candidate = await tryReadRecord(filePath);
      if (candidate !== null && candidate.frontmatter.id === params.lock_id) {
        throw new LockNotActiveError(params.lock_id);
      }
    }
    throw new LockNotFoundError(params.lock_id);
  }
  let record: LockRecord = found;

  // Serialize against concurrent updates on the same file, and re-read inside the
  // lock — otherwise a finish can archive a record it read before someone else's
  // update, silently discarding that update from the archived copy.
  const activeFilePath = record.filePath;
  return withRecordLock(activeFilePath, async () => {
  const rereadActive = await tryReadRecord(activeFilePath);
  if (rereadActive === null) throw new LockNotFoundError(params.lock_id);
  record = rereadActive;

  if (params.summary) {
    record.notes.push(params.summary);
  }

  // OWNERSHIP, enforced exactly as far as the data allows and no further.
  //
  // Refuse only when BOTH identities are known and differ. That closes the accidental
  // path — the failure actually observed — without making any existing lock
  // unfinishable: most carry agent_id null, and a caller that supplies no identity is
  // unchanged. Enforcing more would strand real locks, which is worse than the defect.
  //
  // `force` is deliberate, recorded, and not hidden: a caller who must end someone
  // else's claim can, and the archive says so afterwards. A refusal nobody can get past
  // becomes a refusal everyone routes around.
  const holder = record.frontmatter.agent_id;
  const foreign = params.agent_id != null && holder != null && !agentMatches(holder, params.agent_id);
  if (foreign && !params.force) {
    throw new LockNotOwnedError(params.lock_id, holder, params.agent_id!);
  }
  if (foreign) {
    record.notes.push(
      `Force-finished by ${params.agent_id}, which is NOT the holder (${holder}). ` +
        `Recorded here in prose and in frontmatter as finished_by: force, so the archive ` +
        `can answer "who ended this claim?" whichever way it is read.`,
    );
  }
  record.frontmatter.status = 'done';
  // Provenance, so `reopen` and any later audit can tell a deliberate close from a
  // reap without parsing note prose. `force` means someone other than the holder
  // ended the claim; `holder` covers both "its owner finished it" and "nobody's
  // identity was known", which is the honest reading — an unattributed finish is not
  // evidence of a takeover.
  record.frontmatter.finished_by = foreign ? 'force' : 'holder';
  const previousUpdated = record.frontmatter.updated;
  record.frontmatter.updated = formatTimestamp();

  const newFilePath = path.join(doneDir(locksRoot), path.basename(record.filePath));
  await assertDestinationFree(newFilePath, params.lock_id, 'archive');
  const oldFilePath = record.filePath;
  record.filePath = newFilePath;

  await writeRecord(record);
  await fs.unlink(oldFilePath);
  // The last live interval of a lock that was NEVER reaped — the right-hand end of
  // the distribution a threshold has to sit above.
  await recordTouch(locksRoot, record, previousUpdated, 'finish', params.agent_id);

  return { id: record.frontmatter.id, filePath: newFilePath };
  });
}

export interface HeartbeatLockParams {
  lock_id: string;
  /**
   * Who is sending the heartbeat, if known. Recorded on the touch event so an
   * anonymous or foreign heartbeat is visible in the log; not enforced, because a
   * heartbeat only ever extends a claim's life and refusing one strands the holder.
   */
  agent_id?: string | null;
}

export interface HeartbeatLockResult {
  id: string;
  updated: string;
}

/**
 * Bumps ONLY a lock's `updated` timestamp — no task/note/scope change.
 * This is the proof-of-life ping an agent should call periodically during
 * a long-running task that isn't naturally hitting lock_update (completing
 * a task) often enough to keep the lock from reading as stale. `updated`
 * doubles as the heartbeat signal rather than introducing a separate field
 * (see README "Staleness detection" for why): lock_update already bumps it
 * for free on real activity, so this is purely for the gap between real
 * updates.
 *
 * Restricted to active locks — heartbeating a done/archived lock is not a
 * meaningful operation and would be a new footgun, not a feature.
 */
export async function heartbeatLock(locksRoot: string, params: HeartbeatLockParams): Promise<HeartbeatLockResult> {
  const activeFiles = await listMarkdownFiles(activeDir(locksRoot));
  for (const filePath of activeFiles) {
    const found = await tryReadRecord(filePath);
    if (found !== null && found.frontmatter.id === params.lock_id) {
      // Serialize and re-read, exactly as updateLock does: a heartbeat is a
      // read-modify-write like any other, so unserialized it can write back a record
      // it read before a concurrent update, discarding that update entirely.
      return withRecordLock(filePath, async () => {
        const record = await tryReadRecord(filePath);
        if (record === null) throw new LockNotFoundError(params.lock_id);
        const previousUpdated = record.frontmatter.updated;
        record.frontmatter.updated = formatTimestamp();
        await writeRecord(record);
        await recordTouch(locksRoot, record, previousUpdated, 'heartbeat', params.agent_id);
        return { id: record.frontmatter.id, updated: record.frontmatter.updated };
      });
    }
  }
  // Distinguish "never existed" from "exists but already done", same as finishLock.
  const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
  for (const filePath of doneFiles) {
    const candidate = await readRecord(filePath);
    if (candidate.frontmatter.id === params.lock_id) {
      throw new LockNotActiveError(params.lock_id);
    }
  }
  throw new LockNotFoundError(params.lock_id);
}

export interface ReapStaleLocksParams {
  /** Reap only this lock id. Errors if it exists but isn't actually stale (a safety check, not a formality — see store.test.ts). Omit to reap every stale active lock. */
  lock_id?: string;
  stale_minutes?: number;
  /** When true, returns what WOULD be reaped without writing anything. */
  dry_run?: boolean;
}

export interface ReapedLock {
  id: string;
  title: string;
  staleForSeconds: number;
}

export class LockNotStaleError extends Error {
  constructor(lockId: string, staleForSeconds: number, staleMinutes: number) {
    super(
      `Lock "${lockId}" is not stale (last updated ${staleForSeconds}s ago; the threshold is ${staleMinutes} minute(s)). ` +
        `Refusing to reap a lock that isn't actually stale — reap is for cleaning up abandoned work, not an alternate way to call lock_finish.`,
    );
    this.name = 'LockNotStaleError';
  }
}

/**
 * Finishes (moves to done, same as finishLock) every active lock currently
 * computed as stale, or a single specific lock if lock_id is given —
 * explicitly, never as a side effect of a read like lock_query. Each
 * reaped lock gets an auto-generated note recording why, so the done
 * archive stays honest about "the owning agent finished this" vs.
 * "nobody was heard from and this got cleaned up automatically."
 */
export async function reapStaleLocks(locksRoot: string, params: ReapStaleLocksParams = {}): Promise<ReapedLock[]> {
  // A caller-supplied threshold may only LENGTHEN the reaping window, never shorten it.
  //
  // WHY THIS FLOOR EXISTS — do not remove it to "respect the caller's flag".
  // The singular form (lock_id given) refuses a non-stale lock via LockNotStaleError,
  // and the README promises reap is "never a back door to force-finish someone else's
  // live work". That promise held for the singular form ONLY. The plural form took this
  // threshold straight from the caller with no lower bound, so
  // `reap --stale-minutes 0.01` finished every active lock in a repo — exit 0, no
  // confirmation, no refusal. Demonstrated against this binary on 2026-09-03, against
  // locks held by other sessions.
  //
  // The floor is applied HERE rather than in resolveStaleMinutes deliberately: read
  // paths (lock_query, lock_check_conflict) may legitimately ask "what would look stale
  // at 5 minutes?", which is informational and harmless. Only the destructive path
  // needs the bound.
  const requested = resolveStaleMinutes(params.stale_minutes);
  const floor = resolveStaleMinutes(undefined);
  const staleMinutes = Math.max(requested, floor);
  // Record it. A floor that silently changes the answer produces a FALSE report:
  // "No stale locks to reap" when locks are stale by the threshold the caller asked
  // for and were merely protected. Callers must be able to say what actually ran.
  lastReapFloor = staleMinutes === requested ? null : { requested, applied: staleMinutes };
  lastReapSkipped = 0;
  const now = new Date();
  const activeRecords = await readAllRecords(locksRoot, 'active');

  const candidates = activeRecords.filter((record) => {
    if (params.lock_id !== undefined && record.frontmatter.id !== params.lock_id) return false;
    return toSummary(record, { staleMinutes, now }).stale;
  });

  if (params.lock_id !== undefined && candidates.length === 0) {
    // Either the id doesn't exist/isn't active, or it exists but isn't stale — give an
    // honest, specific error either way rather than a silent empty-array no-op.
    const match = activeRecords.find((record) => record.frontmatter.id === params.lock_id);
    if (match) {
      const summary = toSummary(match, { staleMinutes, now });
      throw new LockNotStaleError(params.lock_id, summary.staleForSeconds, staleMinutes);
    }
    const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
    for (const filePath of doneFiles) {
      const candidate = await tryReadRecord(filePath);
      if (candidate !== null && candidate.frontmatter.id === params.lock_id) throw new LockNotActiveError(params.lock_id);
    }
    throw new LockNotFoundError(params.lock_id);
  }

  const reaped: ReapedLock[] = [];
  for (const candidate of candidates) {
    if (params.dry_run) {
      const summary = toSummary(candidate, { staleMinutes, now });
      reaped.push({ id: candidate.frontmatter.id, title: candidate.title, staleForSeconds: summary.staleForSeconds });
      continue;
    }

    // SERIALIZE, THEN RE-READ, THEN RE-CHECK STALENESS — all three, inside the lock.
    //
    // Taking the lock is only a third of it. The candidate above was read BEFORE the
    // lock was held, so acting on it archives a record as it looked before any
    // concurrent update — and, worse, before any concurrent HEARTBEAT. Measured with
    // the shipped binary at the default threshold: a heartbeat exited 0 reporting a
    // fresh timestamp, and the lock was archived `finished_by: reap` regardless. The
    // holder was told it was alive and its claim was taken in the same moment.
    //
    // So the staleness test is re-run against the re-read record. A lock that stopped
    // being stale while we queued for the lock is no longer a candidate, and the
    // caller is told how many were skipped rather than left to infer it.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await withRecordLock(candidate.filePath, async (): Promise<ReapedLock | null> => {
    const record = await tryReadRecord(candidate.filePath);
    // Finished, reaped or corrupted by someone else while we queued.
    if (record === null) return null;
    if (record.frontmatter.status !== 'active') return null;
    const summary = toSummary(record, { staleMinutes, now: new Date() });
    if (!summary.stale) return null; // came back to life while we queued

    // Record the EXACT prior last-touch stamp before overwriting it below.
    // `updated` is set to now on reap, which erases the inter-touch interval — the
    // one quantity anyone tuning the staleness threshold needs. A minute-rounded
    // English sentence is not a recoverable datum, so keep the raw timestamp.
    record.notes.push(
      `Auto-reaped: last touched ${record.frontmatter.updated} (UTC), ` +
        `no activity for ${Math.round(summary.staleForSeconds / 60)} minute(s), ` +
        `threshold ${staleMinutes} minute(s).`,
    );
    const lastTouch = record.frontmatter.updated;
    record.frontmatter.status = 'done';
    record.frontmatter.finished_by = 'reap';
    record.frontmatter.updated = formatTimestamp();
    const newFilePath = path.join(doneDir(locksRoot), path.basename(record.filePath));
    // Reap performs the SAME active->done move as finishLock and needs the same guard.
    // Without it, reap overwrote a holder's existing archived record — summary gone,
    // finished_by rewritten from holder to reap — and then crashed with ENOENT.
    // Fixing the move in one of the two functions that make it is fixing the instance.
    await assertDestinationFree(newFilePath, record.frontmatter.id, 'reap');
    const oldFilePath = record.filePath;
    record.filePath = newFilePath;
    await ensureDirs(locksRoot);
    await writeRecord(record);
    await fs.unlink(oldFilePath);

    // INSTRUMENT THE REAP. The threshold is currently unvalidated in both
    // directions: across every lock ever created on this machine nothing has gone
    // stale and nothing has been reaped, so 60 minutes is neither confirmed nor
    // refuted. Tuning it later needs the distribution of inter-touch intervals for
    // locks that turned out to be ALIVE, and that data does not exist unless it is
    // captured at the moment of the reap — `updated` is overwritten one line above,
    // which is exactly how the interval would otherwise be destroyed by the event
    // that makes it interesting.
    //
    // Emitted AFTER the write succeeds, so the log never claims a reap that did not
    // happen. appendEvent cannot throw (see events.ts invariant 2), so a broken log
    // cannot break the reap.
    await appendEvent(locksRoot, {
      event: 'reap',
      ts: record.frontmatter.updated,
      lock_id: record.frontmatter.id,
      repository: record.frontmatter.repository ?? '',
      agent_id: record.frontmatter.agent_id,
      created: record.frontmatter.created,
      last_touch: lastTouch,
      age_seconds: Math.max(0, Math.round((now.getTime() - parseTimestamp(record.frontmatter.created).getTime()) / 1000)),
      idle_seconds: summary.staleForSeconds,
      tasks_total: record.tasks.length,
      tasks_done: record.tasks.filter((t) => t.done).length,
      threshold_minutes: staleMinutes,
    });
    return { id: record.frontmatter.id, title: record.title, staleForSeconds: summary.staleForSeconds };
    });
    if (outcome !== null) reaped.push(outcome);
    else lastReapSkipped += 1;
  }

  return reaped;
}

export interface ReopenLockParams {
  lock_id: string;
  /**
   * Why this archived lock is being returned to active. REQUIRED unless the lock was
   * finished by reap — see ReopenReasonRequiredError for why that asymmetry exists.
   */
  reason?: string;
  /** The identity of whoever is reopening, if known. Recorded, never enforced. */
  agent_id?: string | null;
}

export interface ReopenLockResult {
  id: string;
  filePath: string;
  /** How the lock had been finished before this reopen — the provenance that gated it. */
  previously_finished_by: 'holder' | 'force' | 'reap' | null;
  /**
   * What this reopen says about the staleness threshold. Only 'false-positive' is
   * evidence it was too short — see ReopenEvent.verdict for why a boolean was wrong.
   */
  verdict: ReopenVerdict;
}

export class LockNotDoneError extends Error {
  constructor(lockId: string) {
    super(`Lock "${lockId}" is already active; reopen only applies to a lock in the done archive.`);
    this.name = 'LockNotDoneError';
  }
}

export class ReopenReasonRequiredError extends Error {
  constructor(lockId: string, finishedBy: string | null) {
    super(
      `Reopening "${lockId}" requires a reason: it was finished by ${finishedBy ?? 'an unrecorded path'}, not by reap. ` +
        `Recovering a claim that auto-reap took from a live session is routine and needs no justification; reviving one its ` +
        `owner deliberately closed is a different act, and this refusal is what keeps reopen from becoming a general ` +
        `back door into the archive.`,
    );
    this.name = 'ReopenReasonRequiredError';
  }
}

/**
 * TRANSITION 9: done -> active. The recovery path for a wrongful reap.
 *
 * WHY THIS EXISTS AT ALL. Auto-reap can finish a LIVE lock whose holder simply had
 * no task boundary to check off for longer than the threshold. When that happens the
 * holder needs its claim back, and both workarounds are bad in the same way the
 * missing scope mutator was bad: re-claiming creates a second record for one job,
 * loses the task checklist, and leaves a window with nothing claimed; hand-editing
 * the markdown bypasses the API entirely and is untraceable.
 *
 * WHY IT DOUBLES AS THE INSTRUMENT. A reopen of a REAPED lock is a labelled false
 * positive for the staleness threshold — the strongest evidence available that the
 * threshold is too short, and it arrives already attached to the interval that
 * triggered it. So the recovery path and the measurement are the same code, and
 * there is no separate telemetry to remember to keep alive.
 *
 * WHAT IT IS NOT: a way to revive arbitrary archived work. A lock its owner
 * deliberately finished can still be reopened, but only with a stated reason, which
 * is recorded.
 */
export async function reopenLock(locksRoot: string, params: ReopenLockParams): Promise<ReopenLockResult> {
  await ensureDirs(locksRoot);
  const doneFiles = await listMarkdownFiles(doneDir(locksRoot));

  let found: LockRecord | null = null;
  for (const filePath of doneFiles) {
    const candidate = await tryReadRecord(filePath);
    if (candidate !== null && candidate.frontmatter.id === params.lock_id) {
      found = candidate;
      break;
    }
  }

  if (!found) {
    const activeFiles = await listMarkdownFiles(activeDir(locksRoot));
    for (const filePath of activeFiles) {
      const candidate = await readRecord(filePath);
      if (candidate.frontmatter.id === params.lock_id) throw new LockNotDoneError(params.lock_id);
    }
    throw new LockNotFoundError(params.lock_id);
  }
  let record: LockRecord = found;

  const doneFilePath = record.filePath;
  return withRecordLock(doneFilePath, async () => {
  const rereadDone = await tryReadRecord(doneFilePath);
  if (rereadDone === null) throw new LockNotFoundError(params.lock_id);
  record = rereadDone;

  const finishedBy = record.frontmatter.finished_by ?? null;
  const wasReaped = finishedBy === 'reap';
  // Only the HOLDER coming back for a reaped lock says anything about the threshold.
  // A stranger reviving someone's abandoned claim is not evidence the reap was wrong,
  // and a lock that predates provenance cannot be scored at all — scoring it anyway
  // is what biased the measurement toward "the threshold is fine".
  const holderId = record.frontmatter.agent_id;
  const identityKnown = params.agent_id != null && holderId != null;
  const reopenerIsHolder = identityKnown && agentMatches(holderId!, params.agent_id!);
  const verdict: ReopenVerdict =
    finishedBy === null
      ? 'unknown'
      : !wasReaped
        ? 'not-a-reap'
        : !identityKnown
          ? 'identity-unknown'
          : reopenerIsHolder
            ? 'false-positive'
            : 'reaped-by-other';
  const reason = params.reason?.trim() ?? '';
  if (!wasReaped && reason === '') throw new ReopenReasonRequiredError(params.lock_id, finishedBy);

  // Join the reap-time interval from this log's own history, so the false-positive
  // record is self-contained. Doing it here rather than at analysis time means a
  // later reader never has to reconstruct the pairing — and a pairing nobody
  // reconstructs is a measurement nobody makes.
  const priorReap = wasReaped ? await lastReapEventFor(locksRoot, params.lock_id) : null;

  // The note states the VERDICT, not an assumption. It previously asserted "the reap
  // was a FALSE POSITIVE: the holder was still working" on every reaped lock, which
  // contradicted the verdict computed two lines above whenever the reopener was not,
  // or could not be shown to be, the holder — writing a conclusion into a permanent
  // archive that the log itself declined to draw.
  const who = params.agent_id ?? 'an unidentified caller';
  const reapDetail = priorReap
    ? ` that fired at ${priorReap.idle_seconds}s idle against a ${priorReap.threshold_minutes}-minute threshold`
    : '';
  record.notes.push(
    ({
      'false-positive': `Reopened by ${who}, the holder, after an auto-reap${reapDetail}. The reap was a false positive: the holder was still working.`,
      'reaped-by-other': `Reopened by ${who}, who is NOT the holder on record, after an auto-reap${reapDetail}. Not counted as evidence about the staleness threshold.`,
      'identity-unknown': `Reopened by ${who} after an auto-reap${reapDetail}. Whether the holder returned is not determinable — one side carried no identity — so this is not counted as evidence about the staleness threshold.`,
      'not-a-reap': `Reopened by ${who} from a ${finishedBy} finish.`,
      unknown: `Reopened by ${who}. This lock predates finish-provenance, so how it ended is not recoverable.`,
    } as Record<ReopenVerdict, string>)[verdict] + (reason === '' ? '' : ` Reason: ${reason}`),
  );

  record.frontmatter.status = 'active';
  record.frontmatter.finished_by = null;
  // PRESERVE THE INTERVAL THIS REOPEN IS EVIDENCE OF. Reopen used to stamp `updated`
  // to now, so the next touch measured from the reopen rather than from the holder's
  // real gap: a true ~7s holder gap was recorded as 1s. The one case KNOWN to be
  // alive-and-quiet had its interval destroyed by the act of recovering it — the log
  // censored by its own intervention. Emit the true interval as a touch first, from
  // the pre-reap last-touch stamp that the reap event preserved.
  const trueLastTouch = priorReap?.last_touch ?? record.frontmatter.updated;
  record.frontmatter.updated = formatTimestamp();

  const newFilePath = path.join(activeDir(locksRoot), path.basename(record.filePath));
  await assertDestinationFree(newFilePath, params.lock_id, 'reopen');
  const oldFilePath = record.filePath;
  record.filePath = newFilePath;
  await writeRecord(record);
  await fs.unlink(oldFilePath);

  // A reopened reap is the strongest evidence there is that a live lock went quiet for
  // this long: the holder demonstrably came back. Record it as a live interval so the
  // distribution the threshold is tuned against contains the case that matters most.
  if (verdict === 'false-positive') {
    await recordTouch(locksRoot, record, trueLastTouch, 'update', params.agent_id);
  }

  await appendEvent(locksRoot, {
    event: 'reopen',
    ts: record.frontmatter.updated,
    lock_id: record.frontmatter.id,
    repository: record.frontmatter.repository ?? '',
    agent_id: params.agent_id ?? null,
    finished_by: finishedBy,
    reason: reason === '' ? null : reason,
    verdict,
    idle_at_reap_seconds: priorReap?.idle_seconds ?? null,
  });

  return {
    id: record.frontmatter.id,
    filePath: newFilePath,
    previously_finished_by: finishedBy,
    verdict,
  };
  });
}
