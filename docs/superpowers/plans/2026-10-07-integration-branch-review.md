# Integration Branch and Review Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run launched from the default branch lands its work on an
integration branch, and every isolated run ends with one code review of
the unreviewed work plus one test-gated fix pass.

**Architecture:** The CLI decides policy (whether to create or resume
an integration branch, whether to review) and `runWavesIsolated` acts
on what it is given. The retry loop moves into `src/retry.ts` so
tickets, the reviewer, and the fixer share it. The review lives in a
new `src/review.ts` that imports no values from `src/orchestrator.ts`;
the orchestrator injects `spawnAgent` and its process registry.

**Tech Stack:** TypeScript (Node >= 24, ESM), git CLI via
`node:child_process`, `@substrate-system/tapzero` tests bundled by
esbuild through `scripts/test.sh`.

**Spec:**
`docs/superpowers/specs/2026-10-07-integration-branch-review-design.md`

## Global Constraints

- Branch names: `nightralph--<feature>` for one feature,
  `nightralph--all` otherwise; reviewer `<repo>--review`, fixer
  `<repo>--review-fix`; worktrees `<repo>.review`, `<repo>.review-fix`.
- Findings file inside a worktree: `.nightralph/findings.md`; clean
  marker line: `No findings.`
- Review log: `.scratch/<feature>/review.md` (one feature) or
  `.scratch/review.md` (several).
- Review diff always excludes `.scratch`:
  `git diff <from>..<to> -- . ':(exclude).scratch'`.
- Review statuses: `clean`, `fixed`, `unresolved`, `review-failed`.
- Commit message for the log: `nightralph: record review`.
- `src/review.ts`, `src/retry.ts`, `src/rules.ts` import no values from
  `src/orchestrator.ts` (type-only imports are fine).
- TypeScript style: no space between colon and type
  (`foo:string`), lines at most 80 columns, 4-space indent, no
  semicolons, multi-line ternaries with `?` and `:` at line ends.
- No em dashes or arrow characters in docs or comments; use `--` and
  `->`.
- Tests: no assertions on prose wording; hermetic temp repos; never
  write `.git/info/exclude`.
- Every git-repo test sets its branch name explicitly
  (`git branch -M main`); the machine's `init.defaultBranch` varies.

## Review Focus

- A resumed run whose integration branch already has `done` tickets
  must not re-run them (the CLI re-scans after checkout). Pinned in
  Task 4 (CLI resume test).
- A run that merged nothing but bookkeeping (failed tickets, progress
  commits) must not start a reviewer. Pinned in Task 10 (AC4.4 test).
- A second run with nothing new after a completed review must not
  review again, including the commit that wrote `review.md`. Pinned in
  Task 10 (marker test).
- Reviewer or fixer edits must never reach the integration branch
  except through a green test gate. Pinned in Task 8 (AC5.5) and Task 9
  (red gate test).
- A broken review (unwritable `review.md`, git failure) must not change
  the run's exit status. Pinned in Task 10 (AC7.2 test).

---

## File Structure

- Create `src/retry.ts` -- effort ladders, `escalateEffort`,
  `retryDelayFor`, `sleep`, `runWithRetries`.
- Create `src/rules.ts` -- prompt rule lines shared by the ticket and
  fix prompts.
- Create `src/review.ts` -- review log, findings, prompts, range,
  reviewer, fixer, `runReviewPass`.
- Modify `src/orchestrator.ts` -- re-export moved effort symbols,
  `runTicketAttempts` on `runWithRetries`, `renderPrompt` on
  `rules.ts`, `runWavesIsolated` review option, launch commit, return
  value, summary lines.
- Modify `src/worktree.ts` -- default branch, integration branch
  planning and preparation, named worktrees, branch deletion, small git
  queries.
- Modify `src/learnings.ts` -- `collectNotes` file argument, export
  `formatDate`.
- Modify `src/index.ts` -- ticket loading as a function, integration
  branch, `--no-review`, dry-run lines.
- Tests: create `test/retry.test.ts`, `test/review.test.ts`,
  `test/review-pass.test.ts`, `test/review-integration.test.ts`,
  `test/mock-agent-review.js`; extend `test/worktree.test.ts`,
  `test/learnings.test.ts`, `test/integration.test.ts`; register the
  new suites in `scripts/test.sh`.
- Docs: `AGENTS.md`, `README.md`.

---

### Task 1: Shared retry helper

**Files:**
- Create: `src/retry.ts`
- Modify: `src/orchestrator.ts` (effort block near line 745,
  `retryDelayFor`/`sleep` near line 1632, `TicketOutcome` near line
  1653, `attemptEntry` near line 1999, `runTicketAttempts` near line
  2047)
- Test: `test/retry.test.ts`, `scripts/test.sh`

**Interfaces:**
- Produces (from `src/retry.ts`): `EFFORT_LADDERS`, `ProviderName`,
  `EffortLevel`, `ALL_EFFORT_LEVELS`,
  `escalateEffort(provider:ProviderName, level?:EffortLevel):EffortLevel`,
  `retryDelayFor(base:number, attempt:number):number`,
  `sleep(ms:number):Promise<void>`,
  `type AttemptStep<T> = { result:T; stop:boolean }`,
  `runWithRetries<T>(opts:RetryOpts, run:(attempt:number,
  effort:EffortLevel|undefined) => Promise<AttemptStep<T>>):Promise<T>`
  where `RetryOpts = { maxAttempts:number; retryDelay:number;
  agentCmd:string; effort?:EffortLevel; label:string;
  log:(msg:string) => void; wait?:(ms:number) => Promise<void> }`.
- `src/orchestrator.ts` keeps exporting the moved names unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/retry.test.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    runWithRetries,
    type EffortLevel,
} from '../src/retry.js'

function noLog ():void {}

test('runWithRetries - stops at the first step that says stop',
    async t => {
        let calls = 0
        const result = await runWithRetries({
            maxAttempts:4,
            retryDelay:0,
            agentCmd:'claude',
            label:'x',
            log:noLog,
        }, async attempt => {
            calls++
            return { result:attempt, stop:true }
        })
        t.equal(calls, 1, 'ran once')
        t.equal(result, 1, 'returns that step\'s result')
    })

test('runWithRetries - runs maxAttempts and returns the last result',
    async t => {
        const seen:number[] = []
        const result = await runWithRetries({
            maxAttempts:3,
            retryDelay:0,
            agentCmd:'claude',
            label:'x',
            log:noLog,
        }, async attempt => {
            seen.push(attempt)
            return { result:`attempt ${attempt}`, stop:false }
        })
        t.deepEqual(seen, [1, 2, 3], 'attempts in order')
        t.equal(result, 'attempt 3', 'last result')
    })

test('runWithRetries - escalates effort for a known provider',
    async t => {
        const efforts:Array<EffortLevel|undefined> = []
        await runWithRetries({
            maxAttempts:3,
            retryDelay:0,
            agentCmd:'/usr/local/bin/claude',
            label:'x',
            log:noLog,
        }, async (_attempt, effort) => {
            efforts.push(effort)
            return { result:null, stop:false }
        })
        t.deepEqual(efforts, [undefined, 'high', 'xhigh'],
            'undefined, then high, then one rung up')
    })

test('runWithRetries - keeps effort for an unknown provider',
    async t => {
        const efforts:Array<EffortLevel|undefined> = []
        await runWithRetries({
            maxAttempts:2,
            retryDelay:0,
            agentCmd:'node',
            effort:'low',
            label:'x',
            log:noLog,
        }, async (_attempt, effort) => {
            efforts.push(effort)
            return { result:null, stop:false }
        })
        t.deepEqual(efforts, ['low', 'low'], 'unchanged')
    })

test('runWithRetries - waits with exponential backoff', async t => {
    const waits:number[] = []
    await runWithRetries({
        maxAttempts:3,
        retryDelay:30,
        agentCmd:'node',
        label:'x',
        log:noLog,
        wait:async ms => { waits.push(ms) },
    }, async () => ({ result:null, stop:false }))
    t.deepEqual(waits, [30_000, 60_000], 'base, then double')
})

test('runWithRetries - maxAttempts below 1 still runs once',
    async t => {
        let calls = 0
        await runWithRetries({
            maxAttempts:0,
            retryDelay:0,
            agentCmd:'node',
            label:'x',
            log:noLog,
        }, async () => {
            calls++
            return { result:null, stop:false }
        })
        t.equal(calls, 1, 'one attempt')
    })
```

Add `retry` to the `TESTS` array in `scripts/test.sh`, right after
`orchestrator`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: esbuild fails with `Could not resolve "../src/retry.js"`.

- [ ] **Step 3: Create `src/retry.ts`**

Move the effort block (the `// Per-provider effort ladders.` comment
through the end of `escalateEffort`), `retryDelayFor`, and `sleep` out
of `src/orchestrator.ts` into the new file verbatim, then add
`runWithRetries`:

