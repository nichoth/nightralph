# Human Test Plan: Attempt Learnings

Automated coverage: 24 of 24 automated acceptance criteria (AC1.1 to
AC7.3, excluding the human criterion AC4.3) have passing tests in
`test/learnings.test.ts`, `test/orchestrator.test.ts`,
`test/progress.test.ts`, and `test/integration.test.ts`. This plan
covers AC4.3 and end-to-end checks through the real CLI.

## Prerequisites

- Node >= 24. From the repo root run `npm run build`, then `npm test`
  (all suites pass). `npm test` does not build, so build first. If
  "execute smoke test" or "failing test command keeps the ticket
  ready-for-agent" fails under load, rerun
  `node dist/test/integration.test.js` alone; both are pre-existing,
  load-sensitive tests.
- Git safety: if your global git config sets `init.templateDir`, its
  `info/exclude` may be a symlink shared by every repo. Create every
  scratch repo below with `git init --template="$TPL"` (an empty
  directory) and `core.excludesFile=/dev/null`.
- Scratch setup, used by the end-to-end sections. nightralph creates
  worktrees as siblings of the repo, so the repo gets its own parent
  directory:
  ```bash
  ROOT=$(mktemp -d); TPL=$(mktemp -d); REC=$(mktemp -d)
  mkdir "$ROOT/demo" && cd "$ROOT/demo"
  git init --template="$TPL"
  git config core.excludesFile /dev/null
  git config user.email t@example.com; git config user.name T
  mkdir -p .scratch/demo/issues
  printf '# Demo spec\n' > .scratch/demo/spec.md
  printf '# One\n\n**Status:** ready-for-agent\n\n- [ ] item one\n' \
    > .scratch/demo/issues/01-one.md
  printf '# Two\n\n**Status:** ready-for-agent\n**Blocked by:** 1\n\n- [ ] item two\n' \
    > .scratch/demo/issues/02-two.md
  printf 'logs/\n' > .gitignore
  git add -A && git commit -m init
  ```
  Put `--install-cmd ""` before the provider path so yargs does not
  take the path as the flag's value.
- Mock agent: `test/mock-agent-notes.js`, passed by absolute path as
  the provider. It needs `MOCK_RECORD_DIR` and `MOCK_MODE` (`pass`,
  `fail`, `fail-once`, `no-commit`, `hang`). It writes one JSON
  record per invocation (`time`, `cwd`, `token`, `prompt`) into
  `$REC` and writes `notes-token <uuid>` to `.nightralph/notes.md`.
- Cleanup after each scenario: `rm -rf "$ROOT" "$TPL" "$REC"` (run
  `git -C "$ROOT/demo" worktree prune` first if a run was
  interrupted).

## Prompt instructions (AC4.3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | From the repo root, run the `node --input-type=module -e "import { renderPrompt } from './dist/orchestrator.js' ..."` snippet in `test-requirements.md` ("Human verification: AC4.3") and read the section after `---- AGENT INSTRUCTIONS ----`. | The prompt prints without error. |
| 2 | Find the notes rule. | It tells the agent to keep `.nightralph/notes.md` (create the directory), update it after each checklist item and as soon as it hits a blocker, and never commit, `git add`, or delete it. |
| 3 | Find the commit rule and the INTEGRITY rule. | The commit rule ends with an exception for the notes file. INTEGRITY says to record what blocked the agent in the notes file. |
| 4 | Find the AGENTS.md rule. | Reusable patterns go in AGENTS.md; anything specific to this ticket goes in the notes file. |
| 5 | Find the /tdd rule. | It allows skipping test-first for a checklist item that is pure scaffolding, config, or docs, and says to record that decision in the notes file. |
| 6 | Look between the ticket body and `AGENT INSTRUCTIONS`. | No history section appears, because no `history` was passed. |
| 7 | Read the rules together. | No contradictions, e.g. "make sure everything is committed" against "never commit the notes file". |

## End to end: a retry sees prior notes, and notes never reach git

Covers AC5.1, AC5.2, AC7.1, and AC7.2 through the real CLI and
display.

