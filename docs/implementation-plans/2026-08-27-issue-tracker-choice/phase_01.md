# Issue Tracker Choice -- Implementation Plan

**Goal:** Add an inquirer prompt to `nightralph setup` that lets users choose between GitHub Issues and Local Markdown as their issue tracker, with `gh` prerequisite checking and correct template installation.

**Architecture:** The setup function gains a `tracker` field on `SetupOpts` (`'github' | 'local'`). The CLI handler in `index.ts` prompts for the choice via `@inquirer/prompts` `select`, runs `gh auth status` when GitHub is chosen, then passes the result to `setup()`. The `setup()` function copies the correct `issue-tracker*.md` template and writes an AGENTS.md that reflects the choice.

**Tech Stack:** TypeScript, yargs, @inquirer/prompts (already installed), Node child_process for `gh` CLI check

**Scope:** 2 phases from context bundle (phases 1-2)

**Codebase verified:** 2026-08-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### issue-tracker-choice.AC1: Tracker choice prompt
- **issue-tracker-choice.AC1.1 Success:** Running `nightralph setup` prompts user to choose between "GitHub Issues" and "Local Markdown"
- **issue-tracker-choice.AC1.2 Success:** Choosing "Local Markdown" installs the local markdown issue-tracker template to `docs/agents/issue-tracker.md`

### issue-tracker-choice.AC2: GitHub prerequisite check
- **issue-tracker-choice.AC2.1 Success:** Choosing "GitHub Issues" runs `gh auth status` and proceeds if authenticated
- **issue-tracker-choice.AC2.2 Failure:** If `gh` is not installed or not authenticated, setup prints a message and exits with code 2
- **issue-tracker-choice.AC2.3 Success:** If `gh` is authenticated, setup installs the GitHub issue-tracker template

### issue-tracker-choice.AC3: AGENTS.md reflects choice
- **issue-tracker-choice.AC3.1 Success:** After setup with Local Markdown, AGENTS.md issue tracker section says "local markdown files under `.scratch/`"
- **issue-tracker-choice.AC3.2 Success:** After setup with GitHub Issues, AGENTS.md issue tracker section says "GitHub Issues" with `gh` CLI reference

### issue-tracker-choice.AC4: Template installation
- **issue-tracker-choice.AC4.1 Success:** The correct `issue-tracker.md` is installed to `docs/agents/` based on tracker choice
- **issue-tracker-choice.AC4.2 Success:** Non-tracker templates (triage-labels.md, domain.md) are still installed with idempotency checks

---

## Phase 1: Setup Prompt, Template, and AGENTS.md

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create GitHub issue tracker template

**Files:**
- Create: `src/docs-templates/issue-tracker-github.md`

**Implementation:**

Create the GitHub issue tracker template at `src/docs-templates/issue-tracker-github.md`. Optionally reference the Matt Pocock template at `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md` for conventions (this path is machine-local and not a required input -- the template can be written from scratch using `gh` CLI documentation). Adapt to match nightralph's conventions (simpler, no GitLab, no PR triage surface).

The template should document:
- Title: `# Issue tracker: GitHub`
- How to create/read/list/comment/close issues via `gh` CLI
- How to apply and remove labels
- The "publish to issue tracker" instruction (create a GitHub issue)
- The "fetch the relevant ticket" instruction (`gh issue view`)
- Wayfinding operations using GitHub sub-issues or task lists
- Blocking via GitHub native issue dependencies
- Frontier query, claim (assign), and resolve (close) operations

The file is copied verbatim by the build system (`cp -r ./src/docs-templates/* ./dist/docs-templates`), so no build changes are needed.

**Verification:**
Run: `ls src/docs-templates/issue-tracker-github.md`
Expected: File exists

**Commit:** `feat: add GitHub issue tracker template`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Build and verify template is included

**Files:**
- None modified (build system verification)

**Verification:**
Run: `npm run build`
Expected: Build succeeds, `dist/docs-templates/issue-tracker-github.md` exists

