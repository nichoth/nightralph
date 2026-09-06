# Test Requirements: Unified Effort Escalation

All automated tests live in `test/orchestrator.test.ts` and use
`@substrate-system/tapzero`. Tests follow the project's existing
patterns: `t.equal(actual, expected, message)` assertions, ESM
imports with `.js` extensions, temp directories for mock agents,
and cleanup in `finally` blocks.

---

## Automated Tests

### unified-effort.AC1: Unified CLI flag

#### AC1.1: --effort accepted on CLI, replaces --thinking

- **Test type:** unit
- **File:** `test/orchestrator.test.ts`
- **Description:** After Phase 2 Task 4 renames the API surface,
  verify that `ALL_EFFORT_LEVELS` is exported and contains the
  union of all provider levels (`off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`). This is the choices array the CLI
  passes to yargs, so its correctness proves the flag accepts the
  right values. The CLI wiring itself (yargs option definition)
  is verified by the build compiling and by the dry-run integration
  test in AC3.4.

#### AC1.2: --effort values validated against provider's ladder at spawn time

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script named `claude` that
  writes its received args to a file. Call `spawnAgent` with
  effort set to `'off'` (not in claude's ladder). Verify that:
  (a) a warning line is emitted via the `onLine` callback
  containing "not supported", and (b) the mock agent's captured
  args do not contain `--effort`. This tests the validation
  guard added in Phase 2 Task 1.

#### AC1.3: Omitting --effort uses provider's default

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script (any provider name).
  Call `spawnAgent` with effort set to `undefined`. Verify the
  mock agent's captured args contain no `--effort`, `--thinking`,
  or `-e` flag. This is the same test as AC3.4 (see below) --
  the two criteria describe the same behavior from different
  angles.

---

### unified-effort.AC2: Per-provider escalation

#### AC2.1: On retry, effort escalates one rung up provider's ladder

- **Test type:** unit
- **File:** `test/orchestrator.test.ts`
- **Description:** Call `escalateEffort` for each provider with
  a mid-ladder level and verify it returns the next rung:
  - `escalateEffort('pi', undefined)` returns `'high'`
  - `escalateEffort('claude', undefined)` returns `'high'`
  - `escalateEffort('codex', undefined)` returns `'high'`
  - `escalateEffort('pi', 'medium')` returns `'high'`
  - `escalateEffort('claude', 'medium')` returns `'high'`
  - `escalateEffort('codex', 'medium')` returns `'high'`
  - `escalateEffort('pi', 'off')` returns `'minimal'`
  - `escalateEffort('claude', 'low')` returns `'medium'`
  - `escalateEffort('codex', 'minimal')` returns `'low'`
- **Phase:** Phase 1 Task 3

#### AC2.2: Escalation capped at provider's highest level

- **Test type:** unit
- **File:** `test/orchestrator.test.ts`
- **Description:** Call `escalateEffort` at the ceiling for each
  provider and verify the level stays pinned:
  - `escalateEffort('pi', 'max')` returns `'max'`
  - `escalateEffort('claude', 'max')` returns `'max'`
  - `escalateEffort('codex', 'xhigh')` returns `'xhigh'`
  Also verify the edge case where the given level is not in the
  provider's ladder at all (e.g. `escalateEffort('claude', 'off')`
  returns `'off'` unchanged, `escalateEffort('codex', 'max')`
  returns `'max'` unchanged).
- **Phase:** Phase 1 Task 3

#### AC2.3: Effort resets to starting level for each new ticket

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Set up two tickets (01, 02) and a mock agent
  that fails on its first invocation then succeeds on the second
  (the existing `mock-agent-fail-then-pass.js` pattern). Run
  `runWaves` with effort set to `'medium'` and retries set to 1.
  Ticket 01 fails, retries with escalated effort (`'high'`), and
  succeeds. Ticket 02 (in wave 2 or same wave) should start at
  `'medium'` again, not `'high'`. Verify by capturing spawn
  args via the mock agent -- the first attempt for ticket 02
  must receive `'medium'`, not `'high'`.
- **Implementation note:** The reset behavior is structural --
  `runTicketAttempts` initializes `let effort = opts.effort` on
  each call, so escalation from a previous ticket does not leak.
  The test confirms this by observing the args passed to the
  mock agent across tickets.
- **Phase:** Phase 2 Task 6

---

### unified-effort.AC3: Provider flag mapping

#### AC3.1: claude agents receive --effort in spawn args

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script named `claude` that
  writes `process.argv` to a file. Call `spawnAgent` with effort
  `'high'`. Read the captured args and verify they contain
  `['--effort', 'high']`.
- **Phase:** Phase 2 Task 6

#### AC3.2: pi agents receive --thinking in spawn args

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script named `pi` that
  writes `process.argv` to a file. Call `spawnAgent` with effort
  `'high'`. Read the captured args and verify they contain
  `['--thinking', 'high']`.
- **Phase:** Phase 2 Task 6

