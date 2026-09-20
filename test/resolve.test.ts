import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    findFeatureDirs,
    resolveIssuesDir,
} from '../src/resolve.js'
import {
    scanTickets,
    findReadyTickets,
} from '../src/orchestrator.js'

function makeTempScratch ():{
    cwd:string;
    scratchDir:string;
} {
    const cwd = mkdtempSync(
        join(tmpdir(), 'nightralph-resolve-')
    )
    const scratchDir = join(cwd, '.scratch')
    mkdirSync(scratchDir, { recursive:true })
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
    mkdirSync(issuesDir, { recursive:true })
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
                filename:'01-ready.md',
                body:[
                    '# Ready ticket',
                    '**Status:** ready-for-agent',
                    '**Blocked by:** None',
                ].join('\n'),
            },
            {
                filename:'02-done.md',
                body:[
                    '# Done ticket',
                    '**Status:** done',
                    '**Blocked by:** None',
                ].join('\n'),
            },
            {
                filename:'03-blocked.md',
                body:[
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
