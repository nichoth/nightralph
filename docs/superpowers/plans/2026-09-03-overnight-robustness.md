# Overnight Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an unattended run such as `caffeinate -i npx nightralph pi -m openrouter/z-ai/glm-5.3-flash` survive the night: no crash from a repeated failure, no hang on a timed-out agent, no crash from a fast-exiting agent, no random worktree failure, orderly shutdown on Ctrl-C, and a backoff between retries so a provider outage is waited out instead of burning every attempt.

**Architecture:** Every fix lives in the module that owns the behavior. `src/progress.ts` stops committing when nothing changed. `src/orchestrator.ts` contains the retry loop, so it gets the backoff, the failed-ticket exclusion, the attempt error containment, the process-group kill, the stdin error guard, and a registry of running agents. `src/worktree.ts` serializes worktree creation. `src/display.ts` gives up its process signal handlers and `src/index.ts` installs one that kills agents and exits. Each task is verified by a test against a mock agent that reproduces the failure.

**Tech Stack:** TypeScript, Node >= 24, ESM, yargs, `@substrate-system/tapzero`, esbuild.

**Spec:** The assessment below, in this file.

## Global Constraints

- No line longer than 80 columns in TypeScript.
- No space between colon and type annotation (`foo:string`).
- Ternaries formatted as `cond ?\n    a :\n    b`.
- No em dashes or arrow glyphs in docs or comments; use `--` and `->`.
- No emojis in file names or comments.
- Do not test for specific text content of docs. Tests assert on the behavior of code.
- `package.json` lists every source module in `build-esm` and every test file in `test`. No new source or test files are added by this plan, only new mock agents under `test/`, which need no registration.
- Every new mock agent must be executable: `chmod +x test/<mock>.js`. The orchestrator spawns the file directly, not through `node`.
- Run `npm test` from the repo root. It builds the tests first. Run `npm run build` before any test that spawns `dist/index.js`.
- Commit after each task. Do not commit `progress.md`, worktrees, or anything under `.scratch/`.

---

## Assessment

Written 2026-09-03 against the working tree after commit `f5b448f` (0.0.19, with the retry and thinking-escalation changes uncommitted). Lint was clean and all 153 tests passed. The findings below were each reproduced with a script against `dist/`.

### Confirmed by reproduction

1. **A ticket that fails in two consecutive waves crashes the run.** A failed ticket keeps `ready-for-agent`, so `findReadyTickets` selects it again in every later wave. The second failure writes identical `progress.md` content, and `commitProgress` (`src/progress.ts:197`) throws `nothing to commit`. Nothing catches it at `src/orchestrator.ts:1521`, so the process dies mid-wave; in the repro the other ticket in that wave had finished but was never merged.

2. **A timed-out agent can wedge the orchestrator forever.** `spawnAgent` sends SIGKILL only to the agent (`src/orchestrator.ts:711`) and resolves on `close` (line 720). A child of the agent that inherited the stdout pipe, such as a dev server or watcher, keeps the pipe open and `close` never fires. With a 2 second timeout the promise was still pending after 12 seconds. `src/testcmd.ts:34` already solves the same problem for the test command with `detached:true` and a process-group kill.

3. **An agent that exits before reading stdin crashes the process with EPIPE.** For `claude` and `codex` the prompt is written to stdin at `src/orchestrator.ts:715` with no `error` listener on `proc.stdin`. A CLI that dies at once on an auth error or rejected flag, plus a prompt larger than the pipe buffer, raises an uncaught exception. Prompts include the whole spec, so that size is normal.

4. **Parallel worktree creation races inside git.** 50 concurrent `createWorktree` calls produced one `failed to read .git/worktrees/.../commondir` error. That outcome is `worktree-error`, which `runTicketAttempts` returns without retrying (`src/orchestrator.ts:1207`).

5. **Ctrl-C no longer stops the run.** `StatusDisplay.startWave` installs SIGINT and SIGTERM handlers (`src/display.ts:197`) that only restore the cursor. Installing any handler removes Node's default exit, so the orchestrator, the agents, and their children keep running.

### Not reproduced, but will hurt overnight

6. **No backoff between retries.** The loop at `src/orchestrator.ts:1192` respawns instantly, so a provider outage burns all attempts in seconds, every ticket in the wave fails, and the run exits with `No tickets completed this wave`.

7. **Any throw inside an attempt kills every ticket in the wave.** Attempts run under `Promise.all` (`src/orchestrator.ts:1456`). `isDirty`, `hasNewCommits`, and `commitDirty` call git synchronously and throw when, for example, the agent deleted its own worktree.

8. **Cost bound on a stuck ticket.** With the 3600 second default timeout and two retries, one ticket can hold a wave for three hours. This is a documentation item: recommend a lower `--timeout` for fast models.

9. **Agents can reach outside the worktree.** Worktrees are siblings of the repo, so `../<repo>` is the live checkout, and nothing in the prompt forbids `git push`.

### Seen in a real run

12. **A failed agent's dirty worktree cannot be removed, and the reason is cut off.** A run of `nightralph pi -m openrouter/z-ai/glm-5.3-flash` in a sibling project (16 tickets, 11 waves) ended after wave 1 with `agent exited 1`, then `Failed to remove worktree ...: Command failed: git -C /Users/ni` truncated by the status display, then `No tickets completed this wave. Stopping.` The agent was mid-rewrite of a tracked file when it exited, and `removeWorktree` (`src/worktree.ts:122`) runs `git worktree remove` without `--force`, which git refuses for a worktree with modified or untracked files. The leftover directory is harmless (the next `createWorktree` force-removes it) but the truncated line hides the cause. That run also used the published 0.0.17, which has no retries; the retry work in this tree must be published before the README command benefits from it.

### Documentation

10. `pi --approve` means "trust project-local files", not tool auto-approval. README line 207 describes it as granting write access.
11. The README never says `.scratch` should be gitignored, but `commitProgress` uses `git add --force` and `markDone` writes into `.scratch` during the run. In a repo that tracks `.scratch`, the next start fails the dirty-tree check.

### Design decisions

- **A ticket that exhausts its attempts is excluded from later waves of the same run.** Its file keeps `ready-for-agent` so tomorrow's run picks it up, and progress.md records the failure. This bounds cost to `retries + 1` attempts per ticket per run. A ticket whose merge failed is still re-run in a later wave: a fresh worktree from the updated base cannot conflict, so that second chance is worth its cost.
- **`commitProgress` becomes idempotent** and returns whether a commit was made. The orchestrator additionally logs, instead of throwing, when a progress commit fails for any other reason. The initial "start" commit still throws, because that is a configuration problem worth stopping for before any agent runs.
- **Backoff defaults to 30 seconds in the CLI, doubling per retry, and 0 in the library functions**, so the existing test suite keeps its speed and only CLI subprocess tests that exercise retries need `--retry-delay 0`.
- **Signal handling moves to the CLI.** The display only draws. The orchestrator exposes `killRunningAgents()` so the CLI can take the agents down before exiting.
- **Agents run in their own process group** (`detached:true`) so the timeout kill and the signal handler can kill their children. As a fallback for a grandchild that escaped the group, the stdio streams are destroyed two seconds after `exit` so `close` always fires.

