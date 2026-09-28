# Stable ticket list implementation plan -- phase 1

**Goal:** `StatusDisplay` renders one fixed ticket list for the whole
run, with a `blocked` status and a header that counts over that list.

**Architecture:** The `Display` interface gains `startRun(tickets)`
(called once) and `setBlocked(num, feature, blockedBy)`. `startWave`
loses its `remaining` parameter and, in `StatusDisplay`, only updates
the wave number. `StatusDisplay` derives done/total from its own list.
`PlainDisplay` gets no-op implementations and keeps its output.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild, tapzero tests.

**Scope:** Phase 1 of 3 from
`docs/design-plans/2026-09-28-stable-ticket-list.md`.

**Codebase verified:** 2026-09-28

---

## Acceptance Criteria Coverage

This phase implements and tests:

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
- **stable-ticket-list.AC1.5 Success:** `startWave` does not reset
  the status of any ticket in the fixed list.
- **stable-ticket-list.AC1.7 Edge:** `startWave` called without a
  prior `startRun` seeds the list from that wave's tickets; a later
  `startWave` never replaces it.
- **stable-ticket-list.AC1.8 Edge:** `setTicketStatus` for a ticket
  not in the fixed list is ignored and does not add a row.
- **stable-ticket-list.AC1.9 Edge:** With more tickets than terminal
  rows, pagination and auto-scroll to the in-progress ticket still
  work against the fixed list.

### stable-ticket-list.AC2: Failed and blocked tickets are visible
- **stable-ticket-list.AC2.5 Success:** The blocked dot is visually
  distinct from pending, in-progress, awaiting-merge, done, and
  failed.
- **stable-ticket-list.AC2.8 Edge:** The row stays within the
  terminal width when the blocked suffix is long (clamped by
  `fitLine`).

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
- **stable-ticket-list.AC4.5 Success:** `PlainDisplay` output
  format is unchanged; `startRun` and `setBlocked` are no-ops there.

---

## Project conventions for every task

- Read `/Users/nick/code/nightralph/AGENTS.md` and
  `/Users/nick/.claude/CLAUDE.md` first.
- Type annotations have no space after the colon (`num:number`).
  Lines stay under 80 columns. Multi-line ternaries put `?` and `:` at
  line ends. Match surrounding code; no FCIS `// pattern:` comments.
- Tests use `@substrate-system/tapzero` and the `MockStream` /
  `createMockStream` helper at `test/display.test.ts:27-75`. Never
  assert on whole rendered strings. Assert on ticket labels (identity),
  extracted numbers, dot escape codes from `renderDot`, and row order.
- Run one test file:
  `npx esbuild test/display.test.ts --format=esm --bundle --packages=external --outdir=dist/test --sourcemap && node dist/test/display.test.js`
- Full suite: `npm test`. Lint: `npm run lint`. Build: `npm run build`
  (runs `tsc --emitDeclarationOnly`, so type errors fail it).
- TypeScript `lib` is ES2021 (`tsconfig.json:8`): no `toSorted`; use
  `[...arr].sort(...)`.

- Nothing type-checks `test/`: `tsconfig.build.json` excludes it and
  esbuild strips types without checking. A `Display` double that is
  missing a method only fails at runtime, when the orchestrator calls
  it. After changing the `Display` type, check every double by hand:
  `grep -n "startWave (" test/*.ts test/*.mjs`.

A useful test helper (add near `createMockStream` in
`test/display.test.ts`): `lastFrame(output)` strips ANSI (same regex
the file already uses at line 432), finds the last match of
`/Wave \d+\/\d+/` (every render starts with the header; a bare
`'Wave '` search could match a log line), and returns the text from
there. Tests can then split it into rows and read labels in order.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Display types, blocked dot, exported label helper

**Verifies:** stable-ticket-list.AC2.5, stable-ticket-list.AC4.5

**Files:**
- Modify: `src/display.ts:1-58` (types and `Display`)
- Modify: `src/display.ts:106-114` (`ticketLabel`, export it)
- Modify: `src/display.ts:153-168` (`renderDot`)
- Modify: `src/display.ts:442-487` (`PlainDisplay`)
- Modify: `src/orchestrator.ts:1877-1898` and `src/orchestrator.ts:2148-2166`
  (drop the `remaining` argument; see below)
