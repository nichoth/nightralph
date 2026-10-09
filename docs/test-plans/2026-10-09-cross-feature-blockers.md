# Human Test Plan: Cross-Feature Blockers

Implementation plan:
`docs/implementation-plans/2026-10-09-cross-feature-blockers/`.
Automated coverage: every criterion in `test-requirements.md`
(AC1.1-AC1.11, AC2.1-AC2.9, AC3.1-AC3.6 and the build half of AC4.2)
has a passing automated test. This plan covers what tests cannot:
the documentation (AC4.1, the docs half of AC4.2), whether the
messages are actionable, and an end-to-end run on a real `.scratch`
tree.

## Prerequisites

1. In `/Users/nick/code/nightralph` run `npm run build && npm test`.
   Expect exit 0 and `# fail 0`. Delete any `mock-change-*.txt` left
   in the repo root.
2. Build a throwaway two-feature repo. Set
   `NR=/Users/nick/code/nightralph` and
   `MOCK=$NR/test/mock-agent-pass.js`. Make a temp dir with
   `T=$(mktemp -d)`, then `mkdir $T/demo && cd $T/demo`. Run
   `git init -q -b main --template=` (the empty template keeps the
   shared `info/exclude` out of the repo) and set a local
   `user.name` and `user.email`. Write `.gitignore` containing
   `.scratch/*/logs/`. Create `.scratch/alpha-feat/spec.md` and
   `.scratch/beta-feat/spec.md`, each a one-line heading.
3. Create these tickets. Each has a `# Title` line, a blank line,
   `**Status:** <status>`, `**Blocked by:** <field>`, a blank line,
   then `- [ ] Do the thing`.
   - `.scratch/beta-feat/issues/01-beta-one.md`: status `done`,
     blocked by `None`.
   - `.scratch/beta-feat/issues/02-beta-two.md`: status
     `ready-for-agent`, blocked by `01`.
   - `.scratch/alpha-feat/issues/01-alpha-one.md`: status
     `ready-for-agent`. Write the field over two lines:
     `beta-feat 02, see FDR-018 (the helper` then
     `lands there first)`.
   - `.scratch/alpha-feat/issues/02-alpha-two.md`: status
     `ready-for-agent`, blocked by `01`.
   - `.scratch/alpha-feat/issues/03-alpha-three.md`: status
     `ready-for-agent`, blocked by `beta-feat 09`.
   - `.scratch/alpha-feat/issues/04-alpha-four.md`: status
     `ready-for-agent`, blocked by `beta-fet 01`.

   Then `git add -A && git commit -qm fixture`.
4. Cleanup at the end: `rm -rf $T`, which also removes the sibling
   `demo.*` worktree dirs.

## Feature picker

| Step | Action | Expected |
|------|--------|----------|
| 1 | In `$T/demo`, run `node $NR/dist/index.js $MOCK --dry-run` with no `--spec` | The checkbox picker lists `alpha-feat (0/4 ready, 1 bad blocker)` and `beta-feat (1/2 ready)` |
| 2 | Compare against the rules | alpha has 0 ready: 01 waits on outside beta/02, 02 and 04 wait on 01, 03 has a missing ref. The one bad blocker is `beta-feat 09`; the pending outside ref and the typo are not counted as bad |
| 3 | Tick both features with space, press enter | Dry run shows `Wave 1:` with `02-beta-two.md`, `Wave 2:` with `01-alpha-one.md`, `Wave 3:` with `02-alpha-two.md` and `04-alpha-four.md`. `03-alpha-three.md` is under `Deadlocked tickets:` and its listing shows `beta-feat/09 (not found)`. Exit 0. No `FDR-018` or `018` ref appears anywhere |

## Zero-ready stop, first scan

| Step | Action | Expected |
|------|--------|----------|
| 1 | `node $NR/dist/index.js $MOCK --spec alpha-feat --dry-run; echo $?` | First line `Nothing to run: every ready-for-agent ticket is waiting on a blocker.` Paragraphs say alpha-feat/01 waits on `beta-feat/02 (ready-for-agent, not in run)`, `beta-feat/09 (not found)` for alpha-feat/03, and that `beta-fet` (alpha-feat/04) looks like a feature name. Exit 0, no wave listing |
| 2 | Same command without `--dry-run` | Same message, exit 0. `git branch --list 'nightralph--*'` is empty, `git branch --show-current` is `main`, `git status` is clean, every alpha ticket still says `ready-for-agent` |
| 3 | `node $NR/dist/index.js nightralph-no-such-provider --spec alpha-feat; echo $?` | Same stop message, no `Provider ... not found on PATH` line, exit 0, still no `nightralph--*` branch |
| 4 | Read the message as a new user would | It is clear which feature to select or finish and which `**Blocked by:**` line to fix |

