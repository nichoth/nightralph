import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSelection } from '../src/resolve.js'
import {
    buildGraph,
    suggestSelection,
    type LoadFn,
    type Suggestion,
} from '../src/graph.js'

function makeScratch ():{
    root:string;
    scratchDir:string;
    load:LoadFn;
} {
    const root = mkdtempSync(join(tmpdir(), 'nightralph-graph-'))
    const scratchDir = join(root, '.scratch')
    mkdirSync(scratchDir, { recursive:true })
    const load:LoadFn = names => loadSelection(scratchDir, names)
    return { root, scratchDir, load }
}

function addFeature (
    scratchDir:string,
    name:string,
    tickets:Array<[number, string, string]> = []
):void {
    const featureDir = join(scratchDir, name)
    const issuesDir = join(featureDir, 'issues')
    mkdirSync(issuesDir, { recursive:true })
    writeFileSync(join(featureDir, 'spec.md'), `# ${name}`)
    for (const [num, status, blockedBy] of tickets) {
        const nn = String(num).padStart(2, '0')
        writeFileSync(
            join(issuesDir, `${nn}-t.md`),
            `# T\n\n**Status:** ${status}\n**Blocked by:** ${blockedBy}\n`
        )
    }
}

// Field text copied verbatim from rebase.blog held-import-review 01.
const HIR_01_BLOCKED_BY = `newsletter-audit 16
(\`.scratch/newsletter-audit/issues/16-operator-approval-sticks.md\`),
which rewrites the same decision and expiry emails.`

function rebaseBlog (scratchDir:string):void {
    const ready = 'ready-for-agent'
    addFeature(scratchDir, 'newsletter-audit', [
        [15, ready, 'None'],
        [16, ready, '15'],
        [18, ready, '15, 16'],
    ])
    addFeature(scratchDir, 'held-import-review', [
        [1, ready, HIR_01_BLOCKED_BY],
        [2, ready, 'newsletter-audit 15'],
        [3, ready, '01'],
        [4, ready, '02'],
        [5, ready, '03, 04'],
        [6, ready, 'newsletter-audit 18'],
    ])
    addFeature(scratchDir, 'analytics', [
        [1, ready, 'None'],
    ])
}

function edgeTriples (s:Suggestion):Array<[number, string, number]> {
    return s.edges.map(e => [e.from.num, e.ref.feature, e.ref.num])
}