- Modify: `test/orchestrator.test.ts:3849-3855`,
  `test/integration.test.ts:3692-3697`,
  `test/display.test.ts:1211-1268` (`RecordingDisplay`) (test doubles)
- Test: `test/display.test.ts` (unit)

**Implementation:**

1. `TicketStatus`: add `| 'blocked'`.
2. `DisplayTicket`: add optional `blockedBy?:ReadonlyArray<string>`.
3. Add and export a ref type used by every `Display` method that takes
   tickets, replacing the repeated inline shapes:
   ```ts
   export type TicketRef = {
       readonly num:number
       readonly filename:string
       readonly feature?:string
   }
   ```
4. `WaveState`: drop `tickets`, leaving `{ waveNum, totalWaves }`
   (the list now lives on `StatusDisplay` directly; `WaveState` is only
   used inside `src/display.ts`).
5. `Display`:
   ```ts
   export type Display = {
       startRun(tickets:ReadonlyArray<TicketRef>):void
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
       setBlocked(
           num:number,
           feature:string|undefined,
           blockedBy:ReadonlyArray<string>,
       ):void
       log(message:string):void
       cleanup():void
   }
   ```
   Add a short doc comment on `startRun` (called once, fixes the list)
   and `setBlocked` (`blockedBy` holds display labels).
6. Export `ticketLabel` unchanged (Phase 2 uses it to build labels).
7. `renderDot`: `case 'blocked': return color.dim(FILLED_DOT)`, with a
   one-line comment: the ticket cannot run this session because an
   upstream ticket failed or needs a human.
8. `PlainDisplay`: add no-op `startRun` and `setBlocked` (comment like
   the existing `setTicketStatus` no-op). Remove the `_remaining`
   parameter from `startWave`. Do not change what it prints.
9. `StatusDisplay` must still compile: in this task, make the minimal
   change so it type-checks (add stub `startRun`/`setBlocked` that
   Task 2 replaces, and drop its `remaining` parameter). Task 2 does
   the real rework.
10. `src/orchestrator.ts`: in both loops delete the `readyKeys` and
    `remaining` computation and the fifth `startWave` argument. Nothing
    else in the orchestrator changes in this phase. Between Phase 1
    and Phase 2 the TTY display is temporarily incomplete: with no
    `startRun` call, `StatusDisplay` seeds its list from wave 1 only,
    so in a multi-wave run tickets from wave 2 on never appear and
    their status updates are ignored. Phase 2 fixes this by calling
    `startRun`. Do not release between the two phases.
11. Test doubles:
    - Add `startRun () {}` and `setBlocked () {}` to the object
      literals at `test/orchestrator.test.ts:3849` and
      `test/integration.test.ts:3692`.
    - `RecordingDisplay` (`test/display.test.ts:1211`,
      `implements Display`): drop the `remaining` parameter from
      `startWave` (record `[waveNum, totalWaves, tickets, progress]`),
      and add `startRun (tickets)` and
      `setBlocked (num, feature, blockedBy)` methods that push
      `{ method:'startRun', args:[tickets] }` and
      `{ method:'setBlocked', args:[num, feature, blockedBy] }`, so
      `getCallsByMethod` works for them. Without these, Phase 2
      crashes the tests at `test/display.test.ts:1372`, `1461` and
      `1538` with "d.startRun is not a function".
12. `test/demo-display.mjs`: call `d.startRun([...all five
    tickets])` before `startWave`, and drop the fifth argument, so
    `npm run demo` still works. Where the demo marks ticket 3
    `failed`, also call `d.setBlocked(5, undefined,
    ['03-dashboard-ui.md'])` so the demo shows a blocked row for the
    manual check in `test-requirements.md`.

**Testing:**
- AC2.5: `renderDot('blocked')` differs from `renderDot` of each of the
  other five statuses.
- AC4.5: a `PlainDisplay` (capture `console.log` the way the test at
  `test/display.test.ts:1135` does) prints the same wave line with and
  without `startRun`/`setBlocked` calls, and those two calls print
  nothing.

