import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLock, queryLocks } from '../lock/store.js';

/**
 * Concurrent claim allocation.
 *
 * The id was chosen by PROBING for a free filename and then writing it — a TOCTOU.
 * Twelve simultaneous claims with the same title all saw the same id free and all took
 * it, leaving ONE lock on disk and eleven callers each holding an id for a claim that
 * no longer existed. Every one of them reported success.
 *
 * Found by the sibling sweep after the same read-then-write shape was fixed in the
 * mutators: createLock is the adjacent function, and it had the defect in its own form.
 */
let locksRoot: string;
beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'al-crace-'));
  locksRoot = path.join(tmp, 'agents-locks');
});
describe('concurrent create', () => {
  it('12 simultaneous claims with the same title all survive', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createLock(locksRoot, { title: 'Same Title', scope: [`s${i}/**`], tasks: ['t'], repository: '/x' }),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size, 'duplicate ids issued').toBe(12);
    const live = await queryLocks(locksRoot, {});
    expect(live.length, 'claims lost on disk').toBe(12);
  });
});
