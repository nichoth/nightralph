# Issue Tracker Choice -- Phase 2: Tests and Phase 2 Note

**Goal:** Update existing tests for the new `setup()` signature, add tests covering both tracker paths, and write a Phase 2 future work note documenting orchestrator GitHub support.

**Architecture:** Tests follow the existing tapzero pattern with temp directories. The `makeTempProject()` helper gains a `tracker` parameter and an additional template file for GitHub. A new markdown file documents Phase 2 scope (orchestrator changes) for future implementation.

**Tech Stack:** @substrate-system/tapzero, Node fs

**Scope:** 2 phases (this is phase 2 of 2)

**Codebase verified:** 2026-08-27

---

## Acceptance Criteria Coverage

This phase tests:

### issue-tracker-choice.AC1: Tracker choice prompt
- **issue-tracker-choice.AC1.2 Success:** Choosing "Local Markdown" installs the local markdown issue-tracker template to `docs/agents/issue-tracker.md`

### issue-tracker-choice.AC2: GitHub prerequisite check
- **issue-tracker-choice.AC2.3 Success:** If `gh` is authenticated, setup installs the GitHub issue-tracker template

### issue-tracker-choice.AC3: AGENTS.md reflects choice
- **issue-tracker-choice.AC3.1 Success:** After setup with Local Markdown, AGENTS.md issue tracker section says "local markdown files under `.scratch/`"
- **issue-tracker-choice.AC3.2 Success:** After setup with GitHub Issues, AGENTS.md issue tracker section says "GitHub Issues" with `gh` CLI reference

### issue-tracker-choice.AC4: Template installation
- **issue-tracker-choice.AC4.1 Success:** The correct `issue-tracker.md` is installed to `docs/agents/` based on tracker choice
- **issue-tracker-choice.AC4.2 Success:** Non-tracker templates (triage-labels.md, domain.md) are still installed with idempotency checks

---

## Phase 2: Tests and Phase 2 Note

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->

<!-- START_TASK_1 -->
### Task 1: Update `makeTempProject` helper and existing tests

**Verifies:** issue-tracker-choice.AC4.2

**Files:**
- Modify: `test/setup.test.ts:12-53` (makeTempProject helper)
- Modify: `test/setup.test.ts:55-77` (first test -- add tracker to setup call)
- Modify: `test/setup.test.ts:79-95` (second test -- add tracker to setup call)
- Modify: `test/setup.test.ts:97-145` (third test -- add tracker to setup call)
- Modify: `test/setup.test.ts:147-165` (fourth test -- update DOC_TEMPLATES assertion)
- Modify: `test/setup.test.ts:167-189` (fifth test -- add tracker, adjust for issue-tracker behavior change)
- Modify: `test/setup.test.ts:191-235` (sixth test -- add tracker)

**Implementation:**

1. **Update `makeTempProject`** -- add the GitHub tracker template to the temp `docsTemplatesDir`. Currently the helper creates template files for each entry in `DOC_TEMPLATES`. Since `issue-tracker.md` is no longer in `DOC_TEMPLATES`, the helper needs to create both tracker templates explicitly:
   ```typescript
   // After the DOC_TEMPLATES loop, add tracker templates:
   writeFileSync(
       join(docsTemplatesDir, 'issue-tracker.md'),
       '# Issue tracker: Local Markdown'
   )
   writeFileSync(
       join(docsTemplatesDir, 'issue-tracker-github.md'),
       '# Issue tracker: GitHub'
   )
   ```

2. **Update all existing `setup()` calls** -- add `tracker:'local'` to every existing test's `setup()` call to maintain backward compatibility. The `tracker` field is now required on `SetupOpts`.

3. **Update the DOC_TEMPLATES assertion** -- the fourth test (`setup creates docs/agents/ templates`) checks all `DOC_TEMPLATES` entries exist. Since `issue-tracker.md` is no longer in `DOC_TEMPLATES`, the test should verify `triage-labels.md` and `domain.md` via the `DOC_TEMPLATES` loop, then separately verify `issue-tracker.md` exists.

4. **Update the idempotency test** -- the "does not overwrite existing docs" test (fifth test) checks that `issue-tracker.md` is preserved. But with the new design, `issue-tracker.md` is always overwritten by the tracker choice. Update this test: the file SHOULD be overwritten (to allow tracker switching). Move the idempotency assertion to check `triage-labels.md` or `domain.md` instead, which are still preserved.

**Testing:**
Tests must verify:
- issue-tracker-choice.AC4.2: After updating, existing tests still pass -- `triage-labels.md` and `domain.md` are installed with idempotency checks

**Verification:**
Run: `npm test`
Expected: All existing tests pass (with updated assertions)

**Commit:** `test: update existing tests for tracker-aware setup`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add tests for local markdown tracker path

