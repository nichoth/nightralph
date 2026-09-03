# TDD Workflow Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fourth arrow in `grill -> to-spec -> to-tickets -> tdd` true: the orchestrator tells agents to work test-first and refuses to mark a ticket done unless the project's test command passes in the ticket's worktree.

**Architecture:** A new `src/testcmd.ts` module detects and runs the project test command. `renderPrompt` gains an optional test-command argument and emits test-first instructions. `runWavesIsolated` runs the test command in each worktree after the agent exits and before the branch is queued for merge. The CLI exposes `--test-cmd`. Bundled skill text and doc templates lose references to commands this package does not ship.

**Tech Stack:** TypeScript, Node >= 24, ESM, yargs, `@substrate-system/tapzero`, esbuild.

**Spec:** The assessment below, in this file.

## Global Constraints

- No line longer than 80 columns in TypeScript.
- No space between colon and type annotation (`foo:string`).
- Ternaries formatted as `cond ?\n    a :\n    b`.
- No em dashes or arrow glyphs in docs or comments; use `--` and `->`.
- No emojis in file names or comments.
- Do not test for specific text content of docs. Tests below assert on behavior of code, not on markdown.
- `package.json` lists every source module in `build-esm` and every test file in `test`. New files must be added to both lists or they are silently never built or run.
- Run `npm test` from the repo root. It builds first.

---

## Assessment

Written 2026-09-02 against commit `6a492bd` (0.0.19).

### What works

The pipeline is a monotonic ambiguity reducer. `grill` extracts decisions, `to-spec` freezes them, `to-tickets` partitions them into independent slices, and the orchestrator executes. Human judgment sits in the first three steps and automation in the fourth. That is the right boundary: a human cannot review overnight and an agent cannot run an interview.

The artifacts chain cleanly. `domain-modeling` writes `CONTEXT.md` and ADRs, `to-spec` and `to-tickets` read them, and the `tdd` skill reads `CONTEXT.md` too. Vocabulary set during grilling survives into ticket titles and test names. The advice to run `grill -> to-spec` in one context window is correct because `to-spec` is a synthesis with no interview.

Ticket sizing matches the runtime. `to-tickets` sizes each slice to one fresh context window and nightralph gives each ticket exactly that. Vertical slices with blocking edges map directly onto waves and worktrees. Bundling the skills at a pinned upstream commit is the real value of the package.

### Where it breaks down

1. **The `tdd` step is aspirational.** The README says the CLI does the tdd part. The agent prompt in `src/orchestrator.ts` (`renderPrompt`) never mentions tests, seams, or the tdd skill. It tells the agent to spend at most two minutes reading code and start writing code as soon as possible. The tdd skill also requires confirming seams with the user, which cannot happen in a `--print` run. The spec's Testing Decisions section is the only bridge and nothing tells the agent to honor it.

2. **Nothing enforces green.** Success is exit 0 plus new commits (dirty trees are auto-committed). The merge-conflict prompt says to make tests pass; the implementation prompt does not. An agent can commit red tests and the ticket is marked done.

3. **Documented timeout disagrees with the code.** The README table says the default is 300 seconds and `runExecute` has a dead `?? 300` fallback, but the yargs default is 900. The README also still says an agent that leaves uncommitted changes has its ticket left `ready-for-agent`; the code auto-commits instead.

4. **The full spec is prepended to every prompt.** `to-spec` asks for an extremely extensive user story list. That padding is paid for on every ticket in every wave and does not help an implementing agent.

5. **The "no file paths in tickets" rule is wrong for this runtime.** Upstream avoids paths because tickets go stale on a human tracker. Here tickets are executed within hours by an agent told to read for two minutes. Paths and symbol names are the biggest per-ticket speedup available.

6. **Drift the package exists to prevent.** `to-spec` and `to-tickets` tell the user to run `/setup-matt-pocock-skills`, which this package does not ship; the command is `nightralph init`. Both issue-tracker templates document `/wayfinder`, which is not bundled.

### Fix summary

