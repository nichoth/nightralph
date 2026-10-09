# Cross-Feature Blockers Implementation Plan -- Phase 3

**Goal:** The picker and the run get tickets, resolved refs and
warnings from the same function, `loadSelection`.

**Architecture:** `loadSelection(scratchDir, names)` in
`src/resolve.ts` lists `<scratchDir>/*/issues` for
`knownFeatures`, scans each selected feature, scans an unselected
feature only when a ref points into it (once, cached), resolves
every ticket's refs with `resolveBlockers`, and returns the
selected tickets plus warnings. `loadTickets` in `src/index.ts`
calls it instead of scanning per feature and drops the
unknown-blocker filter. The picker label comes from
`featureCounts`, which also calls `loadSelection`.

**Tech Stack:** TypeScript (ESM), `@inquirer/prompts`,
`@substrate-system/tapzero`

**Scope:** Phase 3 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements and tests (through `loadSelection` and the
picker counts):

### cross-feature-blockers.AC1: Parsing and one loading path
- **cross-feature-blockers.AC1.1 Success:** `newsletter-audit 16`
  yields `{ feature:'newsletter-audit', num:16 }` when
  `.scratch/newsletter-audit/issues` exists
- **cross-feature-blockers.AC1.11 Success:** the picker's ready
  count for a feature equals the ready count of a run that selects
  only that feature (both come from `loadSelection`)

### cross-feature-blockers.AC2: Readiness and reporting
- **cross-feature-blockers.AC2.1 Success:** a ticket whose blocker
  is in an unselected feature and done is ready
- **cross-feature-blockers.AC2.2 Failure:** a ticket whose blocker
  is in an unselected feature and not done is not ready; its row
  label names `<feature>/<NN>` and the blocker's status
- **cross-feature-blockers.AC2.4 Failure:** a ref that matches no
  ticket (same or other feature) leaves the ticket not ready; the
  row label says not found, the picker label counts a bad blocker,
  and the finish summary lists it
  (this phase: through `loadSelection` and the picker count; the
  finish summary is Phase 4)

---

## Divergences from the design (and why)

- `BlockerWarning` is defined in `src/blockers.ts` and re-exported
  from `src/resolve.ts`. Phase 4 needs the type in
  `src/orchestrator.ts`, and `resolve.ts` already imports
  `orchestrator.ts`; defining it in the pure module avoids an
  import cycle.
- The picker label is built by two new exports,
  `featureCounts(scratchDir, name)` and
  `featureChoiceLabel(scratchDir, name)`, because the `checkbox`
  prompt in `resolveIssuesDir` is called inline with no seam.
  Tests check the counts, not the label text.

---

## Codebase facts the executor needs

`src/resolve.ts` (118 lines):
- Imports lines 1-6: `existsSync, readdirSync` from `node:fs`;
  `dirname, join` from `node:path`; `fileURLToPath`; `checkbox,
  Separator` from `@inquirer/prompts`; `isSpecComplete` from
  `./progress.js`; `scanTickets, findReadyTickets` from
  `./orchestrator.js`.
- `findFeatureDirs(cwd)` line 18 lists `<cwd>/.scratch/*` with an
  `issues` dir, skipping completed specs.
- `resolveIssuesDir(specName, cwd = process.cwd())` line 54. With
  several features it builds each choice name as
  `` `${f.name} (${ready}/${tickets.length} ready)` `` from
  `scanTickets(f.dir)` (no feature argument) and
  `findReadyTickets`. Replace exactly that computation.

`src/index.ts`:
- Imports from `./resolve.js` at lines 29-34
  (`findFeatureDirs, resolveIssuesDir, getScriptDir,
  type FeatureSelection`).
- `LoadedTickets` type ~lines 259-273: `allTickets, specBodies,
  progressPaths, issuesDirs, firstFeatureName, firstLogsDir,
  missing`.
