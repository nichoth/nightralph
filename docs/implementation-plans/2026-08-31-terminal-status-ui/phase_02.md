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

### terminal-status-ui.AC1: Status list rendering
- **terminal-status-ui.AC1.1 Success:** Each ticket in the
  current wave is displayed as a line with a dot character
  and filename
- **terminal-status-ui.AC1.2 Success:** Pending tickets show
  an empty/dim dot
- **terminal-status-ui.AC1.3 Success:** In-progress tickets
  show a yellow/amber filled dot
- **terminal-status-ui.AC1.4 Success:** Completed tickets show
  a green filled dot
- **terminal-status-ui.AC1.5 Success:** Failed tickets show a
  red filled dot

### terminal-status-ui.AC2: Status line
- **terminal-status-ui.AC2.1 Success:** Status line shows
  "Wave {current}/{total} -- {pct}% complete"
- **terminal-status-ui.AC2.2 Success:** Percentage reflects
  current wave progress (completed tickets / total in wave)

### terminal-status-ui.AC3: Rolling message area
- **terminal-status-ui.AC3.1 Success:** Message area has a
  fixed height of 3-4 lines at the bottom
- **terminal-status-ui.AC3.2 Success:** New messages push old
  messages out (rolling window)
- **terminal-status-ui.AC3.3 Success:** Agent stdout and
  orchestrator messages both appear in the area

### terminal-status-ui.AC4: Wave transitions
- **terminal-status-ui.AC4.1 Success:** When a wave completes,
  the display clears and shows the next wave's tickets
- **terminal-status-ui.AC4.2 Success:** Status line updates to
  new wave number, percentage resets to 0%

---

## Phase 2: Display Renderer Core (Functionality)

This phase adds the `StatusDisplay` class to `src/display.ts`.
It handles rendering the status list, status line, rolling
message area, and wave transitions using ANSI escape codes
from Phase 1.

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: StatusDisplay class skeleton

**Verifies:** terminal-status-ui.AC4.1, terminal-status-ui.AC4.2

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add the `StatusDisplay` class to the bottom of `src/display.ts`.
The class manages mutable state for the current wave, ticket
statuses, and message buffer. Uses the `DisplayConfig` type
and `DisplayTicket` type from Phase 1.

Constructor accepts an optional partial config and defaults
`messageLines` to 4 and `stream` to `process.stdout`.

Methods:
- `startWave(waveNum, totalWaves, tickets)` -- initializes
  wave state from an array of `{num, filename}` objects,
  resets messages, writes `ansi.cursorHide()` to the stream
  (hides cursor for clean rendering), then calls render.
  This is the wave transition entry point (AC4.1, AC4.2).
- `setTicketStatus(num, status)` -- finds the ticket by num,
  updates its status, calls render
- `cleanup()` -- restores cursor visibility by writing
  `ansi.cursorShow()` to the stream

The `startWave` method creates a new `WaveState` with all
tickets in `'pending'` status. If there was a previous
render, it clears the old display area before rendering fresh.

**Testing:**
Tests must verify each AC listed above:
- terminal-status-ui.AC4.1: calling `startWave` a second time
  resets the ticket list to the new wave's tickets
