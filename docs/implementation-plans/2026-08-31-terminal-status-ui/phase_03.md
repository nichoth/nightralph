# Terminal Status UI Implementation Plan

**Goal:** Add a live-updating terminal status display to the
nightralph orchestrator, showing ticket progress as colored dots
with a rolling message area.

**Architecture:** Single flat module `src/display.ts` containing
types, ANSI escape helpers, and the display renderer. Integrates
with the orchestrator by replacing `console.log` calls with
display API methods. Falls back to plain text when stdout is not
a TTY.

**Tech Stack:** TypeScript, raw ANSI escape codes (no external
library), Node >= 24

**Scope:** 4 phases from design

**Codebase verified:** 2026-08-31

---

## Acceptance Criteria Coverage

This phase implements and tests:

### terminal-status-ui.AC5: Pagination
- **terminal-status-ui.AC5.1 Success:** When ticket list
  exceeds available terminal rows, a viewport window is shown
- **terminal-status-ui.AC5.2 Success:** Viewport auto-scrolls
  to keep in-progress items visible

---

## Phase 3: Pagination and Terminal Resize (Functionality)

This phase adds viewport management to the `StatusDisplay`
class for cases where the ticket list is taller than the
available terminal rows.

**Layout math:**
- Terminal height: `process.stdout.rows`
- Overhead lines: 1 (status line) + 1 (separator) +
  `messageLines` (default 4) = 6 fixed lines
- Available rows for tickets: `termHeight - overhead`
- If ticket count <= available rows, render all (no pagination)
- If ticket count > available rows, show a viewport window

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Add viewport tracking to StatusDisplay

**Verifies:** terminal-status-ui.AC5.1

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add private state to `StatusDisplay`:
- `viewportStart:number` -- index of the first visible ticket
  (0-based). Reset to 0 in `startWave()`.

Add a private method `getAvailableRows():number`:
- Returns `(this.config.stream.rows ?? 24) - 6`
  where 6 = status line (1) + separator (1) + messageLines (4)
- Floor at 1 to avoid negative values

Modify `render()` to use the viewport:
- Compute `availableRows` via `getAvailableRows()`
- If `wave.tickets.length <= availableRows`, render all
  tickets as before (no change)
- If `wave.tickets.length > availableRows`, render only
  `tickets.slice(viewportStart, viewportStart + availableRows)`
- If `viewportStart > 0`, prepend an indicator line:
  `  ... {viewportStart} more above`
  (this replaces the first visible ticket row, so adjust
  the slice to show one fewer ticket)
- If `viewportStart + availableRows < tickets.length`,
  append an indicator line:
  `  ... {remaining} more below`
  (this replaces the last visible ticket row, so adjust
  the slice to show one fewer ticket)

The indicators count toward the available rows. So the
actual visible ticket count when both indicators are needed
is `availableRows - 2`. When only one indicator is needed,
it's `availableRows - 1`.

**Testing:**
Tests must verify:
- terminal-status-ui.AC5.1: when tickets exceed available
  rows, only a subset is rendered with overflow indicators

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add viewport tracking to StatusDisplay`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Auto-scroll to in-progress items

**Verifies:** terminal-status-ui.AC5.2

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Modify `setTicketStatus()` to adjust the viewport when a
ticket becomes in-progress:

When `status === 'in-progress'`:
1. Find the ticket's index in `wave.tickets`
2. Compute `availableRows` via `getAvailableRows()`
3. If the ticket index is below the viewport
   (index >= viewportStart + availableRows), set
   `viewportStart = index - availableRows + 1`
4. If the ticket index is above the viewport
   (index < viewportStart), set `viewportStart = index`
5. Clamp `viewportStart` to valid range:
   `Math.max(0, Math.min(viewportStart, tickets.length - availableRows))`

This ensures that when an agent starts working on a ticket,
the viewport scrolls to show it.

**Testing:**
Tests must verify:
- terminal-status-ui.AC5.2: setting a ticket outside the
  viewport to in-progress causes the viewport to scroll

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: auto-scroll viewport to in-progress items`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Terminal resize handling and tests

**Verifies:** terminal-status-ui.AC5.1, terminal-status-ui.AC5.2

**Files:**
- Modify: `src/display.ts`
- Modify: `test/display.test.ts`

**Implementation:**

Add resize handling to `StatusDisplay`:

In the constructor (or in `startWave`), if the stream is a
TTY, listen for the `'resize'` event:
```
this.config.stream.on('resize', () => this.render())
```

In `cleanup()`, remove the resize listener.

This ensures that when the terminal is resized, the display
recalculates available rows and re-renders with the new
viewport size.

**Testing:**
Add tests to `test/display.test.ts` for pagination:

1. **Viewport limits rendering**: Create a display with a
   mock stream that has `rows` set to a small value (e.g. 12).
   Start a wave with more tickets than fit. Verify only a
   subset of tickets appear in the output, and overflow
   indicators are present (includes "more above" or
   "more below" text).

2. **Auto-scroll on status change**: Same setup with small
   terminal. Set a ticket near the end to in-progress.
   Verify the viewport shifted to include that ticket in
   the output.

3. **No pagination when fits**: Set `rows` high enough to
   fit all tickets. Verify no overflow indicators appear
   and all tickets are rendered.

Mock stream setup: the mock write stream from Phase 2 tests
should have a `rows` property set to the desired terminal
height, and optionally an `on`/`removeListener` method
(can be no-ops for pagination tests since we test the
render output, not the event wiring).

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npm test`
Expected: All tests pass.

**Commit:** `feat: add terminal resize handling and pagination tests`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