Run: `ls dist/docs-templates/`
Expected: Shows `domain.md`, `issue-tracker-github.md`, `issue-tracker.md`, `triage-labels.md`

**Commit:** No commit needed -- build verification only.
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Add `checkGhAuth` function to setup.ts

**Verifies:** issue-tracker-choice.AC2.1, issue-tracker-choice.AC2.2

**Files:**
- Modify: `src/setup.ts:1-10` (add import for `execSync`)

**Implementation:**

Add a new exported function `checkGhAuth` to `src/setup.ts`. This function:
1. Calls `execSync('gh auth status', { stdio:'ignore' })` in a try/catch
2. Returns `true` if the command succeeds (exit 0)
3. Returns `false` if it throws (command not found or auth failure)

Keep it as a pure check -- no console output, no process.exit. The caller (`index.ts`) decides what to do with the result.

Add `execSync` to the imports from `node:child_process`.

**Testing:**
Tests must verify:
- issue-tracker-choice.AC2.1: `checkGhAuth` returns true when `gh` is authenticated
- issue-tracker-choice.AC2.2: `checkGhAuth` returns false when `gh` is not available

Note: this is a thin wrapper around exec. The function's behavior depends on the system state (`gh` installed/authenticated). Integration testing is appropriate -- unit tests with mocked exec would just test the mock. Testing guidance: verify the function exists and has the right signature; actual auth checking is tested via the CLI integration.

**Verification:**
Run: `npx tsc --noEmit`
Expected: No type errors

**Commit:** `feat: add checkGhAuth helper`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Refactor setup.ts for tracker-aware template copying

**Verifies:** issue-tracker-choice.AC1.2, issue-tracker-choice.AC2.3, issue-tracker-choice.AC4.1, issue-tracker-choice.AC4.2

**Files:**
- Modify: `src/setup.ts:12-21` (DOC_TEMPLATES constant)
- Modify: `src/setup.ts:23-28` (SetupOpts type)
- Modify: `src/setup.ts:80-103` (template copying section and end of function)

**Implementation:**

1. **Update `DOC_TEMPLATES`** -- remove `'issue-tracker.md'` from the array. It becomes tracker-specific and is handled separately. The constant becomes:
   ```typescript
   export const DOC_TEMPLATES = [
       'triage-labels.md',
       'domain.md',
   ] as const
   ```

2. **Add tracker type and update `SetupOpts`** -- add a string literal union type and a `tracker` field:
   ```typescript
   export type TrackerKind = 'github' | 'local'

   export type SetupOpts = {
       bundledSkillsDir:string
       docsTemplatesDir:string
       projectDir:string
       claude?:boolean
       tracker:TrackerKind
   }
   ```

3. **Add tracker template mapping** -- define which source template maps to which tracker choice:
   ```typescript
   const TRACKER_TEMPLATES:Record<TrackerKind, string> = {
       local:'issue-tracker.md',
       github:'issue-tracker-github.md',
   }
   ```

4. **Add tracker template copy logic** -- after the existing `DOC_TEMPLATES` loop (line 98), add logic to copy the tracker-specific template. The destination is always `issue-tracker.md` in `docs/agents/`. Unlike other templates, this one overwrites existing content (so re-running setup with a different tracker choice takes effect):
   ```typescript
   const trackerSrc = join(
       docsTemplatesDir, TRACKER_TEMPLATES[tracker]
   )
   const trackerDest = join(docsAgentsDir, 'issue-tracker.md')
   writeFileSync(trackerDest, readFileSync(trackerSrc, 'utf8'))
   console.log(
       `  docs/agents/issue-tracker.md (${tracker})`
   )
   ```

