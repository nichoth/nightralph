# Prefer Subagent -- Test Requirements

- **Feature:** `--prefer-subagent <model>` and subagent stats
- **Design:** `docs/design-plans/2026-10-09-prefer-subagent.md`
- **Plan:** `docs/implementation-plans/2026-10-09-prefer-subagent/`
  (`phase_01.md` to `phase_06.md`)

Every acceptance criterion below maps to at least one automated test.
The parts that depend on the real Claude Code CLI or on how a real
terminal looks are listed under Human verification.

## Conventions

- Test types: **unit** is a pure function in-process. **integration**
  means a real child process, real git, or a runner
  (`runWaves`/`runWavesIsolated`) called in-process. **e2e** means a
  `spawnCli` subprocess against `dist/index.js` (run `npm run build`
  first).
- `FAKE_CLAUDE` is `test/fake-claude/claude`, a `sh` wrapper whose
  basename selects the claude branch of `spawnAgent`. It `exec`s
  `test/mock-agent-claude.js`, which is driven by `FAKE_CLAUDE_ENV_LOG`
  (P2 T1), `FAKE_CLAUDE_STREAM` (P2 T1), `FAKE_CLAUDE_HANG` (P2 T1),
  `FAKE_CLAUDE_DELEGATE` (P4 T1) and `FAKE_CLAUDE_FAIL_ONCE` (P5 T6).
- No test pins prose. Prompt checks compare against `subagentRule(...)`
  output (P3, P4). Finish-line checks compare against
  `renderRunStats(<literal RunStats>)` and
  `renderFinishSummary(...)` computed after the run (P5 T8). The only
  literal strings are documented output contracts: the dry-run
  `Prefer subagent:` line (P4 T4) and the learnings `Subagents: <n>.` /
  `Cost: $<x>.` lines (P5 T2).
- `P<n> T<m>` means phase n, task m.

## Automated tests

### AC1: Flag and env

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC1.1 | e2e | `test/integration.test.ts` | P4 T4 | `--dry-run --prefer-subagent haiku` with `FAKE_CLAUDE`, in a non-git project (`dryRun`) and a `cliGitRepo()` project (`dryRunIsolated`): exit 0, stdout has `Prefer subagent: haiku` and every line of `subagentRule('haiku')` |
| prefer-subagent.AC1.2 | e2e | `test/integration.test.ts` | P4 T4 | Same runs without the flag: stdout has `Prefer subagent: (none)` and none of the rule lines |
| prefer-subagent.AC1.3 | e2e | `test/integration.test.ts` | P4 T4 | Providers `codex` and `pi` with `--prefer-subagent haiku --dry-run`: exit 0, `--prefer-subagent` appears exactly once in stderr, stdout has `(none)` and no rule lines |
| prefer-subagent.AC1.3 (env half) | integration | `test/orchestrator.test.ts` | P2 T3 | `spawnAgent` of `test/mock-agent-claude.js` directly (basename is not `claude`) with `preferSubagent:'haiku'`: env log reads `null`, so a non-claude spawn never gets the var even if a value slipped past the CLI drop |
| prefer-subagent.AC1.4 | integration | `test/orchestrator.test.ts` | P2 T3 | Shell has `CLAUDE_CODE_SUBAGENT_MODEL=shell-model`; `spawnAgent(FAKE_CLAUDE, preferSubagent:'haiku')` logs `'haiku'` |
| prefer-subagent.AC1.5 | integration | `test/orchestrator.test.ts` | P2 T3 | No option: the log reads `'shell-model'` when exported, `null` when the var is deleted |
| prefer-subagent.AC1.6 (ticket, in-place) | e2e | `test/integration.test.ts` | P4 T4 | Real CLI run, non-git project, `--prefer-subagent haiku --test-cmd ''`: exit 0, env log's only line is `'haiku'` (proves the positional `runWaves` arg is wired) |
| prefer-subagent.AC1.6 (ticket, isolated) | e2e | `test/integration.test.ts` | P4 T4 | Same in a committed `cliGitRepo()` project, `--no-review`, `FAKE_CLAUDE_DELEGATE=MOCK_PASS`: exit 0, log reads `'haiku'` |
| prefer-subagent.AC1.6 (merge respawn) | integration | `test/integration.test.ts` | P4 T4 | Copy of the respawn test (`installMergeFailOnceGit`, two tickets) with `FAKE_CLAUDE` + `MOCK_PASS` delegate and `preferSubagent:'haiku'`: both done, env log has 3 lines, all `'haiku'` |
| prefer-subagent.AC1.6 (reviewer, fixer) | integration | `test/review-integration.test.ts` | P4 T4 | `withHarness` run with extras `{ agentCmd:FAKE_CLAUDE, preferSubagent:'haiku' }`, `MOCK_REVIEW:'findings'`, `MOCK_FIX:'pass'`: `countRoles` is one of each, env log has 3 lines, all `'haiku'` |
| prefer-subagent.AC1.7 | e2e | `test/integration.test.ts` | P4 T4 | Dry run with `--prefer-subagent ''`: stdout equals the AC1.2 run's stdout; with `codex`, stderr has no `--prefer-subagent` warning; real in-place run with `''` and the var removed: log reads `null` |

