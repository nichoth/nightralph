# Prefer Subagent Implementation Plan

**Goal:** All four agent prompts carry a delegation rule when a
subagent model is set, and are byte-identical to today otherwise.

**Architecture:** `subagentRule(preferSubagent?, readOnly?)` in
`src/rules.ts` returns `string[]`, empty when unset, following
`installRule`. Each prompt builder takes `preferSubagent?` and
spreads the lines right after its `installRule(...)` spread (or, for
the reviewer, after its "You may run the tests" rule).

**Tech Stack:** TypeScript, tapzero

**Scope:** Phase 3 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

This phase implements and tests:

### prefer-subagent.AC2: Prompt rule
- **prefer-subagent.AC2.1 Success:** `renderPrompt`,
  `renderMergePrompt`, `renderFixPrompt` and `renderReviewPrompt` are
  identical to today's output when the option is unset
- **prefer-subagent.AC2.2 Success:** when set, each prompt includes
  the lines `subagentRule` returns
- **prefer-subagent.AC2.3 Success:** the reviewer prompt gets the
  read-only variant, without the edit/commit line
- **prefer-subagent.AC2.4 Edge:** `subagentRule('')` and
  `subagentRule()` return `[]`

**Deviation from the design:** the design writes
`subagentRule(preferSubagent?, opts?)` with `opts.readOnly`. This
plan uses a positional `readOnly = false` boolean instead, because
every function in `src/rules.ts` takes positional arguments. The
reviewer calls `subagentRule(opts.preferSubagent, true)`. Phase 6
documents this form.

---

## Codebase notes for the executor

- `src/rules.ts` (99 lines): every function takes positional string
  arguments and returns a `string` or `string[]`. `installRule
  (installCmd?:string):string[]` at lines 17-28 is the model. Imports
  only `NOTES_PATH` from `./learnings.js`.
- `src/orchestrator.ts:519-571` `renderPrompt(specBody, ticket,
  opts:{ testCmd; installCmd?; history? })`: rules-based;
  `...installRule(opts.installCmd)` sits after the "Do NOT research
  external APIs" line.
- `src/orchestrator.ts:573-610` `renderMergePrompt(specBody, ticket,
  opts:{ installCmd? } = {})`: inline text, not rules-based;
  `...installRule(opts.installCmd)` sits after "Do NOT re-implement
  the ticket from scratch.".
- `src/review.ts:158-199` `renderFixPrompt(opts:{ specBody; findings;
  testCmd; installCmd?; previous? })`: rules-based,
  `...installRule(opts.installCmd)` after the "Fix ONLY the listed
  findings" line.
- `src/review.ts:77-121` `renderReviewPrompt(opts:{ specBody; from;
  to; exclude? })`: inline bullets; contains "- You may run the tests
  or the type checker to confirm a suspicion." followed by "- Do NOT
  edit, stage, or commit code...". The reviewer never edits.
- Existing prompt tests use `prompt.includes(...)`:
  `test/orchestrator.test.ts:1551` (`-- renderPrompt --`),
  `renderMergePrompt` checks at ~1741-1768, `test/review.test.ts:216`
  (`renderReviewPrompt`) and `:234` (`renderFixPrompt`).
- The user forbids brittle tests that pin literal prose. Assert
  against `subagentRule(...)`'s own output and against prompt
  equality, never against hand-typed rule sentences.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: `subagentRule`

**Verifies:** prefer-subagent.AC2.4 (tested in Task 3)

**Files:**
- Modify: `src/rules.ts` (add after `installRule`, ~line 29)

**Implementation:**

