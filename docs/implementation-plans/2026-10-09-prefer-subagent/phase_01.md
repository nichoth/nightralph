# Prefer Subagent Implementation Plan

**Goal:** A pure stats core that turns claude stream-json objects into
subagent counts and cost, and renders a run-wide total line.

**Architecture:** New module `src/stats.ts` with no imports at all
(it must not import from `src/orchestrator.ts`, following the
`src/learnings.ts` precedent). State is immutable: `nextStreamStats`
returns the same state object when nothing changed, a new one
otherwise, so callers detect changes by identity.

**Tech Stack:** TypeScript, Node >= 24, ESM, esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 1 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

This phase implements and tests:

### prefer-subagent.AC3: Stats capture
- **prefer-subagent.AC3.1 Success:** a main-loop `Agent` tool_use
  counts one subagent
- **prefer-subagent.AC3.2 Success:** a main-loop `Task` tool_use
  counts one subagent
- **prefer-subagent.AC3.3 Edge:** a message with a non-null
  `parent_tool_use_id` is not counted
- **prefer-subagent.AC3.4 Edge:** a repeated tool_use id counts once
- **prefer-subagent.AC3.5 Success:** a `result` sets the cost and
  replaces the count with `subagent_stats.spawned`; the last of
  several results wins and nothing is summed; a result without
  `subagent_stats` keeps the live count
- **prefer-subagent.AC3.6 Failure:** non-JSON lines, non-objects and
  wrong-typed fields leave the state unchanged and never throw

### prefer-subagent.AC6: Finish line
- **prefer-subagent.AC6.1 Edge:** `renderRunStats` returns `null`
  when no run reported anything
- **prefer-subagent.AC6.2 Success:** the line has the subagent total,
  the agent-run count and the cost
- **prefer-subagent.AC6.3 Edge:** the partial-cost marker appears
  only when some runs reported no cost

---

## Codebase notes for the executor

- Read `AGENTS.md` (root) first. It lists the build and test file
  lists that must be edited by hand.
- `package.json` line 20, script `build-esm`: the second `esbuild`
  call lists standalone modules (`src/orchestrator.ts ... src/review.ts`).
  A module missing there gets no `dist/<name>.js`.
- `scripts/test.sh` lines 13-29: the `TESTS=( ... )` array. A test
  file missing there never runs.
- Test style (see `test/learnings.test.ts:40`):
  `import { test } from '@substrate-system/tapzero'`, then
  `test('AC3.1: ...', t => { ... })` with `t.ok`, `t.equal`,
  `t.deepEqual`. Test names carry the AC id.
