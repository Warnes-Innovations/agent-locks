import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkConflicts,
  createLock,
  finishLock,
  LockNotActiveError,
  LockNotFoundError,
  LockNotStaleError,
  queryLocks,
  reapStaleLocks,
  TaskNotFoundError,
  updateLock,
} from '../lock/store.js';

const TEST_REPO = '/tmp/fake-repo';

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-store-test-'));
  locksRoot = path.join(tmp, 'agents-locks');
});

afterEach(async () => {
  await fs.rm(path.dirname(locksRoot), { recursive: true, force: true });
});

describe('createLock', () => {
  it('writes an active lock file with the given title, scope, and unchecked tasks', async () => {
    const { id, filePath } = await createLock(locksRoot, {
      title: 'Add hindsight route tests',
      scope: ['backend/src/hindsight/**'],
      tasks: ['write unit tests', 'write integration test'],
      repository: TEST_REPO,
    });

    expect(id).toContain('add-hindsight-route-tests');
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).toContain('status: active');
    expect(raw).toContain('- [ ] write unit tests');
    expect(raw).toContain('- [ ] write integration test');
    expect(raw).toContain('agent_id: null');
    expect(raw).toContain('parent_agent_id: null');
  });

  it('records repository in frontmatter and returns it in summaries', async () => {
    const REPO = '/home/user/projects/test-repo';
    const { filePath } = await createLock(locksRoot, {
      title: 'repo-tracked lock',
      scope: ['a/**'],
      tasks: [],
      repository: REPO,
    });
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).toContain(`repository: ${REPO}`);

    const [summary] = await queryLocks(locksRoot, {});
    expect(summary.repository).toBe(REPO);
  });

  it('records agent_id/parent_agent_id when explicitly provided, and never fabricates them otherwise', async () => {
    const { filePath } = await createLock(locksRoot, {
      title: 'lock with known ids',
      scope: ['x/**'],
      tasks: [],
      agent_id: 'subagent-42',
      parent_agent_id: 'session-99',
    });
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).toContain('agent_id: subagent-42');
    expect(raw).toContain('parent_agent_id: session-99');
  });

  it('a lock created with zero tasks reports 100% complete', async () => {
    await createLock(locksRoot, { title: 'no tasks here', scope: ['x/**'], tasks: [] });
    const [summary] = await queryLocks(locksRoot, {});
    expect(summary.percentComplete).toBe(100);
  });
});

