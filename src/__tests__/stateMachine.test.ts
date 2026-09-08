/**
 * Tests for the lock STATE MACHINE — transitions 5 (scope mutation) and 9 (reopen),
 * plus the finish-provenance field both depend on.
 *
 * These exist because the machine was never written down: scope mutation was assumed
 * by three separate design decisions while the tool had no mutator at all, and nobody
 * noticed because nothing enumerated the transitions. The README now carries the table;
 * this file is the executable half of it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLock,
  finishLock,
  reapStaleLocks,
  reopenLock,
  updateLock,
  queryLocks,
  EmptyScopeError,
  LockNotDoneError,
  LockNotFoundError,
  NoOpUpdateError,
  ReopenReasonRequiredError,
  ScopeNotHeldError,
} from '../lock/store.js';
import { readEvents, appendEvent, lastEventLogErrors, eventsPath } from '../lock/events.js';

const TEST_REPO = '/tmp/fake-repo';

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-sm-test-'));
  locksRoot = path.join(tmp, 'agents-locks');
});

afterEach(async () => {
  await fs.rm(path.dirname(locksRoot), { recursive: true, force: true });
});

async function claim(overrides: Partial<Parameters<typeof createLock>[1]> = {}): Promise<string> {
  const { id } = await createLock(locksRoot, {
    title: 'some work',
    scope: ['src/a/**'],
    tasks: ['first', 'second'],
    repository: TEST_REPO,
    ...overrides,
  });
  return id;
}

/** Rewrites a lock's `updated` stamp so it reads as stale without waiting. */
async function backdate(id: string, minutesAgo: number): Promise<void> {
  for (const dir of [locksRoot, path.join(locksRoot, 'done')]) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      const text = await fs.readFile(file, 'utf8');
      if (!text.includes(`id: ${id}`)) continue;
      const stamp = new Date(Date.now() - minutesAgo * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '')
        .replace(/:/g, '-');
      await fs.writeFile(file, text.replace(/^updated: .*$/m, `updated: ${stamp}`), 'utf8');
    }
  }
}

describe('transition 5 — scope mutation', () => {
  it('add_scope extends an existing claim rather than requiring a second lock', async () => {
    const id = await claim();
    const result = await updateLock(locksRoot, { lock_id: id, add_scope: ['src/b/**'] });
    expect(result.scope).toEqual(['src/a/**', 'src/b/**']);

    // The claim must actually cover the new path for a CONSUMER, not just in the
    // return value — a scope edit that does not reach queryLocks is decorative.
    const found = await queryLocks(locksRoot, { scope: ['src/b/main.ts'] });
    expect(found.map((l) => l.id)).toEqual([id]);
  });

  it('add_scope is idempotent — re-adding a held pattern does not duplicate it', async () => {
    const id = await claim();
    await updateLock(locksRoot, { lock_id: id, add_scope: ['src/b/**'] });
    const again = await updateLock(locksRoot, { lock_id: id, add_scope: ['src/b/**', 'src/c/**'] });
    expect(again.scope).toEqual(['src/a/**', 'src/b/**', 'src/c/**']);
  });

  it('remove_scope drops a held pattern', async () => {
    const id = await claim({ scope: ['src/a/**', 'src/b/**'] });
    const result = await updateLock(locksRoot, { lock_id: id, remove_scope: ['src/a/**'] });
    expect(result.scope).toEqual(['src/b/**']);
    const found = await queryLocks(locksRoot, { scope: ['src/a/main.ts'] });
    expect(found).toEqual([]);
  });

  it('removing a pattern the lock does not hold is an ERROR, never a silent no-op', async () => {
    // The silent version is the dangerous one: a caller that believes it released a
    // path it still holds will not release it later either.
    const id = await claim();
    await expect(updateLock(locksRoot, { lock_id: id, remove_scope: ['src/nope/**'] })).rejects.toThrow(ScopeNotHeldError);
    const still = await queryLocks(locksRoot, { scope: ['src/a/x.ts'] });
    expect(still.map((l) => l.id)).toEqual([id]);
  });

  it('refuses to empty the scope entirely', async () => {
    const id = await claim();
    await expect(updateLock(locksRoot, { lock_id: id, remove_scope: ['src/a/**'] })).rejects.toThrow(EmptyScopeError);
  });

  it('validates every scope change before applying any of them', async () => {
    // A partially-applied scope edit is a claim whose extent nobody can state. The
    // second pattern here is not held, so NEITHER removal may land.
    const id = await claim({ scope: ['src/a/**', 'src/b/**'] });
    await expect(
      updateLock(locksRoot, { lock_id: id, remove_scope: ['src/a/**', 'src/nope/**'] }),
    ).rejects.toThrow(ScopeNotHeldError);
    const [lock] = await queryLocks(locksRoot, {});
    expect(lock.scope).toEqual(['src/a/**', 'src/b/**']);
  });

  it('refuses an update that would change nothing', async () => {
    // Otherwise this is an undocumented heartbeat: a caller could keep a claim alive
    // indefinitely while appearing to report progress on it.
    const id = await claim();
    await expect(updateLock(locksRoot, { lock_id: id })).rejects.toThrow(NoOpUpdateError);
  });

  it('still flips tasks, and can flip a task and change scope in one call', async () => {
    const id = await claim();
    const result = await updateLock(locksRoot, { lock_id: id, task_text: 'first', done: true, add_scope: ['src/b/**'] });
    expect(result.percentComplete).toBe(50);
    expect(result.scope).toEqual(['src/a/**', 'src/b/**']);
  });
});

