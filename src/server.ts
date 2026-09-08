/**
 * Module: builds the agent-locks McpServer instance and registers its 8
 * tools. Kept separate from index.ts (the stdio entrypoint) so tests can
 * construct a server and drive it without spawning a real subprocess.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveLocksRoot, resolveRepoRoot, NotAGitRepoError } from './git.js';
import {
  lastReapFloor,
  lastUnreadableLocks,
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
  ScopeAmendmentError,
  EmptyScopeError,
  EmptyUpdateError,
  ScopeNarrowingRefusedError,
  IncompleteTaskUpdateError,
} from './lock/store.js';
import { checkScopeDrift } from './lock/drift.js';
import { DEFAULT_STALE_MINUTES } from './lock/types.js';
import { VERSION } from './version.js';

const SERVER_NAME = 'agent-locks';
const SERVER_VERSION = VERSION;

const INSTRUCTIONS = `agent-locks: filesystem-based work-claiming locks shared across every git worktree of the current repository. No database — everything lives as markdown files under the repo's shared .git directory, so it is automatically invisible to git and never gets committed.

Recommended workflow, in order:
1. Before starting work on a set of files, call lock_query (default view, active locks only) to see what other agents are already doing, and call lock_check_conflict with the globs you're about to touch to see if anyone's active lock overlaps them. lock_check_conflict is purely informational — it never blocks you, it just gives you information to make your own judgment call with.
2. If you decide to proceed, call lock_create to claim the work: give it a title, the glob patterns describing what you're touching, and a checklist of the tasks you plan to do.
3. As you actually complete each task, call lock_update immediately — not batched at the end. The whole point of this system is that other agents can see live, current state; a lock that only gets updated right before you finish is not useful to anyone watching in the meantime. If you're doing a long stretch of work without a task boundary to check off, call lock_heartbeat periodically so your lock doesn't read as abandoned to anyone else watching.
4. Whenever the work grows past what you claimed, amend the scope in the same lock_update call: add_scope widens it (set_scope replaces it outright, which is how a lock that over-claimed gets narrowed). Do this when you notice, not at the end — lock_check_conflict matches the globs recorded RIGHT NOW, so until you amend, every file you have touched outside your scope is invisible to any other agent checking for a conflict, while your lock still reads to them as active and healthy.
5. Before you finish, call lock_check_drift. It lists the changed files in your working tree that your scope does not cover, so you are not relying on having remembered step 4.
6. When the work is COMMITTED — not merely when the edits are done — call lock_finish with a short summary. The gap between finishing edits and committing them is exactly when another agent sweeps your uncommitted work into its own commit, so releasing early leaves that window unclaimed. This moves the lock out of the active set and into the done archive, and it will no longer show up in lock_query's default view.

Why steps 4 and 5 are steps and not advice: scope going stale as the work grows is the failure mode most likely to bite you, and it is not a discipline problem. You declare scope at the moment you know LEAST about what you will touch, and work legitimately grows — a lock created for auth/** ends up spanning eight packages. Two sessions in sibling worktrees already came to independently rewrite the same files this way, each having run exactly the queries these instructions prescribe: the one that checked saw an active, healthy-looking lock whose globs did not mention any file it was about to edit. Amendments are recorded in the lock file with timestamps, never overwritten silently, and lock_create/lock_update echo the current scope back to you on every call so it stays in front of you rather than being written once and never seen again.

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
        'Returns a compact summary per lock: {id, title, status, percentComplete, scope, repository, agent_id, parent_agent_id, stale, staleForSeconds}, ' +
        'plus scope_history (the scopes this lock previously claimed, each with the timestamp it was retired) on any lock whose scope has been amended — that is what answers "was that file inside their claim at the moment I checked?". ' +
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
        // Surface unreadable locks HERE too — this is the surface agents actually use.
        // Reporting only on the CLI would leave the agent-facing path silent, which is
        // where the collision would then happen.
        // ALWAYS this shape. An earlier version returned a bare array normally and an
        // object only when a lock was unreadable — so a consumer would test the happy
        // path, ship, and break in exactly the failure case the field exists to report.
        // A conditional shape is discovered only when things are already going wrong.
        return textResult(
          JSON.stringify(
            {
              locks: results,
              unreadable_locks: lastUnreadableLocks,
              ...(lastUnreadableLocks.length > 0
                ? { warning: `${lastUnreadableLocks.length} lock file(s) could not be read and are NOT included in "locks". A claim you cannot see is a claim you will collide with.` }
                : {}),
            },
            null,
            2,
          ),
        );
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
        // A corrupt lock here reads as "no conflict", which is the most dangerous
        // possible answer from this tool — it is the check an agent runs before writing.
        // Always this shape, for the same reason as lock_query above.
        return textResult(
          JSON.stringify(
            {
              conflicts: results,
              unreadable_locks: lastUnreadableLocks,
              ...(lastUnreadableLocks.length > 0
                ? { warning: `${lastUnreadableLocks.length} lock file(s) could not be read, so this is NOT a complete conflict check.` }
                : {}),
            },
            null,
            2,
          ),
        );
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
        'parent_agent_id specifically means "the id of whatever spawned you," if you are a subagent and happen to know it. ' +
        'The result echoes back the scope it recorded, along with a prompt to keep re-deriving it: scope is not frozen at creation — amend it with lock_update\'s add_scope as the work grows, ' +
        'because lock_check_conflict matches whatever globs are recorded now, and any file outside them is invisible to every other agent looking for a conflict.',
      inputSchema: {
        title: z.string().min(1).describe('Short human-readable title for this lock.'),
        scope: z
          .array(z.string())
          .min(1)
          .describe(
            'Glob patterns describing the files/paths this lock claims. Declare your best guess now and amend it later with lock_update — ' +
              'this is the moment you know least about what you will touch, and an unamended scope silently stops covering the files the work grows into.',
          ),
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
        'Flips one task on an existing lock to done or not-done, amends the lock\'s scope, and/or appends a note — any combination, at least one required. ' +
        'Call this AS SOON as a task actually completes — not batched at the end of your work — so other agents watching lock_query see live progress. ' +
        'task_text must match an EXISTING task\'s text EXACTLY (no fuzzy/partial matching); if it does not match, this returns an error listing the lock\'s actual task texts rather than silently doing nothing. ' +
        'task_text and done are required TOGETHER, and both are optional overall, so a scope amendment or a note does not have to flip a task to be recorded. ' +
        'AMENDING SCOPE: pass add_scope to widen the claim as the work grows (the common case — scope is declared when you know least about what you will touch), or set_scope to replace it outright, which is how a lock that over-claimed gets narrowed instead of left blocking others. ' +
        'A replacement that DROPS globs takes protection away, so it is gated the same way lock_finish is: refused when the lock is held by a different, named agent, unless force:true — which is recorded on the lock. Widening is never gated. ' +
        'The two are mutually exclusive. Amendments are appended to the lock file\'s scope_history with a timestamp rather than overwriting the old value silently, so a later reader can reconstruct what this lock claimed at the moment another agent checked it. ' +
        'The result ALWAYS echoes the lock\'s current scope, amended or not, along with a prompt to re-derive it against what you are really editing — because lock_check_conflict matches these globs, and any file outside them is invisible to every other agent looking for a conflict. ' +
        'Works on a lock in either active or done status (found by lock_id regardless of which directory it currently lives in).',
      inputSchema: {
        lock_id: z.string().describe('The id of the lock to update (as returned by lock_create or lock_query).'),
        task_text: z
          .string()
          .optional()
          .describe('The exact text of an existing task on this lock. Required together with `done`; omit both if you are only amending scope or adding a note.'),
        done: z
          .boolean()
          .optional()
          .describe('true to mark the task done, false to mark it not done. Required together with `task_text`.'),
        add_scope: z
          .array(z.string())
          .optional()
          .describe(
            'Glob patterns to ADD to this lock\'s existing scope — the usual way to keep a claim honest as work grows beyond what you first declared. ' +
              'Adding a glob already claimed is a no-op and records no amendment. Mutually exclusive with `set_scope`.',
          ),
        set_scope: z
          .array(z.string())
          .optional()
          .describe(
            'REPLACE this lock\'s scope with these glob patterns. Use to narrow a lock that over-claimed, rather than leaving it blocking work it is not really doing. ' +
              'Must contain at least one non-empty pattern — an empty scope would still read as an active claim in lock_query while matching nothing in lock_check_conflict. Mutually exclusive with `add_scope`. ' +
              'Named set_scope and NOT scope deliberately: `scope` is what lock_create calls the whole claim, so copying create arguments into an update would silently REPLACE a claim you had been widening.',
          ),
        agent_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Your own agent id, if you already know it. Used ONLY to detect a narrowing of someone else\'s claim; widening never consults it, and it is never fabricated. Same honesty caveat as lock_create.',
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            'Proceed with a narrowing that would otherwise be refused because the lock is held by another session. Deliberate and RECORDED on the lock — a refusal nobody can get past becomes one everyone routes around.',
          ),
        note: z.string().optional().describe('Optional free-text note to append to the lock\'s Notes section.'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'The lock is looked up in that repository\'s shared .git directory. Omit to use the current working directory.',
          ),
      },
      // destructiveHint: `set_scope` can REPLACE a whole claim, and a narrowing
      // removes protection from files that may still be in flight — recoverable
      // only by reading scope_history. A client using this hint to decide
      // whether to confirm should be told that is possible.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ lock_id, task_text, done, note, set_scope, add_scope, agent_id, force, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const [locksRoot, repoRoot] = await Promise.all([resolveLocksRoot(cwd), resolveRepoRoot(cwd)]);
        const result = await updateLock(locksRoot, {
          lock_id,
          task_text,
          done,
          note,
          set_scope,
          add_scope,
          agent_id,
          force,
          repository: repoRoot,
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'lock_check_drift',
    {
      title: 'Check a lock for scope drift',
      description:
        'Compares what a lock CLAIMS against what your working tree has actually changed, and lists every changed file the lock\'s scope does not cover. ' +
        'Run this before you finish, and any time the work has grown beyond what you first declared — scope is set at lock_create, the moment you know least about what you will touch, so drift is the normal outcome rather than a lapse. ' +
        'Changed files come from `git status` in the working tree you are calling from (staged, unstaged, and untracked alike, with renames counting both paths) PLUS every file touched by a commit made since the lock was claimed — committing as you go is how a branch normally grows, and `git status` alone cannot see it. ' +
        'Coverage is decided by the exact same glob matcher lock_check_conflict uses, so a file this reports as out of scope is precisely a file another agent\'s conflict check would NOT surface your lock for. ' +
        'Purely informational and read-only: it never amends anything. Fix what it reports with lock_update\'s add_scope. ' +
        'WHAT IT CANNOT SEE, so you do not read a clean result for more than it is worth: files git ignores (the count is reported, their drift is not knowable here); ' +
        'work committed BEFORE the lock was claimed; anything outside this working tree; and submodule contents. ' +
        'If nothing changed at all, nothing was compared — that is reported as outcome "NOTHING_MEASURED", which is NOT the same as "your scope is right". ' +
        'Prefer `outcome` over `drifted`: the boolean cannot tell "the scope covers the work" from "nothing was measured". ' +
        'Returns {lock_id, title, scope, inspectedWorktree, lockCreatedIn, changedFileCount, uncommittedCount, committedSinceClaimCount, ignoredFilesNotExamined, inScopeCount, outOfScope, outOfScopeCount, outOfScopeTruncated, outcome, drifted, warnings, scopeCheck}. ' +
        'READ THE WARNINGS: drift is only meaningful for your OWN lock in your OWN worktree, and running it against a lock created elsewhere compares that lock\'s scope to files its owner is not editing — a clean result there means nothing.',
      inputSchema: {
        lock_id: z.string().describe('The id of the lock to check (as returned by lock_create or lock_query).'),
        base_dir: z
          .string()
          .optional()
          .describe(
            'Target a different repository by its working-tree path (or any path inside it). ' +
              'Both the lock lookup AND the `git status` that supplies the changed files come from there instead of the current working directory.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ lock_id, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await checkScopeDrift(locksRoot, { lock_id, cwd });
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
        agent_id: z
          .string()
          .optional()
          .describe(
            'Your own agent id. Supply it so ownership can be checked: finishing a lock held by a DIFFERENT session is refused unless force is set. Omit it and no check is possible.',
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            'Deliberately finish a lock held by someone else. Required when both identities are known and differ; the fact is recorded in the archived lock.',
          ),
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
    async ({ lock_id, summary, agent_id, force, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        // Identity must reach the store here too, or the check is decorative on the
        // surface agents actually use.
        const result = await finishLock(locksRoot, { lock_id, summary, agent_id, force });
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
        // The floor must be reported HERE too. A CLI-only version left the surface
        // agents actually use claiming nothing was stale, when locks were stale by the
        // requested threshold and merely protected.
        return textResult(JSON.stringify({ reaped: result, floor: lastReapFloor }, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

// Re-exported so callers of this module (and tests) can recognize/handle
// these specific failure modes without reaching into ./lock/store or ./git.
export {
  NotAGitRepoError,
  LockNotFoundError,
  TaskNotFoundError,
  LockNotActiveError,
  LockNotStaleError,
  ScopeAmendmentError,
  EmptyScopeError,
  EmptyUpdateError,
  IncompleteTaskUpdateError,
  ScopeNarrowingRefusedError,
};