- Code style (user's global rules): 4-space indent, no semicolons,
  single quotes, no space between colon and type (`a:number`), lines
  at most 80 columns, ternaries break after `?` and `:` with the
  operator at line end. Union types without spaces (`A|B`), enforced
  by a local eslint rule. No em dashes or arrow characters in
  comments; use `--` and `->`.
- "JSON lines that fail to parse" are handled by the caller
  (`spawnAgent` in Phase 2), which only passes parsed values to
  `nextStreamStats`. AC3.6's "non-JSON lines" is therefore covered
  here by feeding `nextStreamStats` the values a failed or odd parse
  could yield (`undefined`, `null`, a number, a string, an array),
  and in Phase 2 by a fake agent that prints a non-JSON line.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Register the new module in the build

**Verifies:** None (build wiring)

**Files:**
- Modify: `package.json:20` (`build-esm`, second esbuild call)

**Step 1: Edit `package.json`**

In the `build-esm` script, in the second `esbuild` call, add
`src/stats.ts` right after `src/review.ts`:

```
... src/retry.ts src/rules.ts src/review.ts src/stats.ts --format=esm ...
```

**Step 2: Do not verify yet.** The build fails until Task 2 creates
`src/stats.ts`. Commit together with Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Stats core implementation

**Verifies:** prefer-subagent.AC3.1, AC3.2, AC3.3, AC3.4, AC3.5,
AC3.6, AC6.1, AC6.2, AC6.3 (tested in Task 3)

**Files:**
- Create: `src/stats.ts`

**Implementation:**

Create `src/stats.ts` with this content (adjust only for lint):

```ts
// Subagent counts and cost read from claude's stream-json output,
// and the run-wide total. Pure: imports nothing, so the
// orchestrator, display and tests can all use it.

export type SubagentStats = {
    subagents:number
    // absent until a `result` message reports it
    costUsd?:number
}

export type StreamStatsState = {
    readonly stats:SubagentStats
    // tool_use ids already counted, so a repeated id counts once
    readonly seenToolIds:ReadonlySet<string>
}

export type RunStats = {
    // spawnAgent results tallied
    readonly agentRuns:number
    // of those, how many reported a cost
    readonly withCost:number
    readonly subagents:number
    readonly costUsd:number
}

// Starting a subagent is a tool_use named `Agent`; Claude Code
// named it `Task` before 2.1.63.
const SUBAGENT_TOOLS:ReadonlySet<string> = new Set(['Agent', 'Task'])

function isRecord (value:unknown):value is Record<string, unknown> {
    return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
}

export function emptyStreamStats ():StreamStatsState {
    return { stats:{ subagents:0 }, seenToolIds:new Set() }
}

/**
 * Fold one parsed stream-json value into the state. Returns the
 * same `state` object when nothing changed, so callers can detect
 * a change by identity. Never throws.
 */
export function nextStreamStats (
    state:StreamStatsState,
    obj:unknown
):StreamStatsState {
    if (!isRecord(obj)) return state
    if (obj.type === 'assistant') return countSubagents(state, obj)
    if (obj.type === 'result') return applyResult(state, obj)
    return state
}

function countSubagents (
    state:StreamStatsState,
    obj:Record<string, unknown>
):StreamStatsState {
    // A message from inside a subagent carries the id of the
    // tool_use that started it; only the main loop is counted.
    if (obj.parent_tool_use_id != null) return state
    const message = obj.message
    if (!isRecord(message) || !Array.isArray(message.content)) {
        return state
    }
    const ids:string[] = []
    for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue
        if (
            typeof block.name !== 'string' ||
            !SUBAGENT_TOOLS.has(block.name)
        ) continue
        if (typeof block.id !== 'string') continue
        if (state.seenToolIds.has(block.id)) continue
        if (ids.includes(block.id)) continue
        ids.push(block.id)
    }
    if (ids.length === 0) return state
    return {
        stats:{
            ...state.stats,
            subagents:state.stats.subagents + ids.length,
        },
        seenToolIds:new Set([...state.seenToolIds, ...ids]),
    }
}

// `total_cost_usd` is cumulative and a process can emit several
// `result` messages, so the latest one replaces earlier values.
function applyResult (
    state:StreamStatsState,
    obj:Record<string, unknown>
):StreamStatsState {
    const cost = obj.total_cost_usd
    const hasCost = typeof cost === 'number' && Number.isFinite(cost)
    const subagentStats = obj.subagent_stats
    const spawned = isRecord(subagentStats) ?
        subagentStats.spawned :
        undefined
    const hasSpawned = typeof spawned === 'number' &&
        Number.isInteger(spawned) &&
        spawned >= 0
    if (!hasCost && !hasSpawned) return state

    const subagents = hasSpawned ?
        spawned as number :
        state.stats.subagents
    const costUsd = hasCost ?
        cost as number :
        state.stats.costUsd
    // A repeated result with the same values is not a change
    if (
        subagents === state.stats.subagents &&
        costUsd === state.stats.costUsd
    ) return state
    return {
        stats:costUsd === undefined ?
            { subagents } :
            { subagents, costUsd },
        seenToolIds:state.seenToolIds,
    }
}

export function emptyRunStats ():RunStats {
    return { agentRuns:0, withCost:0, subagents:0, costUsd:0 }
}

export function addRun (
    run:RunStats,
    result:{ subagents?:number; costUsd?:number }
):RunStats {
    return {
        agentRuns:run.agentRuns + 1,
        withCost:run.withCost + (result.costUsd === undefined ? 0 : 1),
        subagents:run.subagents + (result.subagents ?? 0),
        costUsd:run.costUsd + (result.costUsd ?? 0),
    }
}

/**
 * The one-line total logged after the finish summary, or `null`
 * when no run reported a subagent or a cost (codex and pi never
 * do).
 */
export function renderRunStats (run:RunStats):string|null {
    if (run.agentRuns === 0) return null
    if (run.withCost === 0 && run.subagents === 0) return null
    const runs = `${run.agentRuns} agent ` +
        (run.agentRuns === 1 ? 'run' : 'runs')
    const partial = run.withCost < run.agentRuns ?
        ` (cost from ${run.withCost} of ${run.agentRuns} runs)` :
        ''
    return `Subagents: ${run.subagents} started across ${runs}, ` +
        `cost $${run.costUsd.toFixed(2)}${partial}`
}
```

Key contracts:
- `stats` objects never carry a `costUsd:undefined` key (so
  `t.deepEqual` against `{ subagents:1 }` works).
- `nextStreamStats` returns the input `state` by identity whenever
  nothing changed, including a repeated `result` with the same
  values, so `onStats` (Phase 2) fires only on a real change.

**Step: Verify the build**

Run: `npm run build`
Expected: succeeds; `ls dist/stats.js` lists the file.

**Commit (with Task 1):**

```bash
git add package.json src/stats.ts
git commit -m "feat: add subagent stats core"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Stats core tests

**Verifies:** prefer-subagent.AC3.1, AC3.2, AC3.3, AC3.4, AC3.5,
AC3.6, AC6.1, AC6.2, AC6.3

**Files:**
- Create: `test/stats.test.ts` (unit)
- Modify: `scripts/test.sh:13-29` (`TESTS` array): add `stats`
  directly after `learnings`, in the same commit as the new test
  file, so no commit lists a suite that does not exist

**Testing:**

Build small helpers in the test file, e.g.
`assistant(blocks, parent = null)` returning
`{ type:'assistant', parent_tool_use_id:parent, message:{ content:blocks } }`
and `toolUse(name, id)` returning
`{ type:'tool_use', name, id, input:{} }`. Fold a list of values
with `values.reduce(nextStreamStats, emptyStreamStats())`.

Tests must verify each AC:
- AC3.1: one main-loop assistant message with a `tool_use` named
  `Agent` -> `stats` deep-equals `{ subagents:1 }`.
- AC3.2: same with `Task` -> `{ subagents:1 }`. Also a `tool_use`
  named something else (e.g. `Bash`) counts nothing.
- AC3.3: an assistant message with `parent_tool_use_id:'toolu_x'`
  and an `Agent` tool_use -> state returned by identity
  (`t.equal(next, state)`). A message with `parent_tool_use_id`
  absent counts (absent means main loop).
- AC3.4: the same tool_use id in two messages, and twice in one
  message -> `subagents` is 1 in both cases.
- AC3.5: a `result` with `total_cost_usd:0.5` and no
  `subagent_stats` after two counted Agent calls -> `{ subagents:2,
  costUsd:0.5 }`. A `result` with `subagent_stats:{ spawned:5 }`
  replaces the count with 5. Two results (`0.5` then `0.75`, spawned
  3 then 4) -> cost is 0.75 and subagents 4 (not summed). A second
  `result` identical to the first returns the state by identity.
- AC3.6: each of `undefined`, `null`, `42`, `'text'`, `[]`,
  `{ type:'assistant' }` (no message), `{ type:'assistant',
  message:{ content:'x' } }`, a tool_use with numeric `id` or
  numeric `name`, `{ type:'result', total_cost_usd:'1' }`,
  `{ type:'result', total_cost_usd:NaN }`, `{ type:'result',
  subagent_stats:{ spawned:-1 } }` and `{ type:'result',
  subagent_stats:{ spawned:1.5 } }` returns the input state by
  identity and does not throw.
- AC6.1: `renderRunStats(emptyRunStats())` is `null`; after
  `addRun` with `{}` (a codex/pi result) it is still `null`.
- AC6.2: after `addRun` with `{ subagents:2, costUsd:0.5 }` and
  `{ subagents:1, costUsd:0.25 }`, the tally deep-equals
  `{ agentRuns:2, withCost:2, subagents:3, costUsd:0.75 }`, and the
  line is non-null and contains `'3'` (subagents), `' 2 '` (agent
  runs, with spaces so it does not match inside another number) and
  `'0.75'` (cost).
- AC6.3: build two `RunStats` literals with the same `agentRuns:2`,
  `subagents:3` and `costUsd:0.5`, one with `withCost:2` (`full`)
  and one with `withCost:1` (`partial`). Assert
  `renderRunStats(partial)` starts with `renderRunStats(full)` and
  is strictly longer (the marker is appended only when some runs
  reported no cost).

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass, including `stats`.

Run: `npm run lint`
Expected: no errors.

**Commit:**

```bash
git add scripts/test.sh test/stats.test.ts
git commit -m "test: cover subagent stats core"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
