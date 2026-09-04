import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkScopeDrift } from '../lock/drift.js';
import { listChangedFiles, NotAGitRepoError } from '../git.js';
import { createLock, finishLock, LockNotFoundError, updateLock } from '../lock/store.js';
import { resolveLocksRoot, resolveRepoRoot } from '../git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Pin fixture commit dates to the distant past. Drift counts files touched
    // by commits made AT OR AFTER the lock's `created` second, and lock
    // timestamps are second-granular — so a setup commit made in the same
    // second as the claim legitimately counts as "committed since the claim".
    // Dating the fixture's history explicitly is what keeps each test about the
    // thing it is testing; a sleep would only make the flake rarer.
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
  return stdout.trim();
}

/** Commits with a REAL (now) timestamp — for tests that need "committed since the claim". */
async function gitCommitNow(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

let sandbox: string;
let repo: string;
let locksRoot: string;
let repoRoot: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-locks-drift-test-'));
  repo = path.join(sandbox, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main', '.']);
  await git(repo, ['config', 'user.email', 'test@test.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await fs.mkdir(path.join(repo, 'auth'), { recursive: true });
  await fs.writeFile(path.join(repo, 'auth', 'oauth_config.py'), 'x = 1\n');
  await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 1\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  locksRoot = await resolveLocksRoot(repo);
  repoRoot = await resolveRepoRoot(repo);
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function claim(scope: string[]): Promise<string> {
  const { id } = await createLock(locksRoot, {
    title: 'Session A work',
    scope,
    tasks: ['task one'],
    repository: repoRoot,
  });
  return id;
}

describe('listChangedFiles', () => {
  it('reports staged, unstaged and untracked paths alike, repo-root-relative and sorted', async () => {
    await fs.writeFile(path.join(repo, 'auth', 'oauth_config.py'), 'x = 2\n'); // unstaged edit
    await fs.writeFile(path.join(repo, 'staged.py'), 'z = 1\n');
    await git(repo, ['add', 'staged.py']); // staged add
    await fs.writeFile(path.join(repo, 'untracked.py'), 'w = 1\n'); // untracked

    expect(await listChangedFiles(repo)).toEqual([
      'auth/oauth_config.py',
      'staged.py',
      'untracked.py',
    ]);
  });

  it('expands an untracked DIRECTORY into its files, not a single "dir/" entry', async () => {
    // git's default collapses a new directory to `newpkg/`, which matches a
    // glob differently than the real files under it do — and a brand-new
    // directory of files is exactly the shape scope drift takes.
    await fs.mkdir(path.join(repo, 'newpkg'), { recursive: true });
    await fs.writeFile(path.join(repo, 'newpkg', 'a.py'), 'a\n');
    await fs.writeFile(path.join(repo, 'newpkg', 'b.py'), 'b\n');

    expect(await listChangedFiles(repo)).toEqual(['newpkg/a.py', 'newpkg/b.py']);
  });

  it('counts BOTH paths of a rename', async () => {
    await git(repo, ['mv', 'mcp_ctl.py', 'ctl.py']);
    expect(await listChangedFiles(repo)).toEqual(['ctl.py', 'mcp_ctl.py']);
  });

  it('does not mangle a path containing a space or a quote', async () => {
    // Without -z, git C-quotes such paths, and the mangled form would be
    // compared against the lock's globs — reporting an in-scope file as drift.
    await fs.writeFile(path.join(repo, 'a file with spaces.py'), 'q\n');
    const changed = await listChangedFiles(repo);
    expect(changed).toContain('a file with spaces.py');
    expect(changed.some((f) => f.startsWith('"'))).toBe(false);
  });

  it('reports a clean tree as no changed files', async () => {
    expect(await listChangedFiles(repo)).toEqual([]);
  });

  it('raises NotAGitRepoError outside a repository rather than reporting zero drift', async () => {
    const notARepo = path.join(sandbox, 'not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });
    await expect(listChangedFiles(notARepo)).rejects.toThrow(NotAGitRepoError);
  });
});

describe('checkScopeDrift', () => {
  it('lists exactly the changed files the scope does not cover', async () => {
    const id = await claim(['auth/**']);
    await fs.writeFile(path.join(repo, 'auth', 'oauth_config.py'), 'x = 2\n');
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 2\n');

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });

    expect(result.changedFileCount).toBe(2);
    expect(result.inScopeCount).toBe(1);
    expect(result.outOfScope).toEqual(['mcp_ctl.py']);
    expect(result.drifted).toBe(true);
    expect(result.scope).toEqual(['auth/**']);
  });

  it('reports no drift once the scope has been amended to cover the grown work', async () => {
    const id = await claim(['auth/**']);
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 2\n');
    expect((await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo })).drifted).toBe(true);

    await updateLock(locksRoot, { lock_id: id, add_scope: ['mcp_ctl.py'] });

    const after = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(after.drifted).toBe(false);
    expect(after.outOfScope).toEqual([]);
  });

  it('does not call a clean tree "no drift" — nothing was measured, and it says so', async () => {
    const id = await claim(['auth/**']);
    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.changedFileCount).toBe(0);
    // `drifted: false` on an empty comparison reads as good news and is not.
    expect(result.outcome).toBe('NOTHING_MEASURED');
    expect(result.warnings.join('\n')).toContain('Nothing was compared');
  });

  /**
   * The defect three independent reviewers converged on, pinned.
   *
   * `git status` reports the working tree against HEAD, so work already
   * COMMITTED is invisible to it — and committing as you go is how a branch
   * normally grows. Before this was fixed, an agent that committed its grown
   * work got `drifted: false` from the one tool built to catch exactly that,
   * at exactly the moment the instructions say to run it ("before you finish").
   */
  it('sees work that has already been COMMITTED since the lock was claimed', async () => {
    const id = await claim(['auth/**']);

    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'grown\n');
    await gitCommitNow(repo, ['add', '.']);
    await gitCommitNow(repo, ['commit', '-q', '-m', 'work grew into mcp_ctl.py']);

    // The working tree is now clean; only the commit records the growth.
    expect(await listChangedFiles(repo)).toEqual([]);

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.uncommittedCount).toBe(0);
    expect(result.committedSinceClaimCount).toBeGreaterThan(0);
    expect(result.outOfScope).toContain('mcp_ctl.py');
    expect(result.drifted).toBe(true);
  });

  it('reports how many files git ignores, so a clean result carries its own bound', async () => {
    const id = await claim(['auth/**']);
    await fs.writeFile(path.join(repo, '.gitignore'), 'secrets.env\n');
    await fs.writeFile(path.join(repo, 'secrets.env'), 'TOKEN=x\n');

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.ignoredFilesNotExamined).toBeGreaterThan(0);
    expect(result.warnings.join('\n')).toContain('ignored by git and were NOT examined');
    // The ignored file itself is invisible to the comparison — that is the
    // bound being disclosed, not a bug.
    expect(result.outOfScope).not.toContain('secrets.env');
  });

  it('warns whenever the repository has more than one worktree, independently of the lock\'s own record', async () => {
    // The `lockCreatedIn !== inspectedWorktree` guard compares two values
    // derived from the SAME cwd, so it detects the caller varying the input
    // between calls and is blind to that input being wrong both times. This
    // signal comes from `git worktree list` instead, so it fires where the
    // other cannot.
    const id = await claim(['auth/**']);
    await git(repo, ['worktree', 'add', '-q', '-b', 'side', path.join(sandbox, 'side')]);

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.warnings.join('\n')).toContain('worktrees');
  });

  /**
   * The invariant that makes drift worth trusting: it must agree with
   * lock_check_conflict, because the question it really answers is "would
   * another agent's conflict check see my lock for this file?" A scope of
   * `auth` (a bare directory, no wildcard) DOES overlap `auth/oauth_config.py`
   * under globOverlap's prefix heuristic, so drift must not report that file —
   * a stricter matcher here would flag files the conflict check does surface,
   * which is noise that teaches agents to ignore the tool.
   */
  it('uses the same matcher as the conflict check, including its over-inclusive prefix rule', async () => {
    const id = await claim(['auth']);
    await fs.writeFile(path.join(repo, 'auth', 'oauth_config.py'), 'x = 2\n');

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.outOfScope).toEqual([]);
  });

  it('does not run a repository-supplied core.fsmonitor command', async () => {
    // `git status` EXECUTES core.fsmonitor from the target repo's own config,
    // and base_dir lets a caller name any directory — so without hardening,
    // "check drift there" is "run whatever that repo's config says". The
    // pre-existing rev-parse calls never had this reach; the content-reading
    // calls introduced it. Verified failing before SAFE_GIT_PREFIX existed.
    const id = await claim(['auth/**']);
    const marker = path.join(sandbox, 'payload-ran.txt');
    const payload = path.join(sandbox, 'payload.sh');
    await fs.writeFile(payload, `#!/bin/sh\necho ran > ${marker}\nexit 1\n`);
    await fs.chmod(payload, 0o755);
    await git(repo, ['config', 'core.fsmonitor', payload]);

    await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });

    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('warns when the lock was created in a different worktree than the one inspected', async () => {
    const { id } = await createLock(locksRoot, {
      title: 'Someone else\'s lock',
      scope: ['auth/**'],
      tasks: [],
      repository: '/some/other/worktree',
    });
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 2\n');

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.lockCreatedIn).toBe('/some/other/worktree');
    expect(result.inspectedWorktree).toBe(repoRoot);
    expect(result.warnings.join('\n')).toContain('/some/other/worktree');
    expect(result.warnings.join('\n')).toContain('not the ones the lock\'s owner is editing');
  });

  it('warns when the lock predates the repository field, instead of implying the comparison is sound', async () => {
    const { id } = await createLock(locksRoot, { title: 'Old lock', scope: ['auth/**'], tasks: [] });
    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.warnings.join('\n')).toContain('predates');
  });

  it('warns that amending a finished lock changes nothing', async () => {
    const id = await claim(['auth/**']);
    await finishLock(locksRoot, { lock_id: id });
    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.warnings.join('\n')).toContain('already done');
  });

  it('keeps outcome a MEASUREMENT, separate from whether the answer is reliable', async () => {
    // Folding reliability into `outcome` made it a constant in exactly this
    // tool's own deployment: the multi-worktree warning fires on any repo with
    // more than one worktree, so outcome could never be DRIFTED or COVERED.
    const id = await claim(['auth/**']);
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 2\n');
    await git(repo, ['worktree', 'add', '-q', '-b', 'side2', path.join(sandbox, 'side2')]);

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.outcome).toBe('DRIFTED');
    expect(result.reliable).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('says so when a scope is so broad the check cannot fail', async () => {
    // `**/*.ts` matches every path under the shared conflict matcher, so peers
    // really do see the lock for any file — not a matcher bug. But a COVERED
    // from a check that could not have failed must not read as evidence.
    const id = await claim(['**/*.ts']);
    await fs.writeFile(path.join(repo, 'docs.md'), 'doc\n');

    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.outOfScope).toEqual([]);
    expect(result.warnings.join('\n')).toContain('match every');
    expect(result.reliable).toBe(false);
  });

  it('errors clearly on an unknown lock id', async () => {
    await expect(checkScopeDrift(locksRoot, { lock_id: 'nope', cwd: repo })).rejects.toThrow(LockNotFoundError);
  });

  it('never mutates the lock — it is a read, like every other query in this tool', async () => {
    const id = await claim(['auth/**']);
    const before = await fs.readFile(path.join(locksRoot, `${id}.md`), 'utf8');
    await fs.writeFile(path.join(repo, 'mcp_ctl.py'), 'y = 2\n');
    await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(await fs.readFile(path.join(locksRoot, `${id}.md`), 'utf8')).toBe(before);
  });

  it('carries the scope-check prompt so the amend instruction is right there with the finding', async () => {
    const id = await claim(['auth/**']);
    const result = await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo });
    expect(result.scopeCheck).toContain('`auth/**`');
    expect(await checkScopeDrift(locksRoot, { lock_id: id, cwd: repo, dialect: 'cli' })).toHaveProperty(
      'scopeCheck',
      expect.stringContaining('--add-scope'),
    );
  });
});
