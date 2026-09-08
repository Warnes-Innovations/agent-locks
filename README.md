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

Every tool implementation calls `resolveLocksRoot()` (`src/git.ts`) at the start of its own handler, which runs `git rev-parse --git-common-dir` with `cwd` set to the caller's `base_dir` if one was given, and otherwise to the server process's own current working directory (`process.cwd()`) **at that exact moment** — never cached across calls, never resolved once at server startup. There is no protocol-level or environment-variable mechanism for a stdio MCP server to learn "which worktree is this particular tool call morally about" (see the [Claude Code launch mechanics](#how-claude-code-launches-this-server) section below) — the server's own `cwd` at call time is the only signal available, and re-resolving it fresh every call costs one cheap subprocess spawn while removing any risk of relying on a stale assumption.

## How Claude Code launches this server

Claude Code's `.mcp.json`/`claude mcp add` configuration for a stdio server has no `cwd` field. A spawned stdio server simply **inherits Claude Code's own current working directory** at the moment it's launched (standard `child_process.spawn` behavior when no explicit `cwd` is given) — i.e., whatever directory the `claude` session itself was started from, which for a worktree-rooted session is that worktree's own directory. This is exactly what this tool needs: two Claude Code sessions rooted in two different worktrees of the same repo will each spawn their own agent-locks process with a different `process.cwd()`, and both will resolve to the *same* `agents-locks/` directory via `--git-common-dir`.

Claude Code does expose one environment variable to spawned stdio servers, `CLAUDE_PROJECT_DIR` — but this project **deliberately does not use it**. Per Claude Code's own docs, `CLAUDE_PROJECT_DIR` is "the stable project root" that "doesn't change when you add or remove working directories mid-session." That stability is exactly wrong for this tool: if a user works from a linked worktree, `CLAUDE_PROJECT_DIR` would likely still point at (or be defined relative to) the original/main project root rather than the worktree the session is actually rooted in, defeating the entire per-worktree design. Using the server process's own inherited `cwd` instead is what actually varies correctly across worktrees.

## Claiming work in a *different* repository (`base_dir`)

Everything above is about worktrees of **one** repository. But agents routinely work out of one checkout while writing into another — a session rooted in `project-a` that needs to edit `shared-config`, say. Without help, such a session can only create a lock in `project-a`, where the very agent it might collide with — the one working in `shared-config` — will never look. **A lock the colliding agent cannot see is decorative.**

Every lock tool therefore accepts an optional `base_dir`: any path inside the repository you want to operate on.

```json
{
  "name": "lock_create",
  "arguments": {
    "title": "Bump the shared eslint config",
    "scope": ["packages/eslint-config/**"],
    "tasks": ["Bump rules", "Run downstream builds"],
    "base_dir": "/Users/me/src/shared-config"
  }
}
```

The lock lands in **`shared-config`**'s shared `.git`, where an agent working in `shared-config` sees it via a plain `lock_query` — which is the entire point.

Three properties worth stating explicitly, each of them tested (`src/__tests__/crossRepo.test.ts`):

- **It resolves to the git *common* dir, like everything else here.** A `base_dir` pointing at a linked worktree and one pointing at that repo's main checkout land in the same store. `base_dir` does not open a hole in the cross-worktree guarantee.
- **A `base_dir` outside any git repository is a hard error**, never a silent fallback to the current directory. Falling back would file the lock in the wrong repository *and look like success* — strictly worse than failing, because the caller would believe the work was claimed.
- **It is required, not decorative.** Omitting `base_dir` genuinely cannot reach another repository's locks; there is no accidental cross-repo leakage in either direction.

Every lock is stamped with the repository it governs (`repository` in the frontmatter, and in every summary `lock_query` returns), so an agent reading a lock never has to infer that from the scope glob.

`base_dir` is available on all 8 MCP tools and, as `--base-dir`, on every CLI subcommand except `serve`.

## Scope is amendable, and you are expected to amend it

A lock's `scope` is declared at `lock_create` — **the moment the agent knows least about what it will end up touching.** Work legitimately grows: a lock created for `auth/**` ends up spanning eight packages. If scope could never change, it would drift away from reality while the lock still read as active and healthy.

That matters because `lock_check_conflict` and `lock_query`'s `scope` filter both match against **whatever globs are recorded now**. A lock whose footprint has grown, unamended, silently stops protecting the files it grew into — and the agent that would have caught the collision runs exactly the query these docs prescribe, sees nothing, and proceeds.

This is not hypothetical. It is how two sessions in sibling worktrees came to independently rewrite the same files, having each done everything the tool asked of them:

> Session A claimed `["auth/oauth_config.py", "auth/google_auth.py", "tests/auth/**"]`. Its branch legitimately grew to ~20 files across 8 packages, including `mcp_ctl.py` and `gdrive/drive_tools.py`. Session B ran `lock_query` and `lock_check_conflict` before writing, correctly. It saw A's lock, listed and ACTIVE, whose scope mentioned none of the files B was about to edit — so B proceeded, and made the *opposite* fix to the same three diagnostics. A's only recourse was a free-text `note`, which no matcher reads.

**Scope drift is the expected outcome of a field set at the point of least information, not a discipline failure.** So the remedy here is mechanical rather than exhortative:

1. **Amend it.** `lock_update` takes `add_scope` (widen — the common case, because work grows) or `set_scope` (replace — how a lock that over-claimed gets narrowed instead of left blocking others).
2. **See it.** `lock_create` and `lock_update` echo the current scope back on *every* call, so it is in front of the agent continuously rather than written once at creation and never seen again.
3. **Be asked to verify it, not reminded to care.** Alongside the scope, both return a `scopeCheck` prompt:

   > Scope claimed: `auth/**`, `tests/auth/**`. Does this still match what you are touching? Compare it against `git status --porcelain` / `git diff --name-only`, or call `lock_check_drift`, which does that comparison for you. If you are writing outside this scope, amend it now with `lock_update`'s `add_scope` (widen) or `set_scope` (replace) — `lock_check_conflict` matches these globs, so every file outside them is invisible to any other agent looking for a conflict.

   The last clause is the load-bearing one. It names the **consequence** rather than asking politely: an agent that knows an unamended scope makes its work invisible to its peers has a reason to act; one told to "remember to keep scope updated" does not.
4. **Have the tool do it for you.** [`lock_check_drift`](#lock_check_drift) compares the working tree's changed files against the lock's globs and reports the difference. Points 2 and 3 make the right behaviour *visible*; this one makes it *automatic*, which is what survives contact with a busy session — guidance that depends on being remembered has a failure rate, and the observed one here was 100%.

Amendments **append** to `scope_history` in the lock file with a timestamp; they never overwrite the previous value silently. See [File format](#file-format).

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
  - backend/src/telemetry/**
scope_history:
  - replaced_at: 2026-07-17T19-02-08
    scope:
      - backend/src/hindsight/**
repository: /home/user/projects/my-app
---

# Add hindsight route tests

- [x] Write route unit tests
- [ ] Write integration test

## Notes
- Started after checking for conflicts with the oauth-cleanup lock
```

`scope_history` records every scope this lock previously claimed, oldest first, each with the timestamp at which it was retired. It appears only once a lock's scope has actually been amended (see [Scope is amendable](#scope-is-amendable-and-you-are-expected-to-amend-it)). Each entry holds the scope **as it stood before** that amendment — so the sample above says "this lock claimed only `backend/src/hindsight/**` until 19:02:08, and `backend/src/hindsight/**` plus `backend/src/telemetry/**` from then on". Recording the retired value rather than the new one is what makes the history reconstructable from the file alone: the newest value is already in the live `scope` field.

That reconstruction is the point. When two agents collide, the question is *"was that file inside their claim at the moment I checked?"* — and the current scope alone cannot answer it.

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

## The 8 MCP tools

All eight are implemented in `src/server.ts`; the actual filesystem logic lives in `src/lock/store.ts`.

All eight also accept an optional `base_dir` to operate on a different repository — omitted from the examples below for brevity; see [Claiming work in a *different* repository](#claiming-work-in-a-different-repository-base_dir).

### `lock_query`

Lists locks. **Hard requirement, enforced and tested** (`src/__tests__/store.test.ts`): when `status` is omitted, done locks are excluded — you see current work, not history, by default.

```json
{ "name": "lock_query", "arguments": {} }
{ "name": "lock_query", "arguments": { "status": "all", "text": "oauth" } }
{ "name": "lock_query", "arguments": { "scope": "backend/src/oauth/client.ts" } }
```

Returns `{ locks: Array<{id, title, status, percentComplete, scope, repository, agent_id, parent_agent_id, stale, staleForSeconds}>, unreadable_locks: Array<{filePath, reason}>, warning?: string }`. **The shape does not change when something is wrong** — `unreadable_locks` is always present, empty in the normal case. An earlier version returned a bare array and switched to an object only when a lock could not be read, so a consumer would test the happy path, ship, and break in exactly the failure case the field exists to report. `lock_check_conflict` uses the same envelope with `conflicts` in place of `locks`; `lock_reap` returns `{ reaped, floor }`, where `floor` is non-null when a per-call `stale_minutes` was raised to the configured default. `percentComplete` is the ratio of checked to total tasks (a lock with zero tasks reports 100). `repository` is the root of the repo the lock governs, so a reader never has to infer that from the scope glob. See "Staleness detection" below for `stale`/`staleForSeconds` and the optional `stale_minutes` argument.

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

Returns `{id, filePath, scope, scopeCheck}` — the scope it actually recorded, plus the check prompt described in [Scope is amendable](#scope-is-amendable-and-you-are-expected-to-amend-it). Whitespace-padded and duplicate globs are normalized away; a `scope` that normalizes to nothing is rejected rather than stored.

### `lock_update`

```json
{ "name": "lock_update", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test", "task_text": "Reproduce the flake", "done": true, "note": "Repro'd via 50x loop with -t 30s" } }
{ "name": "lock_update", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test", "add_scope": ["backend/src/telemetry/**"] } }
{ "name": "lock_update", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test", "set_scope": ["backend/src/oauth/callback.ts"], "agent_id": "subagent-4f2a" } }
```

Checks a task off, amends the scope, and/or appends a note — **any combination, at least one required**. A call with nothing to do is an error rather than a silent timestamp bump; the operation that only says "I'm still alive" is `lock_heartbeat`, and keeping the two distinguishable is the point.

`task_text` must match an existing task **exactly** (chosen deliberately over fuzzy/partial matching — it's the unambiguous, predictable default). A non-matching `task_text` returns a real MCP tool error (`isError: true`) listing the lock's actual task texts, never a silent no-op. `task_text` and `done` are required **together** — both optional overall, so amending scope or adding a note doesn't have to flip a task, but supplying one without the other is an error rather than a guess.

`add_scope` widens the claim; `set_scope` replaces it outright (how a lock that over-claimed gets narrowed instead of left blocking others). They are mutually exclusive — applying both would require guessing an order. Adding a glob already claimed is a no-op that records no amendment, so `lock_update` stays idempotent.

**Why `set_scope` and not `scope`.** `scope` is what `lock_create` calls the *whole claim*, so an agent copying its create arguments into an update would silently replace a claim it had been widening — a destructive operation reached by a copy-paste that looks like a no-op. The CLI flag was `--set-scope` from the start; the MCP surface now matches it. Renamed before first release, so no caller ever saw `scope`.

**A replacement that DROPS globs is gated, the same way `lock_finish` is.** Narrowing takes protection away, and does it quietly — the lock goes on reading as active and healthy while the files it used to cover become invisible to every conflict check. So it is refused when the lock is held by a *different, named* agent, unless `force: true`, which is recorded on the lock. Refused only when **both** identities are known and differ: most locks carry `agent_id: null`, and requiring a match would strand them. Widening is never gated. As with `lock_finish`, `agent_id` is self-asserted and unverified, so this narrows accidents rather than preventing impersonation.

Returns `{id, percentComplete, scope, scopeChanged, scopeCheck}`, plus `previousScope` when the scope actually changed, so the before/after diff is visible in the transcript rather than having to be inferred; plus `removedFromScope` and `warnings` when the amendment **narrowed** the claim. **The scope is echoed on every call, amended or not.**

Narrowing is legitimate — it is how a lock that over-claimed stops blocking others — but it is the only amendment that takes protection *away*, and it does so while the lock goes on reading as active and healthy. So a narrowing is reported distinguishably from a widening, warns about work still in flight under the dropped globs, and records an auto-generated note on the lock (the same honesty mechanism `lock_reap` uses) so `lock_query`'s text search can find it afterwards.

### `lock_check_drift`

```json
{ "name": "lock_check_drift", "arguments": { "lock_id": "2026-07-17T18-45-12-fix-flaky-oauth-callback-test" } }
```

Compares what a lock **claims** against what your working tree has actually **changed**, and lists every changed file the scope does not cover:

The CLI rendering (`agent-locks drift <lock-id>`), which is what the report actually looks like:

```
Lock 2026-07-17T18-45-12-fix-flaky-oauth-callback-test — "Fix flaky OAuth callback test"
claims: auth/**, tests/auth/**
14 changed file(s) in /home/user/projects/my-app (9 uncommitted, 5 committed since the claim); 2 covered by that scope.
warning: 3 file(s) are ignored by git and were NOT examined. …
outcome: DRIFTED

files changed outside that scope (12):
  core/utils.py
  gdrive/drive_tools.py
  gforms/forms_tools.py
  mcp_ctl.py
  …
```

Changed files come from `git status` in the working tree you call from — staged, unstaged and untracked alike, with untracked directories expanded into their files and renames counting both paths — **plus every file touched by a commit made since the lock was claimed**. That second half matters more than it sounds: `git status` reports the working tree against `HEAD`, so work you have already committed is invisible to it, and committing as you go is how a branch normally grows. Without it, an agent that committed its grown work got a clean bill of health from the one tool built to catch exactly that, at exactly the moment the instructions say to run it.

Read-only: it never amends anything. Returns `{lock_id, title, scope, inspectedWorktree, lockCreatedIn, changedFileCount, uncommittedCount, committedSinceClaimCount, ignoredFilesNotExamined, inScopeCount, outOfScope, outOfScopeCount, outOfScopeTruncated, outcome, drifted, warnings, scopeCheck}`.

**Prefer `outcome` over `drifted`.** The boolean cannot distinguish "the scope covers the work" from "nothing was measured", and those render identically to a reader in a hurry. `outcome` is one of `DRIFTED`, `COVERED`, or `NOTHING_MEASURED` (no files were compared — this says nothing about your scope).

Reliability is carried separately, in `reliable` and `warnings`, and deliberately so: folding it into `outcome` made that field a *constant* in exactly the deployment this tool exists for. The multi-worktree warning fires on any repository with more than one worktree, so `outcome` could then never be `DRIFTED` or `COVERED` — a measurement field that had stopped varying, introduced by the very change meant to stop one state borrowing another's meaning. Read them together: "DRIFTED, and here is why the answer may not be about your work."

**A scope broad enough that the check cannot fail is reported as such.** A pattern beginning with a wildcard (`**/*.ts`, `{src,docs}/**`) matches every path under the shared matcher. That is not a matcher bug — peers genuinely do see the lock for any file, so the work is over-claimed rather than unprotected — but a `COVERED` from a check that could not have failed is not evidence, and it says so.

**Drift detects under-claiming only.** A lock whose scope is too *wide* blocks other agents without ever being reported here. That is a known gap, not an oversight.

### What `lock_check_drift` cannot see

Stated here rather than left to be discovered, because a clean result from a blind instrument is worse than no instrument:

- **Files git ignores** — a `.env`, a generated config, anything under an ignored build directory. The *count* is reported as `ignoredFilesNotExamined` and raises a warning, but their names and their drift are not knowable here.
- **Work committed *before* the lock was claimed.** The commit sweep starts at the lock's `created` timestamp.
- **Anything outside this working tree**, and the contents of submodules (which git reports as a single gitlink path).
- **A clean tree measures nothing.** That is reported as `NOTHING_MEASURED`, not as "no drift".

The warnings print **above** the verdict in the CLI, deliberately: `| head -n` is routine, and a reason the result may be meaningless must not be the part the pipe drops.

**Coverage is decided by the exact same glob matcher `lock_check_conflict` uses**, and that is deliberate rather than incidental. The question drift really answers is not the abstract "does this glob match this path" but *"would another agent's conflict check on this file see my lock?"* — and those are only the same question while both use the same matcher. A stricter matcher here would report files as uncovered that `lock_check_conflict` does surface (noise, which teaches agents to ignore the tool); a looser one would clear files that conflict checks miss (silence, which is the original bug). Sharing the matcher makes the two answers unable to disagree.

**Read the `warnings`.** Drift is only meaningful for your *own* lock in your *own* worktree. Run against a lock created elsewhere and it compares that lock's scope to files its owner is not editing — a clean result there means nothing, and the tool says so.

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

Finishes (same mechanism as `lock_finish`) every currently-stale active lock, or a single specific one if `lock_id` is given. **Explicit and deliberate — never a side effect of `lock_query`/`lock_check_conflict` reading state.** Each reaped lock gets an auto-generated note recording that it was reaped for inactivity (and for how long), so the done archive stays honest about "the owning agent finished this" vs. "nobody was heard from and this got cleaned up." If `lock_id` is given but that lock is **not** actually stale, this errors (`LockNotStaleError`) rather than reaping it — `lock_reap` cannot be used as a back door to force-finish someone else's live work. **A caller-supplied `stale_minutes` may only LENGTHEN the window, never shorten it** (floored at the configured default). Without that floor the plural form *was* exactly the back door this sentence denies: `reap --stale-minutes 0.01` finished every active lock in a repo, and even the named form could be pushed past its own refusal. Fixed and regression-tested 2026-09-03. `dry_run: true` reports what would be reaped without writing anything.

## CLI usage

The exact same lock store the 8 MCP tools above talk to is also reachable from a plain terminal or a shell script — useful for a human checking coordination state directly, or for any agent harness that can run a command but doesn't (yet) speak MCP.

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

# Same as lock_update — any combination of task flip, scope amendment and note; at least one required
agent-locks update <lock-id> [--task <text> [--done | --undone]] [--add-scope <glob> ...] [--set-scope <glob> ...] [--note <text>]

# Same as lock_check_drift — which changed files does this lock NOT cover?
agent-locks drift <lock-id> [--json]

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

`claim` and `update` print the lock's current scope and the check prompt on every call, phrased for a terminal (`agent-locks drift`, `--add-scope`) rather than naming MCP tools a human cannot call. `--add-scope` and `--set-scope` are mutually exclusive, `--done`/`--undone` require `--task`, and an `update` with nothing to do exits 1 rather than silently bumping a timestamp.

> **Note for anything scripting the CLI:** the plain-text output of `claim` and `update` now ends with that scope-check prompt, so the confirmation line is no longer the last line printed. Parse `--json` instead. Its shape is purely additive: `claim` gains `scope` and `scopeCheck`; `update` gains `scope`, `scopeChanged` and `scopeCheck`, plus `previousScope` when the scope changed and `removedFromScope`/`warnings` when it narrowed.

Every subcommand except `serve` accepts `--base-dir <path>` to operate on another repository, mirroring the MCP tools' `base_dir`:

```bash
# What is being worked on in a different repo, from wherever you happen to be
agent-locks status --base-dir ~/src/shared-config

# Claim work there before you write into it
agent-locks claim --base-dir ~/src/shared-config --title "Bump eslint config" --scope 'packages/eslint-config/**'
```

As with the MCP tools, a `--base-dir` that is not inside a git repository exits 1 with a clear error rather than quietly falling back to the current directory.

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

## Durability: atomic writes and one-writer-at-a-time

A lock store that loses a claim under concurrency has failed at the one thing it exists for, so two mechanisms guard every write. They overlap on purpose; neither covers the other.

**Writes are atomic.** `writeRecord` serializes to a sibling temp file and `rename`s it over the target. `fs.writeFile` opens `O_TRUNC` and *then* writes, so between those two syscalls a reader in another process — the normal case here, one server per worktree, all sharing one store — can observe a zero-length or half-written file. That matters more than it sounds, because a half-written lock file **does not fail to parse**: YAML truncation shortens a list rather than erroring, so the reader sees a valid-looking active lock claiming fewer globs than it really does. `rename(2)` is atomic on POSIX within a filesystem, so a reader sees either the whole old file or the whole new one.

**Every write path holds that claim, not just `lock_update`.** `writeRecord` serialises the *whole* record, so an unguarded path meaning to touch one scalar rewrites the scope, the history, the tasks and the notes from whatever it last read. `finishLock`, `heartbeatLock` and `reapStaleLocks` therefore go through the same guard — `lock_heartbeat` most of all, since the instructions tell agents to call it during precisely the long stretch in which scope grows and gets amended. The move into `done/` happens inside the held guard too, so a lock is never observable in both `active/` and `done/`.

**Updates hold an exclusive claim.** `lock_update` is a read-modify-write, and two concurrent amendments used to end with one simply gone — *both* calls returning success, each echoing a scope containing its own addition. Reproduced before the fix; pinned by a test now. Updates therefore take an `O_CREAT|O_EXCL` `.lock` sidecar for the duration of the read-modify-write, retry on contention, and fail with a named `ConcurrentUpdateError` rather than picking a winner. A sidecar left by a crashed process is taken over after 30 seconds, so nothing wedges permanently. A compare-and-swap on the file's bytes runs *inside* that guard as a second, independent check — a compare-and-swap alone is not sufficient, because two callers can both pass the re-read before either writes.

**Malformed lock files are refused by name.** `parseLockFile` validates the frontmatter instead of casting it. Previously a damaged file parsed into an object with `undefined` where a required field belonged and failed far away — `TypeError: b is not iterable` from inside a glob matcher, naming no file, taking every lock in the repository offline for every agent until a human found the bad one. Validation cannot detect a truncation that leaves a *shorter but well-formed* list; nothing can, because nothing records how long the list should have been. That case is what the atomic write prevents.

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

## Which predicate answers which question

There are two matchers, they are not interchangeable, and choosing between them by
"is one side a concrete file?" gets it wrong. The rule is:

> **Ask whose claim you are testing, and which wrong answer hurts.**

| You are asking | Predicate | Because the costly error is… |
|---|---|---|
| "I want to claim `src/auth/**` — will that intersect an existing lock?" | `scopesOverlap` | …missing a real collision. Both sides are *claims*; neither names a file yet. Over-reporting costs you one look. |
| "Is this file I am about to modify covered by **someone else's** lock?" | `scopesOverlap`, passing the file as a one-element scope | …missing THEIR claim and writing over live work. You want the over-inclusive answer here, even though one side is a concrete path. |
| "Does **my own** lock cover the files I am about to commit?" (a gate) | `scopeCovers` | …passing work that nothing actually claims. A gate must only admit what is *provable*, so this one refuses when it cannot prove coverage. |
| "Is my claim still honest about what I am touching?" (drift) | `scopeCovers` | …telling me my scope is fine when it does not really name those files. See below. |

**Why "concrete path → `scopeCovers`" is the wrong rule.** Rows 2 and 3 both test a
concrete file against a glob, and they want *opposite* biases. Row 2 asks whether to stay
away from someone else's work, so a false negative is the expensive one — the answer must
lean toward "yes, covered". Row 3 authorises your own action, so a false positive is the
expensive one — the answer must lean toward "no, not covered". Same shapes, inverted
safety directions. The predicate follows the *consequence*, not the argument types.

`scopeCovers` is conservative toward FALSE: a pattern using syntax outside its supported
subset (`**`, `*`, `?`) returns "not covered" rather than guessing, because for a gate "I
cannot prove this is covered" must mean "not covered". `scopesOverlap` is conservative
toward TRUE: an empty static prefix prefixes everything, so a lock scoped `*.md` reports
overlap against `src/main.ts`. Each is right for its own row and dangerous in the other's.

### What this means for `lock_check_drift`

Drift is row 4, and it currently uses row 1's predicate. That is defensible but it answers
a slightly different question than the one an agent asks:

- With `scopesOverlap`, drift means *"would a peer's conflict check surface my lock for
  this file?"* — so a broad scope like `**/*.ts` reports everything covered, and drift can
  never fail. The lock genuinely does protect those files, over-broadly; the check just
  cannot tell you anything.
- With `scopeCovers`, drift means *"does my scope actually name these files?"* — which is
  what "is my claim honest?" is really asking, and it can fail.

**Both facts are worth having, and they are not in conflict**: a file can be outside your
scope by the strict reading while a peer's check would still surface your lock by the
loose one. Reporting the strict answer with the loose one as mitigation ("not covered by
your globs, though a conflict check would still surface this lock") is more useful than
either alone.

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
- `markdown.test.ts` — frontmatter + body round-tripping (`parseLockFile(serializeLockFile(x)) === x`), including the exact documented file shape, and that two parses of identical content get independent frontmatter objects (`gray-matter`'s content-keyed cache returns a *shallow* copy, so without an options argument every frontmatter mutation leaks into the next parse of an identical file).
- `scope.test.ts` — scope normalization, the amendment rules (widen/replace, mutual exclusion, no-op detection, empty-scope refusal), and that the check prompt names MCP tools to an agent and CLI commands to a human.
- `scopeAmendment.test.ts` — amendment through the store: history appended with timestamps rather than overwritten, no history entry for a no-op, whole-or-nothing failure when a bad `task_text` accompanies a good amendment, and **the issue #3 collision reproduced end to end** — a conflict check that misses grown work before the amendment and catches it after.
- `drift.test.ts` — `listChangedFiles` against a real git repo (staged/unstaged/untracked, untracked directories expanded, renames counting both paths, paths containing spaces unmangled), and `checkScopeDrift`'s reporting, warnings, read-only guarantee, and agreement with the conflict matcher.
- `globOverlap.test.ts` — the overlap heuristic, including the extglob fallback case and the documented case-sensitivity gap.
- `store.test.ts` — the full lock lifecycle (create → update → finish), the hard "done excluded from default query" requirement, exact task-text matching (with a clear error on mismatch, never a silent no-op), and conflict-checking.
- `cli.test.ts` — every subcommand's success and usage-error paths, including scope amendment via `--add-scope`/`--set-scope`, the `drift` report, and that `--base-dir` is actually honoured rather than accepted and ignored.
- `crossRepo.test.ts` — that `base_dir` genuinely reaches another repository's store, in both directions, rather than being accepted and ignored.
- `staleness.test.ts` — the computed `stale`/`staleForSeconds` flags, the env-var and per-call thresholds, and that reading never mutates.
- `git.test.ts` — creates a **real** temporary git repository and a **real** linked worktree (via actual `git init`/`git worktree add` subprocess calls) and proves `resolveLocksRoot()` returns the identical path from both, that `--git-dir` would have differed, and that a path under `.git/agents-locks/` can never enter git's index.
- `e2e.test.ts` — spawns the **actual compiled `dist/index.js`** as a real subprocess (via the MCP SDK's own `Client` + `StdioClientTransport`, exactly how Claude Code itself talks to an MCP server) and drives real JSON-RPC round trips: `initialize`, `tools/list`, and a full `lock_create` → `lock_query` → `lock_update` → `lock_finish` → `lock_query` cycle against the real filesystem, plus a real tool-error round trip for a bad `task_text`.

### Verification performed for this project (not just unit tests)

In addition to the automated suite above, the following were run manually against the actual built artifacts:

1. `node dist/index.js` spawned directly and driven through `initialize` → `lock_create` → `lock_query` via the MCP SDK's client (this is what `e2e.test.ts` also automates).
2. `pnpm dlx <local tarball produced by \`npm pack\`>` — spawned exactly the way a real consumer's package manager would install and run it, driven through the same `initialize` → `tools/list` → `lock_create` round trip, and the created lock file was independently confirmed on disk under a real temporary git repo's `.git/agents-locks/`.
3. `pnpm dlx github:luohoa97/agent-locks` (after this repo was pushed) — the actual pre-npm-publish install command from this README, run for real against the pushed GitHub repository, exercising the identical `command: pnpm, args: [dlx, ...]` shape a Claude Code config would use.

## License

MIT
