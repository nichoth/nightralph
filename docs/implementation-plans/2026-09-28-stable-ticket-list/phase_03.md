# Stable ticket list implementation plan -- phase 3

**Goal:** Contracts and user docs describe the fixed ticket list, the
blocked status, and what a wave is.

**Architecture:** Documentation only. `AGENTS.md` holds the module
contracts other agents rely on; `README.md` holds user-facing
behavior.

**Tech Stack:** Markdown.

**Scope:** Phase 3 of 3 from
`docs/design-plans/2026-09-28-stable-ticket-list.md`.

**Codebase verified:** 2026-09-28

---

## Acceptance Criteria Coverage

This phase is documentation; it implements no acceptance criteria.

**Verifies:** None

---

## Writing rules

From `/Users/nick/.claude/CLAUDE.md`: never use em dashes (use `--`)
and never use the unicode arrow (use `->`). Match the surrounding
wrap width (about 60 columns in `AGENTS.md` contract bullets, 76 in
`README.md`). Do not write tests for docs.

---

<!-- START_TASK_1 -->
### Task 1: Update AGENTS.md contracts

**Files:**
- Modify: `AGENTS.md:356-419` (display module)
- Modify: `AGENTS.md:94-335` (orchestrator)
- Modify: `AGENTS.md:3` (`Last verified:` date -> 2026-09-28)

**Changes, display module section:**
- **Exposes**: add `startRun`, `setBlocked` to the interface line,
  and add `TicketRef` and `ticketLabel` to the exposed list.
- **Display interface**: `startRun(tickets)`,
  `startWave(waveNum, totalWaves, tickets, progress?)`,
  `setTicketStatus(num, status, feature?)`,
  `setBlocked(num, feature, blockedBy)`, `log`, `cleanup`.
- **TicketStatus**: add `'blocked'`, drawn as a dim filled dot.
  Blocked means an upstream ticket failed or is not agent work, so
  the ticket cannot run this session; the row names those tickets
  as `(blocked by a/01, a/02)`.
- Replace the **remaining** bullet with a **startRun** bullet: called
  once before the first wave; fixes the rendered list for the rest
  of the run; rows never move, vanish or reappear; `startWave` never
  resets statuses. When `startRun` was never called, the first
  `startWave` seeds the list from its tickets.
- **WaveState**: still exported, now `{ waveNum, totalWaves }` (the
  ticket list moved onto `StatusDisplay`). Say so where
  `AGENTS.md:359` lists it.
- **RunProgress**: now used only by `PlainDisplay`. `StatusDisplay`
  computes done/total from its fixed list, so the header
  (`Wave N/M - D/T done - P%`) and the rows cannot disagree.
- Keep the existing width, log, and signal-handler guarantees.

**Changes, orchestrator section:**
- **Exposes**: add `findBlockedTickets(tickets, failedKeys)`.
- New bullet **findBlockedTickets**: pure; maps each
  `ready-for-agent`, non-failed ticket to the dead tickets upstream
  of it within its feature (dead = in `failedKeys`, or a status that
  is neither `done` nor `ready-for-agent`); missing blocker numbers
  are not dead; cycles terminate.
- **runWaves** and **runWavesIsolated**: capture the session set
  (`ready-for-agent` before the loop, sorted by feature then number);
  call `startRun` once when wave 1 starts (never for a run with
  nothing ready); report blocked tickets via `setBlocked` right after
  `startRun`, at the top of each later loop iteration, and once after
  the loop (so the `-X` stop and no-progress breaks still report);
  progress passed to `startWave` counts only the session set.
- **runWavesIsolated** guarantees: an unrecovered merge failure also
  sets the ticket's display status to `failed` (it was left
  `awaiting-merge`). Known limit: under `-X`, branches after the stop
  point never enter `mergeResult.merged`, so their rows stay
  `awaiting-merge` in the final frame.
- Remove any mention of the `remaining` argument.

**Verification:**
Run: `grep -n "remaining" AGENTS.md`
Expected: no hit refers to the `startWave` argument (hits about
"remaining" tickets in `renderFinishSummary` are fine).

**Commit:** `docs: AGENTS.md contracts for the fixed ticket list`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Explain waves and the status display in README.md

**Files:**
- Modify: `README.md:256-291` ("How It Works")
- Modify: `README.md:191-192`

**Changes:**
- At `README.md:191` ("Failed tickets (non-zero exit) keep their
  status and block dependents."), add that the status display marks
  those dependents as blocked and names the failed ticket.
- Rewrite the opening of "How It Works" to define a wave in plain
  terms: a batch of tickets whose blockers are all done; they run in
  parallel (up to `--concurrency` at once); nightralph waits for the
  whole batch, merges the branches, then looks for newly unblocked
  tickets, which form the next wave. The wave total in the header is
  a prediction that assumes every ticket succeeds.
- Add a short "Status display" subsection: the list shows every
  ticket that was `ready-for-agent` at startup and stays the same for
  the whole run; one line per dot state (pending, running, waiting to
  merge, done, failed, blocked); the header format
  `Wave 2/3 - 5/8 done - 62%` and that the counts cover only this
  run's tickets. Mention that non-TTY output prints one line per wave
  instead. Note one known limit: with `-X`, a ticket whose branch
  succeeded but sat after the conflicting branch is never merged, and
  its row stays on the "waiting to merge" dot when the run stops.
- Regenerate the table of contents (`README.md:22-46`, between the
  `<!-- toc -->` markers) so it lists the new subsection.

**Verification:**
Run: `npm run toc`
Expected: the TOC block now includes "Status display" under
"How It Works"; no other README lines change (check `git diff
README.md`).
Run:
`perl -CSD -ne 'print "$ARGV:$.:$_" if /[\x{2014}\x{2192}]/; close ARGV if eof' README.md AGENTS.md`
Expected: no output.
Run: `npm run lint && npm test`
Expected: pass.

**Commit:** `docs: explain waves and the status display`
<!-- END_TASK_2 -->
