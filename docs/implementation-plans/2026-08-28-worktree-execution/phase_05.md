# Phase 5: Dry-run support for isolated mode

Update the `--dry-run` output to reflect the new worktree-based
execution model.

## Why this phase is last

Dry-run is a display concern. It needs to know about worktree
naming and merge strategy to show accurate output, so it comes
after all the functional pieces are in place.

## Tasks

### 5A. Update `dryRun()` in `src/orchestrator.ts`

Add a new `dryRunIsolated()` function (or extend `dryRun`
with an options parameter) that shows:

1. The same wave simulation as today
2. Additionally for each wave:
   - Worktree paths that would be created
     (`../<repoName>.<NN>-<slug>`)
   - Branch names (`<repoName>/<NN>-<slug>`)
3. The merge strategy in effect (`respawn` or `stop`)
4. The progress file path

Example output:
```
Tickets:
  01-add-auth.md (ready-for-agent) no blockers
  02-add-api.md (ready-for-agent) blocked by [1]

Simulated wave order:
  Wave 1: 01-add-auth.md
    worktree: ../myapp.01-add-auth
    branch:   myapp/01-add-auth
  Wave 2: 02-add-api.md
    worktree: ../myapp.02-add-api
    branch:   myapp/02-add-api

Merge strategy: respawn (re-run agent on conflict)
Progress file: .scratch/my-feature/progress.md
```

### 5B. Wire dry-run to CLI

In `runExecute()`, when `--dry-run` is set and we're in a
git repo, call the isolated dry-run variant.

### 5C. Test dry-run output

Add a test that calls the dry-run function and verifies
the output includes worktree paths and branch names.
(Capture stdout or return structured data -- follow
whichever pattern the project uses.)

## Acceptance criteria

- [ ] `--dry-run` shows worktree paths and branch names
- [ ] `--dry-run` shows the active merge strategy
- [ ] `--dry-run` shows the progress file path
- [ ] Existing non-isolated dry-run behavior unchanged
- [ ] `npm test` passes
- [ ] `npm run lint` passes
