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

## Phase 1: Display Module Types and ANSI Utilities (Infrastructure)

This phase creates the foundational types and ANSI escape code
helpers in a new `src/display.ts` file. It also updates the
build script to include the new module.

**Verifies: None** -- infrastructure phase, verified operationally.

---

<!-- START_TASK_1 -->
### Task 1: Create `src/display.ts` with types

**Files:**
- Create: `src/display.ts`

**Step 1: Create the file with type definitions**

Create `src/display.ts` with the following types:

```typescript
export type TicketStatus =
    | 'pending'
    | 'in-progress'
    | 'done'
    | 'failed'

export type DisplayTicket = {
    readonly num:number
    readonly filename:string
    status:TicketStatus
}

export type WaveState = {
    readonly waveNum:number
    readonly totalWaves:number
    readonly tickets:Array<DisplayTicket>
}

export type DisplayConfig = {
    readonly messageLines:number
    readonly stream:NodeJS.WriteStream
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/display.ts
git commit -m "feat: add display module types"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add ANSI escape code helpers

**Files:**
- Modify: `src/display.ts`

**Step 1: Add ANSI constants and helper functions**

Append to `src/display.ts`:

```typescript
const ESC = '\x1b['

export const ansi = {
    cursorUp(n:number):string {
        return `${ESC}${n}A`
    },
    cursorTo(col:number):string {
        return `${ESC}${col}G`
    },
    eraseLine():string {
        return `${ESC}2K`
    },
    eraseLines(n:number):string {
        let out = ''
        for (let i = 0; i < n; i++) {
            out += ansi.eraseLine()
            if (i < n - 1) out += ansi.cursorUp(1)
        }
        return out
    },
    cursorHide():string {
        return `${ESC}?25l`
    },
    cursorShow():string {
        return `${ESC}?25h`
    },
} as const

export const color = {
    green(text:string):string {
        return `${ESC}32m${text}${ESC}0m`
    },
    yellow(text:string):string {
        return `${ESC}33m${text}${ESC}0m`
    },
    red(text:string):string {
        return `${ESC}31m${text}${ESC}0m`
    },
    dim(text:string):string {
        return `${ESC}2m${text}${ESC}0m`
    },
} as const
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/display.ts
git commit -m "feat: add ANSI escape code helpers"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add dot rendering helper

**Files:**
- Modify: `src/display.ts`

**Step 1: Add dot character constants and rendering function**

Append to `src/display.ts`:

```typescript
const FILLED_DOT = '●'
const EMPTY_DOT = '○'

export function renderDot(status:TicketStatus):string {
    switch (status) {
        case 'pending':
            return color.dim(EMPTY_DOT)
        case 'in-progress':
            return color.yellow(FILLED_DOT)
        case 'done':
            return color.green(FILLED_DOT)
        case 'failed':
            return color.red(FILLED_DOT)
    }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/display.ts
git commit -m "feat: add dot rendering helper"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update build script

**Files:**
- Modify: `package.json`

**Step 1: Add `src/display.ts` to the esbuild entry points**

In `package.json`, locate the `build-esm` script and add
`src/display.ts` to the list of entry points. The existing
script lists files like:

```
esbuild src/index.ts src/orchestrator.ts src/setup.ts src/resolve.ts src/worktree.ts src/progress.ts src/merge.ts --format=esm ...
```

Add `src/display.ts` to this list.

**Step 2: Verify the build**

Run: `npm run build`
Expected: Build completes without errors. `dist/display.js`
exists.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add display module to build"
```
<!-- END_TASK_4 -->
