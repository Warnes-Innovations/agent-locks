import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Pin fixture commit dates to the distant past. Drift counts files touched
    // by commits made AT OR AFTER the lock's `created` second, and lock
    // timestamps are second-granular — so a setup commit made in the same
    // second as the claim legitimately counts as "committed since the claim".
    // Dating the fixture's history explicitly is what keeps each test about the
    // thing it is testing; a sleep would only make the flake rarer.
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
  return stdout.trim();
}

/** Commits with a REAL (now) timestamp — for tests that need "committed since the claim". */
async function gitCommitNow(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

let sandbox: string;
let repo: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-cli-test-'));
  repo = path.join(sandbox, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main', '.']);
  await git(repo, ['config', 'user.email', 'test@test.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Runs runCli with process.cwd() pointed at `repo` for the duration of the call, restoring it after. */
async function runCliIn(repoDir: string, argv: string[]): Promise<number> {
  const originalCwd = process.cwd();
  const originalStale = process.env.AGENT_LOCKS_STALE_MINUTES;
  process.chdir(repoDir);
  // See e2e.test.ts: --stale-minutes may only LENGTHEN, so these tests lower the
  // configured default instead of shortening per call.
  process.env.AGENT_LOCKS_STALE_MINUTES = '0.03';
  try {
    return await runCli(argv);
  } finally {
    if (originalStale === undefined) delete process.env.AGENT_LOCKS_STALE_MINUTES;
    else process.env.AGENT_LOCKS_STALE_MINUTES = originalStale;
    process.chdir(originalCwd);
  }
}

const CLAIMED_LINE_RE = /^Claimed .* as lock (\S+)$/;

/**
 * Pulls the lock id out of `agent-locks claim` output by finding its
 * confirmation line, not by position.
 *
 * These tests used to read logs[logs.length - 1], which broke the moment
 * `claim` gained a trailing scope-check line — six tests at once, all with
 * misleading failures ("No lock found with id 'conflict.'") pointing at the
 * lock store rather than at the scraping. Match the line you actually want.
 * Takes the LAST match, because some tests claim twice without clearing logs.
 */
function lockIdFrom(logs: string[]): string {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const match = CLAIMED_LINE_RE.exec(logs[i]);
    if (match) return match[1];
  }
  throw new Error(`No "Claimed ... as lock <id>" line in CLI output:\n${logs.join('\n')}`);
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { logs, errors };
}

describe('runCli', () => {
  it('prints usage and exits 0 for --help and for no command', async () => {
    const { logs } = captureConsole();
    expect(await runCliIn(repo, ['--help'])).toBe(0);
    expect(await runCliIn(repo, [])).toBe(0);
    expect(logs.every((line) => line.includes('agent-locks'))).toBe(true);
  });

  it('reports a version that matches package.json, so a build in the field can be identified', async () => {
    const { logs } = captureConsole();
    expect(await runCliIn(repo, ['--version'])).toBe(0);
    const pkg = JSON.parse(
      await fs.readFile(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    // Two hand-maintained copies drift, and a version that disagrees with
    // itself is worse than none: "which build wrote this lock file?" is the
    // first question any field diagnosis asks.
    expect(logs[0]).toBe(pkg.version);
  });

  it('exits 1 with a clear message for an unknown command', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['bogus']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('unknown command "bogus"');
  });

  it('claim creates a lock and status/list/check see it', async () => {
    const { logs } = captureConsole();

    const claimCode = await runCliIn(repo, [
      'claim',
      '--title', 'Refactor auth',
      '--scope', 'src/auth/**',
      '--task', 'Write tests',
      '--task', 'Update docs',
      '--agent', 'claude-code',
    ]);
    expect(claimCode).toBe(0);
    expect(logs.some((line) => /^Claimed "Refactor auth" as lock \S+$/.test(line))).toBe(true);
    const lockId = lockIdFrom(logs);

    logs.length = 0;
    expect(await runCliIn(repo, ['status'])).toBe(0);
    expect(logs.join('\n')).toContain('1 active lock');
    expect(logs.join('\n')).toContain('Refactor auth');

    logs.length = 0;
    expect(await runCliIn(repo, ['list', '--json'])).toBe(0);
    const listed = JSON.parse(logs[0]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: lockId, title: 'Refactor auth', percentComplete: 0, agent_id: 'claude-code' });

    logs.length = 0;
    expect(await runCliIn(repo, ['check', 'src/auth/login.ts'])).toBe(0);
    expect(logs.join('\n')).toContain('1 active lock(s) overlap');

    logs.length = 0;
    expect(await runCliIn(repo, ['check', 'src/unrelated/**'])).toBe(0);
    expect(logs.join('\n')).toContain('No active locks overlap');

    logs.length = 0;
    expect(await runCliIn(repo, ['update', lockId, '--task', 'Write tests', '--done'])).toBe(0);
    expect(logs[0]).toContain('"Write tests" marked done');
    expect(logs[0]).toContain('50% complete');

    logs.length = 0;
    expect(await runCliIn(repo, ['finish', lockId, '--summary', 'Shipped in #42'])).toBe(0);
    expect(logs[0]).toBe(`Lock ${lockId} finished and archived.`);

    logs.length = 0;
    expect(await runCliIn(repo, ['status'])).toBe(0);
    expect(logs.join('\n')).toContain('0 active lock');
  });

  it('claim requires --title and --scope, with a clear exit-1 error rather than a stack trace', async () => {
    const { errors } = captureConsole();

    expect(await runCliIn(repo, ['claim', '--scope', 'src/**'])).toBe(1);
    expect(errors[0]).toContain('requires --title');

    errors.length = 0;
    expect(await runCliIn(repo, ['claim', '--title', 'x'])).toBe(1);
    expect(errors[0]).toContain('requires at least one --scope');
  });

  it('update on a non-existent lock id exits 1 with the store\'s own error message, not a stack trace', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['update', 'nonexistent-lock', '--task', 'x']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('No lock found with id "nonexistent-lock"');
  });

  it('update with a task_text that does not match exactly exits 1 listing the real available tasks', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'Do the thing']);
    const lockId = lockIdFrom(logs);

    const code = await runCliIn(repo, ['update', lockId, '--task', 'wrong text']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('Do the thing');
  });

  it('rejects passing both --done and --undone to update', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    const code = await runCliIn(repo, ['update', lockId, '--task', 'y', '--done', '--undone']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('at most one of --done / --undone');
  });

  it('a flag requiring a value with none provided is a usage error, not a crash', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['claim', '--title']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('--title requires a value');
  });

  it('list --status rejects an invalid value rather than silently ignoring it', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['list', '--status', 'bogus']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('--status must be one of active, done, all');
  });

  it('claim and update print the claimed scope with the check prompt, so it is never written once and never seen again', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'auth/**', '--task', 'y']);
    expect(logs.join('\n')).toContain('Scope claimed: `auth/**`');
    // The CLI dialect must name CLI commands: telling a human at a terminal
    // to "call lock_update" is wrong advice.
    expect(logs.join('\n')).toContain('--add-scope');
    expect(logs.join('\n')).not.toContain('lock_update');
    const lockId = lockIdFrom(logs);

    logs.length = 0;
    expect(await runCliIn(repo, ['update', lockId, '--task', 'y', '--done'])).toBe(0);
    expect(logs.join('\n')).toContain('"y" marked done');
    expect(logs.join('\n')).toContain('Scope claimed: `auth/**`');
  });

  it('update --add-scope widens the claim and shows the before/after', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'auth/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    logs.length = 0;
    expect(await runCliIn(repo, ['update', lockId, '--add-scope', 'mcp_ctl.py'])).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('scope amended');
    expect(output).toContain('was: auth/**');
    expect(output).toContain('now: auth/**, mcp_ctl.py');

    // And the widened claim is what a conflict check now matches against.
    logs.length = 0;
    expect(await runCliIn(repo, ['check', 'mcp_ctl.py'])).toBe(0);
    expect(logs.join('\n')).toContain('1 active lock(s) overlap');
  });

  it('update --set-scope narrows a lock that over-claimed', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'src/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    expect(await runCliIn(repo, ['update', lockId, '--set-scope', 'src/auth/**'])).toBe(0);

    logs.length = 0;
    expect(await runCliIn(repo, ['check', 'src/billing/invoice.ts'])).toBe(0);
    expect(logs.join('\n')).toContain('No active locks overlap');
  });

  it('rejects --add-scope together with --set-scope, and an update with nothing to do', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    expect(await runCliIn(repo, ['update', lockId, '--add-scope', 'b/**', '--set-scope', 'c/**'])).toBe(1);
    expect(errors[errors.length - 1]).toContain('at most one of --add-scope');

    expect(await runCliIn(repo, ['update', lockId])).toBe(1);
    expect(errors[errors.length - 1]).toContain('needs something to do');
  });

  it('rejects --done without --task, rather than letting a typo become a silent no-op', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    expect(await runCliIn(repo, ['update', lockId, '--done'])).toBe(1);
    expect(errors[errors.length - 1]).toContain('require --task');
  });

  it('narrowing another session\'s claim is refused FROM THE CLI, and --force gets past it', async () => {
    // Wiring test, not a mechanism test: the store-level gate is covered
    // elsewhere: what this proves is that --agent and --force actually reach it
    // and that the refusal is an exit-1 message rather than a stack trace.
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'held', '--scope', 'src/**', '--scope', 'docs/**', '--agent', 'Blue [aa1111]']);
    const lockId = lockIdFrom(logs);

    expect(await runCliIn(repo, ['update', lockId, '--set-scope', 'src/**', '--agent', 'Red [bb2222]'])).toBe(1);
    expect(errors[errors.length - 1]).toMatch(/held by Blue \[aa1111\]|Refusing/i);

    // Widening by the same foreign caller is NOT gated.
    expect(await runCliIn(repo, ['update', lockId, '--add-scope', 'extra/**', '--agent', 'Red [bb2222]'])).toBe(0);

    logs.length = 0;
    expect(await runCliIn(repo, ['update', lockId, '--set-scope', 'src/**', '--agent', 'Red [bb2222]', '--force'])).toBe(0);
    expect(logs.join('\n')).toContain('NO LONGER CLAIMED');
  });

  it('drift lists the changed files a lock does not cover, and clears once amended', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'auth/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    await fs.mkdir(path.join(repo, 'auth'), { recursive: true });
    await fs.writeFile(path.join(repo, 'auth', 'login.ts'), 'a\n');
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'b\n');

    logs.length = 0;
    expect(await runCliIn(repo, ['drift', lockId])).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('files changed outside that scope (1)');
    expect(output).toContain('mcp_ctl.py');
    expect(output).not.toContain('auth/login.ts');

    expect(await runCliIn(repo, ['update', lockId, '--add-scope', 'mcp_ctl.py'])).toBe(0);
    logs.length = 0;
    expect(await runCliIn(repo, ['drift', lockId])).toBe(0);
    expect(logs.join('\n')).toContain('No drift');
  });

  it('drift prints warnings ABOVE the verdict, so a pipe cannot strip the qualifier', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'auth/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);
    await gitCommitNow(repo, ['worktree', 'add', '-q', '-b', 'side', path.join(sandbox, 'side')]);

    logs.length = 0;
    expect(await runCliIn(repo, ['drift', lockId])).toBe(0);
    const warningAt = logs.findIndex((l) => l.startsWith('warning:'));
    const verdictAt = logs.findIndex((l) => l.startsWith('outcome:') || l.includes('No drift') || l.includes('outside that scope'));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    // `| head -n` is routine; a reason the result may be meaningless must not
    // be the part that the pipe drops.
    expect(warningAt).toBeLessThan(verdictAt);
  });

  it('rejects an unknown flag rather than accepting and ignoring it', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);

    // An older build accepted --add-scope, printed success, and did nothing —
    // turning a version skew into a silent no-op. Unknown flags must be loud.
    expect(await runCliIn(repo, ['update', lockId, '--task', 'y', '--done', '--not-a-flag', 'v'])).toBe(1);
    expect(errors[errors.length - 1]).toContain('unknown flag --not-a-flag');
    expect(await runCliIn(repo, ['claim', '--title', 'z', '--scope', 'a/**', '--add-scope', 'b/**'])).toBe(1);
    expect(errors[errors.length - 1]).toContain('unknown flag --add-scope');
  });

  it('drift --json exits 0 and reports structurally, and errors clearly with no lock id', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'auth/**', '--task', 'y']);
    const lockId = lockIdFrom(logs);
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'b\n');

    logs.length = 0;
    expect(await runCliIn(repo, ['drift', lockId, '--json'])).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({ lock_id: lockId, drifted: true, outOfScope: ['mcp_ctl.py'] });
    expect(JSON.parse(logs[0]).outcome).toBe('DRIFTED');

    expect(await runCliIn(repo, ['drift'])).toBe(1);
    expect(errors[errors.length - 1]).toContain('requires a lock id');
  });

  it('status run outside a git repository exits 1 with NotAGitRepoError\'s message, not a stack trace', async () => {
    const { errors } = captureConsole();
    const notARepo = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });
    const code = await runCliIn(notARepo, ['status']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('does not appear to be inside a git repository');
  });

  it('status honours --base-dir instead of silently reporting the current repo', async () => {
    // Regression: cmdStatus was the one subcommand that never called
    // resolveBaseDir, so `status --base-dir <other repo>` accepted the flag,
    // ignored it, and printed the CURRENT repo's locks — the exact
    // silent-fallback failure the base_dir feature exists to prevent, and the
    // worst shape for it, because the output looks like a real answer.
    const otherRepo = path.join(sandbox, 'other-repo');
    await fs.mkdir(otherRepo, { recursive: true });
    await git(otherRepo, ['init', '-q', '-b', 'main', '.']);
    await git(otherRepo, ['config', 'user.email', 'test@test.com']);
    await git(otherRepo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(otherRepo, 'a.txt'), 'hi\n');
    await git(otherRepo, ['add', 'a.txt']);
    await git(otherRepo, ['commit', '-q', '-m', 'init']);

    // A lock in `repo`, and nothing at all in `otherRepo`.
    const claim = captureConsole();
    expect(await runCliIn(repo, ['claim', '--title', 'local work', '--scope', 'src/**'])).toBe(0);
    expect(claim.logs.join('\n')).toContain('local work');

    // Asking about otherRepo from inside repo must report otherRepo's state.
    const { logs } = captureConsole();
    const code = await runCliIn(repo, ['status', '--base-dir', otherRepo]);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('0 active lock(s)');
    expect(output).not.toContain('local work');
    // It also names the store it actually read, which must be otherRepo's.
    expect(output).toContain(path.join('other-repo', '.git', 'agents-locks'));
  });

  it('prefixes an error with the tool name exactly once, whether or not the message already names it', async () => {
    // NotAGitRepoError self-identifies, because its message is also surfaced
    // verbatim over the MCP error path where nothing else names the tool.
    // The CLI used to add its own prefix unconditionally, yielding
    // "agent-locks: agent-locks: ...".
    const selfIdentifying = captureConsole();
    const notARepo = path.join(sandbox, 'prefix-not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });
    expect(await runCliIn(notARepo, ['status'])).toBe(1);
    expect(selfIdentifying.errors[0]).not.toContain('agent-locks: agent-locks:');
    expect(selfIdentifying.errors[0].match(/agent-locks: /g)).toHaveLength(1);
    expect(selfIdentifying.errors[0].startsWith('agent-locks: ')).toBe(true);

    // ...and a message that does NOT name the tool still gets the prefix, so
    // the fix suppressed a duplicate rather than the prefix itself.
    const plain = captureConsole();
    expect(await runCliIn(repo, ['claim', '--scope', 'x/**'])).toBe(1); // missing --title
    expect(plain.errors[0].startsWith('agent-locks: ')).toBe(true);
    expect(plain.errors[0].match(/agent-locks: /g)).toHaveLength(1);
  });

  it('status rejects a --base-dir outside any git repository rather than falling back', async () => {
    const notARepo = path.join(sandbox, 'status-not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['status', '--base-dir', notARepo]);
    expect(code).toBe(1);
    expect(errors[0]).toContain('does not appear to be inside a git repository');
  });
});

// Lock timestamps have whole-second precision (see timestamp.ts), so a check
// made mere milliseconds after an operation can show up to ~1000ms of
// apparent staleness from truncation alone, with zero real inactivity.
// SLEEP_MS is comfortably over the threshold below; SHORT_STALE_MINUTES is
// well below that real wait but well above both the ~1000ms truncation
// noise floor AND realistic scheduling overhead under a fully parallel test
// run (see staleness.test.ts for the full reasoning — this file has the
// same "fresh lock created right after a stale one" pattern that needs the
// wider margin, not just the truncation-floor margin). NOT_STALE_MINUTES is
// used for immediate (no-sleep) "not stale" checks. Kept local here since
// this file doesn't otherwise depend on staleness.test.ts.
const SLEEP_MS = 2500;
const SHORT_STALE_MINUTES = '0.03'; // 1800ms, passed as a CLI flag value (string)
const NOT_STALE_MINUTES = '0.1'; // 6000ms
const sleepPastStaleThreshold = () => new Promise((resolve) => setTimeout(resolve, SLEEP_MS));

describe('runCli heartbeat/reap', () => {
  it('heartbeat resets an active lock to not-stale', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'Long task', '--scope', 'a/**']);
    const lockId = lockIdFrom(logs);

    await sleepPastStaleThreshold();
    logs.length = 0;
    await runCliIn(repo, ['list', '--json', '--stale-minutes', SHORT_STALE_MINUTES]);
    expect(JSON.parse(logs[0])[0].stale).toBe(true);

    const heartbeatCode = await runCliIn(repo, ['heartbeat', lockId]);
    expect(heartbeatCode).toBe(0);

    logs.length = 0;
    await runCliIn(repo, ['list', '--json', '--stale-minutes', NOT_STALE_MINUTES]);
    expect(JSON.parse(logs[0])[0].stale).toBe(false);
  });

  it('heartbeat on a nonexistent lock id is a clear exit-1 error, not a stack trace', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['heartbeat', 'nonexistent']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('No lock found with id "nonexistent"');
  });

  it('heartbeat requires a lock id', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['heartbeat']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('requires a lock id');
  });

  it('reap with no lock_id reaps every stale active lock and reports them', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'Stale one', '--scope', 'a/**']);
    const staleId = lockIdFrom(logs);

    await sleepPastStaleThreshold();
    await runCliIn(repo, ['claim', '--title', 'Fresh one', '--scope', 'b/**']);
    const freshId = lockIdFrom(logs);

    logs.length = 0;
    const code = await runCliIn(repo, ['reap', '--stale-minutes', SHORT_STALE_MINUTES]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Reaped 1 lock(s)');
    expect(logs.join('\n')).toContain(staleId);
    expect(logs.join('\n')).not.toContain(freshId);

    logs.length = 0;
    await runCliIn(repo, ['list', '--json', '--status', 'active']);
    const stillActive = JSON.parse(logs[0]) as Array<{ id: string }>;
    expect(stillActive.map((l) => l.id)).toEqual([freshId]);
  });

  it('reap --dry-run reports without mutating anything', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**']);
    const lockId = lockIdFrom(logs);

    await sleepPastStaleThreshold();
    logs.length = 0;
    await runCliIn(repo, ['reap', '--stale-minutes', SHORT_STALE_MINUTES, '--dry-run']);
    expect(logs.join('\n')).toContain('Would reap 1 lock(s)');

    logs.length = 0;
    await runCliIn(repo, ['list', '--json']);
    expect(JSON.parse(logs[0]).map((l: { id: string }) => l.id)).toEqual([lockId]);
  });

  it('reap refuses to reap a named lock_id that is not actually stale', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**']);
    const lockId = lockIdFrom(logs);

    const code = await runCliIn(repo, ['reap', lockId, '--stale-minutes', '1000']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('is not stale');
  });

  it('reap with no stale locks reports none, not an error', async () => {
    const { logs } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'fresh', '--scope', 'a/**']);
    logs.length = 0;
    const code = await runCliIn(repo, ['reap', '--stale-minutes', '1000']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('No stale locks to reap');
  });

  it('reap rejects a non-positive --stale-minutes value', async () => {
    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['reap', '--stale-minutes', '0']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('--stale-minutes must be a positive number');
  });
});

describe('CLI dispatch via the actual compiled binary', () => {
  it('running dist/index.js with a CLI subcommand exits with the CLI\'s code, not the MCP server', async () => {
    // Complements e2e.test.ts, which already proves argv.length === 0 starts
    // the MCP server. This proves the OTHER branch of the same dispatch: a
    // real subprocess spawn of the compiled artifact with a subcommand runs
    // the CLI and exits, rather than hanging waiting for stdio JSON-RPC.
    const distPath = path.resolve(import.meta.dirname, '../../dist/index.js');
    const { stdout } = await execFileAsync('node', [distPath, 'status'], { cwd: repo });
    expect(stdout).toContain('0 active lock');
  });
});

describe('a corrupt lock is surfaced on EVERY read surface (Y2 regression)', () => {
  /**
   * These tests assert the POINTER, not the mechanism.
   *
   * The round-4 fix recorded unreadable locks in `lastUnreadableLocks` and wired a
   * warning into the human table renderer. Five tests were added and all five asserted
   * the STORE-LEVEL recording, which already worked — so deleting every call site and
   * the whole MCP payload left the suite fully green. The wiring, which was the actual
   * fix, was untested. That is the failure this project keeps repeating: a control
   * built and nothing pointing at it, including nothing in the tests.
   *
   * Each test below fails if its call site is removed.
   */
  async function corruptTheOnlyLock(): Promise<void> {
    const locksDir = path.join(repo, '.git', 'agents-locks');
    for (const name of await fs.readdir(locksDir)) {
      if (name.endsWith('.md')) await fs.writeFile(path.join(locksDir, name), '', 'utf8');
    }
  }

  it('warns on `list --json` — the form a hook or script uses', async () => {
    await runCliIn(repo, ['claim', '--title', 'real work', '--scope', 'src/**']);
    await corruptTheOnlyLock();
    const { logs, errors } = captureConsole();

    await runCliIn(repo, ['list', '--json', '--status', 'active']);

    expect(errors.join('\n')).toMatch(/could not be read/i);
    // And the payload itself is still the empty array, which is exactly why the
    // warning has to exist: the data cannot express "I could not tell you".
    expect(logs.join('\n')).toContain('[]');
  });

  it('warns on `check` — the call made before writing, where silence is worst', async () => {
    await runCliIn(repo, ['claim', '--title', 'real work', '--scope', 'src/**']);
    await corruptTheOnlyLock();
    const { errors } = captureConsole();

    await runCliIn(repo, ['check', 'src/main.ts']);

    expect(errors.join('\n')).toMatch(/could not be read/i);
  });

  it('warns on `status`', async () => {
    await runCliIn(repo, ['claim', '--title', 'real work', '--scope', 'src/**']);
    await corruptTheOnlyLock();
    const { errors } = captureConsole();

    await runCliIn(repo, ['status']);

    expect(errors.join('\n')).toMatch(/could not be read/i);
  });

  it('warns on `reap`', async () => {
    await runCliIn(repo, ['claim', '--title', 'real work', '--scope', 'src/**']);
    await corruptTheOnlyLock();
    const { errors } = captureConsole();

    await runCliIn(repo, ['reap', '--dry-run']);

    expect(errors.join('\n')).toMatch(/could not be read/i);
  });
});

