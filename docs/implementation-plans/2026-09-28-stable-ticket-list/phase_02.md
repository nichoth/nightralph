# Stable ticket list implementation plan -- phase 2

**Goal:** Both wave loops hand the session set to the display once and
report blocked tickets.

**Architecture:** Each loop captures the session set (tickets that are
`ready-for-agent` before the loop starts, sorted by feature then
number) and calls `Display.startRun` when wave 1 starts. A pure helper,
`findBlockedTickets`, finds tickets with a dead upstream ticket; a
small shell helper turns its result into `Display.setBlocked` calls.
Blocked tickets are reported when wave 1 starts, at the top of every
later loop iteration (after the previous wave's outcomes are
recorded), and once after the loop, so no `break` can skip a report.
`runProgress` counts only the session set. The unrecovered
merge-failure branch now marks its row `failed`.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild, tapzero tests.

**Scope:** Phase 2 of 3 from
`docs/design-plans/2026-09-28-stable-ticket-list.md`.

**Codebase verified:** 2026-09-28

---

## Acceptance Criteria Coverage

This phase implements and tests:

### stable-ticket-list.AC1: The ticket list is fixed for the session
- **stable-ticket-list.AC1.4 Success:** The orchestrator passes the
  session set to `startRun` sorted by feature, then ticket number,
  regardless of `scanTickets` order.
- **stable-ticket-list.AC1.6 Edge:** Tickets that were `done` or
  `ready-for-human` at startup are not in the list.

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
- **stable-ticket-list.AC2.6 Success:** A merge failure that adds
  the ticket to `failedKeys` blocks its dependents the same way an
  agent failure does.
