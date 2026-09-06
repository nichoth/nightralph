# Unified Effort Escalation Implementation Plan

**Goal:** Wire per-provider effort through spawnAgent, update
retry loops to escalate for all providers, and replace the
CLI `--thinking` flag with `--effort`.

**Architecture:** spawnAgent maps the unified effort level to
each provider's native CLI flag (`--effort` for claude,
`--thinking` for pi, `-e` for codex). The retry loops call
`escalateEffort(provider, level)` for all providers instead
of the pi-only `escalateThinking`. The CLI presents a single
`--effort` flag validated against all known levels.

**Tech Stack:** TypeScript, Node >= 24, ESM,
@substrate-system/tapzero

**Scope:** 2 phases from original design (phases 1-2)

**Codebase verified:** 2026-09-05

---

## Acceptance Criteria Coverage

This phase implements and tests:

### unified-effort.AC1: Unified CLI flag
- **unified-effort.AC1.1 Success:** `--effort <level>` is
  accepted on the CLI and replaces `--thinking`
- **unified-effort.AC1.2 Success:** `--effort` values are
  validated against the active provider's ladder at spawn time
- **unified-effort.AC1.3 Success:** omitting `--effort` uses
  the provider's default

### unified-effort.AC2: Per-provider escalation
- **unified-effort.AC2.3 Success:** effort resets to the
  starting level for each new ticket

### unified-effort.AC3: Provider flag mapping
- **unified-effort.AC3.1 Success:** claude agents receive
  `--effort <level>` in their spawn args
- **unified-effort.AC3.2 Success:** pi agents receive
  `--thinking <level>` in their spawn args
- **unified-effort.AC3.3 Success:** codex agents receive
  `-e <level>` in their spawn args
- **unified-effort.AC3.4 Success:** providers that don't
  receive an effort arg when `--effort` is omitted

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Update spawnAgent provider flag mapping

**Verifies:** unified-effort.AC3.1, unified-effort.AC3.2,
unified-effort.AC3.3, unified-effort.AC3.4,
unified-effort.AC1.2

**Files:**
- Modify: `src/orchestrator.ts:648-653`

**Implementation:**

Replace the pi-only thinking flag block (lines 651-653)
with per-provider effort mapping. The parameter is still
named `thinking` at this point (renamed in Task 4).

Current code at lines 648-653:
```typescript
const providerName = basename(opts.agentCmd)
const isClaude = providerName === 'claude'
const isPi = providerName === 'pi'
if (isPi && opts.thinking) {
    args.push('--thinking', opts.thinking)
}
```

Replace the `if (isPi && opts.thinking)` block with:

```typescript
if (opts.thinking && providerName in EFFORT_LADDERS) {
    const ladder = EFFORT_LADDERS[
        providerName as ProviderName
    ]
    if (
        !(ladder as readonly string[])
            .includes(opts.thinking)
    ) {
        if (opts.onLine) {
            opts.onLine(
                `Warning: effort ` +
                `'${opts.thinking}' not ` +
                `supported by ` +
                `${providerName}, skipping`
            )
        }
    } else if (isPi) {
        args.push('--thinking', opts.thinking)
    } else if (isClaude) {
        args.push('--effort', opts.thinking)
    } else if (providerName === 'codex') {
        args.push('-e', opts.thinking)
    }
}
```

This validates the level against the provider's ladder
(AC1.2), passes the correct native flag per provider
(AC3.1-3.3), and skips when effort is omitted (AC3.4).

**Verification:**
Run: `npm run build`
Expected: Compiles without errors

**Commit:** `feat: pass effort flag to all providers in spawnAgent`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Generalize retry escalation in runTicketAttempts

**Verifies:** unified-effort.AC2.3

**Files:**
- Modify: `src/orchestrator.ts:1301-1330`

**Implementation:**

In `runTicketAttempts` (line 1301), update the retry loop
to escalate for all providers, not just pi.

At line 1306, replace:
```typescript
const isPi = basename(opts.agentCmd) === 'pi'
```
with:
```typescript
const providerName = basename(opts.agentCmd)
const isKnown = providerName in EFFORT_LADDERS
```

At line 1316, replace:
```typescript
thinking = escalateThinking(thinking)
```
with:
```typescript
if (isKnown) {
    thinking = escalateEffort(
        providerName as ProviderName,
        thinking
    )
}
```

