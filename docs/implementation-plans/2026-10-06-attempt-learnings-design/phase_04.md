# Attempt Learnings Implementation Plan -- Phase 4: Orchestrator wiring

**Goal:** Every attempt in `runWavesIsolated` records an entry in
`learnings.md`, each agent's prompt carries its own and its direct
blockers' history, and the log is committed without ever leaving the
base tree dirty during merges.

**Architecture:** `runTicketAttempt` builds the history before
spawning and collects the notes file right after the agent exits.
`runTicketAttempt` also writes a self-ignoring `.nightralph/.gitignore`
in the worktree before spawning. `runTicketAttempts` appends one entry
per attempt. `runWavesIsolated` commits the touched learnings files
right after each wave's pool settles, appends a `merge` entry for unrecovered
merges, and `saveProgress` stages the log alongside `progress.md`. All
learnings IO is wrapped: a failure is reported via `d.log` and never
fails a ticket.

**Tech Stack:** TypeScript (ESM), git, `@substrate-system/tapzero`,
mock agents in `test/`.

**Scope:** Phase 4 of 5 from
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md`.

**Codebase verified:** 2026-10-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### attempt-learnings-design.AC5: Later agents see earlier attempts
- **attempt-learnings-design.AC5.1 Success:** A retry's prompt
  contains the previous attempt's agent notes.
- **attempt-learnings-design.AC5.2 Success:** `learnings.md` records
  one entry per attempt, in order, with outcomes matching what
  happened.
- **attempt-learnings-design.AC5.3 Success:** A downstream ticket's
  prompt contains its direct blocker's agent notes.
- **attempt-learnings-design.AC5.4 Success:** A second run's
  first-attempt prompt contains notes written during the first run.

### attempt-learnings-design.AC6: Failures are explained
- **attempt-learnings-design.AC6.1 Success:** Notes written before a
  timeout kill appear in that attempt's entry, and the entry is marked
  timed out.
- **attempt-learnings-design.AC6.2 Success:** A red test gate's entry
  has outcome `tests` and contains the tail of the test log.
- **attempt-learnings-design.AC6.3 Success:** An unrecovered merge
  failure appends a `merge` entry for that ticket.

### attempt-learnings-design.AC7: Repo hygiene and safety
- **attempt-learnings-design.AC7.1 Success:** No commit on any ref
  contains a `.nightralph/` path.
- **attempt-learnings-design.AC7.2 Success:** `learnings.md` is
  committed and has no uncommitted changes when the run ends.
- **attempt-learnings-design.AC7.3 Failure:** When `learnings.md`
  cannot be read or written, the ticket still finishes `done` and
  `progress.md` is still committed.

---

Conventions: same as Phase 1. Line numbers below are from the
2026-10-06 investigation; Phase 3 shifted `src/orchestrator.ts` by a
few lines, so locate each site by the named function or code shown.

<!-- START_TASK_1 -->
### Task 1: `commitProgress` accepts several paths

**Verifies:** attempt-learnings-design.AC7.2 (partially; the commit
mechanism)

**Files:**
- Modify: `src/progress.ts:235-263` (`commitProgress`)
- Test: `test/progress.test.ts` (unit, temp git repo via the existing
  `initTempRepo` helper at `test/progress.test.ts:40-57`)

**Implementation:**

Change the second parameter to `paths:string|string[]` and normalize
once:

```ts
export async function commitProgress (
    repoRoot:string,
    paths:string|string[],
    message:string
):Promise<boolean> {
    const list = typeof paths === 'string' ? [paths] : paths
    await execFileAsync(
        'git',
        ['add', '--force', '--', ...list],
        { cwd:repoRoot }
    )
    // ...`git diff --cached --quiet -- ...list` and
    // `git commit -m message -- ...list`, as today
}
```

All existing call sites pass a string and keep working.

**Testing:**
- Two files written and passed as an array produce one new commit
  whose `git show --name-only --format= HEAD` lists both paths.
- Calling again with unchanged files returns `false` and adds no
  commit (compare `git rev-parse HEAD` before and after).

**Verification:**
Run: `npm test`
Expected: all suites pass

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output

Run: `npx tsc --noEmit -p . 2>&1 | grep 'error TS' | grep progress.test`
Expected: no output

**Commit:**
```bash
git add src/progress.ts test/progress.test.ts
git commit -m "feat(progress): commitProgress accepts a list of paths"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->
<!-- START_TASK_2 -->
### Task 2: Outcome fields, history in the prompt, notes collection