```ts
import { basename } from 'node:path'

// Per-provider effort ladders.
export const EFFORT_LADDERS = {
    pi:['off', 'minimal', 'low', 'medium',
        'high', 'xhigh', 'max'],
    claude:['low', 'medium', 'high',
        'xhigh', 'max'],
    codex:['low', 'medium', 'high'],
} as const

export type ProviderName =
    keyof typeof EFFORT_LADDERS

export type EffortLevel =
    typeof EFFORT_LADDERS[ProviderName][number]

export const ALL_EFFORT_LEVELS:EffortLevel[] = [
    'off', 'minimal', 'low', 'medium',
    'high', 'xhigh', 'max',
]

// Step up the effort ladder for a given provider.
// Without a starting level, the first retry jumps to high.
// Otherwise, step one rung up and stop at the provider's max.
export function escalateEffort (
    provider:ProviderName,
    level?:EffortLevel
):EffortLevel {
    if (!level) return 'high'
    const ladder = EFFORT_LADDERS[provider]
    const i = (ladder as readonly string[])
        .indexOf(level)
    if (i === -1) return level
    return ladder[
        Math.min(i + 1, ladder.length - 1)
    ] as EffortLevel
}

export function retryDelayFor (base:number, attempt:number):number {
    return base * 2 ** (attempt - 2)
}

export function sleep (ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export type AttemptStep<T> = { result:T; stop:boolean }

export type RetryOpts = {
    maxAttempts:number
    // seconds before the first retry; doubles each further retry
    retryDelay:number
    agentCmd:string
    // starting effort level; unset = provider's default
    effort?:EffortLevel
    // names the work in log lines, e.g. a ticket filename
    label:string
    log:(msg:string) => void
    // test seam; defaults to sleep
    wait?:(ms:number) => Promise<void>
}

// Runs `run` until a step says stop or the attempt cap is hit,
// escalating effort for known providers and backing off
// exponentially between attempts. Returns the last step's result.
export async function runWithRetries<T> (
    opts:RetryOpts,
    run:(
        attempt:number,
        effort:EffortLevel|undefined
    ) => Promise<AttemptStep<T>>
):Promise<T> {
    const maxAttempts = Math.max(1, opts.maxAttempts)
    const providerName = basename(opts.agentCmd)
    const isKnown = providerName in EFFORT_LADDERS
    const wait = opts.wait ?? sleep
    let effort = opts.effort

    for (let attempt = 1; ; attempt++) {
        if (attempt === 1) {
            opts.log(`  Starting ${opts.label}`)
        } else {
            if (isKnown) {
                effort = escalateEffort(
                    providerName as ProviderName,
                    effort
                )
            }
            const delay = retryDelayFor(opts.retryDelay, attempt)
            opts.log(
                `  ${opts.label}: retrying ` +
                `(attempt ${attempt}/${maxAttempts}` +
                (isKnown && effort ?
                    `, effort ${effort}` : '') +
                (delay > 0 ?
                    `, waiting ${delay}s` : '') +
                ')'
            )
            if (delay > 0) await wait(delay * 1000)
        }
        const step = await run(attempt, effort)
        if (step.stop || attempt >= maxAttempts) return step.result
    }
}
```

- [ ] **Step 4: Run the new tests**

Run: `npm test`
Expected: `retry` suite passes; build may still fail in
`orchestrator.ts` until Step 5 if you removed definitions there.

- [ ] **Step 5: Point the orchestrator at `retry.ts`**

In `src/orchestrator.ts`, delete the moved definitions and add, next to
the other imports:

```ts
import {
    EFFORT_LADDERS,
    escalateEffort,
    retryDelayFor,
    runWithRetries,
    sleep,
    type EffortLevel,
    type ProviderName,
} from './retry.js'

export {
    EFFORT_LADDERS,
    ALL_EFFORT_LEVELS,
    escalateEffort,
    retryDelayFor,
    type EffortLevel,
    type ProviderName,
} from './retry.js'
```

Drop any of `EFFORT_LADDERS`, `escalateEffort`, `retryDelayFor`,
`sleep`, `ProviderName` from the import that `tsc`/eslint report as
unused after Step 6 (the in-place `runWaves` still uses some of them).

- [ ] **Step 6: Rewrite `runTicketAttempts` on the helper**

Replace the body of `runTicketAttempts` with:

```ts
async function runTicketAttempts (
    opts:TicketAttemptOpts&{ retries:number; retryDelay:number }
):Promise<TicketOutcome> {
    const { ticket, d } = opts
    return runWithRetries({
        maxAttempts:opts.retries + 1,
        retryDelay:opts.retryDelay,
        agentCmd:opts.agentCmd,
        effort:opts.effort,
        label:ticket.filename,
        log:(msg) => d.log(msg),
    }, async (attempt, effort) => {
        const record = (o:TicketOutcome):void => {
            recordAttempt({
                learningsPath:opts.learningsPath,
                logsDir:opts.logsDir,
                ticket,
                attempt,
                effort,
                outcome:o,
                d,
            })
        }
        let outcome:TicketOutcome
        try {
            outcome = await runTicketAttempt({
                ...opts, attempt, effort,
            })
        } catch (error) {
            d.log(
                `  ${ticket.filename}: attempt ${attempt} ` +
                `threw: ${formatErrorMessage(error)}`
            )
            const errorOutcome:TicketOutcome = { kind:'error', error }
            record(errorOutcome)
            return { result:errorOutcome, stop:true }
        }
        record(outcome)
        if (outcome.kind === 'ready') {
            // The agent is no longer running, but the branch is
            // only merged once the whole wave has finished.
            d.setTicketStatus(
                ticket.num, 'awaiting-merge',
                ticket.feature,
            )
            return { result:outcome, stop:true }
        }
        return {
            result:outcome,
            stop:outcome.kind === 'worktree-error',
        }
    })
}
```

The placeholder outcome is gone, so narrow the type: in
`TicketOutcome`'s `'no-commits'` variant replace

```ts
        // null only for the placeholder outcome in
        // runTicketAttempts, which no agent produced
        agentRun:AgentRunRecord|null
```

with `        agentRun:AgentRunRecord`, and in `attemptEntry` delete the
line `            if (!outcome.agentRun) return null` under
`case 'no-commits':`.

- [ ] **Step 7: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: everything passes with no edits to existing tests (AC7.4).

- [ ] **Step 8: Commit**

```bash
git add src/retry.ts src/orchestrator.ts test/retry.test.ts \
    scripts/test.sh
git commit -m "refactor(retry): share the attempt loop via runWithRetries"
```

---

### Task 2: Branch planning

**Files:**
- Modify: `src/worktree.ts`
- Test: `test/worktree.test.ts`

**Interfaces:**
- Produces: `integrationBranchName(features:ReadonlyArray<string>):
  string`, `planIntegrationBranch(current:string,
  defaultBranch:string|null, features:ReadonlyArray<string>):
  string|null`, `getDefaultBranch(repoRoot:string):string|null`,
  `localBranchExists(repoRoot:string, name:string):boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worktree.test.ts` (add the new names to the existing
import from `../src/worktree.js`):

```ts
// -- integration branch planning --

test('integrationBranchName - one feature, several, none', t => {
    t.equal(integrationBranchName(['auth']), 'nightralph--auth',
        'one feature')
    t.equal(integrationBranchName(['auth', 'auth']),
        'nightralph--auth', 'duplicates count once')
    t.equal(integrationBranchName(['auth', 'billing']),
        'nightralph--all', 'several features')
    t.equal(integrationBranchName([]), 'nightralph--all', 'none')
    t.equal(integrationBranchName(['']), 'nightralph--all',
        'an empty feature name counts as none')
})

test('planIntegrationBranch - only on the default branch', t => {
    t.equal(planIntegrationBranch('main', 'main', ['auth']),
        'nightralph--auth', 'on the default branch')
    t.equal(planIntegrationBranch('my-work', 'main', ['auth']),
        null, 'on another branch')
    t.equal(planIntegrationBranch('main', null, ['auth']),
        null, 'default branch unknown')
    t.equal(planIntegrationBranch('HEAD', 'HEAD', ['auth']),
        null, 'detached HEAD')
})

test('getDefaultBranch - reads origin/HEAD', t => {
    const dir = initTempRepo()
    execSync('git branch -M main', { cwd:dir })
    execSync('git update-ref refs/remotes/origin/trunk HEAD',
        { cwd:dir })
    execSync(
        'git symbolic-ref refs/remotes/origin/HEAD ' +
        'refs/remotes/origin/trunk',
        { cwd:dir }
    )
    t.equal(getDefaultBranch(dir), 'trunk',
        'origin/HEAD wins over a local main')
})

test('getDefaultBranch - falls back to main, master, or null', t => {
    const dir = initTempRepo()
    execSync('git branch -M main', { cwd:dir })
    t.equal(getDefaultBranch(dir), 'main', 'local main')
    execSync('git branch -M master', { cwd:dir })
    t.equal(getDefaultBranch(dir), 'master', 'local master')
    execSync('git branch -M trunk', { cwd:dir })
    t.equal(getDefaultBranch(dir), null, 'neither exists')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild reports `No matching export` for the new names.

- [ ] **Step 3: Implement in `src/worktree.ts`**

Add after `getCurrentBranch`:

```ts
export function localBranchExists (
    repoRoot:string,
    name:string
):boolean {
    try {
        execFileSync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${name}`],
            { cwd:repoRoot, stdio:'ignore' }
        )
        return true
    } catch {
        return false
    }
}

// The repo's default branch: what origin/HEAD points at, else a
// local main or master, else null.
export function getDefaultBranch (repoRoot:string):string|null {
    try {
        const ref = execFileSync(
            'git',
            [
                'symbolic-ref', '--quiet', '--short',
                'refs/remotes/origin/HEAD',
            ],
            {
                cwd:repoRoot,
                encoding:'utf8',
                stdio:['ignore', 'pipe', 'ignore'],
            }
        ).trim()
        if (ref) return ref.replace(/^origin\//, '')
    } catch {
        // no origin/HEAD
    }
    for (const name of ['main', 'master']) {
        if (localBranchExists(repoRoot, name)) return name
    }
    return null
}

// Uses `--` rather than `/` for the same reason as
// buildBranchName: refs/heads/X/Y cannot coexist with
// refs/heads/X.
export function integrationBranchName (
    features:ReadonlyArray<string>
):string {
    const distinct = [...new Set(features.filter(Boolean))]
    return distinct.length === 1 ?
        `nightralph--${distinct[0]}` :
        'nightralph--all'
}

// The integration branch to use, or null to merge into the
// current branch as before. Only a run launched from the default
// branch gets one.
export function planIntegrationBranch (
    current:string,
    defaultBranch:string|null,
    features:ReadonlyArray<string>
):string|null {
    if (!defaultBranch || current === 'HEAD') return null
    if (current !== defaultBranch) return null
    return integrationBranchName(features)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat(worktree): plan an integration branch"
```

---

### Task 3: Preparing the branch, named worktrees, git queries

**Files:**
- Modify: `src/worktree.ts`
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: Task 2's `getDefaultBranch`, `planIntegrationBranch`,
  `integrationBranchName`, `localBranchExists`.
- Produces:
  - `getCurrentBranch(cwd?:string):string` (new optional `cwd`).
  - `type IntegrationPlan = { branch:string; created:boolean;
    resumed:boolean; behind:number; launchBranch:string;
    forkedFrom:string|null }`.
  - `prepareIntegrationBranch(repoRoot:string,
    features:ReadonlyArray<string>):IntegrationPlan`.
  - `describeIntegrationBranch(repoRoot:string,
    features:ReadonlyArray<string>):string`.
  - `createNamedWorktree(opts:{ repoRoot:string; repoName:string;
    baseBranch:string; name:string }):Promise<{ worktreePath:string;
    branchName:string }>`.
  - `deleteBranch(repoRoot:string, name:string):Promise<void>`.
  - `headCommit(cwd:string):string`,
    `mergeBase(cwd:string, a:string, b:string):string|null`,
    `isAncestor(cwd:string, ancestor:string, of:string):boolean`,
    `hasChangesOutside(cwd:string, from:string, to:string,
    excludeDir:string):boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worktree.test.ts` (extend the imports; also import
`scanTickets` from `../src/orchestrator.js` and `mkdirSync`,
`readFileSync` from `node:fs`):

```ts
// -- prepareIntegrationBranch --

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Test',
    GIT_COMMITTER_EMAIL:'test@example.com',
    GIT_AUTHOR_NAME:'Test',
    GIT_AUTHOR_EMAIL:'test@example.com',
}

function git (dir:string, cmd:string):string {
    return execSync(`git ${cmd}`, {
        cwd:dir, env:GIT_ENV, encoding:'utf8',
    }).trim()
}

function commitFile (dir:string, path:string, body:string):void {
    mkdirSync(join(dir, path, '..'), { recursive:true })
    writeFileSync(join(dir, path), body)
    git(dir, `add ${path}`)
    git(dir, `commit -m "add ${path}" --no-verify`)
}

function ticketBody (status:string):string {
    return `# Ticket\n\n**Status:** ${status}\n`
}

test('prepareIntegrationBranch - AC2.1 creates and checks out ' +
    'the branch from the default branch', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    const mainBefore = git(dir, 'rev-parse main')

    const plan = prepareIntegrationBranch(dir, ['auth'])

    t.equal(plan.branch, 'nightralph--auth', 'names the branch')
    t.ok(plan.created, 'created')
    t.ok(!plan.resumed, 'not resumed')
    t.equal(plan.launchBranch, 'main', 'launched from main')
    t.equal(plan.forkedFrom, 'main', 'forked from main')
    t.equal(getCurrentBranch(dir), 'nightralph--auth',
        'checked out')
    t.equal(git(dir, 'rev-parse main'), mainBefore,
        'main did not move')
})

test('prepareIntegrationBranch - AC2.2 resumes an existing ' +
    'branch and keeps its ticket statuses', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    const ticket = '.scratch/auth/issues/01-login.md'
    commitFile(dir, ticket, ticketBody('ready-for-agent'))
    git(dir, 'checkout -b nightralph--auth')
    writeFileSync(join(dir, ticket), ticketBody('done'))
    git(dir, `commit -am "done" --no-verify`)
    git(dir, 'checkout main')
    commitFile(dir, 'README.md', 'moved on')

    const plan = prepareIntegrationBranch(dir, ['auth'])

    t.ok(plan.resumed, 'resumed')
    t.ok(!plan.created, 'not created')
    t.equal(plan.behind, 1, 'main is one commit ahead')
    t.equal(getCurrentBranch(dir), 'nightralph--auth',
        'checked out')
    const tickets = scanTickets(
        join(dir, '.scratch', 'auth', 'issues'), 'auth'
    )
    t.equal(tickets[0].status, 'done',
        'a scan after preparing sees the branch\'s status')
})

test('prepareIntegrationBranch - AC2.3 leaves another branch ' +
    'alone', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    git(dir, 'checkout -b my-work')

    const plan = prepareIntegrationBranch(dir, ['auth'])

    t.equal(plan.branch, 'my-work', 'merges into the current branch')
    t.ok(!plan.created && !plan.resumed, 'nothing checked out')
    t.equal(plan.forkedFrom, null, 'not an integration branch')
    t.ok(!localBranchExists(dir, 'nightralph--auth'),
        'no integration branch created')
})

test('prepareIntegrationBranch - a hand-resumed integration ' +
    'branch reports its fork point', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    git(dir, 'checkout -b nightralph--auth')

    const plan = prepareIntegrationBranch(dir, ['auth'])

    t.equal(plan.branch, 'nightralph--auth', 'stays put')
    t.equal(plan.forkedFrom, 'main', 'knows it came from main')
})

test('prepareIntegrationBranch - AC2.5 a dirty tree throws ' +
    'before any branch exists', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    writeFileSync(join(dir, 'stray.txt'), 'dirty')

    t.throws(() => prepareIntegrationBranch(dir, ['auth']),
        'throws on a dirty tree')
    t.ok(!localBranchExists(dir, 'nightralph--auth'),
        'no branch created')
    t.equal(getCurrentBranch(dir), 'main', 'still on main')
})

test('describeIntegrationBranch - checks nothing out', t => {
    const dir = initTempRepo()
    git(dir, 'branch -M main')
    const line = describeIntegrationBranch(dir, ['auth'])
    t.ok(line.includes('nightralph--auth'), 'names the branch')
    t.equal(getCurrentBranch(dir), 'main', 'still on main')
    t.ok(!localBranchExists(dir, 'nightralph--auth'),
        'creates nothing')
})

// -- named worktrees and git queries --

test('createNamedWorktree - creates, replaces a stale one, and ' +
    'deleteBranch removes the branch', async t => {
    const dir = realpathSync(initTempRepo())
    git(dir, 'branch -M main')
    const repoName = basename(dir)

    const first = await createNamedWorktree({
        repoRoot:dir, repoName, baseBranch:'main', name:'review',
    })
    t.equal(first.branchName, `${repoName}--review`, 'branch name')
    t.ok(existsSync(first.worktreePath), 'worktree exists')

    const second = await createNamedWorktree({
        repoRoot:dir, repoName, baseBranch:'main', name:'review',
    })
    t.equal(second.worktreePath, first.worktreePath,
        'same path, stale one replaced')

    await removeWorktree(second.worktreePath, { force:true })
    await deleteBranch(dir, second.branchName)
    t.ok(!localBranchExists(dir, second.branchName),
        'branch deleted')
    await deleteBranch(dir, second.branchName)
    t.ok(true, 'deleting a missing branch does not throw')
})

