# Feature Graph Implementation Plan -- Phase 3

**Goal:** Terminal text for a list of feature reports.

**Architecture:** `renderGraph(reports, warnings)` in `src/graph.ts`
is pure and returns a string: plain text, two-space indents, no
color. Labels come from `blockerLabel` (`src/orchestrator.ts`) and
`ticketLabel` (`src/display.ts`), as in `renderFinishSummary`. The
typo-warning paragraph that `renderFinishSummary` and
`renderNothingReady` already print moves into one exported helper,
`renderTypoWarnings`, so `graph` prints the same text and the wording
cannot drift.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 3 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### feature-graph.AC2: `graph` command output
- **feature-graph.AC2.2 Success:** Each block groups edges by upstream
  feature, with ticket-level refs and their statuses
- **feature-graph.AC2.3 Success:** A transitive hop appears as its own
  `X waits on Y` group in the target's block
- **feature-graph.AC2.9 Edge:** Done refs, edges inside a feature, and
  refs from tickets that are not `ready-for-agent` are not shown
- **feature-graph.AC2.10 Edge:** Order is deterministic (feature, then
  upstream feature, then ticket number)
- **feature-graph.AC2.11 Edge:** Unblocked features are listed on one
  line (or one line says none wait), and typo warnings print once at
  the end

### feature-graph.AC3: Verified suggestion
- **feature-graph.AC3.1 Success:** The rebase.blog reconstruction
  suggests `[held-import-review, newsletter-audit]` with 6 of 6
  runnable, and the remedy says to select both in the picker

(Phase 2 tested AC3.1's features and count; this phase tests that the
rendered block names both features on its "Run together" line.)

---

## Output shape

```
held-import-review (0/6 ready)
  held-import-review waits on newsletter-audit
    held-import-review/01 waits on newsletter-audit/16 (ready-for-agent)
    held-import-review/02 waits on newsletter-audit/15 (ready-for-agent)
    held-import-review/06 waits on newsletter-audit/18 (ready-for-agent)
  Run together: held-import-review, newsletter-audit (select both in the picker)
    6 of 6 ready-for-agent tickets become runnable

Not waiting on other features: analytics, newsletter-audit
```

- One block per report with a non-null `suggestion`, in report order
  (`buildGraph` sorts by feature). Blocks are separated by a blank
  line.
- Groups: one per (`from.feature`, `ref.feature`) pair in
  `suggestion.edges`. Groups whose `from.feature` is the block's
  feature come first, then the rest; within each part, groups sort by
  `from.feature`, then `ref.feature`. Ref lines keep `edges` order
  (`buildGraph` already sorted them by ticket number).
- A ref label is `blockerLabel(ref)`, plus ` (<status>)` for a `run`
  ref that has a `status` (`blockerLabel` already adds the reason for
  `pending` and `missing` refs).
- The hint is `select both in the picker` for two features and
  `select all <n> in the picker` for more. A one-feature suggestion
  (the block exists only for a dead ref into another feature) has no
  "Run together" line.
- The count line names its denominator (`N of M ready-for-agent
  tickets`), since the header's R/T counts all tickets, as the picker
  does.
- On a dead end, after the count line, one line per stuck target
  ticket: `    <ticket> stays blocked: <ref label>, <ref label>`.
  Cycles print as `    deadlocked: a/02, b/03 (in or behind a
  cycle)`; like `renderNothingReady`, the list also holds tickets
  that only wait on a cycle. (The design's wording was `(they wait
  on each other)`; changed because of that.)
- After the blocks: `Not waiting on other features: <names>` on one
  line when any report has a null suggestion. When no report has a
  suggestion, that same line is the whole output (it says none
  wait). An empty `reports` gives `''`.
- Typo warnings last, as the `renderTypoWarnings` lines, after a
  blank line.

---

## Codebase facts the executor needs

- The typo paragraph lives in the private `explainOpen` in
  `src/orchestrator.ts`, lines ~2383-2392:

  ```ts
  const typos = warnings.filter(w => w.kind === 'typo')
  if (typos.length > 0) {
      const n = typos.length
      blockers.push(
          `${n} word${n === 1 ? '' : 's'} in a **Blocked by:** ` +
          `line look${n === 1 ? 's' : ''} like a feature name but ` +
          'match no .scratch/<name>/issues directory:',
          ...typos.map(w => `  ${w.ticket}: ${w.text}`),
      )
  }
  ```

  `explainOpen` feeds `renderFinishSummary` and `renderNothingReady`,
  and existing tests in `test/orchestrator.test.ts` cover that text.
  Use `grep -n "const typos = warnings.filter" src/orchestrator.ts`
  to find it.
- `src/graph.ts` (Phase 2) imports `findReadyTickets`, `simulateRun`,
  `ticketKey` and `type Ticket` from `./orchestrator.js`.
- `blockerLabel(ref)` (`src/orchestrator.ts:270`): `<feature>/<NN>`,
  plus ` (<status>, not in run)` for `pending` and ` (not found)` for
  `missing`. For `run` it adds nothing.
- `test/graph.test.ts` (Phase 2) has `makeScratch`, `addFeature` and
  `rebaseBlog` helpers.
- Tests must not pin exact wording (user rule: no brittle text
  tests). Assert on labels and feature names taken from the input,
  line counts, and relative order (`indexOf`).

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Extract `renderTypoWarnings`

**Verifies:** None (refactor; existing `renderFinishSummary` and
`renderNothingReady` tests prove the text is unchanged)

**Files:**
- Modify: `src/orchestrator.ts` -- add an exported function right
  before `explainOpen` and use it inside `explainOpen`

**Implementation:**

```ts
/**
 * The typo paragraph: words in **Blocked by:** lines that look like
 * a feature name but match no feature dir. `[]` when there are none.
 */
