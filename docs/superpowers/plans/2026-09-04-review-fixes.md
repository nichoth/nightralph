# Overnight Robustness Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven gaps the adversarial review found in the overnight robustness implementation so unattended runs cannot orphan child processes, leak worktrees, lose progress data, or report wrong defaults.

**Architecture:** Each fix lives in the module that owns the behavior. The tasks are ordered so later tasks can depend on types or interfaces introduced by earlier ones. Tasks 1-5 are independent of each other; Task 7 depends on the type changes in Task 6.

**Tech Stack:** TypeScript, Node >= 24, ESM, `@substrate-system/tapzero`, esbuild.

**Spec:** `docs/superpowers/plans/2026-09-03-overnight-robustness-review.md`

## Global Constraints

- No line longer than 80 columns in TypeScript.
- No space between colon and type annotation (`foo:string`).
- Ternaries formatted as `cond ?\n    a :\n    b`.
- No em dashes or arrow glyphs in docs or comments; use `--` and `->`.
- No emojis in file names or comments.
- Tests assert on behavior, not on specific text content of docs.
- `package.json` lists every source module in `build-esm` and every test file in `test`. No new source or test files are added by this plan, only one new mock agent under `test/` which needs no registration, and which must be executable (`chmod +x`).
- Run `npm test` from the repo root. It builds first. Run `npm run build` before any test that spawns `dist/index.js`.
- Commit after each task.

---

## File Structure

| File | Change |
| --- | --- |
| `src/orchestrator.ts` | `dryRunIsolated` retry-delay default; `renderMergePrompt` directory rule; `killProcessGroup` call in grace timer; pass `runningAgents` to `runTestGate`; `TicketOutcome` types carry worktree info on `no-commits` and `error`; `runWavesIsolated` handlers clean up worktrees and write progress for every terminal failure |
| `src/testcmd.ts` | `runTestCmd` accepts optional `registry:Set<number>` |
| `src/worktree.ts` | `removeWorktree` serialized through the module queue |
| `test/orchestrator.test.ts` | tests for `dryRunIsolated` default and `renderMergePrompt` directory rule |
| `test/testcmd.test.ts` | test for registry add/remove in `runTestCmd` |
| `test/worktree.test.ts` | test for concurrent create + remove |
| `test/integration.test.ts` | test for grandchild kill on normal exit |
| `test/mock-agent-grandchild-exit.js` | new: spawns a grandchild, records its pid, then exits 0 |
| `AGENTS.md` | updated contracts for `testcmd`, `worktree`, `orchestrator` |

---

### Task 1: Fix dry-run retry delay default (Review finding 7)

**Files:**
- Modify: `src/orchestrator.ts:943`
- Test: `test/orchestrator.test.ts` (append after the existing `dryRunIsolated` tests, around line 1560)

**Interfaces:**
- Consumes: `dryRunIsolated(opts)` -- `retryDelay` is optional
- Produces: no interface change; output now prints `0s` when `retryDelay` is omitted, matching how `runWavesIsolated` already defaults to 0

- [ ] **Step 1: Write the failing test**

Append to `test/orchestrator.test.ts`:

```ts
test(
    'dryRunIsolated defaults retryDelay to 0, ' +
    'not DEFAULT_RETRY_DELAY',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-test.md',
                status:'ready-for-agent',
                blockers:[],
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }
        try {
            dryRunIsolated({
                tickets,
                specBody:'spec',
                repoName:'myapp',
                conflictStrategy:'respawn',
                progressPath:'progress.md',
            })
        } finally {
            console.log = originalLog
        }

        const full = output.join('\n')
        t.ok(
            full.includes('Retry delay:  0s'),
            'prints 0s, not 30s, when retryDelay is ' +
            'omitted'
        )
    }
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "defaults retryDelay"`
Expected: FAIL -- output contains `30s`, not `0s`.

- [ ] **Step 3: Implement the fix**

In `src/orchestrator.ts`, change line 943 from:

