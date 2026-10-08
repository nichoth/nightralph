# Human test plan -- CLI audit fixes

Implementation plan:
`docs/implementation-plans/2026-10-07-cli-audit-fixes/`.
Automated coverage: all 18 automated criteria (AC1.1-AC1.7,
AC2.1-AC2.8, AC3.1-AC3.3) have tests; AC4 is operational and AC5 is
docs, verified below.

## Prerequisites

- Node 24 or newer, git, macOS or Linux. Run from
  `/Users/nick/code/nightralph` with a clean tree.
- `npm run build && npm test` passes; `npm run lint` shows no
  errors.
- Scratch project `$P`:

  ```
  P=$(mktemp -d)/demo && mkdir -p $P && cd $P && git init -b main
  git config user.name t && git config user.email t@example.com
  mkdir -p .scratch/demo/issues
  printf '# Demo spec\n' > .scratch/demo/spec.md
  printf '# Task\n\n**Status:** ready-for-agent\n' > .scratch/demo/issues/01-task.md
  printf '.scratch/*/logs/\n' > .gitignore
  git add -A && git commit -m init
  ```

- `AGENT=/Users/nick/code/nightralph/test/mock-agent-pass.js`
- `NR="node /Users/nick/code/nightralph/dist/index.js"`
- Resetting `$P` between steps that merge or create
  `nightralph--demo`: `git checkout main && git branch -D
  nightralph--demo`, and `git checkout -- .scratch` (or rebuild
  `$P`) if a ticket ran.
- Remove `$P` and its `demo.*` sibling worktree directories when
  done.

Never run `npm version`, a real `npm publish`, or `git push` for
any of this.

## Phase 1: Provider preflight

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | In `$P`: `$NR nightralph-no-such-provider --spec demo; echo "exit=$?"` | `exit=2`; one stderr line `Provider 'nightralph-no-such-provider' not found on PATH`; `git branch --list 'nightralph--*'` prints nothing; HEAD is still `main`. |
| 1.2 | `$NR nightralph-no-such-provider --spec demo --dry-run; echo "exit=$?"` | `exit=0`; output has `Provider:     not found on PATH` and still shows the wave plan. |
| 1.3 | `$NR $AGENT --spec demo --dry-run` | `Provider:` line shows the absolute path of `mock-agent-pass.js`. |
| 1.4 | `touch $P/noexec.js && chmod 644 $P/noexec.js`; `$NR $P/noexec.js --spec demo; echo "exit=$?"` | `exit=2`; stderr names the path and says `not found or not executable`. |
| 1.5 | `mkdir -p bin && cp $AGENT bin/agent.mjs && chmod 755 bin/agent.mjs`; `echo bin/ >> .gitignore && git commit -am ignore-bin`; `$NR ./bin/agent.mjs --spec demo --no-review --retries 0 --install-cmd "" --test-cmd "" --timeout 30; echo "exit=$?"` | `exit=0`; HEAD is `nightralph--demo` and `git log --format=%s` shows `mock agent change` (the relative path resolved against the launch directory, not the worktree). |
| 1.6 | On a TTY, a provider that passes preflight but fails to spawn: `printf '#!/nonexistent/interp\n' > bad && chmod 755 bad`; `$NR ./bad --spec demo --no-review --retries 0 --test-cmd ""` | The status UI log area shows `agent process error: ...` with the ticket prefix, not painted over; `.scratch/demo/logs/01-task.log` contains `nightralph: agent process error`. |

