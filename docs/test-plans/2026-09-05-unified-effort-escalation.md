# Unified Effort Escalation -- Human Test Plan

## Prerequisites
- Node >= 24 installed
- Project built: `npm run build` succeeds
- `npm test` passes (200/200)
- At least one agent CLI installed (`claude`, `pi`, or `codex`)

## Phase 1: CLI Flag Acceptance

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `node dist/index.js pi --effort high --dry-run` from the repo root | Dry-run output prints successfully, includes `Effort: high` in the configuration summary |
| 2 | Run `node dist/index.js pi --thinking high --dry-run` | yargs rejects with an "Unknown argument: thinking" error (the old flag is removed) |
| 3 | Run `node dist/index.js pi --effort banana --dry-run` | yargs rejects with an invalid-choice error listing the valid levels: off, minimal, low, medium, high, xhigh, max |
| 4 | Run `node dist/index.js claude --effort high --dry-run` | Dry-run output prints successfully with `Effort: high` |
| 5 | Run `node dist/index.js codex --effort high --dry-run` | Dry-run output prints successfully with `Effort: high` |
| 6 | Run `node dist/index.js pi --dry-run` (no --effort) | Dry-run output prints with no effort line, or shows the provider default |

## Phase 2: Per-Ticket Effort Reset (end-to-end)

Purpose: Confirm that effort escalation from retrying one ticket does not leak into the next ticket's starting effort.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a test project with local issue tracking (two tickets: `01-first.md` wave 1, `02-second.md` wave 2, where 02 depends on 01) | Two markdown ticket files under `.scratch/<feature>/` with appropriate `status: ready-for-agent` and blockers |
| 2 | Run `nightralph pi --effort medium --retries 1 --timeout 120` | Orchestrator starts, processes tickets in waves |
| 3 | Observe ticket 01: if it fails on first attempt, watch for retry | Retry attempt should show escalated effort (e.g. `high`) in the display or logs |
| 4 | Observe ticket 02: watch the first attempt's effort level | First attempt should show `medium` (the starting level), not `high` from ticket 01's retry |

## Phase 3: Provider Flag Mapping (end-to-end)

Purpose: Confirm the full CLI path (yargs parsing through orchestrator through spawn) passes the correct provider-specific flag.

| Step | Action | Expected |
|------|--------|----------|
| 1 | With `claude` installed, set up a single-ticket project and run `nightralph claude --effort high --timeout 60` | The spawned claude process receives `--effort high` in its arguments (visible in the agent's log or by checking `.scratch/<feature>/logs/`) |
| 2 | With `pi` installed, run the same setup with `nightralph pi --effort high --timeout 60` | The spawned pi process receives `--thinking high` (not `--effort`) |
| 3 | With `codex` installed, run the same setup with `nightralph codex --effort high --timeout 60` | The spawned codex process receives `-e high` (not `--effort` or `--thinking`) |

## End-to-End: Full Retry Cycle with Effort Escalation

Purpose: Validates the complete flow -- CLI flag parsing, provider dispatch, effort escalation on retry, and effort reset across tickets -- in a single run.

1. Initialize a project: `nightralph init`, select local tracker
2. Create a feature spec under `.scratch/myfeature/` with 3 tickets (01 in wave 1, 02-03 in wave 2)
3. Run `nightralph pi --effort low --retries 2 --retry-delay 0 --timeout 120`
4. If ticket 01 fails: first retry should use `medium`, second retry should use `high`
5. Tickets 02 and 03 (wave 2) should each start at `low` regardless of 01's escalation
6. Check `progress.md` after the run: completed tickets are checked, failed tickets show `done: false`
7. Check log files in `.scratch/myfeature/logs/`: `01-*.attempt2.log` and `01-*.attempt3.log` should exist for retried tickets

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC1.1 (CLI smoke) | yargs wiring is declarative; compilation proves syntax but shell behavior (flag acceptance, error messages) needs one manual pass | Phase 1 steps 1-6 |
| AC2.3 (effort reset e2e) | The automated test uses `runWavesIsolated` with mock agents; the full worktree + real agent path is impractical to automate without installing provider CLIs | Phase 2 steps 1-4 |
| AC3.1-3.3 (provider mapping e2e) | Unit tests use mock agents and `spawnAgent` directly; the full CLI-to-spawn path involves yargs, orchestrator config, and real binaries | Phase 3 steps 1-3 |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `ALL_EFFORT_LEVELS` export (line 2525) | Phase 1, steps 1-3 |
| AC1.2 | Validation warning + no flag (line 2454) | -- |
| AC1.3 | No flag when omitted (line 2396) | Phase 1, step 6 |
| AC2.1 | `escalateEffort` per provider (lines 2029, 2047) | -- |
| AC2.2 | Ceiling clamp (lines 2065, 2083) | -- |
| AC2.3 | Two-ticket arg capture (line 2540) | Phase 2, steps 1-4 |
| AC3.1 | Claude mock `--effort` (line 2213) | Phase 3, step 1 |
| AC3.2 | Pi mock `--thinking` (line 2274) | Phase 3, step 2 |
| AC3.3 | Codex mock `-e` (line 2335) | Phase 3, step 3 |
| AC3.4 | No flag when omitted (line 2396) | -- |
| AC4.1 | `DEFAULT_RETRIES === 3` (line 2096) | -- |
| AC4.2 | Existing retry test with explicit retries (line 2128) | -- |
