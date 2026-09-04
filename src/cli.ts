/**
 * Module: human-facing CLI for agent-locks.
 *
 * The MCP tools in server.ts are the primary interface (an agent talking to
 * this server over stdio JSON-RPC); this module is a thin, dependency-free
 * wrapper around the exact same lock/store.ts functions, for two audiences:
 *
 * 1. A human at a terminal who wants to see or manage lock state directly
 *    (`agent-locks status`, `agent-locks list`, ...) without going through
 *    an agent.
 * 2. Any agent harness that can run a shell command but does not (or does
 *    not yet) speak MCP — the same coordination guarantees this tool
 *    provides are available via a plain subprocess call and exit code.
 *
 * No new dependency was added for argument parsing — subcommands and their
 * flags are small and fixed enough that a hand-rolled parser keeps this in
 * line with the project's existing minimal dependency footprint (only
 * @modelcontextprotocol/sdk, gray-matter, minimatch, zod).
 *
 * Every subcommand resolves its own locksRoot fresh via resolveLocksRoot()
 * (no caching), exactly like every MCP tool handler in server.ts — running
 * the CLI from a different worktree of the same repo than a concurrent
 * agent session still coordinates correctly, for the same git-common-dir
 * reason documented in git.ts.
 */
import { resolveLocksRoot, resolveRepoRoot, NotAGitRepoError } from './git.js';
import {
  lastReapFloor,
  lastUnreadableLocks,
  createLock,
  queryLocks,
  checkConflicts,
  updateLock,
  finishLock,
  heartbeatLock,
  reapStaleLocks,
  LockNotFoundError,
  TaskNotFoundError,
  LockNotActiveError,
  LockNotOwnedError,
  LockNotStaleError,
  LockNotDoneError,
  NoOpUpdateError,
  ScopeNotHeldError,
  EmptyScopeError,
  ReopenReasonRequiredError,
  reopenLock,
} from './lock/store.js';
import { readEvents, lastEventLogErrors } from './lock/events.js';
import type { LockSummary } from './lock/types.js';

const USAGE = `agent-locks — filesystem-based work-claiming locks for AI coding agents, shared across every git worktree of the current repository.

Usage:
  agent-locks                           Start the MCP stdio server (same as running with no args — this is what an MCP client config should use).
  agent-locks serve                     Same as above, explicit.
  agent-locks status                    Human-readable summary of active locks.
  agent-locks list [options]            List locks. See "agent-locks list --help".
  agent-locks check <scope...>          Check whether any active lock overlaps the given glob(s). Informational only — exits 0 either way.
  agent-locks claim [options]           Create a new lock. See "agent-locks claim --help".
  agent-locks update <lock-id> [options]  Mark a task done/undone on an existing lock. See "agent-locks update --help".
  agent-locks finish <lock-id> [--summary <text>] [--agent <id>] [--force]  Mark a lock done and archive it. Pass --agent so ownership can be checked; --force is required (and recorded) to end another session's claim.
  agent-locks heartbeat <lock-id>        Bump a lock's updated timestamp with no other change. See "Staleness detection" in the README.
  agent-locks reap [lock-id] [options]  Finish stale lock(s). See "agent-locks reap --help".
  agent-locks reopen <lock-id> [options]  Return an archived lock to active. See "agent-locks reopen --help".
  agent-locks events [options]          Read the append-only lock event log. See "agent-locks events --help".
  agent-locks --help                    Show this message.

Every subcommand talks to the exact same lock store the MCP tools use — a human running "agent-locks status" and an agent calling lock_query see identical, live state.

Every lock subcommand above (all except "serve") accepts --base-dir <path> to operate on a
different repository instead of the current directory — any path inside the target repo will
do. A --base-dir that is not inside a git repository is a hard error, never a silent fallback
to the current directory.`;

const LIST_USAGE = `agent-locks list [options]

Options:
  --status <active|done|all>   Which locks to include. Default: active.
  --scope <glob>                Only locks whose scope overlaps this glob. Repeatable.
  --agent <id>                  Only locks with this exact agent_id.
  --text <query>                Case-insensitive substring search over title + notes.
  --stale-minutes <n>           Override the staleness threshold (minutes) for this call only.
  --base-dir <path>             Resolve locks from a different repository (any path inside it).
  --json                        Print raw JSON instead of a formatted table.`;

