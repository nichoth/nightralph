# PRD: Integration Test Coverage

## Introduction

The nightralph test suite has solid unit coverage for parsing,
wave scheduling, and setup scaffolding, but nothing validates that
the CLI commands actually work end-to-end. The CLI layer
(`src/index.ts`) is completely untested, the `setup` and execute
commands are never tested in composition, and `spawnAgent` is only
exercised through trivial mock scripts. This PRD defines the
integration tests needed to close those gaps and give confidence
that `npx nightralph setup` followed by
`npx nightralph claude -m <model>` works on real issue docs.

## Goals

- Validate the full CLI path via subprocess (`node dist/index.js`)
- Prove that `setup` output feeds correctly into the execute command
- Test `findFeatureDirs` and `resolveIssuesDir` with realistic
  directory layouts
- Test `dryRun` output (wave order, deadlock warnings, prompt preview)
- Test the unknown-blocker warning/stripping logic in `runExecute`
- All new tests use mock agent scripts -- no real `claude` invocation

## User Stories

### US-001: Subprocess CLI smoke test for execute

**Description:** As a developer, I want a test that spawns
`node dist/index.js <provider>` as a child process so that I know
the yargs wiring, argument parsing, and file resolution work
end-to-end.

**Acceptance Criteria:**

- [ ] Test spawns the built CLI with `--dir`, `--spec`, and
      `--timeout-secs` pointing at a temp directory with ticket files
- [ ] Uses the existing `mock-agent-pass.js` as the provider argument
- [ ] Asserts exit code 0
- [ ] Asserts ticket files on disk are updated to `**Status:** done`
- [ ] Asserts log files are created in the expected location
- [ ] Typecheck/lint passes

### US-002: Subprocess CLI test for `--dry-run`

**Description:** As a developer, I want a test that runs the CLI
with `--dry-run` so that I know the dry-run path works through yargs
and produces the expected output.

**Acceptance Criteria:**

- [ ] Test spawns the built CLI with `--dry-run`, `--dir`, and
      `--spec`
- [ ] Captures stdout
- [ ] Asserts output contains "Wave 1:" with the expected ticket
      filenames
- [ ] Asserts output contains "AGENT INSTRUCTIONS" (prompt preview)
- [ ] Asserts ticket files on disk are NOT modified
- [ ] Typecheck/lint passes

### US-003: Subprocess CLI test for `--model` flag

**Description:** As a developer, I want to verify that `--model`
(or `-m`) is passed through to the spawned agent process so that
running `npx nightralph claude -m claude-sonnet-4-6` actually
forwards the model argument.

**Acceptance Criteria:**

- [ ] Create a new mock agent script (`mock-agent-echo-args.js`)
      that writes `process.argv` to stdout, then exits 0
- [ ] Test spawns the CLI with `-m test-model` using this mock agent
- [ ] Asserts the log file contains `--model` and `test-model` in
      the captured argv
- [ ] Typecheck/lint passes

### US-004: `findFeatureDirs` returns correct structure

**Description:** As a developer, I want direct tests for
`findFeatureDirs` so that feature directory discovery is validated
independently.

**Acceptance Criteria:**

- [ ] Export `findFeatureDirs` from `src/index.ts` (or extract to a
      shared module) so it can be imported in tests
- [ ] Test: returns empty array when `.scratch/` does not exist
- [ ] Test: returns empty array when `.scratch/` has directories
      without `issues/` subdirs
- [ ] Test: returns entries with correct `name`, `dir`, and `spec`
      paths for valid feature dirs
- [ ] Test: ignores non-directory entries in `.scratch/`
- [ ] Typecheck/lint passes

### US-005: `resolveIssuesDir` with explicit flags

**Description:** As a developer, I want to verify that when both
`--dir` and `--spec` are provided, `resolveIssuesDir` returns them
directly without scanning `.scratch/`.

**Acceptance Criteria:**

- [ ] Export `resolveIssuesDir` (or extract to a shared module)
- [ ] Test: returns `{ dir, spec }` exactly as given when both
      flags are provided
- [ ] No filesystem scanning occurs (the temp dir has no `.scratch/`)
- [ ] Typecheck/lint passes

### US-006: Setup-then-execute composition test

**Description:** As a developer, I want a test that runs `setup`,
then creates issue files in the expected `.scratch/` layout, then
runs `execute` -- proving the two commands compose correctly.

**Acceptance Criteria:**

- [ ] Test calls `setup()` with `tracker:'local'` in a temp project dir
- [ ] Creates `.scratch/<feature>/issues/` with 2 ticket files and
      a `spec.md`
- [ ] Spawns the CLI as a subprocess pointing at that project dir
      (using the mock agent)