test('AC3.1: rebase.blog suggests both features, 6 of 6 runnable', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        rebaseBlog(scratchDir)
        const s = suggestSelection(load, 'held-import-review')
        t.deepEqual(
            s.features,
            ['held-import-review', 'newsletter-audit'],
            'suggests both features'
        )
        t.equal(s.runnable, 6, 'all 6 target tickets run')
        t.equal(s.total, 6, 'total is 6')
        t.deepEqual(s.deadEnds, [], 'no dead ends')
        t.deepEqual(s.cycles, [], 'no cycles')
        t.deepEqual(
            edgeTriples(s),
            [[1, 'newsletter-audit', 16], [2, 'newsletter-audit', 15],
                [6, 'newsletter-audit', 18]],
            'edges are the three cross-feature refs'
        )

        const { reports } = buildGraph(load, [
            'analytics', 'held-import-review', 'newsletter-audit',
        ])
        const byName = new Map(reports.map(r => [r.feature, r]))
        const hir = byName.get('held-import-review')
        t.equal(hir?.ready, 0, 'picker count: nothing ready alone')
        t.equal(hir?.total, 6, 'picker count: six tickets')
        t.ok(hir?.suggestion, 'held-import-review has a suggestion')
        t.equal(
            byName.get('newsletter-audit')?.suggestion,
            null,
            'newsletter-audit has no suggestion'
        )
        t.equal(
            byName.get('analytics')?.suggestion,
            null,
            'analytics has no suggestion'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.2: a transitive chain is suggested in full', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 01']])
        addFeature(scratchDir, 'beta', [[1, 'ready-for-agent', 'gamma 01']])
        addFeature(scratchDir, 'gamma', [[1, 'ready-for-agent', 'None']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha', 'beta', 'gamma'], 'all three')
        t.equal(s.runnable, 1, 'alpha/01 runs')
        t.equal(s.total, 1, 'one target ticket')
        t.ok(
            s.edges.some(e => (
                e.from.feature === 'beta' &&
                    e.ref.feature === 'gamma' &&
                    e.ref.num === 1
            )),
            'edges include the beta -> gamma hop'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.3: an upstream ticket the target does not need is ignored', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 01']])
        addFeature(scratchDir, 'beta', [
            [1, 'ready-for-agent', 'None'],
            [2, 'ready-for-agent', 'gamma 01'],
        ])
        addFeature(scratchDir, 'gamma', [[1, 'ready-for-agent', 'None']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha', 'beta'], 'gamma not added')
        t.ok(
            s.edges.every(e => e.from.feature !== 'beta'),
            'no edge starts in beta'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.4: a needed ready-for-human upstream is a dead end', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 04']])
        addFeature(scratchDir, 'beta', [[4, 'ready-for-human', 'None']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha', 'beta'], 'beta is selected')
        t.equal(s.runnable, 0, 'alpha/01 cannot run')
        t.equal(s.total, 1, 'one target ticket')
        t.deepEqual(s.deadEnds, [{
            from:{ feature:'alpha', num:1 },
            ref:{
                feature:'beta',
                num:4,
                where:'run',
                status:'ready-for-human',
            },
        }], 'the human-gated ref is named')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.5: a missing ref never grows the selection', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [
            [1, 'ready-for-agent', 'beta 01'],
            [2, 'ready-for-agent', 'beta 40'],
        ])
        addFeature(scratchDir, 'beta', [[1, 'ready-for-agent', 'None']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha', 'beta'], 'beta is selected')
        t.equal(s.runnable, 1, 'alpha/01 runs')
        t.equal(s.total, 2, 'two target tickets')
        t.ok(
            s.deadEnds.some(d => (
                d.from.feature === 'alpha' &&
                d.from.num === 2 &&
                d.ref.where === 'missing' &&
                d.ref.num === 40
            )),
            'alpha/02 missing ref is a dead end'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.5: a lone missing ref does not widen the selection', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 40']])
        addFeature(scratchDir, 'beta', [[1, 'ready-for-agent', 'None']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha'], 'only alpha is selected')
        t.deepEqual(s.edges, [], 'no edges')
        t.ok(
            s.deadEnds.some(d => d.ref.where === 'missing'),
            'the missing ref is a dead end'
        )

        const { reports } = buildGraph(load, ['alpha', 'beta'])
        const byName = new Map(reports.map(r => [r.feature, r]))
        t.ok(
            byName.get('alpha')?.suggestion,
            'alpha keeps a suggestion so the dead end is reported'
        )
        t.equal(
            byName.get('beta')?.suggestion,
            null,
            'beta has no suggestion'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('buildGraph loads each feature set once, names sorted', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 01']])
        addFeature(scratchDir, 'beta', [[1, 'ready-for-agent', 'alpha 01']])
        const calls:string[][] = []
        const recording:LoadFn = names => {
            calls.push([...names])
            return load(names)
        }
        buildGraph(recording, ['alpha', 'beta'])
        const sortedKey = (names:string[]) => [...names].sort().join('\n')
        const keys = calls.map(sortedKey)
        t.equal(
            new Set(keys).size,
            keys.length,
            'no feature set is loaded twice'
        )
        t.ok(
            calls.every(c => c.join('\n') === sortedKey(c)),
            'every load call gets its names sorted'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.6: mutually waiting features terminate as deadlocked', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [[1, 'ready-for-agent', 'beta 01']])
        addFeature(scratchDir, 'beta', [[1, 'ready-for-agent', 'alpha 01']])
        const s = suggestSelection(load, 'alpha')
        t.deepEqual(s.features, ['alpha', 'beta'], 'both selected')
        t.equal(s.runnable, 0, 'nothing runs')
        t.deepEqual(s.deadEnds, [], 'a cycle is not a dead ref')
        t.deepEqual(s.cycles, ['alpha/01', 'beta/01'], 'both in the cycle')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})
