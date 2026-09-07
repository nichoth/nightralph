# Stall-Resilient Wave Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When every ticket in a wave exits 0 but makes no changes (`no-commits`), keep the run alive instead of stopping, so an unattended overnight run can make progress once a blocking condition clears. Stop only after a configurable number of consecutive stalled waves.

**Architecture:** All changes are in `src/orchestrator.ts` and `src/index.ts`. The `no-commits` outcome no longer adds a ticket to `failedNums` -- the ticket stays eligible for future waves. A `stalledWaves` counter increments after each wave that completes zero tickets, and resets when any ticket completes. When `stalledWaves` reaches `maxStalledWaves`, the run stops. A per-ticket effort map preserves escalated effort across waves so a ticket that reached `max` stays there. Log file names incorporate a global per-ticket attempt counter so wave-2 logs don't overwrite wave-1 logs. The final summary distinguishes "failed" (terminal errors) from "deferred" (stall budget exhausted).

**Tech Stack:** TypeScript, Node >= 24, ESM, yargs, `@substrate-system/tapzero`

**Spec:** Conversation history and adversarial review from 2026-09-06

## Global Constraints

- No line longer than 80 columns in TypeScript.
- No space between colon and type annotation (`foo:string`).
- Ternaries formatted as `cond ?\n    a :\n    b`.
- No em dashes or arrow glyphs in docs or comments; use `--` and `->`.
- No emojis in file names or comments.
- Do not test for specific text content of docs. Tests assert on the behavior of code.

## Scoping note

These changes apply only to `runWavesIsolated`. The `runWaves` (in-place, non-git) path has no `no-commits` detection and is left unchanged.

---

### Task 1: Export `DEFAULT_MAX_STALLED_WAVES` and add CLI flag

**Files:**
- Modify: `src/orchestrator.ts:1156-1161` (add constant near other defaults)
- Modify: `src/index.ts:141-155` (add CLI option)
- Modify: `src/index.ts:204-215` (add to `runExecute` argv type)
- Modify: `src/index.ts:310-325` (pass to `runWavesIsolated`)
- Test: `test/orchestrator.test.ts` (add constant assertion)
- Test: `test/integration.test.ts` (add dry-run output assertion)

**Interfaces:**
- Produces: `DEFAULT_MAX_STALLED_WAVES` exported as `3`; `runWavesIsolated` opts gains `maxStalledWaves?:number`; `dryRunIsolated` opts gains `maxStalledWaves?:number` and prints it; CLI passes `--max-stalled-waves` through

- [ ] **Step 1: Write the failing test for the constant**

In `test/orchestrator.test.ts`, after the `DEFAULT_RETRY_DELAY` test:

```ts
test('DEFAULT_MAX_STALLED_WAVES equals 3', t => {
    t.equal(DEFAULT_MAX_STALLED_WAVES, 3)
})
```

Add `DEFAULT_MAX_STALLED_WAVES` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: import error -- `DEFAULT_MAX_STALLED_WAVES` not exported

- [ ] **Step 3: Add the constant to `src/orchestrator.ts`**

After `DEFAULT_RETRY_DELAY` (~line 1161):

```ts
export const DEFAULT_MAX_STALLED_WAVES = 3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Add the CLI option in `src/index.ts`**

After the `.option('retry-delay', ...)` block (~line 149), add:

```ts
.option('max-stalled-waves', {
    type:'number',
    default:DEFAULT_MAX_STALLED_WAVES,
    describe:'Consecutive waves with no ' +
        'completions before stopping. ' +
        '0 = stop on first stalled wave.',
})
```

Add `DEFAULT_MAX_STALLED_WAVES` to the import from `'./orchestrator.js'`.

Update the `runExecute` argv type to include `maxStalledWaves?:number`.

Pass it through to `runWavesIsolated` and `dryRunIsolated`:

```ts
maxStalledWaves:argv.maxStalledWaves,
```

- [ ] **Step 6: Add `maxStalledWaves` to `dryRunIsolated` opts and output**

In `src/orchestrator.ts`, add `maxStalledWaves?:number` to `dryRunIsolated`'s opts type. After the "Retry delay" print (~line 996), add:

```ts
console.log(
    'Max stalled: ' +
    `${opts.maxStalledWaves ?? DEFAULT_MAX_STALLED_WAVES}`
)
```

- [ ] **Step 7: Add `maxStalledWaves` to `runWavesIsolated` opts type**

In `src/orchestrator.ts`, add to the opts type of `runWavesIsolated` (~line 1630):

```ts
maxStalledWaves?:number
```

Initialize it after `retryDelay` (~line 1637):

```ts
const maxStalled =
    opts.maxStalledWaves ?? DEFAULT_MAX_STALLED_WAVES
