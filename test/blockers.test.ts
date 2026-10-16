import { test } from '@substrate-system/tapzero'
import {
    parseBlockerField,
    provisionalRefs,
    resolveBlockers,
} from '../src/blockers.js'

const KNOWN = new Set([
    'newsletter-audit',
    'held-import-review',
    'og-enhanced-cards',
    'analytics',
])

// Field text copied verbatim from rebase.blog tickets.
const HIR_01 = `newsletter-audit 16
(\`.scratch/newsletter-audit/issues/16-operator-approval-sticks.md\`),
which rewrites the same decision and expiry emails.`

const HIR_04 = `01, 02, 03 (03 edits the same Operator card,
\`importNextStep\` and writer-list mapping; it is a conflict edge, not a
logical one).`

const HIR_06 = `01, 02, 03, 04, 05, newsletter-audit 18
(\`.scratch/newsletter-audit/issues/18-docs-ses-only-transport.md\`, which
edits FDR-018 first).`

const NA_07 = `01 (the daily-quota error code), 02 (message module
cleanup), 05 (claim semantics)`

const NA_16 = `14 (notice recovery resumes an approved Import), 15
(the size-hold entry point)`

const NA_18 = `02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15,
16, 17`

const OG_04 = `03 (the stored publication URI and CID). Also 01, only
because both edit \`resolveShareCard\` and
\`test/reader-share-bluesky.spec.ts\`; run them in order to avoid a merge
conflict.`

const ANALYTICS_01 = 'None (can start immediately).'

function bodyWith (text:string):string {
    return '**Blocked by:** ' + text + '\n\n**Status:** ready-for-agent'
}

function parse (text:string) {
    return parseBlockerField(bodyWith(text), KNOWN)
}

test('AC1.1: a cross-feature ref is read with its feature', t => {
    const hir01 = parse(HIR_01)
    t.deepEqual(hir01, {
        refs: [{ feature: 'newsletter-audit', num: 16 }],
        typos: [],
    }, 'held-import-review 01')

    const hir06 = parse(HIR_06)
    t.deepEqual(hir06.refs, [
        { num: 1 },
        { num: 2 },
        { num: 3 },
        { num: 4 },
        { num: 5 },
        { feature: 'newsletter-audit', num: 18 },
    ], 'held-import-review 06 refs')
    t.deepEqual(hir06.typos, [], 'held-import-review 06 typos')
})

test('AC1.2: plain numbers are de-duplicated', t => {
    const hir04 = parse(HIR_04)
    t.deepEqual(hir04.refs.map(r => r.num), [1, 2, 3], 'nums')
    t.ok(hir04.refs.every(r => r.feature === undefined), 'no feature')

    const dup = parse('01, 02, 01, 02')
    t.deepEqual(dup.refs.map(r => r.num), [1, 2], 'each num once')
})

test('AC1.3: a long list of numbers is read in order', t => {
    const nums = parse(NA_18)
    const expected:number[] = []
    for (let n = 2; n <= 17; n++) expected.push(n)
    t.deepEqual(nums.refs.map(r => r.num), expected, 'nums 2 to 17')
})

test('AC1.4: parenthetical notes are ignored, even across lines', t => {
    const n16 = parse(NA_16)
    t.deepEqual(
        n16.refs.map(r => r.num), [14, 15], 'newsletter-audit 16'
    )

    const n07 = parse(NA_07)
    t.deepEqual(
        n07.refs.map(r => r.num), [1, 2, 5], 'newsletter-audit 07'
    )
})

test('AC1.5: backtick spans are ignored', t => {
    const og = parse(OG_04)
    t.deepEqual(og.refs.map(r => r.num), [3, 1], 'og-enhanced-cards 04')

    const ticks = parse('02 `step 07` 05')
    t.deepEqual(ticks.refs.map(r => r.num), [2, 5], 'backtick span')
})

test('AC1.6: no blockers when the field says none', t => {
    const analytics = parse(ANALYTICS_01)
    t.deepEqual(analytics, { refs: [], typos: [] }, 'analytics 01')

    t.deepEqual(parse('None').refs, [], 'None')
    t.deepEqual(parse('none').refs, [], 'none')
})

