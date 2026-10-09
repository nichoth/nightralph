# Cross-Feature Blockers Design

## Summary
nightralph runs one agent per ticket, where each ticket is a markdown
file under `.scratch/<feature>/issues/` with a `**Blocked by:**` field
naming the tickets that must finish first. Today that field is read
as a list of bare numbers and every number is assumed to belong to the
ticket's own feature. A ticket that waits on another feature's work
(for example `newsletter-audit 16`) is misread, loses its dependency,
or gets its blocker silently dropped. A run in which every ticket is
blocked also creates and checks out an integration branch before it
discovers there is nothing to do.

The design resolves each blocker reference once, when tickets are
loaded, and attaches the result to the ticket. A new pure module,
`src/blockers.ts`, parses the field (ignoring parenthetical notes and
backtick spans, reading wrapped lines, de-duplicating) and classifies
each reference as in the run, done outside the run, pending outside
the run, or missing. A single loader, `loadSelection`, is shared by
the feature picker and the CLI so both see the same tickets and
counts. The existing readiness functions keep their shape but key
blockers by the blocker's own feature, so a not-done or unknown
blocker keeps its dependents blocked, and row labels, the dry run, the
finish summary and the learnings history all name the blocker. Last,
the CLI checks for "nothing ready" before touching any branch and
exits 0 with an explanation, and the docs and AGENTS.md contracts are
updated to match.

## Definition of Done

1. One shared normalization function, called by both the picker
   (`src/resolve.ts`) and `loadTickets`, turns each ticket's
   Blocked-by text into de-duplicated `{ feature, num }` refs. The
   parser strips `(...)` and backtick spans, reads wrapped lines,
   and treats a word as a feature only when
   `.scratch/<word>/issues` exists. A lowercase hyphenated word
   (shaped like a feature dir name) that names no dir gets a typo
   warning.
2. Readiness, `findBlockedTickets`, dry run, the finish summary
   and learnings history all key blockers by the blocker's own
   feature. An unknown blocker, or a not-done blocker in an
   unselected feature, keeps its dependents blocked. The row
   label, the finish summary and the picker label name it.
3. When no ticket is ready, the run explains why and exits 0
   before creating or checking out the integration branch. On
   resume it checks the launch branch back out first.
4. `to-tickets/SKILL.md` and `issue-tracker.md` document the
   `<feature> <NN>` form, AGENTS.md contracts are updated, and
   tests cover the rebase.blog cases (cross-feature, the 04
   duplicate, the wrapped list in newsletter-audit 18).

Out of scope: editing the rebase.blog ticket files themselves.

## Acceptance Criteria

### cross-feature-blockers.AC1: Parsing and one loading path
- **cross-feature-blockers.AC1.1 Success:** `newsletter-audit 16`
  yields `{ feature:'newsletter-audit', num:16 }` when
  `.scratch/newsletter-audit/issues` exists
- **cross-feature-blockers.AC1.2 Success:**
  `01, 02, 03 (03 edits ...)` yields 1, 2, 3, each once
- **cross-feature-blockers.AC1.3 Success:** a list wrapped onto the
  next line yields every number (newsletter-audit 18 -> 02 through
  17)
- **cross-feature-blockers.AC1.4 Success:** a parenthetical spanning
  lines contributes no numbers (newsletter-audit 16 -> 14, 15)
- **cross-feature-blockers.AC1.5 Success:** backtick spans
  contribute no numbers
- **cross-feature-blockers.AC1.6 Success:**
  `None (can start immediately)` yields no refs
- **cross-feature-blockers.AC1.7 Edge:** digits inside words
  (`24h`, `v2`) are not refs
- **cross-feature-blockers.AC1.8 Edge:** a plain word before a
  number (`Also 01`) is prose; the number refers to the ticket's own
  feature and no warning is produced
- **cross-feature-blockers.AC1.9 Failure:** a hyphenated word that
  names no feature dir produces a typo warning, and its number
  refers to the ticket's own feature. (Amended 2026-10-09 during
  Phase 1 review: only lowercase feature-shaped words, letters and
  digits joined by hyphens with at least one letter, warn, so a doc
  ID such as `FDR-018` gives no warning.)
- **cross-feature-blockers.AC1.10 Edge:** the field ends at a blank
  line or the next `**Field:**` line; numbers after it are ignored
