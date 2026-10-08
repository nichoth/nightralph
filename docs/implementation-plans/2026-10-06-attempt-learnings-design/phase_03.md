# Attempt Learnings Implementation Plan -- Phase 3: Prompt changes

**Goal:** `renderPrompt` carries the attempt history and tells the agent
to keep a notes file, separates AGENTS.md patterns from ticket notes,
and allows skipping test-first for scaffolding, config, or docs items.

**Architecture:** `renderPrompt` gains an optional `history` string,
rendered between the TICKET section and AGENT INSTRUCTIONS. The rule
list in `renderPrompt` is edited in place. No orchestration changes yet;
callers keep working without passing `history`.

**Tech Stack:** TypeScript (ESM), `@substrate-system/tapzero`.

**Scope:** Phase 3 of 5 from
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md`.

**Codebase verified:** 2026-10-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### attempt-learnings-design.AC4: The prompt carries history
- **attempt-learnings-design.AC4.1 Success:** A history string passed
  to `renderPrompt` appears in the prompt.
- **attempt-learnings-design.AC4.2 Edge:** A prompt rendered with no
  history equals one rendered with `history:''`.
- **attempt-learnings-design.AC4.3 Human:** The prompt tells the agent
  to keep `.nightralph/notes.md` current and never commit it, splits
  reusable patterns (AGENTS.md) from ticket notes, and allows skipping
  test-first for pure scaffolding, config, or docs items.

---

Conventions: same as Phase 1.

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `history` option and new instructions

**Verifies:** attempt-learnings-design.AC4.3 (by reading the rendered
prompt)

**Files:**
- Modify: `src/orchestrator.ts:471-543` (`renderPrompt`)
- Modify: `src/orchestrator.ts:16-52` (imports) -- add
  `import { NOTES_PATH } from './learnings.js'`

**Implementation:**

1. Signature (`src/orchestrator.ts:471-475`):
   ```ts
   export function renderPrompt (
       specBody:string,
       ticket:Ticket,
       opts:{
           testCmd:string
           installCmd?:string
           history?:string
       }
   ):string
   ```
2. After `ticket.body,` and its blank line (`src/orchestrator.ts:482`),
   before `'---- AGENT INSTRUCTIONS ----'` (line 484), spread
   `...historyBlock(opts.history)`, where a new helper next to
   `installRule` (`src/orchestrator.ts:459-469`) returns `[]` when the
   history is empty or undefined, else `[history, '']`:
   ```ts
   function historyBlock (history?:string):string[] {
       if (!history) return []
       return [history, '']
   }
   ```
   With no history, the history block adds nothing (no extra lines),
   which is the property AC4.2 tests.
3. /tdd rule (`src/orchestrator.ts:501-506`): append an exception
   sentence: for a checklist item that is pure scaffolding, config, or
   docs, where a test adds no value, skip test-first and say so in your
   notes file. Keep the existing words `/tdd` and `Testing Decisions`
   (asserted by `test/orchestrator.test.ts:1604`).
4. INTEGRITY rule (`src/orchestrator.ts:517-522`): change the ending to
   "leave it unchecked and record what blocked you in your notes
   file." Keep the words `weaken` and `leave it unchecked` (asserted by
   `test/orchestrator.test.ts:1768`).
5. Commit rule ("Commit after each checklist item, and make sure
   everything is committed when finished."): add "except your notes
   file" so it does not contradict the notes rule. Keep the phrase
   `Commit after each checklist item` intact (asserted, lowercased, by
   `test/orchestrator.test.ts:1804-1818`).
6. New rule, placed right after the commit rule, built from
   `NOTES_PATH` (not a hard-coded path):
   ```ts
   `- Keep notes for this attempt in \`${NOTES_PATH}\` ` +
       '(create the directory). Update it after each ' +
       'checklist item and as soon as you hit a ' +
       'blocker, not only at the end. Record what you ' +
       'implemented, files changed, how you read any ' +
       'vague acceptance criteria, what blocked you, and ' +
       'anything the next attempt at this ticket should ' +
       'know. Never commit, git add, or delete this ' +
       'file; the orchestrator collects it.',
   ```
7. AGENTS.md rule (`src/orchestrator.ts:531-541`): append one sentence:
   reusable patterns go in AGENTS.md; anything specific to this ticket
   goes in your notes file.

Keep every string line at most 80 columns, matching the surrounding
`'...' +` continuation style.

**Verification:**
Run: `npm run build`
Expected: builds (Phase 1 added `src/learnings.ts` to the per-module
esbuild list, so `dist/orchestrator.js` can import it)

AC4.3 human check: print a rendered prompt and read the instructions
for the three points in AC4.3:

```bash
node --input-type=module -e "
import { renderPrompt } from './dist/orchestrator.js'
console.log(renderPrompt('spec', {
    num:1, slug:'x', filename:'01-x.md', filepath:'',
    body:'- [ ] item', status:'ready-for-agent',
    blockers:[], feature:'f',
}, { testCmd:'npm test' }))
"
```

**Commit:** none yet (committed with Task 2)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `renderPrompt` unit tests

**Verifies:** attempt-learnings-design.AC4.1,
attempt-learnings-design.AC4.2

**Files:**
- Modify: `test/orchestrator.test.ts` (unit), next to the existing
  `renderPrompt` tests at `test/orchestrator.test.ts:1549-1810`; reuse
  the `makeTicket` helper those tests use.

**Testing:**
- AC4.1: a history string containing a `randomUUID()` token is passed
  as `history`; the prompt includes the token. The token appears after
  the ticket body and before `AGENT INSTRUCTIONS` (compare
  `indexOf` positions; the section marker string is already asserted
  by the existing test at line 1551).
- AC4.2: `renderPrompt(spec, ticket, { testCmd })` equals
  `renderPrompt(spec, ticket, { testCmd, history:'' })` (`t.equal`).
- The prompt includes `NOTES_PATH` (imported from
  `src/learnings.ts`), following the existing pattern of checking that
  named files and commands appear (e.g. the `AGENTS.md` test at line
  1750). This ties the prompt to the path `collectNotes` reads.

**Verification:**
Run: `npm test`
Expected: all suites pass, including the existing `renderPrompt` tests

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output (no type errors)

Run:
`npx tsc --noEmit -p . 2>&1 | grep 'error TS' | grep -c orchestrator.test`
Expected: `8` (the pre-existing count in that file, unchanged; the new
tests add no type errors)

Run: `npm run lint`
Expected: no errors

**Commit:**
```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(prompt): attempt history and notes-file instructions"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
