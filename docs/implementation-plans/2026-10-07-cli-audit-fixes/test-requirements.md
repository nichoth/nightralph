# Test requirements: CLI audit fixes

Design plan: `docs/design-plans/2026-10-07-cli-audit-fixes.md`

Implementation plan:
`docs/implementation-plans/2026-10-07-cli-audit-fixes/`
(`phase_01.md` to `phase_05.md`)

Date: 2026-10-07

This document maps every acceptance criterion in the design to the
test that proves it or, where a test is not possible or not wanted,
to a documented manual check. 18 criteria (AC1.1 to AC3.3) are
covered by automated tests. 6 criteria (AC4.1, AC4.2, AC5.1 to
AC5.4) are verified by hand.

Test types used below:

- **unit** -- calls one function in process; no git repo, no CLI
  subprocess.
- **integration** -- calls exported orchestrator or review functions
  in process against a real temporary git repo and a mock agent.
- **e2e** -- a CLI subprocess test: `spawnCli` runs the built
  `dist/index.js` against a temporary project, with a
  `test/mock-agent-*.js` script (or a deliberately missing name) as
  the provider.

## Automated tests

### cli-audit-fixes.AC1: A missing provider fails fast

| Criterion | Type | Test file | Phase/Task | What the test verifies |
| --- | --- | --- | --- | --- |
| **cli-audit-fixes.AC1.1 Success:** `resolveExecutable` returns the absolute path of a bare name found in a PATH entry; the first entry that has it wins. | unit | `test/preflight.test.ts` | Phase 1, Task 1 | Two temp dirs `a` and `b` each hold an executable `tool`. `resolveExecutable('tool', { path })` returns `join(a, 'tool')` for `path` `[a, b]` and `join(b, 'tool')` for `[b, a]`. `path` and `cwd` are always passed, so the real PATH is never consulted. |
| **cli-audit-fixes.AC1.2 Success:** `resolveExecutable` returns a `cmd` containing a path separator when that file exists and is executable, resolved against `cwd`. | unit | `test/preflight.test.ts` | Phase 1, Task 1 | `resolveExecutable('./tool', { cwd:a })` returns `join(a, 'tool')`; an absolute path to `a/tool` returns the same absolute path. |
| **cli-audit-fixes.AC1.3 Failure:** `resolveExecutable` returns `null` for a name in no PATH entry, a path that does not exist, and an existing file without execute permission. It never throws. | unit | `test/preflight.test.ts` | Phase 1, Task 1 | `null` for `'nosuch'`, for `join(a, 'missing')`, for `noexec` (mode `0o644`) and for `''`. A `path` entry that is a nonexistent directory does not throw and the lookup continues to the next entry. |
| **cli-audit-fixes.AC1.4 Success:** The CLI given a bare provider name that is not on PATH exits 2, stderr names the provider, no `nightralph--*` branch exists afterwards, and the current branch is unchanged. | e2e | `test/integration.test.ts` | Phase 1, Task 2 | `cliGitRepo()` on `main` with one committed ticket; `spawnCli(['nightralph-no-such-provider', '--spec', FEAT])`. Asserts `code === 2`, stderr includes `nightralph-no-such-provider`, `git branch --list 'nightralph--*'` prints nothing, and `git rev-parse --abbrev-ref HEAD` is still `main`. |
| **cli-audit-fixes.AC1.5 Success:** The CLI given an absolute path to a mock agent runs it as before. | e2e | `test/integration.test.ts` | Phase 1, Task 2 | Plain temp project (no git); `spawnCli([MOCK_AGENT, '--spec', FEAT, '--timeout', '10'])`. Asserts `code === 0` and `logs/01-task.log` exists, so an absolute path passes the preflight. Mirrors the existing `--model` test. |
| **cli-audit-fixes.AC1.6 Edge:** `--dry-run` with a provider not on PATH exits 0 and prints a `Provider:` line saying it was not found. | e2e | `test/integration.test.ts` | Phase 1, Task 2 | Plain temp project; `spawnCli(['nightralph-no-such-provider', '--spec', FEAT, '--dry-run'])`. Asserts `code === 0` and stdout includes `Provider:` and `not found`. |
| **cli-audit-fixes.AC1.7 Success:** When `spawnAgent` is given `onLine` and the spawn fails, the error text arrives through `onLine`, and the attempt resolves with exit code 1. | unit | `test/orchestrator.test.ts` | Phase 1, Task 3 | `spawnAgent` with `agentCmd` `join(tmpDir, 'nightralph-no-such-agent')` and an `onLine` collector. Asserts `exitCode === 1`, a collected line includes `ENOENT`, and `agent.log` exists and includes `ENOENT` (the handler resolves only after the log stream flushes). Placed next to the existing `spawnAgent` `onLine` tests. |