test('git queries - ancestry, merge-base, changes outside a dir',
    t => {
        const dir = initTempRepo()
        git(dir, 'branch -M main')
        const base = headCommit(dir)
        commitFile(dir, '.scratch/auth/progress.md', 'progress')
        const afterBookkeeping = headCommit(dir)
        t.ok(!hasChangesOutside(dir, base, afterBookkeeping, '.scratch'),
            'bookkeeping only')
        commitFile(dir, 'src/a.ts', 'code')
        const tip = headCommit(dir)
        t.ok(hasChangesOutside(dir, base, tip, '.scratch'),
            'code change')
        t.ok(isAncestor(dir, base, tip), 'base is an ancestor')
        t.ok(!isAncestor(dir, tip, base), 'tip is not')
        t.ok(!isAncestor(dir, 'deadbeef', tip),
            'an unknown commit is not an ancestor')
        git(dir, `checkout -b side ${base}`)
        commitFile(dir, 'side.txt', 'side')
        t.equal(mergeBase(dir, 'main', 'side'), base, 'merge-base')
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild reports `No matching export` for the new names.

- [ ] **Step 3: Implement in `src/worktree.ts`**

Give `getCurrentBranch` an optional `cwd`:

```ts
export function getCurrentBranch (cwd?:string):string {
    const stdout = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd, encoding:'utf8' }
    )
    return stdout.trim()
}
```

Add the integration branch functions after `planIntegrationBranch`:

```ts
export type IntegrationPlan = {
    // where this run's work lands
    branch:string
    created:boolean
    resumed:boolean
    // commits on the launch branch that `branch` lacks
    behind:number
    launchBranch:string
    // the default branch when `branch` is an integration branch,
    // else null; the review falls back to its merge-base
    forkedFrom:string|null
}

function gitText (cwd:string, args:string[]):string {
    return execFileSync('git', args, { cwd, encoding:'utf8' }).trim()
}

// Enters the integration branch when the run was launched from
// the default branch, creating it or resuming it. Callers must
// scan tickets after this, since ticket statuses live on the
// branch it checks out.
export function prepareIntegrationBranch (
    repoRoot:string,
    features:ReadonlyArray<string>
):IntegrationPlan {
    const current = getCurrentBranch(repoRoot)
    const defaultBranch = getDefaultBranch(repoRoot)
    const name = planIntegrationBranch(
        current, defaultBranch, features
    )
    if (!name) {
        const onIntegration = defaultBranch !== null &&
            current === integrationBranchName(features)
        return {
            branch:current,
            created:false,
            resumed:false,
            behind:0,
            launchBranch:current,
            forkedFrom:onIntegration ? defaultBranch : null,
        }
    }
    if (isDirty(repoRoot)) {
        throw new Error(
            'Working tree is dirty; commit or stash ' +
            'changes before running'
        )
    }
    if (localBranchExists(repoRoot, name)) {
        gitText(repoRoot, ['checkout', '--quiet', name])
        const behind = Number(gitText(
            repoRoot, ['rev-list', '--count', `${name}..${current}`]
        ))
        return {
            branch:name,
            created:false,
            resumed:true,
            behind,
            launchBranch:current,
            forkedFrom:defaultBranch,
        }
    }
    gitText(repoRoot, ['checkout', '--quiet', '-b', name])
    return {
        branch:name,
        created:true,
        resumed:false,
        behind:0,
        launchBranch:current,
        forkedFrom:defaultBranch,
    }
}

// What prepareIntegrationBranch would do, for --dry-run.
export function describeIntegrationBranch (
    repoRoot:string,
    features:ReadonlyArray<string>
):string {
    const current = getCurrentBranch(repoRoot)
    const name = planIntegrationBranch(
        current, getDefaultBranch(repoRoot), features
    )
    if (!name) return `Branch:       merges into ${current}`
    return localBranchExists(repoRoot, name) ?
        `Branch:       would resume ${name}` :
        `Branch:       would create ${name} from ${current}`
}
```

`isDirty` is defined further down the file; function declarations are
hoisted, so the order is fine.

Refactor worktree creation so tickets and named worktrees share the
stale-cleanup path and the queue. Replace `createWorktreeNow`,
`worktreeQueue`, `createWorktree`, and the body of `removeWorktree`
with:

```ts
// Creates a worktree on a fresh branch, first clearing any stale
// worktree at the path and any leftover branch of the same name,
// so re-running after a failed run is safe.
async function addWorktreeNow (opts:{
    repoRoot:string
    baseBranch:string
    branchName:string
    worktreePath:string
}):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, baseBranch, branchName, worktreePath } = opts

    if (existsSync(worktreePath)) {
        try {
            await execFileAsync(
                'git',
                ['worktree', 'remove', '--force', worktreePath],
                { cwd:repoRoot }
            )
        } catch {
            // directory may not be a registered worktree anymore;
            // prune stale entries below and let worktree add fail
            // loudly if the path is still unusable
        }
    }

    try {
        await execFileAsync(
            'git',
            ['worktree', 'prune'],
            { cwd:repoRoot }
        )
    } catch {
        // best-effort cleanup of stale worktree metadata
    }

    if (await branchExists(repoRoot, branchName)) {
        await execFileAsync(
            'git',
            ['branch', '-D', branchName],
            { cwd:repoRoot }
        )
    }

    await execFileAsync(
        'git',
        [
            'worktree',
            'add',
            '-b',
            branchName,
            worktreePath,
            baseBranch,
        ],
        { cwd:repoRoot }
    )

    return { worktreePath, branchName }
}

let worktreeQueue:Promise<unknown> = Promise.resolve()

// Serializes every worktree and branch mutation module-wide, so
// concurrent calls cannot race on shared git refs or on
// .git/worktrees metadata.
function enqueue<T> (fn:() => Promise<T>):Promise<T> {
    const result = worktreeQueue.then(fn)
    worktreeQueue = result.catch(() => {})
    return result
}

export function createWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, ticket } = opts
    const num = String(ticket.num).padStart(2, '0')
    const prefix = ticket.feature ?
        `${ticket.feature}-` :
        ''
    return enqueue(() => addWorktreeNow({
        repoRoot,
        baseBranch:opts.baseBranch,
        branchName:buildBranchName(repoName, ticket),
        worktreePath:join(
            repoRoot,
            '..',
            `${repoName}.${prefix}${num}-${ticket.slug}`
        ),
    }))
}

// A worktree that belongs to no ticket, e.g. the review pass:
// `<repo>.<name>` on branch `<repo>--<name>`. Ticket branches
// always carry a number, so the names cannot collide.
export function createNamedWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        name:string
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, name } = opts
    return enqueue(() => addWorktreeNow({
        repoRoot,
        baseBranch:opts.baseBranch,
        branchName:`${repoName}--${name}`,
        worktreePath:join(repoRoot, '..', `${repoName}.${name}`),
    }))
}

export function removeWorktree (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    return enqueue(() => removeWorktreeNow(worktreePath, opts))
}

// Deletes a local branch; a missing branch is not an error.
export function deleteBranch (
    repoRoot:string,
    name:string
):Promise<void> {
    return enqueue(async () => {
        if (!(await branchExists(repoRoot, name))) return
        await execFileAsync(
            'git', ['branch', '-D', name], { cwd:repoRoot }
        )
    })
}
```

Add the git queries after `hasNewCommits`:

```ts
export function headCommit (cwd:string):string {
    return gitText(cwd, ['rev-parse', 'HEAD'])
}

export function mergeBase (
    cwd:string,
    a:string,
    b:string
):string|null {
    try {
        return gitText(cwd, ['merge-base', a, b]) || null
    } catch {
        return null
    }
}

// False when `ancestor` is not an ancestor of `of`, or is not a
// commit this repo knows.
export function isAncestor (
    cwd:string,
    ancestor:string,
    of:string
):boolean {
    try {
        execFileSync(
            'git',
            ['merge-base', '--is-ancestor', ancestor, of],
            { cwd, stdio:'ignore' }
        )
        return true
    } catch {
        return false
    }
}

// True when from..to changes any path outside `excludeDir`.
export function hasChangesOutside (
    cwd:string,
    from:string,
    to:string,
    excludeDir:string
):boolean {
    try {
        execFileSync(
            'git',
            [
                'diff', '--quiet', `${from}..${to}`,
                '--', '.', `:(exclude)${excludeDir}`,
            ],
            { cwd, stdio:'ignore' }
        )
        return false
    } catch {
        return true
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS, including every existing worktree and integration test.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat(worktree): prepare an integration branch, named worktrees"
```

---

### Task 4: CLI wiring for the integration branch

**Files:**
- Modify: `src/index.ts` (`runExecute`, around lines 236-407)
- Modify: `src/orchestrator.ts` (`runWavesIsolated` start and end)
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `prepareIntegrationBranch`, `describeIntegrationBranch`,
  `IntegrationPlan`, `headCommit` (Task 3).
- Produces: `runWavesIsolated(...)` returns
  `Promise<{ allDone:boolean; branch:string }>`; in `src/index.ts` a
  local `loadTickets(selections, log)` returning `LoadedTickets =
  { allTickets:Ticket[]; specBodies:Map<string, string>;
  progressPaths:Map<string, string>; issuesDirs:string[];
  firstFeatureName:string; firstLogsDir:string }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration.test.ts`, near the other CLI subprocess
tests (`spawnCli`, `scratchDirs`, `FEAT`, `MOCK_NOTES`,
`initTempGitRepo`, `commitAll`, `gitOut`, `readNotesRecords`,
`restoreEnv`, `removeWorktreesAndRepo` all exist in the file):

```ts
// A git repo on `main` with the scratch layout and its logs
// ignored, ready for CLI runs that use worktrees.
function cliGitRepo ():{
    projectDir:string
    issuesDir:string
    templateDir:string
} {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const projectDir = initTempGitRepo({ templateDir })
    execSync('git branch -M main', { cwd:projectDir })
    writeFileSync(
        join(projectDir, '.gitignore'), '.scratch/*/logs/\n'
    )
    const { issuesDir } = scratchDirs(projectDir)
    return { projectDir, issuesDir, templateDir }
}

test('CLI subprocess - AC2.1 a run from main lands on the ' +
    'integration branch', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writeFileSync(
            join(issuesDir, '01-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const mainBefore = gitOut(projectDir, ['rev-parse', 'main'])

        const { code } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--timeout', '10',
            '--retry-delay', '0',
            '--test-cmd', 'true',
            '--no-review',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(
            gitOut(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
                .trim(),
            `nightralph--${FEAT}`,
            'left on the integration branch'
        )
        t.equal(gitOut(projectDir, ['rev-parse', 'main']), mainBefore,
            'main did not move')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.2 a run from main resumes the ' +
    'integration branch without redoing done tickets', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    try {
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        execSync(`git checkout -b nightralph--${FEAT}`,
            { cwd:projectDir })
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'done' })
        )
        commitAll(projectDir, 'first is done')
        execSync('git checkout main', { cwd:projectDir })

        const { code } = await spawnCli([
            MOCK_NOTES,
            '--spec', FEAT,
            '--timeout', '10',
            '--retry-delay', '0',
            '--test-cmd', 'true',
            '--no-review',
        ], {
            cwd:projectDir,
            env:{
                ...process.env,
                MOCK_RECORD_DIR:recordDir,
                MOCK_MODE:'pass',
            },
        })

        t.equal(code, 0, 'exit 0')
        const records = readNotesRecords(recordDir)
        t.equal(records.length, 1, 'only one agent ran')
        t.ok(records[0].prompt.includes('02-second.md'),
            'it ran the ticket that was not done')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(recordDir, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
})
```

`spawnCli` (around line 211) takes `opts?:{ cwd?:string }` and calls
`execFile` with `{ timeout:30_000, cwd:opts?.cwd }`. Extend it to
`opts?:{ cwd?:string; env?:NodeJS.ProcessEnv }` and pass
`env:opts?.env` in those `execFile` options (undefined keeps today's
inherited environment). `MOCK_AGENT` is the existing passing mock used
by the "exits 0 when all tickets complete" test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. The first test sees `main` checked out (and yargs
rejects `--no-review` under `.strict()` until Task 10 adds the option,
so add the option now, see Step 3).

- [ ] **Step 3: Implement the CLI changes in `src/index.ts`**

Add the `review` option to the yargs builder after `concurrency`, and
pass it through (the review itself is wired in Task 10):

```ts
            .option('review', {
                type:'boolean',
                default:true,
                describe:'Review the merged work and run one ' +
                    'fix pass at the end. --no-review skips it.',
            }),
```

and in the handler: `review:argv.review as boolean|undefined,`; add
`review?:boolean` to `runExecute`'s argument type.

Move the ticket-scanning loop of `runExecute` into a function above
it:

```ts
type LoadedTickets = {
    allTickets:Ticket[]
    specBodies:Map<string, string>
    progressPaths:Map<string, string>
    issuesDirs:string[]
    firstFeatureName:string
    firstLogsDir:string
}

// Scans every selected feature's tickets from the working tree.
// `log` is a no-op for the silent re-scan after resuming an
// integration branch.
function loadTickets (
    selections:FeatureSelection[],
    log:(msg:string) => void
):LoadedTickets {
```

Its body is the existing loop, unchanged except: `console.log(...)`
and `console.warn(...)` become `log(...)`, it pushes `dir` onto
`issuesDirs` next to `progressPaths.set(...)`, and it returns the
`LoadedTickets` object. Import `type FeatureSelection` from
`./resolve.js`.

Then the top of `runExecute` becomes:

```ts
    const selections = await resolveIssuesDir(
        argv.spec
    )

    let loaded = loadTickets(selections, console.log)
    if (loaded.allTickets.length === 0) return

    const isolated = isGitRepo()
    const featureNames = [...loaded.specBodies.keys()]
    let plan:IntegrationPlan|null = null
    if (isolated && !argv.dryRun) {
        try {
            plan = prepareIntegrationBranch(
                getRepoRoot(), featureNames
            )
        } catch (err) {
            console.error(
                err instanceof Error ? err.message : String(err)
            )
            process.exit(2)
        }
        if (plan.created) {
            console.log(
                `Created branch ${plan.branch} ` +
                `from ${plan.launchBranch}`
            )
        } else if (plan.resumed) {
            console.log(
                `Resumed ${plan.branch}` +
                (plan.behind > 0 ?
                    ` (${plan.launchBranch} is ${plan.behind} ` +
                    `commit${plan.behind === 1 ? '' : 's'} ahead)` :
                    '')
            )
            // Ticket statuses live on the branch just checked out
            loaded = loadTickets(selections, () => {})
        }
    }

    const {
        allTickets, specBodies, progressPaths,
        firstFeatureName, firstLogsDir,
    } = loaded
```

Replace later uses of `isGitRepo()` inside `runExecute` with
`isolated`. In the dry-run branch, after `dryRunIsolated(...)`, print:

```ts
            console.log(
                describeIntegrationBranch(
                    getRepoRoot(), featureNames
                )
            )
            console.log(
                `Review:       ${argv.review === false ? 'off' : 'on'}`
            )
```

Change `let result:{ allDone:boolean }` to
`let result:{ allDone:boolean; branch?:string }`. Import
`prepareIntegrationBranch`, `describeIntegrationBranch`, and
`type IntegrationPlan` from `./worktree.js`.

- [ ] **Step 4: Return the branch from `runWavesIsolated`**

In `src/orchestrator.ts`, change the return type of `runWavesIsolated`
to `Promise<{ allDone:boolean; branch:string }>`, record the launch
commit right after the dirty-tree check (Task 10 uses it; import
`headCommit` from `./worktree.js`):

```ts
    // The review falls back to this when no earlier review or
    // fork point applies
    const launchCommit = headCommit(repoRoot)
```

and end the function with:

```ts
    d.log('\n' + renderFinishSummary(
        opts.tickets, totalCompleted, failedKeys
    ))
    d.log(`Work is on ${baseBranch}`)
    d.cleanup()

    return { allDone:remaining.length === 0, branch:baseBranch }
```

Until Task 10, prefix the unused variable as `void launchCommit` only
if lint complains; otherwise leave it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS, including the existing dry-run CLI tests.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/orchestrator.ts test/integration.test.ts
git commit -m "feat(cli): land runs from the default branch on an integration branch"
```

---

### Task 5: Shared prompt rules and `collectNotes` file argument

**Files:**
- Create: `src/rules.ts`
- Modify: `src/orchestrator.ts` (`installRule`, `renderPrompt`,
  `renderMergePrompt`), `src/learnings.ts` (`collectNotes`,
  `formatDate`)
- Test: `test/learnings.test.ts`

**Interfaces:**
- Produces (from `src/rules.ts`): `readDocsRule(subject:string):string`,
  `installRule(installCmd?:string):string[]`,
  `testGateRule(testCmd:string, subject:string):string`, `LINT_RULE`,
  `integrityRule(unit:string):string`, `CONFINEMENT_RULES:string[]`,
  `commitRule(unit:string):string`,
  `notesRule(unit:string, subject:string):string`,
  `agentsMdRule(subject:string):string`.
- Produces (from `src/learnings.ts`): `collectNotes(worktreePath:string,
  file?:string):string|null`, `formatDate(date:Date):string` now
  exported.

- [ ] **Step 1: Snapshot the current ticket prompt**

Run (SCRATCH is your scratchpad directory):

```bash
npx esbuild src/orchestrator.ts --bundle --platform=node \
    --format=esm --packages=external --outfile=$SCRATCH/before.mjs
node -e "import('$SCRATCH/before.mjs').then(m => {
  const t = { num:1, slug:'x', filename:'01-x.md', filepath:'/x',
    body:'BODY', status:'ready-for-agent', blockers:[], feature:'f' }
  process.stdout.write(m.renderPrompt('SPEC', t,
    { testCmd:'npm test', installCmd:'npm ci', history:'H' }))
  process.stdout.write('\n=====\n')
  process.stdout.write(m.renderMergePrompt('SPEC', t,
    { installCmd:'npm ci' }))
})" > $SCRATCH/before.txt
```

- [ ] **Step 2: Write the failing `collectNotes` test**

Append to `test/learnings.test.ts` (match the file's existing temp-dir
helper and imports):

```ts
test('collectNotes - reads a named file and removes the dir', t => {
    const dir = mkdtempSync(join(tmpdir(), 'nightralph-notes-'))
    try {
        mkdirSync(join(dir, '.nightralph'))
        writeFileSync(
            join(dir, '.nightralph', 'findings.md'), '- [ ] a\n'
        )
        writeFileSync(join(dir, '.nightralph', 'notes.md'), 'n')
        t.equal(collectNotes(dir, 'findings.md'), '- [ ] a',
            'returns the named file, trimmed')
        t.ok(!existsSync(join(dir, '.nightralph')),
            'removes the whole directory')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, `collectNotes` ignores the second argument and returns
`n`.

- [ ] **Step 4: Implement `collectNotes(worktreePath, file)`**

In `src/learnings.ts` (add `basename` to the `node:path` import):

```ts
// Reads one file from the worktree's notes directory (the notes
// by default), then removes the whole directory.
export function collectNotes (
    worktreePath:string,
    file:string = basename(NOTES_PATH)
):string|null {
    const dir = join(worktreePath, dirname(NOTES_PATH))
    const path = join(dir, file)
    const text = existsSync(path) ?
        readFileSync(path, 'utf8').trim() :
        ''
    rmSync(dir, { recursive:true, force:true })
    return text || null
}
```

Also change `function formatDate` to `export function formatDate`.

- [ ] **Step 5: Create `src/rules.ts`**

Each function reproduces a line of `renderPrompt` exactly when called
with the ticket wording (`'ticket'`, `'checklist item'`):

```ts
import { NOTES_PATH } from './learnings.js'

// Rule lines shared by the agent prompts. `unit` is what the agent
// commits one at a time ("checklist item", "finding"); `subject` is
// what the orchestrator accepts or rejects ("ticket", "fix").

export function readDocsRule (subject:string):string {
    return '- Read the files directly relevant to the ' +
        `${subject} before writing code. Also read any ` +
        'AGENTS.md in or above the directories you ' +
        'will touch, plus CONTEXT.md and the ' +
        'relevant docs/adr/ entries if they exist. ' +
        'If they do not exist, proceed silently.'
}

// The rule for agents in a worktree the orchestrator has
// already installed dependencies into. Empty without one.
export function installRule (installCmd?:string):string[] {
    if (!installCmd) return []
    return [
        '- Dependencies are already installed with ' +
            `\`${installCmd}\`. Do NOT reinstall them ` +
            'with any other command; to reinstall, run ' +
            'that same command. To add a dependency, use ' +
            'the package manager that command uses, so ' +
            'its lockfile stays in sync.',
    ]
}

export function testGateRule (testCmd:string, subject:string):string {
    return '- While iterating, run only the tests ' +
        'relevant to what you changed. Run ' +
        `\`${testCmd}\` in full once, as the ` +
        'final gate before your last commit. Do ' +
        'not commit with failing tests. The ' +
        'orchestrator runs the same command after ' +
        `you exit and rejects the ${subject} if it ` +
        'fails.'
}

export const LINT_RULE = '- If the project has a lint script, run it ' +
    'and fix what it reports.'

export function integrityRule (unit:string):string {
    return '- INTEGRITY: never delete, skip, weaken, or ' +
        'write tautological tests to force a green ' +
        `result. Only report a ${unit} done ` +
        'when its real tests genuinely pass. If an ' +
        'item cannot be completed honestly, leave ' +
        'it unchecked and record what blocked you ' +
        'in your notes file.'
}

export const CONFINEMENT_RULES:string[] = [
    '- Do NOT read or modify files outside ' +
        'your current directory (the worktree).',
    '- Do NOT run git push.',
]

export function commitRule (unit:string):string {
    return `- Commit after each ${unit}, and make ` +
        'sure everything is committed when finished, ' +
        'except your notes file.'
}

export function notesRule (unit:string, subject:string):string {
    return `- Keep notes for this attempt in \`${NOTES_PATH}\` ` +
        '(create the directory). Update it after each ' +
        `${unit} and as soon as you hit a ` +
        'blocker, not only at the end. Record what you ' +
        'implemented, files changed, how you read any ' +
        'vague acceptance criteria, what blocked you, and ' +
        `anything the next attempt at this ${subject} should ` +
        'know. Never commit, git add, or delete this ' +
        'file; the orchestrator collects it.'
}

export function agentsMdRule (subject:string):string {
    return '- Before your final commit, record reusable ' +
        'learnings in the nearest AGENTS.md (in or ' +
        'above the directories you modified; ' +
        'prefer that over the repo root). Good ' +
        'additions: module conventions, gotchas, ' +
        'files that must change together, how to ' +
        'test that area, environment requirements. ' +
        `Do NOT add ${subject}-specific details or ` +
        'temporary debugging notes. Only write ' +
        'when you have knowledge that would help ' +
        'future work in that directory. Reusable ' +
        'patterns go in AGENTS.md; anything ' +
        `specific to this ${subject} goes in your ` +
        'notes file.'
}
```

- [ ] **Step 6: Use the rules in `renderPrompt`**

In `src/orchestrator.ts`, delete the local `installRule` and import the
rules from `./rules.js`. In `renderPrompt`, replace the matching
literal lines with calls, keeping their order:

```ts
        'Follow these rules:',
        readDocsRule('ticket'),
        '- Work ONLY on this ticket. Do not fix ' +
            'unrelated problems you notice.',
        '- Do NOT research external APIs or services ' +
            'via web search. Use the spec and ticket ' +
            'body as your sole reference for API shapes.',
        ...installRule(opts.installCmd),
        '- Use /tdd for every checklist item. For ' +
            // unchanged literal through 'file.',
        testGateRule(opts.testCmd, 'ticket'),
        LINT_RULE,
        integrityRule('checklist item'),
        ...CONFINEMENT_RULES,
        commitRule('checklist item'),
        notesRule('checklist item', 'ticket'),
        '- After completing each checklist item in the ' +
            'ticket, print a line: [x] <item text> ' +
            '(matching the checklist text exactly).',
        agentsMdRule('ticket'),
        '',
```

(The `/tdd` line stays a literal; copy it from the current file.)
`renderMergePrompt` keeps its own unprefixed lines and only uses the
imported `installRule`.

- [ ] **Step 7: Verify the prompts are byte-identical**

Re-run Step 1's commands with `after.mjs`/`after.txt`, then:

```bash
diff $SCRATCH/before.txt $SCRATCH/after.txt && echo identical
```

Expected: `identical`. If not, fix the rule text, not the diff.

- [ ] **Step 8: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: PASS with no edits to existing prompt tests.

- [ ] **Step 9: Commit**

```bash
git add src/rules.ts src/orchestrator.ts src/learnings.ts \
    test/learnings.test.ts
git commit -m "refactor(prompt): shared rule lines; collectNotes reads any file"
```

---

### Task 6: Review core (pure)

**Files:**
- Create: `src/review.ts`
- Test: `test/review.test.ts`, `scripts/test.sh`

**Interfaces:**
- Consumes: `formatDate`, `NOTES_PATH` (Task 5).
- Produces:
  - `FINDINGS_FILE = 'findings.md'`,
    `FINDINGS_PATH = '.nightralph/findings.md'`,
    `NO_FINDINGS = 'No findings.'`, `REVIEW_EXCLUDE = '.scratch'`,
    `REVIEW_STATUSES`, `type ReviewStatus`.
  - `type Finding = { summary:string; detail:string; checked:boolean }`.
  - `type FixRecord = { attempts:number; maxAttempts:number;
    effort?:string; exitCode:number|null; result:string;
    notes:string|null }`.
  - `type ReviewEntryInput = { from:string; to:string;
    status:ReviewStatus; now:Date; findings:Finding[];
    fix?:FixRecord }`.
  - `type ReviewEntry = { from:string; to:string; status:ReviewStatus;
    findings:Finding[]; body:string }`.
  - `parseFindings(text:string):Finding[]|null`,
    `markFixed(findings:ReadonlyArray<Finding>,
    completedItems:ReadonlyArray<string>):Finding[]`,
    `renderReviewEntry(input:ReviewEntryInput):string`,
    `parseReviewEntries(text:string):ReviewEntry[]`,
    `selectReviewBase(entries:ReadonlyArray<ReviewEntry>, opts:{
    isAncestor:(sha:string) => boolean; forkPoint:string|null;
    launchCommit:string }):string`,
    `type ReviewOutcome = { status:ReviewStatus|'skipped';
    findings:number; fixed:number }`,
    `renderReviewSummary(outcome:ReviewOutcome,
    reviewPath:string):string|null`.

- [ ] **Step 1: Write the failing tests**

Create `test/review.test.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    parseFindings,
    markFixed,
    renderReviewEntry,
    parseReviewEntries,
    selectReviewBase,
    renderReviewSummary,
    type Finding,
    type ReviewEntry,
} from '../src/review.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const NOW = new Date(2026, 9, 7, 3, 40)

