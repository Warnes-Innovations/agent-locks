/**
 * The archived-id-reuse data loss, and the two independent guards against it.
 *
 * Before the fix: `uniqueFilePath` probed only the ACTIVE directory, so archiving a
 * lock made its id available again. A later claim in the same second with the same
 * title was issued that id, and `reopen` then renamed `done/<id>.md` over
 * `active/<id>.md` — destroying a live claim's scope, checklist, owner and progress,
 * exit 0, no warning. `finish` had the mirror of it, archiving over an existing done
 * record.
 *
 * Found independently by two reviewers 2026-09-04 and demonstrated end to end.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLock,
  finishLock,
  reopenLock,
  reapStaleLocks,
  queryLocks,
  DuplicateLockIdError,
} from '../lock/store.js';

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-collide-'));
  locksRoot = path.join(tmp, 'agents-locks');
});

const shared = {
  title: 'Shared Title',
  tasks: ['a task'],
  repository: '/x',
};

describe('guard 1 — an archived id is never re-issued', () => {
  it('a new claim in the same second with the same title gets a DIFFERENT id from the archived one', async () => {
    const a = await createLock(locksRoot, { ...shared, scope: ['old/**'], agent_id: 'agent-A [aaa]' });
    await finishLock(locksRoot, { lock_id: a.id, agent_id: 'agent-A [aaa]' });

    const b = await createLock(locksRoot, { ...shared, scope: ['live/**'], agent_id: 'agent-B [bbb]' });

    // The id is the only handle every surface uses. A duplicate makes "which lock is
    // this?" unanswerable and every by-id operation ambiguous.
    expect(b.id).not.toBe(a.id);
  });

  it('reopening the archived lock leaves the unrelated live claim intact', async () => {
    const a = await createLock(locksRoot, { ...shared, scope: ['old/**'], agent_id: 'agent-A [aaa]' });
    await finishLock(locksRoot, { lock_id: a.id, agent_id: 'agent-A [aaa]' });
    const b = await createLock(locksRoot, { ...shared, scope: ['live/**'], agent_id: 'agent-B [bbb]' });

    await reopenLock(locksRoot, { lock_id: a.id, reason: 'recovering', agent_id: 'agent-A [aaa]' });

    const live = await queryLocks(locksRoot, {});
    expect(live).toHaveLength(2);
    const bLock = live.find((l) => l.id === b.id);
    expect(bLock, "agent-B's live claim was destroyed by agent-A reopening an archived lock").toBeDefined();
    expect(bLock!.scope).toEqual(['live/**']);
    expect(bLock!.agent_id).toBe('agent-B [bbb]');
  });
});

describe('guard 2 — a move never clobbers, even if a duplicate arises another way', () => {
  // Guard 1 stops the id being re-issued. This one stops a destructive move if a
  // duplicate exists anyway — a hand-edited store, a restored backup, two processes
  // racing. A destructive move must never be the fallback for an unexpected state.

  it('reopen REFUSES when an active file with that id already exists', async () => {
    const a = await createLock(locksRoot, { ...shared, scope: ['old/**'], agent_id: 'agent-A [aaa]' });
    await finishLock(locksRoot, { lock_id: a.id, agent_id: 'agent-A [aaa]' });

    // Forge the collision guard 1 now prevents.
    const doneFile = path.join(locksRoot, 'done', `${a.id}.md`);
    await fs.copyFile(doneFile, path.join(locksRoot, `${a.id}.md`));

    await expect(reopenLock(locksRoot, { lock_id: a.id, reason: 'x' })).rejects.toThrow(DuplicateLockIdError);
    // ...and the file it would have clobbered is still there.
    await expect(fs.access(path.join(locksRoot, `${a.id}.md`))).resolves.toBeUndefined();
  });

  it('finish REFUSES when a done file with that id already exists', async () => {
    const a = await createLock(locksRoot, { ...shared, scope: ['old/**'], agent_id: 'agent-A [aaa]' });
    const activeFile = path.join(locksRoot, `${a.id}.md`);
    await fs.mkdir(path.join(locksRoot, 'done'), { recursive: true });
    await fs.copyFile(activeFile, path.join(locksRoot, 'done', `${a.id}.md`));

    await expect(finishLock(locksRoot, { lock_id: a.id })).rejects.toThrow(DuplicateLockIdError);
    const archived = await fs.readFile(path.join(locksRoot, 'done', `${a.id}.md`), 'utf8');
    expect(archived).toContain('old/**');
  });
});

describe('guard 2, continued — reap performs the same move and needs the same guard', () => {
  it('reap REFUSES when a done file with that id already exists', async () => {
    // reap does the identical active -> done move as finishLock. Fixing the guard in
    // one of the two functions that make the move is fixing the instance and leaving
    // the class: reap was demonstrated overwriting a holder's archived record —
    // summary gone, finished_by rewritten from holder to reap.
    const a = await createLock(locksRoot, { ...shared, scope: ['old/**'], agent_id: 'agent-A [aaa]' });
    const activeFile = path.join(locksRoot, `${a.id}.md`);

    // Forge a colliding archive entry, then make the active lock stale.
    await fs.mkdir(path.join(locksRoot, 'done'), { recursive: true });
    await fs.copyFile(activeFile, path.join(locksRoot, 'done', `${a.id}.md`));
    const raw = await fs.readFile(activeFile, 'utf8');
    await fs.writeFile(activeFile, raw.replace(/^updated: .*$/m, 'updated: 2020-01-01T00-00-00'), 'utf8');

    await expect(reapStaleLocks(locksRoot, {})).rejects.toThrow(DuplicateLockIdError);
    const archived = await fs.readFile(path.join(locksRoot, 'done', `${a.id}.md`), 'utf8');
    expect(archived, 'reap overwrote an existing archived record').toContain('status: active');
  });
});
