# Integration branch and review pass

Date: 2026-10-07
Status: design approved, awaiting spec review

## Problem

Two gaps, both borrowed fixes from the `/implement-spec` skill
(aihero.dev):

1. `runWavesIsolated` merges every ticket into whatever branch was
   checked out at launch (`getCurrentBranch()`). Launched from `main`,
   an unattended overnight run writes straight to `main`.
2. Nothing looks at the combined result. Each ticket passes its own
   test gate, but no step reviews the merged work as a whole, so
   cross-ticket bugs, missing tests, and contract drift reach the
   human unflagged.

## Goal

A run launched from the default branch lands all its work on one
integration branch the human can review in the morning, and every run
ends with one code review of the unreviewed work plus one fix pass
whose changes pass the test gate before they merge.

## Acceptance Criteria

### integration-branch-review-design.AC1: Branch planning
- **integration-branch-review-design.AC1.1 Success:**
  `integrationBranchName` returns `nightralph--<feature>` for exactly
  one feature, and `nightralph--all` for several or none.
- **integration-branch-review-design.AC1.2 Success:**
  `planIntegrationBranch` returns that name when the current branch is
  the default branch, and `null` otherwise.
- **integration-branch-review-design.AC1.3 Edge:**
  `planIntegrationBranch` returns `null` when the default branch is
  unknown (`null`) or HEAD is detached (`HEAD`).
- **integration-branch-review-design.AC1.4 Success:**
  `getDefaultBranch` reads `origin/HEAD` when it exists.
- **integration-branch-review-design.AC1.5 Edge:** Without
  `origin/HEAD`, `getDefaultBranch` returns `main` or `master`,
  whichever exists locally, else `null`.

### integration-branch-review-design.AC2: Integration branch in a run
- **integration-branch-review-design.AC2.1 Success:** With
  `integrationBranch` set and no such branch, the run creates it from
  the current branch, merges every ticket into it, and leaves the
  launch branch where it was.
- **integration-branch-review-design.AC2.2 Success:** With
  `integrationBranch` set and the branch already present, the run
  checks it out, keeps tickets already `done` there, and logs how many
  commits the launch branch is ahead.
- **integration-branch-review-design.AC2.3 Success:** Without
  `integrationBranch`, the run merges into the current branch exactly
  as before.
- **integration-branch-review-design.AC2.4 Success:** The run returns
  `{ allDone, branch }`, with `branch` naming where the work landed,
  and the main checkout is left on that branch.
- **integration-branch-review-design.AC2.5 Failure:** A dirty working
  tree still throws before any branch is created or checked out.

### integration-branch-review-design.AC3: Review log
- **integration-branch-review-design.AC3.1 Success:** An entry built
  by `renderReviewEntry` and read back by `parseReviewEntries` keeps
  `from`, `to`, `status`, and each finding with its checked state.
- **integration-branch-review-design.AC3.2 Edge:** Findings or notes
  containing the sentinel prefix still parse as exactly one entry.
- **integration-branch-review-design.AC3.3 Edge:** Malformed entries
  (missing `from`/`to`, unknown status) are dropped, not thrown; CRLF
  is accepted.

### integration-branch-review-design.AC4: Review range
- **integration-branch-review-design.AC4.1 Success:**
  `selectReviewBase` returns the `to` of the latest entry whose status
  is not `review-failed`.
- **integration-branch-review-design.AC4.2 Failure:** A marker that is
  not an ancestor of the tip is ignored.
- **integration-branch-review-design.AC4.3 Edge:** With no usable
  marker, the base is the integration branch's merge-base with the
  default branch, or the launch commit when no integration branch is
  in use.
- **integration-branch-review-design.AC4.4 Edge:** A range whose only
  changes are under `.scratch/` skips the review entirely: no agent
  runs and no entry is written.

### integration-branch-review-design.AC5: Reviewer
- **integration-branch-review-design.AC5.1 Success:** A reviewer that
  writes findings produces a parsed checklist, and its worktree and
  branch are removed.
- **integration-branch-review-design.AC5.2 Success:** A reviewer that
  writes `No findings.` produces a `clean` entry, and no fixer runs.
- **integration-branch-review-design.AC5.3 Success:** A findings file
  written before a timeout kill still counts.
- **integration-branch-review-design.AC5.4 Failure:** A reviewer that
  leaves no findings file (or a blank one) is retried; after the last
  attempt the entry is `review-failed`, no fixer runs, and the marker
  does not move.