test('AC1.7: numbers with a unit or a version prefix are not refs', t => {
    const p = parse('24h, v2, 03')
    t.deepEqual(p.refs.map(r => r.num), [3], 'only 03 is a ref')
})

test('AC1.8: a plain word before a number is not a feature', t => {
    const also = parse('Also 01')
    t.deepEqual(also, { refs: [{ num: 1 }], typos: [] }, 'Also 01')

    const og = parse(OG_04)
    t.deepEqual(og.typos, [], 'no typos for og-enhanced-cards 04')
})

test('AC1.9: a misspelt feature name is reported as a typo', t => {
    const p = parse('nwsletter-audit 16')
    t.deepEqual(p.refs, [{ num: 16 }], 'ref falls back to own feature')
    t.deepEqual(p.typos, ['nwsletter-audit'], 'typo reported')
})

test('AC1.10: the field ends at a blank line or the next field', t => {
    const blank = parseBlockerField(
        '**Blocked by:** 01\n\n02 later',
        KNOWN,
    )
    t.deepEqual(blank.refs.map(r => r.num), [1], 'blank line ends field')

    const next = parseBlockerField(
        '**Blocked by:** 01,\n02\n**Touches:** src/a.ts 04',
        KNOWN,
    )
    t.deepEqual(next.refs.map(r => r.num), [1, 2], 'next field ends it')

    const bullet = parseBlockerField(
        '- **Blocked by:** 01\n- **Touches:** 09',
        KNOWN,
    )
    t.deepEqual(bullet.refs.map(r => r.num), [1], 'bulleted field')
})

test('AC1.10: a checklist item or heading ends the field', t => {
    const checklist = parseBlockerField(
        '**Blocked by:** 01\n- [ ] Do step 2\n## Heading 3',
        KNOWN,
    )
    t.deepEqual(checklist.refs.map(r => r.num), [1], 'checklist ends it')

    const heading = parseBlockerField(
        '**Blocked by:** 01\n## Step 3',
        KNOWN,
    )
    t.deepEqual(heading.refs.map(r => r.num), [1], 'heading ends it')
})

test('ranges expand to their endpoints', t => {
    const range = parse('03-05')
    t.deepEqual(range.refs.map(r => r.num), [3, 5], 'bare range')

    const featureRange = parse('newsletter-audit 03-05')
    t.deepEqual(featureRange.refs, [
        { feature: 'newsletter-audit', num: 3 },
        { feature: 'newsletter-audit', num: 5 },
    ], 'a feature applies to both ends of a range')

    const list = parse('newsletter-audit 16, 17')
    t.deepEqual(list.refs, [
        { feature: 'newsletter-audit', num: 16 },
        { num: 17 },
    ], 'a feature applies only to the number right after it')
})

test('a nested feature is read with its full path', t => {
    const known = new Set([...KNOWN, 'rollout/billing'])
    const p = parseBlockerField(
        bodyWith('rollout/billing 03-05, 07'), known
    )
    t.deepEqual(p, {
        refs: [
            { feature: 'rollout/billing', num: 3 },
            { feature: 'rollout/billing', num: 5 },
            { num: 7 },
        ],
        typos: [],
    }, 'the path is the feature')
})

test('an unknown nested feature is reported as a typo', t => {
    const p = parse('rollout/biling 03')
    t.deepEqual(p.refs, [{ num: 3 }], 'ref falls back to own feature')
    t.deepEqual(p.typos, ['rollout/biling'], 'typo reported')
})

test('nested and code-guarded parentheses', t => {
    const nested = parse('03 (a (b) 04) 05')
    t.deepEqual(nested.refs.map(r => r.num), [3, 5], 'nested parens')

    const code = parse('03 (x `)` 04) 05')
    t.deepEqual(
        code.refs.map(r => r.num), [3, 5], 'a ) in code does not close'
    )
})

test('the field name is matched in any case', t => {
    const p = parseBlockerField('**blocked BY:** 07', KNOWN)
    t.deepEqual(p.refs, [{ num: 7 }], 'lowercase field name')
})

