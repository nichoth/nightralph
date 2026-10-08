# Test Requirements: Attempt Learnings

This file maps every acceptance criterion in
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md` to the
automated test that verifies it, or to a documented human check. The
test locations and assertions come from the Testing sections of
`phase_01.md` through `phase_04.md` in this directory.

Decisions from planning that shape these tests:

1. Unit tests for the new module live in `test/learnings.test.ts`
   (registered in the `TESTS` array of `scripts/test.sh`, after
   `progress`). `renderPrompt` unit tests live in
   `test/orchestrator.test.ts`, next to the existing `renderPrompt`
   tests. The `commitProgress` path-list test lives in
   `test/progress.test.ts`.
2. Integration tests live in `test/integration.test.ts`, next to the
   existing `runWavesIsolated` tests, and drive `runWavesIsolated` in a
   temp git repo.
3. One env-driven mock agent, `test/mock-agent-notes.js`, serves every
   integration test. `MOCK_MODE` is `pass`, `fail`, `fail-once`, or
   `hang`. Each invocation writes a JSON record (time, cwd, token,
   prompt) to `MOCK_RECORD_DIR` and writes its token to
   `.nightralph/notes.md`. In `pass` mode it commits with `git add -A`,
   so the `.nightralph/.gitignore` safety net is exercised.
4. No test asserts on prose copy. Tests check random `randomUUID()`
   tokens, parsed fields (`key`, `attempt`, `outcome`, `timedOut`),
   lengths, equality between two renders, `indexOf` ordering, or git
   state.
5. With `logsDir = <projectDir>/.logs` and no `progressPaths`, the
   integration log is at `join(projectDir, 'learnings.md')`
   (`learningsPathFor` of the fallback `progress.md`), and tests read it
   with `readEntries`.

Every criterion maps to an automated test except AC4.3, which is
verified by a human reading a rendered prompt.

## Summary

| AC id | Type | File | Phase |
|---|---|---|---|
| AC1.1 | unit | `test/learnings.test.ts` | 1 |
| AC1.2 | unit | `test/learnings.test.ts` | 1 |
| AC1.3 | unit | `test/learnings.test.ts` | 1 |
| AC2.1 | unit | `test/learnings.test.ts` | 1 |
| AC2.2 | unit | `test/learnings.test.ts` | 1 |
| AC2.3 | unit | `test/learnings.test.ts` | 1 |
| AC2.4 | unit | `test/learnings.test.ts` | 1 |
| AC2.5 | unit | `test/learnings.test.ts` | 1 |
| AC3.1 | unit (temp dir) | `test/learnings.test.ts` | 2 |
| AC3.2 | unit (temp dir) | `test/learnings.test.ts` | 2 |
| AC3.3 | unit (temp git repo) | `test/learnings.test.ts` | 2 |
| AC3.4 | unit (temp dir) | `test/learnings.test.ts` | 2 |
| AC4.1 | unit | `test/orchestrator.test.ts` | 3 |
| AC4.2 | unit | `test/orchestrator.test.ts` | 3 |
| AC4.3 | human | rendered prompt (phase_03 Task 1) | 3 |
| AC5.1 | integration | `test/integration.test.ts` | 4 |
| AC5.2 | integration | `test/integration.test.ts` | 4 |
| AC5.3 | integration | `test/integration.test.ts` | 4 |
| AC5.4 | integration | `test/integration.test.ts` | 4 |
| AC6.1 | integration | `test/integration.test.ts` | 4 |
| AC6.2 | integration | `test/integration.test.ts` | 4 |
| AC6.3 | integration | `test/integration.test.ts` | 4 |
| AC7.1 | integration | `test/integration.test.ts` | 4 |
| AC7.2 | integration + unit | `test/integration.test.ts`, `test/progress.test.ts` | 4 |
| AC7.3 | integration | `test/integration.test.ts` | 4 |

All AC ids are prefixed `attempt-learnings-design.` in the spec; the
table drops the prefix for width.

## AC1: Entries round-trip through the log

Phase 1, Task 3. Unit tests in `test/learnings.test.ts`.

- **attempt-learnings-design.AC1.1 Success:** An entry built by
  `renderEntry` and read back by `parseEntries` keeps its ticket key,
  attempt number, outcome, and timed-out flag.
  - Type: unit
  - Asserts: entries for `done`, `exit` with `timedOut:true`, `tests`,
    `install`, `error`, and `merge` (one key containing a space) are
    concatenated and parsed; `t.deepEqual` of each parsed
    `{ key, attempt, outcome, timedOut }` matches the inputs, in order.
- **attempt-learnings-design.AC1.2 Edge:** Agent notes containing the
  sentinel prefix still parse as exactly one entry.
  - Type: unit
  - Asserts: notes holding a full sentinel line on its own line render
    to an entry that parses to exactly one entry with the original key.
  - Supporting: sentinels with an unknown outcome, a non-numeric
    attempt, or a malformed escape in `ticket` (e.g. `%E0%A`) are each
    dropped without throwing, and a valid entry after them still parses.
- **attempt-learnings-design.AC1.3 Success:** `tailLines(text, n)`
  returns the last `n` lines, or the whole input when it has fewer.
  - Type: unit
  - Asserts: 50 numbered lines with `n = 40` give 40 lines ending at
    line 50; 3 lines give all 3; a trailing newline adds no empty line.

## AC2: History is bounded and relevant

Phase 1, Task 3. Unit tests in `test/learnings.test.ts`.

- **attempt-learnings-design.AC2.1 Success:** A ticket's own history
  holds at most its `MAX_OWN_ENTRIES` most recent entries, oldest first.
  - Type: unit
  - Asserts: six entries for one key; `own` has length
    `MAX_OWN_ENTRIES` and its `attempt` numbers equal the last four, in
    order.
- **attempt-learnings-design.AC2.2 Success:** For each direct blocker,
  the history holds only that blocker's most recent `done` entry.
  - Type: unit
  - Asserts: a blocker with `exit`, `done`, `exit`, `done` entries
    yields exactly one `blockers` entry, the second `done` (by
    `attempt`).
- **attempt-learnings-design.AC2.3 Failure:** Blocker failures,
  unrelated tickets, the same ticket number in another feature, and
  blockers of blockers are excluded.
  - Type: unit
  - Asserts: entries for an unrelated key, for `other:4` when selecting
    `feat:4`, for a blocker with only failures, and for a blocker's own
    blocker (not in `blockerKeys`) are absent from both `own` and
    `blockers`.
- **attempt-learnings-design.AC2.4 Edge:** An empty selection renders
  as an empty string.
  - Type: unit
  - Asserts: `renderHistory({ own:[], blockers:[] })` equals `''`.
- **attempt-learnings-design.AC2.5 Edge:** An entry longer than
  `MAX_ENTRY_CHARS` renders within `MAX_ENTRY_CHARS` plus the
  truncation marker.
  - Type: unit
  - Asserts: the rendered length of an entry with a
    `MAX_ENTRY_CHARS * 3` body, minus that of an empty-body entry, is
    at most `MAX_ENTRY_CHARS + TRUNCATED_MARKER.length + 1`.

Supporting test in the same phase (no AC of its own):
`learningsPathFor(join('a', 'b', 'progress.md'))` equals
`join('a', 'b', 'learnings.md')`. The integration tests rely on this
placement.

## AC3: Learnings IO

Phase 2, Task 2. Unit tests in `test/learnings.test.ts`, using
`mkdtempSync` temp dirs removed in `finally`, and a temp git repo built
like `initTempRepo` in `test/progress.test.ts`.

- **attempt-learnings-design.AC3.1 Success:** `collectNotes` returns
  the notes file's contents and removes the `.nightralph/` directory,
  also when there is no notes file.
  - Type: unit (temp dir)
  - Asserts: with a random token written at `join(dir, NOTES_PATH)`,
    the result contains the token, and afterwards neither the file nor
    its `.nightralph` directory exists. With only a
    `.nightralph/.gitignore` present (no notes), the result is `null`
    and the directory is gone.
- **attempt-learnings-design.AC3.2 Edge:** `collectNotes` returns
  `null` when there is no notes file.
  - Type: unit (temp dir)
  - Asserts: an empty dir returns `null`; a whitespace-only notes file
    also returns `null`.
- **attempt-learnings-design.AC3.3 Success:** After
  `ensureNotesIgnored(worktreePath)`, git ignores everything under
  `.nightralph/` in that worktree (including its own `.gitignore`), and
  nothing under the repo's git dir is written.
  - Type: unit (hermetic temp git repo: `git init --template=<empty
    temp dir>` and `core.excludesFile=/dev/null`, so the user's git
    template and global excludes cannot affect or be affected by it)
  - Asserts: after `ensureNotesIgnored` (called twice) and writing
    `.nightralph/notes.md`, `git check-ignore -q .nightralph/notes.md`
    exits 0, and `git status --porcelain` is empty (so the
    `.gitignore` ignores itself). The repo's `<git dir>/info/exclude`
    is unchanged. A second case does the same inside a linked
    worktree.
- **attempt-learnings-design.AC3.4 Edge:** `readEntries` on a missing
  file returns `[]`.
  - Type: unit (temp dir)
  - Asserts: `readEntries(join(dir, 'missing.md'))` deep-equals `[]`.

Supporting test (no AC of its own): `appendEntry` of two rendered
entries to a path under a not-yet-existing subdirectory, then
`readEntries` returns 2 entries with the right keys.

## AC4: The prompt carries history

Phase 3. AC4.1 and AC4.2 are unit tests in `test/orchestrator.test.ts`
(Task 2), reusing the `makeTicket` helper of the existing
`renderPrompt` tests. AC4.3 is a human check (Task 1).

- **attempt-learnings-design.AC4.1 Success:** A history string passed
  to `renderPrompt` appears in the prompt.
  - Type: unit
  - Asserts: a history containing a `randomUUID()` token appears in the
    prompt, after the ticket body and before `AGENT INSTRUCTIONS`
    (compared by `indexOf`).
- **attempt-learnings-design.AC4.2 Edge:** A prompt rendered with no
  history equals one rendered with `history:''`.
  - Type: unit
  - Asserts: `renderPrompt(spec, ticket, { testCmd })` `t.equal`s
    `renderPrompt(spec, ticket, { testCmd, history:'' })`.
- **attempt-learnings-design.AC4.3 Human:** The prompt tells the agent
  to keep `.nightralph/notes.md` current and never commit it, splits
  reusable patterns (AGENTS.md) from ticket notes, and allows skipping
  test-first for pure scaffolding, config, or docs items.
  - Type: human verification (see below)

Supporting test (Task 2, no AC of its own): the prompt includes
`NOTES_PATH`, imported from `src/learnings.ts`. This follows the
existing pattern of checking that named files appear (as the
`AGENTS.md` test does), and ties the prompt to the path `collectNotes`
reads without asserting on any instruction wording.

### Human verification: AC4.3

Justification: AC4.3 is about what the instructions say. Checking it
automatically would mean matching instruction prose, which the project
rules forbid as brittle. The one machine-checkable part, that the
prompt names the notes path, is covered by the `NOTES_PATH` supporting
test above.

Approach: after Phase 3, run `npm run build`, then print a rendered
prompt from the repo root (phase_03 Task 1):

```bash
node --input-type=module -e "
import { renderPrompt } from './dist/orchestrator.js'
console.log(renderPrompt('spec', {
    num:1, slug:'x', filename:'01-x.md', filepath:'',
    body:'- [ ] item', status:'ready-for-agent',
    blockers:[], feature:'f',
}, { testCmd:'npm test' }))
"
```

Read the `AGENT INSTRUCTIONS` section and confirm:

1. A rule tells the agent to keep `.nightralph/notes.md` (creating the
   directory), update it after each checklist item and as soon as it
   hits a blocker, and never commit, `git add`, or delete it. The
   commit rule excepts the notes file, and the INTEGRITY rule says to
   record what blocked the agent in the notes file.
2. The AGENTS.md rule says reusable patterns go in AGENTS.md and
   anything specific to this ticket goes in the notes file.
3. The /tdd rule allows skipping test-first for a checklist item that
   is pure scaffolding, config, or docs, and says to note that in the
   notes file.

Also confirm that no history section appears in this prompt (no
`history` was passed), which matches AC4.2.

## AC5: Later agents see earlier attempts

Phase 4, Task 6. Integration tests in `test/integration.test.ts`, using
`test/mock-agent-notes.js` (constant `MOCK_NOTES`), with
`MOCK_RECORD_DIR` set to a fresh temp dir and records read back sorted
by `time`.

- **attempt-learnings-design.AC5.1 Success:** A retry's prompt
  contains the previous attempt's agent notes.
  - Type: integration
  - Asserts: one ticket, `MOCK_MODE=fail-once`, `retries:1`; there are
    two records and the second record's prompt contains the first
    record's token.
- **attempt-learnings-design.AC5.2 Success:** `learnings.md` records
  one entry per attempt, in order, with outcomes matching what
  happened.
  - Type: integration (same test as AC5.1)
  - Asserts: `readEntries` gives two entries for the ticket with
    outcomes `['exit', 'done']`.
- **attempt-learnings-design.AC5.3 Success:** A downstream ticket's
  prompt contains its direct blocker's agent notes.
  - Type: integration
  - Asserts: ticket 2 blocked by ticket 1, `pass`, `retries:0`; ticket
    2's record (found by its worktree name in `cwd`) has a prompt that
    contains ticket 1's token.
- **attempt-learnings-design.AC5.4 Success:** A second run's
  first-attempt prompt contains notes written during the first run.
  - Type: integration
  - Asserts: with `.logs/` in a committed `.gitignore` (so the second
    run's dirty-tree check passes), a first run in `fail` mode with
    `retries:0`, then a rescan and a second run in `pass` mode; the
    first record of the second run contains the first run's token.

## AC6: Failures are explained

Phase 4, Task 6. Integration tests in `test/integration.test.ts`.

- **attempt-learnings-design.AC6.1 Success:** Notes written before a
  timeout kill appear in that attempt's entry, and the entry is marked
  timed out.
  - Type: integration
  - Asserts: `MOCK_MODE=hang`, `timeout:2`, `retries:0`; the ticket's
    entry has `timedOut:true` and its body contains the record's token.
- **attempt-learnings-design.AC6.2 Success:** A red test gate's entry
  has outcome `tests` and contains the tail of the test log.
  - Type: integration
  - Asserts: `pass` mode with a `testCmd` that echoes a fresh
    `randomUUID()` and then exits 1, `retries:0`; the entry's outcome
    is `tests` and its body contains the test token.
- **attempt-learnings-design.AC6.3 Success:** An unrecovered merge
  failure appends a `merge` entry for that ticket.
  - Type: integration
  - Asserts: the existing `installMergeFailingGit` fake-git setup
    (PATH restored in `finally`), `pass` mode,
    `conflictStrategy:'stop'`; `readEntries` holds an entry for the
    ticket with outcome `merge`.

## AC7: Repo hygiene and safety

Phase 4. Integration tests in `test/integration.test.ts` (Task 6), plus
a unit test of the commit mechanism in `test/progress.test.ts`
(Task 1).

- **attempt-learnings-design.AC7.1 Success:** No commit on any ref
  contains a `.nightralph/` path.
  - Type: integration (same test as AC5.1)
  - Asserts: `git log --all --name-only --format=` has no line starting
    with `.nightralph/`. The mock commits with `git add -A`, so this
    proves `collectNotes` plus `.nightralph/.gitignore` keep the notes
    out.
- **attempt-learnings-design.AC7.2 Success:** `learnings.md` is
  committed and has no uncommitted changes when the run ends.
  - Type: integration (same test as AC5.1)
  - Asserts: `git ls-files learnings.md` is non-empty and
    `git status --porcelain -- learnings.md` is empty.
  - Type: unit, `test/progress.test.ts` (the commit mechanism, Task 1)
  - Asserts: two files passed to `commitProgress` as an array produce
    one commit whose `git show --name-only --format= HEAD` lists both;
    a second call with unchanged files returns `false` and leaves
    `git rev-parse HEAD` unchanged.
- **attempt-learnings-design.AC7.3 Failure:** When `learnings.md`
  cannot be read or written, the ticket still finishes `done` and
  `progress.md` is still committed.
  - Type: integration
  - Asserts: an empty directory created at the `learnings.md` path
    (invisible to `git status`, so the dirty-tree check passes), `pass`,
    `retries:0`; the ticket's status is `done`,
    `git status --porcelain -- progress.md` is empty, and `readProgress`
    shows the ticket with `done:true`.

## Phase 5: Docs

Phase 5 (AGENTS.md contracts and the README note on `learnings.md`)
has no acceptance criteria. It is verified by reading the docs against
the code shipped in Phases 1-4, with a
`grep -n "learnings" AGENTS.md` check that the new section and each
updated contract are present. Per project rules, no tests are written
for docs.