---

## File Structure

| File | Change |
| --- | --- |
| `src/progress.ts` | `commitProgress` skips a no-op commit, returns `Promise<boolean>` |
| `src/orchestrator.ts` | `saveProgress` helper; `failedNums` exclusion in both wave loops; stdin error guard; `detached:true`, `killProcessGroup`, close fallback; `runningAgents` registry and `killRunningAgents()`; `DEFAULT_RETRY_DELAY`, `retryDelayFor`, `retryDelay` option; `error` outcome and try/catch in `runTicketAttempts`; new prompt rules |
| `src/worktree.ts` | `createWorktree` runs through a module-level queue; `removeWorktree` accepts `{ force }` |
| `src/display.ts` | Remove `signalHandler` and the `process.on` calls |
| `src/index.ts` | `--retry-delay` flag; SIGINT/SIGTERM handler |
| `test/progress.test.ts` | idempotent commit test |
| `test/orchestrator.test.ts` | `retryDelayFor` and prompt rule tests |
| `test/worktree.test.ts` | parallel creation test |
| `test/display.test.ts` | no-signal-handler test |
| `test/integration.test.ts` | failed-ticket exclusion, EPIPE, grandchild kill, SIGINT, backoff, attempt error tests; `--retry-delay 0` on retry-exercising CLI tests |
| `test/mock-agent-fail-ticket-01.js` | new: exits 1 for ticket 01, commits for others |
| `test/mock-agent-exit-before-reading.js` | new: exits 1 without reading stdin |
| `test/mock-agent-grandchild-hang.js` | new: spawns `sleep` sharing stdio, records its pid, hangs |
| `test/mock-agent-delete-worktree-01.js` | new: deletes its cwd for ticket 01, commits for others |
| `test/mock-agent-dirty-then-fail.js` | new: leaves an untracked file and exits 1 |
| `README.md`, `AGENTS.md` | flag, behavior, and wording updates |

---

### Task 1: `commitProgress` skips an unchanged file

**Files:**
- Modify: `src/progress.ts:186-202`
- Test: `test/progress.test.ts` (append after the existing `commitProgress` tests, around line 480)

**Interfaces:**
- Produces: `commitProgress(repoRoot:string, progressPath:string, message:string):Promise<boolean>` -- resolves `true` when a commit was made, `false` when the staged file matched HEAD. Task 2 relies on the no-throw behavior.

- [ ] **Step 1: Write the failing test**

Append to `test/progress.test.ts`:

```ts
test(
    'commitProgress returns false and does not throw when ' +
    'the progress file is unchanged since the last commit',
    async t => {
        const repoRoot = initTempRepo()
        const progressPath = join(repoRoot, 'progress.md')
        const data = generateProgress('feat', [
            makeTestTicket({ num:1, filename:'01-a.md' }),
        ])
        writeProgress(progressPath, data)

        const first = await commitProgress(
            repoRoot, progressPath, 'first'
        )
        t.equal(first, true, 'first commit is made')

        writeProgress(progressPath, data)
        const second = await commitProgress(
            repoRoot, progressPath, 'second'
        )
        t.equal(
            second, false,
            'identical content is not committed'
        )

        const log = execSync(
            'git log --oneline', { cwd:repoRoot }
        ).toString()
        t.equal(
            log.includes('second'), false,
            'no empty commit was created'
        )
    }
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A12 "unchanged since"`
Expected: the test throws `Command failed: git commit` because git exits 1 with `nothing to commit`. (The return-value assertions fail to type-check first; that is also a failure.)

- [ ] **Step 3: Implement**

Replace `commitProgress` in `src/progress.ts`:

```ts
// Stages and commits the progress file. Resolves false,
// without committing, when the file matches HEAD: the
// orchestrator records the same outcome more than once
// (a ticket that fails again) and git would otherwise
// exit 1 with "nothing to commit".
export async function commitProgress (
    repoRoot:string,
    progressPath:string,
    message:string
):Promise<boolean> {
    await execFileAsync(
        'git',
        ['add', '--force', progressPath],
        { cwd:repoRoot }
    )

    try {
        await execFileAsync(
            'git',
            ['diff', '--cached', '--quiet', '--', progressPath],
            { cwd:repoRoot }
        )
        return false
    } catch {
        // exit 1: the staged file differs from HEAD
    }

    await execFileAsync(
        'git',
        ['commit', '-m', message, '--', progressPath],
        { cwd:repoRoot }
    )
    return true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`, test count up by 3.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts test/progress.test.ts
git commit -m "fix: commitProgress skips an unchanged progress file"
```

---

### Task 2: A failed ticket is recorded once and not re-run this run

**Files:**
- Modify: `src/orchestrator.ts` (`runWaves` at 1224-1371, `runWavesIsolated` at 1373-1717)
- Create: `test/mock-agent-fail-ticket-01.js`
- Test: `test/integration.test.ts` (append at end)

**Interfaces:**
- Consumes: `commitProgress(...):Promise<boolean>` from Task 1.
- Produces: module-private `saveProgress(opts)` used by every progress write inside the wave loop. `runWaves` and `runWavesIsolated` keep their signatures. Both now skip tickets in a per-run `failedNums:Set<number>` when selecting a wave. The final log line gains `, N failed` when N > 0.

- [ ] **Step 1: Create the mock agent**

`test/mock-agent-fail-ticket-01.js`:

```js
#!/usr/bin/env node
// Exits 1 when run in the worktree for ticket 01 and
// otherwise commits a file and exits 0, so one wave can
// hold a failing and a passing ticket with one agent
// command. Worktree directories are named <repo>.<NN>-<slug>.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

process.stdin.resume()
process.stdin.on('end', () => {
    if (/\.01-/.test(basename(process.cwd()))) process.exit(1)
    const filename = `mock-agent-change-${randomUUID()}.txt`
    writeFileSync(join(process.cwd(), filename), String(Date.now()))
    execSync(`git add ${filename}`, { stdio:'ignore', env:GIT_ENV })
    execSync(
        'git commit -m "mock agent change" --no-verify',
        { stdio:'pipe', env:GIT_ENV }
    )
    process.exit(0)
})
```

Run: `chmod +x test/mock-agent-fail-ticket-01.js`

- [ ] **Step 2: Write the failing test**

In `test/integration.test.ts`, add `type Display` to the import from `'../src/display.js'` (there is no such import yet; add one):

```ts
import type { Display } from '../src/display.js'
```

Append at the end of the file:

```ts
const MOCK_FAIL_TICKET_01 = join(
    process.cwd(), 'test', 'mock-agent-fail-ticket-01.js'
)

