# Cross-Feature Blockers Implementation Plan -- Phase 2

**Goal:** Tickets carry `BlockerRef[]`, and every readiness decision
keys a blocker by the blocker's own feature.

**Architecture:** `src/blockers.ts` gains the resolved-ref types and
`resolveBlockers`. `Ticket.blockers` becomes `BlockerRef[]`.
`scanTickets` fills refs provisionally (every ref `where:'run'`), so
a bare scan behaves as before: a ref to a ticket not in the list is
never satisfied. A single predicate, `blockerSatisfied`, replaces the
three inline copies in `findReadyTickets`, `simulateWaves` and
`detectDeadlocks`. `findBlockedTickets` returns dead refs instead of
keys. Phase 3 is what produces `done`, `pending` and `missing` refs;
this phase tests them with inline `BlockerRef`s.

**Tech Stack:** TypeScript (ESM), `@substrate-system/tapzero`

**Scope:** Phase 2 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements and tests (at the function level, with inline
`BlockerRef`s):

### cross-feature-blockers.AC2: Readiness and reporting
- **cross-feature-blockers.AC2.1 Success:** a ticket whose blocker
  is in an unselected feature and done is ready
- **cross-feature-blockers.AC2.2 Failure:** a ticket whose blocker
  is in an unselected feature and not done is not ready; its row
  label names `<feature>/<NN>` and the blocker's status
- **cross-feature-blockers.AC2.3 Success:** with both features
  selected, the cross-feature blocker runs in an earlier wave than
  its dependent
- **cross-feature-blockers.AC2.4 Failure:** a ref that matches no
  ticket (same or other feature) leaves the ticket not ready; the
  row label says not found, the picker label counts a bad blocker,
  and the finish summary lists it
  (this phase: not ready and the row label; picker label in Phase 3;
  finish summary in Phase 4)
- **cross-feature-blockers.AC2.5 Edge:** if A waits on in-run B and
  B waits on outside pending C, A is reported blocked by C
- **cross-feature-blockers.AC2.6 Edge:** a ready-for-human `a/02`
  does not mark `b/03` as blocked by a human just because `b/03`
  lists `02`
- **cross-feature-blockers.AC2.8 Success:** the dry run lists
  blocker labels, and `simulateWaves` and `detectDeadlocks` agree
  with `findReadyTickets`

---

## Divergences from the design (and why)

- `blockerLabel`, the `listTickets` label change and the
  `renderFinishSummary` human-key fix (AC2.6) are in this phase,
  not Phase 4. Changing `Ticket.blockers` to `BlockerRef[]` breaks
  their compile (`t.blockers.join`, `humanNums.has(b)`), and the
  phase must build. The `buildHistory` key change (line 1679) is
  here for the same reason; the cross-feature learnings read stays
  in Phase 4.
- `reportBlocked` labels a dead ref that has a `Ticket` in the run
  with `ticketLabel(toRef(t))`, as today (so featureless scans in
  existing tests still show filenames), and uses `blockerLabel` only
  for refs with no ticket (`pending`, `missing`). For tickets with a
  feature the two produce the same `<feature>/<NN>` text.
- `src/blockers.ts` gains `provisionalRefs(raw, ownFeature)` for
  `scanTickets`, because `resolveBlockers` needs a selection map a
  bare scan does not have.

---

## Codebase facts the executor needs

`src/orchestrator.ts` (line numbers before this phase):
- `Ticket` type, lines 100-108: `num, slug, filename, filepath,
  body, status, blockers:number[], feature`.
- `parseBlockers`, lines 188-200: only caller is `scanTickets` line
  225. Remove it.
- `scanTickets(dir:string, feature:string = ''):Ticket[]`, lines
  202-229; sets `blockers:parseBlockers(body)` at line 225.
- `ticketKey(feature, num)`, lines 231-233: `${feature}:${num}`.
- `findReadyTickets`, ~lines 235-249: builds `doneKeys` from done
  tickets, then `t.blockers.every(b =>
  doneKeys.has(ticketKey(t.feature, b)))` at line 245.