function finding (summary:string, checked = false):Finding {
    return { summary, detail:'', checked }
}

// -- parseFindings --

test('parseFindings - checklist with indented detail', t => {
    const found = parseFindings([
        'Some preamble',
        '- [ ] Off-by-one in   page count',
        '    src/page.ts:12',
        '    a 10-item list reports 2 pages',
        '- [ ] Missing test for empty input',
    ].join('\n'))
    t.deepEqual(found, [
        {
            summary:'Off-by-one in page count',
            detail:'src/page.ts:12\na 10-item list reports 2 pages',
            checked:false,
        },
        {
            summary:'Missing test for empty input',
            detail:'',
            checked:false,
        },
    ], 'summaries collapsed, detail kept, preamble ignored')
})

test('parseFindings - clean, empty, and CRLF', t => {
    t.deepEqual(parseFindings('No findings.\n'), [], 'clean')
    t.deepEqual(parseFindings('no findings.'), [],
        'case-insensitive')
    t.equal(parseFindings(''), null, 'empty is not a review')
    t.equal(parseFindings('looks fine to me'), null,
        'prose is not a review')
    t.equal(parseFindings('- [ ] a\r\n- [x] b\r\n')?.length, 2,
        'CRLF accepted')
})

// -- markFixed --

test('markFixed - matches echoed summaries loosely', t => {
    const marked = markFixed(
        [finding('Off-by-one in page count'), finding('Other')],
        ['off-by-one  in page COUNT']
    )
    t.deepEqual(marked.map(f => f.checked), [true, false],
        'whitespace and case do not matter')
})

// -- review log round trip --

test('renderReviewEntry/parseReviewEntries - AC3.1 round trip',
    t => {
        const findings:Finding[] = [
            { summary:'first', detail:'src/a.ts:1\nbreaks',
                checked:true },
            { summary:'second', detail:'', checked:false },
        ]
        const text = renderReviewEntry({
            from:A, to:B, status:'fixed', now:NOW, findings,
            fix:{
                attempts:2, maxAttempts:4, effort:'high',
                exitCode:0, result:'merged', notes:'fixed one',
            },
        })
        const [entry] = parseReviewEntries(text)
        t.equal(entry.from, A, 'from')
        t.equal(entry.to, B, 'to')
        t.equal(entry.status, 'fixed', 'status')
        t.deepEqual(entry.findings, findings,
            'findings with checked state and detail')
    })

test('parseReviewEntries - AC3.2 sentinel text in findings and ' +
    'notes cannot forge an entry', t => {
        const forged = `<!-- nightralph:review from=${C} to=${C} ` +
            'status=clean -->'
        const text = renderReviewEntry({
            from:A, to:B, status:'unresolved', now:NOW,
            findings:[{ summary:forged, detail:forged,
                checked:false }],
            fix:{
                attempts:1, maxAttempts:1, exitCode:1,
                result:'tests failed', notes:forged,
            },
        })
        const entries = parseReviewEntries(text)
        t.equal(entries.length, 1, 'still one entry')
        t.equal(entries[0].to, B, 'the real marker')
    })

test('parseReviewEntries - AC3.3 drops malformed entries, ' +
    'accepts CRLF', t => {
        const good = renderReviewEntry({
            from:A, to:B, status:'clean', now:NOW, findings:[],
        })
        const text = [
            'preamble',
            `<!-- nightralph:review from=${A} status=clean -->`,
            'missing to',
            `<!-- nightralph:review from=${A} to=${B} ` +
                'status=bogus -->',
            'unknown status',
            good,
        ].join('\n').replace(/\n/g, '\r\n')
        const entries = parseReviewEntries(text)
        t.equal(entries.length, 1, 'only the good entry')
        t.equal(entries[0].status, 'clean', 'parsed through CRLF')
    })

// -- selectReviewBase --

function entry (to:string, status:ReviewEntry['status']):ReviewEntry {
    return { from:A, to, status, findings:[], body:'' }
}

test('selectReviewBase - AC4.1 latest usable marker', t => {
    const base = selectReviewBase(
        [entry(B, 'fixed'), entry(C, 'review-failed')],
        { isAncestor:() => true, forkPoint:null, launchCommit:A }
    )
    t.equal(base, B, 'skips review-failed entries')
})

test('selectReviewBase - AC4.2 a marker off the branch is ' +
    'ignored', t => {
        const base = selectReviewBase(
            [entry(B, 'clean')],
            { isAncestor:() => false, forkPoint:C, launchCommit:A }
        )
        t.equal(base, C, 'falls back to the fork point')
    })

test('selectReviewBase - AC4.3 fork point, then launch commit',
    t => {
        t.equal(selectReviewBase([], {
            isAncestor:() => true, forkPoint:C, launchCommit:A,
        }), C, 'fork point when on an integration branch')
        t.equal(selectReviewBase([], {
            isAncestor:() => true, forkPoint:null, launchCommit:A,
        }), A, 'launch commit otherwise')
    })

// -- renderReviewSummary --