- `loadTickets(selections, log)` lines 275-363. Per selection:
  `Directory not found: ${dir}` / `Spec file not found: ${spec}`
  into `missing` and `continue`; read the spec with
  `stripSpecSection(readFileSync(spec, 'utf8'), 'User Stories')`;
  `scanTickets(dir, name)`; zero tickets logs
  `No ticket files found for <name>. Skipping.`; else logs
  `[<name>] Found N tickets`; lines 322-339 are the unknown-blocker
  filter (modified in Phase 2, deleted now); then fills
  `specBodies`, `progressPaths` (`join(dirname(dir),
  'progress.md')`), `issuesDirs`, `allTickets`, and the
  first-feature `firstFeatureName` / `firstLogsDir`.
- A selection's `dir` is `<cwd>/.scratch/<name>/issues`, where
  `<cwd>` is `process.cwd()` (`resolveIssuesDir`'s default) and
  `<name>` may contain `/` for a nested `--spec`.
- `scanTickets` is imported from `./orchestrator.js` (lines 10-25);
  after this phase `index.ts` may no longer need it -- remove the
  import if unused (lint will say).

Tests:
- `test/resolve.test.ts` (171 lines): `makeTempScratch()` line 16
  returns `{ cwd, scratchDir }`; `addFeature(scratchDir, name,
  tickets = [])` line 28 writes `<name>/spec.md` and each
  `{ filename, body }` into `<name>/issues/`. Imports
  `findFeatureDirs, resolveIssuesDir` and `scanTickets,
  findReadyTickets`.
- `test/integration.test.ts` line 437, `'CLI subprocess - unknown
  blocker warning and stripping'`: writes `01-task.md` with
  `blockers:[99]`, runs `spawnCli([MOCK_AGENT, '--spec', FEAT,
  '--timeout', '10'])` and asserts output mentions `99` and
  `not found`, exit 0, ticket becomes `**Status:** done`, and
  `logsDir/01-task.log` exists. Under the new rules the ref to 99
  is `missing`, so the ticket must not run.

Type-check baseline as in Phase 1 and 2.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: `BlockerWarning` and `loadSelection`

**Verifies:** cross-feature-blockers.AC1.1, AC2.1, AC2.2, AC2.4
(tests in Task 3)

**Files:**
- Modify: `src/blockers.ts` (append the type)
- Modify: `src/resolve.ts`

**Implementation:**

Append to `src/blockers.ts`:
```ts
export type BlockerWarning = {
    ticket:string;    // ticketLabel of the ticket with the problem
    kind:'missing'|'typo';
    text:string;      // the ref label or the unknown word
}
```

In `src/resolve.ts`:
- Imports: add `blockerLabel, type Ticket` to the
  `./orchestrator.js` import; add
  `import { ticketLabel } from './display.js'`; add
  `import { parseBlockerField, resolveBlockers, type
  BlockerWarning } from './blockers.js'`; add
  `export type { BlockerWarning }`.
- Add:

```ts
export type LoadedSelection = {
    tickets:Ticket[];
    warnings:BlockerWarning[];
}

// Names of the features under scratchDir: dirs with an issues
// subdir, complete or not.
function knownFeatureNames (scratchDir:string):Set<string> {
    if (!existsSync(scratchDir)) return new Set()
    return new Set(
        readdirSync(scratchDir, { withFileTypes:true })
            .filter(e => (
                e.isDirectory() &&
                existsSync(join(scratchDir, e.name, 'issues'))
            ))
            .map(e => e.name)
    )
}

/**
 * Tickets of the named features with every blocker resolved, and
 * the problems found on the way. An unselected feature is scanned
 * only when a ref points into it, once.
 */
export function loadSelection (
    scratchDir:string,
    names:ReadonlyArray<string>
):LoadedSelection {
    const known = knownFeatureNames(scratchDir)
    const issuesDir = (name:string) => join(scratchDir, name, 'issues')

    const tickets:Ticket[] = []
    const selected = new Map<string, Set<number>>()
    for (const name of new Set(names)) {
        const dir = issuesDir(name)
        const found = existsSync(dir) ?
            scanTickets(dir, name, known) :
            []
        selected.set(name, new Set(found.map(t => t.num)))
        tickets.push(...found)
    }

    const outside = new Map<string, Map<number, string>>()
    const lookup = (feature:string, num:number) => {
        if (!known.has(feature)) return undefined
        let statuses = outside.get(feature)
        if (!statuses) {
            statuses = new Map(
                scanTickets(issuesDir(feature), feature)
                    .map(t => [t.num, t.status])
            )
            outside.set(feature, statuses)
        }
        return statuses.get(num)
    }

    const warnings:BlockerWarning[] = []
    for (const t of tickets) {
        const parsed = parseBlockerField(t.body, known)
        t.blockers = resolveBlockers(
            parsed.refs, t.feature, selected, lookup
        )
        const ticket = ticketLabel(t)
        for (const word of parsed.typos) {
            warnings.push({ ticket, kind:'typo', text:word })
        }
        for (const ref of t.blockers) {
            if (ref.where !== 'missing') continue
            warnings.push({
                ticket, kind:'missing', text:blockerLabel(ref),
            })
        }
    }
    return { tickets, warnings }
}
```
(wrap any line over 80 columns.)

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Picker counts and label

**Verifies:** cross-feature-blockers.AC1.11, AC2.4 (picker half)

**Files:**
- Modify: `src/resolve.ts` (`resolveIssuesDir` multi-feature
  branch, line 54-118)

**Implementation:**

```ts
export type FeatureCounts = {
    ready:number;
    total:number;
    badBlockers:number;   // refs that match no ticket
}

/**
 * Counts for one feature as if it ran alone: the same
 * loadSelection a `--spec <name>` run uses.
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
    return `${name} (${c.ready}/${c.total} ready${bad})`
}
```

In `resolveIssuesDir`, build each choice's `name` with
`featureChoiceLabel(join(cwd, '.scratch'), f.name)` and remove the
old `scanTickets(f.dir)` / `findReadyTickets` lines there. Outside
pending refs are not counted as bad (only `missing` warnings are).

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `loadSelection` and picker tests

**Verifies:** cross-feature-blockers.AC1.1, AC1.11, AC2.1, AC2.2,
AC2.4

**Files:**
- Modify: `test/resolve.test.ts` (unit, temp `.scratch` trees via
  `makeTempScratch` / `addFeature`)

**Testing.** Use real feature names `newsletter-audit` and
`held-import-review`. Ticket bodies are
`'# T\n\n**Status:** <status>\n**Blocked by:** <text>\n'`. For
`held-import-review/01-writer-can-reply.md` use the verbatim
held-import-review 01 field from Phase 1 Task 3.
- AC1.1 + AC2.1: `newsletter-audit/16-x.md` done.
  `loadSelection(scratchDir, ['held-import-review'])`: the 01
  ticket's `blockers` deepEqual
  `[{ feature:'newsletter-audit', num:16, where:'done',
  status:'done' }]`, it is in `findReadyTickets(tickets)`, and
  `tickets` contains no newsletter-audit ticket.
- AC2.2: same tree with `newsletter-audit/16` ready-for-agent: the
  ref is `where:'pending', status:'ready-for-agent'`;
  `findReadyTickets` is empty; `blockerLabel(ref)` includes
  `'newsletter-audit/16'` and `'ready-for-agent'`; `warnings` is
  empty (pending is not a warning).
- Both selected: `loadSelection(scratchDir, ['held-import-review',
  'newsletter-audit'])` -> the ref is `where:'run'`.
- AC2.4: a held-import-review ticket blocked by
  `newsletter-audit 40` (no such ticket) and another blocked by
  `09` (no such own ticket): both refs `where:'missing'`, neither
  ticket ready, and `warnings` has two entries with
  `kind:'missing'` naming the tickets
  (`ticket === 'held-import-review/NN'`).
- Typo: a ticket blocked by `nwsletter-audit 16` -> one warning
  `{ kind:'typo', text:'nwsletter-audit' }` and its ref is the
  own-feature 16.
- AC1.11: tree where held-import-review has `01` (blocked by
  `newsletter-audit 16`, which is done) and `02` (blocked by `01`).
  `featureCounts(scratchDir, 'held-import-review')` deepEqual
  `{ ready:1, total:2, badBlockers:0 }`, and `.ready` equals
  `findReadyTickets(loadSelection(scratchDir,
  ['held-import-review']).tickets).length`. (The old picker read
  `newsletter-audit 16` as own ticket 16 and counted 0 ready.)
- AC2.4 picker: add a ticket blocked by `newsletter-audit 40` ->
  `badBlockers:1`; a ticket blocked by a pending outside ticket
  does not raise `badBlockers`.

**Verification:** run the resolve suite:
`npx esbuild test/resolve.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/resolve.test.js` -> all pass.
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-6) -->
<!-- START_TASK_4 -->
### Task 4: `loadTickets` uses `loadSelection`

