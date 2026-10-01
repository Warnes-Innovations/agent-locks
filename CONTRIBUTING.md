# Contributing to agent-locks

Thanks for your interest in improving **agent-locks**. This is a small, dependency-light
MCP server; contributions that keep it that way are especially welcome.

## Licence

This project is **[MIT](LICENSE)**. By submitting a contribution you agree it is licensed
under those same terms.

There is no CLA and no DCO sign-off requirement here — unlike some sibling projects, this
repository is single-licensed, so no relicensing grant is needed. `git commit -s` is
welcome but not required.

New source files do **not** currently carry `SPDX-License-Identifier` headers; nothing
under `src/` has one. Please match that convention rather than introducing headers
piecemeal — a repository where only some files are marked is harder to reason about than
one where none are.

## Where to send changes

- **Pull requests target `main`, and `main` is protected** — `.hookshim` at the repo root
  names it, so a direct push is refused by the pre-push hook. Reach it through a PR.
- **There IS a `devel` branch**, used as an integration branch: work lands there first and
  reaches `main` by PR. PRs #1, #2, #3 and #5 came from topic branches directly; **#4 came
  from `devel`**. Either route is fine — what is not fine is pushing to `main`.
- Branch from `main` (or from `devel` if you are joining work already staged there), keep
  the branch focused, and rebase rather than merge the base back in.

> An earlier version of this section stated "There is no `devel` branch here" and listed
> the merged PRs as #1, #2, #3, #5 — omitting #4, which is the one that came from `devel`.
> Both halves were wrong at the time of writing. Noted rather than silently corrected,
> because a contributor who read the old text and branched accordingly was following the
> documentation, not disregarding it.

## Development workflow

Requires Node ≥ 18 and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run — `pretest` builds first, so dist/ is always fresh
pnpm build        # tsup -> dist/index.js
```

**Run all three before opening a PR.** CI (`.github/workflows/ci.yml`) runs the same
checks on every push and PR to `main` and `devel`: typecheck and the full suite on Node 18
and 22, plus a `dist` job described below. Running them locally first is still the faster
way to find a problem, but a broken `main` will now be caught.

**If the suite fails locally but passes in CI, check your git hooks first.** The tests
shell out to `git commit` inside throwaway repositories. That is hermetic on a runner but
not on a developer machine: a global `core.hooksPath` applies to those fixtures too, and a
blocking `pre-commit` hook fails dozens of tests for reasons that have nothing to do with
your change. Reproduce a CI result locally with:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath \
  GIT_CONFIG_VALUE_0=/dev/null pnpm test
```

That redirects the hook path for one command instead of editing your global git config,
so other work on the machine keeps running under the hooks it expects.

### `dist/` is committed

`dist/index.js` is a **tracked build artifact**, not ignored. If your change touches
anything under `src/`, run `pnpm build` and include the regenerated `dist/index.js` in the
same commit. Conversely, if your change is test-only, `dist/` should come out
byte-identical — don't commit incidental churn.

CI enforces this: the `dist` job rebuilds from `src/` and fails if the committed bundle
differs. It is the only mechanical check that the artifact agents actually execute matches
the source that was reviewed — every MCP server launches `dist/index.js` directly, so a
`dist/` that lags `src/` means the fix is in the repository and not in the thing running.
A merge can produce this without anyone making a mistake: git resolves `dist/index.js`
textually, and the result is not guaranteed to equal a clean rebuild.

### Testing conventions

Tests live in `src/__tests__/` and run under [vitest](https://vitest.dev/).

The suite deliberately favours **real** integration over mocks: `e2e.test.ts` and
`crossRepo.test.ts` spawn the compiled `dist/index.js` as an actual subprocess and drive
real JSON-RPC through the MCP SDK client; `git.test.ts` and `cli.test.ts` create real
temporary git repositories (and real linked worktrees) with `git init`. Please keep new
tests in that style where the behaviour under test involves git or the MCP transport —
this project's core claims are about what git and the filesystem actually do, and a mock
cannot falsify those claims.

Two habits worth adopting, because both have already caught real defects here:

- **Anchor assertions absolutely, not relatively.** A test that only checks two results
  agree with each other can pass while both are wrong. A cross-worktree test once passed
  against a build where the repository selector was ignored entirely, because both locks
  landed in the same (wrong) place.
- **Verify a new test can fail.** Break the behaviour it covers, confirm the test goes
  red, then restore. A test that cannot fail is documentation, not coverage.

### Style

- Conventional Commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `test:` …).
- No new runtime dependencies without discussion — argument parsing is hand-rolled in
  `src/cli.ts` specifically to keep the footprint minimal.
- Explain *why* in comments where behaviour is non-obvious. The existing comments in
  `src/git.ts` are the house style: they justify the design against the alternative that
  looks correct but isn't.

## Reporting security issues

Please **do not** open a public issue for a security vulnerability — this repository is
public, so an issue discloses the problem to everyone before a fix exists.

Email <greg@warnes-innovations.com> instead. There is no `SECURITY.md` in this repository
yet; this section is the disclosure process until there is one.

## A note on the upstream project

This repository has an `upstream` remote pointing at
[luohoa97/agent-locks](https://github.com/luohoa97/agent-locks). GitHub does not treat
this as a fork (`isFork: false`), so pushes go only to the Warnes-Innovations `origin` —
but contributions here may be offered upstream. Keep that in mind if you would prefer
your change not be forwarded.
