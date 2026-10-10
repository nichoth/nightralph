# Prefer Subagent Design

## Summary

This feature adds an opt-in `--prefer-subagent <model>` flag to
nightralph. When it is set and the provider is claude, every spawned
agent (ticket runs, merge-conflict respawns, the reviewer and the
fixer) gets the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable. It
also gets a short prompt rule telling it to hand read-only work
(exploration, code search, noisy test runs) to subagents running that
model, while the main agent keeps making every edit and commit. The
flag value travels down the same path as the existing `effort` option.
When the flag is absent, spawns and prompts are byte-identical to
today. For codex and pi, the CLI warns once and drops the value.

Separately, and whether or not the flag is used, nightralph starts
measuring subagent activity for claude runs. A new pure module,
`src/stats.ts`, reads claude's stream-json output line by line. It
counts subagents started by the main agent and picks up the final
count and total cost from the closing `result` message. `spawnAgent`
returns these numbers and also reports them live. They are then shown
in three places: extra lines in `learnings.md` entries, a suffix on
each ticket's row in the terminal display, and a one-line total after
the finish summary. The stats are advisory only. They never change a
ticket's outcome, an exit code, or the finish summary text.

## Definition of Done

`nightralph claude --prefer-subagent <model>` sets
`CLAUDE_CODE_SUBAGENT_MODEL` for every spawned claude agent (ticket,
merge respawn, reviewer, fixer) and adds a prompt rule: subagents do
read-only exploration, search and experiments/test runs; the main agent
makes every edit and commit. Without the flag, prompts and env are
unchanged; codex/pi warn once and skip; `--dry-run` prints it.

Every claude attempt, flag or not, records subagents started and
`total_cost_usd`, shown in `learnings.md` entries, finish-summary
totals, and live display rows.

Docs state the model is a fallback, and that subagent turns do not
count toward `--max-turns` (verified on Claude Code 2.1.296).

Out of scope: `--agents` JSON workers, per-model cost breakdown,
codex/pi subagents.

## Acceptance Criteria

### prefer-subagent.AC1: Flag and env
- **prefer-subagent.AC1.1 Success:** `--dry-run --prefer-subagent X`
  prints `Prefer subagent: X`
- **prefer-subagent.AC1.2 Success:** `--dry-run` without the flag
  prints `Prefer subagent: (none)`
- **prefer-subagent.AC1.3 Failure:** with provider codex or pi, one
  warning is printed, the run continues (dry run exits 0), and no
  agent gets the env var or the prompt rule
- **prefer-subagent.AC1.4 Success:** a claude spawn with the option
  has `CLAUDE_CODE_SUBAGENT_MODEL=X` in its env, overriding a value
  exported in the parent shell
- **prefer-subagent.AC1.5 Success:** a claude spawn without the
  option leaves the env untouched: a shell value is inherited, none
  is added
- **prefer-subagent.AC1.6 Success:** the option reaches ticket,
  merge-respawn, reviewer and fixer spawns
- **prefer-subagent.AC1.7 Edge:** `--prefer-subagent ""` behaves
  exactly like an absent flag

### prefer-subagent.AC2: Prompt rule
- **prefer-subagent.AC2.1 Success:** `renderPrompt`,
  `renderMergePrompt`, `renderFixPrompt` and `renderReviewPrompt` are
  identical to today's output when the option is unset
- **prefer-subagent.AC2.2 Success:** when set, each prompt includes
  the lines `subagentRule` returns
- **prefer-subagent.AC2.3 Success:** the reviewer prompt gets the
  read-only variant, without the edit/commit line
- **prefer-subagent.AC2.4 Edge:** `subagentRule('')` and
  `subagentRule()` return `[]`

### prefer-subagent.AC3: Stats capture
- **prefer-subagent.AC3.1 Success:** a main-loop `Agent` tool_use
  counts one subagent
- **prefer-subagent.AC3.2 Success:** a main-loop `Task` tool_use
  counts one subagent
