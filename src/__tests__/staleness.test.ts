import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkConflicts,
  createLock,
  heartbeatLock,
  LockNotActiveError,
  LockNotFoundError,
  LockNotStaleError,
  queryLocks,
  reapStaleLocks,
  resolveStaleMinutes,
} from '../lock/store.js';
import { DEFAULT_STALE_MINUTES } from '../lock/types.js';

const STALE_MINUTES_ENV_VAR = 'AGENT_LOCKS_STALE_MINUTES';

// Lock timestamps have whole-SECOND precision (see timestamp.ts) — a lock
// created at, say, 12:00:00.900 stores "12:00:00", so a check made 50ms
// later can already show up to ~1000ms of apparent staleness purely from
// truncation, with no real inactivity at all. Tests here account for that
// deliberately rather than fighting it:
//   - "definitely stale" tests sleep past SLEEP_MS (comfortably over the
//     threshold below) and use SHORT_STALE_MINUTES.
//   - "definitely not stale" tests use NOT_STALE_MINUTES, comfortably above
//     the ~1000ms truncation noise floor, with no sleep at all.
//   - "control" locks meant to stay fresh (e.g. a lock created right after
//     the sleep, in a test asserting it's NOT reaped alongside stale ones)
//     need their own margin against real scheduling overhead between their
//     creation and the moment the assertion actually runs — under a fully
//     parallel test run (many files, several with their own real sleeps,
//     genuinely competing for the CPU) that gap was observed to occasionally
//     exceed a too-tight threshold, reaping the "fresh" control lock too.
//     SHORT_STALE_MINUTES is set well above that realistic overhead, not
//     just above the truncation floor, specifically to keep those tests
//     robust under full-suite parallel load, not just in isolation.
const SLEEP_MS = 2500;
const SHORT_STALE_MINUTES = 0.03; // 1800ms — well above both the ~1000ms truncation floor and realistic scheduling overhead between a "fresh" control lock's creation and the moment it's checked
const NOT_STALE_MINUTES = 0.1; // 6000ms — comfortably above both floors with zero real wait

function sleepPastStaleThreshold(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
}

let locksRoot: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-staleness-test-'));
  locksRoot = path.join(tmp, 'agents-locks');
  delete process.env[STALE_MINUTES_ENV_VAR];
});

afterEach(async () => {
  await fs.rm(path.dirname(locksRoot), { recursive: true, force: true });
  delete process.env[STALE_MINUTES_ENV_VAR];
});

describe('resolveStaleMinutes', () => {
  it('returns DEFAULT_STALE_MINUTES when nothing is set', () => {
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);
  });

  it('prefers an explicit override over the environment variable', () => {
    process.env[STALE_MINUTES_ENV_VAR] = '5';
    expect(resolveStaleMinutes(30)).toBe(30);
  });

  it('reads AGENT_LOCKS_STALE_MINUTES from the environment when no override is given', () => {
    process.env[STALE_MINUTES_ENV_VAR] = '15';
    expect(resolveStaleMinutes()).toBe(15);
  });

  it('falls back to the default for a non-numeric or non-positive env value, rather than throwing', () => {
    process.env[STALE_MINUTES_ENV_VAR] = 'not-a-number';
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);

    process.env[STALE_MINUTES_ENV_VAR] = '-5';
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);

    process.env[STALE_MINUTES_ENV_VAR] = '0';
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);
  });

  it('reads the environment fresh every call, never caching a value from an earlier call', () => {
    process.env[STALE_MINUTES_ENV_VAR] = '10';
    expect(resolveStaleMinutes()).toBe(10);
    process.env[STALE_MINUTES_ENV_VAR] = '20';
    expect(resolveStaleMinutes()).toBe(20);
  });
});