describe('finish enforces ownership FROM THE CLI, not just in the store (pointer test)', () => {
  /**
   * The store-level refusal was implemented and passing its own tests while the CLI
   * still archived another session's lock, exit 0 — because cmdFinish never passed
   * `--agent` through. That is the same last-hop failure as Y2: the mechanism worked,
   * nothing called it, and only store-level tests existed. These assert the SURFACE.
   */
  it('refuses to finish another session\'s lock', async () => {
    await runCliIn(repo, ['claim', '--title', 'held by Blue', '--scope', 'a/**', '--agent', 'Blue [aa1111]']);
    const { logs } = captureConsole();
    await runCliIn(repo, ['list', '--json']);
    const id = (JSON.parse(logs.join('\n')) as Array<{ id: string }>)[0]!.id;

    const { errors } = captureConsole();
    const code = await runCliIn(repo, ['finish', id, '--agent', 'Red [bd9522]']);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toMatch(/held by Blue \[aa1111\]|not by Red/i);
  });

  it('allows it with --force, and records the fact', async () => {
    await runCliIn(repo, ['claim', '--title', 'held by Blue', '--scope', 'a/**', '--agent', 'Blue [aa1111]']);
    const { logs } = captureConsole();
    await runCliIn(repo, ['list', '--json']);
    const id = (JSON.parse(logs.join('\n')) as Array<{ id: string }>)[0]!.id;

    captureConsole();
    const code = await runCliIn(repo, ['finish', id, '--agent', 'Red [bd9522]', '--force']);
    expect(code).toBe(0);

    const doneDir = path.join(repo, '.git', 'agents-locks', 'done');
    const files = await fs.readdir(doneDir);
    const text = await fs.readFile(path.join(doneDir, files[0]!), 'utf8');
    expect(text).toContain('is NOT the holder');
  });

  it('still finishes an unowned lock without --agent, as before', async () => {
    await runCliIn(repo, ['claim', '--title', 'legacy', '--scope', 'a/**']);
    const { logs } = captureConsole();
    await runCliIn(repo, ['list', '--json']);
    const id = (JSON.parse(logs.join('\n')) as Array<{ id: string }>)[0]!.id;

    captureConsole();
    expect(await runCliIn(repo, ['finish', id])).toBe(0);
  });
});