- **cross-feature-blockers.AC1.11 Success:** the picker's ready
  count for a feature equals the ready count of a run that selects
  only that feature (both come from `loadSelection`)

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
- **cross-feature-blockers.AC2.5 Edge:** if A waits on in-run B and
  B waits on outside pending C, A is reported blocked by C
- **cross-feature-blockers.AC2.6 Edge:** a ready-for-human `a/02`
  does not mark `b/03` as blocked by a human just because `b/03`
  lists `02`
- **cross-feature-blockers.AC2.7 Success:** a ticket's prompt
  history includes a cross-feature blocker's latest `done` entry
  from that feature's `learnings.md`
- **cross-feature-blockers.AC2.8 Success:** the dry run lists
  blocker labels, and `simulateWaves` and `detectDeadlocks` agree
  with `findReadyTickets`
- **cross-feature-blockers.AC2.9 Success:** typo warnings appear in
  the finish summary

### cross-feature-blockers.AC3: Zero-ready stop
- **cross-feature-blockers.AC3.1 Success:** when the first scan
  finds nothing ready, the run prints why and exits 0, and the
  branch is unchanged, with no `nightralph--*` branch created
- **cross-feature-blockers.AC3.2 Edge:** the stop happens before
  provider preflight, so an unknown provider with nothing ready
  still exits 0
- **cross-feature-blockers.AC3.3 Success:** `--dry-run` with
  nothing ready exits 0 and prints the explanation
- **cross-feature-blockers.AC3.4 Success:** when the resume
  re-scan finds a blocked ready-for-agent ticket and nothing ready,
  the run checks out the launch branch and exits 0
- **cross-feature-blockers.AC3.5 Edge:** when the resume re-scan
  finds no ready-for-agent tickets left, the run continues into the
  review pass and stays on the integration branch
- **cross-feature-blockers.AC3.6 Success:** with at least one
  ticket ready, the run proceeds as today

### cross-feature-blockers.AC4: Docs and contracts (verified by review)
- **cross-feature-blockers.AC4.1:** `to-tickets/SKILL.md` and
  `issue-tracker.md` describe numbers plus `<feature> <NN>`, say
  that notes in parentheses are ignored, and say that lists may wrap
- **cross-feature-blockers.AC4.2:** AGENTS.md covers
  `src/blockers.ts`, `loadSelection`, the changed orchestrator
  contracts, the zero-ready stop and the picker label;
  `src/blockers.ts` is in `build-esm` and its test file is in
  `TESTS`

## Glossary
- **Ticket**: A markdown file in `.scratch/<feature>/issues/`
  describing one unit of work for an agent, with a status, a
  checklist and a `**Blocked by:**` field.
- **Feature**: A named group of tickets, stored as a directory
  `.scratch/<feature>/` with an `issues` subdirectory and a spec.
- **Blocked by / blocker**: The ticket field listing tickets that
  must be done before this one can start. A blocker is one entry in
  that list.
- **`<feature> <NN>` form**: The new way to name a blocker in
  another feature, such as `newsletter-audit 16`. A bare number still
  means a ticket in the same feature.
- **Ready (ready-for-agent)**: A ticket status meaning an agent may
  pick it up. A ticket is "ready" in a run when its status allows it
  and all its blockers are satisfied.
- **ready-for-human**: A ticket status meaning an agent must not
  work on it. Tickets that depend on one are blocked until a person
  finishes it.
- **Selected / unselected feature**: Selected features are those the
  user chose for this run (by `--spec` or the picker). Tickets in
  unselected features are not run, but their statuses still matter
  when they are blockers.
- **Wave**: A batch of tickets whose blockers are all satisfied, run
  in parallel. A later wave starts only after the earlier one is
  merged.
- **Integration branch**: The `nightralph--<feature>` branch (or
  `nightralph--all`) that a run creates or resumes from the default
  branch and merges ticket work into.
- **Launch branch**: The branch the user ran the CLI from, which is
  checked back out when a run stops early on a resumed integration
  branch.
- **Resume re-scan**: When a run resumes an existing integration
  branch, tickets are loaded a second time after the checkout so
  their statuses reflect that branch.
- **Picker**: The interactive feature chooser, `resolveIssuesDir` in
  `src/resolve.ts`, which shows a ready count per feature.
- **Resolved refs**: The design's central approach. Each blocker
  reference is parsed and classified once at load time, so the
  readiness functions stay pure and never read files.
