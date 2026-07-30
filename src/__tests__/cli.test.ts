import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
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
  process.chdir(repoDir);
  try {
    return await runCli(argv);
  } finally {
    process.chdir(originalCwd);
  }
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
    expect(logs[logs.length - 1]).toMatch(/^Claimed "Refactor auth" as lock \S+$/);
    const lockId = logs[logs.length - 1].split(' ').pop() as string;

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
    const lockId = logs[logs.length - 1].split(' ').pop() as string;

    const code = await runCliIn(repo, ['update', lockId, '--task', 'wrong text']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('Do the thing');
  });

  it('rejects passing both --done and --undone to update', async () => {
    const { logs, errors } = captureConsole();
    await runCliIn(repo, ['claim', '--title', 'x', '--scope', 'a/**', '--task', 'y']);
    const lockId = logs[logs.length - 1].split(' ').pop() as string;

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

  it('status run outside a git repository exits 1 with NotAGitRepoError\'s message, not a stack trace', async () => {
    const { errors } = captureConsole();
    const notARepo = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });
    const code = await runCliIn(notARepo, ['status']);
    expect(code).toBe(1);
    expect(errors[0]).toContain('does not appear to be inside a git repository');
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
