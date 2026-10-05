# Stable ticket list -- test requirements

This file maps every acceptance criterion in
`docs/design-plans/2026-09-28-stable-ticket-list.md` to the
automated tests the phase files create, plus the checks a person
has to do by eye. All automated tests use
`@substrate-system/tapzero`.

Phase 3 is documentation only and verifies no criterion. Per the
user's global rules, no tests are written for docs; its checks
(`npm run toc`, the em dash and arrow grep, `npm run lint`,
`npm test`) are verification steps, not tests.

## How the tests are written

These planning decisions shape every test below. A test that breaks
one of them should be rewritten, not merged.

1. No brittle text assertions. No test matches a whole rendered line
   or frame. Tests assert on ticket labels (identity, e.g. `f/02`),
   dot escape codes taken from `renderDot(status)`, numbers pulled
   out of the header with a regex, and the order of labels in a
   frame. The blocked-suffix test checks that the row holding `f/02`
   also holds `f/01`, not the words around them.
2. The `lastFrame(output)` helper (Phase 1, added next to
   `createMockStream` in `test/display.test.ts`) strips ANSI with the
   regex the file already uses, finds the last match of
   `/Wave \d+\/\d+/`, and returns the text from there. Every render
   starts with the header, so this isolates the final frame. A bare
   `'Wave '` search is not used because a log line could match it.
3. `runWaves` + display tests reuse what already lives in
   `test/display.test.ts`: `RecordingDisplay` (extended in Phase 1
   with `startRun` and `setBlocked` recording, so
   `getCallsByMethod` and `getCalls()` order work for them),
   `MockStream` / `createMockStream`, `initTempGitRepo` and
   `MOCK_AGENT_PASS`. Phase 2 adds `MOCK_AGENT_FAIL_TICKET_01`,
   pointing at the existing `test/mock-agent-fail-ticket-01.js`.
   Ticket bodies with blockers are written inline with a
   `**Blocked by:** N` line, since `makeTicketBody` takes no
   blockers.
4. `runWavesIsolated` tests live in `test/integration.test.ts`. That
   file has no recording double, so each new test builds a small
   object-literal one that records calls in order. They reuse
   `MOCK_FAIL_TICKET_01`, `installMergeFailingGit` and the worktree
   cleanup loop already there.
5. Tests with a failing agent pass `retries:0` (for `runWaves`, the
   eleventh positional argument), so the failing ticket runs once.
6. Nothing type-checks `test/`. `tsconfig.build.json` excludes it
   and esbuild only strips types. A `Display` double missing
   `startRun` or `setBlocked` fails only at runtime, when the
   orchestrator calls it. Phase 1 Task 1 adds both methods to every
   double (`RecordingDisplay`, the literals in
   `test/orchestrator.test.ts` and `test/integration.test.ts`, and
   `test/demo-display.mjs`), and its verification step is a grep:
   `grep -n "startWave (" test/*.ts test/*.mjs`.
7. Pure helper tests build tickets with `makeTicket` and assert on
   the returned map, as the existing `findReadyTickets` tests do.
   `findBlockedTickets` returns `ticketKey` strings (`f:1`); the
   conversion to display labels (`f/01`) happens in `reportBlocked`
   and is checked by the integration tests.

Test type below: "unit" means an in-memory call against
`StatusDisplay`, `PlainDisplay`, `renderDot` or `findBlockedTickets`
with no processes spawned. "Integration" means the test runs
`runWaves` or `runWavesIsolated` against a temp git repo with a mock
agent.

## Existing tests that change

Phase 1 Task 2 rewrites or removes tests that assert the old
list-replacing and `remaining` behavior. They are listed so a
reviewer can see the old intent is kept where it still applies.