```ts
        'Retry delay:  ' +
        `${opts.retryDelay ?? DEFAULT_RETRY_DELAY}s`
```

to:

```ts
        'Retry delay:  ' +
        `${opts.retryDelay ?? 0}s`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "fix: dryRunIsolated defaults retryDelay to 0

The library default is 0 (the CLI supplies 30). The dry-run
output was falling back to DEFAULT_RETRY_DELAY (30), which
misrepresented what runWavesIsolated would actually use."
```

---

### Task 2: Add worktree restriction to merge prompt (Review finding 6)

**Files:**
- Modify: `src/orchestrator.ts:271-302` (`renderMergePrompt`)
- Test: `test/orchestrator.test.ts` (append after the existing `renderMergePrompt` test, around line 862)

**Interfaces:**
- Consumes: `renderMergePrompt(specBody, ticket):string`
- Produces: no signature change; the returned string now includes the same directory and branch restrictions that `renderPrompt` has

- [ ] **Step 1: Write the failing test**

Append to `test/orchestrator.test.ts` after the existing `renderMergePrompt` test:

```ts
test(
    'renderMergePrompt contains worktree ' +
    'directory restriction',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderMergePrompt(
            'spec body', ticket
        )
        t.ok(
            prompt.toLowerCase().includes(
                'current directory'
            ),
            'merge prompt restricts agent to the ' +
            'current directory'
        )
    }
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "directory restriction"`
Expected: FAIL -- `renderMergePrompt` output does not contain "current directory".

- [ ] **Step 3: Implement the fix**

In `src/orchestrator.ts`, in `renderMergePrompt`, change the instructions array from:

```ts
        'Do NOT re-implement the ticket from scratch.',
        'Do NOT run git push.',
```

to:

```ts
        'Do NOT re-implement the ticket from scratch.',
        'Do NOT read or modify files outside ' +
            'your current directory (the worktree).',
        'Do NOT run git push.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "fix: add worktree restriction to merge prompt

The normal prompt confined the agent to its worktree, but
the merge-conflict respawn prompt only forbade git push.
A respawned agent could reach sibling checkouts via ../"
```

---

### Task 3: Kill process group on grace timeout (Review finding 3)

An agent that exits 0 after spawning a long-lived child (dev server, watcher) leaves that child alive. The grace timer destroys the stdio streams so `spawnAgent` resolves, but the child process keeps running. Fix: kill the process group before destroying the streams.

**Files:**
- Create: `test/mock-agent-grandchild-exit.js`
- Modify: `src/orchestrator.ts:804-810` (grace timer in `spawnAgent`)
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `killProcessGroup(pid)`, `spawnAgent(opts)`
- Produces: no interface change; behavioral: the grace timer now kills the agent's process group before destroying streams

- [ ] **Step 1: Create the mock agent**

Create `test/mock-agent-grandchild-exit.js`:

```js
#!/usr/bin/env node
// Simulates an agent that spawns a long-lived child
// (like a dev server) sharing its stdout, then exits 0.
// The grandchild's pid is written to ./grandchild.pid
// so the test can verify it was killed by the grace
// timer's process-group kill.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pidFile = join(process.cwd(), 'grandchild.pid')

const grandchild = spawn(process.execPath, [
    '-e',
    'process.stdin.resume(); ' +
    'setInterval(() => {}, 1000)',
], {
    stdio:['ignore', 'inherit', 'inherit'],
})

writeFileSync(pidFile, String(grandchild.pid))

// Read stdin to completion (the orchestrator writes the
// prompt and closes stdin), then exit 0.
process.stdin.resume()
process.stdin.on('end', () => {
    process.exit(0)
})
```

Make it executable:

```bash
chmod +x test/mock-agent-grandchild-exit.js
```

- [ ] **Step 2: Write the failing test**

Append to `test/integration.test.ts`. Add `MOCK_GRANDCHILD_EXIT` alongside the existing mock constants:

```ts
const MOCK_GRANDCHILD_EXIT = join(
    process.cwd(), 'test',
    'mock-agent-grandchild-exit.js'
)
```

Then append the test:

```ts
test(
    'spawnAgent grace timer kills process group ' +
    'when agent exits 0 but grandchild holds pipe',
    async t => {
        const logDir = mkdtempSync(
            join(
                tmpdir(),
                'nightralph-grandchild-exit-'
            )
        )
        try {
            const logPath = join(
                logDir, 'exit.log'
            )
            const pidFile = join(
                logDir, 'grandchild.pid'
            )
            const start = Date.now()
            const result = await spawnAgent({
                prompt:'test prompt',
                agentCmd:MOCK_GRANDCHILD_EXIT,
                model:null,
                timeout:30,
                logPath,
                cwd:logDir,
            })
            const elapsed = Date.now() - start

            t.equal(
                result.exitCode, 0,
                'agent exited 0'
            )
            t.equal(
                result.timedOut, false,
                'not a timeout'
            )
            t.ok(
                elapsed < 10_000,
                'spawnAgent resolved within 10s ' +
                `(took ${elapsed}ms)`
            )

            t.ok(
                existsSync(pidFile),
                'grandchild pid file exists'
            )
            const pid = Number(
                readFileSync(pidFile, 'utf8').trim()
            )
            let alive = true
            try {
                process.kill(pid, 0)
            } catch {
                alive = false
            }
            t.equal(
                alive, false,
                'grandchild was killed by the ' +
                'grace timer'
            )
        } finally {
            rmSync(logDir, {
                recursive:true, force:true,
            })
        }
    }
)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "grace timer kills"`
Expected: FAIL -- the grandchild is still alive after `spawnAgent` resolves (or `spawnAgent` hangs past 10s).

- [ ] **Step 4: Implement the fix**

In `src/orchestrator.ts`, in the `proc.on('exit', ...)` handler (around line 804), change:

```ts
        proc.on('exit', code => {
            graceTimer = setTimeout(() => {
                proc.stdout.destroy()
                proc.stderr.destroy()
                finish(code ?? 1)
            }, CLOSE_GRACE_MS)
        })
```

to:

```ts
        proc.on('exit', code => {
            graceTimer = setTimeout(() => {
                killProcessGroup(proc.pid)
                proc.stdout.destroy()
                proc.stderr.destroy()
                finish(code ?? 1)
            }, CLOSE_GRACE_MS)
        })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts \
    test/integration.test.ts \
    test/mock-agent-grandchild-exit.js
git commit -m "fix: grace timer kills process group on normal exit

When an agent exits 0 but a grandchild (dev server, watcher)
holds the stdout pipe open, the grace timer now kills the
agent's process group before destroying the streams. Without
this, the grandchild survived indefinitely."
```

---

### Task 4: Track test-gate processes in signal registry (Review finding 1)

The signal handler (`killRunningAgents`) only kills agents. A SIGINT during the test-gate phase leaves the test process and its children alive. Fix: `runTestCmd` registers its PID in the same set the signal handler iterates.

**Files:**
- Modify: `src/testcmd.ts:27-78` (`runTestCmd` -- add optional `registry` parameter)
- Modify: `src/orchestrator.ts:954-985` (`runTestGate` -- pass `runningAgents` to `runTestCmd`)
- Test: `test/testcmd.test.ts` (append)

**Interfaces:**
- Consumes: `runTestCmd(opts)` with existing `{ cmd, cwd, timeout }`
- Produces: `runTestCmd(opts)` now accepts optional `registry?:Set<number>`; when provided, the child's PID is added on spawn and removed on close/error. `runTestGate` passes `runningAgents` so the signal handler kills test processes too.

- [ ] **Step 1: Write the failing test**

Append to `test/testcmd.test.ts`:

```ts
test(
    'runTestCmd registers and unregisters pid ' +
    'in the provided registry',
    async t => {
        const dir = tmp()
        const registry = new Set<number>()
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({
                scripts:{ test:'echo ok' },
            })
        )
        try {
            const promise = runTestCmd({
                cmd:'echo ok',
                cwd:dir,
                timeout:10,
                registry,
            })
            // Give the child a moment to spawn
            await new Promise(
                r => setTimeout(r, 100)
            )
            t.ok(
                registry.size > 0,
                'pid was registered during execution'
            )
            await promise
            t.equal(
                registry.size, 0,
                'pid was unregistered after completion'
            )
        } finally {
            rmSync(dir, {
                recursive:true, force:true,
            })
        }
    }
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "registers and unregisters"`
Expected: FAIL -- `runTestCmd` does not accept `registry` (TypeScript error), or registry stays empty.

- [ ] **Step 3: Implement the change in testcmd.ts**

In `src/testcmd.ts`, change `runTestCmd`'s parameter type from:

```ts
export function runTestCmd (opts:{
    cmd:string
    cwd:string
    timeout:number
}):Promise<TestResult> {
```

to:

```ts
export function runTestCmd (opts:{
    cmd:string
    cwd:string
    timeout:number
    registry?:Set<number>
}):Promise<TestResult> {
```

After the `spawn` call (after line 38), add registration:

```ts
        if (
            child.pid !== undefined &&
            opts.registry
        ) {
            opts.registry.add(child.pid)
        }
```

In the `child.on('error', ...)` handler, add unregistration before `resolve`:

```ts
            if (
                child.pid !== undefined &&
                opts.registry
            ) {
                opts.registry.delete(child.pid)
            }
```

In the `child.on('close', ...)` handler, add the same unregistration before `resolve`.

- [ ] **Step 4: Pass the registry from runTestGate**

In `src/orchestrator.ts`, in `runTestGate` (around line 963), change:

```ts
    const result = await runTestCmd({
        cmd:opts.testCmd,
        cwd:opts.worktreePath,
        timeout:opts.timeout,
    })
```

to:

```ts
    const result = await runTestCmd({
        cmd:opts.testCmd,
        cwd:opts.worktreePath,
        timeout:opts.timeout,
        registry:runningAgents,
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 6: Commit**

```bash
git add src/testcmd.ts src/orchestrator.ts \
    test/testcmd.test.ts
git commit -m "fix: track test-gate processes in signal registry

