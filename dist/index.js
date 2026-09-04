#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// src/git.ts
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { promisify } from "util";
import path from "path";
var execFileAsync = promisify(execFile);
var NotAGitRepoError = class extends Error {
  constructor(cwd, cause) {
    super(
      `agent-locks: "${cwd}" does not appear to be inside a git repository (git rev-parse --git-common-dir failed). agent-locks requires a git repository because locks are stored under the repo's shared .git directory. Original error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "NotAGitRepoError";
  }
};
async function resolveLocksRoot(cwd = process.cwd()) {
  const realGitCommonDir = await getRealGitCommonDir(cwd);
  return path.join(realGitCommonDir, "agents-locks");
}
async function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch (error) {
    throw new NotAGitRepoError(cwd, error);
  }
}
async function getRealGitCommonDir(cwd) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd }));
  } catch (error) {
    throw new NotAGitRepoError(cwd, error);
  }
  const gitCommonDir = stdout.trim();
  const absoluteGitCommonDir = path.resolve(cwd, gitCommonDir);
  const realGitCommonDir = await fs.realpath(absoluteGitCommonDir);
  return realGitCommonDir;
}

// src/lock/store.ts
import { promises as fs2 } from "fs";
import path2 from "path";

// src/timestamp.ts
function formatTimestamp(date = /* @__PURE__ */ new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}
var TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;
function parseTimestamp(value) {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) {
    throw new Error(`agent-locks: "${value}" is not a valid agent-locks timestamp (expected YYYY-MM-DDTHH-MM-SS).`);
  }
  const [, year, month, day, hours, minutes, seconds] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds))
  );
}
function slugify(title) {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

// src/lock/markdown.ts
import matter from "gray-matter";
var NOTES_HEADING = "## Notes";
var TASK_LINE_RE = /^- \[([ xX])\] (.*)$/;
var TITLE_LINE_RE = /^# (.*)$/;
function parseBody(content) {
  const lines = content.split(/\r?\n/);
  let title = "";
  const tasks = [];
  const notes = [];
  let section = "title";
  for (const line of lines) {
    if (section === "title") {
      const titleMatch = TITLE_LINE_RE.exec(line);
      if (titleMatch) {
        title = titleMatch[1].trim();
        section = "tasks";
        continue;
      }
      continue;
    }
    if (line.trim() === NOTES_HEADING) {
      section = "notes";
      continue;
    }
    if (section === "tasks") {
      const taskMatch = TASK_LINE_RE.exec(line);
      if (taskMatch) {
        tasks.push({ done: taskMatch[1].toLowerCase() === "x", text: taskMatch[2].trim() });
      }
      continue;
    }
    if (section === "notes") {
      if (line.startsWith("- ")) {
        notes.push(line.slice(2).trim());
      }
    }
  }
  return { title, tasks, notes };
}
function serializeBody(body) {
  const lines = [`# ${body.title}`, ""];
  for (const task of body.tasks) {
    lines.push(`- [${task.done ? "x" : " "}] ${task.text}`);
  }
  lines.push("", NOTES_HEADING);
  for (const note of body.notes) {
    lines.push(`- ${note}`);
  }
  return lines.join("\n") + "\n";
}
function parseLockFile(raw) {
  const { data, content } = matter(raw);
  const frontmatter = data;
  const body = parseBody(content);
  return {
    frontmatter,
    title: body.title,
    tasks: body.tasks,
    notes: body.notes
  };
}
function serializeLockFile(parsed) {
  const body = serializeBody({ title: parsed.title, tasks: parsed.tasks, notes: parsed.notes });
  return matter.stringify(body, parsed.frontmatter);
}

// src/lock/globOverlap.ts
import { minimatch } from "minimatch";
var SPECIAL_CHARS = /* @__PURE__ */ new Set(["*", "?", "[", "]", "{", "}", "(", ")", "!"]);
function staticPrefix(pattern) {
  let end = pattern.length;
  for (let i = 0; i < pattern.length; i++) {
    if (SPECIAL_CHARS.has(pattern[i])) {
      end = i;
      break;
    }
  }
  return pattern.slice(0, end);
}
function patternsOverlap(a, b) {
  if (a === b) return true;
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) {
    return true;
  }
  if (minimatch(a, b, { dot: true }) || minimatch(b, a, { dot: true })) {
    return true;
  }
  return false;
}
function scopesOverlap(a, b) {
  for (const patternA of a) {
    for (const patternB of b) {
      if (patternsOverlap(patternA, patternB)) return true;
    }
  }
  return false;
}

// src/lock/types.ts
var DEFAULT_STALE_MINUTES = 60;
function computePercentComplete(tasks) {
  if (tasks.length === 0) return 100;
  const done = tasks.filter((t) => t.done).length;
  return Math.round(done / tasks.length * 100);
}
function toSummary(record, options = {}) {
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const now = options.now ?? /* @__PURE__ */ new Date();
  const updatedAt = parseTimestamp(record.frontmatter.updated);
  const staleForMs = Math.max(0, now.getTime() - updatedAt.getTime());
  const staleForSeconds = Math.round(staleForMs / 1e3);
  const stale = record.frontmatter.status === "active" && staleForMs > staleMinutes * 6e4;
  return {
    id: record.frontmatter.id,
    title: record.title,
    status: record.frontmatter.status,
    percentComplete: computePercentComplete(record.tasks),
    scope: record.frontmatter.scope,
    repository: record.frontmatter.repository ?? "",
    agent_id: record.frontmatter.agent_id,
    parent_agent_id: record.frontmatter.parent_agent_id,
    stale,
    staleForSeconds
  };
}

// src/lock/store.ts
var DONE_SUBDIR = "done";
var STALE_MINUTES_ENV_VAR = "AGENT_LOCKS_STALE_MINUTES";
function resolveStaleMinutes(override) {
  if (override !== void 0) return override;
  const raw = process.env[STALE_MINUTES_ENV_VAR];
  if (raw === void 0) return DEFAULT_STALE_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
}
function agentMatches(stored, query) {
  if (query === null) return stored === null;
  if (stored === null) return false;
  if (stored.trim().toLowerCase() === query.trim().toLowerCase()) return true;
  const SESSION_REF = /^[0-9a-f]{4,}$/i;
  const refOf = (v) => {
    const m = /\[([^\]]+)\]\s*$/.exec(v.trim());
    if (!m) {
      const bare = v.trim();
      return SESSION_REF.test(bare) ? bare : null;
    }
    const inner = m[1].trim();
    return SESSION_REF.test(inner) ? inner : null;
  };
  const storedRef = refOf(stored);
  const queryRef = refOf(query);
  if (storedRef !== null && queryRef !== null) {
    return storedRef.toLowerCase() === queryRef.toLowerCase();
  }
  return false;
}
var LockNotFoundError = class extends Error {
  constructor(lockId) {
    super(`No lock found with id "${lockId}".`);
    this.name = "LockNotFoundError";
  }
};
var TaskNotFoundError = class extends Error {
  constructor(lockId, taskText, availableTasks) {
    super(
      `Lock "${lockId}" has no task with the exact text "${taskText}". Available tasks on this lock: ${availableTasks.length > 0 ? availableTasks.map((t) => `"${t}"`).join(", ") : "(none)"}. task_text must match an existing task exactly (this tool does not do fuzzy/partial matching).`
    );
    this.name = "TaskNotFoundError";
  }
};
var LockNotActiveError = class extends Error {
  constructor(lockId) {
    super(`Lock "${lockId}" is not active (it may already be finished), so it cannot be finished again.`);
    this.name = "LockNotActiveError";
  }
};
function activeDir(locksRoot) {
  return locksRoot;
}
function doneDir(locksRoot) {
  return path2.join(locksRoot, DONE_SUBDIR);
}
async function ensureDirs(locksRoot) {
  await fs2.mkdir(doneDir(locksRoot), { recursive: true });
}
async function listMarkdownFiles(dir) {
  let entries;
  try {
    entries = await fs2.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((name) => name.endsWith(".md")).map((name) => path2.join(dir, name));
}
async function readRecord(filePath) {
  const raw = await fs2.readFile(filePath, "utf8");
  const parsed = parseLockFile(raw);
  return { ...parsed, filePath };
}
async function writeRecord(record) {
  const contents = serializeLockFile(record);
  const dir = path2.dirname(record.filePath);
  await fs2.mkdir(dir, { recursive: true });
  const tmpPath = path2.join(dir, `.${path2.basename(record.filePath)}.${process.pid}.tmp`);
  try {
    await fs2.writeFile(tmpPath, contents, "utf8");
    await fs2.rename(tmpPath, record.filePath);
  } catch (err) {
    await fs2.rm(tmpPath, { force: true }).catch(() => {
    });
    throw err;
  }
}
var lastReapFloor = null;
var lastUnreadableLocks = [];
async function readAllRecords(locksRoot, status) {
  const dirs = [];
  if (status === "active" || status === "all") dirs.push(activeDir(locksRoot));
  if (status === "done" || status === "all") dirs.push(doneDir(locksRoot));
  const files = (await Promise.all(dirs.map(listMarkdownFiles))).flat();
  const records = [];
  const unreadable = [];
  for (const filePath of files) {
    try {
      const record = await readRecord(filePath);
      const fm = record.frontmatter;
      const missing = [];
      if (!fm) missing.push("frontmatter");
      else {
        const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
        const isStamp = (v) => typeof v === "string" && STAMP.test(v.trim());
        if (typeof fm.id !== "string") missing.push("id");
        if (!isStamp(fm.created)) missing.push("created");
        if (!isStamp(fm.updated)) missing.push("updated");
        if (fm.status !== "active" && fm.status !== "done") missing.push("status");
        if (!Array.isArray(fm.scope)) missing.push("scope");
      }
      if (missing.length > 0) {
        unreadable.push({ filePath, reason: `malformed lock: missing or invalid ${missing.join(", ")}` });
        continue;
      }
      records.push(record);
    } catch (err) {
      unreadable.push({ filePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  lastUnreadableLocks = unreadable;
  return records;
}
async function findRecordById(locksRoot, lockId) {
  for (const dir of [activeDir(locksRoot), doneDir(locksRoot)]) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const record = await readRecord(filePath);
      if (record.frontmatter.id === lockId) return record;
    }
  }
  return null;
}
async function uniqueFilePath(dir, timestamp, slug) {
  let suffix = 0;
  for (; ; ) {
    const candidateId = suffix === 0 ? `${timestamp}-${slug}` : `${timestamp}-${slug}-${suffix + 1}`;
    const filePath = path2.join(dir, `${candidateId}.md`);
    try {
      await fs2.access(filePath);
      suffix += 1;
    } catch {
      return { filePath, id: candidateId };
    }
  }
}
async function createLock(locksRoot, params) {
  await ensureDirs(locksRoot);
  const now = formatTimestamp();
  const slug = slugify(params.title);
  const { filePath, id } = await uniqueFilePath(activeDir(locksRoot), now, slug);
  const frontmatter = {
    id,
    agent_id: params.agent_id ?? null,
    parent_agent_id: params.parent_agent_id ?? null,
    status: "active",
    created: now,
    updated: now,
    scope: params.scope,
    repository: params.repository ?? ""
  };
  const record = {
    filePath,
    frontmatter,
    title: params.title,
    tasks: params.tasks.map((text) => ({ text, done: false })),
    notes: []
  };
  await writeRecord(record);
  return { id, filePath };
}
async function queryLocks(locksRoot, params) {
  const status = params.status ?? "active";
  const records = await readAllRecords(locksRoot, status);
  const scopeFilter = params.scope === void 0 ? void 0 : [].concat(params.scope);
  const textFilter = params.text?.trim().toLowerCase();
  const filtered = records.filter((record) => {
    if (params.agent_id !== void 0 && !agentMatches(record.frontmatter.agent_id, params.agent_id)) {
      return false;
    }
    if (scopeFilter && !scopesOverlap(scopeFilter, record.frontmatter.scope)) {
      return false;
    }
    if (textFilter) {
      const haystack = [record.title, ...record.notes].join("\n").toLowerCase();
      if (!haystack.includes(textFilter)) return false;
    }
    return true;
  });
  const staleMinutes = resolveStaleMinutes(params.stale_minutes);
  return filtered.map((record) => toSummary(record, { staleMinutes }));
}
async function checkConflicts(locksRoot, scope, staleMinutesOverride) {
  const records = await readAllRecords(locksRoot, "active");
  const conflicting = records.filter((record) => scopesOverlap(scope, record.frontmatter.scope));
  const staleMinutes = resolveStaleMinutes(staleMinutesOverride);
  return conflicting.map((record) => toSummary(record, { staleMinutes }));
}
async function updateLock(locksRoot, params) {
  const record = await findRecordById(locksRoot, params.lock_id);
  if (!record) throw new LockNotFoundError(params.lock_id);
  const task = record.tasks.find((t) => t.text === params.task_text);
  if (!task) {
    throw new TaskNotFoundError(
      params.lock_id,
      params.task_text,
      record.tasks.map((t) => t.text)
    );
  }
  task.done = params.done;
  if (params.note) {
    record.notes.push(params.note);
  }
  record.frontmatter.updated = formatTimestamp();
  await writeRecord(record);
  return { id: record.frontmatter.id, percentComplete: computePercentComplete(record.tasks) };
}
async function finishLock(locksRoot, params) {
  await ensureDirs(locksRoot);
  const activeFiles = await listMarkdownFiles(activeDir(locksRoot));
  let record = null;
  for (const filePath of activeFiles) {
    const candidate = await readRecord(filePath);
    if (candidate.frontmatter.id === params.lock_id) {
      record = candidate;
      break;
    }
  }
  if (!record) {
    const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
    for (const filePath of doneFiles) {
      const candidate = await readRecord(filePath);
      if (candidate.frontmatter.id === params.lock_id) {
        throw new LockNotActiveError(params.lock_id);
      }
    }
    throw new LockNotFoundError(params.lock_id);
  }
  if (params.summary) {
    record.notes.push(params.summary);
  }
  record.frontmatter.status = "done";
  record.frontmatter.updated = formatTimestamp();
  const newFilePath = path2.join(doneDir(locksRoot), path2.basename(record.filePath));
  const oldFilePath = record.filePath;
  record.filePath = newFilePath;
  await writeRecord(record);
  await fs2.unlink(oldFilePath);
  return { id: record.frontmatter.id, filePath: newFilePath };
}
async function heartbeatLock(locksRoot, params) {
  const activeFiles = await listMarkdownFiles(activeDir(locksRoot));
  for (const filePath of activeFiles) {
    const record = await readRecord(filePath);
    if (record.frontmatter.id === params.lock_id) {
      record.frontmatter.updated = formatTimestamp();
      await writeRecord(record);
      return { id: record.frontmatter.id, updated: record.frontmatter.updated };
    }
  }
  const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
  for (const filePath of doneFiles) {
    const candidate = await readRecord(filePath);
    if (candidate.frontmatter.id === params.lock_id) {
      throw new LockNotActiveError(params.lock_id);
    }
  }
  throw new LockNotFoundError(params.lock_id);
}
var LockNotStaleError = class extends Error {
  constructor(lockId, staleForSeconds, staleMinutes) {
    super(
      `Lock "${lockId}" is not stale (last updated ${staleForSeconds}s ago; the threshold is ${staleMinutes} minute(s)). Refusing to reap a lock that isn't actually stale \u2014 reap is for cleaning up abandoned work, not an alternate way to call lock_finish.`
    );
    this.name = "LockNotStaleError";
  }
};
async function reapStaleLocks(locksRoot, params = {}) {
  const requested = resolveStaleMinutes(params.stale_minutes);
  const floor = resolveStaleMinutes(void 0);
  const staleMinutes = Math.max(requested, floor);
  lastReapFloor = staleMinutes === requested ? null : { requested, applied: staleMinutes };
  const now = /* @__PURE__ */ new Date();
  const activeRecords = await readAllRecords(locksRoot, "active");
  const candidates = activeRecords.filter((record) => {
    if (params.lock_id !== void 0 && record.frontmatter.id !== params.lock_id) return false;
    return toSummary(record, { staleMinutes, now }).stale;
  });
  if (params.lock_id !== void 0 && candidates.length === 0) {
    const match = activeRecords.find((record) => record.frontmatter.id === params.lock_id);
    if (match) {
      const summary = toSummary(match, { staleMinutes, now });
      throw new LockNotStaleError(params.lock_id, summary.staleForSeconds, staleMinutes);
    }
    const doneFiles = await listMarkdownFiles(doneDir(locksRoot));
    for (const filePath of doneFiles) {
      const candidate = await readRecord(filePath);
      if (candidate.frontmatter.id === params.lock_id) throw new LockNotActiveError(params.lock_id);
    }
    throw new LockNotFoundError(params.lock_id);
  }
  const reaped = [];
  for (const record of candidates) {
    const summary = toSummary(record, { staleMinutes, now });
    reaped.push({ id: record.frontmatter.id, title: record.title, staleForSeconds: summary.staleForSeconds });
    if (params.dry_run) continue;
    record.notes.push(
      `Auto-reaped: last touched ${record.frontmatter.updated} (UTC), no activity for ${Math.round(summary.staleForSeconds / 60)} minute(s), threshold ${staleMinutes} minute(s).`
    );
    record.frontmatter.status = "done";
    record.frontmatter.updated = formatTimestamp();
    const newFilePath = path2.join(doneDir(locksRoot), path2.basename(record.filePath));
    const oldFilePath = record.filePath;
    record.filePath = newFilePath;
    await ensureDirs(locksRoot);
    await writeRecord(record);
    await fs2.unlink(oldFilePath);
  }
  return reaped;
}

// src/server.ts
var SERVER_NAME = "agent-locks";
var SERVER_VERSION = "0.1.0";
var INSTRUCTIONS = `agent-locks: filesystem-based work-claiming locks shared across every git worktree of the current repository. No database \u2014 everything lives as markdown files under the repo's shared .git directory, so it is automatically invisible to git and never gets committed.

Recommended workflow, in order:
1. Before starting work on a set of files, call lock_query (default view, active locks only) to see what other agents are already doing, and call lock_check_conflict with the globs you're about to touch to see if anyone's active lock overlaps them. lock_check_conflict is purely informational \u2014 it never blocks you, it just gives you information to make your own judgment call with.
2. If you decide to proceed, call lock_create to claim the work: give it a title, the glob patterns describing what you're touching, and a checklist of the tasks you plan to do.
3. As you actually complete each task, call lock_update immediately \u2014 not batched at the end. The whole point of this system is that other agents can see live, current state; a lock that only gets updated right before you finish is not useful to anyone watching in the meantime. If you're doing a long stretch of work without a task boundary to check off, call lock_heartbeat periodically so your lock doesn't read as abandoned to anyone else watching.
4. When the work is COMMITTED \u2014 not merely when the edits are done \u2014 call lock_finish with a short summary. The gap between finishing edits and committing them is exactly when another agent sweeps your uncommitted work into its own commit, so releasing early leaves that window unclaimed. This moves the lock out of the active set and into the done archive, and it will no longer show up in lock_query's default view.

Working in a different repository than the one you are rooted in: every tool accepts an optional base_dir \u2014 any path inside the target repository. Locks then resolve from THAT repository's shared .git rather than from the current working directory. Use it whenever you are about to write into another repo: a lock created where you happen to be standing, instead of where you are writing, is invisible to the one agent who needed to see it. A base_dir that is not inside a git repository is a hard error, never a silent fallback to the current directory.

Staleness: every lock returned by lock_query / lock_check_conflict carries a computed \`stale\` flag (and \`staleForSeconds\`) \u2014 true when an ACTIVE lock hasn't been touched (create, lock_update, or lock_heartbeat) in over ${DEFAULT_STALE_MINUTES} minutes (configurable via the AGENT_LOCKS_STALE_MINUTES environment variable, or per-call). This is informational, exactly like lock_check_conflict \u2014 nothing is ever cleaned up as a side effect of reading. If you see a stale lock that's blocking your own work, call lock_reap on it explicitly; it will refuse (with a clear error) if the lock turns out not to actually be stale by the time you call it, so it can't be used as a workaround to force-finish someone else's live work. A supplied stale_minutes may only LENGTHEN the window (it is floored at the default), so a small value cannot be used to reap live locks.

Honesty note on agent identity: this server cannot detect your agent id or your parent agent's id automatically \u2014 no MCP transport mechanism exposes that. Pass agent_id/parent_agent_id to lock_create only if you already know them from your own context (e.g. an orchestration harness gave you an explicit id); otherwise omit them and they will be recorded as null. Do not guess or fabricate an id.`;
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}
function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );
  server.registerTool(
    "lock_query",
    {
      title: "Query locks",
      description: `Lists agent-locks work-claim locks for the current git repository (shared across all its worktrees). IMPORTANT: when \`status\` is omitted, this ONLY returns active locks \u2014 done/finished locks are excluded from the default view by design, so you see what is currently being worked on, not a full history. Pass status: "done" or status: "all" to include finished locks. Returns a compact summary per lock: {id, title, status, percentComplete, scope, agent_id, parent_agent_id, stale, staleForSeconds}. percentComplete is computed from the ratio of checked to total tasks on that lock (a lock with zero tasks reports 100). stale is true for an ACTIVE lock not touched in over stale_minutes (default ${DEFAULT_STALE_MINUTES}) \u2014 computed fresh on every call, never mutates anything; done locks are never stale.`,
      inputSchema: {
        status: z.enum(["active", "done", "all"]).optional().describe('Which locks to include. Defaults to "active" (done locks are excluded unless you explicitly ask for them).'),
        scope: z.union([z.string(), z.array(z.string())]).optional().describe(
          "One or more glob patterns. Only locks whose own scope glob-overlaps at least one of these patterns are returned. Uses the same overlap heuristic as lock_check_conflict (see that tool's description for its limitations)."
        ),
        agent_id: z.string().optional().describe("Only return locks created with this exact agent_id."),
        text: z.string().optional().describe("Free-text, case-insensitive substring search across each lock's title and its Notes section."),
        stale_minutes: z.number().positive().optional().describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). Locks are resolved from that repository's shared .git directory instead of the current working directory. Fails with a clear error if this path is not inside a git repository."
        )
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ status, scope, agent_id, text, stale_minutes, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const results = await queryLocks(locksRoot, { status, scope, agent_id, text, stale_minutes });
        const payload = lastUnreadableLocks.length > 0 ? {
          locks: results,
          unreadable_locks: lastUnreadableLocks,
          warning: `${lastUnreadableLocks.length} lock file(s) could not be read and are NOT included. A claim you cannot see is a claim you will collide with.`
        } : results;
        return textResult(JSON.stringify(payload, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "lock_check_conflict",
    {
      title: "Check for scope conflicts",
      description: "Checks whether any currently ACTIVE lock claims file(s)/path(s) that overlap the glob patterns you pass in. This tool is purely INFORMATIONAL \u2014 it never blocks, refuses, or vetoes anything; it has no side effects and cannot prevent lock_create from proceeding. It exists only to give you information so you (the calling agent) can decide for yourself whether to proceed, coordinate with the other lock's owner, or pick a narrower scope. Overlap is determined by a static-prefix glob heuristic (not exact set intersection) that is intentionally biased toward reporting overlaps that turn out not to matter, rather than missing a real one \u2014 see this project's README for the exact heuristic and a documented case (filesystem case-sensitivity) it deliberately does not catch. Returns the same compact summary shape as lock_query (including stale/staleForSeconds) for every overlapping active lock (empty array if none).",
      inputSchema: {
        scope: z.array(z.string()).describe("Glob patterns describing the files/paths you are about to work on."),
        stale_minutes: z.number().positive().optional().describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). Conflicts are checked against locks in that repository's shared .git directory instead of the current working directory."
        )
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
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
    }
  );
  server.registerTool(
    "lock_create",
    {
      title: "Create a lock",
      description: 'Claims a piece of work by writing a new active lock file. Use this after you have decided to proceed (optionally having checked lock_query / lock_check_conflict first). tasks are created as a plain unchecked checklist; call lock_update as you complete each one. agent_id / parent_agent_id: pass your OWN id here only if you already know it from your own context (some orchestration harnesses hand a subagent an explicit id when dispatching it) \u2014 this server has no way to detect either value automatically (no MCP transport mechanism exposes a session/agent id to a stdio server subprocess). Omit them (or pass null) if you do not know them; they will be recorded as null, never fabricated. parent_agent_id specifically means "the id of whatever spawned you," if you are a subagent and happen to know it.',
      inputSchema: {
        title: z.string().min(1).describe("Short human-readable title for this lock."),
        scope: z.array(z.string()).min(1).describe("Glob patterns describing the files/paths this lock claims."),
        tasks: z.array(z.string()).describe("Plain-text descriptions of the tasks you plan to do. All are created unchecked."),
        agent_id: z.string().nullable().optional().describe("Your own agent id, ONLY if you already know it from your context. Omit or pass null otherwise \u2014 never guess."),
        parent_agent_id: z.string().nullable().optional().describe("The id of whatever spawned you, ONLY if you already know it. Omit or pass null otherwise \u2014 never guess."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is created in that repository's shared .git directory instead of the current working directory. Use this when an agent working in one repo needs to claim work in another \u2014 a lock the colliding agent cannot see is decorative."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ title, scope, tasks, agent_id, parent_agent_id, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const [locksRoot, repoRoot] = await Promise.all([
          resolveLocksRoot(cwd),
          resolveRepoRoot(cwd)
        ]);
        const result = await createLock(locksRoot, { title, scope, tasks, agent_id, parent_agent_id, repository: repoRoot });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "lock_update",
    {
      title: "Update a lock",
      description: "Flips one task on an existing lock to done or not-done, and optionally appends a note. Call this AS SOON as a task actually completes \u2014 not batched at the end of your work \u2014 so other agents watching lock_query see live progress. task_text must match an EXISTING task's text EXACTLY (no fuzzy/partial matching); if it does not match, this returns an error listing the lock's actual task texts rather than silently doing nothing. Works on a lock in either active or done status (found by lock_id regardless of which directory it currently lives in).",
      inputSchema: {
        lock_id: z.string().describe("The id of the lock to update (as returned by lock_create or lock_query)."),
        task_text: z.string().describe("The exact text of an existing task on this lock."),
        done: z.boolean().describe("true to mark the task done, false to mark it not done."),
        note: z.string().optional().describe("Optional free-text note to append to the lock's Notes section."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is looked up in that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    }
  );
  server.registerTool(
    "lock_finish",
    {
      title: "Finish a lock",
      description: "Marks an active lock as done, optionally appending a closing summary to its Notes, and moves its file from the active set into the done archive. Once finished, the lock stops appearing in lock_query's default (status-omitted) view. Errors clearly if lock_id does not exist, or if it exists but is already done (rather than silently no-op-ing).",
      inputSchema: {
        lock_id: z.string().describe("The id of the active lock to finish."),
        summary: z.string().optional().describe("Optional closing summary appended to the Notes section before the lock is archived."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is looked up in that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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
    }
  );
  server.registerTool(
    "lock_heartbeat",
    {
      title: "Heartbeat a lock",
      description: "Bumps ONLY a lock's updated timestamp \u2014 no task, note, or scope change. Call this periodically during a long stretch of work that isn't naturally hitting lock_update often enough (completing a task also counts as a heartbeat for free) to keep the lock from being computed as stale by lock_query / lock_check_conflict. Restricted to active locks \u2014 errors clearly if lock_id does not exist, or exists but is already done (heartbeating finished work is not a meaningful operation).",
      inputSchema: {
        lock_id: z.string().describe("The id of the active lock to heartbeat."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is looked up in that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    }
  );
  server.registerTool(
    "lock_reap",
    {
      title: "Reap stale lock(s)",
      description: "Finishes (moves to the done archive, same mechanism as lock_finish) every ACTIVE lock currently computed as stale, or a single specific one if lock_id is given. This is an explicit, deliberate mutation \u2014 never a side effect of lock_query or lock_check_conflict reading state. Each reaped lock gets an auto-generated note recording that it was reaped for inactivity (with how long) rather than finished by its owning agent, so the done archive stays honest. If lock_id is given but that lock is NOT actually stale, this errors rather than reaping it \u2014 reap cannot be used as a workaround to force-finish someone else's live work. A supplied stale_minutes may only LENGTHEN the window; it is floored at the default, so it cannot shorten the way to a live lock. Pass dry_run: true to see what WOULD be reaped without writing anything.",
      inputSchema: {
        lock_id: z.string().optional().describe("Reap only this lock id. Omit to reap every currently-stale active lock."),
        stale_minutes: z.number().positive().optional().describe(`Override the staleness threshold (minutes) for this call only. Defaults to AGENT_LOCKS_STALE_MINUTES or ${DEFAULT_STALE_MINUTES}.`),
        dry_run: z.boolean().optional().describe("If true, report what would be reaped without actually mutating anything."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). Locks are reaped from that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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
    }
  );
  return server;
}

// src/cli.ts
var USAGE = `agent-locks \u2014 filesystem-based work-claiming locks for AI coding agents, shared across every git worktree of the current repository.

Usage:
  agent-locks                           Start the MCP stdio server (same as running with no args \u2014 this is what an MCP client config should use).
  agent-locks serve                     Same as above, explicit.
  agent-locks status                    Human-readable summary of active locks.
  agent-locks list [options]            List locks. See "agent-locks list --help".
  agent-locks check <scope...>          Check whether any active lock overlaps the given glob(s). Informational only \u2014 exits 0 either way.
  agent-locks claim [options]           Create a new lock. See "agent-locks claim --help".
  agent-locks update <lock-id> [options]  Mark a task done/undone on an existing lock. See "agent-locks update --help".
  agent-locks finish <lock-id> [--summary <text>]  Mark a lock done and archive it.
  agent-locks heartbeat <lock-id>        Bump a lock's updated timestamp with no other change. See "Staleness detection" in the README.
  agent-locks reap [lock-id] [options]  Finish stale lock(s). See "agent-locks reap --help".
  agent-locks --help                    Show this message.

Every subcommand talks to the exact same lock store the MCP tools use \u2014 a human running "agent-locks status" and an agent calling lock_query see identical, live state.

Every lock subcommand above (all except "serve") accepts --base-dir <path> to operate on a
different repository instead of the current directory \u2014 any path inside the target repo will
do. A --base-dir that is not inside a git repository is a hard error, never a silent fallback
to the current directory.`;
var LIST_USAGE = `agent-locks list [options]

Options:
  --status <active|done|all>   Which locks to include. Default: active.
  --scope <glob>                Only locks whose scope overlaps this glob. Repeatable.
  --agent <id>                  Only locks with this exact agent_id.
  --text <query>                Case-insensitive substring search over title + notes.
  --stale-minutes <n>           Override the staleness threshold (minutes) for this call only.
  --base-dir <path>             Resolve locks from a different repository (any path inside it).
  --json                        Print raw JSON instead of a formatted table.`;
var CLAIM_USAGE = `agent-locks claim [options]

Options:
  --title <text>        Required. Short description of the work.
  --scope <glob>         Required. Glob pattern this lock claims. Repeatable.
  --task <text>          A task to track on this lock. Repeatable; order preserved.
  --agent <id>           Your own agent id, if you have one. Never fabricated if omitted.
  --parent <id>          Your parent agent's id, if known.
  --base-dir <path>      Create the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;
var UPDATE_USAGE = `agent-locks update <lock-id> [options]

Options:
  --task <text>          Required. Must match an existing task's text exactly.
  --done                 Mark the task done (default if neither --done nor --undone given).
  --undone               Mark the task not done.
  --note <text>           Append a free-text note to the lock.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;
var REAP_USAGE = `agent-locks reap [lock-id] [options]

Reaps (finishes, same as "agent-locks finish") every currently-stale active lock, or a
single one if lock-id is given. Refuses to reap a named lock-id that isn't actually
stale \u2014 never a back door to force-finish someone else's live work.
A supplied --stale-minutes may only LENGTHEN the window, never shorten it: it is
floored at the configured default, so this cannot be used to reap live locks.

Options:
  --stale-minutes <n>    Override the staleness threshold for this call only. Defaults
                          to AGENT_LOCKS_STALE_MINUTES or 60.
  --dry-run              Report what would be reaped without writing anything.
  --base-dir <path>      Reap locks in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;
var CliUsageError = class extends Error {
};
var CLI_PREFIX = "agent-locks: ";
function printError(message) {
  console.error(message.startsWith(CLI_PREFIX) ? message : `${CLI_PREFIX}${message}`);
}
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["--json", "--done", "--undone", "--help", "--dry-run"]);
function parseArgs(argv) {
  const positionals = [];
  const flags = /* @__PURE__ */ new Map();
  const boolFlags = /* @__PURE__ */ new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      boolFlags.add(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new CliUsageError(`Flag ${arg} requires a value.`);
    }
    const existing = flags.get(arg) ?? [];
    existing.push(value);
    flags.set(arg, existing);
    i += 1;
  }
  return { positionals, flags, boolFlags };
}
function oneOf(flags, name) {
  const values = flags.get(name);
  if (values === void 0) return void 0;
  return values[values.length - 1];
}
function allOf(flags, name) {
  return flags.get(name) ?? [];
}
function warnUnreadable() {
  if (lastUnreadableLocks.length === 0) return;
  console.error(
    `WARNING: ${lastUnreadableLocks.length} lock file(s) could not be read and are NOT included below. A claim you cannot see is a claim you will collide with.`
  );
  for (const bad of lastUnreadableLocks) {
    console.error(`  ${bad.filePath}: ${bad.reason}`);
  }
}
function formatStaleForSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
function formatLockTable(locks) {
  warnUnreadable();
  if (locks.length === 0) return "(no locks)";
  const rows = locks.map((lock) => [
    lock.id,
    lock.status,
    `${lock.percentComplete}%`,
    lock.status === "active" ? lock.stale ? `yes (${formatStaleForSeconds(lock.staleForSeconds)})` : "no" : "-",
    lock.agent_id ?? "(unknown agent)",
    lock.scope.join(", "),
    lock.title
  ]);
  const header = ["ID", "STATUS", "DONE", "STALE", "AGENT", "SCOPE", "TITLE"];
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const formatRow = (row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ");
  return [formatRow(header), formatRow(header.map((h) => "-".repeat(h.length))), ...rows.map(formatRow)].join("\n");
}
function parseStaleMinutesFlag(flags) {
  const raw = oneOf(flags.flags, "--stale-minutes");
  if (raw === void 0) return void 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`--stale-minutes must be a positive number (got "${raw}").`);
  }
  return parsed;
}
function resolveBaseDir(flags) {
  const raw = oneOf(flags.flags, "--base-dir");
  return raw ?? process.cwd();
}
async function cmdStatus(flags) {
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const locks = await queryLocks(locksRoot, {});
  console.log(`agent-locks: ${locks.length} active lock(s) in ${locksRoot}
`);
  console.log(formatLockTable(locks));
}
async function cmdList(flags) {
  if (flags.boolFlags.has("--help")) {
    console.log(LIST_USAGE);
    return;
  }
  const status = oneOf(flags.flags, "--status");
  if (status !== void 0 && !["active", "done", "all"].includes(status)) {
    throw new CliUsageError(`--status must be one of active, done, all (got "${status}").`);
  }
  const scope = allOf(flags.flags, "--scope");
  const agent_id = oneOf(flags.flags, "--agent");
  const text = oneOf(flags.flags, "--text");
  const stale_minutes = parseStaleMinutesFlag(flags);
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const locks = await queryLocks(locksRoot, {
    status,
    scope: scope.length > 0 ? scope : void 0,
    agent_id,
    text,
    stale_minutes
  });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(locks, null, 2));
  } else {
    console.log(formatLockTable(locks));
  }
}
async function cmdCheck(flags) {
  const scope = flags.positionals;
  if (scope.length === 0) {
    throw new CliUsageError('agent-locks check requires at least one scope glob, e.g. "agent-locks check src/auth/**".');
  }
  const stale_minutes = parseStaleMinutesFlag(flags);
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const conflicts = await checkConflicts(locksRoot, scope, stale_minutes);
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
  if (conflicts.length === 0) {
    warnUnreadable();
    console.log(`No active locks overlap ${scope.join(", ")}.`);
    return;
  }
  console.log(`${conflicts.length} active lock(s) overlap ${scope.join(", ")} \u2014 informational only, nothing is blocked:
`);
  console.log(formatLockTable(conflicts));
}
async function cmdClaim(flags) {
  if (flags.boolFlags.has("--help")) {
    console.log(CLAIM_USAGE);
    return;
  }
  const title = oneOf(flags.flags, "--title");
  if (!title) throw new CliUsageError('agent-locks claim requires --title. See "agent-locks claim --help".');
  const scope = allOf(flags.flags, "--scope");
  if (scope.length === 0) throw new CliUsageError('agent-locks claim requires at least one --scope. See "agent-locks claim --help".');
  const tasks = allOf(flags.flags, "--task");
  const agent_id = oneOf(flags.flags, "--agent") ?? null;
  const parent_agent_id = oneOf(flags.flags, "--parent") ?? null;
  const cwd = resolveBaseDir(flags);
  const [locksRoot, repoRoot] = await Promise.all([
    resolveLocksRoot(cwd),
    resolveRepoRoot(cwd)
  ]);
  const result = await createLock(locksRoot, { title, scope, tasks, agent_id, parent_agent_id, repository: repoRoot });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Claimed "${title}" as lock ${result.id}`);
  }
}
async function cmdUpdate(flags) {
  if (flags.boolFlags.has("--help")) {
    console.log(UPDATE_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks update requires a lock id as its first argument. See "agent-locks update --help".');
  const taskText = oneOf(flags.flags, "--task");
  if (!taskText) throw new CliUsageError('agent-locks update requires --task. See "agent-locks update --help".');
  if (flags.boolFlags.has("--done") && flags.boolFlags.has("--undone")) {
    throw new CliUsageError("Pass at most one of --done / --undone.");
  }
  const done = !flags.boolFlags.has("--undone");
  const note = oneOf(flags.flags, "--note");
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await updateLock(locksRoot, { lock_id: lockId, task_text: taskText, done, note });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id}: "${taskText}" marked ${done ? "done" : "not done"} (${result.percentComplete}% complete overall).`);
  }
}
async function cmdFinish(flags) {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError("agent-locks finish requires a lock id as its first argument.");
  const summary = oneOf(flags.flags, "--summary");
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await finishLock(locksRoot, { lock_id: lockId, summary });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id} finished and archived.`);
  }
}
async function cmdHeartbeat(flags) {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError("agent-locks heartbeat requires a lock id as its first argument.");
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await heartbeatLock(locksRoot, { lock_id: lockId });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Lock ${result.id} heartbeat sent (updated: ${result.updated}).`);
  }
}
async function cmdReap(flags) {
  if (flags.boolFlags.has("--help")) {
    console.log(REAP_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  const stale_minutes = parseStaleMinutesFlag(flags);
  const dry_run = flags.boolFlags.has("--dry-run");
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const reaped = await reapStaleLocks(locksRoot, { lock_id: lockId, stale_minutes, dry_run });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify({ reaped, floor: lastReapFloor }, null, 2));
    return;
  }
  if (lastReapFloor) {
    console.log(
      `Note: a per-call threshold may only LENGTHEN the reaping window. You asked for ${lastReapFloor.requested} minute(s); ${lastReapFloor.applied} minute(s) was used. Lower AGENT_LOCKS_STALE_MINUTES to reap more aggressively \u2014 a visible, global choice.`
    );
  }
  if (reaped.length === 0) {
    console.log(
      lastReapFloor ? `No locks reaped at the ${lastReapFloor.applied}-minute threshold that was used. Locks stale by your requested ${lastReapFloor.requested} minute(s) but not by that one were left alone.` : "No stale locks to reap."
    );
    return;
  }
  const verb = dry_run ? "Would reap" : "Reaped";
  console.log(`${verb} ${reaped.length} lock(s):`);
  for (const lock of reaped) {
    console.log(`  ${lock.id} \u2014 "${lock.title}" (stale for ${formatStaleForSeconds(lock.staleForSeconds)})`);
  }
}
async function runCli(argv) {
  const [command, ...rest] = argv;
  if (command === void 0 || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case "status":
        await cmdStatus(parseArgs(rest));
        return 0;
      case "list":
        await cmdList(parseArgs(rest));
        return 0;
      case "check":
        await cmdCheck(parseArgs(rest));
        return 0;
      case "claim":
        await cmdClaim(parseArgs(rest));
        return 0;
      case "update":
        await cmdUpdate(parseArgs(rest));
        return 0;
      case "finish":
        await cmdFinish(parseArgs(rest));
        return 0;
      case "heartbeat":
        await cmdHeartbeat(parseArgs(rest));
        return 0;
      case "reap":
        await cmdReap(parseArgs(rest));
        return 0;
      default:
        console.error(`agent-locks: unknown command "${command}".
`);
        console.error(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      printError(error.message);
      return 1;
    }
    if (error instanceof NotAGitRepoError || error instanceof LockNotFoundError || error instanceof TaskNotFoundError || error instanceof LockNotActiveError || error instanceof LockNotStaleError) {
      printError(error.message);
      return 1;
    }
    printError(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}

// src/index.ts
async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
async function main() {
  const argv = process.argv.slice(2);
  const isServerMode = argv.length === 0 || argv[0] === "serve";
  if (isServerMode) {
    await runServer();
    return;
  }
  const exitCode = await runCli(argv);
  process.exitCode = exitCode;
}
main().catch((error) => {
  process.stderr.write(`agent-locks: fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
  process.exitCode = 1;
});
