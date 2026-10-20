# Test Gate Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task.
> Steps use checkboxes for tracking.

**Goal:** Make an active test gate visibly distinguishable from a stalled
or finished agent, including during the final review-fix pass.

**Architecture:** Add optional progress reporting to `runTestCmd`, using
the caller's existing display callback. Report the command and worktree
before execution, then elapsed time every 15 seconds until settlement.
Callers report the outcome and completed log path after writing the log.

**Tech Stack:** TypeScript, Node >= 24, ESM, child processes,
`@substrate-system/tapzero`, existing terminal displays.

---

## Context and decisions

Investigation on 2026-10-20 found nightralph 0.1.2 apparently frozen at
the fix agent's last message. The agent had actually finished and the
orchestrator was running its independent `npm test` gate. Successive
process snapshots showed the suite advancing.

The relevant source in this checkout is:

- `src/testcmd.ts:45`: `runTestCmd` captures stdout and stderr in memory.
- `src/orchestrator.ts:1530`: `runTestGate` prints only the result.
- `src/review.ts:541`: `runStep` waits, then writes the entire log.
- `src/review.ts:748`: the fixer enters that step without announcing it.
- `src/display.ts`: both display implementations accept `log(message)`.

Use a heartbeat rather than streaming raw test output into the display.
Large TAP suites produce thousands of lines, and concurrent ticket gates
would interleave them. A heartbeat works even when a command emits no
output. Fifteen seconds is frequent enough to show activity without
printing a line every second for each concurrent gate.

Keep the existing independent test gate, captured output, log filenames,
timeout values, retries, merge decisions, and process-group tracking.
This change does not remove the second test run, introduce a CLI flag,
or make log files live. Tell the reader explicitly that output is saved
when the command finishes. A heartbeat means the orchestrator is waiting
for the command; it does not claim the suite is making forward progress.

Example display sequence:

```text
  review-fix attempt 1: starting tests: npm test
  review-fix attempt 1: worktree /path/repo.review-fix; timeout 3600s
  review-fix attempt 1: output is saved when tests finish
  review-fix attempt 1: tests still running (15s elapsed)
  review-fix attempt 1: tests still running (30s elapsed)
  review fix: tests passed; see /path/logs/review-fix.test.log
```

## Acceptance criteria

1. Every nonempty ticket and review-fix gate announces itself before
   spawning the command, including its command, worktree, and timeout.
2. Every active gate reports elapsed time through the existing display
   callback every 15 seconds, including commands with no output.
3. Labels identify feature/ticket and attempt, or review-fix and attempt.
4. Completion reports success or nonzero exit and the saved log path.
   A timeout additionally announces that the command is being stopped.
5. No heartbeat survives close, spawn error, or timeout. No extra process
   or signal handler is introduced. Existing registry cleanup holds.
6. Empty test commands retain their current skip behavior: no process,
   heartbeat, or test log. Install steps remain unchanged.
7. Progress text never enters captured test output. Both terminal and
   redirected output use the existing display abstraction.

## File map

| File | Change |
| --- | --- |
| `src/testcmd.ts` | Optional progress callback and timer lifecycle |
| `src/orchestrator.ts` | Enable progress for ticket test gates |
| `src/review.ts` | Enable progress for the fixer test gate |
| `test/testcmd.test.ts` | Live heartbeat and termination coverage |
| `test/integration.test.ts` | Ticket display wiring regression |
| `test/review-pass.test.ts` | Fixer progress and saved-result regression |
| `README.md` | Explain the gate and heartbeat |

No new source or test module is needed. The explicit build and test lists
therefore remain unchanged. Read `AGENTS.md` before implementation.

## Task 1: Report progress from the shared command runner

**Modify:** `src/testcmd.ts`, `test/testcmd.test.ts`.

- [ ] Append this behavioral regression. It deliberately takes about 31
  seconds: it checks the real 15-second interval and its cleanup without
  adding a test-only timing option to the public runner.