const CLAIM_USAGE = `agent-locks claim [options]

Options:
  --title <text>        Required. Short description of the work.
  --scope <glob>         Required. Glob pattern this lock claims. Repeatable.
  --task <text>          A task to track on this lock. Repeatable; order preserved.
  --agent <id>           Your own agent id, if you have one. Never fabricated if omitted.
  --parent <id>          Your parent agent's id, if known.
  --base-dir <path>      Create the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;

const UPDATE_USAGE = `agent-locks update <lock-id> [options]

Changes a lock: flip a task, append a note, and/or CHANGE ITS SCOPE. At least one of
--task, --note, --add-scope or --remove-scope is required — an update that would change
nothing is refused rather than silently bumping the timestamp, which would be a
heartbeat wearing an update's name. Use "agent-locks heartbeat" if that is what you want.

Options:
  --task <text>          Must match an existing task's text exactly.
  --done                 Mark the task done (default if neither --done nor --undone given).
  --undone               Mark the task not done.
  --note <text>           Append a free-text note to the lock.
  --agent <id>           Your own agent id. Supply it so ownership can be checked:
                          updating a lock held by a DIFFERENT session is refused unless
                          --force is given. Omit it and no check is possible.
  --force                Deliberately update another session's lock. Recorded in its notes.
  --add-scope <glob>     Add a glob to this lock's scope. Repeatable. Adding a glob the
                          lock already holds changes nothing and is refused as a no-op,
                          so it cannot be used as a disguised heartbeat.
  --remove-scope <glob>  Remove a glob from this lock's scope. Repeatable. Errors if the
                          lock does not hold it, and refuses to empty the scope entirely.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.

Scope drift is the NORMAL case: you claim what you expect to touch, then discover the job
reaches one more file. Extend the existing claim rather than creating a second lock — a
second lock for one job splits the task checklist and leaves a window where the new paths
are claimed by nobody.`;

const REOPEN_USAGE = `agent-locks reopen <lock-id> [options]

Returns a lock from the done archive to active. This is the recovery path for a lock that
auto-reap took from a session that was still working: re-claiming instead would create a
second record, lose the checklist, and leave the paths unclaimed in between.

A lock finished by REAP reopens with no reason required. A lock its owner deliberately
finished requires --reason, which is recorded — reopen is a recovery path, not a general
back door into the archive.

Reopening a reaped lock also records a labelled FALSE POSITIVE in the event log: direct
evidence, with the interval attached, that the staleness threshold was too short.

Options:
  --reason <text>        Why. Required unless the lock was finished by reap.
  --agent <id>           Your own agent id, if you have one. Recorded, never enforced.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;

const EVENTS_USAGE = `agent-locks events [options]

Reads the append-only event log — reaps and reopens, oldest first. This is the data behind
any future change to the staleness threshold: tune on the distribution of inter-touch
intervals for locks that turned out to be ALIVE, which means the reaps that were later
reopened. The threshold must exceed the TAIL of that distribution, not its median.

Options:
  --type <reap|reopen>   Only events of this type.
  --lock <lock-id>       Only events for this lock.
  --limit <n>            Return at most n events, the most recent ones.
  --base-dir <path>      Read the log of a different repository (any path inside it).
  --json                 Print raw JSON instead of a formatted table.`;