| Existing test | Change | Criterion it now serves |
| --- | --- | --- |
| `test/display.test.ts:115` "startWave resets ticket list on second call" | Inverted: both `startRun` labels survive two `startWave` calls | AC1.1, AC1.7 |
| `test/display.test.ts:291` header regex | Extracts wave `N/M`, `done/total` and percent by regex | AC3.1 |
| `test/display.test.ts:375` "percentage reflects overall run progress when given" | Replaced: a disagreeing `progress` argument is ignored; percent comes from the fixed list | AC3.2 |
| `test/display.test.ts:412` "rendered lines never exceed terminal width" | Bound tightened from `40` to `stream.columns - 1`, so it covers the longer header | AC2.8 |
| `test/display.test.ts:738-869` (`remaining` tests) | Rewritten with `startRun`: non-wave tickets render with the dim empty dot and are paginated | AC1.1, AC1.9 |
| `test/display.test.ts:1309` "runWaves passes remaining tickets to startWave" | Deleted in Phase 1; replaced in Phase 2 Task 2 by the `startRun` session-set test | AC1.4, AC1.6, AC4.1 |
| `test/orchestrator.test.ts:3830-3870` "no wave should start" | Extended: `startRun` and `setBlocked` also call `t.fail` | AC4.4 |

## Automated tests

### stable-ticket-list.AC1: The ticket list is fixed for the session

| Criterion | Type | File | Created in | Asserts |
| --- | --- | --- | --- | --- |
| stable-ticket-list.AC1.1 -- every session ticket renders after `startRun`, including non-wave tickets | unit | `test/display.test.ts` | Phase 1 Task 2 | `startRun` with 4 tickets, `startWave` with 1; all 4 labels appear in `lastFrame` |
| stable-ticket-list.AC1.2 -- a ticket done in wave 1 still renders green after wave 2 starts | unit | `test/display.test.ts` | Phase 1 Task 2 | After `setTicketStatus(1, 'done')` and `startWave(2, ...)`, ticket 1's row holds `renderDot('done')` |
| stable-ticket-list.AC1.3 -- rendered order is identical across every `startWave` and `setTicketStatus` | unit | `test/display.test.ts` | Phase 1 Task 2 | Label order in `lastFrame` equals `startRun` order after status and wave calls made in non-list order |
| stable-ticket-list.AC1.4 -- the orchestrator passes the session set sorted by feature, then number | integration | `test/display.test.ts` | Phase 2 Task 2 | With the scanned array reversed and features set to `zeta` / `alpha`, the one `startRun` call lists ticket 2 before ticket 1 |
| stable-ticket-list.AC1.5 -- `startWave` never resets a status in the fixed list | unit | `test/display.test.ts` | Phase 1 Task 2 | Same test as AC1.2: a `done` row keeps the green dot and a `failed` row keeps the red dot after the next `startWave` |
| stable-ticket-list.AC1.6 -- tickets `done` or `ready-for-human` at startup are not listed | integration | `test/display.test.ts` | Phase 2 Task 2 | Same test as AC1.4: tickets 3 (`done`) and 4 (`ready-for-human`) are absent from the `startRun` argument |
| stable-ticket-list.AC1.7 -- without `startRun`, the first `startWave` seeds the list and a later one never replaces it | unit | `test/display.test.ts` | Phase 1 Task 2 | `startWave(1, 2, [a, b])` then `startWave(2, 2, [c])`; `lastFrame` has `a` and `b` and not `c` |
| stable-ticket-list.AC1.8 -- `setTicketStatus` for an unknown ticket is ignored | unit | `test/display.test.ts` | Phase 1 Task 2 | After `setTicketStatus` for a num not in the list, the row count is unchanged and no new label appears |
| stable-ticket-list.AC1.9 -- pagination and auto-scroll still work against the fixed list | unit | `test/display.test.ts` | Phase 1 Task 2 | Small `stream.rows`, many tickets via `startRun`; setting a ticket below the viewport to `in-progress` brings its label into the frame (mirrors the test at `:959`); the rewritten `remaining` pagination test and the existing above-viewport test at `:990` also run against the fixed list |

### stable-ticket-list.AC2: Failed and blocked tickets are visible

