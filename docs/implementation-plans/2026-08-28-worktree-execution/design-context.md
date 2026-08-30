# Worktree Execution -- Design Context

Phase in the pipeline: `grill -> to-spec -> to-tickets -> tdd`

This document captures the design decisions made for the `tdd` execution
phase. The feature adds git worktree isolation, progress tracking, and
wave-end merge to the existing orchestrator.

## Current state

`runWaves()` in `src/orchestrator.ts` executes tickets in waves using
`Promise.allSettled`. All agents share the same working directory. Status
is tracked per-ticket in the ticket file itself (`**Status:** done`).

## Execution flow (target)

```
1. Scan tickets from .scratch/<feature>/issues/
2. Generate progress.md with full metadata
   (checkboxes, timestamps, branch names, exit codes)
3. Commit progress.md to the current branch (base branch)
4. For each wave:
   a. Identify ready tickets
      (status=ready-for-agent, blockers resolved)
   b. Create git worktree per ready ticket
      Named: <repo-name>.<NN>-<slug>
      Branched from current base
   c. Spawn agents in worktrees
      (parallel, Promise.allSettled)
   d. As each agent completes:
      Check its checkbox in progress.md + record metadata
      Commit progress.md update to base branch
      Mark ticket status as done
   e. At wave end -- sequential merge with rebase:
      Merge branch A into base
      Rebase branch B onto updated base, then merge
      If rebase conflicts: re-spawn agent in new worktree
        from updated base (default)
      If -X flag passed: stop and flag for user instead
      Keep all branch refs after merge
   f. Next wave worktrees branch from updated base
5. Failed agents: leave worktree in failed state
6. Repeat until no more tickets are ready
```

## Decisions

| Question | Decision |
|----------|----------|
| Worktree naming | `<repo-name>.<NN>-<slug>` |
| Merge conflicts (default) | Sequential merge + rebase; re-spawn agent on conflict |
| Merge conflicts (`-X` flag) | Sequential merge + rebase; stop on conflict |
| Failed ticket cleanup | Leave worktree in failed state |
| Progress tracking | Separate `progress.md` file, not spec.md |
| Progress persistence | Committed to git (not just disk) |
| progress.md metadata | Checkboxes + timestamp, branch name, exit code |
| Cross-wave deps | Batch merge at wave end so next wave sees prior work |
| Branch cleanup | Keep branch refs after merge |
