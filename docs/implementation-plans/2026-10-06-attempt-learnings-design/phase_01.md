# Attempt Learnings Implementation Plan -- Phase 1: Learnings core

**Goal:** A pure module that renders, parses, selects, and formats
per-attempt learning entries for `.scratch/<feature>/learnings.md`.

**Architecture:** New `src/learnings.ts`. Pure functions only in this
phase; no fs, no git. The module does not import values from
`src/orchestrator.ts` (which will import it in Phase 4), so callers pass
precomputed ticket keys (`ticketKey(feature, num)`) and labels
(`ticketLabel(ticket)`) instead of `Ticket` objects.

**Tech Stack:** TypeScript (ESM, NodeNext), `@substrate-system/tapzero`,
esbuild-bundled tests via `scripts/test.sh`.

**Scope:** Phase 1 of 5 from
`docs/superpowers/specs/2026-10-06-attempt-learnings-design.md`.

**Codebase verified:** 2026-10-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### attempt-learnings-design.AC1: Entries round-trip through the log
- **attempt-learnings-design.AC1.1 Success:** An entry built by
  `renderEntry` and read back by `parseEntries` keeps its ticket key,
  attempt number, outcome, and timed-out flag.
- **attempt-learnings-design.AC1.2 Edge:** Agent notes containing the
  sentinel prefix still parse as exactly one entry.
- **attempt-learnings-design.AC1.3 Success:** `tailLines(text, n)`
  returns the last `n` lines, or the whole input when it has fewer.

### attempt-learnings-design.AC2: History is bounded and relevant
- **attempt-learnings-design.AC2.1 Success:** A ticket's own history
  holds at most its `MAX_OWN_ENTRIES` most recent entries, oldest first.
- **attempt-learnings-design.AC2.2 Success:** For each direct blocker,
  the history holds only that blocker's most recent `done` entry.
- **attempt-learnings-design.AC2.3 Failure:** Blocker failures,
  unrelated tickets, the same ticket number in another feature, and
  blockers of blockers are excluded.
- **attempt-learnings-design.AC2.4 Edge:** An empty selection renders
  as an empty string.
- **attempt-learnings-design.AC2.5 Edge:** An entry longer than
  `MAX_ENTRY_CHARS` renders within `MAX_ENTRY_CHARS` plus the
  truncation marker.

---

## Conventions for every task

- TS style: no space between colon and type (`foo:string`), no spaces
  in inline unions (`A|B`), 4-space indent, lines at most 80 columns,
  ternaries with `?` and `:` at line end. Enforced by
  `eslint.config.js`; run `npm run lint`.
- `import type` for type-only imports (lint rule
  `consistent-type-imports`). Relative imports use the `.js` suffix.
- Do not add FCIS classification comments to source files.
- Docs and comments: no em dashes (use `--`), no arrow characters (use
  `->`).
- Tests never assert on prose copy. Assert on parsed fields, lengths,
  equality between two renders, or a random token appearing.

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Types, constants, and `renderEntry`

**Verifies:** None on its own (Task 3 tests it via round-trip)

**Files:**
- Create: `src/learnings.ts`

**Implementation:**

Constants and types:

```ts
export const MAX_OWN_ENTRIES = 4
export const MAX_ENTRY_CHARS = 4000
export const LOG_TAIL_LINES = 40
export const NOTES_PATH = '.nightralph/notes.md'

const SENTINEL_PREFIX = '<!-- nightralph:entry'
export const TRUNCATED_MARKER = '[truncated]'

export const LEARNING_OUTCOMES = [
    'done',
    'exit',
    'tests',
    'install',
    'no-commits',
    'error',
    'merge',
] as const
export type LearningOutcome = typeof LEARNING_OUTCOMES[number]

export type LearningEntry = {
    key:string
    attempt:number
    outcome:LearningOutcome
    timedOut:boolean
    // Everything after the sentinel line, trimmed, without the
    // trailing `---` separator
    body:string
}

type EntryBase = {
    key:string    // ticketKey(feature, num)
    label:string  // ticketLabel(ticket), e.g. "my-feature/04"
    attempt:number  // 0 for merge entries
    now:Date
}

// What one agent process did. Phase 4 attaches this to every
// attempt outcome where an agent actually ran.
export type AgentRunRecord = {
    exitCode:number
    completedItems:string[]
    timedOut:boolean
    notes:string|null
}

type AgentFields = { run:AgentRunRecord; effort?:string }

type LogTail = { logName:string; logTail:string }

export type EntryInput = EntryBase&(
    | (AgentFields&{ outcome:'done'|'exit'|'no-commits' })
    | (AgentFields&LogTail&{ outcome:'tests' })
    | (LogTail&{ outcome:'install' })
    | { outcome:'error'; error:string }
    | { outcome:'merge'; stderr:string }
)
```

Type operators are written without surrounding spaces (`A&B`, `A|B`),
per the repo's `local/union-spacing` lint rule (existing precedent:
`TicketAttemptOpts&{ attempt:number }` in `src/orchestrator.ts`).

`renderEntry(input:EntryInput):string` returns one entry:

1. Sentinel line:
   `<!-- nightralph:entry ticket=<encodeKey(key)>
   attempt=<n> outcome=<o>[ timedout=true] -->` (one line).
   `timedout=true` only when the variant has `run.timedOut` true.
   `encodeKey` escapes only `%` and whitespace, so the key stays
   readable (`ticket=my-feature:4`) while a space in a feature name
   cannot split the attribute list:
   ```ts
   function encodeKey (key:string):string {
       return key
           .replace(/%/g, '%25')
           .replace(/\s/g, c => encodeURIComponent(c))
   }
   ```
2. `## <YYYY-MM-DD HH:MM> -- <label>[ attempt <n>] -- <description>`.
   Format `now` in local time with zero-padded fields (no external
   date library). Omit ` attempt <n>` for `merge`. Description:
   `done` -> `done`; `exit` -> `failed (exit <run.exitCode>)`;
   `tests` -> `failed (tests)`; `install` -> `failed (install)`;
   `no-commits` -> `no commits`; `error` -> `error`;
   `merge` -> `merge failed`. Prefix with `timed out, then ` when
   `run.timedOut` is true.
3. A blank line, then the body:
   - Agent-run variants: one paragraph with `Effort: <effort>.` (only
     when set), `Agent exit: <run.exitCode>.`, and
     `Checked items: "<a>", "<b>".` from `run.completedItems` (or
     `Checked items: none.`).
   - `tests`/`install`: `Test gate failed.` / `Install failed.`, then
     `Last <LOG_TAIL_LINES> lines of \`<logName>\`:` and the tail in a
     fenced block (see fence rule below).
   - `error`: the error text in a fenced block.
   - `merge`: `Merge failed.` and the stderr in a fenced block.
   - Agent-run variants end with `### Agent notes` and the notes, or
     `The agent left no notes.` when `run.notes` is null or blank.
4. A final `---` line followed by a blank line, so appended entries are
   separated.

Sanitizing: every free-text field that comes from outside
(`run.notes`, `logTail`, `error`, `stderr`, `run.completedItems`) has
every
occurrence of `SENTINEL_PREFIX` replaced with `<!-- nightralph-entry`
(hyphen instead of colon) before rendering, so it cannot start a new
entry when parsed.

