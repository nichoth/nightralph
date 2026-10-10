# Prefer Subagent Implementation Plan

**Goal:** Subagent stats appear in `learnings.md` entries, as a
suffix on live display rows, and as one total line after the finish
summary.

**Architecture:** `AgentRunRecord` copies `subagents`/`costUsd` from
`AgentResult`, and `renderEntry` prints them for agent outcomes.
`Display` gains `setTicketStats`; `StatusDisplay` appends a suffix
built by a pure `formatStats` in `src/stats.ts`. Each runner keeps a
`RunStats` tally fed by an `onAgentRun(result)` callback passed to
every spawn site (ticket attempts, merge respawns, and a wrapped
`deps.spawnAgent` for the reviewer and fixer), then logs
`renderRunStats(tally)` after `renderFinishSummary`. All of it is
advisory: nothing here changes an outcome, an exit code or the
finish summary text.

**Tech Stack:** TypeScript, tapzero

**Scope:** Phase 5 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

This phase implements and tests:

### prefer-subagent.AC4: learnings.md
- **prefer-subagent.AC4.1 Success:** `done`, `exit`, `no-commits`
  and `tests` entries show the subagent count and cost
- **prefer-subagent.AC4.2 Edge:** each line is omitted when its value
  is absent
- **prefer-subagent.AC4.3 Edge:** `install`, `error` and `merge`
  entries carry neither line
- **prefer-subagent.AC4.4 Success:** new entries round-trip through
  `parseEntries`, and entries written before this change still parse

### prefer-subagent.AC5: Display
- **prefer-subagent.AC5.1 Success:** `setTicketStats` adds a suffix
  to that ticket's row
- **prefer-subagent.AC5.2 Success:** the row shows the running total
  across attempts; a retry adds to the prior attempts
- **prefer-subagent.AC5.3 Edge:** rows with stats never exceed
  `stream.columns - 1` visible characters
- **prefer-subagent.AC5.4 Edge:** an unknown ticket is ignored;
  `PlainDisplay.setTicketStats` is a no-op

### prefer-subagent.AC6: Finish line
- **prefer-subagent.AC6.4 Success:** the tally includes ticket
  attempts, merge respawns, the reviewer and the fixer
- **prefer-subagent.AC6.5 Success:** both runners log the line after
  the finish summary
- **prefer-subagent.AC6.6 Edge:** a codex or pi run logs no stats
  line

### prefer-subagent.AC7: Cross-cutting
- **prefer-subagent.AC7.2 Success:** stats never change a ticket's
  outcome, an exit code, or `renderFinishSummary` output

---

## Codebase notes for the executor

- `src/learnings.ts` must import nothing but `node:fs` and
  `node:path` (AGENTS.md contract), so declare the new
  `AgentRunRecord` fields inline; do not import from `./stats.js`.
  - `AgentRunRecord` at :51-56.
  - `renderAgentSummary(run, effort?)` at :100-123 builds one line
    from `Effort: x.`, `Agent exit: n.`, `Checked items: ...`,
    joined with spaces. It is used only by the `done`, `exit`,
    `no-commits` and `tests` bodies in `renderEntry` (:147-271);
    `install`, `error` and `merge` do not call it.
- `src/display.ts`:
  - `DisplayTicket` at :9-15, `Display` type at :43-71 (`setBlocked`
    at :64 is the precedent for a per-ticket setter).
  - `rowText(ticket)` at :139-145 appends `(blocked by ...)`;
    `fitLine` at :152 clamps rows; `StatusDisplay` uses it on rows
    at ~:365, :376, :434. Confirm that the row built from `rowText`
    goes through `fitLine` (AC5.3 depends on it).
  - `StatusDisplay.setBlocked` at :304-315 (`findTicket(num,
    feature)`, mutate, `render()`); `PlainDisplay.setBlocked` at
    :504-510 is a no-op.
