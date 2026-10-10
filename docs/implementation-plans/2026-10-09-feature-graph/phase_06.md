# Feature Graph Implementation Plan -- Phase 6

**Goal:** Contracts and user docs describe the `graph` command, the
picker label and `simulateRun`.

**Architecture:** Documentation only. `AGENTS.md` gets a graph module
contract and updates to the orchestrator, resolve and CLI contracts
and the Project Structure list. `README.md` gets a `graph` section.

**Tech Stack:** Markdown

**Scope:** Phase 6 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements:

### feature-graph.AC4: Cross-cutting
- **feature-graph.AC4.2:** `AGENTS.md` contracts and `README.md`
  describe `graph`, `simulateRun` and `waitsOn` (checked in review,
  not tested)

**Verifies: None** (documentation; the user's rules forbid tests for
docs). It is checked in code review against the shipped code from
Phases 1-5.

---

## Rules for the docs

- No em dashes; use `--`. No arrow characters; use `->`.
- Describe what the code does as shipped. Before writing, re-read the
  final `src/graph.ts`, the `simulateRun`/`renderTypoWarnings` code in
  `src/orchestrator.ts`, `featureCounts`/`featureChoiceLabel`/
  `NO_FEATURES_MESSAGE` in `src/resolve.ts`, and `runGraph` in
  `src/index.ts`. Where they differ from the text below, the code
  wins; fix the text.
- Match the surrounding contract style: `- **Name**: text`, wrapped
  near 66 columns as the file already is.
- Load the `writing-for-agents` skill before editing `AGENTS.md`.

---

<!-- START_TASK_1 -->
### Task 1: `AGENTS.md`

**Files:**
- Modify: `AGENTS.md:3` -- `Last verified:` to the current date
- Modify: `AGENTS.md:86-87` (Project Structure) -- after the
  `src/blockers.ts` bullet add:
  ```
  - `src/graph.ts` -- cross-feature edges, the suggested feature
    selection (verified with `simulateRun`) and the `graph` report
    (pure; the loader is injected)
  ```
- Modify: `AGENTS.md` CLI contract (`### CLI (\`src/index.ts\`)`,
  line 114) -- after the `nightralph init` bullet (lines 115-117)
  add a `nightralph graph [--spec <name>]` bullet: read-only, reads
  the current checkout like the picker (no provider preflight, no
  git, no writes); without `--spec` it reports the picker's features
  (`findFeatureDirs`); with `--spec` one feature, which may be nested
  (`a/b`) or hidden from the picker; a missing
  `.scratch/<name>/issues` prints `Directory not found: <dir>` and
  exits 2; no features prints `NO_FEATURES_MESSAGE` and exits 2;
  otherwise prints `renderGraph(buildGraph(load, names))` and exits
  0; registered right after `init`, so yargs matches it before
  `$0 <provider>`.
- Modify: `AGENTS.md` orchestrator `**Exposes**` list (line 252 on)
  -- add `SimulatedRun`, `simulateRun(tickets)` and
  `renderTypoWarnings(warnings)`; then add two bullets after the
  `**blockerLabel(ref)**` bullet:
  - `**simulateRun(tickets)**`: pure; `{ waves, neverRun, deadRefs }`.
    `waves` is the dry-run wave order (`simulateWaves`), `neverRun`
    the `ready-for-agent` tickets in no wave (`detectDeadlocks`),
    `deadRefs` is `findBlockedTickets(tickets, new Set())`. A
    `neverRun` ticket that is not a `deadRefs` key waits on a cycle.
    The dry runs and `renderNothingReady` still call the private
    helpers directly.
  - `**renderTypoWarnings(warnings)**`: the typo paragraph lines
    (`[]` when there are none), shared by the finish summary,
    `renderNothingReady` and `renderGraph`.
