# Feature Graph Implementation Plan -- Phase 2

**Goal:** Cross-feature edges, the ticket-level closure and the
verified suggestion, in a new pure module `src/graph.ts`.

**Architecture:** `src/graph.ts` imports values from
`src/orchestrator.ts` and `src/display.ts` only, and types from
`src/blockers.ts` and `src/resolve.ts`. The loader is injected as a
`LoadFn` (the CLI passes `names => loadSelection(scratchDir, names)`)
because `src/resolve.ts` will import `upstreamOf` from this module in
Phase 4; a value import of `loadSelection` here would make a cycle.
`suggestSelection` grows the selection from the target feature, one
round per new upstream feature, then checks the final selection once
with `simulateRun` (Phase 1).

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 2 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### feature-graph.AC3: Verified suggestion
- **feature-graph.AC3.1 Success:** The rebase.blog reconstruction
  suggests `[held-import-review, newsletter-audit]` with 6 of 6
  runnable, and the remedy says to select both in the picker
- **feature-graph.AC3.2 Success:** If A needs B and B needs C, the
  suggestion is `[A, B, C]`
- **feature-graph.AC3.3 Success:** An upstream ticket the target does
  not need, waiting on a third feature, does not widen the suggestion
- **feature-graph.AC3.4 Failure:** A needed upstream ticket that is
  `ready-for-human` gives `runnable < total`, and that ref is named as
  the dead end
- **feature-graph.AC3.5 Failure:** A `missing` ref never grows the
  selection and is named as a dead end
- **feature-graph.AC3.6 Edge:** Tickets that wait on each other across
  features are reported as deadlocked, and the closure terminates

(AC3.1's "remedy says to select both in the picker" is rendered text;
Phase 3 tests that part. This phase tests the suggested features and
the 6 of 6 count.)

### feature-graph.AC4: Cross-cutting
- **feature-graph.AC4.1:** `npm run build` emits `dist/graph.js`, and
  `test/graph.test.ts` runs under `npm test`

---

## Divergences from the design (decided during planning)

- `Suggestion.edges` holds the refs as they are in the *final*
  selection. After the closure every needed upstream feature is
  selected, so those refs are `where:'run'`, not `'pending'`. Each
  `run` ref in `edges` and `deadEnds` is a copy with `status` set to
  the blocking ticket's status, so the renderer can print
  `newsletter-audit/16 (ready-for-agent)` without a ticket lookup.
- `Suggestion.deadEnds` is `UpstreamRef[]` (stuck target ticket plus
  the dead ref), not `BlockerRef[]`, so Phase 3 can print one
  `<ticket> stays blocked: <refs>` line per stuck ticket.
- `cycles` is limited to tickets the target needs (reached from its
  ready-for-agent tickets), so a cycle inside an upstream feature
  that the target does not depend on is not reported in its block.
  Like `renderNothingReady`, it also holds needed tickets that only
  wait behind a cycle; Phase 3 words the line accordingly.
- `FeatureReport.suggestion` is non-null when the feature has a
  cross-feature edge *or* a dead ref into another feature (e.g.
  `beta 40` where beta has no ticket 40). Otherwise such a feature
  would land on the "not waiting" line and its dead end would never
  be named (design DoD 3, AC3.5).
