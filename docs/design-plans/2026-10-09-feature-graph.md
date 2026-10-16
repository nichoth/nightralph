# Feature Graph Design

## Summary

Nightralph runs agents against tickets grouped into "features" (folders
under `.scratch/`). A ticket in one feature can declare that it is
blocked by a ticket in another feature. Today the feature picker counts
a feature's tickets as "ready if run alone", so a feature whose work all
waits on another feature shows as 0 ready with no hint why. This change
makes those cross-feature dependencies visible and tells the user which
features to select together so the work can actually run.

The approach is to add one new pure module, `src/graph.ts`, that finds
the cross-feature edges and computes a suggested selection. The
suggestion is a ticket-level closure: start from the target feature,
load it, add only the upstream features that its tickets actually need,
and repeat until the set stops growing. The result is then checked by
simulating the combined run with the same wave logic that `--dry-run`
uses, through one new shared function, `simulateRun`, so readiness
cannot drift between the dry run and the graph. Three thin consumers sit
on top: a new read-only `nightralph graph [--spec <name>]` subcommand
that prints the report, an extra "waits on ..." suffix on the picker
label, and updated docs. The loader is passed into the graph module as a
function rather than imported, which avoids an import cycle with
`src/resolve.ts` and lets tests use an in-memory loader.

## Definition of Done

1. Picker: a feature with unfinished blockers in other features has the
   label `held-import-review (0/6 ready, waits on crop-dialog-modal,
   analytics)`. R/T keeps meaning "ready if run alone", so nothing
   changes for features with no such blockers. Every upstream feature
   is named, not truncated.

2. `nightralph graph [--spec <name>]` prints terminal text. For each
   feature with unsatisfied cross-feature refs, it prints the upstream
   features, and under each one the ticket refs and their statuses
   (e.g. `held-import-review/01 waits on crop-dialog-modal/03
   (ready-for-agent)`). Done refs and edges inside a feature are left
   out. With `--spec`, it shows only that feature and its upstream
   chain.

3. Each blocked feature gets a suggested selection: the transitive set
   of upstream features. It is checked by simulating the combined run
   with the same wave logic `--dry-run` uses. The output says how many
   of the feature's tickets become runnable, or names the real dead end
   (a ready-for-human or missing ref) when selecting together will not
   help. Cross-feature cycles are reported too.

4. Tests, AGENTS.md contracts and README updated. The build lists
   (`build-esm` in `package.json`, `TESTS` in `scripts/test.sh`)
   include any new module.

Out of scope: auto-selecting features in the picker, mermaid / dot /
JSON output, showing edges inside a feature, changing what R/T counts,
and reading statuses from an integration branch (the command reads the
current checkout, like the picker).

## Acceptance Criteria

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

### feature-graph.AC2: `graph` command output
- **feature-graph.AC2.1 Success:** `nightralph graph` exits 0 and prints
  one block per picker feature that has cross-feature edges
- **feature-graph.AC2.2 Success:** Each block groups edges by upstream
  feature, with ticket-level refs and their statuses
- **feature-graph.AC2.3 Success:** A transitive hop appears as its own
  `X waits on Y` group in the target's block
- **feature-graph.AC2.4 Success:** `--spec x` prints only x's block, or
  a not-waiting line when x is unblocked
- **feature-graph.AC2.5 Success:** `--spec` accepts a nested name
  (`a/b`) and a feature the picker hides
- **feature-graph.AC2.6 Failure:** `--spec` with an unknown name exits
  2 with an error on stderr, without reaching the picker
- **feature-graph.AC2.7 Failure:** No `.scratch` features exits 2 with
  the picker's error
- **feature-graph.AC2.8 Edge:** `graph` is never taken for a provider:
  no preflight, no git, no files written
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
- **feature-graph.AC3.7 Success:** `simulateRun`'s waves match the
  dry-run waves, `neverRun` is the `ready-for-agent` tickets in no
  wave, and `deadRefs` equals `findBlockedTickets(tickets, new Set())`

### feature-graph.AC4: Cross-cutting
- **feature-graph.AC4.1:** `npm run build` emits `dist/graph.js`, and
  `test/graph.test.ts` runs under `npm test`
- **feature-graph.AC4.2:** `AGENTS.md` contracts and `README.md`
  describe `graph`, `simulateRun` and `waitsOn` (checked in review,
  not tested)

## Glossary

- **Feature**: A folder under `.scratch/<name>/` holding a spec and its
  ticket files. The unit a user selects in the picker or with
  `--spec`. Can be nested (`a/b`).