```ts
test('runTestCmd reports a live gate and stops reporting on exit',
    async t => {
        const dir = tmp()
        const lines:string[] = []
        const registry = new Set<number>()
        let finished = false
        let observedLive = false
        writeFileSync(join(dir, 'gate.cjs'), [
            "const fs = require('node:fs')",
            "process.stdout.write('stdout marker\\n')",
            "process.stderr.write('stderr marker\\n')",
            'setInterval(() => {',
            "  if (fs.existsSync('release')) process.exit(0)",
            '}, 25)',
        ].join('\n'))
        try {
            const result = await runTestCmd({
                cmd: 'exec node gate.cjs',
                cwd: dir,
                timeout: 30,
                registry,
                progress: {
                    label: 'feature/01 attempt 1',
                    onLine: line => {
                        lines.push(line)
                        if (line.includes('still running')) {
                            observedLive = !finished && registry.size > 0
                            writeFileSync(join(dir, 'release'), '')
                        }
                    },
                },
            })
            finished = true
            t.equal(result.exitCode, 0, 'released command passes')
            t.ok(observedLive, 'heartbeat arrived during execution')
            t.ok(lines[0]?.includes('exec node gate.cjs'),
                'start names the command')
            t.ok(lines.some(line => line.includes(dir)),
                'start identifies the worktree')
            t.ok(lines.some(line => line.includes('timeout 30s')),
                'start names the timeout')
            t.ok(lines.every(line => line.includes('feature/01')),
                'messages retain their owner')
            t.ok(result.output.includes('stdout marker'),
                'stdout still captured')
            t.ok(result.output.includes('stderr marker'),
                'stderr still captured')
            t.ok(!result.output.includes('still running'),
                'progress stays out of the test log')
            t.equal(registry.size, 0, 'registry cleared')
            const count = lines.length
            await new Promise(resolve => setTimeout(resolve, 16000))
            t.equal(lines.length, count, 'no progress after completion')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
```

- [ ] Add this termination matrix. It checks actual child outcomes and
  that the progress timer does not outlive any terminal path.

```ts
test('runTestCmd clears progress on failure and timeout', async t => {
    const dir = tmp()
    const cases = [
        { cmd: 'exit 3', cwd: dir, timeout: 5, code: 3 },
        {
            cmd: 'true', cwd: join(dir, 'missing'),
            timeout: 5, code: 1,
        },
        { cmd: 'exec sleep 30', cwd: dir, timeout: 0.1, code: 1 },
    ]
    try {
        const observations = await Promise.all(cases.map(async c => {
            const lines:string[] = []
            const registry = new Set<number>()
            const result = await runTestCmd({
                ...c,
                registry,
                progress: {
                    label: c.cmd,
                    onLine: line => { lines.push(line) },
                },
            })
            t.equal(result.exitCode, c.code, 'exit behavior retained')
            t.equal(registry.size, 0, 'terminal path clears registry')
            if (c.timeout === 0.1) {
                t.ok(lines.some(line => line.includes('timeout reached')),
                    'timeout explained')
            }
            return { lines, count: lines.length }
        }))
        await new Promise(resolve => setTimeout(resolve, 16000))
        for (const item of observations) {
            t.equal(item.lines.length, item.count,
                'terminal command has no remaining heartbeat')
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
```

- [ ] Run the targeted suite and confirm failure before implementing:

```sh
./node_modules/.bin/esbuild test/testcmd.test.ts \
  --bundle --format=esm --platform=node --packages=external \
  --outfile=dist/test/testcmd.test.js
node dist/test/testcmd.test.js
```

Expected: the live-gate test times out its child and fails the live
heartbeat assertion; the timeout explanation assertion also fails.

- [ ] Add this optional field to `runTestCmd`'s options:

```ts
    progress?:{
        label:string
        onLine:(line:string) => void
    }
```

- [ ] Inside its promise executor, immediately after `let settled`, add
  the following. Use `performance.now()` for monotonic elapsed time.
  Keep existing spawn, capture, timeout, and registry behavior.

```ts
        const started = performance.now()
        const report = (message:string):void => {
            if (opts.progress) {
                opts.progress.onLine(
                    `  ${opts.progress.label}: ${message}`
                )
            }
        }
        report(`starting tests: ${opts.cmd}`)
        report(`worktree ${opts.cwd}; timeout ${opts.timeout}s`)
        report('output is saved when tests finish')
        const heartbeat = opts.progress ? setInterval(() => {
            const elapsed = Math.floor(
                (performance.now() - started) / 1000
            )
            report(`tests still running (${elapsed}s elapsed)`)
        }, 15000) : undefined
        heartbeat?.unref()
```

- [ ] At the beginning of the existing timeout callback, before killing
  the process group, add:

```ts
            clearInterval(heartbeat)
            report(`timeout reached (${opts.timeout}s); stopping tests`)
```

