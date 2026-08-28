import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    parseTicketFilename,
    parseStatus,
    parseBlockers,
    scanTickets,
    findReadyTickets,
    markDone,
    renderPrompt,
    runWaves,
    type Ticket,
} from '../src/orchestrator.js'

// -- helpers --

function tmp ():string {
    return mkdtempSync(
        join(tmpdir(), 'nightralph-orch-test-')
    )
}

function makeTicketBody (opts:{
    status:string
    blockers?:number[]
}):string {
    const lines = [
        '# Test ticket',
        '',
        `**Status:** ${opts.status}`,
    ]
    if (opts.blockers && opts.blockers.length > 0) {
        lines.push(
            `**Blocked by:** ${opts.blockers.join(', ')}`
        )
    }
    return lines.join('\n')
}

function makeTicket (overrides:Partial<Ticket>&{
    num:number;
    filename:string;
}):Ticket {
    return {
        slug:overrides.filename.replace(
            /^\d+-(.+)\.md$/, '$1'
        ),
        filepath:`/fake/${overrides.filename}`,
        body:makeTicketBody({
            status:overrides.status ?? 'ready-for-agent',
        }),
        status:overrides.status ?? 'ready-for-agent',
        blockers:overrides.blockers ?? [],
        ...overrides,
    }
}

// -- parseTicketFilename --

test('parseTicketFilename parses valid names', t => {
    const r = parseTicketFilename('01-add-auth.md')
    t.ok(r, 'should return a result')
    t.equal(r!.num, 1, 'num')
    t.equal(r!.slug, 'add-auth', 'slug')
})

test('parseTicketFilename with multi-digit number', t => {
    const r = parseTicketFilename('123-foo-bar.md')
    t.ok(r, 'should return a result')
    t.equal(r!.num, 123, 'num')
    t.equal(r!.slug, 'foo-bar', 'slug')
})

test('parseTicketFilename rejects non-matching names', t => {
    t.equal(
        parseTicketFilename('readme.md'),
        null,
        'no leading number'
    )
    t.equal(
        parseTicketFilename('01-thing.txt'),
        null,
        'wrong extension'
    )
    t.equal(
        parseTicketFilename('not-a-ticket'),
        null,
        'no extension'
    )
})

// -- parseStatus --

test('parseStatus extracts status', t => {
    t.equal(
        parseStatus('**Status:** ready-for-agent'),
        'ready-for-agent',
        'basic'
    )
    t.equal(
        parseStatus('**Status:**   Done  '),
        'done',
        'trims and lowercases'
    )
    t.equal(
        parseStatus('no status here'),
        '',
        'missing status returns empty'
    )
})

test('parseStatus works in multi-line body', t => {
    const body = [
        '# Ticket',
        '',
        '**Status:** ready-for-agent',
        '**Blocked by:** 1, 2',
    ].join('\n')
    t.equal(parseStatus(body), 'ready-for-agent')
})

// -- parseBlockers --

test('parseBlockers extracts blocker numbers', t => {
    t.deepEqual(
        parseBlockers('**Blocked by:** 1, 2, 3'),
        [1, 2, 3],
        'comma-separated'
    )
    t.deepEqual(
        parseBlockers('**Blocked by:** #4 and #5'),
        [4, 5],
        'hash-prefixed'
    )
})

test('parseBlockers returns empty for none', t => {
    t.deepEqual(
        parseBlockers('**Blocked by:** none'),
        [],
        'explicit none'
    )
    t.deepEqual(
        parseBlockers('**Blocked by:** None'),
        [],
        'case-insensitive none'
    )
    t.deepEqual(
        parseBlockers('no blockers field at all'),
        [],
        'missing field'
    )
})

// -- scanTickets --

test('scanTickets reads and parses ticket files', t => {
    const dir = tmp()
    writeFileSync(
        join(dir, '01-first.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[],
        })
    )
    writeFileSync(
        join(dir, '02-second.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[1],
        })
    )
    writeFileSync(
        join(dir, 'ignore-me.txt'),
        'not a ticket'
    )

    const tickets = scanTickets(dir)
    t.equal(tickets.length, 2, 'finds 2 tickets')
    t.equal(tickets[0].num, 1, 'first ticket num')
    t.equal(tickets[0].slug, 'first', 'first ticket slug')
    t.equal(
        tickets[0].status,
        'ready-for-agent',
        'first ticket status'
    )
    t.deepEqual(
        tickets[0].blockers,
        [],
        'first has no blockers'
    )
    t.equal(tickets[1].num, 2, 'second ticket num')
    t.deepEqual(
        tickets[1].blockers,
        [1],
        'second blocked by 1'
    )
})

test('scanTickets returns sorted by number', t => {
    const dir = tmp()
    writeFileSync(
        join(dir, '10-z.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(dir, '02-a.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(dir, '03-b.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )

    const tickets = scanTickets(dir)
    t.deepEqual(
        tickets.map(t => t.num),
        [2, 3, 10],
        'numeric sort'
    )
})

// -- findReadyTickets --

test('findReadyTickets returns unblocked ready tickets', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            status:'done',
            blockers:[],
        }),
    ]

    const ready = findReadyTickets(tickets)
    t.equal(ready.length, 1, 'only one is ready')
    t.equal(ready[0].num, 1, 'ticket 1 is ready')
})

