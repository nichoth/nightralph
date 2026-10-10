# nightralph

Last verified: 2026-10-10

Small orchestrator that runs a single-agent session per issue. It
loads tickets from `.scratch/<feature>/issues/`, runs the ready ones
in waves (one git worktree and branch per ticket), gates each branch
on the test command, merges the wave, and ends with a review and fix
pass. A run launched from the default branch works on an integration
branch, `nightralph--<feature>`; launched from any other branch it
merges into that branch.

## Tech Stack
- TypeScript, Node >= 24, ESM
- CLI: yargs + @inquirer/prompts
- Testing: @substrate-system/tapzero

## Commands
- `npm run build` -- build to dist/
- `npm test` -- bundles the suites listed in `scripts/test.sh`
  into `dist/test` and runs them. It does not rebuild `dist/`:
  the CLI subprocess and setup tests in
  `test/integration.test.ts` run `dist/index.js` and read
  `dist/skills` and `dist/docs-templates`, so run
  `npm run build` first when `src/` changed. The script gives
  the run a private `TMPDIR` and deletes it (plus any
  `mock-change-*.txt` in the repo root) when the run ends, pass
  or fail
- `npm run lint` -- eslint
- Both file lists are explicit: a new `src/` module must be
  added to the second esbuild call in `build-esm`
  (`package.json`) or no standalone `dist/<name>.js` is
  emitted (the CLI bundle still inlines it), and a new
  `test/<name>.test.ts` must be added to `TESTS` in
  `scripts/test.sh` or it never runs
- CLI subprocess tests in `test/integration.test.ts` use
  `spawnCli(args, { cwd?, env?, closeStdin? })`, which runs
  `dist/index.js` with a 30s timeout. stdin stays open unless
  `closeStdin:true`, so a run that reaches the interactive
  feature picker waits until the timeout; closing stdin makes
  the prompt reject, which the `.fail()` handler turns into
  exit 2
- Fake claude: `test/fake-claude/claude` is a `sh` wrapper
  around `test/mock-agent-claude.js`; its basename makes
  `spawnAgent` take the claude branch. `FAKE_CLAUDE_*` env vars
  drive it; the mock reads each one. Tests clear and
  restore these through an explicit key list
  (`FAKE_CLAUDE_KEYS` in `test/integration.test.ts`,
  `FAKE_ENV_KEYS` in `test/orchestrator.test.ts`, `ENV_KEYS`
  in `test/review-integration.test.ts`), so a test that sets a
  new key must add it to its file's list
- `npm version` -- `postversion` publishes, and `prepublishOnly`
  builds and tests first, so a red suite leaves the version
  commit and tag local

## Project Structure
- `src/index.ts` -- CLI entry point (yargs commands), signal
  handling, integration branch setup
- `src/setup.ts` -- `nightralph init` scaffolding
- `src/orchestrator.ts` -- ticket scanning, prompts, agent
  spawning and wave execution
- `src/worktree.ts` -- git worktrees, integration branch planning
- `src/merge.ts` -- merging a wave's branches
- `src/progress.ts` -- per-feature `progress.md`
- `src/learnings.ts` -- per-attempt `learnings.md` log and the
  agent's notes file
- `src/review.ts` -- review log, reviewer, fixer, review pass
- `src/retry.ts` -- shared retry loop and effort ladders
- `src/rules.ts` -- prompt rule lines shared by every prompt
- `src/stats.ts` -- subagent counts and cost from claude
  stream-json
- `src/display.ts` -- terminal status UI (`StatusDisplay`,
  `PlainDisplay`)
- `src/testcmd.ts` -- test and install command detection and
  execution
- `src/preflight.ts` -- provider executable lookup
- `src/resolve.ts` -- feature discovery, the picker, and
  `loadSelection`, the one ticket loader
- `src/blockers.ts` -- `**Blocked by:**` parsing and resolution
- `src/graph.ts` -- cross-feature waits: the `graph` command's
  suggestion and the picker's `waits on` label
- `src/skills/` -- bundled skill definitions
- `src/docs-templates/` -- doc templates copied to target projects

## Invariants

Rules that span modules and that no single file announces. For
signatures, defaults and per-function behaviour, read the code and
its tests.

### Git and the working tree
- A run creates or checks out nothing until it is worth starting:
  the zero-ready stop, the provider preflight and the dirty-tree
  check all come before `prepareIntegrationBranch`.