test('renderReviewSummary - null only when skipped', t => {
    t.equal(renderReviewSummary(
        { status:'skipped', findings:0, fixed:0 }, 'r.md'
    ), null, 'skipped says nothing')
    for (const status of [
        'clean', 'fixed', 'unresolved', 'review-failed',
    ] as const) {
        const line = renderReviewSummary(
            { status, findings:3, fixed:2 }, 'r.md'
        )
        t.ok(line && line.includes('r.md'),
            `${status} names the file`)
    }
})
```

Add `review` to the `TESTS` array in `scripts/test.sh` after
`learnings`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild fails with `Could not resolve "../src/review.js"`.

- [ ] **Step 3: Implement the pure core in `src/review.ts`**

```ts
import { dirname } from 'node:path'
import { NOTES_PATH, formatDate } from './learnings.js'

export const FINDINGS_FILE = 'findings.md'
export const FINDINGS_PATH = `${dirname(NOTES_PATH)}/${FINDINGS_FILE}`
export const NO_FINDINGS = 'No findings.'
// Bookkeeping lives here (tickets, progress, learnings, the
// review log), so the review never looks at it.
export const REVIEW_EXCLUDE = '.scratch'

const SENTINEL_PREFIX = '<!-- nightralph:review'
const SENTINEL_RE = /^<!-- nightralph:review (.*) -->$/
const SHA_RE = /^[0-9a-f]{4,64}$/
const FIX_HEADING = '### Fix'
const FINDING_RE = /^ ?[-*+]\s+\[([ xX])\]\s+(.+)$/

export const REVIEW_STATUSES = [
    'clean', 'fixed', 'unresolved', 'review-failed',
] as const

export type ReviewStatus = typeof REVIEW_STATUSES[number]

export type Finding = {
    summary:string
    detail:string
    checked:boolean
}

export type FixRecord = {
    attempts:number
    maxAttempts:number
    effort?:string
    exitCode:number|null
    result:string
    notes:string|null
}

export type ReviewEntryInput = {
    from:string
    to:string
    status:ReviewStatus
    now:Date
    findings:Finding[]
    fix?:FixRecord
}

export type ReviewEntry = {
    from:string
    to:string
    status:ReviewStatus
    findings:Finding[]
    body:string
}

export type ReviewOutcome = {
    status:ReviewStatus|'skipped'
    findings:number
    fixed:number
}

function isReviewStatus (value:string):value is ReviewStatus {
    return (REVIEW_STATUSES as readonly string[]).includes(value)
}

function collapse (s:string):string {
    return s.replace(/\s+/g, ' ').trim()
}

function normalize (s:string):string {
    return collapse(s).toLowerCase()
}

function sanitize (text:string):string {
    return text.replace(
        new RegExp(SENTINEL_PREFIX, 'g'),
        '<!-- nightralph-review'
    )
}

function splitLines (text:string):string[] {
    return text.split('\n').map(line => {
        return line.endsWith('\r') ? line.slice(0, -1) : line
    })
}

// The reviewer's checklist: `- [ ] summary` lines, each followed
// by its detail lines. [] for an explicit "No findings.", null
// when the text is neither, which fails the review attempt.
export function parseFindings (text:string):Finding[]|null {
    const findings:Finding[] = []
    const details:string[][] = []
    for (const line of splitLines(text)) {
        const m = line.match(FINDING_RE)
        if (m) {
            findings.push({
                summary:collapse(m[2]),
                detail:'',
                checked:m[1] !== ' ',
            })
            details.push([])
        } else if (findings.length > 0 && line.trim()) {
            details[details.length - 1].push(line.trim())
        }
    }
    if (findings.length > 0) {
        return findings.map((f, i) => {
            return { ...f, detail:details[i].join('\n') }
        })
    }
    const clean = splitLines(text).some(line => {
        return normalize(line) === NO_FINDINGS.toLowerCase()
    })
    return clean ? [] : null
}

// Checks off the findings the fixer echoed as `[x] <summary>`,
// compared loosely like ticket checklist items.
export function markFixed (
    findings:ReadonlyArray<Finding>,
    completedItems:ReadonlyArray<string>
):Finding[] {
    const done = new Set(completedItems.map(normalize))
    return findings.map(f => {
        return { ...f, checked:done.has(normalize(f.summary)) }
    })
}

function headline (input:ReviewEntryInput):string {
    const n = input.findings.length
    const fixed = input.findings.filter(f => f.checked).length
    switch (input.status) {
        case 'clean': return 'no findings'
        case 'fixed': return `${fixed} of ${n} fixed`
        case 'unresolved': return `${n} findings, fix failed`
        case 'review-failed': return 'review failed'
        default: {
            const _exhaustive:never = input.status
            return _exhaustive
        }
    }
}

function renderFindings (input:ReviewEntryInput):string[] {
    if (input.status === 'review-failed') {
        return ['The reviewer left no usable findings file.']
    }
    if (input.findings.length === 0) return [NO_FINDINGS]
    return input.findings.flatMap(f => {
        const box = f.checked ? '[x]' : '[ ]'
        const detail = f.detail ?
            f.detail.split('\n').map(l => `    ${sanitize(l)}`) :
            []
        return [`- ${box} ${sanitize(collapse(f.summary))}`, ...detail]
    })
}

function renderFix (fix?:FixRecord):string[] {
    if (!fix) return []
    return [
        '',
        FIX_HEADING,
        `- attempts: ${fix.attempts} of ${fix.maxAttempts}`,
        ...(fix.effort ? [`- effort: ${fix.effort}`] : []),
        `- agent exit code: ${fix.exitCode ?? 'none'}`,
        `- result: ${sanitize(fix.result)}`,
        '',
        fix.notes ? sanitize(fix.notes) : 'The fixer left no notes.',
    ]
}

export function renderReviewEntry (input:ReviewEntryInput):string {
    return [
        `${SENTINEL_PREFIX} from=${input.from} to=${input.to} ` +
            `status=${input.status} -->`,
        `## ${formatDate(input.now)} -- review ` +
            `${input.from.slice(0, 7)}..${input.to.slice(0, 7)} ` +
            `-- ${headline(input)}`,
        ...renderFindings(input),
        ...renderFix(input.fix),
        '---',
        '',
    ].join('\n')
}

function parseEntry (
    sentinel:string,
    bodyLines:string[]
):ReviewEntry|null {
    const attrs:Record<string, string> = {}
    for (const part of sentinel.split(/\s+/).filter(Boolean)) {
        const idx = part.indexOf('=')
        if (idx > 0) attrs[part.slice(0, idx)] = part.slice(idx + 1)
    }
    const { from, to, status } = attrs
    if (!from || !SHA_RE.test(from)) return null
    if (!to || !SHA_RE.test(to)) return null
    if (!status || !isReviewStatus(status)) return null

    const lines = [...bodyLines]
    while (lines.length > 0 && !lines[lines.length - 1].trim()) {
        lines.pop()
    }
    if (lines[lines.length - 1] === '---') lines.pop()
    const fixAt = lines.indexOf(FIX_HEADING)
    const findingLines = fixAt === -1 ? lines : lines.slice(0, fixAt)
    return {
        from,
        to,
        status,
        findings:parseFindings(findingLines.join('\n')) ?? [],
        body:lines.join('\n').trim(),
    }
}

// Malformed entries are dropped, not thrown; text before the
// first sentinel is ignored.
export function parseReviewEntries (text:string):ReviewEntry[] {
    const entries:ReviewEntry[] = []
    let sentinel:string|null = null
    let body:string[] = []
    const flush = ():void => {
        if (sentinel === null) return
        const entry = parseEntry(sentinel, body)
        if (entry) entries.push(entry)
    }
    for (const line of splitLines(text)) {
        const m = line.match(SENTINEL_RE)
        if (m) {
            flush()
            sentinel = m[1]
            body = []
        } else if (sentinel !== null) {
            body.push(line)
        }
    }
    flush()
    return entries
}

// Where the review range starts: the last reviewed commit while
// it is still on this branch, else the fork point from the
// default branch, else the commit the run started from.
export function selectReviewBase (
    entries:ReadonlyArray<ReviewEntry>,
    opts:{
        isAncestor:(sha:string) => boolean
        forkPoint:string|null
        launchCommit:string
    }
):string {
    const last = [...entries].reverse().find(e => {
        return e.status !== 'review-failed'
    })
    if (last && opts.isAncestor(last.to)) return last.to
    return opts.forkPoint ?? opts.launchCommit
}

