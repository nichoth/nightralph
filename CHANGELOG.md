# Changelog

## 0.0.54

### Added

- **Integration branch.** A run launched from the default branch
  (`main`) no longer merges into it. nightralph creates
  `nightralph--<feature>` (`nightralph--all` for several features),
  merges every ticket there, and leaves you on that branch. Running
  again from `main` resumes the same branch, so finished tickets stay
  finished. After you merge the branch into `main`, the next run
  fast-forwards it and resumes. If the branch has commits of its own,
  the run logs how far behind `main` it is. If the resumed branch is
  missing the feature's tickets or spec, the run checks `main` back
  out, exits 2, and says how to fix it. A run launched from any
  other branch merges into that branch, as before.
- **Review pass.** After the last wave, an agent reviews everything
  merged since the previous review and writes its findings to
  `.scratch/<feature>/review.md` (`.scratch/review.md` for a
  multi-feature run). A second agent fixes the findings in its own
  worktree, and its work merges only when the test command passes.
  Findings it could not fix stay unchecked. The reviewer and fixer
  retry with escalating effort, like tickets. The review is advisory:
  a failure in it is logged and never fails the run. Pass
  `--no-review` to skip it.
- **Attempt learnings.** Each attempt at a ticket appends an entry to
  `.scratch/<feature>/learnings.md`, next to `progress.md`. An entry
  records the outcome, the agent's exit code, the checklist items it
  reported, the tail of a failed test or install log, and the agent's
  own notes. The prompt for a retry includes the ticket's recent
  entries and the last successful entry of each ticket that directly
  blocks it, so the agent can see why the previous attempt failed.
  Agents write their notes to `.nightralph/notes.md` in the worktree;
  a self-ignoring `.nightralph/.gitignore` keeps the file out of the
  agent's commits.
- **Provider check.** After it finds tickets, nightralph checks that
  the provider command exists and is executable before it touches
  git. A missing provider exits 2 without creating or checking out a
  branch. `--dry-run` prints a `Provider:` line instead and keeps
  going.
- README sections for requirements (Node 24+, git, macOS or Linux),
  worktree location, the integration branch and the review pass.

### Changed

- **No test command, no gate.** When `--test-cmd` is not given and
  `package.json` has no `test` script, the run now has no test gate
  and says so at startup. It used to fall back to `npm test`.
  `--test-cmd ""` now disables the gate; it used to fall back to
  `npm test` too. The agent prompt tells the agent the orchestrator
  runs no test command, and `--dry-run` prints `Test command: (none)`.
- **Error output.** An error from a command (for example a dirty
  working tree) prints one line to stderr and exits 2, with no help
  text or stack trace. Usage errors still print the help text and exit
  1.
- Ticket statuses marked `done` are committed after each wave, so a
  finished run leaves no uncommitted ticket files.

### Fixed

- A relative provider path (for example `./bin/agent`) is resolved
  against the launch directory. Worktrees run with their own working
  directory, so the relative path used to fail in every worktree.
- A provider given as a path that is not executable is reported as
  `not found or not executable` instead of `not found on PATH`.
- A spawn error, such as a missing agent binary, is written to the
  ticket log and the status display. It used to go only to the
  console, where the status display painted over it.

### Maintenance

- `prepublishOnly` runs the build and the test suite, so a stale
  `dist/` or a red suite cannot be published.
- `postversion` publishes before it pushes the version tag, so a
  failed publish no longer leaves a pushed tag behind.
