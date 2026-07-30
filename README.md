# agent-locks

A filesystem-based, database-free MCP server that lets AI coding agents (Claude Code sessions, subagents, or anything else speaking MCP) claim work, see what other agents are doing, avoid stepping on each other's files, and leave a readable log of what happened — across every git worktree of the same repository, without ever polluting that repo's own git history.

No database. No server to run. No credentials. Just markdown files under a directory that git structurally can never track.

## Why this exists

When multiple agents work in parallel on different `git worktree`s of the same repository, they have no shared, low-ceremony way to say "I'm working on these files right now" or "here's what I did and why." agent-locks fills that gap with one idea: store lightweight lock files under the repository's **shared** `.git` directory, which every worktree of that repository can see, and which git itself can never accidentally commit.

## The git-common-dir trick (the crux of the whole design)

Every worktree of a git repository — the original checkout and every `git worktree add`-created linked worktree — shares exactly one real `.git` directory. A linked worktree's own `.git` is not a real git directory at all; it's a plain **file** containing a pointer back to the shared one:

```
$ cat /path/to/linked-worktree/.git
gitdir: /path/to/main-repo/.git/worktrees/linked-worktree
```

This means two different git commands give two different answers, and only one of them is useful here:

| Command | From the main worktree | From a linked worktree |
|---|---|---|
| `git rev-parse --git-dir` | `/repo/.git` | `/repo/.git/worktrees/linked` (**different per worktree — wrong for us**) |
| `git rev-parse --git-common-dir` | `/repo/.git` | `/repo/.git` (**identical — this is what we use**) |

agent-locks resolves its storage location by running `git rev-parse --git-common-dir` (via `child_process`, never cached, see below) and storing locks at:

```
<git-common-dir>/agents-locks/
├── 2026-07-17T18-45-12-hindsight-route-tests.md   # active locks live directly here
├── 2026-07-17T09-12-03-oauth-cleanup.md
└── done/                                           # finished locks are moved here
    └── 2026-07-16T22-01-00-fix-flaky-test.md
```

Verified empirically (see `src/__tests__/git.test.ts`): a real `git init` + `git worktree add` pair produces the identical `--git-common-dir` from both worktrees, while `--git-dir` genuinely differs. This is not an assumption — it's exercised by an automated test that creates a real temporary git repo and a real linked worktree on every test run.

### Why this can never be committed to the repo you're working on

`agents-locks/` lives **under `.git` itself**, not inside the tracked working tree. This is not a `.gitignore` entry (a `.gitignore` rule wouldn't even apply here — the directory isn't part of the working tree git tracks at all) — it's structural: git's index and working-tree model have no concept of a path under `.git/` as something that can be staged. Empirically verified (also in `src/__tests__/git.test.ts`):

```
$ git add .git/agents-locks/some-lock.md
$ echo $?
0                          # no error...
$ git status --porcelain
                           # ...but nothing was actually staged
$ git ls-files | grep some-lock
                           # ...and it never appears in the index
```

`git add` on a path under `.git/` is a **silent no-op**, not an error — there's no error message an agent could work around or accidentally suppress. The file structurally cannot enter the index.

### How the path is resolved — freshly, every single call

Every tool implementation calls `resolveLocksRoot()` (`src/git.ts`) at the start of its own handler, which runs `git rev-parse --git-common-dir` with `cwd` set to the server process's own current working directory (`process.cwd()`) **at that exact moment** — never cached across calls, never resolved once at server startup. There is no protocol-level or environment-variable mechanism for a stdio MCP server to learn "which worktree is this particular tool call morally about" (see the [Claude Code launch mechanics](#how-claude-code-launches-this-server) section below) — the server's own `cwd` at call time is the only signal available, and re-resolving it fresh every call costs one cheap subprocess spawn while removing any risk of relying on a stale assumption.

## How Claude Code launches this server

