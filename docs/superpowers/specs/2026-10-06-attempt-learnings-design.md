# Attempt learnings

Date: 2026-10-06
Status: design approved, awaiting spec review

## Problem

A retry is blind. Each attempt gets the same `renderPrompt` output in a
fresh worktree, one effort rung higher, and nothing about why the last
attempt failed. Three things lose that knowledge today:

1. The agent is told to "say what blocked you", but that goes to stdout
   and from there only to `<ticket>.log`, which nothing reads back.
2. A failed attempt's worktree is force-removed and the retry's
   `createWorktree` deletes the leftover branch, so anything the agent
   wrote there (including AGENTS.md learnings) is lost.
3. Most failures are invisible to the agent itself: the test gate runs
   after it exits, and a max-turns or timeout kill stops it before any
   "final summary" step.

## Goal

A failed attempt leaves behind what went wrong -- the facts the
orchestrator saw, plus anything the agent noticed -- so the next agent
starts informed. Success is measured by the next agent's prompt
containing that record.

## Decisions

1. **Who reads it.** An agent's prompt gets its own ticket's earlier
   attempts, plus the latest successful entry of each direct blocker.
   Not the whole feature log: by the end of a night most of it is noise
   for any one ticket.
2. **Persistence.** The log persists across runs and is committed with
   `progress.md`. A rerun after a bad night starts with the history.
3. **Agent channel.** The agent keeps a notes file inside its worktree,
   updated incrementally, which the orchestrator collects after the
   agent exits. Incremental writes survive max-turns and timeout kills;
   a stdout block or a final summary would not. Writing straight to
   `.scratch/` was rejected because it breaks worktree confinement.
4. **Patterns layer.** No "Codebase Patterns" section. AGENTS.md
   already fills that role (tight, re-read every session, merges via
   `merge=union`). `learnings.md` is the dated, ticket-specific
   history.
5. **Scope.** `runWavesIsolated` only. The in-place `runWaves` has no
   progress files or worktrees, and every run inside a git repo is
   isolated.
6. **TDD escape hatch.** Folded into this change: test-first is skipped
   for pure scaffolding, config, or docs items, and the agent says so
   in its notes.

## Design

### The log file

Path: `.scratch/<feature>/learnings.md`, next to `progress.md` and
`logs/` (derived as `join(dirname(tracker.pathFor(feature)),
'learnings.md')`).

Append-only, one entry per attempt, oldest first:

````markdown
<!-- nightralph:entry ticket=my-feature:4 attempt=2 outcome=tests -->
## 2026-10-07 03:14 -- my-feature/04 attempt 2 -- failed (tests)

Effort: xhigh. Agent exit: 0. Checked items: "parse header",
"reject bad input".

Test gate failed. Last 40 lines of `04-parser.attempt2.test.log`:

```
not ok 7 - rejects empty input
...
```

### Agent notes

<contents of .nightralph/notes.md, or "The agent left no notes.">

---
````

The sentinel comment is the only thing parsed; the `##` heading is for
humans. Agent notes may contain their own headings, so the heading is
never used as a delimiter. Any occurrence of the sentinel prefix
(`<!-- nightralph:entry`) inside agent notes is stripped before the
entry is written.

Sentinel fields:

- `ticket` -- `ticketKey(feature, num)`
- `attempt` -- attempt number within the run
- `outcome` -- one of:
  - `done` -- the attempt passed the test gate and is ready to merge
  - `exit` -- the agent exited non-zero
  - `tests` -- the test gate failed
  - `install` -- the install command failed (no agent ran)
  - `no-commits` -- the agent exited 0 with no new commits
  - `error` -- the attempt threw
  - `merge` -- an unrecovered merge failure after the wave
- `timedout=true` -- present only when the agent was killed at the
  timeout; combined with the outcome that followed (the heading reads
  e.g. "timed out, then tests failed")

Entry body by outcome:

- Every attempt entry: effort (when known), agent exit code, checked
  items, then the agent notes section.
- `tests` and `install`: the last `LOG_TAIL_LINES` (40) lines of the
  corresponding `.test.log` or `.install.log`, in a code fence.