#### AC3.3: codex agents receive -e in spawn args

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script named `codex` that
  writes `process.argv` to a file. Call `spawnAgent` with effort
  `'high'`. Read the captured args and verify they contain
  `['-e', 'high']`.
- **Phase:** Phase 2 Task 6

#### AC3.4: No effort arg when --effort is omitted

- **Test type:** integration
- **File:** `test/orchestrator.test.ts`
- **Description:** Create a mock agent script (any provider name).
  Call `spawnAgent` with effort `undefined`. Read the captured
  args and verify none of `--effort`, `--thinking`, or `-e`
  appear. Covers AC1.3 simultaneously.
- **Phase:** Phase 2 Task 6

---

### unified-effort.AC4: Retries default

#### AC4.1: DEFAULT_RETRIES is 3

- **Test type:** unit
- **File:** `test/orchestrator.test.ts`
- **Description:** Import `DEFAULT_RETRIES` from the orchestrator
  module and assert it equals 3.
- **Phase:** Phase 1 Task 3

#### AC4.2: --retries still overrides the default

- **Test type:** integration (existing)
- **File:** `test/orchestrator.test.ts`
- **Description:** The existing integration test "runWaves retries
  a failed agent with escalated thinking" (lines 2071-2110)
  already passes `retries: 1` explicitly and verifies the agent
  is retried exactly once. After the rename in Phase 2, this
  test's parameter name changes from `thinking` to `effort`, but
  the assertion remains the same: an explicit retries value
  overrides the default. Confirm this test still passes after
  the changes.

---

## Human Verification

### AC1.1: --effort accepted on CLI, replaces --thinking

- **Why partial automation:** The yargs option definition is
  declarative wiring -- it compiles or it does not, and the test
  for `ALL_EFFORT_LEVELS` verifies the choices array. But the
  full user-facing behavior (running `nightralph pi --effort high`
  from a shell and seeing it accepted, or `--thinking` being
  rejected as unknown) is best confirmed manually once.
- **How to verify:**
  1. Build the project: `npm run build`
  2. Run `node dist/index.js pi --effort high --dry-run` --
     should print the dry-run output with `Effort: high`
  3. Run `node dist/index.js pi --thinking high --dry-run` --
     should fail with an unknown option error
  4. Run `node dist/index.js pi --effort banana --dry-run` --
     should fail with an invalid choice error listing the
     valid levels

### AC2.3: Effort resets to starting level for each new ticket

- **Why partial automation:** The integration test described
  above covers the reset via mock agent arg capture. However,
  confirming the full end-to-end flow in `runWavesIsolated`
  (worktree mode) with real git operations and multiple waves
  is impractical to automate without a significant test harness
  expansion.
- **How to verify:**
  1. Set up a project with two local tickets where ticket 02
     depends on ticket 01 (different waves)
  2. Run `nightralph pi --effort medium --retries 1`
  3. Observe the display output: ticket 01's retry should show
     `effort high`; ticket 02's first attempt should show
     `effort medium`

### AC3 (all sub-criteria): Provider flag mapping end-to-end

- **Why partial automation:** The unit-level integration tests
  above use mock agent scripts and `spawnAgent` directly. The
  full CLI path (`nightralph claude --effort high`) involves
  yargs parsing, the orchestrator, and real provider binaries.
  This end-to-end path does not lend itself to automated testing
  without installing all three provider CLIs.
- **How to verify:**
  1. With `claude` installed: run
     `nightralph claude --effort high --dry-run` -- dry-run
     output should show `Effort: high`
  2. With `pi` installed: run
     `nightralph pi --effort high --dry-run` -- output should
     show `Effort: high`
  3. With `codex` installed: run
     `nightralph codex --effort high --dry-run` -- output
     should show `Effort: high`

---

## Coverage Matrix

| Criterion | Automated | Human | Phase |
|-----------|-----------|-------|-------|
| AC1.1     | unit (ALL_EFFORT_LEVELS export) | CLI smoke test | P2 T4, T6 |
| AC1.2     | integration (invalid level warning) | -- | P2 T1, T6 |
| AC1.3     | integration (no flag in args) | -- | P2 T6 |
| AC2.1     | unit (escalateEffort per provider) | -- | P1 T3 |
| AC2.2     | unit (ceiling clamp) | -- | P1 T3 |
| AC2.3     | integration (two-ticket arg capture) | worktree end-to-end | P2 T6 |
| AC3.1     | integration (claude mock --effort) | end-to-end with real CLI | P2 T6 |
| AC3.2     | integration (pi mock --thinking) | end-to-end with real CLI | P2 T6 |
| AC3.3     | integration (codex mock -e) | end-to-end with real CLI | P2 T6 |
| AC3.4     | integration (no flag when omitted) | -- | P2 T6 |
| AC4.1     | unit (DEFAULT_RETRIES === 3) | -- | P1 T3 |
| AC4.2     | integration (existing test with explicit retries) | -- | P1 T3 |
