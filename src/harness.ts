/**
 * Module: optional, best-effort probes that ask each AI coding harness for its
 * own list of sessions, so a stale-looking lock can be read against whether
 * anyone is actually working in this repository right now.
 *
 * Issue #1. Read the two limits below before using any of this.
 *
 * WHAT THIS CANNOT DO, AND WHY IT IS NOT A BUG
 *
 * 1. It cannot tell you whether a PARTICULAR lock's owner is alive. A lock
 *    records `agent_id`, which is whatever the agent knew to call itself
 *    ('sable-1 [1a3e60]'). A harness records its own auto-generated `name`
 *    ('agent-locks-9a') plus a `sessionId`. Those are different namespaces:
 *    measured 2026-09-11, a single live session appeared as BOTH of those at
 *    once. The only stable join key is `sessionId`, and locks do not carry one
 *    — lock_create refuses to invent identity it cannot observe, which is the
 *    right call and is not being undone here.
 *
 *    So the evidence is REPOSITORY-level: "N sessions are live with a cwd
 *    inside this repo." It cannot be narrowed to a lock.
 *
 * 2. Because of (1), this must never feed the `stale` boolean. Folding
 *    repo-level activity into a per-lock verdict would mark every lock in a
 *    busy repository as fresh, including genuinely abandoned ones — which
 *    inverts the protection. Staleness stays a pure function of the lock's own
 *    `updated` field. This only ever ADDS context to a decision a caller is
 *    already making.
 */
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Per-probe wall-clock budget. A hung harness binary must not wedge a lock call. */
const PROBE_TIMEOUT_MS = 2_000;

/** One session as some harness reports it, normalised. */
export interface HarnessSession {
  /** Which probe produced this. */
  harness: string;
  /** The harness's own session identifier, verbatim. Never synthesised. */
  sessionId: string | null;
  /** The harness's own display name, verbatim. NOT comparable to a lock's agent_id — see module header. */
  name: string | null;
  /** Absolute working directory the harness reports for this session. */
  cwd: string;
  /** Epoch ms of the most recent activity the harness exposes, or null if it exposes none. */
  lastActivity: number | null;
  /**
   * True only when the harness's listing is a LIVE registry (the session exists
   * as a process right now). False when it is a historical session log, which
   * looks identical until you exit a session and re-list.
   */
  live: boolean;
}

export type ProbeOutcome =
  /** Binary not found. Expected and harmless — most machines run one harness. */
  | { status: 'absent'; harness: string; detail: string }
  /** Ran, parsed, here is what it said (possibly an empty list). */
  | { status: 'ok'; harness: string; sessions: HarnessSession[] }
  /** Binary exists but the probe could not get an answer. Reported, never swallowed. */
  | { status: 'failed'; harness: string; detail: string };

export interface HarnessEvidence {
  /** Sessions whose cwd was independently confirmed to be inside `repoRoot`. */
  sessionsInRepo: HarnessSession[];
  /** Every probe's outcome, including the ones that found nothing. */
  outcomes: ProbeOutcome[];
  /**
   * Human-readable caveat, ALWAYS present. An empty `sessionsInRepo` is not
   * evidence that nobody is working here — it is evidence that no probe that
   * ran could see anyone, which is a much smaller claim.
   */
  caveat: string;
}

export interface HarnessProbe {
  harness: string;
  /** Candidate absolute paths, tried in order, before falling back to PATH. */
  candidatePaths: () => string[];
  binaryName: string;
  args: (repoRoot: string) => string[];
  /** Parse stdout. Must throw on unparseable input rather than returning []. */
  parse: (stdout: string) => HarnessSession[];
}

/**
 * Claude Code. `claude agents --json` is a LIVE registry: pid, cwd, kind,
 * startedAt (epoch ms), sessionId, name.
 *
 * The candidate-path list is load-bearing, not defensive padding. On the
 * machine this was written for, `claude` is installed at ~/.local/bin/claude
 * and is NOT on the PATH that a stdio MCP server subprocess inherits — probing
 * PATH alone reported the harness ABSENT while nineteen of its sessions were
 * running. A false "no harness here" is the worst answer this module can give,
 * because it is indistinguishable from a genuinely idle repository.
 */
const claudeCodeProbe: HarnessProbe = {
  harness: 'claude-code',
  binaryName: 'claude',
  candidatePaths: () => [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ],
  args: () => ['agents', '--json'],
  parse: (stdout) => {
    const raw: unknown = JSON.parse(stdout);
    if (!Array.isArray(raw)) throw new Error('expected a JSON array');
    return raw.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        harness: 'claude-code',
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
        name: typeof e.name === 'string' ? e.name : null,
        cwd: String(e.cwd ?? ''),
        lastActivity: typeof e.startedAt === 'number' ? e.startedAt : null,
        // A registry of running processes: presence means alive.
        live: true,
      };
    });
  },
};

/**
 * OpenCode. `opencode session list --format json` is a HISTORICAL log, not a
 * live registry — verified in issue #1 by exiting a session and re-listing (the
 * entry survives). `updated` is a genuine last-activity stamp and does not move
 * merely because you queried it, so it is usable as corroboration; `live` is
 * false because presence here does NOT mean a process exists.
 *
 * Empty stdout with exit 0 means "no sessions", not "broken" — measured.
 */
