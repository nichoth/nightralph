# CLI audit fixes implementation plan -- phase 2

**Goal:** `--test-cmd ""` and an undetectable test command both run
without a test gate, and the agent prompt stops promising one.

**Architecture:** `testCmd` stays a `string` everywhere; the empty
string means "no gate". `src/index.ts` computes it as the flag value
when given, else the detected command, else `''`, and drops the
`'npm test'` fallback. Three consumers honor `''`: `testGateRule` in
`src/rules.ts` (shorter rule, no command), `runTestGate` in
`src/orchestrator.ts` (returns true without spawning or writing a
log), and the fixer's gate in `src/review.ts`. Both dry-run printers
show `(none)`.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild, tapzero tests
run by `scripts/test.sh`.

**Scope:** Phase 2 of 5 from
`docs/design-plans/2026-10-07-cli-audit-fixes.md`.

**Codebase verified:** 2026-10-07

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cli-audit-fixes.AC2: The test gate can be off
- **cli-audit-fixes.AC2.1 Success:** `renderPrompt` with
  `testCmd:''` contains no test command and does not say the
  orchestrator runs tests after exit. `renderFixPrompt` behaves the
  same.
- **cli-audit-fixes.AC2.2 Success:** `runWavesIsolated` with
  `testCmd:''` writes no `.test.log`, and a branch with new commits
  is merged.
- **cli-audit-fixes.AC2.3 Success:** The fixer with `testCmd:''`
  writes no `review-fix.test.log`, and its branch merges when it
  has commits.
- **cli-audit-fixes.AC2.4 Success:** `nightralph <agent> --test-cmd
  ""` on a project whose `package.json` has no `test` script
  completes the ticket and merges it.
- **cli-audit-fixes.AC2.5 Success:** The same project with no
  `--test-cmd` flag completes the ticket, and stdout contains the
  no-test-command warning once.
- **cli-audit-fixes.AC2.6 Success:** A project with a `test` script
  and no flag still runs `npm test` as the gate.
- **cli-audit-fixes.AC2.7 Success:** `--dry-run` with `--test-cmd
  ""` prints `Test command: (none)` in both the isolated and the
  in-place printers.
- **cli-audit-fixes.AC2.8 Edge:** An explicit `--test-cmd ""` on a
  project with a `test` script runs no gate and prints no detection
  warning.

---

## Project conventions the executor must follow

Same as phase 1: read `/Users/nick/code/nightralph/AGENTS.md`;
4-space indent, single quotes, no semicolons, `name:type` with no
space, 80 columns, `.js` import suffixes, tapzero tests with
`t.ok` / `t.equal`, temp dirs removed in `finally`, no em dashes.
`npm run build` before CLI subprocess tests; `npm test` before each
commit.

**Pre-existing behavior to leave alone:** the in-place `runWaves`
(`src/orchestrator.ts:2220` onward) has never had a test gate; only
`runWavesIsolated` and the fixer run one. Do not add a gate to
`runWaves` in this phase. The in-place prompt still names a
non-empty `testCmd` as a gate the orchestrator runs; that remains
false for in-place runs and is a follow-up, not part of this phase.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `testGateRule` for an empty command

**Verifies:** cli-audit-fixes.AC2.1

**Files:**
- Modify: `src/rules.ts:30-39` (`testGateRule`)
- Test: `test/orchestrator.test.ts` (unit, next to the `renderPrompt`
  tests at lines 1558-1700) and `test/review.test.ts` (unit, next to
  the `renderFixPrompt` tests at lines 248-265)

**Implementation:**

Replace `testGateRule` with a version that branches on `''`:

```ts
export function testGateRule (testCmd:string, subject:string):string {
    if (testCmd === '') {
        return '- Before each commit, run the tests relevant ' +
            'to what you changed. Do not commit with failing ' +
            'tests. The orchestrator runs no test command ' +
            `for this ${subject}.`
    }
    return '- While iterating, run only the tests ' +
        'relevant to what you changed. Run ' +
        `\`${testCmd}\` in full once, as the ` +
        'final gate before your last commit. Do ' +
        'not commit with failing tests. The ' +
        'orchestrator runs the same command after ' +
        `you exit and rejects the ${subject} if it ` +
        'fails.'
}
```

The non-empty branch is byte-for-byte the current text, so the
existing prompt tests keep passing. Both callers
(`src/orchestrator.ts:560` in `renderPrompt`, `src/review.ts:185` in
`renderFixPrompt`) need no change.

**Testing:**

Assert on tokens, not prose: the command string, and the empty
code span `` ` ` `` (two backticks with nothing between them) that
the current rule produces for `''`.

- cli-audit-fixes.AC2.1 (`renderPrompt`): render with
  `{ testCmd:'npm run check' }` and with `{ testCmd:'' }` for the
  same ticket. Assert the first includes `npm run check`, and the
  second includes neither `npm run check` nor the two-character
  string of two backticks. Follow the shape of the existing test at
  `test/orchestrator.test.ts:1650` that asserts `'npm run check'`.
- cli-audit-fixes.AC2.1 (`renderFixPrompt`): same pair of renders
  through `renderFixPrompt({ specBody, findings, testCmd:'' })` next
  to the test at `test/review.test.ts:248`; assert the `''` render
  does not include two consecutive backticks, and the `'npm run t'`
  render still includes `npm run t`.

**Verification:**

Run: `npm test`
Expected: all suites pass.

**Commit:** `feat(rules): no test gate sentence for an empty test
command`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Skip the gate in the orchestrator and the fixer

**Verifies:** cli-audit-fixes.AC2.2, cli-audit-fixes.AC2.3

**Files:**
- Modify: `src/orchestrator.ts:1371-1404` (`runTestGate`)
- Modify: `src/review.ts:733-740` (the fixer's test gate in
  `runFixer`)
- Test: `test/integration.test.ts` (next to the passing-gate test
  that uses `testCmd:'ls mock-agent-change-*.txt'` around line 960)
  and `test/review-pass.test.ts` (next to the `runFixer` tests
  around lines 215-300)

**Implementation:**

In `runTestGate`, add a short circuit as the first statement of the
body, before `runTestCmd` is called:

```ts
    if (opts.testCmd === '') {
        opts.log(`  ${opts.ticket.filename}: no test gate`)
        return true
    }
```

Both call sites (`src/orchestrator.ts:1493` in
`respawnAndRetryMerge` and `:1834` in `runTicketAttempts`) then
proceed as if the suite were green. No `.test.log` is written.

In `runFixer`, wrap the gate so `runStep` is not called for `''`.
Change lines 733-740 from

```ts
            if (!(await runStep(
                opts, deps, opts.testCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt, '.test.log'
                )
            ))) {
                return fail('tests', agent.exitCode, notes)
            }
```

to

```ts
            if (opts.testCmd !== '' && !(await runStep(
                opts, deps, opts.testCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt, '.test.log'
                )
            ))) {
                return fail('tests', agent.exitCode, notes)
            }