describe('finish provenance', () => {
  it('records holder for an ordinary finish', async () => {
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await finishLock(locksRoot, { lock_id: id, agent_id: 'Red [bd9522]' });
    const [lock] = await queryLocks(locksRoot, { status: 'done' });
    expect(lock.finished_by).toBe('holder');
  });

  it('records force when another session deliberately ends the claim', async () => {
    const id = await claim({ agent_id: 'Blue [a1b2]' });
    await finishLock(locksRoot, { lock_id: id, agent_id: 'Red [bd9522]', force: true });
    const [lock] = await queryLocks(locksRoot, { status: 'done' });
    expect(lock.finished_by).toBe('force');
  });

  it('records reap when nobody was heard from', async () => {
    const id = await claim();
    await backdate(id, 90);
    await reapStaleLocks(locksRoot, {});
    const [lock] = await queryLocks(locksRoot, { status: 'done' });
    expect(lock.finished_by).toBe('reap');
  });
});

describe('transition 9 — reopen', () => {
  it('returns a reaped lock to active with no reason required, keeping its checklist', async () => {
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await updateLock(locksRoot, { lock_id: id, task_text: 'first', done: true });
    await backdate(id, 90);
    await reapStaleLocks(locksRoot, {});

    const result = await reopenLock(locksRoot, { lock_id: id, agent_id: 'Red [bd9522]' });
    expect(result.verdict).toBe('false-positive');
    expect(result.previously_finished_by).toBe('reap');

    // The point of reopen over re-claiming: the checklist survives.
    const [lock] = await queryLocks(locksRoot, {});
    expect(lock.id).toBe(id);
    expect(lock.status).toBe('active');
    expect(lock.percentComplete).toBe(50);
    expect(lock.finished_by).toBeNull();
  });

  it('requires a reason to revive a lock its owner deliberately finished', async () => {
    const id = await claim();
    await finishLock(locksRoot, { lock_id: id });
    await expect(reopenLock(locksRoot, { lock_id: id })).rejects.toThrow(ReopenReasonRequiredError);
    // A whitespace-only reason is not a reason.
    await expect(reopenLock(locksRoot, { lock_id: id, reason: '   ' })).rejects.toThrow(ReopenReasonRequiredError);
  });

  it('allows a deliberate finish to be reopened WITH a reason, and records it', async () => {
    const id = await claim();
    await finishLock(locksRoot, { lock_id: id });
    const result = await reopenLock(locksRoot, { lock_id: id, reason: 'the work was not actually done' });
    expect(result.verdict).toBe('not-a-reap');
    expect(result.previously_finished_by).toBe('holder');
    const raw = await fs.readFile(result.filePath, 'utf8');
    expect(raw).toContain('the work was not actually done');
  });

  it('refuses to reopen a lock that is already active, and errors for an unknown id', async () => {
    const id = await claim();
    await expect(reopenLock(locksRoot, { lock_id: id, reason: 'x' })).rejects.toThrow(LockNotDoneError);
    await expect(reopenLock(locksRoot, { lock_id: 'no-such-lock', reason: 'x' })).rejects.toThrow(LockNotFoundError);
  });
});