- `findBlockedTickets`, ~lines 251-300: returns
  `Map<string, Array<string>>`; inner `collectDead` keys blockers by
  `ticketKey(ticket.feature, b)` (line 273-274); a blocker with no
  matching ticket is skipped (not dead); visited set stops cycles.
- `listTickets` (not exported), lines 614-625: prints
  `blocked by [${t.blockers.join(', ')}]`. Callers `dryRun` line
  1216, `dryRunIsolated` line 1262.
- `simulateWaves` (generator), lines 627-657: same-feature check at
  line 648.
- `detectDeadlocks` (not exported), lines 666-700: same-feature
  check at line 688.
- `buildHistory`, lines 1669-1692: `blockerKeys:ticket.blockers.map(
  b => ticketKey(ticket.feature, b))` at line 1679.
- `renderFinishSummary`, ~lines 2105-2185: `humanNums = new
  Set(human.map(t => t.num))` and `t.blockers.some(b =>
  humanNums.has(b))` at lines 2113-2117 (bare numbers, any feature).
- `toRef` ~line 2201 returns `{ num, filename, feature }`.
- `reportBlocked`, lines 2206-2225: maps dead keys through `byKey` to
  `ticketLabel(toRef(t))` and calls
  `d.setBlocked(ticket.num, ticket.feature, labels)`. Callers at
  2266, 2278, 2412, 2546, 2558, 3007 (unchanged).
- `ticketLabel` is imported from `./display.js` (display.ts lines
  119-127): `<feature>/<NN>` when `feature` is set, else
  `filename`.

