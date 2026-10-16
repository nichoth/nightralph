# Feature Graph Implementation Plan -- Phase 5

**Goal:** `nightralph graph [--spec <name>]` prints the report.

**Architecture:** A `.command('graph', ...)` in `src/index.ts`,
registered right after `init` so yargs matches it before the
`$0 <provider> [turns]` default command. Its handler is a thin shell:
it picks the feature names (the picker's `findFeatureDirs`, or the
one `--spec` name), checks they exist, and prints
`renderGraph(buildGraph(load, names))` with
`load = names => loadSelection(scratchDir, names)`. It is read-only:
no provider preflight, no git, no writes. The picker's no-features
message moves into an exported constant so `graph` and the picker
print the same text.

**Tech Stack:** TypeScript (ESM, Node >= 24), yargs, esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 5 of 6 from
`docs/design-plans/2026-10-09-feature-graph.md`

**Codebase verified:** 2026-10-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### feature-graph.AC2: `graph` command output
- **feature-graph.AC2.1 Success:** `nightralph graph` exits 0 and prints
  one block per picker feature that has cross-feature edges
- **feature-graph.AC2.4 Success:** `--spec x` prints only x's block, or
  a not-waiting line when x is unblocked
- **feature-graph.AC2.5 Success:** `--spec` accepts a nested name
  (`a/b`) and a feature the picker hides
- **feature-graph.AC2.6 Failure:** `--spec` with an unknown name exits
  2 with an error on stderr, without reaching the picker
- **feature-graph.AC2.7 Failure:** No `.scratch` features exits 2 with
  the picker's error
- **feature-graph.AC2.8 Edge:** `graph` is never taken for a provider:
  no preflight, no git, no files written

---

## Codebase facts the executor needs

- `src/index.ts` (698 lines):
  - imports from `./resolve.js` at lines 30-37: `findFeatureDirs`,
    `resolveIssuesDir`, `getScriptDir`, `loadSelection`,
    `type FeatureSelection`, `type BlockerWarning`. `existsSync` and
    `join` are already imported (lines 4-5).
  - The yargs chain starts at line 54. `init` is registered at lines
    57-100 (`.command('init', 'Install bundled skills and doc
    templates', y => y, async () => {...})`). The default command
    `.command('$0 <provider> [turns]', ...)` starts at line 101.
    `.strict()` is at line 235, `.fail(...)` at 238-252 (a thrown
    handler error prints one line to stderr and exits 2), `.parse()`
    follows. Helper functions such as `isGitRepo` are declared after
    `.parse()` (line ~254), and are hoisted.
  - Nothing at import time runs git or preflight. Signal handlers
    are installed inside `runExecute` (line ~643).
  - The run command's missing-feature wording comes from `loadTickets`
    (line ~317): `Directory not found: ${dir}` on stderr, exit 2,
    where `dir` is `<cwd>/.scratch/<name>/issues`.
- `src/resolve.ts:197-205`, inside `resolveIssuesDir`, is the picker's
  no-features error:
  ```ts
  if (features.length === 0) {
      console.error(
          'No .scratch/<feature>/issues/ directories ' +
          'found.\nProvide --spec <feature-name>.'
      )
      process.exit(2)
  }
  ```
- `findFeatureDirs(cwd)` (`src/resolve.ts:31-63`) lists top-level
  `.scratch/<name>/` dirs that have an `issues` subdir and whose
  `progress.md` is not complete (`isSpecComplete`), sorted. So nested
  features and complete features are hidden from the picker.
- `src/progress.ts`: `generateProgress(feature, tickets)` (line 26),
  `checkTicket(data, ticketNum, { branch, exitCode, done? })` (line
  207), `writeProgress(path, data)` (line 225),
  `isSpecComplete(path)` (line 85: every ticket in progress.md done).
