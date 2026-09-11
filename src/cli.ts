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
import { resolveLocksRoot, resolveRepoRoot, resolveHeadSha, NotAGitRepoError } from './git.js';
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
  ScopeNarrowingRefusedError,
  LockNotStaleError,
  ScopeAmendmentError,
  EmptyScopeError,
  EmptyUpdateError,
  IncompleteTaskUpdateError,
} from './lock/store.js';
import { checkScopeDrift } from './lock/drift.js';
import { VERSION } from './version.js';
import type { LockSummary } from './lock/types.js';

const USAGE = `agent-locks — filesystem-based work-claiming locks for AI coding agents, shared across every git worktree of the current repository.

Usage:
  agent-locks                           Start the MCP stdio server (same as running with no args — this is what an MCP client config should use).
  agent-locks serve                     Same as above, explicit.
  agent-locks status                    Human-readable summary of active locks.
  agent-locks list [options]            List locks. See "agent-locks list --help".
  agent-locks check <scope...>          Check whether any active lock overlaps the given glob(s). Informational only — exits 0 either way.
  agent-locks claim [options]           Create a new lock. See "agent-locks claim --help".
  agent-locks update <lock-id> [options]  Mark a task done/undone, amend the scope, and/or add a note. See "agent-locks update --help".
  agent-locks drift <lock-id> [options]   Show which of this working tree's changed files a lock's scope does NOT cover.
  agent-locks finish <lock-id> [--summary <text>] [--agent <id>] [--force]  Mark a lock done and archive it. Pass --agent so ownership can be checked; --force is required (and recorded) to end another session's claim.
  agent-locks heartbeat <lock-id>        Bump a lock's updated timestamp with no other change. See "Staleness detection" in the README.
  agent-locks reap [lock-id] [options]  Finish stale lock(s). See "agent-locks reap --help".
  agent-locks --version                 Print the version. Use it to tell which build a worktree is running.
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

Checks a task off, amends the lock's scope, and/or appends a note — any combination, at
least one required.

Amending scope is expected, not exceptional: you declare it at claim time, which is when
you know least about what you will touch, and conflict checks match whatever globs are
recorded now. Every file you touch outside them is invisible to any other agent looking
for a conflict. Run "agent-locks drift <lock-id>" to see which of your changed files are
currently uncovered.

Options:
  --task <text>          Must match an existing task's text exactly. Optional — omit it if you
                          are only amending scope or adding a note.
  --done                 Mark the task done. Requires --task. Default when --task is given and
                          neither --done nor --undone is.
  --undone               Mark the task not done. Requires --task.
  --add-scope <glob>     Add a glob to the lock's existing scope. Repeatable. The usual amendment.
  --set-scope <glob>     Replace the lock's whole scope with these globs. Repeatable. Use to
                          narrow a lock that over-claimed. Mutually exclusive with --add-scope.
  --agent <id>           Your own agent id, so ownership can be checked when this narrows
                          the claim. Widening never needs it.
  --force                Proceed with a narrowing that would otherwise be refused because
                          the lock is held by someone else. Recorded on the lock.
  --note <text>           Append a free-text note to the lock.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;

const DRIFT_USAGE = `agent-locks drift <lock-id> [options]

Compares what the lock CLAIMS against what this working tree has actually changed, and
lists every changed file the lock's scope does not cover. Changed files come from
"git status" (staged, unstaged and untracked alike) PLUS every file touched by a commit
made since the lock was claimed; coverage uses the same glob matcher the conflict check
uses, so a file listed here is exactly a file another agent's conflict check would NOT
surface this lock for.

Read-only — it never amends anything. Fix what it reports with
"agent-locks update <lock-id> --add-scope <glob>".

WHAT THIS CANNOT SEE, so that a clean result is not read for more than it is worth:
  - files git ignores (a .env, a generated config, an ignored build dir) — the count of
    them is reported, but their names and their drift are not knowable here;
  - work committed BEFORE the lock was claimed;
  - anything outside this working tree, and the contents of submodules;
  - and if nothing changed at all, nothing was compared — that is reported as
    outcome: NOTHING_MEASURED, which is not the same as "your scope is right".

Only meaningful for your own lock in your own worktree: run against a lock created
elsewhere, it compares that lock's scope to files its owner is not editing, and a clean
result means nothing. Read the warnings — they print above the verdict for a reason.

