/**
 * Issue #1: harness session probes.
 *
 * Every probe here is INJECTED. Asserting against whichever harnesses happen to
 * be installed on the machine running the suite would make these tests pass or
 * fail for reasons unrelated to the code — and would be green on a CI runner
 * with no harness installed at all, which is precisely the case the absent-path
 * test exists to cover.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatherHarnessEvidence, PROBES, type HarnessProbe } from '../harness.js';

// A REAL directory: probes are spawned with cwd set to it, so a path that does
// not exist makes every probe fail with ENOENT and the containment assertions
// pass vacuously against an empty list.
let REPO: string;

beforeAll(async () => {
  REPO = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-harness-')));
});

afterAll(async () => {
  await fs.rm(REPO, { recursive: true, force: true });
});

/** A probe backed by `echo`, so it really does spawn a process and parse stdout. */
function echoProbe(harness: string, stdout: string, parse: HarnessProbe['parse']): HarnessProbe {
  return {
    harness,
    binaryName: 'echo',
    candidatePaths: () => ['/bin/echo'],
    args: () => [stdout],
    parse,
  };
}

const passthrough: HarnessProbe['parse'] = (out) =>
  (JSON.parse(out) as Array<Record<string, unknown>>).map((e) => ({
    harness: 'fake',
    sessionId: String(e.id),
    name: String(e.name),
    cwd: String(e.cwd),
    lastActivity: null,
    live: e.live === true,
  }));

describe('harness probes (issue #1)', () => {
  it('a missing binary is ABSENT, not an error, and yields no sessions', async () => {
    const missing: HarnessProbe = {
      harness: 'nonexistent-harness',
      binaryName: 'agent-locks-no-such-binary-xyzzy',
      candidatePaths: () => ['/nonexistent/path/to/nothing'],
      args: () => [],
      parse: () => [],
    };
    const evidence = await gatherHarnessEvidence(REPO, [missing]);

    expect(evidence.outcomes).toHaveLength(1);
    expect(evidence.outcomes[0].status).toBe('absent');
    expect(evidence.sessionsInRepo).toEqual([]);
  });

  it('a probe whose output cannot be parsed is FAILED, and never throws', async () => {
    // 'absent' and 'failed' must stay distinguishable: one is a machine that
    // does not run this harness, the other is a broken install. Collapsing them
    // would hide the second behind the first, which is always the common case.
    const broken = echoProbe('broken', 'not json at all', passthrough);
    const evidence = await gatherHarnessEvidence(REPO, [broken]);

    expect(evidence.outcomes[0].status).toBe('failed');
    expect(evidence.sessionsInRepo).toEqual([]);
  });

  it('sessions outside the repository are excluded, even though the harness returned them', async () => {
    // The containment check is applied to EVERY probe, including ones that claim
    // to be cwd-scoped. A caller holding an evidence object cannot tell which
    // kind they have, and trusting the harness to have filtered is how a sibling
    // repo's session gets counted as activity here.
    const sessions = JSON.stringify([
      { id: 'a', name: 'inside', cwd: REPO, live: true },
      { id: 'b', name: 'nested', cwd: path.join(REPO, 'packages', 'x'), live: true },
      { id: 'c', name: 'sibling', cwd: path.join(os.tmpdir(), 'some-other-repo'), live: true },
      // The prefix trap: a plain startsWith() would count this as inside.
      { id: 'd', name: 'prefix-trap', cwd: `${REPO}-not-really`, live: true },
      { id: 'e', name: 'empty-cwd', cwd: '', live: true },
    ]);
    const evidence = await gatherHarnessEvidence(REPO, [echoProbe('fake', sessions, passthrough)]);

    expect(evidence.sessionsInRepo.map((s) => s.name)).toEqual(['inside', 'nested']);
  });

  it('the caveat is always present, including when nothing was found', async () => {
    // An empty sessionsInRepo is not evidence that nobody is working here. If
    // the caveat were omitted on the empty case it would vanish exactly when a
    // reader is most likely to over-read the result.
    const evidence = await gatherHarnessEvidence(REPO, [echoProbe('fake', '[]', passthrough)]);

    expect(evidence.sessionsInRepo).toEqual([]);
    expect(evidence.caveat).not.toBe('');
    expect(evidence.caveat).toContain('NOT that nobody is working here');
  });

  it('parses a real `claude agents --json` payload, including that name != agent_id', async () => {
    // Captured from this machine on 2026-09-11. The last assertion is the whole
    // reason this feature is repository-level: the session below reported
    // name 'agent-locks-9a' while the lock it created recorded agent_id
    // 'sable-1 [1a3e60]'. Those are different namespaces, so no join is possible.
    const claude = PROBES.find((p) => p.harness === 'claude-code');
    expect(claude).toBeDefined();
    const sessions = claude!.parse(
      JSON.stringify([
        {
          pid: 50554,
          cwd: '/Users/warnes/src/agent-locks',
          kind: 'interactive',
          startedAt: 1788906721926,
          sessionId: '407494d2-8b8f-4680-ac51-d4d11e11af85',
          name: 'agent-locks-9a',
        },
      ]),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].live).toBe(true);
    expect(sessions[0].name).toBe('agent-locks-9a');
    expect(sessions[0].lastActivity).toBe(1788906721926);
    expect(sessions[0].name).not.toBe('sable-1 [1a3e60]');
  });

  it('treats OpenCode empty stdout as "no sessions", not as a parse failure', async () => {
    // Measured: `opencode session list --format json` exits 0 with zero bytes
    // when there is nothing to report. JSON.parse('') throws, so without this
    // the common case would be reported as a broken install.
    const opencode = PROBES.find((p) => p.harness === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode!.parse('')).toEqual([]);
    expect(opencode!.parse('   \n ')).toEqual([]);
  });

  it('OpenCode sessions are never marked live, because its listing is historical', async () => {
    // Confirmed in issue #1 by exiting a session and re-listing: the entry
    // survives. Marking these live would let a finished session vouch for
    // abandoned work indefinitely.
    const opencode = PROBES.find((p) => p.harness === 'opencode');
    const sessions = opencode!.parse(
      JSON.stringify([{ id: 's1', title: 'a session', directory: REPO, updated: 1788906721926 }]),
    );

    expect(sessions[0].live).toBe(false);
    expect(sessions[0].lastActivity).toBe(1788906721926);
  });

  it('only harnesses actually verified against a running session are registered', async () => {
    // Gemini CLI and Cursor are tracked in issue #2 and deliberately absent.
    // Cursor is simply untested. Gemini was tested (2026-09-11) and excluded on
    // the result: it is a historical log, not a live registry, so it would sit
    // beside two verified probes with nothing marking it as weaker evidence.
    // This assertion is what makes adding it later a deliberate act — it has to
    // be edited, which is the moment to re-read issue #2.
    expect(PROBES.map((p) => p.harness).sort()).toEqual(['claude-code', 'opencode']);
  });
});