- **prefer-subagent.AC3.3 Edge:** a message with a non-null
  `parent_tool_use_id` is not counted
- **prefer-subagent.AC3.4 Edge:** a repeated tool_use id counts once
- **prefer-subagent.AC3.5 Success:** a `result` sets the cost and
  replaces the count with `subagent_stats.spawned`; the last of
  several results wins and nothing is summed; a result without
  `subagent_stats` keeps the live count
- **prefer-subagent.AC3.6 Failure:** non-JSON lines, non-objects and
  wrong-typed fields leave the state unchanged and never throw
- **prefer-subagent.AC3.7 Success:** `spawnAgent` returns the final
  stats in `AgentResult`, and `onStats` fires on each change, in
  order
- **prefer-subagent.AC3.8 Edge:** a timed-out agent reports the live
  count and no cost

### prefer-subagent.AC4: learnings.md
- **prefer-subagent.AC4.1 Success:** `done`, `exit`, `no-commits`
  and `tests` entries show the subagent count and cost
- **prefer-subagent.AC4.2 Edge:** each line is omitted when its value
  is absent
- **prefer-subagent.AC4.3 Edge:** `install`, `error` and `merge`
  entries carry neither line
- **prefer-subagent.AC4.4 Success:** new entries round-trip through
  `parseEntries`, and entries written before this change still parse

### prefer-subagent.AC5: Display
- **prefer-subagent.AC5.1 Success:** `setTicketStats` adds a suffix
  to that ticket's row
- **prefer-subagent.AC5.2 Success:** the row shows the running total
  across attempts; a retry adds to the prior attempts
- **prefer-subagent.AC5.3 Edge:** rows with stats never exceed
  `stream.columns - 1` visible characters
- **prefer-subagent.AC5.4 Edge:** an unknown ticket is ignored;
  `PlainDisplay.setTicketStats` is a no-op

### prefer-subagent.AC6: Finish line
- **prefer-subagent.AC6.1 Edge:** `renderRunStats` returns `null`
  when no run reported anything
- **prefer-subagent.AC6.2 Success:** the line has the subagent total,
  the agent-run count and the cost
- **prefer-subagent.AC6.3 Edge:** the partial-cost marker appears
  only when some runs reported no cost
- **prefer-subagent.AC6.4 Success:** the tally includes ticket
  attempts, merge respawns, the reviewer and the fixer
- **prefer-subagent.AC6.5 Success:** both runners log the line after
  the finish summary
- **prefer-subagent.AC6.6 Edge:** a codex or pi run logs no stats
  line

### prefer-subagent.AC7: Cross-cutting
- **prefer-subagent.AC7.1 Failure:** `[x]` text from a subagent
  message never checks off ticket items
- **prefer-subagent.AC7.2 Success:** stats never change a ticket's
  outcome, an exit code, or `renderFinishSummary` output

## Glossary

- **Subagent**: A helper agent that the main Claude Code agent starts
  mid-session to do a delegated task in its own context window. It
  returns a reply to the main agent.
- **Main agent / main loop**: The top-level claude process working a
  ticket, as opposed to subagents it spawns. Stats count only
  subagents started from the main loop.
- **`CLAUDE_CODE_SUBAGENT_MODEL`**: Environment variable that tells
  Claude Code which model subagents use by default. It is a fallback:
  a per-call model or the built-in Explore subagent overrides it.
- **`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`**: Companion variable that would
  make the model mandatory. The design deliberately never sets it.
- **stream-json**: Claude Code's line-delimited JSON output mode. Each
  stdout line is one event (`assistant`, `result`, and so on). The
  stats core parses these events.
- **`tool_use` block / `Agent` and `Task` tools**: A tool call inside
  an assistant message. Starting a subagent appears as a `tool_use`
  named `Agent` (named `Task` before Claude Code 2.1.63). Both names
  are accepted.
- **`parent_tool_use_id`**: Field on a stream message. It is non-null
  when the message came from inside a subagent, so the stats core and
  `formatStreamLine` use it to ignore subagent messages.