Options:
  --base-dir <path>      Look up the lock, and read the changed files, from a different
                          repository (any path inside it).
  --json                 Print raw JSON instead of a formatted report.`;

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

/**
 * Every flag each subcommand accepts. Anything else is a usage error.
 *
 * WHY REJECTING IS LOAD-BEARING, not tidiness: this parser used to sweep any
 * `--flag value` into its map and ignore what no subcommand read. So a version
 * of this CLI that predates a flag ACCEPTS it, prints a success line, and exits
 * 0 having done nothing with it. Verified against the previous build:
 * `update <id> --task t --done --add-scope 'newpkg/**'` reported the task done
 * and left the scope untouched. During any window where two builds coexist — a
 * worktree checked out before an upgrade, a second machine, a rollback — that
 * turns an amendment into a silent no-op the agent is told succeeded, which is
 * precisely the class of failure this whole feature exists to remove. An old
 * binary must never accept a new instruction it cannot carry out.
 */
const SUBCOMMAND_FLAGS: Record<string, string[]> = {
  status: ['--base-dir', '--json'],
  list: ['--status', '--scope', '--agent', '--text', '--stale-minutes', '--base-dir', '--json', '--help'],
  check: ['--stale-minutes', '--base-dir', '--json', '--help'],
  claim: ['--title', '--scope', '--task', '--agent', '--parent', '--base-dir', '--json', '--help'],
  update: [
    '--task', '--done', '--undone', '--add-scope', '--set-scope', '--note',
    '--agent', '--force', '--base-dir', '--json', '--help',
  ],
  drift: ['--base-dir', '--json', '--help'],
  finish: ['--summary', '--agent', '--force', '--base-dir', '--json', '--help'],
  heartbeat: ['--base-dir', '--json', '--help'],
  reap: ['--stale-minutes', '--dry-run', '--base-dir', '--json', '--help'],
};

function rejectUnknownFlags(command: string, parsed: ParsedFlags): void {
  const allowed = SUBCOMMAND_FLAGS[command];
  if (!allowed) return;
  const used = [...parsed.flags.keys(), ...parsed.boolFlags];
  for (const flag of used) {
    if (!allowed.includes(flag)) {
      throw new CliUsageError(
        `unknown flag ${flag} for "agent-locks ${command}". Accepted: ${allowed.join(', ')}. ` +
          `Refusing rather than ignoring it — a flag this build silently dropped would report success while doing nothing.`,
      );
    }
  }
}

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
  const [locksRoot, repoRoot, head] = await Promise.all([
    resolveLocksRoot(cwd),
    resolveRepoRoot(cwd),
    resolveHeadSha(cwd),
  ]);
  const result = await createLock(locksRoot, {
    head,
    title,
    scope,
    tasks,
    agent_id,
    parent_agent_id,
    repository: repoRoot,
    dialect: 'cli',
  });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Claimed "${title}" as lock ${result.id}`);
    console.log(result.scopeCheck);
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
  if (flags.boolFlags.has('--done') && flags.boolFlags.has('--undone')) {
    throw new CliUsageError('Pass at most one of --done / --undone.');
  }
  // --done/--undone without --task names no task to flip. Rejecting here rather
  // than defaulting keeps a typo'd --task from silently becoming a scope-only
  // update that reports success while the task stays unchecked.
  if (!taskText && (flags.boolFlags.has('--done') || flags.boolFlags.has('--undone'))) {
    throw new CliUsageError('--done / --undone name how to flip a task, so they require --task. See "agent-locks update --help".');
  }
  const addScope = allOf(flags.flags, '--add-scope');
  const setScope = allOf(flags.flags, '--set-scope');
  if (addScope.length > 0 && setScope.length > 0) {
    throw new CliUsageError('Pass at most one of --add-scope (widen the claim) / --set-scope (replace it), not both.');
  }
  const note = oneOf(flags.flags, '--note');
  if (!taskText && addScope.length === 0 && setScope.length === 0 && note === undefined) {
    throw new CliUsageError(
      'agent-locks update needs something to do: --task (with --done/--undone), --add-scope, --set-scope, or --note. See "agent-locks update --help".',
    );
  }
  const done = taskText === undefined ? undefined : !flags.boolFlags.has('--undone');

  const cwd = resolveBaseDir(flags);
  const [locksRoot, repoRoot] = await Promise.all([resolveLocksRoot(cwd), resolveRepoRoot(cwd)]);
  const result = await updateLock(locksRoot, {
    lock_id: lockId,
    repository: repoRoot,
    task_text: taskText,
    done,
    note,
    agent_id: oneOf(flags.flags, '--agent') ?? null,
    force: flags.boolFlags.has('--force'),
    add_scope: addScope.length > 0 ? addScope : undefined,
    set_scope: setScope.length > 0 ? setScope : undefined,
    dialect: 'cli',
  });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (taskText !== undefined) {
    console.log(`Lock ${result.id}: "${taskText}" marked ${done ? 'done' : 'not done'} (${result.percentComplete}% complete overall).`);
  }
  for (const warning of result.warnings ?? []) {
    console.log(`warning: ${warning}`);
  }
  if (result.scopeChanged) {
    console.log(`Lock ${result.id}: scope amended.`);
    console.log(`  was: ${(result.previousScope ?? []).join(', ') || '(none)'}`);
    console.log(`  now: ${result.scope.join(', ')}`);
    if (result.removedFromScope?.length) {
      console.log(`  NO LONGER CLAIMED: ${result.removedFromScope.join(', ')}`);
    }
  }
  if (note !== undefined && taskText === undefined && !result.scopeChanged) {
    console.log(`Lock ${result.id}: note recorded.`);
  }
  console.log(result.scopeCheck);
}