- Other `Display` implementations that must gain the method (tests
  are bundled by esbuild without a type check, but keep them
  type-correct): `class RecordingDisplay` at
  `test/display.test.ts:1748`, `recordingDisplay()` at
  `test/integration.test.ts:2246`, `quietDisplay()` at
  `test/review-integration.test.ts:30`, the display at
  `test/integration.test.ts:~4350`, and inline display literals
  in `test/orchestrator.test.ts` (~:4519, ~:4570). Find them all with
  `grep -n "setBlocked" test/*.ts`.
- `src/orchestrator.ts`:
  - `runTicketAttempt` builds `agentRun:AgentRunRecord` at
    ~:1791-1796 from `agentResult`.
  - `runTicketAttempts` at :1997-2050 wraps attempts in
    `runWithRetries`; it spreads `...opts` into `runTicketAttempt`.
  - `respawnAndRetryMerge` spawn at ~:1484.
  - In-place `runWaves`: the per-ticket pool function at
    ~:2290-2360 (two `spawnAgent` calls), finish summary logged at
    ~:2417: `d.log('\n' + renderFinishSummary(tickets,
    totalCompleted, failedKeys))`, then `d.cleanup()`.
  - `runWavesIsolated`: `runTicketAttempts({...})` at ~:2576,
    `respawnAndRetryMerge({...})` at ~:2831, `runReviewPass({...},
    { spawnAgent, registry:runningAgents })` at ~:3015-3035, finish
    summary at ~:3047, then `if (reviewLine) d.log(reviewLine)` and
    `d.log(\`Work is on ${baseBranch}\`)`.
- Fake claude (`test/mock-agent-claude.js`) supports
  `FAKE_CLAUDE_ENV_LOG`, `FAKE_CLAUDE_STREAM`, `FAKE_CLAUDE_HANG`,
  `FAKE_CLAUDE_DELEGATE` (Phases 2 and 4).
- Display tests: `class MockStream` at `test/display.test.ts:32`
  (`columns`, `rows`, `isTTY`, buffered `write`), `createMockStream()`
  at :78; narrow-terminal tests set `stream.columns = 40`
  (~:492-542) and check visible row widths.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Learnings entries show subagents and cost

**Verifies:** prefer-subagent.AC4.1, AC4.2, AC4.3, AC4.4 (tested in
Task 2)

**Files:**
- Modify: `src/learnings.ts:51-56` (`AgentRunRecord`)
- Modify: `src/learnings.ts:100-123` (`renderAgentSummary`)
- Modify: `src/orchestrator.ts:~1791-1796` (`agentRun` in
  `runTicketAttempt`)

**Implementation:**

1. `AgentRunRecord` gains:

```ts
    // claude only; absent = not reported
    subagents?:number
    costUsd?:number
```

2. In `renderAgentSummary`, after `exitLine`:

```ts
    const subagentsLine = run.subagents === undefined ?
        '' :
        `Subagents: ${run.subagents}.`
    const costLine = run.costUsd === undefined ?
        '' :
        `Cost: $${run.costUsd.toFixed(2)}.`
```

   and include them in the joined list in the order
   `effortLine, exitLine, subagentsLine, costLine, itemsLine`.
   `parseEntries` is unchanged (it does not parse the body).

3. In `runTicketAttempt`, copy the fields only when present, so
   records for codex and pi keep their current shape:

```ts
    const agentRun:AgentRunRecord = {
        exitCode:agentResult.exitCode,
        completedItems:agentResult.completedItems,
        timedOut:agentResult.timedOut,
        notes,
        ...(agentResult.subagents === undefined ?
            {} :
            { subagents:agentResult.subagents }),
        ...(agentResult.costUsd === undefined ?
            {} :
            { costUsd:agentResult.costUsd }),
    }
```

**Verification:** `npm run build` succeeds.

**Commit:** with Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Learnings tests

**Verifies:** prefer-subagent.AC4.1, AC4.2, AC4.3, AC4.4