export function renderTypoWarnings (
    warnings:ReadonlyArray<BlockerWarning>
):string[] {
    const typos = warnings.filter(w => w.kind === 'typo')
    if (typos.length === 0) return []
    const n = typos.length
    return [
        `${n} word${n === 1 ? '' : 's'} in a **Blocked by:** ` +
        `line look${n === 1 ? 's' : ''} like a feature name but ` +
        'match no .scratch/<name>/issues directory:',
        ...typos.map(w => `  ${w.ticket}: ${w.text}`),
    ]
}
```

In `explainOpen`, replace the `const typos = ...` block with
`blockers.push(...renderTypoWarnings(warnings))`.

**Verification:**

Run: `npx esbuild test/orchestrator.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/orchestrator.test.js`
Expected: all tests pass, unchanged

**Commit:**

```bash
git add src/orchestrator.ts
git commit -m "refactor: share the typo warning paragraph"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `renderGraph`

**Verifies:** None (implementation; Task 3 tests it)

**Files:**
- Modify: `src/graph.ts` -- add `blockerLabel` and
  `renderTypoWarnings` to the `./orchestrator.js` import; append
  `renderGraph` and its helpers at the end of the file

**Implementation:**

```ts
function idLabel (id:TicketId):string {
    return ticketLabel({ ...id, filename:'' })
}

function refLabel (ref:BlockerRef):string {
    return ref.where === 'run' && ref.status ?
        `${blockerLabel(ref)} (${ref.status})` :
        blockerLabel(ref)
}

function renderBlock (report:FeatureReport, s:Suggestion):string[] {
    const { feature } = report
    const lines = [`${feature} (${report.ready}/${report.total} ready)`]

    const groups = new Map<string, UpstreamRef[]>()
    for (const e of s.edges) {
        const key = `${e.from.feature}\n${e.ref.feature}`
        groups.set(key, [...(groups.get(key) ?? []), e])
    }
    const keys = [...groups.keys()].sort((a, b) => {
        const [fa, ua] = a.split('\n')
        const [fb, ub] = b.split('\n')
        return Number(fa !== feature) - Number(fb !== feature) ||
            fa.localeCompare(fb) || ua.localeCompare(ub)
    })
    for (const key of keys) {
        const [from, upstream] = key.split('\n')
        lines.push(`  ${from} waits on ${upstream}`)
        for (const e of groups.get(key)!) {
            lines.push(
                `    ${idLabel(e.from)} waits on ${refLabel(e.ref)}`
            )
        }
    }

    // One feature: only dead refs into other features, so there
    // is nothing to select together.
    const n = s.features.length
    if (n > 1) {
        const hint = n === 2 ?
            'select both in the picker' :
            `select all ${n} in the picker`
        lines.push(`  Run together: ${s.features.join(', ')} (${hint})`)
    }
    // Under "Run together" when there is one, else at group level
    const pad = n > 1 ? '    ' : '  '
    lines.push(
        `${pad}${s.runnable} of ${s.total} ready-for-agent tickets ` +
        'become runnable'
    )

    const stuck = new Map<string, string[]>()
    for (const d of s.deadEnds) {
        const label = idLabel(d.from)
        stuck.set(label, [...(stuck.get(label) ?? []), refLabel(d.ref)])
    }
    for (const [label, refs] of stuck) {
        lines.push(`    ${label} stays blocked: ${refs.join(', ')}`)
    }
    if (s.cycles.length > 0) {
        lines.push(
            `    deadlocked: ${s.cycles.join(', ')} ` +
            '(in or behind a cycle)'
        )
    }
    return lines
}

/**
 * The `graph` command's text: one block per feature that waits on
 * another, one line naming the features that do not, then the typo
 * warnings. Plain text, no color.
 */
export function renderGraph (
    reports:ReadonlyArray<FeatureReport>,
    warnings:ReadonlyArray<BlockerWarning>
):string {
    const blocks:string[][] = []
    const free:string[] = []
    for (const r of reports) {
        if (r.suggestion) blocks.push(renderBlock(r, r.suggestion))
        else free.push(r.feature)
    }
    if (free.length > 0) {
        blocks.push([`Not waiting on other features: ${free.join(', ')}`])
    }
    const typos = renderTypoWarnings(warnings)
    if (typos.length > 0) blocks.push(typos)
    return blocks.map(b => b.join('\n')).join('\n\n')
}
```