// One line for the finish summary; null when no review ran.
export function renderReviewSummary (
    outcome:ReviewOutcome,
    reviewPath:string
):string|null {
    const see = ` -- see ${reviewPath}`
    const plural = outcome.findings === 1 ? '' : 's'
    switch (outcome.status) {
        case 'skipped': return null
        case 'clean': return `Review: no findings${see}`
        case 'fixed':
            return `Review: ${outcome.findings} finding${plural}, ` +
                `${outcome.fixed} fixed${see}`
        case 'unresolved':
            return `Review: ${outcome.findings} finding${plural}, ` +
                `fix failed${see}`
        case 'review-failed':
            return `Review: the reviewer failed${see}`
        default: {
            const _exhaustive:never = outcome.status
            return _exhaustive
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts test/review.test.ts scripts/test.sh
git commit -m "feat(review): review log, findings, and range selection"
```

---

### Task 7: Review and fix prompts

**Files:**
- Modify: `src/review.ts`
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: Task 5's rule functions; Task 6's `Finding`,
  `FINDINGS_PATH`, `NO_FINDINGS`, `REVIEW_EXCLUDE`.
- Produces: `REVIEW_MARKER = '---- REVIEW INSTRUCTIONS ----'`,
  `FIX_MARKER = '---- REVIEW FINDINGS ----'`,
  `reviewDiffCommand(from:string, to:string):string`,
  `renderReviewPrompt(opts:{ specBody:string; from:string;
  to:string }):string`, `type FixFailure = 'install'|'exit'|
  'no-commits'|'tests'|'merge'`, `FIX_FAILURE_TEXT:Record<FixFailure,
  string>`, `renderFixPrompt(opts:{ specBody:string;
  findings:ReadonlyArray<Finding>; testCmd:string; installCmd?:string;
  previous?:{ reason:FixFailure; notes:string|null } }):string`.

- [ ] **Step 1: Write the failing tests**

Append to `test/review.test.ts` (extend the import):

```ts
// -- prompts --

test('renderReviewPrompt - carries the spec, range, and output ' +
    'contract', t => {
        const prompt = renderReviewPrompt({
            specBody:'SPEC-BODY', from:A, to:B,
        })
        t.ok(prompt.includes('SPEC-BODY'), 'spec pasted')
        t.ok(prompt.includes(REVIEW_MARKER), 'marked as a review')
        t.ok(prompt.includes(reviewDiffCommand(A, B)),
            'exact diff command')
        t.ok(reviewDiffCommand(A, B).includes(':(exclude).scratch'),
            'diff excludes bookkeeping')
        t.ok(prompt.includes(FINDINGS_PATH), 'names the findings file')
        t.ok(prompt.includes(NO_FINDINGS), 'names the clean marker')
    })

test('renderFixPrompt - carries findings, test command, and the ' +
    'previous attempt only on a retry', t => {
        const findings = [
            { summary:'first thing', detail:'src/a.ts:1',
                checked:false },
            { summary:'second thing', detail:'', checked:false },
        ]
        const first = renderFixPrompt({
            specBody:'SPEC-BODY', findings, testCmd:'npm run t',
        })
        t.ok(first.includes(FIX_MARKER), 'marked as a fix')
        t.ok(first.includes('first thing') &&
            first.includes('second thing'), 'every finding')
        t.ok(first.includes('src/a.ts:1'), 'finding detail')
        t.ok(first.includes('npm run t'), 'test command')
        t.ok(first.includes('[x]'), 'asks for [x] echoes')
        t.ok(!first.includes('NOTES-TOKEN'), 'no previous notes')

        const retry = renderFixPrompt({
            specBody:'SPEC-BODY', findings, testCmd:'npm run t',
            installCmd:'npm ci',
            previous:{ reason:'tests', notes:'NOTES-TOKEN' },
        })
        t.ok(retry.includes('NOTES-TOKEN'), 'previous notes')
        t.ok(retry.includes(FIX_FAILURE_TEXT.tests),
            'previous failure reason')
        t.ok(retry.includes('npm ci'), 'install rule')
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild reports `No matching export` for the new names.

- [ ] **Step 3: Implement the prompts in `src/review.ts`**

Add to the imports:

```ts
import {
    readDocsRule,
    installRule,
    testGateRule,
    LINT_RULE,
    integrityRule,
    CONFINEMENT_RULES,
    commitRule,
    notesRule,
    agentsMdRule,
} from './rules.js'
```

Then:

```ts
export const REVIEW_MARKER = '---- REVIEW INSTRUCTIONS ----'
export const FIX_MARKER = '---- REVIEW FINDINGS ----'

export function reviewDiffCommand (from:string, to:string):string {
    return `git diff ${from}..${to} -- . ':(exclude)${REVIEW_EXCLUDE}'`
}

export function renderReviewPrompt (opts:{
    specBody:string
    from:string
    to:string
}):string {
    return [
        '---- SPEC CONTEXT ----',
        opts.specBody,
        '',
        REVIEW_MARKER,
        'You are reviewing work that autonomous agents merged ' +
            'into this branch, one ticket at a time. Review the ' +
            'combined change as a whole.',
        '',
        'The change to review:',
        '',
        `    ${reviewDiffCommand(opts.from, opts.to)}`,
        '',
        'Follow these rules:',
        '- Read any AGENTS.md in or above the directories the ' +
            'change touches, plus CONTEXT.md and the relevant ' +
            'docs/adr/ entries if they exist. Treat their ' +
            'contracts and the spec above as the standard the ' +
            'code must meet.',
        '- Look for correctness bugs, missing or weak tests, ' +
            'and code that breaks a documented contract. Ignore ' +
            'style preferences.',
        '- You may run the tests or the type checker to confirm ' +
            'a suspicion.',
        '- Do NOT edit, stage, or commit code. Anything you ' +
            'change here is discarded.',
        ...CONFINEMENT_RULES,
        '',
        `Write your findings to \`${FINDINGS_PATH}\` (create the ` +
            'directory), most severe first, in exactly this form:',
        '',
        '- [ ] <one-line summary of the finding>',
        '    <file:line, and a concrete input or state that goes ' +
            'wrong>',
        '',
        'If you find nothing worth fixing, write the single line: ' +
            NO_FINDINGS,
        'Never git add or commit that file; the orchestrator ' +
            'collects it.',
        '',
    ].join('\n')
}

export type FixFailure =
    'install'|'exit'|'no-commits'|'tests'|'merge'

export const FIX_FAILURE_TEXT:Record<FixFailure, string> = {
    install:'dependency install failed',
    exit:'the agent exited with an error',
    'no-commits':'the agent made no commits',
    tests:'the test command failed after the agent finished',
    merge:'the fix branch did not merge cleanly',
}

function findingLines (findings:ReadonlyArray<Finding>):string[] {
    return findings.flatMap(f => [
        `- [ ] ${f.summary}`,
        ...(f.detail ?
            f.detail.split('\n').map(l => `    ${l}`) :
            []),
    ])
}

function previousBlock (
    previous?:{ reason:FixFailure; notes:string|null }
):string[] {
    if (!previous) return []
    return [
        '---- PREVIOUS FIX ATTEMPT ----',
        `It failed: ${FIX_FAILURE_TEXT[previous.reason]}.`,
        previous.notes ?? 'It left no notes.',
        '',
    ]
}

export function renderFixPrompt (opts:{
    specBody:string
    findings:ReadonlyArray<Finding>
    testCmd:string
    installCmd?:string
    previous?:{ reason:FixFailure; notes:string|null }
}):string {
    return [
        '---- SPEC CONTEXT ----',
        opts.specBody,
        '',
        FIX_MARKER,
        ...findingLines(opts.findings),
        '',
        ...previousBlock(opts.previous),
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent. Fix the review ' +
            'findings above using /tdd.',
        '',
        'Follow these rules:',
        readDocsRule('findings'),
        '- Fix ONLY the listed findings. Do not fix unrelated ' +
            'problems you notice.',
        ...installRule(opts.installCmd),
        '- Use /tdd for every finding: write a failing test that ' +
            'shows the problem, then write only enough code to ' +
            'make it pass, then refactor.',
        testGateRule(opts.testCmd, 'fix'),
        LINT_RULE,
        integrityRule('finding'),
        ...CONFINEMENT_RULES,
        commitRule('finding'),
        notesRule('finding', 'fix'),
        '- After fixing each finding, print a line: ' +
            '[x] <finding summary> (matching the summary ' +
            'text exactly).',
        '- If a finding is wrong or cannot be fixed honestly, ' +
            'leave it unchecked and explain why in your notes ' +
            'file.',
        agentsMdRule('fix'),
        '',
    ].join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts test/review.test.ts
git commit -m "feat(review): reviewer and fixer prompts"
```

---

### Task 8: The reviewer

**Files:**
- Modify: `src/review.ts`
- Test: `test/review-pass.test.ts`, `scripts/test.sh`

**Interfaces:**
- Consumes: `runWithRetries` (Task 1); `createNamedWorktree`,
  `removeWorktree`, `deleteBranch` (Task 3); `collectNotes` (Task 5),
  `ensureNotesIgnored`; `runTestCmd` (`src/testcmd.ts`); Task 6-7
  functions.
- Produces:
  - `type SpawnAgentFn = (opts:{ prompt:string; agentCmd:string;
    model:string|null; timeout:number; logPath:string; cwd?:string;
    label?:string; maxTurns?:number; effort?:EffortLevel;
    onLine?:(line:string) => void }) => Promise<AgentResult>`.
  - `type ReviewDeps = { spawnAgent:SpawnAgentFn;
    registry?:Set<number> }`.
  - `type ReviewPassOpts = { repoRoot:string; repoName:string;
    baseBranch:string; reviewPath:string; forkedFrom?:string;
    launchCommit:string; specBody:string; agentCmd:string;
    model:string|null; timeout:number; logsDir:string; testCmd:string;
    installCmd?:string; maxTurns?:number; effort?:EffortLevel;
    retries:number; retryDelay:number; log:(msg:string) => void;
    now?:() => Date }`.
  - `runReviewer(opts:ReviewPassOpts, deps:ReviewDeps, range:{
    from:string; to:string }):Promise<Finding[]|null>`.

- [ ] **Step 1: Write the failing tests**

Create `test/review-pass.test.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
    realpathSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import {
    runReviewer,
    FINDINGS_PATH,
    NO_FINDINGS,
    type ReviewDeps,
    type ReviewPassOpts,
    type SpawnAgentFn,
} from '../src/review.js'
import { localBranchExists } from '../src/worktree.js'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Test',
    GIT_COMMITTER_EMAIL:'test@example.com',
    GIT_AUTHOR_NAME:'Test',
    GIT_AUTHOR_EMAIL:'test@example.com',
}

function git (cwd:string, args:string[]):string {
    return execFileSync('git', args, {
        cwd, env:GIT_ENV, encoding:'utf8',
    }).trim()
}

// A hermetic repo on main with one code commit, plus cleanup of
// any sibling worktrees the review created.
function withRepo (
    fn:(repoRoot:string) => Promise<void>
):Promise<void> {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const repoRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'nightralph-review-'))
    )
    execFileSync('git', ['init', `--template=${templateDir}`],
        { cwd:repoRoot, stdio:'ignore' })
    execSync('git config core.excludesFile /dev/null', { cwd:repoRoot })
    execSync('git config core.hooksPath /dev/null', { cwd:repoRoot })
    git(repoRoot, ['commit', '--allow-empty', '-m', 'init'])
    git(repoRoot, ['branch', '-M', 'main'])
    writeFileSync(join(repoRoot, 'a.ts'), 'export const a = 1\n')
    git(repoRoot, ['add', 'a.ts'])
    git(repoRoot, ['commit', '-m', 'code'])
    const cleanup = ():void => {
        for (const name of ['review', 'review-fix']) {
            rmSync(join(repoRoot, '..', `${basename(repoRoot)}.${name}`),
                { recursive:true, force:true })
        }
        rmSync(repoRoot, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
    return fn(repoRoot).finally(cleanup)
}

function passOpts (
    repoRoot:string,
    overrides?:Partial<ReviewPassOpts>
):ReviewPassOpts {
    const logsDir = join(repoRoot, '.scratch', 'feat', 'logs')
    mkdirSync(logsDir, { recursive:true })
    return {
        repoRoot,
        repoName:basename(repoRoot),
        baseBranch:'main',
        reviewPath:join(repoRoot, '.scratch', 'feat', 'review.md'),
        launchCommit:git(repoRoot, ['rev-parse', 'HEAD~1']),
        specBody:'SPEC',
        agentCmd:'node',
        model:null,
        timeout:30,
        logsDir,
        testCmd:'true',
        retries:0,
        retryDelay:0,
        log:() => {},
        ...overrides,
    }
}

// A fake agent: records each call's prompt and cwd, then runs
// `act` inside the worktree.
function fakeAgent (
    act:(cwd:string, call:number) => Partial<{
        exitCode:number
        timedOut:boolean
        completedItems:string[]
    }>|void
):{ spawnAgent:SpawnAgentFn; calls:Array<{
    prompt:string; cwd:string
}> } {
    const calls:Array<{ prompt:string; cwd:string }> = []
    const spawnAgent:SpawnAgentFn = async opts => {
        const cwd = opts.cwd ?? process.cwd()
        calls.push({ prompt:opts.prompt, cwd })
        const r = act(cwd, calls.length) ?? {}
        return {
            exitCode:r.exitCode ?? 0,
            timedOut:r.timedOut ?? false,
            completedItems:r.completedItems ?? [],
        }
    }
    return { spawnAgent, calls }
}

function writeFindings (cwd:string, text:string):void {
    mkdirSync(join(cwd, '.nightralph'), { recursive:true })
    writeFileSync(join(cwd, FINDINGS_PATH), text)
}

function range (repoRoot:string):{ from:string; to:string } {
    return {
        from:git(repoRoot, ['rev-parse', 'HEAD~1']),
        to:git(repoRoot, ['rev-parse', 'HEAD']),
    }
}

test('runReviewer - AC5.1 returns findings and removes its ' +
    'worktree and branch', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            writeFindings(cwd, '- [ ] one\n    a.ts:1\n- [ ] two\n')
        })
        const deps:ReviewDeps = { spawnAgent:agent.spawnAgent }
        const opts = passOpts(repoRoot)
        const found = await runReviewer(opts, deps, range(repoRoot))

        t.deepEqual(found?.map(f => f.summary), ['one', 'two'],
            'parsed findings')
        t.ok(!existsSync(agent.calls[0].cwd), 'worktree removed')
        t.ok(!localBranchExists(repoRoot, `${opts.repoName}--review`),
            'branch deleted')
    })
})

test('runReviewer - AC5.2 a clean review returns []', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => writeFindings(cwd, NO_FINDINGS))
        const found = await runReviewer(
            passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
            range(repoRoot)
        )
        t.deepEqual(found, [], 'clean')
    })
})

test('runReviewer - AC5.3 findings written before a timeout count',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent(cwd => {
                writeFindings(cwd, '- [ ] slow one\n')
                return { exitCode:137, timedOut:true }
            })
            const found = await runReviewer(
                passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(found?.length, 1, 'kept')
        })
    })

test('runReviewer - AC5.4 no findings file is retried, then null',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent(() => {})
            const found = await runReviewer(
                passOpts(repoRoot, { retries:1 }),
                { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(agent.calls.length, 2, 'retried once')
            t.equal(found, null, 'failed review')
        })
    })