**Verifies:** None on its own (Task 6 tests it)

**Files:**
- Modify: `src/orchestrator.ts:1610-1635` (`TicketOutcome`)
- Modify: `src/orchestrator.ts:1637-1653` (`TicketAttemptOpts`)
- Modify: `src/orchestrator.ts:1658-1804` (`runTicketAttempt`)
- Modify: `src/orchestrator.ts:16-52` (imports from
  `./learnings.js`: `collectNotes`, `ensureNotesIgnored`,
  `readEntries`, `renderHistory`,
  `selectHistory`, plus what Tasks 3-4 need; `AgentRunRecord` and
  `EntryInput` via `import type`)

**Implementation:**

1. `TicketOutcome`: attach what the agent process did, using
   `AgentRunRecord` from `./learnings.js`
   (`{ exitCode, completedItems, timedOut, notes }`), to every variant
   where an agent ran, and split `failed` by reason so the install
   failure (no agent ran) cannot carry one:
   ```ts
   type TicketOutcome =
       | { kind:'worktree-error'; error:unknown }
       | {
           kind:'error'
           error:unknown
           worktreePath?:string
           branchName?:string
       }
       | {
           kind:'no-commits'
           worktreePath:string
           branchName:string
           agentRun:AgentRunRecord|null
       }
       | {
           kind:'failed'
           reason:'install'
           branchName:string
           exitCode:number
           completedItems:string[]
       }
       | {
           kind:'failed'
           reason:'exit'|'tests'
           branchName:string
           exitCode:number
           completedItems:string[]
           agentRun:AgentRunRecord
       }
       | {
           kind:'ready'
           worktreePath:string
           branchName:string
           completedItems:string[]
           agentRun:AgentRunRecord
       }
   ```
   The existing `exitCode` and `completedItems` fields stay as they
   are: they feed progress.md, and `exitCode` on a `tests` failure is a
   placeholder `1`, not the agent's exit code. Entries always read the
   agent's real exit code from `agentRun.exitCode`. `no-commits` takes
   `AgentRunRecord|null` only because the placeholder outcome in
   `runTicketAttempts`
   (`{ kind:'no-commits', worktreePath:'', branchName:'' }`) has no
   agent run; it gets `agentRun:null`, and every real `no-commits`
   return passes a record. Keep each existing comment on these types.
   Then run
   `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
   and fix every
   construction or narrowing site it reports in `src/` (the existing
   type errors under `test/` are out of scope).
2. `TicketAttemptOpts`: add `learningsPath:string`.
3. In `runTicketAttempt`, before `spawnAgent`, build the history:
   ```ts
   function buildHistory (
       learningsPath:string,
       ticket:Ticket,
       d:Display
   ):string {
       try {
           return renderHistory(selectHistory(
               readEntries(learningsPath),
               {
                   key:ticketKey(ticket.feature, ticket.num),
                   blockerKeys:ticket.blockers.map(b => {
                       return ticketKey(ticket.feature, b)
                   }),
               }
           ))
       } catch (err) {
           d.log(
               `  ${ticket.filename}: could not read ` +
               `learnings: ${formatErrorMessage(err)}`
           )
           return ''
       }
   }
   ```
   and pass `history:buildHistory(opts.learningsPath, ticket, d)` in
   the `renderPrompt` opts. It is rebuilt on every attempt, so a retry
   sees the entry its previous attempt just wrote. Also before
   `spawnAgent` (after any install step), make the notes directory
   ignore itself:
   ```ts
   try {
       ensureNotesIgnored(worktree.worktreePath)
   } catch (err) {
       d.log(
           `  ${ticket.filename}: could not set up the notes ` +
           `directory: ${formatErrorMessage(err)}`
       )
   }
   ```
4. Immediately after `spawnAgent` resolves, before the timed-out /
   exit-code branches, `commitDirty`, and any `removeWorktreeQuietly`:
   ```ts
   let notes:string|null = null
   try {
       notes = collectNotes(worktree.worktreePath)
   } catch (err) {
       d.log(
           `  ${ticket.filename}: could not collect ` +
           `notes: ${formatErrorMessage(err)}`
       )
   }
   ```
   Collecting first keeps the notes out of the timeout path's
   auto-commit (`commitDirty` runs `git add -A`). Then build the
   record once:
   ```ts
   const agentRun:AgentRunRecord = {
       exitCode:agentResult.exitCode,
       completedItems:agentResult.completedItems,
       timedOut:agentResult.timedOut,
       notes,
   }
   ```
   and attach `agentRun` to every later return (`failed` exit,
   `no-commits`, `failed` tests, `ready`).

**Verification:** compiles together with Tasks 3-4 (see Task 4).
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Append an entry after every attempt

**Verifies:** None on its own (Task 6 tests it)

**Files:**
- Modify: `src/orchestrator.ts:1809-1866` (`runTicketAttempts`)

**Implementation:**

Add a helper that maps an outcome to an `EntryInput`, renders it, and
appends it, never throwing:

```ts
function recordAttempt (opts:{
    learningsPath:string
    logsDir:string
    ticket:Ticket
    attempt:number
    effort?:EffortLevel
    outcome:TicketOutcome
    d:Display
}):void
```

Mapping (`key = ticketKey(ticket.feature, ticket.num)`,
`label = ticketLabel(ticket)` from `./display.js`,
`now = new Date()`):

- `ready` -> `outcome:'done'` with `run:outcome.agentRun` and
  `effort`.
- `failed` with `reason:'exit'` -> `'exit'` with
  `run:outcome.agentRun` and `effort`.
- `failed` with `reason:'tests'` -> `'tests'` with
  `run:outcome.agentRun`, `effort`, plus
  `logName = basename(attemptLogPath(logsDir, ticket, attempt,
  '.test.log'))` and `logTail = tailLines(<file contents>,
  LOG_TAIL_LINES)`; a missing or unreadable log gives `logTail:''`.
- `failed` with `reason:'install'` -> `'install'` with the
  `.install.log` name and tail the same way (no `run`: no agent ran).
- `no-commits` with a non-null `agentRun` -> `'no-commits'` with
  `run:outcome.agentRun` and `effort`. A null `agentRun` (only the
  never-returned placeholder) records nothing.
- `error` and `worktree-error` -> `'error'` with
  `formatErrorMessage(outcome.error)`.

Never take the exit code from the outcome's top-level `exitCode`; it is
a progress.md placeholder (`1` for every `tests` failure).

Use a `switch (outcome.kind)` with an exhaustive `default` arm
(`const _exhaustive:never = outcome`), and switch on `reason` inside
`failed` the same way. Wrap render + `appendEntry` in try/catch and
report failures with `d.log`.

Call sites inside `runTicketAttempts`:
- After each `runTicketAttempt` returns, call `recordAttempt` with the
  attempt number and the effort used for that attempt, before the
  `ready` / `worktree-error` early returns.
- In the existing `catch (error)` around `runTicketAttempt`, call
  `recordAttempt` with `{ kind:'error', error }` before returning.

**Verification:** compiles together with Tasks 2 and 4 (see Task 4).
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: `runWavesIsolated` wiring

**Verifies:** None on its own (Task 6 tests it)

**Files:**
- Modify: `src/orchestrator.ts:1877-1892` (`saveProgress`)
- Modify: `src/orchestrator.ts:2362-2392` (`runPool` call and the code
  right after it)
- Modify: `src/orchestrator.ts:2655-2684` (unrecovered merge failure)

**Implementation:**

1. Add `statSync` to the existing `node:fs` import
   (`src/orchestrator.ts:2-9`), then a local helper next to
   `saveProgress`:
   ```ts
   function isRegularFile (path:string):boolean {
       try {
           return statSync(path).isFile()
       } catch {
           return false
       }
   }
   ```
2. `saveProgress` stages the log too, when it is a regular file (a
   directory or other bad path must not make `git add` fail and take
   the `progress.md` commit down with it):
   ```ts
   const learningsPath = learningsPathFor(progressPath)
   const paths = isRegularFile(learningsPath) ?
       [progressPath, learningsPath] :
       progressPath
   await commitProgress(repoRoot, paths, message)
   ```
   The existing try/catch and `d.log` stay. No call sites change.
3. (No per-run setup: the notes directory is made to ignore itself
   per attempt, in Task 2.)
4. In the `runPool(ready, poolSize, t => runTicketAttempts({...}))`
   call, add
   `learningsPath:learningsPathFor(tracker.pathFor(t.feature))`.
5. Right after `runPool` settles and before the outcome loop, commit
   the learnings files the wave touched, sequentially (this section
   already runs one commit at a time, per the comment at line 2362):
   ```ts
   const touched = new Set(ready.map(t => {
       return learningsPathFor(tracker.pathFor(t.feature))
   }))
   for (const path of touched) {
       if (!isRegularFile(path)) continue
       try {
           await commitProgress(
               repoRoot, path,
               'nightralph: record attempt learnings'
           )
       } catch (err) {
           d.log(
               '  Failed to commit learnings: ' +
               formatErrorMessage(err)
           )
       }
   }
   ```
   Attempt entries are appended while the pool runs, but outcome
   processing may not call `saveProgress` for every feature (a wave
   where every ticket is `ready` saves progress only after merging).
   Committing here keeps `learnings.md` committed at every terminal
   point and keeps the base tree free of modified tracked files before
   `mergeWave` touches it.
6. In the unrecovered merge branch (the `else` at line 2655, which adds
   to `failedKeys` and records `done:false`), before its
   `saveProgress`, append a `merge` entry to
   `learningsPathFor(tracker.pathFor(ticket.feature))`:
   `appendEntry(path, renderEntry({ outcome:'merge',
   key:ticketKey(ticket.feature, ticket.num),
   label:ticketLabel(ticket), attempt:0, now:new Date(),
   stderr:branchResult.stderr ?? '' }))`, wrapped in try/catch with
   `d.log`. (No `key` variable is in scope there; the existing code
   calls `ticketKey(...)` inline.) The following `saveProgress` commits
   it.
   This is the only site that records a merge failure as `done:false`.

**Verification:**
Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output (no type errors)

Run: `npm run build`
Expected: builds

Run: `npm test`
Expected: all existing suites pass (new behavior is tested in Task 6)

Run: `npm run lint`
Expected: no errors

**Commit:**
```bash
git add src/orchestrator.ts
git commit -m "feat(orchestrator): record and replay attempt learnings"
```
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Notes-writing mock agent

**Verifies:** None (test infrastructure)

**Files:**
- Create: `test/mock-agent-notes.js` (executable: `chmod +x`, shebang
  `#!/usr/bin/env node`, like `test/mock-agent-pass.js`)

