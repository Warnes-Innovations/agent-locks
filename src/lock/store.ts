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
import { applyScopeAmendment, EmptyScopeError, formatScopeCheck, normalizeScope } from './scope.js';
import type { ScopeAmendmentRequest, ScopeCheckDialect } from './scope.js';
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

// Re-exported so callers handling this module's failure modes (server.ts's
// error path, cli.ts's exit-code mapping) can import every lock error from
// one place, rather than some from here and some from ./scope.
export { ScopeAmendmentError, EmptyScopeError } from './scope.js';

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

export class ScopeNarrowingRefusedError extends Error {
  constructor(lockId: string, holder: string, caller: string, removed: string[]) {
    super(
      `Lock "${lockId}" is held by ${holder}, not by ${caller}, and this update would REMOVE ` +
        `${removed.map((g) => `"${g}"`).join(', ')} from its claim. Refusing: narrowing another session's ` +
        `live claim makes their work invisible to every conflict check while their lock still reads as ` +
        `active and healthy — quieter than finishing it, and harder to notice. Coordinate with the holder ` +
        `first. If you genuinely must: force:true via MCP, or --force on the CLI. Either is allowed, and ` +
        `either is recorded on the lock.`,
    );
    this.name = 'ScopeNarrowingRefusedError';
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
  // Pass the path so a malformed file names itself. "TypeError: b is not
  // iterable" from deep inside a matcher is not something an agent can act on;
  // one bad file otherwise denies the whole store to every agent in the repo
  // with no clue which file to remove.
  const parsed = parseLockFile(raw, filePath);
  return { ...parsed, filePath };
}

/** Reads a record and also returns the exact bytes it came from, for compare-and-swap writes. */
async function readRecordWithRaw(filePath: string): Promise<{ record: LockRecord; raw: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = parseLockFile(raw, filePath);
  return { record: { ...parsed, filePath }, raw };
}

/**
 * Writes a lock ATOMICALLY: full contents to a temp file in the same directory,
 * then rename over the target. Rename is atomic within a filesystem, so a reader
 * sees either the old file or the new one — never a half-written one.
 *
 * WHY THIS IS NOT A PLAIN writeFile (do not "simplify" it back):
 * `fs.writeFile` opens O_TRUNC and then writes, so between those two syscalls a
 * reader in another process — the normal case here, one server per worktree, all
 * sharing this directory — observes a zero-length or half-written file. That does
 * not fail loudly: YAML truncation SHORTENS a list rather than erroring, so the
 * reader sees a valid-looking active lock claiming fewer globs than it really
 * does. A partial write can also leave frontmatter that will not parse, and one
 * unparseable lock used to throw for the WHOLE store — so every query, conflict
 * check and reap in that repo failed. An ordinary Ctrl-C during a write was
 * enough to reach that state, and the pre-commit check that consumes this store
 * fails open, which turned it into silent repo-wide non-enforcement rather than
 * a visible error. Found by committee review 2026-09-03.
 *
 * The temp file lives in the SAME directory as the target because rename() is
 * only atomic within one filesystem; via os.tmpdir() it can cross a mount and
 * silently degrade to a copy. Do not move it.
 */
let tempFileCounter = 0;

async function writeRecord(record: LockRecord): Promise<void> {
  const contents = serializeLockFile(record);
  const dir = path.dirname(record.filePath);
  await fs.mkdir(dir, { recursive: true });
  // pid + ms is NOT unique: two writes in one process within the same
  // millisecond collide, and each then removes the other's temp file in its
  // error path. A counter makes the name unique per process for free.
  tempFileCounter += 1;
  const tempPath = path.join(
    dir,
    `.${path.basename(record.filePath)}.tmp-${process.pid}-${Date.now()}-${tempFileCounter}`,
  );
  try {
    await fs.writeFile(tempPath, contents, 'utf8');
    await fs.rename(tempPath, record.filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export class ConcurrentUpdateError extends Error {
  constructor(lockId: string) {
    super(
      `Lock "${lockId}" was modified by someone else while this update was being prepared, and the update was NOT applied. ` +
        `Re-read the lock and re-issue your change. Reporting this rather than overwriting is deliberate: a lost scope ` +
        `amendment leaves the amending agent believing its files are visible to peers when they are not — which is the ` +
        `exact failure this tool exists to prevent.`,
    );
    this.name = 'ConcurrentUpdateError';
  }
}

/**
 * Applies `mutate` to a lock and writes it back, retrying if the file changed
 * underneath us, and failing loudly rather than silently clobbering.
 *
 * WHY: `updateLock` is a read-modify-write with no mutual exclusion, and two
 * concurrent `add_scope` calls used to end with one amendment simply gone —
 * BOTH calls returning success, each echoing a scope containing its own
 * addition. Verified before this guard existed. A lock-coordination tool losing
 * a lock claim under concurrency is the one failure it may not have.
 *
 * The retry is what makes the common case correct rather than merely loud:
 * re-running the mutation against freshly-read state is exactly right for an
 * additive amendment, so two agents widening the same lock both land. Only when
 * the file keeps changing under repeated attempts does this give up — and then
 * it says so instead of picking a winner.
 */
async function mutateRecord<T>(
  locksRoot: string,
  lockId: string,
  mutate: (record: LockRecord) => T,
): Promise<{ record: LockRecord; result: T }> {
  const ATTEMPTS = 8;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const found = await findRecordPathById(locksRoot, lockId);
    if (!found) throw new LockNotFoundError(lockId);

    // Mutual exclusion FIRST, then read. A compare-and-swap on its own is not
    // enough and it is worth being explicit about why, because the CAS looks
    // sufficient: read, mutate, re-read, write-if-unchanged still lets two
    // callers both pass the re-read before either writes, and the second write
    // then clobbers the first. Only holding an exclusive claim across the whole
    // read-modify-write closes that.
    const release = await acquireFileLock(found);
    if (!release) continue; // someone else holds it; back off and retry
    try {
      const { record, raw } = await readRecordWithRaw(found);
      const result = mutate(record);

      // Belt and suspenders: even holding the guard, verify the bytes are still
      // the ones we read. If the exclusion ever fails (a stale-lock takeover, a
      // filesystem without O_EXCL semantics), this refuses rather than silently
      // overwriting — a protective check may only ever add protection.
      const current = await fs.readFile(found, 'utf8').catch(() => null);
      if (current !== raw) continue;

      await writeRecord(record);
      // A mutation that MOVES the lock (finish, reap → done/) sets a new
      // filePath; completing the move here keeps write-then-unlink inside the
      // held guard, so the window where the id exists in both active/ and
      // done/ is not reachable by a concurrent reader.
      if (record.filePath !== found) await fs.rm(found, { force: true });
      return { record, result };
    } finally {
      await release();
    }
  }
  throw new ConcurrentUpdateError(lockId);
}

/** How long a `.lock` sidecar may sit before it is assumed to belong to a crashed process. */
const FILE_LOCK_STALE_MS = 30_000;

/**
 * Takes an exclusive claim on one lock file, or returns null if someone else
 * holds it.
 *
 * `open(..., 'wx')` is O_CREAT|O_EXCL: the create succeeds for exactly one
 * caller, which is the primitive that makes this mutual exclusion rather than a
 * convention. The sidecar is removed on release; a leftover one older than
 * FILE_LOCK_STALE_MS is treated as a crashed holder and taken over, so a killed
 * process cannot wedge a lock permanently.
 */
async function acquireFileLock(filePath: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${filePath}.lock`;
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // Vanished between the EEXIST and the stat — the holder released it.
    }
    // Brief, jittered back-off so two contenders do not lock-step forever.
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    return null;
  }
  return async () => {
    await fs.rm(lockPath, { force: true });
  };
}

/** Finds the on-disk path of a lock by id, searching active first, then done. */
async function findRecordPathById(locksRoot: string, lockId: string): Promise<string | null> {
  for (const dir of [activeDir(locksRoot), doneDir(locksRoot)]) {
    for (const filePath of await listMarkdownFiles(dir)) {
      const record = await readRecord(filePath);
      if (record.frontmatter.id === lockId) return filePath;
    }
  }
  return null;
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
export async function findLockById(locksRoot: string, lockId: string): Promise<LockRecord | null> {
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
  /** Which command names the echoed scope-check prompt should name. Defaults to 'mcp'. */
  dialect?: ScopeCheckDialect;
}

export interface CreateLockResult {
  id: string;
  filePath: string;
  /**
   * The scope actually recorded, echoed back rather than left implicit.
   * An agent that never sees what it claimed cannot notice when the claim
   * stops matching its work — and it can otherwise work for hours without
   * the scope appearing in the transcript once after this call.
   */
  scope: string[];
  scopeCheck: string;
}

export async function createLock(locksRoot: string, params: CreateLockParams): Promise<CreateLockResult> {
  await ensureDirs(locksRoot);
  const now = formatTimestamp();
  const slug = slugify(params.title);
  const { filePath, id } = await uniqueFilePath(activeDir(locksRoot), now, slug);

  const scope = normalizeScope(params.scope);
  if (scope.length === 0) {
    throw new EmptyScopeError(
      'lock_create requires at least one non-empty glob pattern in scope (whitespace-only patterns are dropped, ' +
        'because a glob carrying stray whitespace matches nothing and would produce a lock that claims a file it can never be matched against).',
    );
  }
  const frontmatter: LockFrontmatter = {
    id,
    agent_id: params.agent_id ?? null,
    parent_agent_id: params.parent_agent_id ?? null,
    status: 'active',
    created: now,
    updated: now,
    scope,
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
  return { id, filePath, scope, scopeCheck: formatScopeCheck(scope, params.dialect ?? 'mcp', id) };
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

export class EmptyUpdateError extends Error {
  constructor(lockId: string) {
    super(
      `lock_update on "${lockId}" was given nothing to do. Pass task_text + done to check a task off, ` +
        `note to record something, scope/add_scope to amend the claim, or any combination. ` +
        `Refusing a no-op rather than bumping the timestamp silently: a call that only proves the agent is alive is lock_heartbeat, and saying so keeps the two distinguishable.`,
    );
    this.name = 'EmptyUpdateError';
  }
}

export class IncompleteTaskUpdateError extends Error {
  constructor(lockId: string) {
    super(
      `lock_update on "${lockId}" received task_text without done (or done without task_text). ` +
        `Both are required together — which task, and which way to flip it. Guessing either one would silently record a state change nobody asked for.`,
    );
    this.name = 'IncompleteTaskUpdateError';
  }
}

export interface UpdateLockParams extends ScopeAmendmentRequest {
  lock_id: string;
  /** Required together with `done`. Optional overall so a scope amendment or a note need not flip a task. */
  task_text?: string;
  /** Required together with `task_text`. */
  done?: boolean;
  note?: string;
  /** Canonical repository root, used only to backfill locks written before that field existed. */
  repository?: string;
  /** The caller's own agent id, if known. Used only to detect a FOREIGN narrowing; never fabricate it. */
  agent_id?: string | null;
  /** Proceed with a narrowing that would otherwise be refused. Deliberate, and recorded on the lock. */
  force?: boolean;
  /** Which command names the echoed scope-check prompt should name. Defaults to 'mcp'. */
  dialect?: ScopeCheckDialect;
}

export interface UpdateLockResult {
  id: string;
  percentComplete: number;
  /**
   * The lock's scope AFTER this call — echoed on every update, amended or
   * not, so it stays in front of the agent on routine progress calls rather
   * than being seen once at lock_create and never again.
   */
  scope: string[];
  /** True only when this call actually changed the scope. */
  scopeChanged: boolean;
  /** The scope as it stood before this call. Present only when `scopeChanged` is true, so the diff is visible in the transcript. */
  previousScope?: string[];
  /** Globs this call REMOVED from the claim. Present only when the amendment narrowed the scope. */
  removedFromScope?: string[];
  /** Conditions that make this update mean less than it appears to. Present only when non-empty. */
  warnings?: string[];
  scopeCheck: string;
}

export async function updateLock(locksRoot: string, params: UpdateLockParams): Promise<UpdateLockResult> {
  const wantsTaskFlip = params.task_text !== undefined || params.done !== undefined;
  const wantsScopeAmendment = params.set_scope !== undefined || params.add_scope !== undefined;
  // `note === undefined` was the wrong test: an empty-or-whitespace note passed
  // the guard and then recorded nothing (the write below is `if (params.note)`),
  // bumping `updated` for a call that did nothing — precisely what this error's
  // own message says it refuses. Test for a note that will actually be RECORDED.
  const wantsNote = params.note !== undefined && params.note.trim() !== '';
  if (!wantsTaskFlip && !wantsScopeAmendment && !wantsNote) {
    throw new EmptyUpdateError(params.lock_id);
  }
  if (wantsTaskFlip && (params.task_text === undefined || params.done === undefined)) {
    throw new IncompleteTaskUpdateError(params.lock_id);
  }

  // The whole read-modify-write runs under mutateRecord's compare-and-swap, so
  // a concurrent amendment cannot be silently overwritten. The callback may run
  // more than once against freshly-read state; keep it free of side effects
  // outside `record`.
  const { record, result } = await mutateRecord(locksRoot, params.lock_id, (record) => {
    // Validate the task BEFORE mutating anything: a call carrying both a bad
    // task_text and a good scope amendment must fail whole, not half-apply the
    // amendment and then report an error the agent reads as "nothing happened".
    const task =
      params.task_text === undefined ? undefined : record.tasks.find((t) => t.text === params.task_text);
    if (params.task_text !== undefined && !task) {
      throw new TaskNotFoundError(
        params.lock_id,
        params.task_text,
        record.tasks.map((t) => t.text),
      );
    }

    const previousScope = record.frontmatter.scope ?? [];
    const amendment = applyScopeAmendment(previousScope, params);

    if (task) task.done = params.done as boolean;

    if (params.note) {
      record.notes.push(params.note);
    }

    if (amendment.changed) {
      const now = formatTimestamp();
      // Append rather than overwrite. `scope` alone answers "what does this
      // claim now"; the history is what answers "what did it claim when the
      // other agent checked" — the question a collision is actually
      // reconstructed from.
      record.frontmatter.scope_history = [
        ...(record.frontmatter.scope_history ?? []),
        { replaced_at: now, scope: previousScope },
      ];
      record.frontmatter.scope = amendment.next;
      if (amendment.removed.length > 0) {
        // OWNERSHIP, enforced exactly as far as the data allows — the same shape as
        // finishLock, and gated on the NARROWING rather than on amendment at large.
        // Widening stays frictionless; only the operation that takes protection away
        // is refused, and only when both identities are known and differ. Most locks
        // carry agent_id null, so requiring a match would strand them.
        //
        // Evaluated here, inside the guard, against the freshly-read record: deciding
        // "is this mine?" from an earlier scan can pass on a holder that no longer
        // holds it.
        const holder = record.frontmatter.agent_id;
        const foreign =
          params.agent_id != null && holder != null && !agentMatches(holder, params.agent_id);
        if (foreign && !params.force) {
          throw new ScopeNarrowingRefusedError(
            params.lock_id,
            holder,
            params.agent_id as string,
            amendment.removed,
          );
        }
        if (foreign) {
          record.notes.push(
            `Scope force-narrowed by ${params.agent_id}, which is NOT the holder (${holder}). ` +
              `Dropped ${amendment.removed.map((g) => `\`${g}\``).join(', ')}. This note is the only ` +
              `record that another session's claim was reduced.`,
          );
        }
        // Mirror lock_reap's auto-generated honesty note. A narrowing removes
        // protection from files that may still be in flight, and unlike a reap
        // it leaves the lock reading as active and healthy — so the fact that
        // it happened has to be discoverable by lock_query's text search
        // rather than only by reading the raw file.
        record.notes.push(
          `Scope narrowed at ${now}: no longer claims ${amendment.removed.map((g) => `\`${g}\``).join(', ')}. ` +
            `Those paths are now invisible to other agents' conflict checks.`,
        );
      }
    }

    // Backfill the repository on any write that finds it missing, so a lock
    // written before the field existed stops permanently reporting "cannot
    // confirm which worktree this came from" once a current server touches it.
    if (!record.frontmatter.repository && params.repository) {
      record.frontmatter.repository = params.repository;
    }

    record.frontmatter.updated = formatTimestamp();
    return { amendment, previousScope };
  });

  const { amendment, previousScope } = result;
  const scope = record.frontmatter.scope;
  const warnings: string[] = [];
  if (amendment.changed && record.frontmatter.status !== 'active') {
    // Reuse drift's framing: conflict checks read ACTIVE locks only, so the
    // scope-check prompt's promise ("peers can now see these globs") is simply
    // false for an archived lock. Saying nothing would leave the agent holding
    // a protection claim the tool cannot honour.
    warnings.push(
      `This lock is already ${record.frontmatter.status}, and lock_check_conflict reads active locks only — ` +
        'so amending its scope changes nothing about what other agents can see.',
    );
  }
  if (amendment.removed.length > 0) {
    warnings.push(
      `This narrowed the claim: ${amendment.removed.map((g) => `\`${g}\``).join(', ')} are no longer covered, ` +
        'so any work you still have in flight there is now invisible to other agents\' conflict checks.',
    );
  }

  return {
    id: record.frontmatter.id,
    percentComplete: computePercentComplete(record.tasks),
    scope,
    scopeChanged: amendment.changed,
    ...(amendment.changed ? { previousScope } : {}),
    ...(amendment.removed.length > 0 ? { removedFromScope: amendment.removed } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    scopeCheck: formatScopeCheck(scope, params.dialect ?? 'mcp', record.frontmatter.id),
  };
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
  // The ownership gate runs INSIDE the guard, against the record as freshly read.
  // Checking it against an earlier scan would decide "is this mine?" from a copy
  // that another session may already have replaced — the check would pass on a
  // holder that no longer holds it.
  const { record } = await mutateRecord(locksRoot, params.lock_id, (record) => {
    if (record.frontmatter.status !== 'active') throw new LockNotActiveError(params.lock_id);

    if (params.summary) record.notes.push(params.summary);

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
          `This note is the only record that the claim was ended by someone other than ` +
          `whoever made it.`,
      );
    }

    record.frontmatter.status = 'done';
    record.frontmatter.updated = formatTimestamp();
    // Setting filePath is what tells mutateRecord to complete the move; it
    // writes the new file and removes the old one inside the held guard, so the
    // lock is never observable in both active/ and done/.
    record.filePath = path.join(doneDir(locksRoot), path.basename(record.filePath));
  });
  return { id: record.frontmatter.id, filePath: record.filePath };
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
  const { record } = await mutateRecord(locksRoot, params.lock_id, (record) => {
    // Restricted to active locks — heartbeating finished work is not a
    // meaningful operation and would be a new footgun, not a feature.
    if (record.frontmatter.status !== 'active') throw new LockNotActiveError(params.lock_id);
    record.frontmatter.updated = formatTimestamp();
  });
  return { id: record.frontmatter.id, updated: record.frontmatter.updated };
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

    await ensureDirs(locksRoot);
    await mutateRecord(locksRoot, record.frontmatter.id, (fresh) => {
      if (fresh.frontmatter.status !== 'active') throw new LockNotActiveError(fresh.frontmatter.id);
      // Record the EXACT prior last-touch stamp before overwriting it below.
      // `updated` is set to now on reap, which erases the inter-touch interval — the
      // one quantity anyone tuning the staleness threshold needs. A minute-rounded
      // English sentence is not a recoverable datum, so keep the raw timestamp.
      // Read it from the FRESHLY-read record, not from the candidate scanned
      // earlier: under the guard those can differ, and the stamp is only useful
      // if it is the one actually being overwritten.
      fresh.notes.push(
        `Auto-reaped: last touched ${fresh.frontmatter.updated} (UTC), ` +
          `no activity for ${Math.round(summary.staleForSeconds / 60)} minute(s), ` +
          `threshold ${staleMinutes} minute(s).`,
      );
      fresh.frontmatter.status = 'done';
      fresh.frontmatter.updated = formatTimestamp();
      fresh.filePath = path.join(doneDir(locksRoot), path.basename(fresh.filePath));
    });
  }

  return reaped;
}
