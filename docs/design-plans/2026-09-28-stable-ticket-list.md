# Stable ticket list design

## Summary

Today the terminal status list in nightralph rebuilds itself at the
start of every wave. Tickets that finished drop out, the current
wave's tickets jump to the top, and a ticket that failed comes back
as an empty dot. This change makes the list fixed for the whole
run. The orchestrator builds it once, from every ticket that's
ready for an agent at startup, and hands it to the display. After
that it only sends status changes, so rows never move, vanish, or
reappear. Only their dots change.

The display gets two new calls. `startRun` receives the fixed list
once. `setBlocked` marks a ticket that can't run because something
it depends on failed or needs a human. A new pure helper,
`findBlockedTickets`, works out which tickets are blocked and by
whom, following dependency chains within a feature. Both wave loops
call it right after `startRun` and again after each wave's failures
are recorded. The header counts done tickets against the same fixed
array the rows come from, so the list and the percent can't
disagree. The plain (non-TTY) display keeps its current output.

## Definition of Done

1. The TTY status list is fixed at startup: every ticket that was
   `ready-for-agent` when the run began, sorted by feature/number.
   It never changes during the session -- rows don't move, vanish,
   or get re-added; only their dots change.
2. Done tickets stay green and failed tickets stay red. Tickets that
   can't run because a ticket they depend on (directly or
   transitively) failed or is `ready-for-human` get a distinct
   "blocked" marker naming that ticket.
3. The header keeps the wave number and adds counts over that same
   fixed set, e.g. `Wave 2/3 - 5/8 done - 62%`. It starts at 0% and
   reaches 100% only when every session ticket is done.
4. Same behavior in `runWaves` and `runWavesIsolated`. `PlainDisplay`
   and wave scheduling are unchanged. Tests cover the fixed list
   across waves (no brittle text assertions). The AGENTS.md display
   contract and the README wave explanation are updated.

## Acceptance Criteria

### stable-ticket-list.AC1: The ticket list is fixed for the session
- **stable-ticket-list.AC1.1 Success:** After `startRun`, every
  session ticket is rendered, including tickets not in the current
  wave.
- **stable-ticket-list.AC1.2 Success:** A ticket marked `done` in
  wave 1 is still rendered, with a green dot, after `startWave` for
  wave 2.
- **stable-ticket-list.AC1.3 Success:** The rendered ticket order is
  identical before and after every `startWave` and
  `setTicketStatus` call.
- **stable-ticket-list.AC1.4 Success:** The orchestrator passes the
  session set to `startRun` sorted by feature, then ticket number,
  regardless of `scanTickets` order.
- **stable-ticket-list.AC1.5 Success:** `startWave` does not reset
  the status of any ticket in the fixed list.
- **stable-ticket-list.AC1.6 Edge:** Tickets that were `done` or
  `ready-for-human` at startup are not in the list.
- **stable-ticket-list.AC1.7 Edge:** `startWave` called without a
  prior `startRun` seeds the list from that wave's tickets; a later
  `startWave` never replaces it.
- **stable-ticket-list.AC1.8 Edge:** `setTicketStatus` for a ticket
  not in the fixed list is ignored and does not add a row.
- **stable-ticket-list.AC1.9 Edge:** With more tickets than terminal
  rows, pagination and auto-scroll to the in-progress ticket still
  work against the fixed list.

### stable-ticket-list.AC2: Failed and blocked tickets are visible
- **stable-ticket-list.AC2.1 Success:** A ticket that failed in an
  earlier wave keeps its red dot in every later wave (today it
  reverts to an empty dot).
- **stable-ticket-list.AC2.2 Success:** A ticket whose direct
  blocker failed is shown as blocked, and its row names the failed
  ticket.
- **stable-ticket-list.AC2.3 Success:** A ticket blocked through a
  chain (C blocked by B, B blocked by failed A) is shown as blocked
  and names A.
- **stable-ticket-list.AC2.4 Success:** A ticket with two failed
  upstream tickets names both.
- **stable-ticket-list.AC2.5 Success:** The blocked dot is visually
  distinct from pending, in-progress, awaiting-merge, done, and
  failed.
- **stable-ticket-list.AC2.6 Success:** A merge failure that adds
  the ticket to `failedKeys` blocks its dependents the same way an
  agent failure does.