**Implementation:**

Behavior is driven by env vars (agents inherit the test process env;
`spawnAgent` does not override `env`, see `src/orchestrator.ts:1023`,
and `MOCK_INVOCATION_LOG` in `test/integration.test.ts:787` is the
precedent):

Order of events: read stdin to `end` (the prompt), then

1. generate `token = randomUUID()`;
2. write `<MOCK_RECORD_DIR>/<Date.now()>-<randomUUID()>.json`
   containing `{ time:Date.now(), cwd:process.cwd(), token, prompt }`
   (`MOCK_RECORD_DIR` is required; one file per invocation, so
   concurrent agents never share a file);
3. write `.nightralph/notes.md` in `process.cwd()` (mkdir recursive)
   containing `notes-token ${token}`;
4. act on `MOCK_MODE`:
  - `pass`: write a `mock-agent-change-<uuid>.txt`, then
    `git add -A` and commit (copy the `GIT_ENV` identity and
    commit-with-retry approach from `test/mock-agent-pass.js`).
    Using `git add -A` is deliberate: it proves the
    `.nightralph/.gitignore` safety net keeps `.nightralph/` out even
    when an agent stages everything. Exit 0.
  - `fail`: exit 1.
  - `fail-once`: if `<MOCK_RECORD_DIR>/failed-<basename(cwd)>` does not
    exist, create it and exit 1; otherwise behave as `pass`. The
    worktree directory name is stable across attempts of one ticket.
  - `hang`: after writing notes, never exit
    (`setInterval(() => {}, 1000)`).