Notes:

- The new suite only runs because Phase 1, Task 1 also adds
  `preflight` to the `TESTS` array in `scripts/test.sh` and
  `src/preflight.ts` to the `build-esm` script in `package.json`.
- AC1.4 uses `cliGitRepo()`, never plain `initTempGitRepo()`, because
  the assertion that HEAD is still `main` depends on a branch name
  that does not follow the machine's `init.defaultBranch`.

### cli-audit-fixes.AC2: The test gate can be off

| Criterion | Type | Test file | Phase/Task | What the test verifies |
| --- | --- | --- | --- | --- |
| **cli-audit-fixes.AC2.1 Success:** `renderPrompt` with `testCmd:''` contains no test command and does not say the orchestrator runs tests after exit. `renderFixPrompt` behaves the same. | unit | `test/orchestrator.test.ts` (`renderPrompt`); `test/review.test.ts` (`renderFixPrompt`) | Phase 2, Task 1 | Renders the same input twice. `renderPrompt` with `testCmd:'npm run check'` includes `npm run check`; with `testCmd:''` it includes neither the command nor an empty code span (two consecutive backticks, which the old rule produced for `''`). `renderFixPrompt` with `'npm run t'` includes `npm run t`; with `''` it has no two consecutive backticks. Asserts on tokens, not on the rule's prose. |
| **cli-audit-fixes.AC2.2 Success:** `runWavesIsolated` with `testCmd:''` writes no `.test.log`, and a branch with new commits is merged. | integration | `test/integration.test.ts` | Phase 2, Task 2 | In-process `runWavesIsolated` (not `spawnCli`) on `initTempGitRepo({ templateDir })` with one ticket and `agentCmd:MOCK_PASS`, `testCmd:''`. Asserts `allDone === true`, the ticket status is `done`, `01-first.test.log` does not exist, and `git log --oneline` includes `mock agent change`. Placed next to the passing-gate test that uses `testCmd:'ls mock-agent-change-*.txt'`. |
| **cli-audit-fixes.AC2.3 Success:** The fixer with `testCmd:''` writes no `review-fix.test.log`, and its branch merges when it has commits. | integration | `test/review-pass.test.ts` | Phase 2, Task 2 | Copy of the `AC6.1 a green fix merges` test calling `runFixer(passOpts(repoRoot, { testCmd:'' }), { spawnAgent }, FINDINGS)`. Asserts `result.merged === true`, `fix.ts` exists on the base branch, and no `review-fix*.test.log` exists in the logs dir `passOpts` sets. |
| **cli-audit-fixes.AC2.4 Success:** `nightralph <agent> --test-cmd ""` on a project whose `package.json` has no `test` script completes the ticket and merges it. | e2e | `test/integration.test.ts` | Phase 2, Task 4 | `cliGitRepo()` with a committed `package.json` that has no `scripts`; one ticket; `MOCK_AGENT` with `--test-cmd ""`, `--no-review`, `--retries 0`, `--install-cmd ""`, `--timeout 30`. Asserts `code === 0`, `git log` on HEAD (the integration branch) includes `mock agent change`, and no `*.test.log` exists in the logs dir. |
| **cli-audit-fixes.AC2.5 Success:** The same project with no `--test-cmd` flag completes the ticket, and stdout contains the no-test-command warning once. | e2e | `test/integration.test.ts` | Phase 2, Task 4 | Fresh `cliGitRepo()` with the same no-`test` `package.json`, no `--test-cmd`. Asserts `code === 0`, `git log` includes `mock agent change`, and `No test command detected` occurs exactly once in stdout (`split(...).length - 1 === 1`). |
| **cli-audit-fixes.AC2.6 Success:** A project with a `test` script and no flag still runs `npm test` as the gate. | e2e | `test/integration.test.ts` | Phase 2, Task 4 | `package.json` with `"scripts":{"test":"exit 7"}`, no flag. Asserts `code !== 0`, stdout has no `No test command detected`, `01-task.test.log` exists, and `git log` does not include `mock agent change`: the detected `npm test` ran and rejected the ticket. |
| **cli-audit-fixes.AC2.7 Success:** `--dry-run` with `--test-cmd ""` prints `Test command: (none)` in both the isolated and the in-place printers. | unit | `test/orchestrator.test.ts` | Phase 2, Task 3 | With `console.log` captured (and restored in `finally`): `dryRunIsolated` with `testCmd:''` prints `Test command: (none)` and with `testCmd:'npm test'` prints `Test command: npm test`; `dryRun(tickets, 'spec', '')` prints `Test command: (none)`. Placed next to the existing `dryRunIsolated` tests. |
| **cli-audit-fixes.AC2.7** (CLI half) | e2e | `test/integration.test.ts` | Phase 2, Task 4 | `spawnCli([MOCK_AGENT, '--spec', FEAT, '--dry-run', '--test-cmd', ''])` in a plain temp project (in-place printer) and again in a `cliGitRepo()` project (isolated printer). Each stdout includes `Test command: (none)`, proving the flag's `''` reaches both printers. |
| **cli-audit-fixes.AC2.8 Edge:** An explicit `--test-cmd ""` on a project with a `test` script runs no gate and prints no detection warning. | e2e | `test/integration.test.ts` | Phase 2, Task 4 | The `exit 7` project with `--test-cmd ""`. Asserts `code === 0`, `git log` includes `mock agent change`, no `*.test.log` exists, and stdout has no `No test command detected`. |

