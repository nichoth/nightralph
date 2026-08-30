# Phase 2: Progress tracking file

New module `src/progress.ts` for generating and updating `progress.md`.

## Why this phase is second

Progress tracking is independent of worktrees but must exist before
the orchestrator can use either. Building it as a standalone module
makes it testable in isolation.

## Tasks

### 2A. Create `src/progress.ts`

Add the module to the esbuild entry points in `package.json`.

**Functions to implement:**

```ts
type TicketProgress = {
    num:number
    slug:string
    filename:string
    done:boolean
    branch:string|null
    exitCode:number|null
    completedAt:string|null  // ISO 8601
}

type ProgressData = {
    feature:string
    startedAt:string  // ISO 8601
    tickets:TicketProgress[]
}
```

```ts
generateProgress(
    feature:string,
    tickets:ReadonlyArray<Ticket>
):ProgressData
```
Creates the initial progress data from scanned tickets.
All tickets start with `done:false`, null metadata fields.

```ts
renderProgress(data:ProgressData):string
```
Renders `ProgressData` to markdown. Format:

```markdown
# Progress: <feature>

Started: <ISO timestamp>

- [ ] 01-add-auth.md
- [ ] 02-add-api.md
- [x] 03-add-tests.md
  branch: nightralph/03-add-tests
  exit: 0
  completed: 2026-08-28T14:30:00Z
```

The metadata lines (branch, exit, completed) only appear for
completed items.

```ts
checkTicket(
    data:ProgressData,
    ticketNum:number,
    result:{ branch:string; exitCode:number }
):void
```
Mutates `data` in place: sets `done:true`, fills in branch,
exitCode, and completedAt (using `new Date().toISOString()`).

```ts
writeProgress(
    progressPath:string,
    data:ProgressData
):void
```
Renders and writes to disk. Just
`writeFileSync(path, renderProgress(data))`.

```ts
commitProgress(
    repoRoot:string,
    progressPath:string,
    message:string
):Promise<void>
```
Stages the progress file and commits it:
```
git add <progressPath>
git commit -m <message>
```
Uses `execFile` (promisified). The `repoRoot` is the cwd for
the git commands.

### 2B. Tests for progress module

File: `test/progress.test.ts`

Add to the `test` script in `package.json`.

**Test cases:**

1. `generateProgress` creates entries for all tickets,
   all marked not done
2. `renderProgress` produces valid markdown with unchecked boxes
3. `checkTicket` marks the right ticket done and fills metadata
4. `renderProgress` after `checkTicket` shows `[x]` with
   metadata lines
5. `checkTicket` for unknown ticket number is a no-op
   (does not throw)
6. `commitProgress` creates a git commit containing the
   progress file (use a real temp git repo)

## Acceptance criteria

- [ ] `src/progress.ts` exports all types and functions
- [ ] `test/progress.test.ts` passes
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] No changes to orchestrator or worktree code