## Phase 2: Test gate off

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Fresh `$P`; `printf '{"name":"p","private":true}\n' > package.json && git add -A && git commit -m pkg`; `$NR $AGENT --spec demo --no-review --retries 0 --install-cmd "" --timeout 30 \| tee out.txt` | Exit 0; `grep -c "No test command detected" out.txt` prints `1`; ticket done and merged on `nightralph--demo`; no `.scratch/demo/logs/*.test.log`; log shows `01-task.md: no test gate`. |
| 2.2 | Set `package.json` to `{"name":"p","private":true,"scripts":{"test":"exit 7"}}`, commit, reset, rerun the 2.1 command | Non-zero exit; no `No test command detected`; `01-task.test.log` exists; `mock agent change` not in the log. |
| 2.3 | Reset, rerun 2.2 with `--test-cmd ""` | Exit 0; no warning, no `.test.log`, ticket merged. |
| 2.4 | `$NR $AGENT --spec demo --dry-run --test-cmd ""` in `$P`, then in a non-git copy (`cp -r $P/.scratch $(mktemp -d)` and run there) | Both print `Test command: (none)`; the git one also prints `Install:` and the worktree/branch layout. |
| 2.5 | `$NR $AGENT --spec demo --dry-run` with no flag in the `exit 7` project | Prints `Test command: npm test`. |
| 2.6 | Prompt prose (human half of AC2.1): read `testGateRule` in `src/rules.ts`, or render `renderPrompt` from `dist/orchestrator.js` with `testCmd:''` and with `testCmd:'npm test'` | With `''` the rule says to run the relevant tests before each commit and that the orchestrator runs no test command for this ticket; it never claims a run after exit. With a command it names the command and says the orchestrator runs it. `renderFixPrompt` uses the same rule with subject `fix`. |
| 2.7 | Optional: in the no-`test`-script project, run with review on (drop `--no-review`) and `--test-cmd ""` | If the review mock yields findings, the fixer merges and no `review-fix*.test.log` is written. |

## Phase 3: Error reporting

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | `git checkout -b feature`; `echo x >> .scratch/demo/spec.md`; `$NR $AGENT --spec demo --no-review; echo "exit=$?"` | `exit=2`; exactly one stderr line containing `Working tree is dirty`; no `Options:` help and no `    at ` stack lines. Undo with `git checkout -- .scratch && git checkout main`. |
| 3.2 | In an empty dir: `$NR; echo "exit=$?"` | `exit=1`; help with `Options:` and the usage message. |
| 3.3 | `$NR $AGENT --bogus-flag --spec demo; echo "exit=$?"` | `exit=1` with help (`.strict()` usage error). |
| 3.4 | Add a second feature (`.scratch/other/issues/` with a spec and one ticket); `$NR $AGENT < /dev/null; echo "exit=$?"` | `exit=2`; one stderr line, no stack. |
| 3.5 | Same project on a TTY: `$NR $AGENT`, press Ctrl-C at the feature checkbox | Exits with one line and no stack trace; note the exit code. |

## Phase 4: Publish safety (AC4.1, AC4.2)

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | In the repo: `npm publish --dry-run; echo "exit=$?"` | In order: the `prepublishOnly` header, esbuild lines, every suite `# ok`, `Tarball Contents`; then the expected `You cannot publish over the previously published versions` and a non-zero exit. Do not pass `--force` or bump the version. |
| 4.2 | Add `t.ok(false, 'temporary')` to a test in `test/retry.test.ts`; `npm publish --dry-run; echo "exit=$?"` | Stops at the retry suite; the `prepublishOnly` header, then an `npm error command failed` block naming `npm run build && npm test`; no `Tarball Contents`; non-zero exit. |
| 4.3 | `git checkout -- test/retry.test.ts`; `git status` | Clean tree. |
| 4.4 | Read `package.json` `scripts` (do not run them) | `prepublishOnly` is `npm run build && npm test`; `postversion` is `npm publish && git push --follow-tags`, so a failed publish never pushes the tag. |

## End-to-end: fresh project with no tests

1. Build `$P` with a `package.json` that has no `scripts`.
2. `$NR $AGENT --spec demo --dry-run`: `Provider:` shows the
   absolute mock path, `Test command: (none)`, and the branch
   decision says it will create `nightralph--demo`.
3. `git branch`: only `main` (the dry run changed nothing).
4. `$NR $AGENT --spec demo --retries 0 --install-cmd "" --no-review
   --timeout 30`.
5. Exactly one `No test command detected` line, exit 0,
   `Created branch nightralph--demo` and `Work is on
   nightralph--demo`.
6. HEAD is `nightralph--demo`; `git log --format=%s` includes
   `mock agent change`; the ticket says `**Status:** done`.
