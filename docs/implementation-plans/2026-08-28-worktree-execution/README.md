# Implementation Plan: Worktree Execution

**Feature:** Git worktree isolation for the `tdd` execution phase
**Date:** 2026-08-28
**Branch:** `wip`

## Overview

Add git worktree isolation, progress tracking, and wave-end merge
to the nightralph orchestrator. This is the `tdd` phase in the
`grill -> to-spec -> to-tickets -> tdd` pipeline.

## Phases

| Phase | Module | Description |
|-------|--------|-------------|
| [1](phase_01.md) | `src/worktree.ts` | Worktree lifecycle (create, remove, list) |
| [2](phase_02.md) | `src/progress.ts` | Progress tracking file (generate, update, commit) |
| [3](phase_03.md) | `src/merge.ts` | Sequential merge with rebase at wave boundaries |
| [4](phase_04.md) | `src/orchestrator.ts` + `src/index.ts` | Wire everything into the orchestrator and CLI |
| [5](phase_05.md) | `src/orchestrator.ts` | Dry-run output for isolated mode |

## Dependency graph

```
Phase 1 (worktree) ──┐
                      ├── Phase 4 (integration) ── Phase 5 (dry-run)
Phase 2 (progress) ──┤
                      │
Phase 3 (merge) ──────┘
```

Phases 1, 2, and 3 are independent and can be implemented in any
order (or in parallel). Phase 4 depends on all three. Phase 5
depends on phase 4.

## New files

- `src/worktree.ts`
- `src/progress.ts`
- `src/merge.ts`
- `test/worktree.test.ts`
- `test/progress.test.ts`
- `test/merge.test.ts`

## Modified files

- `src/orchestrator.ts` -- add `runWavesIsolated()`, modify
  `spawnAgent()` to accept `cwd`
- `src/index.ts` -- add `-X` flag, route to `runWavesIsolated()`
- `package.json` -- add new modules to esbuild and test scripts

## Design context

See [design-context.md](design-context.md) for the full set of
decisions and rationale.
