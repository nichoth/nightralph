# PRD: Correctness Fixes

## Introduction

The 2026-08-29 correctness audit identified several defects that
prevent nightralph from working reliably when installed via npm,
from safely handling agent output, and from reporting failures
accurately. This PRD covers the P0 and P1 fixes, excluding
dependency validation semantics (intentional design) and Node
engine range (already fixed).

## Goals

- The CLI works correctly when installed via npm (not just from source)
- Agent work is never silently lost
- Progress commits never capture unrelated staged files
- Failed runs produce nonzero exit codes for CI/scripting
- Provider commands work non-interactively for claude and codex
- Setup preserves existing project instructions
- The README accurately describes current behavior

## User Stories

### US-001: Fix asset resolution for npm-installed CLI

**Description:** As a user installing nightralph via npm, I want the
`setup` command to find its bundled skills and templates so that
setup works without running from a source checkout.

**Acceptance Criteria:**
- [ ] Asset directory is derived from `import.meta.url` instead
      of `process.argv[1]`
- [ ] `setup` locates `skills/` and `docs-templates/` relative to
      the compiled module, not the bin symlink
- [ ] Existing tests still pass
- [ ] Typecheck/lint passes

### US-002: Verify agent commits before marking done

**Description:** As an operator, I want the orchestrator to verify
that an agent actually committed changes before merging and marking
a ticket done, so that work is never silently lost.

**Acceptance Criteria:**
- [ ] After an agent exits 0, the orchestrator checks whether the
      worktree branch has new commits relative to the base branch
- [ ] If no new commits exist, the ticket is NOT marked done and
      the worktree is NOT cleaned up
- [ ] If the worktree has uncommitted changes (dirty), the ticket
      is NOT marked done and the uncommitted state is reported
      to the console
- [ ] The in-place execution path (`runWaves`) checks for commits
      on the current branch before calling `markDone`
- [ ] Tests cover the no-commit and dirty-worktree scenarios
- [ ] Typecheck/lint passes

### US-003: Add non-interactive provider adapters

**Description:** As a user running `nightralph claude` or
`nightralph codex`, I want the CLI to invoke the correct
non-interactive command so that agents run without hanging on
interactive prompts.

**Acceptance Criteria:**
- [ ] `claude` provider spawns with `--print` flag
- [ ] `codex` provider spawns with `exec` subcommand
- [ ] Unknown providers are passed through as-is (current behavior)
- [ ] `--model` flag is still forwarded correctly for all providers
- [ ] Tests cover command construction for claude, codex, and an
      unknown provider
- [ ] Typecheck/lint passes

### US-004: Isolate progress commits

**Description:** As a user with staged changes in my repo, I want
progress commits to contain only the progress file so that my
staged work is not swept into an automated commit.

**Acceptance Criteria:**
- [ ] `commitProgress` commits only the progress file path, not
      the full index
- [ ] Existing staged files in the repo are untouched by the
      progress commit
- [ ] Tests verify that a pre-staged file is not included in the
      progress commit
- [ ] Typecheck/lint passes

### US-005: Return nonzero exit code for incomplete runs

**Description:** As a CI pipeline or monitoring script, I want
nightralph to exit with a nonzero status when any ticket fails
or remains incomplete so that I can detect failed runs.

**Acceptance Criteria:**
- [ ] `runWaves` and `runWavesIsolated` return a result indicating
      whether all ready tickets completed successfully
- [ ] The CLI calls `process.exit(1)` when any ready ticket failed,
      was not merged, or remains in `ready-for-agent` status
- [ ] Successful runs (all tickets done) exit 0
- [ ] Dry runs always exit 0
- [ ] Tests verify exit behavior for both success and failure cases
- [ ] Typecheck/lint passes

### US-006: Patch README inaccuracies

**Description:** As a user reading the README, I want the
documentation to match current behavior so that I can follow it
without hitting surprises.

**Acceptance Criteria:**
- [ ] The opening paragraph no longer claims the orchestrator reads
      "remote Github issues" -- it describes local markdown tickets
      only, and notes that choosing GitHub during setup installs
      GitHub-oriented skill instructions (not a remote issue source)
- [ ] Path references use `.agents/skills/` instead of
      `./claude/skills/` or `./agents.skills/`
- [ ] The flags table includes the `-X` flag
- [ ] Typecheck/lint passes

### US-007: Preserve existing AGENTS.md during setup

**Description:** As a user running setup in a project that already
has an AGENTS.md, I want my existing instructions preserved so that
setup does not silently destroy project-specific content.

**Acceptance Criteria:**
- [ ] Setup writes its content inside managed-section markers
      (e.g. `<!-- nightralph:start -->` / `<!-- nightralph:end -->`)
- [ ] If AGENTS.md exists and contains managed markers, only the
      managed section is replaced
- [ ] If AGENTS.md exists without markers, the managed section is
      appended and existing content is preserved
- [ ] If no AGENTS.md exists, the file is created with the managed
      section (current content wrapped in markers)
- [ ] Tests cover all three cases: no file, file without markers,
      file with markers
- [ ] Typecheck/lint passes

## Functional Requirements

- FR-1: Replace `dirname(process.argv[1])` with
  `dirname(fileURLToPath(import.meta.url))` in `src/index.ts`
- FR-2: After agent exit 0, compare the worktree branch HEAD against
  the base branch; skip merge if no new commits
- FR-3: After agent exit 0, check `git status --porcelain` in the
  worktree; report dirty state and skip merge
- FR-4: Map `claude` to `['claude', '--print']` and `codex` to
  `['codex', 'exec']` in `spawnAgent`; pass unknown providers as
  `[provider]`
- FR-5: Change `commitProgress` to use
  `git commit -- <progressPath>` so only the staged progress file
  is committed
- FR-6: `runWaves` and `runWavesIsolated` must return a boolean or
  status indicating whether the run fully succeeded
- FR-7: The CLI handler must call `process.exit(1)` on incomplete
  runs
- FR-8: Setup must read existing AGENTS.md, locate managed-section
  markers, and replace only the managed section (or append if
  no markers exist)

## Non-Goals

- Changing dependency validation semantics (the warn-and-remove
  behavior for unknown blockers is intentional)
- Changing the Node engine range (already fixed to `>=24`)
- Adding a GitHub Issues execution adapter (the README fix
  clarifies this is not supported, not adding it)
- Adding a resume/cleanup command for failed worktrees (P2)
- Trimming the npm package contents (P2)
- Fixing `generateProgress` to respect existing ticket status (P2)

## Technical Considerations

- `import.meta.url` returns a `file://` URL; use
  `fileURLToPath` from `node:url` to convert
- The commit-verification check in US-002 needs
  `git rev-list --count base..branch` or
  `git log base..branch --oneline`; both work from the
  main repo without entering the worktree
- Provider adapter logic in US-003 should stay in `spawnAgent`
  as a simple switch/map, not an external config system
- The `git commit -- <path>` form in US-005 commits only the
  named path from the index, leaving other staged files alone

## Success Metrics

- `npm pack && npm install -g ./nightralph-*.tgz && nightralph setup`
  works in a fresh project
- An agent that exits 0 without committing is reported as incomplete,
  not marked done
- `echo $?` after a failed run returns 1
- Progress commits never contain files other than `progress.md`
- `nightralph claude` spawns `claude --print` without hanging

## Open Questions

- Should US-002 also verify that the agent's commits touch files
  relevant to the ticket, or is "any new commit" sufficient?
- Should the managed-section markers in US-007 include a version
  or timestamp for auditability?
