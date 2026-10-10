# Prefer Subagent Implementation Plan

**Goal:** `--prefer-subagent <model>` reaches every spawned claude
agent and its prompt; non-claude providers warn once and drop it;
dry runs print it.

**Architecture:** The value travels as `preferSubagent?:string` on
the same path as `effort`: `src/index.ts` -> `runWaves` /
`runWavesIsolated` -> `runTicketAttempts` / `runTicketAttempt`,
`respawnAndRetryMerge`, `runReviewPass` -> `runReviewer` /
`runFixer` -> `spawnAgent` (env, Phase 2) and the prompt builders
(rule, Phase 3). `runExecute` normalises `""` to unset and drops the
value with one warning for any provider other than claude, so nothing
downstream needs a provider check for the prompt rule.

**Tech Stack:** TypeScript, yargs, tapzero

**Scope:** Phase 4 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

This phase implements and tests:

### prefer-subagent.AC1: Flag and env
- **prefer-subagent.AC1.1 Success:** `--dry-run --prefer-subagent X`
  prints `Prefer subagent: X`
- **prefer-subagent.AC1.2 Success:** `--dry-run` without the flag
  prints `Prefer subagent: (none)`
- **prefer-subagent.AC1.3 Failure:** with provider codex or pi, one
  warning is printed, the run continues (dry run exits 0), and no
  agent gets the env var or the prompt rule
- **prefer-subagent.AC1.6 Success:** the option reaches ticket,
  merge-respawn, reviewer and fixer spawns
- **prefer-subagent.AC1.7 Edge:** `--prefer-subagent ""` behaves
  exactly like an absent flag

---

## Codebase notes for the executor

- `src/index.ts`:
  - yargs options for the execute command at ~:120-190; copy the
    style of `max-turns` (:153-157) and `effort` (:158-164).
  - argv -> `runExecute({...})` mapping at ~:193-215
    (`effort:argv.effort as EffortLevel|undefined`).
  - `runExecute(argv:{...})` type at :413-428.
  - Provider preflight at :436-452: `resolveExecutable`, exit 2 when
    missing outside `--dry-run`, then `agentCmd` is computed.
  - `--dry-run` block at ~:520-547: prints `Provider:`, calls
    `dryRunIsolated({...})` (git repo) or
    `dryRun(allTickets, fallbackSpec, testCmd)` (not a git repo).
  - `runWavesIsolated({...})` call at ~:563-590 and positional
    `runWaves(...)` call at ~:592-606.
  - `node:path` import at :5 is `{ dirname, join }`; add `basename`.
- `src/orchestrator.ts`:
  - `dryRun(tickets, specBody, testCmd)` at :1210-1244: prints
    `\nTest command: ...` then the first ready ticket's
    `renderPrompt(..., { testCmd })`.
  - `dryRunIsolated(opts)` at :1246-1339: opts type at :1246-1258;
    prints the first ready prompt (~:1293-1307), then `Test
    command:`, `Install:`, `Effort:`, `Retries:`, `Retry delay:`,
    `Concurrency:` lines (~:1312-1331).
  - `respawnAndRetryMerge(opts)` at :1423-1438 (opts type),
    `renderMergePrompt(..., { installCmd })` at ~:1472, its
    `spawnAgent({...})` at ~:1484-1494. It passes no `effort` today;
    leave that as is.
  - `TicketAttemptOpts` at :1647-1664; `runTicketAttempt` renders the
    prompt and calls `spawnAgent` at ~:1754-1777.
    `runTicketAttempts` spreads `...opts` into `runTicketAttempt`, so
    a new `TicketAttemptOpts` field flows through without edits there.
  - In-place `runWaves` positional signature at :2234-2248 (last
    param `concurrency?:number`); `renderPrompt(specBody, t,
    { testCmd })` at ~:2293 and two `spawnAgent({...})` calls at
    ~:2303 and ~:2342.
  - `runWavesIsolated(opts)` type at :2425-2459; `runTicketAttempts
    ({...})` call at ~:2576-2597; `respawnAndRetryMerge({...})` call
    at ~:2831-2849; `runReviewPass({...}, deps)` at ~:3015-3035.
- `src/review.ts`: `SpawnAgentFn` at :475-486 mirrors spawnAgent's
  opts; `ReviewPassOpts` at :494-518; reviewer `deps.spawnAgent
  ({...})` at ~:596-612 (`renderReviewPrompt({...})`); fixer at
  ~:696-714 (`renderFixPrompt({...})`).