| Criterion | Type | File | Created in | Asserts |
| --- | --- | --- | --- | --- |
| stable-ticket-list.AC2.1 -- a ticket failed in an earlier wave keeps its red dot in later waves | integration | `test/display.test.ts` | Phase 2 Task 2 | Real `StatusDisplay` over `createMockStream`, `MOCK_AGENT_FAIL_TICKET_01`, a two-wave run; in `lastFrame`, ticket 1 holds `renderDot('failed')` and ticket 3 holds `renderDot('done')` |
| stable-ticket-list.AC2.2 -- a ticket whose direct blocker failed is blocked and names it | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | `findBlockedTickets` with `failedKeys = {f:1}` maps `f:2` to `['f:1']` and has no key `f:1` |
| stable-ticket-list.AC2.2 (display side) | unit | `test/display.test.ts` | Phase 1 Task 2 | After `setBlocked(2, 'f', ['f/01'])`, the `lastFrame` row holding `f/02` also holds `f/01` |
| stable-ticket-list.AC2.2 (orchestrator side) | integration | `test/display.test.ts`, `test/integration.test.ts` | Phase 2 Task 2 | In the AC4.3 tests, a `setBlocked` call after wave 1 is for ticket 2 and names ticket 1's label |
| stable-ticket-list.AC2.3 -- a chain (C -> B -> failed A) names A | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | 1 failed, 2 blocked by 1, 3 blocked by 2; `f:3` maps to `['f:1']` |
| stable-ticket-list.AC2.4 -- two failed upstream tickets are both named | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | 1 and 2 failed, 3 blocked by both; sorted `f:3` value equals `['f:1', 'f:2']`; the diamond test also checks a shared upstream is named once |
| stable-ticket-list.AC2.5 -- the blocked dot differs from the other five | unit | `test/display.test.ts` | Phase 1 Task 1 | `renderDot('blocked')` is not equal to `renderDot` of `pending`, `in-progress`, `awaiting-merge`, `done` or `failed` |
| stable-ticket-list.AC2.6 -- a merge failure blocks dependents like an agent failure | integration | `test/integration.test.ts` | Phase 2 Task 2 | Respawn variant (copy of the test at `:1950` plus `02-after.md` blocked by 1): a `setBlocked` for ticket 2 names ticket 1, and ticket 1 gets `setTicketStatus(..., 'failed')`. Stop (`-X`) variant: the after-loop report still yields the `setBlocked` call for ticket 2 |
| stable-ticket-list.AC2.7 -- a failed ticket in another feature with the same number does not block | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | `a:1` failed, `b:2` blocked by 1, `b:1` ready; `b:2` is not a key in the result |
| stable-ticket-list.AC2.8 -- a long blocked suffix stays within the terminal width | unit | `test/display.test.ts` | Phase 1 Task 2 | `stream.columns = 30`, long `blockedBy`; every `lastFrame` row, header included, is at most `columns - 1` visible characters, and the row holds `renderDot('blocked')` |
| stable-ticket-list.AC2.9 -- a ticket waiting on a `ready-for-human` ticket is blocked from the first render | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | Ticket 1 at `HUMAN_STATUS`, 2 blocked by 1, empty `failedKeys`; `f:2` maps to `['f:1']` |
| stable-ticket-list.AC2.9 (first render) | integration | `test/display.test.ts`, `test/integration.test.ts` | Phase 2 Task 2 | In the AC4.3 tests, the first `setBlocked` call comes after `startRun` and before the first `startWave`, is for ticket 3, and names ticket 4 (the human ticket, not in the list) |
| stable-ticket-list.AC2.10 -- a chain ending at a `ready-for-human` ticket names it | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | 1 human, 2 blocked by 1, 3 blocked by 2; `f:3` maps to `['f:1']` |
| stable-ticket-list.AC2.11 -- blockers that are `done` or still `ready-for-agent` do not block | unit | `test/orchestrator.test.ts` | Phase 2 Task 1 | 1 done, 2 ready, 3 blocked by 1 and 2; result is empty. The missing-blocker and cycle tests also return empty maps |

The dense-graph test (200 tickets, each blocked by the two before
it) is not tied to one criterion. It guards the linear walk that
AC2.3, AC2.4 and AC2.10 rely on; an exponential walk would not
finish.

### stable-ticket-list.AC3: Header counts match the list

All of these read the header of `lastFrame` and pull numbers out
with a regex.

