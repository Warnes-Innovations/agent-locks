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