**Verification:**
Run: `npm run build && npm run lint`
Expected: no errors. (This checks `src/` types only; tests are not
type-checked.)
Run: `grep -n "startWave (" test/*.ts test/*.mjs`
Expected: every double found also defines `startRun` and
`setBlocked`.
Run the display test file (command above).
Expected: the two new tests pass. Tests that rely on the old
list-replacing and `remaining` behavior still fail at this point
(`test/display.test.ts:115`, `:738-869`, `:1309`); Task 2 rewrites
them. Do not commit until Task 2 is done.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: StatusDisplay holds the fixed list

**Verifies:** stable-ticket-list.AC1.1, AC1.2, AC1.3, AC1.5, AC1.7,
AC1.8, AC1.9, AC2.8, AC3.1, AC3.2, AC3.3, AC3.4, AC3.5

**Files:**
- Modify: `src/display.ts:170-439` (`StatusDisplay`)
- Test: `test/display.test.ts` (unit)

**Implementation:**

Fields: replace `wave:WaveState|null` (keep the name, new shape),
`progress`, and `remaining` with:
```ts
private wave:WaveState|null = null
private tickets:Array<DisplayTicket> = []
private hasRun:boolean = false
```
Keep `messages`, `renderedLines`, `config`, `viewportStart`,
`resizeListener`.

Add a private finder used by both status setters, same matching rule
as today (`src/display.ts:248-251`):
```ts
private findTicket (
    num:number,
    feature?:string,
):DisplayTicket|null {
    const found = feature ?
        this.tickets.find(
            t => t.num === num && t.feature === feature,
        ) :
        this.tickets.find(t => t.num === num)
    return found ?? null
}
```

`startRun(tickets)`: set `this.tickets` to copies with
`status:'pending'`, set `hasRun = true`, `viewportStart = 0`. Do not
render (there is no header yet; the first `startWave` renders).

`startWave(waveNum, totalWaves, tickets, _progress?)`:
- If `!this.hasRun`, seed `this.tickets` from `tickets` (pending) and
  set `hasRun = true`. This keeps `StatusDisplay` usable without
  `startRun` (AC1.7) and keeps the many existing tests working.
- Set `this.wave = { waveNum, totalWaves }`.
- Keep today's `messages = []`, `viewportStart = 0`, cursor hide and
  resize-listener handling (`src/display.ts:221-236`).
- Never touch statuses.
- `progress` is unused by `StatusDisplay`; name it `_progress`.

`setTicketStatus`: same as today but look up with `findTicket`, and
compute the auto-scroll index with `this.tickets.indexOf(ticket)` and
`this.tickets.length`. Unknown tickets are ignored (AC1.8). Remove the
`if (!this.wave) return` guard: the fixed list exists from `startRun`,
so updates before the first wave are kept, and `render()` already does
nothing without a wave.

`setBlocked(num, feature, blockedBy)`: find the row; if absent,
return. Set `status = 'blocked'` and `blockedBy = [...blockedBy]`,
then `render()`. No wave guard, same as `setTicketStatus`.

`render()`:
- `const done = this.tickets.filter(t => t.status === 'done').length`
- `const total = this.tickets.length`
- `const pct = total === 0 ? 0 : Math.round((done / total) * 100)`
- Header, clamped like every other row so the width guarantee in
  `AGENTS.md` holds (the new header is longer; e.g.
  `Wave 12/15 - 35/120 done - 29%` would wrap at 30 columns):
  ```ts
  const header = `Wave ${this.wave.waveNum}/` +
      `${this.wave.totalWaves} - ` +
      `${done}/${total} done - ${pct}%`
  output += fitLine(header, width) + '\n'
  ```
  (`width` is already computed above the header today; move the
  header below it if needed.)
- Row list is `this.tickets` (replace the
  `[...this.wave.tickets, ...this.remaining]` array at
  `src/display.ts:329-332`).