- **`result` message / `total_cost_usd` / `subagent_stats.spawned`**:
  The closing event of a claude run. It carries cumulative cost and,
  on newer versions, the authoritative subagent count. A process can
  emit several `result` messages, and the last one wins.
- **`--max-turns`**: Existing flag capping agentic turns per ticket.
  The docs note that subagent turns do not count toward it.
- **`--timeout`**: Existing flag that kills a still-running agent
  after N seconds. Subagent time counts against it.
- **ticket**: One markdown issue file under `.scratch/<feature>/`. A
  single agent session works on it.
- **wave**: A batch of tickets with no unmet blockers that run
  concurrently, then merge before the next wave.
- **isolated run / worktree**: In a git repo, each ticket runs in its
  own git worktree on its own branch, and branches merge back after
  the wave. In-place runs (`runWaves`) skip this.
- **merge respawn**: When a branch conflicts on merge, nightralph
  starts an agent again to resolve the conflict.
- **reviewer / fixer / review pass**: The advisory end-of-run step.
  The reviewer agent writes findings and the fixer agent applies them.
  Both are claude spawns that receive the flag.
- **`spawnAgent`**: The orchestrator function that launches the
  provider process, parses its output and returns an `AgentResult`.
- **`AgentResult` / `AgentRunRecord`**: Result objects for one agent
  process. This design adds optional `subagents` and `costUsd` fields.
- **`learnings.md`**: Per-feature append-only log of each attempt's
  outcome and notes. Later attempts read it as history.
- **Display / `StatusDisplay` / `PlainDisplay`**: The terminal UI
  interface. `StatusDisplay` is the live ANSI grid for TTYs.
  `PlainDisplay` is the non-TTY fallback.
- **`fitLine`**: Display helper that clamps a row to the terminal
  width. Stats suffixes pass through it.
- **`installRule` / `rules.ts`**: The existing pattern for optional
  prompt rule lines, returning `string[]` and empty when unset. The
  new `subagentRule` copies it.
- **`renderPrompt` / `renderMergePrompt` / `renderFixPrompt` /
  `renderReviewPrompt`**: The four prompt builders that receive the
  new rule.
- **yargs**: The CLI argument parsing library used for the flag.
- **esbuild (second call in `package.json`)**: The bundler step that
  must list each new `src/` module to emit a standalone
  `dist/<name>.js`.
- **tapzero / `scripts/test.sh` `TESTS`**: The test framework and the
  explicit suite list. A new test file must be added to the list.
- **`spawnCli` / mock-agent fakes**: Test helpers. `spawnCli` runs the
  built CLI as a subprocess. The fakes are stand-in agent executables.
- **Acceptance criteria IDs (`prefer-subagent.ACn.m`)**: Numbered,
  testable requirements that phases cite in their "Done when" lines.

## Architecture

Three parts: a flag that reaches every spawned claude agent, a pure
stats core fed by claude's stream-json, and three places the stats
are shown.

### Flag, env and prompt rule

`--prefer-subagent <model>` is a yargs string option in
`src/index.ts`. Absent or `""` means off. The value is not validated.
After the provider preflight, `runExecute` prints one warning for a
non-claude provider (`--prefer-subagent not supported by <provider>,
skipping`) and drops the value, so nothing downstream sees it.
`--dry-run` prints `Prefer subagent: <model>` or `(none)`.

The value travels as `preferSubagent?:string` on the same path as
`effort`: `runWaves` and `runWavesIsolated`, `runTicketAttempts`, the
merge respawn (`respawnAndRetryMerge`), `ReviewPassOpts`,
`runReviewer`, `runFixer`, and `spawnAgent`. `dryRun` and
`dryRunIsolated` accept and print it.

When set and the provider is claude, `spawnAgent` spawns with
`env:{ ...process.env, CLAUDE_CODE_SUBAGENT_MODEL:<model> }`. When
unset, `spawn` gets no `env` option, so an exported shell value still
applies. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is never set: the model is
a preference.

