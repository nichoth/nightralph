# Issue Tracker Choice -- Human Test Plan

## Prerequisites

- Node.js installed; project built (`npm run build` produces `dist/`)
- `npm test` passes (66 assertions in setup.test.ts, 54 in
  orchestrator.test.ts)
- `gh` CLI installed and authenticated (`gh auth status` succeeds) for
  GitHub Issues tests
- A throwaway directory or git branch to avoid polluting a real project

## Phase 1: Interactive Prompt Verification (AC1.1)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open a terminal, `cd` to a clean temp directory | Working directory is empty or has a basic package.json |
| 2 | Run `node <path-to-nightralph>/dist/index.js setup` | An interactive prompt appears: "Issue tracker format" |
| 3 | Observe the choices listed | Two choices appear: "Local Markdown" (with description "Issues as .md files in .scratch/") and "GitHub Issues" (with description "Issues via gh CLI") |
| 4 | Press up/down arrow keys | Highlighted selection moves between the two choices |
| 5 | Highlight "Local Markdown" and press Enter | Prompt accepts the selection. Setup proceeds, printing "Installing skills to .agents/skills/" and listing installed files |
| 6 | Verify `docs/agents/issue-tracker.md` was created | File exists, content starts with the local markdown template heading |
| 7 | Verify `AGENTS.md` was created | File exists, contains "local markdown files under `.scratch/`" |

## Phase 2: GitHub Issues -- Authenticated Path (AC2.1, AC2.3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Confirm `gh auth status` succeeds (exit code 0) | Output shows authenticated user and active account |
| 2 | Remove any previous setup output (`rm -rf .agents docs AGENTS.md`) | Clean state |
| 3 | Run `node <path-to-nightralph>/dist/index.js setup` | Prompt appears |
| 4 | Select "GitHub Issues" and press Enter | No error message. Setup proceeds normally |
| 5 | Verify `docs/agents/issue-tracker.md` was created | File exists, content matches the GitHub template (heading references GitHub) |
| 6 | Verify `AGENTS.md` contains "GitHub Issues" and a reference to `gh` | The issue tracker section reads: "Issues are tracked via GitHub Issues using the `gh` CLI." |

## Phase 3: GitHub Issues -- Unauthenticated Path (AC2.2)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Make `gh auth status` fail. Option A: run `gh auth logout`. Option B: temporarily rename the `gh` binary (`which gh`, then `mv` it) | `gh auth status` now fails or `gh` is not found |
| 2 | Remove any previous setup output | Clean state |
| 3 | Run `node <path-to-nightralph>/dist/index.js setup` | Prompt appears |
| 4 | Select "GitHub Issues" and press Enter | Error message printed: "GitHub Issues requires the gh CLI, authenticated." followed by install/login instructions |
| 5 | Check exit code: `echo $?` | Exit code is `2` |
| 6 | Verify no `docs/agents/issue-tracker.md` was created | File does not exist -- setup aborted before template installation |
| 7 | Restore `gh` authentication (`gh auth login`) or rename the binary back | `gh auth status` succeeds again |

## End-to-End: Full Tracker Switching Scenario

**Purpose:** Validates that a user can set up with one tracker, then
re-run setup to switch to the other, and all artifacts reflect the new
choice.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Clean temp directory | Empty |
| 2 | Run `node <path>/dist/index.js setup`, select "Local Markdown" | Setup completes. `AGENTS.md` mentions local markdown, `issue-tracker.md` has local template content |
| 3 | Run `node <path>/dist/index.js setup` again, select "GitHub Issues" (requires authenticated `gh`) | Setup completes without error |
| 4 | Read `docs/agents/issue-tracker.md` | Content now matches the GitHub template -- local template content is gone |
| 5 | Read `AGENTS.md` | Now says "GitHub Issues using the `gh` CLI" -- no mention of "local markdown files" |
| 6 | Verify `docs/agents/triage-labels.md` and `docs/agents/domain.md` still exist | Non-tracker templates preserved across re-runs |

## End-to-End: --claude Flag with Tracker Choice

**Purpose:** Validates that the `--claude` flag works correctly alongside
tracker selection.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Clean temp directory | Empty |
| 2 | Run `node <path>/dist/index.js setup --claude`, select "Local Markdown" | Setup completes. Skills installed to both `.agents/skills/` and `.claude/skills/` |
| 3 | Verify `.claude/skills/<skill>` entries are symlinks | Each is a symlink pointing to `../../.agents/skills/<skill>` |
| 4 | Verify `docs/agents/issue-tracker.md` has local template content | Tracker choice unaffected by --claude flag |
| 5 | Run setup again with --claude, select "GitHub Issues" | Symlinks remain valid. `issue-tracker.md` now has GitHub content |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC1.1: Prompt displays two choices | Tests the interactive `@inquirer/prompts` `select` UI, which requires a real TTY. Mocking would test the mock, not the prompt. | Phase 1, steps 2-5 |
| AC2.1: CLI wiring calls `checkGhAuth` on "GitHub Issues" selection | The automated test confirms the function exists; the CLI handler glue (`index.ts` lines 46-55) is thin code best verified by running | Phase 2, steps 3-4 |
| AC2.2: Unauthenticated `gh` prints error and exits with code 2 | `process.exit(2)` lives in the CLI handler; testing requires a child process with inspected exit code | Phase 3, steps 4-5 |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1: Prompt with two choices | -- | Phase 1, steps 2-5 |
| AC1.2: Local Markdown installs local template | `setup with tracker:local copies local markdown template` | Phase 1, step 6 |
| AC2.1: checkGhAuth when authenticated | `checkGhAuth exists and is callable` (partial) | Phase 2, steps 3-4 |
| AC2.2: Unauthenticated exits with code 2 | -- | Phase 3, steps 4-6 |
| AC2.3: GitHub Issues installs GitHub template | `setup with tracker:github copies github template` | Phase 2, step 5 |
| AC3.1: AGENTS.md local markdown text | `setup creates AGENTS.md with local markdown text` | Phase 1, step 7 |
| AC3.2: AGENTS.md GitHub Issues text | `setup creates AGENTS.md with GitHub Issues text` | Phase 2, step 6 |
| AC4.1: Correct template per choice | AC1.2 + AC2.3 tests + tracker-switching test | Switching scenario, steps 2-5 |
| AC4.2: Non-tracker templates + idempotency | `setup creates docs/agents/ templates` + `setup does not overwrite non-tracker docs` + `setup is idempotent` | Switching scenario, step 6 |
