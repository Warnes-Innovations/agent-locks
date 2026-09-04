import { describe, expect, it } from 'vitest';
import {
  applyScopeAmendment,
  EmptyScopeError,
  formatScopeCheck,
  normalizeScope,
  ScopeAmendmentError,
  scopesEqual,
} from '../lock/scope.js';

describe('normalizeScope', () => {
  it('trims patterns, because a glob carrying whitespace matches nothing', () => {
    expect(normalizeScope([' src/**  ', '\tauth/*.ts'])).toEqual(['src/**', 'auth/*.ts']);
  });

  it('drops empty and whitespace-only patterns', () => {
    expect(normalizeScope(['src/**', '', '   '])).toEqual(['src/**']);
  });

  it('de-duplicates while preserving first-occurrence order', () => {
    expect(normalizeScope(['b/**', 'a/**', 'b/**', ' a/** '])).toEqual(['b/**', 'a/**']);
  });
});

describe('scopesEqual', () => {
  it('is element-wise, so a reorder counts as a change', () => {
    expect(scopesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(scopesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(scopesEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('applyScopeAmendment', () => {
  it('reports no change when neither scope nor add_scope is requested', () => {
    const result = applyScopeAmendment(['auth/**'], {});
    expect(result).toEqual({ next: ['auth/**'], changed: false, removed: [] });
  });

  it('add_scope widens the existing claim rather than replacing it', () => {
    const result = applyScopeAmendment(['auth/**'], { add_scope: ['gdrive/drive_tools.py', 'mcp_ctl.py'] });
    expect(result.next).toEqual(['auth/**', 'gdrive/drive_tools.py', 'mcp_ctl.py']);
    expect(result.changed).toBe(true);
  });

  it('scope replaces the whole claim, which is how an over-claiming lock gets narrowed', () => {
    const result = applyScopeAmendment(['src/**', 'tests/**'], { scope: ['src/auth/**'] });
    expect(result.next).toEqual(['src/auth/**']);
    expect(result.changed).toBe(true);
    // A narrowing must be distinguishable from a widening: it is the only
    // amendment that takes protection away, and it does so while the lock goes
    // on reading as active and healthy.
    expect(result.removed).toEqual(['src/**', 'tests/**']);
  });

  it('reports no removals for a widening, so narrowings stand out', () => {
    expect(applyScopeAmendment(['a/**'], { add_scope: ['b/**'] }).removed).toEqual([]);
    expect(applyScopeAmendment(['a/**'], { scope: ['a/**', 'b/**'] }).removed).toEqual([]);
  });

  it('adding a glob already claimed is a no-op, so lock_update stays idempotent', () => {
    const result = applyScopeAmendment(['auth/**', 'tests/**'], { add_scope: ['auth/**'] });
    expect(result.next).toEqual(['auth/**', 'tests/**']);
    expect(result.changed).toBe(false);
  });

  it('replacing with an identical scope reports no change', () => {
    const result = applyScopeAmendment(['auth/**'], { scope: ['auth/**'] });
    expect(result.changed).toBe(false);
  });

  it('rejects scope and add_scope together rather than guessing an order', () => {
    expect(() => applyScopeAmendment(['a/**'], { scope: ['b/**'], add_scope: ['c/**'] })).toThrow(ScopeAmendmentError);
  });

  it('refuses to replace a scope with nothing — an empty claim reads as protection and provides none', () => {
    expect(() => applyScopeAmendment(['a/**'], { scope: [] })).toThrow(EmptyScopeError);
    expect(() => applyScopeAmendment(['a/**'], { scope: ['  '] })).toThrow(EmptyScopeError);
  });

  it('refuses an add_scope that amends nothing', () => {
    expect(() => applyScopeAmendment(['a/**'], { add_scope: [] })).toThrow(ScopeAmendmentError);
    expect(() => applyScopeAmendment(['a/**'], { add_scope: ['', ' '] })).toThrow(ScopeAmendmentError);
  });

  it('normalizes the pre-existing scope before comparing, so a stored duplicate does not survive an amendment', () => {
    const result = applyScopeAmendment(['a/**', 'a/**'], { add_scope: ['b/**'] });
    expect(result.next).toEqual(['a/**', 'b/**']);
  });
});

describe('formatScopeCheck', () => {
  it('lists the claimed globs and names the consequence, not just a reminder', () => {
    const text = formatScopeCheck(['auth/**', 'tests/auth/**']);
    expect(text).toContain('`auth/**`');
    expect(text).toContain('`tests/auth/**`');
    // The consequence clause is the whole point of this prompt: an agent told
    // WHY an unamended scope hurts acts on it, one told to "remember" does not.
    expect(text).toContain('invisible to any other agent looking for a conflict');
  });

  it('names MCP tools to an agent and CLI commands to a human', () => {
    expect(formatScopeCheck(['a/**'], 'mcp')).toContain('lock_check_drift');
    expect(formatScopeCheck(['a/**'], 'mcp')).toContain('lock_update');
    expect(formatScopeCheck(['a/**'], 'cli')).toContain('agent-locks drift');
    expect(formatScopeCheck(['a/**'], 'cli')).toContain('--add-scope');
    // Telling a human at a terminal to "call lock_update" is wrong advice.
    expect(formatScopeCheck(['a/**'], 'cli')).not.toContain('lock_update');
  });
});