- `test/integration.test.ts` (6000+ lines; grep, never read whole):
  - runs the built CLI, so `npm run build` must run before the suite.
  - `tmp()` at line 39: `mkdtempSync(join(tmpdir(),
    'nightralph-int-test-'))`.
  - `spawnCli(args, { cwd?, env?, closeStdin? })` at lines 220-250
    resolves `{ code, stdout, stderr }`; 30s timeout; stdin stays
    open unless `closeStdin:true`.
  - The test `CLI subprocess - error for nonexistent feature` (line
    ~437) is the model for a failing-command test: `try { ... }
    finally { rmSync(projectDir, { recursive:true, force:true }) }`,
    asserting the code and `stderr.includes(...)`.
  - Existing imports already cover the fixtures: `mkdtempSync`,
    `mkdirSync`, `writeFileSync`, `rmSync` and `readdirSync` from
    `node:fs` (lines 2-7); `findFeatureDirs` from
    `'../src/resolve.js'` (lines 14-18); `scanTickets` from
    `'../src/orchestrator.js'` (line ~22). Line 34 is
    `import { readProgress } from '../src/progress.js'`; extend it to
    `import { readProgress, generateProgress, checkTicket,
    writeProgress } from '../src/progress.js'` (wrapped under 80
    columns).
- Tests must not pin whole sentences: assert exit codes, presence or
  absence of ticket labels and feature names, and stream emptiness.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Share the picker's no-features message

**Verifies:** None (refactor; existing behavior unchanged)

**Files:**
- Modify: `src/resolve.ts` -- add an exported constant above
  `resolveIssuesDir` (line ~182) and use it at lines 199-205

**Implementation:**

```ts
export const NO_FEATURES_MESSAGE =
    'No .scratch/<feature>/issues/ directories found.\n' +
    'Provide --spec <feature-name>.'
```

and in `resolveIssuesDir`:

```ts
if (features.length === 0) {
    console.error(NO_FEATURES_MESSAGE)
    process.exit(2)
}
```

**Verification:**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: exit code 0 and no `error TS` lines (the command also
prints a file list; that is normal)

**Commit:** do not commit yet; Task 3 commits.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: The `graph` subcommand

**Verifies:** None (implementation; Task 3 tests it)

**Files:**
- Modify: `src/index.ts:30-37` -- add `NO_FEATURES_MESSAGE` to the
  `./resolve.js` import
- Modify: `src/index.ts` imports -- add
  `import { buildGraph, renderGraph } from './graph.js'` after the
  `./resolve.js` import block
- Modify: `src/index.ts:100-101` -- insert the command between the
  end of `init` and `.command('$0 <provider> [turns]'`
- Modify: `src/index.ts` -- add `function runGraph` just before
  `function isGitRepo` (after `.parse()`)

**Implementation:**

```ts
    .command(
        'graph',
        'Show which features wait on tickets in other features',
        y => y.option('spec', {
            type:'string',
            describe:'Feature name (resolves .scratch/<name>/); ' +
                'shows that feature and what it waits on',
        }),
        argv => runGraph(argv.spec)
    )
```

```ts
// Read-only: no provider, no git, no writes. Reads the current
// checkout, like the picker.
function runGraph (spec:string|undefined):void {
    const cwd = process.cwd()
    const scratchDir = join(cwd, '.scratch')
    let names:string[]
    if (spec) {
        const dir = join(scratchDir, spec, 'issues')
        if (!existsSync(dir)) {
            console.error(`Directory not found: ${dir}`)
            process.exit(2)
        }
        names = [spec]
    } else {
        names = findFeatureDirs(cwd).map(f => f.name)
        if (names.length === 0) {
            console.error(NO_FEATURES_MESSAGE)
            process.exit(2)
        }
    }
    const { reports, warnings } = buildGraph(
        list => loadSelection(scratchDir, list),
        names
    )
    console.log(renderGraph(reports, warnings))
}
```

`--spec ""` is falsy and behaves like no `--spec`, as it does for the
run command (`resolveIssuesDir` checks `if (specName)`).

**Verification:**

Run: `npm run build && node dist/index.js --help`
Expected: the help lists a `graph` command

**Commit:** do not commit yet; Task 3 commits with the tests.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: CLI subprocess tests for `graph`

