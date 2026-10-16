# Feature Graph Implementation Plan -- Phase 4

**Goal:** The picker names the features a feature waits on.

**Architecture:** `featureCounts` in `src/resolve.ts` gains
`waitsOn:string[]`, the sorted keys of `upstreamOf` (Phase 2) on the
`loadSelection` call it already makes, so the picker does no extra
reads. `featureChoiceLabel` appends `, waits on a, b` (every name,
never truncated) after the existing counts. R/T keeps meaning "ready
if run alone".

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 4 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### feature-graph.AC1: Picker names upstream features
- **feature-graph.AC1.1 Success:** A feature whose `ready-for-agent`
  ticket has a `pending` ref into feature B has `waitsOn` equal to
  `[B]`, and its label ends `, waits on B)`
- **feature-graph.AC1.2 Success:** Several upstream features are all
  named, sorted, none truncated
- **feature-graph.AC1.3 Edge:** A feature with no `pending`
  cross-feature ref gets exactly today's label
- **feature-graph.AC1.4 Edge:** Refs to done tickets, `missing` refs,
  and refs from done or human tickets do not add to `waitsOn`
- **feature-graph.AC1.5 Edge:** R/T is unchanged (ready if run alone)
- **feature-graph.AC1.6 Edge:** With bad blockers too, the label order
  is `R/T ready, N bad blocker(s), waits on ...`

---

## Codebase facts the executor needs

- `src/resolve.ts` (245 lines):
  - imports at lines 1-17. Add
    `import { upstreamOf } from './graph.js'` after the
    `./display.js` import (line 12). `src/graph.ts` only type-imports
    `./resolve.js`, so this adds no runtime cycle.
  - `FeatureCounts` at lines 148-152:
    ```ts
    export type FeatureCounts = {
        ready:number;
        total:number;
        badBlockers:number;   // refs that match no ticket
    }
    ```
  - `featureCounts` at lines 158-168 calls
    `loadSelection(scratchDir, [name])` and returns the three counts.
  - `featureChoiceLabel` at lines 170-180 builds
    `${name} (${c.ready}/${c.total} ready${bad})`, where `bad` is
    `''` or `, N bad blocker(s)`.
- `test/resolve.test.ts` (359 lines):
  - imports from `'../src/resolve.js'` at lines 7-12 (`featureCounts`
    is there; `featureChoiceLabel` is not).
  - helpers: `makeTempScratch()` (20-30), `addFeature(scratchDir,
    name, tickets)` (32-53), `NA`/`HIR` constants (179-180),
    `ticketBody(status, blockedBy)` (187-189),
    `crossFeatureTree(naStatus)` (200-211): `held-import-review/01`
    (ready-for-agent) blocked by `newsletter-audit 16`, which has
    `naStatus`.
  - **Existing test that must change:** `featureCounts AC1.11`
    (lines 327-343) does
    `t.deepEqual(counts, { ready:1, total:2, badBlockers:0 }, ...)`.
    With the new field it must expect
    `{ ready:1, total:2, badBlockers:0, waitsOn:[] }` (its NA
    blocker is `done`).
  - The last test, `featureCounts AC2.4`, ends at line 359.
- Tests must not pin whole sentences. Comparing the label with a
  string built from the counts (for AC1.3) and checking `endsWith`
  on the suffix the AC names is fine.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `waitsOn` in `featureCounts` and the label

**Verifies:** None (implementation; Task 2 tests it)

**Files:**
- Modify: `src/resolve.ts:1-17` (import), `:148-180`
  (`FeatureCounts`, `featureCounts`, `featureChoiceLabel`)
- Modify: `test/resolve.test.ts:327-343` (update the `deepEqual`
  in `featureCounts AC1.11` to include `waitsOn:[]`)

**Implementation:**