test('findReadyTickets unblocks after deps done', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            status:'done',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            status:'ready-for-agent',
            blockers:[1, 2],
        }),
    ]

    const ready = findReadyTickets(tickets)
    t.equal(ready.length, 1, 'only ticket 2 is ready')
    t.equal(
        ready[0].num,
        2,
        'ticket 2 unblocked because 1 is done'
    )
})

test('findReadyTickets returns nothing when all blocked', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            status:'ready-for-agent',
            blockers:[2],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const ready = findReadyTickets(tickets)
    t.equal(ready.length, 0, 'circular dep deadlock')
})

// -- markDone --

test('markDone updates file and ticket object', t => {
    const dir = tmp()
    const filepath = join(dir, '01-test.md')
    const body = makeTicketBody({
        status:'ready-for-agent',
    })
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'test',
        filename:'01-test.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
    }

    markDone(ticket)

    t.equal(ticket.status, 'done', 'in-memory status')
    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('**Status:** done'),
        'file updated on disk'
    )
    t.ok(
        !onDisk.includes('ready-for-agent'),
        'old status removed'
    )
})

// -- renderPrompt --

test('renderPrompt includes spec and ticket', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body here', ticket)
    t.ok(
        prompt.includes('spec body here'),
        'contains spec'
    )
    t.ok(
        prompt.includes('01-thing.md'),
        'contains ticket filename'
    )
    t.ok(
        prompt.includes('AGENT INSTRUCTIONS'),
        'contains instructions'
    )
})

// -- runWaves (integration) --

const MOCK_PASS = join(
    process.cwd(), 'test', 'mock-agent-pass.js'
)
const MOCK_FAIL = join(
    process.cwd(), 'test', 'mock-agent-fail.js'
)

test('runWaves completes unblocked tickets', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-first.md'),
        makeTicketBody({
            status:'ready-for-agent',
        })
    )
    writeFileSync(
        join(issuesDir, '02-second.md'),
        makeTicketBody({
            status:'ready-for-agent',
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_PASS, null, 10, logsDir,
    )

    t.equal(
        tickets[0].status, 'done',
        'ticket 1 done'
    )
    t.equal(
        tickets[1].status, 'done',
        'ticket 2 done'
    )

    const onDisk = readFileSync(
        join(issuesDir, '01-first.md'), 'utf8'
    )
    t.ok(
        onDisk.includes('**Status:** done'),
        'ticket 1 persisted to disk'
    )
})

test('runWaves respects dependency order', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-base.md'),
        makeTicketBody({
            status:'ready-for-agent',
        })
    )
    writeFileSync(
        join(issuesDir, '02-depends-on-1.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[1],
        })
    )
    writeFileSync(
        join(issuesDir, '03-depends-on-2.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[2],
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_PASS, null, 10, logsDir,
    )

    for (const ticket of tickets) {
        t.equal(
            ticket.status,
            'done',
            `${ticket.filename} completed`
        )
    }
})

test('runWaves stops dependents when agent fails', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-will-fail.md'),
        makeTicketBody({
            status:'ready-for-agent',
        })
    )
    writeFileSync(
        join(issuesDir, '02-blocked.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[1],
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_FAIL, null, 10, logsDir,
    )

    t.equal(
        tickets[0].status,
        'ready-for-agent',
        'failed ticket keeps status'
    )
    t.equal(
        tickets[1].status,
        'ready-for-agent',
        'dependent never ran'
    )
})

test('runWaves writes log files', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-task.md'),
        makeTicketBody({
            status:'ready-for-agent',
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_PASS, null, 10, logsDir,
    )

    t.ok(
        existsSync(join(logsDir, '01-task.log')),
        'log file created'
    )
})

test('runWaves skips already-done tickets', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-done.md'),
        makeTicketBody({ status:'done' })
    )
    writeFileSync(
        join(issuesDir, '02-ready.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[1],
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_PASS, null, 10, logsDir,
    )

    t.equal(
        tickets[0].status,
        'done',
        'pre-done ticket unchanged'
    )
    t.equal(
        tickets[1].status,
        'done',
        'dependent ran and completed'
    )
    t.ok(
        !existsSync(join(logsDir, '01-done.log')),
        'no log for skipped ticket'
    )
})

test('runWaves handles parallel independent tickets', async t => {
    const base = tmp()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-a.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(issuesDir, '02-b.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(issuesDir, '03-c.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(issuesDir, '04-final.md'),
        makeTicketBody({
            status:'ready-for-agent',
            blockers:[1, 2, 3],
        })
    )

    const tickets = scanTickets(issuesDir)

    await runWaves(
        tickets, 'test spec',
        MOCK_PASS, null, 10, logsDir,
    )

    for (const ticket of tickets) {
        t.equal(
            ticket.status,
            'done',
            `${ticket.filename} completed`
        )
    }

    const logs = readdirSync(logsDir)
    t.equal(logs.length, 4, 'all four logs written')
})