- **Ticket**: One markdown issue file for an agent to implement, with a
  status such as `ready-for-agent`, `ready-for-human` or `done`.
- **Blocker / blocked by**: A `**Blocked by:**` field in a ticket that
  lists tickets which must be done first. A ref may point into another
  feature.
- **Cross-feature edge**: A blocker ref from a ticket in one feature to
  a ticket in a different feature. Edges inside one feature are
  deliberately not shown.
- **Upstream feature**: A feature that another feature waits on.
- **Blocker ref kinds (`run`, `done`, `pending`, `missing`)**: How the
  loader classifies a ref. `run`: the ticket is in this run. `done`:
  outside the run and finished. `pending`: outside the run and not
  finished, so it cannot run this session. `missing`: matches no
  ticket, which is a dead end.
- **Dead end / dead ref**: A blocker that can never be satisfied in this
  run, such as a `ready-for-human` ticket or a `missing` ref.
- **Wave**: A batch of tickets whose blockers are all satisfied, run in
  parallel. Later waves unlock as earlier ones finish.
- **Deadlock / cycle**: Tickets that wait on each other, so none can
  ever start.
- **Picker**: The interactive feature chooser shown when no `--spec` is
  given.
- **R/T**: The picker's "ready / total" count for a feature, meaning
  tickets ready if that feature were run alone. It stays unchanged
  here.
- **`waitsOn`**: New field on the picker's feature counts, listing the
  upstream feature names, used for the label suffix.
- **Suggestion / closure**: The verified set of features to run
  together: the target plus the upstream features its tickets
  transitively need, iterated until the set stops growing.
- **`--dry-run`**: Existing CLI mode that prints the simulated wave
  order without running agents.
- **Integration branch**: The `nightralph--<feature>` git branch a run
  works on. Out of scope; `graph` reads the current checkout only.
- **FCIS (pure core / thin shell)**: Pattern of putting logic in pure
  functions and keeping I/O in a thin outer layer. Here `graph.ts` is
  the pure core and `src/index.ts` is the shell.
- **`loadSelection`**: The single loader that reads tickets and
  classifies their blocker refs; shared by the run, the picker and now
  `graph`.
- **`LoadFn`**: The injected loader function type that breaks the
  `graph.ts` and `resolve.ts` import cycle.
- **yargs**: The CLI argument library. `.command('graph', ...)` must be
  registered so it matches before the default `$0 <provider>` command.
- **esbuild `build-esm` list / `TESTS` list**: Explicit file lists in
  `package.json` and `scripts/test.sh`. New modules and test suites
  must be added by hand or they are not built or run.
- **`spawnCli`**: Test helper that runs the built CLI as a subprocess,
  used for the `graph` command tests.
- **rebase.blog reconstruction**: A reduced real-world fixture
  (`held-import-review` waiting on `newsletter-audit` tickets 15, 16,
  18) used as the main acceptance case.

## Architecture

A new pure-core module, `src/graph.ts`, answers "which features block
this one, through which tickets, and would selecting them together
help". A thin `graph` subcommand in `src/index.ts` prints its result,
and the picker label in `src/resolve.ts` reuses its direct-edge
helper.

### Shared simulation (`src/orchestrator.ts`)

One new pure export composes the private `simulateWaves` and
`detectDeadlocks` with the exported `findBlockedTickets`, so readiness,
`--dry-run` and `graph` share one predicate (`blockerSatisfied`) and
cannot drift:

```ts
export interface SimulatedRun {
    waves:Ticket[][];                    // simulateWaves, in order
    neverRun:Ticket[];                   // detectDeadlocks leftovers
    deadRefs:Map<string, BlockerRef[]>;  // findBlockedTickets(t, {})
}
export function simulateRun (tickets:Ticket[]):SimulatedRun
```

`simulateWaves` and `detectDeadlocks` keep their names and existing
callers.

### Graph module (`src/graph.ts`)

```ts
export interface UpstreamRef {
    from:{ feature:string; num:number };  // open ticket that waits
    ref:BlockerRef;                       // where:'pending'
}
export interface Suggestion {
    features:string[];      // target first, then upstream, sorted
    edges:UpstreamRef[];    // every needed cross-feature edge
    runnable:number;        // target tickets that run in some wave
    total:number;           // target ready-for-agent tickets
    deadEnds:BlockerRef[];  // why the rest never run
    cycles:string[];        // labels of tickets waiting on each other
}
export interface FeatureReport {
    feature:string;
    ready:number;
    total:number;
    suggestion:Suggestion|null;  // null: no cross-feature edge
}
export function upstreamOf (tickets:Ticket[]):
    Map<string, UpstreamRef[]>                   // pure
export function neededPending (tickets:Ticket[],
    target:string):UpstreamRef[]                 // pure
export type LoadFn = (names:string[]) => LoadedSelection
export function suggestSelection (load:LoadFn,
    target:string):Suggestion
export function buildGraph (load:LoadFn,
    features:string[]):{ reports:FeatureReport[];
        warnings:BlockerWarning[] }
export function renderGraph (reports:FeatureReport[],
    warnings:BlockerWarning[]):string           // pure
```