// A Display that records log lines so a test can assert on
// what the orchestrator reported.
function captureDisplay ():{ display:Display; lines:string[] } {
    const lines:string[] = []
    return {
        lines,
        display:{
            startWave () {},
            setTicketStatus () {},
            log (message:string) { lines.push(message) },
            cleanup () {},
        },
    }
}

test('runWavesIsolated - a ticket that exhausted its attempts ' +
    'is not re-run in a later wave and the run survives',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '03-after.md'),
            makeTicketBody({
                status:'ready-for-agent', blockers:[2],
            })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const { display, lines } = captureDisplay()

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_FAIL_TICKET_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                display,
                retries:0,
            })

            t.equal(result.allDone, false, 'run reports the failure')
            t.equal(tickets[1].status, 'done', '02 is done')
            t.equal(
                tickets[2].status, 'done',
                '03 is done in the second wave'
            )
            t.equal(
                tickets[0].status, 'ready-for-agent',
                '01 keeps its status for a later run'
            )
            const starts = lines.filter(l =>
                /Starting 01-fail\.md/.test(l)
            )
            t.equal(
                starts.length, 1,
                '01 was started once, not again in wave 2'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A12 "exhausted its attempts"`
Expected: the test rejects with `Command failed: git commit -m nightralph: 01-fail.md failed` (or, once Task 1 is in, `starts.length` is 2).

- [ ] **Step 4: Add `saveProgress` and use it inside the wave loop**

In `src/orchestrator.ts`, add above `export const DEFAULT_RETRIES = 2`:

```ts
// Writes progress.md and commits it. A commit failure is
// logged, never thrown: losing one progress commit is
// better than aborting the wave.
async function saveProgress (opts:{
    repoRoot:string
    progressPath:string
    progress:ProgressData
    message:string
    d:Display
}):Promise<void> {
    writeProgress(opts.progressPath, opts.progress)
    try {
        await commitProgress(
            opts.repoRoot, opts.progressPath, opts.message
        )
    } catch (err) {
        opts.d.log(
            '  Failed to commit progress.md: ' +
            formatErrorMessage(err)
        )
    }
}
```

In `runWavesIsolated`, replace each of the four `writeProgress(progressPath, progress)` + `await commitProgress(repoRoot, progressPath, ...)` pairs inside the `while` loop with one call. For example the failed-outcome pair becomes:

```ts
                await saveProgress({
                    repoRoot,
                    progressPath,
                    progress,
                    message:`nightralph: ${ticket.filename} ` +
                        (outcome.reason === 'tests' ?
                            'tests failed' :
                            'failed'),
                    d,
                })
```

Do the same for the `done`, `done (respawn)`, and `merge failed` pairs. Leave the `nightralph: start` commit before the loop as it is.

- [ ] **Step 5: Exclude exhausted tickets from later waves**

In `runWavesIsolated`, after `const retries = ...` add:

```ts
    // Tickets that used up their attempts this run. They keep
    // ready-for-agent on disk so a later run picks them up,
    // but re-running them in every later wave of this run
    // would only repeat the failure.
    const failedNums = new Set<number>()
```

Change the wave selection:

```ts
        const ready = findReadyTickets(opts.tickets)
            .filter(t => !failedNums.has(t.num))
        if (ready.length === 0) break
```

and the `remaining` filter:

```ts
        const remaining = opts.tickets.filter(t =>
            t.status === 'ready-for-agent' &&
            !readyNums.has(t.num) &&
            !failedNums.has(t.num)
        )
```

Add `failedNums.add(ticket.num)` as the first line inside the `worktree-error`, `no-commits`, and `failed` branches of the outcome loop. Do not add it in the merge-failed branch (see Design decisions).

Change the final summary:

```ts
    d.log(
        `\nFinished: ${totalCompleted} completed` +
        (failedNums.size > 0 ?
            `, ${failedNums.size} failed` :
            '') +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '')
    )
```

Make the same three changes in `runWaves`: declare `failedNums` after `const isPi = ...`, filter `ready` and `remaining`, add `failedNums.add(ticket.num)` in the `result.exitCode !== 0` branch, and extend the summary line.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts \
    test/mock-agent-fail-ticket-01.js
git commit -m "fix: record a failed ticket once and skip it for the rest of the run"
```

---

### Task 3: An agent that exits before reading stdin cannot crash the run

**Files:**
- Modify: `src/orchestrator.ts:714-717`
- Create: `test/mock-agent-exit-before-reading.js`
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Produces: no API change. `spawnAgent` resolves `{ exitCode:1, timedOut:false }` for such an agent.

- [ ] **Step 1: Create the mock agent**

`test/mock-agent-exit-before-reading.js`:

```js
#!/usr/bin/env node
// Exits at once without reading stdin, like a CLI that
// rejects a flag or fails auth before touching the prompt.
process.exit(1)
```

Run: `chmod +x test/mock-agent-exit-before-reading.js`

- [ ] **Step 2: Write the failing test**

Append to `test/integration.test.ts`:

```ts
const MOCK_EXIT_BEFORE_READING = join(
    process.cwd(), 'test', 'mock-agent-exit-before-reading.js'
)

test('spawnAgent - an agent that exits before reading a large ' +
    'prompt does not crash the orchestrator', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-epipe-log-')
    )
    try {
        const result = await spawnAgent({
            prompt:'x'.repeat(2 * 1024 * 1024),
            agentCmd:MOCK_EXIT_BEFORE_READING,
            model:null,
            timeout:10,
            logPath:join(logDir, 'epipe.log'),
            onLine:() => {},
        })
        t.equal(result.exitCode, 1, 'the exit code is reported')
        t.equal(result.timedOut, false, 'not a timeout')
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: the integration test process dies with `Error: write EPIPE` before printing its final `# ok`, and `npm test` exits non-zero.

- [ ] **Step 4: Implement**

In `spawnAgent`, directly above `if (!promptFile) {`:

```ts
    // A CLI that exits before reading its prompt closes the
    // pipe under us. Without a listener that EPIPE is an
    // uncaught exception and takes the whole run down.
    proc.stdin.on('error', err => {
        logStream.write(
            `nightralph: stdin error: ${formatErrorMessage(err)}\n`
        )
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts \
    test/mock-agent-exit-before-reading.js
git commit -m "fix: survive EPIPE from an agent that exits before reading stdin"
```

---

### Task 4: The timeout kill takes the agent's process group and always resolves

