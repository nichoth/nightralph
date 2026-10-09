# Cross-Feature Blockers Implementation Plan -- Phase 5

**Goal:** A run in which every ready-for-agent ticket is waiting on
a blocker explains why and exits 0 without creating or checking
out a branch; on resume it checks the launch branch back out
first.

**Architecture:** Two pure exports in `src/orchestrator.ts`:
`nothingReady(tickets)` (the stop rule) and
`renderNothingReady(tickets, warnings)` (the explanation, built
from Phase 4's `explainOpen` plus a cycle line). `runExecute` in
`src/index.ts` checks the rule right after the first scan, before
provider preflight and before the dry-run branch, and again after
the resume re-scan, where `stopNothingReady` shares the launch
branch checkout with `failStaleResume`.

**Tech Stack:** TypeScript (ESM), yargs CLI,
`@substrate-system/tapzero` CLI subprocess tests

**Scope:** Phase 5 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cross-feature-blockers.AC3: Zero-ready stop
- **cross-feature-blockers.AC3.1 Success:** when the first scan
  finds nothing ready, the run prints why and exits 0, and the
  branch is unchanged, with no `nightralph--*` branch created
- **cross-feature-blockers.AC3.2 Edge:** the stop happens before
  provider preflight, so an unknown provider with nothing ready
  still exits 0
- **cross-feature-blockers.AC3.3 Success:** `--dry-run` with
  nothing ready exits 0 and prints the explanation
- **cross-feature-blockers.AC3.4 Success:** when the resume
  re-scan finds a blocked ready-for-agent ticket and nothing ready,
  the run checks out the launch branch and exits 0
- **cross-feature-blockers.AC3.5 Edge:** when the resume re-scan
  finds no ready-for-agent tickets left, the run continues into the
  review pass and stays on the integration branch
- **cross-feature-blockers.AC3.6 Success:** with at least one
  ticket ready, the run proceeds as today

---

## Decisions and divergences

- **Stop rule (decided with the user):** both the first scan and
  the resume re-scan stop only when nothing is ready AND at least
  one ticket is `ready-for-agent` (so something is blocked). A run
  whose tickets are all done, or whose only open tickets are
  ready-for-human, proceeds as today (finish summary, review pass).
  This is the design's resume rule applied to the first scan too,
  so a finished but unreviewed branch always gets its review pass.
  AC3.1 is read as "nothing ready while a ready-for-agent ticket
  waits".
- **Resume and the first scan:** when the run will resume an
  existing integration branch, the first-scan stop is skipped and
  the resume re-scan decides, because the launch branch's statuses
  can be stale relative to that branch (review finding). AC3.2
  (stop before provider preflight) holds for runs that do not
  resume.
- **Cycles:** today a dependency cycle is reported only by
  `dryRun`'s `Deadlocked tickets:` line. The stop now runs before
  `dryRun`, so `renderNothingReady` reports cycles itself, and the
  existing dry-run deadlock CLI test is updated to the new output.

---

## Codebase facts the executor needs

`src/index.ts` (614 lines before this plan; locate by name, numbers
shift after Phases 2-4):
- `failStaleResume(plan:IntegrationPlan, problems:string[]):never`
  ~lines 377-401: runs `execFileSync('git', ['checkout',
  '--quiet', plan.launchBranch], { cwd:getRepoRoot(),
  stdio:'ignore' })` inside try/catch (errors ignored), prints
  `Cannot resume ${plan.branch}: ...` to stderr, `process.exit(2)`.
- `runExecute` order: `selections = await
  resolveIssuesDir(argv.spec)` (~429); `loaded =
  loadTicketsOrExit(selections)` and
  `if (loaded.allTickets.length === 0) return` (~433-434);
  provider preflight with `resolveExecutable(argv.provider)`
  (~436-447); `isolated = isGitRepo()`; if isolated and not dry
  run, `plan = prepareIntegrationBranch(...)`, logs, and on
  `plan.resumed` the silent re-scan `loaded = loadTickets(
  selections, () => {})` followed by
  `if (loaded.missing.length > 0) failStaleResume(plan,
  loaded.missing)` and `if (loaded.allTickets.length === 0)
  failStaleResume(plan, ['no tickets'])` (~472-491); then the
  dry-run branch (~523-554) and the runners.
- Imports from `./orchestrator.js` at lines 10-25.

`src/orchestrator.ts`:
- `findReadyTickets`, `findBlockedTickets` (refs since Phase 2),
  `detectDeadlocks(tickets)` (private, returns the
  ready-for-agent tickets that can never become ready),
  `explainOpen(tickets, failedKeys, warnings)` (private, Phase 4),
  `ticketLabel` (imported from `./display.js`), `toRef`.

`test/integration.test.ts`:
- `spawnCli(args, { cwd?, env?, closeStdin? })` line 213 ->
  `{ code, stdout, stderr }`.
- `makeTicketBody({ status, blockers? })` line 250 (numbers only);
  write cross-feature bodies by hand:
  `'# Test ticket\n\n**Status:** ready-for-agent\n' +
  '**Blocked by:** other-feat 01\n'`.
- `FEAT = 'test-feat'` line 265; `commitAll(dir, msg)` line 640;
  `initTempGitRepo(opts?)` line 651 (hermetic: template dir,
  `core.excludesFile /dev/null`; never write the shared
  `info/exclude`); `gitOut(dir, args)` line 4450;
  `cliGitRepo()` line 4904 returns
  `{ projectDir, issuesDir, templateDir }` for `test-feat` on
  `main` (read its body before using it).
- Model test: `'CLI subprocess - AC1.4 a provider not on PATH
  fails before git state changes'` ~line 4919 -- uses
  `cliGitRepo()`, one ticket, `commitAll`, then asserts
  `gitOut(projectDir, ['branch', '--list', 'nightralph--*'])` is
  empty and HEAD is `main`. Copy its structure and cleanup.
- `'CLI subprocess - dry-run deadlock detection'` ~line 489: two
  tickets blocking each other, `--dry-run`; asserts exit 0,
  `Deadlocked tickets`, `01-alpha.md`, `02-beta.md`.
- The unknown-blocker test (~line 437, rewritten in Phases 3-4).
- `MOCK_AGENT` is the mock provider constant used by the CLI tests.
  For AC3.6 use the same mock agent that existing `cliGitRepo()`
  tests use to complete a ticket on an integration branch (grep for
  tests that assert `**Status:** done` after an isolated CLI run).

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `nothingReady` and `renderNothingReady`

**Verifies:** cross-feature-blockers.AC3.1, AC3.3 (the rule and the
text; CLI wiring in Task 3)

**Files:**
- Modify: `src/orchestrator.ts` (new exports next to
  `renderFinishSummary`)

**Implementation:**

```ts
/**
 * The zero-ready stop rule: nothing can start, yet a
 * ready-for-agent ticket is waiting on a blocker. A run with no
 * ready-for-agent ticket left (all done, or only human work) is
 * not a stop: it still gets its finish summary and review.
 */
export function nothingReady (
    tickets:ReadonlyArray<Ticket>
):boolean {
    return findReadyTickets(tickets).length === 0 &&
        tickets.some(t => t.status === 'ready-for-agent')
}

/**
 * Why nothing can run: the same paragraphs as the finish summary
 * (human work, tickets outside the run, refs that match nothing,
 * typos), plus tickets waiting on an in-run ticket in another
 * status (e.g. needs-triage) and tickets that wait on each other
 * in a cycle.
 */
export function renderNothingReady (
    tickets:ReadonlyArray<Ticket>,
    warnings:ReadonlyArray<BlockerWarning>
):string {
    const lines = [
        'Nothing to run: every ready-for-agent ticket is ' +
        'waiting on a blocker.',
        ...explainOpen(tickets, new Set(), warnings),
    ]
    const dead = findBlockedTickets(tickets, new Set())
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    // Human blockers are explained by explainOpen; any other
    // in-run dead blocker is a status an agent will not pick up.
    const other:string[] = []
    for (const [key, refs] of dead) {
        const stuck = refs.flatMap(r => {
            const b = byKey.get(ticketKey(r.feature, r.num))
            return b && b.status !== HUMAN_STATUS ?
                [`${ticketLabel(toRef(b))} (${b.status})`] :
                []
        })
        const t = byKey.get(key)
        if (t && stuck.length > 0) {
            other.push(
                `  ${ticketLabel(toRef(t))} waits on ` +
                stuck.join(', ')
            )
        }
    }
    if (other.length > 0) {
        lines.push(
            '',
            'These tickets wait on tickets that are not ' +
            'ready-for-agent:',
            ...other,
            'Set those tickets to ready-for-agent or done, or ' +
            'fix the **Blocked by:** lines.'
        )
    }
    const cycle = detectDeadlocks([...tickets]).filter(t => (
        !dead.has(ticketKey(t.feature, t.num))
    ))
    if (cycle.length > 0) {
        lines.push(
            '',
            'Deadlocked tickets (waiting on each other): ' +
            cycle.map(t => ticketLabel(toRef(t))).join(', ') +
            '. Fix their **Blocked by:** lines.'
        )
    }
    return lines.join('\n')
}
```
Adjust the `detectDeadlocks` argument to whatever parameter type it
declares (it takes the ticket array). Wrap lines at 80 columns.

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Unit tests for the rule and the text

**Verifies:** cross-feature-blockers.AC3.1, AC3.3

**Files:**
- Modify: `test/orchestrator.test.ts`

**Testing** (`makeTicket` with inline refs; substring checks built
from `blockerLabel` / `ticketLabel`):
- `nothingReady`: `[]` -> false; all done -> false; only
  ready-for-human -> false; one ready-for-agent ticket with a
  `pending` ref -> true; that plus one unblocked ready-for-agent
  ticket -> false.
- `renderNothingReady`: a ticket with a `pending` ref -> output
  includes `blockerLabel(ref)`; two tickets with `run` refs to each
  other -> output includes `'Deadlocked tickets'` and both
  `ticketLabel`s; a ticket waiting on a ready-for-human ticket ->
  output includes the human ticket's filename and the cycle line is
  absent (it is reported as human work, not a cycle); a ticket with
  a `run` ref to a `needs-triage` ticket -> output includes that
  ticket's `ticketLabel` and `'needs-triage'` (it is not silent).

**Verification:** run the orchestrator suite or `npm test`; pass.
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Wire the stop into `runExecute`

**Verifies:** cross-feature-blockers.AC3.1 through AC3.6 (tests in
Task 4)

**Files:**
- Modify: `src/index.ts` (`failStaleResume`, new
  `checkoutLaunchBranch` and `stopNothingReady`, `runExecute`)

**Implementation:**
1. Import `nothingReady, renderNothingReady` from
   `./orchestrator.js`.
2. Extract the checkout from `failStaleResume` into:
   ```ts
   // Puts the launch branch back after a resume that stops early.
   // A failed checkout is reported by the caller's message.
   function checkoutLaunchBranch (plan:IntegrationPlan):void {
       try {
           execFileSync(
               'git', ['checkout', '--quiet', plan.launchBranch],
               { cwd:getRepoRoot(), stdio:'ignore' }
           )
       } catch {
           // the caller reports the stop either way
       }
   }
   ```
   `failStaleResume` calls it and keeps its message and exit 2.
3. Add:
   ```ts
   // A resumed integration branch where every ready-for-agent
   // ticket is blocked: nothing to do here, so go back and say why.
   function stopNothingReady (
       plan:IntegrationPlan,
       loaded:LoadedTickets
   ):never {
       checkoutLaunchBranch(plan)
       console.log(
           `Nothing to run on ${plan.branch}. ` +
           `Back on ${plan.launchBranch}.\n` +
           renderNothingReady(loaded.allTickets, loaded.warnings)
       )
       process.exit(0)
   }
   ```
4. Add a helper (import `getCurrentBranch`, `getDefaultBranch`,
   `planIntegrationBranch`, `localBranchExists` from
   `./worktree.js`; signatures: `getCurrentBranch(cwd?):string`,
   `getDefaultBranch(repoRoot):string|null`,
   `planIntegrationBranch(current, defaultBranch,
   features):string|null`, `localBranchExists(repoRoot,
   name):boolean`):
   ```ts
   // True when this run will resume an existing integration
   // branch. Its ticket statuses can differ from the launch
   // branch's, so the zero-ready check waits for the re-scan.
   function willResume (features:ReadonlyArray<string>):boolean {
       const root = getRepoRoot()
       const name = planIntegrationBranch(
           getCurrentBranch(root), getDefaultBranch(root), features
       )
       return name !== null && localBranchExists(root, name)
   }
   ```
5. First scan: directly after
   `if (loaded.allTickets.length === 0) return` and before the
   provider preflight:
   ```ts
   const resuming = !argv.dryRun && isGitRepo() &&
       willResume([...loaded.specBodies.keys()])
   if (!resuming && nothingReady(loaded.allTickets)) {
       console.log(renderNothingReady(
           loaded.allTickets, loaded.warnings
       ))
       return
   }
   ```
   This precedes `--dry-run` handling, provider lookup and
   `prepareIntegrationBranch`, so nothing is checked out or
   created. When an existing integration branch will be resumed,
   the check is left to step 6, which reads that branch's tickets
   (otherwise a ticket finished on the integration branch but not
   on the launch branch could stop a run that has work to do).
   AC3.2 therefore holds for runs that do not resume.
6. Resume: after the two `failStaleResume` checks inside
   `if (plan.resumed)`, add
   `if (nothingReady(loaded.allTickets)) stopNothingReady(plan,
   loaded)`. When no ready-for-agent ticket remains, `nothingReady`
   is false and the run falls through to `runWavesIsolated` as
   today (AC3.5).

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors; `npm run build` succeeds.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: CLI subprocess tests

**Verifies:** cross-feature-blockers.AC3.1, AC3.2, AC3.3, AC3.4,
AC3.5, AC3.6

**Files:**
- Modify: `test/integration.test.ts`

**Implementation:** add a helper next to `cliGitRepo()`:
`twoFeatureRepo(ticket01Body:string, otherStatus:string)` that
calls `cliGitRepo()`, writes `issuesDir/01-first.md` with
`ticket01Body`, creates `.scratch/other-feat/issues/` with
`spec.md` (`# Other spec`) and `01-other.md` with
`makeTicketBody({ status:otherStatus })`, runs
`commitAll(projectDir, 'add tickets')`, and returns
`{ projectDir, issuesDir }`. `BLOCKED_BODY` is the hand-written body
with `**Blocked by:** other-feat 01`. Use `try/finally` cleanup like
the line-4919 test.

**Testing:**
- AC3.1: `twoFeatureRepo(BLOCKED_BODY, 'ready-for-agent')`; run
  `spawnCli([MOCK_AGENT, '--spec', FEAT], { cwd:projectDir })`.
  Exit 0; `stdout` includes `'other-feat/01'`;
  `gitOut(projectDir, ['branch', '--list', 'nightralph--*'])`
  is empty; HEAD (`rev-parse --abbrev-ref HEAD`) is `main`;
  `01-first.md` is unchanged (still `ready-for-agent`).
- AC3.2: same setup, provider `'nightralph-no-such-provider'`:
  exit 0, no `nightralph--*` branch.
- AC3.3: same setup with `--dry-run`: exit 0, `stdout` includes
  `'other-feat/01'`.
- AC3.4: `twoFeatureRepo(makeTicketBody({
  status:'ready-for-agent' }), 'ready-for-agent')` (ticket 01 is
  ready on `main`). Then `git checkout -b nightralph--test-feat`,
  rewrite `01-first.md` to `BLOCKED_BODY`, `commitAll`,
  `git checkout main`. Run with `MOCK_AGENT`. Exit 0; HEAD is
  `main`; `nightralph--test-feat` still exists; `stdout` includes
  `'other-feat/01'` (printed only by the stop's explanation).
- Resume skips the first-scan stop: `twoFeatureRepo(BLOCKED_BODY,
  'ready-for-agent')`, then `git branch nightralph--test-feat`
  (same commit as `main`). Run with `MOCK_AGENT`. Exit 0; HEAD is
  `main`; `stdout` includes `'Resumed'` (the existing resume log,
  so the run went through `prepareIntegrationBranch` and the stop
  came from the re-scan) and `'other-feat/01'`.
- AC3.5: same as AC3.4 but on the integration branch set
  `01-first.md` to `makeTicketBody({ status:'done' })`. Run with
  `MOCK_AGENT`. Exit 0 and HEAD is `nightralph--test-feat` (the run
  went on into `runWavesIsolated`; its review pass is skipped
  because only `.scratch` changed).
- AC3.6: `twoFeatureRepo(BLOCKED_BODY, 'done')` with the mock agent
  that completes tickets in isolated runs, and the flags
  `'--retry-delay', '0', '--test-cmd', 'true', '--no-review'` (as
  the tests at ~`test/integration.test.ts:5078-5080` do) so the run
  fits in `spawnCli`'s 30s timeout. Exit 0;
  `nightralph--test-feat` exists; `git show
  nightralph--test-feat:.scratch/test-feat/issues/01-first.md`
  includes `**Status:** done`.

**Update existing tests:**
- `'CLI subprocess - dry-run deadlock detection'` (~line 489): it
  now hits the zero-ready stop. Keep the setup; assert exit 0,
  `stdout` includes `'Deadlocked tickets'`, `'test-feat/01'` and
  `'test-feat/02'` (labels replace filenames).
- The unknown-blocker test (~line 437): add `t.equal(code, 0,
  ...)`; its output now comes from `renderNothingReady`, which
  still includes `'99'` and `'not found'`.
- Run the full suite; any other CLI test whose tickets were all
  blocked now stops early. Update its assertions to the new
  behavior and note it in the commit body.

**Verification:**
Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`; type-check as in Phase 2.
Expected: no new errors.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Commit

**Commit:** `feat: stop before branching when nothing is ready`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->
