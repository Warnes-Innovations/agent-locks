/**
 * Resolves the one shared lock-storage directory for whichever git worktree
 * the calling agent's tool call is actually rooted in.
 *
 * The crux of the whole design: `git rev-parse --git-common-dir` returns the
 * SAME path for every worktree of a repository (the main checkout and every
 * `git worktree add`-created linked worktree), because a linked worktree's
 * own `.git` is just a *file* containing a pointer (`gitdir: /path/to/main/
 * .git/worktrees/<name>`) back to the one real `.git` directory that all
 * worktrees share. `git rev-parse --git-dir`, by contrast, returns the
 * worktree-LOCAL path — for a linked worktree that's the per-worktree
 * `.git/worktrees/<name>` subdirectory, which is NOT shared, so using
 * `--git-dir` here would give every worktree its own separate, invisible-to-
 * each-other lock directory and defeat the entire point of this tool.
 *
 * Concrete example (see README for the full walkthrough):
 *   Main worktree at   /repo            → --git-common-dir → /repo/.git
 *   Linked worktree at  /repo-feature-x  → --git-common-dir → /repo/.git   (same!)
 *                                         → --git-dir        → /repo/.git/worktrees/feature-x  (different, wrong)
 *
 * We deliberately run this git command FRESH on every single tool call
 * (never cached across calls, never resolved once at server startup) with
 * `cwd` set to the server process's own current working directory. A stdio
 * MCP server has no protocol-level or environment-variable way to learn
 * which worktree a particular tool call "belongs to" (see README's "How
 * Claude Code launches this server" section for why `CLAUDE_PROJECT_DIR` is
 * NOT used for this) — the only signal available is the process's own cwd
 * at the moment each git command runs, which normally does not change
 * within one server's lifetime, but resolving it fresh every time costs
 * nothing and removes any risk of relying on a stale, cached assumption if
 * this server is ever invoked in an environment where that assumption
 * doesn't hold.
 *
 * One more normalization step matters: git does not consistently return the
 * common-dir path in the same symlink-resolved-or-not form across call
 * shapes. When `cwd` IS the repo root, git tends to answer with a path
 * relative to `cwd` (e.g. plain ".git"), so `path.resolve(cwd, ...)` inherits
 * whatever symlink form `cwd` itself was passed in. When `cwd` is a LINKED
 * worktree, resolving the common dir requires git to internally chase the
 * worktree's `.git` *file* (a `gitdir: ...` pointer) back to the shared
 * directory, and in doing so git can return an already-canonicalized
 * (symlink-resolved) absolute path. On platforms where a caller's natural
 * working-directory path itself passes through a symlink — notably macOS,
 * where `/tmp` and `/var` are symlinks to `/private/tmp` and `/private/var`
 * — these two call shapes can therefore return two DIFFERENT strings for
 * what is the same real directory on disk, defeating this function's entire
 * contract ("same real directory in, same path out, regardless of which
 * worktree you called it from"). We close that gap by resolving the final
 * path through `fs.realpath` before returning it, so the return value is
 * always the canonical form no matter which internal path git took to get
 * there.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Prefix flags for every git invocation that inspects a repository's CONTENT
 * (`status`, `log`) rather than merely resolving a path (`rev-parse`).
 *
 * **`core.fsmonitor` is a command the repository's own `.git/config` names, and
 * `git status` EXECUTES it.** Because `base_dir` lets a caller point these tools
 * at any directory on disk, without this, "check drift in that repo" is a
 * request to run whatever that repo's config says — arbitrary code as the user,
 * from a directory they may merely have cloned. Reproduced end to end against a
 * planted repo: plain `git status` ran the payload, these flags stopped it, and
 * the pre-existing `git rev-parse` calls never ran it at all (they do not
 * refresh the index). So this hazard arrived with the content-reading calls; it
 * is not inherited, and it does not travel back to the older tools.
 *
 * `-c` on the command line outranks repository config, which is what makes this
 * work at all. `--no-optional-locks` additionally stops `status` from taking
 * `.git/index.lock` and rewriting the index of a repository we are only
 * READING — both a correctness point (a coordination tool must not intermittently
 * break a concurrent `git` in someone else's worktree) and what makes these
 * tools' `readOnlyHint: true` annotation actually true.
 *
 * Applied to `git log` as well, which does not currently need it — overlapping
 * protection is deliberate, and a future flag or git version that makes `log`
 * refresh the index must not silently reopen this.
 */
