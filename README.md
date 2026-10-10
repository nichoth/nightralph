# `nightralph`
[![tests](https://img.shields.io/github/actions/workflow/status/nichoth/nightralph/nodejs.yml?style=flat-square)](https://github.com/nichoth/nightralph/actions/workflows/nodejs.yml)
[![types](https://img.shields.io/npm/types/nightralph?style=flat-square)](README.md)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![install size](https://flat.badgen.net/packagephobia/install/nightralph)](https://packagephobia.com/result?p=nightralph)
[![license](https://img.shields.io/badge/license-Big_Time-blue?style=flat-square)](LICENSE)

This is a minimal Node-based AI orchestrator. It reads local markdown tickets
produced by
[`to-tickets` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md),
resolves their dependency graph, and runs agents in parallel,
honoring ticket dependencies. During setup you can choose a GitHub issue
tracker, which installs skill instructions that use `gh` CLI conventions,
but the ticket source is always local markdown files.

This is inspired by [nightshift](https://github.com/Shaurya-Sethi/nightshift/).
I made it because I noticed the API in `nightshift` had already drifted
from the skill definitions. This module bundles its skill dependencies,
so they can't drift as long as you install the skills with this package.
(See [the section on the `init` command](#install-dependency-skills).)

<!-- toc -->

- [Install](#install)
  * [Requirements](#requirements)
  * [Install Dependency Skills](#install-dependency-skills)
- [Workflow](#workflow)
  * [Create Issues](#create-issues)
- [Examples](#examples)
- [Command Line Arguments](#command-line-arguments)
  * [Notes](#notes)
  * [`--spec ` option](#--spec--option)
  * [`--prefer-subagent` option](#--prefer-subagent-option)
- [How It Works](#how-it-works)
  * [Select a ticket](#select-a-ticket)
  * [Worktrees](#worktrees)
  * [Progress](#progress)
  * [Integration branch](#integration-branch)
  * [Review](#review)
  * [Status display](#status-display)
- [Keep Your Machine Awake](#keep-your-machine-awake)
  * [Mac OS](#mac-os)
    + [Claude Opus 4.6](#claude-opus-46)
    + [Claude Opus 5.5](#claude-opus-55)
    + [Claude Sonnet 5.5](#claude-sonnet-55)
    + [Claude Haiku 5.5](#claude-haiku-55)
    + [Claude Fable 5.1](#claude-fable-51)
    + [`pi` + OpenRouter model](#pi--openrouter-model)
    + [`codex` + Luna](#codex--luna)
    + [`codex` + Terra](#codex--terra)
    + [Mercury + `pi`](#mercury--pi)

<!-- tocstop -->

## Install

```bash
npm i -S nightralph
```

### Requirements

- Node 24 or newer (see `engines` in `package.json`) and git.
- The agent CLI you name on the command line (`claude`, `codex` or
  `pi`) installed and on your `PATH`. After it finds tickets,
  nightralph checks for this command before it touches git, and
  exits with code 2 if the command is not found. A run with no
  tickets stops before the check. With `--dry-run` it prints the
  problem and keeps going.
- macOS or Linux. nightralph runs agents in their own process group
  and uses `sh -c` for test and install commands, so it does not
  run on Windows.

### Install Dependency Skills

```sh
npx nightralph init
```

Use the `init` subcommand in this package to add the required
[Pocock skills](https://github.com/mattpocock/skills) to your repo.
This command will copy some files in this package to a specific directory
in your repo. The upstream
[`grill-with-docs`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)
skill is exposed as `/grill`, along with its sub-skills `grilling`
and `domain-modeling`.

The Pocock skills are bundled with this git repo, at `./skills`.
They are cloned with some metadata, visible in
[skill/upstream.json](skills/upstream.json).
That's how we prevent skill vs API drift.


## Workflow

**The expected flow is**

```
grill -> to-spec -> to-tickets -> tdd
```

>
> [!NOTE]  
> The `grill` step can be changed to something else. Output from step 1
> needs to be a prose description.
>

First create issues.

After installing this package, use
[the `npx nightralph init` command](#install-dependency-skills)
to add the required skills to your local `.agents/skills/` folder.

### Create Issues

Use the `to-tickets` skill to create issues in local markdown files from
a prose text description.

The `nightralph` CLI does the `tdd` part of the workflow: the agent
prompt tells the agent to write a failing test per acceptance
criterion at the seams named in the spec's Testing Decisions, and
the orchestrator runs the project's test command, when there is
one, in the worktree before a ticket can be marked `done`.

>
> [!NOTE]  
> The `grill -> to-spec` pipeline is recommended to be run in a
> single context window.
>

>
> [!TIP]
> The `to-tickets` skill bundled here can use any input text
> describing a feature, meaning `grill` & `to-spec` skills are not required.
> You could, for example, use
> [superpowers:writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md),
> then follow with `to-tickets`.
>

## Examples

After you have the tickets, use the `nightralph` loop to execute.
The `to-tickets` skill produces markdown files at
`.scratch/<feature>/issues/<NN>-<slug>.md`, with task dependency info.

```bash
# Auto-discover .scratch features and run with claude
npx nightralph claude -m claude-opus-4-6

# Run with pi and an OpenRouter model
npx nightralph pi -m openrouter/z-ai/glm-5.3-flash

# Dry run to inspect the dependency graph and prompt
npx nightralph codex --dry-run

# Show which features wait on tickets in other features
npx nightralph graph

# Use codex with a specific model
npx nightralph codex -m gpt-5.6-luna

# Specify a feature by name
npx nightralph claude -m claude-opus-4-6 --spec my-feature

# Cap each agent at 30 agentic turns
npx nightralph claude -m claude-opus-4-6 --max-turns 30

# Same thing, using the positional shorthand
npx nightralph claude -m claude-opus-4-6 30

# Start pi at medium effort and allow one escalated retry
npx nightralph pi -m openrouter/z-ai/glm-5.3-flash --effort medium --retries 1
```

## Command Line Arguments

Flags:

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<provider>` | yes | -- | Agent harness to spawn (e.g. `claude`, `codex`, `pi`) |
| `[turns]` | no | -- | Max agentic turns per agent run (positional shorthand for `--max-turns`) |
| `-m`, `--model` | no | -- | Model flag passed to the agent |
| `--spec <name>` | no | auto | Feature name (resolves `.scratch/<name>/`) |
| `--dry-run` | no | -- | Show wave order and prompt without running |
| `--no-review` | no | review on | Skip the review and fix pass at the end of a run |
| `-X` | no | -- | Stop on merge conflict instead of re-spawning |
| `--timeout` | no | `3600` | Kill the agent after N seconds. A killed agent is not a failure: its work is kept (see Notes) |
| `--test-cmd <cmd>` | no | auto | Run in each worktree after the agent exits; non-zero exit rejects the ticket. Defaults to `npm test` when `package.json` has a `test` script. When nothing is detected the run has no test gate and says so at startup. Pass `""` to run without a gate. Shares the agent's `--timeout`. Dependencies are already installed by `--install-cmd` |
| `--install-cmd <cmd>` | no | auto | Run in each fresh worktree before the agent starts, and again after a merge-conflict rebase; non-zero exit fails the attempt (it is retried like any other failure). Auto-detects from the lockfile: `pnpm-lock.yaml` -> `pnpm install --prefer-offline --frozen-lockfile`, `package-lock.json` -> `npm ci --prefer-offline --no-audit --no-fund`, a `package.json` with no lockfile -> `npm install --prefer-offline --no-audit --no-fund --no-package-lock`, no `package.json` -> no install. Pass `""` to disable. Shares the agent's `--timeout`. Output goes to `<ticket>.install.log` |
| `--max-turns <n>` | no | -- | Max agentic turns per agent run. Forwarded as `--max-turns <n>` to `claude` only; for `codex` and `pi` the flag is skipped with a warning and the agent runs with no turn limit. The limit is per spawn, not a total for the ticket: every retry and every re-spawn after a merge conflict starts with a fresh budget of `n` turns, so with `--retries 3` one ticket can use up to 4 x `n`. When omitted (or `0`), no limit is passed, so `--timeout` is the only cap. Takes precedence over the `[turns]` positional when both are given. Reaching the limit is an error exit, so the attempt fails and is retried like any other failure |
| `--effort <level>` | no | -- | Starting effort/reasoning level. Each provider has its own ladder: `claude` supports `low`, `medium`, `high`, `xhigh`, `max` (forwarded as `--effort`); `codex` supports `low`, `medium`, `high` (forwarded as `-c model_reasoning_effort=<level>`); `pi` supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (forwarded as `--thinking`). Omitted = provider default. Each retry steps up from here (see `--retries`) |
| `--prefer-subagent <model>` | no | -- | `claude` only. Sets `CLAUDE_CODE_SUBAGENT_MODEL=<model>` for every claude agent nightralph spawns (tickets, merge-conflict re-spawns, the reviewer and the fixer) and adds a prompt rule: hand read-only work (exploring the codebase, searching code, test runs with long output) to subagents, and make every edit and commit yourself. The reviewer gets the rule without the edit and commit line, since it never edits. `""` is the same as omitting the flag. For `codex` and `pi` it is skipped with one warning at startup (`--prefer-subagent not supported by <provider>, skipping`). `--dry-run` prints `Prefer subagent: <model>`, or `(none)`. See [`--prefer-subagent` option](#--prefer-subagent-option) |
| `--retries <n>` | no | `3` | Extra attempts per ticket after a failed run. Each retry starts from a fresh worktree and raises the effort level one rung (see Notes). `0` disables retries |
| `--retry-delay <n>` | no | `30` | Seconds to wait before the first retry; doubles each further retry (30s, 60s, 120s, ...). `0` disables the wait |
| `--concurrency <n>` | no | `5` | Max agents running at once within a wave. A wave with more ready tickets than this runs them through a pool: as one agent exits, the next ticket starts. The wave still finishes fully before its branches are merged |


### Notes

* When `--spec <name>` is omitted, the CLI looks for
  `.scratch/<feature>/issues/` directories. If multiple features exist,
  **it prompts you to pick one or more** with an interactive
  selector.
* Tickets are selected by `**Status:** ready-for-agent` in the file body.
* Dependencies are read from the `**Blocked by:**` field; the orchestrator
  skips tickets whose blockers haven't completed.
* Unblocked tickets run in parallel. After a wave finishes, newly unblocked
  tickets start in the next wave.
* An agent run only counts as a success when the agent exits 0,
  its worktree branch has new commits relative to the base branch,
  and the test command (see `--test-cmd`), when there is one, exits
  0 in that worktree.
  Uncommitted changes left by the agent are auto-committed before
  the check. On success, the ticket's status is updated to `done`
  in-place. If the agent exits 0 but made no commits, or the test
  command fails, the ticket is left `ready-for-agent` for a retry
  and the test output is written to `<dir>/../logs/<ticket>.test.log`.
  Failed tickets (non-zero exit) keep their status and block
  dependents. The status display marks those dependents as blocked
  and names the failed ticket.
* A failed attempt is retried, up to `--retries` times, before the
  ticket is recorded as failed. Non-zero exit, exit 0 with no new
  commits, and a red test command all count as failures; a timeout
  does not (see below). Each retry discards the previous worktree
  and starts from a fresh one. Each retry also raises the effort
  level one rung up the provider's ladder: without `--effort` the
  first retry uses `high`; with `--effort <level>` each retry
  steps one level up from the previous attempt, stopping at the
  provider's max (`max` for claude/pi, `high` for codex).
  Retries are spaced with exponential backoff controlled by
  `--retry-delay`: the first retry waits `--retry-delay` seconds,
  the second waits double that, and so on. This lets provider
  outages clear before burning the next attempt. Retry
  logs are written to `<dir>/../logs/<ticket>.attempt<n>.log`
  (and `.attempt<n>.test.log` for the test command) so the first
  attempt's log is kept.
* Each attempt at a ticket appends an entry to
  `.scratch/<feature>/learnings.md`, next to `progress.md`. The
  entry records what the orchestrator saw (the outcome, the agent's
  exit code, the checklist items it reported, and the last lines of
  the test or install log when one of those failed) and, when an
  agent ran, the agent's own notes. The file is committed along with
  `progress.md` and persists across runs. Each agent's prompt
  includes the most
  recent entries for its own ticket and the last successful entry of
  each ticket that directly blocks it, so a retry can see why the
  previous attempt failed. Agents keep their notes in
  `.nightralph/notes.md` inside the worktree. nightralph collects
  that file when the agent exits, and a self-ignoring
  `.nightralph/.gitignore` keeps it out of the agent's commits.
* A ticket that exhausts all its retry attempts is excluded from
  later waves in the same run. It stays `ready-for-agent` on disk
  so a future run can pick it up, but it will not be re-started
  within the current invocation. The final summary line includes
  the count of failed tickets when any failed.
* An agent still running at `--timeout` is killed. The kill is
  reported in the status display and in the ticket log. It is not
  treated as an agent failure: uncommitted changes in the worktree
  are auto-committed, and the branch goes through the same
  new-commits check, test gate, and merge as an agent that exited 0.
  Opus tickets have taken over 12 minutes of API time, which is why
  the default is an hour rather than the old 15 minutes.
* Agents are spawned in their own process group (`detached:true`).
  When the timeout fires or when you press Ctrl-C (SIGINT) or send
  SIGTERM, the orchestrator kills the entire process group -- not
  just the agent process -- so dev servers, watchers, and other
  child processes are cleaned up. SIGINT exits 130 and SIGTERM
  exits 143 after killing all running agents and restoring the
  terminal.
* For fast models that reliably finish tickets in a few minutes,
  `--timeout 900` is a reasonable cap that catches stuck agents
  sooner than the one-hour default.
* `.scratch/` should be listed in your project's `.gitignore`.
  The orchestrator force-adds `progress.md` so it is tracked despite
  the ignore rule, but ticket files, logs, and spec files are
  working state and should not be committed to the project repo.
* Agent logs are written to `<dir>/../logs/<ticket>.log`.
* Provider commands are launched non-interactively with default flags
  that grant the agent write access to the worktree, so tickets can
  actually be implemented without a permission prompt:
  * `claude`: `--print --dangerously-skip-permissions`
  * `codex`: `exec --dangerously-bypass-approvals-and-sandbox`
    (codex removed `--full-auto`; the workspace-write sandbox
    cannot commit in a worktree because its `.git` link points
    outside the tree)
  * `pi`: `-p --verbose --approve --no-session --mode json`
    (prompt delivered via temp file; `--approve` auto-accepts
    tool-use proposals so the agent runs non-interactively)


### `--spec <name>` option

A feature name that resolves to `.scratch/<name>/`.
The spec file is `.scratch/<name>/spec.md` and the issues directory
is `.scratch/<name>/issues/`.


### `graph` command

`nightralph graph` lists the features whose tickets wait on tickets
in other features, the tickets that wait, and the features to select
together so the work can run.

Without `--spec` it reports every feature the picker shows. With
`--spec <name>` it reports that one feature and what it waits on.
The name can be one the picker hides: a nested feature such as
`rollout/billing`, or a complete one.

The sample below is from a run with three features.
`held-import-review` has two tickets: `01` is blocked by
`newsletter-audit/16`, and `02` by `01`. `analytics` has no
blockers.

```bash
npx nightralph graph
```

```text
held-import-review (0/2 ready)
  held-import-review waits on newsletter-audit
    held-import-review/01 waits on newsletter-audit/16 (ready-for-agent)
  Run together: held-import-review, newsletter-audit (select both in the picker)
    2 of 2 ready-for-agent tickets become runnable

Not waiting on other features: analytics, newsletter-audit
```

Each block opens with the feature's counts as the picker shows them,
for a run of that feature alone. `(0/2 ready)` means neither ticket
can start: `01` waits on another feature and `02` waits on `01`. The
`X waits on Y` lines group the blocking refs by feature pair, so a
block also shows waits further up the chain, such as a feature this
one waits on that itself waits on a third.

`Run together` names the features to select in the picker. The
suggestion is checked by simulating a run of those features with the
same wave logic as `--dry-run`, assuming every ticket succeeds. The
line under it counts how many of the feature's `ready-for-agent`
tickets become runnable. That total can differ from the header's,
which counts every ticket, as the picker does.

Some tickets can't run whatever you select:

* `stays blocked` names a ticket and the blocker that stops it: a
  ticket in a status an agent doesn't pick up, such as
  `ready-for-human`, or a ref that matches no ticket, shown as
  `(not found)`.
* `deadlocked` names tickets in or behind a cycle.

A feature whose only problem is a ref into another feature that
matches no ticket gets a block with no `Run together` line. The
remaining features share the `Not waiting on other features` line,
and any typo warnings come last.

The picker labels a feature that waits on others the same way, for
example `held-import-review (0/2 ready, waits on newsletter-audit)`.
The label names only the features its tickets wait on directly, and
the counts still mean ready if the feature runs alone.

`graph` is read-only: it runs no git, no provider check, and writes
nothing. It reads `.scratch/` in the current checkout, not an
integration branch, so tickets a run finished on
`nightralph--<feature>` show as open until that branch is merged.
`Run together` can only be acted on in the picker, since `--spec`
takes one name.


### `--prefer-subagent` option

Use this to use a strong model on the ticket while a cheaper, faster
model handles the reading. The main agent writes the code and makes
every commit. Subagents explore the codebase, search for code, and run
tests whose output would flood the main agent's context, then report
back a short answer.

The flag does two things for every claude agent nightralph spawns
(tickets, merge-conflict re-spawns, the reviewer and the fixer):

1. It sets `CLAUDE_CODE_SUBAGENT_MODEL=<model>` in the agent's
   environment.
2. It adds a rule to the prompt: hand read-only work to subagents,
   brief each one fully, do not delegate a lookup that takes a single
   tool call, and never let a subagent edit files or commit. The
   reviewer gets the same rule without the edit and commit line.

`<model>` is anything Claude Code accepts as a model: an alias such as
`sonnet` or `haiku`, or a full model ID. Sonnet is the safer choice
when subagents need judgment, such as tracing a call path across
modules. Haiku is cheaper and faster, and suits mechanical lookups and
summarizing long test output, but it is more likely to miss something.

```sh
# Opus writes the code, Sonnet subagents explore and run tests
npx nightralph claude -m claude-opus-4-6 --prefer-subagent sonnet

# Cheaper subagents for searches and noisy test runs
npx nightralph claude -m claude-opus-4-6 --prefer-subagent haiku

# A Sonnet main agent with Haiku subagents
npx nightralph claude -m claude-sonnet-4-6 --prefer-subagent haiku

# Pin an exact model ID instead of an alias
npx nightralph claude -m claude-opus-4-6 --prefer-subagent claude-sonnet-5-5

# Check the setting and the prompt rule without running anything
npx nightralph claude --prefer-subagent claude-haiku-5-5 --dry-run
```

Only the `claude` provider supports this flag. With `codex` or `pi` it
is skipped with one warning at startup.

`--prefer-subagent <model>` sets the model that a claude agent's
subagents default to. It's a fallback, not a mandate. A model passed on
an individual subagent call wins, and so does the `model` in a subagent
definition. The built-in Explore subagent picks its own model.
nightralph never sets `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, so without
the flag a value you exported in your shell still applies.

Subagent turns do not count toward `--max-turns`. That was observed on
Claude Code 2.1.296 and is not documented by Anthropic, so it may
change. Subagent time does count against `--timeout`, because the
timeout covers the whole agent process.

Spawned agents load your global `~/.claude` plugins and hooks. Those
can spend turns and steer delegation their own way, and nightralph does
not isolate agents from them.

Subagent stats are recorded for every claude run, whether or not
`--prefer-subagent` is set. When a claude agent ran, the attempt's
entry in `learnings.md` includes `Subagents: <n>.` and `Cost: $<x>.`,
each left out when the agent did not report it. The
ticket's row in the status display shows the running total across its
attempts, as in `a/03 - 2 subagents, $0.42`. After the finish summary,
one line totals the subagents, agent runs and cost over every ticket
attempt, merge-conflict re-spawn, the reviewer and the fixer:

```
Subagents: 5 started across 7 agent runs, cost $3.18 (cost from 6 of 7 runs)
```

The part in parentheses appears only when some runs reported no cost.
A claude agent reports cost only when it finishes, so one killed at
`--timeout` usually reports none. Codex and pi runs report nothing, so
a run that used only them gets no stats line. Stats are advisory: they
never change a ticket's outcome or the exit code.




## How It Works

Tickets run in waves. A wave is a batch of tickets whose blockers are
all done. The tickets in a wave run in parallel, up to `--concurrency`
at once, and each ticket gets a worktree named after the ticket slug.
nightralph waits for the whole batch to finish, merges the branches of
the tickets that succeeded, and marks them `done`. Then it looks for
tickets that are newly unblocked. Those form the next wave. This
continues until no ticket is ready to run.

The wave total in the status display header (the `3` in `Wave 2/3`) is
a prediction made at startup. It assumes every ticket succeeds. When a
ticket fails, its dependents never become ready, so the run can end
before it reaches the predicted last wave.


### Select a ticket

* Build a ticket dependency graph with the `Blocked by:` fields
* A ticket is eligible for execution when its status is `ready-for-agent` and
  every ticket listed in its `Blocked by:` field is completed.


### Worktrees

Each ticket gets its own git worktree. Agents work in
isolation so parallel tickets never conflict on disk. After a wave
completes, successful branches are merged back into the base branch.
The first branch merges directly, and subsequent branches rebase
onto the updated base before merging.

Worktrees are created next to the repository, not inside it: a
ticket's worktree is the sibling directory
`<repo>.<feature>-<num>-<slug>` on the branch
`<repo>--<feature>-<num>-<slug>`. A run that is interrupted leaves
them in place; the next run removes a stale worktree and branch of
the same name before creating a new one.

A fresh worktree has only tracked files, so there is no
`node_modules`. Before the agent starts, the orchestrator installs
dependencies with the command that matches the project's lockfile
(see `--install-cmd`), and the prompt tells the agent not to run
another installer. The install never writes a lockfile, so ticket
branches do not commit one by accident.

If a merge conflict occurs, the behavior depends on the `-X` flag: by
default the agent is re-spawned to resolve it; with `-X`,
the run stops immediately.

### Progress

A file `progress.md` is written to the `.scratch/<feature>/` directory
and committed after each ticket completes, so you can monitor the run from
another terminal by reading the file.

### Integration branch

Launched from your default branch (`main`), nightralph does not merge
into it. It creates `nightralph--<feature>` (or `nightralph--all` for
several features), merges every ticket there, and leaves you on that
branch. Running again from `main` resumes the same branch, so finished
tickets stay finished. Launched from any other branch, it merges into
that branch.

After you merge the integration branch into `main`, the next run
fast-forwards it to `main` and resumes. If the branch has commits `main`
lacks, nightralph reports how far behind it is; merge `main` into it or
delete it with `git branch -D`.

If `.scratch/` is gitignored, the bookkeeping files (tickets, progress,
learnings, review) are force-added and live on the integration branch, so
they disappear from disk when you check out `main`.

### Review

After the last wave, an agent reviews everything merged since the last
review and writes its findings to `.scratch/<feature>/review.md` (`.scratch/review.md`
for a multi-feature run). A
second agent fixes them test-first; its work merges only if the test
command passes. Findings it could not fix stay unchecked in
`review.md`. Skip this with `--no-review`.

### Status display

In a terminal, nightralph shows a header line, one row per ticket, and
a log of recent messages. The ticket list holds every ticket that was
`ready-for-agent` when the run started, and it stays the same for the
whole run. Rows do not move, disappear, or reappear between waves.

Each row starts with a dot that shows the ticket's state:

* Dim empty dot: pending. The ticket has not started yet.
* Yellow dot: running. The agent is working, the test command is
  running, or the ticket is waiting out a retry delay.
* Cyan dot: waiting to merge. The agent and the test command
  succeeded, and the branch waits for the rest of the wave to finish.
  The dot stays cyan while the branch is merged, including while a
  re-spawned agent resolves a merge conflict.
* Green dot: done.
* Red dot: failed.
* Dim filled dot: blocked. A ticket upstream failed or is not agent
  work (for example, it is `ready-for-human`), so this ticket cannot
  run in this session. The row names the blocking tickets, as in
  `auth/03 (blocked by auth/01)`.

A claude ticket's row can end with its subagent count and cost, as in
`auth/02 - 2 subagents, $0.42` (see [`--prefer-subagent` option](#--prefer-subagent-option)).

The header looks like this:

```
Wave 2/3 - 5/8 done - 63%
```

The counts cover only this run's tickets, the ones in the list.
Tickets finished by an earlier run are not counted.

When stdout is not a terminal, for example when it is piped to a file,
nightralph prints one line per wave that names the wave's tickets,
followed by plain log lines.

Known limit: with `-X`, the run stops at the first merge conflict. A
ticket whose branch succeeded but came after the conflicting branch is
never merged, and its row stays on the cyan "waiting to merge" dot when
the run stops.


---

## Keep Your Machine Awake

This is expected to run for a long time, like overnight.

### Mac OS

Use `caffeinate` to prevent your machine from sleeping. These examples will
keep the machine awake, but the display can still go dark.

#### Claude Opus 4.6

```sh
caffeinate -i npx nightralph claude -m claude-opus-4-6 --effort medium
```

#### Claude Opus 5.5

```sh
caffeinate -i npx nightralph claude -m claude-opus-5-5 --effort medium
```

#### Claude Sonnet 5.5

```sh
caffeinate -i npx nightralph claude -m claude-sonnet-5-5 --effort medium
```

#### Claude Haiku 5.5

```sh
caffeinate -i npx nightralph claude -m claude-haiku-5-5 --effort high
```

#### Claude Fable 5.1

```sh
caffeinate -i npx nightralph claude -m claude-fable-5-1 --effort medium
```

#### `pi` + OpenRouter model

```sh
caffeinate -i npx nightralph pi -m openrouter/z-ai/glm-5.3-flash --effort high
```

#### `codex` + Luna

```sh
caffeinate -i npx nightralph codex -m gpt-5.6-luna --effort high
```

#### `codex` + Terra

```sh
caffeinate -i npx nightralph codex -m gpt-5.6-terra --effort medium
```

#### Mercury + `pi`

```sh
caffeinate -i npx nightralph pi -m openrouter/inception/mercury-2.5 --effort high
```