async function cmdDrift(flags: ParsedFlags): Promise<void> {
  if (flags.boolFlags.has('--help')) {
    console.log(DRIFT_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks drift requires a lock id as its first argument. See "agent-locks drift --help".');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await checkScopeDrift(locksRoot, { lock_id: lockId, cwd, dialect: 'cli' });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Lock ${result.lock_id} — "${result.title}"`);
  console.log(`claims: ${result.scope.join(', ') || '(none)'}`);
  console.log(
    `${result.changedFileCount} changed file(s) in ${result.inspectedWorktree} ` +
      `(${result.uncommittedCount} uncommitted, ${result.committedSinceClaimCount} committed since the claim); ` +
      `${result.inScopeCount} covered by that scope.`,
  );
  // WARNINGS BEFORE THE VERDICT, deliberately. A reason the result may be
  // meaningless belongs ABOVE the result: `| head -n` is routine for keeping
  // tool output short, and printing the qualifier last is how a report about
  // the wrong worktree survives the pipe looking authoritative.
  for (const warning of result.warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log(`outcome: ${result.outcome}`);
  if (result.drifted) {
    console.log(`\nfiles changed outside that scope (${result.outOfScopeCount}):`);
    for (const file of result.outOfScope) console.log(`  ${file}`);
    if (result.outOfScopeTruncated > 0) {
      console.log(`  ... and ${result.outOfScopeTruncated} more (list capped)`);
    }
  } else if (result.outcome === 'NOTHING_MEASURED') {
    console.log('\nNo files were compared, so this says NOTHING about whether the scope is right.');
  } else {
    console.log('\nNo drift: every changed file is covered by the scope above.');
  }
  console.log(`\n${result.scopeCheck}`);
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

  const parsedFor = (name: string, args: string[]): ParsedFlags => {
    const parsed = parseArgs(args);
    rejectUnknownFlags(name, parsed);
    return parsed;
  };

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  // Without this there is no way to tell which build a worktree is running
  // short of counting tools or grepping the usage text — and "which build
  // wrote this lock file?" is the first question any field diagnosis asks.
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  try {
    switch (command) {
      case 'status':
        await cmdStatus(parsedFor(command, rest));
        return 0;
      case 'list':
        await cmdList(parsedFor(command, rest));
        return 0;
      case 'check':
        await cmdCheck(parsedFor(command, rest));
        return 0;
      case 'claim':
        await cmdClaim(parsedFor(command, rest));
        return 0;
      case 'update':
        await cmdUpdate(parsedFor(command, rest));
        return 0;
      case 'drift':
        await cmdDrift(parsedFor(command, rest));
        return 0;
      case 'finish':
        await cmdFinish(parsedFor(command, rest));
        return 0;
      case 'heartbeat':
        await cmdHeartbeat(parsedFor(command, rest));
        return 0;
      case 'reap':
        await cmdReap(parsedFor(command, rest));
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
      error instanceof ScopeNarrowingRefusedError ||
      error instanceof LockNotStaleError ||
      error instanceof ScopeAmendmentError ||
      error instanceof EmptyScopeError ||
      error instanceof EmptyUpdateError ||
      error instanceof IncompleteTaskUpdateError
    ) {
      printError(error.message);
      return 1;
    }
    printError(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}