**Files:**
- Modify: `test/learnings.test.ts` (unit)

**Testing:**

Use the existing entry-input helpers in the file. The lines are the
entry format contract, so `includes('Subagents: 3.')` and
`includes('Cost: $0.42.')` checks follow the file's current style for
`Agent exit:`.
- AC4.1: for each of `done`, `exit`, `no-commits` and `tests`, a run
  with `subagents:3, costUsd:0.42` renders a body that includes
  `Subagents: 3.` and `Cost: $0.42.`.
- AC4.2: a run with only `subagents:0` has the subagents line and no
  `Cost:`; a run with neither field has neither (`!includes
  ('Subagents:')`, `!includes('Cost:')`).
- AC4.3: `install`, `error` and `merge` entries include neither
  `Subagents:` nor `Cost:`.
- AC4.4: `parseEntries(renderEntry(x))` returns one entry with the
  right `key`, `attempt` and `outcome` for an input with both fields.
  For old entries, use a literal entry string in the pre-change
  format written into the test (copy one the file already uses as a
  fixture if there is one; otherwise a hand-written `done` entry:
  sentinel line, `## ... -- f/01 attempt 1 -- done` heading,
  `Agent exit: 0. Checked items: none.`, `The agent left no notes.`,
  `---`); it still parses to one entry with the expected `key`,
  `attempt` and `outcome`.

**Verification:** `npm run build && npm test` -- all pass.

**Commit:**

```bash
git add src/learnings.ts src/orchestrator.ts test/learnings.test.ts
git commit -m "feat: record subagent stats in learnings entries"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: `addStats` and `formatStats` in the stats core

**Verifies:** prefer-subagent.AC5.1, AC5.2 (pure halves; tested in
Task 5)

**Files:**
- Modify: `src/stats.ts`

**Implementation:**

```ts
// The running total of a ticket's attempts. A cost is kept as
// soon as either side reports one.
export function addStats (
    total:SubagentStats,
    run:{ subagents?:number; costUsd?:number }
):SubagentStats {
    const subagents = total.subagents + (run.subagents ?? 0)
    if (total.costUsd === undefined && run.costUsd === undefined) {
        return { subagents }
    }
    return {
        subagents,
        costUsd:(total.costUsd ?? 0) + (run.costUsd ?? 0),
    }
}

/**
 * The display row suffix, e.g. `2 subagents, $0.42`, or `null`
 * when there is nothing to show.
 */
export function formatStats (stats?:SubagentStats):string|null {
    if (!stats) return null
    if (stats.subagents === 0 && stats.costUsd === undefined) {
        return null
    }
    const count = `${stats.subagents} ` +
        (stats.subagents === 1 ? 'subagent' : 'subagents')
    return stats.costUsd === undefined ?
        count :
        `${count}, $${stats.costUsd.toFixed(2)}`
}
```

**Verification:** `npm run build` succeeds.

**Commit:** with Task 4.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: `setTicketStats` on the Display

**Verifies:** prefer-subagent.AC5.1, AC5.3, AC5.4 (tested in Task 5)

**Files:**
- Modify: `src/display.ts` (`DisplayTicket`, `Display`, `rowText`,
  `StatusDisplay`, `PlainDisplay`)
- Modify: every test `Display` implementation listed in the notes

**Implementation:**

1. `import { formatStats, type SubagentStats } from './stats.js'`.
2. `DisplayTicket` gains `stats?:SubagentStats`.
3. `Display` gains, after `setBlocked`:

```ts
    /**
     * Subagent stats for a ticket's row: the running total of
     * its attempts so far.
     */
    setTicketStats(
        num:number,
        feature:string|undefined,
        stats:SubagentStats,
    ):void