### AC2: Prompt rule

`subagentRule(preferSubagent?, readOnly = false)` takes a positional
`readOnly` (P3 deviation from the design's `opts.readOnly`, to match
the other functions in `src/rules.ts`). Tests call it that way.

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC2.1 | unit | `test/orchestrator.test.ts`, `test/review.test.ts` | P3 T3 | For all four builders, output with the option omitted `===` output with `''` and with `undefined`, and contains no line of `subagentRule('haiku')` |
| prefer-subagent.AC2.2 | unit | `test/orchestrator.test.ts`, `test/review.test.ts` | P3 T3 | `renderPrompt`, `renderMergePrompt`, `renderFixPrompt` with `'haiku'` include every line of `subagentRule('haiku')` |
| prefer-subagent.AC2.3 | unit | `test/review.test.ts` | P3 T3 | `renderReviewPrompt` with `'haiku'` includes every line of `subagentRule('haiku', true)` and not the one line in the set difference with the full variant |
| prefer-subagent.AC2.4 | unit | `test/orchestrator.test.ts` | P3 T3 | `subagentRule('')` and `subagentRule()` deep-equal `[]`; the set variant is non-empty, each line starts `- `; the read-only variant is one line shorter and a subset |

### AC3: Stats capture

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC3.1 | unit | `test/stats.test.ts` | P1 T3 | A main-loop assistant message with an `Agent` tool_use folds to `{ subagents:1 }` |
| prefer-subagent.AC3.2 | unit | `test/stats.test.ts` | P1 T3 | Same with `Task` gives `{ subagents:1 }`; a `Bash` tool_use counts nothing |
| prefer-subagent.AC3.3 | unit | `test/stats.test.ts` | P1 T3 | `parent_tool_use_id:'toolu_x'` returns the state by identity; an absent field counts as main loop |
| prefer-subagent.AC3.4 | unit | `test/stats.test.ts` | P1 T3 | One tool_use id repeated across two messages, and twice in one message, counts 1 |
| prefer-subagent.AC3.5 | unit | `test/stats.test.ts` | P1 T3 | Result without `subagent_stats` keeps the live count and sets cost; `spawned:5` replaces the count; two results give the last values, not sums; an identical second result returns the state by identity |
| prefer-subagent.AC3.6 (pure) | unit | `test/stats.test.ts` | P1 T3 | `undefined`, `null`, `42`, `'text'`, `[]`, missing or non-array content, numeric tool_use id or name, string or `NaN` cost, `spawned` of `-1` or `1.5`: state returned by identity, no throw |
| prefer-subagent.AC3.6 (stdout) | integration | `test/orchestrator.test.ts` | P2 T3 | `FAKE_CLAUDE_STREAM` with a non-JSON line, `null`, `42` and wrong-typed lines, then a valid result: resolves with `exitCode` 0 and `costUsd` 0.1; `formatStreamLine` on each wrong-typed line does not throw |
| prefer-subagent.AC3.7 | integration | `test/orchestrator.test.ts` | P2 T3 | Two `Agent` lines then a result (`0.5`, `spawned:3`): `onStats` calls deep-equal `[{1}, {2}, {3, 0.5}]` in order; result has `subagents` 3, `costUsd` 0.5; a non-claude spawn result has no `subagents` key |
| prefer-subagent.AC3.8 | integration | `test/orchestrator.test.ts` | P2 T3 | One `Agent` line, no result, `FAKE_CLAUDE_HANG=1`, `timeout:1`: `timedOut` true, `subagents` 1, no `costUsd` key |

