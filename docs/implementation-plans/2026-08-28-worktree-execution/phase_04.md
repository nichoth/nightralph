# Phase 4: Orchestrator integration

Wire the worktree, progress, and merge modules into the existing
`runWaves()` flow. This is the only phase that modifies existing files.

## Why this phase is fourth

Phases 1-3 built and tested all the pieces independently. This
phase is pure wiring -- connecting the pieces into the orchestrator
and CLI.

## Tasks

### 4A. Modify `src/orchestrator.ts` -- new `runWavesIsolated()`

Add a new function alongside the existing `runWaves()`. Do not
remove `runWaves()` -- it stays as the non-isolated fallback.

```ts
export async function runWavesIsolated(opts:{
    tickets:Ticket[]
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    featureName:string
    conflictStrategy:MergeConflictStrategy
}):Promise<void>
```

**Flow:**

1. Get repo info:
   ```ts
   const repoRoot = getRepoRoot()
   const repoName = getRepoName()
   const baseBranch = getCurrentBranch()
   ```

2. Generate and commit initial progress:
   ```ts
   const progressPath = join(
       dirname(opts.logsDir), 'progress.md'
   )
   const progress = generateProgress(
       opts.featureName, opts.tickets
   )
   writeProgress(progressPath, progress)
   await commitProgress(
       repoRoot, progressPath,
       `nightralph: start ${opts.featureName}`
   )
   ```

3. Wave loop (similar structure to `runWaves`):

   ```
   while (true):
     ready = findReadyTickets(tickets)
     if empty: break

     // Create worktrees for all ready tickets
     worktrees = await Promise.all(
       ready.map(t => createWorktree({
         repoRoot, repoName, baseBranch, ticket:t
       }))
     )

     // Spawn agents in parallel, each in its worktree
     results = await Promise.allSettled(
       ready.map((t, i) => {
         const prompt = renderPrompt(specBody, t)
         const logPath = join(logsDir, ...)
         return spawnAgent({
           prompt,
           agentCmd,
           model,
           timeout,
           logPath,
           cwd:worktrees[i].worktreePath,  // NEW
         })
       })
     )

     // Update progress for completed tickets
     for each successful result:
       markDone(ticket)
       checkTicket(progress, ticket.num, {
         branch:worktrees[i].branchName,
         exitCode:0,
       })
       writeProgress(progressPath, progress)
       await commitProgress(
         repoRoot, progressPath,
         `nightralph: ${ticket.filename} done`
       )

     // Batch merge at wave end
     successfulBranches = collect branches for
       tickets that completed this wave
     mergeResult = await mergeWave({
       repoRoot,
       baseBranch,
       branches:successfulBranches,
       strategy:opts.conflictStrategy,
     })

     // Handle conflicts (respawn strategy)
     if strategy === 'respawn':
       for each conflicted branch:
         create new worktree from updated base
         re-run agent
         if re-run succeeds: merge (should be clean)

     // Handle conflicts (stop strategy)
     if mergeResult.stoppedAt:
       log which branch conflicted
       break

     // Deadlock protection
     if no tickets completed: break
   ```

### 4B. Modify `spawnAgent()` to accept `cwd`

Add an optional `cwd` field to the `spawnAgent` options:

```ts
export function spawnAgent(opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string        // NEW
}):Promise<number>
```

Pass `cwd` through to the `spawn()` call:

```ts
const proc = spawn(opts.agentCmd, args, {
    stdio:['pipe', 'pipe', 'pipe'],
    cwd:opts.cwd,      // NEW -- undefined = inherit
})
```

This is backward-compatible. When `cwd` is undefined,
`spawn` uses the parent's cwd (existing behavior).

### 4C. Modify CLI (`src/index.ts`) to pass new options

Add the `-X` flag to the CLI:

```ts
.option('X', {
    type:'boolean',
    describe:'Stop on merge conflict instead of ' +
        're-spawning',
    default:false,
})
```

In `runExecute()`, choose `runWavesIsolated` vs `runWaves`
based on whether worktree support is available (i.e., we're
in a git repo). Call `runWavesIsolated` by default when
in a git repo:

```ts
if (isGitRepo()) {
    await runWavesIsolated({
        tickets,
        specBody,
        agentCmd:argv.provider,
        model:argv.model ?? null,
        timeout,
        logsDir,
        featureName:featureName,
        conflictStrategy:argv.X ? 'stop' : 'respawn',
    })
} else {
    await runWaves(...)
}
```

The `featureName` comes from the resolved spec directory
name (already available as the `--spec` value or the
selected feature name).

### 4D. Update existing tests, add integration tests

**Modify `test/orchestrator.test.ts`:**

- Add test for `spawnAgent` with `cwd` option

**New file `test/integration.test.ts` additions or
new file `test/isolated-waves.test.ts`:**

Integration tests that exercise the full
`runWavesIsolated` flow. These need a real git repo with
ticket files. Test cases:

1. Two independent tickets run in parallel worktrees,
   both merge cleanly
2. Two-wave scenario: ticket 2 depends on ticket 1,
   wave 1 merges before wave 2 starts
3. `progress.md` is committed with correct checkbox state
   after each ticket completes
4. Failed ticket leaves its worktree intact
5. `-X` flag causes stop on simulated conflict

Note: testing actual merge conflicts in integration is
hard because the mock agents would need to produce
conflicting changes. Consider a targeted unit test in
`test/merge.test.ts` (phase 3) for that, and limit
integration tests to the happy path.

## Acceptance criteria

- [ ] `runWavesIsolated()` creates worktrees, spawns agents,
  updates progress, and merges at wave boundaries
- [ ] `spawnAgent()` accepts and uses `cwd`
- [ ] CLI has `-X` flag for stop-on-conflict
- [ ] Existing `runWaves()` is unchanged (non-isolated fallback)
- [ ] All existing tests still pass
- [ ] New integration tests pass
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