Claude Code's `.mcp.json`/`claude mcp add` configuration for a stdio server has no `cwd` field. A spawned stdio server simply **inherits Claude Code's own current working directory** at the moment it's launched (standard `child_process.spawn` behavior when no explicit `cwd` is given) — i.e., whatever directory the `claude` session itself was started from, which for a worktree-rooted session is that worktree's own directory. This is exactly what this tool needs: two Claude Code sessions rooted in two different worktrees of the same repo will each spawn their own agent-locks process with a different `process.cwd()`, and both will resolve to the *same* `agents-locks/` directory via `--git-common-dir`.

Claude Code does expose one environment variable to spawned stdio servers, `CLAUDE_PROJECT_DIR` — but this project **deliberately does not use it**. Per Claude Code's own docs, `CLAUDE_PROJECT_DIR` is "the stable project root" that "doesn't change when you add or remove working directories mid-session." That stability is exactly wrong for this tool: if a user works from a linked worktree, `CLAUDE_PROJECT_DIR` would likely still point at (or be defined relative to) the original/main project root rather than the worktree the session is actually rooted in, defeating the entire per-worktree design. Using the server process's own inherited `cwd` instead is what actually varies correctly across worktrees.

## File format

```markdown
---
id: 2026-07-17T18-45-12-hindsight-route-tests
agent_id: subagent-4f2a
parent_agent_id: session-abc123
status: active
created: 2026-07-17T18-45-12
updated: 2026-07-17T18-45-12
scope:
  - backend/src/hindsight/**
---

# Add hindsight route tests

- [x] Write route unit tests
- [ ] Write integration test

## Notes
- Started after checking for conflicts with the oauth-cleanup lock
```