```

Leave the install `runStep` calls (lines 588 and 685) untouched;
`installCmd` already has its own optional handling.

**Testing:**

- cli-audit-fixes.AC2.2: copy the passing-gate `runWavesIsolated`
  test shape (temp git repo from `initTempGitRepo({ templateDir })`
  with a `mkdtempSync` template dir removed in `finally`, one
  ticket, `commitAll`, `process.chdir`, `agentCmd:MOCK_PASS`), but
  pass
  `testCmd:''`. Assert `result.allDone === true`, the ticket status
  is `done`, `join(logsDir, '01-first.test.log')` does NOT exist,
  and `git log --oneline` in the repo includes `mock agent change`.
  Clean up worktrees and the repo in `finally` the way the
  neighboring tests do.
- cli-audit-fixes.AC2.3: in `test/review-pass.test.ts`, copy the
  `AC6.1 a green fix merges` test and call `runFixer(passOpts(
  repoRoot, { testCmd:'' }), { spawnAgent:agent.spawnAgent },
  FINDINGS)`. Assert `result.merged === true`, `fix.ts` exists on
  the base branch, and no file matching `review-fix*.test.log`
  exists in the logs dir that `passOpts` sets.

**Verification:**

Run: `npm test`
Expected: all suites pass.

**Commit:** `feat(orchestrator): an empty test command skips the
gate`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Dry-run printers show `(none)`

**Verifies:** cli-audit-fixes.AC2.7 (the printers; the CLI test is in
Task 4)

**Files:**
- Modify: `src/orchestrator.ts:1306-1308` (`dryRunIsolated`'s
  `Test command:` line)
- Modify: `src/orchestrator.ts:1204-1238` (in-place `dryRun`)
- Test: `test/orchestrator.test.ts` (unit; find the existing
  `dryRunIsolated` tests by searching for `dryRunIsolated(` and add
  next to them)

**Implementation:**

In `dryRunIsolated`, change the line to

```ts
    console.log(
        `\nTest command: ${opts.testCmd || '(none)'}`
    )
```

which matches the neighboring `Install:      ${opts.installCmd ||
'(none)'}` on line 1310.

In the in-place `dryRun`, the test command is never printed today.
Add, after the deadlock block and before `const firstReady = ...`
(around line 1228):

```ts
    console.log(`\nTest command: ${testCmd || '(none)'}`)
```

**Testing:**

Capture `console.log` the way the existing `dryRunIsolated` tests
do (look at how they collect output; if they do not, temporarily
replace `console.log` with a collector and restore it in `finally`).

- cli-audit-fixes.AC2.7 (`dryRunIsolated`): call with `testCmd:''`
  and assert the joined output includes `Test command: (none)`; call
  with `testCmd:'npm test'` and assert it includes `Test command:
  npm test`.
- cli-audit-fixes.AC2.7 (`dryRun`): call `dryRun(tickets, 'spec',
  '')` and assert the output includes `Test command: (none)`.

**Verification:**

Run: `npm test`
Expected: all suites pass.

**Commit:** `feat(orchestrator): dry run prints (none) for no test
command`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: CLI selects the test command without a fallback

**Verifies:** cli-audit-fixes.AC2.4, cli-audit-fixes.AC2.5,
cli-audit-fixes.AC2.6, cli-audit-fixes.AC2.7, cli-audit-fixes.AC2.8

**Files:**
- Modify: `src/index.ts:129-135` (the `--test-cmd` option's
  `describe`)
- Modify: `src/index.ts:459-463` (the `testCmd` computation)
- Test: `test/integration.test.ts` (CLI subprocess tests)

**Implementation:**

Update the help text first. Lines 129-135 declare the option with
`describe:'... Defaults to "npm test".'`. Replace the `describe`
value with:

```ts
                describe:'Command run in each worktree ' +
                    'after the agent exits; non-zero ' +
                    'exit rejects the ticket. Defaults ' +
                    'to "npm test" when package.json has ' +
                    'a test script; otherwise the run ' +
                    'has no test gate. "" disables it.',
```

Today line 459-463 reads
`argv.testCmd || detectTestCmd(...) || 'npm test'`, so `""` falls
through to detection and a project without a `test` script gets a
command that always fails. Replace those lines with:

```ts
    const testCmd = argv.testCmd ?? detectTestCmd(
        isolated ?
            getRepoRoot() :
            process.cwd()
    ) ?? ''
    if (argv.testCmd === undefined && testCmd === '') {
        console.log(
            'No test command detected; running without a ' +
            'test gate. Pass --test-cmd to add one.'
        )
    }
```

`argv.testCmd` is `undefined` when the flag is absent and `''` when
given as `""`, so `??` keeps the explicit empty string. The warning
prints only when nothing was given and nothing was detected. It
prints before the display starts, so it is not repainted over, and
it also prints under `--dry-run`.

**Testing:**

CLI subprocess tests in `test/integration.test.ts`. "A project with
no `test` script" means `writeFileSync(join(projectDir,
'package.json'), '{"name":"p","private":true}\n')` committed in the
temp git repo. Build every git fixture with `cliGitRepo()` (line
4840; returns `{ projectDir, issuesDir, templateDir }`, a hermetic
repo on `main` with the `test-feat` layout), never plain
`initTempGitRepo()`. Write one ticket `01-task.md`, `commitAll(
projectDir, 'add tickets')`, and run with `MOCK_AGENT` as the
provider plus `--no-review`, `--retries 0`, `--install-cmd ""` and
`--timeout 30` to keep the run short. Read `git log --oneline` from
the repo after the run (`gitOut`, line 4386); the integration branch
is checked out, so the merge is visible on HEAD. In `finally`
remove sibling worktrees and the repo (`removeWorktreesAndRepo`,
line 2220) and `templateDir`. The logs dir is `join(projectDir,
'.scratch', FEAT, 'logs')`.

- cli-audit-fixes.AC2.4: run with `--test-cmd ""`. Assert `code ===
  0`, `git log` includes `mock agent change`, and no `*.test.log`
  exists in the logs dir.
- cli-audit-fixes.AC2.5: a fresh `cliGitRepo()` project with the
  same no-`test`-script `package.json`, no `--test-cmd`. Assert
  `code === 0`, `git log` includes `mock agent change`, and `stdout`
  contains `No test command detected` exactly once (`split(...)
  .length - 1 === 1`).
- cli-audit-fixes.AC2.6: a project whose `package.json` is
  `{"name":"p","private":true,"scripts":{"test":"exit 7"}}`, no
  flag. Assert `code !== 0`, `stdout` does not contain `No test
  command detected`, `join(logsDir, '01-task.test.log')` exists,
  and `git log` does not include `mock agent change`.
- cli-audit-fixes.AC2.7: in a plain temp project (no git), run
  `spawnCli([MOCK_AGENT, '--spec', FEAT, '--dry-run', '--test-cmd',
  ''], { cwd:projectDir })`. Assert `stdout` includes `Test command:
  (none)`. Repeat in a `cliGitRepo()` project to cover the isolated
  printer.
- cli-audit-fixes.AC2.8: the `exit 7` project with `--test-cmd ""`.
  Assert `code === 0`, `git log` includes `mock agent change`, no
  `*.test.log` exists, and `stdout` does not contain `No test
  command detected`.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

**Commit:** `fix(cli): --test-cmd "" disables the gate; no npm test
fallback`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