| Gap | Task |
|-----|------|
| 6 stale references | Task 1 |
| 1, 2 test-first prompt and test gate | Tasks 2, 3, 4 |
| 2, 3 CLI flag, timeout docs | Task 5 |
| 5 file paths in tickets | Task 6 |
| 4 spec padding | Task 7 |

Not in scope: re-running tests on the base branch after a wave merges, and a test gate for the in-place (non-git) `runWaves` path where parallel agents share one directory.

---

## File Structure

- Create `src/testcmd.ts` -- detect the project test command and run it in a directory. Pure detection function plus one spawning function.
- Create `test/testcmd.test.ts` -- tests for the above.
- Modify `src/orchestrator.ts` -- `renderPrompt` third argument; test gate in `runWavesIsolated`; `testCmd` in `runWavesIsolated` and `dryRunIsolated` opts; `stripSpecSection` helper.
- Modify `test/orchestrator.test.ts` -- `renderPrompt` and `stripSpecSection` tests.
- Modify `test/integration.test.ts` -- test gate integration tests.
- Modify `src/index.ts` -- `--test-cmd` option, timeout fallback, spec stripping.
- Modify `package.json` -- add the new module and test file to the build and test scripts.
- Modify `scripts/clone-skills.sh`, `src/skills/to-spec/SKILL.md`, `src/skills/to-tickets/SKILL.md`, `src/docs-templates/issue-tracker.md`, `src/docs-templates/issue-tracker-github.md`, `README.md` -- text only.

---

### Task 1: Remove references to commands this package does not ship

**Files:**
- Modify: `scripts/clone-skills.sh`
- Modify: `src/skills/to-spec/SKILL.md:9`
- Modify: `src/skills/to-tickets/SKILL.md:11`, `:60`
- Modify: `src/docs-templates/issue-tracker.md:21-32`
- Modify: `src/docs-templates/issue-tracker-github.md:144` onward

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-facing. Text only.

- [ ] **Step 1: Add the substitution to the clone script so it survives the next upstream pull**

In `scripts/clone-skills.sh`, after the existing `sed` that renames `grill-with-docs`, add:

```bash
# This package's setup command is `nightralph init`, not
# the upstream slash command.
for f in "$SKILLS_DIR"/*/SKILL.md; do
    sed -i '' 's#`/setup-matt-pocock-skills`#`npx nightralph init`#g' "$f"
done

if grep -rq 'setup-matt-pocock-skills' "$SKILLS_DIR"; then
    echo "error: stale setup command reference remains" >&2
    exit 1
fi
```

- [ ] **Step 2: Apply the same substitution to the currently bundled files**

Run from the repo root:

```bash
sed -i '' 's#`/setup-matt-pocock-skills`#`npx nightralph init`#g' \
    src/skills/to-spec/SKILL.md src/skills/to-tickets/SKILL.md
grep -rn 'setup-matt-pocock-skills' src/skills
```

Expected: the grep prints nothing.

- [ ] **Step 3: Delete the Wayfinding sections from both tracker templates**

In `src/docs-templates/issue-tracker.md` delete from the line `## Wayfinding operations` to the end of the file. In `src/docs-templates/issue-tracker-github.md` delete from the line `## Wayfinding Operations` to the end of the file. Both sections describe a `/wayfinder` skill that `SKILL_DIRS` in `src/setup.ts` does not install.

Run:

```bash
grep -rn 'wayfinder\|Wayfinding' src/
```

Expected: nothing.

