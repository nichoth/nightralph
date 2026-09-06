# Unified Effort Escalation -- Design Plan

## Overview

Generalize the retry-with-escalation logic so it works for all
three providers (claude, pi, codex), not just pi. Replace the
pi-only `--thinking` CLI flag with a unified `--effort` flag
that maps to each provider's native reasoning parameter.
Change `--retries` default from 2 to 3.

## Provider Effort Ladders

Each provider has its own set of reasoning levels and CLI flag:

| Provider | CLI flag     | Levels (lowest to highest)                          |
|----------|-------------|-----------------------------------------------------|
| pi       | `--thinking` | `off, minimal, low, medium, high, xhigh, max`      |
| claude   | `--effort`   | `low, medium, high, xhigh, max`                    |
| codex    | `-e`         | `minimal, low, medium, high, xhigh`                |

`ultracode` and `auto` (claude-only) are excluded from the
escalation ladder -- they have side effects beyond reasoning
depth.

## Unified `--effort` Flag

A single `--effort <level>` flag on the nightralph CLI replaces
`--thinking`. The level value is validated against the active
provider's ladder at runtime. When omitted, the provider uses
its own default.

## Escalation Behavior

On retry, effort steps one rung up the active provider's ladder,
capped at the provider's highest level:

- pi: capped at `max`
- claude: capped at `max`
- codex: capped at `xhigh`

When no starting level is given (`--effort` omitted), the first
retry escalates to `high` (matching today's behavior).

Effort resets to the starting level for each new ticket.

## Integration Points

### `src/orchestrator.ts`

- `THINKING_LEVELS` replaced with per-provider ladder maps
- `escalateThinking()` generalized to accept a provider name
  and return the next rung on that provider's ladder
- `spawnAgent()` passes effort to all providers via each
  provider's native flag (`--effort`, `--thinking`, `-e`)
- `runTicketAttempts()` escalates for all providers, not
  just pi
- `DEFAULT_RETRIES` changes from 2 to 3

### `src/index.ts`

- `--thinking` flag replaced with `--effort`
- Choices validated against a union of all provider levels
  (runtime validation per-provider happens in the orchestrator)
- Help text updated

## Acceptance Criteria

### unified-effort.AC1: Unified CLI flag
- **unified-effort.AC1.1 Success:** `--effort <level>` is
  accepted on the CLI and replaces `--thinking`
- **unified-effort.AC1.2 Success:** `--effort` values are
  validated against the active provider's ladder at spawn time
- **unified-effort.AC1.3 Success:** omitting `--effort` uses
  the provider's default

### unified-effort.AC2: Per-provider escalation
- **unified-effort.AC2.1 Success:** on retry, effort escalates
  one rung up the active provider's ladder
- **unified-effort.AC2.2 Success:** escalation is capped at
  the provider's highest level
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

### unified-effort.AC4: Retries default
- **unified-effort.AC4.1 Success:** `DEFAULT_RETRIES` is 3
- **unified-effort.AC4.2 Success:** `--retries` still
  overrides the default

<!-- START_PHASE_1 -->
## Phase 1: Effort types and escalation generalization

Replace pi-specific thinking types with per-provider effort
ladders and generalize the escalation function.

**Components:**
- Per-provider effort ladder definitions
- Generalized escalation function
- Updated exports (deprecate or remove `THINKING_LEVELS`,
  `escalateThinking`)
- `DEFAULT_RETRIES` change from 2 to 3

**Verifies:** AC2 (per-provider escalation), AC4 (retries default)
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
## Phase 2: spawnAgent and CLI integration

Wire effort through spawnAgent for all providers and update the
CLI flag from `--thinking` to `--effort`.

**Components:**
- `spawnAgent` updated to map effort to each provider's
  native flag
- `runTicketAttempts` updated to escalate for all providers
- CLI `--thinking` replaced with `--effort`
- Help text and dry-run output updated

**Verifies:** AC1 (unified CLI flag), AC3 (provider flag mapping)
<!-- END_PHASE_2 -->
