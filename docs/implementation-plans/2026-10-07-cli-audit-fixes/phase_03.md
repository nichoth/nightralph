# CLI audit fixes implementation plan -- phase 3

**Goal:** A thrown error ends the process with one stderr line and
exit 2. Usage errors keep their help text and exit 1.

**Architecture:** `src/index.ts` installs a yargs `.fail()` handler.
yargs 18 routes a rejected async command handler to `.fail()` with
`msg` null and `err` set, and routes validation errors with `msg`
set and no `err`. Once a handler is installed yargs no longer prints
help by itself, so the handler calls `showHelp()` for usage errors.

**Tech Stack:** TypeScript (ESM, Node >= 24), yargs 18.1.0, esbuild,
tapzero tests run by `scripts/test.sh`.

**Scope:** Phase 3 of 5 from
`docs/design-plans/2026-10-07-cli-audit-fixes.md`.

**Codebase verified:** 2026-10-07

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cli-audit-fixes.AC3: Errors end in one line
- **cli-audit-fixes.AC3.1 Success:** A dirty tree when launched
  from a non-default branch exits 2; stderr contains the dirty-tree
  message and contains neither `Options:` nor a line starting with
  `    at `.
- **cli-audit-fixes.AC3.2 Success:** A usage error, such as no
  arguments, still prints help and exits 1.
- **cli-audit-fixes.AC3.3 Success:** Closing the feature prompt
  without a TTY exits 2 with one line and no stack trace.

---

## Project conventions the executor must follow

Same as phase 1: read `/Users/nick/code/nightralph/AGENTS.md`;
4-space indent, single quotes, no semicolons, `name:type` with no
space, 80 columns, tapzero tests, temp dirs removed in `finally`, no
em dashes. `npm run build` before CLI subprocess tests; `npm test`
before each commit.

**Why the dirty-tree case goes through yargs:** `prepareIntegrationBranch`
only checks the tree when the run starts on the default branch; its
throw is already caught at `src/index.ts:419-425`. On any other
branch the check happens inside `runWavesIsolated`
(`src/orchestrator.ts:2459-2463`, text `Working tree is dirty;
commit or stash changes before running`), which nothing in
`src/index.ts` catches, so the rejection reaches yargs. Without a
`.fail()` handler yargs prints the whole help text and the stack.

**yargs typing:** the installed `yargs` package exposes only
`browser.d.ts`, so type the callback parameters explicitly as shown
below. `npm run build` runs `tsc` and will report a mismatch.

---

<!-- START_TASK_1 -->
### Task 1: yargs fail handler

**Verifies:** cli-audit-fixes.AC3.1, cli-audit-fixes.AC3.2,
cli-audit-fixes.AC3.3

**Files:**
- Modify: `src/index.ts:216-219` (the end of the yargs chain:
  `.strict()`, `.demandCommand(...)`, `.help()`, `.parse()`)
- Modify: `test/integration.test.ts:212-237` (`spawnCli` gains a
  `closeStdin` option)
- Test: `test/integration.test.ts` (CLI subprocess tests)

**Implementation:**

Insert `.fail(...)` between `.help()` and `.parse()`:

```ts
    .strict()
    .demandCommand(1, 'Specify a command or provider')
    .help()
    .fail((
        msg:string|null,
        err:unknown,
        y:{ showHelp:() => void }
    ) => {
        // A thrown or rejected error from a command handler: one
        // line, exit 2, same code as the usage errors runExecute
        // exits with itself. No help text, no stack.
        if (err) {
            console.error(formatErrorMessage(err))
            process.exit(2)
        }
        // A parse or validation error: keep today's output.
        y.showHelp()
        console.error(`\n${msg}`)
        process.exit(1)
    })
    .parse()
```

`formatErrorMessage` is already imported from `./orchestrator.js`
on line 22. For an `ExitPromptError` from `@inquirer/prompts` (a
closed or TTY-less prompt) this prints its one-line message, which
satisfies AC3.3 with no further code.

**Test helper change:**

`spawnCli` (`test/integration.test.ts:212-237`) runs the CLI with
`execFile`, which leaves the child's stdin pipe open. An inquirer
prompt then waits on that pipe forever instead of throwing. Add an
option so a test can close it:

```ts
function spawnCli (
    args:string[],
    opts?:{
        cwd?:string
        env?:NodeJS.ProcessEnv
        closeStdin?:boolean
    },
):Promise<{ code:number; stdout:string; stderr:string }> {
    return new Promise(resolve => {
        const child = execFile(
            process.execPath,
            [CLI, ...args],
            { timeout:30_000, cwd:opts?.cwd, env:opts?.env },
            (err, stdout, stderr) => { /* unchanged */ },
        )
        if (opts?.closeStdin) child.stdin?.end()
    })
}
```

Only the `closeStdin` option and the `child.stdin?.end()` line are
new; the callback body stays as it is. Existing callers are
unaffected.

**Testing:**

CLI subprocess tests in `test/integration.test.ts`, using
`spawnCli`. Helpers: `cliGitRepo` (line 4840, returns
`{ projectDir, issuesDir, templateDir }`), `tmp`, `scratchDirs`,
`makeTicketBody`, `commitAll`, `GIT_ENV`, `FEAT`, `MOCK_AGENT`.

- cli-audit-fixes.AC3.1: `cliGitRepo()`, then `execFileSync('git',
  ['checkout', '-b', 'feature'], { cwd:projectDir, env:GIT_ENV })`;
  write a ticket and `commitAll`; then append a line to the spec
  file without committing. Run `spawnCli([MOCK_AGENT, '--spec',
  FEAT, '--no-review'], { cwd:projectDir })`. Assert `code === 2`,
  `stderr` includes `Working tree is dirty`, `stderr` does not
  include `Options:`, and no line of `stderr` starts with
  `    at ` (split on `\n`, `some(l => l.startsWith('    at '))` is
  false). Also assert `stdout` does not include `Options:`. Remove
  `projectDir` and `templateDir` in `finally`.
- cli-audit-fixes.AC3.2: `const dir = tmp()`; `spawnCli([],
  { cwd:dir })`. Assert `code === 1` and that `stderr` includes
  `Options:`. Do not assert on the message text: with no arguments
  the default command's `<provider>` positional fails first, so the
  message is yargs's own `Not enough non-option arguments`, not the
  `demandCommand` text. Remove `dir` in `finally`.
- cli-audit-fixes.AC3.3: a plain temp project with two features
  (`scratchDirs` creates `test-feat`; create a second
  `.scratch/other/issues/` with a `spec.md` and one ticket by hand)
  and no `--spec`, so the CLI shows the feature checkbox. Run
  `spawnCli([MOCK_AGENT], { cwd:projectDir, closeStdin:true })`.
  With stdin closed the prompt rejects with `ExitPromptError`,
  which the fail handler turns into one line. Assert `code === 2`,
  `stderr.trim().split('\n').length === 1`, and no `stderr` line
  starts with `    at `. Remove the project in `finally`.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

Run manually from a dirty repo on a non-default branch:
`node dist/index.js claude --no-review`
Expected: one stderr line `Working tree is dirty; commit or stash
changes before running`, exit code 2 (`echo $?`).

**Commit:** `fix(cli): one-line error output, exit 2, through a yargs
fail handler`
<!-- END_TASK_1 -->