- Modify: `AGENTS.md` -- insert a new `### graph module
  (\`src/graph.ts\`)` section between the end of the blockers module
  section and `### resolve module` (line 807), covering:
  - **Exposes**: types `TicketId`, `UpstreamRef`, `Suggestion`,
    `FeatureReport`, `LoadFn`; `upstreamOf(tickets)`,
    `neededPending(tickets, target)`, `suggestSelection(load,
    target)`, `buildGraph(load, features)`, `renderGraph(reports,
    warnings)`
  - **Imports**: values from `./orchestrator.js` and `./display.js`,
    types only from `./blockers.js` and `./resolve.js`. The loader is
    injected (`LoadFn`) because `src/resolve.ts` imports
    `upstreamOf`; a value import of `loadSelection` would be a cycle
  - **upstreamOf**: the `pending` refs of `ready-for-agent` tickets,
    grouped by the ref's feature; direct edges only; feeds the picker
  - **neededPending**: walks from the target's `ready-for-agent`
    tickets through in-run refs into `ready-for-agent` tickets (each
    ticket once, so cycles end) and returns the `pending` refs it
    reaches; `missing` refs are dead ends, not returned
  - **suggestSelection**: the ticket-level closure: start from
    `[target]`, add the features behind `neededPending`, reload,
    repeat until the selection stops growing (a pending ref always
    points outside the selection, so it ends); then one `simulateRun`
    on the final tickets. `features` is the target then the rest
    sorted; `edges` are the needed cross-feature refs as in the final
    selection (`run` refs carry the blocking ticket's `status`);
    `runnable`/`total` count the target's `ready-for-agent` tickets
    in some wave / in all; `deadEnds` pairs each stuck target ticket
    with its `deadRefs`; `cycles` labels needed `neverRun` tickets
    with no dead ref (tickets in a cycle and tickets that only wait
    behind one, as `renderNothingReady` counts them)
  - **buildGraph**: one `FeatureReport` per feature, sorted;
    `ready`/`total` as the picker counts them (all tickets);
    `suggestion` null when there is neither a cross-feature edge nor
    a dead ref into another feature; typo warnings from each
    feature's own load, so each appears once; loads are cached by
    name list within one call
  - **renderGraph**: plain text, no color. One block per report with
    a suggestion: header `<feature> (R/T ready)`, groups
    `<from> waits on <upstream>` (the block's own feature first),
    ticket lines, `Run together: ...` (omitted when the suggestion
    is the feature alone), `N of M ready-for-agent tickets become
    runnable`, `<ticket> stays blocked: <refs>` per dead end, a
    `deadlocked: ... (in or behind a cycle)` line. Then one
    `Not waiting on other features:` line, then the typo paragraph
  - **Guarantees**: everything except the injected loader is pure;
    order is deterministic (feature, upstream feature, ticket number)
- Modify: `AGENTS.md` resolve module (line 807 on) -- add
  `NO_FEATURES_MESSAGE` to **Exposes**; in **Picker label** (line
  824) say the label is `<name> (R/T ready[, N bad blocker(s)][,
  waits on a, b])`, where `waits on` lists every feature in
  `FeatureCounts.waitsOn` (the sorted keys of `upstreamOf` on the
  same `loadSelection` call; never truncated) and R/T still means
  ready if run alone; note that `resolve.ts` imports `upstreamOf`
  from `./graph.js`

**Verification:**

Run: `grep -n "simulateRun\|waitsOn\|nightralph graph\|### graph module" AGENTS.md`
Expected: each term appears in the sections above

Run: `perl -CSD -ne 'print "$.: $_" if /[\x{2014}\x{2192}]/' AGENTS.md`
Expected: no output (no em dashes or arrows)

**Commit:**

```bash
git add AGENTS.md
git commit -m "docs: document the graph module and command in AGENTS.md"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `README.md`

**Files:**
- Modify: `README.md` -- add a `### \`graph\` command` section after
  the `### \`--spec <name>\` option` section (lines 288-292), before
  `### \`--prefer-subagent\` option` (line 295); and add one example
  to the `## Examples` code block (lines 140-170):
  ```
  # Show which features wait on tickets in other features
  npx nightralph graph
  ```
  The existing examples use `npx nightralph ...`; put the new one
  after the `--dry-run` example (`npx nightralph codex --dry-run`).

**Content of the section** (prose, user-facing):

- What it answers: which features wait on tickets in other features,
  through which tickets, and which features to select together so the
  work can run.
- Usage: `nightralph graph` (the features the picker shows) and
  `nightralph graph --spec <name>` (one feature and what it waits on,
  nested or complete features included).
- A short sample of the output, in the shape `renderGraph` produces
  (copy it from a real run against a fixture, e.g. the Phase 5 test
  fixture, so it matches the code).
- What "Run together" means: the suggestion is checked by simulating
  the combined run with the same wave logic as `--dry-run`; the count
  says how many of the feature's `ready-for-agent` tickets become
  runnable (the header's R/T counts all tickets, as the picker does);
  a `stays blocked` line names a blocker that selecting together
  cannot fix (a `ready-for-human` ticket or a ref that matches no
  ticket); `deadlocked` names tickets in or behind a cycle. A feature
  whose only problem is a ref into another feature that matches no
  ticket gets a block with no "Run together" line.
- The picker label: `held-import-review (0/6 ready, waits on
  newsletter-audit)`; R/T still counts tickets ready if the feature
  runs alone.
- Limits: read-only, reads the current checkout (not an integration
  branch); "Run together" can only be acted on in the picker, since
  `--spec` takes one name.

**Verification:**

Run: `perl -CSD -ne 'print "$.: $_" if /[\x{2014}\x{2192}]/' README.md`
Expected: no output (the README has none today)

**Commit:**

```bash
git add README.md
git commit -m "docs: document nightralph graph in the README"
```
<!-- END_TASK_2 -->
