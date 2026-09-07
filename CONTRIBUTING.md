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

**Run all three before opening a PR.** There is currently **no CI** in this repository —
no GitHub Actions workflows exist — so these checks run only where you run them. A broken
`main` will not be caught for you.

### `dist/` is committed

`dist/index.js` is a **tracked build artifact**, not ignored. If your change touches
anything under `src/`, run `pnpm build` and include the regenerated `dist/index.js` in the
same commit. Conversely, if your change is test-only, `dist/` should come out
byte-identical — don't commit incidental churn.

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
