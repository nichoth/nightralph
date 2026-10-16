import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    findFeatureDirs,
    resolveIssuesDir,
    loadSelection,
    featureCounts,
    featureChoiceLabel,
} from '../src/resolve.js'
import {
    scanTickets,
    findReadyTickets,
    blockerLabel,
    type Ticket,
} from '../src/orchestrator.js'

function makeTempScratch ():{
    cwd:string;
    scratchDir:string;
} {
    const cwd = mkdtempSync(
        join(tmpdir(), 'nightralph-resolve-')
    )
    const scratchDir = join(cwd, '.scratch')
    mkdirSync(scratchDir, { recursive: true })
    return { cwd, scratchDir }
}

function addFeature (
    scratchDir:string,
    name:string,
    tickets:Array<{
        filename:string;
        body:string;
    }> = []
):void {
    const featureDir = join(scratchDir, name)
    const issuesDir = join(featureDir, 'issues')
    mkdirSync(issuesDir, { recursive: true })
    writeFileSync(
        join(featureDir, 'spec.md'),
        `# ${name}`
    )
    for (const t of tickets) {
        writeFileSync(
            join(issuesDir, t.filename),
            t.body
        )
    }
}

test('findFeatureDirs sorts results alphabetically', t => {
    const { cwd, scratchDir } = makeTempScratch()
    addFeature(scratchDir, 'zulu')
    addFeature(scratchDir, 'alpha')
    addFeature(scratchDir, 'mike')

    const results = findFeatureDirs(cwd)
    const names = results.map(r => r.name)
    t.deepEqual(
        names,
        ['alpha', 'mike', 'zulu'],
        'features should be sorted alphabetically'
    )
})

test(
    'resolveIssuesDir with --spec returns ' +
    'single-element array with name',
    async t => {
        const { cwd, scratchDir } = makeTempScratch()
        addFeature(scratchDir, 'my-feature')

        const result = await resolveIssuesDir(
            'my-feature', cwd
        )
        t.ok(
            Array.isArray(result),
            'result should be an array'
        )
        t.equal(
            result.length, 1,
            'should contain exactly one element'
        )
        t.equal(
            result[0].name, 'my-feature',
            'element should have name property'
        )
        t.ok(
            result[0].dir.endsWith('issues'),
            'element should have dir property'
        )
        t.ok(
            result[0].spec.endsWith('spec.md'),
            'element should have spec property'
        )
    }
)

test(
    'resolveIssuesDir auto-selects when 1 ' +
    'feature exists',
    async t => {
        const { cwd, scratchDir } = makeTempScratch()
        addFeature(scratchDir, 'only-feature')

        const result = await resolveIssuesDir(
            undefined, cwd
        )
        t.ok(
            Array.isArray(result),
            'result should be an array'
        )
        t.equal(
            result.length, 1,
            'should auto-select the sole feature'
        )
        t.equal(
            result[0].name, 'only-feature',
            'should have correct name'
        )
    }
)

test(
    'findFeatureDirs dirs work with scanTickets ' +
    'for ticket counts',
    t => {
        const { cwd, scratchDir } = makeTempScratch()
        addFeature(scratchDir, 'counted', [
            {
                filename: '01-ready.md',
                body: [
                    '# Ready ticket',
                    '**Status:** ready-for-agent',
                    '**Blocked by:** None',
                ].join('\n'),
            },
            {
                filename: '02-done.md',
                body: [
                    '# Done ticket',
                    '**Status:** done',
                    '**Blocked by:** None',
                ].join('\n'),
            },
            {
                filename: '03-blocked.md',
                body: [
                    '# Blocked ticket',
                    '**Status:** ready-for-agent',
                    '**Blocked by:** 01',
                ].join('\n'),
            },
        ])

        const features = findFeatureDirs(cwd)
        t.equal(features.length, 1, 'one feature')

        const tickets = scanTickets(features[0].dir)
        t.equal(
            tickets.length, 3,
            'total ticket count'
        )

        const ready = findReadyTickets(tickets)
        t.equal(
            ready.length, 1,
            'only unblocked ready-for-agent tickets'
        )
    }
)

// -- loadSelection --

const NA = 'newsletter-audit'
const HIR = 'held-import-review'

// Field text copied verbatim from rebase.blog held-import-review 01.
const HIR_01_BLOCKED_BY = `newsletter-audit 16
(\`.scratch/newsletter-audit/issues/16-operator-approval-sticks.md\`),
which rewrites the same decision and expiry emails.`

function ticketBody (status:string, blockedBy:string):string {
    return `# T\n\n**Status:** ${status}\n**Blocked by:** ${blockedBy}\n`
}

function findTicket (tickets:Ticket[], feature:string, num:number):Ticket {
    const found = tickets.find(t => t.feature === feature && t.num === num)
    if (!found) throw new Error(`fixture has no ticket ${feature}/${num}`)
    return found
}

