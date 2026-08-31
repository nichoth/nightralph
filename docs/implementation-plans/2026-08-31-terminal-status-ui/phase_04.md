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

### terminal-status-ui.AC6: TTY fallback
- **terminal-status-ui.AC6.1 Success:** When stdout is not a
  TTY, falls back to plain console.log behavior
- **terminal-status-ui.AC6.2 Success:** No ANSI escape codes
  emitted when not a TTY

### terminal-status-ui.AC7: Orchestrator integration
- **terminal-status-ui.AC7.1 Success:** runWaves and
  runWavesIsolated use the display module instead of
  console.log
- **terminal-status-ui.AC7.2 Success:** Agent output streaming
  feeds into the rolling message area

---

## Phase 4: Orchestrator Integration (Functionality)

This phase connects the display module to the orchestrator,
replacing `console.log` calls with display API methods and
adding TTY detection for graceful fallback.

**Integration strategy:**
- Define a `Display` type with the public API
  (startWave, setTicketStatus, log, cleanup)
- Create `PlainDisplay` class that uses console.log
  (preserves current behavior)
- Add `createDisplay()` factory with TTY detection
- Add optional `display` parameter to orchestrator functions
- Add optional `onLine` callback to `spawnAgent` to redirect
  agent stdout to the display

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add Display type and PlainDisplay class

**Verifies:** terminal-status-ui.AC6.1, terminal-status-ui.AC6.2

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add a `Display` type that defines the public interface:

```typescript
export type Display = {
    startWave(
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<{
            num:number
            filename:string
        }>
    ):void
    setTicketStatus(num:number, status:TicketStatus):void
    log(message:string):void
    cleanup():void
}
```

Add `PlainDisplay` class that implements `Display` using
plain console.log (no ANSI codes):

```typescript
export class PlainDisplay implements Display {
    startWave (
        waveNum:number,
        _totalWaves:number,
        tickets:ReadonlyArray<{
            num:number
            filename:string
        }>
    ):void {
        console.log(
            `\nWave ${waveNum}: ` +
            tickets.map(t => t.filename).join(', ')
        )
    }

    setTicketStatus (
        _num:number,
        _status:TicketStatus
    ):void {
        // no-op: plain mode reports via log()
    }

    log (message:string):void {
        console.log(message)
    }

    cleanup ():void {
        // no-op
    }
}
```

Note: `PlainDisplay` uses `implements Display` (interface
usage for class contract, per the TypeScript house style
exception). The `Display` type is used as a type alias,
not a class contract -- but since both `PlainDisplay` and
`StatusDisplay` implement it, using `implements` here is
acceptable for type-checking.

Actually, since the TypeScript house style says use `type`
not `interface`, and `implements` works with type aliases
in TypeScript, both classes can do
`class Foo implements Display` where `Display` is a type.

**Testing:**
Tests must verify:
- terminal-status-ui.AC6.1: PlainDisplay.log() outputs via
  console.log
- terminal-status-ui.AC6.2: PlainDisplay output contains no
  ANSI escape codes (no \x1b sequences)

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add Display type and PlainDisplay class`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add createDisplay() factory

**Verifies:** terminal-status-ui.AC6.1

**Files:**
- Modify: `src/display.ts`

**Implementation:**

Add an exported factory function:

```typescript
export function createDisplay (
    stream?:NodeJS.WriteStream
):Display {
    const s = stream ?? process.stdout
    if (s.isTTY) {
        return new StatusDisplay({ stream:s })
    }
    return new PlainDisplay()
}
```

When `stream.isTTY` is true, returns a `StatusDisplay`
(ANSI rendering). Otherwise returns a `PlainDisplay`
(plain console.log fallback).

Also make `StatusDisplay` implement `Display`:
```typescript
export class StatusDisplay implements Display {
    // ... existing implementation from Phase 2/3
}
```

**Testing:**
Tests must verify:
- terminal-status-ui.AC6.1: createDisplay returns
  PlainDisplay when stream.isTTY is false/undefined,
  returns StatusDisplay when isTTY is true

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add createDisplay factory with TTY detection`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Add onLine callback to spawnAgent

**Verifies:** terminal-status-ui.AC7.2

**Files:**
- Modify: `src/orchestrator.ts`

**Implementation:**

Add an optional `onLine` callback to spawnAgent's opts:

```typescript
export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
    onLine?:(line:string) => void  // NEW
}):Promise<AgentResult> {
```

In the readline `'line'` handler (around line 473-491),
when `opts.onLine` is provided, call it instead of
`console.log`:

```typescript
rl.on('line', line => {
    // ... existing formatting logic (unchanged) ...
    // Replace console.log calls with:
    if (opts.onLine) {
        opts.onLine(`${prefix}${formatted}`)
    } else {
        console.log(`${prefix}${formatted}`)
    }
})
```

Apply the same pattern to the stderr readline handler
(around line 494-496):

```typescript
rlErr.on('line', line => {
    if (opts.onLine) {
        opts.onLine(`${prefix}${line}`)
    } else {
        console.error(`${prefix}${line}`)
    }
})
```

This is backward-compatible: when `onLine` is not provided,
behavior is unchanged.

**Testing:**
Tests must verify:
- terminal-status-ui.AC7.2: when onLine is provided,
  agent output lines are passed to the callback instead
  of being printed to console

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: add onLine callback to spawnAgent`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Integrate display into runWaves

**Verifies:** terminal-status-ui.AC7.1, terminal-status-ui.AC7.2

**Files:**
- Modify: `src/orchestrator.ts`

**Implementation:**

Add import at top of orchestrator.ts:
```typescript
import {
    createDisplay,
    type Display,
    type TicketStatus,
} from './display.js'
```

Add optional `display` parameter to `runWaves`:
```typescript
export async function runWaves (
    tickets:Ticket[],
    specBody:string,
    agentCmd:string,
    model:string|null,
    timeout:number,
    logsDir:string,
    display?:Display,  // NEW
):Promise<{ allDone:boolean }> {
```

At the top of the function, default display if not provided
and pre-count total waves:

```typescript
const d = display ?? createDisplay()
let totalWaves = 0
for (const _ of simulateWaves(tickets)) totalWaves++
```

Replace the console.log calls in runWaves:

1. **Wave header** (line 711-714): Replace with
   ```typescript
   d.startWave(
       waveNum,
       totalWaves,
       ready.map(t => ({
           num:t.num,
           filename:t.filename,
       }))
   )
   ```

2. **Starting ticket** (line 726): Replace with
   ```typescript
   d.setTicketStatus(t.num, 'in-progress')
   d.log(`  Starting ${t.filename}`)
   ```

3. **Agent failure** (line 744-747): Replace with
   ```typescript
   d.setTicketStatus(ticket.num, 'failed')
   d.log(`  ${ticket.filename}: agent exited ${result.exitCode}`)
   ```

4. **Ticket done** (line 755-757): Replace with
   ```typescript
   d.setTicketStatus(ticket.num, 'done')
   d.log(`  ${ticket.filename}: done`)
   ```

5. **No tickets completed** (line 761-764): Replace with
   ```typescript
   d.log('\nNo tickets completed this wave. Stopping.')
   ```

6. **Final summary** (line 772-777): Replace with
   ```typescript
   d.log(`\nFinished: ${totalCompleted} completed` + ...)
   d.cleanup()
   ```

7. **Pass onLine to spawnAgent** (where spawnAgent is called):
   ```typescript
   spawnAgent({
       // ...existing opts...
       onLine:(line) => d.log(line),
   })
   ```

**Testing:**
Tests must verify:
- terminal-status-ui.AC7.1: runWaves uses the provided
  display instead of console.log
- terminal-status-ui.AC7.2: agent output reaches the
  display via onLine callback

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: integrate display into runWaves`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Integrate display into runWavesIsolated

**Verifies:** terminal-status-ui.AC7.1, terminal-status-ui.AC7.2

**Files:**
- Modify: `src/orchestrator.ts`

**Implementation:**

Add optional `display` to `runWavesIsolated` opts:
```typescript
export async function runWavesIsolated (opts:{
    tickets:Array<Ticket>
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    featureName:string
    conflictStrategy:MergeConflictStrategy
    display?:Display  // NEW
}):Promise<{ allDone:boolean }> {
```

At the top of the function:
```typescript
const d = opts.display ?? createDisplay()
let totalWaves = 0
for (const _ of simulateWaves(opts.tickets)) totalWaves++
```

Replace console.log calls in runWavesIsolated following the
same pattern as Task 4. The call sites to replace:

1. **Wave header** (line 820-823): `d.startWave(...)`
2. **Worktree creation failure** (line 844-847):
   `d.setTicketStatus(t.num, 'failed')` +
   `d.log(...)`
3. **Starting ticket** (line 864):
   `d.setTicketStatus(t.num, 'in-progress')` +
   `d.log(...)`
4. **Agent failure** (line 894-896):
   `d.setTicketStatus(ticket.num, 'failed')` +
   `d.log(...)`
5. **Auto-commit** (line 930-933): `d.log(...)`
6. **No changes** (line 940-944):
   `d.setTicketStatus(ticket.num, 'failed')` +
   `d.log(...)`
7. **Awaiting merge** (line 949-952): `d.log(...)`
8. **Merge success** (line 982-984):
   `d.setTicketStatus(ticket.num, 'done')` +
   `d.log(...)`
9. **Respawn recovery** (line 1035-1038):
   `d.setTicketStatus(ticket.num, 'done')` +
   `d.log(...)`
10. **Merge failure** (line 1063-1066):
    `d.setTicketStatus(ticket.num, 'failed')` +
    `d.log(...)`
11. **Merge stopped** (line 1072-1074): `d.log(...)`
12. **No tickets completed** (line 1096-1099): `d.log(...)`
13. **Final summary** (line 1107-1112): `d.log(...)` +
    `d.cleanup()`
14. **Respawn messages**: `respawnAndRetryMerge` is a
    separate private function (line 635) that has its own
    opts parameter. It contains console.log calls at lines
    651-653, 674-677, 685-688, and a `spawnAgent` call at
    line 663. To route output through the display:
    - Add `onLine?:(msg:string) => void` to
      `respawnAndRetryMerge`'s opts
    - Replace its console.log calls with
      `if (opts.onLine) opts.onLine(msg) else console.log(msg)`
    - Pass `onLine` to its `spawnAgent` call at line 663
    - When calling `respawnAndRetryMerge` from
      `runWavesIsolated`, pass
      `onLine:(msg) => d.log(msg)`

Replace console.error calls (worktree cleanup failures at
lines 914-918, 1003-1007, 1055-1059, 1083-1087) with
`d.log(...)` as well -- these are informational, not
critical errors.

Pass `onLine` to all spawnAgent calls within
runWavesIsolated:
```typescript
onLine:(line) => d.log(line)
```

**Testing:**
Tests must verify:
- terminal-status-ui.AC7.1: runWavesIsolated uses the
  provided display instead of console.log

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No errors.

**Commit:** `feat: integrate display into runWavesIsolated`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Update CLI entry point

**Verifies:** terminal-status-ui.AC7.1

**Files:**
- Modify: `src/index.ts`

**Implementation:**

Import `createDisplay` from `./display.js` and create a
display instance before calling `runWaves` or
`runWavesIsolated`. Pass it as the `display` parameter.

Find the call site(s) in `src/index.ts` where `runWaves`
or `runWavesIsolated` are called. Add:

```typescript
const display = createDisplay()
```

Then pass `display` to the orchestrator function call.

This ensures the display is created once per CLI invocation,
with TTY detection happening at the top level.

**Testing:**
This is tested end-to-end via the orchestrator integration
tests. No separate test needed for the CLI entry point
wiring.

**Verification:**
Run: `npm run build`
Expected: Build succeeds.

**Commit:** `feat: wire display into CLI entry point`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Integration and TTY fallback tests

**Verifies:** terminal-status-ui.AC6.1, terminal-status-ui.AC6.2,
terminal-status-ui.AC7.1, terminal-status-ui.AC7.2

**Files:**
- Modify: `test/display.test.ts`

**Implementation:**

Add integration tests to the existing display test file:

1. **PlainDisplay outputs no ANSI**: Create a PlainDisplay,
   call startWave, setTicketStatus, log. Capture console.log
   output (mock console.log temporarily). Verify none of
   the output contains `\x1b[` (ANSI escape prefix).

2. **createDisplay returns PlainDisplay for non-TTY**: Create
   a mock stream with `isTTY: false`. Call `createDisplay(stream)`.
   Verify the returned object is an instance of PlainDisplay
   (or verify its log method does not produce ANSI output).

3. **createDisplay returns StatusDisplay for TTY**: Create
   a mock stream with `isTTY: true`, `rows: 24`,
   `write: mock`. Call `createDisplay(stream)`. Verify the
   returned object is an instance of StatusDisplay (or
   verify its log method produces output on the stream).

4. **spawnAgent onLine callback**: This test is complex
   because it requires spawning a process. If the project
   already has mock agent scripts (it does:
   `test/mock-agent-*.js`), use one. Create a spawnAgent
   call with `onLine` set to a function that collects
   lines. Verify that agent output lines arrive via the
   callback, not console.log.

Follow project testing patterns. Task-implementor generates
actual test code at execution time.

**Verification:**
Run: `npm test`
Expected: All tests pass.

**Commit:** `test: add TTY fallback and integration tests`
<!-- END_TASK_7 -->
