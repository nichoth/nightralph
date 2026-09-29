# nightralph

Last verified: 2026-09-28

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
- **Guarantees**: `setup()` always creates symlinks
  from `.claude/skills/` to `.agents/skills/` for
  every skill; always overwrites `issue-tracker.md`
  (not skip-if-exists like other templates); always
  writes AGENTS.md to the target project; always
  ensures `.gitattributes` contains
  `AGENTS.md merge=union` (appends to an existing
  file, never duplicates the line) so parallel
  agents' AGENTS.md additions merge without conflict

### CLI (`src/index.ts`)
- `nightralph init` -- prompts for tracker
  format, then scaffolds skills, docs, and
  `.claude/skills/` symlinks
- `nightralph <provider> [turns] [--spec <name>]` --
  executes tickets; optional `turns` positional sets
  max agentic turns per ticket (shorthand for
  `--max-turns`); `--spec` takes a feature name that
  resolves to `.scratch/<name>/` (issues dir + spec.md
  by convention)
- `-X` flag -- stop on merge conflict instead of
  re-spawning the agent (sets conflict strategy to
  `'stop'`)
- `--test-cmd <cmd>` -- command run in each worktree
  after the agent exits; non-zero exit rejects the
  ticket. Defaults to `npm test`
- `--max-turns <n>` -- max agentic turns per ticket,
  forwarded as `--max-turns` to claude; other
  providers warn and skip (codex and pi do not
  accept this flag)
- `--timeout <n>` -- seconds before a still-running
  agent is killed; default 3600. A killed agent is
  not a failure (see orchestrator guarantees)
- `--effort <level>` -- starting effort level,
  validated against the active provider's ladder; omitted =
  provider default; ignored by providers without effort support
- `--retries <n>` -- extra attempts per ticket after a
  failed run; default `DEFAULT_RETRIES` (3); `0`
  disables retries
- `--retry-delay <n>` -- seconds to wait before the
  first retry; doubles each further retry; default
  `DEFAULT_RETRY_DELAY` (30); `0` disables the wait
- `--concurrency <n>` -- max agents running at once
  within a wave; default `DEFAULT_CONCURRENCY` (5)
- `--dry-run` -- shows wave order without running;
  auto-detects git repo and shows worktree/branch
  layout when inside one
- **Git auto-detection**: when run inside a git repo,
  the CLI uses isolated worktree execution
  (`runWavesIsolated`) instead of in-place
  (`runWaves`)

### orchestrator (`src/orchestrator.ts`)
- **Exposes**: `Ticket`, `AgentResult`,
  `COMPLETED_RE`, `EFFORT_LADDERS`, `ProviderName`,
  `EffortLevel`, `ALL_EFFORT_LEVELS`,
  `DEFAULT_RETRIES`, `DEFAULT_RETRY_DELAY`,
  `DEFAULT_CONCURRENCY`, `runPool(items, limit, fn)`,
  `escalateEffort(provider, level?)`, `retryDelayFor(base, attempt)`,
  `scanTickets(dir)`,
  `findReadyTickets(tickets)`,
  `findBlockedTickets(tickets, failedKeys)`,
  `checkItems(ticket, items)`,
  `markDone(ticket)`,
  `renderPrompt(specBody, ticket, opts?)`,
  `stripSpecSection(specBody, heading)`,
  `renderMergePrompt(specBody, ticket)`,
  `spawnAgent(opts)`, `createPiStreamFormatter()`,
  `killProcessGroup(pid)`, `killRunningAgents()`,
  `dryRun(tickets, specBody)`,
  `dryRunIsolated(opts)`, `runWaves(...)`,
  `runWavesIsolated(opts)`, `HUMAN_STATUS`,
  `renderFinishSummary(tickets, totalCompleted, failedKeys)`,
  `lookupSpec(specBodies, fallback, feature)`,
  `ticketKey(feature, num)`
- **Supported providers**: `claude` (stdin prompt,
  stream-json output), `codex` (stdin prompt),
  `pi` (file-based prompt via `@tmpfile`, JSON
  mode output parsed by `createPiStreamFormatter`)
