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
var SAFE_GIT_PREFIX = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
var GitCommandFailedError = class extends Error {
  constructor(command, cwd, cause) {
    super(
      `agent-locks: \`git ${command}\` failed in "${cwd}". This is NOT "not a git repository" \u2014 the repository was found, but the command could not complete, so nothing was measured and no conclusion should be drawn from an empty result. Original error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "GitCommandFailedError";
  }
};
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
async function listChangedFiles(cwd = process.cwd()) {
  return parseStatusPaths(await runStatus(cwd, []));
}
async function countIgnoredFiles(cwd = process.cwd()) {
  const stdout = await runStatus(cwd, ["--ignored=matching"]);
  let ignored = 0;
  for (const entry of stdout.split("\0")) {
    if (entry.length >= 4 && entry[0] === "!" && entry[1] === "!") ignored += 1;
  }
  return ignored;
}
async function countWorktrees(cwd = process.cwd()) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", [...SAFE_GIT_PREFIX, "worktree", "list", "--porcelain"], {
      cwd,
      maxBuffer: 8 * 1024 * 1024
    }));
  } catch (error) {
    throw new GitCommandFailedError("worktree list", cwd, error);
  }
  return stdout.split("\n").filter((line) => line.startsWith("worktree ")).length;
}
async function runStatus(cwd, extraArgs) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [...SAFE_GIT_PREFIX, "status", "--porcelain=v1", "-z", "-uall", ...extraArgs],
      {
        cwd,
        // A large working tree can exceed the 1 MB default and would otherwise
        // reject with ENOBUFS. Above this it still fails loudly (see below) —
        // it never degrades into a short list, which would read as low drift.
        maxBuffer: 64 * 1024 * 1024
      }
    );
    return stdout;
  } catch (error) {
    if (await isGitRepo(cwd)) throw new GitCommandFailedError("status", cwd, error);
    throw new NotAGitRepoError(cwd, error);
  }
}
async function isGitRepo(cwd) {
  try {
    await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}
function parseStatusPaths(stdout) {
  const fields = stdout.split("\0");
  const files = /* @__PURE__ */ new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    files.add(entry.slice(3));
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      i += 1;
      const original = fields[i];
      if (original) files.add(original);
    }
  }
  return [...files].sort();
}
async function listCommittedFilesSince(cwd, since) {
  const sinceUtc = since.toISOString();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [...SAFE_GIT_PREFIX, "log", "-z", "--name-only", "--pretty=format:", `--since=${sinceUtc}`, "HEAD"],
      { cwd, maxBuffer: 64 * 1024 * 1024 }
    ));
  } catch (error) {
    if (await hasNoCommits(cwd)) return [];
    if (await isGitRepo(cwd)) throw new GitCommandFailedError("log", cwd, error);
    throw new NotAGitRepoError(cwd, error);
  }
  const files = new Set(stdout.split("\0").filter((name) => name !== ""));
  return [...files].sort();
}
async function hasNoCommits(cwd) {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return false;
  } catch {
    return true;
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
var NO_CACHE = {};
var MalformedLockFileError = class extends Error {
  constructor(reason, filePath) {
    super(
      `agent-locks: ${filePath ? `lock file "${filePath}"` : "lock file"} is malformed and was NOT used: ${reason}. Refusing to treat it as a valid lock: a partially-written or hand-edited lock file parses into a SMALLER claim rather than an error (a truncated YAML list does not fail, it shortens), which would silently hide whatever the missing part claimed. Inspect or delete the file.`
    );
    this.name = "MalformedLockFileError";
  }
};
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function validateFrontmatter(data, filePath) {
  if (typeof data !== "object" || data === null) {
    throw new MalformedLockFileError("its YAML frontmatter is missing or is not a mapping", filePath);
  }
  const fm = data;
  if (typeof fm.id !== "string" || fm.id === "") {
    throw new MalformedLockFileError("`id` is missing or not a non-empty string", filePath);
  }
  if (fm.status !== "active" && fm.status !== "done") {
    throw new MalformedLockFileError(`\`status\` is ${JSON.stringify(fm.status)}, expected "active" or "done"`, filePath);
  }
  for (const field of ["created", "updated"]) {
    if (typeof fm[field] !== "string" || !TIMESTAMP_RE.test(fm[field])) {
      throw new MalformedLockFileError(`\`${field}\` is missing or not a YYYY-MM-DDTHH-MM-SS timestamp`, filePath);
    }
  }
  if (!isStringArray(fm.scope) || fm.scope.length === 0) {
    throw new MalformedLockFileError(
      "`scope` is missing, empty, or not a list of strings \u2014 this is the field a truncated write mutilates silently",
      filePath
    );
  }
  if (fm.scope_history !== void 0) {
    const history = fm.scope_history;
    if (!Array.isArray(history) || !history.every(
      (entry) => typeof entry === "object" && entry !== null && typeof entry.replaced_at === "string" && isStringArray(entry.scope)
    )) {
      throw new MalformedLockFileError(
        "`scope_history` is present but is not a list of {replaced_at, scope} entries",
        filePath
      );
    }
  }
  return fm;
}
function parseLockFile(raw, filePath) {
  const { data, content } = matter(raw, NO_CACHE);
  const frontmatter = validateFrontmatter(data, filePath);
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

// src/lock/scope.ts
var ScopeAmendmentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ScopeAmendmentError";
  }
};
var EmptyScopeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "EmptyScopeError";
  }
};
function normalizeScope(patterns) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === "") continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}
function scopesEqual(a, b) {
  return a.length === b.length && a.every((pattern, i) => pattern === b[i]);
}
function applyScopeAmendment(current, request) {
  const wantsReplace = request.set_scope !== void 0;
  const wantsAdd = request.add_scope !== void 0;
  if (wantsReplace && wantsAdd) {
    throw new ScopeAmendmentError(
      "Pass at most one of set_scope (replace the whole claim) / add_scope (widen the existing claim), not both. Applying them together would require guessing an order, and would produce a scope you did not ask for."
    );
  }
  if (!wantsReplace && !wantsAdd) {
    return { next: [...current], changed: false, removed: [] };
  }
  const currentNormalized = normalizeScope(current);
  let next;
  if (wantsReplace) {
    next = normalizeScope(request.set_scope);
    if (next.length === 0) {
      throw new EmptyScopeError(
        "set_scope must contain at least one non-empty glob pattern. A lock claiming nothing is worse than no lock at all: it still reads as an active claim in lock_query while matching no file in lock_check_conflict. To narrow a lock, pass the globs you are actually still touching; to give up the claim entirely, call lock_finish."
      );
    }
  } else {
    const additions = normalizeScope(request.add_scope);
    if (additions.length === 0) {
      throw new ScopeAmendmentError(
        "add_scope must contain at least one non-empty glob pattern (an empty or whitespace-only list amends nothing)."
      );
    }
    next = normalizeScope([...currentNormalized, ...additions]);
  }
  const removed = currentNormalized.filter((pattern) => !next.includes(pattern));
  return { next, changed: !scopesEqual(currentNormalized, next), removed };
}
function formatPatterns(scope) {
  if (scope.length === 0) return "(none)";
  return scope.map((pattern) => `\`${pattern}\``).join(", ");
}
function formatScopeCheck(scope, dialect = "mcp", lockId) {
  if (dialect === "mcp") {
    return `Scope claimed: ${formatPatterns(scope)}. Does this still match what you are touching? Compare it against \`git status --porcelain\` / \`git diff --name-only\`, or call lock_check_drift, which does that comparison for you. If you are writing outside this scope, amend it now with lock_update's add_scope (widen) or set_scope (replace) \u2014 lock_check_conflict matches these globs, so every file outside them is invisible to any other agent looking for a conflict.`;
  }
  const id = lockId ?? "<lock-id>";
  return `Scope claimed: ${formatPatterns(scope)}. Does this still match what you are touching? Compare it against \`git status --porcelain\` / \`git diff --name-only\`, or run \`agent-locks drift ${id}\`, which does that comparison for you. If you are writing outside this scope, amend it now with \`agent-locks update ${id} --add-scope <glob>\` (or \`--set-scope <glob>...\` to narrow an over-claim) \u2014 \`agent-locks check <glob>\` matches these globs, so every file outside them is invisible to any other agent looking for a conflict.`;
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
    ...record.frontmatter.scope_history && record.frontmatter.scope_history.length > 0 ? { scope_history: record.frontmatter.scope_history } : {},
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
  const SESSION_REF = /^(?=.*\d)[A-Za-z0-9_-]{2,}$/;
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
var LockNotOwnedError = class extends Error {
  constructor(lockId, holder, caller) {
    super(
      `Lock "${lockId}" is held by ${holder}, not by ${caller}. Refusing to finish another session's live claim \u2014 that is the failure this system exists to prevent, and finishing it silently is how uncommitted work loses its only marker. Coordinate with the holder first. If you genuinely must end their claim: --force on the CLI, or force:true via MCP. Either is allowed, and either is recorded in the archive.`
    );
    this.name = "LockNotOwnedError";
  }
};
var ScopeNarrowingRefusedError = class extends Error {
  constructor(lockId, holder, caller, removed) {
    super(
      `Lock "${lockId}" is held by ${holder}, not by ${caller}, and this update would REMOVE ${removed.map((g) => `"${g}"`).join(", ")} from its claim. Refusing: narrowing another session's live claim makes their work invisible to every conflict check while their lock still reads as active and healthy \u2014 quieter than finishing it, and harder to notice. Coordinate with the holder first. If you genuinely must: force:true via MCP, or --force on the CLI. Either is allowed, and either is recorded on the lock.`
    );
    this.name = "ScopeNarrowingRefusedError";
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
  const parsed = parseLockFile(raw, filePath);
  return { ...parsed, filePath };
}
async function readRecordWithRaw(filePath) {
  const raw = await fs2.readFile(filePath, "utf8");
  const parsed = parseLockFile(raw, filePath);
  return { record: { ...parsed, filePath }, raw };
}
var tempFileCounter = 0;
async function writeRecord(record) {
  const contents = serializeLockFile(record);
  const dir = path2.dirname(record.filePath);
  await fs2.mkdir(dir, { recursive: true });
  tempFileCounter += 1;
  const tempPath = path2.join(
    dir,
    `.${path2.basename(record.filePath)}.tmp-${process.pid}-${Date.now()}-${tempFileCounter}`
  );
  try {
    await fs2.writeFile(tempPath, contents, "utf8");
    await fs2.rename(tempPath, record.filePath);
  } catch (error) {
    await fs2.rm(tempPath, { force: true });
    throw error;
  }
}
var ConcurrentUpdateError = class extends Error {
  constructor(lockId) {
    super(
      `Lock "${lockId}" was modified by someone else while this update was being prepared, and the update was NOT applied. Re-read the lock and re-issue your change. Reporting this rather than overwriting is deliberate: a lost scope amendment leaves the amending agent believing its files are visible to peers when they are not \u2014 which is the exact failure this tool exists to prevent.`
    );
    this.name = "ConcurrentUpdateError";
  }
};
async function mutateRecord(locksRoot, lockId, mutate) {
  const ATTEMPTS = 8;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const found = await findRecordPathById(locksRoot, lockId);
    if (!found) throw new LockNotFoundError(lockId);
    const release = await acquireFileLock(found);
    if (!release) continue;
    try {
      const { record, raw } = await readRecordWithRaw(found);
      const result = mutate(record);
      const current = await fs2.readFile(found, "utf8").catch(() => null);
      if (current !== raw) continue;
      await writeRecord(record);
      if (record.filePath !== found) await fs2.rm(found, { force: true });
      return { record, result };
    } finally {
      await release();
    }
  }
  throw new ConcurrentUpdateError(lockId);
}
var FILE_LOCK_STALE_MS = 3e4;
async function acquireFileLock(filePath) {
  const lockPath = `${filePath}.lock`;
  try {
    const handle = await fs2.open(lockPath, "wx");
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const stat = await fs2.stat(lockPath);
      if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
        await fs2.rm(lockPath, { force: true });
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    return null;
  }
  return async () => {
    await fs2.rm(lockPath, { force: true });
  };
}
async function findRecordPathById(locksRoot, lockId) {
  for (const dir of [activeDir(locksRoot), doneDir(locksRoot)]) {
    for (const filePath of await listMarkdownFiles(dir)) {
      const record = await readRecord(filePath);
      if (record.frontmatter.id === lockId) return filePath;
    }
  }
  return null;
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
async function findLockById(locksRoot, lockId) {
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
  const scope = normalizeScope(params.scope);
  if (scope.length === 0) {
    throw new EmptyScopeError(
      "lock_create requires at least one non-empty glob pattern in scope (whitespace-only patterns are dropped, because a glob carrying stray whitespace matches nothing and would produce a lock that claims a file it can never be matched against)."
    );
  }
  const frontmatter = {
    id,
    agent_id: params.agent_id ?? null,
    parent_agent_id: params.parent_agent_id ?? null,
    status: "active",
    created: now,
    updated: now,
    scope,
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
  return { id, filePath, scope, scopeCheck: formatScopeCheck(scope, params.dialect ?? "mcp", id) };
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
var EmptyUpdateError = class extends Error {
  constructor(lockId) {
    super(
      `lock_update on "${lockId}" was given nothing to do. Pass task_text + done to check a task off, note to record something, scope/add_scope to amend the claim, or any combination. Refusing a no-op rather than bumping the timestamp silently: a call that only proves the agent is alive is lock_heartbeat, and saying so keeps the two distinguishable.`
    );
    this.name = "EmptyUpdateError";
  }
};
var IncompleteTaskUpdateError = class extends Error {
  constructor(lockId) {
    super(
      `lock_update on "${lockId}" received task_text without done (or done without task_text). Both are required together \u2014 which task, and which way to flip it. Guessing either one would silently record a state change nobody asked for.`
    );
    this.name = "IncompleteTaskUpdateError";
  }
};
async function updateLock(locksRoot, params) {
  const wantsTaskFlip = params.task_text !== void 0 || params.done !== void 0;
  const wantsScopeAmendment = params.set_scope !== void 0 || params.add_scope !== void 0;
  const wantsNote = params.note !== void 0 && params.note.trim() !== "";
  if (!wantsTaskFlip && !wantsScopeAmendment && !wantsNote) {
    throw new EmptyUpdateError(params.lock_id);
  }
  if (wantsTaskFlip && (params.task_text === void 0 || params.done === void 0)) {
    throw new IncompleteTaskUpdateError(params.lock_id);
  }
  const { record, result } = await mutateRecord(locksRoot, params.lock_id, (record2) => {
    const task = params.task_text === void 0 ? void 0 : record2.tasks.find((t) => t.text === params.task_text);
    if (params.task_text !== void 0 && !task) {
      throw new TaskNotFoundError(
        params.lock_id,
        params.task_text,
        record2.tasks.map((t) => t.text)
      );
    }
    const previousScope2 = record2.frontmatter.scope ?? [];
    const amendment2 = applyScopeAmendment(previousScope2, params);
    if (task) task.done = params.done;
    if (params.note) {
      record2.notes.push(params.note);
    }
    if (amendment2.changed) {
      const now = formatTimestamp();
      record2.frontmatter.scope_history = [
        ...record2.frontmatter.scope_history ?? [],
        { replaced_at: now, scope: previousScope2 }
      ];
      record2.frontmatter.scope = amendment2.next;
      if (amendment2.removed.length > 0) {
        const holder = record2.frontmatter.agent_id;
        const foreign = params.agent_id != null && holder != null && !agentMatches(holder, params.agent_id);
        if (foreign && !params.force) {
          throw new ScopeNarrowingRefusedError(
            params.lock_id,
            holder,
            params.agent_id,
            amendment2.removed
          );
        }
        if (foreign) {
          record2.notes.push(
            `Scope force-narrowed by ${params.agent_id}, which is NOT the holder (${holder}). Dropped ${amendment2.removed.map((g) => `\`${g}\``).join(", ")}. This note is the only record that another session's claim was reduced.`
          );
        }
        record2.notes.push(
          `Scope narrowed at ${now}: no longer claims ${amendment2.removed.map((g) => `\`${g}\``).join(", ")}. Those paths are now invisible to other agents' conflict checks.`
        );
      }
    }
    if (!record2.frontmatter.repository && params.repository) {
      record2.frontmatter.repository = params.repository;
    }
    record2.frontmatter.updated = formatTimestamp();
    return { amendment: amendment2, previousScope: previousScope2 };
  });
  const { amendment, previousScope } = result;
  const scope = record.frontmatter.scope;
  const warnings = [];
  if (amendment.changed && record.frontmatter.status !== "active") {
    warnings.push(
      `This lock is already ${record.frontmatter.status}, and lock_check_conflict reads active locks only \u2014 so amending its scope changes nothing about what other agents can see.`
    );
  }
  if (amendment.removed.length > 0) {
    warnings.push(
      `This narrowed the claim: ${amendment.removed.map((g) => `\`${g}\``).join(", ")} are no longer covered, so any work you still have in flight there is now invisible to other agents' conflict checks.`
    );
  }
  return {
    id: record.frontmatter.id,
    percentComplete: computePercentComplete(record.tasks),
    scope,
    scopeChanged: amendment.changed,
    ...amendment.changed ? { previousScope } : {},
    ...amendment.removed.length > 0 ? { removedFromScope: amendment.removed } : {},
    ...warnings.length > 0 ? { warnings } : {},
    scopeCheck: formatScopeCheck(scope, params.dialect ?? "mcp", record.frontmatter.id)
  };
}
async function finishLock(locksRoot, params) {
  await ensureDirs(locksRoot);
  const { record } = await mutateRecord(locksRoot, params.lock_id, (record2) => {
    if (record2.frontmatter.status !== "active") throw new LockNotActiveError(params.lock_id);
    if (params.summary) record2.notes.push(params.summary);
    const holder = record2.frontmatter.agent_id;
    const foreign = params.agent_id != null && holder != null && !agentMatches(holder, params.agent_id);
    if (foreign && !params.force) {
      throw new LockNotOwnedError(params.lock_id, holder, params.agent_id);
    }
    if (foreign) {
      record2.notes.push(
        `Force-finished by ${params.agent_id}, which is NOT the holder (${holder}). This note is the only record that the claim was ended by someone other than whoever made it.`
      );
    }
    record2.frontmatter.status = "done";
    record2.frontmatter.updated = formatTimestamp();
    record2.filePath = path2.join(doneDir(locksRoot), path2.basename(record2.filePath));
  });
  return { id: record.frontmatter.id, filePath: record.filePath };
}
async function heartbeatLock(locksRoot, params) {
  const { record } = await mutateRecord(locksRoot, params.lock_id, (record2) => {
    if (record2.frontmatter.status !== "active") throw new LockNotActiveError(params.lock_id);
    record2.frontmatter.updated = formatTimestamp();
  });
  return { id: record.frontmatter.id, updated: record.frontmatter.updated };
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
    await ensureDirs(locksRoot);
    await mutateRecord(locksRoot, record.frontmatter.id, (fresh) => {
      if (fresh.frontmatter.status !== "active") throw new LockNotActiveError(fresh.frontmatter.id);
      fresh.notes.push(
        `Auto-reaped: last touched ${fresh.frontmatter.updated} (UTC), no activity for ${Math.round(summary.staleForSeconds / 60)} minute(s), threshold ${staleMinutes} minute(s).`
      );
      fresh.frontmatter.status = "done";
      fresh.frontmatter.updated = formatTimestamp();
      fresh.filePath = path2.join(doneDir(locksRoot), path2.basename(fresh.filePath));
    });
  }
  return reaped;
}

