# Human test plan: stable ticket list

Implementation plan:
`docs/implementation-plans/2026-09-28-stable-ticket-list/`

Automated coverage: 30 of 30 acceptance criteria are covered by tests in
`test/display.test.ts`, `test/orchestrator.test.ts` and
`test/integration.test.ts`. This plan covers what the tests cannot see:
how the display looks and behaves in a real terminal, and full CLI runs.

## Prerequisites

1. `cd /Users/nick/code/nightralph && npm test` passes. `npm run lint`
   is clean.
2. `npm run build`, then use `node /Users/nick/code/nightralph/dist/index.js`
   as `NR` below (or run `npm link` and use `nightralph`).
3. The `claude` CLI is installed and logged in. Each fixture costs a few
   agent turns, so keep tickets trivial and always pass `--retries 0`.
4. A real terminal window you can resize, and both a light and a dark
   color theme.
5. For the AC4.5 baseline: `npx nightralph@0.0.52` or a separately built
   checkout of `main`. `package.json` on this branch also says 0.0.52, so
   do not rely on the version string.

Ticket file template. Each ticket is `.scratch/demo/issues/NN-slug.md`:

```
# <title>

**Status:** ready-for-agent
**Blocked by:** None

- [ ] Append the line "NN" to notes.txt and commit.
```

Scratch repo setup, used by every git fixture:

1. `mkdir /tmp/nr-X && cd /tmp/nr-X && git init`
2. `printf '.scratch/\n' > .gitignore && echo start > notes.txt && git add . && git commit -m init`
3. `mkdir -p .scratch/demo/issues`, then
   `printf '# Demo\n\nTiny edits to notes.txt.\n' > .scratch/demo/spec.md`
4. `.scratch/` must stay ignored. `runWavesIsolated` refuses to start on
   a dirty tree.

## Phase 1: StatusDisplay rendering (demo, no agent)

| Step | Action | Expected |
|------|--------|----------|
| 1 | In a TTY at 80x24 or larger, run `cd /Users/nick/code/nightralph && npm run demo` | Header reads `Wave 1/2 - 0/5 done - 0%`. All 5 tickets are listed in order 01..05. 04 and 05 are not in the wave but still appear, with dim empty dots |
| 2 | Watch the first ~8 seconds | 01 turns yellow, then green. Header goes to `1/5 done - 20%`. No row moves |
| 3 | Watch until 03 fails (~6s in) | 03 turns red. 05 gets a dim filled dot and the suffix `(blocked by 03-dashboard-ui.md)`. 04 keeps its dim empty dot. Header shows `2/5 done - 40%`: failed and blocked rows are not counted |
| 4 | Compare the 05 row (blocked) with the 04 row (pending) | The dim filled dot and the dim empty dot are easy to tell apart at a glance (AC2.5) |
| 5 | Repeat steps 1-4 in the other color theme | The blocked dot is still distinct from pending, yellow, cyan, green and red in both themes |
| 6 | Re-run the demo and resize the window while it runs, including down to ~30 columns | No stale rows or duplicated headers after a resize. No row wraps onto a second line. The blocked suffix truncates cleanly. At very narrow widths the header may lose its trailing `%`; decide whether that is acceptable |
| 7 | Re-run the demo in a window only ~9 rows tall | The list paginates with a "more below" marker. When a ticket below the fold goes in-progress, it scrolls into view and "more above" appears (AC1.9) |
| 8 | When the demo ends | The cursor is visible, the prompt is clean, and "Demo complete." prints |

## Phase 2: Orchestrator blocking (real runs)

### Fixture A: blocked from startup, no failure needed

Scratch repo `/tmp/nr-a`, with these tickets:

1. `01-human.md` with Status `ready-for-human`
2. `02-after-human.md` blocked by `1`
3. `03-after-two.md` blocked by `2`
4. `04-free.md` with no blockers

| Step | Action | Expected |
|------|--------|----------|
| 1 | `cd /tmp/nr-a && NR claude --spec demo --test-cmd true --retries 0` | The first frame lists demo/02, demo/03 and demo/04 only. demo/01 is not listed. Header total is 3 |
| 2 | Look at the first frame before the agent finishes | demo/02 has the blocked dot and `(blocked by demo/01)`. demo/03 has the blocked dot and `(blocked by demo/01)`, naming the human ticket rather than demo/02 (AC2.9, AC2.10) |
| 3 | Let it finish | demo/04 goes green. Header ends at `1/3 done - 33%`, not 100%. The finish summary names demo 01 as needing a human and lists 02 and 03 as blocked on it. `echo $?` prints 0 |
| 4 | Narrow the window to ~40 columns and re-run from a fresh copy of the fixture | The suffix truncates cleanly and no row wraps |

### Fixture B: failure across waves, isolated mode

Scratch repo `/tmp/nr-b`, with these tickets:

1. `01-a.md` with no blockers
2. `02-b.md` with no blockers
3. `03-c.md` blocked by `2`
4. `04-d.md` blocked by `1, 3`