`src/index.ts` lines 322-339 (inside `loadTickets`): filters
`t.blockers` against `knownNums` (this feature's ticket numbers),
logging `${t.filename}: blockers [..] not found in directory`.
Phase 3 deletes this block; this phase only keeps it compiling.

Tests:
- `test/orchestrator.test.ts` imports (lines 11-44) include
  `parseBlockers` (line 14), `findBlockedTickets`,
  `renderFinishSummary`, `ticketKey`, `dryRun`.
- `makeTicket(overrides:Partial<Ticket>&{ num; filename })`, lines
  99-118, sets `blockers:overrides.blockers ?? []` then spreads
  `...overrides`. Fixtures pass `blockers:[1]`, `[2, 3]`,
  `[1, 2, 3]`; a chain builder at lines 904-913 pushes numbers into
  an array. `makeTicketBody(opts:{ status; blockers?:number[] })`,
  lines 82-97, writes `**Blocked by:** 1, 2` text (unchanged).
- `parseBlockers` tests at lines 182-212.
- `findBlockedTickets` tests at lines 540-934 assert
  `blocked.get('f:2')` deepEqual arrays of keys like `['f:1']`.
- `// -- simulateWaves / detectDeadlocks (via dryRun) --` at line
  936: these tests capture `console.log` output of `dryRun`. Reuse
  that capture pattern.
- `renderFinishSummary` tests at lines 4294-4460.
- `test/worktree.test.ts:87`, `test/progress.test.ts:35`,
  `test/learnings.test.ts:845` use `blockers:[]` -- still valid,
  no change.
- `test/integration.test.ts` writes ticket files with
  `makeTicketBody({ blockers:[...] })` text and calls
  `scanTickets(issuesDir)` (no feature): no change needed; bare
  numbers still resolve to the ticket's own feature (`''`).

Type-check: `npx tsc --noEmit -p tsconfig.build.json` must stay at
0 errors. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS"
| cut -d'(' -f1 | sort | uniq -c` must show only the baseline: 135
in `test/display.test.ts`, 8 in `test/orchestrator.test.ts`.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `BlockerRef`, `resolveBlockers`, `provisionalRefs`

**Verifies:** cross-feature-blockers.AC2.1, AC2.2, AC2.4 (the
classification half; readiness in Task 4)

**Files:**
- Modify: `src/blockers.ts` (append)
- Modify: `test/blockers.test.ts` (append)

**Implementation:** append to `src/blockers.ts`:

```ts
export type BlockerWhere = 'run'|'done'|'pending'|'missing'

export type BlockerRef = {
    feature:string;
    num:number;
    // 'run'     -> a ticket in this run; its live status decides
    // 'done'    -> outside the run, done when loaded
    // 'pending' -> outside the run, not done (dead this session)
    // 'missing' -> no ticket matches (dead, reported)
    where:BlockerWhere;
    status?:string;   // the outside ticket's status, for messages
}

// Same text as ticketKey in orchestrator.ts, which this module
// must not import.
function refId (feature:string, num:number):string {
    return `${feature}:${num}`
}

/**
 * Classifies raw refs. `selected` maps each feature in the run to
 * its ticket numbers; `lookup` returns the status of a ticket in a
 * feature outside the run, or undefined when there is none.
 * De-duplicates by (feature, num) after the own feature is filled
 * in.
 */
export function resolveBlockers (
    raw:ReadonlyArray<RawRef>,
    ownFeature:string,
    selected:ReadonlyMap<string, ReadonlySet<number>>,
    lookup:(feature:string, num:number) => string|undefined
):BlockerRef[] {
    const out:BlockerRef[] = []
    const seen = new Set<string>()
    for (const r of raw) {
        const feature = r.feature ?? ownFeature
        const id = refId(feature, r.num)
        if (seen.has(id)) continue
        seen.add(id)
        const nums = selected.get(feature)
        if (nums) {
            out.push({
                feature,
                num:r.num,
                where:nums.has(r.num) ? 'run' : 'missing',
            })
            continue
        }
        const status = lookup(feature, r.num)
        if (status === undefined) {
            out.push({ feature, num:r.num, where:'missing' })
        } else {
            out.push({
                feature,
                num:r.num,
                where:status === 'done' ? 'done' : 'pending',
                status,
            })
        }
    }
    return out
}

/**
 * Refs for a bare scan, before the run is known: every ref is
 * `run`, so one that matches no ticket in the list is never
 * satisfied.
 */
export function provisionalRefs (
    raw:ReadonlyArray<RawRef>,
    ownFeature:string
):BlockerRef[] {
    const out:BlockerRef[] = []
    const seen = new Set<string>()
    for (const r of raw) {
        const feature = r.feature ?? ownFeature
        const id = refId(feature, r.num)
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ feature, num:r.num, where:'run' })
    }
    return out
}
```

**Testing** (append to `test/blockers.test.ts`, `t.deepEqual` on
the result):
- selected own feature with the number -> `where:'run'`.
- selected feature without the number (own or other) ->
  `where:'missing'` (AC2.4).
- unselected feature, lookup returns `'done'` ->
  `{ where:'done', status:'done' }` (AC2.1).
- unselected feature, lookup returns `'ready-for-agent'` ->
  `{ where:'pending', status:'ready-for-agent' }` (AC2.2).
- unselected feature, lookup returns `undefined` -> `missing`.
- raw `[{ feature:'a', num:1 }, { num:1 }]` with own feature `'a'`
  -> one ref.
- `provisionalRefs([{ num:1 }, { feature:'b', num:2 }], 'a')` ->
  `[{ feature:'a', num:1, where:'run' },
  { feature:'b', num:2, where:'run' }]`.

**Verification:** run the blockers suite (command in Phase 1);
all pass.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Commit

**Commit:** `feat: resolve blocker refs by feature`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-6) -->
<!-- START_TASK_3 -->
### Task 3: `Ticket.blockers` type and `scanTickets`

**Verifies:** none on its own (compile step for Tasks 4-5)

**Files:**
- Modify: `src/orchestrator.ts:100-108` (Ticket), `:188-200`
  (delete `parseBlockers`), `:202-229` (`scanTickets`)
- Modify: `src/index.ts:322-339`

**Implementation:**
1. Add near the other local imports at the top of
   `src/orchestrator.ts`:
   ```ts
   import {
       parseBlockerField,
       provisionalRefs,
       type BlockerRef,
   } from './blockers.js'
   ```
2. `Ticket.blockers:BlockerRef[]`.
3. Delete `parseBlockers` (lines 188-200).
4. `scanTickets(dir:string, feature:string = '',
   knownFeatures:ReadonlySet<string> = new Set())`; replace
   `blockers:parseBlockers(body)` with
   `blockers:provisionalRefs(
       parseBlockerField(body, knownFeatures).refs, feature)`.
   Update the doc comment above `scanTickets` to say refs are
   provisional (`where:'run'`) until `loadSelection` resolves them.
5. `src/index.ts` lines 322-339: the scan there passes no
   `knownFeatures`, so every ref is in the ticket's own feature.
   Keep the block's behavior by comparing `b.num`:
   `t.blockers.filter(b => !knownNums.has(b.num))`, log
   `unknown.map(b => b.num).join(', ')`, and
   `t.blockers = t.blockers.filter(b => knownNums.has(b.num))`.
   (Phase 3 deletes this block.)

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` will
still fail until Task 4 updates the readiness functions; continue
to Task 4 before checking.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: `blockerSatisfied`, `blockerLabel` and the readiness functions

