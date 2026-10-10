import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSelection } from '../src/resolve.js'
import {
    buildGraph,
    renderGraph,
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

// -- renderGraph --

function lineIndex (
    lines:string[],
    parts:string[],
    after = -1
):number {
    return lines.findIndex((l, i) => i > after &&
        parts.every(p => l.includes(p)))
}

function renderLines (
    load:LoadFn,
    names:string[],
    pickable?:ReadonlySet<string>
):string[] {
    const { reports, warnings } = buildGraph(load, names)
    return renderGraph(reports, warnings, pickable).split('\n')
}

// A group header names the block feature or an upstream feature but
// no ticket, so it has no "/" in it. The "Run together" line also
// names features and has no "/", so it is excluded by its "picker"
// hint text.
function headerAt (lines:string[], parts:string[]):number {
    return lines.findIndex(l => (
        parts.every(p => l.includes(p)) &&
            !l.includes('/') &&
            !l.includes('picker')
    ))
}

function blockOf (lines:string[], feature:string):string[] {
    const start = lines.findIndex(l => l.startsWith(`${feature} (`))
    const rest = lines.slice(start)
    const blank = rest.indexOf('')
    return blank < 0 ? rest : rest.slice(0, blank)
}

test('AC2.2 and AC3.1: rebase.blog ref lines and Run together', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        rebaseBlog(scratchDir)
        const lines = renderLines(load, [
            'analytics', 'held-import-review', 'newsletter-audit',
        ])
        const ready = 'ready-for-agent'
        const pairs:Array<[string, string]> = [
            ['held-import-review/01', 'newsletter-audit/16'],
            ['held-import-review/02', 'newsletter-audit/15'],
            ['held-import-review/06', 'newsletter-audit/18'],
        ]
        for (const [from, to] of pairs) {
            t.ok(
                lineIndex(lines, [from, to, ready]) >= 0,
                `a line has ${from}, ${to} and ${ready}`
            )
        }

        const i01 = lineIndex(lines, ['held-import-review/01'])
        const header = lines[i01 - 1]
        t.ok(
            header.includes('held-import-review') &&
                header.includes('newsletter-audit') &&
                !header.includes('/'),
            'the group header names both features and no ref'
        )
        t.ok(
            lineIndex(lines, [
                'held-import-review', 'newsletter-audit', 'picker',
            ], i01) > i01,
            'a later Run together line names both features'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC2.3: upstream groups inside a block are ordered', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'alpha', [[1, ready, 'beta 01']])
        addFeature(scratchDir, 'beta', [[1, ready, 'gamma 01']])
        addFeature(scratchDir, 'gamma', [[1, ready, 'None']])
        const lines = renderLines(load, ['alpha', 'beta', 'gamma'])
        const block = blockOf(lines, 'alpha')
        const first = lineIndex(block, ['alpha/01', 'beta/01'])
        const second = lineIndex(block, ['beta/01', 'gamma/01'])
        t.ok(first >= 0, 'alpha/01 line names beta/01')
        t.ok(second > first, 'the beta/01 to gamma/01 line comes after')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC2.3 and AC2.10: groups put the target first, then sort', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        // The target is a late name, and beta/02 names alpha after
        // beta/01 names gamma, so ticket order and name order differ.
        addFeature(scratchDir, 'alpha', [[1, ready, 'delta 01']])
        addFeature(scratchDir, 'beta', [
            [1, ready, 'gamma 01'],
            [2, ready, 'alpha 01'],
        ])
        addFeature(scratchDir, 'delta', [[1, ready, 'None']])
        addFeature(scratchDir, 'gamma', [[1, ready, 'delta 01']])
        const lines = renderLines(load, [
            'alpha', 'beta', 'delta', 'gamma',
        ])
        const block = blockOf(lines, 'beta')
        const betaAlpha = headerAt(block, ['beta', 'alpha'])
        const betaGamma = headerAt(block, ['beta', 'gamma'])
        const alphaDelta = headerAt(block, ['alpha', 'delta'])
        const gammaDelta = headerAt(block, ['gamma', 'delta'])
        t.ok(
            betaAlpha >= 0 && betaGamma >= 0 &&
                alphaDelta >= 0 && gammaDelta >= 0,
            'all four group headers are in the block'
        )
        t.ok(
            betaAlpha < betaGamma,
            'the upstream groups of beta sort by name'
        )
        t.ok(
            betaGamma < alphaDelta,
            'the groups of the block feature come first'
        )
        t.ok(
            alphaDelta < gammaDelta,
            'the other groups sort by from-feature name'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.1 (n > 2): the picker hint names all three features', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'alpha', [
            [1, ready, 'beta 01, gamma 01'],
        ])
        addFeature(scratchDir, 'beta', [[1, ready, 'None']])
        addFeature(scratchDir, 'gamma', [[1, ready, 'None']])
        const lines = renderLines(load, ['alpha', 'beta', 'gamma'])
        const hint = lineIndex(lines, [
            'alpha', 'beta', 'gamma', 'picker', '3',
        ])
        t.ok(hint >= 0, 'one line names all three and the count')
        t.ok(!lines[hint].includes('/'), 'the hint line names no ticket')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('renderGraph with no reports is an empty string', t => {
    t.equal(renderGraph([], []), '', 'nothing to render')
})

test('AC2.9: only the target and its direct needs are shown', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'alpha', [
            [1, ready, '02, beta 01'],
            [2, ready, 'None'],
            [3, 'ready-for-human', 'gamma 01'],
            [4, ready, 'delta 01'],
        ])
        addFeature(scratchDir, 'beta', [[1, ready, 'None']])
        addFeature(scratchDir, 'delta', [[1, 'done', 'None']])
        addFeature(scratchDir, 'gamma', [[1, ready, 'None']])
        const lines = renderLines(load, ['alpha', 'beta', 'delta', 'gamma'])
        t.ok(lineIndex(lines, ['beta/01']) >= 0, 'beta/01 is shown')
        t.equal(lineIndex(lines, ['gamma/01']), -1, 'no gamma/01 line')
        t.equal(lineIndex(lines, ['delta/01']), -1, 'no delta/01 line')
        t.equal(
            lineIndex(lines, ['alpha/01', 'alpha/02']),
            -1,
            'no line pairs alpha/01 with alpha/02'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC2.10: order is by name and number, and output is stable', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'zeta', [
            [2, ready, 'beta 01'],
            [1, ready, 'gamma 01'],
        ])
        addFeature(scratchDir, 'alpha', [
            [1, ready, 'beta 05'],
            [2, ready, 'gamma 01'],
            [3, ready, 'beta 02'],
        ])
        addFeature(scratchDir, 'beta', [
            [1, ready, 'None'],
            [2, ready, 'None'],
            [5, ready, 'None'],
        ])
        addFeature(scratchDir, 'gamma', [[1, ready, 'None']])
        const names = ['zeta', 'alpha', 'beta', 'gamma']
        const once = renderLines(load, names)
        const twice = renderLines(load, names)

        const alphaAt = once.findIndex(l => l.startsWith('alpha ('))
        const zetaAt = once.findIndex(l => l.startsWith('zeta ('))
        t.ok(alphaAt >= 0 && alphaAt < zetaAt, 'alpha block before zeta')

        const betaAt = headerAt(once, ['alpha', 'beta'])
        const gammaAt = headerAt(once, ['alpha', 'gamma'])
        t.ok(
            betaAt >= 0 && betaAt < gammaAt,
            'beta group before gamma group'
        )

        const a01 = lineIndex(once, ['alpha/01', 'beta/05'])
        const a03 = lineIndex(once, ['alpha/03', 'beta/02'])
        t.ok(a01 >= 0 && a03 > a01, 'alpha/01 line before alpha/03 line')

        t.equal(twice.join('\n'), once.join('\n'), 'rendering twice matches')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC2.11: unblocked features share one line', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        rebaseBlog(scratchDir)
        const lines = renderLines(load, [
            'analytics', 'held-import-review', 'newsletter-audit',
        ])
        const withAnalytics = lines.filter(l => l.includes('analytics'))
        t.equal(withAnalytics.length, 1, 'one line names analytics')
        t.ok(
            withAnalytics[0].includes('newsletter-audit'),
            'that line also names newsletter-audit'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }

    const fresh = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(fresh.scratchDir, 'alpha', [[1, ready, 'None']])
        addFeature(fresh.scratchDir, 'beta', [[1, ready, 'None']])
        const lines = renderLines(fresh.load, ['alpha', 'beta'])
        t.equal(lines.length, 1, 'only unblocked features give one line')
        t.ok(
            lines[0].includes('alpha') && lines[0].includes('beta'),
            'that line names both features'
        )
    } finally {
        rmSync(fresh.root, { recursive:true, force:true })
    }
})