**Verifies:** issue-tracker-choice.AC1.2, issue-tracker-choice.AC4.1

**Files:**
- Modify: `test/setup.test.ts` (append new tests)

**Implementation:**

Add a test: `setup with tracker:'local' installs local issue-tracker.md`

This test should:
1. Call `makeTempProject()` to get temp dirs
2. Call `setup({..., tracker:'local'})`
3. Verify `docs/agents/issue-tracker.md` exists
4. Verify its content matches the local markdown template (starts with `# Issue tracker: Local Markdown`)

**Testing:**
Tests must verify:
- issue-tracker-choice.AC1.2: Local Markdown choice installs the local markdown template
- issue-tracker-choice.AC4.1: Installed content matches the source template

**Verification:**
Run: `npm test`
Expected: New test passes

**Commit:** `test: add local markdown tracker path test`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add tests for GitHub tracker path

**Verifies:** issue-tracker-choice.AC2.3, issue-tracker-choice.AC4.1

**Files:**
- Modify: `test/setup.test.ts` (append new tests)

**Implementation:**

Add a test: `setup with tracker:'github' installs github issue-tracker.md`

This test should:
1. Call `makeTempProject()` to get temp dirs
2. Call `setup({..., tracker:'github'})`
3. Verify `docs/agents/issue-tracker.md` exists
4. Verify its content matches the GitHub template (starts with `# Issue tracker: GitHub`)

**Testing:**
Tests must verify:
- issue-tracker-choice.AC2.3: GitHub choice installs the GitHub template
- issue-tracker-choice.AC4.1: Installed content matches the source template for the chosen tracker

**Verification:**
Run: `npm test`
Expected: New test passes

**Commit:** `test: add GitHub tracker path test`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add tests for AGENTS.md generation

**Verifies:** issue-tracker-choice.AC3.1, issue-tracker-choice.AC3.2

**Files:**
- Modify: `test/setup.test.ts` (append new tests)

**Implementation:**

Add two tests:

**Test A:** `setup with tracker:'local' writes AGENTS.md with local description`
1. Call `makeTempProject()` and `setup({..., tracker:'local'})`
2. Verify `AGENTS.md` exists in `projectDir`
3. Read content and verify it contains the string `local markdown files under \`.scratch/\``

**Test B:** `setup with tracker:'github' writes AGENTS.md with github description`
1. Call `makeTempProject()` and `setup({..., tracker:'github'})`
2. Verify `AGENTS.md` exists in `projectDir`
3. Read content and verify it contains the string `GitHub Issues`

**Testing:**
Tests must verify:
- issue-tracker-choice.AC3.1: Local setup produces AGENTS.md with local markdown description
- issue-tracker-choice.AC3.2: GitHub setup produces AGENTS.md with GitHub Issues description

**Verification:**
Run: `npm test`
Expected: Both new tests pass

**Commit:** `test: add AGENTS.md generation tests`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Write Phase 2 future work note

**Files:**
- Create: `docs/implementation-plans/2026-08-27-issue-tracker-choice/phase-2-future-work.md`

**Implementation:**

Create a markdown file documenting the scope and approach for Phase 2 -- orchestrator GitHub support. This is a planning document, not code.

The note should cover:

1. **Goal**: Enable `nightralph <provider>` to pull tickets from GitHub Issues instead of `.scratch/` when the project is configured for GitHub tracking.

2. **What changes in the orchestrator** (`src/orchestrator.ts`):
   - `scanTickets()` currently reads `.scratch/<feature>/issues/` for numbered markdown files. It needs a GitHub-aware variant that queries `gh issue list` with JSON output.
   - Status parsing: currently reads `Status:` lines from markdown. GitHub variant reads labels.
   - Blocker parsing: currently reads `Blocked by:` lines. GitHub variant queries issue dependencies via `gh api`.
   - Status update: currently writes `Status: done` to the file. GitHub variant runs `gh issue close`.

3. **How to detect which tracker is in use**: Read `docs/agents/issue-tracker.md` and check the title line (`# Issue tracker: GitHub` vs `# Issue tracker: Local Markdown`).

4. **New CLI surface**: The `--dir` and `--spec` flags assume local files. GitHub mode would use `--label` or `--milestone` to scope which issues to execute. The feature selection prompt (`resolveIssuesDir` in index.ts) would need a GitHub-aware variant.

5. **Testing considerations**: GitHub orchestrator tests would need either a test repo or mocked `gh` output. The existing wave-based execution model (parallel independent tickets, sequential blocked ones) stays the same -- only the I/O layer changes.

**Verification:**
Run: `cat docs/implementation-plans/2026-08-27-issue-tracker-choice/phase-2-future-work.md`
Expected: File exists with the documented scope

**Commit:** `docs: add Phase 2 future work note for orchestrator GitHub support`
<!-- END_TASK_5 -->