7. `git status` is clean.
8. Run the same command again: it resumes the branch, finds nothing
   to run, and exits 0.

## End-to-end: broken provider name

1. In `$P` on main: `$NR claudee --spec demo`.
2. Exit 2 and one line: `Provider 'claudee' not found on PATH`.
3. `git branch` and `git status` unchanged; no `nightralph--demo`.
4. With `--dry-run`: exit 0 and `Provider:     not found on PATH`.

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC4.1 | Would require running `npm publish` inside the suite | 4.1 |
| AC4.2 | Needs a deliberately failing test that cannot be committed | 4.2, 4.3 |
| AC5.1 README Requirements | Docs (no tests for docs) | Read `### Requirements`: Node 24+ matches `engines`; provider on PATH, exit 2 when missing (dry-run reports and continues); no Windows. TOC lists it. |
| AC5.2 README Worktrees | Docs | Compare with `createWorktree` and `buildBranchName` in `src/worktree.ts`: sibling `<repo>.<feature>-<num>-<slug>` on `<repo>--<feature>-<num>-<slug>`; an interrupted run leaves them for the next run to clean up. The dry-run printer's dot form is a known separate mismatch. |
| AC5.3 README `--test-cmd` row | Docs | Detection from a `test` script, the announced no-gate fallback, `""` disables; "when there is one" in both gate sentences; the row is one line. |
| AC5.4 AGENTS.md | Docs | Preflight module section and Project Structure entry; `prepublishOnly`, `postversion` and the corrected `npm test` under Commands; CLI `--test-cmd`, Provider preflight (including relative path resolution) and Errors bullets; `''` on `renderPrompt`, `runWaves`, `runWavesIsolated`, `dryRun`, `dryRunIsolated`, `testGateRule`, `renderFixPrompt`, `runFixer`, `runReviewPass`; the `spawnAgent` spawn-error sentence; refreshed `Last verified`. Check each against the code. |
| AC2.1 prose half | Tests check tokens, not wording | 2.6 |

## Traceability

| Criterion | Automated test | Manual step |
|-----------|----------------|-------------|
| AC1.1 | preflight.test.ts: bare name, first PATH entry | -- |
| AC1.2 | preflight.test.ts: path with a slash, cwd | 1.5 |
| AC1.3 | preflight.test.ts: returns null | 1.4 |
| AC1.4 | integration.test.ts: AC1.4 (and not-executable path) | 1.1, broken provider |
| AC1.5 | integration.test.ts: AC1.5 absolute path runs | 1.3 |
| AC1.6 | integration.test.ts: AC1.6 dry-run not on PATH | 1.2 |
| AC1.7 | orchestrator.test.ts: spawnAgent reports spawn errors | 1.6 |
| AC2.1 | orchestrator.test.ts and review.test.ts: empty test command | 2.6 |
| AC2.2 | integration.test.ts: runWavesIsolated empty test command | 2.1 |
| AC2.3 | review-pass.test.ts: runFixer empty test command | 2.7 |
| AC2.4 | integration.test.ts: AC2.4 | 2.1, end-to-end |
| AC2.5 | integration.test.ts: AC2.5 | 2.1, end-to-end |
| AC2.6 | integration.test.ts: AC2.6 | 2.2 |
| AC2.7 | orchestrator.test.ts printers; integration.test.ts AC2.7 | 2.4, 2.5 |
| AC2.8 | integration.test.ts: AC2.8 | 2.3 |
| AC3.1 | integration.test.ts: AC3.1 | 3.1 |
| AC3.2 | integration.test.ts: AC3.2 | 3.2, 3.3 |
| AC3.3 | integration.test.ts: AC3.3 | 3.4, 3.5 |
| AC4.1 | -- (operational) | 4.1 |
| AC4.2 | -- (operational) | 4.2, 4.3 |
| AC5.1-AC5.4 | -- (docs) | Human verification table |
| Relative provider path | integration.test.ts: relative provider path runs from the launch directory | 1.5 |
| postversion reorder | -- | 4.4 |