**Verifies:** cross-feature-blockers.AC2.4 (end to end: the ref is
no longer stripped)

**Files:**
- Modify: `src/index.ts:259-363` (`LoadedTickets`, `loadTickets`)

**Implementation:**
1. Import `loadSelection` and `type BlockerWarning` from
   `./resolve.js`.
2. `LoadedTickets` gains `warnings:BlockerWarning[]`.
3. `loadTickets`: keep the per-selection existence checks and
   `missing` messages exactly as they are, collecting the
   selections that pass and reading their spec bodies. Then call
   `loadSelection(join(process.cwd(), '.scratch'),
   valid.map(s => s.name))` once (skip the call and use empty
   results when `valid` is empty). Use `process.cwd()`, the same
   base `resolveIssuesDir` uses, not `dirname(dirname(dir))`: a
   `--spec` name containing `/` (`a/b`) has its issues dir at
   `.scratch/a/b/issues`, and `loadSelection` joins the name back
   onto the scratch dir, so only the true scratch dir round-trips. For each valid selection in
   order, take `tickets.filter(t => t.feature === name)` and keep
   the existing zero-ticket skip message, the `Found N tickets`
   log, and the `specBodies` / `progressPaths` / `issuesDirs` /
   `allTickets` / first-feature bookkeeping. Delete the
   unknown-blocker block (former lines 322-339). Return
   `warnings` (from `loadSelection`) with the rest.