### AC4: learnings.md

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC4.1 | unit | `test/learnings.test.ts` | P5 T2 | `done`, `exit`, `no-commits`, `tests` with `subagents:3, costUsd:0.42` render `Subagents: 3.` and `Cost: $0.42.` |
| prefer-subagent.AC4.1 (wiring) | integration | `test/integration.test.ts` | P5 T8 | The AC5.2 retry run's `learnings.md`, parsed with `parseEntries`, has two entries whose bodies include `Subagents: 1.` (fields copied in `runTicketAttempt`) |
| prefer-subagent.AC4.2 | unit | `test/learnings.test.ts` | P5 T2 | `subagents:0` alone shows the subagents line and no `Cost:`; neither field shows neither line |
| prefer-subagent.AC4.3 | unit | `test/learnings.test.ts` | P5 T2 | `install`, `error`, `merge` entries contain neither `Subagents:` nor `Cost:` |
| prefer-subagent.AC4.4 | unit | `test/learnings.test.ts` | P5 T2 | `parseEntries(renderEntry(x))` with both fields gives one entry with the right `key`, `attempt`, `outcome`; a literal pre-change `done` entry still parses the same way |

### AC5: Display

The suffix text comes from the pure `formatStats` and the running
total from the pure `addStats`, both added to `src/stats.ts` in P5 T3.

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC5.1 | unit | `test/display.test.ts` | P5 T5 | `StatusDisplay` on a `MockStream`, two tickets, `setTicketStats(1, ...)`: ticket 1's row contains `formatStats(...)`, ticket 2's row has no suffix |
| prefer-subagent.AC5.1 (formatter) | unit | `test/stats.test.ts` | P5 T5 | `formatStats` is `null` for `undefined` and `{ subagents:0 }`, non-null for `{ 0, cost }` and `{ subagents:2 }` |
| prefer-subagent.AC5.2 (pure) | unit | `test/stats.test.ts` | P5 T5 | `addStats` sums counts and costs; no `costUsd` key when neither side has one; one side's cost is kept |
| prefer-subagent.AC5.2 (wiring) | integration | `test/integration.test.ts` | P5 T8 | `runWavesIsolated`, `retries:1`, `FAKE_CLAUDE_FAIL_ONCE`, each run reporting `{1, 0.25}`: last `setTicketStats` is `{ 2, 0.5 }` and an earlier call is `{ 2, 0.25 }` (prior total plus live count) |
| prefer-subagent.AC5.3 | unit | `test/display.test.ts` | P5 T5 | `stream.columns = 20`, long feature names, stats set: every rendered row (ANSI stripped) is at most 19 visible characters |
| prefer-subagent.AC5.4 | unit | `test/display.test.ts` | P5 T5 | Unknown `num`, or known num with the wrong feature: no throw, no row changes; `PlainDisplay.setTicketStats` writes nothing |

### AC6: Finish line

The run tally is fed by an `onAgentRun(result)` callback on every
spawn site (ticket attempts, merge respawns) and by a wrapped
`deps.spawnAgent` for the reviewer and fixer (P5 T7).

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC6.1 | unit | `test/stats.test.ts` | P1 T3 | `renderRunStats(emptyRunStats())` is `null`; still `null` after `addRun` with `{}` |
| prefer-subagent.AC6.2 | unit | `test/stats.test.ts` | P1 T3 | Two `addRun`s give `{ agentRuns:2, withCost:2, subagents:3, costUsd:0.75 }`; the line contains `3`, ` 2 ` and `0.75` |
| prefer-subagent.AC6.3 | unit | `test/stats.test.ts` | P1 T3 | `partial` (`withCost:1`) output starts with `full` (`withCost:2`) output and is strictly longer |
| prefer-subagent.AC6.4 (ticket, respawn) | integration | `test/integration.test.ts` | P5 T8 | Respawn test with the stats stream: logs contain `renderRunStats({ 3, 3, 3, 0.75 })` |
| prefer-subagent.AC6.4 (reviewer, fixer) | integration | `test/review-integration.test.ts` | P5 T8 | Harness run with `FAKE_CLAUDE_STREAM` and a log-recording display: one of each role, logs contain `renderRunStats({ 3, 3, 3, 0.75 })` |
| prefer-subagent.AC6.5 (in-place) | integration | `test/orchestrator.test.ts` | P5 T8 | In-place `runWaves`, `FAKE_CLAUDE`, one ticket: logs contain the finish summary and, at a later index, `renderRunStats({ 1, 1, 1, 0.25 })` |
| prefer-subagent.AC6.5 (isolated) | integration | `test/integration.test.ts` | P5 T8 | `runWavesIsolated`, `FAKE_CLAUDE` + `MOCK_PASS`, one ticket: the stats line follows the finish summary in the `log` calls |
| prefer-subagent.AC6.6 | integration | `test/orchestrator.test.ts` | P5 T8 | In-place `runWaves` with `test/mock-agent-noop.js` (non-claude): the finish summary is the last `log` call. The isolated runner shares the same `renderRunStats` null path, covered by AC6.1 |

