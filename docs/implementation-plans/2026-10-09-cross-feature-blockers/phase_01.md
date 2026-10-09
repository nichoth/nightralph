# Cross-Feature Blockers Implementation Plan -- Phase 1

**Goal:** Parse a ticket's `**Blocked by:**` field into
de-duplicated raw refs, with cross-feature names, prose
stripped and wrapped lines read.

**Architecture:** A new pure module, `src/blockers.ts`, holds the
parser. It imports nothing (no `node:*`, no `./orchestrator.js`),
like `src/learnings.ts` and `src/retry.ts` keep their pure parts.
Nothing calls it yet; Phase 2 wires it into `scanTickets`.

**Tech Stack:** TypeScript (ESM, Node >= 24), esbuild,
`@substrate-system/tapzero`

**Scope:** Phase 1 of 6 from
`docs/design-plans/2026-10-09-cross-feature-blockers.md`

**Codebase verified:** 2026-10-09 12:50

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cross-feature-blockers.AC1: Parsing and one loading path
- **cross-feature-blockers.AC1.1 Success:** `newsletter-audit 16`
  yields `{ feature:'newsletter-audit', num:16 }` when
  `.scratch/newsletter-audit/issues` exists
- **cross-feature-blockers.AC1.2 Success:**
  `01, 02, 03 (03 edits ...)` yields 1, 2, 3, each once
- **cross-feature-blockers.AC1.3 Success:** a list wrapped onto the
  next line yields every number (newsletter-audit 18 -> 02 through
  17)
- **cross-feature-blockers.AC1.4 Success:** a parenthetical spanning
  lines contributes no numbers (newsletter-audit 16 -> 14, 15)
- **cross-feature-blockers.AC1.5 Success:** backtick spans
  contribute no numbers
- **cross-feature-blockers.AC1.6 Success:**
  `None (can start immediately)` yields no refs
- **cross-feature-blockers.AC1.7 Edge:** digits inside words
  (`24h`, `v2`) are not refs
- **cross-feature-blockers.AC1.8 Edge:** a plain word before a
  number (`Also 01`) is prose; the number refers to the ticket's own
  feature and no warning is produced
- **cross-feature-blockers.AC1.9 Failure:** a hyphenated word that
  names no feature dir produces a typo warning, and its number
  refers to the ticket's own feature. (Amended 2026-10-09: only
  lowercase feature-shaped words warn; `FDR-018` gives none.)
- **cross-feature-blockers.AC1.10 Edge:** the field ends at a blank
  line or the next `**Field:**` line; numbers after it are ignored

(At this phase "when `.scratch/newsletter-audit/issues` exists" is
modeled by passing `newsletter-audit` in `knownFeatures`. Phase 3
builds `knownFeatures` from the real directory listing.)

---

## Codebase facts the executor needs

- `package.json` script `build-esm` (line 20) runs two esbuild
  calls. The second one lists
  `src/orchestrator.ts src/setup.ts src/resolve.ts src/worktree.ts
  src/progress.ts src/merge.ts src/display.ts src/testcmd.ts
  src/preflight.ts src/learnings.ts src/retry.ts src/rules.ts
  src/review.ts` then `--format=esm ...`. A module missing from that
  list gets no `dist/<name>.js`.
- `scripts/test.sh` line 13 starts `TESTS=(`, one suite name per
  line, 4-space indent (`setup`, `orchestrator`, `retry`, ...). A
  test file missing from `TESTS` never runs.
- Tests import `{ test } from '@substrate-system/tapzero'` and
  source modules with a `.js` suffix (`'../src/blockers.js'`).
  Assertions are `t.equal`, `t.ok`, `t.deepEqual` with a message
  string last.
- To run one suite without the full script:
  `npx esbuild test/blockers.test.ts --format=esm --bundle
  --packages=external --outdir=dist/test --sourcemap &&
  node dist/test/blockers.test.js`
- Type-check baseline (before this plan):
  `npx tsc --noEmit -p tsconfig.build.json` -> 0 errors (src only).
  `npx tsc --noEmit -p tsconfig.json` (src + test) -> 143
  pre-existing errors: 135 in `test/display.test.ts`, 8 in
  `test/orchestrator.test.ts`. Every phase must keep src at 0 and
  add no new test errors.
- User style rules (from `~/.claude/CLAUDE.md`): lines <= 80
  columns; type annotations with no space after the colon
  (`num:number`); multi-line ternaries put `?` and `:` at line
  ends; no em dashes or arrow characters in comments (use `--` and
  `->`); no emojis.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Register the new module and test suite