- terminal-status-ui.AC4.2: calling `startWave` with new
  waveNum updates the status line

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add StatusDisplay class skeleton`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: render() method -- full screen redraw

**Verifies:** terminal-status-ui.AC1.1, terminal-status-ui.AC1.2,
terminal-status-ui.AC1.3, terminal-status-ui.AC1.4,
terminal-status-ui.AC1.5, terminal-status-ui.AC2.1,
terminal-status-ui.AC2.2

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add a private `render()` method to `StatusDisplay`. The method
builds the entire display as a single string and writes it to
the stream in one call.

The render flow:
1. If `renderedLines > 0`, prepend cursor-up and erase-lines
   sequences to clear the previous frame
2. Build the status line:
   `Wave {waveNum}/{totalWaves} -- {pct}% complete`
   where pct = Math.round(completed / total * 100).
   Completed = tickets with status `'done'`.
3. Build the ticket list: for each ticket in the wave,
   render `{dot} {filename}` using the `renderDot()` helper
   from Phase 1
4. Build a separator line of dashes (use plain ASCII `-`)
5. Build the message area: show the last N lines from the
   messages buffer, where N = `config.messageLines`. Pad
   with empty lines if fewer messages exist.
6. Write the entire string to `config.stream`
7. Track the number of lines written as `renderedLines`

The status line percentage is computed from the current wave
only (AC2.2). Count only tickets where `status === 'done'`
for the percentage -- failed tickets do not count as
completed. So pct = `done count / total count * 100`.

Use `renderDot()` from Phase 1 for each ticket status:
- pending -> dim empty dot (AC1.2)
- in-progress -> yellow filled dot (AC1.3)
- done -> green filled dot (AC1.4)
- failed -> red filled dot (AC1.5)

Each ticket is rendered as one line: `{dot} {filename}`
(AC1.1).

**Testing:**
Tests must verify each AC listed above:
- terminal-status-ui.AC1.1: output contains dot + filename
  for each ticket
- terminal-status-ui.AC1.2: pending ticket line contains
  the empty dot character
- terminal-status-ui.AC1.3: in-progress ticket line contains
  yellow ANSI codes
- terminal-status-ui.AC1.4: done ticket line contains
  green ANSI codes
- terminal-status-ui.AC1.5: failed ticket line contains
  red ANSI codes
- terminal-status-ui.AC2.1: output contains the wave/total
  and percentage format
- terminal-status-ui.AC2.2: percentage updates correctly
  when tickets complete

To test rendering output, pass a custom `stream` that
collects written data (e.g., a `PassThrough` stream or
a mock object with a `write` method that appends to a
string buffer).

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add StatusDisplay render method`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: log() method -- rolling message buffer

**Verifies:** terminal-status-ui.AC3.1, terminal-status-ui.AC3.2,
terminal-status-ui.AC3.3

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add a `log(message:string)` method to `StatusDisplay`.

The method:
1. Pushes the message onto the internal `messages` array
2. If `messages.length > config.messageLines`, shift the
   oldest message off the front (rolling window -- AC3.2)
3. Calls `render()` to update the display

The message area height is fixed at `config.messageLines`
(default 4) -- AC3.1.

Both agent stdout lines and orchestrator status messages
will be passed to `log()` by the caller -- the display
module does not distinguish between them (AC3.3).

**Testing:**
Tests must verify each AC listed above:
- terminal-status-ui.AC3.1: message area renders exactly
  `messageLines` lines (padded if fewer messages)
- terminal-status-ui.AC3.2: after logging more than
  `messageLines` messages, only the most recent ones appear
- terminal-status-ui.AC3.3: any string passed to `log()`
  appears in the output

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add StatusDisplay log method`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for StatusDisplay

**Verifies:** terminal-status-ui.AC1.1, terminal-status-ui.AC1.2,
terminal-status-ui.AC1.3, terminal-status-ui.AC1.4,
terminal-status-ui.AC1.5, terminal-status-ui.AC2.1,
terminal-status-ui.AC2.2, terminal-status-ui.AC3.1,
terminal-status-ui.AC3.2, terminal-status-ui.AC3.3,
terminal-status-ui.AC4.1, terminal-status-ui.AC4.2

**Files:**
- Create: `test/display.test.ts`

**Implementation:**

Create test file using `@substrate-system/tapzero` (the
project's test framework). Import from `../src/display.js`.

Create a helper to capture display output:
- Build a mock stream object with a `write` method that
  appends to a string variable
- Pass it as the `stream` option to `StatusDisplay`
- After each operation, read the captured string

Test cases:

1. **Dot rendering per status**: Create a display, start a
   wave with one ticket, set its status to each value
   (pending, in-progress, done, failed), verify the output
   contains the corresponding dot character and color codes.
   Do not test for exact ANSI sequences -- test that the
   filled dot character appears for in-progress/done/failed,
   and the empty dot character appears for pending.

2. **Status line format**: Start a wave with known
   waveNum/totalWaves, verify output includes the wave
   numbers and percentage. Change ticket status to done,
   verify percentage updates.

3. **Message rolling**: Log more messages than messageLines,
   verify only the most recent ones appear in output. Verify
   the message area has exactly messageLines lines.

4. **Wave transition**: Start wave 1 with tickets A/B, then
   start wave 2 with tickets C/D. Verify wave 2's output
   contains tickets C/D and does not contain A/B.

Use `t.ok(output.includes(...))` for content checks to
avoid brittle exact-match testing.

**Testing:**
This IS the test task. All ACs from this phase are verified
here.

Follow project testing patterns (tapzero, behavior-focused).
Task-implementor generates actual test code at execution time.

**Verification:**
Run: `npm test`
Expected: All tests pass.

Also update the test build script in `package.json` if
needed to include the new test file.

**Commit:** `test: add StatusDisplay tests`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->
