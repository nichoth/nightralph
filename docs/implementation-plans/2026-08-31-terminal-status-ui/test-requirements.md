# Terminal Status UI -- Test Requirements

Maps each acceptance criterion to automated tests or documented
human verification. All automated tests use
`@substrate-system/tapzero` and live in `test/display.test.ts`.

**Testing approach:** The `StatusDisplay` class accepts a custom
`stream` in its config. Tests pass a mock writable stream (an
object with a `write` method that appends to a string buffer)
to capture rendered output. Content assertions use
`t.ok(output.includes(...))` to verify behavioral patterns --
never exact ANSI sequences or exact text layout.

**Phase 1 is infrastructure** (types, ANSI helpers, build config).
It has no acceptance criteria and no tests. Verified
operationally by `npm run build`.

---

## AC1: Status list rendering

### AC1.1 -- Each ticket displayed as dot + filename

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave with two tickets. Capture
  rendered output. Assert that each ticket's filename appears
  in the output. Assert that a dot character (filled or empty)
  appears on the same line as the filename.
- **Phase:** 2

### AC1.2 -- Pending tickets show empty/dim dot

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave (all tickets begin as pending).
  Capture output. Assert that the empty dot character appears
  for each ticket line.
- **Phase:** 2

### AC1.3 -- In-progress tickets show yellow/amber filled dot

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave, set one ticket to in-progress.
  Capture output. Assert that the filled dot character appears
  on that ticket's line.
- **Human verification:** The dot actually renders as yellow in
  a real terminal. Automated tests can confirm the filled dot
  character is present but cannot verify perceived color.
  Verify by running the display manually in a terminal and
  confirming the in-progress dot is visually yellow/amber.
- **Phase:** 2

### AC1.4 -- Completed tickets show green filled dot

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave, set one ticket to done.
  Capture output. Assert that the filled dot character appears
  on that ticket's line.
- **Human verification:** Same as AC1.3 -- color appearance
  (green) requires visual confirmation in a real terminal.
- **Phase:** 2

### AC1.5 -- Failed tickets show red filled dot

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave, set one ticket to failed.
  Capture output. Assert that the filled dot character appears
  on that ticket's line.
- **Human verification:** Same as AC1.3 -- color appearance
  (red) requires visual confirmation in a real terminal.
- **Phase:** 2

---

## AC2: Status line

### AC2.1 -- Status line shows wave/total and percentage

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start wave 2 of 3. Capture output. Assert
  that output includes "Wave 2/3" and "% complete". Do not
  assert the exact format template -- just that the wave number,
  total, and percentage label are present.
- **Phase:** 2

### AC2.2 -- Percentage reflects current wave progress

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start a wave with 4 tickets. Mark 2 as
  done. Capture output. Assert that "50%" appears in the
  output. Mark all 4 done, assert "100%" appears.
- **Phase:** 2

---

## AC3: Rolling message area

### AC3.1 -- Fixed height of 3-4 lines

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Create a display with `messageLines: 3`.
  Start a wave and log 1 message. Capture output. Count
  the lines in the message area (below the separator).
  Assert there are exactly 3 lines (the message plus
  empty padding lines).
- **Phase:** 2

### AC3.2 -- Rolling window pushes old messages out

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Create a display with `messageLines: 3`.
  Log 5 messages with distinct identifiers. Capture output
  after the 5th message. Assert that message 5 appears in
  the output and message 1 does not.
- **Phase:** 2

### AC3.3 -- Agent stdout and orchestrator messages both appear

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Call `log()` with an agent-style message
  (e.g. containing a bracket-prefixed identifier) and an
  orchestrator-style message (e.g. containing a status
  keyword). Capture output. Assert both messages appear.
  The display module does not distinguish message sources,
  so this confirms any string passed to `log()` is rendered.
- **Phase:** 2

---

## AC4: Wave transitions

### AC4.1 -- Display clears and shows new wave's tickets

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start wave 1 with tickets A and B. Then
  start wave 2 with tickets C and D. Capture output after
  the second `startWave` call. Assert that filenames C and
  D appear in the output, and filenames A and B do not.
- **Phase:** 2

### AC4.2 -- Status line updates to new wave, percentage resets

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Start wave 1, mark tickets done (percentage
  reaches 100%). Start wave 2 with fresh tickets. Capture
  output. Assert that "Wave 2" appears and "0%" appears
  (percentage reset).
- **Phase:** 2

---

## AC5: Pagination

### AC5.1 -- Viewport window when tickets exceed terminal rows

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Create a display with a mock stream whose
  `rows` property is set small (e.g. 12). Start a wave with
  more tickets than the available rows (e.g. 20 tickets).
  Capture output. Assert that not all 20 filenames appear in
  the output (only a subset is rendered). Assert that an
  overflow indicator containing "more" appears.
- **Phase:** 3

