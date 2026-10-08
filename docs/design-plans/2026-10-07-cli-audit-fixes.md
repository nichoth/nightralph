# CLI audit fixes design

## Summary

This design fixes five rough edges at the boundaries of the
nightralph CLI, which runs one coding agent per ticket in its own
git worktree and merges the results. An audit of the built tool
found that a mistyped agent name only failed after the tool had
already created and checked out a git branch, that projects with no
test script failed every ticket, that runtime errors printed help
text or stack traces, that `npm publish` could ship a stale build,
and that the README left out what the tool needs to run. None of the
fixes changes how tickets are scheduled, run or merged.

The approach is small and local. A new pure function checks that the
agent executable exists before any git state changes. The existing
"empty string disables it" convention from `--install-cmd` is reused
for the test gate; the empty string is chosen over an optional type
because the test command is a required parameter at about twenty
call sites. A top-level error handler separates usage mistakes,
which still show help and exit 1, from thrown runtime errors, which
print one line and exit 2. A publish hook builds and tests before
anything ships. The work is five independent phases, with the
documentation phase last so it describes the final behavior. Each
behavioral phase is verified by tests that run the built CLI as a
subprocess against a temporary project.

## Definition of Done

1. A provider that cannot be found is reported once, in one line,
   before any branch or worktree is created, and the run exits 2.
   An agent spawn error that happens anyway reaches the status
   display, not only the console it repaints over.
2. `--test-cmd ""` turns the test gate off, the way
   `--install-cmd ""` already turns the install off. A project
   with no detectable test command also runs without a gate and
   says so at startup. The agent prompt no longer promises a gate
   that will not run.
3. An error thrown while a run is in progress (a dirty tree, a
   failed git call, a closed prompt) prints one line to stderr and
   exits 2. No help text, no stack trace.
4. `npm publish` cannot ship a stale `dist/`: the build and the
   test suite run as part of publishing.
5. The README Install section states what the tool needs (Node,
   git, the provider CLI on PATH, a Unix-like OS), that worktrees
   are created next to the repo, and how the test gate is chosen
   and disabled. AGENTS.md contracts match the code.

## Acceptance Criteria

### cli-audit-fixes.AC1: A missing provider fails fast
- **cli-audit-fixes.AC1.1 Success:** `resolveExecutable` returns
  the absolute path of a bare name found in a PATH entry; the first
  entry that has it wins.
- **cli-audit-fixes.AC1.2 Success:** `resolveExecutable` returns a
  `cmd` containing a path separator when that file exists and is
  executable, resolved against `cwd`.
- **cli-audit-fixes.AC1.3 Failure:** `resolveExecutable` returns
  `null` for a name in no PATH entry, a path that does not exist,
  and an existing file without execute permission. It never throws.
- **cli-audit-fixes.AC1.4 Success:** The CLI given a bare provider
  name that is not on PATH exits 2, stderr names the provider, no
  `nightralph--*` branch exists afterwards, and the current branch
  is unchanged.
- **cli-audit-fixes.AC1.5 Success:** The CLI given an absolute path
  to a mock agent runs it as before.
- **cli-audit-fixes.AC1.6 Edge:** `--dry-run` with a provider not on
  PATH exits 0 and prints a `Provider:` line saying it was not
  found.
- **cli-audit-fixes.AC1.7 Success:** When `spawnAgent` is given
  `onLine` and the spawn fails, the error text arrives through
  `onLine`, and the attempt resolves with exit code 1.

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

### cli-audit-fixes.AC3: Errors end in one line
- **cli-audit-fixes.AC3.1 Success:** A dirty tree when launched
  from a non-default branch exits 2; stderr contains the dirty-tree
  message and contains neither `Options:` nor a line starting with
  `    at `.
- **cli-audit-fixes.AC3.2 Success:** A usage error, such as no
  arguments, still prints help and exits 1.
- **cli-audit-fixes.AC3.3 Success:** Closing the feature prompt
  without a TTY exits 2 with one line and no stack trace.

### cli-audit-fixes.AC4: Publishing builds first
- **cli-audit-fixes.AC4.1 Success:** `npm publish --dry-run` runs
  `npm run build` and `npm test` before listing the tarball.
- **cli-audit-fixes.AC4.2 Failure:** With a deliberately failing
  test, `npm publish --dry-run` exits non-zero and publishes
  nothing.