**Verifies:** cross-feature-blockers.AC2.1, AC2.2, AC2.3, AC2.4,
AC2.5, AC2.6, AC2.8 (tests in Task 5)

**Files:**
- Modify: `src/orchestrator.ts` (`findReadyTickets`,
  `findBlockedTickets`, `listTickets`, `simulateWaves`,
  `detectDeadlocks`, `buildHistory`, `renderFinishSummary`,
  `reportBlocked`)

**Implementation:**

1. Export two helpers next to `ticketKey`:

```ts
/**
 * Whether one blocker ref lets its dependent run. `run` refs are
 * decided by the live status of the ticket in this run; refs
 * outside the run were classified at load time.
 */
export function blockerSatisfied (
    ref:BlockerRef,
    doneKeys:ReadonlySet<string>
):boolean {
    switch (ref.where) {
        case 'run': return doneKeys.has(ticketKey(ref.feature, ref.num))
        case 'done': return true
        case 'pending':
        case 'missing': return false
    }
}

/**
 * Display name of a blocker: `<feature>/<NN>`, plus why it is dead
 * when it is outside the run.
 */
export function blockerLabel (ref:BlockerRef):string {
    const nn = String(ref.num).padStart(2, '0')
    const base = ref.feature ? `${ref.feature}/${nn}` : nn
    if (ref.where === 'pending') {
        return `${base} (${ref.status ?? 'not done'}, not in run)`
    }
    if (ref.where === 'missing') return `${base} (not found)`
    return base
}
```
(wrap the `case 'run'` line to stay under 80 columns.)

2. `findReadyTickets`: `t.blockers.every(r =>
   blockerSatisfied(r, doneKeys))`.
3. `simulateWaves` (line 648) and `detectDeadlocks` (line 688):
   same replacement, using each function's existing done-key set.
   Remove the now-unused per-blocker `ticketKey(t.feature, b)`.
4. `findBlockedTickets`: return type
   `Map<string, BlockerRef[]>`. `collectDead(ticket, visited,
   found:Map<string, BlockerRef>)`:
   ```ts
   for (const ref of ticket.blockers) {
       const key = ticketKey(ref.feature, ref.num)
       if (visited.has(key)) continue
       visited.add(key)
       if (ref.where === 'done') continue
       if (ref.where === 'pending' || ref.where === 'missing') {
           found.set(key, ref)
           continue
       }
       const blocker = byKey.get(key)
       if (!blocker || blocker.status === 'done') continue
       if (
           failedKeys.has(key) ||
           blocker.status !== 'ready-for-agent'
       ) {
           found.set(key, ref)
           continue
       }
       collectDead(blocker, visited, found)
   }
   ```
   The outer loop sets `blocked.set(key, [...found.values()])`.
   Rewrite the doc comment: dead means a `pending` or `missing`
   ref, or an in-run ticket that failed or whose status is neither
   done nor ready-for-agent; `done` refs end the walk; an in-run
   ref with no matching ticket (bare scans only) is not dead; the
   walk follows in-run refs across features.