Fence rule: a fenced block uses a backtick fence one longer than the
longest run of backticks in its content, minimum three, so a log that
contains ``` cannot close the fence early:

```ts
function fence (content:string):string {
    const longest = Math.max(
        0,
        ...[...content.matchAll(/`+/g)].map(m => m[0].length)
    )
    const ticks = '`'.repeat(Math.max(3, longest + 1))
    return `${ticks}\n${content}\n${ticks}`
}
```

**Verification:**
Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output, i.e. no type errors (this config covers
`src/` only and is clean
today; `-p .` also checks `test/`, which already has unrelated type
errors in `test/display.test.ts` and `test/orchestrator.test.ts` that
are out of scope)

**Commit:** none yet (committed with Task 3)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Parsing, selection, history rendering, helpers

**Verifies:** None on its own (Task 3 tests these)

**Files:**
- Modify: `src/learnings.ts`

**Implementation:**

`parseEntries(text:string):LearningEntry[]`
- Split on `\n`. A line is a sentinel when it matches
  `/^<!-- nightralph:entry (.*) -->$/`. Lines before the first sentinel
  are ignored. Each sentinel starts a new entry; following lines up to
  the next sentinel are its body.
- Parse the sentinel's attributes by splitting the capture on spaces
  into `k=v` pairs. `ticket` -> `decodeURIComponent` (inverse of
  `encodeKey`), `attempt` -> integer, `outcome` must be in
  `LEARNING_OUTCOMES`, `timedout=true` -> `timedOut:true` (absent ->
  `false`).
- This is the boundary where file content enters, so validate: an
  entry whose `ticket` is missing, empty, or fails to decode
  (`decodeURIComponent` throws `URIError` on a malformed escape such as
  a hand-edited `%E0%A`; catch it), whose `attempt` is not a
  non-negative integer, or whose `outcome` is unknown is dropped (skip
  it and its body). One bad sentinel must never make the whole parse
  throw. Use a type guard
  `isLearningOutcome(value:string):value is LearningOutcome` that
  checks membership in `LEARNING_OUTCOMES`; no `as` casts.
- Body: join the lines, trim, and remove one trailing `---` line if
  present, then trim again.

`selectHistory(entries, opts:{ key:string; blockerKeys:string[] })`
returns `HistorySelection = { own:LearningEntry[];
blockers:LearningEntry[] }`:

```ts
const own = entries
    .filter(e => e.key === opts.key)
    .slice(-MAX_OWN_ENTRIES)
const blockers = opts.blockerKeys.flatMap(k => {
    const done = entries.filter(e => {
        return e.key === k && e.outcome === 'done'
    })
    const last = done[done.length - 1]
    return last ? [last] : []
})
```

Do not use `Array.prototype.at`: `tsconfig.json` sets
`lib: ["ES2021"]` and `.at` is ES2022, so it fails `tsc` (and
`npm run build`). Do not change the tsconfig.

Entries are kept in file order, so `own` is oldest first. Blockers of
blockers are excluded by construction: only `opts.blockerKeys` (the
direct blockers, computed by the caller) are looked up.

`renderHistory(selection:HistorySelection):string`
- Returns `''` when both lists are empty.
- Otherwise lines: a framing paragraph ("These are records of earlier
  runs. The ticket or spec may have changed since then; where they
  disagree, follow the ticket and spec. Do not repeat an approach these
  notes say failed unless you can see why it failed."), a blank line,
  then when `own` is non-empty `---- PREVIOUS ATTEMPTS AT THIS TICKET
  ----` followed by each capped body separated by blank lines, then
  when `blockers` is non-empty `---- WHAT THE BLOCKING TICKETS DID
  ----` the same way.
- Cap: a body longer than `MAX_ENTRY_CHARS` becomes
  `body.slice(0, MAX_ENTRY_CHARS) + '\n' + TRUNCATED_MARKER`.

`tailLines(text:string, n:number):string`
- Split on `\n`; if the last element is `''` (text ended in a newline)
  drop it; return the last `n` lines joined with `\n`. Fewer than `n`
  lines -> all of them.

`learningsPathFor(progressPath:string):string`
- `join(dirname(progressPath), 'learnings.md')`, using `node:path`.
  Used by Phase 4 so the log always sits next to `progress.md`.

**Verification:**
Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep 'error TS'`
Expected: no output (no type errors)

**Commit:** none yet (committed with Task 3)
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Unit tests for the pure core

**Verifies:** attempt-learnings-design.AC1.1, attempt-learnings-design.AC1.2,
attempt-learnings-design.AC1.3, attempt-learnings-design.AC2.1,
attempt-learnings-design.AC2.2, attempt-learnings-design.AC2.3,
attempt-learnings-design.AC2.4, attempt-learnings-design.AC2.5

**Files:**
- Create: `test/learnings.test.ts` (unit)
- Modify: `scripts/test.sh:13-23` -- add `learnings` to the `TESTS`
  array (after `progress`)
- Modify: `package.json:20` (`build-esm`) -- append
  `src/learnings.ts` to the second esbuild call's entry list (after
  `src/testcmd.ts`). That call transpiles each module to `dist/`
  without bundling, so once Phase 3 makes `src/orchestrator.ts` import
  `./learnings.js`, `dist/orchestrator.js` would otherwise import a
  file that is never emitted.

**Implementation:**

Style: `import { test } from '@substrate-system/tapzero'`, sync
`test('name', t => { ... })`, assertions `t.equal`, `t.ok`,
`t.deepEqual` (see `test/progress.test.ts:61-118`). Use
`randomUUID()` from `node:crypto` for any text whose presence is
checked.

**Testing:**
- AC1.1: for each outcome variant (at least `done`, `exit` with
  `timedOut:true`, `tests`, `install`, `error`, `merge`), render with
  `renderEntry`, concatenate all into one string, `parseEntries` it,
  and `t.deepEqual` the `{ key, attempt, outcome, timedOut }` of each
  parsed entry against the inputs, in order. Include a key with a
  character that needs encoding (e.g. a space in the feature name).
- AC1.2: notes that contain the literal sentinel prefix
  (`<!-- nightralph:entry ticket=x:1 attempt=1 outcome=done -->`) on
  its own line; the rendered entry parses to exactly one entry with the
  original key.
- AC1.2 (supporting): sentinels with an unknown outcome, a
  non-numeric attempt, or a malformed escape in `ticket` (e.g.
  `ticket=%E0%A`) are each dropped without throwing, while a valid
  entry after them still parses.
- AC1.3: `tailLines` on 50 numbered lines with `n = 40` returns 40
  lines and the last one is the 50th; on 3 lines returns all 3; a
  trailing newline does not produce an extra empty line.
- AC2.1: six `done`/`exit` entries for one key; `own` has length
  `MAX_OWN_ENTRIES` and equals the last four in order (compare
  `attempt` numbers).
- AC2.2: a blocker with entries `exit`, `done`, `exit`, `done`; the
  selection's `blockers` has exactly one entry and it is the second
  `done` (compare `attempt`).
- AC2.3: entries for an unrelated key, for the same number in another
  feature (`other:4` vs `feat:4`), for a blocker with only failures,
  and for a blocker's own blocker (not in `blockerKeys`) are all absent
  from both lists.
- AC2.4: `renderHistory({ own:[], blockers:[] })` equals `''`.
- `learningsPathFor(join('a', 'b', 'progress.md'))` equals
  `join('a', 'b', 'learnings.md')` (the integration tests rely on this
  placement).
- AC2.5: build one entry with a body of `MAX_ENTRY_CHARS * 3` chars and
  one with an empty body; the rendered length difference is at most
  `MAX_ENTRY_CHARS + TRUNCATED_MARKER.length + 1`.

**Verification:**
Run: `npm test`
Expected: all suites pass, including `learnings`

Run: `npx tsc --noEmit -p . 2>&1 | grep 'error TS' | grep learnings.test`
Expected: no output (the test file type-checks; ignore the existing
errors in other test files)

Run: `npm run build && node -e "import('./dist/learnings.js')"`
Expected: builds; the import succeeds

Run: `npm run lint`
Expected: no errors

**Commit:**
```bash
git add src/learnings.ts test/learnings.test.ts scripts/test.sh \
    package.json
git commit -m "feat(learnings): pure core for attempt learning entries"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