| Criterion | Type | File | Created in | Asserts |
| --- | --- | --- | --- | --- |
| stable-ticket-list.AC3.1 -- header shows wave number, done count, total and percent | unit | `test/display.test.ts` | Phase 1 Task 2 | Rewritten header test at `:291`: regex finds wave `N/M`, `D/T` and a percent |
| stable-ticket-list.AC3.2 -- total equals the fixed list length | unit | `test/display.test.ts` | Phase 1 Task 2 | `startRun` with 5, `startWave` with fewer; total is 5. The replaced `:375` test shows a disagreeing `progress` argument does not change it |
| stable-ticket-list.AC3.3 -- percent is 0 before any ticket finishes | unit | `test/display.test.ts` | Phase 1 Task 2 | Same setup as AC3.2: done 0, percent 0 |
| stable-ticket-list.AC3.4 -- percent is 100 when every session ticket is done | unit | `test/display.test.ts` | Phase 1 Task 2 | All 5 set `done`; percent 100 |
| stable-ticket-list.AC3.5 -- failed and blocked tickets never count as done | unit | `test/display.test.ts` | Phase 1 Task 2 | Some rows `failed`, some via `setBlocked`; done count equals only the `done` rows |

### stable-ticket-list.AC4: Both run modes and unchanged scope

| Criterion | Type | File | Created in | Asserts |
| --- | --- | --- | --- | --- |
| stable-ticket-list.AC4.1 -- `runWaves` calls `startRun` once with the session set before the first `startWave` | integration | `test/display.test.ts` | Phase 2 Task 2 | Same test as AC1.4: exactly one `startRun` in `getCalls()`, placed before the first `startWave` |
| stable-ticket-list.AC4.2 -- `runWavesIsolated` does the same | integration | `test/integration.test.ts` | Phase 2 Task 2 | Recording double: exactly one `startRun`, before the first `startWave`, with tickets 1, 2 and 3 |
| stable-ticket-list.AC4.3 -- both loops call `setBlocked` after `startRun` and after each wave's failures | integration | `test/display.test.ts` (in place), `test/integration.test.ts` (isolated) | Phase 2 Task 2 | First `setBlocked` (ticket 3 naming ticket 4) sits between `startRun` and the first `startWave`; a later one names ticket 1 for ticket 2. The AC2.6 stop variant covers the after-loop report |
| stable-ticket-list.AC4.4 -- a run with nothing runnable never calls `startRun` or `startWave`, and the summary still shows | unit (in place), integration (isolated) | `test/orchestrator.test.ts`, `test/integration.test.ts` | Phase 2 Task 2 | `runWaves`: the extended `:3830` test fails on any `startWave`, `startRun` or `setBlocked` call and checks the summary was logged. `runWavesIsolated`: with only a `done` and a human ticket, neither method is called and the summary is logged. The existing test at `test/display.test.ts:702` shows `StatusDisplay.log` before any wave writes to the stream |
| stable-ticket-list.AC4.5 -- `PlainDisplay` output is unchanged; `startRun` and `setBlocked` are no-ops | unit | `test/display.test.ts` | Phase 1 Task 1 | Capturing `console.log` as the test at `:1135` does: the wave line is the same with and without `startRun` / `setBlocked`, and those two calls print nothing. The existing `PlainDisplay` tests at `:1135` and `:1736` keep guarding the format |

## Human verification

Every criterion has an automated test above. The checks below cover
what those tests cannot prove: how the screen looks and behaves in a
real terminal. None of them replaces an automated test.