## End to end: a cross-feature blocker goes from pending to done

This checks that a done blocker outside the run unblocks the ticket,
the run goes through the integration branch, and the finish summary
reports the missing ref and the typo.

1. On `main`, set `.scratch/beta-feat/issues/02-beta-two.md` to
   `**Status:** done` and commit.
2. Run `node $NR/dist/index.js $MOCK --spec alpha-feat --test-cmd
   true --retry-delay 0 --retries 0 --no-review; echo $?`.
3. Expect `Created branch nightralph--alpha-feat`. The status display
   runs alpha-feat/01 in wave 1, then 02 and 04 in wave 2; the
   alpha-feat/03 row is blocked by `beta-feat/09 (not found)`.
4. The finish summary starts `Finished: 3 completed, 1 remaining`. A
   paragraph lists `beta-feat/09 (not found)` against alpha-feat/03
   and another names `beta-fet` and alpha-feat/04. Exit code 1,
   because 03 is still `ready-for-agent`.
5. `git branch --show-current` is `nightralph--alpha-feat`. Its 01,
   02 and 04 tickets say `**Status:** done`, 03 says
   `ready-for-agent`, and `git status` is clean.

## End to end: a resumed integration branch with nothing ready

This checks AC3.4: the stop fires from the re-scan and the CLI goes
back to the launch branch.

1. Make a fresh copy of the fixture, but give alpha-feat a single
   ticket, 01, blocked by `None`. Leave beta-feat 02
   `ready-for-agent`. Commit on `main`.
2. `git checkout -qb nightralph--alpha-feat`, change alpha 01's
   field to `beta-feat 02`, commit, then `git checkout -q main`.
3. Run `node $NR/dist/index.js $MOCK --spec alpha-feat; echo $?`.
   Expect `Resumed nightralph--alpha-feat`, then
   `Nothing to run on nightralph--alpha-feat. Back on main.` and the
   stop text naming `beta-feat/02`. Exit 0. `git branch
   --show-current` is `main` and the integration branch still exists.
4. Variant: on `main`, set alpha 01 to `beta-feat 02` and commit, run
   `git branch -f nightralph--alpha-feat main`, then run again. You
   still get `Resumed`, then the stop, then you are back on `main`:
   the first scan did not stop the run before it resumed.
5. AC3.5 variant: on the integration branch set alpha 01 to `done`,
   commit, return to `main`, and run with `--test-cmd true
   --no-review`. Expect exit 0, no `Nothing to run` text, and
   `git branch --show-current` reports `nightralph--alpha-feat`.

## End to end: in-place (non-git) typo

This checks AC2.9 without a git repo. In a plain temp dir that is not
a repo, create `.scratch/solo-feat/spec.md`, `01-done.md` (status
done) and `02-typo.md` blocked by `nwsletter-audit 01`. Run
`node $NR/dist/index.js $MOCK --spec solo-feat --timeout 10`. Expect
02 to run and exit 0; the finish summary's typo paragraph names
`nwsletter-audit` and solo-feat/02. Delete any `mock-change-*.txt`
the agent wrote.

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC4.1 | Prose docs; docs are not tested | 1. `git diff 1783a4c..HEAD -- src/skills/to-tickets/SKILL.md src/docs-templates/issue-tracker.md`. 2. Confirm each file says blockers are numbers plus `<feature> <NN>` (feature repeated before each number), parenthesised text is ignored, the field may wrap and ends at a blank line, `**Field:**` line, heading or checklist item, `03-05` means 3 and 5, and nothing suggests blocking by title. 3. After `npm run build`, each file is identical to its copy under `dist/skills/to-tickets/` and `dist/docs-templates/`, and `docs/agents/issue-tracker.md` matches the template |
| AC4.2 (docs half) | Prose docs | 1. In `AGENTS.md` find: the blockers module contract; the resolve module contract with `loadSelection` and the picker label `name (R/T ready[, N bad blocker(s)])`; orchestrator entries for `Ticket.blockers`, `findBlockedTickets`, `blockerLabel`, `renderFinishSummary` warnings, `historyFor` and `nothingReady`; the CLI zero-ready stop, including the resume skip and that provider preflight runs after it; the display `blocked` text. 2. `Last verified:` is 2026-10-09. 3. Searching `AGENTS.md` and `src/docs-templates/issue-tracker.md` for U+2014 (em dash) and U+2192 (right arrow), e.g. `grep -n "$(printf '\u2014')\|$(printf '\u2192')" <file>` in zsh, finds nothing. In `src/skills/to-tickets/SKILL.md` the only hits are the pre-existing U+2192 arrows in the original "Local files" and "real issue tracker" bullets |
| AC4.2 (build half) | Operational, already checked | `grep -n "src/blockers.ts" package.json` and `grep -n blockers scripts/test.sh` each give one match; `ls dist/blockers.js` succeeds; `npm test` output includes the blockers suite |
| Message quality (AC2.2, AC2.4, AC2.9, AC3.x) | Tests assert labels, not readability | During the stop and summary steps above, check each paragraph tells the user what to do, labels use `feature/NN`, and no paragraph repeats a ticket confusingly |