**Files:**
- Modify: `src/orchestrator.ts` (`spawn` call at 630, timeout at 695-712, promise at 719-759)
- Create: `test/mock-agent-grandchild-hang.js`
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Produces: module-private `killProcessGroup(proc:ChildProcess):void` and `CLOSE_GRACE_MS = 2000`. Task 6 reuses `killProcessGroup`. Agents now run with `detached:true`.

- [ ] **Step 1: Create the mock agent**

`test/mock-agent-grandchild-hang.js`:

```js
#!/usr/bin/env node
// Starts a long-lived child that shares this process's stdio,
// like a dev server, writes that child's pid to child.pid in
// the working directory, then hangs until it is killed.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const child = spawn('sleep', ['600'], { stdio:'inherit' })
writeFileSync(join(process.cwd(), 'child.pid'), String(child.pid))
process.stdin.resume()
setInterval(() => {}, 1000)
```

Run: `chmod +x test/mock-agent-grandchild-hang.js`

- [ ] **Step 2: Write the failing test**

Append to `test/integration.test.ts`:

```ts
const MOCK_GRANDCHILD_HANG = join(
    process.cwd(), 'test', 'mock-agent-grandchild-hang.js'
)

function isAlive (pid:number):boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// Resolves true once the pid is gone, false if it is still
// alive after `ms`. A killed process can linger as a zombie
// for a moment before it is reaped.
async function waitForExit (pid:number, ms:number):Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (!isAlive(pid)) return true
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    return !isAlive(pid)
}

test('spawnAgent - the timeout kill takes a child that holds ' +
    'the stdout pipe with it and still resolves', async t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-grandchild-')
    )
    let childPid = 0
    let guard:NodeJS.Timeout|null = null
    try {
        const started = Date.now()
        const result = await Promise.race([
            spawnAgent({
                prompt:'test prompt',
                agentCmd:MOCK_GRANDCHILD_HANG,
                model:null,
                timeout:1,
                logPath:join(dir, 'agent.log'),
                cwd:dir,
                onLine:() => {},
            }),
            new Promise<null>(resolve => {
                guard = setTimeout(() => resolve(null), 15_000)
            }),
        ])
        childPid = Number(
            readFileSync(join(dir, 'child.pid'), 'utf8')
        )
        t.ok(result !== null, 'spawnAgent resolved instead of hanging')
        t.ok(
            Date.now() - started < 10_000,
            'resolved within a few seconds of the timeout'
        )
        t.equal(result?.timedOut, true, 'reported as a timeout')
        t.equal(
            await waitForExit(childPid, 3000), true,
            'the child process was killed too'
        )
    } finally {
        if (guard) clearTimeout(guard)
        if (childPid && isAlive(childPid)) {
            process.kill(childPid, 'SIGKILL')
        }
        rmSync(dir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A10 "holds the stdout pipe"`
Expected: `spawnAgent resolved instead of hanging` fails after 15 seconds, and `the child process was killed too` fails.

- [ ] **Step 4: Implement**

Change the `spawn` import at the top of `src/orchestrator.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
```

Add above `export type AgentResult`:

```ts
// How long after 'exit' to wait for stdout and stderr to
// close on their own before destroying them.
const CLOSE_GRACE_MS = 2000

// Kills the agent and every process in its group. An agent
// runs detached so its children (test runners, dev servers)
// share its group and die with it.
function killProcessGroup (proc:ChildProcess):void {
    if (proc.pid) {
        try {
            process.kill(-proc.pid, 'SIGKILL')
            return
        } catch {
            // no such group; the agent may already be gone
        }
    }
    proc.kill('SIGKILL')
}
```

Change the `spawn` call:

```ts
    const proc = spawn(opts.agentCmd, args, {
        stdio:['pipe', 'pipe', 'pipe'],
        cwd:opts.cwd,
        // Own process group, so the timeout kill can take the
        // agent's children with it. A child that inherited our
        // stdout pipe would otherwise keep it open and 'close'
        // would never fire.
        detached:true,
    })
```

In the timeout callback, replace `if (proc.killed) return` with:

```ts
        if (proc.exitCode !== null || proc.signalCode !== null) {
            return
        }
```

and replace `proc.kill('SIGKILL')` with `killProcessGroup(proc)`.

Inside the returned `new Promise`, before `proc.on('close', ...)`:

```ts
        // 'close' waits for stdout and stderr to drain. If a
        // grandchild escaped the group kill and still holds
        // the pipes, destroy them ourselves shortly after
        // 'exit' so the promise always settles.
        proc.on('exit', () => {
            setTimeout(() => {
                proc.stdout.destroy()
                proc.stderr.destroy()
            }, CLOSE_GRACE_MS).unref()
        })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`. The existing `agent that never exits is killed at the timeout` test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts \
    test/mock-agent-grandchild-hang.js
git commit -m "fix: kill the agent's process group at the timeout and always resolve"
```

---

### Task 5: Worktree creation is serialized

**Files:**
- Modify: `src/worktree.ts:47-113`
- Test: `test/worktree.test.ts` (append after the `createWorktree` tests, before `// -- removeWorktree` or equivalent)

**Interfaces:**
- Produces: `createWorktree` keeps its signature. Calls are queued module-wide and run one at a time.

- [ ] **Step 1: Write the failing test**

Add to `test/worktree.test.ts`. It needs `rmSync` from `node:fs`; add it to the existing import if it is not there.

```ts
test(
    'createWorktree succeeds for many tickets created at once',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const created = new Set<string>()
        try {
            for (let round = 0; round < 5; round++) {
                const results = await Promise.allSettled(
                    Array.from({ length:10 }, (_, i) =>
                        createWorktree({
                            repoRoot,
                            repoName,
                            baseBranch,
                            ticket:makeTestTicket({
                                num:i + 1,
                                slug:`par-${i + 1}`,
                            }),
                        })
                    )
                )
                for (const r of results) {
                    if (r.status === 'fulfilled') {
                        created.add(r.value.worktreePath)
                    }
                }
                const failed = results.filter(
                    r => r.status === 'rejected'
                )
                t.equal(
                    failed.length, 0,
                    `round ${round + 1}: no creation failed`
                )
            }
        } finally {
            for (const p of created) {
                rmSync(p, { recursive:true, force:true })
            }
            rmSync(repoRoot, { recursive:true, force:true })
        }
    }
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `for i in 1 2 3; do npm test 2>&1 | grep "no creation failed" | grep -c "^not ok"; done`
Expected: at least one run reports a non-zero count. This is a race; if all three runs pass, note it in the commit message and continue. The serialization is still the fix.

- [ ] **Step 3: Implement**

In `src/worktree.ts`, rename the existing `export async function createWorktree` to `async function createWorktreeNow` (same body) and add below it:

```ts
// git worktree add, branch -D and worktree prune all touch
// shared refs and .git/worktrees. Running them for several
// tickets at once occasionally fails on a half-written
// entry. Creation is quick, so run one at a time.
let worktreeQueue:Promise<unknown> = Promise.resolve()