**Verifies:** None (infrastructure)

**Files:**
- Modify: `package.json:20` (`build-esm`, second esbuild call)
- Modify: `scripts/test.sh:13-` (`TESTS` array)

**Step 1:** In `build-esm`, append ` src/blockers.ts` after
`src/review.ts` in the second esbuild call's file list (before
` --format=esm`).

**Step 2:** In `scripts/test.sh`, add a line `    blockers` to
`TESTS`, directly before `    orchestrator`.

**Step 3:** No verification yet -- the files do not exist. Commit
together with Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `parseBlockerField` in `src/blockers.ts`

**Verifies:** cross-feature-blockers.AC1.1 through AC1.10 (tests
in Task 3)

**Files:**
- Create: `src/blockers.ts`

**Implementation:**

Rules (from the design, plus review hardening):
- The field starts after the first `**Blocked by:**`
  (case-insensitive) and runs across continuation lines until the
  first line that is blank, starts a `**Field:**` marker (optionally
  after a `- ` or `* ` bullet), is a markdown heading (`#` to
  `######` then a space), or is a checklist item (`- [ ]`, `- [x]`,
  `* [ ]`, `+ [ ]`). The last two guard against a field with no
  blank line after it swallowing the ticket's checklist or headings
  (the old parser read one line only). CRLF is accepted.
- Backtick spans and `(...)` spans are removed before tokenizing.
  Backticks pair in order; parentheses pair with a stack (nested
  and across lines), skipping characters inside code spans so a `)`
  inside code does not close a parenthetical. An unpaired `(` or
  backtick is left as ordinary text, so a typo never hides the rest
  of the field. Removed characters become spaces, so the words on
  either side never merge.
- If the remaining text starts with `None` (any case, whole word),
  there are no refs and no typos.
- Tokens are runs of `[A-Za-z0-9_-]`. A token of digits, or of
  digit groups joined by `-` (`03-05`), is a number token; each
  digit group is a number (the old parser read `03-05` as 3 and 5,
  and this keeps that). `24h`, `v2`, `FDR-018` contain letters, so
  they are words, not numbers.
- A number token's feature is the token directly before it, but
  only when the gap between the two tokens is whitespace only
  (newlines count) and that token is in `knownFeatures`. The
  feature applies to every number in the token, so both ends of a
  range. Otherwise the number refers to the ticket's own feature
  (`feature` absent). If that directly preceding token is shaped
  like a feature name (lowercase letters and digits joined by
  hyphens, with at least one letter) but is not a known feature, it
  is reported once in `typos`.
- Refs are de-duplicated by `(feature ?? '', num)`, first
  occurrence wins, order preserved.

Amended 2026-10-09 during review: the range and typo rules above,
and the block below, describe the shipped `src/blockers.ts`. The
original plan applied a feature to a range's first number only and
reported any hyphenated word with a letter (`isHyphenatedWord`);
review replaced that with `looksLikeFeature`, so `FDR-018` is not a
typo. The shipped code passes every fixture in Task 3:

```ts
// Blocker references in a ticket's **Blocked by:** field. Pure:
// no file or process access and no imports, so orchestrator.ts
// and resolve.ts can both depend on it.

export type RawRef = {
    feature?:string;  // absent -> the ticket's own feature
    num:number;
}

export type BlockerParse = {
    refs:RawRef[];
    typos:string[];   // feature-shaped words that name no feature
}

const FIELD_RE = /\*\*Blocked by:\*\*/i
const NEXT_FIELD_RE = /^\s*(?:[-*]\s+)?\*\*[^*\n]+:\*\*/
const HEADING_RE = /^\s*#{1,6}\s/
const CHECKLIST_RE = /^\s*[-*+]\s+\[[ xX]\]/
const TOKEN_RE = /[A-Za-z0-9_-]+/g

function endsField (line:string):boolean {
    return line.trim() === '' ||
        NEXT_FIELD_RE.test(line) ||
        HEADING_RE.test(line) ||
        CHECKLIST_RE.test(line)
}

/**
 * The text of the **Blocked by:** field: the rest of its line
 * plus continuation lines, up to a blank line, the next
 * `**Field:**` line, a heading or a checklist item. `null` when
 * the body has no such field.
 */
function fieldText (body:string):string|null {
    const lines = body.split(/\r?\n/)
    const start = lines.findIndex(l => FIELD_RE.test(l))
    if (start === -1) return null
    const first = lines[start]
    const m = FIELD_RE.exec(first)!
    const parts = [first.slice(m.index + m[0].length)]
    for (const line of lines.slice(start + 1)) {
        if (endsField(line)) break
        parts.push(line)
    }
    return parts.join('\n')
}

/**
 * Blanks out backtick spans and `(...)` spans (nested, across
 * lines). Only paired delimiters count; an unpaired `(` or
 * backtick stays as text. Each blanked character becomes a space,
 * so the words on either side never merge.
 */
function stripNotes (text:string):string {
    const chars = [...text]
    const drop = new Array<boolean>(chars.length).fill(false)
    const ticks:number[] = []
    chars.forEach((ch, i) => {
        if (ch === '`') ticks.push(i)
    })
    for (let i = 0; i + 1 < ticks.length; i += 2) {
        for (let j = ticks[i]; j <= ticks[i + 1]; j++) {
            drop[j] = true
        }
    }
    const open:number[] = []
    chars.forEach((ch, i) => {
        if (drop[i]) return
        if (ch === '(') {
            open.push(i)
        } else if (ch === ')' && open.length > 0) {
            const from = open.pop()!
            for (let j = from; j <= i; j++) drop[j] = true
        }
    })
    return chars.map((ch, i) => (drop[i] ? ' ' : ch)).join('')
}

