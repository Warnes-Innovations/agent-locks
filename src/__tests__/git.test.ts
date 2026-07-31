import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotAGitRepoError, resolveLocksRoot, resolveRepoRoot } from '../git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-git-test-'));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('resolveLocksRoot', () => {
  it('rejects with NotAGitRepoError when cwd is not inside a git repository', async () => {
    const plainDir = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(plainDir, { recursive: true });
    await expect(resolveLocksRoot(plainDir)).rejects.toThrow(NotAGitRepoError);
  });

  it('resolves to <git-common-dir>/agents-locks for a plain (non-worktree) repository', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const locksRoot = await resolveLocksRoot(repo);
    // Compare against the REALPATH'd repo, not `repo` itself: on platforms
    // where the OS temp dir is reached through a symlink (e.g. macOS's
    // /tmp -> /private/tmp), resolveLocksRoot canonicalizes its answer (see
    // src/git.ts), so the raw `repo` string built from `sandbox` would not
    // match even though it refers to the same real directory.
    const realRepo = await fs.realpath(repo);
    expect(locksRoot).toBe(path.join(realRepo, '.git', 'agents-locks'));
  });

  it('resolves to the SAME path from a linked worktree as from the main worktree ' +
    '(the entire point of using --git-common-dir instead of --git-dir)', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const linkedWorktree = path.join(sandbox, 'linked');
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature-x', linkedWorktree]);

    // Sanity check the premise: the linked worktree's own .git is a FILE
    // (not a directory) pointing back at the main repo's .git/worktrees/...
    const linkedDotGitStat = await fs.stat(path.join(linkedWorktree, '.git'));
    expect(linkedDotGitStat.isFile()).toBe(true);
    const linkedDotGitContents = await fs.readFile(path.join(linkedWorktree, '.git'), 'utf8');
    expect(linkedDotGitContents).toMatch(/^gitdir: /);

    // --git-dir differs per worktree (this is why using it would be wrong for this tool)...
    const mainGitDir = await git(repo, ['rev-parse', '--git-dir']);
    const linkedGitDir = await git(linkedWorktree, ['rev-parse', '--git-dir']);
    expect(path.resolve(repo, mainGitDir)).not.toBe(path.resolve(linkedWorktree, linkedGitDir));

    // ...but --git-common-dir (what resolveLocksRoot actually uses) is identical from both.
    const locksRootFromMain = await resolveLocksRoot(repo);
    const locksRootFromLinked = await resolveLocksRoot(linkedWorktree);
    expect(locksRootFromLinked).toBe(locksRootFromMain);
    // See the sibling test above for why this compares against the
    // REALPATH'd repo rather than `repo` itself.
    const realRepo = await fs.realpath(repo);
    expect(locksRootFromMain).toBe(path.join(realRepo, '.git', 'agents-locks'));
  });

  it('is not resolved once and cached — it is safe to call repeatedly and get a fresh answer each time', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    const first = await resolveLocksRoot(repo);
    const second = await resolveLocksRoot(repo);
    expect(first).toBe(second);
  });
});

describe('resolveRepoRoot', () => {
  it('rejects with NotAGitRepoError when cwd is not inside a git repository', async () => {
    const plainDir = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(plainDir, { recursive: true });
    await expect(resolveRepoRoot(plainDir)).rejects.toThrow(NotAGitRepoError);
  });

  it('returns the repository root from --show-toplevel', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const repoRoot = await resolveRepoRoot(repo);
    const realRepo = await fs.realpath(repo);
    expect(repoRoot).toBe(realRepo);
  });

  it('returns each worktree\'s own root — linked worktrees differ from main (--show-toplevel is per-worktree)', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const linkedWorktree = path.join(sandbox, 'linked');
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature-x', linkedWorktree]);

    const mainRoot = await resolveRepoRoot(repo);
    const linkedRoot = await resolveRepoRoot(linkedWorktree);
    const realRepo = await fs.realpath(repo);
    const realLinked = await fs.realpath(linkedWorktree);
    // --show-toplevel returns the worktree's own root, not the shared repo root
    expect(mainRoot).toBe(realRepo);
    expect(linkedRoot).toBe(realLinked);
    expect(linkedRoot).not.toBe(mainRoot); // they are genuinely different paths
  });
});

describe('the agents-locks directory can never enter the tracked working tree (safety mechanism)', () => {
  it('git add on a path under .git/agents-locks is a silent no-op, not an error, and never appears in the index', async () => {
    const repo = path.join(sandbox, 'main');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'main', '.']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const locksRoot = await resolveLocksRoot(repo);
    await fs.mkdir(locksRoot, { recursive: true });
    await fs.writeFile(path.join(locksRoot, 'some-lock.md'), '---\nid: x\n---\n# x\n');

    // git add does not throw...
    await expect(git(repo, ['add', path.join(locksRoot, 'some-lock.md')])).resolves.toBeDefined();
    // ...but nothing was actually staged, because paths under .git/ cannot
    // be represented in the working tree/index at all.
    const status = await git(repo, ['status', '--porcelain']);
    expect(status).toBe('');
    const lsFiles = await git(repo, ['ls-files']);
    expect(lsFiles).not.toContain('some-lock.md');
  });
});