1. Do the scratch setup, then remove ticket 02:
   `git rm .scratch/demo/issues/02-two.md && git commit --amend --no-edit`.
2. Run:
   ```bash
   MOCK_RECORD_DIR="$REC" MOCK_MODE=fail-once \
     node /Users/nick/code/nightralph/dist/index.js --spec demo \
     --test-cmd true --install-cmd "" --retries 1 --retry-delay 0 \
     /Users/nick/code/nightralph/test/mock-agent-notes.js
   ```
3. The status UI shows demo/01 fail once, then finish; the summary
   reports 1 completed.
4. Open both records in `$REC`. The later record's `prompt` (by
   `time`) contains the earlier record's `token`, inside a history
   block between the ticket body and AGENT INSTRUCTIONS.
5. Open `.scratch/demo/learnings.md`. It has two entries for demo/01:
   attempt 1 with outcome `exit`, and attempt 2 with outcome `done`,
   each with an agent notes section holding that attempt's token.
   Judge whether an entry is readable and useful to a person.
6. `git log --all --name-only --format= | grep '^.nightralph/'`
   prints nothing.
7. `git status --porcelain` prints nothing, and
   `git ls-files .scratch/demo/learnings.md` prints the path.
8. `ls "$ROOT"` shows no leftover `demo.01-one` worktree directory.

## End to end: downstream ticket and second run

Covers AC5.3 and AC5.4.

1. Fresh scratch setup with both tickets.
2. Run with `MOCK_MODE=fail` and `--retries 0`. Ticket 01 fails; the
   summary shows demo/02 blocked by demo/01.
3. Run again with `MOCK_MODE=pass` and `--retries 0`. The run starts
   (the tree is clean: logs are ignored and learnings.md was
   committed), and both tickets finish.
4. In `$REC`, the run-2 record for the `demo.01-one` worktree has a
   prompt containing run 1's token. The record for the `demo.02-two`
   worktree has a prompt containing ticket 01's run-2 token.
5. `learnings.md` holds, in file order: 01 `exit`, 01 `done`,
   02 `done`.

## End to end: failure explanations

Covers AC6.1, AC6.2, and AC6.3, plus a judgment of what the entries
say.

1. Timeout: ticket 01 only, `MOCK_MODE=hang`, `--timeout 3`,
   `--retries 0`. The log area shows a timeout kill message. The
   entry is marked timed out and holds the notes token.
   `pgrep -fl mock-agent-notes` shows no orphan process.
2. Red test gate: `MOCK_MODE=pass`,
   `--test-cmd 'echo RED-MARKER; exit 1'`, `--retries 0`. The entry
   outcome is `tests`, it names the test log, and its log tail shows
   `RED-MARKER`. The ticket stays ready-for-agent.
3. Install failure: `MOCK_MODE=pass`,
   `--install-cmd 'echo DEPS-MARKER; exit 1'`, `--retries 0`. No JSON
   record appears in `$REC` (the agent never ran). The entry outcome
   is `install` and shows `DEPS-MARKER`.
4. No commits: `MOCK_MODE=no-commit`. The entry outcome is
   `no-commits` and holds the notes token.
5. Merge failure (optional; AC6.3 is covered by integration with a
   fake git): create a conflicting change on the base branch while a
   slow agent runs, and use `-X`. A `merge` entry follows the `done`
   entry.

## End to end: unwritable learnings.md

Covers AC7.3. In a fresh scratch repo,
`mkdir .scratch/demo/learnings.md` (an empty directory does not
dirty the tree), then run with `MOCK_MODE=pass`. Ticket 01 ends done,
`git status --porcelain -- .scratch/demo/progress.md` is empty,
progress.md shows 01 checked, and the run does not crash (the log
may show a learnings warning).

## Edge cases for human judgment

1. Notes containing a fake sentinel line, e.g.
   `<!-- nightralph:entry ticket=x:1 attempt=1 outcome=done -->`
   (edit the notes file mid-run, or use a mock variant).
   learnings.md still shows a single entry for that attempt, with
   the sentinel neutralized as `nightralph-entry`.