### cli-audit-fixes.AC5: Docs match
- **cli-audit-fixes.AC5.1:** README Install lists Node, git, the
  provider CLI on PATH, and macOS or Linux as requirements.
- **cli-audit-fixes.AC5.2:** README Worktrees states worktrees are
  sibling directories named `<repo>.<num>-<slug>` and that an
  interrupted run leaves them.
- **cli-audit-fixes.AC5.3:** The README `--test-cmd` row describes
  detection, the no-gate fallback and `""`.
- **cli-audit-fixes.AC5.4:** AGENTS.md contains the
  `src/preflight.ts` contract, the `''` meaning of `testCmd` on
  every function that takes it, and the `.fail()` and
  `prepublishOnly` entries.

## Glossary

- **Ticket**: A unit of agent work, stored as a markdown file with a
  status and a checklist. The orchestrator runs one agent session
  per ticket.
- **Provider**: The agent command-line program that does the work
  (`claude`, `codex` or `pi`). It is the CLI's first argument.
- **Wave**: A batch of tickets with no unfinished blockers that run
  in parallel. A wave finishes fully before its branches merge.
- **Worktree**: A separate git working directory for a branch.
  nightralph creates one per ticket as a sibling directory of the
  repo, named `<repo>.<num>-<slug>`.
- **Integration branch**: `nightralph--<feature>` (or
  `nightralph--all`), created when a run is launched from the
  default branch. Ticket branches merge into it.
- **Test gate**: After an agent exits, the orchestrator runs the
  test command in the ticket's worktree. A non-zero exit rejects the
  ticket.
- **Test command (`testCmd`)**: The shell command used as the test
  gate, from `--test-cmd` or detected from `package.json`. In this
  design the empty string means "no gate".
- **Sentinel value**: A special value of an ordinary type standing
  for "absent". Here `''` is the sentinel for "no test gate".
- **Review pass and fixer**: An optional step at the end of a run
  where a reviewer agent inspects the merged work and a fixer agent
  addresses its findings. The fixer has its own test gate.
- **Dry run (`--dry-run`)**: Prints the planned wave order, worktree
  layout and settings without running any agents.
- **Preflight**: A check done before any side effects. Here it
  verifies the provider executable can be found.
- **`onLine`**: An optional callback on `spawnAgent` that sends
  output and status messages to the status display instead of the
  console.
- **StatusDisplay**: The terminal UI that repaints a fixed ticket
  grid and a log area. It overwrites text written straight to the
  console, so messages must go through `onLine`.
- **Process group**: A set of OS processes that can be signalled
  together. Agents are spawned in their own group so a timeout can
  kill them and their children. This is why Windows is unsupported.
- **`.fail()` handler**: A yargs hook called when parsing or a
  command fails. The design uses it to print one stderr line and
  exit 2 for thrown errors.
- **`ExitPromptError`**: The error `@inquirer/prompts` throws when a
  prompt is closed or has no interactive terminal.
- **`prepublishOnly`**: An npm lifecycle script that runs before
  `npm publish` and `npm publish --dry-run`. A failing script aborts
  publishing.
- **Mock agent**: A test script (`test/mock-agent-*.js`) passed as
  the provider so integration tests can run the real CLI without a
  real agent.
- **`spawnCli`**: The test helper in `test/integration.test.ts` that
  runs the built `dist/index.js` as a subprocess.

## Architecture

Five independent fixes to the CLI's edges, found by an audit of the
built tool. None changes how tickets are scheduled, run or merged.
They change what happens before the first worktree exists, what the
agent is told about tests, how the process ends on an error, and
what gets published.

### Provider preflight

A new module, `src/preflight.ts`, exposes one pure, synchronous
function:

```ts
export function resolveExecutable (
    cmd:string,
    opts?:{ path?:string; cwd?:string }
):string|null
```

A `cmd` containing a path separator is resolved against `cwd`
(default `process.cwd()`) and returned when it exists and is
executable. A bare name is searched in each entry of `path`
(default `process.env.PATH`), first hit wins. Anything else returns
`null`. It never throws and never spawns a process.

`runExecute` in `src/index.ts` calls it right after
`loadTicketsOrExit` and before `prepareIntegrationBranch`. A `null`
result prints `Provider '<cmd>' not found on PATH` to stderr and
exits 2, so a typo never creates or checks out the integration
branch. Under `--dry-run` the same lookup prints a `Provider:` line
(the resolved path, or `not found on PATH`) instead of exiting, so a
dry run still works on a machine without the agent installed.

