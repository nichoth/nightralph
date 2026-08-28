# `nightralph`
[![tests](https://img.shields.io/github/actions/workflow/status/nichoth/nightralph/nodejs.yml?style=flat-square)](https://github.com/nichoth/nightralph/actions/workflows/nodejs.yml)
[![types](https://img.shields.io/npm/types/nightralph?style=flat-square)](README.md)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![install size](https://flat.badgen.net/packagephobia/install/nightralph)](https://packagephobia.com/result?p=nightralph)
[![license](https://img.shields.io/badge/license-Big_Time-blue?style=flat-square)](LICENSE)

This is a minimal Node-based AI orchestrator. It reads local markdown tickets
or remote Github issues produced by
[`to-tickets` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md),
resolves their dependency graph, and runs agents in parallel as much as possible,
honoring the ticket dependencies.

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

<!-- tocstop -->

## Install

```bash
npm i -S nightralph
```

### Install Dependency Skills

Use a subcommand in this package to add the required
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

First create issues.

This package bundles the skill files with the CLI, to
**prevent version drift**. After installing this package,
use [the `npx` command](#install-dependency-skills) to add the required
skills to your local `./claude/skills/` folder or `./agents.skills/` folder.

### Create Issues

Use the `to-tickets` skill to create issues in local markdown files.

**The expected flow is**

```
grill -> to-spec -> to-tickets -> tdd
```

The `nightralph` CLI does the `tdd` part.

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

After you have the tickets, you can use the `nightralph` loop to execute.
The `to-tickets` skill produces markdown files at
`.scratch/<feature>/issues/<NN>-<slug>.md`, with task dependency info.

```bash
# Auto-discover .scratch features and run with claude
npx nightralph claude -m claude-opus-4-6

# Dry run to inspect the dependency graph and prompt
npx nightralph claude --dry-run

# Explicit paths (skips auto-discovery)
npx nightralph claude -m claude-opus-4-6 \
  --dir .scratch/my-feature/issues \
  --spec .scratch/my-feature/spec.md
```

#### `--spec` option

The spec is the design document -- it captures the problem, solution,
user stories, and architectural decisions from a conversation.
It's the "what and why" artifact produced by the to-spec skill .


#### `--dir` option

The issues directory (.scratch/<feature>/issues/) holds individual
implementation tickets that get executed by agents one at a time.
Each ticket is a small unit of work with its own status, blockers,
and lifecycle. 


Flags:

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<provider>` | yes | -- | Agent CLI to spawn (e.g. `claude`, `codex`) |
| `-m`, `--model` | no | -- | Model flag passed to the agent |
| `--dir` | no | auto | Path to the issues directory |
| `--spec` | no | auto | Path to the spec file |
| `--dry-run` | no | -- | Show wave order and prompt without running |
| `--timeout-secs` | no | `300` | Kill agent after N seconds |

Notes:

* When `--dir` and `--spec` are omitted, the CLI looks for
  `.scratch/<feature>/issues/` directories. If multiple features exist,
  **it prompts you to pick one** with an interactive selector.
* Tickets are selected by `**Status:** ready-for-agent` in the file body.
* Dependencies are read from the `**Blocked by:**` field; the orchestrator
  skips tickets whose blockers haven't completed.
* Unblocked tickets run in parallel. After a wave finishes, newly unblocked
  tickets start in the next wave.
* On success (agent exit 0), the ticket's status is updated to `done`
  in-place. Failed tickets keep their status and block dependents.
* Agent logs are written to `<dir>/../logs/<ticket>.log`.


## Keep Your Machine Awake

This is expected to run for a long time, like overnight.

### Mac OS

```sh
caffeinate -i npx nightralph claude -m claude-opus-4-6
```
