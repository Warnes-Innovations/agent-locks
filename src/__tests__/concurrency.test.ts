/**
 * Concurrent mutation of one lock.
 *
 * Before per-record serialization: every mutator read the record, changed it in
 * memory and wrote it back, so two concurrent mutations both started from the same
 * state and the second erased the first. Each caller was told what IT wrote, so all
 * of them reported success. Measured: 8 concurrent `update --add-scope`, all exit 0,
 * each printing the pattern it had just added, 3 surviving on disk.
 *
 * A claim-tracking tool that drops claims while confirming them is worse than none:
 * a peer's conflict check then returns nothing for paths an agent was just told it
 * holds. Found by committee review 2026-09-04, reproduced against the shipped binary.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLock, updateLock, heartbeatLock, queryLocks } from '../lock/store.js';

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-conc-'));
  locksRoot = path.join(tmp, 'agents-locks');
});

describe('concurrent mutation', () => {
  it('every concurrent add_scope survives — no confirmed-but-lost claims', async () => {
    const { id } = await createLock(locksRoot, {
      title: 'Race', scope: ['base/**'], tasks: ['t'], repository: '/x',
    });

    const patterns = Array.from({ length: 12 }, (_, i) => `p${i + 1}/**`);
    await Promise.all(patterns.map((p) => updateLock(locksRoot, { lock_id: id, add_scope: [p] })));

    const [lock] = await queryLocks(locksRoot, {});
    for (const p of patterns) {
      expect(lock.scope, `${p} was confirmed to its caller but lost on disk`).toContain(p);
    }
    expect(lock.scope).toHaveLength(13);
  });

  it('concurrent task flips all land', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) => `task ${i + 1}`);
    const { id } = await createLock(locksRoot, {
      title: 'Race tasks', scope: ['base/**'], tasks, repository: '/x',
    });

    await Promise.all(tasks.map((t) => updateLock(locksRoot, { lock_id: id, task_text: t, done: true })));

    const [lock] = await queryLocks(locksRoot, {});
    expect(lock.percentComplete).toBe(100);
  });

  it('a heartbeat racing an update does not discard the update', async () => {
    const { id } = await createLock(locksRoot, {
      title: 'Race heartbeat', scope: ['base/**'], tasks: ['t'], repository: '/x',
    });

    await Promise.all([
      updateLock(locksRoot, { lock_id: id, add_scope: ['added/**'] }),
      heartbeatLock(locksRoot, { lock_id: id }),
      updateLock(locksRoot, { lock_id: id, task_text: 't', done: true }),
    ]);

    const [lock] = await queryLocks(locksRoot, {});
    expect(lock.scope).toContain('added/**');
    expect(lock.percentComplete).toBe(100);
  });
});