- **COMPLETED_RE**: regex matching `[x] <text>` lines
  from agent output, with an optional leading markdown
  bullet (`- [x] <text>` also matches, the form agents
  actually emit most often); used to detect which
  checklist items the agent has completed. Collected
  per line (a whole multi-line text block counts as
  multiple reports) and deduplicated
- **findBlockedTickets(tickets, failedKeys)**: pure;
  returns `Map<string, string[]>` from the `ticketKey`
  of each `ready-for-agent` ticket not in `failedKeys`
  to the keys of the dead tickets upstream of it,
  following blockers directly or through a chain,
  within its own feature only. Dead means in
  `failedKeys`, or a status that is neither `done` nor
  `ready-for-agent` (e.g. `ready-for-human`); the walk
  stops at a dead or done ticket. Tickets with no dead
  upstream are omitted. A blocker number with no
  matching ticket is not dead; cycles terminate
- **checkItems(ticket, items)**: checks off specific
  `- [ ]` items in a ticket file by matching text;
  called with completed items from agent output.
  Items are matched against the ticket's checklist
  with whitespace runs collapsed and case-insensitive,
  so items wrapped across multiple lines in the file
  match a single-line echo (and vice versa); code
  fences are skipped. Re-reads the ticket file from
  disk before writing so it never clobbers changes
  that arrived after the ticket was scanned
- **markDone(ticket)**: sets `**Status:**` to done and
  checks off every remaining unchecked checklist item
  (a done ticket's items are complete by definition,
  so the file must not claim done with unchecked items
  left over when the agent never echoed `[x]` lines);
  re-reads the ticket file from disk first so merged
  agent edits are preserved
- **EFFORT_LADDERS**: per-provider effort levels,
  mapping provider names to their supported ladder. pi:
  `off, minimal, low, medium, high, xhigh, max`; claude:
  `low, medium, high, xhigh, max`; codex:
  `low, medium, high`
- **ProviderName**: type of provider names that have
  effort support; keys of `EFFORT_LADDERS`
- **EffortLevel**: type representing any supported effort
  level across all providers
- **ALL_EFFORT_LEVELS**: union of all provider levels,
  lowest to highest: `off, minimal, low, medium, high, xhigh, max`
- **escalateEffort(provider, level?)**: the level for a
  retry for a given provider; `undefined` -> `high`,
  otherwise one rung up the provider's ladder, clamped at
  the provider's max
- **AgentResult**: `{ exitCode, completedItems, timedOut }`
  -- returned by `spawnAgent`; `timedOut` is true when
  the orchestrator killed the agent at the timeout, and
  `exitCode` is non-zero in that case
- **TicketOutcome**: discriminated union returned by
  `runTicketAttempts`; `'no-commits'` carries
  `worktreePath:string` and `branchName:string`;
  `'error'` carries optional `worktreePath?:string`
  and `branchName?:string`; `'worktree-error'`
  carries only `error:unknown`
- **DEFAULT_RETRY_DELAY**: exported as `30` (seconds)
- **DEFAULT_CONCURRENCY**: exported as `5`
- **runPool(items, limit, fn)**: runs `fn` over `items`
  with at most `limit` in flight at once (clamped to a
  minimum of 1) and resolves with
  `PromiseSettledResult[]` in item order; one rejection
  never stops the others
- **retryDelayFor(base, attempt)**: returns
  `base * 2^(attempt-2)` -- e.g. `retryDelayFor(30,2)`
  is 30, `retryDelayFor(30,3)` is 60,
  `retryDelayFor(0,3)` is 0
- **killProcessGroup(pid)**: sends `SIGKILL` to `-pid`
  (the whole process group), falling back to a direct
  `SIGKILL` of `pid` when the group kill fails; used by
  the timeout handler and signal handling
- **killRunningAgents()**: iterates the module-level
  `runningAgents` set and calls `killProcessGroup` on
  each tracked pid, returning the count of agents
  killed; agents are added on spawn and
  removed on exit
