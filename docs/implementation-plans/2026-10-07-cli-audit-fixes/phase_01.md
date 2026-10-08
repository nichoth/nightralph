# CLI audit fixes implementation plan -- phase 1

**Goal:** A provider that cannot be found fails the run in one line,
before any git state changes, and a spawn error reaches the status
display.

**Architecture:** A new pure module, `src/preflight.ts`, resolves a
command name or path to an executable file. `runExecute` in
`src/index.ts` calls it right after the first ticket scan and before
`prepareIntegrationBranch`. `spawnAgent` in `src/orchestrator.ts`
reports a spawn error the way it already reports a timeout: through
`opts.onLine` when present, else to the console.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild, tapzero tests
run by `scripts/test.sh`.

**Scope:** Phase 1 of 5 from
`docs/design-plans/2026-10-07-cli-audit-fixes.md`.

**Codebase verified:** 2026-10-07

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cli-audit-fixes.AC1: A missing provider fails fast
- **cli-audit-fixes.AC1.1 Success:** `resolveExecutable` returns
  the absolute path of a bare name found in a PATH entry; the first
  entry that has it wins.
- **cli-audit-fixes.AC1.2 Success:** `resolveExecutable` returns a
  `cmd` containing a path separator when that file exists and is
  executable, resolved against `cwd`.
- **cli-audit-fixes.AC1.3 Failure:** `resolveExecutable` returns
  `null` for a name in no PATH entry, a path that does not exist,
  and an existing file without execute permission. It never throws.
- **cli-audit-fixes.AC1.4 Success:** The CLI given a bare provider
  name that is not on PATH exits 2, stderr names the provider, no
  `nightralph--*` branch exists afterwards, and the current branch
  is unchanged.
- **cli-audit-fixes.AC1.5 Success:** The CLI given an absolute path
  to a mock agent runs it as before.
- **cli-audit-fixes.AC1.6 Edge:** `--dry-run` with a provider not on
  PATH exits 0 and prints a `Provider:` line saying it was not
  found.
- **cli-audit-fixes.AC1.7 Success:** When `spawnAgent` is given
  `onLine` and the spawn fails, the error text arrives through
  `onLine`, and the attempt resolves with exit code 1.

---

## Project conventions the executor must follow

Read `/Users/nick/code/nightralph/AGENTS.md` first. Then:

- Style: 4-space indent, single quotes, no semicolons, no space in
  type annotations (`name:string`, `{ key:value }`), `string|null`
  unions without spaces, `T[]` arrays as the repo already uses, 80
  column lines, `function name (args):Type {` with a space before
  the parenthesis. `npm run lint` enforces most of this.
- Imports from local modules end in `.js`
  (`import { x } from './preflight.js'`).
- Tests: `import { test } from '@substrate-system/tapzero'`, named
  `'<module> - <behavior>'`, `t.ok` / `t.equal` / `t.deepEqual` with
  a message as the last argument, temp dirs from `mkdtempSync(join(
  tmpdir(), 'nightralph-...'))` removed in `finally`. Do not assert
  on exact prose; assert on the one token that matters (a path, a
  provider name, an exit code).
- No em dashes or arrow characters in comments or docs. Use `--` and
  `->`.
- Build before CLI subprocess tests: `npm run build` writes
  `dist/index.js`, which `test/integration.test.ts` runs. `npm test`
  does not build.
- Run a single suite while iterating with
  `npm run build && bash -c 'esbuild test/<name>.test.ts
  --format=esm --bundle --packages=external --outdir=dist/test
  --sourcemap && node dist/test/<name>.test.js'` (the `esbuild`
  binary is in `node_modules/.bin`). Run `npm test` in full before
  each commit.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `resolveExecutable` in `src/preflight.ts`

**Verifies:** cli-audit-fixes.AC1.1, cli-audit-fixes.AC1.2,
cli-audit-fixes.AC1.3

**Files:**
- Create: `src/preflight.ts`
- Create: `test/preflight.test.ts` (unit)
- Modify: `scripts/test.sh:13-28` (the `TESTS` array)
- Modify: `package.json` (the `build-esm` script)

**Implementation:**

`src/preflight.ts` is a pure module: no imports from other `src/`
files, no process spawning, nothing thrown. Write it as:

