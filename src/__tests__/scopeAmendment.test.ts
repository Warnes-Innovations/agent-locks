import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkConflicts,
  createLock,
  EmptyScopeError,
  EmptyUpdateError,
  findLockById,
  finishLock,
  heartbeatLock,
  IncompleteTaskUpdateError,
  lastUnreadableLocks,
  queryLocks,
  ScopeAmendmentError,
  TaskNotFoundError,
  updateLock,
} from '../lock/store.js';
import { parseTimestamp } from '../timestamp.js';
import { MalformedLockFileError, parseLockFile } from '../lock/markdown.js';

const TEST_REPO = '/tmp/fake-repo';

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-amend-test-'));
  locksRoot = path.join(tmp, 'agents-locks');
});

afterEach(async () => {
  await fs.rm(path.dirname(locksRoot), { recursive: true, force: true });
});

async function claim(scope: string[], tasks: string[] = ['task one', 'task two']): Promise<string> {
  const { id } = await createLock(locksRoot, { title: 'Session A work', scope, tasks, repository: TEST_REPO });
  return id;
}

describe('createLock echoes what it recorded', () => {
  it('returns the scope and a check prompt, not just an id', async () => {
    const result = await createLock(locksRoot, {
      title: 'Refactor auth',
      scope: ['auth/**', 'tests/auth/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    expect(result.scope).toEqual(['auth/**', 'tests/auth/**']);
    expect(result.scopeCheck).toContain('`auth/**`');
    expect(result.scopeCheck).toContain('invisible to any other agent looking for a conflict');
  });

  it('normalizes the recorded scope, so a whitespace-padded glob never becomes an unmatchable claim', async () => {
    const result = await createLock(locksRoot, {
      title: 'x',
      scope: [' auth/** ', 'auth/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    expect(result.scope).toEqual(['auth/**']);
  });

  it('refuses a scope that normalizes to nothing', async () => {
    await expect(
      createLock(locksRoot, { title: 'x', scope: ['   '], tasks: [], repository: TEST_REPO }),
    ).rejects.toThrow(EmptyScopeError);
  });
});

describe('updateLock scope amendment', () => {
  it('add_scope widens the claim and records the previous scope with a timestamp', async () => {
    const id = await claim(['auth/**']);
    const before = new Date();

    const result = await updateLock(locksRoot, { lock_id: id, add_scope: ['mcp_ctl.py'] });

    expect(result.scopeChanged).toBe(true);
    expect(result.previousScope).toEqual(['auth/**']);
    expect(result.scope).toEqual(['auth/**', 'mcp_ctl.py']);

    const record = await findLockById(locksRoot, id);
    expect(record?.frontmatter.scope).toEqual(['auth/**', 'mcp_ctl.py']);
    const history = record?.frontmatter.scope_history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].scope).toEqual(['auth/**']);
    // Timestamped, and in the same parseable format as every other timestamp
    // in the file — the history is only useful if a reader can order it.
    expect(parseTimestamp(history[0].replaced_at).getTime()).toBeGreaterThanOrEqual(
      Math.floor(before.getTime() / 1000) * 1000,
    );
  });

  it('scope replaces the claim, which is how a lock that over-claimed stops blocking others', async () => {
    const id = await claim(['src/**']);
    const result = await updateLock(locksRoot, { lock_id: id, scope: ['src/auth/**'] });

    expect(result.scope).toEqual(['src/auth/**']);
    expect(result.previousScope).toEqual(['src/**']);

    const conflicts = await checkConflicts(locksRoot, ['src/billing/invoice.ts']);
    expect(conflicts).toHaveLength(0);
  });

  it('accumulates one history entry per amendment, oldest first', async () => {
    const id = await claim(['a/**']);
    await updateLock(locksRoot, { lock_id: id, add_scope: ['b/**'] });
    await updateLock(locksRoot, { lock_id: id, add_scope: ['c/**'] });

    const record = await findLockById(locksRoot, id);
    expect(record?.frontmatter.scope_history?.map((entry) => entry.scope)).toEqual([['a/**'], ['a/**', 'b/**']]);
    expect(record?.frontmatter.scope).toEqual(['a/**', 'b/**', 'c/**']);
  });

  it('records no history entry when the amendment changes nothing', async () => {
    const id = await claim(['a/**']);
    const result = await updateLock(locksRoot, { lock_id: id, add_scope: ['a/**'] });

    expect(result.scopeChanged).toBe(false);
    expect(result.previousScope).toBeUndefined();
    const record = await findLockById(locksRoot, id);
    expect(record?.frontmatter.scope_history).toBeUndefined();
  });

  it('survives a write/read round-trip through the markdown file', async () => {
    const id = await claim(['a/**']);
    await updateLock(locksRoot, { lock_id: id, add_scope: ['b/**'] });

    const record = await findLockById(locksRoot, id);
    const raw = await fs.readFile(record!.filePath, 'utf8');
    expect(raw).toContain('scope_history:');
    // Re-read from disk (findLockById parses the file fresh) rather than
    // trusting the in-memory object the write came from.
    const reread = await findLockById(locksRoot, id);
    expect(reread?.frontmatter.scope_history?.[0]).toMatchObject({ scope: ['a/**'] });
  });

  it('amends scope and flips a task in the same call', async () => {
    const id = await claim(['a/**'], ['task one', 'task two']);
    const result = await updateLock(locksRoot, {
      lock_id: id,
      task_text: 'task one',
      done: true,
      add_scope: ['b/**'],
    });
    expect(result.percentComplete).toBe(50);
    expect(result.scope).toEqual(['a/**', 'b/**']);
  });

  it('fails whole rather than half-applying when the task is bad but the amendment is good', async () => {
    const id = await claim(['a/**']);
    await expect(
      updateLock(locksRoot, { lock_id: id, task_text: 'no such task', done: true, add_scope: ['b/**'] }),
    ).rejects.toThrow(TaskNotFoundError);

    // The amendment must NOT have landed: an error the agent reads as
    // "nothing happened" while the scope silently changed is worse than
    // either outcome alone.
    const record = await findLockById(locksRoot, id);
    expect(record?.frontmatter.scope).toEqual(['a/**']);
    expect(record?.frontmatter.scope_history).toBeUndefined();
  });

  it('rejects scope and add_scope in the same call', async () => {
    const id = await claim(['a/**']);
    await expect(
      updateLock(locksRoot, { lock_id: id, scope: ['b/**'], add_scope: ['c/**'] }),
    ).rejects.toThrow(ScopeAmendmentError);
  });

  it('rejects an amendment that would leave the lock claiming nothing', async () => {
    const id = await claim(['a/**']);
    await expect(updateLock(locksRoot, { lock_id: id, scope: [] })).rejects.toThrow(EmptyScopeError);
  });
});

describe('updateLock argument requirements', () => {
  it('echoes the current scope and the check prompt even on a routine task flip', async () => {
    const id = await claim(['auth/**']);
    const result = await updateLock(locksRoot, { lock_id: id, task_text: 'task one', done: true });

    expect(result.scopeChanged).toBe(false);
    expect(result.scope).toEqual(['auth/**']);
    expect(result.scopeCheck).toContain('`auth/**`');
  });

  it('accepts a note-only update with no task and no amendment', async () => {
    const id = await claim(['a/**']);
    const result = await updateLock(locksRoot, { lock_id: id, note: 'still working' });
    expect(result.scopeChanged).toBe(false);
    const record = await findLockById(locksRoot, id);
    expect(record?.notes).toContain('still working');
  });

  it('refuses a call with nothing to do rather than silently bumping the timestamp', async () => {
    const id = await claim(['a/**']);
    await expect(updateLock(locksRoot, { lock_id: id })).rejects.toThrow(EmptyUpdateError);
  });

  it('refuses task_text without done, and done without task_text', async () => {
    const id = await claim(['a/**']);
    await expect(updateLock(locksRoot, { lock_id: id, task_text: 'task one' })).rejects.toThrow(
      IncompleteTaskUpdateError,
    );
    await expect(updateLock(locksRoot, { lock_id: id, done: true })).rejects.toThrow(IncompleteTaskUpdateError);
  });

  it('refuses a whitespace-only note, which would record nothing while bumping the timestamp', async () => {
    const id = await claim(['a/**']);
    await expect(updateLock(locksRoot, { lock_id: id, note: '   ' })).rejects.toThrow(EmptyUpdateError);
  });

  it('validates arguments before touching disk, so a bad call cannot mutate a lock', async () => {
    const id = await claim(['a/**']);
    const before = await findLockById(locksRoot, id);
    await expect(updateLock(locksRoot, { lock_id: id })).rejects.toThrow(EmptyUpdateError);
    const after = await findLockById(locksRoot, id);
    expect(after?.frontmatter.updated).toBe(before?.frontmatter.updated);
  });
});

/**
 * The collision from issue #3, reproduced end to end.
 *
 * Session A claims auth/**. Its work legitimately grows into mcp_ctl.py.
 * Session B runs exactly the query the server's instructions prescribe —
 * lock_check_conflict before writing — and gets an empty result, because the
 * conflict check matches A's ORIGINAL globs. B proceeds and rewrites a file A
 * has already changed. Amending the scope is what closes it.
 */
describe('issue #3 collision', () => {
  it('an unamended scope hides grown work from the conflict check that is supposed to catch it', async () => {
    const id = await claim(['auth/oauth_config.py', 'auth/google_auth.py', 'tests/auth/**']);

    const beforeAmendment = await checkConflicts(locksRoot, ['mcp_ctl.py', 'gdrive/drive_tools.py']);
    expect(beforeAmendment).toHaveLength(0); // <- the bug: B sees nothing and proceeds

    await updateLock(locksRoot, { lock_id: id, add_scope: ['mcp_ctl.py', 'gdrive/drive_tools.py'] });

    const afterAmendment = await checkConflicts(locksRoot, ['mcp_ctl.py', 'gdrive/drive_tools.py']);
    expect(afterAmendment).toHaveLength(1);
    expect(afterAmendment[0].id).toBe(id);
  });

  it('an amended scope is also visible to lock_query\'s scope filter', async () => {
    const id = await claim(['auth/**']);
    expect(await queryLocks(locksRoot, { scope: ['mcp_ctl.py'] })).toHaveLength(0);

    await updateLock(locksRoot, { lock_id: id, add_scope: ['mcp_ctl.py'] });
    expect(await queryLocks(locksRoot, { scope: ['mcp_ctl.py'] })).toHaveLength(1);
  });
});

/**
 * The two failure modes that survive a green test suite: concurrency and a
 * half-written file. Both were reproduced against this code before the fixes
 * below existed, and both are silent — no error, no exit code, just a lock
 * quietly claiming less than its owner believes.
 */
describe('durability of an accepted amendment', () => {
  it('never loses one of two concurrent amendments — both land, or one is told it failed', async () => {
    // Before the compare-and-swap, this ended with one amendment simply gone
    // and BOTH calls returning success, each echoing a scope containing its own
    // addition. A lock-coordination tool losing a claim under concurrency is
    // the one failure it may not have.
    const id = await claim(['base/**']);

    const results = await Promise.allSettled([
      updateLock(locksRoot, { lock_id: id, add_scope: ['agentA/**'] }),
      updateLock(locksRoot, { lock_id: id, add_scope: ['agentB/**'] }),
    ]);

    const record = await findLockById(locksRoot, id);
    const finalScope = record!.frontmatter.scope;
    for (const [i, glob] of [[0, 'agentA/**'], [1, 'agentB/**']] as const) {
      // Either the amendment is on disk, or its call reported failure. What is
      // forbidden is "reported success, absent from the file".
      if (results[i].status === 'fulfilled') {
        expect(finalScope).toContain(glob);
      }
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('writes atomically, so a concurrent reader never sees a half-written lock', async () => {
    const id = await claim(['a/**']);
    const record = await findLockById(locksRoot, id);
    const dir = path.dirname(record!.filePath);

    // Hammer the file while reading it repeatedly; every read must parse.
    const writes = Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateLock(locksRoot, { lock_id: id, note: `note ${i} ${'x'.repeat(400)}` }).catch(() => undefined),
      ),
    );
    for (let i = 0; i < 25; i += 1) {
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        // A torn read would parse as a valid lock with a SHORTER scope, or throw.
        expect(parseLockFile(raw).frontmatter.scope).toEqual(['a/**']);
      }
    }
    await writes;
  });
});

describe('every write path is guarded, not just the one where the bug was found', () => {
  /**
   * The sibling-pattern check. `writeRecord` serialises the WHOLE record, so an
   * unguarded path that means to touch one scalar rewrites the scope, the
   * history, the tasks and the notes from whatever it last read. Guarding only
   * `updateLock` left `finishLock`, `heartbeatLock` and `reapStaleLocks` able to
   * revert a completed, acknowledged amendment — and `lock_heartbeat` is the
   * likeliest concurrent writer in the system, because the instructions tell
   * agents to call it during exactly the long stretch in which scope grows.
   */
  it.each([
    ['heartbeatLock', heartbeatLock],
    ['finishLock', finishLock],
  ])('%s concurrent with an amendment does not revert it', async (_name, op) => {
    const id = await claim(['src/**']);
    await Promise.all([
      updateLock(locksRoot, { lock_id: id, add_scope: ['docs/**'] }).catch(() => undefined),
      (op as (r: string, p: { lock_id: string }) => Promise<unknown>)(locksRoot, { lock_id: id }).catch(
        () => undefined,
      ),
    ]);
    const after = await findLockById(locksRoot, id);
    expect(after!.frontmatter.scope).toContain('docs/**');
  });
});

describe('malformed lock files', () => {
  it('skips a structurally damaged lock file, records it, and keeps serving the rest', async () => {
    // Two mechanisms meet here and both are needed.
    //
    // parseLockFile VALIDATES rather than casting, so a damaged file throws at
    // the read instead of returning a record with `undefined` where a timestamp
    // belongs and blowing up far away as "TypeError: b is not iterable". That
    // matters beyond tidiness: readAllRecords wraps the read in a try/catch, and
    // without validation that catch never fires — its own comment says so.
    //
    // readAllRecords then SKIPS the bad file and records it, rather than failing
    // the whole query. That is the better contract and it replaces the
    // fail-closed one this test originally asserted: one corrupt lock must not
    // take every other lock in the repository offline for every agent.
    const good = await createLock(locksRoot, {
      title: 'healthy',
      scope: ['ok/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    const { filePath } = await createLock(locksRoot, {
      title: 'legacy',
      scope: ['legacy/**', 'grown/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    const raw = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, raw.slice(0, raw.indexOf('updated:')));

    const locks = await queryLocks(locksRoot, {});
    expect(locks.map((l) => l.id)).toEqual([good.id]);
    // Skipped is not the same as never existed — the condition has to be
    // reportable, or a truncated store reads as a clean empty one.
    expect(lastUnreadableLocks.map((u) => path.basename(u.filePath))).toContain(
      path.basename(filePath),
    );
  });

  it('CANNOT detect a truncation that leaves a shorter but well-formed scope — which is why writes are atomic', async () => {
    // The honest bound on validation. A cut landing mid-glob yields
    // `scope: ["legacy/**", "gr"]` — a non-empty list of strings, structurally
    // perfect, semantically mutilated. No validator can tell that from a lock
    // that really claims those two globs, because nothing records how long the
    // list should have been.
    //
    // This is exactly why writeRecord uses temp+rename rather than relying on
    // this check: the defence against a shortened claim is that a reader never
    // observes a partially-written file in the first place. Do not read the
    // validator as covering this case.
    const { filePath } = await createLock(locksRoot, {
      title: 'legacy2',
      scope: ['legacy/**', 'grown/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    const raw = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, raw.slice(0, raw.indexOf('  - grown/**') + 6));

    const parsed = parseLockFile(await fs.readFile(filePath, 'utf8'), filePath);
    expect(parsed.frontmatter.scope).toEqual(['legacy/**', 'gr']);
  });

  it('refuses a wrong-shaped scope_history rather than spreading it into nonsense', async () => {
    // store.ts spreads this value when amending, so a malformed one was written
    // back WORSE than found — a string spread into one entry per character,
    // permanently. Refusing is the only safe reading; coercing to [] would
    // discard a real history.
    const { filePath, id } = await createLock(locksRoot, {
      title: 'bad-history',
      scope: ['a/**'],
      tasks: [],
      repository: TEST_REPO,
    });
    const raw = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, raw.replace('repository:', 'scope_history: not-a-list\nrepository:'));

    await expect(updateLock(locksRoot, { lock_id: id, add_scope: ['b/**'] })).rejects.toThrow(
      MalformedLockFileError,
    );
  });
});