describe('queryLocks default view (HARD REQUIREMENT: excludes done locks)', () => {
  it('excludes a done lock when status is omitted entirely', async () => {
    const { id } = await createLock(locksRoot, { title: 'will be finished', scope: ['a/**'], tasks: [] });
    await finishLock(locksRoot, { lock_id: id });

    const defaultView = await queryLocks(locksRoot, {});
    expect(defaultView.find((l) => l.id === id)).toBeUndefined();
  });

  it('still returns the done lock when status is explicitly "done"', async () => {
    const { id } = await createLock(locksRoot, { title: 'will be finished', scope: ['a/**'], tasks: [] });
    await finishLock(locksRoot, { lock_id: id });

    const doneView = await queryLocks(locksRoot, { status: 'done' });
    expect(doneView.find((l) => l.id === id)).toBeDefined();
    expect(doneView.find((l) => l.id === id)?.status).toBe('done');
  });

  it('returns both active and done locks when status is "all"', async () => {
    const { id: activeId } = await createLock(locksRoot, { title: 'still active', scope: ['a/**'], tasks: [] });
    const { id: doneId } = await createLock(locksRoot, { title: 'will finish', scope: ['b/**'], tasks: [] });
    await finishLock(locksRoot, { lock_id: doneId });

    const all = await queryLocks(locksRoot, { status: 'all' });
    const ids = all.map((l) => l.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(doneId);
  });

  it('active locks remain visible in the default view', async () => {
    const { id } = await createLock(locksRoot, { title: 'still going', scope: ['a/**'], tasks: [] });
    const defaultView = await queryLocks(locksRoot, {});
    expect(defaultView.find((l) => l.id === id)).toBeDefined();
  });
});

describe('queryLocks filters', () => {
  it('filters by agent_id', async () => {
    await createLock(locksRoot, { title: 'mine', scope: ['a/**'], tasks: [], agent_id: 'agent-a' });
    await createLock(locksRoot, { title: 'theirs', scope: ['b/**'], tasks: [], agent_id: 'agent-b' });

    const results = await queryLocks(locksRoot, { agent_id: 'agent-a' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('mine');
  });

  it('filters by free-text search across title and notes', async () => {
    const { id } = await createLock(locksRoot, { title: 'hindsight route work', scope: ['a/**'], tasks: [] });
    await updateLock(locksRoot, { lock_id: id, task_text: 'nonexistent', done: true }).catch(() => {
      /* expected to throw; ignored here, this call is just noise-checking */
    });
    await createLock(locksRoot, { title: 'unrelated other work', scope: ['b/**'], tasks: [] });

    const results = await queryLocks(locksRoot, { text: 'hindsight' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('hindsight route work');
  });

  it('filters by scope overlap', async () => {
    await createLock(locksRoot, { title: 'oauth work', scope: ['backend/src/oauth/**'], tasks: [] });
    await createLock(locksRoot, { title: 'docs work', scope: ['docs/**'], tasks: [] });

    const results = await queryLocks(locksRoot, { scope: 'backend/src/oauth/client.ts' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('oauth work');
  });
});

describe('checkConflicts', () => {
  it('is purely informational: returns overlapping active locks without throwing or blocking', async () => {
    await createLock(locksRoot, { title: 'existing oauth lock', scope: ['backend/src/oauth/**'], tasks: [] });

    const conflicts = await checkConflicts(locksRoot, ['backend/src/oauth/client.ts']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toBe('existing oauth lock');
  });

  it('returns an empty array (not an error) when nothing conflicts', async () => {
    await createLock(locksRoot, { title: 'docs work', scope: ['docs/**'], tasks: [] });
    const conflicts = await checkConflicts(locksRoot, ['backend/src/oauth/client.ts']);
    expect(conflicts).toEqual([]);
  });

  it('never considers done locks a conflict', async () => {
    const { id } = await createLock(locksRoot, { title: 'finished oauth work', scope: ['backend/src/oauth/**'], tasks: [] });
    await finishLock(locksRoot, { lock_id: id });
    const conflicts = await checkConflicts(locksRoot, ['backend/src/oauth/client.ts']);
    expect(conflicts).toEqual([]);
  });
});

describe('updateLock', () => {
  it('flips the named task to done and reports updated percentComplete', async () => {
    const { id } = await createLock(locksRoot, {
      title: 'two task lock',
      scope: ['a/**'],
      tasks: ['task one', 'task two'],
    });

    const result = await updateLock(locksRoot, { lock_id: id, task_text: 'task one', done: true });
    expect(result.percentComplete).toBe(50);
  });

  it('appends a note when one is provided', async () => {
    const { id, filePath } = await createLock(locksRoot, { title: 'notable lock', scope: ['a/**'], tasks: ['t1'] });
    await updateLock(locksRoot, { lock_id: id, task_text: 't1', done: true, note: 'ran into a flaky test' });
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).toContain('- ran into a flaky test');
  });

  it('throws a clear TaskNotFoundError (never silently no-ops) when task_text does not match exactly', async () => {
    const { id } = await createLock(locksRoot, { title: 'strict match lock', scope: ['a/**'], tasks: ['Write the tests'] });
    await expect(updateLock(locksRoot, { lock_id: id, task_text: 'write the tests', done: true })).rejects.toThrow(
      TaskNotFoundError,
    );
  });

  it('throws LockNotFoundError for an unknown lock_id', async () => {
    await expect(updateLock(locksRoot, { lock_id: 'no-such-lock', task_text: 'x', done: true })).rejects.toThrow(
      LockNotFoundError,
    );
  });

  it('can update a lock that has already been finished (found regardless of active/done directory)', async () => {
    const { id } = await createLock(locksRoot, { title: 'finished then noted', scope: ['a/**'], tasks: ['t1'] });
    await finishLock(locksRoot, { lock_id: id });
    const result = await updateLock(locksRoot, { lock_id: id, task_text: 't1', done: true });
    expect(result.percentComplete).toBe(100);
  });
});

describe('finishLock', () => {
  it('moves the file from the active directory to done/, sets status: done, and appends the summary', async () => {
    const { id, filePath: activePath } = await createLock(locksRoot, { title: 'to finish', scope: ['a/**'], tasks: [] });
    const { filePath: donePath } = await finishLock(locksRoot, { lock_id: id, summary: 'shipped it' });

    expect(donePath).toContain(`${path.sep}done${path.sep}`);
    await expect(fs.access(activePath)).rejects.toThrow();
    const raw = await fs.readFile(donePath, 'utf8');
    expect(raw).toContain('status: done');
    expect(raw).toContain('- shipped it');
  });

  it('throws LockNotFoundError for an unknown lock_id', async () => {
    await expect(finishLock(locksRoot, { lock_id: 'no-such-lock' })).rejects.toThrow(LockNotFoundError);
  });

  it('throws LockNotActiveError (a distinct, clearer error) when finishing an already-done lock', async () => {
    const { id } = await createLock(locksRoot, { title: 'double finish', scope: ['a/**'], tasks: [] });
    await finishLock(locksRoot, { lock_id: id });
    await expect(finishLock(locksRoot, { lock_id: id })).rejects.toThrow(LockNotActiveError);
  });
});

describe('full lifecycle: create -> update -> finish -> excluded from default query', () => {
  it('runs the whole documented workflow end to end against the filesystem', async () => {
    const { id } = await createLock(locksRoot, {
      title: 'full lifecycle lock',
      scope: ['backend/src/lifecycle/**'],
      tasks: ['step one', 'step two'],
      agent_id: 'agent-lifecycle',
    });

    expect((await queryLocks(locksRoot, {})).map((l) => l.id)).toContain(id);

    await updateLock(locksRoot, { lock_id: id, task_text: 'step one', done: true, note: 'halfway there' });
    let mid = await queryLocks(locksRoot, {});
    expect(mid.find((l) => l.id === id)?.percentComplete).toBe(50);

    await updateLock(locksRoot, { lock_id: id, task_text: 'step two', done: true });
    mid = await queryLocks(locksRoot, {});
    expect(mid.find((l) => l.id === id)?.percentComplete).toBe(100);

    await finishLock(locksRoot, { lock_id: id, summary: 'all done' });

    const defaultView = await queryLocks(locksRoot, {});
    expect(defaultView.find((l) => l.id === id)).toBeUndefined();

    const doneView = await queryLocks(locksRoot, { status: 'done' });
    const finished = doneView.find((l) => l.id === id);
    expect(finished).toBeDefined();
    expect(finished?.percentComplete).toBe(100);
  });
});

describe('reapStaleLocks: a caller-supplied threshold may only LENGTHEN (regression)', () => {
  // Regression for the 2026-09-03 committee finding. `reap` refuses to force-finish a
  // NAMED non-stale lock, and the README promises it is "never a back door to
  // force-finish someone else's live work" — but the plural form took stale_minutes
  // straight from the caller with no floor, so `reap --stale-minutes 0.01` finished
  // every active lock in a repo, exit 0, no refusal. These tests fail against the
  // pre-fix code.
  /**
   * Backdate a lock's `updated` stamp so staleness is DETERMINISTIC rather than a race
   * against how long createLock happens to take. An earlier version of this test used a
   * fresh lock and a 0.6-second threshold; it passed against the pre-fix code too,
   * because the lock was not old enough for EITHER version to reap — i.e. it tested
   * nothing. Verified by running it against the reverted implementation.
   */
  async function backdateLock(id: string, minutesAgo: number): Promise<void> {
    // Active locks live directly in locksRoot; `done/` is a subdirectory beside them.
    for (const name of await fs.readdir(locksRoot)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(locksRoot, name);
      const text = await fs.readFile(file, 'utf8');
      if (!text.includes(id)) continue;
      const then = new Date(Date.now() - minutesAgo * 60_000);
      const p2 = (n: number) => String(n).padStart(2, '0');
      const stamp =
        `${then.getUTCFullYear()}-${p2(then.getUTCMonth() + 1)}-${p2(then.getUTCDate())}` +
        `T${p2(then.getUTCHours())}-${p2(then.getUTCMinutes())}-${p2(then.getUTCSeconds())}`;
      await fs.writeFile(file, text.replace(/^updated: .*$/m, `updated: ${stamp}`), 'utf8');
      return;
    }
    throw new Error(`no active lock file for ${id}`);
  }

  it('does not reap a lock older than a SUB-DEFAULT threshold but younger than the default', async () => {
    // 5 minutes old: reapable at the caller's 1-minute threshold (pre-fix), but not at
    // the 60-minute default. This is the exact window the exploit used.
    const { id } = await createLock(locksRoot, { title: 'live work', scope: ['a/**'], tasks: [] });
    await backdateLock(id, 5);

    const reaped = await reapStaleLocks(locksRoot, { stale_minutes: 1 });

    expect(reaped).toEqual([]);
    const stillActive = await queryLocks(locksRoot, {});
    expect(stillActive).toHaveLength(1);
    expect(stillActive[0]!.title).toBe('live work');
  });

  it('DOES still reap a genuinely stale lock at the default threshold', async () => {
    // The floor must not make reap useless: past the default, reaping still works.
    const { id } = await createLock(locksRoot, { title: 'abandoned', scope: ['a/**'], tasks: [] });
    await backdateLock(id, 90);

    const reaped = await reapStaleLocks(locksRoot, {});

    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.title).toBe('abandoned');
    expect(await queryLocks(locksRoot, {})).toEqual([]);
  });

  it('does not reap OTHER sessions\' live locks via a sub-default threshold', async () => {
    await createLock(locksRoot, { title: 'held by Red', scope: ['a/**'], tasks: [], agent_id: 'Red [bd9522]' });
    await createLock(locksRoot, { title: 'held by Blue', scope: ['b/**'], tasks: [], agent_id: 'Blue [aa1111]' });

    const reaped = await reapStaleLocks(locksRoot, { stale_minutes: 0.001 });

    expect(reaped).toEqual([]);
    expect(await queryLocks(locksRoot, {})).toHaveLength(2);
  });

  it('still honours a LENGTHENED threshold (the floor must not clamp upward)', async () => {
    await createLock(locksRoot, { title: 'fresh', scope: ['a/**'], tasks: [] });

    // 10000 minutes is far above the default; nothing is that old, so nothing reaps.
    expect(await reapStaleLocks(locksRoot, { stale_minutes: 10000 })).toEqual([]);
    expect(await queryLocks(locksRoot, {})).toHaveLength(1);
  });

  it('still refuses a NAMED non-stale lock, as before', async () => {
    const { id } = await createLock(locksRoot, { title: 'named live work', scope: ['a/**'], tasks: [] });

    await expect(reapStaleLocks(locksRoot, { lock_id: id, stale_minutes: 0.01 })).rejects.toThrow(
      LockNotStaleError,
    );
  });
});