- **stable-ticket-list.AC2.7 Edge:** A ticket with a failed blocker
  in a different feature that shares the same number is not marked
  blocked (blockers are resolved within the ticket's own feature).
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

---

## Project conventions for every task

- Read `/Users/nick/code/nightralph/AGENTS.md` and
  `/Users/nick/.claude/CLAUDE.md` first.
- Type annotations have no space after the colon. Lines under 80
  columns. Multi-line ternaries put `?` and `:` at line ends. No FCIS
  `// pattern:` comments.
- TypeScript `lib` is ES2021: use `[...arr].sort(...)`, not
  `toSorted`.
- Nothing type-checks `test/` (esbuild only strips types). A double
  missing a `Display` method fails only when called. Phase 1 already
  added `startRun`/`setBlocked` to every double; re-check with
  `grep -n "startWave (" test/*.ts test/*.mjs` if you add one.
- Pure-helper tests follow `test/orchestrator.test.ts` style: build
  tickets with `makeTicket` (`test/orchestrator.test.ts:96-113`),
  call the function, assert on the return value.
- `runWaves` + display tests live in `test/display.test.ts`
  (section "Tests for AC7: Integration with runWaves", from line
  1208). Reuse what is there: `RecordingDisplay` (line 1211, with
  `getCalls()` / `getCallsByMethod(name)`; Phase 1 added `startRun`
  and `setBlocked` recording), `MockStream` / `createMockStream`
  (lines 27-75), `initTempGitRepo` (line 1272), `MOCK_AGENT_PASS`
  (line 1305). Its `makeTicketBody(status)` takes no blockers, so
  write bodies with a `**Blocked by:** N` line inline, the way the
  test at line 1309 does. Add
  `const MOCK_AGENT_FAIL_TICKET_01 = join(process.cwd(), 'test',
  'mock-agent-fail-ticket-01.js')` next to `MOCK_AGENT_PASS`; that
  agent fails only prompts naming a `01-*.md` ticket.
- `runWavesIsolated` tests live in `test/integration.test.ts` and use
  `initTempGitRepo`, `commitAll`, `process.chdir`, and the worktree
  cleanup loop at `test/integration.test.ts:625-751`.
  `MOCK_FAIL_TICKET_01` is defined there. `installMergeFailingGit`
  (line 1921, used at 1955) forces a merge failure for one branch.
  That file has no recording double; add a small object-literal one
  in the new tests that records `startRun`, `startWave` and
  `setBlocked` calls in order into an array.
- Tests that use a failing mock agent pass `retries:0` (as
  `test/integration.test.ts:799` and `:1579` do), so a failing ticket
  runs once instead of four times. For `runWaves`, `retries` is the
  eleventh positional argument, after `effort`.
- Run one test file:
  `npx esbuild test/display.test.ts --format=esm --bundle --packages=external --outdir=dist/test --sourcemap && node dist/test/display.test.js`
  (same shape for `test/orchestrator.test.ts` and
  `test/integration.test.ts`).

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: findBlockedTickets pure helper

**Verifies:** stable-ticket-list.AC2.2, AC2.3, AC2.4, AC2.7, AC2.9,
AC2.10, AC2.11

**Files:**
- Modify: `src/orchestrator.ts` -- add the function after
  `findReadyTickets` (`src/orchestrator.ts:187-201`)
- Test: `test/orchestrator.test.ts` (unit)

**Implementation:**
```ts
/**
 * Tickets that cannot run this session because a ticket they
 * depend on (directly or through a chain, within their own
 * feature) is dead: in `failedKeys`, or in a status that is
 * neither done nor ready-for-agent, e.g. ready-for-human.
 * Returns ticketKey -> dead upstream ticketKeys. Only
 * ready-for-agent tickets that have not failed are keys. A
 * blocker number with no matching ticket is not dead.
 */
export function findBlockedTickets (
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>,
):Map<string, Array<string>> {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )

    // Depth-first over Blocked-by edges. `visited` is shared by
    // the whole walk from one start ticket and never shrinks, so
    // each upstream ticket is expanded once (linear per start,
    // and cycles terminate). Dead tickets are collected into
    // `found` rather than returned, so a ticket reached by a
    // second path still contributes what it found the first
    // time.
    function collectDead (
        ticket:Ticket,
        visited:Set<string>,
        found:Set<string>,
    ):void {
        for (const b of ticket.blockers) {
            const key = ticketKey(ticket.feature, b)
            if (visited.has(key)) continue
            visited.add(key)
            const blocker = byKey.get(key)
            if (!blocker || blocker.status === 'done') continue
            if (
                failedKeys.has(key) ||
                blocker.status !== 'ready-for-agent'
            ) {
                found.add(key)
                continue
            }
            collectDead(blocker, visited, found)
        }
    }

    const blocked = new Map<string, Array<string>>()
    for (const t of tickets) {
        const key = ticketKey(t.feature, t.num)
        if (t.status !== 'ready-for-agent') continue
        if (failedKeys.has(key)) continue
        const found = new Set<string>()
        collectDead(t, new Set([key]), found)
        if (found.size > 0) blocked.set(key, [...found])
    }
    return blocked
}
```
The `done` check comes before the dead check: a done ticket that is
somehow also in `failedKeys` does not block (it finished).

**Testing** (all with `makeTicket`, feature `'f'` unless noted):
- AC2.2: 1 ready, 2 ready blocked by 1; `failedKeys = {f:1}`. Result
  maps `f:2` to `['f:1']`, and has no key `f:1`.
- AC2.3: 1 failed, 2 blocked by 1, 3 blocked by 2. `f:3` maps to
  `['f:1']`.
- AC2.4: 1 and 2 failed, 3 blocked by 1 and 2. `f:3` maps to both
  (compare sorted).
- AC2.7: feature `a` ticket 1 failed; feature `b` ticket 2 blocked by
  1, and feature `b` ticket 1 is ready. `b:2` is not in the result.
- AC2.9: 1 with status `HUMAN_STATUS`, 2 ready blocked by 1, empty
  `failedKeys`. `f:2` maps to `['f:1']`.
- AC2.10: 1 human, 2 blocked by 1, 3 blocked by 2. `f:3` maps to
  `['f:1']`.
- AC2.11: 1 done, 2 ready, 3 blocked by 1 and 2. Result is empty.
- Diamond: 1 failed; 2 and 3 blocked by 1; 4 blocked by 2 and 3.
  `f:4` maps to exactly `['f:1']` (shared upstream reached twice is
  reported once).
- Missing blocker: 2 blocked by 9 (no ticket 9). Result is empty.
- Cycle: 1 blocked by 2, 2 blocked by 1, both ready. Returns; result
  is empty.
- Dense graph: 200 tickets where ticket `n` is blocked by `n-1` and
  `n-2`, ticket 1 failed. Returns, and every ticket 2..200 maps to
  `['f:1']`. (An exponential walk would not finish; no timing
  assertion needed.)

**Verification:**
Run: the orchestrator test file.
Expected: the new tests pass.

**Commit:** `feat(orchestrator): findBlockedTickets helper`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Session set, startRun, and blocked reporting in both loops

**Verifies:** stable-ticket-list.AC1.4, AC1.6, AC2.1, AC2.6, AC4.1,
AC4.2, AC4.3, AC4.4

**Files:**
- Modify: `src/orchestrator.ts` -- add three helpers next to
  `runProgress` (`src/orchestrator.ts:1831-1836`); `runProgress`
  itself is unchanged, callers pass the session set
- Modify: `src/orchestrator.ts:1861-1898` and after `:2020`
  (`runWaves`)
- Modify: `src/orchestrator.ts:2130-2166`, `:2461-2463`, and after
  `:2544` (`runWavesIsolated`)
- Test: `test/display.test.ts` (runWaves integration),
  `test/integration.test.ts` (runWavesIsolated integration)

**Implementation:**

Add, near `runProgress`, and import `ticketLabel` and the `TicketRef`
type from `./display.js`:
```ts
// Tickets an agent can work on this run, in display order. Must
// be captured before the wave loop: markDone mutates status.
function sessionTickets (
    tickets:ReadonlyArray<Ticket>,
):Array<Ticket> {
    return [...tickets]
        .filter(t => t.status === 'ready-for-agent')
        .sort((a, b) => (
            a.feature.localeCompare(b.feature) || a.num - b.num
        ))
}

function toRef (t:Ticket):TicketRef {
    return { num:t.num, filename:t.filename, feature:t.feature }
}

function reportBlocked (
    d:Display,
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>,
):void {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    for (const [key, dead] of findBlockedTickets(
        tickets, failedKeys
    )) {
        const ticket = byKey.get(key)
        if (!ticket) continue
        const labels = dead
            .map(k => byKey.get(k))
            .filter((t):t is Ticket => t !== undefined)
            .map(t => ticketLabel(toRef(t)))
        d.setBlocked(ticket.num, ticket.feature, labels)
    }
}
```
(`ticketLabel` treats an empty `feature` as absent and falls back to
the filename, matching how `setTicketStatus` is already called with
`t.feature`. `setBlocked` is idempotent, so repeat reports are
harmless.)

Loop shape, identical in both loops (`tickets` is `opts.tickets` in
`runWavesIsolated`):
```ts
const session = sessionTickets(tickets)
// ...existing setup...
while (true) {
    // Outcomes of the previous wave are recorded by now.
    if (waveNum > 0) reportBlocked(d, tickets, failedKeys)

    const ready = /* unchanged */
    if (ready.length === 0) break

    waveNum++
    if (waveNum === 1) {
        d.startRun(session.map(toRef))
        reportBlocked(d, tickets, failedKeys)
    }
    d.startWave(
        waveNum,
        totalWaves,
        ready.map(/* unchanged */),
        runProgress(session),
    )
    // ...rest of the wave unchanged...
}
// Any `break` inside the wave body (no progress, or the -X stop
// at src/orchestrator.ts:2518) skips the top-of-loop report, so
// report once more for the final state.
if (waveNum > 0) reportBlocked(d, tickets, failedKeys)
// ...existing finish summary and cleanup...
```
Concretely:
- `runWaves`: `session` before `while (true)` at
  `src/orchestrator.ts:1868`; the top-of-loop call before `ready` at
  `:1869`; `startRun` block after `waveNum++` at `:1876`;
  `runProgress(session)` at `:1892`; the after-loop call before the
  `const remaining` at `:2021`.
- `runWavesIsolated`: `session` before `while (true)` at
  `src/orchestrator.ts:2136`; the top-of-loop call before `ready` at
  `:2137`; `startRun` block after `waveNum++` at `:2144`;
  `runProgress(session)` at `:2160`; the after-loop call before the
  `const remaining` at `:2545`.

Because `startRun` sits after the `if (ready.length === 0) break`,
a run with nothing ready never calls it, and the `waveNum > 0` guards
keep the other calls out of that case too (AC4.4).

Merge failure turns the row red. In the unrecovered-merge `else` at
`src/orchestrator.ts:2461`, right after `failedKeys.add(...)`, add:
```ts
d.setTicketStatus(ticket.num, 'failed', ticket.feature)
```
Today that row is left cyan (`awaiting-merge`, set at `:1699`) and
the next `startWave` hides it; with a fixed list it would stay cyan
for the rest of the run while its dependents say "blocked by" it.

**Testing:**

`test/display.test.ts` (runWaves, `RecordingDisplay`):
- AC1.4 / AC1.6 / AC4.1 (replaces the test deleted from line 1309 in
  Phase 1): files `01-a.md` ready, `02-b.md` ready, `03-c.md` done,
  `04-d.md` ready-for-human. Scan, reverse the array, and set
  `feature = 'zeta'` on ticket 1 and `feature = 'alpha'` on ticket 2
  in memory (blockers are empty, so features do not affect
  readiness). Run `runWaves` with `MOCK_AGENT_PASS`. Exactly one
  `startRun` call, before the first `startWave` in `getCalls()`
  order; its tickets are ticket 2 then ticket 1 (sorted by feature,
  then num); tickets 3 and 4 are absent.
- AC4.3 (in place): `01` ready; `02` ready, blocked by 1; `03` ready,
  blocked by 4; `04` ready-for-human. Agent
  `MOCK_AGENT_FAIL_TICKET_01`. The first `setBlocked` call comes
  after `startRun` and before the first `startWave`, is for ticket 3,
  and names ticket 4's label. A later `setBlocked` call is for
  ticket 2 and names ticket 1's label.
- AC2.1: real `StatusDisplay` over `createMockStream()`. `01` ready,
  `02` ready, `03` ready blocked by 2 (two waves).
  `MOCK_AGENT_FAIL_TICKET_01`. In the last rendered frame (use the
  Phase 1 `lastFrame` helper), ticket 1's row has
  `renderDot('failed')` and ticket 3's row has `renderDot('done')`.

`test/orchestrator.test.ts`:
- AC4.4: extend the existing test at
  `test/orchestrator.test.ts:3830-3870` ("no wave should start"):
  make its `startRun` and `setBlocked` call `t.fail` too, and keep
  the existing assertion that the finish summary was logged.

`test/integration.test.ts` (runWavesIsolated, local recording double):
- AC4.2 / AC4.3: `01` ready; `02` ready, blocked by 1; `03` ready,
  blocked by 4; `04` ready-for-human. `MOCK_FAIL_TICKET_01`,
  `testCmd:'true'`. Exactly one `startRun`, before the first
  `startWave`, with tickets 1, 2, 3. A `setBlocked` for ticket 3
  naming ticket 4 comes before the first `startWave`. A later
  `setBlocked` for ticket 2 names ticket 1.
- AC4.4 (isolated): only a `done` ticket and a ready-for-human
  ticket. `startRun` and `startWave` are never called, and the
  finish summary is logged.
- AC2.6 (respawn): copy the setup of the merge-conflict test at
  `test/integration.test.ts:1950` (`installMergeFailingGit` on the
  `01-conflict` branch, same agent and `conflictStrategy` as that
  test) and add `02-after.md` blocked by 1. Assert a `setBlocked`
  call for ticket 2 naming ticket 1, and a `setTicketStatus` of
  `'failed'` for ticket 1 (record `setTicketStatus` in the double for
  this test). Restore the fake git and clean up worktrees exactly as
  the source test does.
- AC2.6 (stop, `-X`): the same setup with
  `conflictStrategy:'stop'`. This exercises the `break` at
  `src/orchestrator.ts:2518`; the after-loop report must still
  produce the `setBlocked` call for ticket 2 naming ticket 1.

**Verification:**
Run: `npm test`
Expected: all tests pass.
Run: `npm run build && npm run lint`
Expected: no errors.

**Commit:** `feat(orchestrator): fixed session list and blocked reporting`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
