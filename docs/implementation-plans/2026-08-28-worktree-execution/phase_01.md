# Phase 1: Worktree lifecycle management

New module `src/worktree.ts` for creating and managing git worktrees.

## Why this is first

Everything else depends on the ability to create and remove worktrees.
This phase is purely infrastructure -- no changes to the orchestrator.

## Tasks

### 1A. Create `src/worktree.ts` with core functions

Add the module to the esbuild entry points in `package.json`.

**Functions to implement:**

```ts
getRepoName():string
```
Runs `git rev-parse --show-toplevel`, returns `basename(result)`.
Used to construct worktree directory names.

```ts
getCurrentBranch():string
```
Runs `git rev-parse --abbrev-ref HEAD`. Returns current branch name.
This is the "base branch" that worktrees branch from.

```ts
createWorktree(opts:{
    repoRoot:string
    repoName:string
    baseBranch:string
    ticket:Ticket
}):Promise<{ worktreePath:string; branchName:string }>
```

Creates a git worktree for a single ticket:
- Branch name: `<repoName>/<NN>-<slug>`
  (e.g. `nightralph/01-add-auth`)
- Worktree path: `../<repoName>.<NN>-<slug>`
  (sibling of repo root, so sorted near it in the filesystem)
- Command: `git worktree add -b <branch> <path> <baseBranch>`
- Returns the worktree path and branch name

```ts
removeWorktree(worktreePath:string):Promise<void>
```
Runs `git worktree remove <path>`. Used for cleanup of
successfully merged worktrees if needed in the future.
For now, worktrees are kept after merge.

```ts
listWorktrees(repoRoot:string):Promise<string[]>
```
Runs `git worktree list --porcelain`, parses output, returns
paths. Used for diagnostics / dry-run output.

All git commands should be run via `execFile` from
`node:child_process` (promisified), not `spawn`, since these
are short-lived commands that return small output.

### 1B. Tests for worktree module

File: `test/worktree.test.ts`

Add to the `test` script in `package.json`.

Tests should use a real temporary git repo (not mocks) since
we're testing actual git operations. Helper:

```ts
function initTempRepo():string {
    const dir = mkdtempSync(...)
    execSync('git init', { cwd:dir })
    execSync('git commit --allow-empty -m "init"',
        { cwd:dir })
    return dir
}
```

**Test cases:**

1. `getRepoName` returns the directory basename
2. `getCurrentBranch` returns the branch name
3. `createWorktree` creates a worktree at the expected path
   with the expected branch name
4. `createWorktree` branch is based on the specified base branch
5. `removeWorktree` removes the worktree
6. `listWorktrees` returns all worktree paths

## Acceptance criteria

- [ ] `src/worktree.ts` exports all five functions
- [ ] `test/worktree.test.ts` passes
- [ ] `npm run build` succeeds with the new module
- [ ] `npm run lint` passes
- [ ] No changes to existing orchestrator code in this phase
