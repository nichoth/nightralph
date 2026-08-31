# Terminal Status UI -- Human Test Plan

## Prerequisites

- Node >= 24 installed
- `npm test` passing (all tests green)
- A terminal emulator that supports 256 colors (iTerm2,
  Terminal.app, Gnome Terminal, etc.)
- At least 2 test ticket files in a `.scratch/<feature>/`
  directory (or use the mock tickets below)

## Setup: Create test fixtures

Create a temporary feature directory for manual testing:

```
mkdir -p .scratch/manual-test
```

Create 8 ticket files (enough to trigger pagination on a
short terminal):

```
for i in $(seq 1 8); do
  printf '# Ticket %d\n\n**Status:** ready-for-agent\n\n## Spec\n\nPrint hello from ticket %d.\n' "$i" "$i" > ".scratch/manual-test/0${i}-task${i}.md"
done
```

Create a spec file:

```
echo '# Manual Test Spec' > .scratch/manual-test/spec.md
```

## Phase 1: Color verification (AC1.3, AC1.4, AC1.5)

These criteria have automated tests confirming the correct
ANSI codes are emitted, but perceived color depends on the
terminal's color scheme.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `npx nightralph claude --spec manual-test --dry-run` to confirm tickets are detected | Dry-run output lists all 8 tickets in wave order |
| 2 | Run `npx nightralph claude --spec manual-test` (or substitute your provider) | Terminal UI appears with a status line and ticket list |
| 3 | Observe tickets before any agent starts processing | Each ticket line shows a dim/empty dot character next to the filename |
| 4 | Observe a ticket when the agent begins working on it | The dot changes to a filled circle in yellow/amber color |
| 5 | Observe a ticket after the agent completes it successfully | The dot changes to a filled circle in green |
| 6 | To verify red/failed: interrupt an agent mid-run (Ctrl+C while the agent is processing, then re-run), or create a ticket that will fail | The failed ticket's dot should be a filled circle in red |
| 7 | Verify that dots are visually distinguishable from each other: pending (dim), in-progress (yellow), done (green), failed (red) | Four distinct visual states are clearly differentiated |

## Phase 2: Terminal resize (AC5 resize)

The resize event wiring is a single `stream.on('resize', ...)`
call. The automated tests verify the listener is registered
and that `render()` produces correct output for different
`rows` values. This step verifies the OS-level SIGWINCH wiring.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Resize your terminal to approximately 15 rows tall (short enough that not all 8 tickets fit) | -- |
| 2 | Run `npx nightralph claude --spec manual-test` | Terminal UI appears with pagination indicators ("... N more below") because not all tickets fit |
| 3 | While the display is running, drag the terminal window taller (add ~10 rows) | The display re-renders immediately; more tickets become visible; the "more below" count decreases or disappears |
| 4 | Drag the terminal window shorter again | The display re-renders; fewer tickets are visible; the "more below" indicator reappears with a higher count |
| 5 | Verify no visual artifacts (leftover lines, broken layout) after each resize | The display is clean after every resize |

## Phase 3: runWavesIsolated end-to-end (AC7.1)

The automated test covers `runWaves` (in-place execution).
`runWavesIsolated` uses the same Display API but adds git
worktree management. This step verifies the full end-to-end
path.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Ensure you are inside a git repository with a clean working tree | `git status` shows no uncommitted changes |
| 2 | Run `npx nightralph claude --spec manual-test` from inside the git repo | The CLI auto-detects the git repo and uses `runWavesIsolated` |
| 3 | Observe the terminal UI | Status display appears with wave number, ticket dots, percentage, and rolling message area -- identical layout to the non-isolated mode |
| 4 | Verify worktrees are created | While running, open another terminal and run `git worktree list`; sibling directories named `<repo>.<num>-<slug>` should appear |
| 5 | Wait for all tickets to complete | All dots turn green, percentage reaches 100%, branches are merged back |
| 6 | Verify cleanup | `git worktree list` shows only the main worktree; the terminal cursor is restored (visible, not hidden) |

