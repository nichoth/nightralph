# Unified Effort Escalation Implementation Plan

**Goal:** Add per-provider effort ladders and a generalized
escalation function so retry-with-escalation works for all
providers, not just pi.

**Architecture:** A map of provider-specific effort ladders
replaces the single THINKING_LEVELS array. A new
`escalateEffort(provider, level?)` function steps up the
ladder for the given provider. Existing exports
(THINKING_LEVELS, ThinkingLevel, escalateThinking) are kept
as backwards-compatible aliases in this phase and removed in
Phase 2.

**Tech Stack:** TypeScript, Node >= 24, ESM,
@substrate-system/tapzero

**Scope:** 2 phases from original design (phases 1-2)

**Codebase verified:** 2026-09-05

---

## Acceptance Criteria Coverage

This phase implements and tests:

### unified-effort.AC2: Per-provider escalation
- **unified-effort.AC2.1 Success:** on retry, effort
  escalates one rung up the active provider's ladder
- **unified-effort.AC2.2 Success:** escalation is capped at
  the provider's highest level

### unified-effort.AC4: Retries default
- **unified-effort.AC4.1 Success:** `DEFAULT_RETRIES` is 3
- **unified-effort.AC4.2 Success:** `--retries` still
  overrides the default

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Define effort ladders, types, and escalateEffort

**Files:**
- Modify: `src/orchestrator.ts:408-427`

**Implementation:**

Replace the THINKING_LEVELS definition block (lines 408-414)
with per-provider effort ladders, keeping THINKING_LEVELS as
an alias for backwards compatibility:

```typescript
export const EFFORT_LADDERS = {
    pi: ['off', 'minimal', 'low', 'medium',
        'high', 'xhigh', 'max'],
    claude: ['low', 'medium', 'high',
        'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium',
        'high', 'xhigh'],
} as const

export type ProviderName =
    keyof typeof EFFORT_LADDERS

export type EffortLevel =
    typeof EFFORT_LADDERS[ProviderName][number]

export const ALL_EFFORT_LEVELS:EffortLevel[] = [
    'off', 'minimal', 'low', 'medium',
    'high', 'xhigh', 'max',
]

// Backwards compat -- removed in Phase 2
export const THINKING_LEVELS = EFFORT_LADDERS.pi
export type ThinkingLevel = EffortLevel
```

Add `escalateEffort` after the existing `escalateThinking`
function (after line 427). Keep `escalateThinking` as-is
(removed in Phase 2):

```typescript
export function escalateEffort (
    provider:ProviderName,
    level?:EffortLevel
):EffortLevel {
    if (!level) return 'high'
    const ladder = EFFORT_LADDERS[provider]
    const i = (ladder as readonly string[])
        .indexOf(level)
    if (i === -1) return level
    return ladder[
        Math.min(i + 1, ladder.length - 1)
    ] as EffortLevel
}
```

**Verification:**
Run: `npm run build`
Expected: Compiles without errors. Existing code that
imports THINKING_LEVELS, ThinkingLevel, and
escalateThinking still works.

**Commit:** `feat: add per-provider effort ladders and escalateEffort`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Change DEFAULT_RETRIES to 3

**Verifies:** unified-effort.AC4.1

**Files:**
- Modify: `src/orchestrator.ts:1106`

**Implementation:**

Change the value of `DEFAULT_RETRIES` from 2 to 3:

```typescript
export const DEFAULT_RETRIES = 3
```

This is at line 1106. The constant is used by
`runWavesIsolated` and `runWaves` as the fallback when
`retries` is not provided.

**Verification:**
Run: `npm run build`
Expected: Compiles without errors

Run: `npm test`
Expected: Existing tests still pass. No existing test
asserts DEFAULT_RETRIES === 2, so no breakage expected.
Integration tests pass retries explicitly.

**Commit:** `feat: change default retries from 2 to 3`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for escalateEffort and DEFAULT_RETRIES

**Verifies:** unified-effort.AC2.1, unified-effort.AC2.2,
unified-effort.AC4.1, unified-effort.AC4.2

**Files:**
- Modify: `test/orchestrator.test.ts`

**Testing:**

Add tests after the existing escalateThinking tests
(after line 2041). Import `escalateEffort`,
`EFFORT_LADDERS`, `ALL_EFFORT_LEVELS`, and
`DEFAULT_RETRIES` from `../src/orchestrator.js`.

Tests must verify each AC listed above:

- unified-effort.AC2.1 (escalation steps up per provider):
  - `escalateEffort('pi', undefined)` returns `'high'`
  - `escalateEffort('claude', undefined)` returns `'high'`
  - `escalateEffort('codex', undefined)` returns `'high'`
  - `escalateEffort('pi', 'medium')` returns `'high'`
  - `escalateEffort('claude', 'medium')` returns `'high'`
  - `escalateEffort('codex', 'medium')` returns `'high'`

- unified-effort.AC2.2 (capped at provider's highest):
  - `escalateEffort('pi', 'max')` returns `'max'`
  - `escalateEffort('claude', 'max')` returns `'max'`
  - `escalateEffort('codex', 'xhigh')` returns `'xhigh'`
    (codex's highest level)

- unified-effort.AC2.2 (level not in provider's ladder):
  - `escalateEffort('claude', 'off')` returns `'off'`
  - `escalateEffort('codex', 'max')` returns `'max'`

- unified-effort.AC4.1: `DEFAULT_RETRIES` equals 3

- unified-effort.AC4.2: verify that `--retries` still
  overrides the default (this is covered by existing
  integration tests that pass retries explicitly; confirm
  they still pass)

Follow project testing patterns: tapzero,
`t.equal(actual, expected, message)` assertions, ESM
imports with `.js` extensions.

**Verification:**
Run: `npm test`
Expected: All tests pass (existing 185 + new)

**Commit:** `test: add escalateEffort and DEFAULT_RETRIES tests`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