- `buildGraph` caches loads by name list, so no selection is read
  twice (each feature's own load is also the first closure round).
  Nothing in this module mutates loaded tickets, so sharing cached
  results is safe.

---

## Codebase facts the executor needs

- `src/resolve.ts`:
  - `export type LoadedSelection = { tickets:Ticket[];
    warnings:BlockerWarning[] }` (line 65).
  - `loadSelection(scratchDir, names:ReadonlyArray<string>)` (line
    96). A selected name whose `issues` dir is missing contributes no
    tickets; it never throws for that. Refs into a selected feature
    become `run` (number exists) or `missing`; refs into an unselected
    known feature become `done` or `pending` (with `status`), or
    `missing` when the number does not exist there.
  - `resolve.ts` imports values from `./orchestrator.js` and
    `./display.js`. Neither of those imports `resolve.ts`, so
    `resolve -> graph -> orchestrator` adds no cycle.
- `src/orchestrator.ts` exports `Ticket` (type), `ticketKey`,
  `blockerLabel`, `findReadyTickets`, and (Phase 1) `simulateRun`.
- `src/display.ts:131` `ticketLabel(ticket:{ num; filename;
  feature? })` returns `<feature>/<NN>`; a full `Ticket` can be passed.
- `src/blockers.ts:155-170`: `BlockerWhere`, `BlockerRef`
  (`{ feature, num, where, status? }`), and `BlockerWarning`
  (`{ ticket, kind:'missing'|'typo', text }`).
- `package.json:20` `build-esm`: the second esbuild call lists
  `src/orchestrator.ts ... src/blockers.ts src/stats.ts` before
  `--format=esm`. Add `src/graph.ts` after `src/stats.ts`.
- `scripts/test.sh:13-31` `TESTS=(` list, one name per line, 4-space
  indent, ends with `review-integration`. Add `graph` after
  `resolve`.
- Test fixture idiom (see `test/resolve.test.ts:20-53`): a
  `mkdtempSync(join(tmpdir(), '...'))` dir with
  `.scratch/<feature>/issues/NN-*.md` and a `spec.md`. Ticket bodies
  look like `# T\n\n**Status:** <status>\n**Blocked by:** <text>\n`.
  `test/resolve.test.ts:183-185` has the verbatim rebase.blog field
  text for held-import-review 01 (`HIR_01_BLOCKED_BY`).
- tapzero `deepEqual` is fast-deep-equal: it does not compare `Map`
  contents. Compare arrays, or spread maps first.
- Style: types with `type` and semicolons as in `src/resolve.ts`,
  `name:type` with no space, lines under 80 columns, the repo's
  ternary style, no em dashes or arrow characters in comments, no
  `// pattern:` comments.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: `src/graph.ts` core and build wiring

**Verifies:** None (implementation; Task 2 tests it)

**Files:**
- Create: `src/graph.ts`
- Modify: `package.json:20` -- add ` src/graph.ts` after
  `src/stats.ts` in the second esbuild call of `build-esm`

**Implementation:** create `src/graph.ts` with this content:

```ts
import {
    findReadyTickets,
    simulateRun,
    ticketKey,
    type Ticket,
} from './orchestrator.js'
import { ticketLabel } from './display.js'
import type { BlockerRef, BlockerWarning } from './blockers.js'
import type { LoadedSelection } from './resolve.js'

export type TicketId = {
    feature:string;
    num:number;
}

/**
 * One blocker ref of an open ticket, with the ticket it is on. A
 * `run` ref carries the blocking ticket's status in `ref.status`.
 */
export type UpstreamRef = {
    from:TicketId;
    ref:BlockerRef;
}

export type Suggestion = {
    features:string[];      // target first, then upstream, sorted
    edges:UpstreamRef[];    // every needed cross-feature ref
    runnable:number;        // target tickets that run in some wave
    total:number;           // target ready-for-agent tickets
    deadEnds:UpstreamRef[]; // why the rest never run
    cycles:string[];        // labels of needed tickets in a cycle
}

export type FeatureReport = {
    feature:string;
    ready:number;           // ready if run alone, as the picker
    total:number;           // all tickets, as the picker
    // null: no cross-feature edge and no dead ref into another
    // feature
    suggestion:Suggestion|null;
}

export type LoadFn = (names:string[]) => LoadedSelection

function idOf (t:Ticket):TicketId {
    return { feature:t.feature, num:t.num }
}

function byFeatureThenNum (a:UpstreamRef, b:UpstreamRef):number {
    return a.from.feature.localeCompare(b.from.feature) ||
        a.ref.feature.localeCompare(b.ref.feature) ||
        a.from.num - b.from.num ||
        a.ref.num - b.ref.num
}

/**
 * The `pending` refs of ready-for-agent tickets, grouped by the
 * feature they point into. Direct edges only; the picker label
 * uses the keys.
 */
export function upstreamOf (
    tickets:ReadonlyArray<Ticket>
):Map<string, UpstreamRef[]> {
    const groups = new Map<string, UpstreamRef[]>()
    for (const t of tickets) {
        if (t.status !== 'ready-for-agent') continue
        for (const ref of t.blockers) {
            if (ref.where !== 'pending') continue
            const list = groups.get(ref.feature) ?? []
            list.push({ from:idOf(t), ref })
            groups.set(ref.feature, list)
        }
    }
    return groups
}

/**
 * Every unsatisfied ref reached from the target's ready-for-agent
 * tickets, following in-run refs into ready-for-agent tickets only
 * (each ticket once, so cycles end). Done refs and done tickets are
 * skipped; a ticket in any other status is reached but not walked
 * past. `needed` is the keys of the tickets walked, the target's
 * own included.
 */
function walkNeeded (
    tickets:ReadonlyArray<Ticket>,
    target:string
):{ reached:UpstreamRef[]; needed:Set<string> } {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    const stack = tickets.filter(t => (
        t.feature === target && t.status === 'ready-for-agent'
    ))
    const needed = new Set(stack.map(t => ticketKey(t.feature, t.num)))
    const reached:UpstreamRef[] = []
    while (stack.length > 0) {
        const t = stack.pop()!
        for (const ref of t.blockers) {
            if (ref.where === 'done') continue
            if (ref.where !== 'run') {
                reached.push({ from:idOf(t), ref })
                continue
            }
            const key = ticketKey(ref.feature, ref.num)
            const blocker = byKey.get(key)
            if (!blocker || blocker.status === 'done') continue
            reached.push({
                from:idOf(t),
                ref:{ ...ref, status:blocker.status },
            })
            if (blocker.status !== 'ready-for-agent') continue
            if (needed.has(key)) continue
            needed.add(key)
            stack.push(blocker)
        }
    }
    return { reached, needed }
}

/**
 * The `pending` refs the target needs, directly or through in-run
 * tickets. A `missing` ref is a dead end and is not returned.
 */
export function neededPending (
    tickets:ReadonlyArray<Ticket>,
    target:string
):UpstreamRef[] {
    return walkNeeded(tickets, target).reached
        .filter(r => r.ref.where === 'pending')
        .sort(byFeatureThenNum)
}

/**
 * The features to run together so the target's tickets can run:
 * start from the target, add the features behind `neededPending`,
 * reload, and repeat until the selection stops growing. Then check
 * the final selection with `simulateRun`.
 */
export function suggestSelection (
    load:LoadFn,
    target:string
):Suggestion {
    let features = [target]
    let { tickets } = load(features)
    while (true) {
        const more = neededPending(tickets, target)
            .map(r => r.ref.feature)
            .filter(f => !features.includes(f))
        if (more.length === 0) break
        // A pending ref always points outside the selection, so
        // each round adds at least one feature and the loop ends.
        features = [...features, ...new Set(more)]
        tickets = load(features).tickets
    }

    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    const withStatus = (ref:BlockerRef):BlockerRef => {
        const b = ref.where === 'run' ?
            byKey.get(ticketKey(ref.feature, ref.num)) :
            undefined
        return b ? { ...ref, status:b.status } : ref
    }

    const { reached, needed } = walkNeeded(tickets, target)
    const sim = simulateRun(tickets)
    const inWave = new Set(
        sim.waves.flat().map(t => ticketKey(t.feature, t.num))
    )
    const own = tickets
        .filter(t => (
            t.feature === target && t.status === 'ready-for-agent'
        ))
        .sort((a, b) => a.num - b.num)

    return {
        features:[
            target,
            ...features
                .filter(f => f !== target)
                .sort((a, b) => a.localeCompare(b)),
        ],
        edges:reached
            .filter(r => (
                r.ref.where !== 'missing' &&
                r.ref.feature !== r.from.feature
            ))
            .sort(byFeatureThenNum),
        runnable:own.filter(t => (
            inWave.has(ticketKey(t.feature, t.num))
        )).length,
        total:own.length,
        deadEnds:own.flatMap(t => (
            sim.deadRefs.get(ticketKey(t.feature, t.num)) ?? []
        ).map(ref => ({ from:idOf(t), ref:withStatus(ref) }))),
        cycles:sim.neverRun
            .filter(t => {
                const key = ticketKey(t.feature, t.num)
                return needed.has(key) && !sim.deadRefs.has(key)
            })
            .sort((a, b) => (
                a.feature.localeCompare(b.feature) || a.num - b.num
            ))
            .map(t => ticketLabel(t)),
    }
}

// Whether a feature belongs in the report: it waits on another
// feature, or one of its tickets has a dead ref into another
// feature (a ref that matches no ticket there, say).
function crossesFeatures (s:Suggestion):boolean {
    return s.edges.length > 0 || s.deadEnds.some(d => (
        d.ref.feature !== d.from.feature
    ))
}

/**
 * One report per feature, sorted by name: its picker counts and,
 * when it waits on or has a dead ref into another feature, the
 * verified suggestion. Typo warnings come from each feature's own
 * load, so each is listed once. Loads are cached by name list, so
 * no selection is read twice in one call.
 */
export function buildGraph (
    load:LoadFn,
    features:ReadonlyArray<string>
):{ reports:FeatureReport[]; warnings:BlockerWarning[] } {
    const cache = new Map<string, LoadedSelection>()
    const cached:LoadFn = names => {
        const key = names.join('\n')
        const hit = cache.get(key) ?? load(names)
        cache.set(key, hit)
        return hit
    }
    const reports:FeatureReport[] = []
    const warnings:BlockerWarning[] = []
    const sorted = [...new Set(features)]
        .sort((a, b) => a.localeCompare(b))
    for (const feature of sorted) {
        const alone = cached([feature])
        warnings.push(...alone.warnings.filter(w => w.kind === 'typo'))
        const suggestion = suggestSelection(cached, feature)
        reports.push({
            feature,
            ready:findReadyTickets(alone.tickets).length,
            total:alone.tickets.length,
            suggestion:crossesFeatures(suggestion) ? suggestion : null,
        })
    }
    return { reports, warnings }
}
```

Notes for the executor:
- Keep every line under 80 columns; rewrap if your editor's indent
  differs.
- `stack.pop()!` is safe: the loop condition checks the length.
- `upstreamOf` is unused until Phase 4. It is exported now because it
  shares types with this module.

Then add `src/graph.ts` to `build-esm` in `package.json:20`.

**Verification:**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit code 0 and no `error TS` lines (the command also
prints a file list; that is normal)

Run: `npm run build && ls dist/graph.js`
Expected: build succeeds and `dist/graph.js` is listed

**Commit:** do not commit yet; Task 3 commits with the tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `test/graph.test.ts` fixtures and suggestion tests

**Verifies:** feature-graph.AC3.1 (features and count),
feature-graph.AC3.2, feature-graph.AC3.3, feature-graph.AC3.4,
feature-graph.AC3.5, feature-graph.AC3.6

**Files:**
- Create: `test/graph.test.ts` (unit, with real tmp `.scratch` dirs)

**Implementation (test helpers):**

- `import { test } from '@substrate-system/tapzero'`, `mkdtempSync`,
  `mkdirSync`, `writeFileSync`, `rmSync` from `node:fs`, `join` from
  `node:path`, `tmpdir` from `node:os`, `loadSelection` from
  `'../src/resolve.js'`, and the graph exports from
  `'../src/graph.js'`.
- `makeScratch():{ root:string; scratchDir:string; load:LoadFn }`:
  `mkdtempSync(join(tmpdir(), 'nightralph-graph-'))`, creates
  `.scratch`, and returns `load = names => loadSelection(scratchDir,
  names)`.
- `addFeature(scratchDir, name, tickets:Array<[num:number,
  status:string, blockedBy:string]>)`: writes `<name>/spec.md` and
  one `<name>/issues/<NN>-t.md` per tuple (`NN` zero-padded to 2)
  with body `# T\n\n**Status:** ${status}\n**Blocked by:**
  ${blockedBy}\n`. `name` may contain `/`; `mkdirSync` with
  `recursive:true`.
- Each test removes `root` in a `finally` with
  `rmSync(root, { recursive:true, force:true })`.
- `rebaseBlog(scratchDir)`: the reduced rebase.blog reconstruction,
  shared with Phase 3:
  - `newsletter-audit`: `15` ready-for-agent `None`; `16`
    ready-for-agent `15`; `18` ready-for-agent `15, 16`
  - `held-import-review`: `01` ready-for-agent with the verbatim
    multi-line text from `test/resolve.test.ts:183-185`
    (`HIR_01_BLOCKED_BY`, which names `newsletter-audit 16` and has a
    parenthetical path and prose); `02` `newsletter-audit 15`;
    `03` `01`; `04` `02`; `05` `03, 04`; `06` `newsletter-audit 18`
    (all ready-for-agent)
  - `analytics`: `01` ready-for-agent `None` (an unblocked feature)

**Testing:** each test builds a fixture, calls
`suggestSelection(load, target)` (or `buildGraph`), and asserts on
the returned data. Use short, distinct feature names (`alpha`,
`beta`, `gamma`) except in the rebase.blog test.

- AC3.1: `rebaseBlog`; `suggestSelection(load,
  'held-import-review')` has `features` deep-equal
  `['held-import-review', 'newsletter-audit']`, `runnable` 6,
  `total` 6, `deadEnds` `[]`, `cycles` `[]`, and `edges` mapped to
  `[from.num, ref.feature, ref.num]` deep-equal
  `[[1, 'newsletter-audit', 16], [2, 'newsletter-audit', 15],
  [6, 'newsletter-audit', 18]]`. Also `buildGraph(load,
  ['analytics', 'held-import-review', 'newsletter-audit'])` gives a
  `held-import-review` report with `ready` 0, `total` 6 and a
  non-null suggestion, and null suggestions for the other two.
- AC3.2: `alpha/01` blocked by `beta 01`; `beta/01` blocked by
  `gamma 01`; `gamma/01` `None`. `features` is
  `['alpha', 'beta', 'gamma']`, `runnable` 1 of 1, and `edges`
  includes a ref from `beta` to `gamma` (the transitive hop).
- AC3.3: `alpha/01` blocked by `beta 01`; `beta/01` `None`;
  `beta/02` blocked by `gamma 01`; `gamma/01` `None`. `features` is
  `['alpha', 'beta']` (gamma is not added) and no edge has
  `from.feature` `beta`.
- AC3.4: `alpha/01` blocked by `beta 04`; `beta/04`
  `ready-for-human` `None`. `features` is `['alpha', 'beta']`,
  `runnable` 0, `total` 1, and `deadEnds` deep-equals
  `[{ from:{ feature:'alpha', num:1 }, ref:{ feature:'beta', num:4,
  where:'run', status:'ready-for-human' } }]`.
- AC3.5: `alpha/01` blocked by `beta 01`; `alpha/02` blocked by
  `beta 40`; `beta/01` `None` (no `beta/40` exists). `features` is
  `['alpha', 'beta']`, `runnable` 1, `total` 2, and `deadEnds` has an
  entry from `alpha` 2 with `ref.where` `'missing'` and `ref.num` 40.
  A second case: `alpha/01` blocked only by `beta 40` with `beta/01`
  present gives `features` `['alpha']` (a missing ref never grows the
  selection), `edges` `[]` and a `missing` dead end; and
  `buildGraph(load, ['alpha', 'beta'])` gives `alpha` a non-null
  suggestion (so the dead end is reported) and `beta` a null one.
- AC3.6: `alpha/01` blocked by `beta 01`; `beta/01` blocked by
  `alpha 01`. The call returns (the closure terminates), `features`
  is `['alpha', 'beta']`, `runnable` 0, `deadEnds` `[]`, and `cycles`
  deep-equal `['alpha/01', 'beta/01']`.

**Verification:**

Run: `npx esbuild test/graph.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/graph.test.js`
Expected: all tests pass

**Commit:** do not commit yet; Task 3 commits.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Register the suite and run everything

**Verifies:** feature-graph.AC4.1

**Files:**
- Modify: `scripts/test.sh:13-31` -- add a line `    graph` after
  `    resolve` in `TESTS=(`

**Verification:**

Run: `npm run build && npm test`
Expected: build succeeds, `dist/graph.js` exists, every suite passes,
and the output includes the `graph` suite's tests

Run: `npm run lint`
Expected: no errors

**Commit:**

```bash
git add src/graph.ts test/graph.test.ts package.json scripts/test.sh
git commit -m "feat: add graph module with verified feature suggestions"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