- **spawnAgent(opts)**: returns `AgentResult`; spawns
  agents with `detached:true` so they become their own
  process group leader; kills the agent's process group
  after `timeout` seconds via `killProcessGroup` and
  reports that through `onLine` (or `console.warn` when
  no `onLine`) and as a line in the ticket log, never
  only to the console, since `StatusDisplay` repaints
  over bare console output; installs a `proc.stdin`
  error listener so an agent that exits before reading
  its prompt (EPIPE) does not crash the run; collects
  `[x] <text>` lines from agent stdout via
  `COMPLETED_RE` (matched per line, so multi-line text
  blocks yield every reported item); resolves within `CLOSE_GRACE_MS`
  (2s) of exit even when a grandchild holds the stdout
  pipe; the grace-timer callback calls
  `killProcessGroup(proc.pid)` before destroying
  streams so grandchild processes sharing the pipe are
  killed, not just orphaned; accepts optional `cwd`
  to run the agent process
  in a specific directory (used for worktree isolation);
  accepts optional `maxTurns`, forwarded as
  `--max-turns` to claude only (other providers
  warn and skip); accepts optional
  `effort` and maps it to the correct native flag for
  each provider: `--thinking <level>` for pi,
  `--effort <level>` for claude,
  `-c model_reasoning_effort=<level>` for codex;
  accepts optional `onLine` callback to redirect output
  lines (used by Display integration); for `pi`, writes
  prompt to a temp file and passes `@path` as a positional
  arg instead of piping to stdin
- **renderPrompt(specBody, ticket, opts)**: `opts.testCmd`
  is required; the prompt always includes /tdd
  instructions and names the test command the
  orchestrator will run after the agent exits; it
  also tells the agent to read nearby AGENTS.md,
  CONTEXT.md and docs/adr/ first, to commit after
  each checklist item, to never weaken tests or
  fake `[x]` lines (leave the item unchecked and
  say what blocked it), and to record reusable
  learnings in the nearest AGENTS.md before the
  final commit
- **stripSpecSection(specBody, heading)**: drops one
  markdown section from a spec, ignoring headings
  inside code fences; the CLI uses it to omit
  `User Stories` from the per-ticket prompt
- **runWaves(...)**: requires `testCmd` (string);
  accepts optional `display` parameter (`Display`
  interface), defaults to `createDisplay()` when
  omitted; trailing optional
  `effort`, `retries`, `retryDelay`, and
  `concurrency` (default `DEFAULT_CONCURRENCY`; at
  most that many agents run at once within a wave,
  via `runPool`) -- a
  non-zero exit is retried up to `retries` times
  with an escalated level and exponential backoff
  (timeouts are not retried); a per-run `failedKeys`
  set (compound `ticketKey` strings) excludes tickets
  that exhausted their attempts or whose merge conflict
  was not recovered from later waves
- **renderMergePrompt(specBody, ticket)**: prompt for
  a respawned agent resolving a merge conflict; tells
  the agent to resolve conflict markers, not
  re-implement, and to keep both sides' additions
  when AGENTS.md or other docs conflict
- **lookupSpec(specBodies, fallback, feature)**: returns
  the spec body for a given feature from a
  `Map<string, string>`, or `fallback` when the map is
  undefined, the feature is empty, or the feature is not
  in the map
- **runWavesIsolated(opts)**: creates a worktree per
  ticket, runs agents in parallel per wave, merges
  branches back, tracks progress, and commits progress
  updates; requires `testCmd` (string); accepts
  optional `display`, `effort`, `retries`,
  `retryDelay`, `concurrency`,
  `specBodies` (`Map<string, string>`), and
  `progressPaths` (`Map<string, string>`) in opts;
  when `specBodies` and `progressPaths` are provided,
  creates a `ProgressTracker` for per-feature progress
  files; a wave with more ready tickets than
  `concurrency` runs them through `runPool`, so the
  wave still finishes fully before any branch is merged
- **Session list (both `runWaves` variants)**: the
  session set is captured before the wave loop: every
  ticket whose status is `ready-for-agent` at that
  point (blockers done or not), sorted by feature then
  number. `startRun` is called with it exactly once,
  when wave 1 starts, and never for a run with nothing
  ready. Blocked tickets (`findBlockedTickets`) are
  reported via `setBlocked` with `ticketLabel` names
  right after `startRun`, at the top of every later
  loop iteration, and once more after the loop, so
  the `-X` stop and the no-progress breaks still
  report them. The `progress` passed to `startWave`
  counts only the session set (`completed` = session
  tickets now `done`, `total` = session size)