`src/rules.ts` gains `subagentRule(preferSubagent?, opts?)`, returning
`string[]` like `installRule`: `[]` when unset, so every prompt is
unchanged without the flag. The lines tell the agent to delegate
read-only exploration, code search and experiments or test runs whose
output would flood its context; to brief each subagent with the
objective, known facts, boundaries and the expected reply (file:line
references, or pass/fail with relevant output) because a subagent
starts with no context; that subagents never edit files or run git
write commands, and the main agent makes every edit and commit; and
not to delegate a lookup that takes one tool call. `opts.readOnly`
drops the edit/commit line for the reviewer. `renderPrompt`,
`renderMergePrompt`, `renderFixPrompt` and `renderReviewPrompt` each
take `preferSubagent?` and include the lines.

### Stats core (`src/stats.ts`)

A new pure module that imports nothing from `src/orchestrator.ts`.

```ts
export interface SubagentStats {
    subagents:number
    costUsd?:number
}

export interface StreamStatsState {
    stats:SubagentStats
    seenToolIds:ReadonlySet<string>
}

export interface RunStats {
    agentRuns:number    // spawnAgent results tallied
    withCost:number     // of those, how many reported a cost
    subagents:number
    costUsd:number
}

export function nextStreamStats (
    state:StreamStatsState,
    obj:unknown
):StreamStatsState

export function emptyRunStats ():RunStats
export function addRun (
    run:RunStats,
    result:{ subagents?:number, costUsd?:number }
):RunStats
export function renderRunStats (run:RunStats):string|null
```

`nextStreamStats` rules:

- A main-loop `assistant` message (`parent_tool_use_id` null or
  absent) with a `tool_use` block named `Agent` or `Task` (renamed in
  Claude Code 2.1.63; both accepted) adds one subagent, de-duplicated
  by tool_use id.
- A `result` message sets `costUsd` from a numeric `total_cost_usd`
  and, when `subagent_stats.spawned` is a number, replaces
  `subagents` with it. A later `result` replaces earlier values;
  nothing is summed. A process can emit several `result` messages
  (a background subagent's completion notice restarts the main
  loop), and `total_cost_usd` is cumulative.
- Anything else, including non-objects and wrong-typed fields,
  returns the state unchanged. It never throws.

The live count covers only parent-started subagents; Claude's
`spawned` can include nested ones. The final value wins on a clean
finish.

`renderRunStats` returns `null` when `agentRuns` is 0 or no run
reported anything, else one line:
`Subagents: <n> started across <agentRuns> agent runs, cost $<x>`,
with ` (cost from <withCost> of <agentRuns> runs)` appended when
`withCost < agentRuns`.

### Capture in `spawnAgent`

`AgentResult` gains optional `subagents?:number` and
`costUsd?:number`; absent means not reported (always so for codex and
pi). `spawnAgent` takes `onStats?:(stats:SubagentStats) => void`. In
the claude branch of the stdout loop each line is `JSON.parse`d once;
the object feeds `nextStreamStats` and the existing formatting. When
stats change, `onStats` fires. `finish()` copies the final stats into
`AgentResult`. A killed or timed-out agent has no `result`, so it
reports the live count and no cost.

`formatStreamLine` skips `assistant` messages with a non-null
`parent_tool_use_id`, so subagent text can never produce `[x]` items
if `--forward-subagent-text` is ever enabled.

### Where stats appear

- **learnings.md** (isolated runs): `AgentRunRecord` gains optional
  `subagents?` and `costUsd?`, copied from `AgentResult` in
  `runTicketAttempts`. `renderEntry` adds `Subagents: <n>` and
  `Cost: $<x>` lines for agent outcomes (`done`, `exit`,
  `no-commits`, `tests`), each omitted when absent. `parseEntries`
  is unchanged; it does not read the body structurally.