const SAFE_GIT_PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

/**
 * A git command failed for a reason that is NOT "this isn't a repository" — a
 * corrupt index, an unreadable object, output past maxBuffer.
 *
 * Kept distinct from NotAGitRepoError because collapsing the two misdiagnoses
 * the failure to the one reader who acts on it: told "you are not inside a git
 * repository", an agent reasonably concludes drift checking does not apply here
 * and stops asking — which is precisely the silence this feature exists to end.
 * Both still fail closed; only the explanation differs, and the explanation is
 * what decides what happens next.
 */
export class GitCommandFailedError extends Error {
  constructor(command: string, cwd: string, cause: unknown) {
    super(
      `agent-locks: \`git ${command}\` failed in "${cwd}". This is NOT "not a git repository" — the repository ` +
        `was found, but the command could not complete, so nothing was measured and no conclusion should be drawn ` +
        `from an empty result. Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'GitCommandFailedError';
  }
}

export class NotAGitRepoError extends Error {
  constructor(cwd: string, cause: unknown) {
    super(
      `agent-locks: "${cwd}" does not appear to be inside a git repository ` +
        `(git rev-parse --git-common-dir failed). agent-locks requires a git ` +
        `repository because locks are stored under the repo's shared .git ` +
        `directory. Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'NotAGitRepoError';
  }
}

/**
 * Runs `git rev-parse --git-common-dir` in `cwd` and returns the absolute
 * path to that directory's `agents-locks` subdirectory.
 *
 * This is the single source of truth for "where do this repo's locks
 * live" — every tool implementation calls this at the start of its own
 * handler rather than accepting a cached path.
 */
export async function resolveLocksRoot(cwd: string = process.cwd()): Promise<string> {
  const realGitCommonDir = await getRealGitCommonDir(cwd);
  return path.join(realGitCommonDir, 'agents-locks');
}

/**
 * Runs `git rev-parse --show-toplevel` in `cwd` and returns the canonical
 * repository root path. Used to record which repository a lock governs.
 */
export async function resolveRepoRoot(cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch (error) {
    throw new NotAGitRepoError(cwd, error);
  }
}

/**
 * Runs `git status` in `cwd` and returns every path that working tree has
 * touched — staged, unstaged, and untracked alike — as repository-root-
 * relative paths, de-duplicated and sorted.
 *
 * This is the "what am I actually touching" half of scope-drift detection
 * (see lock/drift.ts for the other half). Three flag choices are load-bearing
 * and must not be trimmed as noise:
 *
 *   --porcelain=v1  pins the machine-readable format to v1 explicitly, so a
 *                   future git default flip to v2 (a completely different
 *                   line grammar) cannot silently turn this parser's output
 *                   into an empty list — which would report zero drift on a
 *                   tree full of it.
 *   -z              NUL-separates entries and disables git's C-style path
 *                   quoting. Without it a path containing a space, a quote or
 *                   a non-ASCII byte comes back wrapped in quotes and escaped,
 *                   and would be compared against the lock's globs in that
 *                   mangled form — i.e. reported as out-of-scope drift for a
 *                   file that is in scope.
 *   -uall           expands untracked DIRECTORIES into their individual files.
 *                   git's default collapses them to a single `dir/` entry,
 *                   which matches a `dir/**` glob differently than the real
 *                   files under it do — and a brand-new directory of files is
 *                   precisely the shape scope drift takes.
 */
export async function listChangedFiles(cwd: string = process.cwd()): Promise<string[]> {
  return parseStatusPaths(await runStatus(cwd, []));
}

/**
 * Counts the paths `listChangedFiles` deliberately cannot see because git
 * ignores them, so the omission can be REPORTED rather than left implicit.
 *
 * `.gitignore`, `.git/info/exclude` and the global excludes file remove inputs
 * from examination — an undeclared exception list, and one an agent trips over
 * routinely: a `.env`, a generated config, anything under an ignored build
 * directory is real work that drift is structurally blind to. Reporting the
 * count turns "drift found nothing" into "drift found nothing among the N files
 * it could see, with M more it could not".
 */
export async function countIgnoredFiles(cwd: string = process.cwd()): Promise<number> {
  const stdout = await runStatus(cwd, ['--ignored=matching']);
  // --ignored=matching adds ignored entries to the same stream; count only those.
  let ignored = 0;
  for (const entry of stdout.split('\0')) {
    if (entry.length >= 4 && entry[0] === '!' && entry[1] === '!') ignored += 1;
  }
  return ignored;
}

/** How many worktrees this repository has. More than one means drift may be looking at the wrong tree. */
export async function countWorktrees(cwd: string = process.cwd()): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', [...SAFE_GIT_PREFIX, 'worktree', 'list', '--porcelain'], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw new GitCommandFailedError('worktree list', cwd, error);
  }
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

async function runStatus(cwd: string, extraArgs: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_GIT_PREFIX, 'status', '--porcelain=v1', '-z', '-uall', ...extraArgs],
      {
        cwd,
        // A large working tree can exceed the 1 MB default and would otherwise
        // reject with ENOBUFS. Above this it still fails loudly (see below) —
        // it never degrades into a short list, which would read as low drift.
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (error) {
    // Distinguish "no repository here" from "the repository is here and the
    // command broke". Reporting the second as the first tells the agent this
    // tool does not apply, and it stops checking.
    if (await isGitRepo(cwd)) throw new GitCommandFailedError('status', cwd, error);
    throw new NotAGitRepoError(cwd, error);
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

function parseStatusPaths(stdout: string): string[] {
  const fields = stdout.split('\0');
  const files = new Set<string>();

  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // The trailing NUL yields a final empty field; short entries cannot carry
    // the "XY<space>" prefix plus a path and are not something git emits.
    if (entry.length < 4) continue;

    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    files.add(entry.slice(3));

    // A rename or copy emits its ORIGINAL path as a separate NUL-terminated
    // field right after the entry. Both paths count as touched: the old one
    // vanished from the tree and the new one appeared, and a lock claiming
    // either has a stake in the change.
    if (
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      worktreeStatus === 'R' ||
      worktreeStatus === 'C'
    ) {
      i += 1;
      const original = fields[i];
      if (original) files.add(original);
    }
  }

  return [...files].sort();
}

/**
 * Returns every path touched by a commit on HEAD at or after `since`, as
 * repository-root-relative paths, de-duplicated and sorted.
 *
 * WHY THIS EXISTS AT ALL, and why drift is wrong without it: `git status`
 * reports the working tree and index against HEAD, so **work already
 * committed is invisible to it**. An agent that commits as it goes — the
 * normal way a branch grows, and the very scenario scope drift was built to
 * catch — would otherwise get `changedFileCount: 0` and a clean bill of
 * health from a tool whose whole purpose is to notice that its scope no
 * longer covers its work. Verified: after `git commit` of a file outside the
 * scope, `git status --porcelain` prints nothing at all.
 *
 * `since` is normally the lock's `created` timestamp, which makes this "what
 * has this branch committed since the work was claimed" — an over-inclusive
 * answer on a branch that also received someone else's commits, and
 * deliberately so: over-reporting drift costs an unnecessary widening, while
 * under-reporting it is the original bug.
 *
 * THE `Z` ON THE TIMESTAMP IS LOAD-BEARING. Given a bare `2026-09-01T16:27:42`,
 * git interprets it in the machine's LOCAL zone. Lock timestamps are UTC, so
 * west of Greenwich the cutoff lands in the future and `git log` matches
 * nothing — returning an empty list that is indistinguishable from "no commits
 * since the claim", i.e. reintroducing exactly the false-clean this function
 * exists to remove. Reproduced on a UTC-4 machine while writing this.
 */
export async function listCommittedFilesSince(
  cwd: string,
  since: Date,
  /** When given, restrict to commits NOT reachable from this sha — i.e. those that genuinely postdate it. */
  notReachableFrom?: string,
): Promise<string[]> {
  const sinceUtc = since.toISOString();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        ...SAFE_GIT_PREFIX,
        'log',
        '-z',
        '--name-only',
        '--pretty=format:',
        `--since=${sinceUtc}`,
        ...(notReachableFrom ? [`^${notReachableFrom}`] : []),
        'HEAD',
      ],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (error) {
    // A repository with no commits yet has no HEAD to walk. That is "nothing
    // committed", not a failure — but any OTHER git failure must surface,
    // never degrade into a silently empty (and therefore falsely clean) list.
    if (await hasNoCommits(cwd)) return [];
    if (await isGitRepo(cwd)) throw new GitCommandFailedError('log', cwd, error);
    throw new NotAGitRepoError(cwd, error);
  }

  // NUL-separated paths, with an extra empty field between commits (produced
  // by the empty --pretty=format:). Paths arrive raw — -z disables git's
  // C-style quoting, so a name with a space or a non-ASCII byte is intact.
  const files = new Set(stdout.split('\0').filter((name) => name !== ''));
  return [...files].sort();
}

/** True when `cwd`'s repository has no commits yet (so HEAD cannot be resolved). */
async function hasNoCommits(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    return false;
  } catch {
    return true;
  }
}

/**
 * The current HEAD commit sha, or null when the repository has none yet.
 *
 * Recorded at lock_create so drift can tell a commit that PREDATES the claim from
 * one that followed it. Timestamps cannot: `created` has one-second resolution, so
 * a commit stamped in the same second as the claim is unorderable against it and
 * `--since` (which is inclusive at the boundary — verified) counts it as "since".
 *
 * Returns null rather than throwing on a repository with no commits: that is a real
 * state (`git rev-parse HEAD` -> "fatal: Needed a single revision"), and a lock is
 * perfectly valid there. The field is optional everywhere downstream.
 */
export async function resolveHeadSha(cwd: string = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * True when `ancestor` is an ancestor of `descendant` (or the same commit).
 *
 * Returns FALSE when either sha is unreachable — after a rebase, an amend, or a
 * dropped branch, the sha recorded on a lock may no longer exist. That is not an
 * error here: a filter that cannot prove a commit predates the claim must not
 * suppress it, so an unknown sha degrades to today's behaviour rather than to a
 * silently smaller result.
 */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared implementation for resolveLocksRoot — runs `git rev-parse
 * --git-common-dir` and returns the realpath'd (canonical) directory.
 */
async function getRealGitCommonDir(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd }));
  } catch (error) {
    throw new NotAGitRepoError(cwd, error);
  }
  const gitCommonDir = stdout.trim();
  // git may return a path relative to `cwd` (e.g. ".git") or an absolute
  // path, depending on git version and whether cwd is the repo root.
  // path.resolve is a no-op if gitCommonDir is already absolute.
  const absoluteGitCommonDir = path.resolve(cwd, gitCommonDir);
  // Canonicalize so the same real directory always yields the same string,
  // regardless of which symlink form `cwd` or git's own answer happened to
  // use (see the module doc comment above). The directory is known to exist
  // — `git rev-parse --git-common-dir` just succeeded against it — so a
  // realpath failure here would indicate something removed it out from
  // under us mid-call; surface that rather than silently falling back to
  // the unresolved path, which would reintroduce the very bug this fixes.
  const realGitCommonDir = await fs.realpath(absoluteGitCommonDir);
  return realGitCommonDir;
}