4. Update the doc comment above `loadTickets` to say blockers are
   resolved by `loadSelection` and problems come back as
   `warnings`.
5. Remove the `scanTickets` import from `./orchestrator.js` if
   nothing else in `index.ts` uses it.

The resume re-scan (`loadTickets(selections, () => {})` around
line 476) needs no change: it calls the same function after the
checkout, so it reads the integration branch's tickets.

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> 0
errors.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Rewrite the unknown-blocker CLI test

**Verifies:** cross-feature-blockers.AC2.4 (CLI: a missing ref
keeps the ticket from running)

**Files:**
- Modify: `test/integration.test.ts:437-487`

**Implementation:** rename the test to
`'CLI subprocess - unknown blocker keeps the ticket from running'`.
Keep the setup (`01-task.md`, `blockers:[99]`, same `spawnCli`
args). Replace the assertions with: the ticket file still contains
`**Status:** ready-for-agent`, and `logsDir/01-task.log` does not
exist (no agent ran). Do not assert the exit code or output text in
this phase (Phase 4 adds the summary text, Phase 5 the exit code).

Then run the full suite. If any other test relied on unknown
blockers being stripped, update it to the new rule the same way
and list it in the commit message body.

**Verification:**
Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`; type-check as in Phase 2.
Expected: no new errors.
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Commit

**Commit:** `feat: load tickets and picker counts through
loadSelection`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
