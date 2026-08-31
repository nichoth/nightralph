# nightralph bug: missing `.claude/skills/` symlinks

## Problem

When `npx nightralph setup` runs, skills are copied to
`.agents/skills/` but symlinks in `.claude/skills/` are not always
created. Claude Code only discovers skills via `.claude/skills/`, so
the missing symlinks make those skills invisible.

In `asymmetric-latency`, 16 skills were installed to `.agents/skills/`
but only 12 had symlinks in `.claude/skills/`. The 4 missing:
`domain-modeling`, `grill`, `grilling`, `to-tickets`.

## Root cause

Two issues in `src/setup.ts` and `src/index.ts`:

1. The `--claude` flag (`src/index.ts`, lines 33-37) defaults to
   `false`. The symlink-creation loop in `src/setup.ts` (lines
   113-131) is gated on `if (claude)` at line 113. Running
   `npx nightralph setup` without `--claude` skips symlink creation
   entirely. This flag should default to `true`, or auto-detect
   whether a `.claude/` directory exists in the target project.

2. The `SKILL_DIRS` constant in `src/setup.ts` only lists 6 of the
   16 skills nightralph ships. The other 10 were installed by a prior
   version. If nightralph is the canonical installer, `SKILL_DIRS`
   should either list every bundled skill or dynamically enumerate the
   `skills/` directory rather than maintaining a hardcoded subset.

## How the 12 existing symlinks survived

They were created by a prior nightralph install (commit `1563300`,
Aug 23) that either used `--claude` or ran an older version that
always created symlinks. The current install added 4 new skills to
`.agents/skills/` but never created their symlinks.

## Fix

1. Change the `--claude` flag default from `false` to `true` in
   `src/index.ts` line 36.
2. Make the symlink loop in `src/setup.ts` enumerate every directory
   under `.agents/skills/` rather than relying on `SKILL_DIRS`. This
   way any new skill added to the bundle is automatically symlinked
   without updating a hardcoded list.
3. The symlink loop should also be idempotent -- skip symlinks that
   already exist and point to the correct target, rather than failing
   or silently doing nothing.

## Verification

After the fix, `npx nightralph setup` in a project with a `.claude/`
directory should produce one symlink in `.claude/skills/<name>` for
every directory in `.agents/skills/<name>`, with no manual
`--claude` flag needed.
