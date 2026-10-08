# Attempt Learnings Implementation Plan -- Phase 5: Docs

**Goal:** AGENTS.md and README describe the shipped learnings behavior.

**Architecture:** Documentation only. AGENTS.md carries the contracts
agents rely on; README tells users where the log lives and what it
does.

**Tech Stack:** Markdown.

**Scope:** Phase 5 of 5 from
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md`.

**Codebase verified:** 2026-10-06

---

## Acceptance Criteria Coverage

**Verifies: None.** This phase is documentation; it is verified by
reading it against the code from Phases 1-4. Per project rules, no
tests are written for docs.

---

Writing rules for both files: no em dashes (use `--`), no arrow
characters (use `->`), wrap at about 60-70 columns to match the
surrounding AGENTS.md style. Write for agents (AGENTS.md) and users
(README) respectively; describe behavior and guarantees, not
implementation history.

<!-- START_TASK_1 -->
### Task 1: AGENTS.md contracts

**Verifies:** None

**Files:**
- Modify: `AGENTS.md:20` area (Project Structure) -- add
  `src/learnings.ts` -- attempt learnings log (render, parse, select,
  notes collection)
- Modify: `AGENTS.md:240` area (`renderPrompt` contract) -- optional
  `opts.history`, placed between the ticket and the agent
  instructions and omitted when empty; the notes-file rule
  (`NOTES_PATH`, update incrementally, never commit); AGENTS.md vs
  notes split; the test-first exception for scaffolding, config, or
  docs items; INTEGRITY now records blocked items in the notes file
  (replacing "say what blocked it"); the commit rule excludes the
  notes file. Also fix the `renderPrompt(specBody, ticket, opts?)`
  signature in **Exposes** (`AGENTS.md:113`): `opts` is required
- Modify: `AGENTS.md:182` area (`TicketOutcome`) -- variants where an
  agent ran carry `agentRun:AgentRunRecord`
  (`{ exitCode, completedItems, timedOut, notes }`): `ready`,
  `failed` with reason `exit` or `tests`, and `no-commits`
  (`AgentRunRecord|null`, null only for the internal placeholder);
  `failed` with reason `install` has none. The top-level `exitCode` is
  the progress.md value (a placeholder `1` for test failures), while
  `agentRun.exitCode` is the agent's real exit code
- Modify: `AGENTS.md:284` area (`runWavesIsolated` guarantees) --
  each attempt calls `ensureNotesIgnored` before the agent and
  appends an entry
  to `learnings.md` next to the feature's `progress.md`; the prompt
  gets the ticket's last `MAX_OWN_ENTRIES` entries and each direct
  blocker's latest `done` entry; touched learnings files are committed
  right after each wave's pool settles, so the log is committed at
  every terminal point and the base tree has no modified tracked files
  before merging; unrecovered merges append a
  `merge` entry; learnings IO failures are logged and never fail a
  ticket
- Modify: `AGENTS.md:554` (**Exposes**: the signature becomes
  `commitProgress(repoRoot, paths, message)`) and the `AGENTS.md:557`
  area (`commitProgress`) -- accepts
  `string|string[]`; `saveProgress` stages `learnings.md` with
  `progress.md` when it is a regular file
- Add: a `### learnings module (src/learnings.ts)` section after the
  progress module section, in the same format as the others:
  **Exposes** (constants, `LearningOutcome`, `LearningEntry` -- whose
  ticket identity field is named `key` --, `AgentRunRecord`,
  `EntryInput`, `HistorySelection`, `renderEntry`, `parseEntries`,
  `selectHistory`, `renderHistory`, `tailLines`, `learningsPathFor`,
  `readEntries`, `appendEntry`, `collectNotes`,
  `ensureNotesIgnored`),
  the sentinel format
  (`<!-- nightralph:entry ticket=<key> attempt=<n> outcome=<o>
  [timedout=true] -->`, where only `%` and whitespace in the key are
  percent-escaped, so `ticket=my-feature:4` stays readable; `attempt`
  is `0` for `merge` entries) and outcome values, that it imports no
  values from `src/orchestrator.ts` (callers pass keys and labels),
  and
  **Guarantees** (parse drops malformed entries; sentinel text inside
  free-text fields is neutralized; `collectNotes` removes the notes
  directory, also when there are no notes; `ensureNotesIgnored`
  writes only inside the worktree, never `info/exclude`; `appendEntry` is
  synchronous)
- Modify: `AGENTS.md:3` -- update `Last verified:` to the date of the
  change

**Steps:**
1. Make the edits above, reading the final code from Phases 1-4 for
   exact names.
2. Check: `grep -n "learnings" AGENTS.md` shows the new section and
   each updated contract.

**Commit:** with Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: README note

**Verifies:** None

**Files:**
- Modify: `README.md`, in the `**Notes**:` block that starts around
  line 175

**Steps:**
1. Add a note explaining: each attempt at a ticket appends an entry to
   `.scratch/<feature>/learnings.md` with what the orchestrator saw
   (outcome, exit code, the tail of the test or install log) and the
   agent's own notes; the file is committed alongside `progress.md`
   and persists across runs; each agent's prompt includes its own
   ticket's recent entries and what its direct blockers did; agents
   keep their notes in `.nightralph/notes.md` inside the worktree,
   which nightralph collects and keeps out of commits with a
   self-ignoring `.nightralph/.gitignore`.
2. Read the note against the code once more for accuracy.

**Commit:**
```bash
git add AGENTS.md README.md
git commit -m "docs: attempt learnings contracts and README note"
```
<!-- END_TASK_2 -->