## Traceability

| Acceptance criterion | Automated test | Manual step |
|----------------------|----------------|-------------|
| AC1.1 | blockers `AC1.1`; orchestrator `scanTickets reads a cross-feature blocker`; resolve `loadSelection AC1.1 AC2.1` | Picker step 3 |
| AC1.2 | blockers `AC1.2` | -- |
| AC1.3 | blockers `AC1.3`, CRLF case | -- |
| AC1.4 | blockers `AC1.4`, unpaired paren | Fixture alpha/01 multi-line parenthetical |
| AC1.5 | blockers `AC1.5`, unpaired backtick | -- |
| AC1.6 | blockers `AC1.6`; orchestrator `scanTickets reads None` | Fixture beta/01 |
| AC1.7 | blockers `AC1.7` | `FDR-018` in alpha/01 adds no ref |
| AC1.8 | blockers `AC1.8` | `see FDR-018` gives no typo (stop step 1) |
| AC1.9 | blockers `AC1.9`; resolve typo test | Stop step 1 (`beta-fet`) |
| AC1.10 | blockers two `AC1.10` tests | Fixture checklist line after the field |
| AC1.11 | resolve `featureCounts AC1.11` | Picker steps 1 and 2 |
| AC2.1 | blockers, orchestrator, resolve `AC2.1` | Cross-feature E2E steps 1-3 |
| AC2.2 | blockers, orchestrator, resolve, integration `AC2.2`; CLI AC3.1/3.3/3.4 | Stop step 1; resume E2E step 3 |
| AC2.3 | orchestrator `AC2.3`; resolve selected-feature test | Picker step 3 |
| AC2.4 | blockers, orchestrator, resolve `AC2.4`; integration setBlocked; CLI unknown-blocker | Picker steps 1 and 3; stop step 1; cross-feature E2E step 4 |
| AC2.5 | orchestrator `AC2.5`; integration setBlocked ticket 4 | Picker step 3 |
| AC2.6 | orchestrator `AC2.6` | -- |
| AC2.7 | orchestrator `historyFor` tests (4) | -- |
| AC2.8 | orchestrator `AC2.8`, `blockerSatisfied` | Picker step 3 |
| AC2.9 | orchestrator `renderFinishSummary AC2.9`; CLI in-place and isolated typo tests | Cross-feature E2E step 4; in-place E2E |
| AC3.1 | `nothingReady` / `renderNothingReady` units; CLI AC3.1 | Stop step 2 |
| AC3.2 | CLI AC3.2 | Stop step 3 |
| AC3.3 | `renderNothingReady` units; CLI AC3.3; deadlock CLI test | Stop step 1 |
| AC3.4 | CLI AC3.4 and the re-scan test | Resume E2E steps 2-4 |
| AC3.5 | `nothingReady` all-done; CLI AC3.5 | Resume E2E step 5 |
| AC3.6 | `nothingReady` free ticket; CLI AC3.6 | Cross-feature E2E |
| AC4.1 | -- (docs) | Human verification AC4.1 |
| AC4.2 | Build checks (grep/ls) | Human verification AC4.2, both halves |