Notes:

- AC2.3 lives in `test/review-pass.test.ts`, not in
  `test/review.test.ts` as the design's Phase 2 component list says.
  The `runFixer` tests and the `passOpts` helper are in
  `review-pass.test.ts`; `review.test.ts` holds the pure
  `renderFixPrompt` tests and gets only the `renderFixPrompt` half
  of AC2.1.
- AC2.2 sits in `test/integration.test.ts` but calls
  `runWavesIsolated` in process, so it is an integration test, not a
  CLI subprocess test.
- AC2.7 is covered twice on purpose: the unit tests pin each
  printer's output for `''` and for a real command, and the CLI test
  proves `--test-cmd ""` survives argument parsing (`??`, not `||`)
  and reaches both printers.
- AC2.5, AC2.6 and AC2.8 together pin the selection rule in
  `src/index.ts`: flag when given (including `""`), else
  `detectTestCmd`, else `''` with one warning.
- The in-place `runWaves` has never run a test gate and Phase 2 does
  not add one, so no test asserts a gate for in-place runs.

### cli-audit-fixes.AC3: Errors end in one line

| Criterion | Type | Test file | Phase/Task | What the test verifies |
| --- | --- | --- | --- | --- |
| **cli-audit-fixes.AC3.1 Success:** A dirty tree when launched from a non-default branch exits 2; stderr contains the dirty-tree message and contains neither `Options:` nor a line starting with `    at `. | e2e | `test/integration.test.ts` | Phase 3, Task 1 | `cliGitRepo()`, `git checkout -b feature`, one committed ticket, then an uncommitted line appended to the spec. `spawnCli([MOCK_AGENT, '--spec', FEAT, '--no-review'])`. Asserts `code === 2`, stderr includes `Working tree is dirty`, neither stderr nor stdout includes `Options:`, and no stderr line starts with four spaces and `at `. |
| **cli-audit-fixes.AC3.2 Success:** A usage error, such as no arguments, still prints help and exits 1. | e2e | `test/integration.test.ts` | Phase 3, Task 1 | `spawnCli([])` in an empty temp dir. Asserts `code === 1` and stderr includes `Options:`. The message is not asserted: with no arguments yargs's own positional check fires before `demandCommand`. |
| **cli-audit-fixes.AC3.3 Success:** Closing the feature prompt without a TTY exits 2 with one line and no stack trace. | e2e | `test/integration.test.ts` | Phase 3, Task 1 | Plain temp project with two features (`test-feat` plus a hand-made `.scratch/other/issues/` with `spec.md` and one ticket), no `--spec`, so the CLI opens the feature checkbox. `spawnCli([MOCK_AGENT], { closeStdin:true })`. Asserts `code === 2`, `stderr.trim().split('\n').length === 1`, and no stderr line starts with `    at `. |