```

4. `rowText` appends ` - <suffix>` after the label and any
   `(blocked by ...)` part when `formatStats(ticket.stats)` is not
   `null`, e.g. `a/03 - 2 subagents, $0.42`. The row must still pass
   through `fitLine` (confirm the existing call sites clamp the
   whole row text).
5. `StatusDisplay.setTicketStats`: like `setBlocked`, find the
   ticket with `this.findTicket(num, feature)`; return when not
   found; set `ticket.stats = { ...stats }`; `this.render()`.
6. `PlainDisplay.setTicketStats`: no-op with the comment
   `// no-op: plain mode has no fixed list`. Name the parameters
   `_num`, `_feature`, `_stats`, like the other no-ops there, or
   `@typescript-eslint/no-unused-vars` fails.
7. Add a no-op `setTicketStats` to every test display listed in the
   notes (`RecordingDisplay` should record the call like its other
   methods; `recordingDisplay()` gets `record('setTicketStats')`).

**Verification:** `npm run build` succeeds.

**Commit:**

```bash
git add src/stats.ts src/display.ts test
git commit -m "feat: show subagent stats on display rows"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Stats suffix tests

**Verifies:** prefer-subagent.AC5.1, AC5.3, AC5.4 (and the pure half
of AC5.2)

**Files:**
- Modify: `test/stats.test.ts` (unit)
- Modify: `test/display.test.ts` (unit, `MockStream`)

**Testing:**
- `addStats` (AC5.2 pure half): `addStats({ subagents:1, costUsd:0.25
  }, { subagents:2, costUsd:0.5 })` deep-equals `{ subagents:3,
  costUsd:0.75 }`; `addStats({ subagents:1 }, { subagents:1 })`
  deep-equals `{ subagents:2 }` (no `costUsd` key); one side with a
  cost keeps it.
- `formatStats`: `null` for `undefined` and for `{ subagents:0 }`;
  non-null for `{ subagents:0, costUsd:0.1 }` and `{ subagents:2 }`.
- AC5.1: a `StatusDisplay` on a `MockStream` with `startRun` of two
  tickets, then `setTicketStats(1, feature, { subagents:2,
  costUsd:0.42 })`: the rendered output contains
  `formatStats({ subagents:2, costUsd:0.42 })` on the row with
  ticket 1's label, and ticket 2's row has no suffix.
- AC5.3: with `stream.columns = 20` and long feature names, after
  `setTicketStats`, every rendered row (ANSI stripped, split on
  newlines, after the last full repaint) is at most 19 visible
  characters. Reuse the width helper the narrow-terminal tests use.
- AC5.4: `setTicketStats` with an unknown `num` (or a known num with
  the wrong feature) does not throw and changes no row;
  `new PlainDisplay().setTicketStats(1, 'f', { subagents:1 })` writes
  nothing (capture `console.log` the way the PlainDisplay tests do,
  or assert the call returns `undefined` and the stream stays empty).

**Verification:** `npm run build && npm test` -- all pass;
`npm run lint` -- no errors.

**Commit:** `test: cover display stats suffix`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-8) -->
<!-- START_TASK_6 -->
### Task 6: Fake claude can fail its first run

**Verifies:** None (test fixture)

**Files:**
- Modify: `test/mock-agent-claude.js`

**Implementation:**

Add `FAKE_CLAUDE_FAIL_ONCE` (path to a marker file). After the env
log and the stream, and before the delegate: when the variable is
set and the marker does not exist, create the marker and set
`process.exitCode = 1` and return. Later runs see the marker and
continue normally (delegate, hang or exit 0).

**Verification:** `npm run lint` -- no errors.

**Commit:** `test: let fake claude fail its first run`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Per-ticket running total and run tally in both runners

**Verifies:** prefer-subagent.AC5.2, AC6.4, AC6.5, AC6.6, AC7.2
(tested in Task 8)

**Files:**
- Modify: `src/orchestrator.ts` (locations in the notes)

**Implementation:**

1. Import `emptyRunStats`, `addRun`, `renderRunStats`, `addStats`
   and `type SubagentStats` from `./stats.js`.

2. `TicketAttemptOpts` and `respawnAndRetryMerge` opts gain:

```ts
    // called with every agent result, for the run's stats tally
    onAgentRun?:(result:AgentResult) => void