runTestCmd now accepts an optional registry Set. runTestGate
passes the module-level runningAgents set so killRunningAgents
(called by the SIGINT/SIGTERM handler) kills test processes
too, not just agents."
```

---

### Task 5: Serialize worktree removal through the module queue (Review finding 2)

`createWorktree` is serialized through `worktreeQueue`, but `removeWorktree` calls git directly. Concurrent create + remove can race on `.git/worktrees` metadata. Fix: route `removeWorktree` through the same queue.

**Files:**
- Modify: `src/worktree.ts:130-141` (`removeWorktree`)
- Test: `test/worktree.test.ts` (append)

**Interfaces:**
- Consumes: `removeWorktree(path, opts?)` -- signature unchanged
- Produces: `removeWorktree` now serialized through `worktreeQueue`; callers see no change except that concurrent calls no longer race

- [ ] **Step 1: Write the failing test**

Append to `test/worktree.test.ts`:

```ts
test(
    'removeWorktree is serialized with ' +
    'createWorktree',
    async t => {
        const repoDir = mkdtempSync(
            join(tmpdir(), 'nightralph-wt-serial-')
        )
        execSync('git init', { cwd:repoDir })
        execSync(
            'git config user.email test@test.com',
            { cwd:repoDir }
        )
        execSync(
            'git config user.name Test',
            { cwd:repoDir }
        )
        writeFileSync(
            join(repoDir, 'file.txt'), 'init'
        )
        execSync('git add . && git commit -m init', {
            cwd:repoDir,
        })

        const repoName = basename(repoDir)
        const baseBranch = 'main'

        try {
            execSync('git branch -M main', {
                cwd:repoDir,
            })
        } catch {
            // already on main
        }

        const makeTicket = (n:number) => ({
            num:n,
            slug:`t${n}`,
            filename:`0${n}-t${n}.md`,
            filepath:`/fake/0${n}-t${n}.md`,
            body:'test',
            status:'ready-for-agent',
            blockers:[] as number[],
        })

        // Create a worktree, then concurrently create
        // another and remove the first. The queue must
        // prevent git metadata races.
        const wt1 = await createWorktree({
            repoRoot:repoDir,
            repoName,
            baseBranch,
            ticket:makeTicket(1),
        })

        const results = await Promise.allSettled([
            createWorktree({
                repoRoot:repoDir,
                repoName,
                baseBranch,
                ticket:makeTicket(2),
            }),
            removeWorktree(
                wt1.worktreePath, { force:true }
            ),
        ])

        t.equal(
            results[0].status, 'fulfilled',
            'concurrent create succeeded'
        )
        t.equal(
            results[1].status, 'fulfilled',
            'concurrent remove succeeded'
        )

        t.equal(
            existsSync(wt1.worktreePath), false,
            'first worktree was removed'
        )

        if (results[0].status === 'fulfilled') {
            const wt2 = results[0].value
            t.ok(
                existsSync(wt2.worktreePath),
                'second worktree exists'
            )
            await removeWorktree(
                wt2.worktreePath, { force:true }
            )
        }
    }
)
```

- [ ] **Step 2: Run the test to verify it passes or fails with a race**

Run: `npm test 2>&1 | grep -A3 "serialized with"`

This test may pass sometimes and fail other times due to the race. The fix ensures it always passes.

- [ ] **Step 3: Implement the fix**

In `src/worktree.ts`, extract the current `removeWorktree` body into `removeWorktreeNow` and route through the queue:

```ts
async function removeWorktreeNow (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    const args = [
        '-C', worktreePath,
        'worktree', 'remove',
    ]
    if (opts?.force) args.push('--force')
    args.push(worktreePath)
    await execFileAsync('git', args)
}