### AC7: Cross-cutting

| Criterion | Type | Test file | Source | What the test checks |
|---|---|---|---|---|
| prefer-subagent.AC7.1 | integration | `test/orchestrator.test.ts` | P2 T3 | Stream with a subagent text block `[x] first item` and a main-loop `[x] second item`: `completedItems` deep-equals `['second item']` |
| prefer-subagent.AC7.1 (pure) | unit | `test/orchestrator.test.ts` | P2 T3 | `formatStreamLine` of a subagent assistant line is `null`; with `parent_tool_use_id:null` it returns the text |
| prefer-subagent.AC7.2 | integration | `test/orchestrator.test.ts` | P5 T8 | In-place run with stats, and again with an `error_max_turns`/`is_error` result plus a non-JSON line: ticket `done`, `allDone` true, finish summary equals `renderFinishSummary(tickets, 1, new Set())` computed independently |
| prefer-subagent.AC7.2 (exit code) | integration | `test/orchestrator.test.ts` | P2 T3 | The AC3.6 stdout test: a garbage stream plus a result still resolves with the agent's real `exitCode` 0. The CLI exit code follows `allDone`, checked above |

## Human verification

The fake claude replays stream-json fixtures written from the design's
reading of Claude Code. The tests prove nightralph handles that shape.
They cannot prove the real CLI emits it or honours the env var. Run
H1 to H3 once against the installed `claude` (the design observed
2.1.296; record the version you test).

**H1. The real CLI honours `CLAUDE_CODE_SUBAGENT_MODEL`** (AC1.4,
AC1.6 beyond the env log). The automated tests only show the var
reaches the child's environment.
Approach: in a scratch repo with one small `ready-for-agent` ticket
that needs a code search, run
`nightralph claude --spec <feature> --prefer-subagent haiku`. Also run
`CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p "<prompt that asks for a
subagent>" --output-format stream-json --verbose > out.jsonl`. In
`out.jsonl`, confirm the assistant messages with a non-null
`parent_tool_use_id` name a haiku model in `message.model`, and that
main-loop messages keep the default model.

**H2. The real stream-json shape matches the fixtures** (AC3.1,
AC3.3, AC3.5, AC7.1). The parser rules depend on field names that
are version-dependent.
Approach: using `out.jsonl` from H1, confirm that (a) starting a
subagent is a main-loop `tool_use` named `Agent` (or `Task` on older
versions) with a string `id`; (b) the subagent's own messages carry
`parent_tool_use_id` equal to that id; (c) the final `result` has a
numeric `total_cost_usd` and, on this version, `subagent_stats.spawned`.
Then check that the H1 nightralph run's `learnings.md` entry shows the
same `Subagents:` count and a `Cost:` matching `total_cost_usd`, and
that the finish line totals them.

**H3. `--max-turns` does not cap subagent turns** (README claim from
P6, no AC). This is observed behaviour, not documented by Anthropic.
Approach: repeat the design's experiment. Run
`claude -p "<prompt that delegates a multi-step search>" --max-turns 3
--output-format stream-json --verbose`. Confirm the `result` has
`num_turns` at or below 3 while the subagent made more tool calls
than that. If the result differs, update the README's version note.

**H4. The row suffix looks right in a real terminal** (AC5.1, AC5.3).
The unit tests check text and width on a `MockStream`, not colour,
alignment or repaint behaviour.
Approach: run H1's ticket (or two tickets, one forced to retry) in a
real TTY. Confirm the row reads like `a/03 - 2 subagents, $0.42`,
updates live while the agent runs, adds up across a retry, and stays
on one line with no stale rows after resizing the terminal narrower
than the row.

**H5. Docs review** (Phase 6, no AC; the user's rules forbid tests for
docs).
Approach: read the README `--prefer-subagent` flag row, the new
`### Subagents` section and the `### Status display` sentence, and the
AGENTS.md contract updates (CLI, orchestrator, rules, learnings,
display, review, new stats module, fake claude note) against the
shipped `src/` code. Confirm names, signatures (positional `readOnly`,
`onAgentRun`, `addStats`, `formatStats`) and printed strings match.
Run the P6 grep for em dashes and arrow characters on the diff, then
`npm run build && npm test && npm run lint`.
