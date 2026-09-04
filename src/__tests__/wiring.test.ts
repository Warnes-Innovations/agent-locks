/**
 * POINTER TESTS for controls that were shipped WIRED BUT UNTESTED.
 *
 * A committee round ran 15 deletion proofs against the suite. Five controls could be
 * deleted outright with 199/199 still green:
 *
 *   1. withRecordLock in finishLock
 *   2. withRecordLock in heartbeatLock
 *   3. withRecordLock in reapStaleLocks
 *   4. recordTouch(... 'update')
 *   5. recordTouch(... 'finish')
 *
 * And `concurrency.test.ts`'s case named "a heartbeat racing an update does not
 * discard the update" passed 6 of 6 runs with heartbeat's serialization DELETED — a
 * test that cannot fail in the direction its own name asserts. In-process promise
 * interleaving does not reliably expose a lost update, because the awaits happen to
 * order themselves; the defect needs REAL concurrency or a deterministic hook.
 *
 * Every test here is written so that removing the control it names makes it fail.
 * That was verified by deleting each one and running this file.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../lock/events.js';
import { updateLock, finishLock, heartbeatLock, reapStaleLocks, reopenLock } from '../lock/store.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');

let repo: string;
let locksRoot: string;

beforeEach(async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-wiring-'));
  repo = path.join(sandbox, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
  await execFileAsync('git', ['add', 'a.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  locksRoot = path.join(repo, '.git', 'agents-locks');
});

/** Runs the built CLI as a REAL separate process, which is the only way these races appear. */
function cli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [CLI, ...args], { cwd: repo });
}

async function claim(title: string, extra: string[] = []): Promise<string> {
  const { stdout } = await cli(['claim', '--title', title, '--scope', 'src/**', '--task', 'work', ...extra]);
  return stdout.trim().split(' ').pop() as string;
}

/**
 * Asserts that `op` ACQUIRES the per-record mutation lock.
 *
 * Racing two real operations and hoping the loser is observed is not a test: the
 * first attempt at this raced updates against heartbeats and passed with heartbeat's
 * serialization deleted, because the interleaving simply did not happen that run. A
 * test that can only fail sometimes cannot detect a disconnected control.
 *
 * So assert the POINTER instead of trying to induce the symptom: hold the lockfile
 * from outside, and require that the operation WAITS. A serialized operation blocks;
 * an unserialized one sails past. Deterministic in both directions.
 */
async function assertTakesMutationLock(lockFilePath: string, op: () => Promise<unknown>): Promise<void> {
  const lockPath = path.join(
    path.dirname(lockFilePath),
    `.${path.basename(lockFilePath)}.mutation.lock`,
  );
  await fs.writeFile(lockPath, 'held-by-another-process', 'utf8');

  let settled = false;
  const running = op().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 400));
  const waited = !settled;

  await fs.rm(lockPath, { force: true });
  await running;

  expect(waited, 'the operation did not wait for the mutation lock — it is not serialized').toBe(true);
}

describe('withRecordLock is wired into every mutator', () => {
  it('update takes the mutation lock', async () => {
    const id = await claim('Lock update');
    await assertTakesMutationLock(path.join(locksRoot, `${id}.md`), () =>
      updateLock(locksRoot, { lock_id: id, note: 'n' }),
    );
  });

  it('finish takes the mutation lock', async () => {
    const id = await claim('Lock finish');
    await assertTakesMutationLock(path.join(locksRoot, `${id}.md`), () =>
      finishLock(locksRoot, { lock_id: id }),
    );
  });

  it('heartbeat takes the mutation lock', async () => {
    // This is the one that previously could not fail: the race-shaped version passed
    // 6/6 with heartbeat's serialization removed.
    const id = await claim('Lock heartbeat');
    await assertTakesMutationLock(path.join(locksRoot, `${id}.md`), () =>
      heartbeatLock(locksRoot, { lock_id: id }),
    );
  });

  it('reap takes the mutation lock', async () => {
    const id = await claim('Lock reap');
    const file = path.join(locksRoot, `${id}.md`);
    const raw = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, raw.replace(/^updated: .*$/m, 'updated: 2020-01-01T00-00-00'), 'utf8');
    await assertTakesMutationLock(file, () => reapStaleLocks(locksRoot, {}));
  });

  it('reopen takes the mutation lock', async () => {
    const id = await claim('Lock reopen');
    await finishLock(locksRoot, { lock_id: id });
    await assertTakesMutationLock(path.join(locksRoot, 'done', `${id}.md`), () =>
      reopenLock(locksRoot, { lock_id: id, reason: 'r' }),
    );
  });
});

describe('recordTouch is wired into every mutation that bumps the timestamp', () => {
  it('update emits a touch event', async () => {
    const id = await claim('Touch update');
    await cli(['update', id, '--task', 'work', '--done']);
    const touches = await readEvents(locksRoot, { type: 'touch' });
    expect(touches.filter((e) => e.lock_id === id && e.event === 'touch' && e.via === 'update')).toHaveLength(1);
  });

  it('heartbeat emits a touch event', async () => {
    const id = await claim('Touch heartbeat');
    await cli(['heartbeat', id]);
    const touches = await readEvents(locksRoot, { type: 'touch' });
    expect(touches.filter((e) => e.event === 'touch' && e.via === 'heartbeat')).toHaveLength(1);
  });

  it('finish emits a touch event — the last live interval of a lock never reaped', async () => {
    const id = await claim('Touch finish');
    await cli(['finish', id]);
    const touches = await readEvents(locksRoot, { type: 'touch' });
    expect(touches.filter((e) => e.event === 'touch' && e.via === 'finish')).toHaveLength(1);
  });

  it('records the ACTOR, not just the holder, and flags a foreign mutation', async () => {
    // Logging only the holder made an impersonated update indistinguishable from the
    // holder's own work in the one record that outlives the lock.
    const id = await claim('Actor', ['--agent', 'Alice [aaa1]']);
    await cli(['update', id, '--note', 'by bob', '--agent', 'Bob [bbb2]', '--force']);

    const touches = (await readEvents(locksRoot, { type: 'touch' })).filter((e) => e.event === 'touch');
    expect(touches).toHaveLength(1);
    const touch = touches[0];
    if (touch.event !== 'touch') throw new Error('expected a touch');
    expect(touch.agent_id).toBe('Alice [aaa1]');
    expect(touch.actor).toBe('Bob [bbb2]');
    expect(touch.foreign).toBe(true);
  });
});