```

   `runTicketAttempt` gains an internal-only option
   `onStats?:(stats:SubagentStats) => void` on its
   `TicketAttemptOpts&{ attempt:number }` parameter (add it to the
   intersection, not to `TicketAttemptOpts`). It passes
   `onStats:opts.onStats` to `spawnAgent`, and calls
   `opts.onAgentRun?.(agentResult)` right after `spawnAgent`
   resolves. `respawnAndRetryMerge` calls
   `opts.onAgentRun?.(result)` right after its `spawnAgent`.

3. `runTicketAttempts` keeps the ticket's running total across
   attempts:

```ts
    // The row shows every attempt's subagents and cost so far.
    let prior:SubagentStats = { subagents:0 }
    const showStats = (stats:SubagentStats):void => {
        d.setTicketStats(ticket.num, ticket.feature, stats)
    }
```

   and passes to `runTicketAttempt`:

```ts
                onStats:stats => showStats(addStats(prior, stats)),
                onAgentRun:result => {
                    prior = addStats(prior, result)
                    opts.onAgentRun?.(result)
                },
```

4. `runWavesIsolated`:
   - `let runStats = emptyRunStats()` and
     `const onAgentRun = (result:AgentResult):void => {
     runStats = addRun(runStats, result) }` near the top.
   - Pass `onAgentRun` to `runTicketAttempts({...})` and
     `respawnAndRetryMerge({...})`.
   - Replace the review deps with a wrapper that tallies:

```ts
            }, {
                spawnAgent:async spawnOpts => {
                    const result = await spawnAgent(spawnOpts)
                    onAgentRun(result)
                    return result
                },
                registry:runningAgents,
            })
```

   - Right after the `renderFinishSummary` log:

```ts
    const statsLine = renderRunStats(runStats)
    if (statsLine) d.log(statsLine)
