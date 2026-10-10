# Feature graph -- human test plan

Plan: `docs/implementation-plans/2026-10-09-feature-graph/`.
Automated coverage: 24 of 24 automated criteria (AC1.1-AC1.6,
AC2.1-AC2.11, AC3.1-AC3.7) have tests; AC4.1 and AC4.2 are checked
by hand below. Validated at `6bbeddd`.

## Prerequisites

- Node >= 24, repo at `/Users/nick/code/nightralph` on `feature-graph`.
- `npm run build && npm test` passes (several minutes).
- `NR=/Users/nick/code/nightralph/dist/index.js`
- A scratch fixture outside any git repo, and a helper to write
  tickets:

  ```sh
  FX=$(mktemp -d); cd "$FX"
  tk () { # feature num status blocked-by
    mkdir -p ".scratch/$1/issues"; echo "# $1" > ".scratch/$1/spec.md"
    printf '# T\n\n**Status:** %s\n**Blocked by:** %s\n' "$3" "$4" \
      > ".scratch/$1/issues/$(printf %02d "$2")-t.md"; }
  tk newsletter-audit 15 ready-for-agent None
  tk newsletter-audit 16 ready-for-agent 15
  tk newsletter-audit 18 ready-for-agent "15, 16"
  tk held-import-review 1 ready-for-agent "newsletter-audit 16"
  tk held-import-review 2 ready-for-agent "newsletter-audit 15"
  tk held-import-review 3 ready-for-agent 01
  tk held-import-review 4 ready-for-agent 02
  tk held-import-review 5 ready-for-agent "03, 04"
  tk held-import-review 6 ready-for-agent "newsletter-audit 18"
  tk analytics 1 ready-for-agent None
  ```

- Clean up afterwards: `rm -rf "$FX"`.

## graph output (rebase.blog fixture)

| Step | Action | Expected |
|------|--------|----------|
| 1 | `node $NR graph; echo "exit=$?"` | Exit 0, no picker. One block opens with `held-import-review (0/6 ready)`. |
| 2 | Read the block | A group header for held-import-review waiting on newsletter-audit (no ticket refs on it), then three ref lines: /01 -> newsletter-audit/16, /02 -> /15, /06 -> /18, each marked ready-for-agent. |
| 3 | Read the lines after the refs | A "Run together" line names held-import-review and newsletter-audit and says to select both in the picker; the count line under it says 6 of 6 become runnable. No "stays blocked" or "deadlocked" line. |
| 4 | Read the last line | One line lists analytics and newsletter-audit as not waiting on other features; neither has its own block. |
| 5 | `diff <(node $NR graph) <(node $NR graph)` | No diff (deterministic). |

## Picker label

`--dry-run` reaches the picker before the provider check
(`src/index.ts`), so no provider needs to be installed.

| Step | Action | Expected |
|------|--------|----------|
| 1 | In `$FX`: `node $NR claude --dry-run` | The interactive feature picker opens. |
| 2 | Look at the held-import-review choice | Label like `(0/6 ready, waits on newsletter-audit)`; R/T is the run-alone count. |
| 3 | Look at analytics and newsletter-audit | No "waits on" clause; labels look as before this change. |
| 4 | Ctrl-C | Picker exits; `find "$FX" -newer "$FX/.scratch/analytics/spec.md"` lists nothing new. |
| 5 | `tk held-import-review 7 ready-for-agent "newsletter-audit 40"`, reopen the picker | Bad-blocker count comes before "waits on": `R/T ready, 1 bad blocker, waits on newsletter-audit`. Then `rm .scratch/held-import-review/issues/07-t.md`. |
| 6 | `tk zeta 1 ready-for-agent None; tk held-import-review 8 ready-for-agent "zeta 01"`, reopen | Label names newsletter-audit and zeta, sorted, neither truncated even in a narrow terminal. Then `rm -r .scratch/zeta .scratch/held-import-review/issues/08-t.md`. |

## --spec variants and failures