describe('staleness in queryLocks / checkConflicts', () => {
  it('a freshly-created lock is not stale', async () => {
    const { id } = await createLock(locksRoot, { title: 'Fresh lock', scope: ['a/**'], tasks: [] });
    const [summary] = await queryLocks(locksRoot, { stale_minutes: NOT_STALE_MINUTES });
    expect(summary.id).toBe(id);
    expect(summary.stale).toBe(false);
    expect(summary.staleForSeconds).toBeGreaterThanOrEqual(0);
  });

  it('a lock becomes stale once past the threshold, using either a per-call override or the env var', async () => {
    await createLock(locksRoot, { title: 'Will go stale', scope: ['a/**'], tasks: [] });
    await sleepPastStaleThreshold();

    const withOverride = await queryLocks(locksRoot, { stale_minutes: SHORT_STALE_MINUTES });
    expect(withOverride[0].stale).toBe(true);

    process.env[STALE_MINUTES_ENV_VAR] = String(SHORT_STALE_MINUTES);
    const withEnv = await queryLocks(locksRoot, {});
    expect(withEnv[0].stale).toBe(true);

    // A generous threshold keeps the same lock not-stale.
    const withGenerousThreshold = await queryLocks(locksRoot, { stale_minutes: 1000 });
    expect(withGenerousThreshold[0].stale).toBe(false);
  });

  it('lock_update resets staleness (it bumps `updated`, the same field heartbeat uses)', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: ['t'] });
    await sleepPastStaleThreshold();
    expect((await queryLocks(locksRoot, { stale_minutes: SHORT_STALE_MINUTES }))[0].stale).toBe(true);

    const { updateLock } = await import('../lock/store.js');
    await updateLock(locksRoot, { lock_id: id, task_text: 't', done: true });
    expect((await queryLocks(locksRoot, { stale_minutes: NOT_STALE_MINUTES }))[0].stale).toBe(false);
  });

  it('a done lock is never reported stale, regardless of how long ago it was finished', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    const { finishLock } = await import('../lock/store.js');
    await finishLock(locksRoot, { lock_id: id });
    await sleepPastStaleThreshold();

    const [summary] = await queryLocks(locksRoot, { status: 'done', stale_minutes: SHORT_STALE_MINUTES });
    expect(summary.status).toBe('done');
    expect(summary.stale).toBe(false);
  });

  it('checkConflicts also surfaces stale/staleForSeconds on overlapping locks', async () => {
    await createLock(locksRoot, { title: 'x', scope: ['src/auth/**'], tasks: [] });
    await sleepPastStaleThreshold();
    const [summary] = await checkConflicts(locksRoot, ['src/auth/login.ts'], SHORT_STALE_MINUTES);
    expect(summary.stale).toBe(true);
  });
});

describe('heartbeatLock', () => {
  it('bumps updated without touching tasks, notes, or status', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: ['t1'] });
    await sleepPastStaleThreshold();
    expect((await queryLocks(locksRoot, { stale_minutes: SHORT_STALE_MINUTES }))[0].stale).toBe(true);

    const result = await heartbeatLock(locksRoot, { lock_id: id });
    expect(result.id).toBe(id);

    const [summary] = await queryLocks(locksRoot, { stale_minutes: NOT_STALE_MINUTES });
    expect(summary.stale).toBe(false);
    expect(summary.percentComplete).toBe(0); // unchanged — heartbeat touches nothing else
  });

  it('throws LockNotFoundError for an id that never existed', async () => {
    await expect(heartbeatLock(locksRoot, { lock_id: 'nope' })).rejects.toThrow(LockNotFoundError);
  });

  it('throws LockNotActiveError for a lock that exists but is already done', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    const { finishLock } = await import('../lock/store.js');
    await finishLock(locksRoot, { lock_id: id });
    await expect(heartbeatLock(locksRoot, { lock_id: id })).rejects.toThrow(LockNotActiveError);
  });
});

