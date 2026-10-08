# CLI audit fixes implementation plan -- phase 5

**Goal:** README and AGENTS.md describe the tool as it behaves after
phases 1 to 4.

**Architecture:** Documentation only. The README gets a Requirements
paragraph, a sentence on where worktrees live, and corrected test
gate wording in the two places that describe it. AGENTS.md gets the
new module's contract and the changed contracts of the functions
that take `testCmd`, plus the CLI's error handling and the new npm
script.

**Tech Stack:** Markdown. `npm run toc` (markdown-toc) regenerates
the README table of contents; Task 1 adds a `### Requirements`
heading, so it must be run once and its output kept.

**Scope:** Phase 5 of 5 from
`docs/design-plans/2026-10-07-cli-audit-fixes.md`.

**Codebase verified:** 2026-10-07

---

## Acceptance Criteria Coverage

This phase implements:

### cli-audit-fixes.AC5: Docs match
- **cli-audit-fixes.AC5.1:** README Install lists Node, git, the
  provider CLI on PATH, and macOS or Linux as requirements.
- **cli-audit-fixes.AC5.2:** README Worktrees states worktrees are
  sibling directories named `<repo>.<num>-<slug>` and that an
  interrupted run leaves them.
  The README documents the feature form
  `<repo>.<feature>-<num>-<slug>`, which is what every CLI run
  creates; this supersedes the design's `<repo>.<num>-<slug>`
  wording.
- **cli-audit-fixes.AC5.3:** The README `--test-cmd` row describes
  detection, the no-gate fallback and `""`.
- **cli-audit-fixes.AC5.4:** AGENTS.md contains the
  `src/preflight.ts` contract, the `''` meaning of `testCmd` on
  every function that takes it, and the `.fail()` and
  `prepublishOnly` entries.

These are verified by reading, not by automated tests: the user's
rules say not to write tests for docs.

---

## Conventions

No em dashes and no arrow characters in Markdown; use `--` and
`->`. Wrap AGENTS.md bullets the way the neighbors are wrapped
(about 60 columns, two-space continuation). Keep README table rows
on one line, as the existing rows are. Line numbers below are from
the tree before phases 1 to 4 were applied; locate by the quoted
text if they have moved.

**Known pre-existing mismatch, do not fix here:** `dryRunIsolated`
(`src/orchestrator.ts:1279-1283`) prints worktree paths as
`<repo>.<feature>.<num>-<slug>` while `createWorktree` creates
`<repo>.<feature>-<num>-<slug>`. The README below documents what is
created. The dry-run printer is a separate follow-up ticket.

---

<!-- START_TASK_1 -->
### Task 1: README

**Verifies:** cli-audit-fixes.AC5.1, cli-audit-fixes.AC5.2,
cli-audit-fixes.AC5.3

**Files:**
- Modify: `README.md:51-56` (`## Install`), `README.md:103-106`
  (Workflow gate sentence), `README.md:169` (the `--test-cmd` row),
  `README.md:190` (How It Works gate sentence), `README.md:299-316`
  (`### Worktrees`)

**Step 1: Requirements under Install**

After the `npm i -S nightralph` code block (line 55) and before
`### Install Dependency Skills` (line 57), add:

```markdown
### Requirements

- Node 24 or newer (see `engines` in `package.json`) and git.
- The agent CLI you name on the command line (`claude`, `codex` or
  `pi`) installed and on your `PATH`. nightralph checks this before
  it touches git and exits with code 2 if the command is not found.
- macOS or Linux. nightralph runs agents in their own process group
  and uses `sh -c` for test and install commands, so it does not
  run on Windows.
```

Adding a heading changes the table of contents; run `npm run toc`
and keep the regenerated README.

**Step 2: The `--test-cmd` row**

Replace line 169 with one row:

```markdown
| `--test-cmd <cmd>` | no | auto | Run in each worktree after the agent exits; non-zero exit rejects the ticket. Defaults to `npm test` when `package.json` has a `test` script. When nothing is detected the run has no test gate and says so at startup. Pass `""` to run without a gate. Shares the agent's `--timeout`. Dependencies are already installed by `--install-cmd` |
```

**Step 3: The two gate sentences**

Line 190 reads `and the test command (see \`--test-cmd\`) exits 0 in
that worktree.` as the last condition for a ticket to count as
done. Change it to `and the test command (see \`--test-cmd\`), when
there is one, exits 0 in that worktree.`