`spawnAgent` keeps its `proc.on('error')` handler but reports the
error through `opts.onLine` when one is given, falling back to
`console.error` otherwise. This is the same rule the timeout message
already follows, for the same reason: `StatusDisplay` repaints over
bare console output.

### Test gate off

`testCmd` stays a `string` everywhere. The empty string means "no
gate". Three places consume it:

- `testGateRule` in `src/rules.ts` returns a shorter rule for `''`:
  run the tests relevant to the change and do not commit with
  failing tests. It does not name a command or claim the
  orchestrator will run one.
- `runTestGate` in `src/orchestrator.ts` returns `true` without
  spawning anything or writing a `.test.log` when the command is
  `''`. The ticket proceeds to the new-commits check and merge as
  if the suite were green.
- The fixer's test gate in `src/review.ts` does the same.

`src/index.ts` picks the command as: the `--test-cmd` value when the
flag is given (including `""`), else `detectTestCmd(root)`, else
`''`. The `|| 'npm test'` fallback is removed; it could only ever
run on a project with no `test` script, where it fails every
ticket. When the result is `''` and the flag was not given, the CLI
logs one line before the run: `No test command detected; running
without a test gate. Pass --test-cmd to add one.` Both dry-run
printers show `Test command: (none)` for `''`.

### Error reporting

`src/index.ts` installs a yargs `.fail()` handler. A usage error
(`msg` set, no `err`) keeps today's output: help text, then the
message, exit 1. A thrown error (`err` set) prints
`formatErrorMessage(err)` to stderr and exits 2, with no help text
and no stack. This covers the dirty-tree throw from
`runWavesIsolated`, git failures in `prepareIntegrationBranch` that
are not already caught, and the `ExitPromptError` that
`@inquirer/prompts` throws when a prompt is closed or has no TTY.
Exit 2 matches the existing usage-error exits in `runExecute`.

### Publish safety

`package.json` gains `"prepublishOnly": "npm run build && npm test"`.
npm runs it for `npm publish` and `npm publish --dry-run`, so the
`postversion` publish and a manual publish both build fresh and
refuse to ship if the suite is red. `preversion` keeps lint.

### Documentation

README Install gets a Requirements paragraph (Node per `engines`,
git, the provider CLI on PATH, macOS or Linux; process groups and
`sh -c` rule out Windows). The Worktrees section says worktrees are
sibling directories of the repo, `<repo>.<num>-<slug>`, and that an
interrupted run leaves them for the next run to clean up. The
`--test-cmd` row in the Interface table describes detection, the
no-gate fallback and `""`. AGENTS.md documents `src/preflight.ts`,
the `''` meaning of `testCmd` in `renderPrompt`, `runWaves`,
`runWavesIsolated`, `testGateRule` and `runFixer`, the `spawnAgent`
error reporting, the `.fail()` behavior, and the `--test-cmd`
contract.

## Existing Patterns

Investigation found the patterns these fixes follow:

- `detectTestCmd` and `detectInstallCmd` in `src/testcmd.ts` are
  synchronous, never throw, and return `null` for "nothing found".
  `resolveExecutable` follows the same shape.
- `--install-cmd ""` already disables the install through `??` in
  `src/index.ts`; `installCmd` is simply absent downstream. The test
  gate reuses the flag convention, but keeps `string` with `''` as
  the sentinel because `testCmd` is a required parameter at some
  twenty call sites across `src/orchestrator.ts` and
  `src/review.ts`.
- `spawnAgent` already routes its timeout message through `onLine`
  with a `console.warn` fallback (`src/orchestrator.ts`, timeout
  handler). The spawn-error path adopts the same rule.
- Usage errors exit 2 from `runExecute` (`loadTicketsOrExit`,
  `failStaleResume`, the `prepareIntegrationBranch` catch). Runtime
  errors in the fail handler use the same code.
- CLI behavior is tested end to end in `test/integration.test.ts`
  through `spawnCli`, which runs `dist/index.js` against a temp
  project with `test/mock-agent-*.js` scripts passed by absolute
  path as the provider. Preflight must therefore accept an absolute
  path, and the tests can pass a bare nonexistent name to exercise
  the failure.
- Test suites are listed by name in `scripts/test.sh`; a new
  `test/preflight.test.ts` is added there.
- Documentation changes ship as their own phase, as in
  `docs/design-plans/2026-09-28-stable-ticket-list.md`.