- [ ] **Step 4: Run the existing suite to confirm nothing depended on that text**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/clone-skills.sh src/skills src/docs-templates
git commit -m "fix: drop references to commands nightralph does not ship"
```

---

### Task 2: Test command module

**Files:**
- Create: `src/testcmd.ts`
- Create: `test/testcmd.test.ts`
- Modify: `package.json` (`build-esm` and `test` scripts)

**Interfaces:**
- Consumes: nothing from this repo.
- Produces:
  - `detectTestCmd(projectDir:string):string|null` -- returns `'npm test'` when `<projectDir>/package.json` parses and has `scripts.test`, otherwise `null`.
  - `runTestCmd(opts:{ cmd:string; cwd:string; timeout:number }):Promise<TestResult>` -- runs `cmd` through `sh -c` in `cwd`, kills it after `timeout` seconds.
  - `type TestResult = { exitCode:number; output:string }` -- combined stdout and stderr in `output`.

- [ ] **Step 1: Register the new files in package.json**

In the `build-esm` script, add `src/testcmd.ts` to the second `esbuild` invocation's file list, right after `src/display.ts`.

In the `test` script, add `test/testcmd.test.ts` to the esbuild file list after `test/display.test.ts`, and add `&& node dist/test/testcmd.test.js` after `node dist/test/display.test.js`.

- [ ] **Step 2: Write the failing tests**

Create `test/testcmd.test.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, writeFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectTestCmd, runTestCmd } from '../src/testcmd.js'

function tmp ():string {
    return mkdtempSync(join(tmpdir(), 'nightralph-testcmd-'))
}

