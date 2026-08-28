# Test Requirements: Issue Tracker Choice

Maps each acceptance criterion to automated tests or documented human
verification.

---

## AC1: Tracker choice prompt

### AC1.1: Running `nightralph setup` prompts user to choose between "GitHub Issues" and "Local Markdown"

**Verification:** Human

**Justification:** The prompt is rendered by `@inquirer/prompts` `select`
inside the CLI handler (`index.ts`). Testing it automatically would
require either spawning the CLI as a child process with piped stdin or
mocking inquirer -- both approaches test the scaffolding rather than the
actual user-facing prompt. The implementation plan notes this is "an
integration concern -- verified by running the CLI."

**Approach:**
1. Run `node dist/index.js setup` in a terminal
2. Verify the prompt displays "Issue tracker format" with two choices:
   "Local Markdown" and "GitHub Issues"
3. Verify arrow-key selection works and the chosen value is accepted

---

### AC1.2: Choosing "Local Markdown" installs the local markdown issue-tracker template

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Test name:** `setup with tracker:'local' installs local issue-tracker.md`
- **Assertions:**
  1. Call `setup({..., tracker:'local'})` with temp project dirs
  2. Assert `docs/agents/issue-tracker.md` exists in the project dir
  3. Assert its content matches the local template source
     (starts with `# Issue tracker: Local Markdown` or equivalent
     heading from `src/docs-templates/issue-tracker.md`)

---

## AC2: GitHub prerequisite check

### AC2.1: Choosing "GitHub Issues" runs `gh auth status` and proceeds if authenticated

**Verification:** Automated test (function existence) + Human (CLI wiring)

- **Test type:** Unit
- **File:** `test/setup.test.ts`
- **Test name:** `checkGhAuth returns true when gh is authenticated`
- **Assertions:**
  1. Import `checkGhAuth` from `../src/setup.js`
  2. Call `checkGhAuth()` -- on a machine where `gh` is installed and
     authenticated, assert it returns `true`

**Human verification (CLI wiring):**

The CLI handler in `index.ts` calls `checkGhAuth()` when the user
selects "GitHub Issues." This wiring is thin glue code. Verifying it
end-to-end requires running the CLI interactively.

**Approach:**
1. Ensure `gh auth status` succeeds on the test machine
2. Run `node dist/index.js setup`, choose "GitHub Issues"
3. Verify setup proceeds without error and installs the GitHub template

**Note:** `checkGhAuth` is a thin wrapper around `execSync('gh auth status')`.
The implementation plan explicitly says "unit tests with mocked exec
would just test the mock." The automated test above is conditional on
the test machine having `gh` installed. On CI without `gh`, this test
should be skipped or the AC verified by human run.

---

### AC2.2: If `gh` is not installed or not authenticated, setup prints a message and exits with code 2

**Verification:** Human

**Justification:** The exit-with-code-2 behavior lives in `index.ts`
(the CLI handler), not in the `setup()` function. Testing `process.exit`
requires spawning a child process and inspecting its exit code. The
implementation plan describes this handler as "thin glue" best verified
by unit tests on the underlying functions plus a manual CLI run.

**Approach:**
1. Temporarily make `gh auth status` fail (e.g., `gh auth logout` or
   rename `gh` binary)
2. Run `node dist/index.js setup`, choose "GitHub Issues"
3. Verify the output includes "GitHub Issues requires the gh CLI"
4. Verify the process exits with code 2 (`echo $?` shows `2`)
5. Restore `gh` auth afterward

---

### AC2.3: If `gh` is authenticated, setup installs the GitHub issue-tracker template

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Test name:** `setup with tracker:'github' installs github issue-tracker.md`
- **Assertions:**
  1. Call `setup({..., tracker:'github'})` with temp project dirs
     (the helper provides both `issue-tracker.md` and
     `issue-tracker-github.md` in the temp templates dir)
  2. Assert `docs/agents/issue-tracker.md` exists in the project dir
  3. Assert its content matches the GitHub template source
     (starts with `# Issue tracker: GitHub` or equivalent heading
     from `src/docs-templates/issue-tracker-github.md`)

---

## AC3: AGENTS.md reflects choice

### AC3.1: After setup with Local Markdown, AGENTS.md says "local markdown files under `.scratch/`"

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Test name:** `setup with tracker:'local' writes AGENTS.md with local description`
- **Assertions:**
  1. Call `setup({..., tracker:'local'})` with temp project dirs
  2. Assert `AGENTS.md` exists in the project dir
  3. Read its content and assert it contains the substring
     `local markdown files under \`.scratch/\``

---

### AC3.2: After setup with GitHub Issues, AGENTS.md says "GitHub Issues" with `gh` CLI reference

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Test name:** `setup with tracker:'github' writes AGENTS.md with github description`
- **Assertions:**
  1. Call `setup({..., tracker:'github'})` with temp project dirs
  2. Assert `AGENTS.md` exists in the project dir
  3. Read its content and assert it contains the substring
     `GitHub Issues` and a reference to `gh`

---

## AC4: Template installation

### AC4.1: The correct `issue-tracker.md` is installed to `docs/agents/` based on tracker choice

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Covered by:** The AC1.2 and AC2.3 tests above (local and GitHub
  tracker path tests). Each verifies that `docs/agents/issue-tracker.md`
  receives the content from the correct source template. No separate
  test needed -- the two tracker-path tests together cover this criterion
  exhaustively.

---

### AC4.2: Non-tracker templates (triage-labels.md, domain.md) are still installed with idempotency checks

**Verification:** Automated test

- **Test type:** Integration
- **File:** `test/setup.test.ts`
- **Covered by:** Two existing tests, updated to pass `tracker:'local'`:
  1. `setup creates docs/agents/ templates` -- iterates `DOC_TEMPLATES`
     (now `['triage-labels.md', 'domain.md']`) and asserts each exists.
     Also separately asserts `issue-tracker.md` exists.
  2. `setup does not overwrite existing docs` -- pre-creates
     `triage-labels.md` (or `domain.md`) with custom content, runs
     setup, asserts the custom content is preserved. (The old test
     checked `issue-tracker.md` for idempotency, but that file is now
     always overwritten by tracker choice. The assertion moves to a
     non-tracker template.)
  3. `setup is idempotent` -- runs setup twice, asserts all templates
     still exist after the second run.

---

## Summary

| AC    | Automated | Human | Test file              |
|-------|-----------|-------|------------------------|
| AC1.1 |           | Yes   | --                     |
| AC1.2 | Yes       |       | `test/setup.test.ts`   |
| AC2.1 | Partial   | Yes   | `test/setup.test.ts`   |
| AC2.2 |           | Yes   | --                     |
| AC2.3 | Yes       |       | `test/setup.test.ts`   |
| AC3.1 | Yes       |       | `test/setup.test.ts`   |
| AC3.2 | Yes       |       | `test/setup.test.ts`   |
| AC4.1 | Yes       |       | `test/setup.test.ts`   |
| AC4.2 | Yes       |       | `test/setup.test.ts`   |

Seven of ten acceptance criteria are fully covered by automated
integration tests. AC2.1 has partial automated coverage (function
existence and return value) with human verification for CLI wiring.
AC1.1 and AC2.2 require human verification because they test interactive
CLI behavior and process exit codes in the thin handler layer.