Lines 105-106 (in Workflow) read `the orchestrator runs the
project's test command in the worktree before a ticket can be
marked \`done\`.` Change to `the orchestrator runs the project's
test command, when there is one, in the worktree before a ticket
can be marked \`done\`.`

**Step 4: Worktrees**

In `### Worktrees`, after the first paragraph (ends `onto the updated
base before merging.`), add a paragraph. The CLI always passes the
feature name to `scanTickets`, so a CLI run always gets the feature
form of the directory and branch names (`createWorktree` and
`buildBranchName` in `src/worktree.ts`):

```markdown
Worktrees are created next to the repository, not inside it: a
ticket's worktree is the sibling directory
`<repo>.<feature>-<num>-<slug>` on the branch
`<repo>--<feature>-<num>-<slug>`. A run that is interrupted leaves
them in place; the next run removes a stale worktree and branch of
the same name before creating a new one.
```

**Step 5: Verify**

Run: `npm run lint`
Expected: no errors (lint does not cover Markdown, but confirms
nothing else was touched).

Read the five changed regions once more against the code: the exit
code in Step 1 is the one `src/index.ts` uses for a missing
provider; the gate wording in Steps 2 and 3 matches `src/index.ts`
after phase 2; the worktree naming in Step 4 matches
`createWorktree` (`src/worktree.ts:315-340`) and `buildBranchName`
(`src/worktree.ts:221-230`).

**Commit:** `docs(readme): requirements, worktree location, test gate
wording`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: AGENTS.md contracts

**Verifies:** cli-audit-fixes.AC5.4

**Files:**
- Modify: `AGENTS.md:3` (`Last verified`), `AGENTS.md:12-18`
  (`## Commands`), `AGENTS.md:20-38` (`## Project Structure`),
  `AGENTS.md:62-80` (CLI section), `AGENTS.md:259-296`
  (`spawnAgent` and `renderPrompt` bullets), `AGENTS.md:325` and
  `:355` (`runWaves`, `runWavesIsolated`), `AGENTS.md:886-896`
  (rules module), `AGENTS.md:969-977` (`runFixer`), and a new
  `### preflight module` section

**Step 1: Header and structure**

- Set `Last verified:` (line 3) to the date of this commit.
- Under `## Commands`, the `npm test` bullet (line 14) says `build
  and run tests via scripts/test.sh`. That is false: the script
  bundles only the test files and runs them against whatever
  `dist/` already holds. Change the start of the bullet to
  ``- `npm test` -- run tests via `scripts/test.sh` (does not
  rebuild `dist/`; run `npm run build` first when `src/` changed),``
  and keep the rest of the sentence about `TMPDIR`.
- Under `## Commands`, add after the `npm run lint` bullet:
  ``- `npm publish` -- `prepublishOnly` runs `npm run build` and
  `npm test` first, so a red suite or a stale `dist/` cannot be
  published``
- Under `## Project Structure`, add after the `src/testcmd.ts`
  bullet: ``- `src/preflight.ts` -- provider executable lookup``.
  Also add ``- `src/resolve.ts` -- feature selection
  (`.scratch/<feature>/` discovery and the interactive picker)``,
  which exists but was never listed.

**Step 2: CLI section**

Replace the `--test-cmd` bullet (lines 75-77) with:

```markdown
- `--test-cmd <cmd>` -- command run in each worktree
  after the agent exits; non-zero exit rejects the
  ticket. When the flag is absent the command is
  `detectTestCmd(root)`, else `''` (no gate), and the CLI
  logs one line saying no test command was detected.
  `--test-cmd ""` is an explicit `''`. `''` is passed
  through unchanged to `runWaves`, `runWavesIsolated`,
  `dryRun`, `dryRunIsolated` and the review pass
```

Add two bullets immediately before the `**Integration branch**`
bullet (AGENTS.md:107):

```markdown
- **Provider preflight**: after the first ticket scan and
  before `prepareIntegrationBranch`, `runExecute` calls
  `resolveExecutable(provider)`. `null` prints
  `Provider '<name>' not found on PATH` and exits 2, so a
  bad name never creates or checks out a branch. Under
  `--dry-run` it prints a `Provider:` line instead and
  continues
- **Errors**: a yargs `.fail()` handler. A thrown or
  rejected error from a command (a dirty tree found by
  `runWavesIsolated`, a git failure, a closed or TTY-less
  inquirer prompt) prints `formatErrorMessage(err)` to
  stderr and exits 2, with no help text and no stack. A
  usage error prints the help text and the message and
  exits 1, as before
```