- `upstreamOf` groups the `pending` refs of `ready-for-agent` tickets
  by the ref's feature. Direct edges only; it feeds the picker.
- `neededPending` walks from the target's `ready-for-agent` tickets
  through in-run refs (a visited set, so cycles terminate) and returns
  the `pending` refs reached. A `missing` ref is a dead end and is not
  returned.
- `suggestSelection` is the ticket-level closure. Starting from
  `[target]`, it calls `loadSelection`, adds the features behind
  `neededPending`, and repeats until the selection stops growing. It
  then calls `simulateRun` once on the final tickets. `runnable`
  counts target tickets that appear in a wave; `deadEnds` comes from
  `deadRefs` of the target's tickets; `cycles` are `neverRun` tickets
  with no dead ref.
- `buildGraph` runs `suggestSelection` for each given feature and
  collects the loader's typo warnings once.
- `renderGraph` produces the text below.

`src/graph.ts` imports from `src/orchestrator.ts`, `src/display.ts` and
`src/blockers.ts` only. The loader is injected (`LoadFn`, called by
`src/index.ts` as `names => loadSelection(scratchDir, names)`) because
`src/resolve.ts` imports `upstreamOf` from `src/graph.ts`; importing
`loadSelection` back would make a cycle. `LoadedSelection` is a type
import. This also lets the closure be tested with an in-memory loader.

### Output

```
held-import-review (0/6 ready)
  held-import-review waits on newsletter-audit
    held-import-review/01 waits on newsletter-audit/16 (ready-for-agent)
    held-import-review/02 waits on newsletter-audit/15 (ready-for-agent)
    held-import-review/06 waits on newsletter-audit/18 (ready-for-agent)
  Run together: held-import-review, newsletter-audit (select both in the picker)
    6 of 6 tickets become runnable

Not waiting on other features: analytics, crop-dialog-modal,
newsletter-audit, og-enhanced-cards, write-bottom-update
```

- A block lists every edge in `Suggestion.edges`, grouped as
  `<feature> waits on <feature>`, so a transitive hop appears as its
  own group inside the target's block.
- On a dead end the count line reads `N of M tickets become runnable`
  and one line per stuck target ticket follows:
  `a/03 stays blocked: b/04 (ready-for-human)`, using `blockerLabel`
  wording. Deadlocks print as
  `deadlocked: a/02, b/03 (they wait on each other)`.
- Blocks sort by feature, groups by upstream feature, ref lines by
  ticket number. Plain text, two-space indents, no color.
- Typo warnings print once at the end.
- When no feature waits on another, one line says so.

### Picker label (`src/resolve.ts`)

`featureCounts` gains `waitsOn:string[]`: the sorted keys of
`upstreamOf` on the `loadSelection` call it already makes, so the
picker does no extra reads. `featureChoiceLabel` appends
`, waits on a, b` (every name) when the list is non-empty:
`held-import-review (0/6 ready, waits on newsletter-audit)`. With bad
blockers too: `x (0/3 ready, 1 bad blocker, waits on y)`. R/T keeps
meaning "ready if run alone".

### CLI (`src/index.ts`)

`.command('graph', ...)` with its own `--spec <name>` option, registered
like `init` so yargs matches it before the `$0 <provider>` default.
Without `--spec` it reports the features the picker shows
(`findFeatureDirs`). With `--spec` it reports one feature, which may
be nested (`a/b`) and may be a feature the picker hides. A missing
feature dir exits 2 with the run command's missing-feature wording;
no `.scratch` features exits 2 with the picker's wording. It is
read-only: no provider preflight, no git, no writes. Exit 0 otherwise.

## Existing Patterns

- Ticket loading goes through `loadSelection` (`src/resolve.ts`), the
  one loader the run and the picker share, so `graph` classifies refs
  (`run`, `done`, `pending`, `missing`) exactly as a run would. This
  follows the cross-feature-blockers design
  (`docs/design-plans/2026-10-09-cross-feature-blockers.md`).