- [ ] In both the `error` and `close` handlers, immediately after the
  existing `clearTimeout(timer)`, add:

```ts
            clearInterval(heartbeat)
```

Keep the `settled` guard. Do not emit a completion message here: callers
must save the captured log before they advertise that log as available.
Do not use `console.log`, add signal handlers, or create a second child.

- [ ] Rerun the targeted suite. Expected: all assertions pass, including
  the existing passing, failing, timeout, cwd, and registry tests.
- [ ] Commit these two files with message
  `feat: report test command activity through the display callback`.

## Task 2: Connect ticket and review-fix gates

**Modify:** `src/orchestrator.ts`, `src/review.ts`,
`test/integration.test.ts`, `test/review-pass.test.ts`.

- [ ] In the existing integration test named
  `runWavesIsolated - passing test command runs in the worktree and the
  ticket completes`, create a recorder before `runWavesIsolated`:

```ts
            const recording = recordingDisplay()
```

Pass `display: recording.display` in that call. After the existing
assertions, add:

```ts
            const lines = recording.calls
                .filter(call => call.method === 'log')
                .map(call => String(call.args[0]))
            const start = lines.findIndex(line =>
                line.includes('starting tests:') &&
                line.includes('attempt 1'))
            const end = lines.findIndex(line =>
                line.includes('tests passed'))
            t.ok(start >= 0 && end > start,
                'display reports gate start before completion')
            t.ok(lines[end]?.includes('.test.log'),
                'completion identifies saved output')
```

- [ ] Add this regression to `test/review-pass.test.ts`, using its
  existing repo, fake-agent, and finding helpers. Add `readFileSync` to
  its existing `node:fs` import. The callback reads the log immediately
  when completion is announced, proving the ordering contract.

```ts
test('runFixer reports its gate and then its saved result', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'fix.ts')
            return { completedItems: ['first thing'] }
        })
        const lines:string[] = []
        let outputAtCompletion = ''
        const path = join(repoRoot, '.scratch', 'feat', 'logs',
            'review-fix.test.log')
        const opts = passOpts(repoRoot, {
            testCmd: 'echo gate-marker',
            log: line => {
                lines.push(line)
                if (line.includes('tests passed')) {
                    outputAtCompletion = readFileSync(path, 'utf8')
                }
            },
        })
        const result = await runFixer(opts,
            { spawnAgent: agent.spawnAgent }, FINDINGS)
        const start = lines.findIndex(line =>
            line.includes('review-fix attempt 1: starting tests:'))
        const end = lines.findIndex(line => line.includes('tests passed'))
        t.ok(result.merged, 'successful gate still merges')
        t.ok(start >= 0 && end > start, 'ordered phase messages')
        t.ok(outputAtCompletion.includes('gate-marker'),
            'log is readable when completion is announced')
        t.ok(lines[end]?.includes(path), 'saved log is discoverable')
    })
})
```

- [ ] Run these suites before wiring the call sites; expect the new
  progress assertions to fail. The build is required because some
  integration tests execute `dist/index.js`.

```sh
npm run build
./node_modules/.bin/esbuild test/review-pass.test.ts \
  test/integration.test.ts --bundle --format=esm --platform=node \
  --packages=external --outdir=dist/test
node dist/test/review-pass.test.js
node dist/test/integration.test.js
```

- [ ] In `runTestGate`, compute `testLogPath` before `runTestCmd`, and
  replace that call and its immediate log write with:

```ts
    const testLogPath = attemptLogPath(
        opts.logsDir, opts.ticket, opts.attempt ?? 1,
        '.test.log'
    )
    const result = await runTestCmd({
        cmd: opts.testCmd,
        cwd: opts.worktreePath,
        timeout: opts.timeout,
        registry: opts.registry,
        progress: {
            label: `${ticketLabel(opts.ticket)} ` +
                `attempt ${opts.attempt ?? 1}`,
            onLine: opts.log,
        },
    })
    writeFileSync(testLogPath, result.output)
```

Keep the existing failure message and return. Replace the passing
message with:

```ts
    opts.log(
        `  ${opts.ticket.filename}: tests passed; see ${testLogPath}`
    )
```

The existing `ticketLabel` import supplies feature-qualified labels.
Leave the empty-command return ahead of this code. Conflict respawns
already reuse `runTestGate` and inherit reporting automatically.