**Verifies:** feature-graph.AC2.1, feature-graph.AC2.4,
feature-graph.AC2.5, feature-graph.AC2.6, feature-graph.AC2.7,
feature-graph.AC2.8

**Files:**
- Modify: `test/integration.test.ts` -- add a
  `// -- graph command --` section at the end of the file

**Implementation (helper, in the new section):**

`graphProject(features:Record<string, Array<[num:number,
status:string, blockedBy:string]>>):string` creates `tmp()` and, for
each entry, `.scratch/<name>/spec.md` and
`.scratch/<name>/issues/<NN>-t.md` with body
`# T\n\n**Status:** ${status}\n**Blocked by:** ${blockedBy}\n`
(`name` may contain `/`; use `mkdirSync(..., { recursive:true })`).
Returns the project dir. The base fixture:

```ts
const GRAPH_BASE = {
    'held-import-review':[
        [1, 'ready-for-agent', 'newsletter-audit 16'],
        [2, 'ready-for-agent', '01'],
    ],
    'newsletter-audit':[[16, 'ready-for-agent', 'None']],
    'analytics':[[1, 'ready-for-agent', 'None']],
}
```

Every test removes its project dir in `finally`.

**Testing:**

- AC2.1: `spawnCli(['graph'], { cwd })` on `GRAPH_BASE`: `code` 0;
  `stdout` contains `held-import-review/01` and
  `newsletter-audit/16`; exactly one stdout line starts (column 0)
  with `held-import-review`; no stdout line starts with
  `newsletter-audit` or `analytics` (they are unblocked, so they
  appear only inside the one not-waiting line).
- AC2.4: `['graph', '--spec', 'held-import-review']`: code 0, stdout
  contains `held-import-review/01` and does not contain `analytics`.
  `['graph', '--spec', 'analytics']`: code 0, stdout contains
  `analytics` and contains neither `held-import-review` nor
  `newsletter-audit/`.
- AC2.5 (nested): add `rollout/billing` with
  `[1, 'ready-for-agent', 'newsletter-audit 16']`.
  `['graph', '--spec', 'rollout/billing']`: code 0, stdout contains
  `rollout/billing/01` and `newsletter-audit/16`.
- AC2.5 (hidden): add `finished` with
  `[1, 'ready-for-agent', 'newsletter-audit 16']`, then write
  `.scratch/finished/progress.md` with
  `generateProgress('finished', scanTickets(<its issues dir>,
  'finished'))`, `checkTicket(data, 1, { branch:'b', exitCode:0,
  done:true })` and `writeProgress(...)` from `'../src/progress.js'`.
  First assert `findFeatureDirs(cwd)` (from `'../src/resolve.js'`)
  does not list `finished`, so the fixture really is hidden. Then
  `['graph', '--spec', 'finished']`: code 0, stdout contains
  `finished/01`.
- AC2.6: `['graph', '--spec', 'nope']` on `GRAPH_BASE` (two or more
  features, so the run command would reach the picker), stdin left
  open: `code` 2, `stderr` contains `nope`, `stdout` is empty. With
  stdin open, reaching the picker would hang to the 30s timeout
  instead of exiting 2.
- AC2.7: a `tmp()` dir with no `.scratch`: `['graph']` gives code 2
  and a non-empty `stderr` that contains `.scratch`. Also a project
  whose only feature is complete (the `finished` setup above, alone)
  gives code 2.
- AC2.8: `GRAPH_BASE` in a `tmp()` dir that is not a git repo.
  Record a recursive listing of the dir
  (`readdirSync(cwd, { recursive:true })`, sorted) before and after
  `['graph']`; they deep-equal. `code` is 0, and neither stream
  contains `Provider` (the preflight line) or `nightralph--` (an
  integration branch name).

**Verification:**

Run: `npm run build && npm test`
Expected: every suite passes, including the new `graph command`
tests in the integration suite

Run: `npm run lint`
Expected: no errors

**Commit:**

```bash
git add src/index.ts src/resolve.ts test/integration.test.ts
git commit -m "feat: add the nightralph graph command"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
