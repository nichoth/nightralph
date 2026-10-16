# Feature Graph -- Test Requirements

Design: `docs/design-plans/2026-10-09-feature-graph.md` (section
"Acceptance Criteria"). Phases: `phase_01.md` through `phase_06.md`
in this directory.

How to use this file: every acceptance criterion is listed once,
with its full text from the design, then the automated tests that
verify it (type, file, the phase and task that create the test, and
what the test asserts) or the human check that replaces a test.
After execution, confirm each listed test exists and passes under
`npm run build && npm test`; walk the human checks by hand. A
criterion covered in several phases lists every phase, because each
phase verifies a different layer (data, rendered text, CLI).

Test types: **unit** calls a pure or in-process function directly
(the `src/graph.ts` and `src/resolve.ts` tests use real tmp
`.scratch/<feature>/issues/NN-*.md` fixtures through
`loadSelection`, but no subprocess); **integration** runs the built
CLI, `dist/index.js`, as a subprocess through `spawnCli`. Files:
`test/orchestrator.test.ts`, `test/graph.test.ts` (new, added to
`TESTS` in Phase 2 Task 3), `test/resolve.test.ts`,
`test/integration.test.ts`.

## Planning decisions that shape these tests

1. AC3.1 is split across two phases. Phase 2 tests the data (the
   suggested features and the 6 of 6 count). The clause "the remedy
   says to select both in the picker" is rendered text, so Phase 3
   tests it by finding a line that names both features and the word
   `picker`, not by matching the sentence.
2. `Suggestion.edges` holds refs as they are in the final selection.
   After the closure every needed upstream feature is selected, so
   those refs are `where:'run'` with the blocking ticket's `status`
   copied in, not `'pending'`. The AC3.4 test therefore expects a
   `run` ref with `status:'ready-for-human'`.
3. `Suggestion.deadEnds` is `UpstreamRef[]` (stuck target ticket
   plus dead ref), not `BlockerRef[]`, so AC3.4 and AC3.5 tests
   assert on `from` and `ref` together.
4. `cycles` holds only tickets the target needs, and, like
   `renderNothingReady`, also tickets that only wait behind a cycle.
   The rendered line reads `(in or behind a cycle)` instead of the
   design's `(they wait on each other)`. AC3.6 tests assert labels,
   not that wording.
5. `FeatureReport.suggestion` is non-null when a feature has a dead
   ref into another feature even with no cross-feature edge (e.g.
   `beta 40` where beta has no ticket 40). Without this, AC3.5's
   dead end would land on the not-waiting line and never be named.
   Phase 2 tests the data, Phase 3 the block with no "Run together"
   line.
6. The typo paragraph is extracted into `renderTypoWarnings`
   (Phase 3 Task 1) and shared with `renderFinishSummary` and
   `renderNothingReady`. The existing `test/orchestrator.test.ts`
   tests of those two prove the text is unchanged; no new test pins
   the wording. AC2.11's typo half asserts the misspelt word appears
   once, on the last line.
7. The picker's no-features message becomes `NO_FEATURES_MESSAGE`
   (Phase 5 Task 1), so AC2.7's "the picker's error" holds by
   construction. The CLI test asserts exit 2 and a non-empty stderr
   containing `.scratch`, not the sentence.
8. AC2.6's "without reaching the picker" is proved by leaving stdin
   open: reaching the interactive picker would wait until the 30s
   `spawnCli` timeout instead of exiting 2.
9. AC2.8's "no git" is tested in a tmp dir that is not a git repo,
   and "no files written" by comparing a sorted recursive listing
   before and after. "No preflight" is the absence of the
   `Provider` line and of any `nightralph--` branch name.
10. Tests do not pin whole sentences (user rule: no brittle text
    tests). They assert ticket labels and feature names taken from
    the fixtures, line counts, relative order (`indexOf`) and exit
    codes. AC1.3 compares the label with a string built from
    `featureCounts`, and AC1.1 checks `endsWith` on the suffix the
    AC itself names.