```

     (before `reviewLine` and `Work is on ...`).

5. In-place `runWaves`:
   - `let runStats = emptyRunStats()` before the wave loop.
   - In the per-ticket pool function: `let prior:SubagentStats =
     { subagents:0 }`; pass
     `onStats:stats => d.setTicketStats(t.num, t.feature,
     addStats(prior, stats))` to both `spawnAgent` calls; after each
     `spawnAgent` resolves, `prior = addStats(prior, result)` and
     `runStats = addRun(runStats, result)`.
   - After the `renderFinishSummary` log, the same two-line
     `renderRunStats` block, before `d.cleanup()`.

`renderFinishSummary` and every outcome decision are untouched.

**Verification:** `npm run build` succeeds.

**Commit:** with Task 8.
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Running total, tally and finish-line tests

**Verifies:** prefer-subagent.AC5.2, AC6.4, AC6.5, AC6.6, AC7.2

**Files:**
- Modify: `test/orchestrator.test.ts` (in-place `runWaves`)
- Modify: `test/integration.test.ts` (`runWavesIsolated`, retries
  and merge respawn)
- Modify: `test/review-integration.test.ts` (reviewer and fixer)

**Testing:**

Hermetic repos: every new test that calls `initTempGitRepo()`
creates `const templateDir = mkdtempSync(join(tmpdir(),
'nightralph-tpl-'))`, calls `initTempGitRepo({ templateDir })`, and
runs `rmSync(templateDir, { recursive:true, force:true })` in
`finally` (precedent: `test/integration.test.ts:1023-1024`). A plain
`initTempGitRepo()` picks up the machine's `init.templateDir`, whose
`info/exclude` can be a symlink shared with other repos. Never write
`info/exclude`. `installMergeFailOnceGit(failBranch)` still works,
since the repo name comes from `projectDir`.

Use `FAKE_CLAUDE` with `FAKE_CLAUDE_STREAM` pointing at a file whose
lines are one main-loop assistant message with an `Agent` tool_use
and one `result` with `total_cost_usd:0.25` and
`subagent_stats:{ spawned:1 }`. Each fake run then reports
`{ subagents:1, costUsd:0.25 }`. Compare log lines with
`renderRunStats(...)` built from a literal `RunStats`, and find the
finish summary log as `'\n' + renderFinishSummary(tickets, n,
failedKeys)` computed after the run, so no test pins prose. Restore
all `FAKE_CLAUDE_*` env vars in `finally`.

- AC6.5 + AC7.2 (in-place): `runWaves` in-place with `FAKE_CLAUDE`
  (no `FAKE_CLAUDE_DELEGATE`, so it touches no files; exit 0), one
  ticket, a logging display. The ticket
  ends `done` and `allDone` is true; the logs contain
  `'\n' + renderFinishSummary(tickets, 1, new Set())` and, at a
  later index, `renderRunStats({ agentRuns:1, withCost:1,
  subagents:1, costUsd:0.25 })`. For AC7.2 also run the same setup
  with a stream whose `result` has `subtype:'error_max_turns'` and
  `is_error:true`, plus a non-JSON line; the outcome is still
  `done`/`allDone`.
- AC6.6 (in-place): the same, but with `agentCmd` =
  `test/mock-agent-noop.js` (add a `MOCK_NOOP` const; it exits 0 and
  touches no git). Do not use `MOCK_PASS` here: in-place `runWaves`
  spawns agents in `process.cwd()`, which is the repo root during
  `npm test`, and `MOCK_PASS` would commit into the developer's
  checkout. The finish summary is the last `log` call (nothing is
  logged after it).
- AC6.5 (isolated): `runWavesIsolated` in a hermetic
  `initTempGitRepo({ templateDir })`
  with `FAKE_CLAUDE`, `FAKE_CLAUDE_DELEGATE` = `MOCK_PASS`, one
  ticket, a recording display; the stats line for one run follows
  the finish summary in the `log` calls.
- AC6.4 (ticket + respawn): extend or copy the Phase 4 respawn test
  (two tickets, `installMergeFailOnceGit`) with the stream file;
  the logs contain `renderRunStats({ agentRuns:3, withCost:3,
  subagents:3, costUsd:0.75 })`.
- AC6.4 (reviewer + fixer): in `test/review-integration.test.ts`,
  the Phase 4 harness run with `FAKE_CLAUDE_STREAM` set and a display
  that records logs (`{ ...quietDisplay(), log:... }`, as at :237):
  `countRoles` is one of each and the logs contain
  `renderRunStats({ agentRuns:3, withCost:3, subagents:3,
  costUsd:0.75 })`.
- AC5.2: `runWavesIsolated` with `retries:1`, `retryDelay:0`,
  `FAKE_CLAUDE`, `FAKE_CLAUDE_FAIL_ONCE` (a marker path in a temp
  dir), `FAKE_CLAUDE_DELEGATE` = `MOCK_PASS`, one ticket, and
  `recordingDisplay()`. The ticket ends `done`; the last
  `setTicketStats` call for it has stats deep-equal to
  `{ subagents:2, costUsd:0.5 }`, and some earlier call deep-equals
  `{ subagents:2, costUsd:0.25 }` (the second attempt's live
  `Agent` count added to the first attempt's final total, before the
  second `result` arrives). Also read
  the feature's `learnings.md` with `parseEntries`: two entries,
  each body including `Subagents: 1.` (AC4.1 wiring through
  `runTicketAttempt`).

Follow project testing patterns. The executor writes the test code.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`
Expected: no errors.

**Commit:**

```bash
git add src/orchestrator.ts test test/fake-claude
git commit -m "feat: tally subagent stats per ticket and per run"
```
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_C -->