| Step | Action | Expected |
|------|--------|----------|
| 1 | `cd /tmp/nr-b && NR claude --spec demo --retries 0 --test-cmd 'test -z "$(git rev-parse --abbrev-ref HEAD \| grep -- --01-)"'` | The test command fails only on ticket 1's branch (`<repo>--01-a`). Wave 1 runs 01 and 02 |
| 2 | Watch the end of wave 1 | 01 turns red. 04 becomes blocked with `(blocked by demo/01)` before wave 2 starts. 02 is green |
| 3 | Watch wave 2 | Header shows `Wave 2/...`. 01 is still red and 02 still green. 03 runs and turns green. Rows never reorder, disappear or reappear |
| 4 | Resize the window during wave 2 | Clean repaint, no leftover rows |
| 5 | End state | Header shows `2/4 done - 50%`. 01 red, 02 and 03 green, 04 blocked naming demo/01 only (not demo/03). The logs dir has `01-a.test.log` |

Optional in-place variant (covers `runWaves` without worktrees): copy the
same tickets into a directory that is not a git repo
(`mkdir /tmp/nr-b-plain`, no `git init`). The branch-name trick does not
work there, so use `--test-cmd true` and make ticket 01's text impossible
(for example "Run `false` and report failure; do not echo [x]"). At
minimum, confirm that 02, 03 and 04 render in a stable order and turn
green in order.

### Fixture C: nothing runnable

Scratch repo `/tmp/nr-c`, with these tickets:

1. `01-done.md` with Status `done`
2. `02-human.md` with Status `ready-for-human`
3. Variant: add `03-waiting.md`, ready-for-agent and blocked by `2`

| Step | Action | Expected |
|------|--------|----------|
| 1 | `cd /tmp/nr-c && NR claude --spec demo --test-cmd true` in a TTY | No status grid or `Wave` header is drawn. The finish summary prints as plain text and names demo 02 as needing a human. Exit code is 0 |
| 2 | Add the variant ticket 03 and re-run | Still no grid. The summary lists 03 as blocked on the human ticket |

### Fixture D: merge conflict, with and without `-X` (AC2.6)

Scratch repo `/tmp/nr-d`, with these tickets:

1. `01-first.md`, no blockers: "Replace the entire contents of notes.txt
   with the single line `from-01`."
2. `02-second.md`, no blockers: "Replace the entire contents of
   notes.txt with the single line `from-02`."
3. `03-after.md`, blocked by `2`: "Append `03` to other.txt."

| Step | Action | Expected |
|------|--------|----------|
| 1 | `cd /tmp/nr-d && NR claude --spec demo --test-cmd true --retries 0 -X` | Wave 1 runs 01 and 02. 01 merges and turns green. 02's rebase conflicts |
| 2 | Observe the stop | The run stops merging and does not respawn an agent. 02 is marked failed (red) or left not-done in progress.md. 03 is shown blocked with `(blocked by demo/02)` and does not run. The finish summary appears |
| 3 | Re-run from a fresh copy of the fixture without `-X` | A respawned agent resolves the conflict; the 02 row stays cyan while it works. If the respawn fails, 02 turns red and 03 is still reported blocked naming demo/02 |
| 4 | Run `git worktree list` and `git branch` in the repo afterwards | No stray worktrees are left for failed or stopped tickets |

## End-to-end: non-TTY output unchanged (AC4.5)

Purpose: confirm `PlainDisplay` prints the same wave lines as the
previous release, and nothing extra for `startRun` or `setBlocked`.

1. Create two identical copies of Fixture B: `/tmp/nr-b-new` and
   `/tmp/nr-b-old`.
2. `cd /tmp/nr-b-new && NR claude --spec demo --retries 0 --test-cmd '<fixture B cmd>' 2>&1 | cat > /tmp/new.txt`
3. `cd /tmp/nr-b-old && npx nightralph@0.0.52 claude --spec demo --retries 0 --test-cmd '<fixture B cmd>' 2>&1 | cat > /tmp/old.txt`
4. Remove agent output lines from both files, for example
   `grep -vE '^\[' /tmp/new.txt > /tmp/new.f` (adjust the filter to the
   prefix agent lines carry), then `diff /tmp/old.f /tmp/new.f`.
5. Expected: the only differences come from agent nondeterminism. Wave
   lines and the finish summary have the same format, there are no ANSI
   escape codes, and there are no "blocked" lines.

## End-to-end: header accuracy across a whole run (AC3.1-AC3.5)

1. During Fixture B, write down the header at the start, after wave 1,
   and at the end.
2. Expected: `Wave 1/N - 0/4 done - 0%`, then `... 1/4 done - 25%`, then
   `Wave 2/N ... 2/4 done - 50%`. The total stays 4 the whole time, and
   it never reaches 100% while 01 is red and 04 is blocked.