- **`where` (`run`, `done`, `pending`, `missing`)**: How a blocker
  was classified. `run` is a ticket in this run (its live status
  decides); `done` is outside the run and finished; `pending` is
  outside the run and unfinished, so dead this session; `missing`
  matches no ticket.
- **Typo warning**: A warning for a lowercase hyphenated word before
  a number that matches no feature directory, such as a misspelled
  feature name.
- **`loadSelection`**: The single function that scans the selected
  features, scans an unselected feature only when a blocker points
  into it, resolves every blocker, and returns tickets plus warnings.
- **`findReadyTickets` / `findBlockedTickets`**: Orchestrator
  functions that decide which tickets can run now and which are
  blocked by a dead upstream ticket.
- **`simulateWaves` / `detectDeadlocks`**: Dry-run helpers that
  predict wave order and find tickets that can never run. They must
  agree with `findReadyTickets`.
- **`ticketKey(feature, num)`**: The compound identity
  `<feature>:<num>` used as the key in internal maps, so numbers in
  different features do not collide.
- **`ticketLabel` / `blockerLabel`**: Functions that render the
  human-readable `<feature>/<NN>` name for a ticket or blocker
  (blocker labels may add a note like `(not found)`).
- **Finish summary (`renderFinishSummary`)**: The text printed at the
  end of a run, counting completed, failed and human-needed tickets;
  this design adds blocked-from-outside, missing and typo reporting.
- **Zero-ready stop**: The new early exit: when no ticket is ready,
  the CLI explains why and exits 0 before creating or checking out an
  integration branch.
- **Learnings (`learnings.md`)**: A per-feature log of attempt
  results. A ticket's prompt history includes the latest `done` entry
  of each blocker, now including blockers in other features.
- **Provider preflight**: The check that the agent executable (such
  as `claude`) exists on PATH, which now runs after the zero-ready
  stop.
- **FCIS (pure core, effectful edge)**: Keeping logic in pure
  functions and side effects (file and git access) in a thin outer
  layer. `src/blockers.ts` is fully pure, like `src/learnings.ts` and
  `src/retry.ts`.
- **`fitLine`**: The display helper that clips a row to the terminal
  width; it can cut a long `(blocked by ...)` label.
- **`spawnCli`**: The test helper that runs the built CLI
  (`dist/index.js`) as a subprocess in integration tests.
- **`build-esm` / `TESTS`**: The esbuild script in `package.json` and
  the test-file list in `scripts/test.sh`. Both list files
  explicitly, so new modules and test files must be added.
- **rebase.blog tickets**: The real ticket set whose Blocked-by
  fields (cross-feature, the duplicate in held-import-review 04, the
  wrapped list in newsletter-audit 18) motivate the design and serve
  as test fixtures.

## Architecture

Approach: resolved refs. Blocker references are parsed and resolved
once, when tickets are loaded, and each reference carries its
resolution. The pure readiness functions keep their signatures and
never read files.

### Parsing (`src/blockers.ts`, new, pure)

`parseBlockerField(body, knownFeatures)` reads the `**Blocked by:**`
field and returns raw references plus typo warnings.

- The field starts after `**Blocked by:**` and runs across
  continuation lines until a blank line or the next `**Field:**`
  line (for example `**Touches:**`, which `issue-tracker.md` puts
  directly under it).
- `(...)` spans, including ones that cross lines, and backtick spans
  are removed before tokenizing.
- When the remaining text starts with `None`, there are no refs.
- A number counts only as a whole word, so `24h` and `v2` are not
  refs.
- The word directly before a number is its feature when that word is
  in `knownFeatures` (the names of `.scratch/<name>/issues` dirs).
  Any other word is prose and the number refers to the ticket's own
  feature. A lowercase hyphenated word that is not a known feature
  is reported in `typos`. A feature before a range (`03-05`)
  applies to both ends; in a comma list it applies only to the
  number right after it. (Both rules amended 2026-10-09 during
  Phase 1 review.)
- Refs are de-duplicated by `(feature, num)`.

`resolveBlockers(raw, ownFeature, selected, lookup)` turns raw refs
into `BlockerRef`s. `lookup` returns the status of a ticket in a
feature outside the run, or `undefined` when no such ticket exists.