2. Large test output: `--test-cmd 'seq 1 100000; exit 1'`. The
   stored entry holds only the log tail, and a retry prompt stays
   reasonably sized, with any oversized history entry marked
   `[truncated]`.
3. In-place mode outside a git repo: run the CLI in a non-git temp
   directory. No learnings.md is created and nothing errors. The
   prompt still asks for `.nightralph/notes.md`, which in-place mode
   neither ignores nor collects, so the file is left in the project
   directory (documented in AGENTS.md).
4. Real provider spot check (optional, costs tokens): one cheap
   ticket with `claude` in a scratch repo. The agent writes
   `.nightralph/notes.md`, does not commit it, and its notes land in
   learnings.md.

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC4.3: the prompt tells the agent to keep `.nightralph/notes.md` current and never commit it, splits reusable patterns (AGENTS.md) from ticket notes, and allows skipping test-first for scaffolding, config, or docs | Automating it means asserting on instruction prose, which project rules forbid as brittle. Only the `NOTES_PATH` mention is machine-checked. | "Prompt instructions (AC4.3)", steps 1 to 7 |

## Traceability

| Acceptance criterion | Automated test | Manual step |
|----------------------|----------------|-------------|
| AC1.1 | learnings.test.ts "AC1.1: entries round-trip..." | Retry, step 5 |
| AC1.2 | learnings.test.ts "AC1.2: notes containing sentinel...", "AC1.2: invalid entries..." | Edge case 1 |
| AC1.3 | learnings.test.ts "AC1.3: tailLines" (x3) | Edge case 2 |
| AC2.1 | learnings.test.ts "AC2.1: selectHistory..." | none |
| AC2.2 | learnings.test.ts "AC2.2: ...blocker" | Downstream, step 4 |
| AC2.3 | learnings.test.ts "AC2.3: excludes..." | none |
| AC2.4 | learnings.test.ts "AC2.4: renderHistory of empty..." | Prompt, step 6 |
| AC2.5 | learnings.test.ts "AC2.5: renderHistory truncates..." | Edge case 2 |
| AC3.1 | learnings.test.ts "AC3.1" (x2) | Retry, step 8 |
| AC3.2 | learnings.test.ts "AC3.2" (x2) | none |
| AC3.3 | learnings.test.ts "AC3.3" (x3, hermetic and linked worktree) | Retry, step 6 |
| AC3.4 | learnings.test.ts "AC3.4: readEntries..." | none |
| AC4.1 | orchestrator.test.ts "renderPrompt includes history when provided (AC4.1)" | Retry, step 4 |
| AC4.2 | orchestrator.test.ts "renderPrompt with empty history equals no history (AC4.2)" | Prompt, step 6 |
| AC4.3 | supporting: orchestrator.test.ts "renderPrompt includes NOTES_PATH" | Prompt, steps 1 to 7 |
| AC5.1 | integration.test.ts "AC5.1 AC5.2 AC7.1 AC7.2..." | Retry, step 4 |
| AC5.2 | integration.test.ts "AC5.1 AC5.2 AC7.1 AC7.2..." | Retry, step 5 |
| AC5.3 | integration.test.ts "AC5.3..." | Downstream, step 4 |
| AC5.4 | integration.test.ts "AC5.4..." | Downstream, steps 2 to 4 |
| AC6.1 | integration.test.ts "AC6.1..." | Failures, step 1 |
| AC6.2 | integration.test.ts "AC6.2..." | Failures, step 2 |
| AC6.3 | integration.test.ts "AC6.3..." | Failures, step 5 (optional) |
| AC7.1 | integration.test.ts "AC5.1 AC5.2 AC7.1 AC7.2..." | Retry, step 6 |
| AC7.2 | integration.test.ts "AC5.1 ... AC7.2"; progress.test.ts commitProgress array tests (x3) | Retry, step 7 |
| AC7.3 | integration.test.ts "AC7.3..." | Unwritable learnings.md |