3. Fixture A should also stop short of 100%. A run where every ticket
   succeeds should end at exactly `100%` with every row green.

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC2.5 | Tests only prove the escape codes differ. Blocked and pending share the dim color and differ only in glyph | Phase 1 steps 4-5, Fixture A step 2, in light and dark themes |
| AC2.2, AC2.4, AC2.9 | Suffix wording and truncation are deliberately not asserted | Fixture A steps 2 and 4, Fixture B step 5, Phase 1 step 6 |
| AC1.1, AC1.2, AC1.3, AC1.5, AC2.1 | The mock stream cannot show flicker, stale rows or rows jumping | Fixture B steps 2-4, Phase 1 step 6 |
| AC1.9 | Scroll feel in a real terminal | Phase 1 step 7 |
| AC3.1 | Header readability, including narrow-width clipping of `%` | Header end-to-end section, Phase 1 step 6 |
| AC4.4 | The full CLI path to a real TTY | Fixture C |
| AC4.5 | The automated test compares against itself, not the previous release | Non-TTY end-to-end section |
| AC2.6 (stop) | Real git conflict and `-X` behavior | Fixture D |

## Traceability

| Acceptance criterion | Automated test | Manual step |
|----------------------|----------------|-------------|
| AC1.1 | display.test.ts "AC1.1: all session tickets rendered after startRun" | Phase 1 step 1, Fixture B step 3 |
| AC1.2 | display.test.ts "AC1.2/AC1.5 ..." | Fixture B step 3 |
| AC1.3 | display.test.ts "AC1.3: ticket order is stable across waves" | Fixture B steps 3-4 |
| AC1.4 | display.test.ts "AC1.4 AC1.6 AC4.1 ..." | Fixture A step 1 (order 02, 03, 04) |
| AC1.5 | display.test.ts "AC1.2/AC1.5 ..." | Fixture B step 3 |
| AC1.6 | display.test.ts "AC1.4 AC1.6 AC4.1 ..." | Fixture A step 1 (01 not listed) |
| AC1.7 | display.test.ts "AC1.7: without startRun ..." | -- |
| AC1.8 | display.test.ts "AC1.8: setTicketStatus for unknown ticket ignored" | -- |
| AC1.9 | display.test.ts "AC1.9 ...", "non-wave tickets are included in pagination" | Phase 1 step 7 |
| AC2.1 | display.test.ts "AC2.1: failed ticket keeps red dot in later waves" | Fixture B steps 3, 5 |
| AC2.2 | orchestrator.test.ts "direct blocker failed"; display.test.ts "blocked suffix contains blocker label"; AC4.3 tests | Fixture B step 2 |
| AC2.3 | orchestrator.test.ts "chain through ready ticket" | Fixture A step 2 |
| AC2.4 | orchestrator.test.ts "multiple failed blockers", "diamond pattern"; display.test.ts "blocked suffix with multiple blockers" | Fixture B step 5 |
| AC2.5 | display.test.ts "AC2.5: renderDot(blocked) differs ..." | Phase 1 steps 4-5 |
| AC2.6 | integration.test.ts AC2.6 respawn and stop tests | Fixture D |
| AC2.7 | orchestrator.test.ts "different features" | -- |
| AC2.8 | display.test.ts "AC2.8: blocked row fits terminal width", "AC2.8: blocked row shows blocked dot" | Phase 1 step 6, Fixture A step 4 |
| AC2.9 | orchestrator.test.ts "human status blocker"; display.test.ts "setBlocked before the first startWave is kept"; AC4.3 tests | Fixture A step 2 |
| AC2.10 | orchestrator.test.ts "chain to human ticket" | Fixture A step 2 |
| AC2.11 | orchestrator.test.ts "done blocker not blocking", "missing blocker number", "cycle" | -- |
| AC3.1 | display.test.ts headerNumbers-based tests and the header test | Header end-to-end |
| AC3.2 | display.test.ts "AC3.2/AC3.3 ...", "percentage comes from fixed list ..." | Header end-to-end step 2 |
| AC3.3 | display.test.ts "AC3.2/AC3.3 ..." | Header end-to-end step 2 |
| AC3.4 | display.test.ts "AC3.4: header shows 100% when all done" | Header end-to-end step 3 |
| AC3.5 | display.test.ts "AC3.5: failed and blocked do not count as done" | Phase 1 step 3, Fixture B step 5 |
| AC4.1 | display.test.ts "AC1.4 AC1.6 AC4.1 ..." | Fixture B in-place variant |
| AC4.2 | integration.test.ts "AC4.2 AC4.3: startRun once ..." | Fixture A step 1, Fixture B step 1 |
| AC4.3 | display.test.ts two AC4.3 tests; integration.test.ts two AC4.3 tests | Fixture A step 2, Fixture B step 2 |
| AC4.4 | orchestrator.test.ts "runWaves with nothing runnable ...", "only human tickets ..."; integration.test.ts AC4.4; display.test.ts "log before any wave ..." | Fixture C |
| AC4.5 | display.test.ts two AC4.5 tests | Non-TTY end-to-end |
