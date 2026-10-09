# Cross-Feature Blockers -- Test Requirements

Design: `docs/design-plans/2026-10-09-cross-feature-blockers.md`
(section "Acceptance Criteria"). Phases: `phase_01.md` through
`phase_06.md` in this directory.

How to use this file: every acceptance criterion is listed once,
with the automated tests that verify it (type, file, the phase and
task that create the test, and what the test asserts) or the human
check that replaces a test. After execution, confirm each listed
test exists and passes under `npm run build && npm test`; walk the
human checks by hand. A criterion covered in several phases lists
every phase, because each phase verifies a different layer.

Test types: **unit** calls a pure or in-process function directly;
**integration** runs `runWavesIsolated` in-process against a temp
git repo; **CLI subprocess** runs `dist/index.js` through
`spawnCli`. Files: `test/blockers.test.ts` (new, added to `TESTS`
in Phase 1), `test/orchestrator.test.ts`, `test/resolve.test.ts`,
`test/integration.test.ts`.

## Planning decisions that shape these tests

1. Zero-ready stop rule (decided with the user, Phase 5): the stop
   fires only when nothing is ready AND at least one ticket is
   `ready-for-agent`, on both the first scan and the resume re-scan.
   All-done or human-only runs proceed to the finish summary and
   review. AC3.1 is read as "nothing ready while a ready-for-agent
   ticket waits", and the `nothingReady` unit cases pin this.
2. When the run will resume an existing integration branch, the
   first-scan stop is skipped and only the re-scan decides. AC3.2
   (stop before provider preflight) is therefore tested only for
   runs that do not resume; a separate CLI test proves the resume
   path stops from the re-scan.
3. Because the stop runs before `dryRun`, cycles are reported by
   `renderNothingReady`, and the existing
   `'CLI subprocess - dry-run deadlock detection'` test is updated
   to the new output (Phase 5 Task 4).
4. `blockerLabel`, the `listTickets` label and the AC2.6 human-key
   fix moved from Phase 4 to Phase 2 so Phase 2 compiles. AC2.6 is
   tested in Phase 2 and re-run after Phase 4 restructures the
   summary.
5. The unknown-blocker CLI test is rewritten across Phases 3, 4 and
   5. After Phase 5 that run hits the zero-ready stop, so its `99` /
   `not found` output comes from `renderNothingReady`, not the
   finish summary. The finish-summary half of AC2.4 is covered by
   the Phase 4 unit test.
6. `historyFor` is a new export (Phase 4) so AC2.7 is tested without
   a full isolated run.
7. Picker counts come from `featureCounts`; tests assert counts, not
   label text (no brittle text tests).

## AC1: Parsing and one loading path

**cross-feature-blockers.AC1.1** (`newsletter-audit 16` -> feature
ref when the dir exists)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: held-import-review
  01 fixture -> refs `[{ feature:'newsletter-audit', num:16 }]`,
  typos `[]`; held-import-review 06 -> 1..5 then
  `newsletter-audit 18`, with `FDR-018` and the path contributing
  nothing.
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: `scanTickets`
  with `knownFeatures` `{'newsletter-audit'}` -> blockers
  `[{ feature:'newsletter-audit', num:16, where:'run' }]`.
- unit, `test/resolve.test.ts`, Phase 3 Task 3: with a real
  `.scratch/newsletter-audit/issues` dir, `loadSelection` resolves
  the held-import-review 01 ref to `newsletter-audit/16` (shared
  with AC2.1).

**cross-feature-blockers.AC1.2** (`01, 02, 03 (03 edits ...)`)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: held-import-review
  04 -> nums `[1, 2, 3]`, no feature; synthetic `01, 02, 01, 02`
  -> `[1, 2]`.

**cross-feature-blockers.AC1.3** (wrapped list)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: newsletter-audit
  18 -> nums 2 through 17 in order; CRLF `01,\r\n02` -> `[1, 2]`.

**cross-feature-blockers.AC1.4** (multi-line parenthetical)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: newsletter-audit
  16 -> `[14, 15]`; newsletter-audit 07 -> `[1, 2, 5]`; unpaired
  `(` hides nothing (`03 (oops 04\n05` -> `[3, 4, 5]`).