function enqueue<T> (fn:() => Promise<T>):Promise<T> {
    const next = worktreeQueue.then(fn, fn)
    worktreeQueue = next.catch(() => {})
    return next
}

export function createWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    return enqueue(() => createWorktreeNow(opts))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `for i in 1 2 3; do npm test 2>&1 | tail -1; done`
Expected: `# ok` three times.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "fix: serialize worktree creation to avoid git ref races"
```

---

### Task 6: Ctrl-C and SIGTERM stop the run and the agents

**Files:**
- Modify: `src/orchestrator.ts` (`spawnAgent`), `src/display.ts:138,192-199,246-250`, `src/index.ts:283`
- Test: `test/display.test.ts` (append), `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `killProcessGroup` from Task 4.
- Produces: `export function killRunningAgents():number` in `src/orchestrator.ts` -- kills every agent started by `spawnAgent` that has not yet closed, returns how many. `StatusDisplay` no longer touches `process` signals. The CLI exits 130 on SIGINT and 143 on SIGTERM after killing agents and restoring the cursor.

- [ ] **Step 1: Write the failing display test**

Append to `test/display.test.ts`:

```ts
test('startWave does not install process signal handlers', t => {
    const before = process.listenerCount('SIGINT') +
        process.listenerCount('SIGTERM')
    const display = new StatusDisplay({
        stream:createMockStream(),
    })
    display.startWave(1, 1, createTestTickets())
    const after = process.listenerCount('SIGINT') +
        process.listenerCount('SIGTERM')
    t.equal(
        after, before,
        'signal handling belongs to the CLI, not the display'
    )
    display.cleanup()
})
```

- [ ] **Step 2: Write the failing CLI test**

In `test/integration.test.ts`, extend the `node:child_process` import to `import { execFile, execSync, spawn } from 'node:child_process'`. Append:

```ts
test('CLI subprocess - SIGINT stops the run and kills the ' +
    'agent process tree', async t => {
    const projectDir = tmp()
    let agentChildPid = 0
    try {
        const { issuesDir } = scratchDirs(projectDir)
        writeFileSync(
            join(issuesDir, '01-hang.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const child = spawn(process.execPath, [
            CLI, MOCK_GRANDCHILD_HANG,
            '--spec', FEAT,
            '--timeout', '60',
        ], {
            cwd:projectDir,
            stdio:['ignore', 'pipe', 'pipe'],
        })
        const exited = new Promise<number|null>(resolve => {
            child.on('exit', code => resolve(code))
        })

        // The mock writes child.pid into its cwd, which for an
        // in-place run is the project directory.
        const pidFile = join(projectDir, 'child.pid')
        const deadline = Date.now() + 10_000
        while (!existsSync(pidFile) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        t.ok(existsSync(pidFile), 'agent started')
        agentChildPid = Number(readFileSync(pidFile, 'utf8'))

        child.kill('SIGINT')
        const outcome = await Promise.race([
            exited,
            new Promise<'timeout'>(resolve => {
                setTimeout(() => resolve('timeout'), 5000)
            }),
        ])
        t.ok(outcome !== 'timeout', 'CLI exited after SIGINT')
        t.equal(
            await waitForExit(agentChildPid, 3000), true,
            'the agent process tree was killed'
        )
        if (outcome === 'timeout') child.kill('SIGKILL')
    } finally {
        if (agentChildPid && isAlive(agentChildPid)) {
            process.kill(agentChildPid, 'SIGKILL')
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run build && npm test 2>&1 | grep -B2 -A8 "signal handlers\|process tree"`
Expected: the display test fails (`after` is `before + 2`). The CLI test fails on `the agent process tree was killed`: stdout is not a TTY so `PlainDisplay` is used and Node's default SIGINT exit still applies, but the detached agent and its `sleep` child survive.

- [ ] **Step 4: Remove the display's signal handling**

In `src/display.ts` delete the `signalHandler` field (line 138), the block in `startWave` that registers it (lines 192-199, from the comment `// Register signal handler` through `process.on('SIGTERM', this.signalHandler)`), and the block in `cleanup` that removes it (lines 246-250, from `// Remove signal handlers` through the closing brace).

- [ ] **Step 5: Add the running-agent registry**

In `src/orchestrator.ts`, below `killProcessGroup`:

```ts
const runningAgents = new Set<ChildProcess>()

// Kills every agent this process started and has not seen
// close. The CLI calls it on SIGINT and SIGTERM so agents
// do not outlive the orchestrator. Returns the count.
export function killRunningAgents ():number {
    const count = runningAgents.size
    for (const proc of runningAgents) {
        killProcessGroup(proc)
    }
    runningAgents.clear()
    return count
}
```

In `spawnAgent`, after the `spawn` call add `runningAgents.add(proc)`. In both the `close` and `error` handlers add `runningAgents.delete(proc)` as the first statement.

- [ ] **Step 6: Install the CLI handler**

In `src/index.ts`, import `killRunningAgents` from `'./orchestrator.js'`. In `runExecute`, directly after `const display = createDisplay()`:

```ts
    // Ctrl-C and kill must stop the agents too. Installing a
    // handler removes Node's default exit, so exit explicitly.
    const onSignal = (signal:NodeJS.Signals):void => {
        const killed = killRunningAgents()
        display.cleanup()
        console.error(
            `\nnightralph: received ${signal}, ` +
            `stopped ${killed} agent(s)`
        )
        process.exit(signal === 'SIGINT' ? 130 : 143)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build && npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/display.ts src/index.ts \
    test/display.test.ts test/integration.test.ts
git commit -m "fix: SIGINT and SIGTERM kill running agents and exit"
```

---

### Task 7: Backoff between retries

**Files:**
- Modify: `src/orchestrator.ts` (`runTicketAttempts`, `runWaves`, `runWavesIsolated`, `dryRunIsolated`), `src/index.ts`
- Test: `test/orchestrator.test.ts` (append), `test/integration.test.ts` (append and two edits)

**Interfaces:**
- Produces: `export const DEFAULT_RETRY_DELAY = 30`; `export function retryDelayFor(base:number, attempt:number):number`; `runWavesIsolated` opts gain `retryDelay?:number` (seconds, undefined means 0); `runWaves` gains a trailing `retryDelay?:number` parameter after `retries`; `dryRunIsolated` opts gain `retryDelay?:number` and print it; CLI flag `--retry-delay <seconds>` with default `DEFAULT_RETRY_DELAY`.

- [ ] **Step 1: Write the failing unit test**

Append to `test/orchestrator.test.ts` (add `retryDelayFor` to the import from `'../src/orchestrator.js'`):