Notes:

- AC3.3 needs a test-helper change in the same task: `spawnCli`
  gains a `closeStdin` option that calls `child.stdin?.end()`.
  `execFile` leaves the child's stdin pipe open, and an inquirer
  prompt would wait on it forever instead of throwing
  `ExitPromptError`. Existing callers are unaffected.
- AC3.1 launches from a non-default branch because that is the path
  where the dirty-tree throw comes from `runWavesIsolated` and
  reaches yargs uncaught. From the default branch the check in
  `prepareIntegrationBranch` is already caught in `src/index.ts`.

## Human verification

### cli-audit-fixes.AC4.1

**Criterion:** **cli-audit-fixes.AC4.1 Success:** `npm publish
--dry-run` runs `npm run build` and `npm test` before listing the
tarball.

**Justification:** Phase 4 is infrastructure: one `prepublishOnly`
entry in `package.json`. The phase file marks its only task
"Verifies: None" and checks the criterion operationally. An
automated test would have to run `npm publish`, which talks to the
registry and would run the whole test suite from inside the test
suite.

**Approach** (Phase 4, Task 1, Step 2):

Run: `npm publish --dry-run; echo "exit=$?"`

Expected: the output shows the `prepublishOnly` script running, the
esbuild build lines, every test suite passing, and then the
`Tarball Contents` listing. Nothing is published.

After the listing npm prints `You cannot publish over the previously
published versions` and exits non-zero, because the version in
`package.json` is already on the registry. That error is expected
here and is not a failure of this step. The check that matters is
the order: build, then tests, then the tarball listing. Do not pass
`--force` or bump the version to silence it.

### cli-audit-fixes.AC4.2

**Criterion:** **cli-audit-fixes.AC4.2 Failure:** With a
deliberately failing test, `npm publish --dry-run` exits non-zero
and publishes nothing.

**Justification:** Same as AC4.1. The check also needs a test that
fails on purpose, which cannot be committed to the suite.

**Approach** (Phase 4, Task 1, Step 3):

Make one test fail on purpose: add `t.ok(false, 'temporary')` to
any test in `test/retry.test.ts`.

Run: `npm publish --dry-run; echo "exit=$?"`

Expected: the test run stops at the failing suite, `npm` prints an
error block naming the `prepublishOnly` script, no `Tarball
Contents` listing is printed, and the exit code is non-zero. The
absence of the listing is what distinguishes this from AC4.1.

Revert the temporary change: `git checkout -- test/retry.test.ts`.