**Verification:** used by Task 6.

**Commit:** with Task 6.
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Integration tests

**Verifies:** attempt-learnings-design.AC5.1,
attempt-learnings-design.AC5.2, attempt-learnings-design.AC5.3,
attempt-learnings-design.AC5.4, attempt-learnings-design.AC6.1,
attempt-learnings-design.AC6.2, attempt-learnings-design.AC6.3,
attempt-learnings-design.AC7.1, attempt-learnings-design.AC7.2,
attempt-learnings-design.AC7.3

**Files:**
- Modify: `test/integration.test.ts` (integration). Add
  `const MOCK_NOTES = join(process.cwd(), 'test',
  'mock-agent-notes.js')` near the other `MOCK_*` constants
  (`test/integration.test.ts:577-610`).

**Implementation:**

Follow the existing `runWavesIsolated` tests
(`test/integration.test.ts:658-754`): `initTempGitRepo()`, tickets in
`<projectDir>/issues` via `makeTicketBody({ status, blockers })`,
`scanTickets(issuesDir)`, `commitAll`, `process.chdir(projectDir)`,
`logsDir = join(projectDir, '.logs')`, `featureName`, `model:null`,
`conflictStrategy:'respawn'`, `testCmd:'true'`, `retryDelay:0`, and
restore cwd, env vars, and temp dirs in `finally`. With
`logsDir = <projectDir>/.logs` and no `progressPaths`, the log is at
`join(projectDir, 'learnings.md')` (`learningsPathFor` of the fallback
`progress.md`). Set `MOCK_RECORD_DIR` to a fresh `mkdtempSync` dir and
`MOCK_MODE` per test; read records with a helper that parses every
`*.json` in that dir and sorts by `time`. Read the log with
`readEntries` from `src/learnings.ts`.