test('detectTestCmd - no package.json', t => {
    const dir = tmp()
    try {
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - package.json without test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts:{ build:'tsc' } })
        )
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - package.json with test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts:{ test:'node t.js' } })
        )
        t.equal(detectTestCmd(dir), 'npm test', 'uses npm test')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - unparseable package.json', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{ nope')
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - exit code and output of a passing ' +
    'command', async t => {
    const dir = tmp()
    try {
        const result = await runTestCmd({
            cmd:'echo ok',
            cwd:dir,
            timeout:10,
        })
        t.equal(result.exitCode, 0, 'exit 0')
        t.ok(result.output.includes('ok'), 'captures stdout')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - exit code of a failing command',
    async t => {
        const dir = tmp()
        try {
            const result = await runTestCmd({
                cmd:'echo bad >&2; exit 3',
                cwd:dir,
                timeout:10,
            })
            t.equal(result.exitCode, 3, 'exit 3')
            t.ok(
                result.output.includes('bad'),
                'captures stderr'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

test('runTestCmd - runs in the given directory', async t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'marker.txt'), '')
        const result = await runTestCmd({
            cmd:'test -f marker.txt',
            cwd:dir,
            timeout:10,
        })
        t.equal(result.exitCode, 0, 'found the marker')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - kills the command after the timeout',
    async t => {
        const dir = tmp()
        try {
            const started = Date.now()
            const result = await runTestCmd({
                cmd:'sleep 30',
                cwd:dir,
                timeout:1,
            })
            t.ok(result.exitCode !== 0, 'non-zero exit')
            t.ok(
                Date.now() - started < 10_000,
                'returned well before 30 seconds'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: the build fails because `../src/testcmd.js` does not exist. That is the failure we want.

- [ ] **Step 4: Write the module**

Create `src/testcmd.ts`:

```ts
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TestResult = {
    exitCode:number
    output:string
}

// Returns the command to run the project's tests, or null
// when the project does not declare one.
export function detectTestCmd (projectDir:string):string|null {
    const pkgPath = join(projectDir, 'package.json')
    if (!existsSync(pkgPath)) return null
    try {
        const pkg = JSON.parse(
            readFileSync(pkgPath, 'utf8')
        ) as { scripts?:Record<string, string> }
        return pkg.scripts?.test ?
            'npm test' :
            null
    } catch {
        return null
    }
}

export function runTestCmd (opts:{
    cmd:string
    cwd:string
    timeout:number
}):Promise<TestResult> {
    return new Promise(resolve => {
        const child = spawn('sh', ['-c', opts.cmd], {
            cwd:opts.cwd,
            stdio:['ignore', 'pipe', 'pipe'],
        })
        const chunks:string[] = []
        child.stdout.on('data', d => chunks.push(String(d)))
        child.stderr.on('data', d => chunks.push(String(d)))

        const timer = setTimeout(() => {
            child.kill('SIGKILL')
        }, opts.timeout * 1000)

        child.on('close', code => {
            clearTimeout(timer)
            resolve({
                exitCode:code ?? 1,
                output:chunks.join(''),
            })
        })
    })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all `testcmd` tests pass along with the existing suite.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add src/testcmd.ts test/testcmd.test.ts package.json
git commit -m "feat: add test command detection and runner"
```

---

### Task 3: Test-first instructions in the agent prompt

**Files:**
- Modify: `src/orchestrator.ts:163-195` (`renderPrompt`)
- Test: `test/orchestrator.test.ts` (after the existing `renderPrompt` tests near line 763)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderPrompt(specBody:string, ticket:Ticket, opts?:{ testCmd?:string|null }):string`. The third argument is optional so every existing caller keeps working. When `opts.testCmd` is a non-empty string the prompt includes test-first rules and the literal command.

- [ ] **Step 1: Write the failing tests**

Add to `test/orchestrator.test.ts` after the `renderPrompt instructs agent to report [x] items` test:

```ts
test('renderPrompt includes the test command when given',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt(
            'spec body here', ticket,
            { testCmd:'npm run check' }
        )
        t.ok(
            prompt.includes('npm run check'),
            'names the test command'
        )
        t.ok(
            prompt.includes('Testing Decisions'),
            'points the agent at the spec seams'
        )
    })

test('renderPrompt omits test rules when no test command',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const withNull = renderPrompt(
            'spec body here', ticket, { testCmd:null }
        )
        const withNothing = renderPrompt(
            'spec body here', ticket
        )
        t.equal(withNull, withNothing,
            'null and omitted produce the same prompt')
        t.ok(
            !withNull.includes('Testing Decisions'),
            'no test rules without a command'
        )
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the first new test fails on `names the test command`. (TypeScript in esbuild does not type-check, so the extra argument compiles and is ignored.)

- [ ] **Step 3: Implement**

Replace the `renderPrompt` function in `src/orchestrator.ts` with:

```ts
export function renderPrompt (
    specBody:string,
    ticket:Ticket,
    opts:{ testCmd?:string|null } = {}
):string {
    const testRules = opts.testCmd ?
        [
            '- Work test-first. For each checklist ' +
                'item, write a failing test at the ' +
                'seams named in the spec\'s Testing ' +
                'Decisions section, then write only ' +
                'enough code to make it pass.',
            `- Run \`${opts.testCmd}\` before ` +
                'committing. Do not commit with failing ' +
                'tests. The orchestrator runs the same ' +
                'command after you exit and rejects the ' +
                'ticket if it fails.',
        ] :
        []

    return [
        '---- SPEC CONTEXT ----',
        specBody,
        '',
        '---- TICKET ----',
        ticket.filename,
        ticket.body,
        '',
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent. ' +
            'Implement the ticket.',
        '',
        'Time is limited. Follow these rules:',
        '- Spend at most 2 minutes reading existing ' +
            'code. Read only the files directly relevant ' +
            'to the ticket.',
        '- Do NOT research external APIs or services ' +
            'via web search. Use the spec and ticket ' +
            'body as your sole reference for API shapes.',
        '- Start writing code as soon as you understand ' +
            'the immediate context. You can read more ' +
            'files as needed while implementing.',
        ...testRules,
        '- Commit your work when finished.',
        '- After completing each checklist item in the ' +
            'ticket, print a line: [x] <item text> ' +
            '(matching the checklist text exactly).',
        '',
    ].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, including the two pre-existing `renderPrompt` tests.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: test-first instructions in the agent prompt"
```

---

### Task 4: Test gate in runWavesIsolated

**Files:**
- Modify: `src/orchestrator.ts` -- imports at top; `runWavesIsolated` opts (line 935); the `renderPrompt` call inside the wave loop (line 1037); the success check after `hasNewCommits` (line 1120); `dryRunIsolated` opts (line 674).
- Test: `test/integration.test.ts` (after the `runWavesIsolated - two independent tickets` test).

**Interfaces:**
- Consumes: `runTestCmd`, `TestResult` from Task 2; `renderPrompt` third argument from Task 3.
- Produces: `runWavesIsolated(opts)` and `dryRunIsolated(opts)` accept `testCmd?:string|null`. When set, after an agent exits 0 with new commits, the command runs in the worktree. Output is written to `<logsDir>/<ticket>.test.log`. A non-zero exit records the ticket as failed in `progress.md`, leaves the ticket file `ready-for-agent`, removes the worktree, and does not queue the branch for merge.

- [ ] **Step 1: Write the failing integration tests**

Add to `test/integration.test.ts` after the `two independent tickets` test. These reuse `initTempGitRepo`, `commitAll`, `makeTicketBody`, and `MOCK_PASS` already defined in that file.

```ts
test('runWavesIsolated - failing test command keeps the ' +
    'ticket ready-for-agent', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-first.md'),
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
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                testCmd:'echo suite failed; exit 1',
            })

            t.equal(result.allDone, false, 'run not done')
            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket left for retry'
            )
            const testLog = join(logsDir, '01-first.test.log')
            t.ok(existsSync(testLog), 'test log written')
            t.ok(
                readFileSync(testLog, 'utf8')
                    .includes('suite failed'),
                'test log holds command output'
            )
            const progress = readFileSync(
                join(projectDir, 'progress.md'), 'utf8'
            )
            t.ok(
                !progress.includes('[x] 01-first.md'),
                'progress does not show the ticket done'
            )
            const log = execSync(
                'git log --oneline', { cwd:projectDir }
            ).toString()
            t.ok(
                !log.includes('mock agent change'),
                'branch was not merged into base'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - passing test command runs in the ' +
    'worktree and the ticket completes', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-first.md'),
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
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                // Only succeeds inside the worktree where
                // the mock agent wrote its file.
                testCmd:'ls mock-agent-change-*.txt',
            })

            t.equal(result.allDone, true, 'run done')
            t.equal(tickets[0].status, 'done', 'ticket done')
            t.ok(
                existsSync(join(logsDir, '01-first.test.log')),
                'test log written on success too'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the first new test fails on `ticket left for retry` (the ticket is marked done because `testCmd` is ignored). The second passes trivially except for `test log written on success too`, which fails.

- [ ] **Step 3: Import the runner**

At the top of `src/orchestrator.ts`, after the `./display.js` import block, add:

```ts
import { runTestCmd } from './testcmd.js'
```

- [ ] **Step 4: Add `testCmd` to the two opts types**

In `dryRunIsolated` (line 674) add `testCmd?:string|null` after `progressPath:string`.

In `runWavesIsolated` (line 935) add `testCmd?:string|null` after `display?:Display`.

- [ ] **Step 5: Pass the command into the prompts**

In `dryRunIsolated`, change the `renderPrompt(opts.specBody, firstReady[0])` call (line 717) to:

```ts
            renderPrompt(
                opts.specBody, firstReady[0],
                { testCmd:opts.testCmd }
            )
```

Also add, right before the `Merge strategy` console line in `dryRunIsolated`:

```ts
    console.log(
        `\nTest command: ${opts.testCmd ?? '(none)'}`
    )
```

In the wave loop of `runWavesIsolated`, change `const prompt = renderPrompt(opts.specBody, t)` (line 1037) to:

```ts
                const prompt = renderPrompt(
                    opts.specBody, t,
                    { testCmd:opts.testCmd }
                )
```

- [ ] **Step 6: Add the gate**

In `runWavesIsolated`, directly after the `if (!hasNewCommits(...)) { ... continue }` block (ends around line 1130) and before `checkItems(ticket, agentResult.completedItems)`, insert:

```ts
            if (opts.testCmd) {
                const testResult = await runTestCmd({
                    cmd:opts.testCmd,
                    cwd:worktree.worktreePath,
                    timeout:opts.timeout,
                })
                const testLogPath = join(
                    opts.logsDir,
                    ticket.filename.replace(
                        /\.md$/, '.test.log'
                    )
                )
                writeFileSync(testLogPath, testResult.output)

                if (testResult.exitCode !== 0) {
                    // Acceptance criteria are not met when
                    // the suite is red, so checklist items
                    // the agent claimed are not checked off.
                    d.setTicketStatus(ticket.num, 'failed')
                    d.log(
                        `  ${ticket.filename}: tests failed ` +
                        `(exit ${testResult.exitCode}); ` +
                        `see ${testLogPath}`
                    )
                    checkTicket(progress, ticket.num, {
                        branch:worktree.branchName,
                        exitCode:testResult.exitCode,
                        done:false,
                    })
                    writeProgress(progressPath, progress)
                    await commitProgress(
                        repoRoot,
                        progressPath,
                        `nightralph: ${ticket.filename} ` +
                            'tests failed'
                    )
                    try {
                        await removeWorktree(
                            worktree.worktreePath
                        )
                    } catch (err) {
                        d.log(
                            '  Failed to remove worktree ' +
                            `${worktree.worktreePath}: ` +
                            formatErrorMessage(err)
                        )
                    }
                    continue
                }

                d.log(`  ${ticket.filename}: tests passed`)
            }
```

`writeFileSync`, `checkTicket`, `writeProgress`, `commitProgress`, `removeWorktree`, and `formatErrorMessage` are already imported or defined in this file.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: both new integration tests pass and the existing `runWavesIsolated` tests still pass (they omit `testCmd`, so the gate is skipped).

- [ ] **Step 8: Lint and commit**

Run: `npm run lint`

```bash
git add src/orchestrator.ts test/integration.test.ts
git commit -m "feat: run the test command in each worktree before merge"
```

---

### Task 5: CLI flag, timeout consistency, README

**Files:**
- Modify: `src/index.ts` -- yargs options near line 105; `runExecute` near lines 160, 204, 218, 235.
- Modify: `README.md` -- flags table (line 142), the notes list (lines 155-163), the "Create Issues" paragraph that says the CLI does the `tdd` part.

**Interfaces:**
- Consumes: `detectTestCmd` from Task 2; `testCmd` opts from Task 4.
- Produces: `nightralph <provider> --test-cmd <cmd>`. Omitted means auto-detect via `detectTestCmd(process.cwd())`. An empty string disables the gate.

- [ ] **Step 1: Add the option**

In `src/index.ts`, after the `timeout` option block, add:

```ts
            .option('test-cmd', {
                type:'string',
                describe:'Command run in each worktree ' +
                    'after the agent exits; non-zero ' +
                    'exit rejects the ticket. Defaults ' +
                    'to "npm test" when package.json ' +
                    'has a test script. Pass "" to ' +
                    'disable.',
            })
```

In the handler, pass it through:

```ts
                testCmd:argv.testCmd as string|undefined,
```

- [ ] **Step 2: Thread it through runExecute**

Import at the top of `src/index.ts`:

```ts
import { detectTestCmd } from './testcmd.js'
```

Add `testCmd?:string` to the `runExecute` argument type (near line 160).

Replace `const timeout = argv.timeout ?? 300` with `const timeout = argv.timeout ?? 900` so the fallback matches the yargs default.

Directly after that line add:

```ts
    const testCmd = argv.testCmd === undefined ?
        detectTestCmd(process.cwd()) :
        (argv.testCmd || null)
```

Add `testCmd,` to the `dryRunIsolated({ ... })` call and to the `runWavesIsolated({ ... })` call. Do not add it to the in-place `runWaves` call; that path runs agents in one shared directory and is out of scope.

- [ ] **Step 3: Build and smoke test the flag**

Run:

```bash
npm run build && node dist/index.js claude --dry-run --help
```

Expected: the help output lists `--test-cmd`.

Run, from this repo (which has a `test` script and a `.scratch` dir may not exist, so create a throwaway feature):

```bash
mkdir -p .scratch/smoke/issues
printf '# 01: smoke\n\n**Status:** ready-for-agent\n\n- [ ] one\n' \
    > .scratch/smoke/issues/01-smoke.md
printf '# smoke spec\n' > .scratch/smoke/spec.md
node dist/index.js claude --dry-run --spec smoke
node dist/index.js claude --dry-run --spec smoke --test-cmd ""
rm -rf .scratch/smoke
```

Expected: the first run prints `Test command: npm test` and the rendered prompt contains `npm test`. The second prints `Test command: (none)`.

- [ ] **Step 4: Update the README**

In the flags table, change the `--timeout` default from `300` to `900`, and add a row:

```
| `--test-cmd <cmd>` | no | auto | Run in each worktree after the agent exits; non-zero exit rejects the ticket. Auto-detects `npm test`. Pass `""` to disable |
```

Replace the note that begins `An agent run only counts as a success when the agent exits 0` with:

```
* An agent run only counts as a success when the agent exits 0,
  its worktree branch has new commits relative to the base branch,
  and the test command (see `--test-cmd`) exits 0 in that worktree.
  Uncommitted changes left by the agent are auto-committed before
  the check. On success, the ticket's status is updated to `done`
  in-place. If the agent exits 0 but made no commits, or the test
  command fails, the ticket is left `ready-for-agent` for a retry
  and the test output is written to `<dir>/../logs/<ticket>.test.log`.
  Failed tickets (non-zero exit) keep their status and block
  dependents.
```

Replace the sentence `The nightralph CLI does the tdd part of the workflow.` with:

```
The `nightralph` CLI does the `tdd` part of the workflow: the agent
prompt tells the agent to write a failing test per acceptance
criterion at the seams named in the spec's Testing Decisions, and
the orchestrator runs the project's test command in the worktree
before a ticket can be marked `done`.
```

Then run `npm run toc` so the table of contents stays current.

- [ ] **Step 5: Run everything and commit**

Run: `npm run lint && npm test`
Expected: clean.

```bash
git add src/index.ts README.md
git commit -m "feat: --test-cmd flag; document the test gate and real timeout default"
```

---

### Task 6: Tell to-tickets to include file paths for nightralph tickets

**Files:**
- Modify: `src/docs-templates/issue-tracker.md`
- Modify: `src/docs-templates/issue-tracker-github.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-facing. The ticket parser in `scanTickets` only reads `Status:` and `Blocked by:` lines, so an extra `Touches:` line is ignored by the orchestrator and read only by the agent.

- [ ] **Step 1: Add a section to the local template**

Append to `src/docs-templates/issue-tracker.md` (after the `When a skill says "fetch the relevant ticket"` section, which is now the last one after Task 1):

```markdown
## Tickets are executed within hours, not weeks

Tickets in this tracker are run by an autonomous agent shortly
after they are written, with a fixed time budget and no
interview. This changes one upstream rule:

- Do include the file paths, module names, and exported symbols
  the ticket touches. Put them on a `**Touches:**` line directly
  under `**Blocked by:**`. The "avoid specific file paths" guidance
  in `to-tickets` exists for long-lived human trackers and does not
  apply here.
- Keep the `- [ ]` acceptance criteria phrased as observable
  behavior. The agent writes one failing test per criterion, so
  each criterion should be testable at a seam named in the spec's
  Testing Decisions.
```

- [ ] **Step 2: Add the same guidance to the GitHub template**

Append the same section to `src/docs-templates/issue-tracker-github.md`, replacing the `**Touches:**` sentence with: put the list under a `## Touches` heading in the issue body.

- [ ] **Step 3: Confirm setup still installs the templates**

Run: `npm test`
Expected: `setup.test.ts` passes. It checks that template files are copied, not their content.

- [ ] **Step 4: Commit**

```bash
git add src/docs-templates
git commit -m "docs: ask to-tickets for file paths and testable criteria"
```

---

### Task 7: Drop the User Stories section from the agent's spec context

**Files:**
- Modify: `src/orchestrator.ts` -- add `stripSpecSection` next to `renderPrompt`.
- Modify: `src/index.ts` -- apply it where `specBody` is read (line 176).
- Test: `test/orchestrator.test.ts`.

**Interfaces:**
- Consumes: nothing.
- Produces: `stripSpecSection(specBody:string, heading:string):string` -- removes the markdown section whose heading text equals `heading` (any `#` level), through to the next heading of the same or higher level. Returns the input unchanged when the heading is absent.

This task is independent of Tasks 2 through 6. The spec on disk is untouched; only the copy prepended to prompts is trimmed.

- [ ] **Step 1: Write the failing tests**

Add to `test/orchestrator.test.ts` and add `stripSpecSection` to the import list from `../src/orchestrator.js`:

```ts
// -- stripSpecSection --

const SPEC = [
    '# Feature',
    '',
    '## Problem Statement',
    'p',
    '',
    '## User Stories',
    '1. As a user',
    '',
    '### Nested under stories',
    'still stories',
    '',
    '## Implementation Decisions',
    'keep me',
    '',
].join('\n')

test('stripSpecSection removes the section and nested ' +
    'subsections', t => {
    const out = stripSpecSection(SPEC, 'User Stories')
    t.ok(!out.includes('As a user'), 'body removed')
    t.ok(!out.includes('still stories'), 'nested removed')
    t.ok(out.includes('## Problem Statement'), 'before kept')
    t.ok(out.includes('keep me'), 'after kept')
})

test('stripSpecSection is a no-op when heading absent', t => {
    t.equal(
        stripSpecSection(SPEC, 'Out of Scope'),
        SPEC,
        'unchanged'
    )
})

test('stripSpecSection matches heading text at any level',
    t => {
        const out = stripSpecSection(
            SPEC, 'Nested under stories'
        )
        t.ok(!out.includes('still stories'), 'h3 removed')
        t.ok(
            out.includes('## Implementation Decisions'),
            'stops at the next h2'
        )
        t.ok(out.includes('As a user'), 'parent kept')
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: build error, `stripSpecSection` is not exported.

- [ ] **Step 3: Implement**

Add to `src/orchestrator.ts` directly above `renderPrompt`:

```ts
// Drops one markdown section from a spec. Used to keep the
// per-ticket prompt short: the User Stories list is useful
// to humans and to to-tickets but not to an implementing agent.
export function stripSpecSection (
    specBody:string,
    heading:string
):string {
    const out:string[] = []
    let skipping = false
    let skipLevel = 0

    for (const line of specBody.split('\n')) {
        const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
        if (m) {
            const level = m[1].length
            if (skipping && level <= skipLevel) {
                skipping = false
            }
            if (!skipping && m[2] === heading) {
                skipping = true
                skipLevel = level
                continue
            }
        }
        if (!skipping) out.push(line)
    }

    return out.join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: pass.

- [ ] **Step 5: Apply it in the CLI**

In `src/index.ts`, add `stripSpecSection` to the import from `./orchestrator.js`, and change

```ts
    const specBody = readFileSync(spec, 'utf8')
```

to

```ts
    const specBody = stripSpecSection(
        readFileSync(spec, 'utf8'),
        'User Stories'
    )
```

- [ ] **Step 6: Verify with a dry run, then commit**

Repeat the smoke steps from Task 5 Step 3 with a `spec.md` that has a `## User Stories` section. The printed prompt should not contain it.

Run: `npm run lint && npm test`

```bash
git add src/orchestrator.ts src/index.ts test/orchestrator.test.ts
git commit -m "feat: omit User Stories from the per-ticket spec context"
```

---

## Self-Review

Spec coverage: gap 1 and 2 map to Tasks 3, 4, 5; gap 3 to Task 5; gap 4 to Task 7; gap 5 to Task 6; gap 6 to Task 1. The two out-of-scope items are stated in the assessment.

Type consistency: `testCmd?:string|null` is used identically in `renderPrompt` opts, `runWavesIsolated` opts, and `dryRunIsolated` opts. `runExecute` receives `testCmd?:string` from yargs and converts to `string|null` before passing down. `TestResult` is `{ exitCode:number; output:string }` in Task 2 and consumed as such in Task 4.

Placeholders: none. Every code step contains the code.
