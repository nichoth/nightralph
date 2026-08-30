# Audit Report: nightralph

Date: 2026-08-29

Scope: README.md and all source modules (`orchestrator.ts`, `worktree.ts`,
`merge.ts`, `progress.ts`, `setup.ts`, `resolve.ts`, `index.ts`), plus the
test suite, docs templates, CI workflow, and packaging config.

Verification: lint clean, 100/100 tests pass, and suspicious behaviors were
empirically reproduced in a scratch repo.

## Verified bugs

### 1. Re-running after a failed ticket crashes the CLI (high)

Failed tickets keep status `ready-for-agent` (by design), but their branch
persists. `createWorktree` uses `git worktree add -b <branch>`, which fails
when the branch already exists. Since `runWavesIsolated` creates all wave
worktrees via `Promise.all`, one rejection crashes the whole run with a raw
error — no cleanup, no friendly message. Verified:

```
SECOND CREATE FAILED: Command failed: git worktree add -b repo/01-a ... main
```

**Fix:** detect an existing branch/worktree and reuse it (or
`git worktree remove` + `branch -D` before re-creating), and wrap worktree
creation so failures are reported per-ticket.

### 2. `commitProgress` crashes when `.scratch/` is gitignored (high)

`.scratch/` being in `.gitignore` is common, but `commitProgress` does
`git add <path>`, which fails on ignored paths. Verified:

```
commitProgress THROWS: The following paths are ignored by one of your .gitignore files
```

`runWavesIsolated` awaits this unhandled at startup and also after every
ticket, so a gitignored `.scratch` kills the entire run. The `setup` command
also never checks or warns about this.

**Fix:** check whether `.scratch` is ignored during setup/run start and error
with a clear message, or fall back to skipping progress commits.

### 3. Missing/other statuses count as "done" for blocker resolution (high)

`findReadyTickets` builds `doneNums` from `status !== 'ready-for-agent'`.
A ticket with **no `**Status:**` line** (status `''`) or a status like
`claimed`/`in-progress` is treated as completed, so its dependents get
unblocked and run before the blocker was ever executed. Verified with the
exported function. Notably, the bundled `docs/agents/issue-tracker.md`
template itself uses `claimed`/`resolved` statuses, so this is a realistic
scenario, not a theoretical typo case.

**Fix:** treat only an explicit `done` status as complete; optionally warn on
tickets with unrecognized statuses.

## Likely practical issues

### 4. Spawned agents probably can't write files (high, untested by mocks)

`getProviderArgs` maps `claude → ['--print']` and `codex → ['exec']` with no
permission/sandbox flags. Headless `claude -p` without
`--permission-mode`/`--dangerously-skip-permissions` (or pre-approved
settings) cannot edit files; `codex exec` without
`--full-auto`/`--sandbox workspace-write` defaults to a read-only sandbox.
The mock-agent tests bypass this, so out of the box every ticket will likely
fail the "agent exited 0 but made no commits" check. At minimum the README
should document required provider config; better, pass appropriate flags by
default.

### 5. Orphaned worktrees (medium)

Worktrees are removed only on the merged/recovered paths. Worktrees for
failed tickets — and for successful branches skipped after `mergeWave` hits
`stoppedAt` — are never removed and accumulate as siblings of the repo.

### 6. Progress resets on resume (low)

`runWavesIsolated` calls `generateProgress` fresh at start, overwriting
`progress.md` with everything unchecked. Resuming a partially completed run
loses prior progress history (ticket statuses in the issues files are
preserved, but the progress file is not reconstructed).

### 7. Dead code / wrong semantics in `runWaves` (low)

The `hasNewCommits(repoRoot, baseSha, 'HEAD')` check is unreachable —
`runWaves` only runs when outside a git repo, so `repoRoot` is always null.
If it were ever reachable, the HEAD-based check is wrong for parallel agents
sharing one checkout anyway.

### 8. Cosmetic (low)

- `checkTicket` stamps `completedAt` for failed tickets too.
- `npm test` bundles into `dist/test/`, and those files are published to npm
  (verified via `npm pack --dry-run`); consider a `files` field or excluding
  them.

## Doc inconsistencies

- **AGENTS.md says "Node >= 18"**, but `package.json` engines is `>=24` and
  CI tests only Node 25.x.
- README says "On success (agent exit 0), the ticket's status is updated to
  `done`" — the code additionally requires new commits and a clean worktree.
  Worth stating since it changes what "success" means.
- README's provider examples (`claude`, `codex`) don't mention the permission
  flags needed per issue #4.

## What's solid

- Tests pass (100/100) and lint is clean; coverage of merge strategies,
  progress, setup, and CLI exit codes is good.
- `spawnAgent` handles ENOENT gracefully (verified — resolves with code 1,
  no unhandled stream errors).
- Unknown blockers are warned about and filtered before planning; deadlock
  detection works for genuine cycles.
- The merge-wave strategy (first direct, rest rebased, abort-on-conflict with
  rollback) matches the documented contract in AGENTS.md, as do the worktree
  naming and progress-file guarantees.

## Priority summary

The highest-value fixes are #1–#4: they're all reachable in a normal first or
second run of the tool against a freshly scaffolded repo.