```ts
export type RawRef = {
    feature?:string;  // absent -> the ticket's own feature
    num:number;
}

export type BlockerParse = {
    refs:RawRef[];
    typos:string[];   // feature-shaped words that name no feature
}

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

export function parseBlockerField (
    body:string,
    knownFeatures:ReadonlySet<string>
):BlockerParse

export function resolveBlockers (
    raw:ReadonlyArray<RawRef>,
    ownFeature:string,
    selected:ReadonlyMap<string, ReadonlySet<number>>,
    lookup:(feature:string, num:number) => string|undefined
):BlockerRef[]
```

`selected` maps each feature in the run to its ticket numbers, so a
ref to a selected feature with no matching number resolves to
`missing`. `src/blockers.ts` imports nothing from
`src/orchestrator.ts`, matching `src/learnings.ts` and
`src/retry.ts`.

`Ticket.blockers` in `src/orchestrator.ts` becomes `BlockerRef[]`.
`scanTickets(dir, feature, knownFeatures?)` parses with
`parseBlockerField` and fills `blockers` provisionally, every ref
`where:'run'`, so a bare scan keeps today's behavior: a ref to a
ticket that is not in the list is never satisfied. `parseBlockers`
is removed.

### Loading (`src/resolve.ts`)

`loadSelection` is the single place where tickets get their resolved
blockers. Both the picker and the CLI's `loadTickets` call it.

```ts
export type BlockerWarning = {
    ticket:string;    // ticketLabel of the ticket with the problem
    kind:'missing'|'typo';
    text:string;      // the ref label or the unknown word
}

export type LoadedSelection = {
    tickets:Ticket[];
    warnings:BlockerWarning[];
}

export function loadSelection (
    scratchDir:string,
    names:ReadonlyArray<string>
):LoadedSelection
```

It lists `<scratchDir>/*/issues` for `knownFeatures`, scans each
selected feature, and scans an unselected feature only when a ref
points into it (once per feature, cached). It lives in `resolve.ts`,
not `blockers.ts`, because it calls `scanTickets` and
`orchestrator.ts` imports `blockers.ts`.

`loadTickets` in `src/index.ts` calls `loadSelection` with the names
of the selections whose dir and spec exist, keeps its `missing`
handling, and drops the block that removes unknown blocker numbers.
It returns the warnings with the tickets. The resume re-scan calls
it again after the checkout, so it reads the integration branch.

### Readiness and reporting (`src/orchestrator.ts`)

```ts
export function blockerSatisfied (
    ref:BlockerRef,
    doneKeys:ReadonlySet<string>
):boolean
// 'run' -> doneKeys has ticketKey(ref.feature, ref.num)
// 'done' -> true; 'pending' | 'missing' -> false

export function blockerLabel (ref:BlockerRef):string
// 'run' | 'done' -> newsletter-audit/16
// 'pending'      -> newsletter-audit/16 (ready-for-agent, not in run)
// 'missing'      -> held-import-review/16 (not found)

export function findBlockedTickets (
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>
):Map<string, BlockerRef[]>
```

- `findReadyTickets`, `simulateWaves` and `detectDeadlocks` all
  decide readiness with `blockerSatisfied`; the two inline copies go
  away. In-run refs key by the blocker's own feature, so when both
  features are selected the wave order handles a cross-feature
  chain.
- `findBlockedTickets` returns dead refs instead of keys. `pending`
  and `missing` refs are dead; `done` refs end the walk; `run` refs
  follow today's rules (dead when failed or in a status other than
  done or ready-for-agent, otherwise the walk continues). A ticket
  waiting on an in-run chain that ends at an outside pending ticket
  is reported blocked by that outside ticket.
- `reportBlocked` passes `blockerLabel` strings to `setBlocked`.
- `listTickets` (dry run) prints the labels.
- `renderFinishSummary` matches the ready-for-human paragraph by
  `ticketKey` instead of the bare number, and adds a paragraph that
  lists tickets blocked from outside the run (select that feature or
  finish it first), missing refs (fix the `**Blocked by:**` line),
  and typo warnings. It gains a `warnings` argument for the typos.
- `buildHistory` reads a cross-feature blocker's `done` entry from
  that feature's `learnings.md`, found as
  `../<ref.feature>/learnings.md` relative to the ticket's own
  feature dir (derived from `ticket.filepath`).

### Zero-ready stop (`src/index.ts`, `runExecute`)