11. tapzero's `deepEqual` (fast-deep-equal) treats any two `Map`s
    as equal, so AC3.7's `deadRefs` check spreads both maps into
    entry arrays first.
12. Adding `waitsOn` changes the existing `featureCounts AC1.11`
    test in `test/resolve.test.ts` (Phase 4 Task 1), which must now
    expect `waitsOn:[]`. It doubles as an AC1.3 regression check.
13. AC4.1's build half (`dist/graph.js` exists) is an operational
    check, and its test half (the suite runs under `npm test`) is
    observed in the `npm test` output. Neither gets a test that
    reads build config. AC4.2 is documentation and is checked in
    review (design text and the user's rule "do not write tests for
    docs").

## AC1: Picker names upstream features

**feature-graph.AC1.1 Success:** A feature whose `ready-for-agent`
ticket has a `pending` ref into feature B has `waitsOn` equal to
`[B]`, and its label ends `, waits on B)`
- unit, `test/resolve.test.ts`, Phase 4 Task 2:
  `crossFeatureTree('ready-for-agent')` -> `featureCounts(scratchDir,
  HIR).waitsOn` deep-equals `[NA]`, and `featureChoiceLabel(
  scratchDir, HIR)` ends with `, waits on ${NA})`.

**feature-graph.AC1.2 Success:** Several upstream features are all
named, sorted, none truncated
- unit, `test/resolve.test.ts`, Phase 4 Task 2: `HIR` also waits on
  `zeta-feat 01` and `beta-feat 01` -> `waitsOn` deep-equals
  `['beta-feat', NA, 'zeta-feat']` (sorted), and the label contains
  all three names (none truncated).

**feature-graph.AC1.3 Edge:** A feature with no `pending`
cross-feature ref gets exactly today's label
- unit, `test/resolve.test.ts`, Phase 4 Task 2:
  `crossFeatureTree('done')` -> `waitsOn` is `[]` and the label
  equals `${HIR} (${c.ready}/${c.total} ready)` built from
  `featureCounts`.
- unit, `test/resolve.test.ts`, Phase 4 Task 1 (updated existing
  test `featureCounts AC1.11`): its counts deep-equal
  `{ ready:1, total:2, badBlockers:0, waitsOn:[] }`.

**feature-graph.AC1.4 Edge:** Refs to done tickets, `missing` refs,
and refs from done or human tickets do not add to `waitsOn`
- unit, `test/resolve.test.ts`, Phase 4 Task 2: one fixture where
  `HIR/01` waits on done NA 16, `HIR/02` on missing
  `newsletter-audit 40`, `HIR/03` (done) and `HIR/04`
  (ready-for-human) on ready-for-agent `other-feat/01` -> `waitsOn`
  is `[]`.

**feature-graph.AC1.5 Edge:** R/T is unchanged (ready if run alone)
- unit, `test/resolve.test.ts`, Phase 4 Task 2:
  `crossFeatureTree('ready-for-agent')` -> `featureCounts` `ready` is
  0 and equals `findReadyTickets(loadSelection(scratchDir,
  [HIR]).tickets).length`; `total` is 1.

**feature-graph.AC1.6 Edge:** With bad blockers too, the label order
is `R/T ready, N bad blocker(s), waits on ...`
- unit, `test/resolve.test.ts`, Phase 4 Task 2:
  `crossFeatureTree('ready-for-agent')` plus `HIR/02` waiting on
  missing `newsletter-audit 40` -> in the label, the index of
  `bad blocker` is after `ready` and before `waits on`.

## AC2: `graph` command output

**feature-graph.AC2.1 Success:** `nightralph graph` exits 0 and
prints one block per picker feature that has cross-feature edges
- integration, `test/integration.test.ts`, Phase 5 Task 3:
  `spawnCli(['graph'])` on `GRAPH_BASE` -> code 0; stdout contains
  `held-import-review/01` and `newsletter-audit/16`; exactly one
  line starts with `held-import-review`; no line starts with
  `newsletter-audit` or `analytics` (unblocked, so they appear only
  in the not-waiting line).

**feature-graph.AC2.2 Success:** Each block groups edges by upstream
feature, with ticket-level refs and their statuses
- unit, `test/graph.test.ts`, Phase 3 Task 3: `rebaseBlog`, all
  three features, `renderGraph(buildGraph(...))` -> lines pair
  `held-import-review/01` with `newsletter-audit/16`, `02` with
  `15`, `06` with `18`, each with `ready-for-agent`; the line just
  before the `/01` ref line (the group header) names both features
  and has no `/`.
- unit, `test/graph.test.ts`, Phase 2 Task 2 (data layer, shared
  with AC3.1): `edges` mapped to `[from.num, ref.feature, ref.num]`
  deep-equal `[[1, 'newsletter-audit', 16], [2, ..., 15],
  [6, ..., 18]]`.

**feature-graph.AC2.3 Success:** A transitive hop appears as its own
`X waits on Y` group in the target's block
- unit, `test/graph.test.ts`, Phase 3 Task 3: alpha -> beta 01 ->
  gamma 01 -> inside `alpha`'s block, a line names `beta/01` and
  `gamma/01`, after the line that names `alpha/01` and `beta/01`.
- unit, `test/graph.test.ts`, Phase 2 Task 2 (data layer, shared
  with AC3.2): `edges` includes a ref from `beta` to `gamma`.

**feature-graph.AC2.4 Success:** `--spec x` prints only x's block,
or a not-waiting line when x is unblocked
- integration, `test/integration.test.ts`, Phase 5 Task 3:
  `['graph', '--spec', 'held-import-review']` -> code 0, stdout has
  `held-import-review/01` and no `analytics`. `['graph', '--spec',
  'analytics']` -> code 0, stdout has `analytics` and neither
  `held-import-review` nor `newsletter-audit/`.

**feature-graph.AC2.5 Success:** `--spec` accepts a nested name
(`a/b`) and a feature the picker hides
- integration, `test/integration.test.ts`, Phase 5 Task 3 (nested):
  `['graph', '--spec', 'rollout/billing']` -> code 0, stdout has
  `rollout/billing/01` and `newsletter-audit/16`.
- integration, `test/integration.test.ts`, Phase 5 Task 3 (hidden):
  `finished` with a complete `progress.md`; the test first asserts
  `findFeatureDirs(cwd)` omits it, then `['graph', '--spec',
  'finished']` -> code 0, stdout has `finished/01`.

**feature-graph.AC2.6 Failure:** `--spec` with an unknown name exits
2 with an error on stderr, without reaching the picker
- integration, `test/integration.test.ts`, Phase 5 Task 3:
  `['graph', '--spec', 'nope']` on `GRAPH_BASE` (several features),
  stdin open -> code 2 (not the 30s timeout), stderr contains
  `nope`, stdout is empty.

**feature-graph.AC2.7 Failure:** No `.scratch` features exits 2 with
the picker's error
- integration, `test/integration.test.ts`, Phase 5 Task 3: a tmp dir
  with no `.scratch`, `['graph']` -> code 2, non-empty stderr that
  contains `.scratch`. A project whose only feature is complete
  (hidden from the picker) also exits 2. The wording is shared
  through `NO_FEATURES_MESSAGE` (decision 7).

**feature-graph.AC2.8 Edge:** `graph` is never taken for a provider:
no preflight, no git, no files written
- integration, `test/integration.test.ts`, Phase 5 Task 3:
  `GRAPH_BASE` in a non-git tmp dir -> code 0; the sorted
  `readdirSync(cwd, { recursive:true })` listing is the same before
  and after; neither stream contains `Provider` or `nightralph--`.

**feature-graph.AC2.9 Edge:** Done refs, edges inside a feature, and
refs from tickets that are not `ready-for-agent` are not shown
- unit, `test/graph.test.ts`, Phase 3 Task 3: `alpha/01` waits on
  `02, beta 01`, human `alpha/03` waits on `gamma 01`, `alpha/04`
  waits on done `delta/01` -> output has `beta/01`; no line has
  `gamma/01` or `delta/01`; no line has both `alpha/01` and
  `alpha/02`.
- unit, `test/resolve.test.ts`, Phase 4 Task 2 (AC1.4 fixture): the
  same filter in `upstreamOf` keeps done refs and refs from done or
  human tickets out of `waitsOn`.

**feature-graph.AC2.10 Edge:** Order is deterministic (feature, then
upstream feature, then ticket number)
- unit, `test/graph.test.ts`, Phase 3 Task 3: `buildGraph(load,
  ['zeta', 'alpha', ...])` with tickets numbered out of order ->
  by `indexOf`, the `alpha` block precedes `zeta`, the `beta` group
  precedes `gamma`, and `alpha/01`'s line precedes `alpha/03`'s.
  Rendering twice gives the same string.

**feature-graph.AC2.11 Edge:** Unblocked features are listed on one
line (or one line says none wait), and typo warnings print once at
the end
- unit, `test/graph.test.ts`, Phase 3 Task 3 (list): with
  `rebaseBlog`, exactly one line has `analytics`, and it also has
  `newsletter-audit`. With only unblocked `alpha` and `beta`, the
  output is a single line naming both.
- unit, `test/graph.test.ts`, Phase 3 Task 3 (typos): `rebaseBlog`
  plus `analytics/02` waiting on misspelt `newsleter-audit 15` ->
  the misspelt word appears exactly once, on the last line.
- unit, `test/orchestrator.test.ts`, existing `renderFinishSummary`
  and `renderNothingReady` typo tests, re-run after Phase 3 Task 1:
  the extracted `renderTypoWarnings` leaves their text unchanged.

## AC3: Verified suggestion

**feature-graph.AC3.1 Success:** The rebase.blog reconstruction
suggests `[held-import-review, newsletter-audit]` with 6 of 6
runnable, and the remedy says to select both in the picker
- unit, `test/graph.test.ts`, Phase 2 Task 2: `rebaseBlog` ->
  `suggestSelection(load, 'held-import-review')` has `features`
  `['held-import-review', 'newsletter-audit']`, `runnable` 6,
  `total` 6, `deadEnds` `[]`, `cycles` `[]`. `buildGraph` over all
  three features gives `held-import-review` `ready` 0, `total` 6
  and a non-null suggestion, and null suggestions for the others.
- unit, `test/graph.test.ts`, Phase 3 Task 3 (the remedy, decision
  1): a line after the ref lines names both features and contains
  `picker`.

**feature-graph.AC3.2 Success:** If A needs B and B needs C, the
suggestion is `[A, B, C]`
- unit, `test/graph.test.ts`, Phase 2 Task 2: alpha -> beta 01 ->
  gamma 01 -> `features` `['alpha', 'beta', 'gamma']`, `runnable` 1
  of 1, and `edges` include the beta -> gamma ref.

**feature-graph.AC3.3 Success:** An upstream ticket the target does
not need, waiting on a third feature, does not widen the suggestion
- unit, `test/graph.test.ts`, Phase 2 Task 2: `alpha/01` waits on
  `beta 01`; `beta/02` (not needed) waits on `gamma 01` ->
  `features` `['alpha', 'beta']` and no edge has `from.feature`
  `beta`.

**feature-graph.AC3.4 Failure:** A needed upstream ticket that is
`ready-for-human` gives `runnable < total`, and that ref is named as
the dead end
- unit, `test/graph.test.ts`, Phase 2 Task 2: `alpha/01` waits on
  human `beta/04` -> `features` `['alpha', 'beta']`, `runnable` 0,
  `total` 1, `deadEnds` deep-equal `[{ from:{ feature:'alpha',
  num:1 }, ref:{ feature:'beta', num:4, where:'run',
  status:'ready-for-human' } }]` (decisions 2 and 3).
- unit, `test/graph.test.ts`, Phase 3 Task 3: a line naming
  `alpha/01`, `beta/04` and `ready-for-human` comes after the
  `0 of 1` line.

**feature-graph.AC3.5 Failure:** A `missing` ref never grows the
selection and is named as a dead end
- unit, `test/graph.test.ts`, Phase 2 Task 2: `alpha/01` waits on
  `beta 01`, `alpha/02` on missing `beta 40` -> `features`
  `['alpha', 'beta']`, `runnable` 1, `total` 2, a dead end from
  `alpha` 2 with `ref.where` `'missing'`, `ref.num` 40. Second case:
  `alpha/01` waits only on `beta 40` -> `features` `['alpha']`,
  `edges` `[]`, a `missing` dead end; `buildGraph` gives `alpha` a
  non-null suggestion and `beta` a null one (decision 5).
- unit, `test/graph.test.ts`, Phase 3 Task 3: a line names
  `alpha/01` and `beta/40`; the not-waiting line does not name
  `alpha`; no line contains `picker` (one feature, no "Run
  together").

**feature-graph.AC3.6 Edge:** Tickets that wait on each other across
features are reported as deadlocked, and the closure terminates
- unit, `test/graph.test.ts`, Phase 2 Task 2: `alpha/01` <-> `beta/01`
  -> the call returns, `features` `['alpha', 'beta']`, `runnable` 0,
  `deadEnds` `[]`, `cycles` `['alpha/01', 'beta/01']`.
- unit, `test/graph.test.ts`, Phase 3 Task 3: a line after the count
  line names both `alpha/01` and `beta/01` (decision 4).

**feature-graph.AC3.7 Success:** `simulateRun`'s waves match the
dry-run waves, `neverRun` is the `ready-for-agent` tickets in no
wave, and `deadRefs` equals `findBlockedTickets(tickets, new Set())`
- unit, `test/orchestrator.test.ts`, Phase 1 Task 2 (waves): one
  fixture (cross-feature chain, human blocker, cycle, pending ref);
  the `  Wave N:` lines captured from `dryRun` equal
  `simulateRun(tickets).waves` mapped to filenames; 3 waves.
- unit, same file and task (neverRun): sorted `neverRun` keys equal
  the `ready-for-agent` keys in no wave: `a:5`, `b:2`, `b:3`, `b:4`.
- unit, same file and task (deadRefs): the spread entries equal
  those of `findBlockedTickets(tickets, new Set())` (decision 11);
  keys include `a:5` and `b:4`, and exclude cycle tickets `b:2`,
  `b:3`.
- unit, same file and task: `simulateRun([])` gives empty `waves`,
  empty `neverRun` and a `deadRefs` of size 0.

## AC4: Cross-cutting

**feature-graph.AC4.1:** `npm run build` emits `dist/graph.js`, and
`test/graph.test.ts` runs under `npm test`
- No dedicated test (decision 13). See Human Verification. The
  suite itself is the Phase 2 and Phase 3 tests above, and Phase 2
  Task 3 wires it into `TESTS`.

**feature-graph.AC4.2:** `AGENTS.md` contracts and `README.md`
describe `graph`, `simulateRun` and `waitsOn` (checked in review,
not tested)
- No automated test (decision 13). See Human Verification.

## Human Verification

**feature-graph.AC4.1** (operational check)
- Justification: the criterion is about build and test wiring
  (`src/graph.ts` in the second esbuild call of `build-esm`, `graph`
  in `TESTS` in `scripts/test.sh`), not behavior. A test that reads
  `package.json` or `scripts/test.sh` would pin config text, and the
  CLI subprocess tests cannot see it because the CLI bundle inlines
  `src/graph.ts` whether or not `dist/graph.js` is emitted. If
  `graph` is missing from `TESTS`, the suite silently never runs, so
  only the run output shows it.
- Approach (Phase 2 Task 1 and Task 3 verification steps, repeated
  once after Phase 5): run `npm run build && ls dist/graph.js` and
  confirm the file is listed; run `npm test` and confirm the output
  includes the `graph` suite's tests (the Phase 2 suggestion tests
  and Phase 3 `renderGraph` tests) and that every suite passes.
  `prepublishOnly` runs build and test again before any publish.

**feature-graph.AC4.2** (documentation review)
- Justification: documentation only. The design marks it "checked in
  review, not tested", and the user's rule is "do not write tests for
  docs". Phase 6 has no `Verifies` entry for it.
- Approach (code review of the Phase 6 commits against the shipped
  Phase 1-5 code):
  1. `AGENTS.md`: the Project Structure list has `src/graph.ts`; the
     CLI contract has a `nightralph graph [--spec <name>]` bullet
     (read-only, picker features or one `--spec` feature including
     nested or hidden ones, exit codes 0 and 2, registered after
     `init`); the orchestrator contract lists and describes
     `SimulatedRun`, `simulateRun` and `renderTypoWarnings`; a
     `### graph module (src/graph.ts)` section covers every export,
     the injected `LoadFn` and why it avoids an import cycle; the
     resolve contract describes `FeatureCounts.waitsOn`, the
     `, waits on a, b` label suffix (never truncated, R/T unchanged)
     and `NO_FEATURES_MESSAGE`; `Last verified` is updated.
  2. `README.md`: a `graph` command section after the `--spec`
     section and an example after the `--dry-run` example. Its sample
     output is copied from a real run against a fixture, so it
     matches `renderGraph`; it explains "Run together", the
     `ready-for-agent` denominator of the count line, `stays blocked`,
     `deadlocked`, the picker label, and the limits (read-only,
     current checkout, act on "Run together" through the picker).
  3. Each described behavior matches the code; where they differ, the
     code wins and the doc is fixed.
  4. Run `grep -n "simulateRun\|waitsOn\|nightralph graph\|### graph
     module" AGENTS.md` and confirm each term lands in the sections
     above; run `perl -CSD -ne 'print "$.: $_" if
     /[\x{2014}\x{2192}]/' AGENTS.md README.md` and confirm no
     output (no em dashes or arrow characters).

## Coverage Summary

| Criterion | Verification | File(s) | Phase / Task |
|---|---|---|---|
| AC1.1 | unit | `test/resolve.test.ts` | 4 / 2 |
| AC1.2 | unit | `test/resolve.test.ts` | 4 / 2 |
| AC1.3 | unit | `test/resolve.test.ts` | 4 / 1, 4 / 2 |
| AC1.4 | unit | `test/resolve.test.ts` | 4 / 2 |
| AC1.5 | unit | `test/resolve.test.ts` | 4 / 2 |
| AC1.6 | unit | `test/resolve.test.ts` | 4 / 2 |
| AC2.1 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.2 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC2.3 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC2.4 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.5 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.6 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.7 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.8 | integration | `test/integration.test.ts` | 5 / 3 |
| AC2.9 | unit | `test/graph.test.ts`, `test/resolve.test.ts` | 3 / 3, 4 / 2 |
| AC2.10 | unit | `test/graph.test.ts` | 3 / 3 |
| AC2.11 | unit | `test/graph.test.ts`, `test/orchestrator.test.ts` | 3 / 1, 3 / 3 |
| AC3.1 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC3.2 | unit | `test/graph.test.ts` | 2 / 2 |
| AC3.3 | unit | `test/graph.test.ts` | 2 / 2 |
| AC3.4 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC3.5 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC3.6 | unit | `test/graph.test.ts` | 2 / 2, 3 / 3 |
| AC3.7 | unit | `test/orchestrator.test.ts` | 1 / 2 |
| AC4.1 | operational check | `dist/graph.js`, `npm test` output | 2 / 1, 2 / 3 |
| AC4.2 | human review | `AGENTS.md`, `README.md` | 6 / 1, 6 / 2 |