```ts
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export type ResolveExecutableOpts = {
    // PATH to search for a bare name; default process.env.PATH
    path?:string
    // directory a relative path is resolved against; default
    // process.cwd()
    cwd?:string
}

function isExecutableFile (file:string):boolean {
    try {
        if (!statSync(file).isFile()) return false
        accessSync(file, constants.X_OK)
        return true
    } catch {
        return false
    }
}

// Where a command would run from, or null when it would not run.
// A name with a slash is a path, resolved against cwd. A bare name
// is looked up in each PATH entry in order. Never throws.
export function resolveExecutable (
    cmd:string,
    opts:ResolveExecutableOpts = {}
):string|null {
    if (cmd === '') return null
    const cwd = opts.cwd ?? process.cwd()
    if (cmd.includes('/')) {
        const full = resolve(cwd, cmd)
        return isExecutableFile(full) ? full : null
    }
    const path = opts.path ?? process.env.PATH ?? ''
    for (const dir of path.split(delimiter)) {
        if (dir === '') continue
        const candidate = join(dir, cmd)
        if (isExecutableFile(candidate)) return candidate
    }
    return null
}
```

Add `preflight` to the `TESTS` array in `scripts/test.sh` on its own
line after `testcmd` (line 24), so the suite runs with `npm test`.

In `package.json`, the `build-esm` script lists every `src/` module
for the per-module esbuild output (the second `esbuild` call, which
names `src/orchestrator.ts src/setup.ts ...`). Add `src/preflight.ts`
to that list, after `src/testcmd.ts`, so `dist/preflight.js` is
emitted like the others.

**Testing:**

`test/preflight.test.ts`. Build fixtures with `mkdtempSync` under
`tmpdir()`: two directories `a` and `b`, each holding an executable
file named `tool` (write `#!/bin/sh\nexit 0\n`, then
`chmodSync(file, 0o755)`), plus a file `noexec` in `a` with mode
`0o644`. Pass `path:[a, b].join(delimiter)` and `cwd` explicitly so
the tests never depend on the real PATH. Remove the temp dir in
`finally`.

Tests must verify each AC listed above:
- cli-audit-fixes.AC1.1: `resolveExecutable('tool', { path })`
  equals `join(a, 'tool')`, not the copy in `b`. With
  `path:[b, a].join(delimiter)` it equals `join(b, 'tool')`.
- cli-audit-fixes.AC1.2: `resolveExecutable('./tool', { cwd:a })`
  equals `join(a, 'tool')`; an absolute path to `a/tool` returns the
  same absolute path.
- cli-audit-fixes.AC1.3: `resolveExecutable('nosuch', { path })` is
  `null`; `resolveExecutable(join(a, 'missing'))` is `null`;
  `resolveExecutable('noexec', { path })` is `null`;
  `resolveExecutable('', { path })` is `null`; a `path` entry that is
  a nonexistent directory does not throw and the lookup continues to
  the next entry.

**Verification:**

Run: `npm test`
Expected: all suites pass, including the new `preflight` suite.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build && ls dist/preflight.js`
Expected: the file exists.

**Commit:** `feat(preflight): resolve a provider command to an
executable`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: CLI preflight before the integration branch

**Verifies:** cli-audit-fixes.AC1.4, cli-audit-fixes.AC1.5,
cli-audit-fixes.AC1.6

**Files:**
- Modify: `src/index.ts:26` (imports), `src/index.ts:411-414`
  (after `loadTicketsOrExit`), `src/index.ts:476-503` (the
  `--dry-run` block)
- Test: `test/integration.test.ts` (CLI subprocess tests, next to
  the existing `CLI subprocess - error for nonexistent feature` test
  at line 405)

**Implementation:**

Import the new function next to the `testcmd` import on line 26:

```ts
import { resolveExecutable } from './preflight.js'
```

In `runExecute`, after line 412 (`if (loaded.allTickets.length ===
0) return`) and before line 414 (`const isolated = isGitRepo()`),
add:

```ts
    const providerPath = resolveExecutable(argv.provider)
    if (providerPath === null && !argv.dryRun) {
        console.error(
            `Provider '${argv.provider}' not found on PATH`
        )
        process.exit(2)
    }