## End-to-End: Full wave lifecycle

Validates the complete display lifecycle across multiple
waves, including transitions, percentage resets, and message
area behavior.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create tickets with dependencies so they form 2+ waves (use `depends: 01` in a ticket's frontmatter) | `--dry-run` shows multiple waves |
| 2 | Run the orchestrator | Wave 1 starts: status line shows "Wave 1/N -- 0% complete" |
| 3 | Watch Wave 1 progress | Tickets transition pending -> in-progress -> done/failed; percentage climbs toward 100% |
| 4 | Watch the wave transition | When Wave 1 completes, the display clears Wave 1 tickets and shows Wave 2 tickets; status line updates to "Wave 2/N"; percentage resets to 0% |
| 5 | Watch the rolling message area throughout | Messages appear and scroll; older messages are pushed out when the buffer fills; both agent stdout lines and orchestrator status messages appear |
| 6 | After all waves complete | `cleanup()` is called; cursor reappears; terminal is usable |

## End-to-End: Non-TTY fallback

Validates that piping output to a file or another process
produces clean, ANSI-free output.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `npx nightralph claude --spec manual-test 2>&1 \| cat` | Output goes to cat (non-TTY); should see plain-text wave/ticket info with no escape codes |
| 2 | Run `npx nightralph claude --spec manual-test > /tmp/nightralph-output.txt 2>&1` | -- |
| 3 | Inspect `/tmp/nightralph-output.txt` | File contains readable text with no `\x1b[` sequences; wave starts and log messages are present |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC1.3 -- In-progress yellow dot | Color perception requires a real terminal | Phase 1 steps 4, 7 |
| AC1.4 -- Completed green dot | Same rationale | Phase 1 steps 5, 7 |
| AC1.5 -- Failed red dot | Same rationale | Phase 1 steps 6, 7 |
| AC5 resize -- Terminal resize triggers re-render | SIGWINCH wiring requires a real TTY | Phase 2 all steps |
| AC7.1 -- runWavesIsolated integration | Requires real git repo with worktrees | Phase 3 all steps |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 -- Dot + filename | "renders dot and filename for each ticket" | -- |
| AC1.2 -- Pending empty dot | "pending ticket shows empty/dim dot" | -- |
| AC1.3 -- In-progress yellow dot | "in-progress ticket shows yellow filled dot" | Phase 1, steps 4, 7 |
| AC1.4 -- Completed green dot | "done ticket shows green filled dot" | Phase 1, steps 5, 7 |
| AC1.5 -- Failed red dot | "failed ticket shows red filled dot" | Phase 1, steps 6, 7 |
| AC2.1 -- Status line wave/total | "status line shows Wave..." | -- |
| AC2.2 -- Percentage progress | "percentage reflects completed..." | -- |
| AC3.1 -- Fixed message height | "message area has fixed height..." | -- |
| AC3.2 -- Rolling window | "new messages push old messages out" | -- |
| AC3.3 -- Any message source | "log accepts any string message" | -- |
| AC4.1 -- Wave transition clears | "startWave resets ticket list..." | -- |
| AC4.2 -- Wave number updates | "startWave updates wave number..." | -- |
| AC5.1 -- Viewport pagination | "viewport limits rendering..." | -- |
| AC5.2 -- Auto-scroll | "auto-scroll on in-progress..." | -- |
| AC5 resize -- Resize re-render | "resize event triggers re-render" | Phase 2, all steps |
| AC6.1 -- Non-TTY fallback | "createDisplay returns PlainDisplay..." | E2E Non-TTY fallback |
| AC6.2 -- No ANSI in plain mode | "PlainDisplay implements Display..." | E2E Non-TTY fallback, step 3 |
| AC7.1 -- runWaves integration | "AC7.1 -- runWaves calls display..." | Phase 3, all steps |
| AC7.2 -- Agent output to display | "spawnAgent onLine callback..." + "AC7.2 -- Agent output feeds..." | -- |
