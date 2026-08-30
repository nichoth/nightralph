# Phase 3: Wave-end merge strategy

New module `src/merge.ts` for sequential merge with rebase at wave
boundaries.

## Why this phase is third

The merge logic is the most complex part of this feature. Isolating
it in its own module keeps the orchestrator changes (phase 4) focused
on wiring, not algorithm.

## Tasks

### 3A. Create `src/merge.ts`

Add the module to the esbuild entry points in `package.json`.

**Types:**

```ts
type MergeConflictStrategy = 'respawn' | 'stop'

type MergeResult = {
    branch:string
    ticketNum:number
    merged:boolean
    conflicted:boolean
}

type WaveMergeResult = {
    merged:MergeResult[]
    stoppedAt:MergeResult|null  // non-null if strategy=stop
                                // and a conflict occurred
}
```

**Functions to implement:**

```ts
mergeBranch(
    repoRoot:string,
    branch:string,
):Promise<boolean>
```
Runs `git merge <branch> --no-edit` in `repoRoot`.
Returns `true` if merge succeeds, `false` if it conflicts.
On conflict, runs `git merge --abort` to restore clean state.

```ts
rebaseBranch(
    repoRoot:string,
    branch:string,
    onto:string,
):Promise<boolean>
```
Runs `git rebase <onto> <branch>` (this rebases `branch` onto
`onto` without checking it out). Returns `true` if clean,
`false` if conflicts. On conflict, runs `git rebase --abort`.

Note: this uses the detached form of rebase so we don't need
to checkout the branch. The orchestrator is checked out on the
base branch.

Actually, `git rebase <onto> <branch>` does leave HEAD on
`<branch>` after completion. So the sequence should be:

1. `git checkout <branch>`
2. `git rebase <onto>`
3. If success: `git checkout <baseBranch>`
4. If conflict: `git rebase --abort && git checkout <baseBranch>`

Alternatively, use `git rebase --onto <onto> <fork-point> <branch>`.
The simpler approach: since we're merging sequentially and the
orchestrator stays on the base branch, just do:

```
git rebase <baseBranch> <branch>
```

This rebases `branch` onto the current `baseBranch` tip. After
success, `git checkout <baseBranch>` to return. Then
`git merge <branch> --ff-only` since it's now a fast-forward.

```ts
mergeWave(opts:{
    repoRoot:string
    baseBranch:string
    branches:{ branch:string; ticketNum:number }[]
    strategy:MergeConflictStrategy
}):Promise<WaveMergeResult>
```

Merges all branches from a wave sequentially:

1. For the first branch: `mergeBranch(repoRoot, branch)`
2. For each subsequent branch:
   a. `rebaseBranch(repoRoot, branch, baseBranch)`
   b. If rebase succeeds: `mergeBranch(repoRoot, branch)`
      (should be fast-forward)
   c. If rebase conflicts:
      - If `strategy === 'stop'`: return immediately with
        `stoppedAt` set
      - If `strategy === 'respawn'`: return with
        `conflicted:true` in the result. The orchestrator
        handles the re-spawn (phase 4).
3. Return all merge results.

### 3B. Tests for merge module

File: `test/merge.test.ts`

Add to the `test` script in `package.json`.

Tests require real git repos with actual branches and commits.
Helper:

```ts
function initRepoWithFile(
    dir:string,
    filename:string,
    content:string,
):void {
    writeFileSync(join(dir, filename), content)
    execSync('git add .', { cwd:dir })
    execSync(`git commit -m "add ${filename}"`, { cwd:dir })
}
```

**Test cases:**

1. `mergeBranch` merges a clean branch (no conflicts)
2. `mergeBranch` returns false and aborts on conflict
3. `rebaseBranch` rebases a branch onto updated base
4. `rebaseBranch` returns false and aborts on conflict
5. `mergeWave` merges multiple non-conflicting branches
   sequentially
6. `mergeWave` with `strategy:'stop'` stops at first conflict
   and returns `stoppedAt`
7. `mergeWave` with `strategy:'respawn'` marks conflicted
   branch and continues with remaining branches

## Acceptance criteria

- [ ] `src/merge.ts` exports all types and functions
- [ ] `test/merge.test.ts` passes
- [ ] Merge conflicts are properly detected and aborted
  (no dirty git state left behind)
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] No changes to orchestrator code