**Step 3: Orchestrator section**

- In the `spawnAgent(opts)` bullet (line 259 onward), after the
  sentence about the timeout being reported through `onLine` (or
  `console.warn`) and the ticket log, add: `a spawn error (e.g.
  ENOENT) is reported the same way, through `onLine` or
  `console.error` and as a line in the ticket log, and resolves
  with `exitCode:1``.
- In the `renderPrompt(specBody, ticket, opts)` bullet (line 290),
  after ``opts.testCmd` is required; ... names the test command the
  orchestrator will run after the agent exits`, add: `; when
  `opts.testCmd` is `''` the rule names no command and says the
  orchestrator runs none`.
- In the `runWaves(...)` bullet (line 325), after `requires
  `testCmd` (string)`, add `(`''` means no test gate; the in-place
  runner has never run one, the value only shapes the prompt, so a
  non-empty value still makes the prompt promise a gate that
  in-place runs do not perform)`.
- In the `runWavesIsolated(opts)` bullet (line 355), after `requires
  `testCmd` (string)`, add `(`''` skips the test gate: `runTestGate`
  returns true without spawning or writing a `.test.log`, and the
  branch goes straight to the merge queue)`.
- In the `dryRunIsolated(opts)` bullet, add `prints `Test command:
  (none)` for `''``.
- In the orchestrator Exposes list (line 156), the entry
  `dryRun(tickets, specBody)` is stale: the function already takes
  a third `testCmd` argument. Change it to `dryRun(tickets,
  specBody, testCmd)` and add a bullet: `**dryRun(tickets,
  specBody, testCmd)**: in-place dry run; prints the wave order,
  `Test command: <cmd>` (`(none)` for `''`) and the first ready
  ticket's prompt`.

**Step 4: Rules and review sections**

- `### rules module`, Guarantees: add a sentence: `testGateRule(
  testCmd, subject)` returns the full gate rule naming the command
  for a non-empty `testCmd`, and for `''` a shorter rule (run the
  relevant tests before each commit, do not commit with failing
  tests, the orchestrator runs no test command for this
  `<subject>`).
- `### review module`, `runFixer` bullet (lines 975-977): change `a
  red test gate (`review-fix.test.log`) fails` to `a red test gate
  (`review-fix.test.log`) fails, and `testCmd:''` skips the gate
  and writes no log`.
- `### review module`, `renderFixPrompt` (in the Exposes list or
  where the fixer prompt is described): add that it shares
  `testGateRule` with `renderPrompt`, so `testCmd:''` yields the
  no-gate rule.
- `### review module`, `runReviewPass(opts, deps)` bullet: add
  that `opts.testCmd` is required and `''` means the fixer runs
  without a test gate.

**Step 5: New section**

Add after `### testcmd module` (line 517 onward, before `### display
module`):

```markdown
### preflight module (`src/preflight.ts`)
- **Exposes**: `ResolveExecutableOpts`,
  `resolveExecutable(cmd, opts?)`
- **resolveExecutable(cmd, opts?)**: `opts` is
  `{ path?, cwd? }` (default `process.env.PATH` and
  `process.cwd()`). A `cmd` containing `/` is resolved
  against `cwd` and returned when it is an executable
  file. A bare name is looked up in each `path` entry in
  order; the first executable file wins. Everything else
  (including `''`) is `null`
- **Guarantees**: pure and synchronous, imports only
  `node:fs` and `node:path`, spawns nothing, never throws.
  It checks existence and the execute bit, not that the
  command runs
```

**Step 6: Verify**

Read each changed bullet against the code it describes:
`src/preflight.ts`, `src/index.ts` (preflight block, test command
block, `.fail()`), `src/orchestrator.ts` (`spawnAgent` error
handler, `runTestGate`, both dry-run printers), `src/rules.ts`,
`src/review.ts` (fixer gate), `package.json`. Every sentence must be
true of the code.

Run: `npm run lint`
Expected: no errors.

**Commit:** `docs(agents): preflight, empty test command, fail
handler, prepublishOnly`
<!-- END_TASK_2 -->
