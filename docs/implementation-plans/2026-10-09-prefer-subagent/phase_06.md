# Prefer Subagent Implementation Plan

**Goal:** README and AGENTS.md describe `--prefer-subagent`, its
limits, where subagent stats appear, and the new and changed
contracts.

**Architecture:** Docs only. No code changes.

**Tech Stack:** Markdown

**Scope:** Phase 6 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

**Verifies: None.** This is a documentation phase. The design's
"Done when" for it is: docs match the shipped behavior;
`npm run build`, `npm test` and `npm run lint` pass. The user's rules
forbid tests for docs.

---

## Codebase notes for the executor

- Writing rules (user's global CLAUDE.md): never use em dashes in
  markdown; use `--`. Never use the arrow character; use `->`. No
  emojis. Prefer prose over nested lists.
- Use the `ed3d-extending-claude:writing-claude-md-files` skill (or
  `writing-for-agents`) when editing AGENTS.md; keep the existing
  contract style (bold label, colon, dense prose).
- Read the final code from Phases 1-5 before writing, and describe
  what shipped, not the design. Check names and outputs against
  `src/stats.ts`, `src/rules.ts`, `src/index.ts`,
  `src/orchestrator.ts`, `src/display.ts`, `src/learnings.ts` and
  `src/review.ts`.
- `README.md`:
  - `### Interface` at :170 has a flags table; `--max-turns` row at
    :186 and `--effort` row at :187.
  - `## How It Works` at :292; `### Review` at :365 and
    `### Status display` at :374 (dot legend, the
    `auth/03 (blocked by auth/01)` row example).
- `AGENTS.md`: `Last verified: 2026-10-08` at :3; `## Project
  Structure` at :45; contracts at :67-1140: CLI (:90), orchestrator
  (:196), display (:641), learnings (:869), rules (:983), review
  (:1000).
- Claude Code version observed by the design: 2.1.296 (also the
  local `claude --version`).

---

<!-- START_TASK_1 -->
### Task 1: README

**Verifies:** None

**Files:**
- Modify: `README.md` (Interface table, How It Works)

**Step 1: Flags table row**

Add a `--prefer-subagent <model>` row after `--effort`: default `--`;
claude only; sets `CLAUDE_CODE_SUBAGENT_MODEL=<model>` for every
spawned claude agent (tickets, merge-conflict re-spawns, reviewer,
fixer) and adds a prompt rule telling the agent to hand read-only
work (exploration, code search, test runs with long output) to
subagents while it makes every edit and commit itself; the reviewer
gets the rule without the edit/commit line; `""` is the same as
omitting it; for `codex` and `pi` it is skipped with one warning at
startup; `--dry-run` prints `Prefer subagent: <model>` or `(none)`.

**Step 2: New `### Subagents` section under `## How It Works`**

Place it after `### Review`. Cover, in prose:
- The model is a fallback, not a mandate: a model passed on an
  individual subagent call, or a subagent definition's own `model`,
  wins, and the built-in Explore subagent picks its own model.
  nightralph never sets `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.
- Subagent turns do not count toward `--max-turns` (observed on
  Claude Code 2.1.296, not documented by Anthropic), but subagent
  time counts against `--timeout`.
- Spawned agents load the user's global `~/.claude` plugins and
  hooks, which can spend turns and steer delegation their own way;
  nightralph does not isolate them.
- Stats, recorded for every claude run whether or not the flag is
  set: each claude attempt's entry in `learnings.md` gets
  `Subagents: <n>.` and `Cost: $<x>.`; the status display row shows
  the ticket's running total across attempts, e.g.
  `a/03 - 2 subagents, $0.42`; after the finish summary one line
  totals subagents, agent runs and cost over ticket attempts, merge
  re-spawns, the reviewer and the fixer, noting when some runs
  reported no cost (a killed agent never reports one). Codex and pi
  runs report nothing and get no line. Stats are advisory and never
  change an outcome or exit code.

**Step 3: Status display section**

Add one sentence to `### Status display` that a claude ticket's row
can end with its subagent count and cost, linking to the new
section.

**Step 4: Verify**

Re-read the edited sections against the shipped code. Search the
diff for em dashes and arrow characters:

```bash
git diff README.md | grep -n -e $'\xe2\x80\x94' -e $'\xe2\x86\x92' \
    || echo clean
```
Expected: `clean`.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document --prefer-subagent and subagent stats"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: AGENTS.md contracts

**Verifies:** None

**Files:**
- Modify: `AGENTS.md`

**Step 1: Update the contracts**

- `Last verified:` -> today's date.
- `## Project Structure`: add `src/stats.ts -- subagent stats from
  claude stream-json, per-ticket totals and the run tally`.
- New `### stats module (src/stats.ts)` contract: exposes
  `SubagentStats`, `StreamStatsState`, `RunStats`,
  `emptyStreamStats`, `nextStreamStats`, `emptyRunStats`, `addRun`,
  `renderRunStats`, `addStats`, `formatStats`; imports nothing;
  `nextStreamStats` rules (main-loop `Agent`/`Task` tool_use counts
  once per id; non-null `parent_tool_use_id` ignored; `result` sets
  cost and replaces the count with `subagent_stats.spawned` when
  numeric; last result wins; same state object returned when nothing
  changed; never throws); `stats` never carries a `costUsd:undefined`
  key; `renderRunStats` is `null` when no run reported a subagent or
  a cost, and appends the partial-cost marker when `withCost <
  agentRuns`; `formatStats` is `null` for no stats or zero subagents
  without cost.
- CLI: `--prefer-subagent <model>` (string; `""` = off; after the
  provider preflight, a non-claude provider gets one
  `--prefer-subagent not supported by <provider>, skipping` warning
  and the value is dropped; passed to both runners and both dry
  runs; dry runs print `Prefer subagent:`).
- orchestrator: `AgentResult` gains `subagents?`/`costUsd?` (claude
  only); `spawnAgent` opts `preferSubagent?` (claude only, sets
  `CLAUDE_CODE_SUBAGENT_MODEL` via `env:{ ...process.env, ... }`;
  unset = no `env` option, so the shell value is inherited) and
  `onStats?`; one `JSON.parse` per claude line; a timed-out agent
  reports the live count and no cost; `formatStreamLine` returns
  `null` for subagent `assistant` messages, so subagent `[x]` text
  never checks items; `renderPrompt`/`renderMergePrompt` take
  `preferSubagent?`; `dryRun` gains a 4th param and in-place
  `runWaves` a last positional param `preferSubagent`;
  `runWavesIsolated` opts `preferSubagent?`; both runners keep a
  `RunStats` tally over every `spawnAgent` result (ticket attempts,
  merge respawns, and the wrapped review `deps.spawnAgent`) and log
  `renderRunStats` right after `renderFinishSummary` when non-null;
  `runTicketAttempts` reports the ticket's running total through
  `setTicketStats`; the Learnings paragraph notes that `agentRun`
  carries `subagents`/`costUsd` when `AgentResult` has them.
- rules: `subagentRule(preferSubagent?, readOnly?)`: `[]` when unset;
  `readOnly` drops the edit/commit line; used by all four prompt
  builders, the reviewer with `readOnly`.
- learnings: `AgentRunRecord` gains `subagents?`/`costUsd?`;
  `renderEntry` adds `Subagents: <n>.` and `Cost: $<x>.` to agent
  outcomes only, each omitted when absent.
- display: `Display.setTicketStats(num, feature, stats)`;
  `DisplayTicket.stats?`; `StatusDisplay` suffix ` - <formatStats>`
  clamped by `fitLine`; unknown ticket ignored; `PlainDisplay` no-op.
- review: `SpawnAgentFn` and `ReviewPassOpts` gain `preferSubagent?`;
  `renderReviewPrompt` and `renderFixPrompt` take it.
- Commands section: next to the `spawnCli` note, add one bullet on
  the fake claude: `test/fake-claude/claude` is a `sh` wrapper (its
  basename selects the claude branch) around
  `test/mock-agent-claude.js`, driven by `FAKE_CLAUDE_ENV_LOG`,
  `FAKE_CLAUDE_STREAM`, `FAKE_CLAUDE_HANG`, `FAKE_CLAUDE_DELEGATE`
  and `FAKE_CLAUDE_FAIL_ONCE`; tests restore those env vars in
  `finally`.
- Commands section, otherwise: no change unless the build/test file lists
  changed beyond adding `src/stats.ts` and `stats` (mention nothing
  new; the existing explicit-list note already covers it).

**Step 2: Verify**

```bash
git diff AGENTS.md | grep -n -e $'\xe2\x80\x94' -e $'\xe2\x86\x92' \
    || echo clean
npm run build && npm test && npm run lint
```
Expected: `clean`; build, all suites and lint pass.

**Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update contracts for prefer-subagent and stats"
```
<!-- END_TASK_2 -->