test('runReviewer - AC5.5 reviewer commits never reach main',
    async t => {
        await withRepo(async repoRoot => {
            const before = git(repoRoot, ['rev-parse', 'main'])
            const agent = fakeAgent(cwd => {
                writeFileSync(join(cwd, 'sneaky.ts'), 'x')
                git(cwd, ['add', 'sneaky.ts'])
                git(cwd, ['commit', '-m', 'sneaky'])
                writeFindings(cwd, NO_FINDINGS)
            })
            await runReviewer(
                passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(git(repoRoot, ['rev-parse', 'main']), before,
                'main unchanged')
        })
    })
```

Add `review-pass` to `TESTS` in `scripts/test.sh` after `review`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild reports `No matching export "runReviewer"`.

- [ ] **Step 3: Implement the reviewer in `src/review.ts`**

Add imports:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    collectNotes,
    ensureNotesIgnored,
} from './learnings.js'
import { runTestCmd } from './testcmd.js'
import { runWithRetries, type EffortLevel } from './retry.js'
import {
    createNamedWorktree,
    deleteBranch,
    removeWorktree,
} from './worktree.js'
import type { AgentResult } from './orchestrator.js'
```

(merge the `node:path` import with the existing `dirname` one, and the
`learnings.js` import with the existing one.)

Then:

```ts
export type SpawnAgentFn = (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
    maxTurns?:number
    effort?:EffortLevel
    onLine?:(line:string) => void
}) => Promise<AgentResult>

export type ReviewDeps = {
    spawnAgent:SpawnAgentFn
    // running child pids, so SIGINT also kills installs and tests
    registry?:Set<number>
}

export type ReviewPassOpts = {
    repoRoot:string
    repoName:string
    // the branch the run merged into; the fix merges here too
    baseBranch:string
    reviewPath:string
    // the default branch, when baseBranch is an integration branch
    forkedFrom?:string
    launchCommit:string
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    testCmd:string
    installCmd?:string
    maxTurns?:number
    effort?:EffortLevel
    retries:number
    retryDelay:number
    log:(msg:string) => void
    now?:() => Date
}

// Same naming as ticket logs: the first attempt keeps the plain
// name, later attempts get their own file.
function logPath (
    logsDir:string,
    stem:string,
    attempt:number,
    ext:string
):string {
    const suffix = attempt > 1 ? `.attempt${attempt}` : ''
    return join(logsDir, `${stem}${suffix}${ext}`)
}

// Runs a shell step (install or tests) in a worktree, writing its
// output to `path`; true only on exit 0.
async function runStep (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    cmd:string,
    cwd:string,
    path:string
):Promise<boolean> {
    const result = await runTestCmd({
        cmd,
        cwd,
        timeout:opts.timeout,
        registry:deps.registry,
    })
    writeFileSync(path, result.output)
    return result.exitCode === 0
}

async function discardWorktree (
    opts:ReviewPassOpts,
    wt:{ worktreePath:string; branchName:string }
):Promise<void> {
    try {
        await removeWorktree(wt.worktreePath, { force:true })
        await deleteBranch(opts.repoRoot, wt.branchName)
    } catch (err) {
        opts.log(
            `  Failed to remove ${wt.worktreePath}: ` +
            (err instanceof Error ? err.message : String(err))
        )
    }
}

// Asks an agent to review from..to and returns its findings:
// [] when clean, null when no attempt produced a usable findings
// file. The worktree and anything the reviewer changed in it are
// always discarded.
export async function runReviewer (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    range:{ from:string; to:string }
):Promise<Finding[]|null> {
    return runWithRetries({
        maxAttempts:opts.retries + 1,
        retryDelay:opts.retryDelay,
        agentCmd:opts.agentCmd,
        effort:opts.effort,
        label:'review',
        log:opts.log,
    }, async (attempt, effort) => {
        const wt = await createNamedWorktree({
            repoRoot:opts.repoRoot,
            repoName:opts.repoName,
            baseBranch:opts.baseBranch,
            name:'review',
        })
        try {
            if (opts.installCmd && !(await runStep(
                opts, deps, opts.installCmd, wt.worktreePath,
                logPath(opts.logsDir, 'review', attempt, '.install.log')
            ))) {
                opts.log('  review: install failed')
                return { result:null, stop:false }
            }
            ensureNotesIgnored(wt.worktreePath)
            await deps.spawnAgent({
                prompt:renderReviewPrompt({
                    specBody:opts.specBody, ...range,
                }),
                agentCmd:opts.agentCmd,
                model:opts.model,
                timeout:opts.timeout,
                logPath:logPath(opts.logsDir, 'review', attempt, '.log'),
                cwd:wt.worktreePath,
                label:'review',
                maxTurns:opts.maxTurns,
                effort,
                onLine:opts.log,
            })
            const text = collectNotes(wt.worktreePath, FINDINGS_FILE)
            const findings = text === null ? null : parseFindings(text)
            if (findings === null) {
                opts.log('  review: no usable findings file')
            }
            return { result:findings, stop:findings !== null }
        } finally {
            await discardWorktree(opts, wt)
        }
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts test/review-pass.test.ts scripts/test.sh
git commit -m "feat(review): run the reviewer in a throwaway worktree"
```

---

### Task 9: The fixer

**Files:**
- Modify: `src/review.ts`
- Test: `test/review-pass.test.ts`

**Interfaces:**
- Consumes: Task 8's `ReviewPassOpts`, `ReviewDeps`, `runStep`,
  `discardWorktree`, `logPath`; `isDirty`, `commitDirty`,
  `hasNewCommits` (`src/worktree.ts`); `mergeBranch`
  (`src/merge.ts`); Task 6-7's `markFixed`, `renderFixPrompt`,
  `FixFailure`, `FIX_FAILURE_TEXT`.
- Produces: `type FixResult = { merged:boolean; findings:Finding[];
  attempts:number; effort?:EffortLevel; exitCode:number|null;
  result:string; notes:string|null }`,
  `runFixer(opts:ReviewPassOpts, deps:ReviewDeps,
  findings:ReadonlyArray<Finding>):Promise<FixResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/review-pass.test.ts` (import `runFixer` and
`FIX_FAILURE_TEXT`):

```ts
const FINDINGS = [
    { summary:'first thing', detail:'', checked:false },
    { summary:'second thing', detail:'', checked:false },
]

function commitIn (cwd:string, file:string):void {
    writeFileSync(join(cwd, file), String(Date.now()))
    git(cwd, ['add', file])
    git(cwd, ['commit', '-m', `add ${file}`])
}

test('runFixer - AC6.1 a green fix merges and checks echoed ' +
    'findings', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'fix.ts')
            return { completedItems:['first thing'] }
        })
        const result = await runFixer(
            passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
            FINDINGS
        )
        t.ok(result.merged, 'merged')
        t.deepEqual(result.findings.map(f => f.checked),
            [true, false], 'only the echoed finding is checked')
        t.ok(existsSync(join(repoRoot, 'fix.ts')),
            'the fix is on main')
        t.ok(!existsSync(agent.calls[0].cwd), 'worktree removed')
    })
})

test('runFixer - AC6.2 a red test gate is retried, then nothing ' +
    'merges', async t => {
    await withRepo(async repoRoot => {
        const before = git(repoRoot, ['rev-parse', 'main'])
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'broken.txt')
            return { completedItems:['first thing'] }
        })
        const result = await runFixer(
            passOpts(repoRoot, {
                retries:1, testCmd:'test ! -f broken.txt',
            }),
            { spawnAgent:agent.spawnAgent },
            FINDINGS
        )
        t.equal(agent.calls.length, 2, 'retried once')
        t.ok(!result.merged, 'not merged')
        t.ok(result.findings.every(f => !f.checked),
            'every finding unchecked')
        t.equal(git(repoRoot, ['rev-parse', 'main']), before,
            'main unchanged')
    })
})

test('runFixer - non-zero exit and no commits both fail',
    async t => {
        await withRepo(async repoRoot => {
            const exitAgent = fakeAgent(() => ({ exitCode:1 }))
            const exited = await runFixer(
                passOpts(repoRoot), { spawnAgent:exitAgent.spawnAgent },
                FINDINGS
            )
            t.ok(!exited.merged, 'exit 1 does not merge')
            t.equal(exited.result, FIX_FAILURE_TEXT.exit, 'exit reason')

            const idleAgent = fakeAgent(() => {})
            const idle = await runFixer(
                passOpts(repoRoot), { spawnAgent:idleAgent.spawnAgent },
                FINDINGS
            )
            t.ok(!idle.merged, 'no commits does not merge')
            t.equal(idle.result, FIX_FAILURE_TEXT['no-commits'],
                'no-commits reason')
        })
    })

test('runFixer - AC6.4 a retry sees the previous attempt\'s notes',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent((cwd, call) => {
                if (call === 1) {
                    mkdirSync(join(cwd, '.nightralph'),
                        { recursive:true })
                    writeFileSync(
                        join(cwd, '.nightralph', 'notes.md'),
                        'NOTES-TOKEN'
                    )
                    return { exitCode:1 }
                }
                commitIn(cwd, 'fix.ts')
            })
            await runFixer(
                passOpts(repoRoot, { retries:1 }),
                { spawnAgent:agent.spawnAgent },
                FINDINGS
            )
            t.ok(!agent.calls[0].prompt.includes('NOTES-TOKEN'),
                'first prompt has no notes')
            t.ok(agent.calls[1].prompt.includes('NOTES-TOKEN'),
                'retry prompt carries them')
        })
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: esbuild reports `No matching export "runFixer"`.

- [ ] **Step 3: Implement the fixer in `src/review.ts`**

Extend the imports with `commitDirty`, `hasNewCommits`, `isDirty` from
`./worktree.js` and `mergeBranch` from `./merge.js`. Then:

```ts
export type FixResult = {
    merged:boolean
    // checked per the fixer's [x] lines when merged; all
    // unchecked otherwise
    findings:Finding[]
    attempts:number
    effort?:EffortLevel
    exitCode:number|null
    result:string
    notes:string|null
}

// Asks an agent to fix the findings in a fresh worktree off the
// branch tip. Its work merges only after a green test gate;
// every failure is retried like a ticket.
export async function runFixer (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    findings:ReadonlyArray<Finding>
):Promise<FixResult> {
    const unchecked = findings.map(f => ({ ...f, checked:false }))
    let previous:{ reason:FixFailure; notes:string|null }|undefined

    return runWithRetries<FixResult>({
        maxAttempts:opts.retries + 1,
        retryDelay:opts.retryDelay,
        agentCmd:opts.agentCmd,
        effort:opts.effort,
        label:'review fix',
        log:opts.log,
    }, async (attempt, effort) => {
        const fail = (
            reason:FixFailure,
            exitCode:number|null,
            notes:string|null
        ) => {
            previous = { reason, notes }
            opts.log(`  review fix: ${FIX_FAILURE_TEXT[reason]}`)
            return {
                result:{
                    merged:false,
                    findings:unchecked,
                    attempts:attempt,
                    effort,
                    exitCode,
                    result:FIX_FAILURE_TEXT[reason],
                    notes,
                },
                stop:false,
            }
        }

        const wt = await createNamedWorktree({
            repoRoot:opts.repoRoot,
            repoName:opts.repoName,
            baseBranch:opts.baseBranch,
            name:'review-fix',
        })
        try {
            if (opts.installCmd && !(await runStep(
                opts, deps, opts.installCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt,
                    '.install.log'
                )
            ))) {
                return fail('install', null, null)
            }
            ensureNotesIgnored(wt.worktreePath)
            const agent = await deps.spawnAgent({
                prompt:renderFixPrompt({
                    specBody:opts.specBody,
                    findings,
                    testCmd:opts.testCmd,
                    installCmd:opts.installCmd,
                    previous,
                }),
                agentCmd:opts.agentCmd,
                model:opts.model,
                timeout:opts.timeout,
                logPath:logPath(
                    opts.logsDir, 'review-fix', attempt, '.log'
                ),
                cwd:wt.worktreePath,
                label:'review-fix',
                maxTurns:opts.maxTurns,
                effort,
                onLine:opts.log,
            })
            // Before any auto-commit, so notes never get committed
            const notes = collectNotes(wt.worktreePath)

            if (!agent.timedOut && agent.exitCode !== 0) {
                return fail('exit', agent.exitCode, notes)
            }
            if (isDirty(wt.worktreePath)) {
                await commitDirty(
                    wt.worktreePath,
                    'nightralph: auto-commit review fix ' +
                    'remaining changes'
                )
            }
            if (!hasNewCommits(
                opts.repoRoot, opts.baseBranch, wt.branchName
            )) {
                return fail('no-commits', agent.exitCode, notes)
            }
            if (!(await runStep(
                opts, deps, opts.testCmd, wt.worktreePath,
                logPath(opts.logsDir, 'review-fix', attempt, '.test.log')
            ))) {
                return fail('tests', agent.exitCode, notes)
            }
            const merged = await mergeBranch(
                opts.repoRoot, wt.branchName
            )
            if (!merged.success) {
                return fail(
                    'merge',
                    agent.exitCode,
                    [notes, merged.stderr].filter(Boolean)
                        .join('\n\n') || null
                )
            }
            opts.log('  review fix: merged')
            return {
                result:{
                    merged:true,
                    findings:markFixed(findings, agent.completedItems),
                    attempts:attempt,
                    effort,
                    exitCode:agent.exitCode,
                    result:'merged',
                    notes,
                },
                stop:true,
            }
        } finally {
            await discardWorktree(opts, wt)
        }
    })
}
```

Check `mergeBranch`'s signature in `src/merge.ts`
(`mergeBranch(repoRoot, branch)` returning `GitOpResult`) before
relying on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts test/review-pass.test.ts
git commit -m "feat(review): test-gated fixer"
```

---

### Task 10: The review pass, end to end

**Files:**
- Modify: `src/review.ts`, `src/orchestrator.ts`
  (`runWavesIsolated`), `src/index.ts`
- Create: `test/mock-agent-review.js`,
  `test/review-integration.test.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: everything above; `appendEntry` (`src/learnings.ts`),
  `commitProgress` (`src/progress.ts`), `headCommit`, `mergeBase`,
  `isAncestor`, `hasChangesOutside` (Task 3).
- Produces: `readReviewEntries(path:string):ReviewEntry[]`,
  `runReviewPass(opts:ReviewPassOpts, deps:ReviewDeps):
  Promise<ReviewOutcome>`; `runWavesIsolated` option
  `review?:{ reviewPath:string; forkedFrom?:string }`.

- [ ] **Step 1: Write the mock agent**

Create `test/mock-agent-review.js`:

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Plays every role in a run, picked from the prompt:
//   reviewer  (prompt has the review marker)  per MOCK_REVIEW:
//             findings | clean | none
//   fixer     (prompt has the findings marker) per MOCK_FIX:
//             pass | break
//   ticket    otherwise, per MOCK_TICKET: pass | fail
// Each run writes { time, role, cwd } into MOCK_RECORD_DIR.

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

function commitFile (name) {
    writeFileSync(join(process.cwd(), name), String(Date.now()))
    execSync(`git add ${name}`, { stdio:'ignore', env:GIT_ENV })
    execSync('git commit -m "mock change" --no-verify',
        { stdio:'ignore', env:GIT_ENV })
}

function writeFindings (text) {
    mkdirSync(join(process.cwd(), '.nightralph'), { recursive:true })
    writeFileSync(
        join(process.cwd(), '.nightralph', 'findings.md'), text
    )
}

function run (prompt) {
    const role = prompt.includes('---- REVIEW INSTRUCTIONS ----') ?
        'reviewer' :
        prompt.includes('---- REVIEW FINDINGS ----') ?
            'fixer' :
            'ticket'
    writeFileSync(
        join(process.env.MOCK_RECORD_DIR,
            `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ time:Date.now(), role, cwd:process.cwd() })
    )

    if (role === 'reviewer') {
        const mode = process.env.MOCK_REVIEW
        if (mode === 'findings') {
            writeFindings(
                '- [ ] mock finding one\n' +
                '    src/x.ts:1 breaks\n' +
                '- [ ] mock finding two\n'
            )
        } else if (mode === 'clean') {
            writeFindings('No findings.\n')
        }
        process.exit(0)
    }
    if (role === 'fixer') {
        if (process.env.MOCK_FIX === 'break') {
            commitFile('broken.txt')
        } else {
            commitFile(`fix-${randomUUID()}.ts`)
            process.stdout.write('[x] mock finding one\n')
        }
        process.exit(0)
    }
    if (process.env.MOCK_TICKET === 'fail') process.exit(1)
    commitFile(`mock-change-${randomUUID()}.ts`)
    process.exit(0)
}

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    run(Buffer.concat(chunks).toString('utf8'))
})
```

`chmod +x test/mock-agent-review.js`. Ticket commits use the
`mock-change-` prefix so `scripts/test.sh` cleanup still applies if a
run ever leaks one into the repo root.

- [ ] **Step 2: Write the failing integration tests**

Create `test/review-integration.test.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, readFileSync,
    readdirSync, existsSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import type { Display } from '../src/display.js'
import { runWavesIsolated, scanTickets } from '../src/orchestrator.js'
import { parseReviewEntries } from '../src/review.js'

const MOCK = join(process.cwd(), 'test', 'mock-agent-review.js')
const FEAT = 'feat'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Test',
    GIT_COMMITTER_EMAIL:'test@example.com',
    GIT_AUTHOR_NAME:'Test',
    GIT_AUTHOR_EMAIL:'test@example.com',
}

function git (cwd:string, args:string[]):string {
    return execFileSync('git', args, {
        cwd, env:GIT_ENV, encoding:'utf8',
    }).trim()
}

function quietDisplay ():Display {
    const noop = ():void => {}
    return {
        startRun:noop, startWave:noop, setTicketStatus:noop,
        setBlocked:noop, log:noop, cleanup:noop,
    }
}

type Roles = { reviewer:number; fixer:number; ticket:number }

function countRoles (recordDir:string):Roles {
    const counts:Roles = { reviewer:0, fixer:0, ticket:0 }
    for (const f of readdirSync(recordDir)) {
        const { role } = JSON.parse(
            readFileSync(join(recordDir, f), 'utf8')
        ) as { role:keyof Roles }
        counts[role]++
    }
    return counts
}

type Harness = {
    projectDir:string
    recordDir:string
    reviewPath:string
    run:(review?:boolean) => Promise<{
        allDone:boolean
        branch:string
    }>
}

const ENV_KEYS = [
    'MOCK_RECORD_DIR', 'MOCK_REVIEW', 'MOCK_FIX', 'MOCK_TICKET',
] as const

async function withHarness (
    env:Partial<Record<typeof ENV_KEYS[number], string>>,
    fn:(h:Harness) => Promise<void>
):Promise<void> {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'nightralph-ri-'))
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    const saved = Object.fromEntries(
        ENV_KEYS.map(k => [k, process.env[k]])
    )
    const originalCwd = process.cwd()
    try {
        execFileSync('git', ['init', `--template=${templateDir}`],
            { cwd:projectDir, stdio:'ignore' })
        execSync('git config core.excludesFile /dev/null',
            { cwd:projectDir })
        execSync('git config core.hooksPath /dev/null',
            { cwd:projectDir })
        const base = join(projectDir, '.scratch', FEAT)
        const issuesDir = join(base, 'issues')
        mkdirSync(issuesDir, { recursive:true })
        writeFileSync(join(projectDir, '.gitignore'),
            '.scratch/*/logs/\n')
        writeFileSync(join(issuesDir, '01-only.md'),
            '# Ticket\n\n**Status:** ready-for-agent\n')
        git(projectDir, ['add', '-A'])
        git(projectDir, ['commit', '-m', 'init'])
        git(projectDir, ['branch', '-M', 'main'])

        process.env.MOCK_RECORD_DIR = recordDir
        for (const [k, v] of Object.entries(env)) process.env[k] = v
        process.chdir(projectDir)

        const reviewPath = join(base, 'review.md')
        await fn({
            projectDir,
            recordDir,
            reviewPath,
            run:(review = true) => runWavesIsolated({
                tickets:scanTickets(issuesDir, FEAT),
                specBody:'SPEC',
                specBodies:new Map([[FEAT, 'SPEC']]),
                progressPaths:new Map([
                    [FEAT, join(base, 'progress.md')],
                ]),
                agentCmd:MOCK,
                model:null,
                timeout:30,
                logsDir:join(base, 'logs'),
                featureName:FEAT,
                conflictStrategy:'respawn',
                display:quietDisplay(),
                testCmd:'test ! -f broken.txt',
                retries:0,
                retryDelay:0,
                review:review ? { reviewPath } : undefined,
            }),
        })
    } finally {
        process.chdir(originalCwd)
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) {
                Reflect.deleteProperty(process.env, k)
            } else {
                process.env[k] = saved[k]
            }
        }
        rmSync(projectDir, { recursive:true, force:true })
        rmSync(recordDir, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
}