Parsed and serialized by `src/lock/markdown.ts` using [`gray-matter`](https://github.com/jonschlinkert/gray-matter) for the frontmatter/body split, plus a small hand-written parser/serializer for the specific body shape (title heading, checklist, Notes section) that this project owns entirely — calling agents never write raw markdown; they pass structured tool arguments and this module is the only place that turns them into (or back out of) the file format.

### Timestamp format

Single format used consistently in the filename prefix, the frontmatter `id`, and the `created`/`updated` fields: **`YYYY-MM-DDTHH-MM-SS`, in UTC** — e.g. `2026-07-17T18-45-12`.

- Dashes instead of colons in the time portion, because `:` is awkward-to-forbidden in filenames on some filesystems (notably Windows/NTFS). The date portion's dashes were never a problem; they're kept purely for readability.
- Seconds precision (not just hours:minutes) keeps same-second collisions rare without needing milliseconds. On the rare occasion two locks with the same title are created in the same second, `lock_create` appends a numeric suffix (`-2`, `-3`, ...) to guarantee a unique file — this is a safety-net fallback, not the primary naming scheme (the design is deliberately sequence-number-free otherwise).
- UTC (not local time) so timestamps from agents on different machines in different timezones are directly, correctly comparable.
- Fixed-width, zero-padded fields in a consistent order mean plain string sorting of filenames or `id`s is equivalent to chronological sorting.

The `id` frontmatter field is, by design, **exactly the filename minus `.md`** — e.g. filename `2026-07-17T18-45-12-hindsight-route-tests.md` has `id: 2026-07-17T18-45-12-hindsight-route-tests`. Keeping these byte-identical (rather than letting the filename and the `id` field drift independently) removes an entire class of "which one is authoritative" bugs.

### Filename

`{timestamp}-{kebab-case-title}.md` — purely chronological, no sequence numbers by design (these files are ephemeral coordination artifacts, not a numbered decision log).

## The 7 MCP tools

All seven are implemented in `src/server.ts`; the actual filesystem logic lives in `src/lock/store.ts`.

### `lock_query`

Lists locks. **Hard requirement, enforced and tested** (`src/__tests__/store.test.ts`): when `status` is omitted, done locks are excluded — you see current work, not history, by default.

```json
{ "name": "lock_query", "arguments": {} }
{ "name": "lock_query", "arguments": { "status": "all", "text": "oauth" } }
{ "name": "lock_query", "arguments": { "scope": "backend/src/oauth/client.ts" } }
```

Returns `Array<{id, title, status, percentComplete, scope, agent_id, parent_agent_id, stale, staleForSeconds}>`. `percentComplete` is the ratio of checked to total tasks (a lock with zero tasks reports 100). See "Staleness detection" below for `stale`/`staleForSeconds` and the optional `stale_minutes` argument.

### `lock_check_conflict`

Purely informational — **never blocks, never vetoes, has no side effects**. Returns any *active* locks whose `scope` glob-overlaps the patterns you pass in; you decide what to do with that information. Same summary shape as `lock_query`, including `stale`/`staleForSeconds`.

```json
{ "name": "lock_check_conflict", "arguments": { "scope": ["backend/src/oauth/**"] } }
```

### `lock_create`

```json
{
  "name": "lock_create",
  "arguments": {
    "title": "Fix flaky OAuth callback test",
    "scope": ["backend/src/oauth/**"],
    "tasks": ["Reproduce the flake", "Add a deterministic fixture", "Confirm 20x green"],
    "agent_id": "subagent-4f2a"
  }
}
```

Returns `{id, filePath}`.

### `lock_update`

```json
{ "name": "lock_update", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test", "task_text": "Reproduce the flake", "done": true, "note": "Repro'd via 50x loop with -t 30s" } }
```

`task_text` must match an existing task **exactly** (chosen deliberately over fuzzy/partial matching — it's the unambiguous, predictable default). A non-matching `task_text` returns a real MCP tool error (`isError: true`) listing the lock's actual task texts, never a silent no-op.

### `lock_finish`

```json
{ "name": "lock_finish", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test", "summary": "Fixed by adding a deterministic clock fixture; merged in PR #42." } }
```

Moves the file from `agents-locks/` to `agents-locks/done/`, sets `status: done`. Errors clearly (not silently) if the lock doesn't exist, or already exists but is already done.

### `lock_heartbeat`

```json
{ "name": "lock_heartbeat", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test" } }
```

Bumps **only** a lock's `updated` timestamp — no task/note/scope change. Call this periodically during a long stretch of work that isn't naturally hitting `lock_update` often enough (completing a task already bumps `updated` for free) to keep the lock from reading as stale to anyone else watching. Restricted to active locks — errors clearly if `lock_id` doesn't exist, or exists but is already done.

### `lock_reap`

```json
{ "name": "lock_reap", "arguments": {} }
{ "name": "lock_reap", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test" } }
{ "name": "lock_reap", "arguments": { "dry_run": true } }
```

Finishes (same mechanism as `lock_finish`) every currently-stale active lock, or a single specific one if `lock_id` is given. **Explicit and deliberate — never a side effect of `lock_query`/`lock_check_conflict` reading state.** Each reaped lock gets an auto-generated note recording that it was reaped for inactivity (and for how long), so the done archive stays honest about "the owning agent finished this" vs. "nobody was heard from and this got cleaned up." If `lock_id` is given but that lock is **not** actually stale, this errors (`LockNotStaleError`) rather than reaping it — `lock_reap` cannot be used as a back door to force-finish someone else's live work. `dry_run: true` reports what would be reaped without writing anything.

## CLI usage

The exact same lock store the 5 MCP tools above talk to is also reachable from a plain terminal or a shell script — useful for a human checking coordination state directly, or for any agent harness that can run a command but doesn't (yet) speak MCP.

`index.js` dispatches on `argv`: called with **no arguments** (or the explicit `serve` alias) it starts the MCP stdio server exactly as before — every existing MCP client config keeps working unchanged. Called with any other first argument, it runs as a CLI and exits with a real exit code (0 on success, 1 on a usage error or a store error like a missing lock id) instead of hanging waiting for JSON-RPC on stdin.

```bash
# Human-readable summary of active locks in the current repo (or worktree)
agent-locks status

# Full query, same filters as lock_query, --json for scripting
agent-locks list [--status active|done|all] [--scope <glob>] [--agent <id>] [--text <query>] [--json]

# Same as lock_check_conflict — informational only, exit code is always 0
agent-locks check <scope-glob...>

# Same as lock_create
agent-locks claim --title <text> --scope <glob> [--scope <glob> ...] [--task <text> ...] [--agent <id>] [--parent <id>]

# Same as lock_update
agent-locks update <lock-id> --task <text> [--done | --undone] [--note <text>]

# Same as lock_finish
agent-locks finish <lock-id> [--summary <text>]

# Same as lock_heartbeat
agent-locks heartbeat <lock-id>

# Same as lock_reap
agent-locks reap [lock-id] [--stale-minutes <n>] [--dry-run] [--json]

# Explicit alias for "no arguments" — starts the MCP server
agent-locks serve
```

`list`/`check` also accept `--stale-minutes <n>` to override the staleness threshold for that call, matching `lock_query`/`lock_check_conflict`'s own `stale_minutes` argument. The table view of `status`/`list`/`check` includes a STALE column (`yes (2h)` / `no` / `-` for done locks).

Every subcommand resolves `locksRoot` fresh via `resolveLocksRoot()`, the same as every MCP tool handler — running the CLI from one worktree while an agent's MCP session is live in another worktree of the same repo still coordinates correctly, for the same git-common-dir reason the whole tool exists.

No new dependency was added for this — argument parsing is hand-rolled (`src/cli.ts`) to match the project's existing minimal footprint.

## Staleness detection

Every lock summary (`lock_query`, `lock_check_conflict`) carries two computed fields:

- `stale: boolean` — true only for an **active** lock whose `updated` timestamp is older than the staleness threshold. Always `false` for a `done` lock; staleness is a property of abandoned in-progress work, not of finished work.
- `staleForSeconds: number` — how long it's been, for display/sorting.

**Threshold resolution**, in priority order: an explicit `stale_minutes` argument on the call, then the `AGENT_LOCKS_STALE_MINUTES` environment variable (read fresh on every call — same "never cache an assumption" principle as `resolveLocksRoot` in `git.ts`), then a default of 60 minutes.

**Computed fresh, never mutates anything.** Reading `stale` never moves or touches a lock file — the same "no database, no in-memory cache" principle as everything else in this project (see below) applies here too: staleness is a pure function of `now` and the lock's own `updated` field, recomputed on every call. Cleanup only happens via the explicit `lock_reap` tool.

**`updated` *is* the heartbeat signal — there is no separate `heartbeat`/`pid` field.** `lock_create` sets it, `lock_update` bumps it on every real change, and `lock_heartbeat` bumps it with no other side effect for the gap between real updates. This was a deliberate simplification over a two-signal (timestamp + process-liveness) design:

- A **process-liveness** check (recording the calling process's PID and checking `kill -0` on it) sounds like it would catch crashes faster, but it doesn't transfer cleanly across this tool's two invocation shapes. For an MCP server session, the server subprocess plausibly *does* represent "is this session still connected" for its whole lifetime. For a CLI invocation (`agent-locks claim ...`), the process that created the lock **exits immediately** after the command returns — its PID is dead within milliseconds, by design, while the work it claimed may continue for hours. A staleness rule that trusted PID liveness would therefore flag every CLI-created lock as abandoned almost immediately, which is exactly backwards.
- A **timestamp-since-last-real-activity** check has none of that asymmetry: it means the same thing regardless of which interface created or is updating the lock, degrades gracefully (a crashed process just stops producing updates, and eventually crosses the threshold — a slower but strictly more correct signal than a PID check with a CLI-mode blind spot), and reuses a field the schema already had rather than adding new frontmatter that every existing hand-written or future lock file would need to carry.

If you need faster-than-threshold crash detection for the long-running MCP-server case specifically, that's a reasonable follow-up (e.g. an opt-in PID check that only applies when the caller identifies itself as a persistent session) — deliberately left out of this change to keep the staleness model uniform and simple across both interfaces first.

## Honest `agent_id` / `parent_agent_id` semantics

**Claude Code does not expose any session id to a stdio MCP server subprocess** — not via environment variable, not via any MCP `initialize` parameter (the spec's `initialize` params are only `protocolVersion`, `capabilities`, `clientInfo`), and there is no documented mechanism for a subagent's MCP server process to learn its parent session's id either.

`agent_id` and `parent_agent_id` on `lock_create` are therefore **plain optional strings that the calling agent supplies only if it happens to already know one from its own context** (some orchestration harnesses hand a subagent an explicit id when dispatching it). This server has no way to detect either value and never fabricates one — both default to `null` when omitted. Every tool description says this plainly.

## No database, no in-memory cache

The markdown files are the entire source of truth. Every tool call reads whatever is currently on disk at that moment — there is no cached lock list, no in-memory index, and no assumption that this is the only server process for a given repo.

## Glob overlap heuristic (`lock_check_conflict`, and `lock_query`'s `scope` filter)

There's no exact, general algorithm for "do these two glob patterns ever match a common file" that doesn't require enumerating the filesystem — and even that only answers it for files that exist *right now*. `src/lock/globOverlap.ts` uses a **static-prefix heuristic**, deliberately biased toward false positives over false negatives, because this tool is informational-only: a false positive just means an agent double-checks something that was actually fine; a false negative would silently hide a real conflict.

1. Exact match → overlap.
2. Compare each pattern's literal prefix (everything before the first `* ? [ ] { } ( ) !`). If one prefix is a raw-string prefix of the other → overlap.
   - `src/foo/**` vs `src/foo/bar.ts` → overlap (correct: the first pattern matches that exact file).
   - `src/**` vs `src/foo/**` → overlap (correct: both can match files under `src/foo/`).
   - `packages/foo/**` vs `packages/bar/**` → no overlap (correct: different packages).
   - A pattern whose first character is itself a wildcard (`*.ts`, `**` + `/*.test.ts`) has an *empty* prefix, which trivially prefixes everything — so such patterns are conservatively reported as overlapping with anything in scope. Intentional over-inclusion, not a bug.
3. Fallback: if the prefixes disagree, also check (via `minimatch`) whether either pattern, treated as a literal path string, is matched by the other pattern's glob. This specifically matters for extglob syntax (`+(foo|bar)`, `@(foo|bar)`, `!(foo|bar)`) — e.g. `src/+(foo|bar)/**`'s naive static prefix is `"src/+"` (only the `(` is treated as a wildcard-start, not the `+` before it), which does **not** raw-string-prefix `"src/foo/util.ts"`, so the prefix stage alone would wrongly say "no overlap"; the real `minimatch` check in the fallback catches it.

### Known, documented gap

**Filesystem case-sensitivity is not modeled.** `Src/**` and `src/foo.ts` are reported as non-overlapping (matching is case-sensitive, per `minimatch`'s default), but on a case-insensitive filesystem (default macOS, default Windows) these could refer to the exact same real file. This is not special-cased, because "is this filesystem case-sensitive" isn't knowable from the pattern strings alone, and the case-sensitive assumption matches the Linux dev environments this tool targets. Pinned down explicitly by a test in `src/__tests__/globOverlap.test.ts` so a future reader knows this is a deliberate, accepted limitation rather than an untested edge case.

(There's also a documented, deliberately-accepted *over*-inclusion case for `{brace,expansion}` patterns — see the comments in `globOverlap.ts` and its test file for the reasoning; that direction is considered safe, not a gap, given this tool's informational-only nature.)

## Installing this as an MCP server in Claude Code

**Node/TypeScript, not Python** — `uvx` (which runs Python packages via [`uv`](https://github.com/astral-sh/uv)) does not apply here. The correct launcher is `pnpm dlx` (pnpm's equivalent of Python's `uvx` / Node's `npx`, for running a package's binary without a permanent global install).

Once published to npm, add it with:

```bash
claude mcp add --transport stdio agent-locks -- pnpm dlx agent-locks
```

or as a `.mcp.json` / `~/.claude.json` entry:

```json
{
  "mcpServers": {
    "agent-locks": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "agent-locks"]
    }
  }
}
```

**Before this package is published to npm**, install directly from GitHub instead (`pnpm dlx` resolves the exact same way whether the package spec is a registry name or a `github:` spec — verified directly, see "Verification" below):

```bash
claude mcp add --transport stdio agent-locks -- pnpm dlx github:luohoa97/agent-locks
```

```json
{
  "mcpServers": {
    "agent-locks": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "github:luohoa97/agent-locks"]
    }
  }
}
```

Once added, Claude Code will always launch it with `command: pnpm, args: [dlx, ...]` — no manual build step, no cloning required on the user's part; `pnpm dlx` handles fetching and installing the package on demand.

## Packaging: why `dist/` is committed to this repo

Normally a compiled `dist/` directory has no place in git. Here it's committed deliberately: `pnpm dlx github:...` (the pre-npm-publish install path above) clones the full repository and runs the package as-is — there is no `npm publish`-time "files" filtering step for a git-based install, and pnpm's script-execution security model means a `prepare`/`postinstall` build step is not guaranteed to run automatically for a fresh `dlx` invocation. Committing the already-built `dist/index.js` means the `pnpm dlx github:...` flow works with zero assumptions about lifecycle-script execution. Once this package is published to npm, the packed tarball (governed by `"files": ["dist"]` in `package.json`) is what consumers actually receive, and the committed copy becomes a convenience for the interim git-based flow — kept in sync by running `pnpm run build` before every commit that touches `src/` (the `pretest` script also rebuilds automatically before every `pnpm test` run, so a stale `dist/` is caught by CI/local testing rather than silently drifting).

## Development

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # rebuilds dist/ first (pretest hook), then runs vitest
pnpm run build       # bundles src/index.ts -> dist/index.js via tsup (shebang + executable bit preserved)
pnpm run dev         # run directly from source via tsx, no build step (for local iteration)
```

### What's tested (`src/__tests__/`)

- `timestamp.test.ts` — timestamp formatting and slug generation.
- `markdown.test.ts` — frontmatter + body round-tripping (`parseLockFile(serializeLockFile(x)) === x`), including the exact documented file shape.
- `globOverlap.test.ts` — the overlap heuristic, including the extglob fallback case and the documented case-sensitivity gap.
- `store.test.ts` — the full lock lifecycle (create → update → finish), the hard "done excluded from default query" requirement, exact task-text matching (with a clear error on mismatch, never a silent no-op), and conflict-checking.
- `git.test.ts` — creates a **real** temporary git repository and a **real** linked worktree (via actual `git init`/`git worktree add` subprocess calls) and proves `resolveLocksRoot()` returns the identical path from both, that `--git-dir` would have differed, and that a path under `.git/agents-locks/` can never enter git's index.
- `e2e.test.ts` — spawns the **actual compiled `dist/index.js`** as a real subprocess (via the MCP SDK's own `Client` + `StdioClientTransport`, exactly how Claude Code itself talks to an MCP server) and drives real JSON-RPC round trips: `initialize`, `tools/list`, and a full `lock_create` → `lock_query` → `lock_update` → `lock_finish` → `lock_query` cycle against the real filesystem, plus a real tool-error round trip for a bad `task_text`.

### Verification performed for this project (not just unit tests)

In addition to the automated suite above, the following were run manually against the actual built artifacts:

1. `node dist/index.js` spawned directly and driven through `initialize` → `lock_create` → `lock_query` via the MCP SDK's client (this is what `e2e.test.ts` also automates).
2. `pnpm dlx <local tarball produced by \`npm pack\`>` — spawned exactly the way a real consumer's package manager would install and run it, driven through the same `initialize` → `tools/list` → `lock_create` round trip, and the created lock file was independently confirmed on disk under a real temporary git repo's `.git/agents-locks/`.
3. `pnpm dlx github:luohoa97/agent-locks` (after this repo was pushed) — the actual pre-npm-publish install command from this README, run for real against the pushed GitHub repository, exercising the identical `command: pnpm, args: [dlx, ...]` shape a Claude Code config would use.

## License

MIT