```ts
test('retryDelayFor doubles the base delay per retry', t => {
    t.equal(retryDelayFor(30, 2), 30, 'first retry waits base')
    t.equal(retryDelayFor(30, 3), 60, 'second retry doubles')
    t.equal(retryDelayFor(30, 4), 120, 'third retry doubles again')
    t.equal(retryDelayFor(0, 3), 0, 'zero base disables the wait')
})
```

- [ ] **Step 2: Write the failing integration test**

Append to `test/integration.test.ts`:

```ts
test('runWavesIsolated - retryDelay waits before the retry',
    async t => {
        const projectDir = initTempGitRepo()
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        try {
            symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
            chmodSync(join(binDir, 'pi'), 0o755)
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)
            writeFileSync(
                join(issuesDir, '01-flaky.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            const tickets = scanTickets(issuesDir)
            commitAll(projectDir, 'add tickets')

            const originalCwd = process.cwd()
            process.chdir(projectDir)
            try {
                const started = Date.now()
                const result = await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:join(binDir, 'pi'),
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature',
                    conflictStrategy:'respawn',
                    retries:1,
                    retryDelay:1,
                })
                const elapsed = Date.now() - started
                t.equal(result.allDone, true, 'the retry succeeded')
                t.ok(
                    elapsed >= 1000,
                    'at least the retry delay passed'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            cleanupWorktrees(projectDir)
            rmSync(projectDir, { recursive:true, force:true })
            rmSync(binDir, { recursive:true, force:true })
        }
    })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: the test build fails because `retryDelayFor` is not exported and `retryDelay` is not a known option.

- [ ] **Step 4: Implement in the orchestrator**

Below `export const DEFAULT_RETRIES = 2` add:

```ts
// Seconds the CLI waits before the first retry of a ticket.
export const DEFAULT_RETRY_DELAY = 30

function sleep (seconds:number):Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, seconds * 1000)
    })
}

// Seconds to wait before attempt n (n >= 2): the base delay,
// doubled for each further retry, so a provider outage is
// waited out instead of burning every attempt at once.
export function retryDelayFor (
    base:number,
    attempt:number
):number {
    return base * 2 ** (attempt - 2)
}
```

Change `runTicketAttempts` to take `opts:TicketAttemptOpts&{ retries:number; retryDelay:number }` and, in the `else` branch that logs the retry, add before `outcome = await runTicketAttempt(...)`:

```ts
            const wait = retryDelayFor(opts.retryDelay, attempt)
            if (wait > 0) {
                d.log(
                    `  ${ticket.filename}: waiting ${wait}s ` +
                    'before the retry'
                )
                await sleep(wait)
            }
```

In `runWavesIsolated`, add `retryDelay?:number` to the opts type (comment: `// seconds before the first retry, doubling; default 0`), add `const retryDelay = opts.retryDelay ?? 0` next to `retries`, and pass `retryDelay` into `runTicketAttempts`.

In `runWaves`, add a trailing parameter `retryDelay?:number` and, inside the `for` retry loop before `result = await spawnAgent(...)`:

```ts
                    const wait = retryDelayFor(
                        retryDelay ?? 0, attempt
                    )
                    if (wait > 0) {
                        d.log(
                            `  ${t.filename}: waiting ${wait}s ` +
                            'before the retry'
                        )
                        await sleep(wait)
                    }
```

In `dryRunIsolated`, add `retryDelay?:number` to opts and print after the `Retries:` line:

```ts
    console.log(
        `Retry delay:  ${opts.retryDelay ?? DEFAULT_RETRY_DELAY}s`
    )
```

- [ ] **Step 5: Implement in the CLI**

In `src/index.ts`, import `DEFAULT_RETRY_DELAY`. Add after the `retries` option:

```ts
            .option('retry-delay', {
                type:'number',
                default:DEFAULT_RETRY_DELAY,
                describe:'Seconds to wait before the first ' +
                    'retry of a ticket; doubles for each ' +
                    'further retry. 0 disables the wait.',
            })
```

Pass `retryDelay:argv.retryDelay as number|undefined` into `runExecute`, add `retryDelay?:number` to its argument type, and forward it to `dryRunIsolated`, `runWavesIsolated` (as `retryDelay:argv.retryDelay`), and `runWaves` (as the last positional argument after `argv.retries`).

- [ ] **Step 6: Keep the CLI subprocess tests fast**

In `test/integration.test.ts`, add `'--retry-delay', '0',` to the `spawnCli` argument list of these tests, which exercise a retry through the CLI and would otherwise wait 30 seconds and hit the 30 second `execFile` timeout:

- `CLI subprocess exits 1 when agent fails`
- `CLI subprocess - default retries recover a flaky pi agent`

Then run the whole suite once and add the flag to any other `spawnCli` test that now takes longer than a few seconds.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build && time npm test 2>&1 | tail -5`
Expected: `# ok`, and the suite is at most a few seconds slower than before this task.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/index.ts \
    test/orchestrator.test.ts test/integration.test.ts
git commit -m "feat: wait with backoff between retries, --retry-delay flag"
```

---

### Task 8: A throw inside an attempt fails that attempt, not the wave

**Files:**
- Modify: `src/orchestrator.ts` (`TicketOutcome`, `runTicketAttempts`, outcome loop in `runWavesIsolated`)
- Create: `test/mock-agent-delete-worktree-01.js`
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `failedNums` from Task 2, `retryDelayFor` from Task 7.
- Produces: `TicketOutcome` gains `{ kind:'error'; error:unknown }`. `runTicketAttempts` never rejects.

- [ ] **Step 1: Create the mock agent**

`test/mock-agent-delete-worktree-01.js`:

```js
#!/usr/bin/env node
// For ticket 01, deletes its own working directory and exits
// 0, so the orchestrator's git calls in that directory throw.
// For any other ticket, commits a file and exits 0.
import { execSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

process.stdin.resume()
process.stdin.on('end', () => {
    if (/\.01-/.test(basename(process.cwd()))) {
        rmSync(process.cwd(), { recursive:true, force:true })
        process.exit(0)
    }
    const filename = `mock-agent-change-${randomUUID()}.txt`
    writeFileSync(join(process.cwd(), filename), String(Date.now()))
    execSync(`git add ${filename}`, { stdio:'ignore', env:GIT_ENV })
    execSync(
        'git commit -m "mock agent change" --no-verify',
        { stdio:'pipe', env:GIT_ENV }
    )
    process.exit(0)
})
```

Run: `chmod +x test/mock-agent-delete-worktree-01.js`

- [ ] **Step 2: Write the failing test**

Append to `test/integration.test.ts`:

```ts
const MOCK_DELETE_WORKTREE_01 = join(
    process.cwd(), 'test', 'mock-agent-delete-worktree-01.js'
)

test('runWavesIsolated - an agent that removes its worktree ' +
    'fails its ticket without taking the wave down', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-gone.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_DELETE_WORKTREE_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                display:new PlainDisplay(),
                retries:0,
            })
            t.equal(result.allDone, false, 'run reports a failure')
            t.equal(tickets[1].status, 'done', '02 is done')
            t.equal(
                tickets[0].status, 'ready-for-agent',
                '01 keeps its status'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})