**Testing:**
- **AC5.1, AC5.2, AC7.1, AC7.2** (one test): one ticket, `fail-once`,
  `retries:1`. Two records; the second record's prompt includes the
  first record's token. `readEntries` gives two entries for the ticket
  with outcomes `['exit', 'done']`. `git log --all --name-only
  --format=` output has no line starting with `.nightralph/`.
  `git ls-files learnings.md` is non-empty and
  `git status --porcelain -- learnings.md` is empty.
- **AC5.3**: ticket 1 (`ready-for-agent`) and ticket 2 blocked by 1,
  `pass`, `retries:0`. Ticket 2 runs in wave 2; its record's prompt
  includes ticket 1's token. (Identify records by `cwd`, which contains
  the ticket's `<num>-<slug>` worktree name.)
- **AC5.4**: before the initial `commitAll`, write a `.gitignore`
  containing `.logs/` so it is committed with the tickets. Otherwise the
  first run's untracked logs make `isDirty` (`git status --porcelain`,
  `src/worktree.ts:183-190`) true and the second `runWavesIsolated`
  throws "Working tree is dirty". Run once with `fail`, `retries:0`;
  then rescan tickets (`scanTickets(issuesDir)`) and run again with
  `pass`. The first record of the second run (by `time`) includes the
  token from the first run.
- **AC6.1**: `hang`, `timeout:2`, `retries:0`. The ticket's entry has
  `timedOut:true` and its body includes the record's token.
- **AC6.2**: `pass` with
  `testCmd:` an `echo` of a fresh `randomUUID()` followed by
  `; exit 1`, `retries:0`. The entry's outcome is `tests` and its body
  includes the test token.
- **AC6.3**: reuse the merge-failure setup of
  `test/integration.test.ts:2082-2152` (`installMergeFailingGit` for
  the ticket's branch, restore PATH in `finally`) with `MOCK_NOTES` in
  `pass` mode and `conflictStrategy:'stop'` (the `-X` behavior; it
  reaches the same unrecovered-merge branch without respawning the
  agent). `readEntries` contains an entry for the ticket with outcome
  `merge`.
- **AC7.3**: before the run, `mkdirSync(join(projectDir,
  'learnings.md'))` (an empty directory is invisible to `git status`,
  so the dirty-tree check still passes). `pass`, `retries:0`. The
  ticket's status is `done`; `git status --porcelain -- progress.md`
  is empty (the final progress state was committed, not just some
  earlier commit); and `readProgress(join(projectDir, 'progress.md'))`
  (from `src/progress.ts`) shows the ticket with `done:true`.

**Verification:**
Run: `npm test`
Expected: all suites pass

Run: `npx tsc --noEmit -p . 2>&1 | grep 'error TS' | grep integration.test`
Expected: no output

Run: `npm run lint`
Expected: no errors

**Commit:**
```bash
git add test/mock-agent-notes.js test/integration.test.ts
git commit -m "test: attempt learnings end to end"
```
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
