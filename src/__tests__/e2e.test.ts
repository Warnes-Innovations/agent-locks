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
    // A per-call stale_minutes may only LENGTHEN the reaping window (see
    // reapStaleLocks). These tests deliberately reap sub-minute-old locks, so they
    // lower the CONFIGURED DEFAULT — an explicit operator-level choice — rather than
    // relying on a per-call flag to shorten it, which is the hole that was closed.
    env: { ...process.env, AGENT_LOCKS_STALE_MINUTES: '0.03' },
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
  const parsed = JSON.parse(first.text as string);
  // lock_query / lock_check_conflict / lock_reap return a STABLE envelope carrying the
  // payload plus out-of-band condition reporting (unreadable locks, the reap floor).
  // The envelope is asserted explicitly in its own test; unwrapping here keeps every
  // other assertion about the thing under test rather than about the wrapper.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['locks', 'conflicts', 'reaped']) {
      if (Array.isArray((parsed as Record<string, unknown>)[key])) {
        return (parsed as Record<string, unknown>)[key];
      }
    }
  }
  return parsed;
}

describe('agent-locks MCP server (real subprocess, real JSON-RPC)', () => {
  it('completes the initialize handshake and reports non-empty, honest instructions', async () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('cannot detect your agent id');
  });

  it('lists exactly the 8 documented tools — the roster cannot grow or shrink silently', async () => {
    // An exhaustive list, deliberately. Adding a tool must be a decision someone makes
    // in this file, not something that happens because a registerTool call was added
    // elsewhere: the MCP surface is what every agent on the machine can reach, and it
    // is the only real boundary around what this tool will do on request.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'lock_check_conflict',
        'lock_create',
        'lock_finish',
        'lock_heartbeat',
        'lock_query',
        'lock_reap',
        'lock_reopen',
        'lock_update',
      ].sort(),
    );
  });

  it('exposes no administrative operation over MCP', async () => {
    // Operations that reset history, rewrite a lock's stamped TTL, or prune the archive
    // do not belong on the surface every agent can call. The separate-binary split for
    // those is a speed bump and a signal, NOT a boundary — an agent with shell access
    // can run any binary — so THIS assertion is the boundary, and it has to be
    // mechanical rather than a documented intention. Stated as a prefix/word scan so a
    // future admin verb has to be renamed or exempted here on purpose.
    const { tools } = await client.listTools();
    const forbidden = /(^|_)(admin|reset|prune|purge|truncate|set_ttl|config)(_|$)/;
    const offenders = tools.map((t) => t.name).filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // MCP-SIDE POINTER TESTS.
  //
  // These exist because every control below was, at one point, enforced in the store
  // and NOT passed through by server.ts — and the suite stayed fully green through
  // three separate deletion proofs. A store-level guarantee whose surface never
  // supplies the argument is not a guarantee; it is a comment. The CLI got pointer
  // tests for exactly this reason and the MCP surface did not, which is how the same
  // last-hop failure recurred on the interface that agents actually use.
  //
  // Each test below fails if the corresponding argument stops being forwarded.
  // ---------------------------------------------------------------------------

  it('lock_update FORWARDS add_scope/remove_scope to the store', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Scope drift over MCP', scope: ['src/a/**'], tasks: ['t'] },
      }),
    ) as { id: string };

    const updated = toolResultJson(
      await client.callTool({
        name: 'lock_update',
        arguments: { lock_id: created.id, add_scope: ['src/b/**'] },
      }),
    ) as { scope: string[] };
    expect(updated.scope).toEqual(['src/a/**', 'src/b/**']);

    // ...and a consumer sees the extended claim, not just the return value.
    const conflicts = toolResultJson(
      await client.callTool({ name: 'lock_check_conflict', arguments: { scope: ['src/b/main.ts'] } }),
    ) as Array<{ id: string }>;
    expect(conflicts.map((c) => c.id)).toContain(created.id);
  });

  it('lock_update FORWARDS agent_id, so another session cannot silently shrink a claim', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Held by A', scope: ['src/a/**', 'src/b/**'], tasks: ['t'], agent_id: 'agent-A [aaa]' },
      }),
    ) as { id: string };

    const refused = await client.callTool({
      name: 'lock_update',
      arguments: { lock_id: created.id, remove_scope: ['src/a/**'], agent_id: 'agent-B [bbb]' },
    });
    expect(refused.isError).toBe(true);

    // The claim is intact: a refusal that still mutated would be worse than none.
    const conflicts = toolResultJson(
      await client.callTool({ name: 'lock_check_conflict', arguments: { scope: ['src/a/x.ts'] } }),
    ) as Array<{ id: string }>;
    expect(conflicts.map((c) => c.id)).toContain(created.id);
  });

  it('lock_finish FORWARDS agent_id and force', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Finish ownership', scope: ['src/f/**'], tasks: ['t'], agent_id: 'agent-A [aaa]' },
      }),
    ) as { id: string };

    const refused = await client.callTool({
      name: 'lock_finish',
      arguments: { lock_id: created.id, agent_id: 'agent-B [bbb]' },
    });
    expect(refused.isError).toBe(true);

    // force is the deliberate, recorded escape — and it must also be forwarded.
    const forced = await client.callTool({
      name: 'lock_finish',
      arguments: { lock_id: created.id, agent_id: 'agent-B [bbb]', force: true },
    });
    expect(forced.isError).toBeFalsy();
  });

  it('lock_reopen FORWARDS reason, and enforces it only where the design says to', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'Reopen gating', scope: ['src/r/**'], tasks: ['t'] },
      }),
    ) as { id: string };
    await client.callTool({ name: 'lock_finish', arguments: { lock_id: created.id } });

    // Deliberately finished => a reason is required. If `reason` stopped being
    // forwarded, this call would succeed and the test fails.
    const refused = await client.callTool({ name: 'lock_reopen', arguments: { lock_id: created.id } });
    expect(refused.isError).toBe(true);

    const allowed = await client.callTool({
      name: 'lock_reopen',
      arguments: { lock_id: created.id, reason: 'was not actually done' },
    });
    expect(allowed.isError).toBeFalsy();
    const reopened = toolResultJson(allowed) as { verdict: string; previously_finished_by: string };
    expect(reopened.verdict).toBe('not-a-reap');
    expect(reopened.previously_finished_by).toBe('holder');
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
    const queried = toolResultJson(queryResult) as Array<{ id: string; percentComplete: number; repository: string }>;
    const match = queried.find((l) => l.id === created.id);
    expect(match?.percentComplete).toBe(0);
    // The repository field records which repo the lock governs
    expect(match?.repository).toBeTruthy();
    expect(match?.repository).toContain('agent-locks-e2e-');

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

describe('the MCP response envelope is stable (Y3 regression)', () => {
  // An earlier version returned a bare array normally and an object ONLY when a lock
  // was unreadable. A consumer would test the happy path, ship, and break in exactly
  // the failure case the field exists to report. The shape must not depend on whether
  // anything is wrong — asserted here explicitly, because every other test unwraps it.
  it('lock_query returns locks + unreadable_locks even when nothing is wrong', async () => {
    await client.callTool({
      name: 'lock_create',
      arguments: { title: 'healthy', scope: ['a/**'], tasks: [] },
    });
    const raw = await client.callTool({ name: 'lock_query', arguments: {} });
    const parsed = JSON.parse(
      ((raw.content as Array<{ text?: string }>)[0].text as string),
    ) as Record<string, unknown>;

    expect(Array.isArray(parsed)).toBe(false);
    expect(Array.isArray(parsed.locks)).toBe(true);
    expect(parsed.unreadable_locks).toEqual([]);
    expect(parsed.warning).toBeUndefined();
  });

  it('lock_reap reports the floor that actually ran, on the agent-facing surface', async () => {
    await client.callTool({
      name: 'lock_create',
      arguments: { title: 'fresh', scope: ['b/**'], tasks: [] },
    });
    // Ask for a threshold below the configured default: it may only LENGTHEN.
    const raw = await client.callTool({
      name: 'lock_reap',
      arguments: { stale_minutes: 0.001, dry_run: true },
    });
    const parsed = JSON.parse(
      ((raw.content as Array<{ text?: string }>)[0].text as string),
    ) as Record<string, unknown>;

    expect(Array.isArray(parsed.reaped)).toBe(true);
    // The CLI reported this and the MCP path did not — the surface agents actually use.
    expect(parsed.floor).not.toBeNull();
  });
});