| Step | Action | Expected |
|------|--------|----------|
| 1 | `node $NR graph --spec held-import-review` | Exit 0; only the held-import-review block; analytics not mentioned. |
| 2 | `node $NR graph --spec analytics` | Exit 0; one not-waiting line naming analytics; no held-import-review or newsletter-audit ticket refs. |
| 3 | `tk rollout/billing 1 ready-for-agent "newsletter-audit 16"`, then `node $NR graph --spec rollout/billing` | Exit 0; `rollout/billing/01` waits on `newsletter-audit/16`. The Run together hint says rollout/billing is not in the picker. |
| 4 | `node $NR graph` after step 3 | rollout/billing gets no block of its own (the picker does not list nested features). Then `rm -r .scratch/rollout`. |
| 5 | `tk launch 1 ready-for-agent "rollout/billing 01"; tk rollout/billing 1 ready-for-agent "newsletter-audit 16"`, then `node $NR graph` | launch's Run together line lists launch, newsletter-audit, rollout/billing; its parenthetical says rollout/billing is not in the picker instead of telling you to select them (user-approved change). Then `rm -r .scratch/launch .scratch/rollout`. |
| 6 | `node $NR graph --spec nope; echo "exit=$?"` (stdin is the terminal) | Returns at once, exit 2; stderr names the missing `.scratch/nope/issues` path; stdout empty; no picker. |
| 7 | `node $NR graph --spec a --spec b; echo "exit=$?"` | Exit 2, one short error, no `at ...` stack frames. |
| 8 | `cd "$(mktemp -d)" && node $NR graph; echo "exit=$?"` | Exit 2; stderr is the picker's no-features message, mentioning `.scratch`. |
| 9 | In a new empty dir: `tk finished 1 ready-for-agent None`, mark it complete (below), then `node $NR graph; echo $?` and `node $NR graph --spec finished; echo $?` | Plain `graph` exits 2 (no picker features); `--spec finished` exits 0 and names `finished`. |

Marking `finished` complete:

```sh
node --input-type=module -e "
import { generateProgress, checkTicket, writeProgress }
    from '/Users/nick/code/nightralph/dist/progress.js'
import { scanTickets } from '/Users/nick/code/nightralph/dist/orchestrator.js'
const d = generateProgress('finished',
    scanTickets('.scratch/finished/issues', 'finished'))
checkTicket(d, 1, { branch:'b', exitCode:0, done:true })
writeProgress('.scratch/finished/progress.md', d)"
```

## Read-only check

| Step | Action | Expected |
|------|--------|----------|
| 1 | In `$FX`: `find . -type f \| sort > "$TMPDIR/before.txt"; node $NR graph > /dev/null; find . -type f \| sort > "$TMPDIR/after.txt"; diff "$TMPDIR/before.txt" "$TMPDIR/after.txt"` | No diff; no `.nightralph/`, `progress.md`, `learnings.md` or `review.md` appears. |
| 2 | `node $NR graph 2>&1` | No Provider line, no `nightralph--` branch name, no git mention. |
| 3 | Optional: `git init -q` in `$FX`, commit everything, `node $NR graph`, then `git status --porcelain` and `git branch` | Clean tree; no new branch or worktree. Delete `$FX/.git` afterwards. |

## End to end: dead ends and deadlock

Checks that the verified suggestion explains why a selection still
cannot run fully (AC3.4-AC3.6) in a form a person can act on.

1. New fixture dir: `tk alpha 1 ready-for-agent "beta 04"; tk beta 4
   ready-for-human None`, then `node $NR graph`. alpha's block
   suggests alpha and beta; the count says 0 of 1; a "stays blocked"
   line names alpha/01 and beta/04 with the ready-for-human status.
2. `rm -r .scratch; tk alpha 1 ready-for-agent "beta 40"; tk beta 1
   ready-for-agent None`, then `node $NR graph`. alpha's block has no
   Run together line and no picker hint; a "stays blocked" line names
   alpha/01 and beta/40; the not-waiting line names beta only.
3. `rm -r .scratch; tk alpha 1 ready-for-agent "beta 01"; tk beta 1
   ready-for-agent "alpha 01"`, then `node $NR graph`. Returns
   promptly; a deadlocked line after the count names alpha/01 and
   beta/01.
4. `tk alpha 2 ready-for-agent "betta 01"` and rerun. The misspelt
   word appears once, in the last paragraph.

## End to end: suggestion matches a real run

Checks that the Run together set and count agree with what nightralph
would run (AC3.1 with AC3.7).

1. In the rebase.blog fixture, `node $NR graph`; note the suggested
   features and the 6 of 6 count.