describe('the event log — the instrument behind any future threshold change', () => {
  it('a reap records the PRE-reap last-touch stamp and the idle interval', async () => {
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await updateLock(locksRoot, { lock_id: id, task_text: 'first', done: true });
    await backdate(id, 90);
    const before = await fs.readFile(
      path.join(locksRoot, `${id}.md`),
      'utf8',
    );
    const priorStamp = /^updated: (.*)$/m.exec(before)![1]!.trim();

    await reapStaleLocks(locksRoot, {});

    const events = await readEvents(locksRoot, { type: 'reap' });
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.event !== 'reap') throw new Error('expected a reap event');
    expect(event.lock_id).toBe(id);
    // The whole reason to log at reap time: `updated` is overwritten by the reap, so
    // the interval is destroyed by the very event that makes it interesting.
    expect(event.last_touch).toBe(priorStamp);
    expect(event.idle_seconds).toBeGreaterThan(60 * 60);
    expect(event.tasks_done).toBe(1);
    expect(event.tasks_total).toBe(2);
    expect(event.agent_id).toBe('Red [bd9522]');
    expect(event.threshold_minutes).toBe(60);
  });

  it('a reopen after a reap is recorded as a LABELLED false positive, with the reap interval joined in', async () => {
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await backdate(id, 90);
    await reapStaleLocks(locksRoot, {});
    const [reap] = await readEvents(locksRoot, { type: 'reap' });
    if (reap.event !== 'reap') throw new Error('expected a reap event');

    await reopenLock(locksRoot, { lock_id: id, agent_id: 'Red [bd9522]' });

    const [reopen] = await readEvents(locksRoot, { type: 'reopen' });
    if (reopen.event !== 'reopen') throw new Error('expected a reopen event');
    expect(reopen.verdict).toBe('false-positive');
    expect(reopen.finished_by).toBe('reap');
    // Self-contained: a later analysis never has to re-join the log to get the
    // interval that produced the wrong reap.
    expect(reopen.idle_at_reap_seconds).toBe(reap.idle_seconds);
  });

  it('a stranger reopening a reaped lock is NOT scored as evidence about the threshold', async () => {
    // The boolean scored this `true`, so an unrelated session reviving a genuinely
    // abandoned lock was recorded as proof the threshold was too short.
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await backdate(id, 90);
    await reapStaleLocks(locksRoot, {});

    const result = await reopenLock(locksRoot, { lock_id: id, agent_id: 'Blue [a1b2]' });
    expect(result.verdict).toBe('reaped-by-other');
  });

  it('a lock with no recorded provenance is scored unknown, never guessed', async () => {
    // Every lock written before finish-provenance existed reads back as null. Scoring
    // those as "not a false positive" biases the measurement toward "60 minutes is
    // fine" — the exact conclusion the log exists to test.
    const id = await claim();
    await finishLock(locksRoot, { lock_id: id });
    const doneFile = path.join(locksRoot, 'done', `${id}.md`);
    const raw = await fs.readFile(doneFile, 'utf8');
    await fs.writeFile(doneFile, raw.replace(/^finished_by: .*$/m, ''), 'utf8');

    const result = await reopenLock(locksRoot, { lock_id: id, reason: 'legacy revival' });
    expect(result.verdict).toBe('unknown');
  });

  it('a reopen of a DELIBERATE finish is not a false positive', async () => {
    const id = await claim();
    await finishLock(locksRoot, { lock_id: id });
    await reopenLock(locksRoot, { lock_id: id, reason: 'resumed' });
    const [reopen] = await readEvents(locksRoot, { type: 'reopen' });
    if (reopen.event !== 'reopen') throw new Error('expected a reopen event');
    expect(reopen.verdict).toBe('not-a-reap');
    expect(reopen.idle_at_reap_seconds).toBeNull();
  });

  it('a missing log reads as empty, not as an error', async () => {
    expect(await readEvents(locksRoot)).toEqual([]);
    expect(lastEventLogErrors).toEqual([]);
  });

  it('one corrupt line is skipped and REPORTED, never fatal and never silent', async () => {
    const id = await claim();
    await backdate(id, 90);
    await reapStaleLocks(locksRoot, {});
    await fs.appendFile(eventsPath(locksRoot), 'not json at all\n{"event":"bogus"}\n', 'utf8');

    const events = await readEvents(locksRoot);
    expect(events).toHaveLength(1); // the real reap survived
    expect(lastEventLogErrors).toHaveLength(2);
    expect(lastEventLogErrors[0].phase).toBe('read');
    expect(lastEventLogErrors[1].reason).toContain('not a recognised lock event');
  });

  it('a failing append never fails the operation it describes', async () => {
    // Telemetry that can break a reap converts observability into an availability
    // risk on the primary path. Make the log path unwritable by making it a
    // directory, then confirm the reap still completes.
    const id = await claim();
    await fs.mkdir(locksRoot, { recursive: true });
    await fs.mkdir(eventsPath(locksRoot), { recursive: true });
    await backdate(id, 90);

    const reaped = await reapStaleLocks(locksRoot, {});
    expect(reaped).toHaveLength(1);
    const [lock] = await queryLocks(locksRoot, { status: 'done' });
    expect(lock.id).toBe(id);
    // ...and the failure was recorded rather than swallowed.
    expect(lastEventLogErrors.some((e) => e.phase === 'append')).toBe(true);
  });

  it('filters by type, lock and limit', async () => {
    await appendEvent(locksRoot, {
      event: 'reap',
      ts: '2026-01-01T00-00-00',
      lock_id: 'one',
      repository: TEST_REPO,
      agent_id: null,
      created: '2026-01-01T00-00-00',
      last_touch: '2026-01-01T00-00-00',
      age_seconds: 1,
      idle_seconds: 1,
      tasks_total: 0,
      tasks_done: 0,
      threshold_minutes: 60,
    });
    await appendEvent(locksRoot, {
      event: 'reopen',
      ts: '2026-01-01T00-01-00',
      lock_id: 'two',
      repository: TEST_REPO,
      agent_id: null,
      finished_by: 'reap',
      reason: null,
      verdict: 'false-positive',
      idle_at_reap_seconds: 1,
    });
    expect(await readEvents(locksRoot, { type: 'reap' })).toHaveLength(1);
    expect(await readEvents(locksRoot, { lock_id: 'two' })).toHaveLength(1);
    expect(await readEvents(locksRoot, { limit: 1 })).toHaveLength(1);
    // limit takes the MOST RECENT, not the first.
    expect((await readEvents(locksRoot, { limit: 1 }))[0].lock_id).toBe('two');
  });
});