5. **Add AGENTS.md writing** -- after template copying, write AGENTS.md with tracker-appropriate content. AGENTS.md is fully regenerated on each setup run (not patched); any custom sections a user added will be overwritten. This is acceptable because the file is small and deterministic -- users who need custom content should edit it after setup. Define the issue tracker description based on the choice:
   ```typescript
   const trackerLine = tracker === 'github' ?
       'Issues are tracked via GitHub Issues using the `gh` CLI.' :
       'Issues are tracked as local markdown files under `.scratch/`.'

   const agentsMd = [
       '## Agent skills',
       '',
       '### Issue tracker',
       '',
       `${trackerLine} See \`docs/agents/issue-tracker.md\`.`,
       '',
       '### Triage labels',
       '',
       'Default label vocabulary. See `docs/agents/triage-labels.md`.',
       '',
       '### Domain docs',
       '',
       'Single-context layout. See `docs/agents/domain.md`.',
       '',
   ].join('\n')

   writeFileSync(join(projectDir, 'AGENTS.md'), agentsMd)
   console.log('\n  AGENTS.md (updated)')
   ```

**Testing:**
Tests must verify:
- issue-tracker-choice.AC1.2: `setup({..., tracker:'local'})` creates `docs/agents/issue-tracker.md` with local markdown content
- issue-tracker-choice.AC2.3: `setup({..., tracker:'github'})` creates `docs/agents/issue-tracker.md` with GitHub content
- issue-tracker-choice.AC4.1: The installed template content matches the source template for the chosen tracker
- issue-tracker-choice.AC4.2: `triage-labels.md` and `domain.md` are still installed with idempotency

**Verification:**
Run: `npx tsc --noEmit`
Expected: No type errors

**Commit:** `feat: tracker-aware template copying and AGENTS.md generation`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update index.ts with tracker prompt and gh check

**Verifies:** issue-tracker-choice.AC1.1, issue-tracker-choice.AC2.1, issue-tracker-choice.AC2.2, issue-tracker-choice.AC3.1, issue-tracker-choice.AC3.2

**Files:**
- Modify: `src/index.ts:7` (add `checkGhAuth` to setup import)
- Modify: `src/index.ts:8` (add `TrackerKind` type import)
- Modify: `src/index.ts:20-38` (setup command handler)

**Implementation:**

1. **Update imports** -- add `checkGhAuth` and `TrackerKind` to the import from `./setup.js`

2. **Make setup handler async** -- change the handler callback from sync to async

3. **Add tracker prompt** -- before calling `setup()`, prompt the user with `select`:
   ```typescript
   const tracker = await select<TrackerKind>({
       message:'Issue tracker format',
       choices:[
           {
               name:'Local Markdown',
               value:'local' as const,
               description:'Issues as .md files in .scratch/',
           },
           {
               name:'GitHub Issues',
               value:'github' as const,
               description:'Issues via gh CLI',
           },
       ],
   })
   ```

4. **Add gh auth check** -- if tracker is `'github'`, call `checkGhAuth()`. If it returns false, print a message and exit:
   ```typescript
   if (tracker === 'github') {
       if (!checkGhAuth()) {
           console.error(
               'GitHub Issues requires the gh CLI, ' +
               'authenticated.\n' +
               'Install: https://cli.github.com\n' +
               'Then run: gh auth login'
           )
           process.exit(2)
       }
   }
   ```

5. **Pass tracker to setup** -- add `tracker` to the options object passed to `setup()`

**Testing:**
Tests must verify:
- issue-tracker-choice.AC1.1: The prompt is presented (this is an integration concern -- verified by running the CLI)
- issue-tracker-choice.AC2.1: GitHub path calls `checkGhAuth`
- issue-tracker-choice.AC2.2: Setup exits with code 2 when gh is not authenticated

Note: The CLI handler is thin glue -- its behavior is best tested via the unit tests on `setup()` and `checkGhAuth()` individually, plus a manual run of the CLI.

**Verification:**
Run: `npm run build`
Expected: Build succeeds

Run: `node dist/index.js setup --help`
Expected: Shows setup command help (the `--claude` flag)

**Commit:** `feat: add tracker choice prompt to setup command`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

---

**Note:** After completing Phase 1, `npm test` will fail because existing tests call `setup()` without the new required `tracker` field. This is expected. Phase 2 Task 1 updates all existing test calls. Use `npx tsc --noEmit` and `npm run build` to verify Phase 1 correctness.