describe('reapStaleLocks', () => {
  // A per-call stale_minutes may only LENGTHEN the reaping window (see reapStaleLocks).
  // These tests reap sub-minute-old locks, so they lower the CONFIGURED DEFAULT — an
  // explicit operator-level choice — rather than shortening per call, which is the hole
  // closed on 2026-09-03.
  let savedStale: string | undefined;
  beforeEach(() => {
    savedStale = process.env.AGENT_LOCKS_STALE_MINUTES;
    process.env.AGENT_LOCKS_STALE_MINUTES = '0.03';
  });
  afterEach(() => {
    if (savedStale === undefined) delete process.env.AGENT_LOCKS_STALE_MINUTES;
    else process.env.AGENT_LOCKS_STALE_MINUTES = savedStale;
  });

  it('reaps every currently-stale active lock when no lock_id is given, leaving fresh ones alone', async () => {
    const staleOne = await createLock(locksRoot, { title: 'Stale one', scope: ['a/**'], tasks: [] });
    const staleTwo = await createLock(locksRoot, { title: 'Stale two', scope: ['b/**'], tasks: [] });
    await sleepPastStaleThreshold();
    const fresh = await createLock(locksRoot, { title: 'Fresh', scope: ['c/**'], tasks: [] });

    const reaped = await reapStaleLocks(locksRoot, { stale_minutes: SHORT_STALE_MINUTES });
    const reapedIds = reaped.map((r) => r.id).sort();
    expect(reapedIds).toEqual([staleOne.id, staleTwo.id].sort());

    const active = await queryLocks(locksRoot, {});
    expect(active.map((l) => l.id)).toEqual([fresh.id]);

    const done = await queryLocks(locksRoot, { status: 'done' });
    expect(done.map((l) => l.id).sort()).toEqual([staleOne.id, staleTwo.id].sort());
  });

  it('reaped locks get an honest auto-generated note, distinguishable from a real lock_finish', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    await sleepPastStaleThreshold();
    await reapStaleLocks(locksRoot, { lock_id: id, stale_minutes: SHORT_STALE_MINUTES });

    const [summary] = await queryLocks(locksRoot, { status: 'done' });
    expect(summary.id).toBe(id);
    // Read the raw file to confirm the note landed in the body, not just returned by the call.
    const files = await fs.readdir(path.join(locksRoot, 'done'));
    const raw = await fs.readFile(path.join(locksRoot, 'done', files[0]), 'utf8');
    expect(raw).toContain('Auto-reaped');
  });

  it('dry_run reports what would be reaped without mutating anything', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    await sleepPastStaleThreshold();

    const preview = await reapStaleLocks(locksRoot, { stale_minutes: SHORT_STALE_MINUTES, dry_run: true });
    expect(preview.map((r) => r.id)).toEqual([id]);

    // Still active — dry_run must not have written anything.
    const active = await queryLocks(locksRoot, {});
    expect(active.map((l) => l.id)).toEqual([id]);
  });

  it('refuses to reap a specific lock_id that is NOT actually stale, with a clear error', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    await expect(reapStaleLocks(locksRoot, { lock_id: id, stale_minutes: 1000 })).rejects.toThrow(LockNotStaleError);

    // Confirm it really wasn't touched.
    const [summary] = await queryLocks(locksRoot, {});
    expect(summary.status).toBe('active');
  });

  it('throws LockNotFoundError for a lock_id that never existed', async () => {
    await expect(reapStaleLocks(locksRoot, { lock_id: 'nope' })).rejects.toThrow(LockNotFoundError);
  });

  it('throws LockNotActiveError for a lock_id that exists but is already done', async () => {
    const { id } = await createLock(locksRoot, { title: 'x', scope: ['a/**'], tasks: [] });
    const { finishLock } = await import('../lock/store.js');
    await finishLock(locksRoot, { lock_id: id });
    await expect(reapStaleLocks(locksRoot, { lock_id: id })).rejects.toThrow(LockNotActiveError);
  });

  it('reaping with no stale locks at all (and no lock_id) returns an empty array, not an error', async () => {
    await createLock(locksRoot, { title: 'fresh', scope: ['a/**'], tasks: [] });
    const reaped = await reapStaleLocks(locksRoot, { stale_minutes: 1000 });
    expect(reaped).toEqual([]);
  });
});