const openCodeProbe: HarnessProbe = {
  harness: 'opencode',
  binaryName: 'opencode',
  candidatePaths: () => ['/usr/local/bin/opencode', '/opt/homebrew/bin/opencode'],
  args: () => ['session', 'list', '--format', 'json'],
  parse: (stdout) => {
    if (stdout.trim() === '') return [];
    const raw: unknown = JSON.parse(stdout);
    if (!Array.isArray(raw)) throw new Error('expected a JSON array');
    return raw.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        harness: 'opencode',
        sessionId: typeof e.id === 'string' ? e.id : null,
        name: typeof e.title === 'string' ? e.title : null,
        cwd: String(e.directory ?? ''),
        lastActivity: typeof e.updated === 'number' ? e.updated : null,
        live: false,
      };
    });
  },
};

/**
 * The registry. Gemini CLI and Cursor are deliberately absent, for DIFFERENT
 * reasons — issue #2 tracks both.
 *
 * Cursor: not installed anywhere this has run; nothing about it is verified.
 *
 * Gemini: fully characterised as of 2026-09-11, and left out anyway. It is a
 * HISTORICAL log (a session survives the process exiting — tested), so it would
 * be a third weak signal beside OpenCode's, saying little that a lock's own
 * `updated` field does not. And the two ways to read it are both bad bargains:
 * `gemini --list-sessions` ignores `-o json`, emitting prose with a relative
 * timestamp ("Just now") AND requiring GEMINI_API_KEY before it will list
 * anything — a coordination tool should not need a vendor credential to answer
 * "who is working here". The on-disk record is machine-readable and needs no
 * credential, but lives at an undocumented path under a directory named `tmp/`.
 *
 * Do not add a probe here without re-reading issue #2: the point is that a
 * registered probe means "verified to answer the liveness question usefully",
 * and a reader cannot tell a weak entry from a strong one once it is in the list.
 */
export const PROBES: HarnessProbe[] = [claudeCodeProbe, openCodeProbe];

async function resolveBinary(probe: HarnessProbe): Promise<string | null> {
  for (const candidate of probe.candidatePaths()) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next candidate. Absence is the normal case.
    }
  }
  // Then PATH. Confirmed with `command -v` FIRST so a missing binary is
  // reported as 'absent' rather than as a probe 'failed' — those mean different
  // things to a reader and collapsing them hides a broken install.
  try {
    await execFileAsync('/bin/sh', ['-c', `command -v ${probe.binaryName}`], { timeout: PROBE_TIMEOUT_MS });
    return probe.binaryName;
  } catch {
    return null;
  }
}

async function runProbe(probe: HarnessProbe, repoRoot: string): Promise<ProbeOutcome> {
  const binary = await resolveBinary(probe);
  if (binary === null) {
    return { status: 'absent', harness: probe.harness, detail: `${probe.binaryName} not found on PATH or in any known install location` };
  }
  try {
    const { stdout } = await execFileAsync(binary, probe.args(repoRoot), {
      cwd: repoRoot,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 'ok', harness: probe.harness, sessions: probe.parse(stdout) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'failed', harness: probe.harness, detail };
  }
}

/**
 * True when `candidate` is `root` or lives underneath it. Applied to every
 * session a probe returns, even when the probe claims to be cwd-scoped:
 * OpenCode's listing IS cwd-scoped and Claude Code's is NOT, and a caller
 * cannot tell which they are holding. Trusting the harness to have filtered is
 * how a session in a sibling repo ends up counted as activity here.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === '') return false;
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Run every probe against `repoRoot`. Never throws and never rejects: a probe
 * that explodes becomes a `failed` outcome, because this is decoration on a
 * lock operation and must not be able to fail one.
 */
export async function gatherHarnessEvidence(
  repoRoot: string,
  /**
   * Injectable so tests can exercise the absent / failed / containment paths
   * without depending on which harnesses happen to be installed on the machine
   * running them. A suite that asserts against the real registry passes or
   * fails for reasons that have nothing to do with this code.
   */
  probes: HarnessProbe[] = PROBES,
): Promise<HarnessEvidence> {
  const outcomes = await Promise.all(probes.map((probe) => runProbe(probe, repoRoot)));

  const sessionsInRepo = outcomes
    .flatMap((outcome) => (outcome.status === 'ok' ? outcome.sessions : []))
    .filter((session) => isInside(repoRoot, session.cwd));

  const ran = outcomes.filter((o) => o.status === 'ok').map((o) => o.harness);
  const absent = outcomes.filter((o) => o.status === 'absent').map((o) => o.harness);
  const failed = outcomes.filter((o) => o.status === 'failed').map((o) => o.harness);

  const parts = [
    `Probed: ${ran.length > 0 ? ran.join(', ') : 'none'}.`,
    absent.length > 0 ? `Not installed: ${absent.join(', ')}.` : '',
    failed.length > 0 ? `Could not answer: ${failed.join(', ')}.` : '',
    'This is REPOSITORY-level evidence and cannot be attributed to any particular lock:',
    "a lock's agent_id and a harness's session name are different namespaces.",
    'An empty result means no probe that ran could see anyone, NOT that nobody is working here.',
  ].filter((p) => p !== '');

  return { sessionsInRepo, outcomes, caveat: parts.join(' ') };
}