Keep lines under 80 columns. Wrap any that end up longer after
indentation. `groups.get(key)!` is safe because `key` came from
`groups.keys()`.

**Verification:**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit code 0 and no `error TS` lines (the command also
prints a file list; that is normal)

**Commit:** do not commit yet; Task 3 commits with the tests.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `renderGraph` tests

**Verifies:** feature-graph.AC2.2, feature-graph.AC2.3,
feature-graph.AC2.9, feature-graph.AC2.10, feature-graph.AC2.11,
feature-graph.AC3.1 (the "Run together" line)

**Files:**
- Modify: `test/graph.test.ts` -- add a `// -- renderGraph --`
  section after the Phase 2 tests

**Testing:** each test builds fixtures with the Phase 2 helpers, runs
`buildGraph(load, names)`, and checks `renderGraph(reports,
warnings)`. Split the output on `'\n'` and assert on structure, never
on whole sentences:

- AC2.2 and AC3.1: `rebaseBlog`, all three features. Some line
  contains both `held-import-review/01` and `newsletter-audit/16` and
  the status `ready-for-agent`; the same holds for `02`/`15` and
  `06`/`18`. The line right before the `held-import-review/01` ref
  line (the group header) contains both feature names and no `/`.
  Some later line contains both feature names and the word `picker`
  (the "Run together" line).
- AC2.3: `alpha` blocked by `beta 01`, `beta/01` blocked by
  `gamma 01`, `gamma/01` `None`. Inside `alpha`'s block (from the line
  that starts with `alpha (` to the next blank line), one line
  contains both `beta/01` and `gamma/01`, and it comes after the line
  that contains both `alpha/01` and `beta/01`.
- AC2.9: `alpha/01` blocked by `02, beta 01`; `alpha/02` `None`;
  `alpha/03` `ready-for-human`, blocked by `gamma 01`; `alpha/04`
  blocked by `delta 01`; `beta/01` `None`; `gamma/01` `None`;
  `delta/01` `done`. The output contains `beta/01`, but no line
  contains `gamma/01` or `delta/01`, and no line contains both
  `alpha/01` and `alpha/02`.
- AC2.10: two blocked features given out of order
  (`buildGraph(load, ['zeta', 'alpha', ...])`), each waiting on two
  upstream features via tickets numbered out of order (e.g.
  `alpha/03` waits on `beta 02`, `alpha/01` waits on `beta 05`,
  `alpha/02` waits on `gamma 01`). Assert by `indexOf`: the `alpha`
  block comes before `zeta`; `beta` group before `gamma` group;
  `alpha/01`'s line before `alpha/03`'s. Rendering twice gives the
  same string.
- AC2.11 (list): with `rebaseBlog`, exactly one line contains
  `analytics`, and that line also contains `newsletter-audit`.
  With only unblocked features (`alpha/01` `None`, `beta/01`
  `None`), the output is a single line that contains both names.
- AC2.11 (typos): `rebaseBlog` plus `analytics/02` ready-for-agent,
  blocked by `newsleter-audit 15` (a misspelt feature, so a typo
  warning; it gives `analytics` no cross-feature edge). The misspelt
  word appears exactly once in the output, and on its last line.
- AC3.4 rendering: `alpha/01` blocked by `beta 04`, `beta/04`
  `ready-for-human`. Some line contains `alpha/01`, `beta/04` and
  `ready-for-human` and comes after the line with `0 of 1`.
- AC3.6 rendering: the alpha/beta cycle fixture gives a line that
  contains both `alpha/01` and `beta/01` after the count line.
- AC3.5 rendering (missing ref only): `alpha/01` blocked by
  `beta 40`, `beta/01` `None`, `buildGraph(load, ['alpha',
  'beta'])`. Some line contains both `alpha/01` and `beta/40`; the
  line that contains `beta` but no `/` (the not-waiting line) does
  not contain `alpha`; and no line contains `picker` (one feature, so
  no "Run together" line).

**Verification:**

Run: `npx esbuild test/graph.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/graph.test.js`
Expected: all tests pass

Run: `npm run build && npm test`
Expected: every suite passes

Run: `npm run lint`
Expected: no errors

**Commit:**

```bash
git add src/graph.ts test/graph.test.ts
git commit -m "feat: render the feature graph report"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