### cli-audit-fixes.AC5.1

**Criterion:** **cli-audit-fixes.AC5.1:** README Install lists Node,
git, the provider CLI on PATH, and macOS or Linux as requirements.

**Justification:** Documentation. The project rules say not to write
tests for docs and not to test for specific text content, and Phase
5 states its criteria "are verified by reading, not by automated
tests".

**Approach** (Phase 5, Task 1, Step 5): Run `npm run lint` (no
errors; it confirms nothing outside the docs changed). Read the new
`### Requirements` section under `## Install` against the code: Node
24 or newer matches `engines` in `package.json`; the exit code
stated for a missing provider is the one `src/index.ts` uses (2);
the Windows exclusion reason (process groups, `sh -c`) matches
`spawnAgent` and `runTestCmd`. Confirm `npm run toc` was run and the
table of contents lists the new heading.

### cli-audit-fixes.AC5.2

**Criterion:** **cli-audit-fixes.AC5.2:** README Worktrees states
worktrees are sibling directories named `<repo>.<num>-<slug>` and
that an interrupted run leaves them.

**Justification:** Documentation, as for AC5.1. The phase file also
supersedes the design's wording: the CLI always passes the feature
name to `scanTickets`, so every CLI run creates the feature form.
The README therefore documents `<repo>.<feature>-<num>-<slug>` on
branch `<repo>--<feature>-<num>-<slug>`, and the reviewer checks
for that form, not `<repo>.<num>-<slug>`.

**Approach** (Phase 5, Task 1, Step 5): Read the new paragraph in
`### Worktrees` against `createWorktree` (`src/worktree.ts:315-340`)
and `buildBranchName` (`src/worktree.ts:221-230`): sibling
directory, feature-form directory and branch names, and that an
interrupted run leaves them for the next run to remove before
creating a new one. Check the README against what `createWorktree`
creates, not against `--dry-run` output: `dryRunIsolated` still
prints `<repo>.<feature>.<num>-<slug>`, a known pre-existing
mismatch left for a follow-up ticket.

### cli-audit-fixes.AC5.3

**Criterion:** **cli-audit-fixes.AC5.3:** The README `--test-cmd`
row describes detection, the no-gate fallback and `""`.

**Justification:** Documentation, as for AC5.1.

**Approach** (Phase 5, Task 1, Step 5): Read the `--test-cmd` row in
the Interface table and the two gate sentences (Workflow, and How
It Works) against `src/index.ts` after Phase 2: `npm test` when
`package.json` has a `test` script; no gate, announced once at
startup, when nothing is detected; `""` runs without a gate; and the
gate sentences say "when there is one". The row stays on one line
like its neighbors.

### cli-audit-fixes.AC5.4

**Criterion:** **cli-audit-fixes.AC5.4:** AGENTS.md contains the
`src/preflight.ts` contract, the `''` meaning of `testCmd` on every
function that takes it, and the `.fail()` and `prepublishOnly`
entries.

**Justification:** Documentation, as for AC5.1.

**Approach** (Phase 5, Task 2, Step 6): Read each changed bullet
against the code it describes: `src/preflight.ts`, `src/index.ts`
(preflight block, test command block, `.fail()`),
`src/orchestrator.ts` (`spawnAgent` error handler, `runTestGate`,
both dry-run printers), `src/rules.ts`, `src/review.ts` (fixer
gate), `package.json`. Every sentence must be true of the code. Run
`npm run lint`; expect no errors.

Entries to find: a `### preflight module (src/preflight.ts)`
section; `src/preflight.ts` (and `src/resolve.ts`) under Project
Structure; the `prepublishOnly` bullet and the corrected `npm test`
bullet (it does not rebuild `dist/`) under Commands; the CLI
`--test-cmd`, Provider preflight and Errors (`.fail()`) bullets; the
`''` meaning on `renderPrompt`, `runWaves`, `runWavesIsolated`,
`dryRun`, `dryRunIsolated`, `testGateRule`, `renderFixPrompt`,
`runFixer` and `runReviewPass`; the `spawnAgent` spawn-error
sentence; and a refreshed `Last verified` date.