| Criteria | Why automation is not enough | How to verify |
| --- | --- | --- |
| stable-ticket-list.AC2.5 | The test proves the escape codes differ, not that a person can tell them apart. The blocked dot is a dim filled dot and pending is a dim empty dot, so they differ only in glyph and share a color. | Blocked rows, fixture A below: in a TTY, check the blocked dot is easy to tell from pending, in-progress, awaiting-merge, done and failed, in both a light and a dark terminal theme. |
| stable-ticket-list.AC2.2, AC2.4, AC2.9 | The tests check label identity only, not wording, on purpose (no brittle text assertions). Whether `(blocked by f/01, f/02)` reads well is a judgement call. | Fixtures A and B: check that the suffix names the right tickets, reads clearly, and truncates cleanly in a narrow window. The Phase 1 blocked-suffix test renders two labels in full at 80 columns; the AC2.8 test covers truncation at 30. |
| stable-ticket-list.AC1.1, AC1.2, AC1.3, AC1.5, AC2.1 | The mock stream records bytes but does not show that a real terminal repaints without flicker, stale rows or rows jumping between waves. | Fixture B: watch the list across waves. Rows keep their positions, done rows stay green, the failed row stays red, and nothing vanishes or reappears. Resize the window mid-run. |
| stable-ticket-list.AC1.9 | Pagination is unit-tested against `stream.rows`; real scrolling feel is not. | Run `npm run demo` in a window a few rows shorter than the ticket list, or fixture B with more tickets. The in-progress ticket stays visible, and the "more above" marker appears when scrolled. |
| stable-ticket-list.AC3.1 | The regex proves the numbers are there, not that the header reads well. | Any run above: header reads like `Wave 2/3 - 5/8 done - 62%`, starts at 0% and ends at 100% only when every row is green. |
| stable-ticket-list.AC4.4 | The display side is covered by the `:702` test; the full CLI path to the terminal is not. | Fixture C: `nightralph claude` in a TTY prints the finish summary, with no status grid, and exits 0. |
| stable-ticket-list.AC4.5 | The test compares output with and without the new calls, not with the previous release. | Run fixture B piped through `cat` (not a TTY) on this branch and on `0.0.52`, then diff the two outputs, leaving out agent output. Only wave lines and the summary should appear, in the same format. |

### Fixtures for human checks

These run a real provider in a scratch repo, so they cost agent
turns. Keep tickets trivial (e.g. "add a line to notes.txt") and
use `--retries 0`.

Fixture A (blocked from startup). Feature with `01`
`ready-for-human`, `02` `ready-for-agent` blocked by 1, `03`
`ready-for-agent` blocked by 2, and `04` independent. On the first
frame, `02` and `03` are blocked and name `01`; `01` is not listed.
This needs no failing agent.

Fixture B (failure across waves). `01`, `02` independent; `03`
blocked by 2; `04` blocked by 1 and 3. Make only ticket 1 fail its
test gate with a test command that looks at the branch name, e.g.
`--test-cmd 'test -z "$(git rev-parse --abbrev-ref HEAD | grep -- --01-)"'`
(branches are named `<repo>--<num>-<slug>`). Expect `01` red for
the rest of the run, `02` and `03` green, and `04` blocked naming
`01`.

Fixture C (nothing runnable). Only a `done` ticket and a
`ready-for-human` ticket.

`npm run demo` (`test/demo-display.mjs`) is updated in Phase 1 to
call `startRun`, and to mark ticket 5 blocked by ticket 3 when
ticket 3 fails, so the demo shows a blocked row without an agent
run.

## Coverage summary

All 30 criteria (AC1.1-AC1.9, AC2.1-AC2.11, AC3.1-AC3.5,
AC4.1-AC4.5) have at least one automated test. Thirteen of them also
get the supplementary human checks above: AC1.1, AC1.2, AC1.3,
AC1.5, AC1.9, AC2.1, AC2.2, AC2.4, AC2.5, AC2.9, AC3.1, AC4.4 and
AC4.5 (AC2.5 is the one where the human check carries the real
intent).

Known thin spots:

1. AC2.2 has no single test from the orchestrator to a rendered row.
   It is covered in three parts: the helper result, the
   `setBlocked` label from `reportBlocked`, and the display rendering
   the label in the row. The AC2.1 test uses a real `StatusDisplay`
   but its fixture has no blocked ticket.
2. AC2.4 at the display level: closed. The Phase 1 Task 2
   blocked-suffix test also renders two blocker labels at 80
   columns and checks the row holds both.
3. AC2.10 is covered only by the helper test. `reportBlocked` is the
   same code path for chains and direct blockers, so no extra
   integration test is planned.