- Tests:
  - `test/integration.test.ts`: `spawnCli(args, { cwd?, env?,
    closeStdin? })` at :213-244 runs `dist/index.js` (so
    `npm run build` first). `--dry-run` example at :332-365 uses
    `projectDir = tmp()` (not a git repo -> `dryRun`),
    `scratchDirs(projectDir)`, `makeTicketBody`, `FEAT`.
    `initTempGitRepo()` at :651 gives a git repo. For CLI runs in a
    git repo use `cliGitRepo()` at :4904 instead (hermetic template,
    branch `main`, `.scratch/*/logs/` ignored; returns `{ projectDir,
    issuesDir, templateDir }`), commit the tickets with
    `commitAll(projectDir, ...)`, and clean up with
    `removeWorktreesAndRepo(projectDir)` (:2284) plus
    `rmSync(templateDir, { recursive:true, force:true })`, as the
    CLI test at :4919 does.
    The respawn test at :2677-2780 uses
    `installMergeFailOnceGit(failBranch)` (fake `git` on PATH that
    fails the first `git merge <failBranch>`) with `MOCK_PASS`.
  - `test/review-integration.test.ts`: `withHarness(env, fn)` at
    :71-145 builds a repo and exposes `h.run(review, display,
    forkedFrom)`, which calls `runWavesIsolated` with
    `agentCmd:MOCK` (`test/mock-agent-review.js`, which plays ticket,
    reviewer or fixer from the prompt). `ENV_KEYS` at :67-69 lists
    the env vars it saves and restores. `countRoles(recordDir)`.
  - The fake claude from Phase 2 is `test/fake-claude/claude`.

---

<!-- START_TASK_1 -->
### Task 1: Fake claude can delegate to an existing mock agent

**Verifies:** None (test fixture)

**Files:**
- Modify: `test/mock-agent-claude.js`

**Implementation:**

Add `FAKE_CLAUDE_DELEGATE` (path to a `test/mock-agent-*.js`). The
fake must buffer stdin (the prompt) instead of discarding it. After
the env log and the stream, when `FAKE_CLAUDE_DELEGATE` is set, run
the delegate with the same prompt, cwd, env and arguments, and exit
with its status:

```js
import { spawnSync } from 'node:child_process'
// ...
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks)
    // ... env log, stream (unchanged) ...
    const delegate = process.env.FAKE_CLAUDE_DELEGATE
    if (delegate) {
        const r = spawnSync(
            process.execPath,
            [delegate, ...process.argv.slice(2)],
            { input:prompt, stdio:['pipe', 'inherit', 'inherit'] }
        )
        process.exitCode = r.status ?? 1
        return
    }
    // ... hang / exitCode 0 (unchanged) ...
})
```

This lets claude-branch tests reuse `mock-agent-pass.js` (commits a
file) and `mock-agent-review.js` (plays ticket, reviewer, fixer).

**Verification:**

```bash
printf 'x' | FAKE_CLAUDE_DELEGATE=test/mock-agent-noop.js \
    test/fake-claude/claude; echo "exit $?"
```
Expected: `exit 0` (`test/mock-agent-noop.js` exists; any mock that
exits 0 on stdin end works).

Run: `npm run lint` -- no errors.

**Commit:** `test: let fake claude delegate to a mock agent`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->
<!-- START_TASK_2 -->
### Task 2: Thread `preferSubagent` through orchestrator and review

**Verifies:** prefer-subagent.AC1.6 (tested in Task 4)

**Files:**
- Modify: `src/orchestrator.ts` (locations in the notes above)
- Modify: `src/review.ts` (locations in the notes above)

**Implementation:**

Add `preferSubagent?:string` with a short comment where the type has
comments (e.g. `// claude only: model for subagents; unset = off`)
to:
- `dryRunIsolated` opts; `dryRun` gets a 4th positional param
  `preferSubagent?:string`.
- `respawnAndRetryMerge` opts.
- `TicketAttemptOpts`.
- In-place `runWaves`: new last positional param
  `preferSubagent?:string` after `concurrency`.
- `runWavesIsolated` opts.
- `src/review.ts`: `SpawnAgentFn` opts and `ReviewPassOpts`.