## Test files by phase

### Phase 1: Provider preflight

- Create `test/preflight.test.ts` -- AC1.1, AC1.2, AC1.3 (Task 1).
- Modify `test/integration.test.ts` -- AC1.4, AC1.5, AC1.6 (Task 2).
- Modify `test/orchestrator.test.ts` -- AC1.7 (Task 3).
- Modify `scripts/test.sh` -- add `preflight` to the `TESTS` array
  (Task 1). Not a test file, but the new suite does not run without
  it; `package.json` `build-esm` also gains `src/preflight.ts`.

### Phase 2: Test gate off

- Modify `test/orchestrator.test.ts` -- AC2.1 `renderPrompt`
  (Task 1), AC2.7 printers (Task 3).
- Modify `test/review.test.ts` -- AC2.1 `renderFixPrompt` (Task 1).
- Modify `test/review-pass.test.ts` -- AC2.3 (Task 2).
- Modify `test/integration.test.ts` -- AC2.2 in process (Task 2);
  AC2.4, AC2.5, AC2.6, AC2.7 CLI half, AC2.8 (Task 4).

### Phase 3: Error reporting

- Modify `test/integration.test.ts` -- `spawnCli` gains the
  `closeStdin` option; AC3.1, AC3.2, AC3.3 (Task 1).

### Phase 4: Publish safety

- No test files. `test/retry.test.ts` is edited temporarily during
  the AC4.2 check and reverted with `git checkout`; the change is
  never committed.

### Phase 5: Documentation

- No test files. Docs are verified by reading.

## Project testing rules

1. Runner: `@substrate-system/tapzero`. `npm test` runs
   `scripts/test.sh`, which bundles each suite named in its `TESTS`
   array, gives the run a private `TMPDIR` and deletes it (plus any
   `mock-change-*.txt` in the repo root) when the run ends, pass or
   fail. A new suite must be added to `TESTS`. Tests import
   `{ test }`, are named `'<module> - <behavior>'`, and use `t.ok`,
   `t.equal` or `t.deepEqual` with a message as the last argument.
2. Build first. `npm test` does not build, and the CLI tests run
   `dist/index.js` through `spawnCli`, so run `npm run build` before
   them (`npm run build && npm test`). To iterate on one suite:
   `npm run build && bash -c 'esbuild test/<name>.test.ts
   --format=esm --bundle --packages=external --outdir=dist/test
   --sourcemap && node dist/test/<name>.test.js'`. Run `npm test` in
   full before each commit.
3. No prose assertions. Assert on the one token that matters: an
   exit code, a path, a provider name, a command string, a file that
   exists or does not, a commit subject. Fixed strings that are the
   criterion itself (`Test command: (none)`, `Provider:`) are fine;
   AC3.2 deliberately does not assert yargs's message text, and
   AC2.1 checks for the command and an empty code span rather than
   the rule's wording.
4. Temp dirs come from `mkdtempSync(join(tmpdir(), 'nightralph-...'))`
   and are removed in `finally`. CLI git tests also remove sibling
   worktrees (`removeWorktreesAndRepo`) and the template dir.
5. Hermetic git. CLI tests build repos with `cliGitRepo()` (a
   `git init --template` repo with an empty template dir, on branch
   `main`, with `.scratch/*/logs/` ignored and the `test-feat`
   layout). In-process tests use `initTempGitRepo({ templateDir })`.
   Never use plain `initTempGitRepo()` in a CLI test (its branch
   follows `init.defaultBranch`), and never write `info/exclude`,
   which can be a symlink shared by every repo on the machine.
6. `npm run lint` must pass after every phase.