describe('transitions that must stay ABSENT', () => {
  it('offers no way to set agent_id on an existing lock', async () => {
    // Retrofitting an owner onto a lock would make a misattribution DURABLE — two
    // sessions already made one by hand. A policy erodes; this assertion does not.
    const id = await claim();
    const params = { lock_id: id, note: 'x', agent_id: 'Someone Else [ffff]' };
    await updateLock(locksRoot, params as Parameters<typeof updateLock>[1]);
    const [lock] = await queryLocks(locksRoot, {});
    expect(lock.agent_id).toBeNull();
  });
});

describe('session gaps are not live intervals', () => {
  it('a touch on an ALREADY-STALE lock is flagged and excluded from the live distribution', async () => {
    // Observed for real: a lock left across a four-day break would have contributed a
    // 109-hour "live inter-touch interval" to the distribution whose TAIL sets the
    // staleness threshold — one point arguing for a five-day threshold. Somebody
    // returning to an abandoned lock is a different population from a holder who was
    // alive and quiet.
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await backdate(id, 60 * 24 * 4); // four days
    await updateLock(locksRoot, { lock_id: id, note: 'back after a long break', agent_id: 'Red [bd9522]' });

    const touches = (await readEvents(locksRoot, { type: 'touch' })).filter((e) => e.event === 'touch');
    expect(touches).toHaveLength(1);
    const touch = touches[0];
    if (touch.event !== 'touch') throw new Error('expected a touch');
    expect(touch.was_stale).toBe(true);
    expect(touch.idle_seconds).toBeGreaterThan(60 * 60 * 24 * 3);
  });

  it('an ordinary touch within the threshold is NOT flagged', async () => {
    const id = await claim({ agent_id: 'Red [bd9522]' });
    await updateLock(locksRoot, { lock_id: id, note: 'still working', agent_id: 'Red [bd9522]' });

    const touches = (await readEvents(locksRoot, { type: 'touch' })).filter((e) => e.event === 'touch');
    const touch = touches[0];
    if (touch.event !== 'touch') throw new Error('expected a touch');
    expect(touch.was_stale).toBe(false);
  });
});