Pass it on:
- `dryRun`: `renderPrompt(..., { testCmd, preferSubagent })`; after
  the `Test command:` line print
  `console.log(\`Prefer subagent: ${preferSubagent || '(none)'}\`)`.
- `dryRunIsolated`: add `preferSubagent:opts.preferSubagent` to its
  `renderPrompt` opts; after the `Effort:` line print
  `Prefer subagent: ${opts.preferSubagent || '(none)'}`.
- `respawnAndRetryMerge`: `renderMergePrompt(..., { installCmd,
  preferSubagent:opts.preferSubagent })` and
  `preferSubagent:opts.preferSubagent` in its `spawnAgent` call.
- `runTicketAttempt`: `preferSubagent:opts.preferSubagent` in the
  `renderPrompt` opts and in the `spawnAgent` call.
- In-place `runWaves`: `renderPrompt(specBody, t, { testCmd,
  preferSubagent })` and `preferSubagent` in both `spawnAgent` calls.
- `runWavesIsolated`: `preferSubagent:opts.preferSubagent` in the
  `runTicketAttempts`, `respawnAndRetryMerge` and `runReviewPass`
  calls.
- `runReviewer`: `preferSubagent:opts.preferSubagent` in
  `renderReviewPrompt({...})` and in `deps.spawnAgent({...})`.
- `runFixer`: the same with `renderFixPrompt({...})`.

**Verification:** `npm run build` succeeds.

**Commit:** with Task 3.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: CLI flag, warn-and-drop, pass to runners and dry runs

**Verifies:** prefer-subagent.AC1.1, AC1.2, AC1.3, AC1.7 (tested in
Task 4)

**Files:**
- Modify: `src/index.ts` (locations in the notes above)

**Implementation:**

1. yargs option, after `effort`:

```ts
            .option('prefer-subagent', {
                type:'string',
                describe:'claude only: model that subagents ' +
                    'default to (CLAUDE_CODE_SUBAGENT_MODEL), ' +
                    'plus a prompt rule to hand read-only work ' +
                    'to them. "" disables it.',
            })
```

2. Mapping: `preferSubagent:argv.preferSubagent as string|undefined`;
   add `preferSubagent?:string` to the `runExecute` argv type.

3. In `runExecute`, right after `agentCmd` is computed (after the
   preflight), normalise and drop:

```ts
    // claude is the only provider with subagents. Warn once here
    // and drop the value, so no agent gets the env var or the rule.
    let preferSubagent = argv.preferSubagent || undefined
    const providerName = basename(argv.provider)
    if (preferSubagent && providerName !== 'claude') {
        console.warn(
            '--prefer-subagent not supported by ' +
            `${providerName}, skipping`
        )
        preferSubagent = undefined
    }
```

   Add `basename` to the `node:path` import.

4. Pass `preferSubagent` to `dryRunIsolated({...})`, as the 4th arg
   of `dryRun(...)`, to `runWavesIsolated({...})`, and as the new
   last positional arg of `runWaves(...)`.

**Verification:** `npm run build` succeeds.

**Commit:**

