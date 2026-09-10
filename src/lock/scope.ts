/**
 * Module: the lock `scope` field — normalization, amendment, and the check
 * prompt echoed back on every scope-touching operation.
 *
 * WHY SCOPE IS MUTABLE AT ALL. `scope` is declared at lock_create, which is
 * the moment the agent knows LEAST about what it will end up touching. Work
 * legitimately grows: a lock created for `auth/**` ends up spanning eight
 * packages. When scope cannot be amended, it drifts away from reality while
 * the lock still reads as active and healthy — and because
 * lock_check_conflict and lock_query's scope filter both match against those
 * original globs, a lock whose footprint has grown silently stops protecting
 * the files it grew into. Another agent then runs exactly the query this
 * server's instructions tell it to run, sees no overlap, and edits the same
 * files.
 *
 * That is not a discipline failure to be exhorted away — it is the expected
 * outcome of an immutable field set at the point of least information. So the
 * remedy is mechanical: scope can be amended (below), the amendment is
 * recorded rather than overwritten (see `ScopeAmendment`), and the current
 * scope is printed back on every create/update so it stays in front of the
 * agent rather than being written once and never seen again.
 */

/**
 * One retired scope, recorded when the lock's scope was amended.
 *
 * `scope` is the value as it stood BEFORE the amendment — so an entry means
 * "these were the globs claimed until `replaced_at`". Combined with the
 * frontmatter's `created` and its current `scope`, the entries reconstruct
 * the full interval history of what this lock claimed and when. Recording the
 * retired value rather than the new one is what makes that reconstruction
 * possible from the file alone: the new value of the last amendment is
 * already the live `scope` field, so recording new values would duplicate it
 * and lose the original.
 */
export interface ScopeAmendment {
  /** UTC timestamp (timestamp.ts format) at which the scope below was replaced. */
  replaced_at: string;
  /** The scope as it stood before that amendment. */
  scope: string[];
}

export class ScopeAmendmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeAmendmentError';
  }
}

/**
 * Raised when a scope would end up claiming nothing — at lock_create, or via
 * an amendment that replaces the scope with an empty/whitespace-only list.
 *
 * This is refused rather than accepted-and-stored because an empty scope is
 * worse than no lock at all: the lock still appears in lock_query as an
 * active claim, while matching no file in lock_check_conflict. It reads as
 * protection and provides none.
 */
export class EmptyScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyScopeError';
  }
}

/**
 * Trims each pattern, drops empty ones, and de-duplicates while preserving
 * first-occurrence order.
 *
 * Trimming is deliberate rather than pedantic: a glob carrying stray
 * whitespace matches nothing, so storing it verbatim would produce a lock
 * that claims a file it can never be matched against — the exact silent
 * failure this whole module exists to remove.
 */
export function normalizeScope(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === '') continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** Element-wise equality. Order counts: a reorder is a real (if cosmetic) change, and recording it is honest. */
export function scopesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((pattern, i) => pattern === b[i]);
}

export interface ScopeAmendmentRequest {
  /**
   * Replace the lock's scope wholesale. Mutually exclusive with `add_scope`.
   *
   * NAMED `set_scope`, NOT `scope`, and the difference is a safety property rather
   * than taste. `scope` is what lock_create calls the WHOLE CLAIM, so an agent
   * copying its create arguments into an update would silently replace the claim it
   * had been widening — a destructive operation reached by a copy-paste that looks
   * like a no-op. The CLI flag was `--set-scope` from the start; this aligns the MCP
   * surface with it. Renamed before first release, so no caller ever saw `scope`.
   */
  set_scope?: string[];
  /** Add globs to the lock's existing scope. Mutually exclusive with `set_scope`. */
  add_scope?: string[];
}

export interface AppliedScopeAmendment {
  /** The scope after the amendment (normalized). Equal to the input when nothing was requested. */
  next: string[];
  /** True only when `next` actually differs from the current scope. */
  changed: boolean;
  /**
   * Globs the amendment REMOVED — always empty for `add_scope`, potentially
   * non-empty for a `set_scope` replacement.
   *
   * Narrowing is a legitimate operation (it is how a lock that over-claimed
   * stops blocking others) but it is the only amendment that takes protection
   * AWAY, and it does so while leaving the lock reading as active and healthy.
   * Callers need to be able to tell the two apart to say so; without this they
   * cannot, and a narrowing is reported in exactly the same words as a widening.
   */
  removed: string[];
}