```

This runs before `prepareIntegrationBranch` (line 419), so a bad
name never creates or checks out `nightralph--<feature>`. Keep
`agentCmd:argv.provider` unchanged where `runWavesIsolated` and
`runWaves` are called; the resolved path is only for the check and
the dry-run line.

In the `--dry-run` block, as the first statement inside
`if (argv.dryRun) {` (line 476), before the `if (isolated)` branch,
add one line so both the isolated and the in-place dry run print it:

```ts
        console.log(
            `Provider:     ${providerPath ?? 'not found on PATH'}`
        )
```

The padding matches the existing `Review:       on` line.

**Testing:**

Add three CLI subprocess tests to `test/integration.test.ts` using
the existing helpers `spawnCli`, `tmp`, `scratchDirs`,
`makeTicketBody`, `FEAT`, `commitAll` and, for the git case,
`cliGitRepo()` (line 4840). `cliGitRepo` returns `{ projectDir,
issuesDir, templateDir }`: a hermetic repo (`git init --template`
with an empty template dir, so the shared `info/exclude` is never
touched) on branch `main`, with `.scratch/*/logs/` ignored and the
`test-feat` scratch layout created. Do not use plain
`initTempGitRepo()` for CLI tests: its branch name follows the
machine's `init.defaultBranch`. Remove both `projectDir` and
`templateDir` in `finally`. Each test writes one ticket `01-task.md`
with status `ready-for-agent`.

- cli-audit-fixes.AC1.4: `const { projectDir, issuesDir,
  templateDir } = cliGitRepo()`, write the ticket, `commitAll(
  projectDir, 'add tickets')`, then run
  `spawnCli(['nightralph-no-such-provider', '--spec', FEAT],
  { cwd:projectDir })`. Assert `code === 2`, `stderr` includes
  `nightralph-no-such-provider`, `git branch --list 'nightralph--*'`
  in the repo prints nothing, and `git rev-parse --abbrev-ref HEAD`
  is still `main` (use `gitOut(projectDir, [...])`, line 4386).
- cli-audit-fixes.AC1.5: in a plain temp project (no git), run
  `spawnCli([MOCK_AGENT, '--spec', FEAT, '--timeout', '10'],
  { cwd:projectDir })`. Assert `code === 0` and that
  `join(logsDir, '01-task.log')` exists. This mirrors the existing
  `--model` test at line 274 and proves an absolute path still
  passes the check.
- cli-audit-fixes.AC1.6: in a plain temp project, run
  `spawnCli(['nightralph-no-such-provider', '--spec', FEAT,
  '--dry-run'], { cwd:projectDir })`. Assert `code === 0` and that
  `stdout` includes `Provider:` and `not found`.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

**Commit:** `feat(cli): check the provider exists before touching
git`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Spawn errors reach the display

**Verifies:** cli-audit-fixes.AC1.7

**Files:**
- Modify: `src/orchestrator.ts:1179-1201` (the `proc.on('error')`
  handler inside `spawnAgent`)
- Test: `test/orchestrator.test.ts` (unit, next to the `spawnAgent`
  `onLine` tests around line 3655)

**Implementation:**

The timeout handler at `src/orchestrator.ts:1097-1114` already
writes its message to the log stream and then to `opts.onLine` when
present, else `console.warn`, using `prefix` (line 1000). Make the
error handler do the same. Replace lines 1189-1200 (`logStream.end()`
through the closing of `resolve({ ... })`) with:

```ts
            const msg = 'agent process error: ' +
                formatErrorMessage(err)
            logStream.write(`nightralph: ${msg}\n`)
            if (promptFile) cleanupPromptFile(promptFile)
            if (opts.onLine) {
                opts.onLine(`${prefix}${msg}`)
            } else {
                console.error(`${prefix}${msg}`)
            }
            // Resolve only once the log is flushed, so a caller
            // that reads the log right away sees the message.
            logStream.end(() => {
                resolve({
                    exitCode:1,
                    completedItems,
                    timedOut,
                })
            })
```

Keep the start of the handler (settled flag, timers,
`runningAgents`, `rl.close()`, `rlErr.close()`) exactly as it is.
The `end` callback matters: a plain `logStream.end()` followed by
`resolve(...)` returns before the write reaches disk, and the log
assertion below would fail.

**Testing:**

- cli-audit-fixes.AC1.7: call `spawnAgent({ prompt:'x',
  agentCmd:join(tmpDir, 'nightralph-no-such-agent'), model:null,
  timeout:10, logPath:join(tmpDir, 'agent.log'), onLine:line =>
  lines.push(line) })` where `tmpDir` is a fresh temp dir. Assert
  the result has `exitCode === 1`, that some collected line includes
  `ENOENT`, and that `agent.log` exists and includes `ENOENT`.
  Remove `tmpDir` in `finally`.

**Verification:**

Run: `npm test`
Expected: all suites pass.

**Commit:** `fix(orchestrator): report spawn errors through the
display`
<!-- END_TASK_3 -->