- **Guarantees**: `runWavesIsolated` throws if the
  base branch working tree is dirty; a failed attempt
  (non-zero exit, exit 0 with no new commits, or a red
  test gate) is retried up to `retries` times, each
  from a fresh worktree via `createWorktree` and, for
  known providers, with `escalateEffort` applied to the
  previous level, with exponential backoff between retries
  (`retryDelayFor`); only the final attempt's outcome
  is recorded in progress.md; retry logs are
  `<logsDir>/<ticket>.attempt<n>.log` and
  `<ticket>.attempt<n>.test.log`, the first attempt
  keeps the unsuffixed names; a timed-out agent
  (`timedOut:true`) is not treated as a failed agent:
  its worktree is kept, dirty changes are auto-committed,
  and the branch goes through the new-commits check,
  test gate, and merge exactly like an exit 0; a throw
  inside a ticket attempt (e.g. agent deletes its own
  worktree) fails that ticket with an `'error'` outcome
  but does not crash the wave -- other tickets continue;
  a per-run `failedKeys` set (compound `ticketKey`
  strings) excludes tickets that exhausted their
  attempts or whose merge conflict was not recovered
  from later waves; failed
  and stopped worktrees are removed with `force:true`
  so dirty files do not prevent cleanup; every
  terminal failure -- `worktree-error` (exitCode:-1),
  `error` (exitCode:-1, branchName when available),
  `no-commits` (exitCode:0, branchName from outcome),
  and `failed` -- is recorded in progress.md via
  `checkTicket` + `saveProgress` with `done:false`;
  merge failures are also recorded with `done:false`;
  an unrecovered merge failure also sets the ticket's
  display status to `failed` (it no longer stays
  `awaiting-merge`). Known limit: under `-X`, branches
  after the stop point never enter
  `mergeResult.merged`, so their rows stay
  `awaiting-merge` in the final frame;
  respawned agents receive `renderMergePrompt`
  instead of `renderPrompt`; a red test suite in the
  worktree records the ticket `done:false`, writes
  `<logsDir>/<ticket>.test.log`, and never queues the
  branch for merge -- this holds both after the first
  agent run and after a merge-conflict respawn;
  `renderPrompt` and `renderMergePrompt` confine the
  agent to its worktree directory and prohibit
  `git push`
- **HUMAN_STATUS**: `'ready-for-human'`, the ticket status
  that means an agent must not pick the ticket up
- **ticketKey(feature, num)**: returns `${feature}:${num}`,
  the compound identity used for all internal maps
- **renderFinishSummary(tickets, totalCompleted, failedKeys)**:
  pure; `failedKeys` is `ReadonlySet<string>` of compound
  `ticketKey` values; returns the text both `runWaves`
  variants log before `cleanup()`. The first line is the
  count summary
  (`Finished: N completed[, N remaining][, N failed][, N
  need a human]`). When tickets span more than one
  distinct `feature`, a per-feature breakdown follows
  the total line (one `  <feat>: N completed[, ...]`
  line per feature, sorted alphabetically). When any
  ticket is `ready-for-human` it adds a paragraph
  naming those tickets, saying an agent cannot finish
  them, listing any `ready-for-agent` tickets blocked
  on them, and telling the user to do the work and set
  the status to done. This is why a run whose only
  open tickets are human ones exits 0 with an
  explanation instead of silently
- **dryRunIsolated(opts)**: prints simulated wave order
  with worktree paths and branch names; requires
  `testCmd`; accepts `effort`, `retries`, `retryDelay`,
  and `concurrency` in opts and prints them

### testcmd module (`src/testcmd.ts`)
- **Exposes**: `TestResult`,
  `detectTestCmd(projectDir)`, `runTestCmd(opts)`
- **TestResult**: `{ exitCode, output }` -- `output`
  is stdout and stderr interleaved
- **detectTestCmd(projectDir)**: returns `'npm test'`
  when `<projectDir>/package.json` declares a `test`
  script, else `null`