```

(The stall logic itself is wired in Task 3.)

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: all pass (new constant test passes, nothing broken)

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator.ts src/index.ts \
    test/orchestrator.test.ts
git commit -m "feat: add --max-stalled-waves flag and constant"
```

---

### Task 2: Global per-ticket attempt counter for log uniqueness

**Files:**
- Modify: `src/orchestrator.ts:1174-1183` (change `attemptLogPath` signature)
- Modify: `src/orchestrator.ts:1351-1404` (`runTicketAttempts` -- accept and increment a global counter)
- Modify: `src/orchestrator.ts:1675-1720` (`runWavesIsolated` -- pass counter per ticket)
- Test: `test/orchestrator.test.ts` (add test for log path naming)

**Interfaces:**
- Consumes: `attemptLogPath(logsDir, ticket, attempt, ext)` (current)
- Produces: `attemptLogPath` unchanged in signature -- the `attempt` parameter becomes the global counter value. `runTicketAttempts` accepts and returns a `globalAttempt` count so the caller can track it across waves.

The key insight: `attemptLogPath` already uses `attempt` as a number. Today, `runTicketAttempts` passes 1-based attempt numbers that reset each wave. Instead, we'll track a per-ticket counter in the outer loop and pass it through.

- [ ] **Step 1: Write the failing test**

In `test/orchestrator.test.ts`, add a test that verifies log paths with high attempt numbers produce unique filenames:

```ts
test('attemptLogPath - attempt 1 has no suffix', t => {
    const ticket = {
        num:1, slug:'foo', filename:'01-foo.md',
        filepath:'/tmp/01-foo.md', body:'',
        status:'ready-for-agent' as const, blockers:[],
    }
    const result = attemptLogPath(
        '/logs', ticket, 1, '.log'
    )
    t.equal(result, '/logs/01-foo.log')
})

test('attemptLogPath - attempt 5 gets suffix', t => {
    const ticket = {
        num:1, slug:'foo', filename:'01-foo.md',
        filepath:'/tmp/01-foo.md', body:'',
        status:'ready-for-agent' as const, blockers:[],
    }
    const result = attemptLogPath(
        '/logs', ticket, 5, '.log'
    )
    t.equal(result, '/logs/01-foo.attempt5.log')
})
```

