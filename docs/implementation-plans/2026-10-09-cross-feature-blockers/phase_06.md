# Cross-Feature Blockers Implementation Plan -- Phase 6

**Goal:** Ticket authors and agents know the `<feature> <NN>` form,
and AGENTS.md matches the code.

**Architecture:** Documentation only. The two ticket-format docs
shipped to target projects (`to-tickets` skill and the
`issue-tracker.md` template) describe the field; the repo's own
`AGENTS.md` contracts describe the new module, loader, changed
orchestrator functions and CLI behavior.

**Tech Stack:** Markdown

**Scope:** Phase 6 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements (verified by review, no tests for docs):

### cross-feature-blockers.AC4: Docs and contracts (verified by review)
- **cross-feature-blockers.AC4.1:** `to-tickets/SKILL.md` and
  `issue-tracker.md` describe numbers plus `<feature> <NN>`, say
  that notes in parentheses are ignored, and say that lists may wrap
- **cross-feature-blockers.AC4.2:** AGENTS.md covers
  `src/blockers.ts`, `loadSelection`, the changed orchestrator
  contracts, the zero-ready stop and the picker label;
  `src/blockers.ts` is in `build-esm` and its test file is in
  `TESTS`

**Verifies:** None (documentation; the `build-esm` / `TESTS` half
of AC4.2 was done in Phase 1 and is re-checked here)

---

## Writing rules (from the user's global instructions)

- No em dashes; use `--`. No arrow characters; use `->`.
- No emojis. Prefer prose over nested lists.
- Do not write tests for docs.
- Before editing AGENTS.md or a skill, invoke the
  `writing-for-agents` skill and follow it.

## Codebase facts the executor needs

`src/skills/to-tickets/SKILL.md` (107 lines):
- L47: `- **Blocked by**: which other tickets (if any) must complete
  first`
- L62: local-files rule: each file's "Blocked by" lists the
  "numbers or titles" it depends on; files numbered from `01` in
  dependency order.
- L77: template line `**Blocked by:** the numbers/titles of the
  tickets that gate this one, or "None (can start immediately)".`
- L101-103: `## Blocked by` heading in the real-tracker issue
  template, with `- A reference to each blocking ticket, or "None
  (can start immediately)".`

`src/docs-templates/issue-tracker.md` (44 lines):
- L14-16: dependencies are a `**Blocked by:**` line near the top of
  each issue file, listing ticket numbers or `None`.
- L36-38: a `**Touches:**` line goes directly under
  `**Blocked by:**`.

The parser's actual rules (Phase 1): bare numbers are the ticket's
own feature; `<feature> <NN>` names another feature, where
`<feature>` is a `.scratch/<feature>/` directory name and must be
written directly before each number it applies to (so
`newsletter-audit 15, newsletter-audit 16`, not
`newsletter-audit 15, 16`); text in paired `(...)` and paired backticks is
ignored; the list may wrap onto following lines and ends at a blank
line, the next `**Field:**` line, a heading or a checklist item;
`03-05` is read as 3 and 5; `None` means no blockers. A
hyphenated word before a number that names no feature dir is
reported as a likely typo.

`AGENTS.md` (repo root): sections `## Project Structure`,
`## Contracts` with one `###` per module (setup, CLI, orchestrator,
testcmd, preflight, display, worktree, progress, learnings, retry,
rules, review, merge). Header line `Last verified: 2026-10-08`.
There is no resolve module contract yet.

---

<!-- START_TASK_1 -->
### Task 1: Ticket-format docs

**Files:**
- Modify: `src/skills/to-tickets/SKILL.md:47,62,77,101-103`
- Modify: `src/docs-templates/issue-tracker.md:14-16`

**Changes:**
- L47: say the field lists ticket numbers, and `<feature> <NN>` for
  a ticket in another feature.
- L62: replace "numbers or titles" with numbers (drop "titles";
  the parser never read titles); add that a blocker in another
  feature is written `<feature> <NN>`, where `<feature>` is the
  `.scratch/<feature>/` directory name, repeated before each such
  number; notes go in parentheses and are ignored; the list may
  wrap onto the next lines.
- L77: template line becomes numbers and `<feature> <NN>` refs, or
  `None (can start immediately)`; mention that a parenthetical note
  is allowed.
- L101-103 (real-tracker template): keep it tracker-neutral, but
  replace "a reference to each blocking ticket" so it does not
  suggest titles.
- In both docs (L62 of the skill and the `issue-tracker.md`
  paragraph) add: "List every number; a range like `03-05` is not
  expanded. Repeat the feature name before each number in another
  feature." and "The list ends at a blank line, the next
  `**Field:**` line, a heading or a checklist item."
- `issue-tracker.md` L14-16: same rules in one short paragraph,
  with one example line such as
  `**Blocked by:** 01, 02, newsletter-audit 16 (shares the import
  route)`. Keep the `**Touches:**` guidance at L36-38 as is (it
  ends the field, which is now documented behavior).