- First scan: right after `loadTicketsOrExit` and its empty-list
  exit, and before provider preflight, when `findReadyTickets`
  returns nothing, the CLI prints a line saying nothing can run plus
  `renderNothingReady(tickets, warnings)` (the same body as the
  finish summary) and exits 0. No branch is created or checked out.
  `--dry-run` stops the same way.
- Resume re-scan: after the existing `failStaleResume` checks, when
  nothing is ready and at least one ready-for-agent ticket remains
  (so something is blocked), `stopNothingReady(plan, ...)` checks
  out the launch branch, prints the same text naming the integration
  branch, and exits 0. It shares the checkout code with
  `failStaleResume`, which still exits 2. When no ready-for-agent
  ticket remains, the run falls through to `runWavesIsolated` as
  today, so an unreviewed finished branch still gets its review
  pass.

### Picker (`src/resolve.ts`, `resolveIssuesDir`)

Each feature's label comes from `loadSelection(scratchDir, [name])`:
the ready count is `findReadyTickets` over that result, so it means
"ready if this feature runs alone", which is the zero-ready stop's
rule for a single feature. When the feature has missing refs, the
label adds them: `held-import-review (0/6 ready, 1 bad blocker)`.
Outside-pending refs are not counted as bad.

## Existing Patterns

- Pure core, effectful edge: `src/learnings.ts` and `src/retry.ts`
  are small modules of pure functions plus a few effectful helpers
  that import no values from `src/orchestrator.ts`. `src/blockers.ts`
  follows that shape and stays fully pure.
- Compound identity: every internal map keys tickets by
  `ticketKey(feature, num)`. This design applies that key to blocker
  refs too, which is where same-feature assumptions crept in
  (`findReadyTickets`, `simulateWaves`, `detectDeadlocks`,
  `findBlockedTickets`, `buildHistory`, and the bare-number
  `humanNums` set in `renderFinishSummary`).
- Labels: `ticketLabel` renders `<feature>/<NN>`; `blockerLabel`
  uses the same form, so a blocker reads the same in a row, the
  summary and the dry run.
- Exit paths: `failStaleResume` already checks the launch branch
  back out before exiting; `stopNothingReady` reuses that checkout.
  `loadTickets` already returns problems (`missing`) for the caller
  to act on; `warnings` follows that.
- Per-feature files: `learningsPathFor(progressPath)` puts
  `learnings.md` beside each feature's `progress.md`; the
  cross-feature history read uses the same layout.
- Tests: suites use temp-dir `.scratch` trees written by helpers
  (`test/orchestrator.test.ts`, `test/resolve.test.ts`,
  `test/integration.test.ts`), CLI subprocess tests use `spawnCli`,
  and git repos in tests are initialized hermetically (the shared
  `info/exclude` must never be written).

Divergence: `findBlockedTickets` changes its return value from keys
to refs, because a ticket outside the run has no `Ticket` to look a
key up in. Its one caller, `reportBlocked`, changes with it.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Blocker field parser
**Goal:** Parse `**Blocked by:**` into de-duplicated raw refs with
cross-feature names, prose stripped and wrapped lines read.

**Components:**
- `src/blockers.ts` (new): `RawRef`, `BlockerParse`,
  `parseBlockerField`
- `package.json` `build-esm`: add `src/blockers.ts` to the second
  esbuild call
- `scripts/test.sh`: add `blockers` to `TESTS`
- `test/blockers.test.ts` (new), with Blocked-by fields copied from
  the rebase.blog tickets as fixtures

**Dependencies:** None

**Done when:** `npm run build` emits `dist/blockers.js`, and tests
for cross-feature-blockers.AC1.1 through AC1.10 pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Resolved refs and readiness
**Goal:** Tickets carry `BlockerRef[]`, and every readiness decision
keys blockers by the blocker's own feature.

**Components:**
- `src/blockers.ts`: `BlockerWhere`, `BlockerRef`, `resolveBlockers`
- `src/orchestrator.ts`: `Ticket.blockers` type, `scanTickets` uses
  `parseBlockerField`, `parseBlockers` removed, `blockerSatisfied`,
  `findReadyTickets`, `simulateWaves`, `detectDeadlocks`,
  `findBlockedTickets` (returns refs), `reportBlocked`
- Fixture updates in `test/orchestrator.test.ts`,
  `test/learnings.test.ts`, `test/review-integration.test.ts`,
  `test/worktree.test.ts`, `test/progress.test.ts` (`blockers:[]`
  stubs and `number[]` helpers)