- **runTestCmd(opts)**: `{ cmd, cwd, timeout,
  registry? }` -- runs `cmd` via `sh -c` in its own
  process group; when `registry` (`Set<number>`) is
  provided, the child pid is added on spawn and
  removed on close/error, so signal handlers can
  kill test processes alongside agents
- **Guarantees**: neither function throws; a spawn
  error resolves with `exitCode:1` and the error text
  in `output`; the timeout kills the whole process
  group so child processes cannot outlive the run

### display module (`src/display.ts`)
- **Exposes**: `Display` (type), `StatusDisplay` (class),
  `PlainDisplay` (class), `createDisplay(stream?)`,
  `TicketStatus`, `DisplayTicket`, `TicketRef`,
  `WaveState`, `DisplayConfig`, `RunProgress`, `ansi`,
  `color`, `renderDot`, `ticketLabel(ticket)`,
  `fitLine(line, width)`, `wrapLine(line, width)`
- **Display interface**: `startRun(tickets)`,
  `startWave(waveNum, totalWaves, tickets, progress?)`,
  `setTicketStatus(num, status, feature?)`,
  `setBlocked(num, feature, blockedBy)`,
  `log(message)`, `cleanup()`. `tickets` are
  `TicketRef`s. `setTicketStatus` and `setBlocked`
  find the row by `num` and `feature` (by `num` alone
  when `feature` is omitted) and ignore unknown tickets
- **TicketRef**: `{ num, filename, feature? }` -- the
  identity a caller passes in; `DisplayTicket` adds
  `status` and optional `blockedBy`
- **ticketLabel(ticket)**: the row name,
  `<feature>/<NN>` (number zero-padded to 2) when
  `feature` is set, else `filename`
- **TicketStatus**: `'pending'|'in-progress'|
  'awaiting-merge'|'done'|'failed'|'blocked'`.
  `renderDot` draws them as a dim empty dot, then
  yellow, cyan, green, red and dim filled dots.
  `blocked` means an upstream ticket failed or is not
  agent work, so the ticket cannot run this session;
  the row names those tickets as
  `(blocked by a/01, a/02)`. `in-progress` means the
  ticket holds a concurrency slot (agent running, test
  gate running, or waiting out a retry backoff), so at
  most `concurrency` dots are yellow at once.
  `awaiting-merge` means the attempt succeeded and the
  branch waits for the rest of the wave;
  `runTicketAttempts` sets it when an attempt is
  `'ready'`, so only `runWavesIsolated` uses it. It
  stays set through the merge, including while a
  respawned agent resolves a merge conflict
  (`respawnAndRetryMerge` gets no display). It does
  not count toward the percent; only `done` does
- **startRun(tickets)**: called once before the first
  wave; seeds every row as `pending` and fixes the
  rendered list for the rest of the run. Rows never
  move, vanish or reappear; tickets not yet in a wave
  show as pending. `startWave` sets the wave number
  and total and clears the log area, but never resets
  statuses; its `tickets` argument is ignored by
  `StatusDisplay` except when `startRun` was never
  called, in which case the first `startWave` seeds
  the list from it
- **WaveState**: `{ waveNum, totalWaves }`; the ticket
  list lives on `StatusDisplay` itself, not in the
  wave state
- **RunProgress**: `{ completed, total }` for the whole
  run; used only by `PlainDisplay`, which prints
  `(completed/total done)` in its wave line.
  `StatusDisplay` ignores it and computes done/total
  from its fixed list, so the header
  (`Wave N/M - D/T done - P%`) and the rows cannot
  disagree
- **Guarantees**: `StatusDisplay` never emits a row
  wider than `stream.columns - 1` visible characters;
  ticket names are clamped (`fitLine`) and log messages
  are split into rows (`wrapLine`) so long output is
  shown in full rather than cut off. A row the terminal
  wrapped on its own would occupy more rows than the
  erase count and leave stale rows behind on the next
  render, so `render` counts wrapped rows itself and
  the last `logRows` of them are shown
- **DisplayConfig**: `{ stream }` -- the log message
  area dynamically fills remaining terminal rows after
  the ticket grid and separator
- **StatusDisplay**: ANSI-based terminal UI with
  paginated ticket grid, wave progress, and scrolling
  message log; handles terminal resize