// src/lock/drift.ts
async function checkScopeDrift(locksRoot, params) {
  const record = await findLockById(locksRoot, params.lock_id);
  if (!record) throw new LockNotFoundError(params.lock_id);
  const cwd = params.cwd ?? process.cwd();
  const claimedAt = parseTimestamp(record.frontmatter.created);
  const [uncommitted, committed, inspectedWorktree, ignoredFilesNotExamined, worktreeCount] = await Promise.all([
    listChangedFiles(cwd),
    listCommittedFilesSince(cwd, claimedAt),
    resolveRepoRoot(cwd),
    countIgnoredFiles(cwd),
    countWorktrees(cwd)
  ]);
  const changed = [.../* @__PURE__ */ new Set([...uncommitted, ...committed])].sort();
  const scope = record.frontmatter.scope ?? [];
  const outOfScope = [];
  let inScopeCount = 0;
  for (const file of changed) {
    if (scopesOverlap([file], scope)) inScopeCount += 1;
    else outOfScope.push(file);
  }
  const lockCreatedIn = record.frontmatter.repository ?? "";
  const warnings = [];
  if (worktreeCount > 1) {
    warnings.push(
      `This repository has ${worktreeCount} worktrees, and drift was computed against ${inspectedWorktree}. If you are editing a different one, the files below are not your files and a clean result here means nothing \u2014 agent-locks cannot tell which worktree a tool call came from, so pass base_dir to name yours explicitly.`
    );
  }
  if (ignoredFilesNotExamined > 0) {
    warnings.push(
      `${ignoredFilesNotExamined} file(s) are ignored by git and were NOT examined. If your work includes any of them (a .env, a generated config, anything under an ignored build directory), this check cannot see it and cannot rule out drift in it.`
    );
  }
  if (lockCreatedIn === "") {
    warnings.push(
      `This lock predates the \`repository\` frontmatter field, so agent-locks cannot confirm it was created in the working tree just inspected (${inspectedWorktree}). If it was not, the changed files below are not the ones its owner is editing.`
    );
  } else if (lockCreatedIn !== inspectedWorktree) {
    warnings.push(
      `This lock was created in ${lockCreatedIn}, but drift was computed against ${inspectedWorktree}. The changed files below are THIS working tree's, not the ones the lock's owner is editing \u2014 so a clean result here says nothing about whether their scope matches their work. Drift is only meaningful against your own lock, in your own worktree.`
    );
  }
  if (record.frontmatter.status !== "active") {
    warnings.push(
      `This lock is already ${record.frontmatter.status}; amending the scope of finished work changes nothing about what other agents can see.`
    );
  }
  if (changed.length === 0) {
    warnings.push(
      `Nothing was compared: this working tree has no uncommitted changes and no commits since the lock was created, so "no drift" here is not evidence the scope is right. If the work lives on commits made BEFORE ${record.frontmatter.created} (the moment this lock was claimed), compare the scope against \`git diff --name-only <base>...HEAD\` yourself.`
    );
  }
  const vacuousPatterns = scope.filter((pattern) => staticPrefix(pattern) === "");
  if (vacuousPatterns.length > 0) {
    warnings.push(
      `Scope pattern(s) ${vacuousPatterns.map((p) => `\`${p}\``).join(", ")} begin with a wildcard, so they match every path in the repository. Drift cannot fail against them \u2014 a "covered" result here is a property of the pattern, not evidence about your work. Narrow the scope to the paths you are really touching if you want this check to mean anything.`
    );
  }
  const MAX_LISTED = 200;
  const listed = outOfScope.slice(0, MAX_LISTED);
  const truncated = outOfScope.length - listed.length;
  if (truncated > 0) {
    warnings.push(
      `${truncated} further out-of-scope path(s) are not listed (the list is capped at ${MAX_LISTED}). outOfScopeCount carries the real total.`
    );
  }
  const drifted = outOfScope.length > 0;
  const outcome = changed.length === 0 ? "NOTHING_MEASURED" : drifted ? "DRIFTED" : "COVERED";
  return {
    lock_id: record.frontmatter.id,
    title: record.title,
    scope,
    inspectedWorktree,
    lockCreatedIn,
    changedFileCount: changed.length,
    uncommittedCount: uncommitted.length,
    committedSinceClaimCount: committed.length,
    ignoredFilesNotExamined,
    inScopeCount,
    outOfScope: listed,
    outOfScopeCount: outOfScope.length,
    outOfScopeTruncated: truncated,
    outcome,
    reliable: warnings.length === 0,
    drifted,
    warnings,
    scopeCheck: formatScopeCheck(scope, params.dialect ?? "mcp", record.frontmatter.id)
  };
}

// src/version.ts
var VERSION = "0.2.0";

// src/server.ts
var SERVER_NAME = "agent-locks";
var SERVER_VERSION = VERSION;
var INSTRUCTIONS = `agent-locks: filesystem-based work-claiming locks shared across every git worktree of the current repository. No database \u2014 everything lives as markdown files under the repo's shared .git directory, so it is automatically invisible to git and never gets committed.

Recommended workflow, in order:
1. Before starting work on a set of files, call lock_query (default view, active locks only) to see what other agents are already doing, and call lock_check_conflict with the globs you're about to touch to see if anyone's active lock overlaps them. lock_check_conflict is purely informational \u2014 it never blocks you, it just gives you information to make your own judgment call with.
2. If you decide to proceed, call lock_create to claim the work: give it a title, the glob patterns describing what you're touching, and a checklist of the tasks you plan to do.
3. As you actually complete each task, call lock_update immediately \u2014 not batched at the end. The whole point of this system is that other agents can see live, current state; a lock that only gets updated right before you finish is not useful to anyone watching in the meantime. If you're doing a long stretch of work without a task boundary to check off, call lock_heartbeat periodically so your lock doesn't read as abandoned to anyone else watching.
4. Whenever the work grows past what you claimed, amend the scope in the same lock_update call: add_scope widens it (set_scope replaces it outright, which is how a lock that over-claimed gets narrowed). Do this when you notice, not at the end \u2014 lock_check_conflict matches the globs recorded RIGHT NOW, so until you amend, every file you have touched outside your scope is invisible to any other agent checking for a conflict, while your lock still reads to them as active and healthy.
5. Before you finish, call lock_check_drift. It lists the changed files in your working tree that your scope does not cover, so you are not relying on having remembered step 4.
6. When the work is COMMITTED \u2014 not merely when the edits are done \u2014 call lock_finish with a short summary. The gap between finishing edits and committing them is exactly when another agent sweeps your uncommitted work into its own commit, so releasing early leaves that window unclaimed. This moves the lock out of the active set and into the done archive, and it will no longer show up in lock_query's default view.

Why steps 4 and 5 are steps and not advice: scope going stale as the work grows is the failure mode most likely to bite you, and it is not a discipline problem. You declare scope at the moment you know LEAST about what you will touch, and work legitimately grows \u2014 a lock created for auth/** ends up spanning eight packages. Two sessions in sibling worktrees already came to independently rewrite the same files this way, each having run exactly the queries these instructions prescribe: the one that checked saw an active, healthy-looking lock whose globs did not mention any file it was about to edit. Amendments are recorded in the lock file with timestamps, never overwritten silently, and lock_create/lock_update echo the current scope back to you on every call so it stays in front of you rather than being written once and never seen again.

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
      description: `Lists agent-locks work-claim locks for the current git repository (shared across all its worktrees). IMPORTANT: when \`status\` is omitted, this ONLY returns active locks \u2014 done/finished locks are excluded from the default view by design, so you see what is currently being worked on, not a full history. Pass status: "done" or status: "all" to include finished locks. Returns a compact summary per lock: {id, title, status, percentComplete, scope, repository, agent_id, parent_agent_id, stale, staleForSeconds}, plus scope_history (the scopes this lock previously claimed, each with the timestamp it was retired) on any lock whose scope has been amended \u2014 that is what answers "was that file inside their claim at the moment I checked?". percentComplete is computed from the ratio of checked to total tasks on that lock (a lock with zero tasks reports 100). stale is true for an ACTIVE lock not touched in over stale_minutes (default ${DEFAULT_STALE_MINUTES}) \u2014 computed fresh on every call, never mutates anything; done locks are never stale.`,
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
        return textResult(
          JSON.stringify(
            {
              locks: results,
              unreadable_locks: lastUnreadableLocks,
              ...lastUnreadableLocks.length > 0 ? { warning: `${lastUnreadableLocks.length} lock file(s) could not be read and are NOT included in "locks". A claim you cannot see is a claim you will collide with.` } : {}
            },
            null,
            2
          )
        );
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
        return textResult(
          JSON.stringify(
            {
              conflicts: results,
              unreadable_locks: lastUnreadableLocks,
              ...lastUnreadableLocks.length > 0 ? { warning: `${lastUnreadableLocks.length} lock file(s) could not be read, so this is NOT a complete conflict check.` } : {}
            },
            null,
            2
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "lock_create",
    {
      title: "Create a lock",
      description: `Claims a piece of work by writing a new active lock file. Use this after you have decided to proceed (optionally having checked lock_query / lock_check_conflict first). tasks are created as a plain unchecked checklist; call lock_update as you complete each one. agent_id / parent_agent_id: pass your OWN id here only if you already know it from your own context (some orchestration harnesses hand a subagent an explicit id when dispatching it) \u2014 this server has no way to detect either value automatically (no MCP transport mechanism exposes a session/agent id to a stdio server subprocess). Omit them (or pass null) if you do not know them; they will be recorded as null, never fabricated. parent_agent_id specifically means "the id of whatever spawned you," if you are a subagent and happen to know it. The result echoes back the scope it recorded, along with a prompt to keep re-deriving it: scope is not frozen at creation \u2014 amend it with lock_update's add_scope as the work grows, because lock_check_conflict matches whatever globs are recorded now, and any file outside them is invisible to every other agent looking for a conflict.`,
      inputSchema: {
        title: z.string().min(1).describe("Short human-readable title for this lock."),
        scope: z.array(z.string()).min(1).describe(
          "Glob patterns describing the files/paths this lock claims. Declare your best guess now and amend it later with lock_update \u2014 this is the moment you know least about what you will touch, and an unamended scope silently stops covering the files the work grows into."
        ),
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
      description: "Flips one task on an existing lock to done or not-done, amends the lock's scope, and/or appends a note \u2014 any combination, at least one required. Call this AS SOON as a task actually completes \u2014 not batched at the end of your work \u2014 so other agents watching lock_query see live progress. task_text must match an EXISTING task's text EXACTLY (no fuzzy/partial matching); if it does not match, this returns an error listing the lock's actual task texts rather than silently doing nothing. task_text and done are required TOGETHER, and both are optional overall, so a scope amendment or a note does not have to flip a task to be recorded. AMENDING SCOPE: pass add_scope to widen the claim as the work grows (the common case \u2014 scope is declared when you know least about what you will touch), or set_scope to replace it outright, which is how a lock that over-claimed gets narrowed instead of left blocking others. A replacement that DROPS globs takes protection away, so it is gated the same way lock_finish is: refused when the lock is held by a different, named agent, unless force:true \u2014 which is recorded on the lock. Widening is never gated. The two are mutually exclusive. Amendments are appended to the lock file's scope_history with a timestamp rather than overwriting the old value silently, so a later reader can reconstruct what this lock claimed at the moment another agent checked it. The result ALWAYS echoes the lock's current scope, amended or not, along with a prompt to re-derive it against what you are really editing \u2014 because lock_check_conflict matches these globs, and any file outside them is invisible to every other agent looking for a conflict. Works on a lock in either active or done status (found by lock_id regardless of which directory it currently lives in).",
      inputSchema: {
        lock_id: z.string().describe("The id of the lock to update (as returned by lock_create or lock_query)."),
        task_text: z.string().optional().describe("The exact text of an existing task on this lock. Required together with `done`; omit both if you are only amending scope or adding a note."),
        done: z.boolean().optional().describe("true to mark the task done, false to mark it not done. Required together with `task_text`."),
        add_scope: z.array(z.string()).optional().describe(
          "Glob patterns to ADD to this lock's existing scope \u2014 the usual way to keep a claim honest as work grows beyond what you first declared. Adding a glob already claimed is a no-op and records no amendment. Mutually exclusive with `set_scope`."
        ),
        set_scope: z.array(z.string()).optional().describe(
          "REPLACE this lock's scope with these glob patterns. Use to narrow a lock that over-claimed, rather than leaving it blocking work it is not really doing. Must contain at least one non-empty pattern \u2014 an empty scope would still read as an active claim in lock_query while matching nothing in lock_check_conflict. Mutually exclusive with `add_scope`. Named set_scope and NOT scope deliberately: `scope` is what lock_create calls the whole claim, so copying create arguments into an update would silently REPLACE a claim you had been widening."
        ),
        agent_id: z.string().nullable().optional().describe(
          "Your own agent id, if you already know it. Used ONLY to detect a narrowing of someone else's claim; widening never consults it, and it is never fabricated. Same honesty caveat as lock_create."
        ),
        force: z.boolean().optional().describe(
          "Proceed with a narrowing that would otherwise be refused because the lock is held by another session. Deliberate and RECORDED on the lock \u2014 a refusal nobody can get past becomes one everyone routes around."
        ),
        note: z.string().optional().describe("Optional free-text note to append to the lock's Notes section."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is looked up in that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      // destructiveHint: `set_scope` can REPLACE a whole claim, and a narrowing
      // removes protection from files that may still be in flight — recoverable
      // only by reading scope_history. A client using this hint to decide
      // whether to confirm should be told that is possible.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
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
          repository: repoRoot
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "lock_check_drift",
    {
      title: "Check a lock for scope drift",
      description: 'Compares what a lock CLAIMS against what your working tree has actually changed, and lists every changed file the lock\'s scope does not cover. Run this before you finish, and any time the work has grown beyond what you first declared \u2014 scope is set at lock_create, the moment you know least about what you will touch, so drift is the normal outcome rather than a lapse. Changed files come from `git status` in the working tree you are calling from (staged, unstaged, and untracked alike, with renames counting both paths) PLUS every file touched by a commit made since the lock was claimed \u2014 committing as you go is how a branch normally grows, and `git status` alone cannot see it. Coverage is decided by the exact same glob matcher lock_check_conflict uses, so a file this reports as out of scope is precisely a file another agent\'s conflict check would NOT surface your lock for. Purely informational and read-only: it never amends anything. Fix what it reports with lock_update\'s add_scope. WHAT IT CANNOT SEE, so you do not read a clean result for more than it is worth: files git ignores (the count is reported, their drift is not knowable here); work committed BEFORE the lock was claimed; anything outside this working tree; and submodule contents. If nothing changed at all, nothing was compared \u2014 that is reported as outcome "NOTHING_MEASURED", which is NOT the same as "your scope is right". Prefer `outcome` over `drifted`: the boolean cannot tell "the scope covers the work" from "nothing was measured". Returns {lock_id, title, scope, inspectedWorktree, lockCreatedIn, changedFileCount, uncommittedCount, committedSinceClaimCount, ignoredFilesNotExamined, inScopeCount, outOfScope, outOfScopeCount, outOfScopeTruncated, outcome, drifted, warnings, scopeCheck}. READ THE WARNINGS: drift is only meaningful for your OWN lock in your OWN worktree, and running it against a lock created elsewhere compares that lock\'s scope to files its owner is not editing \u2014 a clean result there means nothing.',
      inputSchema: {
        lock_id: z.string().describe("The id of the lock to check (as returned by lock_create or lock_query)."),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). Both the lock lookup AND the `git status` that supplies the changed files come from there instead of the current working directory."
        )
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
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
        agent_id: z.string().optional().describe(
          "Your own agent id. Supply it so ownership can be checked: finishing a lock held by a DIFFERENT session is refused unless force is set. Omit it and no check is possible."
        ),
        force: z.boolean().optional().describe(
          "Deliberately finish a lock held by someone else. Required when both identities are known and differ; the fact is recorded in the archived lock."
        ),
        base_dir: z.string().optional().describe(
          "Target a different repository by its working-tree path (or any path inside it). The lock is looked up in that repository's shared .git directory. Omit to use the current working directory."
        )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ lock_id, summary, agent_id, force, base_dir }) => {
      try {
        const cwd = base_dir ?? process.cwd();
        const locksRoot = await resolveLocksRoot(cwd);
        const result = await finishLock(locksRoot, { lock_id, summary, agent_id, force });
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
        return textResult(JSON.stringify({ reaped: result, floor: lastReapFloor }, null, 2));
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
  agent-locks update <lock-id> [options]  Mark a task done/undone, amend the scope, and/or add a note. See "agent-locks update --help".
  agent-locks drift <lock-id> [options]   Show which of this working tree's changed files a lock's scope does NOT cover.
  agent-locks finish <lock-id> [--summary <text>] [--agent <id>] [--force]  Mark a lock done and archive it. Pass --agent so ownership can be checked; --force is required (and recorded) to end another session's claim.
  agent-locks heartbeat <lock-id>        Bump a lock's updated timestamp with no other change. See "Staleness detection" in the README.
  agent-locks reap [lock-id] [options]  Finish stale lock(s). See "agent-locks reap --help".
  agent-locks --version                 Print the version. Use it to tell which build a worktree is running.
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

Checks a task off, amends the lock's scope, and/or appends a note \u2014 any combination, at
least one required.

Amending scope is expected, not exceptional: you declare it at claim time, which is when
you know least about what you will touch, and conflict checks match whatever globs are
recorded now. Every file you touch outside them is invisible to any other agent looking
for a conflict. Run "agent-locks drift <lock-id>" to see which of your changed files are
currently uncovered.

Options:
  --task <text>          Must match an existing task's text exactly. Optional \u2014 omit it if you
                          are only amending scope or adding a note.
  --done                 Mark the task done. Requires --task. Default when --task is given and
                          neither --done nor --undone is.
  --undone               Mark the task not done. Requires --task.
  --add-scope <glob>     Add a glob to the lock's existing scope. Repeatable. The usual amendment.
  --set-scope <glob>     Replace the lock's whole scope with these globs. Repeatable. Use to
                          narrow a lock that over-claimed. Mutually exclusive with --add-scope.
  --agent <id>           Your own agent id, so ownership can be checked when this narrows
                          the claim. Widening never needs it.
  --force                Proceed with a narrowing that would otherwise be refused because
                          the lock is held by someone else. Recorded on the lock.
  --note <text>           Append a free-text note to the lock.
  --base-dir <path>      Look up the lock in a different repository (any path inside it).
  --json                 Print raw JSON instead of a short confirmation line.`;
var DRIFT_USAGE = `agent-locks drift <lock-id> [options]

Compares what the lock CLAIMS against what this working tree has actually changed, and
lists every changed file the lock's scope does not cover. Changed files come from
"git status" (staged, unstaged and untracked alike) PLUS every file touched by a commit
made since the lock was claimed; coverage uses the same glob matcher the conflict check
uses, so a file listed here is exactly a file another agent's conflict check would NOT
surface this lock for.

Read-only \u2014 it never amends anything. Fix what it reports with
"agent-locks update <lock-id> --add-scope <glob>".

WHAT THIS CANNOT SEE, so that a clean result is not read for more than it is worth:
  - files git ignores (a .env, a generated config, an ignored build dir) \u2014 the count of
    them is reported, but their names and their drift are not knowable here;
  - work committed BEFORE the lock was claimed;
  - anything outside this working tree, and the contents of submodules;
  - and if nothing changed at all, nothing was compared \u2014 that is reported as
    outcome: NOTHING_MEASURED, which is not the same as "your scope is right".

Only meaningful for your own lock in your own worktree: run against a lock created
elsewhere, it compares that lock's scope to files its owner is not editing, and a clean
result means nothing. Read the warnings \u2014 they print above the verdict for a reason.

Options:
  --base-dir <path>      Look up the lock, and read the changed files, from a different
                          repository (any path inside it).
  --json                 Print raw JSON instead of a formatted report.`;
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
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["--json", "--done", "--undone", "--help", "--dry-run", "--force"]);
var SUBCOMMAND_FLAGS = {
  status: ["--base-dir", "--json"],
  list: ["--status", "--scope", "--agent", "--text", "--stale-minutes", "--base-dir", "--json", "--help"],
  check: ["--stale-minutes", "--base-dir", "--json", "--help"],
  claim: ["--title", "--scope", "--task", "--agent", "--parent", "--base-dir", "--json", "--help"],
  update: [
    "--task",
    "--done",
    "--undone",
    "--add-scope",
    "--set-scope",
    "--note",
    "--agent",
    "--force",
    "--base-dir",
    "--json",
    "--help"
  ],
  drift: ["--base-dir", "--json", "--help"],
  finish: ["--summary", "--agent", "--force", "--base-dir", "--json", "--help"],
  heartbeat: ["--base-dir", "--json", "--help"],
  reap: ["--stale-minutes", "--dry-run", "--base-dir", "--json", "--help"]
};
function rejectUnknownFlags(command, parsed) {
  const allowed = SUBCOMMAND_FLAGS[command];
  if (!allowed) return;
  const used = [...parsed.flags.keys(), ...parsed.boolFlags];
  for (const flag of used) {
    if (!allowed.includes(flag)) {
      throw new CliUsageError(
        `unknown flag ${flag} for "agent-locks ${command}". Accepted: ${allowed.join(", ")}. Refusing rather than ignoring it \u2014 a flag this build silently dropped would report success while doing nothing.`
      );
    }
  }
}
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
  warnUnreadable();
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
  warnUnreadable();
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
  warnUnreadable();
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
  if (conflicts.length === 0) {
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
  const result = await createLock(locksRoot, {
    title,
    scope,
    tasks,
    agent_id,
    parent_agent_id,
    repository: repoRoot,
    dialect: "cli"
  });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Claimed "${title}" as lock ${result.id}`);
    console.log(result.scopeCheck);
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
  if (flags.boolFlags.has("--done") && flags.boolFlags.has("--undone")) {
    throw new CliUsageError("Pass at most one of --done / --undone.");
  }
  if (!taskText && (flags.boolFlags.has("--done") || flags.boolFlags.has("--undone"))) {
    throw new CliUsageError('--done / --undone name how to flip a task, so they require --task. See "agent-locks update --help".');
  }
  const addScope = allOf(flags.flags, "--add-scope");
  const setScope = allOf(flags.flags, "--set-scope");
  if (addScope.length > 0 && setScope.length > 0) {
    throw new CliUsageError("Pass at most one of --add-scope (widen the claim) / --set-scope (replace it), not both.");
  }
  const note = oneOf(flags.flags, "--note");
  if (!taskText && addScope.length === 0 && setScope.length === 0 && note === void 0) {
    throw new CliUsageError(
      'agent-locks update needs something to do: --task (with --done/--undone), --add-scope, --set-scope, or --note. See "agent-locks update --help".'
    );
  }
  const done = taskText === void 0 ? void 0 : !flags.boolFlags.has("--undone");
  const cwd = resolveBaseDir(flags);
  const [locksRoot, repoRoot] = await Promise.all([resolveLocksRoot(cwd), resolveRepoRoot(cwd)]);
  const result = await updateLock(locksRoot, {
    lock_id: lockId,
    repository: repoRoot,
    task_text: taskText,
    done,
    note,
    agent_id: oneOf(flags.flags, "--agent") ?? null,
    force: flags.boolFlags.has("--force"),
    add_scope: addScope.length > 0 ? addScope : void 0,
    set_scope: setScope.length > 0 ? setScope : void 0,
    dialect: "cli"
  });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (taskText !== void 0) {
    console.log(`Lock ${result.id}: "${taskText}" marked ${done ? "done" : "not done"} (${result.percentComplete}% complete overall).`);
  }
  for (const warning of result.warnings ?? []) {
    console.log(`warning: ${warning}`);
  }
  if (result.scopeChanged) {
    console.log(`Lock ${result.id}: scope amended.`);
    console.log(`  was: ${(result.previousScope ?? []).join(", ") || "(none)"}`);
    console.log(`  now: ${result.scope.join(", ")}`);
    if (result.removedFromScope?.length) {
      console.log(`  NO LONGER CLAIMED: ${result.removedFromScope.join(", ")}`);
    }
  }
  if (note !== void 0 && taskText === void 0 && !result.scopeChanged) {
    console.log(`Lock ${result.id}: note recorded.`);
  }
  console.log(result.scopeCheck);
}
async function cmdDrift(flags) {
  if (flags.boolFlags.has("--help")) {
    console.log(DRIFT_USAGE);
    return;
  }
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError('agent-locks drift requires a lock id as its first argument. See "agent-locks drift --help".');
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await checkScopeDrift(locksRoot, { lock_id: lockId, cwd, dialect: "cli" });
  if (flags.boolFlags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Lock ${result.lock_id} \u2014 "${result.title}"`);
  console.log(`claims: ${result.scope.join(", ") || "(none)"}`);
  console.log(
    `${result.changedFileCount} changed file(s) in ${result.inspectedWorktree} (${result.uncommittedCount} uncommitted, ${result.committedSinceClaimCount} committed since the claim); ${result.inScopeCount} covered by that scope.`
  );
  for (const warning of result.warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log(`outcome: ${result.outcome}`);
  if (result.drifted) {
    console.log(`
files changed outside that scope (${result.outOfScopeCount}):`);
    for (const file of result.outOfScope) console.log(`  ${file}`);
    if (result.outOfScopeTruncated > 0) {
      console.log(`  ... and ${result.outOfScopeTruncated} more (list capped)`);
    }
  } else if (result.outcome === "NOTHING_MEASURED") {
    console.log("\nNo files were compared, so this says NOTHING about whether the scope is right.");
  } else {
    console.log("\nNo drift: every changed file is covered by the scope above.");
  }
  console.log(`
${result.scopeCheck}`);
}
async function cmdFinish(flags) {
  const lockId = flags.positionals[0];
  if (!lockId) throw new CliUsageError("agent-locks finish requires a lock id as its first argument.");
  const summary = oneOf(flags.flags, "--summary");
  const agent_id = oneOf(flags.flags, "--agent");
  const force = flags.boolFlags.has("--force");
  const cwd = resolveBaseDir(flags);
  const locksRoot = await resolveLocksRoot(cwd);
  const result = await finishLock(locksRoot, { lock_id: lockId, summary, agent_id, force });
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
  warnUnreadable();
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
  const parsedFor = (name, args) => {
    const parsed = parseArgs(args);
    rejectUnknownFlags(name, parsed);
    return parsed;
  };
  if (command === void 0 || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }
  try {
    switch (command) {
      case "status":
        await cmdStatus(parsedFor(command, rest));
        return 0;
      case "list":
        await cmdList(parsedFor(command, rest));
        return 0;
      case "check":
        await cmdCheck(parsedFor(command, rest));
        return 0;
      case "claim":
        await cmdClaim(parsedFor(command, rest));
        return 0;
      case "update":
        await cmdUpdate(parsedFor(command, rest));
        return 0;
      case "drift":
        await cmdDrift(parsedFor(command, rest));
        return 0;
      case "finish":
        await cmdFinish(parsedFor(command, rest));
        return 0;
      case "heartbeat":
        await cmdHeartbeat(parsedFor(command, rest));
        return 0;
      case "reap":
        await cmdReap(parsedFor(command, rest));
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
    if (error instanceof NotAGitRepoError || error instanceof LockNotFoundError || error instanceof TaskNotFoundError || error instanceof LockNotActiveError || error instanceof LockNotOwnedError || error instanceof ScopeNarrowingRefusedError || error instanceof LockNotStaleError || error instanceof ScopeAmendmentError || error instanceof EmptyScopeError || error instanceof EmptyUpdateError || error instanceof IncompleteTaskUpdateError) {
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