- An integration branch with commits of its own is never merged
  into or rebased; it is only fast-forwarded, and only when it is
  an ancestor of the launch branch.
- Every worktree create, worktree remove and branch delete runs on
  `worktreeQueue` in `src/worktree.ts`, so concurrent tickets
  cannot race on `.git/worktrees`. New worktree operations join
  that queue.
- Ignore rules are written inside the worktree
  (`.nightralph/.gitignore`), never to `.git/info/exclude`, which
  can be a symlink shared by every repo on the machine (via
  `init.templateDir`). Tests that need a repo use a hermetic
  `git init --template=<tmp>`.
- The base tree has no modified tracked files before a merge:
  ticket statuses, `progress.md`, `learnings.md` and `review.md`
  are committed at every terminal point (with `git add --force`,
  since `.scratch/` may be ignored).
- Agents stay inside their worktree and never `git push`; the
  prompt rules in `src/rules.ts` say so.
- `nightralph graph` is read-only: no git, no provider preflight,
  no writes. It reads the checkout in place.

### Processes
- Agents and test commands run in their own process group and
  are tracked (`runningAgents`, or the `registry` set handed to
  `runTestCmd` and the review pass), so the CLI's signal handler
  kills them all through `killProcessGroup`. Anything new that
  spawns joins that tracking. Signal handlers live only in
  `src/index.ts`.
- While a run is on screen, output goes through `display.log` or
  an `onLine` callback; `StatusDisplay` repaints over bare
  `console` output.

### Outcomes
- A timed-out agent is not a failure: its worktree is kept, dirty
  changes are auto-committed, and the branch goes through the
  test gate and merge like an exit 0. Timeouts are not retried.
- A throw inside one ticket attempt fails that ticket, never the
  wave. Every terminal failure is recorded in `progress.md` with
  `done:false`.
- Learnings, the review pass and stats are advisory: their errors
  are logged through the display and never change a ticket
  outcome, a retry decision, `allDone` or the exit code.
- Exit codes: 0 when every ticket finished or nothing was ready, 1
  when tickets were left unfinished or on a usage error (with help
  text), 2 on a runtime error (`formatErrorMessage`, no stack).

### Tickets and prompts
- Tickets are identified by `ticketKey(feature, num)` in every map
  and set, since numbers repeat across features.
- `blockerSatisfied` is the one readiness check; ready tickets,
  dry-run waves (`simulateRun`), deadlock detection and the `graph`
  suggestion all use it, so they agree.
- Prompt rule lines live in `src/rules.ts`, shared by the ticket,
  merge, fix and review prompts. Change a rule there so the
  prompts cannot drift.
- `renderTypoWarnings` in `src/orchestrator.ts` is the one typo
  paragraph, shared by `explainOpen` (the finish summary and the
  nothing-ready explanation) and `graph`.
- Provider-specific options (`--max-turns`, `--prefer-subagent`)
  warn and are dropped on providers without them. Each provider's
  effort ladder is in `src/retry.ts`.
- In-place `runWaves` (outside a git repo) is the reduced path: no
  test gate, no learnings, no review.

### Logs on disk
- `learnings.md` and `review.md` are append-only logs whose entries
  open with a `<!-- nightralph:... -->` sentinel line. Sentinel
  text inside free-text fields is neutralized, so an entry cannot
  forge another, and the parsers drop malformed entries instead of
  throwing.

### Module boundaries
- `blockers`, `stats`, `retry`, `preflight`, `learnings` and
  `rules` import no values from `src/orchestrator.ts`; `review`
  imports only its `AgentResult` type and takes `spawnAgent` and
  the process registry as injected `deps`.
- `graph` value-imports only from `orchestrator` and `display`, and
  takes its loader as an injected `LoadFn`. It type-imports
  `LoadedSelection` from `resolve`, and `resolve` value-imports
  `upstreamOf` from `graph`, so a value import of `loadSelection`
  would be a cycle.

## Keeping this file small
A line belongs here when the code cannot tell a reader: a rule
that spans modules, the reason behind a choice, a gotcha in the
tooling. Put it under the heading it belongs to. Function
signatures, defaults and log wording stay in the code and tests;
anything specific to one ticket goes in the run's notes file.

<!-- nightralph:start -->
## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
<!-- nightralph:end -->
