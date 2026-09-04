# nightralph

Last verified: 2026-09-02

Small orchestrator that runs a single-agent session per issue.

## Tech Stack
- TypeScript, Node >= 24, ESM
- CLI: yargs + @inquirer/prompts
- Testing: @substrate-system/tapzero

## Commands
- `npm run build` -- build to dist/
- `npm test` -- build and run tests
- `npm run lint` -- eslint

## Project Structure
- `src/index.ts` -- CLI entry point (yargs commands)
- `src/setup.ts` -- project scaffolding module
- `src/orchestrator.ts` -- ticket scanning and wave execution
- `src/worktree.ts` -- git worktree management
- `src/progress.ts` -- run progress tracking
- `src/display.ts` -- terminal status UI (Display interface, StatusDisplay, PlainDisplay)
- `src/merge.ts` -- branch merging after wave completion
- `src/testcmd.ts` -- test command detection and execution
- `src/skills/` -- bundled skill definitions
- `src/docs-templates/` -- doc templates copied to target projects

## Contracts

### setup module (`src/setup.ts`)
- **Exposes**: `setup(opts)`, `checkGhAuth()`,
  `TrackerKind`, `SetupOpts`, `SKILL_DIRS`, `DOC_TEMPLATES`
- **TrackerKind**: `'github'|'local'`
- **SetupOpts.tracker**: required -- selects which
  issue-tracker template is installed and what AGENTS.md
  content is generated in the target project
- **checkGhAuth()**: returns true when
  `gh auth status` succeeds
- **DOC_TEMPLATES**: `['triage-labels.md', 'domain.md']` --
  issue-tracker.md is handled separately via tracker selection
- **Guarantees**: `setup()` always overwrites
  `issue-tracker.md` (not skip-if-exists like other
  templates); always writes AGENTS.md to the target project

### CLI (`src/index.ts`)
- `nightralph init [--claude]` -- prompts for tracker
  format, then scaffolds skills and docs
- `nightralph <provider> [--spec <name>]` -- executes
  tickets; `--spec` takes a feature name that resolves
  to `.scratch/<name>/` (issues dir + spec.md by
  convention)
- `-X` flag -- stop on merge conflict instead of
  re-spawning the agent (sets conflict strategy to
  `'stop'`)
- `--test-cmd <cmd>` -- command run in each worktree
  after the agent exits; non-zero exit rejects the
  ticket. Omitted = auto-detect `npm test` from
  `package.json` at the repo root; `""` = disabled
- `--max-turns <n>` -- max agentic turns per ticket,
  forwarded to the agent CLI (e.g. `--max-turns 30`)
- `--dry-run` -- shows wave order without running;
  auto-detects git repo and shows worktree/branch
  layout when inside one
- **Git auto-detection**: when run inside a git repo,
  the CLI uses isolated worktree execution
  (`runWavesIsolated`) instead of in-place
  (`runWaves`)

### orchestrator (`src/orchestrator.ts`)
- **Exposes**: `Ticket`, `AgentResult`,
  `COMPLETED_RE`, `scanTickets(dir)`,
  `findReadyTickets(tickets)`, `checkItems(ticket, items)`,
  `markDone(ticket)`,
  `renderPrompt(specBody, ticket, opts?)`,
  `stripSpecSection(specBody, heading)`,
  `renderMergePrompt(specBody, ticket)`,
  `spawnAgent(opts)`, `createPiStreamFormatter()`,
  `dryRun(tickets, specBody)`,
  `dryRunIsolated(opts)`, `runWaves(...)`,
  `runWavesIsolated(opts)`
- **Supported providers**: `claude` (stdin prompt,
  stream-json output), `codex` (stdin prompt),
  `pi` (file-based prompt via `@tmpfile`, JSON
  mode output parsed by `createPiStreamFormatter`)
- **COMPLETED_RE**: regex matching `[x] <text>` lines
  from agent output; used to detect which checklist
  items the agent has completed
- **checkItems(ticket, items)**: checks off specific
  `- [ ]` items in a ticket file by matching text;
  called with completed items from agent output
- **AgentResult**: `{ exitCode, completedItems }` --
  returned by `spawnAgent`
- **spawnAgent(opts)**: returns `AgentResult`; collects
  `[x] <text>` lines from agent stdout via
  `COMPLETED_RE`; accepts optional `cwd` to run
  the agent process in a specific directory (used for
  worktree isolation); accepts optional `maxTurns`
  forwarded as `--max-turns` to the agent CLI;
  accepts optional `onLine` callback to redirect
  output lines (used by Display integration); for
  `pi`, writes prompt to a temp file and passes
  `@path` as a positional arg instead of piping to
  stdin
- **renderPrompt(specBody, ticket, opts?)**: `opts.testCmd`
  adds test-first rules to the prompt and names the
  command the orchestrator will run after the agent exits
- **stripSpecSection(specBody, heading)**: drops one
  markdown section from a spec, ignoring headings
  inside code fences; the CLI uses it to omit
  `User Stories` from the per-ticket prompt
- **runWaves(...)**: accepts optional `display`
  parameter (`Display` interface); defaults to
  `createDisplay()` when omitted
- **renderMergePrompt(specBody, ticket)**: prompt for
  a respawned agent resolving a merge conflict; tells
  the agent to resolve conflict markers, not re-implement