- **stable-ticket-list.AC2.7 Edge:** A ticket with a failed blocker
  in a different feature that shares the same number is not marked
  blocked (blockers are resolved within the ticket's own feature).
- **stable-ticket-list.AC2.8 Edge:** The row stays within the
  terminal width when the blocked suffix is long (clamped by
  `fitLine`).
- **stable-ticket-list.AC2.9 Success:** A session ticket whose
  blocker is `ready-for-human` is shown as blocked from the first
  render, naming the human ticket, even though the human ticket is
  not in the list.
- **stable-ticket-list.AC2.10 Success:** A ticket blocked through a
  chain that ends at a `ready-for-human` ticket names the human
  ticket.
- **stable-ticket-list.AC2.11 Edge:** A ticket whose blockers are
  all `done` or still `ready-for-agent` (and not failed) is not
  marked blocked.

### stable-ticket-list.AC3: Header counts match the list
- **stable-ticket-list.AC3.1 Success:** The header shows the wave
  number, done count, total, and percent.
- **stable-ticket-list.AC3.2 Success:** Total equals the number of
  tickets in the fixed list.
- **stable-ticket-list.AC3.3 Success:** Before any ticket finishes,
  the percent is 0.
- **stable-ticket-list.AC3.4 Success:** When every session ticket is
  done, the percent is 100.
- **stable-ticket-list.AC3.5 Failure:** Failed and blocked tickets
  never count as done.

### stable-ticket-list.AC4: Both run modes and unchanged scope
- **stable-ticket-list.AC4.1 Success:** `runWaves` calls `startRun`
  exactly once with the session set before the first `startWave`.
- **stable-ticket-list.AC4.2 Success:** `runWavesIsolated` calls
  `startRun` exactly once with the session set before the first
  `startWave`.
- **stable-ticket-list.AC4.3 Success:** Both loops report blocked
  tickets through `setBlocked` right after `startRun` and again
  after each wave's failures are recorded.
- **stable-ticket-list.AC4.4 Edge:** A run with no runnable tickets
  never calls `startRun` or `startWave`, and the finish summary
  still reaches the terminal.
- **stable-ticket-list.AC4.5 Success:** `PlainDisplay` output
  format is unchanged; `startRun` and `setBlocked` are no-ops there.

## Glossary

- **Session set**: The tickets that were `ready-for-agent` when the
  run began, sorted by feature, then number. It's the fixed list
  the display renders for the whole run.
- **Wave**: One batch of tickets whose blockers are all done. Tickets
  in a wave run in parallel, and the wave finishes before the next
  starts.
- **`ready-for-agent`**: Ticket status meaning an agent may pick the
  ticket up.
- **`ready-for-human`**: Ticket status meaning only a person can do
  the work. Agents skip it, and tickets depending on it can't run.
- **Blocked**: A new display status for a ticket that can't finish
  this run because a ticket it depends on, directly or through a
  chain, is dead. The row names the dead ticket.
- **Dead ticket**: A ticket that can't become done this run. It's
  either in `failedKeys` or has a status other than `done` and
  `ready-for-agent`.
- **`failedKeys`**: Per-run set of `ticketKey` strings for tickets
  that used up their attempts or whose merge conflict wasn't
  resolved. Later waves exclude them.
- **`ticketKey(feature, num)`**: Returns `feature:num`. It's the
  compound ticket identity, so the same number in two features
  doesn't collide.
- **Feature**: A named group of tickets, resolved to a
  `.scratch/<name>/` directory. Blockers are only resolved within a
  ticket's own feature.
- **`Display`**: The interface the orchestrator uses to report
  progress. `StatusDisplay` implements it for TTYs and
  `PlainDisplay` for plain output.
- **`StatusDisplay`**: The ANSI terminal UI with a paginated ticket
  grid, a header, and a scrolling message log.
- **`PlainDisplay`**: Append-only text fallback used when stdout
  isn't a TTY.
- **`runWaves` / `runWavesIsolated`**: The two wave loops in the
  orchestrator. The first runs agents in place. The second gives
  each ticket its own git worktree and merges branches afterward.
- **`remaining`**: The old `startWave` argument listing pending
  tickets outside the current wave. This design removes it.
- **`runProgress`**: The orchestrator's `{ completed, total }` count
  for the run, passed to the display. It's rescoped to the session
  set here.
- **`findBlockedTickets`**: New pure helper that maps each blocked
  ticket to the dead tickets it depends on.
- **`fitLine`**: Display helper that clamps a row to the terminal
  width so long text truncates instead of wrapping.
- **`renderDot`**: Display helper that draws a status as a colored
  dot.
- **Pagination / auto-scroll**: When there are more tickets than
  terminal rows, the grid shows a page and scrolls to the
  in-progress ticket.
- **`simulateWaves`**: Predicts the wave count assuming every ticket
  succeeds. That's why `totalWaves` can be stale after a failure.
- **Pure helper**: A function with no side effects, tested directly.
  `findBlockedTickets` follows the existing ones, such as
  `findReadyTickets`.
- **`createMockStream`**: Test helper in `test/display.test.ts` that
  stands in for a terminal stream.
- **Recording display double**: A test `Display` that records calls
  so tests can assert what the orchestrator sent.

## Architecture

The display owns one ticket list for the whole run. The orchestrator
hands it over once, then only sends status changes.

Today, `runWaves` and `runWavesIsolated` (`src/orchestrator.ts`)
call `Display.startWave` at the top of every wave. They pass the
wave's tickets plus a `remaining` list of tickets still
`ready-for-agent`. `StatusDisplay.startWave` (`src/display.ts`)
replaces its list with those two arrays. Tickets finished in
earlier waves are no longer `ready-for-agent`, so they drop out.
The wave's tickets always go first, so rows reorder. A ticket that
failed earlier is still `ready-for-agent` on disk, so it comes back
as an empty dot.

The new flow:

1. Before the first wave, each loop builds the **session set**:
   tickets with status `ready-for-agent` at that moment, sorted by
   feature, then number. It calls `Display.startRun(sessionSet)`
   once.
2. Each wave calls `Display.startWave(waveNum, totalWaves, tickets,
   progress?)`. `StatusDisplay` uses it only to update the wave
   number in the header. `PlainDisplay` keeps printing its
   per-wave line from `tickets` and `progress`, as it does now.
3. `setTicketStatus` updates the matching row in the fixed list.
4. Right after `startRun`, and again after each wave's failures
   are recorded in `failedKeys`, the loop calls a pure helper,
   `findBlockedTickets`, and reports each result through
   `Display.setBlocked`. The startup call catches tickets waiting
   on `ready-for-human` work; the per-wave calls catch failures.

`StatusDisplay` computes the header counts from its own fixed list
(done rows / all rows). The list and the percent can't disagree
because they come from the same array. The `progress` argument
remains for `PlainDisplay`. `runProgress` is rescoped to the session
set so both displays report the same numbers.

### Contracts

`src/display.ts`:

```ts
export type TicketStatus =
    | 'pending'
    | 'in-progress'
    | 'awaiting-merge'
    | 'done'
    | 'failed'
    | 'blocked'

type TicketRef = {
    num:number
    filename:string
    feature?:string
}

export type Display = {
    // Called once, before the first wave. Fixes the rendered
    // list for the rest of the run.
    startRun(tickets:ReadonlyArray<TicketRef>):void
    // `remaining` is removed. StatusDisplay reads only the wave
    // numbers; PlainDisplay prints `tickets` and `progress`.
    startWave(
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<TicketRef>,
        progress?:RunProgress,
    ):void
    setTicketStatus(
        num:number,
        status:TicketStatus,
        feature?:string,
    ):void
    // Marks a ticket blocked. `blockedBy` holds display labels
    // of the dead upstream tickets (e.g. 'pwa/07').
    setBlocked(
        num:number,
        feature:string|undefined,
        blockedBy:ReadonlyArray<string>,
    ):void
    log(message:string):void
    cleanup():void
}
```

`src/orchestrator.ts`:

```ts
// Pure. A "dead" ticket can't become done this run: it is in
// `failedKeys`, or its status is neither 'done' nor
// 'ready-for-agent' (e.g. 'ready-for-human'). For every
// ready-for-agent ticket not in `failedKeys`, returns the dead
// tickets it depends on, directly or transitively, within its
// own feature. Tickets with no dead upstream are absent.
export function findBlockedTickets (
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>,
):Map<string, Array<string>>  // ticketKey -> dead ticketKeys
```

The orchestrator converts dead `ticketKey`s to display labels
(`feature/NN`, or filename when there is no feature) before calling
`setBlocked`, matching `ticketLabel` in `src/display.ts`.

### Rendering

A blocked row is a dim filled dot (new glyph use, same `color.dim`
helper) followed by the label and `(blocked by pwa/07, pwa/09)`.
The whole row passes through `fitLine`, so the suffix truncates
instead of wrapping. The header becomes:

```
Wave 2/3 - 5/8 done - 62%
```

## Existing Patterns

This change stays inside the current display architecture from
`docs/design-plans/2026-08-31-terminal-status-ui.md`:

- The `Display` interface with `StatusDisplay` (TTY) and
  `PlainDisplay` (append-only) implementations, chosen by
  `createDisplay()`.
- Compound ticket identity: `setTicketStatus` matches on
  `num` + `feature`, and the orchestrator keys everything by
  `ticketKey(feature, num)`. `setBlocked` follows the same
  matching rule.
- Pure helpers exported from `src/orchestrator.ts` and tested
  directly (`findReadyTickets`, `renderFinishSummary`,
  `retryDelayFor`). `findBlockedTickets` joins them.
- Row clamping with `fitLine` and the pagination/auto-scroll logic
  in `StatusDisplay.render` are reused as is; they now index into
  the fixed list instead of `wave.tickets + remaining`.
- Tests use `createMockStream` in `test/display.test.ts` and
  recording `Display` doubles in `test/orchestrator.test.ts` and
  `test/integration.test.ts`.

One divergence: the `remaining` parameter added to `startWave` for
pending tickets is removed. `startRun` covers that need, and
keeping both would give two sources for the same rows.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Fixed ticket list in StatusDisplay
**Goal:** `StatusDisplay` renders one list for the run, with
blocked rows and the new header.

**Components:**
- `Display` type in `src/display.ts` -- add `startRun` and
  `setBlocked`, add `'blocked'` to `TicketStatus`, drop the
  `remaining` parameter from `startWave`
- `StatusDisplay` in `src/display.ts` -- hold the fixed list,
  make `startWave` update only the wave header, find rows for
  `setTicketStatus`/`setBlocked` in the fixed list, compute counts
  from it, render the blocked suffix, seed from the first
  `startWave` when `startRun` was never called
- `renderDot` in `src/display.ts` -- blocked glyph
- `PlainDisplay` in `src/display.ts` -- no-op `startRun` and
  `setBlocked`
- `test/display.test.ts` -- replace the tests that assert list
  replacement and `remaining` handling with fixed-list tests
- `test/demo-display.mjs` -- use `startRun` so `npm run demo` still
  runs

**Dependencies:** None

**Done when:** Build and display tests pass, covering
stable-ticket-list.AC1.1, AC1.2, AC1.3, AC1.5, AC1.7, AC1.8,
AC1.9, AC2.5, AC2.8, AC3.1, AC3.2, AC3.3, AC3.4, AC3.5, AC4.5.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Orchestrator drives the fixed list
**Goal:** Both wave loops hand the session set to the display once
and report blocked tickets.

**Components:**
- `findBlockedTickets` in `src/orchestrator.ts` -- new pure helper
- `runWaves` and `runWavesIsolated` in `src/orchestrator.ts` --
  build and sort the session set, call `startRun` before the first
  wave, stop building `remaining`, call `setBlocked` after each
  wave's failures are recorded
- `runProgress` in `src/orchestrator.ts` -- count only the session
  set
- Display doubles in `test/orchestrator.test.ts` and
  `test/integration.test.ts` -- add the new methods
- New orchestrator tests using a recording display double

**Dependencies:** Phase 1

**Done when:** All tests pass, covering stable-ticket-list.AC1.4,
AC1.6, AC2.1, AC2.2, AC2.3, AC2.4, AC2.6, AC2.7, AC2.9, AC2.10,
AC2.11, AC4.1, AC4.2, AC4.3, AC4.4.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Documentation
**Goal:** Contracts and user docs describe the new behavior.

**Components:**
- `AGENTS.md` -- display module contract (`startRun`,
  `setBlocked`, `blocked` status, header format, removal of
  `remaining`, fixed-list guarantee) and orchestrator contract
  (`findBlockedTickets`, session-scoped `runProgress`)
- `README.md` -- "How It Works" explains what a wave is and what
  the status list and header show

**Dependencies:** Phase 2

**Done when:** Docs match the code; `npm run lint` and `npm test`
pass.
<!-- END_PHASE_3 -->

## Additional Considerations

**Log area:** `StatusDisplay.startWave` currently clears the
message log at each wave. This design doesn't change that; it's a
separate decision.

**Wave total can be stale:** `totalWaves` comes from
`simulateWaves`, which assumes every ticket succeeds. After a
failure, the run can end before the predicted last wave. This
design keeps the number as is.

**Tickets waiting on non-agent work:** Blocked covers any blocker
whose status is neither `done` nor `ready-for-agent`, not only
`ready-for-human`. Such a ticket can't finish this run either, so it
gets the same marker. `renderFinishSummary` still explains
human-blocked tickets at the end of the run; the two don't overlap.

**Missing blockers:** A `Blocked by:` number with no matching ticket
file is not treated as dead. The ticket stays pending, as it does
today.
