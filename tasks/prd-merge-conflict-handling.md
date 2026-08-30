# PRD: Merge Conflict Handling and Run Reliability

## Introduction

An audit of nightralph found that the merge-conflict path has correctness
bugs that can silently drop completed work. Tickets are marked `done`
before their branches merge, the "respawn" strategy never actually
re-runs the agent, and several minor gaps (missing conflict flags,
no worktree cleanup, no failure entries in progress) reduce reliability
and observability. This PRD covers fixing all five issues so that
nightralph handles conflicts correctly and cleans up after itself.

## Goals

- Ensure a ticket is only marked `done` after its branch is
  successfully merged into the base branch
- Implement the respawn strategy so that merge conflicts trigger
  a re-run of the agent in the same worktree
- Make `mergeWave` results always reflect the true merged/conflicted
  state of each branch
- Clean up worktrees for successfully merged tickets automatically
- Record failed tickets in progress.md so the user can see what
  happened without checking logs

## User Stories

### US-001: Defer markDone until after merge

**Description:** As a user, I want tickets to stay `ready-for-agent`
until their branch is successfully merged so that failed merges don't
silently drop my work or unblock dependents prematurely.

**Acceptance Criteria:**

- [ ] `markDone` is not called until the ticket's branch has been
      merged into the base branch
- [ ] If a ticket's agent succeeds (exit 0) but its merge conflicts,
      the ticket retains status `ready-for-agent` on disk
- [ ] `checkTicket` in progress.md is not called for a ticket whose
      merge failed
- [ ] Dependents of an unmerged ticket are not unblocked in subsequent
      waves
- [ ] Existing tests for the happy path (agent succeeds, merge clean)
      still pass
- [ ] New test: agent exits 0, merge conflicts -- ticket stays
      `ready-for-agent`
- [ ] Typecheck/lint passes

### US-002: Implement respawn on merge conflict

**Description:** As a user, I want the orchestrator to re-run the agent
in the same worktree when a merge conflicts so that the agent can
resolve the conflict against the updated base branch, matching the
documented behavior.

**Acceptance Criteria:**

- [ ] When `mergeWave` reports a branch as conflicted and strategy is
      `'respawn'`, `runWavesIsolated` re-runs `spawnAgent` in that
      ticket's existing worktree
- [ ] Before re-running, the worktree is updated to reflect the current
      base branch (rebase or merge from base so the agent sees the
      conflict)
- [ ] If the re-spawned agent exits 0, merge is retried
- [ ] If the re-spawned agent fails or the retry merge still conflicts,
      the ticket stays `ready-for-agent` and is reported
- [ ] Respawn is attempted at most once per wave to avoid infinite loops
- [ ] New test: two-branch wave where second branch conflicts, agent is
      re-spawned and succeeds on retry
- [ ] New test: respawn agent fails -- ticket stays `ready-for-agent`
- [ ] Typecheck/lint passes

### US-003: Set conflicted flag after rebase-then-merge failure

**Description:** As a developer, I want `mergeWave` to always set
`conflicted: true` when a branch fails to merge so that consumers can
reliably detect the failure.

**Acceptance Criteria:**

- [ ] In `mergeWave`, when `rebaseBranch` succeeds but `mergeBranch`
      returns false, `mergingResult.conflicted` is set to `true`
- [ ] The stop strategy correctly triggers `stoppedAt` in this case
- [ ] New test: rebase succeeds, merge fails -- result has
      `conflicted: true` and `merged: false`
- [ ] Typecheck/lint passes

### US-004: Clean up worktrees after successful merge

**Description:** As a user, I want worktrees for successfully merged
tickets to be removed automatically so that I don't accumulate sibling
directories after a large run.

**Acceptance Criteria:**

- [ ] After a ticket's branch is successfully merged, its worktree is
      removed via `removeWorktree`
- [ ] Worktrees for failed or conflicted tickets are left intact for
      manual inspection
- [ ] If worktree removal fails (e.g. directory already gone), the
      error is logged but does not stop the run
- [ ] New test: after a successful wave, merged worktrees no longer
      exist on disk
- [ ] New test: after a failed ticket, its worktree still exists
      (existing test, verify it still passes)
- [ ] Typecheck/lint passes

### US-005: Record failed tickets in progress.md

**Description:** As a user, I want progress.md to show which tickets
failed and their exit codes so that I can see the full picture without
checking individual log files.

**Acceptance Criteria:**

- [ ] When an agent exits non-zero, `checkTicket` is called with
      `done: false` or an equivalent mechanism that records the failure
- [ ] progress.md shows failed tickets with their exit code
- [ ] Failed tickets are visually distinct from successful ones (e.g.
      unchecked box with exit code metadata)
- [ ] `commitProgress` is called after recording the failure
- [ ] New test: agent fails -- progress.md contains the ticket with
      exit code and unchecked checkbox
- [ ] Typecheck/lint passes

## Functional Requirements

- FR-1: `runWavesIsolated` must not call `markDone` until
  `mergeWave` confirms the branch merged successfully
- FR-2: `runWavesIsolated` must track worktree paths alongside
  branch results so it can re-spawn agents and clean up
- FR-3: When `mergeWave` returns a conflicted branch and strategy is
  `'respawn'`, re-run `spawnAgent` in the ticket's worktree, then
  retry the merge -- at most once per ticket per wave
- FR-4: `mergeWave` must set `conflicted = !mergeSuccess` after a
  successful rebase followed by a failed merge
- FR-5: After a successful merge, call `removeWorktree` for that
  ticket's worktree; log and continue on removal failure
- FR-6: Call a progress-recording function for failed tickets that
  writes exit code and keeps the checkbox unchecked
- FR-7: Update the README to accurately describe respawn behavior
  once implemented

## Non-Goals

- No retry limit configuration (hardcoded to one respawn attempt)
- No automatic conflict resolution (the agent decides how to resolve)
- No worktree cleanup CLI command (out of scope; cleanup is automatic)
- No changes to the non-isolated `runWaves` path (it has no merge step)
- No changes to the `setup` command or skill bundling

## Technical Considerations

- The current `mergeWave` return type (`WaveMergeResult`) is sufficient
  to carry conflict info; no type changes needed there, just the missing
  flag assignment
- `removeWorktree` already exists in `src/worktree.ts` and is tested;
  it just needs to be called from the right place
- The respawn loop must avoid re-spawning indefinitely; a single retry
  per ticket per wave is the simplest bound
- `checkTicket` in `src/progress.ts` currently sets `done: true`; a
  new function or overload is needed to record failures with
  `done: false` plus an exit code
- The `runWavesIsolated` function will grow in complexity; consider
  extracting the per-ticket post-processing (merge, respawn, cleanup,
  progress) into a helper

## Success Metrics

- A run with merge conflicts does not silently drop any completed work
- After a clean run, no leftover worktree directories remain
- progress.md reflects the true state of every ticket (done, failed,
  or pending) at any point during the run
- All existing tests continue to pass

## Open Questions

- Should the respawn prompt include information about the conflict
  (e.g. which files conflicted) to help the agent resolve it?
- Should there be a `--max-retries` flag for the respawn count, or is
  one retry sufficient for v1?
- Should `runWaves` (the non-isolated path) gain failure recording
  in progress.md too, or is that a separate effort?