- `error`: the error message.
- `merge`: orchestrator-only, with git's stderr from `MergeResult`. No
  agent notes section.

The log is committed whenever `saveProgress` runs, staged together with
`progress.md`, so it is never left uncommitted at a terminal state.

### Prompt changes

Two new sections in `renderPrompt`, between `TICKET` and
`AGENT INSTRUCTIONS`, each omitted when empty:

1. `---- PREVIOUS ATTEMPTS AT THIS TICKET ----` -- this ticket's
   entries, across runs, oldest first, at most `MAX_OWN_ENTRIES` (4,
   the most recent).
2. `---- WHAT THE BLOCKING TICKETS DID ----` -- for each direct
   blocker (`ticket.blockers`, same feature), its most recent `done`
   entry. Blockers of blockers are not included.

Both are preceded by a framing line: these are records of earlier runs;
the ticket or spec may have changed since; where they disagree, follow
the ticket and spec; do not repeat an approach these notes say failed
unless you can see why it failed.

Each entry is capped at `MAX_ENTRY_CHARS` (4000) characters; longer
entries are cut and end with `[truncated]`.

New and changed agent instructions:

1. Keep `.nightralph/notes.md` (create the directory) up to date as you
   work: after each checklist item and as soon as you hit a blocker,
   not only at the end. Record what you implemented, files changed,
   how you interpreted any vague acceptance criteria, what blocked you,
   and anything the next attempt at this ticket should know.
2. Never commit, `git add`, or delete that file. The orchestrator
   collects it.
3. The INTEGRITY rule's "say what blocked you" now points at the notes
   file.
4. The AGENTS.md rule gains one sentence: reusable patterns go in
   AGENTS.md; anything specific to this ticket goes in the notes file.
5. The /tdd rule gains an exception: for a checklist item that is pure
   scaffolding, config, or docs, where a test adds no value, skip
   test-first and say so in the notes file.

`renderMergePrompt` is unchanged. A respawned merge-conflict agent gets
no history and writes no notes.

### New module: `src/learnings.ts`

Pure functions:

- `renderEntry(opts):string` -- builds one entry. Takes ticket,
  attempt, outcome, optional `timedOut`, `effort`, `exitCode`,
  `completedItems`, `logName` + `logTail`, `error`, `stderr`, `notes`,
  and `now:Date` (passed in, so the function stays pure).
- `parseEntries(text):LearningEntry[]` -- splits on sentinel lines;
  `LearningEntry` is `{ ticketKey, attempt, outcome, timedOut, body }`.
  Text before the first sentinel is ignored.
- `selectHistory(entries, ticket):{ own, blockers }` -- `own` is the
  last `MAX_OWN_ENTRIES` entries for `ticketKey(ticket.feature,
  ticket.num)`; `blockers` is the latest `done` entry per direct
  blocker, in blocker order.
- `renderHistory(selection):string` -- the two prompt sections plus
  framing line, applying the per-entry cap; `''` when both lists are
  empty.
- `tailLines(text, n):string`.

Exported constants: `MAX_OWN_ENTRIES`, `MAX_ENTRY_CHARS`,
`LOG_TAIL_LINES`, `NOTES_PATH` (`.nightralph/notes.md`).

IO functions:

- `readEntries(path):LearningEntry[]` -- a missing file is `[]`.
- `appendEntry(path, text):void` -- synchronous append, creating the
  parent directory. Parallel tickets share one Node thread, so
  synchronous appends cannot interleave.
- `collectNotes(worktreePath):string|null` -- reads and deletes
  `<worktree>/.nightralph/notes.md` (and the then-empty directory);
  `null` when absent.
- `ensureExcluded(repoRoot):void` -- appends `.nightralph/` to
  `<git rev-parse --git-common-dir>/info/exclude` unless a line with
  that exact content is already there; creates `info/` if missing.

### Orchestrator changes

1. `renderPrompt` takes optional `opts.history?:string` and carries the
   new instructions above.
2. `runTicketAttempt` builds the history (read, select, render) before
   `spawnAgent`. Right after `spawnAgent` returns -- before
   `commitDirty` and before any `removeWorktreeQuietly` -- it calls
   `collectNotes`. Collecting first keeps the notes out of the
   auto-commit (`git add -A`) on the timeout path.