No new pattern is introduced.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Provider preflight
**Goal:** A missing provider fails fast, before any git state
changes, and a spawn error is visible in the status display.

**Components:**
- `src/preflight.ts` -- `resolveExecutable(cmd, opts?)`, pure and
  synchronous, as specified in Architecture
- `src/index.ts` -- `runExecute` calls it after the first ticket
  scan and before `prepareIntegrationBranch`; exits 2 with the
  one-line message, or prints a `Provider:` line under `--dry-run`
- `src/orchestrator.ts` -- the `proc.on('error')` handler in
  `spawnAgent` reports through `opts.onLine` when present
- `test/preflight.test.ts` -- unit tests for `resolveExecutable`
  with a temp PATH; registered in `scripts/test.sh`
- `test/integration.test.ts` -- CLI subprocess tests: a bare
  nonexistent provider exits 2 without creating the integration
  branch; an absolute mock-agent path still runs; `--dry-run` with
  a nonexistent provider exits 0

**Dependencies:** None.

**Done when:** Tests covering cli-audit-fixes.AC1.* pass and
`npm test` is green.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Test gate off
**Goal:** `--test-cmd ""` and an undetectable test command both run
without a gate, and the prompt stops promising one.

**Components:**
- `src/index.ts` -- test command selection without the `'npm test'`
  fallback; startup warning when nothing was detected
- `src/rules.ts` -- `testGateRule` returns the no-gate rule for `''`
- `src/orchestrator.ts` -- `runTestGate` short-circuits on `''`;
  `dryRun` and `dryRunIsolated` print `(none)`
- `src/review.ts` -- the fixer's test gate short-circuits on `''`
- Tests in `test/orchestrator.test.ts`, `test/review.test.ts` and
  `test/integration.test.ts` for the prompt rule, the skipped gate
  (no `.test.log`, branch merges), the fixer, and the CLI
  subprocess with `--test-cmd ""` on a project with no `test`
  script

**Dependencies:** None.

**Done when:** Tests covering cli-audit-fixes.AC2.* pass and
`npm test` is green.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Error reporting
**Goal:** A thrown error ends the process with one stderr line and
exit 2.

**Components:**
- `src/index.ts` -- yargs `.fail()` handler distinguishing usage
  errors from thrown errors
- `test/integration.test.ts` -- CLI subprocess tests: dirty tree on
  a non-default branch exits 2 with the dirty-tree message and no
  `Options:` or stack frames on stderr; a usage error still shows
  help

**Dependencies:** None.

**Done when:** Tests covering cli-audit-fixes.AC3.* pass and
`npm test` is green.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Publish safety
**Goal:** Publishing always builds and tests first.

**Components:**
- `package.json` -- `prepublishOnly` script

**Dependencies:** None.

**Done when:** `npm publish --dry-run` runs the build and the test
suite before reporting the tarball, and refuses when a test fails.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Documentation
**Goal:** README and AGENTS.md describe the tool as it now behaves.

**Components:**
- `README.md` -- Requirements paragraph in Install; sibling
  worktree directories and leftover worktrees in Worktrees; the
  `--test-cmd` Interface row
- `AGENTS.md` -- preflight module contract; `testCmd` `''` meaning
  on `renderPrompt`, `runWaves`, `runWavesIsolated`, `testGateRule`
  and `runFixer`; `spawnAgent` error reporting; CLI `--test-cmd`
  and `.fail()` behavior; `prepublishOnly` under Commands;
  `src/preflight.ts` in Project Structure; refresh the
  `Last verified` date

**Dependencies:** Phases 1 to 4.

**Done when:** Every statement in the changed sections matches the
code, and `npm run lint` passes.
<!-- END_PHASE_5 -->

## Additional Considerations

**Behavior change for projects without a test script.** Today such
a project fails every ticket on `missing script: test`. After Phase
2 it merges agent branches with no orchestrator test gate and says
so once at startup. This trades a certain failure for an explicit,
logged choice; the one-line warning is what tells the user to add
`--test-cmd`.

**Preflight is a PATH lookup, not a version check.** It confirms a
file exists and is executable. A provider that exists but is
misconfigured still fails at spawn time and is retried as before;
that path now at least reaches the display.

**Display state on error.** The dirty-tree check in
`runWavesIsolated` runs before `startRun`, so no ANSI state has been
written when it throws. The fail handler does not call
`display.cleanup()`; a throw from later in the run is already caught
inside the orchestrator and reported through the display.