test('only feature-shaped words are typos', t => {
    const doc = parse('FDR-018 03')
    t.deepEqual(doc, { refs: [{ num: 3 }], typos: [] }, 'doc id is prose')
})

test('unpaired delimiters do not hide text', t => {
    const paren = parseBlockerField(
        '**Blocked by:** 03 (oops 04\n05',
        KNOWN,
    )
    t.deepEqual(paren.refs.map(r => r.num), [3, 4, 5], 'unpaired paren')

    const tick = parse('03 `x 04')
    t.deepEqual(tick.refs.map(r => r.num), [3, 4], 'unpaired backtick')
})

test('a body with no Blocked by field has no refs', t => {
    const p = parseBlockerField('no field here', KNOWN)
    t.deepEqual(p, { refs: [], typos: [] }, 'no field')
})

test('the old single-feature form still parses', t => {
    const hash = parse('#4 and #5')
    t.deepEqual(hash.refs.map(r => r.num), [4, 5], 'hash numbers')

    const crlf = parseBlockerField(
        '**Blocked by:** 01,\r\n02\r\n',
        KNOWN,
    )
    t.deepEqual(crlf.refs.map(r => r.num), [1, 2], 'CRLF body')
})

const SELECTED = new Map<string, ReadonlySet<number>>([
    ['a', new Set([1, 2])],
    ['b', new Set([1])],
])

function lookupOf (statuses:Record<string, string>) {
    return (feature:string, num:number) => statuses[`${feature}:${num}`]
}

test('resolveBlockers: a ticket in a selected feature', t => {
    const refs = resolveBlockers([{ num: 2 }], 'a', SELECTED, lookupOf({}))
    t.deepEqual(refs, [{ feature: 'a', num: 2, where: 'run' }], 'run')
})

test('resolveBlockers AC2.4: no ticket in a selected feature', t => {
    const own = resolveBlockers([{ num: 9 }], 'a', SELECTED, lookupOf({}))
    t.deepEqual(own, [{ feature: 'a', num: 9, where: 'missing' }], 'own')

    const other = resolveBlockers(
        [{ feature: 'b', num: 9 }], 'a', SELECTED, lookupOf({})
    )
    t.deepEqual(
        other, [{ feature: 'b', num: 9, where: 'missing' }], 'other'
    )
})

test('resolveBlockers AC2.1: a done ticket outside the run', t => {
    const refs = resolveBlockers(
        [{ feature: 'c', num: 3 }], 'a', SELECTED,
        lookupOf({ 'c:3': 'done' })
    )
    t.deepEqual(refs, [
        { feature: 'c', num: 3, where: 'done', status: 'done' },
    ], 'done')
})

test('resolveBlockers AC2.2: an unfinished ticket outside', t => {
    const refs = resolveBlockers(
        [{ feature: 'c', num: 3 }], 'a', SELECTED,
        lookupOf({ 'c:3': 'ready-for-agent' })
    )
    t.deepEqual(refs, [
        { feature: 'c', num: 3, where: 'pending', status: 'ready-for-agent' },
    ], 'pending')
})

test('resolveBlockers: no ticket outside the run', t => {
    const refs = resolveBlockers(
        [{ feature: 'c', num: 3 }], 'a', SELECTED, lookupOf({})
    )
    t.deepEqual(refs, [{ feature: 'c', num: 3, where: 'missing' }], 'missing')
})

test('resolveBlockers: own feature written out is the same ref', t => {
    const refs = resolveBlockers(
        [{ feature: 'a', num: 1 }, { num: 1 }], 'a', SELECTED, lookupOf({})
    )
    t.deepEqual(refs, [{ feature: 'a', num: 1, where: 'run' }], 'one ref')
})

test('provisionalRefs: every ref is in the run', t => {
    const refs = provisionalRefs([{ num: 1 }, { feature: 'b', num: 2 }], 'a')
    t.deepEqual(refs, [
        { feature: 'a', num: 1, where: 'run' },
        { feature: 'b', num: 2, where: 'run' },
    ], 'own feature filled in')
})