const REAP_USAGE = `agent-locks reap [lock-id] [options]

Reaps (finishes, same as "agent-locks finish") every currently-stale active lock, or a
single one if lock-id is given. Refuses to reap a named lock-id that isn't actually
stale — never a back door to force-finish someone else's live work.
A supplied --stale-minutes may only LENGTHEN the window, never shorten it: it is
floored at the configured default, so this cannot be used to reap live locks.

Options:
  --stale-minutes <n>    Override the staleness threshold for this call only. Defaults
                          to AGENT_LOCKS_STALE_MINUTES or 60.
  --dry-run              Report what would be reaped without writing anything.
  --base-dir <path>      Reap locks in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;

class CliUsageError extends Error {}

const CLI_PREFIX = 'agent-locks: ';

/**
 * Writes an error line prefixed with the tool name, unless the message already
 * carries that prefix.
 *
 * NotAGitRepoError deliberately self-identifies: its message is also surfaced
 * verbatim through the MCP error path, where nothing else names the tool, so
 * the prefix has to live in the message itself. Blindly re-prefixing it here
 * produced "agent-locks: agent-locks: ...". Checking rather than special-casing
 * that one class keeps this correct for any future self-identifying message.
 */
function printError(message: string): void {
  console.error(message.startsWith(CLI_PREFIX) ? message : `${CLI_PREFIX}${message}`);
}

interface ParsedFlags {
  positionals: string[];
  flags: Map<string, string[]>;
  boolFlags: Set<string>;
}

const BOOLEAN_FLAGS = new Set(['--json', '--done', '--undone', '--help', '--dry-run', '--force']);
// --force must be declared here or the parser treats it as value-taking and errors
// with "Flag --force requires a value" — which reads as a usage mistake rather than
// a missing registration, so the escape hatch appears broken rather than absent.

function parseArgs(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const boolFlags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      boolFlags.add(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`Flag ${arg} requires a value.`);
    }
    const existing = flags.get(arg) ?? [];
    existing.push(value);
    flags.set(arg, existing);
    i += 1;
  }

  return { positionals, flags, boolFlags };
}

function oneOf(flags: ParsedFlags['flags'], name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  return values[values.length - 1];
}

function allOf(flags: ParsedFlags['flags'], name: string): string[] {
  return flags.get(name) ?? [];
}


/**
 * Print any lock the store could not read.
 *
 * WITHOUT THIS the corrupt-lock fix is worse than the bug it replaced: a truncated
 * lock used to CRASH (loud, wrong, but visible); after the fix it is skipped, so the
 * store reports "(no locks)" with exit 0 and a real claim is invisible. Recording the
 * condition in `lastUnreadableLocks` is worth nothing until something prints it.
 *
 * CALL IT FROM EVERY READ COMMAND, not from the table renderer. An earlier version
 * lived inside formatLockTable, so `--json` — the form a hook or script uses — skipped
 * it entirely and reported a corrupt lock as no lock. Placement, not presence, was the
 * defect. Verified by running each surface.
 */
function warnUnreadable(): void {
  if (lastUnreadableLocks.length === 0) return;
  console.error(
    `WARNING: ${lastUnreadableLocks.length} lock file(s) could not be read and are NOT ` +
      `included below. A claim you cannot see is a claim you will collide with.`,
  );
  for (const bad of lastUnreadableLocks) {
    console.error(`  ${bad.filePath}: ${bad.reason}`);
  }
}

/**
 * Same contract as warnUnreadable, for the event log: a corrupt or unwritable log must
 * be visible, because "the log is empty" and "the log is broken" otherwise look
 * identical — and the whole point of the log is that an empty result MEANS something
 * (nothing was reaped). Wired into every command that reads or writes it, for the same
 * reason warnUnreadable is wired into every read surface rather than the renderer.
 */
function warnEventLog(): void {
  if (lastEventLogErrors.length === 0) return;
  console.error(
    `WARNING: ${lastEventLogErrors.length} problem(s) with the event log. Reap/reopen ` +
      `history may be incomplete, so an empty result here does NOT mean nothing happened.`,
  );
  for (const bad of lastEventLogErrors) {
    console.error(`  [${bad.phase}] ${bad.reason}`);
  }
}

function formatStaleForSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatLockTable(locks: LockSummary[]): string {
  if (locks.length === 0) return '(no locks)';
  const rows = locks.map((lock) => [
    lock.id,
    lock.status,
    `${lock.percentComplete}%`,
    lock.status === 'active' ? (lock.stale ? `yes (${formatStaleForSeconds(lock.staleForSeconds)})` : 'no') : '-',
    lock.agent_id ?? '(unknown agent)',
    lock.scope.join(', '),
    lock.title,
  ]);
  const header = ['ID', 'STATUS', 'DONE', 'STALE', 'AGENT', 'SCOPE', 'TITLE'];
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const formatRow = (row: string[]): string => row.map((cell, col) => cell.padEnd(widths[col])).join('  ');
  return [formatRow(header), formatRow(header.map((h) => '-'.repeat(h.length))), ...rows.map(formatRow)].join('\n');
}

/** Shared by list/check/reap — parses and validates --stale-minutes, if given. */
function parseStaleMinutesFlag(flags: ParsedFlags): number | undefined {
  const raw = oneOf(flags.flags, '--stale-minutes');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`--stale-minutes must be a positive number (got "${raw}").`);
  }
  return parsed;
}

function resolveBaseDir(flags: ParsedFlags): string {
  const raw = oneOf(flags.flags, '--base-dir');
  return raw ?? process.cwd();
}

async function cmdStatus(flags: ParsedFlags): Promise<void> {
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const locks = await queryLocks(locksRoot, {});
  warnUnreadable(); // EVERY read surface, not the renderer — --json bypassed it (Y1)
  console.log(`agent-locks: ${locks.length} active lock(s) in ${locksRoot}\n`);
  console.log(formatLockTable(locks));
}

async function cmdList(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(LIST_USAGE);
    return;
  }
  const status = oneOf(flags.flags, '--status') as 'active' | 'done' | 'all' | undefined;
  if (status !== undefined && !['active', 'done', 'all'].includes(status)) {
    throw new CliUsageError(`--status must be one of active, done, all (got "${status}").`);
  }
  const scope = allOf(flags.flags, '--scope');
  const agent_id = oneOf(flags.flags, '--agent');
  const text = oneOf(flags.flags, '--text');
  const stale_minutes = parseStaleMinutesFlag(flags);

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const locks = await queryLocks(locksRoot, {
    status,
    scope: scope.length > 0 ? scope : undefined,
    agent_id,
    text,
    stale_minutes,
  });
  warnUnreadable(); // EVERY read surface, not the renderer — --json bypassed it (Y1)

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(locks, null, 2));
  } else {
    console.log(formatLockTable(locks));
  }
}

async function cmdCheck(flags: ParsedFlags): Promise<void> {
  const scope = flags.positionals;
  if (scope.length === 0) {
    throw new CliUsageError('agent-locks check requires at least one scope glob, e.g. "agent-locks check src/auth/**".');
  }
  const stale_minutes = parseStaleMinutesFlag(flags);
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const conflicts = await checkConflicts(locksRoot, scope, stale_minutes);
  warnUnreadable(); // EVERY read surface, not the renderer — --json bypassed it (Y1)
  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
  if (conflicts.length === 0) {
    console.log(`No active locks overlap ${scope.join(', ')}.`);
    return;
  }
  console.log(`${conflicts.length} active lock(s) overlap ${scope.join(', ')} — informational only, nothing is blocked:\n`);
  console.log(formatLockTable(conflicts));
}

async function cmdClaim(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(CLAIM_USAGE);
    return;
  }
  const title = oneOf(flags.flags, '--title');
  if (!title) throw new CliUsageError('agent-locks claim requires --title. See "agent-locks claim --help".');
  const scope = allOf(flags.flags, '--scope');
  if (scope.length === 0) throw new CliUsageError('agent-locks claim requires at least one --scope. See "agent-locks claim --help".');
  const tasks = allOf(flags.flags, '--task');
  const agent_id = oneOf(flags.flags, '--agent') ?? null;
  const parent_agent_id = oneOf(flags.flags, '--parent') ?? null;

  const cwd = resolveBaseDir(flags);
  const [locksRoot, repoRoot] = await Promise.all([
    resolveLocksRoot(cwd),
    resolveRepoRoot(cwd),
  ]);
  const result = await createLock(locksRoot, { title, scope, tasks, agent_id, parent_agent_id, repository: repoRoot });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Claimed "${title}" as lock ${result.id}`);
  }
}

