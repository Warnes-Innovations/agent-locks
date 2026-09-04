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
import { formatTimestamp, slugify } from '../timestamp.js';
import { parseLockFile, serializeLockFile } from './markdown.js';
import { scopesOverlap } from './globOverlap.js';
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

  // A SESSION REF, not "whatever is in the last brackets". An earlier version treated
  // any trailing [...] as a stable id, so `--agent 'Codex [main]'` matched a lock held
  // by `Claude [main]` — a false positive on identity, which is worse than a miss
  // because callers act on it. Session refs are hex; a bracketed word is not a ref.
  const SESSION_REF = /^[0-9a-f]{4,}$/i;
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
  const tmpPath = path.join(dir, `.${path.basename(record.filePath)}.${process.pid}.tmp`);
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

/** Finds a lock by id, searching active first, then done. Returns null if not found in either. */
async function findRecordById(locksRoot: string, lockId: string): Promise<LockRecord | null> {
  for (const dir of [activeDir(locksRoot), doneDir(locksRoot)]) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const record = await readRecord(filePath);
      if (record.frontmatter.id === lockId) return record;
    }
  }
  return null;
}

async function uniqueFilePath(dir: string, timestamp: string, slug: string): Promise<{ filePath: string; id: string }> {
  let suffix = 0;
  for (;;) {
    const candidateId = suffix === 0 ? `${timestamp}-${slug}` : `${timestamp}-${slug}-${suffix + 1}`;
    const filePath = path.join(dir, `${candidateId}.md`);
    try {
      await fs.access(filePath);
      suffix += 1; // file exists, try the next suffix
    } catch {
      return { filePath, id: candidateId }; // ENOENT: this path is free
    }
  }
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
  const { filePath, id } = await uniqueFilePath(activeDir(locksRoot), now, slug);

  const frontmatter: LockFrontmatter = {
    id,
    agent_id: params.agent_id ?? null,
    parent_agent_id: params.parent_agent_id ?? null,
    status: 'active',
    created: now,
    updated: now,
    scope: params.scope,
    repository: params.repository ?? '',
  };
  const record: LockRecord = {
    filePath,
    frontmatter,
    title: params.title,
    tasks: params.tasks.map((text): LockTask => ({ text, done: false })),
    notes: [],
  };
  await writeRecord(record);
  return { id, filePath };
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
  task_text: string;
  done: boolean;
  note?: string;
}

export interface UpdateLockResult {
  id: string;
  percentComplete: number;
}

export async function updateLock(locksRoot: string, params: UpdateLockParams): Promise<UpdateLockResult> {
  const record = await findRecordById(locksRoot, params.lock_id);
  if (!record) throw new LockNotFoundError(params.lock_id);

  const task = record.tasks.find((t) => t.text === params.task_text);
  if (!task) {
    throw new TaskNotFoundError(
      params.lock_id,
      params.task_text,
      record.tasks.map((t) => t.text),
    );
  }
  task.done = params.done;

  if (params.note) {
    record.notes.push(params.note);
  }

  record.frontmatter.updated = formatTimestamp();
  await writeRecord(record);

  return { id: record.frontmatter.id, percentComplete: computePercentComplete(record.tasks) };
}

export interface FinishLockParams {
  lock_id: string;
  summary?: string;
}

export interface FinishLockResult {
  id: string;
  filePath: string;
}

export async function finishLock(locksRoot: string, params: FinishLockParams): Promise<FinishLockResult> {
  await ensureDirs(locksRoot);
  const activeFiles = await listMarkdownFiles(activeDir(locksRoot));

  let record: LockRecord | null = null;
  for (const filePath of activeFiles) {
    const candidate = await readRecord(filePath);
    if (candidate.frontmatter.id === params.lock_id) {
      record = candidate;
      break;
    }
  }

  if (!record) {
    // Distinguish "never existed" from "exists but already done" for a clearer error.
    const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
    for (const filePath of doneFiles) {
      const candidate = await readRecord(filePath);
      if (candidate.frontmatter.id === params.lock_id) {
        throw new LockNotActiveError(params.lock_id);
      }
    }
    throw new LockNotFoundError(params.lock_id);
  }

  if (params.summary) {
    record.notes.push(params.summary);
  }
  record.frontmatter.status = 'done';
  record.frontmatter.updated = formatTimestamp();

  const newFilePath = path.join(doneDir(locksRoot), path.basename(record.filePath));
  const oldFilePath = record.filePath;
  record.filePath = newFilePath;

  await writeRecord(record);
  await fs.unlink(oldFilePath);

  return { id: record.frontmatter.id, filePath: newFilePath };
}

export interface HeartbeatLockParams {
  lock_id: string;
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
    const record = await readRecord(filePath);
    if (record.frontmatter.id === params.lock_id) {
      record.frontmatter.updated = formatTimestamp();
      await writeRecord(record);
      return { id: record.frontmatter.id, updated: record.frontmatter.updated };
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
      const candidate = await readRecord(filePath);
      if (candidate.frontmatter.id === params.lock_id) throw new LockNotActiveError(params.lock_id);
    }
    throw new LockNotFoundError(params.lock_id);
  }

  const reaped: ReapedLock[] = [];
  for (const record of candidates) {
    const summary = toSummary(record, { staleMinutes, now });
    reaped.push({ id: record.frontmatter.id, title: record.title, staleForSeconds: summary.staleForSeconds });
    if (params.dry_run) continue;

    // Record the EXACT prior last-touch stamp before overwriting it below.
    // `updated` is set to now on reap, which erases the inter-touch interval — the
    // one quantity anyone tuning the staleness threshold needs. A minute-rounded
    // English sentence is not a recoverable datum, so keep the raw timestamp.
    record.notes.push(
      `Auto-reaped: last touched ${record.frontmatter.updated} (UTC), ` +
        `no activity for ${Math.round(summary.staleForSeconds / 60)} minute(s), ` +
        `threshold ${staleMinutes} minute(s).`,
    );
    record.frontmatter.status = 'done';
    record.frontmatter.updated = formatTimestamp();
    const newFilePath = path.join(doneDir(locksRoot), path.basename(record.filePath));
    const oldFilePath = record.filePath;
    record.filePath = newFilePath;
    await ensureDirs(locksRoot);
    await writeRecord(record);
    await fs.unlink(oldFilePath);
  }

  return reaped;
}