```ts
export type FeatureCounts = {
    ready:number;
    total:number;
    badBlockers:number;   // refs that match no ticket
    waitsOn:string[];     // features with unfinished blockers, sorted
}

/**
 * Counts for one feature as if it ran alone: the same
 * loadSelection a `--spec <name>` run uses. `waitsOn` names the
 * other features its ready-for-agent tickets wait on.
 */
export function featureCounts (
    scratchDir:string,
    name:string
):FeatureCounts {
    const { tickets, warnings } = loadSelection(scratchDir, [name])
    return {
        ready:findReadyTickets(tickets).length,
        total:tickets.length,
        badBlockers:warnings.filter(w => w.kind === 'missing').length,
        waitsOn:[...upstreamOf(tickets).keys()]
            .sort((a, b) => a.localeCompare(b)),
    }
}

export function featureChoiceLabel (
    scratchDir:string,
    name:string
):string {
    const c = featureCounts(scratchDir, name)
    const bad = c.badBlockers === 0 ?
        '' :
        `, ${c.badBlockers} bad blocker` +
            (c.badBlockers === 1 ? '' : 's')
    const waits = c.waitsOn.length === 0 ?
        '' :
        `, waits on ${c.waitsOn.join(', ')}`
    return `${name} (${c.ready}/${c.total} ready${bad}${waits})`
}
```

**Verification:**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit code 0 and no `error TS` lines (the command also
prints a file list; that is normal)

**Commit:** do not commit yet; Task 2 commits with the tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Picker label tests

**Verifies:** feature-graph.AC1.1, feature-graph.AC1.2,
feature-graph.AC1.3, feature-graph.AC1.4, feature-graph.AC1.5,
feature-graph.AC1.6

**Files:**
- Modify: `test/resolve.test.ts` -- add `featureChoiceLabel` to the
  `'../src/resolve.js'` import (lines 7-12); append tests after line
  359

**Testing** (all with `crossFeatureTree`, `addFeature` and
`ticketBody`):

- AC1.1: `crossFeatureTree('ready-for-agent')`. `featureCounts(
  scratchDir, HIR).waitsOn` deep-equals `[NA]`, and
  `featureChoiceLabel(scratchDir, HIR)` ends with
  `` `, waits on ${NA})` ``.
- AC1.2: `crossFeatureTree('ready-for-agent')`, then add features
  `zeta-feat` and `beta-feat`, each with one ready-for-agent ticket
  `01` (`None`), and add `HIR` tickets `02` blocked by `zeta-feat 01`
  and `03` blocked by `beta-feat 01`. `waitsOn` deep-equals
  `['beta-feat', NA, 'zeta-feat']`, and the label contains each of
  the three names.
- AC1.3: `crossFeatureTree('done')`. `waitsOn` is `[]`, and the label
  equals `` `${HIR} (${c.ready}/${c.total} ready)` `` built from
  `featureCounts`.
- AC1.4: one fixture where `HIR` has: `01` blocked by
  `newsletter-audit 16` with NA 16 `done`; `02` blocked by
  `newsletter-audit 40` (missing, no NA 40); `03` with status `done`
  blocked by `other-feat 01`; `04` `ready-for-human` blocked by
  `other-feat 01`; `other-feat/01` ready-for-agent `None`.
  `waitsOn` is `[]`.
- AC1.5: `crossFeatureTree('ready-for-agent')`: `featureCounts`
  `ready` is 0 and equals
  `findReadyTickets(loadSelection(scratchDir, [HIR]).tickets).length`,
  and `total` is 1.
- AC1.6: `crossFeatureTree('ready-for-agent')` plus `HIR/02`
  blocked by `newsletter-audit 40` (missing). In the label, the index
  of `bad blocker` is greater than the index of `ready` and less
  than the index of `waits on`.

**Verification:**

Run: `npx esbuild test/resolve.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/resolve.test.js`
Expected: all tests pass, including the updated `featureCounts
AC1.11`

Run: `npm run build && npm test`
Expected: every suite passes

Run: `npm run lint`
Expected: no errors

**Commit:**

```bash
git add src/resolve.ts test/resolve.test.ts
git commit -m "feat: picker label names the features a feature waits on"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
