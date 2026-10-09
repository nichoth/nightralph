# Cross-Feature Blockers Implementation Plan -- Phase 4

**Goal:** The finish summary explains tickets blocked from outside
the run, blocker refs that match no ticket, and typo warnings; a
ticket's prompt history includes a cross-feature blocker's latest
`done` entry.

**Architecture:** `renderFinishSummary` gains an optional
`warnings` argument and a shared private helper,
`explainOpen(tickets, failedKeys, warnings)`, that returns the
explanatory paragraphs (the existing ready-for-human paragraph plus
a new outside/missing/typo paragraph). Phase 5's
`renderNothingReady` reuses that helper. Both runners accept the
warnings and pass them to the summary. `buildHistory` reads
`learnings.md` of every other feature a ticket's refs point into.

**Tech Stack:** TypeScript (ESM), `@substrate-system/tapzero`

**Scope:** Phase 4 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cross-feature-blockers.AC2: Readiness and reporting
- **cross-feature-blockers.AC2.2 Failure:** a ticket whose blocker
  is in an unselected feature and not done is not ready; its row
  label names `<feature>/<NN>` and the blocker's status
  (this phase: the finish summary names it the same way)
- **cross-feature-blockers.AC2.4 Failure:** a ref that matches no
  ticket (same or other feature) leaves the ticket not ready; the
  row label says not found, the picker label counts a bad blocker,
  and the finish summary lists it
- **cross-feature-blockers.AC2.6 Edge:** a ready-for-human `a/02`
  does not mark `b/03` as blocked by a human just because `b/03`
  lists `02`
  (the key fix landed in Phase 2; this phase keeps it while
  restructuring the summary and re-runs that test)
- **cross-feature-blockers.AC2.7 Success:** a ticket's prompt
  history includes a cross-feature blocker's latest `done` entry
  from that feature's `learnings.md`
- **cross-feature-blockers.AC2.9 Success:** typo warnings appear in
  the finish summary

---

## Divergences from the design (and why)

- `blockerLabel`, `listTickets` and the human-key fix moved to
  Phase 2 (they had to compile there). This phase covers the
  summary paragraph, warnings plumbing and the cross-feature
  history read.
- A new export, `historyFor(learningsPath, ticket)`, holds the
  history logic so AC2.7 can be tested without a full isolated
  run. `buildHistory` stays private and wraps it in the existing
  try/catch.

---

## Codebase facts the executor needs

`src/orchestrator.ts` (line numbers before Phase 2; they shift by a
few lines after it -- locate by name):
- `renderFinishSummary(tickets, totalCompleted, failedKeys)`
  ~lines 2105-2185. Structure: `remaining` (ready-for-agent),
  `human` (`HUMAN_STATUS`), `blockedByHuman` (keyed by `ticketKey`
  since Phase 2); a counts line; per-feature lines when more than
  one feature; then `if (human.length === 0) return
  lines.join('\n')`, otherwise the human paragraph (uses the
  private `indentFilenames(tickets)`), the blocked-by-human list,
  and the "Do that work by hand" line.
- Call sites: `runWaves` ~line 2417 and `runWavesIsolated` ~line
  3047: `d.log('\n' + renderFinishSummary(tickets, totalCompleted,
  failedKeys))`.
- `runWaves` positional parameters (line 2234-2246): `tickets,
  specBody, agentCmd, model, timeout, logsDir, testCmd, display?,
  maxTurns?, effort?, retries?, retryDelay?, concurrency?`.
- `runWavesIsolated(opts)` (line 2425): opts type lists `tickets,
  specBody, specBodies?, agentCmd, model, timeout, logsDir,
  featureName, conflictStrategy, display?, testCmd, installCmd?,
  maxTurns?, effort?, retries?, retryDelay?, concurrency?,
  progressPaths?, review?`.
- `buildHistory(learningsPath, ticket, d)` lines 1669-1692: try {
  `renderHistory(selectHistory(readEntries(learningsPath), { key,
  blockerKeys }))` } catch -> logs `could not read learnings` and
  returns `''`. Only caller ~line 1762 in the ticket attempt;
  `learningsPath` is `learningsPathFor(tracker.pathFor(t.feature))`
  (line 2591).
- `src/learnings.ts`: `readEntries(path)` returns `[]` for a missing
  file and throws on other errors; `selectHistory(entries,
  { key, blockerKeys })` keeps the last 4 own entries and the latest
  `done` entry per blocker key; entry keys are `ticketKey`
  strings, so entries from several files can be concatenated.
  `renderEntry(input)` and `appendEntry(path, text)` write entries
  (use them in the test).