async function cmdUpdate(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(UPDATE_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks update requires a lock id as its first argument. See "agent-locks update --help".');
  const taskText = oneOf(flags.flags, '--task');
  const addScope = allOf(flags.flags, '--add-scope');
  const removeScope = allOf(flags.flags, '--remove-scope');
  const note = oneOf(flags.flags, '--note');
  if (!taskText && addScope.length === 0 && removeScope.length === 0 && note === undefined) {
    throw new CliUsageError(
      'agent-locks update requires at least one of --task, --note, --add-scope or --remove-scope. See "agent-locks update --help".',
    );
  }
  if (flags.boolFlags.has('--done') && flags.boolFlags.has('--undone')) {
    throw new CliUsageError('Pass at most one of --done / --undone.');
  }
  const done = !flags.boolFlags.has('--undone');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await updateLock(locksRoot, {
    lock_id: lockId,
    // Pass identity THROUGH. Store-level ownership is inert if the surface never says
    // who is calling — the same last-hop failure that let the CLI archive another
    // session's lock while finishLock's check was already in place.
    agent_id: oneOf(flags.flags, '--agent'),
    force: flags.boolFlags.has('--force'),
    task_text: taskText,
    done: taskText === undefined ? undefined : done,
    note,
    add_scope: addScope.length > 0 ? addScope : undefined,
    remove_scope: removeScope.length > 0 ? removeScope : undefined,
  });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // Report every part that changed, including the scope — a scope edit that lands
  // silently is one the caller cannot confirm without a second command, and an
  // unconfirmed claim boundary is the thing this tool exists to make legible.
  const parts: string[] = [];
  if (taskText) parts.push(`"${taskText}" marked ${done ? 'done' : 'not done'} (${result.percentComplete}% complete overall)`);
  if (addScope.length > 0) parts.push(`scope +${addScope.join(', +')}`);
  if (removeScope.length > 0) parts.push(`scope -${removeScope.join(', -')}`);
  if (note !== undefined) parts.push('note appended');
  console.log(`Lock ${result.id}: ${parts.join('; ')}.`);
  if (addScope.length > 0 || removeScope.length > 0) {
    console.log(`  scope now: ${result.scope.join(', ')}`);
  }
}

async function cmdReopen(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(REOPEN_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks reopen requires a lock id as its first argument. See "agent-locks reopen --help".');
  const reason = oneOf(flags.flags, '--reason');
  const agent_id = oneOf(flags.flags, '--agent');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await reopenLock(locksRoot, { lock_id: lockId, reason, agent_id });
  warnEventLog();

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Lock ${result.id} reopened and returned to active.`);
  if (result.false_positive) {
    // Say it out loud. This is the one signal that says the staleness threshold is
    // wrong, and a signal recorded only in a log nobody opens is a signal nobody acts on.
    console.log(
      `  This lock had been AUTO-REAPED, so the reap was a false positive: the holder was still working. ` +
        `Recorded in the event log as evidence the staleness threshold is too short.`,
    );
  } else {
    console.log(`  Previously finished by: ${result.previously_finished_by ?? 'an unrecorded path'}.`);
  }
}

async function cmdEvents(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(EVENTS_USAGE);
    return;
  }
  const type = oneOf(flags.flags, '--type');
  if (type !== undefined && type !== 'reap' && type !== 'reopen') {
    throw new CliUsageError(`--type must be one of reap, reopen (got "${type}").`);
  }
  const limitRaw = oneOf(flags.flags, '--limit');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) throw new CliUsageError(`--limit must be a positive integer (got "${limitRaw}").`);
  }

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const events = await readEvents(locksRoot, { type, lock_id: oneOf(flags.flags, '--lock'), limit });
  warnEventLog();

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  if (events.length === 0) {
    console.log('No lock events recorded. Nothing has been reaped or reopened in this repository.');
    return;
  }
  for (const event of events) {
    if (event.event === 'reap') {
      console.log(
        `${event.ts}  REAP    ${event.lock_id}\n` +
          `    idle ${event.idle_seconds}s at a ${event.threshold_minutes}m threshold; ` +
          `${event.tasks_done}/${event.tasks_total} tasks done; holder ${event.agent_id ?? '(none recorded)'}`,
      );
    } else {
      console.log(
        `${event.ts}  REOPEN  ${event.lock_id}\n` +
          `    ${event.false_positive ? 'FALSE POSITIVE — reaped while alive' : `from a ${event.finished_by ?? 'unrecorded'} finish`}` +
          (event.idle_at_reap_seconds === null ? '' : `; had been idle ${event.idle_at_reap_seconds}s when reaped`) +
          (event.reason === null ? '' : `; reason: ${event.reason}`),
      );
    }
  }
  const falsePositives = events.filter((e) => e.event === 'reopen' && e.false_positive).length;
  const reaps = events.filter((e) => e.event === 'reap').length;
  if (reaps > 0) {
    console.log(
      `\n${reaps} reap(s), ${falsePositives} later reopened as false positive(s). ` +
        `Tune the threshold above the TAIL of the idle intervals that turned out to be alive, not their median.`,
    );
  }
}

async function cmdFinish(flags: ParsedFlags): Promise<void> {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks finish requires a lock id as its first argument.');
  const summary = oneOf(flags.flags, '--summary');
  // Pass identity THROUGH. Store-level ownership enforcement is inert if the surface
  // never supplies who is calling — the enforcement existed and the CLI still archived
  // another session's lock, exit 0. Verified by running it.
  const agent_id = oneOf(flags.flags, '--agent');
  const force = flags.boolFlags.has('--force');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await finishLock(locksRoot, { lock_id: lockId, summary, agent_id, force });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id} finished and archived.`);
  }
}