test('AC2.11: a misspelt feature warning is shown once, last', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        rebaseBlog(scratchDir)
        addFeature(scratchDir, 'analytics', [
            [1, 'ready-for-agent', 'None'],
            [2, 'ready-for-agent', 'newsleter-audit 15'],
        ])
        const lines = renderLines(load, [
            'analytics', 'held-import-review', 'newsletter-audit',
        ])
        const hits = lines.filter(l => l.includes('newsleter-audit'))
        t.equal(hits.length, 1, 'the misspelt name appears once')
        t.equal(
            lineIndex(lines, ['newsleter-audit']),
            lines.length - 1,
            'and it is on the last line'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.4: a human-gated upstream is shown after the count', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        addFeature(scratchDir, 'alpha', [
            [1, 'ready-for-agent', 'beta 04'],
        ])
        addFeature(scratchDir, 'beta', [
            [4, 'ready-for-human', 'None'],
        ])
        const lines = renderLines(load, ['alpha', 'beta'])
        const count = lineIndex(lines, ['0 of 1'])
        t.ok(count >= 0, 'the count line is shown')
        t.ok(
            lineIndex(
                lines,
                ['alpha/01', 'beta/04', 'ready-for-human'],
                count
            ) > count,
            'a line names the human-gated ref after the count'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('AC3.6: a cycle is shown after the count', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'alpha', [[1, ready, 'beta 01']])
        addFeature(scratchDir, 'beta', [[1, ready, 'alpha 01']])
        const lines = renderLines(load, ['alpha', 'beta'])
        const count = lineIndex(lines, ['0 of 1'])
        t.ok(count >= 0, 'the count line is shown')
        t.ok(
            lineIndex(lines, ['alpha/01', 'beta/01'], count) > count,
            'a line names both cycle tickets after the count'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

// The hint is the parenthetical after the last "(" on the Run
// together line.
function runTogetherLine (lines:string[]):string {
    return lines.find(l => l.includes('Run together')) ?? ''
}

function parenthetical (line:string):string {
    return line.slice(line.lastIndexOf('(') + 1)
}

// The target's suggestion reaches a nested feature that the picker
// does not list, so its hint must not tell the user to select it.
function nestedRollout (scratchDir:string):void {
    const ready = 'ready-for-agent'
    addFeature(scratchDir, 'hir', [[1, ready, 'rollout/billing 01']])
    addFeature(scratchDir, 'newsletter-audit', [[16, ready, 'None']])
    addFeature(scratchDir, 'rollout/billing', [
        [1, ready, 'newsletter-audit 16'],
    ])
}

test('a Run together hint names a feature the picker cannot list', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        nestedRollout(scratchDir)
        const pickable = new Set(['hir', 'newsletter-audit'])
        const lines = renderLines(load, ['hir', 'newsletter-audit'], pickable)
        const run = runTogetherLine(lines)
        t.ok(run.includes('picker'), 'the Run together line has a hint')
        t.ok(
            parenthetical(run).includes('rollout/billing'),
            'the hint names the nested feature'
        )
        t.ok(
            !parenthetical(run).includes('newsletter-audit') &&
                !parenthetical(run).includes('hir'),
            'the hint names no feature the picker lists'
        )
        const header = lineIndex(lines, ['hir waits on'])
        t.ok(
            header >= 0 && lines.indexOf(run) > header,
            'the Run together line comes after the block header'
        )
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})

test('a Run together hint with every feature pickable is today\'s hint',
    t => {
        const { root, scratchDir, load } = makeScratch()
        try {
            nestedRollout(scratchDir)
            const names = ['hir', 'newsletter-audit', 'rollout/billing']
            const all = new Set(names)
            const run = runTogetherLine(renderLines(load, names, all))
            t.ok(run.includes('picker'), 'the Run together line has a hint')
            const hint = parenthetical(run)
            t.ok(
                names.every(n => !hint.includes(n)),
                'the hint names none of the features'
            )
            const omitted = runTogetherLine(renderLines(load, names))
            t.equal(
                parenthetical(omitted),
                hint,
                'an omitted pickable set gives the same hint'
            )
        } finally {
            rmSync(root, { recursive:true, force:true })
        }
    }
)

test('AC3.5: a missing ref is shown with no Run together line', t => {
    const { root, scratchDir, load } = makeScratch()
    try {
        const ready = 'ready-for-agent'
        addFeature(scratchDir, 'alpha', [[1, ready, 'beta 40']])
        addFeature(scratchDir, 'beta', [[1, ready, 'None']])
        const lines = renderLines(load, ['alpha', 'beta'])
        t.ok(
            lineIndex(lines, ['alpha/01', 'beta/40']) >= 0,
            'a line names alpha/01 and beta/40'
        )
        const bare = lines.findIndex(l => (
            l.includes('beta') && !l.includes('/')
        ))
        t.ok(bare >= 0, 'the not-waiting line names beta')
        t.ok(
            !lines[bare].includes('alpha'),
            'the not-waiting line does not name alpha'
        )
        t.equal(lineIndex(lines, ['picker']), -1, 'no picker line')
    } finally {
        rmSync(root, { recursive:true, force:true })
    }
})