- **Display rows**: `Display` gains
  `setTicketStats(num, feature, stats:SubagentStats)`.
  `DisplayTicket` gains `stats?`. `StatusDisplay` renders a suffix
  such as `a/03 - 2 subagents, $0.42`, following the
  `(blocked by ...)` precedent and clamped by `fitLine`. The value is
  the ticket's running total: `runTicketAttempts` keeps the sum of
  finished attempts and adds the current attempt's `onStats` value.
  `PlainDisplay.setTicketStats` is a no-op. Merge respawns, the
  reviewer and the fixer have no row.
- **Finish line**: both `runWaves` variants create a `RunStats` tally
  and pass it down in opts; every `spawnAgent` result (ticket
  attempts, merge respawns, and, through the wrapped
  `deps.spawnAgent`, the reviewer and fixer) goes through `addRun`.
  After `renderFinishSummary` (signature unchanged), each runner logs
  `renderRunStats(tally)` when non-null. The review pass runs before
  the summary, so it is included.

In-place `runWaves` gets display rows and the finish line, not
learnings (it has none).

## Existing Patterns

- **Option threading** follows `effort` and `maxTurns`: one optional
  field per opts type from `src/index.ts` down to `spawnAgent`
  (`src/orchestrator.ts`), and through `ReviewPassOpts`,
  `runReviewer` and `runFixer` in `src/review.ts`.
- **Optional prompt rule** follows `installRule` in `src/rules.ts`:
  a `string[]` that is empty when the option is unset, so prompts are
  byte-identical without it. `renderMergePrompt` and
  `renderReviewPrompt` do not use `rules.ts` today; this design adds
  the new rule to both by hand rather than refactoring them.
- **Pure module with no orchestrator imports** follows
  `src/learnings.ts`. `src/stats.ts` must be added to the second
  esbuild call in `package.json`, and `test/stats.test.ts` to `TESTS`
  in `scripts/test.sh`.
- **Row suffix** follows the `blockedBy` suffix in `src/display.ts`;
  **display no-op** follows `PlainDisplay.setBlocked`.
- **Advisory side data** follows learnings: failures never change a
  ticket's outcome.
- **Provider-specific flag warning** diverges from `--max-turns`,
  which warns on every spawn. This flag warns once in `runExecute`
  and drops the value, as chosen during clarification.
- **Test fakes**: existing `test/mock-agent-*.js` fakes do not emit
  stream-json. A new fake named `claude` (so `spawnAgent` takes the
  claude branch) emits scripted stream-json and echoes
  `CLAUDE_CODE_SUBAGENT_MODEL`.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Stats core
**Goal:** Pure functions that turn stream-json objects into subagent
stats and render run totals.

**Components:**
- `src/stats.ts` -- `SubagentStats`, `StreamStatsState`, `RunStats`,
  `nextStreamStats`, `emptyRunStats`, `addRun`, `renderRunStats`
- `package.json` -- add `src/stats.ts` to the second esbuild call
- `test/stats.test.ts`, listed in `scripts/test.sh`

**Dependencies:** None

**Done when:** `npm run build` emits `dist/stats.js`; tests for
prefer-subagent.AC3.1 to AC3.6 and AC6.1 to AC6.3 pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Capture and env in `spawnAgent`
**Goal:** `spawnAgent` sets the env var, reports live stats, and
returns final stats.

**Components:**
- `src/orchestrator.ts` -- `AgentResult` optional fields;
  `spawnAgent` opts `preferSubagent?` and `onStats?`; single parse per
  line in the claude branch; `env` on `spawn`; `formatStreamLine`
  skips subagent messages
- New fake `claude` executable under `test/` emitting scripted
  stream-json and echoing `CLAUDE_CODE_SUBAGENT_MODEL`
- `test/orchestrator.test.ts` -- spawnAgent and formatStreamLine cases

**Dependencies:** Phase 1

**Done when:** tests for prefer-subagent.AC1.4, AC1.5, AC3.7, AC3.8
and AC7.1 pass.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Prompt rule
**Goal:** All four prompts carry the delegation rule when the option
is set, and are unchanged otherwise.