```

Add `PlainDisplay` to the import from `'../src/display.js'`: `import { PlainDisplay, type Display } from '../src/display.js'`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A10 "removes its worktree"`
Expected: the test rejects with a `spawnSync git ENOENT` error thrown from `isDirty`.

- [ ] **Step 4: Implement**

Add to the `TicketOutcome` union:

```ts
    | { kind:'error'; error:unknown }
```

In `runTicketAttempts`, wrap the attempt:

```ts
        try {
            outcome = await runTicketAttempt({
                ...opts, attempt, thinking,
            })
        } catch (error) {
            // A git call threw mid-attempt, for example because
            // the agent removed its own worktree. Treat it as a
            // failed attempt so the wave carries on.
            d.log(
                `  ${ticket.filename}: attempt ${attempt} ` +
                `error: ${formatErrorMessage(error)}`
            )
            outcome = { kind:'error', error }
        }
```

In the outcome loop of `runWavesIsolated`, after the `worktree-error` branch:

```ts
            if (outcome.kind === 'error') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: failed: ` +
                    formatErrorMessage(outcome.error)
                )
                continue
            }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts test/integration.test.ts \
    test/mock-agent-delete-worktree-01.js
git commit -m "fix: contain a throw inside a ticket attempt"
```

---

### Task 9: The prompt confines the agent to its worktree

**Files:**
- Modify: `src/orchestrator.ts` (`renderPrompt` rules at 253-263, `renderMergePrompt` at 296)
- Test: `test/orchestrator.test.ts` (append after the `renderPrompt` tests, around line 822)

**Interfaces:**
- Produces: no API change.

- [ ] **Step 1: Write the failing tests**

Add `renderMergePrompt` to the orchestrator import in `test/orchestrator.test.ts`, then append:

```ts
test('renderPrompt forbids pushing and leaving the worktree', t => {
    const prompt = renderPrompt(
        'spec', makeTicket({ num:1, filename:'01-a.md' })
    )
    t.ok(/git push/.test(prompt), 'names git push')
    t.ok(
        /current directory/.test(prompt),
        'confines the agent to the current directory'
    )
})

test('renderMergePrompt forbids pushing', t => {
    const prompt = renderMergePrompt(
        'spec', makeTicket({ num:1, filename:'01-a.md' })
    )
    t.ok(/git push/.test(prompt), 'names git push')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A3 "forbids pushing"`
Expected: both `names git push` assertions fail.

- [ ] **Step 3: Implement**

In `renderPrompt`, after the `Do NOT research external APIs` rule and before `...testRules`:

```ts
        '- Work only inside the current directory. Do not ' +
            'read or modify files outside it; the main ' +
            'checkout lives next door and is not yours.',
        '- Do not run git push, and do not switch or ' +
            'delete branches.',
```

In `renderMergePrompt`, change the last line to:

```ts
        'Do NOT re-implement the ticket from scratch, and ' +
            'do NOT run git push.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: prompt rules keep the agent in its worktree and off git push"
```

---

### Task 10: A failed attempt's worktree is removed even when dirty

**Files:**
- Modify: `src/worktree.ts:115-124`, `src/orchestrator.ts:61-76`
- Create: `test/mock-agent-dirty-then-fail.js`
- Test: `test/worktree.test.ts` (append after the `removeWorktree` tests), `test/integration.test.ts` (append)

**Interfaces:**
- Produces: `removeWorktree(worktreePath:string, opts?:{ force?:boolean }):Promise<void>` -- passes `--force` to git when `opts.force` is true. `removeWorktreeQuietly` in the orchestrator always passes `{ force:true }`; the two direct `removeWorktree` calls after a successful merge or a stopped merge are left unforced.

- [ ] **Step 1: Create the mock agent**

`test/mock-agent-dirty-then-fail.js`:

```js
#!/usr/bin/env node
// Leaves an untracked file behind and exits 1, like an agent
// that was mid-edit when it gave up. git refuses to remove
// such a worktree without --force.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.stdin.resume()
process.stdin.on('end', () => {
    writeFileSync(join(process.cwd(), 'half-done.txt'), 'wip')
    process.exit(1)
})
```

Run: `chmod +x test/mock-agent-dirty-then-fail.js`

- [ ] **Step 2: Write the failing unit test**

Append to `test/worktree.test.ts`:

```ts
test('removeWorktree with force removes a dirty worktree',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const { worktreePath } = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket:makeTestTicket({ num:7, slug:'dirty' }),
        })
        try {
            writeFileSync(join(worktreePath, 'untracked.txt'), 'x')
            await removeWorktree(worktreePath, { force:true })
            t.equal(
                existsSync(worktreePath), false,
                'dirty worktree directory is gone'
            )
        } finally {
            rmSync(worktreePath, { recursive:true, force:true })
            rmSync(repoRoot, { recursive:true, force:true })
        }
    })
```

`writeFileSync` and `existsSync` come from `node:fs`; add them to the import if missing.

- [ ] **Step 3: Write the failing integration test**

Append to `test/integration.test.ts`:

```ts
const MOCK_DIRTY_THEN_FAIL = join(
    process.cwd(), 'test', 'mock-agent-dirty-then-fail.js'
)

test('runWavesIsolated - a failed agent that left files behind ' +
    'still gets its worktree removed', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-messy.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const worktreePath = join(
            projectDir, '..',
            `${basename(projectDir)}.01-messy`
        )

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_DIRTY_THEN_FAIL,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                display:new PlainDisplay(),
                retries:0,
            })
            t.equal(
                existsSync(worktreePath), false,
                'the dirty worktree was removed'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})
```

`basename` comes from `node:path`; extend the existing `join` import.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 -A6 "dirty worktree"`
Expected: the unit test fails to compile (`removeWorktree` takes one argument) and the integration test reports `the dirty worktree was removed` as `not ok`.

- [ ] **Step 5: Implement**

In `src/worktree.ts`:

```ts
export async function removeWorktree (
    worktreePath:string,
    opts:{ force?:boolean } = {}
):Promise<void> {
    // Use git -C to run the command from the worktree
    // directory context so git can resolve the repository.
    // --force is needed for a worktree with modified or
    // untracked files, which a failed agent usually leaves.
    const args = ['-C', worktreePath, 'worktree', 'remove']
    if (opts.force) args.push('--force')
    args.push(worktreePath)
    await execFileAsync('git', args)
}
```

