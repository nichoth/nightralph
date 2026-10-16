# Feature Graph Implementation Plan -- Phase 1

**Goal:** One exported pure function, `simulateRun`, that says which
tickets run, in which wave, and why the rest never do.

**Architecture:** `simulateRun` lives in `src/orchestrator.ts` next to
the private `simulateWaves` and `detectDeadlocks` it composes, plus
the exported `findBlockedTickets`. Readiness, `--dry-run` and the
coming `graph` command then share one predicate (`blockerSatisfied`).
Existing callers of `simulateWaves` and `detectDeadlocks` are not
changed.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 1 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### feature-graph.AC3: Verified suggestion
- **feature-graph.AC3.7 Success:** `simulateRun`'s waves match the
  dry-run waves, `neverRun` is the `ready-for-agent` tickets in no
  wave, and `deadRefs` equals `findBlockedTickets(tickets, new Set())`

---

## Codebase facts the executor needs

- `src/orchestrator.ts` is ~3450 lines. Never read it whole; use
  `grep -n` and read ranges.
- `Ticket` is a `type` at `src/orchestrator.ts:117-126`
  (`num, slug, filename, filepath, body, status, blockers, feature`),
  written with no semicolons between members. `BlockerRef` is imported
  as a type from `./blockers.js` (line 113) and is not re-exported.
- `function * simulateWaves (tickets:ReadonlyArray<Ticket>)` at
  `src/orchestrator.ts:680-713` yields `{ wave:number; ready:Ticket[] }`
  per wave. It starts from the input statuses (a `done` ticket counts
  as satisfied from wave 1) and only ever yields `ready-for-agent`
  tickets.
- `function detectDeadlocks (tickets:ReadonlyArray<Ticket>):Ticket[]`
  at `src/orchestrator.ts:715-746` runs the same predicate to a fixed
  point and returns the `ready-for-agent` tickets that never become
  satisfied. That is a superset of true cycles: tickets behind a
  `pending`/`missing`/human blocker are in it too.
  `renderNothingReady` (line ~2482) separates the two by removing the
  keys of `findBlockedTickets(tickets, new Set())`.
- `findBlockedTickets(tickets, failedKeys)` at line ~305 returns
  `Map<string, BlockerRef[]>` keyed by `ticketKey(feature, num)`.
- `dryRun(tickets, specBody, testCmd, preferSubagent?)` at line ~1324
  prints `\nSimulated wave order:` then one line per wave:
  `  Wave ${wave}: ` + filenames joined with `, `.
- Tests: `test/orchestrator.test.ts`. Imports from
  `'../src/orchestrator.js'` are a multi-line list at lines 11-48
  (`findBlockedTickets` line 16, `dryRun` line 27, `type Ticket` line
  46). `import type { BlockerRef } from '../src/blockers.js'` is line
  54. Helper `makeTicket(overrides)` at lines 111-135: numeric
  `blockers` become `{ feature, num, where:'run' }` in the ticket's own
  feature, `BlockerRef` objects are passed through, `feature` defaults
  to `''`, `status` to `ready-for-agent`.
- Console capture idiom in that file (no shared helper):
  ```ts
  const output:Array<string> = []
  const originalLog = console.log
  console.log = function (msg:unknown) {
      output.push(String(msg))
  }
  try {
      dryRun(tickets, 'spec body', 'npm test')
  } finally {
      console.log = originalLog
  }
  ```
- The `// -- simulateWaves / detectDeadlocks (via dryRun) --` section
  starts at line 1203 and ends before `// -- markDone --` at line 1378.
- Style: `name:type` with no space, lines under 80 columns, the
  repo's ternary style (`cond ?\n    a :\n    b`), no em dashes or
  arrow characters in comments, no `// pattern:` comments.
- Run one suite without the full script:
  `npx esbuild test/orchestrator.test.ts --format=esm --bundle
  --packages=external --outdir=dist/test --sourcemap &&
  node dist/test/orchestrator.test.js`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `simulateRun` and `SimulatedRun`