export async function removeWorktree (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    const result = worktreeQueue.then(
        () => removeWorktreeNow(worktreePath, opts)
    )
    worktreeQueue = result.catch(() => {})
    return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "fix: serialize worktree removal through the queue

removeWorktree now goes through the same module-level promise
queue as createWorktree so concurrent create + remove calls
cannot race on .git/worktrees metadata."
```

---

### Task 6: Carry worktree info in failure outcomes and clean up (Review finding 5)

`runTicketAttempt` returns `{ kind:'no-commits' }` without the worktree path or branch name. `runTicketAttempts` catches errors without worktree info. The `runWavesIsolated` handlers for these outcomes have nothing to clean up, so the worktree directory, branch, and `.git/worktrees` entry leak.

**Files:**
- Modify: `src/orchestrator.ts:1129-1145` (`TicketOutcome` type)
- Modify: `src/orchestrator.ts:1240-1243` (`runTicketAttempt` no-commits return)
- Modify: `src/orchestrator.ts:1280-1323` (`runTicketAttempts` error handling)
- Modify: `src/orchestrator.ts:1645-1665` (`runWavesIsolated` handlers)
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `TicketOutcome`, `removeWorktreeQuietly`, `runTicketAttempt`, `runTicketAttempts`
- Produces: `TicketOutcome` `no-commits` variant now carries `worktreePath:string` and `branchName:string`; `error` variant now carries optional `worktreePath?:string` and `branchName?:string`; `runWavesIsolated` cleans up worktrees for these outcomes

- [ ] **Step 1: Update the `TicketOutcome` type**

In `src/orchestrator.ts`, change the `TicketOutcome` type (around line 1129):

From:

```ts
type TicketOutcome =
    | { kind:'worktree-error'; error:unknown }
    | { kind:'error'; error:unknown }
    | { kind:'no-commits' }
```

To:

```ts
type TicketOutcome =
    | { kind:'worktree-error'; error:unknown }
    | {
        kind:'error'
        error:unknown
        worktreePath?:string
        branchName?:string
    }
    | {
        kind:'no-commits'
        worktreePath:string
        branchName:string
    }
```

- [ ] **Step 2: Update `runTicketAttempt` no-commits return**

In `runTicketAttempt` (around line 1240), change:

```ts
    if (!hasNewCommits(
        opts.repoRoot, opts.baseBranch,
        worktree.branchName
    )) {
        return { kind:'no-commits' }
    }
```

to:

```ts
    if (!hasNewCommits(
        opts.repoRoot, opts.baseBranch,
        worktree.branchName
    )) {
        await removeWorktreeQuietly(
            worktree.worktreePath, d
        )
        return {
            kind:'no-commits',
            worktreePath:worktree.worktreePath,
            branchName:worktree.branchName,
        }
    }
```

- [ ] **Step 3: Update `runTicketAttempts` error catch**

In `runTicketAttempts` (around line 1304), the catch block currently returns `{ kind:'error', error }`. It does not have access to the worktree from the failed attempt because `runTicketAttempt` threw. No worktree info is available here (the attempt that threw may or may not have created one), so leave the error outcome without worktree fields -- the `runTicketAttempt` function already cleans up its own worktree on `failed` outcomes, and a throw means the worktree state is unknown. The orchestrator handler will log but cannot clean up.

No code change needed in this catch block.

- [ ] **Step 4: Update `runWavesIsolated` no-commits handler**

In `runWavesIsolated` (around line 1657), the no-commits worktree is already cleaned up in Step 2 (inside `runTicketAttempt`). No additional cleanup needed in the handler. The handler continues to log and add to `failedNums`.

- [ ] **Step 5: Run the tests to verify nothing broke**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts
git commit -m "fix: clean up worktree on no-commits outcome

The no-commits path in runTicketAttempt now removes its
worktree before returning, and the outcome type carries
worktreePath and branchName so callers can log them.
Previously these worktrees leaked on disk."
```

---

### Task 7: Record all terminal failures in progress.md (Review finding 4)

The `worktree-error`, `error`, and `no-commits` handlers in `runWavesIsolated` update the display and `failedNums` but never call `checkTicket` or `saveProgress`. These failures are invisible in `progress.md`.

**Files:**
- Modify: `src/orchestrator.ts:1637-1665` (`runWavesIsolated` outcome handlers)
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `checkTicket(progress, ticketNum, result)`, `saveProgress(...)`, `TicketOutcome` (as updated by Task 6)
- Produces: no interface change; behavioral: every terminal failure now appears in `progress.md` with `done:false`

- [ ] **Step 1: Add progress recording to the worktree-error handler**

In `runWavesIsolated` (around line 1637), after the existing `d.log(...)` call in the `worktree-error` block, add:

```ts
            if (outcome.kind === 'worktree-error') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: failed to ` +
                    'create worktree: ' +
                    formatErrorMessage(outcome.error)
                )
                checkTicket(progress, ticket.num, {
                    branch:'',
                    exitCode:1,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    progressPath,
                    progress,
                    'nightralph: ' +
                    `${ticket.filename} ` +
                    'worktree error',
                    d,
                )
                continue
            }
```

- [ ] **Step 2: Add progress recording to the error handler**

In the `error` block (around line 1647), add after the existing `d.log(...)`:

```ts
            if (outcome.kind === 'error') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: ` +
                    'attempt error: ' +
                    formatErrorMessage(outcome.error)
                )
                checkTicket(progress, ticket.num, {
                    branch:outcome.branchName ?? '',
                    exitCode:1,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    progressPath,
                    progress,
                    'nightralph: ' +
                    `${ticket.filename} error`,
                    d,
                )
                continue
            }
```

- [ ] **Step 3: Add progress recording to the no-commits handler**

In the `no-commits` block (around line 1657), add after the existing `d.log(...)`:

```ts
            if (outcome.kind === 'no-commits') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: agent ` +
                    'exited 0 but made no changes; ' +
                    'leaving ticket ready-for-agent'
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
                    'nightralph: ' +
                    `${ticket.filename} no commits`,
                    d,
                )
                continue
            }
```

- [ ] **Step 4: Write the test**

Append to `test/integration.test.ts`. This test uses `mock-agent-noop.js` (which exits 0 without committing) to trigger the `no-commits` path and verifies that progress.md records the failure:

```ts
test(
    'runWavesIsolated records no-commits ' +
    'failure in progress.md',
    async t => {
        const projectDir = tmp()
        try {
            execSync('git init', { cwd:projectDir })
            execSync(
                'git config user.email t@t.com',
                { cwd:projectDir }
            )
            execSync(
                'git config user.name T',
                { cwd:projectDir }
            )
            writeFileSync(
                join(projectDir, 'init.txt'), 'x'
            )
            execSync(
                'git add . && git commit -m init',
                { cwd:projectDir }
            )
            try {
                execSync('git branch -M main', {
                    cwd:projectDir,
                })
            } catch {
                // already on main
            }

            const issuesDir = join(
                projectDir,
                '.scratch', 'feat'
            )
            mkdirSync(issuesDir, { recursive:true })
            writeFileSync(
                join(issuesDir, '01-noop.md'),
                [
                    '# Noop ticket',
                    '',
                    '**Status:** ready-for-agent',
                ].join('\n')
            )
            writeFileSync(
                join(issuesDir, 'spec.md'),
                '# Spec\nDo nothing.'
            )

            const logsDir = join(
                projectDir,
                '.scratch', 'feat', 'logs'
            )

            const tickets = scanTickets(issuesDir)

            await runWavesIsolated({
                tickets,
                specBody:'# Spec',
                agentCmd:MOCK_AGENT_NOOP,
                model:null,
                timeout:10,
                logsDir,
                featureName:'feat',
                conflictStrategy:'respawn',
                retries:0,
                retryDelay:0,
            })

            const progressPath = join(
                projectDir,
                '.scratch', 'feat', 'progress.md'
            )
            t.ok(
                existsSync(progressPath),
                'progress.md exists'
            )
            const content = readFileSync(
                progressPath, 'utf8'
            )
            t.ok(
                content.includes('[ ] 01-noop.md'),
                'ticket is unchecked in progress'
            )
            t.ok(
                content.includes('exit: 0'),
                'exit code 0 recorded'
            )
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    }
)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`

- [ ] **Step 6: Update AGENTS.md contracts**

In `AGENTS.md`, update the relevant contract sections:

Under `### testcmd module`, change `runTestCmd(opts)` description to note the optional `registry` parameter:
```
- **runTestCmd(opts)**: `{ cmd, cwd, timeout, registry? }` --
  runs `cmd` via `sh -c` in its own process group; when
  `registry` (a `Set<number>`) is provided, the child's
  PID is added on spawn and removed on close
```

Under `### worktree module`, update `removeWorktree`:
```
- **removeWorktree(path, opts?)**: accepts optional
  `{ force?:boolean }`; when `force` is `true`,
  passes `--force` to `git worktree remove` so dirty
  worktrees are removed; serialized through the same
  module-level queue as `createWorktree` so concurrent
  calls cannot race on `.git/worktrees` metadata
```

Under `### orchestrator`, update `spawnAgent` to note the grace-timer behavior:
```
  resolves within `CLOSE_GRACE_MS` (2s) of exit even
  when a grandchild holds the stdout pipe; the grace
  timer kills the agent's process group before
  destroying the streams
```

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts \
    test/integration.test.ts \
    AGENTS.md
git commit -m "fix: record all terminal failures in progress.md

The worktree-error, error, and no-commits handlers in
runWavesIsolated now call checkTicket and saveProgress so
every terminal failure appears in progress.md. Also updates
AGENTS.md contracts for Tasks 4-7."
```