3. `TicketOutcome` variants that come from an agent run gain optional
   `notes?:string` and `timedOut?:boolean`.
4. `runTicketAttempts` appends an entry after every attempt, including
   the `'error'` path (notes are lost there; the error message is
   recorded). It is the one place that knows attempt number, effort,
   and log paths (`attemptLogPath`) for the tail.
5. Each unrecovered merge failure site in `runWavesIsolated` appends a
   `merge` entry before its `saveProgress`.
6. `saveProgress` also stages the feature's `learnings.md` when it is
   a regular file (`statSync(...).isFile()`, not mere existence, so a
   bad path cannot make `git add` fail and take the `progress.md`
   commit down with it). `commitProgress` accepts
   `path:string|string[]`.
7. `runWavesIsolated` calls `ensureExcluded(repoRoot)` once at start,
   after the dirty-tree check.

### Error handling

Learnings are advisory and never fail a ticket. Every learnings IO call
in the orchestrator is wrapped; a failure is reported via `d.log` and
the run continues. An unreadable log yields an empty history; a failed
append is logged and skipped; a failed `collectNotes` yields no notes;
a failed `ensureExcluded` is logged (the prompt still tells the agent
not to commit the file).

### Docs

- AGENTS.md: a contract section for `src/learnings.ts`; updates to the
  `renderPrompt`, `TicketOutcome`, `commitProgress`, and
  `runWavesIsolated` entries; `src/learnings.ts` in Project Structure.
- README: a note on `.scratch/<feature>/learnings.md` -- what it
  records, that it persists across runs and is committed, and that
  agents see their own and their blockers' entries.

## Testing

No assertion matches copy text. Mock agents write a random UUID token,
and tests check the token appears where it should (a later prompt, a
parsed entry, the log).

`test/learnings.test.ts` (added to `TESTS` in `scripts/test.sh`):

1. `renderEntry` -> `parseEntries` round-trips ticket key, attempt,
   outcome, and `timedOut`.
2. Notes containing the sentinel still parse as exactly one entry.
3. `selectHistory` returns the last 4 own entries; only the latest
   `done` per direct blocker; excludes blocker failures, unrelated
   tickets, the same number in another feature, and transitive
   blockers.
4. `renderHistory` of an empty selection is `''`; an oversized entry
   renders within `MAX_ENTRY_CHARS` plus the marker.
5. `tailLines` with fewer than `n` lines returns the input.
6. `collectNotes` returns contents and deletes the file; `null` when
   absent.
7. `ensureExcluded` run twice on a temp repo leaves exactly one line.

`test/orchestrator.test.ts` integration tests, with new mock agents:

1. **Retry sees history.** `mock-agent-notes-fail-then-pass.js` saves
   its stdin prompt to a file, writes a token to `.nightralph/notes.md`,
   fails unless escalated. Assert: attempt 2's prompt contains attempt
   1's token; `learnings.md` parses to two entries for the ticket
   (`exit`, then `done`); no commit on any ref touches `.nightralph/`;
   `learnings.md` is tracked and the base tree is clean at the end.
2. **Notes survive a timeout.** `mock-agent-notes-then-hang.js` writes
   a token then hangs; the entry is `timedOut` and contains the token.
3. **Red test gate.** A test command that prints a token and exits 1;
   the entry's outcome is `tests` and its body contains the token.
4. **Blocker history.** Ticket 2 blocked on ticket 1; ticket 1's notes
   token appears in ticket 2's prompt.
5. **Across runs.** A second `runWavesIsolated` on the same repo puts
   the first run's token in attempt 1's prompt.
6. **Advisory.** A directory occupies the `learnings.md` path; the
   ticket still finishes `done` and `progress.md` is still committed.

`renderPrompt` unit tests: a passed history string appears in the
prompt; a prompt with no history equals one with `history:''`.

## Out of scope

- History for the in-place `runWaves`.
- Notes from merge-conflict respawn agents.
- Pruning or rotating `learnings.md`; the prompt only ever reads a
  bounded slice of it.
- A shared "Codebase Patterns" section (AGENTS.md covers it).
