# `nightralph`
[![tests](https://img.shields.io/github/actions/workflow/status/nichoth/nightralph/nodejs.yml?style=flat-square)](https://github.com/nichoth/nightralph/actions/workflows/nodejs.yml)
[![types](https://img.shields.io/npm/types/nightralph?style=flat-square)](README.md)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![install size](https://flat.badgen.net/packagephobia/install/nightralph)](https://packagephobia.com/result?p=nightralph)
[![license](https://img.shields.io/badge/license-Big_Time-blue?style=flat-square)](LICENSE)

This is a minimal Node-based AI orchestrator. It reads local markdown tickets
produced by
[`to-tickets` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md),
resolves their dependency graph, and runs agents in parallel as much as possible,
honoring the ticket dependencies. During setup you can choose
a GitHub-oriented tracker, which installs skill instructions that use
`gh` CLI conventions, but the ticket source is always local markdown files.

This is inspired by [nightshift](https://github.com/Shaurya-Sethi/nightshift/).
I made it because I noticed that the API in `nightshift` had already drifted
from the skill definitions. This module bundles its skill dependencies,
so they can't drift as long as you install the skills with this package.
(See [the section on the `setup` command](#install-dependency-skills).)

<!-- toc -->

- [Install](#install)
  * [Install Dependency Skills](#install-dependency-skills)
- [Workflow](#workflow)
  * [Create Issues](#create-issues)
  * [Execute Tasks with `nightralph`](#execute-tasks-with-nightralph)
- [How It Works](#how-it-works)
  * [Select a ticket](#select-a-ticket)
  * [Worktrees](#worktrees)
  * [Progress](#progress)
- [Keep Your Machine Awake](#keep-your-machine-awake)
  * [Mac OS](#mac-os)

<!-- tocstop -->

## Install

```bash
npm i -S nightralph
```

### Install Dependency Skills

Use the `setup` subcommand in this package to add the required
[Pocock skills](https://github.com/mattpocock/skills) to your repo.
This command will copy some files in this package to a specific directory
in your repo. The upstream
[`grill-with-docs`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)
skill is exposed as `/grill`, along with its sub-skills `grilling`
and `domain-modeling`.


```sh
npx nightralph setup
```

The Pocock skills are bundled with this git repo, at `./skills`.
They are cloned with some metadata, visible in
[skill/upstream.json](skills/upstream.json).
That's how we prevent skill vs API drift.


## Workflow

**The expected flow is**

```
grill -> to-spec -> to-tickets -> tdd
```

First create issues.

After installing this package, use
[the `npx nightralph setup` command](#install-dependency-skills)
to add the required skills to your local `.agents/skills/` folder.

### Create Issues

Use the `to-tickets` skill to create issues in local markdown files from
a prose text description.

The `nightralph` CLI does the `tdd` part of the workflow.

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


### Execute Tasks with `nightralph`

After you have the tickets, use the `nightralph` loop to execute.
The `to-tickets` skill produces markdown files at
`.scratch/<feature>/issues/<NN>-<slug>.md`, with task dependency info.

```bash
# Auto-discover .scratch features and run with claude
npx nightralph claude -m claude-opus-4-6

# Dry run to inspect the dependency graph and prompt
npx nightralph codex --dry-run

# Specify a feature by name
npx nightralph claude -m claude-opus-4-6 --spec my-feature
```

#### `--spec <name>` option

A feature name that resolves to `.scratch/<name>/`.
The spec file is `.scratch/<name>/spec.md` and the issues directory
is `.scratch/<name>/issues/`.

Flags:

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<provider>` | yes | -- | Agent CLI to spawn (e.g. `claude`, `codex`) |
| `-m`, `--model` | no | -- | Model flag passed to the agent |
| `--spec` | no | auto | Feature name (resolves `.scratch/<name>/`) |
| `--dry-run` | no | -- | Show wave order and prompt without running |
| `-X` | no | -- | Stop on merge conflict instead of re-spawning |
| `--timeout` | no | `300` | Kill agent after N seconds |

Notes:

* When `--spec` is omitted, the CLI looks for
  `.scratch/<feature>/issues/` directories. If multiple features exist,
  **it prompts you to pick one** with an interactive selector.
* Tickets are selected by `**Status:** ready-for-agent` in the file body.
* Dependencies are read from the `**Blocked by:**` field; the orchestrator
  skips tickets whose blockers haven't completed.
* Unblocked tickets run in parallel. After a wave finishes, newly unblocked
  tickets start in the next wave.
* An agent run only counts as a success when the agent exits 0,
  its worktree branch has new commits relative to the base branch,
  and the worktree is clean (no uncommitted changes). On success,
  the ticket's status is updated to `done` in-place. If the agent
  exits 0 but made no commits or left uncommitted changes, the
  ticket is left `ready-for-agent` for a retry. Failed tickets
  (non-zero exit) keep their status and block dependents.
* Agent logs are written to `<dir>/../logs/<ticket>.log`.
* Provider commands are launched non-interactively with default flags
  that grant the agent write access to the worktree, so tickets can
  actually be implemented without a permission prompt:
  * `claude`: `--print --dangerously-skip-permissions`
  * `codex`: `exec --full-auto`


## How It Works

All currently eligible tickets are grouped into a
"wave" and run in parallel. Each ticket gets a worktree named after the
ticket slug.

When the wave finishes, every agent that exited successfully has its ticket
marked `done`, which unlocks dependency tickets, which are grouped into the
next wave. This continues until all tickets are complete.


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


---

## Keep Your Machine Awake

This is expected to run for a long time, like overnight.

### Mac OS

```sh
caffeinate -i npx nightralph claude -m claude-opus-4-6
```

That command will prevent your machine from sleeping, but the display can still
go dark.