**Dependencies:** Phase 1

**Done when:** The build is green and tests for
cross-feature-blockers.AC2.1, AC2.2, AC2.3, AC2.4, AC2.5 and AC2.8
pass at the function level (inline `BlockerRef`s).
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: One loading path
**Goal:** The picker and the run get tickets, resolutions and
warnings from the same function.

**Components:**
- `src/resolve.ts`: `BlockerWarning`, `LoadedSelection`,
  `loadSelection`; `resolveIssuesDir` labels use it and show the bad
  blocker count
- `src/index.ts`: `loadTickets` calls `loadSelection`, drops the
  unknown-blocker filter, returns `warnings`
- `test/resolve.test.ts`: `loadSelection` over temp `.scratch`
  trees (selected, unselected done, unselected pending, missing,
  typo)

**Dependencies:** Phase 2

**Done when:** Tests for cross-feature-blockers.AC1.11, AC2.1,
AC2.2 and AC2.4 pass through `loadSelection` and the picker label
logic.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Labels, summary and history
**Goal:** Every blocked ticket names what blocks it, and the finish
summary explains outside, missing and typo cases.

**Components:**
- `src/orchestrator.ts`: `blockerLabel`; `reportBlocked`,
  `listTickets` use it; `renderFinishSummary` keys humans by
  `ticketKey`, takes `warnings`, adds the outside/missing/typo
  paragraph; `runWaves` and `runWavesIsolated` pass warnings
  through to it; `buildHistory` reads cross-feature learnings
- `src/index.ts`: passes `warnings` into the runners
- Tests in `test/orchestrator.test.ts` and
  `test/learnings.test.ts`

**Dependencies:** Phase 3

**Done when:** Tests for cross-feature-blockers.AC2.2, AC2.4,
AC2.6, AC2.7 and AC2.9 pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Zero-ready stop
**Goal:** A run with nothing ready explains why and exits 0 without
touching a branch.

**Components:**
- `src/orchestrator.ts`: `renderNothingReady`
- `src/index.ts`: first-scan check before provider preflight;
  `stopNothingReady` after the resume re-scan, sharing checkout code
  with `failStaleResume`
- `test/integration.test.ts`: CLI subprocess cases over a temp repo
  with two features

**Dependencies:** Phase 4

**Done when:** `npm run build && npm test` pass, including tests
for cross-feature-blockers.AC3.1 through AC3.6.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Docs and contracts
**Goal:** Ticket authors and agents know the `<feature> <NN>` form,
and AGENTS.md matches the code.

**Components:**
- `src/skills/to-tickets/SKILL.md` (lines 47, 62, 77, 101): numbers
  and `<feature> <NN>`, the feature is a `.scratch` dir name, notes
  go in parentheses, the list may wrap; drop "titles"
- `src/docs-templates/issue-tracker.md` (the `**Blocked by:**`
  bullet): the same
- `AGENTS.md`: Project Structure entry for `src/blockers.ts`, a
  blockers module contract, `loadSelection` in a resolve entry,
  updated orchestrator contracts (`Ticket.blockers`,
  `findReadyTickets`, `findBlockedTickets`, `blockerSatisfied`,
  `blockerLabel`, `renderFinishSummary`, learnings), the CLI
  zero-ready stop and picker label

**Dependencies:** Phase 5

**Done when:** `npm run build`, `npm test` and `npm run lint` pass,
and the docs cover cross-feature-blockers.AC4.1 and AC4.2 on review
(no tests for docs).
<!-- END_PHASE_6 -->

## Additional Considerations

**Frozen outside statuses:** `done` and `pending` are read once per
load. Nothing in the run changes an unselected feature's tickets, so
the snapshot cannot go stale within a run. A human editing one
mid-run is picked up on the next run.

**Integration branches:** statuses are read from the working tree
after any checkout. A blocker finished on another, unmerged
integration branch reads as not done here, which is correct: its
work is not on this branch. The summary text tells the user to
finish or merge that feature first.

**Row truncation:** `fitLine` can cut a long `(blocked by ...)`
label at the terminal edge. The finish summary carries the full
text, so `fitLine` is unchanged.

**Typo blind spot:** a typo in a feature name whose number also
exists in the ticket's own feature resolves to that own ticket. The
typo warning still names the word.