async function cmdHeartbeat(flags: ParsedFlags): Promise<void> {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks heartbeat requires a lock id as its first argument.');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await heartbeatLock(locksRoot, { lock_id: lockId });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id} heartbeat sent (updated: ${result.updated}).`);
  }
}

async function cmdReap(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(REAP_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  const stale_minutes = parseStaleMinutesFlag(flags);
  const dry_run = flags.boolFlags.has('--dry-run');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const reaped = await reapStaleLocks(locksRoot, { lock_id: lockId, stale_minutes, dry_run });
  warnUnreadable(); // EVERY read surface, not the renderer — --json bypassed it (Y1)

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify({ reaped, floor: lastReapFloor }, null, 2));
    return;
  }
  // Report the floor whether or not anything was reaped. An earlier version mentioned
  // it only in the zero-reaped branch, so "asked for 1, used 60, reaped 2" said nothing
  // about the threshold that actually ran.
  if (lastReapFloor) {
    console.log(
      `Note: a per-call threshold may only LENGTHEN the reaping window. You asked for ` +
        `${lastReapFloor.requested} minute(s); ${lastReapFloor.applied} minute(s) was used. ` +
        `Lower AGENT_LOCKS_STALE_MINUTES to reap more aggressively — a visible, global choice.`,
    );
  }
  if (reaped.length === 0) {
    console.log(
      lastReapFloor
        ? `No locks reaped at the ${lastReapFloor.applied}-minute threshold that was used. ` +
            `Locks stale by your requested ${lastReapFloor.requested} minute(s) but not by that ` +
            `one were left alone.`
        : 'No stale locks to reap.',
    );
    return;
  }
  const verb = dry_run ? 'Would reap' : 'Reaped';
  console.log(`${verb} ${reaped.length} lock(s):`);
  for (const lock of reaped) {
    console.log(`  ${lock.id} — "${lock.title}" (stale for ${formatStaleForSeconds(lock.staleForSeconds)})`);
  }
}

