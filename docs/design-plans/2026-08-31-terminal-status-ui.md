# Terminal Status UI -- Design Plan

## Overview

A new display module that replaces raw `console.log` calls in the
orchestrator with a live-updating terminal UI. The screen is divided
into two regions drawn in-place using ANSI escape codes: a status list
(top) showing each ticket as a colored dot, and a message area
(bottom 3-4 lines) showing a rolling window of agent output.

## Layout

```
Wave 1/3 -- 50% complete        <-- status line
* 01-add-login.md                <-- green = done
* 02-setup-db.md                 <-- yellow = in progress
o 03-api-endpoints.md            <-- empty = pending
o 04-validation.md
-----                            <-- separator
  [02-setup-db] Running tests..  <-- rolling message area
  [02-setup-db] All tests passed <-- (3-4 lines, newest at bottom)
  [01-add-login] done
```

## Dot States

| State       | Character | Color        | When                                |
|-------------|-----------|--------------|-------------------------------------|
| Pending     | empty dot | dim/gray     | Ticket in current wave, not started |
| In progress | filled    | yellow/amber | Agent spawned, still running        |
| Completed   | filled    | green        | Agent exited successfully           |
| Failed      | filled    | red          | Agent failed or moved on            |

## Status Line

Format: `Wave {current}/{total} -- {pct}% complete`

The percentage reflects the current wave only (completed tickets /
total tickets in this wave). Resets to 0% when a new wave starts.

## Message Area

- Fixed height of 3-4 lines at the bottom of the display
- Rolling window: new lines push old lines out (only the most recent
  N lines are visible)
- Receives both agent stdout (prefixed like `[ticket-name] ...`) and
  orchestrator status messages (like `Starting 01-feature.md`,
  `01-feature.md: done`)
- When multiple agents run in parallel, their output interleaves
  naturally in arrival order

## Wave Transitions

When a wave completes and the next wave begins:
1. Clear the entire display region
2. Update the status line to the new wave number and reset
   percentage to 0%
3. Render the new wave's ticket list with all dots in the
   pending state
4. Clear the message area

## Pagination

When the ticket list is taller than the available terminal rows
(minus status line, separator, and message area):
- Show a viewport window that auto-scrolls to keep in-progress
  items visible
- Similar to @inquirer/checkbox pagination: track which slice of
  tickets is visible and adjust as items change state

## TTY Fallback

When `process.stdout` is not a TTY (piped output, CI, redirected
to file):
- Fall back to the current plain `console.log` behavior
- No ANSI escape codes, no cursor movement, no colors

## Rendering Approach

- Use ANSI escape codes directly (or a lightweight library like
  `ansi-escapes`)
- `cursorUp(n)` + `eraseLines(n)` to redraw in place
- Hide cursor during rendering, restore on exit
- Listen to `process.stdout.rows` for terminal height
- Handle `SIGWINCH` (terminal resize) to recalculate layout

## Integration Points

The orchestrator (`src/orchestrator.ts`) currently calls
`console.log` in:
- Wave start announcements
- Ticket start/completion messages
- Agent stdout streaming
- Error/warning messages
- Final summary

These would be replaced with calls to the display module's API
(e.g. `display.setTicketStatus(num, 'done')`,
`display.log(message)`, `display.startWave(waveNum, tickets)`).

## Acceptance Criteria

### terminal-status-ui.AC1: Status list rendering
- **terminal-status-ui.AC1.1 Success:** Each ticket in the current
  wave is displayed as a line with a dot character and filename
- **terminal-status-ui.AC1.2 Success:** Pending tickets show an
  empty/dim dot
- **terminal-status-ui.AC1.3 Success:** In-progress tickets show a
  yellow/amber filled dot
- **terminal-status-ui.AC1.4 Success:** Completed tickets show a
  green filled dot
- **terminal-status-ui.AC1.5 Success:** Failed tickets show a red
  filled dot

### terminal-status-ui.AC2: Status line
- **terminal-status-ui.AC2.1 Success:** Status line shows
  "Wave {current}/{total} -- {pct}% complete"
- **terminal-status-ui.AC2.2 Success:** Percentage reflects current
  wave progress (completed tickets / total in wave)

### terminal-status-ui.AC3: Rolling message area
- **terminal-status-ui.AC3.1 Success:** Message area has a fixed
  height of 3-4 lines at the bottom
- **terminal-status-ui.AC3.2 Success:** New messages push old
  messages out (rolling window)
- **terminal-status-ui.AC3.3 Success:** Agent stdout and
  orchestrator messages both appear in the area

### terminal-status-ui.AC4: Wave transitions
- **terminal-status-ui.AC4.1 Success:** When a wave completes, the
  display clears and shows the next wave's tickets
- **terminal-status-ui.AC4.2 Success:** Status line updates to new
  wave number, percentage resets to 0%

### terminal-status-ui.AC5: Pagination
- **terminal-status-ui.AC5.1 Success:** When ticket list exceeds
  available terminal rows, a viewport window is shown
- **terminal-status-ui.AC5.2 Success:** Viewport auto-scrolls to
  keep in-progress items visible

### terminal-status-ui.AC6: TTY fallback
- **terminal-status-ui.AC6.1 Success:** When stdout is not a TTY,
  falls back to plain console.log behavior
- **terminal-status-ui.AC6.2 Success:** No ANSI escape codes
  emitted when not a TTY

### terminal-status-ui.AC7: Orchestrator integration
- **terminal-status-ui.AC7.1 Success:** runWaves and
  runWavesIsolated use the display module instead of console.log
- **terminal-status-ui.AC7.2 Success:** Agent output streaming
  feeds into the rolling message area

<!-- START_PHASE_1 -->
## Phase 1: Display module types and ANSI utilities (Infrastructure)

Create the foundational types, ANSI escape code helpers, and color
utilities for the display module.

**Components:**
- `src/display/types.ts` -- TicketStatus enum, DisplayTicket type,
  WaveState type, DisplayConfig type
- `src/display/ansi.ts` -- cursor movement, line clearing, color
  codes (green, yellow/amber, red, dim/gray)

**Done when:** `npm run build` compiles without errors.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
## Phase 2: Display renderer core (Functionality)

Build the core display manager that renders the status list, status
line, message area, and handles in-place redraw.

**Components:**
- `src/display/renderer.ts` -- StatusDisplay class with methods:
  - `startWave(waveNum, totalWaves, tickets)` -- initialize wave
  - `setTicketStatus(num, status)` -- update a ticket's dot
  - `log(message)` -- add message to rolling window
  - `render()` -- full redraw using ANSI escapes
  - `cleanup()` -- restore cursor, clear display

**Verifies:** AC1 (status list rendering), AC2 (status line),
AC3 (rolling message area), AC4 (wave transitions)
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
## Phase 3: Pagination and terminal resize (Functionality)

Add viewport management for long ticket lists and handle terminal
resize events.

**Components:**
- Pagination logic in renderer -- viewport tracking, auto-scroll
  to active items
- `SIGWINCH` handler for terminal resize
- Viewport indicator (e.g. "... and N more below")

**Verifies:** AC5 (pagination)
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
## Phase 4: Orchestrator integration (Functionality)

Replace `console.log` calls in the orchestrator with display module
calls. Add TTY detection for fallback behavior.

**Components:**
- `src/display/index.ts` -- public API, TTY detection, factory
- Modifications to `src/orchestrator.ts` -- replace console.log
  with display API calls in runWaves and runWavesIsolated
- Fallback to plain console.log when stdout is not a TTY

**Verifies:** AC6 (TTY fallback), AC7 (orchestrator integration)
<!-- END_PHASE_4 -->