```bash
git add src/index.ts src/orchestrator.ts src/review.ts
git commit -m "feat: add --prefer-subagent flag"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: CLI and threading tests

**Verifies:** prefer-subagent.AC1.1, AC1.2, AC1.3, AC1.6, AC1.7

**Files:**
- Modify: `test/integration.test.ts` (CLI subprocess and
  runWavesIsolated integration)
- Modify: `test/review-integration.test.ts` (end-to-end review pass)

**Testing:**

Import `subagentRule` from `../src/rules.js` and compare prompt text
against its output; do not hand-type rule sentences. The dry-run
`Prefer subagent:` line is the CLI's documented output, so asserting
it with `includes` follows the existing dry-run tests (`'Wave 1:'`).
Use `FAKE_CLAUDE = join(process.cwd(), 'test', 'fake-claude',
'claude')` as the claude provider path so the result does not depend
on a real `claude` on PATH.

CLI subprocess cases (`npm run build` first; `spawnCli`):
- AC1.1: in a non-git `tmp()` project (-> `dryRun`) and in a
  `cliGitRepo()` project (-> `dryRunIsolated`), `spawnCli
  ([FAKE_CLAUDE, '--spec', FEAT, '--dry-run', '--prefer-subagent',
  'haiku'])` exits 0, stdout includes `Prefer subagent: haiku` and
  every line of `subagentRule('haiku')` (the printed prompt).
- AC1.2: the same without the flag; stdout includes
  `Prefer subagent: (none)` and none of `subagentRule('haiku')`'s
  lines.
- AC1.3: with provider `codex` and with provider `pi` (bare names;
  in dry-run a missing provider is reported and the run continues),
  `--prefer-subagent haiku` exits 0; stderr contains
  `--prefer-subagent` exactly once
  (`stderr.split('--prefer-subagent').length === 2`); stdout
  includes `Prefer subagent: (none)` and none of the rule lines.
- AC1.7: `--prefer-subagent ''` with `FAKE_CLAUDE` in the same
  project as the AC1.2 run: exit 0 and stdout equal to the AC1.2
  run's stdout (same project, so paths match). With provider
  `codex` and `--prefer-subagent ''`, stderr does not contain
  `--prefer-subagent`.

CLI real-run cases (not dry runs; these prove `src/index.ts`
passes the value to the runners, including the positional in-place
`runWaves`). Pass the env through `spawnCli(..., { cwd, env:{
...process.env, FAKE_CLAUDE_ENV_LOG:<path>, ... } })`:
- AC1.6 in-place: a non-git `tmp()` project with one
  `ready-for-agent` ticket; `spawnCli([FAKE_CLAUDE, '--spec', FEAT,
  '--prefer-subagent', 'haiku', '--test-cmd', ''])` exits 0 and the
  env log's only line parses to `'haiku'`.
- AC1.6 isolated: the same in a `cliGitRepo()` project with
  `--no-review` and `FAKE_CLAUDE_DELEGATE` = `MOCK_PASS` in the env
  (the ticket must commit to succeed). Commit the ticket files with
  `commitAll` first: the CLI refuses a dirty tree before creating
  the integration branch. Exit 0 and the log reads `'haiku'`.
- AC1.7 real run: the in-place case with `--prefer-subagent ''` and
  `CLAUDE_CODE_SUBAGENT_MODEL` removed from the passed env; the log
  reads `null`.

Hermetic repos: every new test that calls `initTempGitRepo()`
creates `const templateDir = mkdtempSync(join(tmpdir(),
'nightralph-tpl-'))`, calls `initTempGitRepo({ templateDir })`, and
runs `rmSync(templateDir, { recursive:true, force:true })` in
`finally` (precedent: `test/integration.test.ts:1023-1024`). A plain
`initTempGitRepo()` picks up the machine's `init.templateDir`, whose
`info/exclude` can be a symlink shared with other repos. Never write
`info/exclude`. `installMergeFailOnceGit(failBranch)` still works,
since the repo name comes from `projectDir`.

Threading cases (no subprocess; real git; set
`FAKE_CLAUDE_ENV_LOG` and restore env in `finally`):
- AC1.6 tickets and merge respawn: copy the respawn test at
  `test/integration.test.ts:2722` (two tickets, `installMergeFailOnceGit`
  on the second branch), but use `agentCmd:FAKE_CLAUDE` with
  `FAKE_CLAUDE_DELEGATE` = `MOCK_PASS` and
  `preferSubagent:'haiku'`. Both tickets end `done`, and the env log
  has exactly 3 lines (ticket 1, ticket 2, the respawn), each
  parsing to `'haiku'`.
- AC1.6 reviewer and fixer: in `test/review-integration.test.ts`,
  extend `withHarness` so `h.run` accepts an optional object of
  extra `runWavesIsolated` opts spread last (e.g. `agentCmd`,
  `preferSubagent`), and add `FAKE_CLAUDE_DELEGATE`,
  `FAKE_CLAUDE_ENV_LOG` and `FAKE_CLAUDE_STREAM` to `ENV_KEYS` (the
  last is used by Phase 5; adding it now means the harness always
  restores it). Run with
  `MOCK_REVIEW:'findings', MOCK_FIX:'pass', MOCK_TICKET:'pass'`,
  `FAKE_CLAUDE_DELEGATE` = the harness's `MOCK`, and extras
  `{ agentCmd:FAKE_CLAUDE, preferSubagent:'haiku' }`.
  `countRoles` is `{ reviewer:1, fixer:1, ticket:1 }` and the env log
  has 3 lines, each `'haiku'`.

Follow project testing patterns. The executor writes the test code.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`
Expected: no errors.

**Commit:** `test: cover --prefer-subagent CLI and threading`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->
