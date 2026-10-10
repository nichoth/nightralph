# Human Test Plan: prefer-subagent

Automated coverage: 35 of 35 acceptance criteria covered (see
`docs/implementation-plans/2026-10-09-prefer-subagent/test-requirements.md`).
This plan covers what the automated suite cannot: the real `claude`
CLI, the live TTY display, and the docs.

## Prerequisites

- macOS or Linux, Node >= 24, `claude` CLI installed. Record the
  version you test (observed during development: `2.1.296`).
- In this repo: `npm run build && npm test && npm run lint`, all
  green.
- Run the CLI as `node <repo>/dist/index.js` (written `NR` below), or
  `npm link`.
- Scratch project:
  1. `mkdir /tmp/nr-sub && cd /tmp/nr-sub && git init -b main && npm init -y`
  2. Add a small `src/` with 5-10 files of real code, so a code search
     is worth delegating. Set `"test":"node --test"` and add one
     passing test.
  3. `NR init` and choose `local`.
  4. Create `.scratch/sub/spec.md` with a short spec.
  5. Create `.scratch/sub/issues/01-find-and-rename.md` with
     `# Rename helper`, `**Status:** ready-for-agent`, and
     `- [ ] Find every call site of <fn> and rename it to <newFn>`.
  6. Optionally add `02-...md` with `**Blocked by:** 1`.
  7. `git add -A && git commit -m init`

## Phase 1: CLI flag and dry run

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | `NR claude --spec sub --dry-run --prefer-subagent haiku` | Exit 0; `Prefer subagent: haiku`; worktree/branch layout and `Review: on` printed |
| 1.2 | `NR claude --spec sub --dry-run` | `Prefer subagent: (none)` |
| 1.3 | `NR claude --spec sub --dry-run --prefer-subagent ""` | Identical to 1.2 (`diff <(...) <(...)` is empty) |
| 1.4 | `NR codex --spec sub --dry-run --prefer-subagent haiku`, then the same with `pi` | Exactly one stderr line `--prefer-subagent not supported by codex, skipping` (or `pi`); stdout `(none)`. If the provider is not installed, the not-found line also prints, and the warning still prints once |
| 1.5 | `NR codex --spec sub --dry-run --prefer-subagent ""` | No warning |
| 1.6 | `cp -r .scratch /tmp/nr-plain && cd /tmp/nr-plain` (not a git repo), then `NR claude --spec sub --dry-run --prefer-subagent haiku` | The printed in-place ticket prompt contains the "Hand read-only work to subagents ... default to the haiku model" bullet and the three bullets after it |

## Phase 2: the real CLI honours the env var, and the stream shape matches

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | In `/tmp/nr-sub`: `CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p "Use a subagent to find every file under src/ that calls <fn>, then summarise" --output-format stream-json --verbose > out.jsonl` | Completes |
| 2.2 | `jq -c 'select(.type=="assistant" and .parent_tool_use_id!=null) \| .message.model' out.jsonl \| sort -u` | Only haiku model ids |
| 2.3 | `jq -c 'select(.type=="assistant" and .parent_tool_use_id==null) \| .message.model' out.jsonl \| sort -u` | The default main model, not haiku |
| 2.4 | `jq -c 'select(.type=="assistant" and .parent_tool_use_id==null) \| .message.content[]? \| select(.type=="tool_use" and (.name=="Agent" or .name=="Task")) \| .id' out.jsonl` | One or more string ids; each appears as a `parent_tool_use_id` in the 2.2 messages |
| 2.5 | `jq 'select(.type=="result") \| {total_cost_usd, subagent_stats, num_turns}' out.jsonl` | `total_cost_usd` numeric; `subagent_stats.spawned` an integer. If the field is missing on your version, note it: nightralph then keeps its live count |
| 2.6 | `NR claude --spec sub --prefer-subagent haiku` (git repo, real run) | Exit 0; ends on `nightralph--sub` with `Work is on nightralph--sub` |
| 2.7 | `cat .scratch/sub/learnings.md` | The attempt entry has `Agent exit: 0. Subagents: <n>. Cost: $<x>.` |
| 2.8 | Inspect `.scratch/sub/logs/<ticket>.log`; optionally `ps eww <agent pid>` while it runs | Raw stream present; the agent env contains `CLAUDE_CODE_SUBAGENT_MODEL=haiku` |
| 2.9 | Read the terminal right after `Finished: ...` | Next line is `Subagents: N started across M agent runs, cost $X.XX`; M counts ticket, reviewer and any fixer runs; N and $X match the sums of the learnings entries plus the review runs |
| 2.10 | `export CLAUDE_CODE_SUBAGENT_MODEL=sonnet`, repeat 2.6 on a fresh ticket without the flag, then with `--prefer-subagent haiku` | Without the flag the log shows sonnet subagents; with it, haiku |

## Phase 3: `--max-turns` does not cap subagent turns

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | `claude -p "Delegate to a subagent: read every file in src/ one by one and list each exported function" --max-turns 3 --output-format stream-json --verbose > turns.jsonl` | Completes or stops on max turns |
| 3.2 | `jq 'select(.type=="result") \| .num_turns' turns.jsonl` | 3 or fewer |
| 3.3 | `jq -c 'select(.parent_tool_use_id!=null) \| .message.content[]? \| select(.type=="tool_use")' turns.jsonl \| wc -l` | More than 3. If not, update the version note in README `### Subagents` |