// held-import-review 01 waits on newsletter-audit 16, which has the
// given status.
function crossFeatureTree (naStatus:string):string {
    const { scratchDir } = makeTempScratch()
    addFeature(scratchDir, NA, [{
        filename: '16-x.md',
        body: ticketBody(naStatus, 'None'),
    }])
    addFeature(scratchDir, HIR, [{
        filename: '01-writer-can-reply.md',
        body: ticketBody('ready-for-agent', HIR_01_BLOCKED_BY),
    }])
    return scratchDir
}

test('loadSelection AC1.1 AC2.1: a done blocker in an unselected ' +
    'feature', t => {
    const scratchDir = crossFeatureTree('done')
    const { tickets, warnings } = loadSelection(scratchDir, [HIR])
    const hir01 = findTicket(tickets, HIR, 1)
    t.deepEqual(hir01.blockers, [
        { feature: NA, num: 16, where: 'done', status: 'done' },
    ], 'the ref is done outside the run')
    t.deepEqual(
        findReadyTickets(tickets).map(x => x.num), [1], 'ticket is ready'
    )
    t.ok(
        tickets.every(x => x.feature === HIR),
        'the unselected feature is not in the run'
    )
    t.deepEqual(warnings, [], 'no warnings')
})

test('loadSelection AC2.2: an unfinished blocker in an unselected ' +
    'feature', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    const { tickets, warnings } = loadSelection(scratchDir, [HIR])
    const [ref] = findTicket(tickets, HIR, 1).blockers
    t.deepEqual(ref, {
        feature: NA, num: 16, where: 'pending', status: 'ready-for-agent',
    }, 'the ref is pending')
    t.deepEqual(findReadyTickets(tickets), [], 'nothing is ready')
    t.ok(blockerLabel(ref).includes('newsletter-audit/16'), 'label names it')
    t.ok(blockerLabel(ref).includes('ready-for-agent'), 'label has status')
    t.deepEqual(warnings, [], 'pending is not a warning')
})

test('loadSelection: a blocker in a selected feature is in the run', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    const { tickets } = loadSelection(scratchDir, [HIR, NA])
    t.deepEqual(findTicket(tickets, HIR, 1).blockers, [
        { feature: NA, num: 16, where: 'run' },
    ], 'run ref')
})

test('loadSelection AC2.4: blockers that match no ticket', t => {
    const { scratchDir } = makeTempScratch()
    addFeature(scratchDir, NA, [{
        filename: '16-x.md',
        body: ticketBody('done', 'None'),
    }])
    addFeature(scratchDir, HIR, [
        {
            filename: '01-other.md',
            body: ticketBody('ready-for-agent', 'newsletter-audit 40'),
        },
        {
            filename: '02-own.md',
            body: ticketBody('ready-for-agent', '09'),
        },
    ])
    const { tickets, warnings } = loadSelection(scratchDir, [HIR])
    t.deepEqual(findTicket(tickets, HIR, 1).blockers, [
        { feature: NA, num: 40, where: 'missing' },
    ], 'other-feature ref is missing')
    t.deepEqual(findTicket(tickets, HIR, 2).blockers, [
        { feature: HIR, num: 9, where: 'missing' },
    ], 'own-feature ref is missing')
    t.deepEqual(findReadyTickets(tickets), [], 'neither is ready')
    t.deepEqual(
        warnings.map(w => [w.kind, w.ticket]),
        [
            ['missing', `${HIR}/01`],
            ['missing', `${HIR}/02`],
        ],
        'one missing warning per ticket'
    )
})

test('loadSelection: a misspelt feature is a typo warning', t => {
    const { scratchDir } = makeTempScratch()
    addFeature(scratchDir, NA, [])
    addFeature(scratchDir, HIR, [
        {
            filename: '01-typo.md',
            body: ticketBody('ready-for-agent', 'nwsletter-audit 16'),
        },
        {
            filename: '16-own.md',
            body: ticketBody('ready-for-agent', 'None'),
        },
    ])
    const { tickets, warnings } = loadSelection(scratchDir, [HIR])
    t.deepEqual(
        warnings.map(w => ({ kind: w.kind, text: w.text })),
        [{ kind: 'typo', text: 'nwsletter-audit' }],
        'one typo warning'
    )
    t.deepEqual(findTicket(tickets, HIR, 1).blockers, [
        { feature: HIR, num: 16, where: 'run' },
    ], 'the number refers to the own feature')
})

test('loadSelection: a blocker in a nested feature', t => {
    const { scratchDir } = makeTempScratch()
    addFeature(scratchDir, 'rollout/billing', [{
        filename: '03-x.md',
        body: ticketBody('done', 'None'),
    }])
    addFeature(scratchDir, HIR, [{
        filename: '01-x.md',
        body: ticketBody('ready-for-agent', 'rollout/billing 03'),
    }])
    const { tickets, warnings } = loadSelection(scratchDir, [HIR])
    t.deepEqual(findTicket(tickets, HIR, 1).blockers, [
        { feature: 'rollout/billing', num: 3, where: 'done', status: 'done' },
    ], 'the ref resolves into the nested feature')
    t.deepEqual(warnings, [], 'no warnings')
})