- **PlainDisplay**: plain-text fallback when
  stdout is not a TTY; prints one line per wave;
  `startRun`, `setTicketStatus` and `setBlocked` are
  no-ops (it has no fixed list)
- **createDisplay(stream?)**: factory that returns
  `StatusDisplay` when `stream` (default stdout) is a
  TTY, `PlainDisplay` otherwise
- **Guarantees**: `StatusDisplay.log()` called before any
  `startWave()` writes the message straight to the
  stream instead of dropping it (`render` is a no-op
  without a wave); this is how the finish summary reaches
  the terminal when a run has no runnable tickets
- **Guarantees**: `StatusDisplay` does not install
  process-level signal handlers (SIGINT/SIGTERM are
  handled by the CLI in `src/index.ts` via
  `killRunningAgents`); `StatusDisplay.cleanup()`
  restores cursor and clears ANSI state; resize
  listener is removed on cleanup

### worktree module (`src/worktree.ts`)
- **Exposes**: `getRepoRoot()`, `getRepoName()`,
  `getCurrentBranch()`, `buildBranchName(repoRoot,
  repoName, ticket)`, `createWorktree(opts)`,
  `removeWorktree(path, opts?)`,
  `listWorktrees(repoRoot)`
- **buildBranchName**: returns the branch name for a
  ticket as `<repo>--<num>-<slug>`; uses `--`
  instead of `/` to avoid the git ref hierarchy
  conflict that prevents creating
  `refs/heads/X/Y` when `refs/heads/X` exists
- **createWorktree**: creates a git worktree in a
  sibling directory named
  `<repo>.<num>-<slug>` on a branch named by
  `buildBranchName`; calls are serialized
  module-wide via a promise chain so concurrent
  invocations do not race on shared git refs;
  before creating, cleans up any stale worktree at
  the target path and deletes any leftover branch of
  the same name, so re-running after a failed run is
  safe
- **removeWorktree(path, opts?)**: accepts optional
  `{ force?:boolean }`; when `force` is `true`,
  passes `--force` to `git worktree remove` so dirty
  worktrees (modified or untracked files) are removed;
  calls are serialized through the same module-level
  `worktreeQueue` as `createWorktree`, so concurrent
  create + remove calls cannot race on `.git/worktrees`
  metadata
- **Guarantees**: all functions are synchronous except
  `createWorktree`, `removeWorktree`, and
  `listWorktrees`

### progress module (`src/progress.ts`)
- **Exposes**: `TicketProgress`, `ProgressData`,
  `ProgressTracker`,
  `generateProgress(feature, tickets)`,
  `generateMultiFeatureProgress(tickets)`,
  `createProgressTracker(opts)`,
  `renderProgress(data)`, `checkTicket(data, num, result)`,
  `writeProgress(path, data)`,
  `commitProgress(repoRoot, path, message)`,
  `readProgress(progressPath)`,
  `mergeProgress(fresh, existing)`
- **commitProgress**: returns `Promise<boolean>` --
  `true` when a commit was made, `false` when the
  staged file matched HEAD (no-op). Uses `git add
  --force` so gitignored paths (e.g. under `.scratch/`)
  are staged regardless
- **readProgress(progressPath)**: parses an existing
  progress.md back into a `ProgressData` object, or
  returns `null` if the file does not exist
- **mergeProgress(fresh, existing)**: returns a new
  `ProgressData` whose tickets are the fresh set, except
  tickets that were `done:true` in `existing` are
  replaced with the existing (completed) record; returns
  `fresh` unchanged when `existing` is `null`
- **generateMultiFeatureProgress(tickets)**: groups
  tickets by `feature` field and returns
  `Map<string, ProgressData>` with one entry per
  distinct feature
- **ProgressTracker**: type with `dataFor(feature)`
  and `pathFor(feature)` methods
- **createProgressTracker(opts)**: factory that returns
  a `ProgressTracker`; accepts `progressPaths`,
  `dataMap`, `fallbackPath`, and `fallbackData`;
  lookups fall back to the fallback values when a
  feature is not in the maps
- **Guarantees**: `renderProgress` produces a markdown
  checklist; `commitProgress` never throws on a no-op
  (identical content)

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

<!-- nightralph:start -->
## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
<!-- nightralph:end -->