## Phase 4: live TTY display

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | In a real terminal at least 80 columns wide, reset the ticket to `ready-for-agent` and run `NR claude --spec sub --prefer-subagent haiku` | The ticket row gains a suffix such as `sub/01 - 1 subagent` once the agent starts its first subagent, before it exits; the cost appears when the result arrives, e.g. `sub/01 - 2 subagents, $0.42` |
| 4.2 | Force a retry (`--test-cmd "false" --retries 1 --retry-delay 0`) | During attempt 2 the row shows attempt 1's total plus attempt 2's live count; the final row is both attempts summed; `learnings.md` has 2 entries, each with only its own `Subagents:` value |
| 4.3 | While running, resize the terminal narrower than the row (about 25 columns) and back | The row is truncated to one line; no stale or duplicated rows after repaint |
| 4.4 | Pipe the run through `\| cat` (non-TTY, `PlainDisplay`) | No row suffix; the finish summary and the stats line still print |

## Phase 5: other providers

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | If codex or pi is installed: `NR codex --spec sub --prefer-subagent haiku` (real run, fresh ticket) | One warning at start, not repeated per ticket; no `Subagents:` or `Cost:` in the learnings entry; no stats line after `Finished:`; no row suffix |

## End-to-end: full pipeline with the review pass

Confirms the env var and rule reach the ticket, reviewer and fixer
agents, and that the tally covers all three.

1. In `/tmp/nr-sub` on `main` with a committed `ready-for-agent`
   ticket, run `NR claude --spec sub --prefer-subagent haiku`.
2. Open `.scratch/sub/logs/review.log` and `review-fix.log` (if there
   were findings). Each stream shows main-loop `Agent` tool_uses and
   haiku subagent messages.
3. The stats line's M equals ticket attempts + 1 reviewer + fixer
   attempts; the cost is about the sum of each log's last
   `total_cost_usd`.
4. `.scratch/sub/review.md` has an entry; `learnings.md` has no
   review entries.

## End-to-end: merge-conflict respawn

Confirms a respawned agent gets the model and is tallied.

1. Create two unblocked `ready-for-agent` tickets that edit the same
   line of `src/index.js` differently.
2. Run `NR claude --spec sub --prefer-subagent haiku`.
3. A merge-conflict respawn happens (ticket log or display messages),
   both tickets end `done`, and the stats line counts 3 or more agent
   runs.

## Human verification required

| Item | Why manual | Steps |
|------|------------|-------|
| H1 (AC1.4, AC1.6 beyond the env log) | Tests prove the var reaches the child, not that real claude uses it | 2.1-2.3, 2.8, 2.10 |
| H2 (AC3.1, AC3.3, AC3.5, AC7.1) | Fixtures model a version-dependent stream shape | 2.4-2.5, 2.7, 2.9 |
| H3 (README claim, no AC) | Undocumented upstream behaviour | Phase 3 |
| H4 (AC5.1, AC5.3) | Live repaint and resize cannot be asserted on a mock stream | Phase 4 |
| H5 (docs) | The project does not test docs | Read the README flag row, `### Subagents` and `### Status display`, and the AGENTS.md contracts; confirm names and signatures match `src/` (`subagentRule(preferSubagent?, readOnly = false)`, `onAgentRun`, `addStats`, `formatStats`, the `Prefer subagent:` line, the `Subagents: N started across M agent runs, cost $X` line) |
| codex/pi warn once (AC1.3, real run) | The automated test covers the dry run only | 1.4, 5.1 |

## Traceability

| Criterion | Automated test | Manual step |
|-----------|----------------|-------------|
| AC1.1 | integration.test.ts (`checkPreferSubagentDryRun`, non-git and git) | 1.1, 1.6 |
| AC1.2 | same | 1.2 |
| AC1.3 | integration.test.ts (codex/pi warning); orchestrator.test.ts (non-claude basename) | 1.4, 5.1 |
| AC1.4 | orchestrator.test.ts (option overrides shell value) | 2.10 |
| AC1.5 | orchestrator.test.ts (inherit / unset) | 2.10 |
| AC1.6 | integration.test.ts (in-place, isolated, merge respawn); review-integration.test.ts (reviewer, fixer) | 2.6, 2.8, both E2E runs |
| AC1.7 | integration.test.ts (`""` dry run, codex `""`, in-place and isolated `""`) | 1.3, 1.5 |
| AC2.1-AC2.2 | orchestrator.test.ts; review.test.ts | 1.6 |
| AC2.3 | review.test.ts; review-integration.test.ts | E2E review step 2 |
| AC2.4 | orchestrator.test.ts (`subagentRule`) | -- |
| AC3.1-AC3.5 | stats.test.ts | 2.4, 2.5 |
| AC3.6 | stats.test.ts; orchestrator.test.ts (stdout half, `formatStreamLine`) | -- |
| AC3.7 | orchestrator.test.ts (`onStats` order) | 4.1 |
| AC3.8 | orchestrator.test.ts (timeout) | -- |
| AC4.1 | learnings.test.ts; integration.test.ts (retry wiring) | 2.7, 4.2 |
| AC4.2-AC4.4 | learnings.test.ts | 5.1 |
| AC5.1 | display.test.ts; stats.test.ts | 4.1 |
| AC5.2 | stats.test.ts (`addStats`); integration.test.ts (retry) | 4.2 |
| AC5.3 | display.test.ts (20 columns) | 4.3 |
| AC5.4 | display.test.ts | 4.4 |
| AC6.1-AC6.3 | stats.test.ts | 2.9 |
| AC6.4 | integration.test.ts (respawn); review-integration.test.ts | both E2E runs |
| AC6.5 | orchestrator.test.ts (in-place); integration.test.ts (isolated) | 2.9 |
| AC6.6 | orchestrator.test.ts (noop agent) | 5.1 |
| AC7.1 | orchestrator.test.ts (`completedItems`, `formatStreamLine`) | 2.4 |
| AC7.2 | orchestrator.test.ts (error result and bad lines) | 3.1 |