In `src/orchestrator.ts`, `removeWorktreeQuietly`, change the call to `await removeWorktree(worktreePath, { force:true })`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: `# ok`.

- [ ] **Step 7: Commit**

```bash
git add src/worktree.ts src/orchestrator.ts \
    test/worktree.test.ts test/integration.test.ts \
    test/mock-agent-dirty-then-fail.js
git commit -m "fix: force-remove the worktree of a failed attempt"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`, `AGENTS.md`

No tests: docs are not tested.

- [ ] **Step 1: README flag table and notes**

In the flags table add after the `--retries` row:

```
| `--retry-delay <seconds>` | no | `30` | Wait before the first retry of a ticket; doubles for each further retry (30, 60, 120). `0` disables the wait. Lets a provider outage pass instead of burning every attempt at once |
```

In the Notes list, replace the bullet that begins `* A failed attempt is retried` with one that ends:

```
  ... so the first attempt's log is kept. Between attempts the
  orchestrator waits `--retry-delay` seconds, doubling each time.
  A ticket that uses up its attempts is not run again in a later
  wave of the same run; it keeps `ready-for-agent` on disk and is
  picked up by the next run. A ticket whose merge failed is run
  again in a later wave from a fresh worktree on the updated base.
```

Add these bullets to Notes:

```
* Agents run in their own process group. The `--timeout` kill and
  Ctrl-C (SIGINT) or SIGTERM kill the agent and every process it
  started, then nightralph exits with 130 or 143. Worktrees of
  interrupted tickets are left in place and replaced on the next run.
* With a fast model the default hour is generous. A ticket that
  times out with no commits is retried from scratch, so with two
  retries one stuck ticket can hold a wave for three hours. For
  models like `glm-5.3-flash` consider `--timeout 900`.
* `.scratch/` should be listed in `.gitignore`. The orchestrator
  writes ticket status and logs there during the run and force-adds
  only `progress.md`. If `.scratch/` is tracked, those writes dirty
  the working tree and the next run refuses to start.
```

Change the `pi` provider bullet:

```
  * `pi`: `-p --approve --no-session`
    (`--approve` trusts project-local extensions and skills;
    pi runs tools without prompting in `-p` mode. The prompt is
    delivered via temp file, not stdin)
```

Add to the `pi` example in `## Keep Your Machine Awake`:

```sh
caffeinate -i npx nightralph pi -m openrouter/z-ai/glm-5.3-flash --timeout 900
```

- [ ] **Step 2: AGENTS.md contracts**

Update `Last verified` to the date of the change. Then:

CLI section, after the `--retries` bullet:

```
- `--retry-delay <seconds>` -- wait before the first
  retry of a ticket, doubling per retry; default
  `DEFAULT_RETRY_DELAY` (30); `0` disables the wait
- **Signals**: `runExecute` installs SIGINT and SIGTERM
  handlers that call `killRunningAgents()`, run
  `display.cleanup()`, and exit 130 (SIGINT) or 143
  (SIGTERM); the display installs no signal handlers
```

Orchestrator `Exposes` list: add `DEFAULT_RETRY_DELAY`, `retryDelayFor(base, attempt)`, `killRunningAgents()`.

Add bullets:

```
- **retryDelayFor(base, attempt)**: seconds to wait
  before attempt n >= 2: `base * 2 ** (attempt - 2)`
- **killRunningAgents()**: kills the process group of
  every agent `spawnAgent` started that has not closed;
  returns the count
- **spawnAgent** (append): agents are spawned with
  `detached:true` and killed as a process group; stdout
  and stderr are destroyed `CLOSE_GRACE_MS` (2000 ms)
  after `exit` so the promise settles even when a
  grandchild still holds the pipes; a `proc.stdin`
  error (EPIPE from an agent that exited before reading
  the prompt) is written to the log, never thrown
```

Orchestrator `runWaves` and `runWavesIsolated` bullets: add `retryDelay` (`runWaves`: trailing optional parameter after `retries`; `runWavesIsolated`: in opts; undefined means 0, the CLI passes `DEFAULT_RETRY_DELAY`).

Orchestrator `Guarantees`: append

```
  a ticket that used up its attempts (or hit a worktree or
  attempt error) is excluded from later waves of the same
  run; a merge failure is not excluded; a throw inside an
  attempt after worktree creation is caught and counts as
  a failed attempt; a progress commit inside the wave loop
  never throws (failures are logged); the initial
  `nightralph: start` commit still throws
```

Progress section: change `commitProgress` to `commitProgress(repoRoot, path, message):Promise<boolean>` and add to Guarantees: `commitProgress resolves false without committing when the staged file matches HEAD`.

Worktree section: change the `Exposes` entry to `removeWorktree(path, opts?)` and add to Guarantees: `createWorktree calls are serialized module-wide; concurrent calls run one at a time`; `removeWorktree passes --force to git when opts.force is true; the orchestrator forces removal after a failed attempt`.

Add to the README Notes: `Publish and reinstall after upgrading: npx nightralph runs the version in the project's node_modules, so a project pinned to an older release gets none of the retry or timeout behavior described here.`

Display section: remove any mention of signal handlers from `StatusDisplay` and `cleanup` guarantees; add `StatusDisplay never registers process signal listeners`.

- [ ] **Step 3: Regenerate the README table of contents and lint**

Run: `npm run toc && npm run lint`
Expected: lint clean; the TOC is unchanged unless a heading was added.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: retry delay, signal handling, process groups, .scratch gitignore"
```

---

## Self-Review

**Spec coverage.** Finding 1 is Task 1 and Task 2. Finding 2 is Task 4. Finding 3 is Task 3. Finding 4 is Task 5. Finding 5 is Task 6. Finding 6 is Task 7. Finding 7 is Task 8. Finding 8 is the timeout note in Task 11. Finding 9 is Task 9. Finding 12 is Task 10. Findings 10 and 11 are Task 11.

**Placeholder scan.** Every code step shows the code. The one probabilistic step is Task 5 Step 2, which says what to do if the race does not show.

**Type consistency.** `killProcessGroup(proc:ChildProcess)` is defined in Task 4 and used in Task 6. `failedNums` is defined in Task 2 and used in Task 8. `retryDelayFor(base, attempt)` and `sleep(seconds)` are defined in Task 7 and used in Task 8's `runTicketAttempts` only through the existing retry branch. `isAlive` and `waitForExit` are defined in Task 4's test additions and used in Task 6's test. `MOCK_GRANDCHILD_HANG` is defined in Task 4 and used in Task 6. `captureDisplay` from Task 2 is not reused. Task 8's test imports `PlainDisplay` alongside the `Display` type import added in Task 2.