- Row text: extract a small module-level function used by both the
  unpaginated and paginated branches:
  ```ts
  function rowText (ticket:DisplayTicket):string {
      const label = ticketLabel(ticket)
      if (ticket.status !== 'blocked' || !ticket.blockedBy?.length) {
          return label
      }
      return `${label} (blocked by ${ticket.blockedBy.join(', ')})`
  }
  ```
  and render `${dot} ${fitLine(rowText(ticket), width - 2)}`.
- Everything else in `render` (pagination, separator, log rows,
  `renderedLines`) stays as is.

**Testing:** rewrite or replace these existing tests, keeping their
intent where it still applies:
- `test/display.test.ts:115` "startWave resets ticket list on second
  call": invert it. After `startRun([a, b])`, `startWave(1, ..., [a])`,
  `startWave(2, ..., [b])`, the last frame still contains both labels.
- `test/display.test.ts:291` header regex: assert the header carries
  wave `N/M`, `done/total` and a percent, by extracting numbers with a
  regex, not by matching the whole line.
- `test/display.test.ts:375` "percentage reflects overall run progress
  when given": replace with a test that the percent comes from the
  fixed list (a `progress` argument that disagrees is ignored).
- `test/display.test.ts:738-869` (`remaining` tests): rewrite using
  `startRun` for the same behaviors (non-wave tickets render with the
  dim empty dot, are included in pagination).
- `test/display.test.ts:1309` "runWaves passes remaining tickets to
  startWave": delete it. The orchestrator no longer passes
  `remaining`; Phase 2 Task 2 adds the replacement (`startRun` gets
  the full session set) in the same place.
- `test/display.test.ts:412` "rendered lines never exceed terminal
  width": tighten the bound from a fixed `40` to `stream.columns - 1`
  so it covers the header too.

New tests:
- AC1.1: `startRun` with 4 tickets, `startWave` with 1 of them; all 4
  labels in the last frame.
- AC1.2 / AC1.5: set ticket 1 `done` in wave 1, `startWave` for wave 2;
  ticket 1's row still has the green dot (`renderDot('done')`), and a
  `failed` ticket keeps the red dot.
- AC1.3: label order in the last frame equals the `startRun` order
  after a sequence of `startWave` and `setTicketStatus` calls that
  touch tickets in non-list order.
- AC1.7: no `startRun`; `startWave(1, 2, [a, b])` then
  `startWave(2, 2, [c])`; last frame has `a` and `b`, not `c`.
- AC1.8: `setTicketStatus` for a num not in the list; row count in the
  last frame is unchanged and no new label appears.
- AC1.9: `stream.rows` small enough to paginate; `startRun` with many
  tickets; setting a ticket below the viewport to `in-progress` makes
  its label visible (mirror `test/display.test.ts:959`).
- AC2.8: `stream.columns = 30`; `setBlocked` with a long `blockedBy`
  list; every row of the last frame, header included, is at most
  `columns - 1` visible characters (mirror
  `test/display.test.ts:412`), and the blocked row shows
  `renderDot('blocked')`.
- Blocked suffix names the blocker (supports AC2.2 at the display
  level): `startRun` with `f/01` and `f/02`, `setBlocked(2, 'f',
  ['f/01'])`, `startWave`; in the last frame, the row containing
  `f/02` also contains `f/01`. This checks label identity only, not
  the surrounding wording. With the default 80 columns, also call
  `setBlocked(2, 'f', ['f/01', 'f/03'])` and check that row contains
  both labels (two blockers, AC2.4 at the display level).
- AC3.2 / AC3.3: after `startRun` with 5 tickets and `startWave`, the
  header numbers are done 0, total 5, percent 0.
- AC3.4: all 5 set `done`; percent 100.
- AC3.5: mark some `failed` and some via `setBlocked`; done count only
  counts `done` rows.

**Verification:**
Run: the display test file, then `npm test`
Expected: all tests pass.
Run: `npm run build && npm run lint`
Expected: no errors.
Run: `npm run demo` and stop it with Ctrl-C after it finishes
drawing.
Expected: all five tickets stay listed while statuses change.

**Commit:**
```bash
git add src/display.ts src/orchestrator.ts test/display.test.ts \
    test/orchestrator.test.ts test/integration.test.ts \
    test/demo-display.mjs
git commit -m "feat(display): fixed ticket list with blocked status"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
