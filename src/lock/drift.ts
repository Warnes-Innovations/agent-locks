/**
 * Module: scope-drift detection — "is this lock still claiming what I am
 * actually editing?"
 *
 * Points 2 and 3 of the design (echo the scope, prompt the agent to re-derive
 * it) make the right behaviour VISIBLE. This module makes it AUTOMATIC, which
 * is the part that survives contact with a busy session: guidance that depends
 * on being remembered has a failure rate, and the observed one for scope was
 * total. Here the tool does the comparison and reports the difference, so
 * noticing drift stops being something an agent must think to do.
 */
import {
  countIgnoredFiles,
  countWorktrees,
  listChangedFiles,
  listCommittedFilesSince,
  resolveRepoRoot,
} from '../git.js';
import { parseTimestamp } from '../timestamp.js';
import { scopesOverlap, staticPrefix } from './globOverlap.js';
import { formatScopeCheck } from './scope.js';
import type { ScopeCheckDialect } from './scope.js';
import { findLockById, LockNotFoundError } from './store.js';

export interface ScopeDriftResult {
  lock_id: string;
  title: string;
  /** The globs the lock currently claims. */
  scope: string[];
  /** Repository/worktree root the changed files were read from. */
  inspectedWorktree: string;
  /** Repository/worktree root recorded on the lock at creation. Empty for locks predating that field. */
  lockCreatedIn: string;
  /**
   * Total distinct paths compared against the scope — uncommitted plus
   * committed-since-claim. Always read this alongside `outOfScope`: an
   * `outOfScope: []` on a `changedFileCount: 0` means nothing was measured,
   * not that the scope is right.
   */
  changedFileCount: number;
  /** Of those, how many came from `git status` (staged, unstaged, untracked). */
  uncommittedCount: number;
  /** Of those, how many came from commits on HEAD at or after the lock's `created` timestamp. */
  committedSinceClaimCount: number;
  /** How many of those the lock's scope already covers. */
  inScopeCount: number;
  /** Files git ignores, and which drift therefore could not examine at all. Read this before trusting a clean result. */
  ignoredFilesNotExamined: number;
  /** Every touched path the scope does NOT cover — the drift itself. Capped; see `outOfScopeTruncated`. */
  outOfScope: string[];
  /** Total count of out-of-scope paths, which may exceed `outOfScope.length`. */
  outOfScopeCount: number;
  /** How many out-of-scope paths were omitted from the list above. Zero normally. */
  outOfScopeTruncated: number;
  /**
   * What this check established. Prefer it over `drifted`, which cannot
   * distinguish "the scope covers the work" from "nothing was measured".
   *
   * - `DRIFTED`          — files were compared and some fall outside the scope.
   * - `COVERED`          — files were compared and all fall inside it.
   * - `NOTHING_MEASURED` — no files were compared. Says nothing about the scope.
   *
   * Reliability is deliberately NOT one of these values. Folding it in made the
   * field a constant in exactly the deployment this tool is for: the
   * multi-worktree warning fires on any repo with more than one worktree, so
   * `outcome` could never be DRIFTED or COVERED there — a measurement field
   * that stops varying, reintroduced by the code written to stop one state
   * borrowing another's meaning. Reliability is orthogonal to the measurement;
   * read `reliable` and `warnings` alongside this, not instead of it.
   */
  outcome: 'DRIFTED' | 'COVERED' | 'NOTHING_MEASURED';
  /** False when a warning means this answer may not be about your work. Orthogonal to `outcome`. */
  reliable: boolean;
  /** True when `outOfScope` is non-empty. Kept for convenience; `outcome` is the honest field. */
  drifted: boolean;
  /** Conditions that make the result above mean less than it appears to. Never empty-checked away; read them. */
  warnings: string[];
  scopeCheck: string;
}

/**
 * Reports which of the working tree's changed files fall outside a lock's
 * claimed scope.
 *
 * THE MATCHER HERE IS DELIBERATELY `scopesOverlap`, THE SAME ONE
 * lock_check_conflict USES — do not "fix" this to a direct minimatch call
 * against each file. The question drift actually answers is not the abstract
 * "does this glob match this path" but "would another agent's conflict check
 * on this file see my lock?" Those are only the same question while both use
 * the same matcher. Swap in a stricter one and drift starts reporting files as
 * uncovered that lock_check_conflict does in fact surface (noise, which
 * teaches agents to ignore the tool); swap in a looser one and it clears files
 * that conflict checks miss (silence, which is the original bug). Sharing the
 * matcher makes the two answers unable to disagree, and inherits
 * globOverlap.ts's deliberate over-inclusion bias along with it.
 */