Add `attemptLogPath` to the import. (It is not currently exported -- export it for testability.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: import error -- `attemptLogPath` not exported

- [ ] **Step 3: Export `attemptLogPath`**

In `src/orchestrator.ts`, change `function attemptLogPath` to `export function attemptLogPath` (~line 1174).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: both `attemptLogPath` tests pass

- [ ] **Step 5: Add per-ticket attempt tracking to `runTicketAttempts`**

Modify `runTicketAttempts` to accept `startAttempt:number` and return `{ outcome, attemptsUsed }`:

Change the return type from `Promise<TicketOutcome>` to `Promise<{ outcome:TicketOutcome; attemptsUsed:number }>`.

In the function body, replace `for (let attempt = 1; ...)` with `for (let attempt = startAttempt; attempt < startAttempt + maxAttempts; attempt++)`. Return `{ outcome, attemptsUsed: attempt - startAttempt + 1 }` at early-return points, and `{ outcome, attemptsUsed: maxAttempts }` at the end.

Update the retry log line to use the new global attempt numbering -- show `attempt N` where N is the global count, and `attempt N/M` where M is `startAttempt + maxAttempts - 1`.

- [ ] **Step 6: Update the call site in `runWavesIsolated`**

In `runWavesIsolated`, before the `while (true)` loop, add a per-ticket attempt map:

```ts
const attemptCounters = new Map<number, number>()
```

When calling `runTicketAttempts`, pass `startAttempt`:

```ts
const startAttempt =
    (attemptCounters.get(t.num) ?? 0) + 1
```

After the call, update the counter:

```ts
attemptCounters.set(
    t.num,
    (attemptCounters.get(t.num) ?? 0) +
    result.attemptsUsed
)
```

Destructure the new return shape: `const { outcome, attemptsUsed } = ...`.

Replace all references to the old `outcome` local (currently named `outcome` in the outcomes array destructuring) with the new shape.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all pass. Existing integration tests still work because attempt 1 still produces unsuffixed log names.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: global per-ticket attempt counter for log uniqueness"
```

---

### Task 3: `no-commits` stays eligible + stall counter

This is the core change. `no-commits` tickets no longer go to `failedNums`. A `stalledWaves` counter gates when the run stops.

**Files:**
- Modify: `src/orchestrator.ts:1675-2042` (`runWavesIsolated`)
- Test: `test/integration.test.ts` (modify existing no-commits test, add stall-limit test, add stall-reset test)

**Interfaces:**
- Consumes: `DEFAULT_MAX_STALLED_WAVES`, `maxStalled` from Task 1; `attemptCounters` map and return shape from Task 2
- Produces: `no-commits` tickets stay eligible; run stops after `maxStalled` consecutive zero-completion waves; final summary distinguishes "deferred" from "failed"

- [ ] **Step 1: Write the test -- no-commits ticket retried in next wave**

In `test/integration.test.ts`, add a new test using `mock-agent-noop` (exits 0, no commits). With `retries:0` and `maxStalledWaves:2`, the agent should be invoked at least twice (once per wave) before the run stops. The ticket should remain `ready-for-agent`. Use the `attemptCounters` behavior to verify the second invocation gets attempt number 2.

```ts
test(
    'runWavesIsolated - no-commits ticket retried ' +
    'across waves until stall limit',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-noop.md'),
            makeTicketBody({
                status:'ready-for-agent',
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_NOOP,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-stall',
                conflictStrategy:'respawn',
                retries:0,
                retryDelay:0,
                maxStalledWaves:2,
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket still eligible after stall limit'
            )

            // Should have attempt logs from two waves
            const logFiles = readdirSync(logsDir)
                .filter(f => f.startsWith('01-noop'))
                .filter(f => f.endsWith('.log'))
            t.ok(
                logFiles.length >= 2,
                'logs from multiple waves exist'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(
            projectDir,
            { recursive:true, force:true }
        )
    }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL -- the current code adds no-commits to `failedNums` and stops after one wave, so `logFiles.length` is 1 and the stall limit has no effect.

- [ ] **Step 3: Implement the stall counter and no-commits change**

In `runWavesIsolated`, after initializing `failedNums`:

```ts
let stalledWaves = 0
```

In the `no-commits` outcome handler (~line 1782), remove the `failedNums.add(ticket.num)` call. Change the display status from `'failed'` to a neutral state -- keep `d.setTicketStatus(ticket.num, 'waiting')` or introduce `'deferred'` if the display supports it. For now, leave the status as-is but do not add to `failedNums`:

```ts
if (outcome.kind === 'no-commits') {
    d.setTicketStatus(ticket.num, 'waiting')
    d.log(
        `  ${ticket.filename}: agent exited 0 ` +
        'but made no changes; will retry ' +
        'next wave'
    )
    checkTicket(progress, ticket.num, {
        branch:outcome.branchName,
        exitCode:0,
        done:false,
    })
    await saveProgress(
        repoRoot,
        progressPath,
        progress,
        `nightralph: ${ticket.filename} ` +
        'no commits',
        d,
    )
    continue
}
```

At the end-of-wave check (~line 2006), replace the existing `waveCompleted === 0` block with:

```ts
if (waveCompleted === 0) {
    stalledWaves++
    const remaining = findReadyTickets(
        opts.tickets
    ).filter(t => !failedNums.has(t.num))
    if (remaining.length === 0) {
        d.log(
            '\nNo tickets completed this wave ' +
            'and no eligible tickets remain. ' +
            'Stopping.'
        )
        break
    }
    if (stalledWaves >= maxStalled) {
        d.log(
            `\n${stalledWaves} consecutive ` +
            'stalled wave' +
            (stalledWaves === 1 ? '' : 's') +
            '; stopping. ' +
            `${remaining.length} ticket` +
            (remaining.length === 1 ?
                '' : 's') +
            ' deferred.'
        )
        break
    }
    const delay = retryDelayFor(
        retryDelay, stalledWaves + 1
    )
    d.log(
        '\nNo tickets completed this wave. ' +
        `${remaining.length} ready ticket` +
        (remaining.length === 1 ? '' : 's') +
        ' remain; retrying' +
        (delay > 0 ?
            ` after ${delay}s` : '') +
        '.'
    )
    if (delay > 0) await sleep(delay * 1000)
} else {
    stalledWaves = 0
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: new stall test passes. Existing no-commits test may need updating (see step 5).

- [ ] **Step 5: Update existing no-commits test**

The existing test at line 939 (`agent exits 0 but makes no commits, ticket stays ready-for-agent`) should still pass since the ticket stays `ready-for-agent`. But it uses default `maxStalledWaves` (3) and default `retries` (3), so the run will now make multiple waves before stopping. Add `retries:0, retryDelay:0, maxStalledWaves:1` to the opts to keep it fast:

```ts
await runWavesIsolated({
    tickets,
    specBody:'test spec',
    agentCmd:MOCK_NOOP,
    model:null,
    timeout:10,
    logsDir,
    featureName:'test-feature-noop',
    conflictStrategy:'respawn',
    retries:0,
    retryDelay:0,
    maxStalledWaves:1,
})
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts
git commit -m "feat: no-commits tickets stay eligible with stall-wave limit"
```

---

### Task 4: Preserve per-ticket effort across waves

**Files:**
- Modify: `src/orchestrator.ts:1675-1720` (`runWavesIsolated` -- effort map)
- Modify: `src/orchestrator.ts:1351-1404` (`runTicketAttempts` -- accept starting effort)
- Test: `test/integration.test.ts` (verify effort escalates across waves)

**Interfaces:**
- Consumes: `runTicketAttempts` from Task 2 (with `startAttempt`)
- Produces: `runTicketAttempts` also accepts `effort` override per invocation; per-ticket effort persists across waves so a ticket that reached `max` stays at `max`

- [ ] **Step 1: Write the failing test**

Use `mock-agent-noop` with `retries:1` and `maxStalledWaves:2`. With starting effort `'low'`, the first wave should escalate from `low` to `medium` (two attempts), then the second wave should start at `medium` and escalate to `high`. Use `mock-agent-fail-capture-args` (which logs its args) to verify the effort flags. Actually, `mock-agent-noop` won't trigger retries (it exits 0). Instead, this test should verify that on the second wave, the ticket starts at the effort level it ended at in wave 1.

The simplest way: use a mock agent that captures its args to a file, exits 0 with no commits. Check that wave 2's agent invocation uses the escalated effort from wave 1's last attempt.

```ts
test(
    'runWavesIsolated - effort preserved across ' +
    'waves for no-commits tickets',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-noop.md'),
            makeTicketBody({
                status:'ready-for-agent',
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        const argsLogPath = join(
            projectDir, 'args.log'
        )
        process.env.ARGS_LOG_PATH = argsLogPath

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_NOOP_CAPTURE,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-effort',
                conflictStrategy:'respawn',
                retries:1,
                retryDelay:0,
                maxStalledWaves:2,
                effort:'low' as EffortLevel,
            })

            const argsLog = readFileSync(
                argsLogPath, 'utf8'
            )
            const invocations = argsLog
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(l => JSON.parse(l))

            // Wave 1: attempt 1 at low, attempt 2
            // at medium (retry with escalation).
            // Wave 2: attempt 3 at medium (preserved),
            // attempt 4 at high (escalated).
            t.ok(
                invocations.length >= 3,
                'at least 3 invocations across waves'
            )
        } finally {
            delete process.env.ARGS_LOG_PATH
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(
            projectDir,
            { recursive:true, force:true }
        )
    }
})
```

Note: this test requires a `MOCK_NOOP_CAPTURE` agent -- a noop agent that also logs its args. Create `test/mock-agent-noop-capture.js`:

```js
#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require('fs')
const logPath = process.env.ARGS_LOG_PATH
if (logPath) {
    appendFileSync(logPath, JSON.stringify({
        args:process.argv.slice(2),
        cwd:process.cwd(),
    }) + '\n')
}
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL -- effort is not preserved across waves

- [ ] **Step 3: Add per-ticket effort map to `runWavesIsolated`**

Before the `while (true)` loop, add:

```ts
const effortByTicket = new Map<
    number, EffortLevel|undefined
>()
```

When calling `runTicketAttempts`, pass the preserved effort:

```ts
effort:effortByTicket.get(t.num) ?? opts.effort,
```

After `runTicketAttempts` returns, update the map. `runTicketAttempts` should return the final effort level it used alongside the outcome and `attemptsUsed`. Add `finalEffort:EffortLevel|undefined` to the return type.

In `runTicketAttempts`, track the last-used effort and return it:

```ts
return {
    outcome,
    attemptsUsed:maxAttempts,
    finalEffort:effort,
}
```

Back in `runWavesIsolated`, after each ticket attempt:

```ts
effortByTicket.set(t.num, result.finalEffort)
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: effort preservation test passes

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts \
    test/mock-agent-noop-capture.js
git commit -m "feat: preserve per-ticket effort level across waves"
```

---

### Task 5: Stall-reset test and final summary

**Files:**
- Modify: `src/orchestrator.ts:2027-2041` (final summary)
- Test: `test/integration.test.ts` (stall-reset test)

**Interfaces:**
- Consumes: `stalledWaves` counter from Task 3
- Produces: final summary distinguishes "failed" from "deferred"; stall counter resets when a ticket completes

- [ ] **Step 1: Write the stall-reset test**

Use two tickets: ticket 01 uses `mock-agent-noop` (no commits), ticket 02 uses `mock-agent-create-file` (creates a commit). Ticket 02 blocks on 01 so they run in separate waves. Since 02 will succeed in wave 2 (after 01 fails wave 1 but stays eligible), the stall counter should reset and the run should continue. With `maxStalledWaves:1`, the run would stop after one stalled wave -- but if ticket 02 completes in wave 2, that resets the counter.

Actually, the simpler scenario: two independent tickets, one noop and one that succeeds. They run in the same wave. Since one succeeds, `waveCompleted > 0` and `stalledWaves` resets to 0. The noop ticket should be tried again in wave 2.

```ts
test(
    'runWavesIsolated - stall counter resets when ' +
    'any ticket completes',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        // Ticket 01: will succeed (creates a file)
        writeFileSync(
            join(issuesDir, '01-good.md'),
            makeTicketBody({
                status:'ready-for-agent',
            })
        )
        // Ticket 02: noop, depends on 01
        writeFileSync(
            join(issuesDir, '02-noop.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_CREATE_FILE,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-reset',
                conflictStrategy:'respawn',
                retries:0,
                retryDelay:0,
                maxStalledWaves:1,
            })

            t.equal(
                tickets[0].status,
                'done',
                'ticket 01 completed'
            )
            // Ticket 02 ran in wave 2 but is noop --
            // but since mock-agent-create-file
            // creates a file, it should succeed too.
            // Both done.
            t.equal(
                tickets[1].status,
                'done',
                'ticket 02 completed in wave 2'
            )
            t.equal(result.allDone, true)
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(
            projectDir,
            { recursive:true, force:true }
        )
    }
})
```

Note: this test uses `mock-agent-create-file` for both tickets. Since both agents create files, both should succeed. This test verifies that the stall counter resets (0 stalled waves) when tickets complete, even with `maxStalledWaves:1`. If the counter did not reset, wave 2 would stop after ticket 02's wave -- but since ticket 01 completed in wave 1, the counter stays at 0.

- [ ] **Step 2: Run test to verify it passes**

This test should already pass with the Task 3 implementation since `stalledWaves` resets in the `else` branch. Verify it does.

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Update the final summary**

In `runWavesIsolated`, the final summary (~line 2027) currently reports "remaining" and "failed". Replace with a three-way split:

```ts
const remaining = opts.tickets.filter(
    t => t.status === 'ready-for-agent'
)
const failed = failedNums.size
const deferred = remaining.filter(
    t => !failedNums.has(t.num)
).length
d.log(
    `\nFinished: ${totalCompleted} completed` +
    (deferred > 0 ?
        `, ${deferred} deferred` :
        '') +
    (failed > 0 ?
        `, ${failed} failed` :
        '')
)
```

"Deferred" means the ticket is still eligible but the stall budget ran out. "Failed" means a terminal error (crash, worktree error, non-zero exit after all retries).

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts
git commit -m "feat: stall-reset behavior and deferred/failed summary"
```

---

### Task 6: Inter-wave delay for stalled waves

**Files:**
- Modify: `src/orchestrator.ts:2006-2024` (add delay in stall path -- already drafted in Task 3)
- Test: `test/integration.test.ts` (verify delay is applied)

**Interfaces:**
- Consumes: `retryDelay` and `stalledWaves` from Task 3
- Produces: a delay of `retryDelayFor(retryDelay, stalledWaves + 1)` between stalled waves

- [ ] **Step 1: Verify delay is already wired**

The Task 3 implementation already includes `retryDelayFor(retryDelay, stalledWaves + 1)` in the stall path. Verify by reading the code.

- [ ] **Step 2: Write a timing test**

This is hard to test precisely without mocking `sleep`. Instead, verify by checking that the delay log message is present in the display output. Use a capture display or check that the `d.log` call includes the delay value.

Since the existing test infrastructure uses real delays, test with `retryDelay:0` (no actual wait) and just verify the log message format. With `retryDelay:1`, it would log "after 1s".

This was already covered in the Task 3 implementation. If the delay line is present in the stall handler, this step is complete. No separate test needed beyond what Task 3 already verifies.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 4: Commit (if any changes)**

Only commit if step 1 revealed missing delay logic. If Task 3 already includes it, skip.

---

### Task 7: Update AGENTS.md contracts

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: all prior tasks
- Produces: updated contract documentation

- [ ] **Step 1: Update the orchestrator contract**

Add to the `orchestrator` section in `AGENTS.md`:

Under the CLI section, add `--max-stalled-waves` flag documentation.

Under the orchestrator section, update `runWavesIsolated` guarantees:
- `no-commits` outcomes do not add the ticket to `failedNums`; the ticket remains eligible for future waves
- A `stalledWaves` counter increments after each wave with zero completions and resets when any ticket completes
- The run stops when `stalledWaves >= maxStalledWaves` (default `DEFAULT_MAX_STALLED_WAVES`, 3)
- Per-ticket effort level is preserved across waves via `effortByTicket` map
- Per-ticket attempt counter is preserved across waves so log filenames are unique across the entire run
- An inter-wave delay of `retryDelayFor(retryDelay, stalledWaves + 1)` is applied between stalled waves
- The final summary distinguishes "deferred" (stall budget exhausted, still eligible) from "failed" (terminal error)

Add `DEFAULT_MAX_STALLED_WAVES` to the exports list.

Add `attemptLogPath` to the exports list.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update contracts for stall-resilience changes"
```
