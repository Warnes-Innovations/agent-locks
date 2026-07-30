/**
 * Real end-to-end test: spawns the actual compiled dist/index.js as a
 * subprocess (not a mocked transport, not a direct function call) and
 * drives real JSON-RPC round trips against it via the MCP SDK's own client,
 * the same way Claude Code itself would talk to this server.
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

let repo: string;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  await fs.access(DIST_ENTRY).catch(() => {
    throw new Error(`${DIST_ENTRY} does not exist. Run "pnpm run build" before running tests.`);
  });

  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-e2e-'));
  await git(repo, ['init', '-q', '-b', 'main', '.']);
  await git(repo, ['config', 'user.email', 'test@test.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  // cwd is the temp git repo (this is what a real MCP client spawning this
  // server from within that repo's worktree would do); command/args are
  // absolute so module resolution doesn't depend on cwd.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd: repo,
    stderr: 'pipe',
  });
  client = new Client({ name: 'agent-locks-e2e-test-client', version: '0.0.0' });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(repo, { recursive: true, force: true });
});

function toolResultJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  expect(first?.type).toBe('text');
  return JSON.parse(first.text as string);
}

describe('agent-locks MCP server (real subprocess, real JSON-RPC)', () => {
  it('completes the initialize handshake and reports non-empty, honest instructions', async () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('cannot detect your agent id');
  });

  it('lists exactly the 7 documented tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['lock_check_conflict', 'lock_create', 'lock_finish', 'lock_heartbeat', 'lock_query', 'lock_reap', 'lock_update'].sort(),
    );
  });

  it('drives a real create -> query -> update -> finish round trip against the filesystem', async () => {
    const createResult = await client.callTool({
      name: 'lock_create',
      arguments: {
        title: 'E2E smoke test lock',
        scope: ['some/scope/**'],
        tasks: ['do the thing'],
      },
    });
    const created = toolResultJson(createResult) as { id: string; filePath: string };
    expect(created.id).toContain('e2e-smoke-test-lock');

    // Confirm the file really landed under the repo's shared .git dir, not
    // just that the tool claimed success.
    const onDisk = await fs.readFile(created.filePath, 'utf8');
    expect(onDisk).toContain('status: active');
    expect(created.filePath).toContain(path.join('.git', 'agents-locks'));

    const queryResult = await client.callTool({ name: 'lock_query', arguments: {} });
    const queried = toolResultJson(queryResult) as Array<{ id: string; percentComplete: number }>;
    expect(queried.find((l) => l.id === created.id)?.percentComplete).toBe(0);

    const updateResult = await client.callTool({
      name: 'lock_update',
      arguments: { lock_id: created.id, task_text: 'do the thing', done: true },
    });
    const updated = toolResultJson(updateResult) as { percentComplete: number };
    expect(updated.percentComplete).toBe(100);

    await client.callTool({ name: 'lock_finish', arguments: { lock_id: created.id, summary: 'done via e2e test' } });

    const defaultQueryResult = await client.callTool({ name: 'lock_query', arguments: {} });
    const defaultQueried = toolResultJson(defaultQueryResult) as Array<{ id: string }>;
    expect(defaultQueried.find((l) => l.id === created.id)).toBeUndefined();

    const doneQueryResult = await client.callTool({ name: 'lock_query', arguments: { status: 'done' } });
    const doneQueried = toolResultJson(doneQueryResult) as Array<{ id: string; status: string }>;
    expect(doneQueried.find((l) => l.id === created.id)?.status).toBe('done');
  });

  it('drives a real heartbeat -> stale detection -> reap round trip against the filesystem', async () => {
    // Lock timestamps have whole-SECOND precision (see timestamp.ts), so a
    // check made mere milliseconds after creation can show up to ~1000ms of
    // apparent staleness from truncation alone, with zero real inactivity.
    // SLEEP_MS is comfortably over one real second; SHORT_STALE_MINUTES is
    // well below that real wait but well above the truncation noise floor;
    // NOT_STALE_MINUTES is used for immediate (no-sleep) "not stale" checks,
    // comfortably above the noise floor on its own. See staleness.test.ts,
    // which documents and unit-tests this same reasoning directly.
    // Widened from an earlier 1100ms/600ms/3000ms to stay robust under a
    // fully parallel test run (see staleness.test.ts for why: realistic
    // scheduling overhead between an operation and its check can exceed a
    // too-tight margin under real CPU contention from other test files).
    const SLEEP_MS = 2500;
    const SHORT_STALE_MINUTES = 0.03; // 1800ms
    const NOT_STALE_MINUTES = 0.1; // 6000ms
    const sleepPastStaleThreshold = () => new Promise((resolve) => setTimeout(resolve, SLEEP_MS));

    const createResult = await client.callTool({
      name: 'lock_create',
      arguments: { title: 'Staleness e2e lock', scope: ['stale/**'], tasks: [] },
    });
    const created = toolResultJson(createResult) as { id: string };

    await sleepPastStaleThreshold();
    const staleQuery = await client.callTool({
      name: 'lock_query',
      arguments: { stale_minutes: SHORT_STALE_MINUTES },
    });
    const staleResults = toolResultJson(staleQuery) as Array<{ id: string; stale: boolean; staleForSeconds: number }>;
    const found = staleResults.find((l) => l.id === created.id);
    expect(found?.stale).toBe(true);
    expect(found?.staleForSeconds).toBeGreaterThan(0);

    // A real MCP tool error, not a JS throw, for a heartbeat on the wrong lock id.
    const badHeartbeat = await client.callTool({ name: 'lock_heartbeat', arguments: { lock_id: 'nonexistent' } });
    expect(badHeartbeat.isError).toBe(true);

    // Heartbeating the real lock resets it to not-stale immediately.
    await client.callTool({ name: 'lock_heartbeat', arguments: { lock_id: created.id } });
    const afterHeartbeat = await client.callTool({ name: 'lock_query', arguments: { stale_minutes: NOT_STALE_MINUTES } });
    const afterHeartbeatResults = toolResultJson(afterHeartbeat) as Array<{ id: string; stale: boolean }>;
    expect(afterHeartbeatResults.find((l) => l.id === created.id)?.stale).toBe(false);

    // Reaping a lock that is NOT stale is a real MCP tool error, not a silent finish.
    const reapNotStale = await client.callTool({
      name: 'lock_reap',
      arguments: { lock_id: created.id, stale_minutes: 1000 },
    });
    expect(reapNotStale.isError).toBe(true);
    const reapErrorText = (reapNotStale.content as Array<{ text?: string }>)[0].text;
    expect(reapErrorText).toContain('is not stale');

    // Let it go stale again, then dry_run must report it without mutating anything.
    await sleepPastStaleThreshold();
    const dryRunResult = await client.callTool({
      name: 'lock_reap',
      arguments: { lock_id: created.id, stale_minutes: SHORT_STALE_MINUTES, dry_run: true },
    });
    const dryRunReaped = toolResultJson(dryRunResult) as Array<{ id: string }>;
    expect(dryRunReaped.map((l) => l.id)).toContain(created.id);
    const stillActiveQuery = await client.callTool({ name: 'lock_query', arguments: {} });
    const stillActive = toolResultJson(stillActiveQuery) as Array<{ id: string; status: string }>;
    expect(stillActive.find((l) => l.id === created.id)?.status).toBe('active');

    // A real (non-dry-run) reap actually moves it to done, with an honest note.
    const reapResult = await client.callTool({
      name: 'lock_reap',
      arguments: { lock_id: created.id, stale_minutes: SHORT_STALE_MINUTES },
    });
    const reaped = toolResultJson(reapResult) as Array<{ id: string }>;
    expect(reaped.map((l) => l.id)).toContain(created.id);
    const doneQuery = await client.callTool({ name: 'lock_query', arguments: { status: 'done' } });
    const doneResults = toolResultJson(doneQuery) as Array<{ id: string; status: string }>;
    expect(doneResults.find((l) => l.id === created.id)?.status).toBe('done');
  });

  it('reports a real MCP tool error (isError: true) rather than throwing or silently no-op-ing on a bad task_text', async () => {
    const createResult = await client.callTool({
      name: 'lock_create',
      arguments: { title: 'error path lock', scope: ['x/**'], tasks: ['real task'] },
    });
    const created = toolResultJson(createResult) as { id: string };

    const result = await client.callTool({
      name: 'lock_update',
      arguments: { lock_id: created.id, task_text: 'not a real task', done: true },
    });
    expect(result.isError).toBe(true);
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(first.text).toContain('no task with the exact text');
  });
});
