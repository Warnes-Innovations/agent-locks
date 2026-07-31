/**
 * Cross-repo `base_dir` tests.
 *
 * git.test.ts already proves the *resolver* handles a foreign path correctly.
 * These tests prove something different and previously untested: that the
 * `base_dir` PARAMETER is actually plumbed from each MCP tool's input schema
 * through to that resolver. The distinction matters because a tool that
 * accepted `base_dir` and silently ignored it would pass every existing
 * resolver test while writing every lock into the wrong repository — and
 * would look like success from the caller's side.
 *
 * The scenario throughout: the server subprocess is rooted in repo X (its
 * cwd, exactly as a real MCP client launched from X would spawn it) and is
 * asked to operate on repo Y via `base_dir`. That is the case the whole
 * feature exists for — a lock the colliding agent cannot see is decorative.
 *
 * `pretest` (see package.json) runs `pnpm run build` before `vitest run`,
 * so dist/index.js is always fresh here.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main', '.']);
  await git(dir, ['config', 'user.email', 'test@test.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hi\n');
  await git(dir, ['add', 'a.txt']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

let sandbox: string;
let repoX: string;
let repoY: string;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  await fs.access(DIST_ENTRY).catch(() => {
    throw new Error(`${DIST_ENTRY} does not exist. Run "pnpm run build" before running tests.`);
  });

  // realpath the sandbox up front so every path built from it is already in
  // canonical form. resolveLocksRoot canonicalizes its own answer (see
  // src/git.ts), so without this the server's returned paths would not
  // string-compare against ours on platforms where the OS temp dir is
  // reached through a symlink — e.g. macOS's /var -> /private/var.
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-cross-repo-')));
  repoX = await initRepo(path.join(sandbox, 'repo-x'));
  repoY = await initRepo(path.join(sandbox, 'repo-y'));

  // The server's cwd is repo X for every test in this file. Any lock that
  // lands in Y therefore got there via base_dir and nothing else.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd: repoX,
    stderr: 'pipe',
  });
  client = new Client({ name: 'agent-locks-cross-repo-test-client', version: '0.0.0' });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(sandbox, { recursive: true, force: true });
});

function toolResultJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  expect(first?.type).toBe('text');
  return JSON.parse(first.text as string);
}

function errorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>)[0].text as string;
}

type Summary = { id: string; repository: string; status: string; percentComplete: number };

describe('cross-repo base_dir (server rooted in repo X, operating on repo Y)', () => {
  it('creates the lock in repo Y, where a query from Y sees it and a query from X does not', async () => {
    const createResult = await client.callTool({
      name: 'lock_create',
      arguments: {
        title: 'Cross-repo claim',
        scope: ['src/**'],
        tasks: ['do the cross-repo thing'],
        base_dir: repoY,
      },
    });
    const created = toolResultJson(createResult) as { id: string; filePath: string };

    // The file physically landed under Y's shared .git, not X's.
    expect(path.dirname(created.filePath)).toBe(path.join(repoY, '.git', 'agents-locks'));
    expect(created.filePath).not.toContain(repoX);
    await expect(fs.access(created.filePath)).resolves.toBeUndefined();

    // Visible to an agent asking about Y...
    const fromY = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: repoY } }),
    ) as Summary[];
    expect(fromY.find((l) => l.id === created.id)?.repository).toBe(repoY);

    // ...and invisible to one asking about X, both implicitly (no base_dir,
    // so the server falls back to its own cwd, which IS X) and explicitly.
    const fromXImplicit = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: {} }),
    ) as Summary[];
    expect(fromXImplicit.find((l) => l.id === created.id)).toBeUndefined();

    const fromXExplicit = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: repoX } }),
    ) as Summary[];
    expect(fromXExplicit.find((l) => l.id === created.id)).toBeUndefined();

    // X's lock store was never even created — nothing leaked sideways.
    await expect(fs.access(path.join(repoX, '.git', 'agents-locks'))).rejects.toThrow();
  });

  it('carries base_dir through the whole create -> conflict-check -> update -> finish lifecycle', async () => {
    // If any single tool in this chain dropped base_dir it would resolve
    // against X, fail to find the lock, and break the chain here.
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Lifecycle claim', scope: ['pkg/**'], tasks: ['step one'], base_dir: repoY },
      }),
    ) as { id: string };

    const conflicts = toolResultJson(
      await client.callTool({
        name: 'lock_check_conflict',
        arguments: { scope: ['pkg/thing.ts'], base_dir: repoY },
      }),
    ) as Summary[];
    expect(conflicts.map((l) => l.id)).toContain(created.id);

    // The same overlapping scope checked against X reports nothing, because
    // the lock simply is not there.
    const noConflictsInX = toolResultJson(
      await client.callTool({ name: 'lock_check_conflict', arguments: { scope: ['pkg/thing.ts'] } }),
    ) as Summary[];
    expect(noConflictsInX).toEqual([]);

    const updated = toolResultJson(
      await client.callTool({
        name: 'lock_update',
        arguments: { lock_id: created.id, task_text: 'step one', done: true, base_dir: repoY },
      }),
    ) as { percentComplete: number };
    expect(updated.percentComplete).toBe(100);

    await client.callTool({
      name: 'lock_finish',
      arguments: { lock_id: created.id, summary: 'done cross-repo', base_dir: repoY },
    });

    const done = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { status: 'done', base_dir: repoY } }),
    ) as Summary[];
    expect(done.find((l) => l.id === created.id)?.status).toBe('done');
  });

  it('cannot reach a repo-Y lock without base_dir — proving the parameter is load-bearing, not decorative', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Unreachable from X', scope: ['z/**'], tasks: ['t'], base_dir: repoY },
      }),
    ) as { id: string };

    // Same lock id, no base_dir: the server resolves against its own cwd (X)
    // and must report an honest "not found" rather than reaching into Y.
    const blindUpdate = await client.callTool({
      name: 'lock_update',
      arguments: { lock_id: created.id, task_text: 't', done: true },
    });
    expect(blindUpdate.isError).toBe(true);

    // ...and the real lock in Y is untouched by that failed attempt.
    const stillOpen = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: repoY } }),
    ) as Summary[];
    expect(stillOpen.find((l) => l.id === created.id)?.percentComplete).toBe(0);
  });

  it('rejects a base_dir outside any git repository instead of silently falling back to cwd', async () => {
    const plainDir = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(plainDir, { recursive: true });

    const result = await client.callTool({
      name: 'lock_create',
      arguments: { title: 'Should not exist', scope: ['**'], tasks: [], base_dir: plainDir },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('does not appear to be inside a git repository');

    // The failure mode this guards against is not the error — it is a silent
    // fallback that writes the lock into the server's own cwd and reports
    // success. Assert the lock exists in neither repo, nor in plainDir.
    const inX = toolResultJson(await client.callTool({ name: 'lock_query', arguments: {} })) as Summary[];
    expect(inX).toEqual([]);
    const inY = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: repoY } }),
    ) as Summary[];
    expect(inY).toEqual([]);
    await expect(fs.access(path.join(plainDir, '.git'))).rejects.toThrow();
  });

  it('resolves a linked worktree of Y and Y itself to the same lock store', async () => {
    // The server already promises locks are shared across every worktree of a
    // repository; base_dir must not open a hole in that promise by treating a
    // worktree path as a separate repo.
    const linkedWorktree = path.join(sandbox, 'repo-y-feature');
    await git(repoY, ['worktree', 'add', '-q', '-b', 'feature-x', linkedWorktree]);

    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Worktree claim', scope: ['w/**'], tasks: [], base_dir: repoY },
      }),
    ) as { id: string; filePath: string };

    const fromWorktree = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: linkedWorktree } }),
    ) as Summary[];
    expect(fromWorktree.map((l) => l.id)).toContain(created.id);

    // A lock created via the worktree path lands in that same shared store,
    // not in a per-worktree one.
    const fromWorktreeCreate = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Claim via worktree', scope: ['w2/**'], tasks: [], base_dir: linkedWorktree },
      }),
    ) as { id: string; filePath: string; repository?: string };

    // Anchor both to Y's shared .git ABSOLUTELY, not merely to each other:
    // if base_dir were ignored entirely, both locks would still agree with
    // one another (they would both land in the server's cwd) and a purely
    // relative assertion would pass while the feature was broken.
    const sharedStore = path.join(repoY, '.git', 'agents-locks');
    expect(path.dirname(created.filePath)).toBe(sharedStore);
    expect(path.dirname(fromWorktreeCreate.filePath)).toBe(sharedStore);
    // The linked worktree never gets a lock store of its own.
    await expect(fs.access(path.join(linkedWorktree, '.git', 'agents-locks'))).rejects.toThrow();

    // Both are visible from the main checkout, and neither is visible from X.
    const fromMain = toolResultJson(
      await client.callTool({ name: 'lock_query', arguments: { base_dir: repoY } }),
    ) as Summary[];
    expect(fromMain.map((l) => l.id).sort()).toEqual([created.id, fromWorktreeCreate.id].sort());
    const fromX = toolResultJson(await client.callTool({ name: 'lock_query', arguments: {} })) as Summary[];
    expect(fromX).toEqual([]);
  });
});
