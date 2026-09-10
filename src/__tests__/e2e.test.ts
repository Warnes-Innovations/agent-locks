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

  it('lists exactly the 8 documented tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'lock_check_conflict',
        'lock_check_drift',
        'lock_create',
        'lock_finish',
        'lock_heartbeat',
        'lock_query',
        'lock_reap',
        'lock_update',
      ].sort(),
    );
  });

  it('tells agents scope is amendable, in the instructions they read before any tool call', async () => {
    // The instructions are the only text an agent is guaranteed to see. A
    // scope-amendment feature nothing points at is one no session will use.
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('add_scope');
    expect(instructions).toContain('lock_check_drift');
    // The consequence clause, matched on its stable core rather than an exact
    // sentence — what must survive an edit is that the text names WHY an
    // unamended scope hurts, not the particular verb it uses to say so.
    expect(instructions).toMatch(/invisible to any other agent/);
    // And it must be inside the numbered procedure an agent actually executes:
    // guidance sitting only in the prose below the steps is a reminder, however
    // forcefully worded, and gets read past.
    const steps = instructions.slice(
      instructions.indexOf('Recommended workflow'),
      instructions.indexOf('Why steps 4 and 5'),
    );
    expect(steps).toContain('add_scope');
    expect(steps).toContain('lock_check_drift');

    // And the REPLACE parameter by its real name. The handshake said `scope`
    // for two commits after the rename to `set_scope`, and this assertion —
    // which already existed for add_scope — is exactly what would have caught
    // it. An agent following the stale step passed `scope`, which the schema
    // strips silently: success returned, claim unchanged.
    expect(instructions).toContain('set_scope');
    expect(steps).toContain('set_scope');
    expect(steps).not.toMatch(/\(scope replaces it/);
  });

  /**
   * The CLASS-level guard, and the reason the instance-level ones were not enough.
   *
   * Three separate sweeps for the `scope` -> `set_scope` rename each grepped for a
   * PHRASE that had broken ("or scope (replace)", "Mutually exclusive with `scope`")
   * and each came back clean while agent-facing strings were still wrong — the
   * survivors used different wording every time, ending with `scope/add_scope` in an
   * error message, which matched no phrase anyone thought to search for.
   *
   * So this asserts the PROPERTY instead: every snake_case token appearing in text we
   * hand to an agent must be a name that actually exists in the served schema. The
   * vocabulary is DERIVED from tools/list rather than hand-copied, because a literal
   * list in a test is a second copy of the schema and drifts green — the next rename
   * would leave this asserting that the stale token must remain.
   */
  it('no agent-facing string names an identifier that does not exist', async () => {
    const { tools } = await client.listTools();

    const known = new Set<string>();
    const corpus: Array<{ where: string; text: string }> = [
      { where: 'INSTRUCTIONS', text: client.getInstructions() ?? '' },
    ];
    for (const tool of tools) {
      known.add(tool.name);
      corpus.push({ where: `${tool.name}.description`, text: tool.description ?? '' });
      const props = ((tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties) ?? {};
      for (const [param, spec] of Object.entries(props)) {
        known.add(param);
        corpus.push({ where: `${tool.name}.${param}`, text: spec.description ?? '' });
      }
    }

    // Declared exceptions, reported rather than silent: names that are real but are
    // not tool or parameter names. Keep this list SHORT and justified — every entry
    // is a hole in the check.
    const EXCEPTIONS = new Map<string, string>([
      ['scope_history', 'a lock-file frontmatter field, not a tool parameter'],
    ]);

    const offenders: string[] = [];
    const exceptionsUsed = new Set<string>();
    for (const { where, text } of corpus) {
      for (const token of text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? []) {
        if (known.has(token)) continue;
        if (EXCEPTIONS.has(token)) { exceptionsUsed.add(token); continue; }
        offenders.push(`${where}: "${token}"`);
      }
    }

    // M0: state the exception list's effect even when it changes nothing.
    expect(EXCEPTIONS.size).toBeGreaterThanOrEqual(exceptionsUsed.size);
    expect(offenders, `agent-facing text names identifiers absent from the served schema:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every lock_update parameter description names only parameters that exist', async () => {
    // A description citing a sibling key that is not in the same schema is an
    // instruction to call something absent. add_scope's description named
    // `scope` while the schema carried `set_scope`, eight keys away.
    const { tools } = await client.listTools();
    const update = tools.find((t) => t.name === 'lock_update');
    const props = Object.keys((update?.inputSchema as { properties: object }).properties);
    expect(props).toContain('set_scope');
    expect(props).not.toContain('scope');

    const described = JSON.stringify(update?.inputSchema);
    // No description may cite a bare `scope` parameter — only set_scope/add_scope.
    expect(described).not.toMatch(/Mutually exclusive with `scope`/);
  });

  it('drives a real amend -> conflict-visible -> drift round trip over JSON-RPC', async () => {
    const created = toolResultJson(
      await client.callTool({
        name: 'lock_create',
        arguments: { title: 'E2E scope amendment', scope: ['auth/**'], tasks: ['grow the work'] },
      }),
    ) as { id: string; scope: string[]; scopeCheck: string };

    // lock_create echoes what it recorded, rather than only an id.
    expect(created.scope).toEqual(['auth/**']);
    expect(created.scopeCheck).toContain('`auth/**`');

    // Before amending, a peer's conflict check on the grown file sees nothing.
    const before = toolResultJson(
      await client.callTool({ name: 'lock_check_conflict', arguments: { scope: ['mcp_ctl.py'] } }),
    ) as Array<{ id: string }>;
    expect(before.find((l) => l.id === created.id)).toBeUndefined();

    const amended = toolResultJson(
      await client.callTool({
        name: 'lock_update',
        arguments: { lock_id: created.id, add_scope: ['mcp_ctl.py'] },
      }),
    ) as { scope: string[]; previousScope: string[]; scopeChanged: boolean };
    expect(amended.scopeChanged).toBe(true);
    expect(amended.previousScope).toEqual(['auth/**']);
    expect(amended.scope).toEqual(['auth/**', 'mcp_ctl.py']);

    // After amending, the same conflict check surfaces the lock.
    const after = toolResultJson(
      await client.callTool({ name: 'lock_check_conflict', arguments: { scope: ['mcp_ctl.py'] } }),
    ) as Array<{ id: string }>;
    expect(after.find((l) => l.id === created.id)).toBeDefined();

    const drift = toolResultJson(
      await client.callTool({ name: 'lock_check_drift', arguments: { lock_id: created.id } }),
    ) as { lock_id: string; scope: string[]; drifted: boolean; outOfScope: string[] };
    expect(drift.lock_id).toBe(created.id);
    expect(drift.scope).toEqual(['auth/**', 'mcp_ctl.py']);

    await client.callTool({ name: 'lock_finish', arguments: { lock_id: created.id } });
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
