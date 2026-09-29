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
  * [Install Dependency Skills](#install-dependency-skills)
- [Workflow](#workflow)
  * [Create Issues](#create-issues)
  * [Examples](#examples)
  * [Interface](#interface)
    + [`--spec ` option](#--spec--option)
- [How It Works](#how-it-works)
  * [Select a ticket](#select-a-ticket)
  * [Worktrees](#worktrees)
  * [Progress](#progress)
  * [Status display](#status-display)
- [Keep Your Machine Awake](#keep-your-machine-awake)
  * [Mac OS](#mac-os)
    + [Claude Opus 4.6](#claude-opus-46)
    + [Claude Opus 5.5](#claude-opus-55)
    + [Claude Sonnet 5](#claude-sonnet-5)
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
the orchestrator runs the project's test command in the worktree
before a ticket can be marked `done`.

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

### Examples

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

### Interface

Flags:

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<provider>` | yes | -- | Agent harness to spawn (e.g. `claude`, `codex`, `pi`) |
| `[turns]` | no | -- | Max agentic turns per ticket (positional shorthand for `--max-turns`) |
| `-m`, `--model` | no | -- | Model flag passed to the agent |
| `--spec <name>` | no | auto | Feature name (resolves `.scratch/<name>/`) |
| `--dry-run` | no | -- | Show wave order and prompt without running |
| `-X` | no | -- | Stop on merge conflict instead of re-spawning |
| `--timeout` | no | `3600` | Kill the agent after N seconds. A killed agent is not a failure: its work is kept (see Notes) |
| `--test-cmd <cmd>` | no | auto | Run in each worktree after the agent exits; non-zero exit rejects the ticket. Auto-detects `npm test`. Pass `""` to disable. Shares the agent's `--timeout`. The command runs in a fresh git worktree, which contains only tracked files, so a project that needs an install step should include it, for example `--test-cmd 'npm ci && npm test'` |
| `--max-turns <n>` | no | -- | Max agentic turns per ticket. Forwarded verbatim as `--max-turns <n>` to the provider CLI. Only `claude` accepts it; `codex` and `pi` reject it as an unknown option and the agent exits immediately. Applies to every agent spawn, including a re-spawn after a merge conflict. When omitted, `claude` applies no turn limit, so `--timeout` is the only cap. Reaching the limit is an error exit, so the ticket is recorded as failed |
| `--effort <level>` | no | -- | Starting effort/reasoning level. Each provider has its own ladder: `claude` supports `low`, `medium`, `high`, `xhigh`, `max` (forwarded as `--effort`); `codex` supports `low`, `medium`, `high` (forwarded as `-c model_reasoning_effort=<level>`); `pi` supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (forwarded as `--thinking`). Omitted = provider default. Each retry steps up from here (see `--retries`) |
| `--retries <n>` | no | `3` | Extra attempts per ticket after a failed run. Each retry starts from a fresh worktree and raises the effort level one rung (see Notes). `0` disables retries |
| `--retry-delay <n>` | no | `30` | Seconds to wait before the first retry; doubles each further retry (30s, 60s, 120s, ...). `0` disables the wait |
| `--concurrency <n>` | no | `5` | Max agents running at once within a wave. A wave with more ready tickets than this runs them through a pool: as one agent exits, the next ticket starts. The wave still finishes fully before its branches are merged |


**Notes**:

* When `--spec <name>` is omitted, the CLI looks for
  `.scratch/<feature>/issues/` directories. If multiple features exist,
  **it prompts you to pick one** with an interactive selector.
* Tickets are selected by `**Status:** ready-for-agent` in the file body.
* Dependencies are read from the `**Blocked by:**` field; the orchestrator
  skips tickets whose blockers haven't completed.
* Unblocked tickets run in parallel. After a wave finishes, newly unblocked
  tickets start in the next wave.
* An agent run only counts as a success when the agent exits 0,
  its worktree branch has new commits relative to the base branch,
  and the test command (see `--test-cmd`) exits 0 in that worktree.
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


#### `--spec <name>` option

A feature name that resolves to `.scratch/<name>/`.
The spec file is `.scratch/<name>/spec.md` and the issues directory
is `.scratch/<name>/issues/`.


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

If a merge conflict occurs, the behavior depends on the `-X` flag: by
default the agent is re-spawned to resolve it; with `-X`,
the run stops immediately.

### Progress

A file `progress.md` is written to the `.scratch/<feature>/` directory
and committed after each ticket completes, so you can monitor the run from
another terminal by reading the file.

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
* Green dot: done.
* Red dot: failed.
* Dim filled dot: blocked. A ticket upstream failed or is not agent
  work (for example, it is `ready-for-human`), so this ticket cannot
  run in this session. The row names the blocking tickets, as in
  `auth/03 (blocked by auth/01)`.

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
caffeinate -i npx nightralph claude -m claude-opus-4-6 --effort low
```

#### Claude Opus 5.5

```sh
caffeinate -i npx nightralph claude -m claude-opus-5-5 --effort low
```
#### Claude Sonnet 5

```sh
caffeinate -i npx nightralph claude -m claude-sonnet-5 --effort high
```

#### Claude Fable 5.1

```sh
caffeinate -i npx nightralph claude -m claude-fable-5-1 --effort low
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