At lines 1318-1323, update the log message to show effort
for all known providers instead of just pi:
```typescript
d.log(
    `  ${ticket.filename}: retrying ` +
    `(attempt ${attempt}/${maxAttempts}` +
    (isKnown && thinking ?
        `, effort ${thinking}` : '') +
    (delay > 0 ?
        `, waiting ${delay}s` : '') +
    ')'
)
```

The `let thinking = opts.thinking` at line 1307 already
provides the per-ticket reset behavior (AC2.3).

**Verification:**
Run: `npm run build`
Expected: Compiles without errors

**Commit:** `feat: escalate effort for all providers in runTicketAttempts`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Generalize retry escalation in runWaves

**Files:**
- Modify: `src/orchestrator.ts:1394,1436,1458,1460-1467`

**Implementation:**

In `runWaves` (starting around line 1376), apply the same
changes as Task 2.

At line 1394, replace:
```typescript
const isPi = basename(agentCmd) === 'pi'
```
with:
```typescript
const providerName = basename(agentCmd)
const isKnown = providerName in EFFORT_LADDERS
```

At line 1458, replace:
```typescript
level = escalateThinking(level)
```
with:
```typescript
if (isKnown) {
    level = escalateEffort(
        providerName as ProviderName,
        level
    )
}
```

At lines 1460-1467, update the log message:
```typescript
d.log(
    `  ${t.filename}: agent exited ` +
    `${result.exitCode}; retrying ` +
    `(attempt ${attempt}/${maxAttempts}` +
    (isKnown && level ?
        `, effort ${level}` : '') +
    (delay > 0 ?
        `, waiting ${delay}s` : '') +
    ')'
)
```

**Verification:**
Run: `npm run build`
Expected: Compiles without errors

**Commit:** `feat: escalate effort for all providers in runWaves`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Replace CLI --thinking with --effort and rename params

**Verifies:** unified-effort.AC1.1, unified-effort.AC1.3

**Files:**
- Modify: `src/index.ts:9-21,134-140,146,169-170,213,287,322,334`
- Modify: `src/orchestrator.ts` (multiple locations)

**Implementation:**

This task renames the entire API surface from `thinking` to
`effort`. All changes must happen together for the build to
compile.

**In `src/index.ts`:**

Update imports (lines 9-21):
- Replace `THINKING_LEVELS` with `ALL_EFFORT_LEVELS`
- Replace `type ThinkingLevel` with `type EffortLevel`

Replace the `--thinking` option (lines 134-140) with:
```typescript
.option('effort', {
    type:'string',
    choices:ALL_EFFORT_LEVELS,
    describe:'Starting effort level. ' +
        'Omitted = provider default. ' +
        'Retries step up from here.',
})
```

Update the type cast (lines 169-170):
- Change `thinking` to `effort` and
  `ThinkingLevel` to `EffortLevel`

Update the `runExecute` function's internal parameter type
at line 213 (`thinking?:ThinkingLevel` ->
`effort?:EffortLevel`).

Update the `--retries` option describe text at line 146:
replace the pi-specific "higher thinking level (pi)" with
"higher effort level" to reflect all-provider support.

Update all routing lines (287, 322, 334):
- Change `thinking: argv.thinking` to
  `effort: argv.effort`

**In `src/orchestrator.ts`:**

Rename all occurrences of the `thinking` parameter to
`effort` in function signatures:
- `spawnAgent` opts (line 635):
  `thinking?:ThinkingLevel` -> `effort?:EffortLevel`
- `runTicketAttempts` / `TicketAttemptOpts`:
  `thinking` -> `effort`
- `runWaves` parameter: `thinking` -> `effort`
- `runWavesIsolated` opts: `thinking` -> `effort`
- `dryRunIsolated` opts (line 884):
  `thinking` -> `effort`
- `runTicketAttempt` opts: `thinking` -> `effort`

Update all internal references from `opts.thinking` to
`opts.effort`, `let thinking` to `let effort`, etc.

Update pi-specific comments to reflect all-provider
escalation:
- Line 1300: change "and, for pi, a higher thinking
  level" to "and a higher effort level"
- Line 1549: change "starting thinking level for pi;
  unset = pi's default" to "starting effort level;
  unset = provider's default"

In `dryRunIsolated` (line 939), update display label:
```typescript
console.log(
    `Effort:       ${opts.effort ?? '(provider default)'}`
)
```

Remove deprecated exports:
- Remove `THINKING_LEVELS` alias
- Remove `ThinkingLevel` type alias
- Remove `escalateThinking` function (lines 419-427)

**Verification:**
Run: `npm run build`
Expected: Compiles without errors

**Commit:** `feat: replace --thinking with --effort, rename API surface`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

**Implementation:**

Update all documentation references:

In the exports list (around line 88), replace
`THINKING_LEVELS`, `ThinkingLevel`,
`escalateThinking(level?)` with:
- `EFFORT_LADDERS`
- `ProviderName`
- `EffortLevel`
- `ALL_EFFORT_LEVELS`
- `escalateEffort(provider, level?)`

Update the CLI section (around line 70):
- Replace `--thinking <level>` docs with `--effort`
- Update description to reflect all-provider support

Update the detailed descriptions (around lines 113-117):
- Replace THINKING_LEVELS description with EFFORT_LADDERS
- Replace escalateThinking description with escalateEffort
- Document per-provider ladders

Update spawnAgent docs (around line 159):
- Replace `thinking` with `effort`
- Document per-provider flag mapping

Update runWaves, runWavesIsolated, dryRunIsolated docs:
- Replace `thinking` with `effort` throughout

**Verification:**
Run: `npm run build`
Expected: Still compiles (markdown only)

**Commit:** `docs: update AGENTS.md for unified effort API`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Tests for provider flag mapping, CLI, and escalation

**Verifies:** unified-effort.AC1.1, unified-effort.AC1.2,
unified-effort.AC1.3, unified-effort.AC2.3,
unified-effort.AC3.1, unified-effort.AC3.2,
unified-effort.AC3.3, unified-effort.AC3.4

**Files:**
- Modify: `test/orchestrator.test.ts`

**Testing:**

Update existing tests and add new ones. Import
`escalateEffort`, `EFFORT_LADDERS`, `ALL_EFFORT_LEVELS`,
`ProviderName`, `EffortLevel` from `../src/orchestrator.js`.

**Update existing tests:**

The existing `escalateThinking` tests (lines 2026-2041)
should be replaced with escalateEffort tests (already
added in Phase 1 Task 3, but verify they reference the
correct function name after the rename).

The existing integration test "runWaves retries a failed
agent with escalated thinking" (lines 2071-2110) must be
updated to use the renamed `effort` parameter instead of
`thinking`.

**New tests for AC coverage:**

- unified-effort.AC1.2 (per-provider validation):
  Create a mock agent named `claude` (via a script that
  captures its args). Spawn with effort `'off'` (not in
  claude's ladder). Verify the warning is emitted and
  `--effort` is NOT passed to the agent.

- unified-effort.AC1.3 (omitting uses provider default):
  Spawn a mock agent with no effort specified. Verify no
  effort-related flag appears in the agent's args.

- unified-effort.AC2.3 (per-ticket reset):
  Run two tickets in sequence with effort `'medium'` and
  a provider that supports escalation. First ticket
  fails and retries (escalating to `'high'`). Second
  ticket should start at `'medium'` again, not `'high'`.

- unified-effort.AC3.1 (claude receives --effort):
  Create a mock `claude` agent that captures its args.
  Spawn with effort `'high'`. Verify args contain
  `['--effort', 'high']`.

- unified-effort.AC3.2 (pi receives --thinking):
  Same pattern with mock `pi` agent. Verify args contain
  `['--thinking', 'high']`.

- unified-effort.AC3.3 (codex receives -e):
  Same pattern with mock `codex` agent. Verify args
  contain `['-e', 'high']`.

- unified-effort.AC3.4 (no flag when omitted):
  Spawn mock agent with effort undefined. Verify no
  `--effort`, `--thinking`, or `-e` in args.

Follow project testing patterns: tapzero assertions,
temp directories for mock agents, cleanup after tests.

**Verification:**
Run: `npm test`
Expected: All tests pass

**Commit:** `test: add provider flag mapping and effort CLI tests`
<!-- END_TASK_6 -->