function committedEntries (projectDir:string, reviewPath:string) {
    const rel = reviewPath.slice(projectDir.length + 1)
    return parseReviewEntries(
        git(projectDir, ['show', `HEAD:${rel}`])
    )
}

test('review pass - AC6.1 AC7.1 a fix merges and the log is ' +
    'committed', async t => {
    await withHarness({
        MOCK_REVIEW:'findings', MOCK_FIX:'pass', MOCK_TICKET:'pass',
    }, async h => {
        const result = await h.run()
        t.ok(result.allDone, 'tickets done')
        t.equal(result.branch, 'main', 'AC2.4 reports the branch')
        t.deepEqual(countRoles(h.recordDir),
            { reviewer:1, fixer:1, ticket:1 }, 'one of each')
        const entries = committedEntries(h.projectDir, h.reviewPath)
        t.equal(entries.length, 1, 'one committed entry')
        t.equal(entries[0].status, 'fixed', 'fixed')
        t.deepEqual(entries[0].findings.map(f => f.checked),
            [true, false], 'the echoed finding is checked')
        t.equal(entries[0].to, git(h.projectDir, ['rev-parse', 'HEAD~1']),
            'marker is the tip after the fix, before the log commit')
    })
})

test('review pass - AC6.2 AC6.3 a red fix merges nothing but ' +
    'the marker advances', async t => {
    await withHarness({
        MOCK_REVIEW:'findings', MOCK_FIX:'break', MOCK_TICKET:'pass',
    }, async h => {
        await h.run()
        t.ok(!existsSync(join(h.projectDir, 'broken.txt')),
            'the broken fix did not merge')
        const [entry] = committedEntries(h.projectDir, h.reviewPath)
        t.equal(entry.status, 'unresolved', 'unresolved')
        t.ok(entry.findings.every(f => !f.checked), 'all unchecked')

        await h.run()
        t.equal(countRoles(h.recordDir).reviewer, 1,
            'a second run does not review the same range')
    })
})

test('review pass - AC4.4 bookkeeping-only changes skip the ' +
    'review', async t => {
    await withHarness({
        MOCK_REVIEW:'findings', MOCK_FIX:'pass', MOCK_TICKET:'fail',
    }, async h => {
        await h.run()
        t.equal(countRoles(h.recordDir).reviewer, 0, 'no reviewer')
        t.ok(!existsSync(h.reviewPath), 'no review log')
    })
})

test('review pass - a clean review, then nothing new to review',
    async t => {
        await withHarness({
            MOCK_REVIEW:'clean', MOCK_FIX:'pass', MOCK_TICKET:'pass',
        }, async h => {
            await h.run()
            const counts = countRoles(h.recordDir)
            t.equal(counts.reviewer, 1, 'reviewed once')
            t.equal(counts.fixer, 0, 'AC5.2 no fixer')
            t.equal(
                committedEntries(h.projectDir, h.reviewPath)[0].status,
                'clean', 'clean entry'
            )
            await h.run()
            t.equal(countRoles(h.recordDir).reviewer, 1,
                'the review log commit does not trigger a review')
        })
    })

test('review pass - AC7.2 a broken review does not change the ' +
    'result', async t => {
    await withHarness({
        MOCK_REVIEW:'clean', MOCK_FIX:'pass', MOCK_TICKET:'pass',
    }, async h => {
        // A directory where the log file should be: appending throws
        mkdirSync(h.reviewPath, { recursive:true })
        writeFileSync(join(h.reviewPath, 'keep'), '')
        git(h.projectDir, ['add', '-A'])
        git(h.projectDir, ['commit', '-m', 'block the log'])
        const result = await h.run()
        t.ok(result.allDone, 'still all done')
    })
})

test('review pass - AC7.3 no review option, no reviewer',
    async t => {
        await withHarness({
            MOCK_REVIEW:'findings', MOCK_FIX:'pass',
            MOCK_TICKET:'pass',
        }, async h => {
            await h.run(false)
            t.equal(countRoles(h.recordDir).reviewer, 0, 'no reviewer')
        })
    })
```

Add `review-integration` to `TESTS` in `scripts/test.sh` after
`integration`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: `review-integration` fails its assertions: esbuild does not
type-check, so the unknown `review` option is silently ignored and no
reviewer runs (`reviewer` count 0, no committed `review.md`).

- [ ] **Step 4: Implement `runReviewPass` in `src/review.ts`**

Extend imports: `existsSync`, `readFileSync` from `node:fs`;
`appendEntry` from `./learnings.js`; `commitProgress` from
`./progress.js`; `hasChangesOutside`, `headCommit`, `isAncestor`,
`mergeBase` from `./worktree.js`. Then:

```ts
export function readReviewEntries (path:string):ReviewEntry[] {
    if (!existsSync(path)) return []
    return parseReviewEntries(readFileSync(path, 'utf8'))
}

// Reviews everything since the last reviewed commit, runs one fix
// pass when there are findings, and appends and commits one entry
// to the review log. Skips entirely when the range only touches
// bookkeeping under REVIEW_EXCLUDE.
export async function runReviewPass (
    opts:ReviewPassOpts,
    deps:ReviewDeps
):Promise<ReviewOutcome> {
    const now = opts.now ?? (() => new Date())
    const to = headCommit(opts.repoRoot)
    const forkPoint = opts.forkedFrom ?
        mergeBase(opts.repoRoot, opts.forkedFrom, to) :
        null
    const from = selectReviewBase(readReviewEntries(opts.reviewPath), {
        isAncestor:sha => isAncestor(opts.repoRoot, sha, to),
        forkPoint,
        launchCommit:opts.launchCommit,
    })
    if (!hasChangesOutside(opts.repoRoot, from, to, REVIEW_EXCLUDE)) {
        opts.log('\nReview: nothing new to review')
        return { status:'skipped', findings:0, fixed:0 }
    }

    opts.log(`\nReviewing ${from.slice(0, 7)}..${to.slice(0, 7)}`)
    const findings = await runReviewer(opts, deps, { from, to })

    let entry:ReviewEntryInput
    if (findings === null) {
        entry = { from, to, status:'review-failed', now:now(),
            findings:[] }
    } else if (findings.length === 0) {
        entry = { from, to, status:'clean', now:now(), findings:[] }
    } else {
        opts.log(
            `Review: ${findings.length} finding` +
            `${findings.length === 1 ? '' : 's'}`
        )
        const fix = await runFixer(opts, deps, findings)
        entry = {
            from,
            // A merged fix counts as reviewed
            to:fix.merged ? headCommit(opts.repoRoot) : to,
            status:fix.merged ? 'fixed' : 'unresolved',
            now:now(),
            findings:fix.findings,
            fix:{
                attempts:fix.attempts,
                maxAttempts:opts.retries + 1,
                effort:fix.effort,
                exitCode:fix.exitCode,
                result:fix.result,
                notes:fix.notes,
            },
        }
    }

    appendEntry(opts.reviewPath, renderReviewEntry(entry))
    await commitProgress(
        opts.repoRoot, opts.reviewPath, 'nightralph: record review'
    )
    return {
        status:entry.status,
        findings:entry.findings.length,
        fixed:entry.findings.filter(f => f.checked).length,
    }
}
```

- [ ] **Step 5: Wire it into `runWavesIsolated`**

In `src/orchestrator.ts`, import `runReviewPass` and
`renderReviewSummary` from `./review.js` and `relative` from
`node:path`. Add to the options type:

```ts
    // review the unreviewed work and run one fix pass at the end;
    // unset = no review
    review?:{
        reviewPath:string
        // the default branch, when this run is on an
        // integration branch
        forkedFrom?:string
    }
```

Add a helper near `lookupSpec`:

```ts
// The spec text for the review: the one spec, or every feature's
// spec under its own heading for a multi-feature run.
function reviewSpecBody (
    specBody:string,
    specBodies?:Map<string, string>
):string {
    if (!specBodies || specBodies.size <= 1) return specBody
    return [...specBodies]
        .map(([name, body]) => `# Feature: ${name}\n\n${body}`)
        .join('\n\n')
}
```

Replace the end of `runWavesIsolated` (from
`if (waveNum > 0) reportBlocked(...)`) with:

```ts
    if (waveNum > 0) reportBlocked(d, opts.tickets, failedKeys)

    // Advisory, like learnings: a broken review is reported and
    // never changes the run's result.
    let reviewLine:string|null = null
    if (opts.review) {
        try {
            const outcome = await runReviewPass({
                repoRoot,
                repoName,
                baseBranch,
                reviewPath:opts.review.reviewPath,
                forkedFrom:opts.review.forkedFrom,
                launchCommit,
                specBody:reviewSpecBody(
                    opts.specBody, opts.specBodies
                ),
                agentCmd:opts.agentCmd,
                model:opts.model,
                timeout:opts.timeout,
                logsDir:opts.logsDir,
                testCmd:opts.testCmd,
                installCmd:opts.installCmd,
                maxTurns:opts.maxTurns,
                effort:opts.effort,
                retries,
                retryDelay,
                log:(msg) => d.log(msg),
            }, { spawnAgent, registry:runningAgents })
            reviewLine = renderReviewSummary(
                outcome, relative(repoRoot, opts.review.reviewPath)
            )
        } catch (err) {
            d.log(`\nReview failed: ${formatErrorMessage(err)}`)
        }
    }

    const remaining = opts.tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    d.log('\n' + renderFinishSummary(
        opts.tickets, totalCompleted, failedKeys
    ))
    if (reviewLine) d.log(reviewLine)
    d.log(`Work is on ${baseBranch}`)
    d.cleanup()

    return { allDone:remaining.length === 0, branch:baseBranch }
```

- [ ] **Step 6: Pass the review from the CLI**

In `src/index.ts`, in the `runWavesIsolated({...})` call, add:

```ts
            review:argv.review === false ?
                undefined :
                {
                    reviewPath:reviewPathFor(loaded.issuesDirs),
                    forkedFrom:plan?.forkedFrom ?? undefined,
                },
```

with this helper above `runExecute`:

```ts
// One feature keeps its review log next to its progress file; a
// multi-feature run reviews one combined diff, so its log sits in
// .scratch/ itself.
function reviewPathFor (issuesDirs:string[]):string {
    const featureDir = dirname(issuesDirs[0])
    return issuesDirs.length === 1 ?
        join(featureDir, 'review.md') :
        join(dirname(featureDir), 'review.md')
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS, every suite.

- [ ] **Step 8: Commit**

```bash
git add src/review.ts src/orchestrator.ts src/index.ts \
    test/mock-agent-review.js test/review-integration.test.ts \
    scripts/test.sh
git commit -m "feat(review): review and fix pass at the end of a run"
```

---

### Task 11: Docs

**Files:**
- Modify: `AGENTS.md`, `README.md`

- [ ] **Step 1: Update `AGENTS.md`**

Bump `Last verified` to the current date. Then:

1. Project Structure: add `src/retry.ts` (shared retry loop and effort
   ladders), `src/rules.ts` (prompt rule lines), `src/review.ts`
   (review log, reviewer, fixer, review pass).
2. CLI: `--no-review`; integration branch behavior (created or
   resumed only when launched from the default branch, entered before
   tickets are scanned, re-scan on resume); `--dry-run` prints the
   branch decision and whether review is on.
3. orchestrator: the moved effort symbols are re-exported from
   `retry.ts`; `TicketOutcome`'s `'no-commits'` `agentRun` is no
   longer nullable (drop the placeholder sentence);
   `runWavesIsolated` gains `review` and returns `{ allDone, branch }`,
   logs `Work is on <branch>` and the review line after the finish
   summary, records the launch commit; review is advisory.
4. worktree: `getCurrentBranch(cwd?)`, `localBranchExists`,
   `getDefaultBranch`, `integrationBranchName`,
   `planIntegrationBranch`, `IntegrationPlan`,
   `prepareIntegrationBranch`, `describeIntegrationBranch`,
   `createNamedWorktree`, `deleteBranch` (both on the same queue as
   `createWorktree`), `headCommit`, `mergeBase`, `isAncestor`,
   `hasChangesOutside`. Fix the existing `buildBranchName` entry to
   the real signature `(repoName, ticket)`.
5. learnings: `collectNotes(worktreePath, file?)`; `formatDate` is
   exported.
6. New `retry` section: `runWithRetries` contract (stop/attempt cap,
   escalation for known providers, `retryDelayFor` backoff, at least
   one attempt).
7. New `review` section: everything under the spec's Design section
   that a caller relies on -- file locations, entry format and
   statuses, marker rule, range fallback order, `.scratch` exclusion
   and skip rule, reviewer success rule, fixer gate and merge, retry
   behavior, `deps`, advisory error handling, imports no values from
   the orchestrator.

Follow the existing contract style (bold names, terse clauses, `--`
not em dashes).

- [ ] **Step 2: Update `README.md`**

Add a section after "Progress" (match the existing heading level and
add it to the toc block):

```markdown
### Integration branch

Launched from your default branch (`main`), nightralph does not merge
into it. It creates `nightralph--<feature>` (or `nightralph--all` for
several features), merges every ticket there, and leaves you on that
branch. Running again from `main` resumes the same branch, so finished
tickets stay finished. Launched from any other branch, it merges into
that branch.

### Review

After the last wave, an agent reviews everything merged since the last
review and writes its findings to `review.md` next to `progress.md`. A
second agent fixes them test-first; its work merges only if the test
command passes. Findings it could not fix stay unchecked in
`review.md`. Skip this with `--no-review`.
```

- [ ] **Step 3: Check docs for banned characters**

Run: `grep -nP '[\x{2014}\x{2192}]' AGENTS.md README.md || echo clean`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: integration branch and review pass"
```