export async function checkScopeDrift(
  locksRoot: string,
  params: { lock_id: string; cwd?: string; dialect?: ScopeCheckDialect },
): Promise<ScopeDriftResult> {
  const record = await findLockById(locksRoot, params.lock_id);
  if (!record) throw new LockNotFoundError(params.lock_id);

  const cwd = params.cwd ?? process.cwd();
  // Both halves of "what am I touching". `git status` alone would miss every
  // file already committed on this branch — see listCommittedFilesSince.
  const claimedAt = parseTimestamp(record.frontmatter.created);
  const [uncommitted, committed, inspectedWorktree, ignoredFilesNotExamined, worktreeCount] =
    await Promise.all([
      listChangedFiles(cwd),
      listCommittedFilesSince(cwd, claimedAt),
      resolveRepoRoot(cwd),
      countIgnoredFiles(cwd),
      countWorktrees(cwd),
    ]);
  const changed = [...new Set([...uncommitted, ...committed])].sort();

  const scope = record.frontmatter.scope ?? [];
  const outOfScope: string[] = [];
  let inScopeCount = 0;
  for (const file of changed) {
    if (scopesOverlap([file], scope)) inScopeCount += 1;
    else outOfScope.push(file);
  }

  const lockCreatedIn = record.frontmatter.repository ?? '';
  const warnings: string[] = [];
  // THE WRONG-WORKTREE WARNING BELOW CANNOT STAND ALONE, and this one is why.
  // `lockCreatedIn` was recorded from `base_dir ?? process.cwd()` and
  // `inspectedWorktree` is that same expression re-evaluated now — two operands
  // from one unverified source. That comparison detects the caller VARYING the
  // input between calls; it is structurally blind to the input being wrong both
  // times, which is the likelier failure: a stdio server whose cwd is worktree A
  // while the agent is really editing worktree B sees both operands equal A,
  // stays silent, and reports B's untouched-looking tree as clean. `git worktree
  // list` is an independent signal, so this fires exactly where that guard cannot.
  if (worktreeCount > 1) {
    warnings.push(
      `This repository has ${worktreeCount} worktrees, and drift was computed against ${inspectedWorktree}. ` +
        'If you are editing a different one, the files below are not your files and a clean result here means nothing — ' +
        'agent-locks cannot tell which worktree a tool call came from, so pass base_dir to name yours explicitly.',
    );
  }
  if (ignoredFilesNotExamined > 0) {
    warnings.push(
      `${ignoredFilesNotExamined} file(s) are ignored by git and were NOT examined. If your work includes any of them ` +
        '(a .env, a generated config, anything under an ignored build directory), this check cannot see it and cannot rule out drift in it.',
    );
  }
  if (lockCreatedIn === '') {
    warnings.push(
      'This lock predates the `repository` frontmatter field, so agent-locks cannot confirm it was created in ' +
        `the working tree just inspected (${inspectedWorktree}). If it was not, the changed files below are not the ones its owner is editing.`,
    );
  } else if (lockCreatedIn !== inspectedWorktree) {
    warnings.push(
      `This lock was created in ${lockCreatedIn}, but drift was computed against ${inspectedWorktree}. ` +
        'The changed files below are THIS working tree\'s, not the ones the lock\'s owner is editing — so a clean ' +
        'result here says nothing about whether their scope matches their work. Drift is only meaningful against your own lock, in your own worktree.',
    );
  }
  if (record.frontmatter.status !== 'active') {
    warnings.push(
      `This lock is already ${record.frontmatter.status}; amending the scope of finished work changes nothing about what other agents can see.`,
    );
  }
  // An empty compared set is the one result that reads like good news and is
  // not: "no drift" and "nothing was measured" render identically unless the
  // difference is said out loud. Never let this one be inferred from a count
  // the reader might not look at.
  if (changed.length === 0) {
    warnings.push(
      'Nothing was compared: this working tree has no uncommitted changes and no commits since the lock was created, ' +
        `so "no drift" here is not evidence the scope is right. If the work lives on commits made BEFORE ${record.frontmatter.created} ` +
        '(the moment this lock was claimed), compare the scope against `git diff --name-only <base>...HEAD` yourself.',
    );
  }

  // A scope pattern with an empty static prefix (`**/*.ts`, `{src,docs}/**`,
  // anything leading with a wildcard) matches EVERY path under the shared
  // conflict matcher. Such a claim is not wrong — peers really do see the lock
  // for any file, which is why this is not a matcher bug — but it makes drift
  // structurally unable to fire, and reporting a confident COVERED for a check
  // that could not have failed is the shape of a control nobody should trust.
  const vacuousPatterns = scope.filter((pattern) => staticPrefix(pattern) === '');
  if (vacuousPatterns.length > 0) {
    warnings.push(
      `Scope pattern(s) ${vacuousPatterns.map((p) => `\`${p}\``).join(', ')} begin with a wildcard, so they match every ` +
        'path in the repository. Drift cannot fail against them — a "covered" result here is a property of the pattern, ' +
        'not evidence about your work. Narrow the scope to the paths you are really touching if you want this check to mean anything.',
    );
  }

  // Bounded so one call cannot flood an agent's whole context with a million
  // paths from an un-ignored tree — but the omission is STATED, never silent.
  // A quietly clipped list would be a worse bug than an unbounded one: it would
  // under-report drift while looking complete.
  const MAX_LISTED = 200;
  const listed = outOfScope.slice(0, MAX_LISTED);
  const truncated = outOfScope.length - listed.length;
  if (truncated > 0) {
    warnings.push(
      `${truncated} further out-of-scope path(s) are not listed (the list is capped at ${MAX_LISTED}). ` +
        'outOfScopeCount carries the real total.',
    );
  }

  const drifted = outOfScope.length > 0;
  const outcome: ScopeDriftResult['outcome'] =
    changed.length === 0 ? 'NOTHING_MEASURED' : drifted ? 'DRIFTED' : 'COVERED';

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
    scopeCheck: formatScopeCheck(scope, params.dialect ?? 'mcp', record.frontmatter.id),
  };
}