- [ ] Asserts tickets are marked done
- [ ] Asserts logs are written to `.scratch/<feature>/logs/`
- [ ] Asserts `docs/agents/issue-tracker.md` exists (from setup)
- [ ] Asserts `.agents/skills/` directories exist (from setup)
- [ ] Typecheck/lint passes

### US-007: Unknown blocker warning and stripping

**Description:** As a developer, I want to verify that `runExecute`
warns about blockers referencing nonexistent ticket numbers and
strips them so execution proceeds.

**Acceptance Criteria:**

- [ ] Test creates a ticket with `**Blocked by:** 99` where ticket
      99 does not exist
- [ ] Spawns the CLI as a subprocess
- [ ] Asserts stderr/stdout contains a warning mentioning
      blocker `99`
- [ ] Asserts the ticket still completes (blocker was stripped)
- [ ] Typecheck/lint passes

### US-008: Dry-run deadlock detection

**Description:** As a developer, I want the dry-run to report
deadlocked tickets (circular dependencies) so users can fix their
ticket graph before running real agents.

**Acceptance Criteria:**

- [ ] Test creates two tickets that block each other (1 blocks 2,
      2 blocks 1)
- [ ] Spawns the CLI with `--dry-run`
- [ ] Asserts output contains "Deadlocked tickets" with both
      filenames
- [ ] Typecheck/lint passes

### US-009: CLI exits with error when no tickets found

**Description:** As a developer, I want to verify the CLI handles
the empty-directory edge case gracefully.

**Acceptance Criteria:**

- [ ] Test points `--dir` at an empty directory
- [ ] Asserts stdout contains "No ticket files found"
- [ ] Asserts exit code 0 (graceful, not a crash)
- [ ] Typecheck/lint passes

### US-010: CLI exits with error for missing dir/spec

**Description:** As a developer, I want the CLI to fail clearly
when `--dir` or `--spec` point to nonexistent paths.

**Acceptance Criteria:**

- [ ] Test passes `--dir /nonexistent/path` with a valid `--spec`
- [ ] Asserts exit code is non-zero
- [ ] Asserts stderr contains "not found"
- [ ] Test passes valid `--dir` with `--spec /nonexistent/spec.md`
- [ ] Asserts exit code is non-zero
- [ ] Asserts stderr contains "not found"
- [ ] Typecheck/lint passes

## Functional Requirements

- FR-1: All new integration tests must use subprocess spawning
  (`node dist/index.js`) to exercise the full CLI path including
  yargs parsing
- FR-2: All tests must use mock agent scripts, never the real
  `claude` CLI
- FR-3: A new mock agent script `mock-agent-echo-args.js` must be
  created to validate argument forwarding
- FR-4: `findFeatureDirs` and `resolveIssuesDir` must be exported
  (or extracted to a testable module) for direct unit tests
- FR-5: Tests must create and clean up temp directories -- no
  shared mutable state between tests
- FR-6: The composition test (US-006) must call `setup()` as a
  library function, then spawn the CLI for execute, proving the
  two stages connect
- FR-7: All tests must pass `npm test` (build + run)

## Non-Goals

- No tests that invoke the real `claude` CLI or require
  authentication
- No tests for the interactive `@inquirer/prompts` select flows
  (these require TTY)
- No tests for `checkGhAuth()` (depends on external `gh` CLI state)
- No performance or load testing
- No changes to the existing unit test files

## Technical Considerations

- The CLI must be built (`npm run build`) before subprocess tests
  run -- the test script already does this
- Subprocess tests should set a short `--timeout-secs` (e.g. 10)
  to avoid hanging
- `findFeatureDirs` currently uses `process.cwd()` -- it will need
  a `cwd` parameter to be testable, or the tests can set `CWD` via
  subprocess env
- The test file should be `test/integration.test.ts` to keep it
  separate from the existing unit tests
- Mock agent scripts live in `test/` alongside existing
  `mock-agent-pass.js` and `mock-agent-fail.js`

## Success Metrics

- Running `npm test` exercises the full CLI path through subprocess
- The `--model` flag is provably forwarded to the agent process
- The setup -> execute composition is tested in a single test
- Dry-run output is validated (wave order, deadlocks, prompt preview)
- Edge cases (empty dir, missing paths, unknown blockers) are covered

## Open Questions

- Should `findFeatureDirs` accept a `cwd` parameter, or should
  tests set `process.cwd()` via subprocess working directory? The
  subprocess approach avoids changing the function signature but
  is less direct for unit testing.
- Should the integration tests live in `test/integration.test.ts`
  or `test/cli.test.ts`?