- **integration-branch-review-design.AC5.5 Success:** Code the
  reviewer changes or commits never reaches the integration branch.

### integration-branch-review-design.AC6: Fixer
- **integration-branch-review-design.AC6.1 Success:** A fixer whose
  test gate is green merges into the integration branch; the entry is
  `fixed` and checks the findings it echoed as `[x]`.
- **integration-branch-review-design.AC6.2 Failure:** A fixer with a
  red test gate, a non-zero exit, or no commits is retried; after the
  last attempt nothing merges, the entry is `unresolved`, and every
  finding stays unchecked.
- **integration-branch-review-design.AC6.3 Success:** In both cases
  the marker moves to `to`, so the next run does not review the same
  range again.
- **integration-branch-review-design.AC6.4 Success:** A retry's prompt
  carries the previous attempt's notes and failure reason.

### integration-branch-review-design.AC7: Wiring and safety
- **integration-branch-review-design.AC7.1 Success:** The `review.md`
  entry is committed on the integration branch, and the finish summary
  names the finding count, the fixed count, and the file.
- **integration-branch-review-design.AC7.2 Failure:** A throw inside
  the review pass is logged through the display, does not crash the
  run, and does not change `allDone`.
- **integration-branch-review-design.AC7.3 Success:** Without the
  `review` option no reviewer runs, so existing callers and tests are
  unaffected.
- **integration-branch-review-design.AC7.4 Success:**
  `runTicketAttempts` on top of `runWithRetries` keeps today's retry
  behavior (attempt count, effort escalation, backoff, log names); the
  existing retry tests pass unchanged.

## Decisions

1. **When to create the branch.** Only when launched from the default
   branch. On any other branch the user has already chosen where work
   goes, so nightralph merges there as today. No flag to override the
   name yet.
2. **Branch name.** `nightralph--<feature>`, or `nightralph--all` for
   a multi-feature run. No date: a rerun the next day must find the
   same branch. `--` instead of `/` for the same ref-hierarchy reason
   as `buildBranchName`.
3. **Existing branch.** Resume it. Ticket status lives on the
   integration branch, so branching fresh from `main` would redo
   finished work. Staleness is reported, not fixed.
4. **Policy in the CLI, mechanism in the library.** The CLI decides
   whether to use an integration branch and whether to review;
   `runWavesIsolated` only acts on what it is given. This keeps the 37
   existing isolated-run tests unchanged.
5. **Two agents.** A reviewer writes findings; a separate fixer
   addresses them. Findings survive a failed fix, and the fixer cannot
   grade its own work.
6. **Review on by default** in the CLI, `--no-review` to skip. Costs
   two agent runs per night, not per ticket.
7. **Range.** Everything since the last reviewed commit, tracked in
   `review.md`. A run that dies before its review leaves that work in
   the next run's range instead of skipping it.
8. **Failed fix.** Retried like tickets; on final failure the findings
   are recorded as unresolved and the marker still advances. A finding
   that survives several escalating attempts needs a human, and
   re-reviewing it nightly would waste runs.
9. **Spec is pasted, not pointed to.** Same as `renderPrompt`: the
   orchestrator is code, so pasting is verbatim, and `.scratch/` may
   be gitignored and absent from the worktree.

## Design

### Integration branch

New in `src/worktree.ts`:

- `getDefaultBranch(repoRoot):string|null` -- `git symbolic-ref
  --short refs/remotes/origin/HEAD` with `origin/` stripped; else
  `main` or `master` if that local branch exists; else `null`.
- `integrationBranchName(features:ReadonlyArray<string>):string` --
  pure, see AC1.1.
- `planIntegrationBranch(current, defaultBranch, features)` -- pure;
  the name when `current === defaultBranch`, else `null`.
- `enterIntegrationBranch(repoRoot, name)` -- checks out an existing
  branch and returns `{ created:false, behind:n }`, where `n` is
  `git rev-list --count <name>..<launch branch>`; otherwise
  `git checkout -b <name>` and `{ created:true, behind:0 }`.

`runWavesIsolated` gains `integrationBranch?:string`. After the
dirty-tree check it records the launch commit, and when
`integrationBranch` is set it calls `enterIntegrationBranch` and uses
that name as `baseBranch` for worktrees, merges, progress and
learnings commits, and the review. It logs one line, e.g.
`Created branch nightralph--x from main` or
`Resumed nightralph--x (main is 3 commits ahead)`. It returns
`{ allDone, branch }` and leaves the main checkout on `branch`;
`renderFinishSummary`'s caller adds a `Work is on <branch>` line.