test('featureCounts AC1.11: the picker counts what a run would', t => {
    const scratchDir = crossFeatureTree('done')
    addFeature(scratchDir, HIR, [{
        filename: '02-next.md',
        body: ticketBody('ready-for-agent', '01'),
    }])
    const counts = featureCounts(scratchDir, HIR)
    t.deepEqual(
        counts,
        { ready: 1, total: 2, badBlockers: 0, waitsOn: [] },
        'counts'
    )
    const run = loadSelection(scratchDir, [HIR])
    t.equal(
        counts.ready,
        findReadyTickets(run.tickets).length,
        'same ready count as a run of this feature alone'
    )
})

test('featureCounts AC2.4: only missing refs are bad blockers', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    t.equal(
        featureCounts(scratchDir, HIR).badBlockers, 0,
        'a pending outside blocker is not bad'
    )
    addFeature(scratchDir, HIR, [{
        filename: '02-bad.md',
        body: ticketBody('ready-for-agent', 'newsletter-audit 40'),
    }])
    t.equal(
        featureCounts(scratchDir, HIR).badBlockers, 1,
        'a blocker that matches no ticket is bad'
    )
})

test('featureCounts AC1.1: names the feature it waits on', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    t.deepEqual(
        featureCounts(scratchDir, HIR).waitsOn, [NA], 'waitsOn'
    )
    const label = featureChoiceLabel(scratchDir, HIR)
    t.ok(
        label.endsWith(`, waits on ${NA})`),
        'label ends with the upstream feature'
    )
})

test('featureCounts AC1.2: several upstream features, all named', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    addFeature(scratchDir, 'zeta-feat', [{
        filename: '01-x.md',
        body: ticketBody('ready-for-agent', 'None'),
    }])
    addFeature(scratchDir, 'beta-feat', [{
        filename: '01-x.md',
        body: ticketBody('ready-for-agent', 'None'),
    }])
    addFeature(scratchDir, HIR, [
        {
            filename: '02-zeta.md',
            body: ticketBody('ready-for-agent', 'zeta-feat 01'),
        },
        {
            filename: '03-beta.md',
            body: ticketBody('ready-for-agent', 'beta-feat 01'),
        },
    ])
    const { waitsOn } = featureCounts(scratchDir, HIR)
    t.deepEqual(
        waitsOn,
        ['beta-feat', NA, 'zeta-feat'],
        'sorted, none dropped'
    )
    const label = featureChoiceLabel(scratchDir, HIR)
    for (const name of ['beta-feat', NA, 'zeta-feat']) {
        t.ok(label.includes(name), `label names ${name}`)
    }
})

test('featureCounts AC1.3: no pending ref gives the old label', t => {
    const scratchDir = crossFeatureTree('done')
    const c = featureCounts(scratchDir, HIR)
    t.deepEqual(c.waitsOn, [], 'waitsOn is empty')
    t.equal(
        featureChoiceLabel(scratchDir, HIR),
        `${HIR} (${c.ready}/${c.total} ready)`,
        'label has no waits clause'
    )
})

test('featureCounts AC1.4: done, missing and human refs add nothing', t => {
    const { scratchDir } = makeTempScratch()
    addFeature(scratchDir, NA, [{
        filename: '16-done.md',
        body: ticketBody('done', 'None'),
    }])
    addFeature(scratchDir, 'other-feat', [{
        filename: '01-x.md',
        body: ticketBody('ready-for-agent', 'None'),
    }])
    addFeature(scratchDir, HIR, [
        {
            filename: '01-done-ref.md',
            body: ticketBody('ready-for-agent', 'newsletter-audit 16'),
        },
        {
            filename: '02-missing.md',
            body: ticketBody('ready-for-agent', 'newsletter-audit 40'),
        },
        {
            filename: '03-done-ticket.md',
            body: ticketBody('done', 'other-feat 01'),
        },
        {
            filename: '04-human.md',
            body: ticketBody('ready-for-human', 'other-feat 01'),
        },
    ])
    t.deepEqual(
        featureCounts(scratchDir, HIR).waitsOn,
        [],
        'waitsOn is empty'
    )
})

test('featureCounts AC1.5: ready is still the run-alone count', t => {
    const scratchDir = crossFeatureTree('ready-for-agent')
    const c = featureCounts(scratchDir, HIR)
    const alone = loadSelection(scratchDir, [HIR]).tickets
    t.equal(
        c.ready,
        findReadyTickets(alone).length,
        'ready matches a solo run'
    )
    t.equal(c.ready, 0, 'the pending blocker keeps it from running alone')
    t.equal(c.total, 1, 'total is the feature alone')
})

test('featureChoiceLabel AC1.6: bad blockers sit between ready and waits',
    t => {
        const scratchDir = crossFeatureTree('ready-for-agent')
        addFeature(scratchDir, HIR, [{
            filename: '02-bad.md',
            body: ticketBody('ready-for-agent', 'newsletter-audit 40'),
        }])
        const label = featureChoiceLabel(scratchDir, HIR)
        const ready = label.indexOf('ready')
        const bad = label.indexOf('bad blocker')
        const waits = label.indexOf('waits on')
        t.ok(
            ready < bad && bad < waits,
            `order is ready, bad blockers, waits on: ${label}`
        )
    }
)