- [ ] Extend `runStep` in `src/review.ts` with an optional final
  parameter and replace its body as follows. Install callers omit the
  label and retain their existing behavior.

```ts
async function runStep (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    cmd:string,
    cwd:string,
    path:string,
    testLabel?:string
):Promise<boolean> {
    const result = await runTestCmd({
        cmd,
        cwd,
        timeout: opts.timeout,
        registry: deps.registry,
        progress: testLabel ? {
            label: testLabel,
            onLine: opts.log,
        } : undefined,
    })
    writeFileSync(path, result.output)
    if (testLabel) {
        const outcome = result.exitCode === 0 ?
            'tests passed' : `tests failed (exit ${result.exitCode})`
        opts.log(`  review fix: ${outcome}; see ${path}`)
    }
    return result.exitCode === 0
}
```

- [ ] Change only the fixer's test call to pass the label:

```ts
            } else if (!(await runStep(
                opts, deps, opts.testCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt, '.test.log'
                ),
                `review-fix attempt ${attempt}`
            ))) {
                return fail('tests', agent.exitCode, notes)
            }
```

- [ ] Strengthen the existing `AC6.2` failing-gate test by creating
  `const lines:string[] = []` before `runFixer` and adding
  `log: line => { lines.push(line) }` to its `passOpts` overrides.
  After its existing assertions, add:

```ts
        t.ok(lines.some(line =>
            line.includes('review-fix attempt 2: starting tests:')),
        'retry identifies its attempt')
        t.ok(lines.some(line =>
            line.includes('tests failed (exit 1)') &&
            line.includes('review-fix.attempt2.test.log')),
        'failed retry names its own saved log')
```

In the existing empty-command fixer test, also add:

```ts
        t.ok(!lines.some(line => line.includes('starting tests:')),
            'skipped gate does not announce execution')
```

- [ ] Rerun the build and both targeted suites. Expected: the new
  assertions pass, and existing retry, merge, skipped-gate, and failure
  tests retain their outcomes.
- [ ] Commit with message
  `feat: show ticket and review fix test gate progress`.

## Task 3: Document and verify the visible behavior

**Modify:** `README.md`, in Notes immediately after the paragraph about
the test gate and blocked dependents.

- [ ] Add this text:

```markdown
* After an agent finishes, nightralph independently runs the test gate,
  even if the agent already ran tests. Ticket gates and the final
  review-fix gate announce the command, worktree, and timeout, then
  report elapsed time every 15 seconds while waiting for it to finish.
  A heartbeat means the command is still running; it does not prove
  that individual tests are advancing. Test output is captured and
  saved when the command finishes, and the completion message gives
  the log path. The log is not a live stream.
```

- [ ] Run the repository checks in this order:

```sh
npm run build
npm run lint
npm test
```

Expected: successful build/type declarations, clean lint, and all suites
passing. Build first: the test script does not rebuild CLI artifacts.
The new lifecycle tests add roughly 47 seconds to the testcmd suite.

- [ ] Exercise the actual displays without invoking a paid agent. After
  building, run this inline demo once with a terminal and once redirected
  to a temporary file. The callback must flow through `createDisplay`.
  This executes a harmless sleeping command, not a project test suite.

```sh
node --input-type=module <<'JS'
import { createDisplay } from './dist/display.js'
import { runTestCmd } from './dist/testcmd.js'

const display = createDisplay()
display.startRun([])
try {
    const result = await runTestCmd({
        cmd: 'sleep 16',
        cwd: process.cwd(),
        timeout: 30,
        progress: {
            label: 'review-fix attempt 1',
            onLine: line => display.log(line),
        },
    })
    display.log(`Demo finished with exit ${result.exitCode}`)
} finally {
    display.cleanup()
}
JS
```

Expected: immediate phase information, one heartbeat at approximately
15 seconds, then completion. No corrupted ticket rows, repeated
completion, or lingering process. Redirected output remains readable.

- [ ] Review the diff for lines of 80 columns or more, unrelated edits,
  raw console writes, changed gate decisions, and additional signal
  handlers. Confirm no build artifacts are accidentally staged.
- [ ] Commit `README.md` with message
  `docs: explain test gate progress and captured output`.

## Completion evidence

Record the build/lint/full-suite outcomes and the terminal and redirected
demo results in the implementation handoff. Explicitly state that logs
still become available at command completion and independent gates still
run after agent-side testing. This plan changes visibility, not the
amount of verification performed.