5. `reportBlocked`:
   ```ts
   const labels = dead.map(ref => {
       const t = byKey.get(ticketKey(ref.feature, ref.num))
       return t ? ticketLabel(toRef(t)) : blockerLabel(ref)
   })
   ```
6. `listTickets`: `blocked by [${t.blockers.map(blockerLabel)
   .join(', ')}]`.
7. `buildHistory` line 1679: `blockerKeys:ticket.blockers.map(r =>
   ticketKey(r.feature, r.num))`.
8. `renderFinishSummary` lines 2113-2117: replace `humanNums` with
   `humanKeys = new Set(human.map(t => ticketKey(t.feature,
   t.num)))` and `t.blockers.some(r =>
   humanKeys.has(ticketKey(r.feature, r.num)))`.

**Verification:**
Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: 0 errors.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update orchestrator tests and add AC tests

**Verifies:** cross-feature-blockers.AC2.1, AC2.2, AC2.3, AC2.4,
AC2.5, AC2.6, AC2.8

**Files:**
- Modify: `test/orchestrator.test.ts`
- Modify: `test/integration.test.ts` (row-label test only)

**Fixture migration:**
1. Imports: drop `parseBlockers`; add `blockerSatisfied`,
   `blockerLabel`; add `import type { BlockerRef } from
   '../src/blockers.js'`.
2. `makeTicket`: accept `blockers?:Array<number|BlockerRef>` and
   map numbers to `{ feature:overrides.feature ?? '', num:b,
   where:'run' }`. Type the parameter as
   `Omit<Partial<Ticket>, 'blockers'>&{ num:number;
   filename:string; blockers?:Array<number|BlockerRef> }` and set
   `blockers` after the `...overrides` spread so the mapped array
   wins. Existing fixtures (`blockers:[1]`, the chain builder at
   lines 904-913) then compile unchanged.
3. Replace the two `parseBlockers` tests (lines 182-212) with
   `scanTickets` tests over a temp dir (use the existing `tmp()`
   helper and write files with `writeFileSync`): a
   `01-a.md` with `**Blocked by:** 1, 2, 3` scanned as feature
   `'f'` -> `blockers` deepEqual three `where:'run'` refs in
   feature `'f'`; a ticket with `**Blocked by:** newsletter-audit
   16` scanned with `knownFeatures` `new Set(['newsletter-audit'])`
   -> `[{ feature:'newsletter-audit', num:16, where:'run' }]`; a
   ticket with `None` -> `[]`.
4. The existing `scanTickets` test at lines 247-256 asserts
   `tickets[1].blockers` deepEqual `[1]`. Change the expected value
   to `[{ feature:'', num:1, where:'run' }]` (the test scans with
   no feature). The `[]` assertion for `tickets[0]` is unchanged.
5. `findBlockedTickets` tests (lines 540-934): values are now refs.
   Add a local helper
   `const keysOf = (refs?:BlockerRef[]) =>
   (refs ?? []).map(r => ticketKey(r.feature, r.num))` and wrap
   each `blocked.get(...)` in it; the expected key arrays stay as
   they are. Size and `has` assertions are unchanged.

**New tests** (each builds tickets with `makeTicket` and inline
refs; features `'a'` and `'b'`):
- AC2.1: `a/02` with
  `{ feature:'b', num:1, where:'done', status:'done' }` is in
  `findReadyTickets`.
- AC2.2: `a/02` with
  `{ feature:'b', num:1, where:'pending',
  status:'ready-for-agent' }` is not ready; `findBlockedTickets`
  maps `'a:2'` to that ref; `blockerLabel(ref)` includes `'b/01'`
  and `'ready-for-agent'`.
- AC2.3: `b/01` ready-for-agent, `a/02` with
  `{ feature:'b', num:1, where:'run' }`: `findReadyTickets` returns
  only `b/01`; after setting `b/01` to `done`, it returns `a/02`.
  Then via `dryRun` with the console-capture pattern from line 936:
  `b`'s ticket file appears on the `Wave 1:` line and `a`'s on
  `Wave 2:` (give the two tickets distinct filenames).