2. `node $NR claude --dry-run`; in the picker select exactly the
   features the Run together line named.
3. The dry-run waves include all six held-import-review tickets, and
   none is reported as waiting on a feature outside the run.

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC4.1 | Build and test wiring; a test reading package.json or scripts/test.sh would pin config text | 1. `npm run build && ls dist/graph.js` lists the file. 2. `npm test` output includes graph suite tests (e.g. "AC3.1: rebase.blog suggests both features", the "Run together hint" tests) and no line starts with `not ok`. |
| AC4.2 | Docs only; no tests for docs | AGENTS.md was rewritten (3d3293c) into Project Structure plus cross-module Invariants, so it has no per-module contract sections. Check: 1. Project Structure lists `src/graph.ts`. 2. Invariants say `nightralph graph` is read-only; the `blockerSatisfied` bullet says `graph` checks its suggestion through `simulateRun`, which wraps the `simulateWaves` that `--dry-run` prints; the `renderTypoWarnings` bullet names the finish summary, the nothing-ready explanation and `graph`; Module boundaries explain the injected `LoadFn` and why (`resolve` imports `upstreamOf` from `graph`); the exit-code bullet says every command handler returns a promise. 3. README has a `graph` section after `--spec` and an example after `--dry-run`; its sample matches a real `node $NR graph` run in structure; it covers `--spec` (nested and complete names), Run together (dry-run wave logic, the unlisted-feature hint), the ready-for-agent denominator, stays blocked, deadlocked, the picker label and the limits. 4. `perl -CSD -ne 'print "$.: $_" if /[\x{2014}\x{2192}]/' AGENTS.md README.md` prints nothing. |

## Traceability

| Criterion | Automated test | Manual step |
|-----------|----------------|-------------|
| AC1.1 | resolve.test.ts featureCounts AC1.1 | Picker label 2 |
| AC1.2 | resolve.test.ts featureCounts AC1.2 | Picker label 6 |
| AC1.3 | resolve.test.ts AC1.3, AC1.11 | Picker label 3 |
| AC1.4 | resolve.test.ts AC1.4 | Picker label 3 |
| AC1.5 | resolve.test.ts AC1.5 | Picker label 2 |
| AC1.6 | resolve.test.ts featureChoiceLabel AC1.6 | Picker label 5 |
| AC2.1 | integration "graph - lists the waiting feature" | graph output 1-4 |
| AC2.2 | graph.test.ts AC3.1 data, AC2.2 render | graph output 2 |
| AC2.3 | graph.test.ts AC3.2, AC2.3 | --spec 5 |
| AC2.4 | integration "graph --spec - shows the named feature" | --spec 1-2 |
| AC2.5 | integration nested and complete --spec tests | --spec 3, 9 |
| AC2.6 | integration "unknown feature exits 2 without a picker" | --spec 6 |
| AC2.7 | integration "exits 2 with no features to show" | --spec 8, 9 |
| AC2.8 | integration "read-only, git-free" | Read-only 1-3 |
| AC2.9 | graph.test.ts AC2.9, resolve.test.ts AC1.4 | Dead ends 1 |
| AC2.10 | graph.test.ts AC2.10 and group-order test | graph output 5 |
| AC2.11 | graph.test.ts AC2.11 (two), orchestrator renderFinishSummary AC2.9 | graph output 4; dead ends 4 |
| AC3.1 | graph.test.ts AC3.1 (data, render), n > 2 hint test | graph output 3; suggestion run |
| AC3.2 | graph.test.ts AC3.2 | --spec 5 |
| AC3.3 | graph.test.ts AC3.3 | None needed |
| AC3.4 | graph.test.ts AC3.4 (data, render) | Dead ends 1 |
| AC3.5 | graph.test.ts AC3.5 (three tests) | Dead ends 2 |
| AC3.6 | graph.test.ts AC3.6 (data, render) | Dead ends 3 |
| AC3.7 | orchestrator.test.ts simulateRun (four tests) | Suggestion run |
| AC4.1 | npm test output | Human verification AC4.1 |
| AC4.2 | None (docs) | Human verification AC4.2 |
| Unlisted-feature hint (user-approved) | graph.test.ts three hint tests; integration "a Run together hint names a nested feature the picker lacks" | --spec 3, 5 |