- `ticket.filepath` is `<scratch>/<feature>/issues/<file>.md`, so
  the feature dir is `dirname(dirname(ticket.filepath))` and
  another feature's log is
  `join(dirname(featureDir), ref.feature, 'learnings.md')`.

`src/index.ts`: `runWavesIsolated({...})` call ~lines 568-594 and
`runWaves(...)` call ~lines 595-608 in `runExecute`; `loaded` holds
`warnings` since Phase 3.

Tests:
- `renderFinishSummary` tests at `test/orchestrator.test.ts`
  ~lines 4294-4460 (substring assertions with `out.includes`).
- `test/learnings.test.ts` has entry fixtures; `renderEntry` input
  shape is in `src/learnings.ts` (`EntryInput`: `key`, `label`,
  `attempt`, `now`, plus per-outcome fields; `done` carries `run`).
- `test/integration.test.ts`, the test renamed in Phase 3 (~line
  437).

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: `explainOpen` and the new summary paragraph

**Verifies:** cross-feature-blockers.AC2.2, AC2.4, AC2.6, AC2.9
(tests in Task 3)

**Files:**
- Modify: `src/orchestrator.ts` (`renderFinishSummary`)

**Implementation:**
1. Import `type BlockerWarning` from `./blockers.js` (extend the
   Phase 2 import).
2. Signature:
   `renderFinishSummary(tickets, totalCompleted, failedKeys,
   warnings:ReadonlyArray<BlockerWarning> = [])`.
3. Move everything after the counts and per-feature lines into a
   private `function explainOpen(tickets, failedKeys,
   warnings):string[]` that returns the lines to append (each
   paragraph preceded by `''`). `renderFinishSummary` becomes
   counts + per-feature + `...explainOpen(...)`, joined with
   `'\n'`. With no humans, no outside/missing refs and no typos it
   returns `[]`, so a plain run is still one line.
4. Keep the human paragraph text as it is.
5. Add a second paragraph, built from `open` = ready-for-agent
   tickets not in `failedKeys`:
   - `outside`: tickets in `open` with any `pending` ref. Header
     `` `${n} ready-for-agent ticket${n === 1 ? ' waits' : 's
     wait'} on tickets outside this run. Select those features
     too, or finish them first:` `` then one line per ticket:
     `` `  ${ticketLabel(toRef(t))} waits on ${refs.map(
     blockerLabel).join(', ')}` ``.
   - `missing`: every `missing` ref of a ticket in `open`. Header
     `` `${n} blocker reference${n === 1 ? '' : 's'} match no
     ticket. Fix the **Blocked by:** line:` `` then
     `` `  ${ticketLabel(toRef(t))}: ${blockerLabel(ref)}` ``.
   - `typos`: `warnings` with `kind === 'typo'`. Header
     `` `${n} word${n === 1 ? '' : 's'} in a **Blocked by:** line
     look${n === 1 ? 's' : ''} like a feature name but match no
     .scratch/<name>/issues directory:` `` then
     `` `  ${w.ticket}: ${w.text}` ``.
   Emit each sub-list only when non-empty; emit the whole
   paragraph (leading `''`) only when at least one is non-empty.
   `toRef` is defined further down the file (~line 2201); a
   function declaration is hoisted, so calling it is fine.
6. Update the doc comment of `renderFinishSummary` to mention the
   new paragraph and the `warnings` argument.

Wrap every line at 80 columns.

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Pass warnings through the runners and the CLI

**Verifies:** cross-feature-blockers.AC2.4, AC2.9 (CLI half; the
CLI tests are in Task 3)

**Files:**
- Modify: `src/orchestrator.ts` (`runWaves` signature and its
  `renderFinishSummary` call; `runWavesIsolated` opts type and its
  call)
- Modify: `src/index.ts` (`runExecute` calls)

**Implementation:**
1. `runWaves`: add a trailing optional positional parameter
   `warnings:ReadonlyArray<BlockerWarning> = []` after
   `concurrency`, and pass it as the 4th argument to
   `renderFinishSummary`.
2. `runWavesIsolated`: add `warnings?:ReadonlyArray<BlockerWarning>`
   to the opts type and pass `opts.warnings ?? []`.
3. `src/index.ts`: pass `warnings:loaded.warnings` in the
   `runWavesIsolated` opts and `loaded.warnings` as the new last
   argument of `runWaves`.

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Summary tests

**Verifies:** cross-feature-blockers.AC2.2, AC2.4, AC2.6, AC2.9

**Files:**
- Modify: `test/orchestrator.test.ts` (unit, near the existing
  `renderFinishSummary` tests)
- Modify: `test/integration.test.ts` (the Phase 3 unknown-blocker
  test)