/**
 * Runs the CLI for the given argv (excluding the node/script prefix, i.e.
 * process.argv.slice(2)) and returns the process exit code. Never calls
 * process.exit itself so it stays testable in-process.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case 'status':
        await cmdStatus(parseArgs(rest));
        return 0;
      case 'list':
        await cmdList(parseArgs(rest));
        return 0;
      case 'check':
        await cmdCheck(parseArgs(rest));
        return 0;
      case 'claim':
        await cmdClaim(parseArgs(rest));
        return 0;
      case 'update':
        await cmdUpdate(parseArgs(rest));
        return 0;
      case 'finish':
        await cmdFinish(parseArgs(rest));
        return 0;
      case 'heartbeat':
        await cmdHeartbeat(parseArgs(rest));
        return 0;
      case 'reap':
        await cmdReap(parseArgs(rest));
        return 0;
      case 'reopen':
        await cmdReopen(parseArgs(rest));
        return 0;
      case 'events':
        await cmdEvents(parseArgs(rest));
        return 0;
      default:
        console.error(`agent-locks: unknown command "${command}".\n`);
        console.error(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      printError(error.message);
      return 1;
    }
    if (
      error instanceof NotAGitRepoError ||
      error instanceof LockNotFoundError ||
      error instanceof TaskNotFoundError ||
      error instanceof LockNotActiveError ||
      error instanceof LockNotOwnedError ||
      error instanceof LockNotStaleError ||
      error instanceof LockNotDoneError ||
      error instanceof NoOpUpdateError ||
      error instanceof ScopeNotHeldError ||
      error instanceof EmptyScopeError ||
      error instanceof ReopenReasonRequiredError
    ) {
      printError(error.message);
      return 1;
    }
    printError(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}
