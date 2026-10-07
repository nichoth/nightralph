# Attempt Learnings Implementation Plan -- Phase 2: Learnings IO

**Goal:** The filesystem and git edges of the learnings module: read
and append the log, collect an agent's notes file, and exclude the
notes directory from git.

**Architecture:** Thin IO functions added to `src/learnings.ts`, built
on the Phase 1 pure core. Synchronous `node:fs` and `execFileSync`, the
same patterns as `src/worktree.ts:10-24`. Each function may throw;
Phase 4 callers wrap them so learnings never fail a ticket.

**Tech Stack:** TypeScript (ESM), `node:fs`, `node:child_process`,
`@substrate-system/tapzero`.

**Scope:** Phase 2 of 5 from
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md`.

**Codebase verified:** 2026-10-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### attempt-learnings-design.AC3: Learnings IO
- **attempt-learnings-design.AC3.1 Success:** `collectNotes` returns
  the notes file's contents and removes the `.nightralph/` directory,
  also when there is no notes file.
- **attempt-learnings-design.AC3.2 Edge:** `collectNotes` returns
  `null` when there is no notes file.
- **attempt-learnings-design.AC3.3 Success:** After
  `ensureNotesIgnored(worktreePath)`, git ignores everything under
  `.nightralph/` in that worktree (including its own `.gitignore`), and
  nothing under the repo's git dir is written.
- **attempt-learnings-design.AC3.4 Edge:** `readEntries` on a missing
  file returns `[]`.

---

Conventions: same as Phase 1 (80 columns, `foo:string`, `import type`,
`.js` import suffix, no em dashes or arrow characters in comments, no
prose assertions in tests).

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: IO functions

**Verifies:** None on its own (Task 2 tests these)

**Files:**
- Modify: `src/learnings.ts`

**Implementation:**

```ts
import { execFileSync } from 'node:child_process'
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// A missing log means no history yet. Any other read error (e.g.
// the path is a directory) is thrown for the caller to report.
export function readEntries (path:string):LearningEntry[] {
    if (!existsSync(path)) return []
    return parseEntries(readFileSync(path, 'utf8'))
}

// Synchronous on purpose: tickets in a wave run concurrently in one
// Node thread, so sync appends can never interleave.
export function appendEntry (path:string, text:string):void {
    mkdirSync(dirname(path), { recursive:true })
    appendFileSync(path, text)
}

// Reads the agent's notes and removes the whole notes directory
// (also when there are no notes), so nothing in it can reach a
// commit. Blank notes count as none.
export function collectNotes (worktreePath:string):string|null {
    const notesPath = join(worktreePath, NOTES_PATH)
    const text = existsSync(notesPath) ?
        readFileSync(notesPath, 'utf8').trim() :
        ''
    rmSync(dirname(notesPath), { recursive:true, force:true })
    return text || null
}

// Makes the notes directory ignore itself, so an agent's
// `git add -A` cannot stage its notes. Deliberately not
// info/exclude: that file can be a symlink shared by every repo on
// the machine (e.g. via init.templateDir).
export function ensureNotesIgnored (worktreePath:string):void {
    const dir = join(worktreePath, dirname(NOTES_PATH))
    mkdirSync(dir, { recursive:true })
    writeFileSync(join(dir, '.gitignore'), '*\n')
}
```

Imports become `appendFileSync, existsSync, mkdirSync, readFileSync,
rmSync, writeFileSync` from `node:fs` and `dirname, join` from
`node:path`; `execFileSync` is not needed.

**Verification:**
Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output, i.e. no type errors (covers `src/`; the
existing type errors in
`test/display.test.ts` and `test/orchestrator.test.ts` are out of
scope)

**Commit:** none yet (committed with Task 2)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: IO tests

**Verifies:** attempt-learnings-design.AC3.1,
attempt-learnings-design.AC3.2, attempt-learnings-design.AC3.3,
attempt-learnings-design.AC3.4

**Files:**
- Modify: `test/learnings.test.ts` (unit, with temp dirs)

**Implementation:**

Temp dirs with `mkdtempSync(join(tmpdir(), 'nightralph-learnings-'))`,
removed in `finally` with `rmSync(dir, { recursive:true, force:true })`.
For the git test, copy the `initTempRepo` pattern from
`test/progress.test.ts:40-57` (git init, `core.hooksPath /dev/null`,
identity via env vars, empty initial commit). `scripts/test.sh` already
points `TMPDIR` at a private directory that is deleted after the run.

**Testing:**
- AC3.1: write a random-token notes file at `join(dir, NOTES_PATH)`;
  `collectNotes(dir)` returns a string containing the token, and
  afterwards neither the file nor its `.nightralph` directory exists.
  Also: after `ensureNotesIgnored(dir)` with no notes file,
  `collectNotes(dir)` returns `null` and the directory is gone.
- AC3.2: `collectNotes` on an empty dir returns `null`; a notes file
  containing only whitespace also returns `null`.
- Git tests must be hermetic: `git init --template=<empty mkdtemp
  dir>` and `git config core.excludesFile /dev/null` in the temp repo,
  so the user's `init.templateDir` (which may symlink `info/exclude`
  into dotfiles) and global excludes can neither leak in nor be
  written. Use `node:fs` for file setup, `spawnSync('git', [...])`
  with argument arrays, no shell strings, no `as` casts.
- AC3.3: in a temp git repo, snapshot `<git dir>/info/exclude` (or
  its absence), call `ensureNotesIgnored(repoRoot)` twice, write
  `.nightralph/notes.md`; `git check-ignore -q .nightralph/notes.md`
  exits 0, `git status --porcelain` output is empty (the `.gitignore`
  ignores itself), and `info/exclude` is unchanged.
- AC3.3 (worktree): add a worktree (`git worktree add <tmp> -b x`),
  call `ensureNotesIgnored(worktreePath)`, write the notes file there,
  and confirm the same two git checks with `cwd` set to the worktree.
  Declare the worktree path before `try`; in `finally`, run a guarded
  `git worktree remove --force` and `rmSync` both directories.
- AC3.4: `readEntries(join(dir, 'missing.md'))` deep-equals `[]`.
- Round trip through disk: `appendEntry` two rendered entries to a path
  under a not-yet-existing subdirectory, then `readEntries` returns 2
  entries with the right keys.

**Verification:**
Run: `npm test`
Expected: all suites pass

Run: `npx tsc --noEmit -p . 2>&1 | grep 'error TS' | grep learnings.test`
Expected: no output

Run: `npm run lint`
Expected: no errors

**Commit:**
```bash
git add src/learnings.ts test/learnings.test.ts
git commit -m "feat(learnings): read, append, collect notes, exclude"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