**Testing** (substring checks with `out.includes`, like the
existing summary tests; build expected strings with `blockerLabel`
and `ticketLabel` rather than hard-coding):
- AC2.2: `a/02` ready-for-agent with a `pending` ref to `b/01`
  (status `ready-for-agent`): the output includes
  `blockerLabel(ref)` and `'a/02'`.
- AC2.4: `a/03` with a `missing` ref `a/09`: the output includes
  `blockerLabel(ref)` (which carries `(not found)`) and `'a/03'`.
- A failed ticket with a pending ref is not listed in the new
  paragraph (pass its key in `failedKeys`).
- AC2.9: `warnings` `[{ ticket:'a/04', kind:'typo',
  text:'nwsletter-audit' }]`: the output includes
  `'nwsletter-audit'` and `'a/04'`.
- No humans, no dead refs, no typos: still one line
  (`out.split('\n').length === 1`), as the existing test at ~line
  4294 asserts.
- AC2.6: re-run the Phase 2 test unchanged (it lives in the same
  file).
- AC2.9 end to end, new test in `test/integration.test.ts` next to
  the `'CLI subprocess - execute smoke test'` (~line 535), same
  setup style (`tmp()`, `scratchDirs(projectDir)`, no git, so the
  run is in place): `01-done.md` with
  `makeTicketBody({ status:'done' })` and `02-typo.md` written by
  hand as `'# Test ticket\n\n**Status:** ready-for-agent\n' +
  '**Blocked by:** nwsletter-audit 01\n'`. The typo ref falls back
  to own ticket 01, which is done, so 02 runs. Run
  `spawnCli([MOCK_AGENT, '--spec', FEAT, '--timeout', '10'],
  { cwd:projectDir })`; assert exit 0 and `stdout + stderr`
  includes `'nwsletter-audit'` (from the finish summary).
- Integration test (~line 437): add back the output assertions,
  now satisfied by the finish summary: `stdout + stderr` includes
  `'99'` and `'not found'`. Keep the Phase 3 assertions (ticket
  still `ready-for-agent`, no `01-task.log`).

**Verification:**
Run: `npm run build && npm test`
Expected: all suites pass.
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Cross-feature history

**Verifies:** cross-feature-blockers.AC2.7

**Files:**
- Modify: `src/orchestrator.ts` (`buildHistory`, new
  `historyFor`)
- Modify: `test/orchestrator.test.ts`

**Implementation:**

```ts
/**
 * The ticket's own earlier attempts and its direct blockers' last
 * successful runs, rendered for the prompt. A blocker in another
 * feature is read from that feature's learnings.md, beside this
 * feature's dir. Throws when a log cannot be read.
 */
export function historyFor (
    learningsPath:string,
    ticket:Ticket
):string {
    const featureDir = dirname(dirname(ticket.filepath))
    const others = new Set(
        ticket.blockers
            .map(r => r.feature)
            .filter(f => f !== ticket.feature)
    )
    const entries = [
        ...readEntries(learningsPath),
        ...[...others].flatMap(f => readEntries(
            join(dirname(featureDir), f, 'learnings.md')
        )),
    ]
    return renderHistory(selectHistory(entries, {
        key:ticketKey(ticket.feature, ticket.num),
        blockerKeys:ticket.blockers.map(r => {
            return ticketKey(r.feature, r.num)
        }),
    }))
}
```

`buildHistory` keeps its signature and catch block; its `try` body
becomes `return historyFor(learningsPath, ticket)`. `dirname` and
`join` come from `node:path` (already imported in
`orchestrator.ts`; add `dirname` to that import if it is missing).

**Testing** (temp dir via the existing `tmp()` helper):
- Create `<tmp>/.scratch/a/issues/02-x.md` and
  `<tmp>/.scratch/b/`. Append a `done` entry for key
  `ticketKey('b', 1)` to `<tmp>/.scratch/b/learnings.md` with
  `appendEntry(path, renderEntry({...}))`, giving the run notes a
  unique marker string (e.g. `'marker-b-01-notes'`). Build a ticket
  with `makeTicket({ num:2, filename:'02-x.md', feature:'a',
  filepath:<the a/02 path>, blockers:[{ feature:'b', num:1,
  where:'done', status:'done' }] })`.
  `historyFor(<tmp>/.scratch/a/learnings.md, ticket)` (file absent)
  includes `'marker-b-01-notes'`.
- A same-feature blocker entry in `a/learnings.md` still appears
  (regression).
- A ref into a feature with no `learnings.md` yields no error
  (`readEntries` returns `[]`).

**Verification:**
Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`; type-check as in Phase 2.
Expected: no new errors.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Commit

**Commit:** `feat: explain outside and missing blockers, read
cross-feature history`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->
