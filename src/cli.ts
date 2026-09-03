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
  LockNotStaleError,
} from './lock/store.js';
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
  agent-locks finish <lock-id> [--summary <text>]  Mark a lock done and archive it.
  agent-locks heartbeat <lock-id>        Bump a lock's updated timestamp with no other change. See "Staleness detection" in the README.
  agent-locks reap [lock-id] [options]  Finish stale lock(s). See "agent-locks reap --help".
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

Options:
  --task <text>          Required. Must match an existing task's text exactly.
  --done                 Mark the task done (default if neither --done nor --undone given).
  --undone               Mark the task not done.
  --note <text>           Append a free-text note to the lock.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;

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

const BOOLEAN_FLAGS = new Set(['--json', '--done', '--undone', '--help', '--dry-run']);

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
  if (!taskText) throw new CliUsageError('agent-locks update requires --task. See "agent-locks update --help".');
  if (flags.boolFlags.has('--done') && flags.boolFlags.has('--undone')) {
    throw new CliUsageError('Pass at most one of --done / --undone.');
  }
  const done = !flags.boolFlags.has('--undone');
  const note = oneOf(flags.flags, '--note');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await updateLock(locksRoot, { lock_id: lockId, task_text: taskText, done, note });

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id}: "${taskText}" marked ${done ? 'done' : 'not done'} (${result.percentComplete}% complete overall).`);
  }
}

async function cmdFinish(flags: ParsedFlags): Promise<void> {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks finish requires a lock id as its first argument.');
  const summary = oneOf(flags.flags, '--summary');

  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await finishLock(locksRoot, { lock_id: lockId, summary });

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

  if (flags.boolFlags.has('--json')) {
    console.log(JSON.stringify(reaped, null, 2));
    return;
  }
  if (reaped.length === 0) {
    console.log('No stale locks to reap.');
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
      error instanceof LockNotStaleError
    ) {
      printError(error.message);
      return 1;
    }
    printError(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}