**cross-feature-blockers.AC1.5** (backtick spans)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: og-enhanced-cards
  04 -> `[3, 1]`; `` 02 `step 07` 05 `` -> `[2, 5]`; unpaired
  backtick hides nothing (`` 03 `x 04 `` -> `[3, 4]`).

**cross-feature-blockers.AC1.6** (`None`)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: analytics 01,
  plain `None` and `none` -> refs `[]`, typos `[]`.
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: `scanTickets`
  on a `None` ticket -> blockers `[]`.

**cross-feature-blockers.AC1.7** (digits inside words)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: `24h, v2, 03` ->
  `[3]`.

**cross-feature-blockers.AC1.8** (`Also 01` is prose, no warning)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: `Also 01` -> refs
  `[{ num:1 }]`, typos `[]`; og-enhanced-cards 04 typos `[]`.

**cross-feature-blockers.AC1.9** (hyphenated typo warning)
- unit, `test/blockers.test.ts`, Phase 1 Task 3:
  `nwsletter-audit 16` -> refs `[{ num:16 }]`, typos
  `['nwsletter-audit']`.
- unit, `test/resolve.test.ts`, Phase 3 Task 3: `loadSelection`
  emits one `{ kind:'typo', text:'nwsletter-audit' }` warning and
  the ref is own-feature 16.

**cross-feature-blockers.AC1.10** (field extent)
- unit, `test/blockers.test.ts`, Phase 1 Task 3: blank line ends
  the field (`01\n\n02 later` -> `[1]`); next `**Field:**` line
  ends it, bulleted or not (`[1, 2]` and `[1]`); a checklist item
  or heading ends it (`[1]`); missing field -> `[]`.

**cross-feature-blockers.AC1.11** (picker count equals run count)
- unit, `test/resolve.test.ts`, Phase 3 Task 3: held-import-review
  01 (blocked by done `newsletter-audit 16`) and 02 (blocked by
  01): `featureCounts` deepEqual `{ ready:1, total:2,
  badBlockers:0 }`, and `.ready` equals `findReadyTickets(
  loadSelection(scratchDir, ['held-import-review']).tickets)
  .length`.

## AC2: Readiness and reporting

**cross-feature-blockers.AC2.1** (outside done blocker -> ready)
- unit, `test/blockers.test.ts`, Phase 2 Task 1: unselected
  feature, lookup `'done'` -> `{ where:'done', status:'done' }`.
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: `a/02` with a
  `done` ref to `b/01` is in `findReadyTickets`.
- unit, `test/resolve.test.ts`, Phase 3 Task 3: `loadSelection(
  ['held-import-review'])` -> ref `where:'done'`, ticket ready, no
  newsletter-audit tickets in the result.

**cross-feature-blockers.AC2.2** (outside pending blocker -> not
ready, labelled)
- unit, `test/blockers.test.ts`, Phase 2 Task 1: lookup
  `'ready-for-agent'` -> `{ where:'pending', status:... }`.
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: not ready;
  `findBlockedTickets` maps `'a:2'` to the ref; `blockerLabel`
  includes `'b/01'` and `'ready-for-agent'`.
- integration, `test/integration.test.ts`, Phase 2 Task 5:
  `runWavesIsolated` calls `setBlocked` for ticket 2 with
  `[blockerLabel(pendingRef)]`.
- unit, `test/resolve.test.ts`, Phase 3 Task 3: `loadSelection`
  gives a `pending` ref labelled `newsletter-audit/16` with
  `ready-for-agent`; no warning.
- unit, `test/orchestrator.test.ts`, Phase 4 Task 3: finish summary
  includes `blockerLabel(ref)` and `'a/02'`; a failed ticket with a
  pending ref is not listed.
- CLI subprocess, `test/integration.test.ts`, Phase 5 Task 4: the
  AC3.1, AC3.3 and AC3.4 runs print `'other-feat/01'`.

**cross-feature-blockers.AC2.3** (both selected -> earlier wave)
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5:
  `findReadyTickets` returns only `b/01`, then `a/02` once `b/01`
  is done; `dryRun` output puts `b`'s file on `Wave 1:` and `a`'s
  on `Wave 2:`.
- unit, `test/resolve.test.ts`, Phase 3 Task 3: with both features
  selected the ref is `where:'run'`.

**cross-feature-blockers.AC2.4** (ref matching no ticket). Covered
in four phases, one layer each:
- Phase 2 (not ready, row label): unit, `test/blockers.test.ts`
  Task 1 (selected feature without the number -> `missing`); unit,
  `test/orchestrator.test.ts` Task 5 (`a/02` -> `b/09` and `a/03`
  -> `a/09` both not ready, both in `findBlockedTickets`, label
  has `(not found)`); integration, `test/integration.test.ts` Task
  5 (`setBlocked` for ticket 3 gets `[blockerLabel(missingRef)]`).
- Phase 3 (loading and picker): unit, `test/resolve.test.ts` Task 3
  (`newsletter-audit 40` and own `09` -> two `missing` refs, two
  `kind:'missing'` warnings naming the tickets; `badBlockers:1`,
  and a pending outside ref does not raise it); CLI subprocess,
  `test/integration.test.ts` Task 5 (renamed unknown-blocker test:
  ticket stays `ready-for-agent`, no `01-task.log`).
- Phase 4 (finish summary): unit, `test/orchestrator.test.ts` Task
  3 (output includes `blockerLabel(ref)` with `(not found)` and
  `'a/03'`); CLI subprocess, same unknown-blocker test, output
  includes `'99'` and `'not found'`.
- Phase 5 (stop): CLI subprocess, same test, exit 0; its output now
  comes from `renderNothingReady` (decision 5).

**cross-feature-blockers.AC2.5** (A -> in-run B -> outside C)
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5:
  `findBlockedTickets` maps both `'a:1'` and `'a:2'` to `['b:5']`.
- integration, `test/integration.test.ts`, Phase 2 Task 5: ticket
  04 (waits on in-run 05, which waits on outside `other/08`) gets
  `setBlocked` with `[blockerLabel(chainRef)]`.

**cross-feature-blockers.AC2.6** (no cross-feature human match)
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: with `a/02`
  ready-for-human and `b/03` -> `b/02`, `renderFinishSummary` does
  not include `'03-waits.md'` and `findBlockedTickets` has no
  `'b:3'`. Re-run unchanged after Phase 4 Task 3 (decision 4).

**cross-feature-blockers.AC2.7** (cross-feature history)
- unit, `test/orchestrator.test.ts`, Phase 4 Task 4: a `done` entry
  for `b:1` in `.scratch/b/learnings.md` appears in
  `historyFor(<a learnings>, a/02)` (marker string); a same-feature
  blocker entry still appears; a feature with no `learnings.md`
  does not throw.

**cross-feature-blockers.AC2.8** (dry run labels; simulator agrees)
- unit, `test/orchestrator.test.ts`, Phase 2 Task 5: `dryRun` with
  `a/01` (outside done), `a/02` (outside pending), `a/03` (-> a/01):
  `a/01` on `Wave 1:`, `a/03` on `Wave 2:`, `a/02` on no wave line
  and on `Deadlocked tickets:`; the `Tickets:` line for `a/02`
  includes `blockerLabel`; `findReadyTickets` equals wave 1. Plus
  `blockerSatisfied` cases for all four `where` values.

**cross-feature-blockers.AC2.9** (typos in the finish summary)
- unit, `test/orchestrator.test.ts`, Phase 4 Task 3: a typo warning
  for `a/04` -> output includes `'nwsletter-audit'` and `'a/04'`; a
  clean run is still one line.
- CLI subprocess, `test/integration.test.ts`, Phase 4 Task 3:
  in-place run where `02-typo.md` says `nwsletter-audit 01` (falls
  back to done own 01, so 02 runs and the stop does not fire):
  exit 0, output includes `'nwsletter-audit'`.

## AC3: Zero-ready stop

Unit tests for the rule and text: `test/orchestrator.test.ts`,
Phase 5 Task 2. `nothingReady`: `[]`, all done and human-only ->
false; a blocked ready-for-agent ticket -> true; plus one unblocked
ticket -> false. `renderNothingReady`: includes the pending ref
label; reports a two-ticket cycle as `Deadlocked tickets`; reports
a human blocker as human work, not a cycle; names a `needs-triage`
blocker. CLI tests below are in `test/integration.test.ts`, Phase 5
Task 4, using the `twoFeatureRepo` helper.

**cross-feature-blockers.AC3.1** (first scan stop)
- unit: the `nothingReady` and `renderNothingReady` cases above.
- CLI subprocess: blocked by pending `other-feat 01`: exit 0,
  output has `'other-feat/01'`, no `nightralph--*` branch, HEAD is
  `main`, `01-first.md` still `ready-for-agent`.

**cross-feature-blockers.AC3.2** (before provider preflight)
- CLI subprocess: same setup, provider
  `'nightralph-no-such-provider'`: exit 0, no `nightralph--*`
  branch. Non-resuming runs only (decision 2).

**cross-feature-blockers.AC3.3** (`--dry-run`)
- unit: `renderNothingReady` cases above.
- CLI subprocess: same setup with `--dry-run`: exit 0, output has
  `'other-feat/01'`. Updated deadlock test: exit 0, output has
  `'Deadlocked tickets'`, `'test-feat/01'`, `'test-feat/02'`.

**cross-feature-blockers.AC3.4** (resume re-scan stop)
- CLI subprocess: 01 ready on `main`, blocked on
  `nightralph--test-feat`: exit 0, HEAD is `main`, the integration
  branch still exists, output has `'other-feat/01'`.
- CLI subprocess (decision 2): blocked on `main` with an existing
  `nightralph--test-feat` at the same commit: exit 0, HEAD `main`,
  output has `'Resumed'` and `'other-feat/01'`, proving the stop
  came from the re-scan.

**cross-feature-blockers.AC3.5** (nothing ready-for-agent left on
resume)
- unit: `nothingReady` all-done -> false.
- CLI subprocess: 01 done on the integration branch: exit 0, HEAD
  stays `nightralph--test-feat` (the run reached
  `runWavesIsolated`; its review pass is skipped by the existing
  skip rule because only `.scratch` changed).

**cross-feature-blockers.AC3.6** (a ready ticket -> run as today)
- unit: `nothingReady` with one unblocked ticket -> false.
- CLI subprocess: blocker `other-feat 01` is done, with
  `--retry-delay 0 --test-cmd true --no-review`: exit 0,
  `nightralph--test-feat` exists and its `01-first.md` has
  `**Status:** done`.

## AC4: Docs and contracts

**cross-feature-blockers.AC4.1** -- human verification.
Justification: these are prose docs, and the user's rule is "do
not write tests for docs". Approach: after Phase 6 Task 1, read the
diff of `src/skills/to-tickets/SKILL.md` and
`src/docs-templates/issue-tracker.md` and confirm each doc says
(1) blockers are numbers plus `<feature> <NN>`, with the feature
repeated before each number; (2) text in parentheses is ignored;
(3) the list may wrap and ends at a blank line, `**Field:**` line,
heading or checklist item; (4) `03-05` is not expanded; (5) no
mention of titles remains. Run `npm run build` and confirm both
files are copied into `dist/`.

**cross-feature-blockers.AC4.2** -- split.
- Docs half, human verification (same justification). Read
  `AGENTS.md` against the Phase 6 Task 2 list: a blockers module
  contract, a resolve module contract with `loadSelection` and the
  picker label, the orchestrator changes (`Ticket.blockers`,
  `findBlockedTickets`, `blockerLabel`, `renderFinishSummary`
  warnings, `historyFor`, `nothingReady`), the zero-ready stop
  under the CLI contract (including the resume skip and that
  provider preflight runs after it), the display `blocked` text,
  and a new `Last verified:` date. Check prose rules: no em dashes,
  no arrow characters.
- Build/test half, operational check: `grep -n "src/blockers.ts"
  package.json` and `grep -n "blockers" scripts/test.sh` each
  return one match; `npm run build` emits `dist/blockers.js`
  (`ls dist/blockers.js`); `npm test` output shows the
  `blockers` suite running.