`dryRunIsolated` takes the same option and prints the branch it would
create or resume, without checking anything out. In-place `runWaves`
is unchanged.

### Review log: `review.md`

Location: `.scratch/<feature>/review.md` for a single-feature run,
`.scratch/review.md` for a multi-feature run. The CLI computes it and
passes `review:{ reviewPath }`.

Append-only, one entry per review pass:

```
<!-- nightralph:review from=<sha> to=<sha> status=<status> -->
## 2026-10-07 03:40 -- review abc1234..def5678 -- 2 of 3 fixed
- [x] finding one
    detail: file:line, failure scenario
- [x] finding two
- [ ] finding three

### Fix
effort high, exit 0, tests passed, attempt 2 of 4
<fixer notes>
---
```

`status` is one of `clean`, `fixed`, `unresolved`, `review-failed`.
`to` is the integration tip after the fix merge, or the tip at review
time when nothing merged. Sentinel text inside findings and notes is
neutralized as in `learnings.ts`.

### Review range

`selectReviewBase(entries, { isAncestor, integrationBase,
launchCommit })` is pure; `isAncestor` is a callback so git stays out
of the core. It returns the marker (AC4.1) if `isAncestor(marker)`,
else `integrationBase` when set, else `launchCommit`.

The pass is skipped when
`git diff --quiet <from>..<tip> -- . ':(exclude).scratch'` exits 0.
Ticket files, progress, learnings, and `review.md` are bookkeeping;
excluding them means the commit that records a review does not make
the next range look non-empty.

### Reviewer

`createNamedWorktree({ repoRoot, repoName, baseBranch, name })` is
added to `src/worktree.ts`, serialized on the same `worktreeQueue`
with the same stale-cleanup; `createWorktree` delegates to it. The
reviewer uses `<repo>.review` on `<repo>--review`.

Per attempt:

1. Create the worktree, `ensureNotesIgnored`, run `installCmd`
   (`review.install.log`).
2. `spawnAgent` with `renderReviewPrompt({ specBody, from, to,
   pathspec })`. The prompt pastes the spec(s), gives the exact diff
   command, names AGENTS.md and its contracts as the standard, asks
   for correctness bugs, missing tests, and contract violations ranked
   most severe first and no style preferences, and asks for
   `.nightralph/findings.md`: one `- [ ] <one-line summary>` per
   finding with indented detail (file:line, concrete failure
   scenario), or the single line `No findings.` It says not to edit
   code and not to push.
3. `collectNotes(worktreePath, 'findings.md')` -- `collectNotes` gains
   an optional `file` argument, default `notes.md`.
4. Remove the worktree with `force:true` and delete its branch.

Success is decided by the findings file alone. Logs:
`review.log`, `review.attempt<n>.log`.

### Fixer

Runs only when there is at least one finding. Per attempt:

1. `createNamedWorktree` from the integration tip, `<repo>.review-fix`
   on `<repo>--review-fix`; `ensureNotesIgnored`; `installCmd`
   (failure fails the attempt).
2. `spawnAgent` with `renderFixPrompt({ specBody, findings, testCmd,
   installCmd, previous })`. It reuses the rule lines from
   `renderPrompt` -- /tdd test-first, the test command, worktree
   confinement, no `git push`, commit per finding, notes in
   `NOTES_PATH`, reusable learnings in AGENTS.md, the install rule --
   moved into a shared helper so the prompts cannot drift. Fixer
   rules: fix only the listed findings, echo `[x] <finding summary>`
   for each one fixed, and leave a wrong or unfixable finding
   unchecked with the reason in the notes. `previous` (retries only)
   carries the last attempt's notes and failure reason.
3. Collect notes; auto-commit dirty changes on a timeout; new-commits
   check; test gate (`review-fix.test.log`).
4. On green, `mergeBranch` into the integration branch from the main
   checkout. A conflict is not expected (nothing else merges during
   the pass) and fails the attempt, with git's stderr in the notes.
5. Remove the worktree with `force:true`.

Checked findings come from the fixer's `COMPLETED_RE` matches,
compared with the same whitespace-collapsed, case-insensitive
normalization `checkItems` uses.

Afterward the pass appends the entry and calls
`commitProgress(repoRoot, reviewPath, 'nightralph: record review')`.
Review attempts are not written to `learnings.md`.

### Shared retry helper: `src/retry.ts`