### AC5.2 -- Viewport auto-scrolls to keep in-progress visible

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Same small-terminal setup as AC5.1 with 20
  tickets. Set a ticket near the end (e.g. ticket 18) to
  in-progress. Capture output. Assert that ticket 18's
  filename appears in the rendered output (viewport scrolled
  to include it).
- **Phase:** 3

### AC5 (resize) -- Terminal resize triggers re-render

- **Human verification only**
- **Justification:** Testing SIGWINCH / the `resize` event
  on a stream requires either a real TTY or deep mocking of
  Node stream internals, which produces brittle tests. The
  implementation registers a listener on the stream's
  `resize` event and calls `render()`. Verifying that
  `render()` produces correct output for different `rows`
  values is already covered by the viewport tests above.
  The event wiring itself is a single line that is best
  verified by resizing a terminal window while the display
  is active.
- **Verification approach:** Run nightralph with enough
  tickets to trigger pagination. Resize the terminal window.
  Confirm the display re-renders with the updated viewport
  size -- more or fewer tickets become visible.

---

## AC6: TTY fallback

### AC6.1 -- Non-TTY falls back to plain console.log behavior

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description (PlainDisplay):** Create a `PlainDisplay`
  instance. Call `startWave()` and `log()`. Mock or capture
  `console.log` output. Assert that the logged messages
  appear in the captured output.
- **Description (createDisplay factory):** Call
  `createDisplay()` with a mock stream where `isTTY` is
  `false` (or undefined). Assert the returned object is a
  `PlainDisplay` instance (or verify its behavior produces
  no ANSI codes). Call with a mock stream where `isTTY` is
  `true`. Assert the returned object is a `StatusDisplay`
  instance.
- **Phase:** 4

### AC6.2 -- No ANSI escape codes when not a TTY

- **Test type:** Unit
- **File:** `test/display.test.ts`
- **Description:** Create a `PlainDisplay`. Call `startWave()`,
  `setTicketStatus()`, and `log()`. Capture all console.log
  output. Assert that none of the captured strings contain
  the ANSI escape prefix `\x1b[`.
- **Phase:** 4

---

## AC7: Orchestrator integration

### AC7.1 -- runWaves and runWavesIsolated use display module

- **Test type:** Integration
- **File:** `test/display.test.ts`
- **Description (runWaves):** Call `runWaves` with a mock
  display object that records method calls (startWave,
  setTicketStatus, log, cleanup). Use a mock agent script
  (e.g. `test/mock-agent-pass.js`) and minimal ticket
  fixtures. Assert that the mock display's `startWave` was
  called at least once. Assert that `setTicketStatus` was
  called with `'in-progress'` and later with `'done'` or
  `'failed'`. Assert that `cleanup` was called.
- **Human verification:** Full end-to-end verification of
  `runWavesIsolated` integration requires a git repo with
  worktree support and real agent execution. The automated
  test covers `runWaves`; `runWavesIsolated` follows the
  same display API pattern and is verified by running
  `nightralph <provider>` inside a git repo and confirming
  the terminal UI appears.
- **Phase:** 4

### AC7.2 -- Agent output feeds into rolling message area

- **Test type:** Integration
- **File:** `test/display.test.ts`
- **Description (spawnAgent onLine):** Call `spawnAgent` with
  a mock agent script that writes to stdout and an `onLine`
  callback that collects lines into an array. Assert that the
  callback received at least one line. Assert that console.log
  was not called for those lines (the callback replaced it).
- **Description (end-to-end via runWaves):** In the runWaves
  integration test above, assert that the mock display's
  `log()` method was called with at least one string
  (confirming agent output reached the display).
- **Phase:** 4

---

## Summary

| AC      | Sub  | Automated | Human | Phase |
|---------|------|-----------|-------|-------|
| AC1     | 1.1  | yes       | no    | 2     |
| AC1     | 1.2  | yes       | no    | 2     |
| AC1     | 1.3  | yes       | yes   | 2     |
| AC1     | 1.4  | yes       | yes   | 2     |
| AC1     | 1.5  | yes       | yes   | 2     |
| AC2     | 2.1  | yes       | no    | 2     |
| AC2     | 2.2  | yes       | no    | 2     |
| AC3     | 3.1  | yes       | no    | 2     |
| AC3     | 3.2  | yes       | no    | 2     |
| AC3     | 3.3  | yes       | no    | 2     |
| AC4     | 4.1  | yes       | no    | 2     |
| AC4     | 4.2  | yes       | no    | 2     |
| AC5     | 5.1  | yes       | no    | 3     |
| AC5     | 5.2  | yes       | no    | 3     |
| AC5     | resize | no      | yes   | 3     |
| AC6     | 6.1  | yes       | no    | 4     |
| AC6     | 6.2  | yes       | no    | 4     |
| AC7     | 7.1  | yes       | yes   | 4     |
| AC7     | 7.2  | yes       | no    | 4     |

**Totals:** 18 automated tests, 4 items requiring human
verification (3 are color appearance in a real terminal,
1 is runWavesIsolated end-to-end with worktrees).
