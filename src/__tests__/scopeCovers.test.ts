import { describe, expect, it } from 'vitest';
import { scopeCovers, patternCoversPath, scopesOverlap } from '../lock/globOverlap.js';

describe('scopeCovers — the GATING predicate (CR-9)', () => {
  it('THE NEGATIVE CONTROL: a `*.md` lock does not cover src/main.ts', () => {
    // This is the case that motivated the function. `scopesOverlap` reports TRUE here
    // (empty static prefix prefixes everything), which is correct for warning and
    // catastrophic for gating — one broad lock would satisfy a pre-commit check for
    // every file in the repo.
    expect(scopesOverlap(['*.md'], ['src/main.ts'])).toBe(true); // the heuristic, as designed
    expect(scopeCovers(['*.md'], 'src/main.ts')).toBe(false); // the gate, as required
  });

  it('covers what it should', () => {
    expect(scopeCovers(['src/**'], 'src/main.ts')).toBe(true);
    expect(scopeCovers(['src/**'], 'src/deep/nested/file.ts')).toBe(true);
    expect(scopeCovers(['src/*.ts'], 'src/main.ts')).toBe(true);
    expect(scopeCovers(['docs/AGENT_LOCK_PROTOCOL.md'], 'docs/AGENT_LOCK_PROTOCOL.md')).toBe(true);
    expect(scopeCovers(['*.md'], 'README.md')).toBe(true);
    expect(scopeCovers(['src/'], 'src/a/b.ts')).toBe(true);
    // `**/` matches zero segments too.
    expect(scopeCovers(['**/*.ts'], 'main.ts')).toBe(true);
    expect(scopeCovers(['**/*.ts'], 'a/b/main.ts')).toBe(true);
  });

  it('does not cover what it should not', () => {
    expect(scopeCovers(['src/*.ts'], 'src/deep/main.ts')).toBe(false); // * stops at /
    expect(scopeCovers(['src/**'], 'lib/main.ts')).toBe(false);
    expect(scopeCovers(['packages/foo/**'], 'packages/bar/x.ts')).toBe(false);
    expect(scopeCovers([], 'anything.ts')).toBe(false);
    expect(scopeCovers([''], 'anything.ts')).toBe(false);
  });

  it('refuses to guess: an unsupported pattern covers NOTHING', () => {
    // For a gate, "I cannot prove this is covered" must mean "not covered". Erring the
    // other way would let a pattern the parser does not understand gate everything.
    expect(patternCoversPath('src/{a,b}/*.ts', 'src/a/x.ts')).toBe(false);
    expect(patternCoversPath('src/[abc].ts', 'src/a.ts')).toBe(false);
    expect(patternCoversPath('!(vendor)/**', 'app/x.ts')).toBe(false);
  });

  it('any of several scope patterns is enough', () => {
    expect(scopeCovers(['docs/**', 'src/**'], 'src/main.ts')).toBe(true);
    expect(scopeCovers(['docs/**', 'src/**'], 'test/main.ts')).toBe(false);
  });

  it('normalises leading ./ and / so equivalent paths agree', () => {
    expect(scopeCovers(['./src/**'], 'src/a.ts')).toBe(true);
    expect(scopeCovers(['src/**'], './src/a.ts')).toBe(true);
  });
});