/**
 * A word shaped like a feature dir name: lowercase letters and
 * digits joined by hyphens, with at least one letter. Doc IDs such
 * as `FDR-018` are not.
 */
function looksLikeFeature (word:string):boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(word) && /[a-z]/.test(word)
}

/**
 * Reads the **Blocked by:** field of a ticket body. A number
 * belongs to the feature named by the word directly before it
 * when that word is in `knownFeatures` (the names of
 * `.scratch/<name>/issues` dirs); otherwise to the ticket's own
 * feature. Feature-shaped words that name no feature are returned
 * as `typos`.
 */
export function parseBlockerField (
    body:string,
    knownFeatures:ReadonlySet<string>
):BlockerParse {
    const text = fieldText(body)
    if (text === null) return { refs:[], typos:[] }
    const clean = stripNotes(text)
    if (/^\s*none\b/i.test(clean)) return { refs:[], typos:[] }

    const refs:RawRef[] = []
    const typos:string[] = []
    const seen = new Set<string>()
    const add = (num:number, feature?:string) => {
        const id = `${feature ?? ''}:${num}`
        if (seen.has(id)) return
        seen.add(id)
        refs.push(feature === undefined ? { num } : { feature, num })
    }
    let prev:{ word:string; end:number }|null = null
    for (const m of clean.matchAll(TOKEN_RE)) {
        const word = m[0]
        const start = m.index ?? 0
        if (/^\d+(?:-\d+)*$/.test(word)) {
            const before = prev !== null &&
                /^\s+$/.test(clean.slice(prev.end, start)) ?
                prev.word :
                null
            let feature:string|undefined
            if (before !== null && knownFeatures.has(before)) {
                feature = before
            } else if (
                before !== null &&
                looksLikeFeature(before) &&
                !typos.includes(before)
            ) {
                typos.push(before)
            }
            // both ends of a range belong to the same feature
            for (const n of word.split('-').map(Number)) add(n, feature)
        }
        prev = { word, end:start + word.length }
    }
    return { refs, typos }
}
```
(wrap any line over 80 columns, e.g. the `drop[j] = true` loop.)

**Verification:** `npx tsc --noEmit -p tsconfig.build.json` -> no
errors.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Parser tests with rebase.blog fixtures

**Verifies:** cross-feature-blockers.AC1.1, AC1.2, AC1.3, AC1.4,
AC1.5, AC1.6, AC1.7, AC1.8, AC1.9, AC1.10

**Files:**
- Create: `test/blockers.test.ts` (unit)

**Fixtures.** Copy these verbatim from the rebase.blog tickets
(`/Users/nick/code/rebase.blog/.scratch/...` and the
held-import-review worktree copies). Each is the field text exactly
as it appears in the ticket, line breaks preserved; build each
fixture body as `'**Blocked by:** ' + <text>` followed by
`'\n\n**Status:** ready-for-agent'` so a blank line ends the field.
Use `KNOWN = new Set(['newsletter-audit', 'held-import-review',
'og-enhanced-cards', 'analytics'])`.

held-import-review 01:
```
newsletter-audit 16
(`.scratch/newsletter-audit/issues/16-operator-approval-sticks.md`),
which rewrites the same decision and expiry emails.
```
held-import-review 04:
```
01, 02, 03 (03 edits the same Operator card,
`importNextStep` and writer-list mapping; it is a conflict edge, not a
logical one).
```
held-import-review 06:
```
01, 02, 03, 04, 05, newsletter-audit 18
(`.scratch/newsletter-audit/issues/18-docs-ses-only-transport.md`, which
edits FDR-018 first).
```
newsletter-audit 07:
```
01 (the daily-quota error code), 02 (message module
cleanup), 05 (claim semantics)
```
newsletter-audit 16:
```
14 (notice recovery resumes an approved Import), 15
(the size-hold entry point)
```
newsletter-audit 18:
```
02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15,
16, 17
```
og-enhanced-cards 04:
```
03 (the stored publication URI and CID). Also 01, only
because both edit `resolveShareCard` and
`test/reader-share-bluesky.spec.ts`; run them in order to avoid a merge
conflict.
```
analytics 01: `None (can start immediately).`

**Testing.** One `test(...)` per AC, asserting with `t.deepEqual`
on the returned `{ refs, typos }`:
- AC1.1: held-import-review 01 ->
  refs `[{ feature:'newsletter-audit', num:16 }]`, typos `[]`.
  held-import-review 06 -> refs 1..5 (no feature) then
  `{ feature:'newsletter-audit', num:18 }`; `FDR-018` and the
  path contribute nothing.
- AC1.2: held-import-review 04 -> nums `[1, 2, 3]`, no feature.
  Also a synthetic `01, 02, 01, 02` -> `[1, 2]` (each once).
- AC1.3: newsletter-audit 18 -> nums 2 through 17 in order.
- AC1.4: newsletter-audit 16 -> `[14, 15]`; newsletter-audit 07
  (parenthetical crosses the line break) -> `[1, 2, 5]`.
- AC1.5: og-enhanced-cards 04 -> `[3, 1]`; synthetic
  `` 02 `step 07` 05 `` -> `[2, 5]`.
- AC1.6: analytics 01 -> refs `[]`, typos `[]`; also plain
  `None` and `none` -> `[]`.
- AC1.7: synthetic `24h, v2, 03` -> `[3]`.
- AC1.8: synthetic `Also 01` -> refs `[{ num:1 }]`, typos `[]`;
  og-enhanced-cards 04 typos `[]`.
- AC1.9: synthetic `nwsletter-audit 16` with `KNOWN` -> refs
  `[{ num:16 }]`, typos `['nwsletter-audit']`.
- AC1.10: body `'**Blocked by:** 01\n\n02 later'` -> `[1]`; body
  `'**Blocked by:** 01,\n02\n**Touches:** src/a.ts 04'` ->
  `[1, 2]`; body `'- **Blocked by:** 01\n- **Touches:** 09'` ->
  `[1]`.
- AC1.10 (no blank line after the field):
  `'**Blocked by:** 01\n- [ ] Do step 2\n## Heading 3'` -> `[1]`;
  `'**Blocked by:** 01\n## Step 3'` -> `[1]`.
- Ranges: `03-05` -> `[3, 5]`; with `KNOWN`,
  `newsletter-audit 03-05` ->
  `[{ feature:'newsletter-audit', num:3 },
  { feature:'newsletter-audit', num:5 }]`. (Amended 2026-10-09
  during review: a feature applies to both ends of a range. In a
  comma list it still applies only to the next number:
  `newsletter-audit 16, 17` -> 17 is the ticket's own feature.)
- Unpaired delimiters hide nothing: `'03 (oops 04\n05'` ->
  `[3, 4, 5]`; `` '03 `x 04' `` -> `[3, 4]`.
- Missing field: `'no field here'` -> refs `[]`, typos `[]`.
- Old behavior kept: `'**Blocked by:** #4 and #5'` -> `[4, 5]`;
  CRLF body `'**Blocked by:** 01,\r\n02\r\n'` -> `[1, 2]`.

**Verification:**
Run: `npm run build`
Expected: succeeds and `dist/blockers.js` exists
(`ls dist/blockers.js`).

Run: `npx esbuild test/blockers.test.ts --format=esm --bundle
--packages=external --outdir=dist/test --sourcemap &&
node dist/test/blockers.test.js`
Expected: all assertions pass.

Run: `npm test`
Expected: all suites pass (the new suite runs from `TESTS`).

Run: `npm run lint`
Expected: no errors.

**Commit:** `feat: parse cross-feature Blocked by fields`
(stage `src/blockers.ts`, `test/blockers.test.ts`, `package.json`,
`scripts/test.sh`)
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