/**
 * Computes the amended scope without touching disk.
 *
 * Passing both `set_scope` and `add_scope` is rejected rather than resolved in
 * some defined order: "replace with A, then also add B" is a request nobody
 * means to make, and picking an order for it would silently produce a scope
 * the caller did not ask for. An amendment that no-ops (adding a glob already
 * claimed) reports `changed: false` so no empty history entry is recorded and
 * lock_update stays idempotent.
 */
export function applyScopeAmendment(
  current: readonly string[],
  request: ScopeAmendmentRequest,
): AppliedScopeAmendment {
  const wantsReplace = request.set_scope !== undefined;
  const wantsAdd = request.add_scope !== undefined;

  if (wantsReplace && wantsAdd) {
    throw new ScopeAmendmentError(
      'Pass at most one of set_scope (replace the whole claim) / add_scope (widen the existing claim), not both. ' +
        'Applying them together would require guessing an order, and would produce a scope you did not ask for.',
    );
  }

  if (!wantsReplace && !wantsAdd) {
    return { next: [...current], changed: false, removed: [] };
  }

  const currentNormalized = normalizeScope(current);
  let next: string[];

  if (wantsReplace) {
    next = normalizeScope(request.set_scope as string[]);
    if (next.length === 0) {
      throw new EmptyScopeError(
        'set_scope must contain at least one non-empty glob pattern. A lock claiming nothing is worse than no lock at all: ' +
          'it still reads as an active claim in lock_query while matching no file in lock_check_conflict. ' +
          'To narrow a lock, pass the globs you are actually still touching; to give up the claim entirely, call lock_finish.',
      );
    }
  } else {
    const additions = normalizeScope(request.add_scope as string[]);
    if (additions.length === 0) {
      throw new ScopeAmendmentError(
        'add_scope must contain at least one non-empty glob pattern (an empty or whitespace-only list amends nothing).',
      );
    }
    next = normalizeScope([...currentNormalized, ...additions]);
  }

  const removed = currentNormalized.filter((pattern) => !next.includes(pattern));
  return { next, changed: !scopesEqual(currentNormalized, next), removed };
}

/** Which command names to use in the check prompt — an agent calls MCP tools, a human runs the CLI. */
export type ScopeCheckDialect = 'mcp' | 'cli';

function formatPatterns(scope: readonly string[]): string {
  if (scope.length === 0) return '(none)';
  return scope.map((pattern) => `\`${pattern}\``).join(', ');
}

/**
 * The prompt printed alongside the scope on every scope-touching result.
 *
 * DO NOT soften the final sentence into a reminder ("remember to keep scope
 * up to date"). It names a CONSEQUENCE on purpose: an agent that knows an
 * unamended scope makes its work invisible to its peers has a reason to act,
 * whereas one asked politely to remember does not. The observed failure rate
 * of the polite form was 100%.
 */
export function formatScopeCheck(
  scope: readonly string[],
  dialect: ScopeCheckDialect = 'mcp',
  lockId?: string,
): string {
  if (dialect === 'mcp') {
    return (
      `Scope claimed: ${formatPatterns(scope)}. ` +
      'Does this still match what you are touching? Compare it against `git status --porcelain` / ' +
      '`git diff --name-only`, or call lock_check_drift, which does that comparison for you. ' +
      "If you are writing outside this scope, amend it now with lock_update's add_scope (widen) or set_scope (replace) — " +
      'lock_check_conflict matches these globs, so every file outside them is invisible to any other agent looking for a conflict.'
    );
  }

  // The CLI reader is a human at a terminal, so every command named here has
  // to be one they can actually run — and, where we know it, with the real
  // lock id already filled in rather than a `<lock-id>` they must go and look
  // up. A prompt whose whole purpose is to make the right action mechanical
  // should not hand back homework.
  const id = lockId ?? '<lock-id>';
  return (
    `Scope claimed: ${formatPatterns(scope)}. ` +
    'Does this still match what you are touching? Compare it against `git status --porcelain` / ' +
    `\`git diff --name-only\`, or run \`agent-locks drift ${id}\`, which does that comparison for you. ` +
    `If you are writing outside this scope, amend it now with \`agent-locks update ${id} --add-scope <glob>\` ` +
    `(or \`--set-scope <glob>...\` to narrow an over-claim) — \`agent-locks check <glob>\` matches these globs, ` +
    'so every file outside them is invisible to any other agent looking for a conflict.'
  );
}