- AC2.4: `a/02` with `{ feature:'b', num:9, where:'missing' }` and
  `a/03` with `{ feature:'a', num:9, where:'missing' }`: neither is
  ready; both are keys in `findBlockedTickets`;
  `blockerLabel` includes `'(not found)'`.
- AC2.5: `a/01` (`run` ref to `a/02`), `a/02` (ready-for-agent,
  `pending` ref to `b/05`): `findBlockedTickets` maps `'a:1'` to
  `['b:5']` (via `keysOf`) and `'a:2'` to `['b:5']`.
- AC2.6: `a/02` ready-for-human; `b/02` done; `b/03`
  ready-for-agent, filename `03-waits.md`, ref
  `{ feature:'b', num:2, where:'run' }`. `renderFinishSummary(
  tickets, 0, new Set())` does not include `'03-waits.md'` (the
  blocked-by-human list is the only place it would appear), and
  `findBlockedTickets` has no `'b:3'` key.
- AC2.8: tickets `a/01` (ref `done` outside), `a/02` (ref
  `pending` outside), `a/03` (`run` ref to `a/01`). Capture
  `dryRun(tickets, 'spec', '')` output: `a/01`'s filename is on
  `Wave 1:`, `a/03`'s on `Wave 2:`, `a/02`'s filename is not on any
  `Wave` line and appears on the `Deadlocked tickets:` line; the
  `Tickets:` listing line for `a/02` includes
  `blockerLabel(<its ref>)`. Also assert `findReadyTickets` on the
  initial list returns exactly `a/01`, the same set as wave 1.
- `blockerSatisfied` unit cases: `run` with/without the key in
  `doneKeys`, `done` -> true, `pending`/`missing` -> false.

**Row labels through `setBlocked`** (AC2.2, AC2.4, AC2.5 -- the
`reportBlocked` glue) in `test/integration.test.ts`, next to the
test `'runWavesIsolated - AC4.2 AC4.3: startRun once with the
session set, then setBlocked for human and failed blockers'`
(~line 2302); copy its setup (`initTempGitRepo()`, an `issues`
dir, `commitAll`, `recordingDisplay()` at ~line 2246,
`process.chdir`, `removeWorktreesAndRepo` cleanup) and use
`MOCK_PASS` (line 595) with `retries:0`, `testCmd:'true'`:
- Write five ready-for-agent tickets with `makeTicketBody`:
  `01-ready.md`, `02-pending.md`, `03-missing.md`, `04-chain.md`,
  `05-mid.md`; `tickets = scanTickets(issuesDir)` (feature `''`).
- After the scan, set refs inline:
  `02` -> `[pendingRef]` with `pendingRef = { feature:'other',
  num:7, where:'pending', status:'ready-for-agent' }`;
  `03` -> `[missingRef]` with `missingRef = { feature:'other',
  num:9, where:'missing' }`;
  `04` -> `[{ feature:'', num:5, where:'run' }]`;
  `05` -> `[{ feature:'other', num:8, where:'pending',
  status:'ready-for-human' }]` (`chainRef`).
- Run `runWavesIsolated`. Find the first `setBlocked` call for each
  of 2, 3, 4 (`c.method === 'setBlocked' && c.args[0] === n`) and
  assert `args[2]` deepEqual `[blockerLabel(pendingRef)]`,
  `[blockerLabel(missingRef)]` and `[blockerLabel(chainRef)]`
  (A=04 waits on in-run B=05, which waits on outside C, so 04 is
  labelled with C).
- Import `blockerLabel` from `../src/orchestrator.js` and
  `type BlockerRef` from `../src/blockers.js` in that file.

**Verification:**
Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" |
cut -d'(' -f1 | sort | uniq -c`
Expected: only the baseline (135 `test/display.test.ts`, 8
`test/orchestrator.test.ts`).

Run: `npm run lint`
Expected: no errors.
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Commit

**Commit:** `feat: key blockers by their own feature`
(stage `src/blockers.ts`, `src/orchestrator.ts`, `src/index.ts`,
`test/blockers.test.ts`, `test/orchestrator.test.ts`,
`test/integration.test.ts`)
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
