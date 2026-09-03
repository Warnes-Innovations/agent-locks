/**
 * Module: builds the agent-locks McpServer instance and registers its 7
 * tools. Kept separate from index.ts (the stdio entrypoint) so tests can
 * construct a server and drive it without spawning a real subprocess.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveLocksRoot, resolveRepoRoot, NotAGitRepoError } from './git.js';
import {
  createLock,
  queryLocks,
  checkConflicts,
  updateLock,
  finishLock,
  heartbeatLock,
  reapStaleLocks,
  LockNotFoundError,
  TaskNotFoundError,
  LockNotActiveError,
  LockNotStaleError,
} from './lock/store.js';
import { DEFAULT_STALE_MINUTES } from './lock/types.js';

const SERVER_NAME = 'agent-locks';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `agent-locks: filesystem-based work-claiming locks shared across every git worktree of the current repository. No database — everything lives as markdown files under the repo's shared .git directory, so it is automatically invisible to git and never gets committed.

Recommended workflow, in order:
1. Before starting work on a set of files, call lock_query (default view, active locks only) to see what other agents are already doing, and call lock_check_conflict with the globs you're about to touch to see if anyone's active lock overlaps them. lock_check_conflict is purely informational — it never blocks you, it just gives you information to make your own judgment call with.
2. If you decide to proceed, call lock_create to claim the work: give it a title, the glob patterns describing what you're touching, and a checklist of the tasks you plan to do.
3. As you actually complete each task, call lock_update immediately — not batched at the end. The whole point of this system is that other agents can see live, current state; a lock that only gets updated right before you finish is not useful to anyone watching in the meantime. If you're doing a long stretch of work without a task boundary to check off, call lock_heartbeat periodically so your lock doesn't read as abandoned to anyone else watching.
4. When the work is done, call lock_finish with a short summary. This moves the lock out of the active set and into the done archive, and it will no longer show up in lock_query's default view.

Working in a different repository than the one you are rooted in: every tool accepts an optional base_dir — any path inside the target repository. Locks then resolve from THAT repository's shared .git rather than from the current working directory. Use it whenever you are about to write into another repo: a lock created where you happen to be standing, instead of where you are writing, is invisible to the one agent who needed to see it. A base_dir that is not inside a git repository is a hard error, never a silent fallback to the current directory.

Staleness: every lock returned by lock_query / lock_check_conflict carries a computed \`stale\` flag (and \`staleForSeconds\`) — true when an ACTIVE lock hasn't been touched (create, lock_update, or lock_heartbeat) in over ${DEFAULT_STALE_MINUTES} minutes (configurable via the AGENT_LOCKS_STALE_MINUTES environment variable, or per-call). This is informational, exactly like lock_check_conflict — nothing is ever cleaned up as a side effect of reading. If you see a stale lock that's blocking your own work, call lock_reap on it explicitly; it will refuse (with a clear error) if the lock turns out not to actually be stale by the time you call it, so it can't be used as a workaround to force-finish someone else's live work. A supplied stale_minutes may only LENGTHEN the window (it is floored at the default), so a small value cannot be used to reap live locks.

Honesty note on agent identity: this server cannot detect your agent id or your parent agent's id automatically — no MCP transport mechanism exposes that. Pass agent_id/parent_agent_id to lock_create only if you already know them from your own context (e.g. an orchestration harness gave you an explicit id); otherwise omit them and they will be recorded as null. Do not guess or fabricate an id.`;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'lock_query',
    {
      title: 'Query locks',
      description:
        'Lists agent-locks work-claim locks for the current git repository (shared across all its worktrees). ' +
        'IMPORTANT: when `status` is omitted, this ONLY returns active locks — done/finished locks are excluded from the default view by design, ' +
        'so you see what is currently being worked on, not a full history. Pass status: "done" or status: "all" to include finished locks. ' +
        'Returns a compact summary per lock: {id, title, status, percentComplete, scope, agent_id, parent_agent_id, stale, staleForSeconds}. ' +
        'percentComplete is computed from the ratio of checked to total tasks on that lock (a lock with zero tasks reports 100). ' +
        `stale is true for an ACTIVE lock not touched in over stale_minutes (default ${DEFAULT_STALE_MINUTES}) — computed fresh on every call, never mutates anything; done locks are never stale.`,
      inputSchema: {
        status: z
          .enum(['active', 'done', 'all'])
          .optional()
          .describe('Which locks to include. Defaults to "active" (done locks are excluded unless you explicitly ask for them).'),
        scope: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'One or more glob patterns. Only locks whose own scope glob-overlaps at least one of these patterns are returned. ' +
              'Uses the same overlap heuristic as lock_check_conflict (see that tool\'s description for its limitations).',
          ),
        agent_id: z.string().optional().describe('Only return locks created with this exact agent_id.'),
        text: z
          .string()
          .optional()
          .describe('Free-text, case-insensitive substring search across each lock\'s title and its Notes section.'),
        stale_minutes: z
          .number()
          .positive()
          .optional()
          .describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'Locks are resolved from that repository\'s shared .git directory instead of the current working directory. ' +
              'Fails with a clear error if this path is not inside a git repository.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, scope, agent_id, text, stale_minutes, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const results = await queryLocks(locksRoot, { status, scope, agent_id, text, stale_minutes });
        return textResult(JSON.stringify(results, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_check_conflict',
    {
      title: 'Check for scope conflicts',
      description:
        'Checks whether any currently ACTIVE lock claims file(s)/path(s) that overlap the glob patterns you pass in. ' +
        'This tool is purely INFORMATIONAL — it never blocks, refuses, or vetoes anything; it has no side effects and cannot prevent lock_create from proceeding. ' +
        'It exists only to give you information so you (the calling agent) can decide for yourself whether to proceed, coordinate with the other lock\'s owner, or pick a narrower scope. ' +
        'Overlap is determined by a static-prefix glob heuristic (not exact set intersection) that is intentionally biased toward reporting overlaps that turn out not to matter, rather than missing a real one — ' +
        'see this project\'s README for the exact heuristic and a documented case (filesystem case-sensitivity) it deliberately does not catch. ' +
        'Returns the same compact summary shape as lock_query (including stale/staleForSeconds) for every overlapping active lock (empty array if none).',
      inputSchema: {
        scope: z.array(z.string()).describe('Glob patterns describing the files/paths you are about to work on.'),
        stale_minutes: z
          .number()
          .positive()
          .optional()
          .describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'Conflicts are checked against locks in that repository\'s shared .git directory instead of the current working directory.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ scope, stale_minutes, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const results = await checkConflicts(locksRoot, scope, stale_minutes);
        return textResult(JSON.stringify(results, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_create',
    {
      title: 'Create a lock',
      description:
        'Claims a piece of work by writing a new active lock file. Use this after you have decided to proceed (optionally having checked lock_query / lock_check_conflict first). ' +
        'tasks are created as a plain unchecked checklist; call lock_update as you complete each one. ' +
        'agent_id / parent_agent_id: pass your OWN id here only if you already know it from your own context (some orchestration harnesses hand a subagent an explicit id when dispatching it) — ' +
        'this server has no way to detect either value automatically (no MCP transport mechanism exposes a session/agent id to a stdio server subprocess). ' +
        'Omit them (or pass null) if you do not know them; they will be recorded as null, never fabricated. ' +
        'parent_agent_id specifically means "the id of whatever spawned you," if you are a subagent and happen to know it.',
      inputSchema: {
        title: z.string().min(1).describe('Short human-readable title for this lock.'),
        scope: z.array(z.string()).min(1).describe('Glob patterns describing the files/paths this lock claims.'),
        tasks: z.array(z.string()).describe('Plain-text descriptions of the tasks you plan to do. All are created unchecked.'),
        agent_id: z
          .string()
          .nullable()
          .optional()
          .describe('Your own agent id, ONLY if you already know it from your context. Omit or pass null otherwise — never guess.'),
        parent_agent_id: z
          .string()
          .nullable()
          .optional()
          .describe('The id of whatever spawned you, ONLY if you already know it. Omit or pass null otherwise — never guess.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'The lock is created in that repository\'s shared .git directory instead of the current working directory. ' +
              'Use this when an agent working in one repo needs to claim work in another — a lock the colliding agent cannot see is decorative.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, scope, tasks, agent_id, parent_agent_id, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const [locksRoot, repoRoot] = await Promise.all([
          resolveLocksRoot(cwd),
          resolveRepoRoot(cwd),
        ]);
        const result = await createLock(locksRoot, { title, scope, tasks, agent_id, parent_agent_id, repository: repoRoot });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_update',
    {
      title: 'Update a lock',
      description:
        'Flips one task on an existing lock to done or not-done, and optionally appends a note. ' +
        'Call this AS SOON as a task actually completes — not batched at the end of your work — so other agents watching lock_query see live progress. ' +
        'task_text must match an EXISTING task\'s text EXACTLY (no fuzzy/partial matching); if it does not match, this returns an error listing the lock\'s actual task texts rather than silently doing nothing. ' +
        'Works on a lock in either active or done status (found by lock_id regardless of which directory it currently lives in).',
      inputSchema: {
        lock_id: z.string().describe('The id of the lock to update (as returned by lock_create or lock_query).'),
        task_text: z.string().describe('The exact text of an existing task on this lock.'),
        done: z.boolean().describe('true to mark the task done, false to mark it not done.'),
        note: z.string().optional().describe('Optional free-text note to append to the lock\'s Notes section.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'The lock is looked up in that repository\'s shared .git directory. Omit to use the current working directory.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ lock_id, task_text, done, note, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await updateLock(locksRoot, { lock_id, task_text, done, note });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_finish',
    {
      title: 'Finish a lock',
      description:
        'Marks an active lock as done, optionally appending a closing summary to its Notes, and moves its file from the active set into the done archive. ' +
        'Once finished, the lock stops appearing in lock_query\'s default (status-omitted) view. ' +
        'Errors clearly if lock_id does not exist, or if it exists but is already done (rather than silently no-op-ing).',
      inputSchema: {
        lock_id: z.string().describe('The id of the active lock to finish.'),
        summary: z.string().optional().describe('Optional closing summary appended to the Notes section before the lock is archived.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'The lock is looked up in that repository\'s shared .git directory. Omit to use the current working directory.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ lock_id, summary, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await finishLock(locksRoot, { lock_id, summary });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_heartbeat',
    {
      title: 'Heartbeat a lock',
      description:
        'Bumps ONLY a lock\'s updated timestamp — no task, note, or scope change. Call this periodically during a long stretch of work that isn\'t naturally hitting lock_update often enough ' +
        '(completing a task also counts as a heartbeat for free) to keep the lock from being computed as stale by lock_query / lock_check_conflict. ' +
        'Restricted to active locks — errors clearly if lock_id does not exist, or exists but is already done (heartbeating finished work is not a meaningful operation).',
      inputSchema: {
        lock_id: z.string().describe('The id of the active lock to heartbeat.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'The lock is looked up in that repository\'s shared .git directory. Omit to use the current working directory.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ lock_id, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await heartbeatLock(locksRoot, { lock_id });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_reap',
    {
      title: 'Reap stale lock(s)',
      description:
        'Finishes (moves to the done archive, same mechanism as lock_finish) every ACTIVE lock currently computed as stale, or a single specific one if lock_id is given. ' +
        'This is an explicit, deliberate mutation — never a side effect of lock_query or lock_check_conflict reading state. ' +
        'Each reaped lock gets an auto-generated note recording that it was reaped for inactivity (with how long) rather than finished by its owning agent, so the done archive stays honest. ' +
        'If lock_id is given but that lock is NOT actually stale, this errors rather than reaping it — reap cannot be used as a workaround to force-finish someone else\'s live work. A supplied stale_minutes may only LENGTHEN the window; it is floored at the default, so it cannot shorten the way to a live lock. ' +
        'Pass dry_run: true to see what WOULD be reaped without writing anything.',
      inputSchema: {
        lock_id: z.string().optional().describe('Reap only this lock id. Omit to reap every currently-stale active lock.'),
        stale_minutes: z
          .number()
          .positive()
          .optional()
          .describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        dry_run: z.boolean().optional().describe('If true, report what would be reaped without actually mutating anything.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'Locks are reaped from that repository\'s shared .git directory. Omit to use the current working directory.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ lock_id, stale_minutes, dry_run, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await reapStaleLocks(locksRoot, { lock_id, stale_minutes, dry_run });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

// Re-exported so callers of this module (and tests) can recognize/handle
// these specific failure modes without reaching into ./lock/store or ./git.
export { NotAGitRepoError, LockNotFoundError, TaskNotFoundError, LockNotActiveError, LockNotStaleError };