```ts
// The delegation rule for agents whose subagents default to a
// cheaper model (CLAUDE_CODE_SUBAGENT_MODEL). Empty without one.
// `readOnly` drops the edit/commit line, for the reviewer, which
// never edits.
export function subagentRule (
    preferSubagent?:string,
    readOnly = false
):string[] {
    if (!preferSubagent) return []
    return [
        '- Hand read-only work to subagents: exploring the ' +
            'codebase, searching code, and experiments or test ' +
            'runs whose output would flood your context. ' +
            `Subagents default to the ${preferSubagent} model.`,
        '- A subagent starts with no context. Brief each one ' +
            'with the objective, what you already know, its ' +
            'boundaries, and the reply you expect (file:line ' +
            'references, or pass/fail with the relevant output).',
        ...(readOnly ? [] : [
            '- Subagents never edit files or run git commands ' +
                'that write. You make every edit and every commit.',
        ]),
        '- Do not delegate a lookup that takes a single tool call.',
    ]
}
```

**Verification:** `npm run build` succeeds.

**Commit:** with Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Thread `preferSubagent` into the four prompt builders

**Verifies:** prefer-subagent.AC2.1, AC2.2, AC2.3 (tested in Task 3)

**Files:**
- Modify: `src/orchestrator.ts:519-571` (`renderPrompt`)
- Modify: `src/orchestrator.ts:573-610` (`renderMergePrompt`)
- Modify: `src/review.ts:77-121` (`renderReviewPrompt`)
- Modify: `src/review.ts:158-199` (`renderFixPrompt`)
- Modify: the `./rules.js` import lists in both files

**Implementation:**

- `renderPrompt`: add `preferSubagent?:string` to `opts`; spread
  `...subagentRule(opts.preferSubagent)` directly after
  `...installRule(opts.installCmd)`.
- `renderMergePrompt`: change `opts` to
  `{ installCmd?:string; preferSubagent?:string } = {}`; spread
  `...subagentRule(opts.preferSubagent)` directly after
  `...installRule(opts.installCmd)`.
- `renderFixPrompt`: add `preferSubagent?:string` to `opts`; spread
  `...subagentRule(opts.preferSubagent)` directly after
  `...installRule(opts.installCmd)`.
- `renderReviewPrompt`: add `preferSubagent?:string` to `opts`;
  spread `...subagentRule(opts.preferSubagent, true)` directly after
  the "- You may run the tests or the type checker..." line.

No caller passes the option yet (Phase 4 does), so every prompt is
unchanged at runtime.

**Verification:** `npm run build` succeeds.

**Commit:**

```bash
git add src/rules.ts src/orchestrator.ts src/review.ts
git commit -m "feat: add subagent delegation prompt rule"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Prompt rule tests

**Verifies:** prefer-subagent.AC2.1, AC2.2, AC2.3, AC2.4

**Files:**
- Modify: `test/orchestrator.test.ts` (unit; `subagentRule`,
  `renderPrompt`, `renderMergePrompt`, near the `-- renderPrompt --`
  section at ~1551)
- Modify: `test/review.test.ts` (unit; `renderReviewPrompt` and
  `renderFixPrompt`, near lines 216 and 234)

**Testing:**

Tests must verify each AC:
- AC2.4: `subagentRule('')` and `subagentRule()` deep-equal `[]`;
  `subagentRule('haiku')` is non-empty and every element starts with
  `'- '`; `subagentRule('haiku', true)` has exactly one fewer line
  than `subagentRule('haiku')` and every one of its lines appears in
  the full variant.
- AC2.1: for each builder, the prompt rendered with the option
  omitted is `===` the prompt rendered with `preferSubagent:''` and
  with `preferSubagent:undefined`, and contains none of the lines of
  `subagentRule('haiku')`.
- AC2.2: for `renderPrompt`, `renderMergePrompt` and
  `renderFixPrompt` with `preferSubagent:'haiku'`, every line of
  `subagentRule('haiku')` is included in the prompt.
- AC2.3: `renderReviewPrompt` with `preferSubagent:'haiku'` includes
  every line of `subagentRule('haiku', true)`, and does not include
  the one line of `subagentRule('haiku')` that is missing from the
  read-only variant (compute it as the set difference).

Follow project testing patterns. The executor writes the test code.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`
Expected: no errors.

**Commit:** `test: cover subagent prompt rule`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