**Verifies:** None (implementation; Task 2 tests it)

**Files:**
- Modify: `src/orchestrator.ts` -- insert directly after the closing
  `}` of `detectDeadlocks` (currently line 746, before
  `const PROVIDER_ARGS`)

**Implementation:**

```ts
/**
 * The whole run simulated with the dry-run wave logic: the waves in
 * order, the ready-for-agent tickets that never reach a wave, and
 * the dead upstream refs of the tickets that cannot run (the same
 * map renderNothingReady uses). A `neverRun` ticket with no
 * `deadRefs` entry waits on a cycle.
 */
export type SimulatedRun = {
    waves:Ticket[][]
    neverRun:Ticket[]
    deadRefs:Map<string, BlockerRef[]>
}

export function simulateRun (
    tickets:ReadonlyArray<Ticket>
):SimulatedRun {
    return {
        waves:[...simulateWaves(tickets)].map(w => w.ready),
        neverRun:detectDeadlocks(tickets),
        deadRefs:findBlockedTickets(tickets, new Set()),
    }
}
```

`findBlockedTickets` is declared earlier in the same file, so no
import changes are needed.

**Verification:**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit code 0 and no `error TS` lines (the command also
prints a file list; that is normal)

**Commit:** do not commit yet; Task 2 commits with the tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `simulateRun` tests

**Verifies:** feature-graph.AC3.7

**Files:**
- Modify: `test/orchestrator.test.ts` -- add `simulateRun,` to the
  import list from `'../src/orchestrator.js'` (lines 11-48, keep the
  list's order style); add a new section
  `// -- simulateRun --` immediately before `// -- markDone --`
  (line 1378)

**Testing:**

Build one in-memory fixture with `makeTicket`. Use unique filenames
across features, since `dryRun` prints filenames only. Pass
cross-feature refs as `BlockerRef` objects. The fixture covers:

- a chain across features that runs in three waves:
  `a/01` done; `a/02` waits on `a/01`; `a/03` waits on `a/02`;
  `b/01` waits on `{ feature:'a', num:3, where:'run' }`
- a ticket behind a human ticket: `a/04` `ready-for-human`; `a/05`
  waits on `a/04`
- a cycle: `b/02` waits on `b/03`; `b/03` waits on `b/02`
- a ticket behind a pending ref:
  `b/04` waits on
  `{ feature:'c', num:9, where:'pending', status:'ready-for-agent' }`

Tests (each `t.deepEqual`/`t.equal` with a message):

1. AC3.7 waves: capture `dryRun(tickets, 'spec body', 'npm test')`
   output, keep lines matching `/^  Wave \d+: (.*)$/`, split the
   capture on `', '`, and `t.deepEqual` that with
   `simulateRun(tickets).waves.map(w => w.map(t => t.filename))`.
   Also assert there are 3 waves.
2. AC3.7 neverRun: the sorted `ticketKey`s of `neverRun` equal the
   sorted keys of every `ready-for-agent` ticket whose key is in no
   wave (compute that set in the test from `waves`). For this fixture
   that is `a:5`, `b:2`, `b:3`, `b:4`.
3. AC3.7 deadRefs: `t.deepEqual([...run.deadRefs.entries()],
   [...findBlockedTickets(tickets, new Set()).entries()])`. Spread the
   maps: tapzero's `deepEqual` is fast-deep-equal, which compares own
   enumerable keys, so any two `Map`s compare equal. Also assert
   `deadRefs` has keys `a:5` and `b:4`, and that the cycle tickets
   (`b:2`, `b:3`) are not keys, which is the property `graph` relies on
   to tell cycles from dead ends.
4. Empty input: `simulateRun([])` gives `waves` `[]`, `neverRun` `[]`
   and a `deadRefs` of size 0.

**Verification:**

Run: `npx esbuild test/orchestrator.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/orchestrator.test.js`
Expected: all tests pass, including the new `simulateRun` ones

Run: `npm run lint`
Expected: no errors

**Commit:**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: add simulateRun, the dry-run simulation as data"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