- Readiness uses `blockerSatisfied` through `simulateRun`, the same
  predicate behind `findReadyTickets`, the dry-run waves and the
  deadlock check.
- Pure rendering functions returning a string, with plain-text labels
  from `blockerLabel` (`src/orchestrator.ts`) and `ticketLabel`
  (`src/display.ts`), as in `renderFinishSummary` and
  `renderNothingReady`. Color stays in `src/display.ts`.
- Subcommand registration mirrors `init` in `src/index.ts`.
- Tests write real `.scratch/<feature>/issues/NN-*.md` fixtures in a tmp
  dir, as `makeTempScratch`/`addFeature` do in `test/resolve.test.ts`,
  and CLI tests use `spawnCli` (`test/integration.test.ts`), asserting
  on exit codes and structure rather than exact wording.
- New modules are added to the second esbuild call in `build-esm`
  (`package.json`) and new suites to `TESTS` (`scripts/test.sh`).

Divergence: `detectDeadlocks` returns tickets blocked by dead refs as
well as true cycles. `simulateRun` keeps it as is and separates the two
using `deadRefs`, the same split `renderNothingReady` relies on.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Shared simulation
**Goal:** One exported pure function that says which tickets run, in
which wave, and why the rest never do.

**Components:**
- `SimulatedRun` and `simulateRun` in `src/orchestrator.ts`, composing
  `simulateWaves`, `detectDeadlocks` and `findBlockedTickets`
- Tests in `test/orchestrator.test.ts`

**Dependencies:** None

**Done when:** `simulateRun` agrees with the dry-run wave order and
`findBlockedTickets`, and tests for `feature-graph.AC3.7` pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Graph core
**Goal:** Cross-feature edges, the ticket-level closure and the
verified suggestion.

**Components:**
- `src/graph.ts`: `UpstreamRef`, `Suggestion`, `FeatureReport`,
  `upstreamOf`, `neededPending`, `suggestSelection`, `buildGraph`
- `src/graph.ts` added to the second esbuild call in `build-esm`
- `test/graph.test.ts`, added to `TESTS` in `scripts/test.sh`, with tmp
  `.scratch` fixtures including a reduced rebase.blog reconstruction
  (held-import-review waiting on newsletter-audit 15, 16, 18)

**Dependencies:** Phase 1

**Done when:** tests for `feature-graph.AC3.1` to `AC3.6` and
`feature-graph.AC4.1` pass and `npm run build` emits `dist/graph.js`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Renderer
**Goal:** Terminal text for a list of feature reports.

**Components:**
- `renderGraph` in `src/graph.ts`
- Tests in `test/graph.test.ts` that check the output against its
  input data (labels present, sort order), not exact wording

**Dependencies:** Phase 2

**Done when:** tests for `feature-graph.AC2.2`, `AC2.3`, `AC2.9`,
`AC2.10` and `AC2.11` pass.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Picker label
**Goal:** The picker names the features a feature waits on.

**Components:**
- `FeatureCounts.waitsOn` and `featureCounts` in `src/resolve.ts`, using
  `upstreamOf` from `src/graph.ts`
- `featureChoiceLabel` in `src/resolve.ts`
- Tests in `test/resolve.test.ts`

**Dependencies:** Phase 2

**Done when:** tests for `feature-graph.AC1.1` to `AC1.6` pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: `graph` command
**Goal:** `nightralph graph [--spec <name>]` prints the report.

**Components:**
- `.command('graph', ...)` in `src/index.ts`
- CLI subprocess tests in `test/integration.test.ts` via `spawnCli`

**Dependencies:** Phases 3 and 4

**Done when:** tests for `feature-graph.AC2.1`, `AC2.4` to `AC2.8`
pass.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Documentation
**Goal:** Contracts and user docs describe the command and label.

**Components:**
- `AGENTS.md`: graph module contract, `simulateRun` in the orchestrator
  contract, `waitsOn` in the resolve contract, `graph` in the CLI
  contract, the module list in Project Structure
- `README.md`: a `graph` section near `## Command Line Arguments`

**Dependencies:** Phase 5

**Done when:** docs describe the shipped behavior and
`feature-graph.AC4.2` holds.
<!-- END_PHASE_6 -->

## Additional Considerations

**Cost:** `suggestSelection` makes one `loadSelection` call per closure
round per feature. The picker already makes one per feature, so this is
the same order of work for the repos nightralph targets.

**Limits:** "Run together" can only be acted on through the picker,
since `--spec` takes one name. `graph` reads the current checkout, not
an integration branch.