`runWithRetries({ maxAttempts, retryDelay, provider, effort, label,
d }, attempt => Promise<{ stop:boolean; result:T }>)` owns the attempt
loop, `escalateEffort` for known providers, `retryDelayFor` backoff,
and the `retrying (attempt n/m, effort x, waiting ys)` log line.
`runTicketAttempts` is rewritten on it; the reviewer and fixer use it
too.

### Module boundaries

`src/review.ts` holds the pure functions (`renderReviewPrompt`,
`renderFixPrompt`, `parseFindings`, `renderReviewEntry`,
`parseReviewEntries`, `selectReviewBase`) and
`runReviewPass(opts, deps)`, where `deps` is
`{ spawnAgent, runInstall, runTestGate }` injected by
`orchestrator.ts`. Like `learnings.ts`, it imports no values from
`orchestrator.ts`. `runWavesIsolated` calls `runReviewPass` after the
wave loop (including after an `-X` stop) and before the finish
summary, when `opts.review` is set.

### CLI

- `--no-review` (yargs boolean `review`, default `true`).
- The CLI calls `getDefaultBranch` and `planIntegrationBranch` and
  passes the result as `integrationBranch`.
- `--dry-run` prints the planned branch and whether review is on.

### Error handling

The review pass is advisory, like learnings. Any throw is caught in
`runWavesIsolated`, logged through the display, and never changes
`allDone` or the exit code. Worktrees are removed in a `finally`.
SIGINT kills the agent through `killRunningAgents` as today, and no
entry is written.

### Docs

AGENTS.md: CLI (`--no-review`, integration branch behavior),
orchestrator (`runWavesIsolated` options and return value), worktree
(new functions), learnings (`collectNotes` `file` argument), new
`retry` and `review` module contracts, Project Structure entries.
README: a short section on the integration branch and the review
pass.

## Testing

Hermetic temp repos throughout (`git init` with an empty template;
never touch `info/exclude`).

- Unit (`test/review.test.ts`, `test/worktree.test.ts`): AC1.1-AC1.3,
  AC3.1-AC3.3, AC4.1-AC4.3 with a stub `isAncestor`, prompt structure
  checks that do not pin wording.
- Git (`test/worktree.test.ts`): AC1.4-AC1.5 with and without an
  `origin` remote.
- Integration (`test/integration.test.ts`), using new mock agents: a
  reviewer that writes findings, one that writes `No findings.`, one
  that writes nothing, one that commits code; a fixer that commits a
  fix and echoes `[x]`, one that breaks the tests, one that exits
  without commits. Covers AC2.1-AC2.5, AC4.4, AC5.1-AC5.5,
  AC6.1-AC6.4, AC7.1-AC7.3. Tests pass `retryDelay:0`.
- AC7.4 is covered by the existing retry tests passing unchanged.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Shared retry helper

Create `src/retry.ts` with `runWithRetries`; rewrite
`runTicketAttempts` on it.

Done when: AC7.4 -- the full existing suite passes with no test edits.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Integration branch

`getDefaultBranch`, `integrationBranchName`, `planIntegrationBranch`,
`enterIntegrationBranch`, `createNamedWorktree`; the
`integrationBranch` option and `{ allDone, branch }` return in
`runWavesIsolated`; `dryRunIsolated` output; CLI wiring.

Done when: tests pass for AC1.1-AC1.5 and AC2.1-AC2.5.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Review core (pure)

`src/review.ts` pure functions; `collectNotes` `file` argument;
shared rule-lines helper extracted from `renderPrompt`.

Done when: tests pass for AC3.1-AC3.3 and AC4.1-AC4.3; existing
prompt tests pass unchanged.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Review pass wiring

`runReviewPass` with reviewer and fixer, range skip, `review.md`
append and commit, `runWavesIsolated` call site, finish summary line,
`--no-review`, new mock agents.

Done when: integration tests pass for AC4.4, AC5.1-AC5.5,
AC6.1-AC6.4, and AC7.1-AC7.3; the full suite and lint pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Docs

AGENTS.md contracts and Project Structure; README section.

Done when: docs reflect the shipped behavior. Verifies: None.
<!-- END_PHASE_5 -->

## Out of scope

- Opening a draft PR or closing tickets in a tracker.
- A flag to override the integration branch name.
- A standalone `nightralph review` subcommand (easy to add on
  `runReviewPass` later).
- Rebasing a stale integration branch onto the default branch.
- Review for the in-place `runWaves`.
- A display row for the review pass.
