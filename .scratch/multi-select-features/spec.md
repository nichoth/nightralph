# Multi-Select Feature Checkbox UI

## Problem Statement

When the CLI starts, it prompts the user to choose a single
feature directory from `.scratch/`. If the user wants to work
on multiple features concurrently, they have to run separate
CLI sessions. There is no way to select several features and
have the orchestrator process all of their tickets together in
one run.

## Solution

Replace the single-select prompt with a checkbox interface
where the user moves up/down with arrow keys and toggles
features with spacebar. Selected features' tickets are merged
into a unified pool. The orchestrator runs them concurrently,
respecting intra-feature dependencies and the max concurrency
setting, exactly as it does today for a single feature.

## User Stories

1. As a developer, I want to select multiple feature
   directories at once, so that I can kick off one
   orchestrator run that processes all of them concurrently.

2. As a developer, I want a "Select all" option in the
   checkbox list, so that I can quickly select every
   available feature without toggling each one.

3. As a developer, I want to see how many tickets are ready
   in each feature (e.g. `auth (2/5 ready)`), so that I can
   make an informed selection.

4. As a developer, I want the finish summary to break down
   results per feature, so that I can see how each feature
   fared without digging into logs.

## Implementation Decisions

- **Prompt library**: use `checkbox` and `Separator` from
  `@inquirer/prompts` (already a dependency) in place of the
  current `select` call in `resolveIssuesDir`.

- **Auto-select**: when exactly 1 feature directory exists,
  skip the prompt and auto-select it (current behavior
  preserved).

- **Select-all**: a first-item "All" checkbox with a
  `Separator` below it. One-shot toggle -- checking it
  selects everything, after which each feature is
  independently toggled. No auto-sync between "All" and
  individual items.

- **Choice labels**: `<name> (<ready>/<total> ready)`,
  sorted alphabetically by name.

- **Validation**: empty selection re-prompts with "Select at
  least one feature" rather than exiting.

- **`--spec` flag**: unchanged, stays single-feature. It
  serves the non-interactive/scripted path.

- **Return type**: `resolveIssuesDir` returns an array of
  `{ dir, spec, name }` instead of a single
  `{ dir, spec }`.

- **Unified ticket pool**: tickets from all selected features
  are merged into one pool for wave computation. Since
  cross-feature tickets have no mutual dependencies, they
  naturally parallelize. The existing wave logic,
  concurrency bounds, retry/effort escalation, and merge
  strategy apply unchanged.

- **Ticket identity**: the `Ticket` type gains a `feature`
  field (the feature directory name). Identity becomes
  `feature + num` rather than `num` alone, so two features
  with the same ticket number do not collide.
  `findReadyTickets` and `setTicketStatus` use compound
  identity.

- **Branch naming**: `buildBranchName` always includes the
  feature name --
  `<repo>--<feature>-<num>-<slug>`. This is a
  breaking change from the current
  `<repo>--<num>-<slug>` format. Worktree
  directories follow suit:
  `<repo>.<feature>-<num>-<slug>`. No
  conditional logic -- always prefixed.

- **Prompt rendering**: `renderPrompt` receives the
  per-ticket spec body, not a single global one. The
  orchestrator looks up each ticket's feature to find the
  right `spec.md` content.

- **Progress tracking**: each feature keeps its own
  `progress.md`. The orchestrator updates the correct
  feature's progress file as tickets from that feature
  complete.

- **Display**: tickets appear as `feature/num` in the
  status UI (e.g. `auth/01`, `payments/03`).
  `DisplayTicket` carries enough info for this prefix.

- **Finish summary**: `renderFinishSummary` produces a
  combined total line followed by per-feature breakdowns
  when more than one feature was selected.

- **Dry-run**: `--dry-run` shows the unified wave plan
  across all selected features.

## Testing Decisions

Good tests for this feature exercise module boundaries
through their public interfaces. They verify observable
output (return values, rendered text, spawned branch names)
rather than internal state. They do not assert on specific
ANSI escape codes or exact whitespace in rendered output.

### Modules tested (all existing seams)

- **`resolveIssuesDir`** (`src/resolve.ts`) --
  multi-select flow, auto-select for 1 feature, select-all
  toggle, empty-selection validation, multi-return shape.
  Currently has no tests -- new test file needed.

- **`buildBranchName`** (`src/worktree.ts`) --
  feature-prefixed branch and worktree names. Extend
  existing tests (24 tests today).

- **`renderFinishSummary`** (`src/orchestrator.ts`) --
  per-feature breakdown format. Extend existing tests.

- **`findReadyTickets`** (`src/orchestrator.ts`) -- verify
  that tickets from multiple features with overlapping
  numbers resolve dependencies correctly (no cross-feature
  collision). Extend existing tests.

- **Display rendering** (`src/display.ts`) -- the
  `feature/num` prefix in status output. Extend existing
  tests (49 tests today).

### Prior art

All existing tests use `@substrate-system/tapzero`. Test
files live in `test/` and import from `../src/*.js`.
Orchestrator tests use filesystem fixtures for ticket
scanning. Display tests construct `DisplayTicket` objects
directly.

## Out of Scope

- Per-feature test commands (all features share the
  `--test-cmd` flag or auto-detected command).
- Cross-feature ticket dependencies (dependencies only exist
  within a single feature's ticket set).
- Per-feature concurrency limits (the `--concurrency` flag
  applies globally across the unified pool).
- Changes to the `--spec` flag (stays single-feature).
- Ticket-level selection within a feature (the wave logic
  handles ordering; skipping individual tickets risks
  breaking the dependency graph).

## Further Notes

The branch naming change
(`<repo>--<feature>-<num>-<slug>` replacing
`<repo>--<num>-<slug>`) is a breaking change.
Existing worktrees created under the old naming scheme will
not be recognized. This is acceptable because worktrees are
ephemeral -- they are created and removed within a single
run. Any leftover worktrees from a prior run would have been
cleaned up or can be removed manually with
`git worktree prune`.