- **runWavesIsolated(opts)**: creates a worktree per
  ticket, runs agents in parallel per wave, merges
  branches back, tracks progress, and commits progress
  updates; accepts optional `display` and `testCmd`
  in opts
- **Guarantees**: `runWavesIsolated` throws if the
  base branch working tree is dirty; merge failures
  are recorded in progress.md with `done:false`;
  respawned agents receive `renderMergePrompt`
  instead of `renderPrompt`; when `testCmd` is set, a
  red suite in the worktree records the ticket
  `done:false`, writes
  `<logsDir>/<ticket>.test.log`, and never queues the
  branch for merge -- this holds both after the first
  agent run and after a merge-conflict respawn
- **dryRunIsolated(opts)**: prints simulated wave order
  with worktree paths and branch names; accepts
  `testCmd` in opts and prints it

### testcmd module (`src/testcmd.ts`)
- **Exposes**: `TestResult`,
  `detectTestCmd(projectDir)`, `runTestCmd(opts)`
- **TestResult**: `{ exitCode, output }` -- `output`
  is stdout and stderr interleaved
- **detectTestCmd(projectDir)**: returns `'npm test'`
  when `<projectDir>/package.json` declares a `test`
  script, else `null`
- **runTestCmd(opts)**: `{ cmd, cwd, timeout }` --
  runs `cmd` via `sh -c` in its own process group
- **Guarantees**: neither function throws; a spawn
  error resolves with `exitCode:1` and the error text
  in `output`; the timeout kills the whole process
  group so child processes cannot outlive the run

### display module (`src/display.ts`)
- **Exposes**: `Display` (type), `StatusDisplay` (class),
  `PlainDisplay` (class), `createDisplay()`,
  `TicketStatus`, `DisplayTicket`, `WaveState`,
  `DisplayConfig`, `RunProgress`, `ansi`, `color`,
  `renderDot`, `fitLine(line, width)`
- **Display interface**:
  `startWave(waveNum, totalWaves, tickets, progress?,
  remaining?)`,
  `setTicketStatus(num, status)`, `log(message)`,
  `cleanup()`
- **remaining**: optional array of tickets not in the
  current wave but still pending; rendered with empty
  dots after wave tickets in `StatusDisplay`
- **RunProgress**: `{ completed, total }` for the whole
  run; `completed` counts tickets done before the wave
  started. The percent in the status line is
  `(completed + done-in-wave) / total`. When `progress`
  is omitted the percent falls back to per-wave
  (done-in-wave / tickets-in-wave). The orchestrator
  always passes it, derived from `ticket.status`
- **Guarantees**: `StatusDisplay` clamps every rendered
  line to `stream.columns - 1` visible characters
  (`fitLine`) so lines never wrap; a wrapped line would
  occupy more rows than the erase count and leave
  stale rows behind on the next render
- **DisplayConfig**: `{ stream }` -- the log message
  area dynamically fills remaining terminal rows after
  the ticket grid and separator
- **StatusDisplay**: ANSI-based terminal UI with
  paginated ticket grid, wave progress, and scrolling
  message log; handles terminal resize
- **PlainDisplay**: plain-text fallback when
  stdout is not a TTY
- **createDisplay()**: factory that returns
  `StatusDisplay` when stdout is a TTY,
  `PlainDisplay` otherwise
- **Guarantees**: `StatusDisplay.cleanup()` restores
  cursor and clears ANSI state; resize listener is
  removed on cleanup

### worktree module (`src/worktree.ts`)
- **Exposes**: `getRepoRoot()`, `getRepoName()`,
  `getCurrentBranch()`, `createWorktree(opts)`,
  `removeWorktree(path)`, `listWorktrees(repoRoot)`
- **createWorktree**: creates a git worktree in a
  sibling directory named
  `<repo>.<num>-<slug>` on branch
  `<repo>/<num>-<slug>`
- **Guarantees**: all functions are synchronous except
  `createWorktree`, `removeWorktree`, and
  `listWorktrees`

### progress module (`src/progress.ts`)
- **Exposes**: `TicketProgress`, `ProgressData`,
  `generateProgress(feature, tickets)`,
  `renderProgress(data)`, `checkTicket(data, num, result)`,
  `writeProgress(path, data)`,
  `commitProgress(repoRoot, path, message)`
- **Guarantees**: `renderProgress` produces a markdown
  checklist; `commitProgress` stages and commits the
  progress file

### merge module (`src/merge.ts`)
- **Exposes**: `GitOpResult`, `MergeConflictStrategy`,
  `MergeResult`, `WaveMergeResult`,
  `mergeBranch(repoRoot, branch)`,
  `rebaseBranch(repoRoot, branch, onto)`,
  `mergeWave(opts)`
- **GitOpResult**: `{ success:boolean; stderr?:string }`
  -- returned by `mergeBranch` and `rebaseBranch`
- **MergeConflictStrategy**: `'respawn'|'stop'`
- **MergeResult**: includes `stderr?:string` with git's
  diagnostic output on conflict
- **mergeWave**: merges the first branch directly,
  rebases subsequent branches onto the base before
  merging; respects strategy to either skip conflicted
  branches or stop entirely
- **Guarantees**: on conflict, `mergeBranch` aborts
  the merge and returns `{ success:false, stderr }`;
  `rebaseBranch` aborts and checks out the base
  branch on failure; stderr captures git's stdout
  (conflict info) or stderr (fatal errors)

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under
`.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
