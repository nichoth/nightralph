# Skill/CLI Drift

Prevent version drift by bundling the CLI & skill definitions.

## Background

We see [nightshift](https://github.com/Shaurya-Sethi/nightshift/), which uses
the [Pocock skills](https://github.com/mattpocock/skills/). And reading the
docs for each, we see that the CLI has already drifted from the current version
of the skills.

The Pocock workflow is

```
grill -> to-spec -> to-tickets -> tdd
```

The upstream
[`grill-with-docs`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)
skill is exposed as `/grill`. It is a composite that calls the upstream
`grilling` and `domain-modeling` sub-skills, which are also bundled.

`to-tickets` will create many issues fwiu. We need to be able to start many
`tdd` sessions, preferably in parallel as much as possible.

## Issues

The `nightshift` CLI I think is hardcoded to GH issues, and we want
local markdown. Need the Pocock skills to create local markdown.

### Solution

Seed `docs/agents/issue-tracker.md` via `npx` runnable script.

Should include a script that can be executed with `npmx`, like
`npmx nightralph setup`.

#### Example `issue-tracker.md`

This is an example config for `docs/agents/issue-tracker.md`:

```
# Issue Tracker Config

Where issues live: local markdown files under .scratch/ in this repo.

---

## Conventions

- One feature per directory: .scratch/<feature-name>/
- Implementation issues are stored as one file per ticket at
  `.scratch/<feature-name>/issues/NN-<name>.md`.
- When publishing to the issue tracker: Write markdown files under
  `.scratch/<feature-name>/issues/`.
- When fetching a ticket: Read the file at the referenced path
  under `.scratch/`.
```