**Verification:** `npm run build` copies both files into `dist/`
(the `copy` script); read the diff for the AC4.1 points: numbers
plus `<feature> <NN>`, parentheses ignored, lists may wrap, ranges
not expanded.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: AGENTS.md contracts

**Files:**
- Modify: `AGENTS.md`

**Changes:**
1. `Last verified:` -> the date of this edit.
2. Project Structure: add `- \`src/blockers.ts\` -- Blocked-by field
   parsing and ref resolution (pure)` near the other module lines.
3. New `### blockers module (\`src/blockers.ts\`)` contract:
   Exposes `RawRef`, `BlockerParse`, `BlockerWhere`, `BlockerRef`,
   `BlockerWarning`, `parseBlockerField(body, knownFeatures)`,
   `resolveBlockers(raw, ownFeature, selected, lookup)`,
   `provisionalRefs(raw, ownFeature)`. State the parse rules (field
   extent including the heading and checklist stops, paired
   `(...)` and backtick stripping with unpaired delimiters left as
   text, `None`, whole-word numbers and `03-05` as 3 and 5, the
   word-directly-before rule, typo rule, de-duplication) and the four `where` values. Guarantees: pure,
   imports nothing, never throws.
4. New `### resolve module (\`src/resolve.ts\`)` contract:
   `loadSelection(scratchDir, names)` (known features from
   `<scratchDir>/*/issues`, selected features scanned, unselected
   ones only when referenced and once, every ref resolved, warnings
   for `missing` refs and typos; tickets of selected features only),
   `LoadedSelection`, `BlockerWarning` (re-exported),
   `featureCounts` / `featureChoiceLabel` (picker label
   `<name> (R/T ready[, N bad blocker(s)])`, counts as if the
   feature ran alone, outside-pending refs not counted as bad),
   plus the existing `findFeatureDirs`, `resolveIssuesDir`.
5. Orchestrator contract updates:
   - Exposes list: add `blockerSatisfied`, `blockerLabel`,
     `historyFor`, `nothingReady`, `renderNothingReady`; remove
     `parseBlockers` if listed.
   - `scanTickets(dir, feature?, knownFeatures?)`: refs are
     provisional `where:'run'`.
   - `Ticket.blockers` is `BlockerRef[]`.
   - `findReadyTickets`, `simulateWaves`, `detectDeadlocks` decide
     with `blockerSatisfied`.
   - Rewrite the `findBlockedTickets` entry: returns
     `Map<string, BlockerRef[]>`; `pending`/`missing` refs are
     dead; `done` refs end the walk; `run` refs follow the old
     rules and the walk crosses features; A waiting on in-run B
     waiting on outside pending C is blocked by C.
   - `blockerLabel(ref)` forms (`a/16`,
     `a/16 (<status>, not in run)`, `a/16 (not found)`), and that
     `reportBlocked` uses `ticketLabel` for in-run blockers.
   - `renderFinishSummary(tickets, totalCompleted, failedKeys,
     warnings?)`: humans matched by `ticketKey`; the
     outside/missing/typo paragraph.
   - `runWaves` trailing `warnings` and `runWavesIsolated`
     `opts.warnings`.
   - Learnings: history includes a cross-feature blocker's latest
     `done` entry from `../<feature>/learnings.md`.
   - `nothingReady` / `renderNothingReady` (rule: nothing ready and
     a ready-for-agent ticket remains; text includes cycles).
6. CLI contract updates:
   - Zero-ready stop: after the first scan, before provider
     preflight and before `--dry-run` output, a run where
     `nothingReady` holds prints `renderNothingReady` and exits 0
     with no branch created or checked out. After the resume
     re-scan the same rule checks the launch branch back out
     (shared with `failStaleResume`), prints the explanation
     naming the integration branch, and exits 0. When the run will
     resume an existing integration branch, the first-scan check is
     skipped and only the re-scan decides. When no ready-for-agent
     ticket remains, the run continues as before.
     Update the "Provider preflight" bullet so it says it runs
     after this stop.
   - `loadTickets` resolves blockers through `loadSelection` and
     returns `warnings`; unknown blockers are no longer stripped.
   - Picker label text.
7. Display contract: the `blocked` status now also covers tickets
   waiting on a ticket outside the run or on a ref that matches no
   ticket, and the `(blocked by ...)` row text can carry
   `blockerLabel` forms such as `a/16 (ready-for-agent, not in
   run)` and `a/16 (not found)`. Orchestrator "Session list"
   bullet: `setBlocked` receives `ticketLabel` names for in-run
   blockers and `blockerLabel` text for outside or missing ones.
8. Check the Commands section still matches `package.json`
   (`build-esm` second esbuild list now includes
   `src/blockers.ts`) and `scripts/test.sh` (`TESTS` includes
   `blockers`); no edit needed if it only states the rule.

**Verification:**
Run: `npm run build && npm test && npm run lint`
Expected: all pass.

Run: `grep -n "src/blockers.ts" package.json` and
`grep -n "blockers" scripts/test.sh`
Expected: one match each.

Read AGENTS.md against the AC4.2 list.

**Commit:** `docs: document cross-feature blockers`
<!-- END_TASK_2 -->
