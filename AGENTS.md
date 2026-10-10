# nightralph

Last verified: 2026-10-09

Small orchestrator that runs a single-agent session per issue.

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
  `spawnAgent` take the claude branch. Env vars drive it:
  `FAKE_CLAUDE_ENV_LOG` (appends the JSON of
  `CLAUDE_CODE_SUBAGENT_MODEL`, or `null`, per run),
  `FAKE_CLAUDE_PROMPT_DIR` (writes each prompt it reads to its
  own file there), `FAKE_CLAUDE_STREAM` (a file whose lines it
  prints as stream-json), `FAKE_CLAUDE_FAIL_ONCE` (a marker
  path: the first run creates it and exits 1),
  `FAKE_CLAUDE_DELEGATE` (a `test/mock-agent-*.js` run with
  the same prompt, cwd, env and args) and `FAKE_CLAUDE_HANG=1`
  (never exits). `test/mock-agent-review.js` records
  `{ time, role, cwd, prompt }` per run. Tests clear and
  restore these through an explicit key list
  (`FAKE_CLAUDE_KEYS` in `test/integration.test.ts`,
  `FAKE_ENV_KEYS` in `test/orchestrator.test.ts`, `ENV_KEYS`
  in `test/review-integration.test.ts`, whose harness clears
  every key before applying a test's env), so a test that
  sets a new key must add it to its file's list
- `npm publish` -- `prepublishOnly` runs `npm run build` and
  `npm test` first, so a red suite or a stale `dist/` cannot be
  published
- `npm version` -- `postversion` is `npm publish && git push
  --follow-tags`, so the version tag is pushed only after the
  build and tests pass. A red suite leaves the version commit
  and tag local

## Project Structure
- `src/index.ts` -- CLI entry point (yargs commands)
- `src/setup.ts` -- project scaffolding module
- `src/orchestrator.ts` -- ticket scanning and wave execution
- `src/worktree.ts` -- git worktree management, integration
  branch planning
- `src/progress.ts` -- run progress tracking
- `src/learnings.ts` -- attempt learnings log (render, parse,
  select, notes collection)
- `src/display.ts` -- terminal status UI (Display interface, StatusDisplay, PlainDisplay)
- `src/merge.ts` -- branch merging after wave completion
- `src/retry.ts` -- shared retry loop and effort ladders
- `src/rules.ts` -- prompt rule lines shared by the ticket,
  fix and review prompts
- `src/review.ts` -- review log, reviewer, fixer, review pass
- `src/stats.ts` -- subagent stats from claude stream-json,
  per-ticket totals and the run tally
- `src/testcmd.ts` -- test command detection and execution
- `src/preflight.ts` -- provider executable lookup
- `src/resolve.ts` -- feature selection (`.scratch/<feature>/`
  discovery and the interactive picker)
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
  ticket. When the flag is absent the command is
  `detectTestCmd` on the repo root (the current directory for
  in-place runs), else `''` (no gate), and the CLI
  logs one line saying no test command was detected.
  `--test-cmd ""` is an explicit `''`. `''` is passed
  through unchanged to `runWaves`, `runWavesIsolated`,
  `dryRun`, `dryRunIsolated` and the review pass
- `--install-cmd <cmd>` -- command run in each fresh
  worktree before the agent (isolated runs only).
  Defaults to `detectInstallCmd(repoRoot)`; `""`
  disables it
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
- `--prefer-subagent <model>` -- yargs string, claude only;
  `""` (or absent) is off. After the provider preflight, a
  provider whose basename is not `claude` gets one
  `--prefer-subagent not supported by <provider>, skipping`
  warning (also under `--dry-run`) and the value is dropped,
  so no agent gets the env var or the prompt rule. Otherwise
  it is passed as `preferSubagent` to `runWavesIsolated`,
  in-place `runWaves`, `dryRun` and `dryRunIsolated`
- `--retries <n>` -- extra attempts per ticket after a
  failed run; default `DEFAULT_RETRIES` (3); `0`
  disables retries
- `--retry-delay <n>` -- seconds to wait before the
  first retry; doubles each further retry; default
  `DEFAULT_RETRY_DELAY` (30); `0` disables the wait
- `--concurrency <n>` -- max agents running at once
  within a wave; default `DEFAULT_CONCURRENCY` (5)
- `--no-review` -- skips the review and fix pass at the
  end of a run (yargs boolean `review`, default `true`)
- `--dry-run` -- shows wave order without running;
  auto-detects git repo and shows worktree/branch
  layout when inside one; also prints the branch
  decision (`describeIntegrationBranch`) and whether
  review is on or off; both dry runs print
  `Prefer subagent: <model>` (`(none)` when off)
- **Provider preflight**: after the first ticket scan (and
  only when it found tickets) and before
  `prepareIntegrationBranch`, `runExecute` calls
  `resolveExecutable(provider)`. `null` prints
  `Provider '<name>' not found on PATH` (or `Provider
  '<name>' not found or not executable` when the name
  contains `/`) and exits 2, so a bad name never creates or
  checks out a branch. Under
  `--dry-run` it prints a `Provider:` line with the resolved
  path or the same not-found wording and continues. A
  provider containing `/` is resolved against the launch
  directory, and the resolved absolute path is the agent
  command the runners spawn (worktrees have their own cwd, so
  a relative path would not resolve there); a bare name is
  still looked up on PATH at spawn time
- **Errors**: a yargs `.fail()` handler. An error thrown or
  rejected by a command handler (for example a dirty tree
  found by `runWavesIsolated`) prints `formatErrorMessage(err)`
  to stderr and exits 2, with no help text and no stack. A
  usage error (a message from yargs, such as an unknown
  argument under `.strict()` or an `--effort` value outside
  its choices) prints the help text and the message and
  exits 1. `runExecute` exits 2 on its own for a missing
  provider or feature path, and for a failed integration
  branch setup
- **Integration branch**: in a git repo, outside
  `--dry-run`, the CLI calls `prepareIntegrationBranch`
  after its first ticket scan (so a run with no tickets
  creates nothing). Only a run launched from the default
  branch gets one: it creates or resumes
  `nightralph--<feature>` (`nightralph--all` for several
  or no features) and is left on it; launched from any
  other branch it merges into that branch as before. A
  dirty tree exits with code 2 before anything is
  checked out. On resume the CLI logs how far the launch
  branch is ahead (or `fast-forwarded to <launch>` when
  the branch was moved up, see `prepareIntegrationBranch`)
  and scans tickets again, silently, so they carry that
  branch's statuses. If the re-scan finds a selected
  feature's issues dir or spec missing, or no tickets at
  all, the CLI checks the launch branch back out, prints
  one error naming the branch, the problem, how far
  behind it is and the remedy (merge the launch branch
  into it, or `git branch -D` it), and exits 2; only the
  first scan exits from inside the scan (`loadTickets`
  returns the missing paths, callers decide). It logs
  `Created branch ...` or `Resumed ...`. The review log
  is `.scratch/<feature>/review.md` for one feature,
  `.scratch/review.md` for several; unless `--no-review`
  it is passed as `review:{ reviewPath, forkedFrom }`
- **Git auto-detection**: when run inside a git repo,
  the CLI uses isolated worktree execution
  (`runWavesIsolated`) instead of in-place
  (`runWaves`)

### orchestrator (`src/orchestrator.ts`)
- **Exposes**: `Ticket`, `AgentResult`,
  `COMPLETED_RE`, `EFFORT_LADDERS`, `ProviderName`,
  `EffortLevel`, `ALL_EFFORT_LEVELS` (these effort
  symbols, `escalateEffort` and `retryDelayFor` live in
  `src/retry.ts` and are re-exported unchanged),
  `DEFAULT_RETRIES`, `DEFAULT_RETRY_DELAY`,
  `DEFAULT_CONCURRENCY`, `runPool(items, limit, fn)`,
  `escalateEffort(provider, level?)`, `retryDelayFor(base, attempt)`,
  `scanTickets(dir)`,
  `findReadyTickets(tickets)`,
  `findBlockedTickets(tickets, failedKeys)`,
  `checkItems(ticket, items)`,
  `markDone(ticket)`,
  `renderPrompt(specBody, ticket, opts)`,
  `stripSpecSection(specBody, heading)`,
  `renderMergePrompt(specBody, ticket, opts?)`,
  `spawnAgent(opts)`, `formatStreamLine(line)`,
  `createPiStreamFormatter()`,
  `killProcessGroup(pid)`, `killRunningAgents()`,
  `dryRun(tickets, specBody, testCmd, preferSubagent?)`,
  `dryRunIsolated(opts)`, `runWaves(...)`,
  `runWavesIsolated(opts)`, `HUMAN_STATUS`,
  `renderFinishSummary(tickets, totalCompleted, failedKeys)`,
  `lookupSpec(specBodies, fallback, feature)`,
  `ticketKey(feature, num)`, `formatErrorMessage(error)`
- **formatErrorMessage(error)**: an `Error`'s `message`, else
  `String(error)`; no stack. The CLI's `.fail()` handler and
  `spawnAgent`'s spawn-error report use it
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
- **AgentResult**: `{ exitCode, completedItems, timedOut,
  subagents?, costUsd? }` -- returned by `spawnAgent`;
  `timedOut` is true when the orchestrator killed the
  agent at the timeout, and `exitCode` is non-zero in that
  case. `subagents` and `costUsd` are set for claude only
  (the final `SubagentStats` from `src/stats.ts`, spread
  in, so `costUsd` is absent, not `undefined`, until a
  `result` message reports it); codex and pi results never
  carry them
- **TicketOutcome**: discriminated union returned by
  `runTicketAttempts`; `'no-commits'` carries
  `worktreePath:string` and `branchName:string`;
  `'error'` carries optional `worktreePath?:string`
  and `branchName?:string`; `'worktree-error'`
  carries only `error:unknown`; `'failed'` carries
  `reason:'exit'|'tests'|'install'`. The variants that
  always follow an agent run carry
  `agentRun:AgentRunRecord`
  (`{ exitCode, completedItems, timedOut, notes,
  subagents?, costUsd? }`, the last two copied only when
  the `AgentResult` has them):
  `'ready'`, `'failed'` with reason `'exit'` or
  `'tests'`, and `'no-commits'`. `'failed'` with reason
  `'install'` has no `agentRun`, and `'error'` never
  carries one, even when the throw came after the
  agent ran (that attempt's notes are dropped). The
  top-level `exitCode` on `'failed'` is the value
  written to progress.md (a placeholder `1` for
  `'tests'` and `'install'`), while
  `agentRun.exitCode` is the agent's real exit code
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
  over bare console output; a spawn error (e.g. ENOENT)
  is reported through `onLine` (or `console.error` when no
  `onLine`) and as a `nightralph:` line in the ticket log,
  and resolves with `exitCode:1` once the log has flushed;
  installs a `proc.stdin`
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
  arg instead of piping to stdin. Optional `preferSubagent`
  (claude only; ignored for other providers) spawns with
  `env:{ ...process.env,
  CLAUDE_CODE_SUBAGENT_MODEL:<model> }`;
  unset, no `env` option is passed, so a value exported in
  the shell is inherited. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
  is never set. Each claude stdout line is `JSON.parse`d
  once: the parsed value is folded into the stream stats
  (`nextStreamStats`) and then formatted, and optional
  `onStats(stats)` is called each time the stats change
  (by identity of the returned state). A timed-out claude
  agent resolves with the count seen so far and a cost only
  if a `result` message arrived before the kill
- **formatStreamLine(line)**: formats one claude
  stream-json line for the log; a line that is not JSON is
  returned as is. Non-object values and fields of the wrong
  type yield `null` or a default rather than a throw. An
  `assistant` message with a non-null `parent_tool_use_id`
  (a subagent's output) yields `null`, so subagent text
  never reaches the log or `COMPLETED_RE` and cannot check
  items; otherwise the first text block whose `text` is a
  string is returned (other blocks are skipped). `result`
  yields `<subtype|done>[ ($<cost>)]`, and `system` with
  subtype `api_retry` yields `retry: <error|unknown>`, both
  typeof-guarding their fields. `spawnAgent` parses each
  line itself and calls the same internal
  `formatStreamObject`
- **renderPrompt(specBody, ticket, opts)**: `opts.testCmd`
  is required; the prompt always includes /tdd
  instructions and names the test command the
  orchestrator will run after the agent exits (when
  `opts.testCmd` is `''` it names no command and says the
  orchestrator runs none); it
  also tells the agent to read nearby AGENTS.md,
  CONTEXT.md and docs/adr/ first, to commit after
  each checklist item and have everything committed
  at the end except its notes file, to never weaken
  tests or fake `[x]` lines (leave the item unchecked
  and record what blocked it in the notes file), and
  to record reusable learnings in the nearest
  AGENTS.md before the final commit. A checklist item
  that is pure scaffolding, config, or docs may skip
  test-first, and the agent records that decision in
  its notes file. Notes rule: the agent keeps notes
  for the attempt in `NOTES_PATH`
  (`.nightralph/notes.md`, creating the directory),
  updates it after each checklist item and as soon as
  it hits a blocker (not only at the end), and never
  commits, stages, or deletes it; `runWavesIsolated`
  collects it (in-place `runWaves` does not). Reusable
  patterns go in AGENTS.md;
  anything specific to this ticket goes in the notes
  file. Optional `opts.history` (the text from
  `renderHistory`) is placed between the ticket and
  the agent instructions, and the block is omitted
  when it is empty or undefined. Optional
  `opts.installCmd` adds a rule
  that dependencies are installed with that command,
  the agent must not reinstall with any other command,
  and new dependencies use the same package manager.
  Optional `opts.preferSubagent` adds the
  `subagentRule(preferSubagent)` lines right after the
  install rule
- **stripSpecSection(specBody, heading)**: drops one
  markdown section from a spec, ignoring headings
  inside code fences; the CLI uses it to omit
  `User Stories` from the per-ticket prompt
- **runWaves(...)**: requires `testCmd` (string; `''`
  means no test gate: in-place runs never run one, so the
  value only shapes the prompt, and a non-empty value makes
  the prompt promise a gate that in-place runs do not
  perform);
  accepts optional `display` parameter (`Display`
  interface), defaults to `createDisplay()` when
  omitted; trailing optional
  `effort`, `retries`, `retryDelay`, and
  `concurrency` (default `DEFAULT_CONCURRENCY`; at
  most that many agents run at once within a wave,
  via `runPool`) and a last positional `preferSubagent`
  (passed to `renderPrompt` and every `spawnAgent`) -- a
  non-zero exit is retried up to `retries` times
  with an escalated level and exponential backoff
  (timeouts are not retried); a per-run `failedKeys`
  set (compound `ticketKey` strings) excludes tickets
  that exhausted their attempts or whose merge conflict
  was not recovered from later waves. It records no
  learnings and passes no history; the prompt still
  asks for `.nightralph/notes.md`, which the in-place
  runner neither ignores nor collects, so the file is
  left in the project directory. Each ticket keeps a
  running total of its attempts' stats (`addStats`) and
  feeds it to `setTicketStats` from `onStats`, and every
  `spawnAgent` result is added to the run's `RunStats`
- **renderMergePrompt(specBody, ticket, opts?)**: prompt for
  a respawned agent resolving a merge conflict; tells
  the agent to resolve conflict markers, not
  re-implement, and to keep both sides' additions
  when AGENTS.md or other docs conflict; optional
  third arg `{ installCmd?, preferSubagent? }` adds the
  same install and subagent rules as `renderPrompt`
- **lookupSpec(specBodies, fallback, feature)**: returns
  the spec body for a given feature from a
  `Map<string, string>`, or `fallback` when the map is
  undefined, the feature is empty, or the feature is not
  in the map
- **runWavesIsolated(opts)**: creates a worktree per
  ticket, runs agents in parallel per wave, merges
  branches back, tracks progress, and commits progress
  updates; requires `testCmd` (string; `''` skips the test
  gate: `runTestGate` returns true without spawning or
  writing a `.test.log`, and the branch goes straight to the
  merge queue); accepts
  optional `installCmd` (run in each fresh worktree
  before the agent and again after a merge-conflict
  rebase, output in `<logsDir>/<ticket>.install.log`;
  a non-zero exit fails the attempt with reason
  `'install'` without running the agent, and it is
  retried like any failure), `display`, `effort`,
  `retries`,
  `retryDelay`, `concurrency`, `preferSubagent` (passed
  to every prompt builder and `spawnAgent` call: tickets,
  merge-conflict respawns, reviewer and fixer),
  `review` (`{ reviewPath, forkedFrom? }`; unset means
  no review, so existing callers are unaffected),
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
- **Integration branch and review**: `runWavesIsolated`
  returns `{ allDone, branch }`, `branch` being the
  branch it merged into (the current branch; the CLI
  has already entered the integration branch). It
  records the launch commit (`HEAD`) after its
  dirty-tree check, as the last-resort start of the
  review range. After each wave's merges it commits the
  ticket files it marked done (`commitTicketFiles`,
  before an `-X` stop is acted on), so a finished run
  leaves no uncommitted ticket statuses. When `review`
  is set it calls `runReviewPass` after the wave loop
  (also after an `-X` stop), with `spawnAgent` and the
  running-process registry injected, and for a
  multi-feature run pastes every spec under a
  `# Feature: <name>` heading. After the finish summary
  it logs the run stats line (see below), the review line
  (`renderReviewSummary`, from the review outcome;
  nothing when the review was skipped or threw) and
  `Work is on <branch>`. The
  review is advisory: any throw in it is caught,
  logged through the display as `Review failed: ...`,
  and never changes `allDone`. In-place `runWaves` has
  no review
- **Subagent stats (both `runWaves` variants)**: each
  runner keeps one `RunStats` tally (`addRun`) over every
  `spawnAgent` result of the run. In `runWavesIsolated`
  the tally is an `onAgentRun(result)` callback passed in
  `TicketAttemptOpts` (called after every ticket attempt's
  agent) and in the `respawnAndRetryMerge` opts (called
  after the respawned agent), and the review pass gets a
  wrapped `deps.spawnAgent` that tallies each reviewer and
  fixer result; in-place `runWaves` tallies each first run
  and retry directly. Right after `renderFinishSummary`
  each runner logs `renderRunStats(runStats)` when it is
  non-null. Per ticket, `runTicketAttempts` (and the
  in-place pool callback) keeps a running total over
  finished attempts (`addStats`) and on every `onStats`
  call passes that total plus the live attempt's stats to
  `display.setTicketStats`; merge respawns and review runs
  count toward the run tally only, not a ticket row.
  Stats are advisory: they never change an outcome, a
  retry decision or an exit code
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
- **Learnings (`runWavesIsolated` only)**: each
  attempt calls `ensureNotesIgnored` on its worktree
  before the agent runs, and `collectNotes` right
  after the agent exits, before any auto-commit or
  worktree removal; the notes become
  `agentRun.notes`. Each attempt then appends one
  entry to `learnings.md` next to the feature's
  `progress.md` (`learningsPathFor`): `ready` ->
  `done`, `failed` -> its reason (`exit`, `tests` or
  `install`, the last two with the last
  `LOG_TAIL_LINES` lines of the attempt's
  `.test.log` or `.install.log`), `no-commits` ->
  `no-commits`, `error` and `worktree-error` ->
  `error`. The entry's exit code always comes from
  `agentRun`, never from the outcome's top-level
  `exitCode`. `agentRun` carries `subagents` and
  `costUsd` when the `AgentResult` has them (claude
  runs), so the entry shows them (see `renderEntry`).
  Every attempt rebuilds the prompt
  history from the log, so a retry sees the entry its
  previous attempt just wrote: the ticket's last
  `MAX_OWN_ENTRIES` entries, plus the latest `done`
  entry of each direct blocker in the same feature.
  Right after each wave's pool settles, every touched
  learnings file that is a regular file is committed
  (`nightralph: record attempt learnings`), so the
  base tree has no modified tracked files before
  `mergeWave`; `saveProgress` also stages it with
  `progress.md`, so the log is committed at every
  terminal point. An unrecovered merge failure
  appends a `merge` entry (git's stderr), committed
  by the `saveProgress` that follows. Learnings are
  advisory: a failure to read, append, set up or
  collect notes, or commit is logged through the
  display and never fails a ticket
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
- **dryRun(tickets, specBody, testCmd, preferSubagent?)**:
  in-place dry run; prints the wave order,
  `Test command: <cmd>` (`(none)` for `''`),
  `Prefer subagent: <model>` (`(none)` when unset or `''`)
  and the first ready ticket's prompt, rendered with
  `preferSubagent`
- **dryRunIsolated(opts)**: prints simulated wave order
  with worktree paths and branch names; requires
  `testCmd` (prints `Test command: (none)` for `''`); accepts
  `installCmd`, `effort`, `retries`,
  `retryDelay`, `concurrency` and `preferSubagent` in
  opts and prints them (`Prefer subagent: (none)` when
  unset); the sample prompt is rendered with
  `preferSubagent`

### testcmd module (`src/testcmd.ts`)
- **Exposes**: `TestResult`,
  `detectTestCmd(projectDir)`,
  `detectInstallCmd(projectDir)`, `runTestCmd(opts)`
- **TestResult**: `{ exitCode, output }` -- `output`
  is stdout and stderr interleaved
- **detectTestCmd(projectDir)**: returns `'npm test'`
  when `<projectDir>/package.json` declares a `test`
  script, else `null`
- **detectInstallCmd(projectDir)**: picks the install
  command from the lockfile, never one that writes a
  lockfile: `pnpm-lock.yaml` ->
  `pnpm install --prefer-offline --frozen-lockfile`;
  `package-lock.json` ->
  `npm ci --prefer-offline --no-audit --no-fund`;
  `package.json` alone ->
  `npm install --prefer-offline --no-audit --no-fund
  --no-package-lock`; no `package.json` -> `null`
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

### preflight module (`src/preflight.ts`)
- **Exposes**: `ResolveExecutableOpts`,
  `resolveExecutable(cmd, opts?)`
- **resolveExecutable(cmd, opts?)**: `opts` is
  `{ path?, cwd? }` (default `process.env.PATH` and
  `process.cwd()`). A `cmd` containing `/` is resolved
  against `cwd`; it returns the absolute path when that is
  an executable file. A bare name is looked up in each
  `path` entry in order (empty entries are skipped); the
  first executable file wins. Everything else (including
  `''`) is `null`
- **Guarantees**: synchronous, no side effects, imports only
  `node:fs` and `node:path`, spawns nothing, never throws.
  It checks that the path is a file with the execute bit,
  not that the command runs

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
  `setTicketStats(num, feature, stats)`,
  `log(message)`, `cleanup()`. `tickets` are
  `TicketRef`s. `setTicketStatus`, `setBlocked` and
  `setTicketStats` find the row by `num` and `feature`
  (by `num` alone when `feature` is omitted or
  `undefined`) and ignore unknown tickets.
  `setTicketStats` takes a `SubagentStats` (the ticket's
  running total across attempts) and replaces the row's
  stats with a copy
- **TicketRef**: `{ num, filename, feature? }` -- the
  identity a caller passes in; `DisplayTicket` adds
  `status`, optional `blockedBy` and optional `stats`
  (`SubagentStats`)
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
- **Row stats**: a `StatusDisplay` row is the label, the
  `(blocked by ...)` text when blocked, then
  ` - <formatStats(stats)>` (e.g. `a/03 - 2 subagents,
  $0.42`) whenever `formatStats` is non-null, in any
  status. The whole row text goes through `fitLine`, so
  the suffix never widens a row past the width guarantee
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
  `startRun`, `setTicketStatus`, `setBlocked` and
  `setTicketStats` are no-ops (it has no fixed list)
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
  `getCurrentBranch(cwd?)`, `localBranchExists(repoRoot,
  name)`, `getDefaultBranch(repoRoot)`,
  `integrationBranchName(features)`,
  `planIntegrationBranch(current, defaultBranch,
  features)`, `IntegrationPlan`,
  `prepareIntegrationBranch(repoRoot, features)`,
  `describeIntegrationBranch(repoRoot, features)`,
  `buildBranchName(repoName, ticket)`,
  `createWorktree(opts)`, `createNamedWorktree(opts)`,
  `removeWorktree(path, opts?)`,
  `deleteBranch(repoRoot, name)`,
  `listWorktrees(repoRoot)`, `headCommit(cwd)`,
  `mergeBase(cwd, a, b)`, `isAncestor(cwd, ancestor, of)`,
  `hasChangesOutside(cwd, from, to, excludeDir)`
- **getDefaultBranch(repoRoot)**: `origin/HEAD` with
  `origin/` stripped when it exists, else `main` or
  `master`, whichever exists locally, else `null`
- **integrationBranchName(features)**: pure;
  `nightralph--<feature>` for exactly one distinct
  feature, else `nightralph--all`
- **planIntegrationBranch(current, defaultBranch,
  features)**: pure; the name when `current` is the
  default branch, else `null`; also `null` when the
  default branch is unknown or HEAD is detached
- **prepareIntegrationBranch(repoRoot, features)**:
  returns `IntegrationPlan` `{ branch, created, resumed,
  behind, fastForwarded, launchBranch, forkedFrom }`.
  When a name is planned it throws on a dirty tree
  before checking anything out, then checks out the
  existing branch (`resumed`, `behind` = commits the
  launch branch has that it lacks). If that branch is an
  ancestor of the launch branch (already merged) and
  behind, it is fast-forwarded with `merge --ff-only`:
  `fastForwarded:true`, `behind:0`. `fastForwarded` is
  false in every other path, and a branch with commits
  of its own is never merged or rebased. Otherwise it
  creates the branch from the current branch
  (`created`). Otherwise nothing is checked out and
  `branch` is the current branch. `forkedFrom` is the
  default branch whenever the resulting branch is the
  integration branch (even one checked out by hand),
  else `null`
- **describeIntegrationBranch(repoRoot, features)**: the
  same decision as one line for `--dry-run`, checking
  nothing out
- **createNamedWorktree(opts)**: `{ repoRoot, repoName,
  baseBranch, name }`; creates `<repo>.<name>` on branch
  `<repo>--<name>` with the same stale cleanup as
  `createWorktree`, which delegates to the shared
  creation code. Ticket branches always carry a number,
  so names cannot collide
- **deleteBranch(repoRoot, name)**: `git branch -D`; a
  missing branch is not an error. Runs on the same
  `worktreeQueue` as `createWorktree`, `createNamedWorktree`
  and `removeWorktree`
- **isAncestor / mergeBase / hasChangesOutside**: read
  only. `isAncestor` is false for an unknown commit;
  `mergeBase` is `null` on failure; `hasChangesOutside`
  is true when `from..to` changes any path outside
  `excludeDir`
- **buildBranchName**: returns the branch name for a
  ticket as `<repo>--<num>-<slug>`, with `<feature>-` before
  the number when the ticket has a feature (every CLI run);
  uses `--` instead of `/` to avoid the git ref hierarchy
  conflict that prevents creating
  `refs/heads/X/Y` when `refs/heads/X` exists
- **createWorktree**: creates a git worktree in a
  sibling directory named
  `<repo>.<feature>-<num>-<slug>` (the `<feature>-` segment is
  omitted when the ticket has no feature) on a branch named by
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
  `createWorktree`, `createNamedWorktree`,
  `removeWorktree`, `deleteBranch`, and `listWorktrees`

### progress module (`src/progress.ts`)
- **Exposes**: `TicketProgress`, `ProgressData`,
  `ProgressTracker`,
  `generateProgress(feature, tickets)`,
  `generateMultiFeatureProgress(tickets)`,
  `createProgressTracker(opts)`,
  `renderProgress(data)`, `checkTicket(data, num, result)`,
  `writeProgress(path, data)`,
  `commitProgress(repoRoot, paths, message)`,
  `readProgress(progressPath)`,
  `mergeProgress(fresh, existing)`
- **commitProgress**: `paths` is `string|string[]`;
  stages and commits only those paths. Returns
  `Promise<boolean>` --
  `true` when a commit was made, `false` when the
  staged files matched HEAD (no-op). Uses `git add
  --force` so gitignored paths (e.g. under `.scratch/`)
  are staged regardless. The orchestrator's
  `saveProgress` passes `learnings.md` along with
  `progress.md` when `learnings.md` is a regular file
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

### learnings module (`src/learnings.ts`)
- **Exposes**: constants `MAX_OWN_ENTRIES` (4),
  `MAX_ENTRY_CHARS` (4000), `LOG_TAIL_LINES` (40),
  `NOTES_PATH` (`.nightralph/notes.md`),
  `TRUNCATED_MARKER`, `LEARNING_OUTCOMES`; types
  `LearningOutcome`, `LearningEntry`,
  `AgentRunRecord`, `EntryInput`,
  `HistorySelection`; functions
  `isLearningOutcome(value)`, `renderEntry(input)`,
  `parseEntries(text)`,
  `selectHistory(entries, { key, blockerKeys })`,
  `renderHistory(selection)`, `tailLines(text, n)`,
  `learningsPathFor(progressPath)`,
  `readEntries(path)`, `appendEntry(path, text)`,
  `collectNotes(worktreePath, file?)`,
  `ensureNotesIgnored(worktreePath)`, `formatDate(date)`
- **Imports no values from `src/orchestrator.ts`**:
  callers pass the ticket key (`ticketKey`) and label
  (`ticketLabel`) in. Its only imports are `node:fs`
  and `node:path`
- **LearningOutcome**: `done`, `exit`, `tests`,
  `install`, `no-commits`, `error`, `merge`
- **LearningEntry**:
  `{ key, attempt, outcome, timedOut, body }`; `key`
  is the ticket identity (`ticketKey`); `body` is
  everything after the sentinel line, trimmed, without
  the trailing `---` separator
- **AgentRunRecord**:
  `{ exitCode, completedItems, timedOut, notes,
  subagents?, costUsd? }` -- what one agent process did;
  `notes` is `string|null`; `subagents` and `costUsd` are
  claude only, absent when not reported
- **EntryInput**: `key`, `label`, `attempt`, `now`,
  plus per-outcome fields: `done`, `exit` and
  `no-commits` carry `run` (and optional `effort`);
  `tests` carries `run` (and optional `effort`) plus
  `logName` and `logTail`;
  `install` carries only `logName` and `logTail`;
  `error` carries `error`; `merge` carries `stderr`
- **Entry format**: each entry starts with a sentinel
  line, `<!-- nightralph:entry ticket=<key>
  attempt=<n> outcome=<o> [timedout=true] -->`, then
  a `## <date> -- <label> attempt <n> -- <result>`
  heading (no `attempt <n>` for `merge`), the body,
  and a `---` line. Only `%` and
  whitespace in the key are percent-escaped, so
  `ticket=my-feature:4` stays readable. `attempt` is
  `0` for `merge` entries
- **renderEntry(input)**: pure; agent outcomes
  (`done`, `exit`, `no-commits`, `tests`) list effort
  (when set), the agent's exit code, `Subagents: <n>.`
  and `Cost: $<x>.` (two decimals; each omitted when
  absent from `run`), the checked items, and the agent's
  notes (or a line saying it
  left none); `tests` also adds the log tail in a
  fence; `install` has no agent summary, only the log
  tail in a fence; `error` and `merge` show the error
  text or git stderr in a fence
- **selectHistory(entries, { key, blockerKeys })**:
  pure; `own` is the last `MAX_OWN_ENTRIES` entries
  for `key`; `blockers` is the latest `done` entry
  for each blocker key that has one
- **renderHistory(selection)**: pure; `''` when both
  lists are empty, else a framing paragraph (the
  ticket and spec win over these records) and up to
  two sections, `PREVIOUS ATTEMPTS AT THIS TICKET` and
  `WHAT THE BLOCKING TICKETS DID`; an entry body over
  `MAX_ENTRY_CHARS` is cut and ends with
  `TRUNCATED_MARKER`
- **learningsPathFor(progressPath)**: `learnings.md`
  in the same directory as `progressPath`
- **readEntries(path)**: `[]` when the file does not
  exist; any other read error is thrown for the caller
- **Guarantees**: `parseEntries` drops malformed
  entries (missing or undecodable ticket, non-numeric
  attempt, unknown outcome) instead of throwing, and
  accepts CRLF; text before the first sentinel is
  ignored. Sentinel text inside free-text fields
  (notes, items, log tails, errors) is neutralized, so
  an entry cannot forge another. `appendEntry` is
  synchronous, so concurrent tickets in one Node
  thread never interleave appends, and creates the
  parent directory. `collectNotes` reads `file` (default
  `notes.md`; the reviewer passes `findings.md`) from
  the `.nightralph/` directory, returns it trimmed
  (blank counts as `null`) and removes the whole
  `.nightralph/` directory, also when there are no
  notes. `ensureNotesIgnored` writes
  `.nightralph/.gitignore` containing `*` inside the
  worktree, so an agent's `git add -A` cannot stage
  its notes; it writes only inside the worktree, never
  `info/exclude` (which can be a symlink shared by
  every repo on the machine, e.g. via
  `init.templateDir`)

### stats module (`src/stats.ts`)
- **Exposes**: types `SubagentStats`
  (`{ subagents, costUsd? }`), `StreamStatsState`
  (`{ stats, seenToolIds }`), `RunStats`
  (`{ agentRuns, withCost, subagents, costUsd }`);
  functions `isRecord(value)`, `emptyStreamStats()`,
  `nextStreamStats(state, obj)`, `addStats(total, run)`,
  `formatStats(stats?)`, `emptyRunStats()`,
  `addRun(run, result)`, `renderRunStats(run)`
- **Imports nothing**, so the orchestrator, display and
  tests can all use it. `isRecord` (a non-null, non-array
  object) is also what the orchestrator's stream formatter
  uses
- **nextStreamStats(state, obj)**: pure, never throws;
  folds one parsed stream-json value into the state. An
  `assistant` message with a null or missing
  `parent_tool_use_id` counts each `tool_use` block named
  `Agent` (or `Task`, the name before Claude Code 2.1.63)
  with a string `id` once per id; a non-null
  `parent_tool_use_id` (a subagent's own message) is
  ignored. A `result` message sets `costUsd` from a finite
  numeric `total_cost_usd` and replaces the count with
  `subagent_stats.spawned` when that is a non-negative
  integer; the last `result` wins. Returns the same state
  object when nothing changed (callers compare by
  identity). `stats` never carries a `costUsd:undefined`
  key
- **addStats(total, run)**: a ticket's running total over
  attempts; `costUsd` is kept once either side has one
- **formatStats(stats?)**: the row suffix,
  `<n> subagent(s)[, $<x.xx>]`; `null` for no stats or for
  zero subagents with no cost
- **addRun / renderRunStats**: `addRun` adds one
  `spawnAgent` result (`withCost` counts results that had
  a cost). `renderRunStats` is `null` when there were no
  runs or no run reported a subagent or a cost (codex and
  pi never do), else `Subagents: <n> started across <m>
  agent run(s), cost $<x.xx>`, with
  ` (cost from <k> of <m> runs)` appended when
  `withCost < agentRuns` (a killed agent never reports a
  cost)
- **Guarantees**: stats are advisory; nothing in the
  orchestrator reads them to decide an outcome

### retry module (`src/retry.ts`)
- **Exposes**: `EFFORT_LADDERS`, `ProviderName`,
  `EffortLevel`, `ALL_EFFORT_LEVELS`, `escalateEffort`,
  `retryDelayFor`, `sleep`, `AttemptStep`, `RetryOpts`,
  `runWithRetries(opts, run)`; imports nothing from
  `src/orchestrator.ts`
- **runWithRetries(opts, run)**: `opts` is `{ maxAttempts,
  retryDelay, agentCmd, effort?, label, log, wait? }`;
  `run(attempt, effort)` resolves with `{ result, stop }`.
  Calls `run` until a step says `stop` or the attempt cap
  is hit, and returns the last step's `result`. The cap
  is clamped to at least 1, so there is always one
  attempt. Before each retry, for a known provider
  (`basename(agentCmd)` in `EFFORT_LADDERS`) the effort
  goes through `escalateEffort`, then it waits
  `retryDelayFor(retryDelay, attempt)` seconds (no wait
  at 0; `wait` is a test seam, default `sleep`). Logs
  `Starting <label>` and then `<label>: retrying
  (attempt n/m[, effort x][, waiting ys])`.
  `runTicketAttempts`, the reviewer and the fixer all
  run on it

### rules module (`src/rules.ts`)
- **Exposes**: `readDocsRule`, `installRule`,
  `subagentRule`, `testGateRule`, `LINT_RULE`,
  `integrityRule`, `CONFINEMENT_RULES`, `commitRule`,
  `notesRule`, `agentsMdRule`
- **Guarantees**: the rule lines `renderPrompt` and
  `renderFixPrompt` share, parameterized by the unit of
  work (`checklist item` or `finding`) and the subject
  the orchestrator accepts or rejects (`ticket` or
  `fix`), so the prompts cannot drift. The ticket prompt
  text is unchanged by the move. `testGateRule(testCmd,
  subject)` returns the full gate rule naming the command for
  a non-empty `testCmd`; for `''` it returns a shorter rule
  (run the relevant tests before each commit, do not commit
  with failing tests, and the orchestrator runs no test
  command for this `<subject>`)
- **subagentRule(preferSubagent?, readOnly = false)**:
  positional boolean; `[]` when `preferSubagent` is unset
  or `''`, else lines telling the agent to hand read-only
  work (exploring, code search, experiments or test runs
  whose output would flood its context) to subagents,
  naming the model they default to, to brief each one
  fully, and not to delegate a single-tool-call lookup,
  plus a line that subagents never edit files or run git
  commands that write (the agent makes every edit and
  commit). `readOnly` drops that edit/commit line. Used
  by all four prompt builders: `renderPrompt`,
  `renderMergePrompt` and `renderFixPrompt` after their
  install rule, and `renderReviewPrompt` with `readOnly`
  (`subagentRule(opts.preferSubagent, true)`)

### review module (`src/review.ts`)
- **Exposes**: `FINDINGS_FILE`, `FINDINGS_PATH`,
  `NO_FINDINGS`, `REVIEW_EXCLUDE`, `REVIEW_STATUSES`,
  types `ReviewStatus`, `Finding`, `FixRecord`,
  `ReviewEntryInput`, `ReviewEntry`, `ReviewOutcome`,
  `FixFailure`, `FixResult`, `ReviewDeps`,
  `SpawnAgentFn`, `ReviewPassOpts`; pure `reviewExcludeFor`, `reviewDiffCommand`,
  `renderReviewPrompt`, `renderFixPrompt`,
  `parseFindings`, `markFixed`, `renderReviewEntry`,
  `parseReviewEntries`, `selectReviewBase`,
  `renderReviewSummary`; effectful `readReviewEntries`,
  `runReviewer`, `runFixer`, `runReviewPass(opts, deps)`
- **Imports no values from `src/orchestrator.ts`**
  (only the `AgentResult` type): it calls `runTestCmd`,
  the worktree helpers, `mergeBranch`, `commitProgress`
  and `appendEntry` directly. The orchestrator injects
  `deps` `{ spawnAgent, registry? }`; `registry` is the
  running-process set, so SIGINT kills review installs
  and test gates too. `spawnAgent` is a `SpawnAgentFn`,
  whose opts include `preferSubagent?`; the orchestrator
  passes a wrapper that tallies each result into the run
  stats
- **preferSubagent**: `ReviewPassOpts.preferSubagent?`
  (claude only; unset = off) is passed to
  `renderReviewPrompt` and `renderFixPrompt` (both take
  `preferSubagent?` in their opts) and to every reviewer
  and fixer `spawnAgent` call
- **Review log**: `review.md`, append-only, one entry per
  pass. Each starts with a sentinel
  `<!-- nightralph:review from=<sha> to=<sha>
  status=<status> -->`, then a
  `## <date> -- review <from>..<to> -- <result>` heading,
  the findings as `- [ ]`/`- [x]` lines with indented
  detail, an optional `### Fix` section (attempts,
  effort, agent exit code, result, the fixer's notes),
  and a `---` line. `status` is `clean`, `fixed`,
  `unresolved` or `review-failed`. Sentinel text inside
  findings and notes is neutralized, so an entry cannot
  forge another. `parseReviewEntries` drops malformed
  entries (missing or non-hex `from`/`to`, unknown
  status) instead of throwing, accepts CRLF, and ignores
  text before the first sentinel
- **Marker rule**: `to` is the integration tip after the
  fix merged, else the tip at review time, so the next
  run reviews only newer work. `selectReviewBase` is
  pure: the `to` of the latest entry whose status is not
  `review-failed`, when `isAncestor(to)` holds; else
  `forkPoint` (the merge-base of `forkedFrom` and the
  tip, when the run is on an integration branch); else
  `launchCommit`. A `review-failed` entry never moves
  the marker
- **Skip rule**: `runReviewPass` returns
  `{ status:'skipped' }` without running an agent or
  writing an entry when `from..tip` changes nothing
  outside the exclude dir, because
  tickets, progress, learnings and `review.md` are
  bookkeeping; this keeps the commit that records a
  review from making the next range look non-empty. The
  diff the reviewer is told to read excludes it too. The
  exclude is `reviewExcludeFor(repoRoot, reviewPath)`:
  the nearest ancestor of `reviewPath` named `.scratch`,
  relative to the repo root (so a run launched from a
  subdirectory excludes the right path), falling back to
  `REVIEW_EXCLUDE` (`.scratch`) when there is none
- **runReviewer**: per attempt, a named worktree `review`
  (`<repo>.review` on `<repo>--review`) off the base
  branch, `ensureNotesIgnored`, optional `installCmd`
  (an install failure fails the attempt), then the agent
  with `renderReviewPrompt`. Success is decided by
  `.nightralph/findings.md` alone, collected with
  `collectNotes(wt, 'findings.md')`: `parseFindings`
  gives the checklist, `[]` for an explicit
  `No findings.`, and `null` (a failed attempt) for a
  missing, blank or unparseable file. A file written
  before a timeout kill still counts. The worktree and
  its branch are always removed (`finally`), so nothing
  the reviewer changed or committed reaches the base
  branch. Returns the findings, or `null` after the last
  attempt
- **runFixer**: runs only when there are findings. Per
  attempt, a named worktree `review-fix`
  (`<repo>.review-fix`) off the base branch, install,
  then the agent with `renderFixPrompt`. After it: notes
  are collected before any auto-commit; a non-zero exit
  (a timeout is not one) fails the attempt; dirty
  changes are auto-committed; no new commits fails; a
  red test gate (`review-fix.test.log`) fails, and
  `testCmd:''` skips the gate, writes no test log and logs
  `review fix: no test gate`; only then
  is the branch merged into the base branch from the main
  checkout, and a merge conflict fails the attempt with
  git's stderr appended to the notes. A failure is one of
  `install`, `exit`, `no-commits`, `tests`, `merge`, and
  the next attempt's prompt carries that reason and the
  failed attempt's notes. After the last attempt nothing
  is merged and every finding stays unchecked. On a
  merge, findings are checked per the fixer's `[x]`
  lines (`markFixed`: whitespace-collapsed,
  case-insensitive). Worktrees are removed in `finally`.
  `renderFixPrompt` shares `testGateRule` with `renderPrompt`,
  so `testCmd:''` yields the no-gate rule
- **Retry behavior**: reviewer and fixer each get
  `retries + 1` attempts through `runWithRetries`, so
  they escalate effort and back off like a ticket; logs
  are `review.log`, `review.attempt<n>.log`,
  `review.install.log`, `review-fix.log`,
  `review-fix.attempt<n>.log`, `review-fix.test.log`
  and their attempt variants in `logsDir`. Review
  attempts are not written to `learnings.md`
- **runReviewPass(opts, deps)**: reviews everything since
  `selectReviewBase`, runs the fixer when there are
  findings, appends one entry (`clean` for none, `fixed`
  when the fix merged, `unresolved` when it did not,
  `review-failed` when the reviewer never produced a
  usable file) and commits `review.md`
  (`nightralph: record review`). Returns `ReviewOutcome`
  `{ status, findings, fixed }`. `opts.testCmd` is required;
  `''` means the fixer runs without a test gate
- **renderReviewSummary(outcome, reviewPath)**: pure; one
  line naming the finding count, the fixed count and the
  file, e.g. `Review: 3 findings, 2 fixed -- see <path>`;
  `null` for `skipped`
- **Guarantees**: advisory. This module lets errors
  propagate; `runWavesIsolated` catches them (see
  orchestrator). SIGINT kills the agent through
  `killRunningAgents` as for tickets and no entry is
  written

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