**Components:**
- `src/rules.ts` -- `subagentRule(preferSubagent?, opts?)`
- `src/orchestrator.ts` -- `renderPrompt`, `renderMergePrompt` take
  `preferSubagent?`
- `src/review.ts` -- `renderFixPrompt`, `renderReviewPrompt` take
  `preferSubagent?` (reviewer uses `readOnly`)
- Tests in `test/orchestrator.test.ts` and the review tests

**Dependencies:** None (independent of Phases 1-2)

**Done when:** tests for prefer-subagent.AC2.1 to AC2.4 pass.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: CLI flag and threading
**Goal:** `--prefer-subagent` reaches every spawned claude agent and
its prompt; non-claude providers warn once; dry runs print it.

**Components:**
- `src/index.ts` -- yargs option, warn-and-drop after preflight,
  pass to runners and dry runs
- `src/orchestrator.ts` -- `preferSubagent?` on `runWaves`,
  `runWavesIsolated`, `runTicketAttempts`, `respawnAndRetryMerge`,
  `dryRun`, `dryRunIsolated`; passed to `spawnAgent` and the prompt
  renderers
- `src/review.ts` -- `ReviewPassOpts`, `runReviewer`, `runFixer`
- `test/integration.test.ts` -- `spawnCli` dry-run cases

**Dependencies:** Phases 2 and 3

**Done when:** tests for prefer-subagent.AC1.1 to AC1.3, AC1.6 and
AC1.7 pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Surfacing stats
**Goal:** Stats appear in learnings entries, live display rows, and
the finish line.

**Components:**
- `src/learnings.ts` -- `AgentRunRecord` optional fields;
  `renderEntry` lines
- `src/display.ts` -- `setTicketStats`, `DisplayTicket.stats`,
  `StatusDisplay` row suffix, `PlainDisplay` no-op
- `src/orchestrator.ts` -- `runTicketAttempts` per-ticket running
  total and `onStats` wiring; `RunStats` tally in both runners,
  merge respawns and the wrapped review `deps.spawnAgent`; log
  `renderRunStats` after `renderFinishSummary`
- Tests in learnings, display and orchestrator suites

**Dependencies:** Phases 1, 2 and 4

**Done when:** tests for prefer-subagent.AC4.1 to AC4.4, AC5.1 to
AC5.4, AC6.4 to AC6.6 and AC7.2 pass.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Docs and contracts
**Goal:** README and AGENTS.md describe the flag, its limits and the
new contracts.

**Components:**
- `README.md` -- `--prefer-subagent` section: model is a fallback
  (per-call model and Explore override it); subagent turns do not
  count toward `--max-turns` (observed on Claude Code 2.1.296);
  subagent time counts against `--timeout`; global `~/.claude`
  plugins and hooks load in spawned agents; where stats appear
- `AGENTS.md` -- CLI, orchestrator (`spawnAgent`, `AgentResult`,
  `formatStreamLine`), rules, learnings, display, review contracts;
  new stats module contract; project structure entry

**Dependencies:** Phases 1-5

**Done when:** docs match the shipped behavior; `npm run build`,
`npm test` and `npm run lint` pass.
<!-- END_PHASE_6 -->

## Additional Considerations

**Verified behavior (Claude Code 2.1.296).** With `--max-turns 3`, a
parent that started one subagent finished with `num_turns=2` while
the subagent made 8 tool calls, one `result success`, exit 0. With
`--max-turns 2`, a parent that spent its turns hit
`error_max_turns`, the background subagent still completed, and a
second `result` followed when its completion notice restarted the
main loop. This is observed, not documented, so the README names the
version.

**Version drift.** `subagent_stats` and the `Agent` tool name are
version-dependent. On versions without `subagent_stats` the live
count is the final count; accepting both `Agent` and `Task` covers the
2.1.63 rename.

**Global config.** Spawned agents load the user's `~/.claude` plugins
and SessionStart hooks, which can spend turns (a Skill call was
observed) and push delegation in their own way. nightralph does not
isolate them.
