import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, readdirSync,
    rmSync, symlinkSync, chmodSync, copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
    parseTicketFilename,
    parseStatus,
    scanTickets,
    findReadyTickets,
    findBlockedTickets,
    markDone,
    checkItems,
    COMPLETED_RE,
    TOOL_USE_RE,
    renderPrompt,
    renderMergePrompt,
    stripSpecSection,
    runWaves,
    DEFAULT_CONCURRENCY,
    spawnAgent,
    dryRun,
    dryRunIsolated,
    getProviderArgs,
    formatStreamLine,
    createPiStreamFormatter,
    escalateEffort,
    retryDelayFor,
    DEFAULT_RETRY_DELAY,
    DEFAULT_RETRIES,
    ALL_EFFORT_LEVELS,
    renderFinishSummary,
    lookupSpec,
    ticketKey,
    blockerSatisfied,
    blockerLabel,
    historyFor,
    nothingReady,
    renderNothingReady,
    HUMAN_STATUS,
    type Ticket,
    type EffortLevel,
} from '../src/orchestrator.js'
import {
    NOTES_PATH,
    appendEntry,
    renderEntry,
} from '../src/learnings.js'
import type { BlockerRef } from '../src/blockers.js'
import { ticketLabel } from '../src/display.js'

// -- helpers --

function tmp ():string {
    return mkdtempSync(
        join(tmpdir(), 'nightralph-orch-test-')
    )
}

function initTempGitRepo ():string {
    const dir = tmp()
    execSync('git init', { cwd:dir })
    execSync(
        'git config user.email test@example.com',
        { cwd:dir }
    )
    execSync(
        'git config user.name "Test User"',
        { cwd:dir }
    )
    execSync(
        'git commit --allow-empty -m "init" --no-verify',
        {
            cwd:dir,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        }
    )
    return dir
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

function makeTicket (overrides:Omit<Partial<Ticket>, 'blockers'>&{
    num:number;
    filename:string;
    blockers?:Array<number|BlockerRef>;
}):Ticket {
    const feature = overrides.feature ?? ''
    const blockers = (overrides.blockers ?? []).map(b => (
        typeof b === 'number' ?
            { feature, num:b, where:'run' as const } :
            b
    ))
    return {
        slug:overrides.filename.replace(
            /^\d+-(.+)\.md$/, '$1'
        ),
        filepath:`/fake/${overrides.filename}`,
        body:makeTicketBody({
            status:overrides.status ?? 'ready-for-agent',
        }),
        status:overrides.status ?? 'ready-for-agent',
        feature,
        ...overrides,
        blockers,
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

// -- scanTickets blocker refs --

test('scanTickets reads blockers as refs in its feature', t => {
    const dir = tmp()
    writeFileSync(
        join(dir, '01-a.md'),
        makeTicketBody({ status:'ready-for-agent', blockers:[1, 2, 3] })
    )
    const [ticket] = scanTickets(dir, 'f')
    t.deepEqual(ticket.blockers, [
        { feature:'f', num:1, where:'run' },
        { feature:'f', num:2, where:'run' },
        { feature:'f', num:3, where:'run' },
    ], 'three run refs in feature f')
})

test('scanTickets reads a cross-feature blocker', t => {
    const dir = tmp()
    writeFileSync(
        join(dir, '01-a.md'),
        '**Status:** ready-for-agent\n' +
        '**Blocked by:** newsletter-audit 16\n'
    )
    const [ticket] = scanTickets(
        dir, 'f', new Set(['newsletter-audit'])
    )
    t.deepEqual(ticket.blockers, [
        { feature:'newsletter-audit', num:16, where:'run' },
    ], 'ref in the named feature')
})

test('scanTickets reads None as no blockers', t => {
    const dir = tmp()
    writeFileSync(
        join(dir, '01-a.md'),
        '**Status:** ready-for-agent\n**Blocked by:** None\n'
    )
    const [ticket] = scanTickets(dir, 'f')
    t.deepEqual(ticket.blockers, [], 'no refs')
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
        [{ feature:'', num:1, where:'run' }],
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

test('scanTickets populates feature on every ticket', t => {
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

    const tickets = scanTickets(dir, 'auth')
    t.equal(
        tickets[0].feature,
        'auth',
        'first ticket has feature set'
    )
    t.equal(
        tickets[1].feature,
        'auth',
        'second ticket has feature set'
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

test(
    'findReadyTickets does not unblock on empty status',
    t => {
        const tickets:Ticket[] = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const ready = findReadyTickets(tickets)
        t.equal(
            ready.length,
            0,
            'blocker with empty status is not done'
        )
    }
)

test(
    'findReadyTickets does not unblock on claimed status',
    t => {
        const tickets:Ticket[] = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'claimed',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const ready = findReadyTickets(tickets)
        t.equal(
            ready.length,
            0,
            'blocker with claimed status is not done'
        )
    }
)

test(
    'findReadyTickets does not unblock on resolved status',
    t => {
        const tickets:Ticket[] = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'resolved',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const ready = findReadyTickets(tickets)
        t.equal(
            ready.length,
            0,
            'blocker with resolved status is not done'
        )
    }
)

test('findReadyTickets unblocks on done status', t => {
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
    ]

    const ready = findReadyTickets(tickets)
    t.equal(ready.length, 1, 'blocker with done status unblocks')
    t.equal(ready[0].num, 2, 'ticket 2 is ready')
})

test(
    'findReadyTickets compound identity: completing ' +
    'feature-A/01 does not unblock feature-B/02',
    t => {
        const tickets:Ticket[] = [
            makeTicket({
                num:1,
                filename:'01-setup.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:1,
                filename:'01-base.md',
                status:'ready-for-agent',
                feature:'payments',
            }),
            makeTicket({
                num:2,
                filename:'02-charge.md',
                status:'ready-for-agent',
                blockers:[1],
                feature:'payments',
            }),
        ]

        const ready = findReadyTickets(tickets)
        t.equal(
            ready.length,
            1,
            'only payments/01 is ready'
        )
        t.equal(
            ready[0].feature,
            'payments',
            'the ready ticket is from payments'
        )
        t.equal(
            ready[0].num,
            1,
            'the ready ticket is num 1'
        )
    }
)

// -- findBlockedTickets --

const keysOf = (refs?:BlockerRef[]) =>
    (refs ?? []).map(r => ticketKey(r.feature, r.num))

test('findBlockedTickets: direct blocker failed', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set(['f:1']))
    t.equal(blocked.size, 1, 'one ticket blocked')
    t.ok(blocked.has('f:2'), 'f:2 is blocked')
    t.deepEqual(
        keysOf(blocked.get('f:2')),
        ['f:1'],
        'f:2 blocked by f:1'
    )
    t.ok(!blocked.has('f:1'), 'f:1 not in blocked')
})

test('findBlockedTickets: chain through ready ticket', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[2],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set(['f:1']))
    t.equal(blocked.size, 2, 'two tickets blocked')
    t.ok(blocked.has('f:2'), 'f:2 is blocked')
    t.ok(blocked.has('f:3'), 'f:3 is blocked')
    const f2Blocked = keysOf(blocked.get('f:2'))
    t.deepEqual(
        f2Blocked.sort(),
        ['f:1'],
        'f:2 blocked by f:1'
    )
    const f3Blocked = keysOf(blocked.get('f:3'))
    t.deepEqual(
        f3Blocked.sort(),
        ['f:1'],
        'f:3 blocked by f:1 (through ready f:2)'
    )
})

test('findBlockedTickets: multiple failed blockers', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1, 2],
        }),
    ]

    const blocked = findBlockedTickets(
        tickets,
        new Set(['f:1', 'f:2'])
    )
    t.equal(blocked.size, 1, 'one ticket blocked')
    t.ok(blocked.has('f:3'), 'f:3 is blocked')
    const f3Blocked = keysOf(blocked.get('f:3'))
    t.deepEqual(
        f3Blocked.sort(),
        ['f:1', 'f:2'],
        'f:3 blocked by both f:1 and f:2'
    )
})

test('findBlockedTickets: different features', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'a',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:1,
            filename:'01-x.md',
            feature:'b',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-y.md',
            feature:'b',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const blocked = findBlockedTickets(
        tickets,
        new Set(['a:1'])
    )
    t.equal(blocked.size, 0, 'no tickets blocked')
    t.ok(
        !blocked.has('b:2'),
        'b:2 not blocked by a:1 from other feature'
    )
})

test('findBlockedTickets: human status blocker', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:HUMAN_STATUS,
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set())
    t.equal(blocked.size, 1, 'one ticket blocked')
    t.ok(blocked.has('f:2'), 'f:2 is blocked')
    t.deepEqual(
        keysOf(blocked.get('f:2')),
        ['f:1'],
        'f:2 blocked by human f:1'
    )
})

test('findBlockedTickets: a failed ticket is never a key', t => {
    // Ticket 2 has a dead blocker, so it would be reported if it
    // were a candidate; it has failed itself, so it is not.
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:HUMAN_STATUS,
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set(['f:2']))
    t.ok(!blocked.has('f:2'), 'failed f:2 is not a key')
    t.equal(blocked.size, 0, 'nothing is blocked')
})

test('findBlockedTickets: chain to human ticket', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:HUMAN_STATUS,
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[2],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set())
    t.equal(blocked.size, 2, 'two tickets blocked')
    t.ok(blocked.has('f:2'), 'f:2 is blocked')
    t.ok(blocked.has('f:3'), 'f:3 is blocked')
    t.deepEqual(
        keysOf(blocked.get('f:2')),
        ['f:1'],
        'f:2 blocked by human f:1'
    )
    t.deepEqual(
        keysOf(blocked.get('f:3')),
        ['f:1'],
        'f:3 blocked by human f:1 (chain)'
    )
})

test('findBlockedTickets: done blocker not blocking', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'done',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1, 2],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set())
    t.equal(blocked.size, 0, 'no tickets blocked')
})

test('findBlockedTickets: diamond pattern', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:4,
            filename:'04-d.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[2, 3],
        }),
    ]

    const blocked = findBlockedTickets(
        tickets,
        new Set(['f:1'])
    )
    t.equal(blocked.size, 3, 'three tickets blocked')
    t.ok(blocked.has('f:2'), 'f:2 is blocked')
    t.ok(blocked.has('f:3'), 'f:3 is blocked')
    t.ok(blocked.has('f:4'), 'f:4 is blocked')
    const f2Blocked = keysOf(blocked.get('f:2'))
    t.deepEqual(f2Blocked.sort(), ['f:1'], 'f:2 blocked by f:1')
    const f3Blocked = keysOf(blocked.get('f:3'))
    t.deepEqual(f3Blocked.sort(), ['f:1'], 'f:3 blocked by f:1')
    const f4Blocked = keysOf(blocked.get('f:4'))
    t.deepEqual(
        f4Blocked.sort(),
        ['f:1'],
        'f:4 blocked by f:1 only (diamond paths converge)'
    )
})

test('findBlockedTickets: missing blocker number', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[9],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set())
    t.equal(blocked.size, 0, 'no tickets blocked by missing ticket')
})

test('findBlockedTickets: cycle', t => {
    const tickets:Ticket[] = [
        makeTicket({
            num:1,
            filename:'01-a.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[2],
        }),
        makeTicket({
            num:2,
            filename:'02-b.md',
            feature:'f',
            status:'ready-for-agent',
            blockers:[1],
        }),
    ]

    const blocked = findBlockedTickets(tickets, new Set())
    t.equal(blocked.size, 0, 'cycles do not create blocks')
})

test('findBlockedTickets: dense graph', t => {
    const tickets:Ticket[] = []
    for (let i = 1; i <= 200; i++) {
        const blockers:number[] = []
        if (i > 1) blockers.push(i - 1)
        if (i > 2) blockers.push(i - 2)
        tickets.push(
            makeTicket({
                num:i,
                filename:`${String(i).padStart(3, '0')}-ticket.md`,
                feature:'f',
                status:'ready-for-agent',
                blockers,
            })
        )
    }

    const blocked = findBlockedTickets(
        tickets,
        new Set(['f:1'])
    )
    t.equal(blocked.size, 199, '199 tickets blocked')
    for (let i = 2; i <= 200; i++) {
        t.ok(
            blocked.has(`f:${i}`),
            `f:${i} is blocked`
        )
        t.deepEqual(
            keysOf(blocked.get(`f:${i}`)),
            ['f:1'],
            `f:${i} maps to f:1`
        )
    }
})

// -- cross-feature blocker refs --

function captureDryRun (tickets:Array<Ticket>):string[] {
    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }
    try {
        dryRun(tickets, 'spec', '')
    } finally {
        console.log = originalLog
    }
    return output.join('\n').split('\n')
}

function lineWith (lines:string[], prefix:string):string {
    return lines.find(l => l.trim().startsWith(prefix)) ?? ''
}

test('blockerSatisfied decides each kind of ref', t => {
    const doneKeys = new Set(['a:1'])
    t.ok(
        blockerSatisfied({ feature:'a', num:1, where:'run' }, doneKeys),
        'run ref to a done ticket'
    )
    t.ok(
        !blockerSatisfied({ feature:'a', num:2, where:'run' }, doneKeys),
        'run ref to an unfinished ticket'
    )
    t.ok(
        blockerSatisfied({ feature:'b', num:1, where:'done' }, doneKeys),
        'done outside the run'
    )
    t.ok(
        !blockerSatisfied(
            { feature:'b', num:1, where:'pending' }, doneKeys
        ),
        'pending outside the run'
    )
    t.ok(
        !blockerSatisfied(
            { feature:'b', num:1, where:'missing' }, doneKeys
        ),
        'missing'
    )
})

test('AC2.1: a done blocker outside the run lets a ticket run', t => {
    const ticket = makeTicket({
        num:2,
        filename:'02-x.md',
        feature:'a',
        blockers:[{ feature:'b', num:1, where:'done', status:'done' }],
    })
    t.deepEqual(
        findReadyTickets([ticket]).map(x => x.num), [2], 'ready'
    )
})

test('AC2.2: an unfinished blocker outside the run blocks', t => {
    const ref:BlockerRef = {
        feature:'b', num:1, where:'pending', status:'ready-for-agent',
    }
    const ticket = makeTicket({
        num:2, filename:'02-x.md', feature:'a', blockers:[ref],
    })
    t.deepEqual(findReadyTickets([ticket]), [], 'not ready')
    t.deepEqual(
        findBlockedTickets([ticket], new Set()).get('a:2'),
        [ref],
        'blocked by the outside ref'
    )
    const label = blockerLabel(ref)
    t.ok(label.includes('b/01'), 'label names the blocker')
    t.ok(label.includes('ready-for-agent'), 'label names its status')
})

test('AC2.3: a selected cross-feature blocker runs first', t => {
    const b1 = makeTicket({ num:1, filename:'01-first.md', feature:'b' })
    const a2 = makeTicket({
        num:2,
        filename:'02-second.md',
        feature:'a',
        blockers:[{ feature:'b', num:1, where:'run' }],
    })
    t.deepEqual(
        findReadyTickets([b1, a2]).map(x => x.filename),
        ['01-first.md'],
        'only the blocker is ready'
    )
    t.deepEqual(
        findReadyTickets([{ ...b1, status:'done' }, a2])
            .map(x => x.filename),
        ['02-second.md'],
        'the dependent is ready once the blocker is done'
    )

    const lines = captureDryRun([b1, a2])
    t.ok(
        lineWith(lines, 'Wave 1:').includes('01-first.md'),
        'blocker in wave 1'
    )
    t.ok(
        lineWith(lines, 'Wave 2:').includes('02-second.md'),
        'dependent in wave 2'
    )
})

test('AC2.4: a blocker that matches no ticket blocks', t => {
    const other:BlockerRef = { feature:'b', num:9, where:'missing' }
    const own:BlockerRef = { feature:'a', num:9, where:'missing' }
    const tickets = [
        makeTicket({
            num:2, filename:'02-x.md', feature:'a', blockers:[other],
        }),
        makeTicket({
            num:3, filename:'03-y.md', feature:'a', blockers:[own],
        }),
    ]
    t.deepEqual(findReadyTickets(tickets), [], 'neither is ready')
    const blocked = findBlockedTickets(tickets, new Set())
    t.ok(blocked.has('a:2'), 'other-feature miss is blocked')
    t.ok(blocked.has('a:3'), 'own-feature miss is blocked')
    t.ok(blockerLabel(other).includes('(not found)'), 'label says why')
})

test('AC2.5: a chain is blocked by the outside ticket', t => {
    const tickets = [
        makeTicket({
            num:1,
            filename:'01-x.md',
            feature:'a',
            blockers:[{ feature:'a', num:2, where:'run' }],
        }),
        makeTicket({
            num:2,
            filename:'02-y.md',
            feature:'a',
            blockers:[{
                feature:'b', num:5, where:'pending', status:'claimed',
            }],
        }),
    ]
    const blocked = findBlockedTickets(tickets, new Set())
    t.deepEqual(keysOf(blocked.get('a:1')), ['b:5'], 'a/01 by b/05')
    t.deepEqual(keysOf(blocked.get('a:2')), ['b:5'], 'a/02 by b/05')
})

test('AC2.6: a human ticket blocks only its own feature', t => {
    const tickets = [
        makeTicket({
            num:2,
            filename:'02-human.md',
            feature:'a',
            status:HUMAN_STATUS,
        }),
        makeTicket({
            num:2, filename:'02-done.md', feature:'b', status:'done',
        }),
        makeTicket({
            num:3,
            filename:'03-waits.md',
            feature:'b',
            blockers:[{ feature:'b', num:2, where:'run' }],
        }),
        makeTicket({
            num:4,
            filename:'04-needs-human.md',
            feature:'b',
            blockers:[{ feature:'a', num:2, where:'run' }],
        }),
    ]
    const summary = renderFinishSummary(tickets, 0, new Set())
    t.ok(
        summary.includes('04-needs-human.md'),
        'b/04, which lists a/02, is blocked by a human'
    )
    t.ok(
        !summary.includes('03-waits.md'),
        'b/03 is not listed as blocked by a human'
    )
    t.ok(
        !findBlockedTickets(tickets, new Set()).has('b:3'),
        'b/03 is not blocked'
    )
})

test('AC2.8: dry run waves agree with readiness', t => {
    const pending:BlockerRef = {
        feature:'b', num:4, where:'pending', status:'ready-for-agent',
    }
    const tickets = [
        makeTicket({
            num:1,
            filename:'01-free.md',
            feature:'a',
            blockers:[{ feature:'b', num:1, where:'done', status:'done' }],
        }),
        makeTicket({
            num:2, filename:'02-stuck.md', feature:'a', blockers:[pending],
        }),
        makeTicket({
            num:3,
            filename:'03-after.md',
            feature:'a',
            blockers:[{ feature:'a', num:1, where:'run' }],
        }),
    ]
    t.deepEqual(
        findReadyTickets(tickets).map(x => x.filename),
        ['01-free.md'],
        'only a/01 is ready'
    )

    const lines = captureDryRun(tickets)
    const wave1 = lineWith(lines, 'Wave 1:')
    t.ok(wave1.includes('01-free.md'), 'a/01 in wave 1')
    t.ok(!wave1.includes('03-after.md'), 'a/03 not in wave 1')
    t.ok(
        lineWith(lines, 'Wave 2:').includes('03-after.md'),
        'a/03 in wave 2'
    )
    t.ok(
        !lines.some(l => l.includes('Wave') && l.includes('02-stuck.md')),
        'a/02 is in no wave'
    )
    t.ok(
        lineWith(lines, 'Deadlocked tickets:').includes('02-stuck.md'),
        'a/02 is deadlocked'
    )
    t.ok(
        lineWith(lines, '02-stuck.md').includes(blockerLabel(pending)),
        'the listing shows the blocker label'
    )
})

// -- simulateWaves / detectDeadlocks (via dryRun) --

test(
    'dryRun does not treat claimed status as done in waves',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'claimed',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRun(tickets, 'spec body')
        } finally {
            console.log = originalLog
        }
        const fullOutput = output.join('\n')
        t.ok(
            !fullOutput.includes(
                'Wave 1: 02-b.md'
            ),
            'ticket 2 does not appear as ready ' +
                'while its blocker is only claimed'
        )
    }
)

test(
    'dryRun reports deadlock when blocker is claimed, ' +
        'not done',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'claimed',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRun(tickets, 'spec body')
        } finally {
            console.log = originalLog
        }
        const fullOutput = output.join('\n')
        t.ok(
            fullOutput.includes('Deadlocked tickets:') &&
                fullOutput.includes('02-b.md'),
            'ticket 2 is reported as deadlocked'
        )
    }
)

test(
    'dryRun compound identity: overlapping nums across ' +
    'features simulate correctly',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-base.md',
                status:'ready-for-agent',
                feature:'auth',
            }),
            makeTicket({
                num:1,
                filename:'01-base.md',
                status:'ready-for-agent',
                feature:'payments',
            }),
            makeTicket({
                num:2,
                filename:'02-after.md',
                status:'ready-for-agent',
                blockers:[1],
                feature:'payments',
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRun(tickets, 'spec body', 'npm test')
        } finally {
            console.log = originalLog
        }
        const fullOutput = output.join('\n')
        t.ok(
            fullOutput.includes('Wave 1:'),
            'has wave 1'
        )
        t.ok(
            fullOutput.includes('Wave 2:'),
            'has wave 2 for payments/02'
        )
        t.ok(
            !fullOutput.includes('Deadlocked'),
            'no deadlock -- payments/02 waits for ' +
            'payments/01, not auth/01'
        )
    }
)

test(
    'dryRun compound identity: cross-feature blocker ' +
    'deadlocks correctly',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-base.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:2,
                filename:'02-needs-1.md',
                status:'ready-for-agent',
                blockers:[1],
                feature:'payments',
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRun(tickets, 'spec body', 'npm test')
        } finally {
            console.log = originalLog
        }
        const fullOutput = output.join('\n')
        t.ok(
            fullOutput.includes('Deadlocked'),
            'payments/02 blocked by payments/01 ' +
            'which does not exist, so deadlocked'
        )
    }
)

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
        feature:'',
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

// -- COMPLETED_RE --

test('COMPLETED_RE matches [x] lines', t => {
    const match = '[x] first item'.match(COMPLETED_RE)
    t.ok(match, 'matches [x] line')
    t.equal(match![1], 'first item', 'captures item text')
})

test('COMPLETED_RE is case insensitive', t => {
    const match = '[X] uppercase marker'.match(COMPLETED_RE)
    t.ok(match, 'matches uppercase [X]')
    t.equal(match![1], 'uppercase marker')
})

test('COMPLETED_RE matches markdown bullet [x] lines', t => {
    // The form agents actually emit: a markdown checklist line.
    const match = '- [x] first item'.match(COMPLETED_RE)
    t.ok(match, 'matches - [x] line')
    t.equal(match![1], 'first item')
    t.ok('* [x] star bullet'.match(COMPLETED_RE))
    t.ok('+ [x] plus bullet'.match(COMPLETED_RE))
})

test('COMPLETED_RE ignores non-matching lines', t => {
    t.equal(
        'some other output'.match(COMPLETED_RE),
        null,
        'plain text does not match'
    )
    t.equal(
        '- [ ] unchecked item'.match(COMPLETED_RE),
        null,
        'unchecked item does not match'
    )
    t.equal(
        '[ ] missing x'.match(COMPLETED_RE),
        null,
        'empty brackets do not match'
    )
})

// -- TOOL_USE_RE --

test('TOOL_USE_RE matches tool invocation lines', t => {
    t.ok(
        TOOL_USE_RE.test('[bash] sed -n 1,35p src/server/events.ts'),
        'matches [bash] with command'
    )
    t.ok(
        TOOL_USE_RE.test('[edit]'),
        'matches [edit] alone'
    )
    t.ok(
        TOOL_USE_RE.test('[Read] src/index.ts'),
        'matches [Read] with path'
    )
    t.ok(
        TOOL_USE_RE.test('[Write] src/foo.ts'),
        'matches [Write]'
    )
})

test('TOOL_USE_RE rejects non-tool lines', t => {
    t.equal(
        TOOL_USE_RE.test('to'),
        false,
        'plain word does not match'
    )
    t.equal(
        TOOL_USE_RE.test('drop the approval frame'),
        false,
        'sentence does not match'
    )
    t.equal(
        TOOL_USE_RE.test(''),
        false,
        'empty string does not match'
    )
    t.equal(
        TOOL_USE_RE.test('some error occurred'),
        false,
        'error text does not match'
    )
})

// -- checkItems --

test('checkItems checks off matching items on disk', t => {
    const dir = tmp()
    const filepath = join(dir, '01-test.md')
    const body = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [ ] first item',
        '- [ ] second item',
        '- [ ] third item',
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'test',
        filename:'01-test.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, ['first item', 'third item'])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('- [x] first item'),
        'first item checked'
    )
    t.ok(
        onDisk.includes('- [ ] second item'),
        'second item still unchecked'
    )
    t.ok(
        onDisk.includes('- [x] third item'),
        'third item checked'
    )
})

test('checkItems is a no-op for empty list', t => {
    const dir = tmp()
    const filepath = join(dir, '01-noop.md')
    const body = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [ ] some item',
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'noop',
        filename:'01-noop.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, [])

    const onDisk = readFileSync(filepath, 'utf8')
    t.equal(onDisk, body, 'file unchanged')
})

test('checkItems handles special regex characters', t => {
    const dir = tmp()
    const filepath = join(dir, '01-special.md')
    const itemText = '`POST /api/setup/verify` works'
    const body = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        `- [ ] ${itemText}`,
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'special',
        filename:'01-special.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, [itemText])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes(`- [x] ${itemText}`),
        'item with special chars checked'
    )
})

test('checkItems checks items wrapped across lines', t => {
    const dir = tmp()
    const filepath = join(dir, '01-wrapped.md')
    // The real-world shape: items wrap with indented
    // continuation lines, while the agent echoes each item
    // as one long line.
    const body = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [ ] A fragment request to each route returns JSON ' +
            'with status 200, a JSON',
        '      content type, and the correct `page`.',
        '- [ ] Another item that stays unchecked',
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'wrapped',
        filename:'01-wrapped.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, [
        'A fragment request to each route returns JSON ' +
            'with status 200, a JSON content type, and the ' +
            'correct `page`.',
    ])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes(
            '- [x] A fragment request to each route returns ' +
                'JSON with status 200, a JSON'
        ),
        'wrapped item checked without reflowing the file'
    )
    t.ok(
        onDisk.includes(
            '      content type, and the correct `page`.'
        ),
        'continuation line preserved verbatim'
    )
    t.ok(
        onDisk.includes('- [ ] Another item that stays unchecked'),
        'other item untouched'
    )
})

test('checkItems matches bullet-prefixed echoes case-insensitively', t => {
    const dir = tmp()
    const filepath = join(dir, '01-bullet.md')
    const body = [
        '# Test ticket',
        '',
        '- [ ] First Item Here',
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'bullet',
        filename:'01-bullet.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, ['- [x] first item here'])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('- [x] First Item Here'),
        'item matched across bullet prefix and case'
    )
})

test('checkItems does not touch items inside code fences', t => {
    const dir = tmp()
    const filepath = join(dir, '01-fence.md')
    const itemText = 'real item'
    const body = [
        '# Test ticket',
        '',
        '```md',
        '- [ ] fenced example not an item',
        '```',
        '',
        `- [ ] ${itemText}`,
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'fence',
        filename:'01-fence.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    checkItems(ticket, ['fenced example not an item', itemText])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('- [ ] fenced example not an item'),
        'fenced line untouched'
    )
    t.ok(
        onDisk.includes(`- [x] ${itemText}`),
        'real item checked'
    )
})

test('markDone checks off all remaining items', t => {
    const dir = tmp()
    const filepath = join(dir, '01-done-items.md')
    const body = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [ ] first item',
        '- [x] second item',
        '- [ ] third item',
    ].join('\n')
    writeFileSync(filepath, body)

    const ticket:Ticket = {
        num:1,
        slug:'done-items',
        filename:'01-done-items.md',
        filepath,
        body,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    markDone(ticket)

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('**Status:** done'),
        'status set to done'
    )
    t.equal(
        onDisk.includes('- [ ]'),
        false,
        'no unchecked items remain'
    )
    t.equal(ticket.status, 'done', 'in-memory status')
})

test('markDone keeps on-disk edits missing from ticket.body', t => {
    const dir = tmp()
    const filepath = join(dir, '01-merged.md')
    const scanned = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [ ] first item',
    ].join('\n')
    // Simulates the merge bringing the agent's own edits into
    // the ticket file after the ticket was scanned.
    const merged = [
        '# Test ticket',
        '',
        '**Status:** ready-for-agent',
        '',
        '- [x] first item',
        '- [ ] a new later item',
    ].join('\n')
    writeFileSync(filepath, merged)

    const ticket:Ticket = {
        num:1,
        slug:'merged',
        filename:'01-merged.md',
        filepath,
        body:scanned,
        status:'ready-for-agent',
        blockers:[],
        feature:'',
    }

    markDone(ticket)

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes('- [x] first item'),
        'merged checked item preserved'
    )
    t.ok(
        onDisk.includes('- [x] a new later item'),
        'new item from disk also checked'
    )
    t.ok(
        !onDisk.includes('- [ ] first item'),
        'stale scanned body was not written back'
    )
})

// -- renderPrompt --

test('renderPrompt includes spec and ticket', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body here', ticket,
        { testCmd:'npm test' })
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

test('lookupSpec returns per-feature spec when available', t => {
    const specBodies = new Map([
        ['auth', 'auth spec content'],
        ['payments', 'payments spec content'],
    ])
    t.equal(
        lookupSpec(specBodies, 'fallback', 'auth'),
        'auth spec content',
        'returns auth spec'
    )
    t.equal(
        lookupSpec(specBodies, 'fallback', 'payments'),
        'payments spec content',
        'returns payments spec'
    )
    t.equal(
        lookupSpec(specBodies, 'fallback', 'unknown'),
        'fallback',
        'falls back for unknown feature'
    )
    t.equal(
        lookupSpec(undefined, 'fallback', 'auth'),
        'fallback',
        'falls back when no map provided'
    )
    t.equal(
        lookupSpec(specBodies, 'fallback', ''),
        'fallback',
        'falls back for empty feature'
    )
})

test('renderPrompt instructs agent to use /tdd',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt(
            'spec body here', ticket,
            { testCmd:'npm test' }
        )
        t.ok(
            prompt.includes('/tdd'),
            'prompt mentions /tdd'
        )
        t.ok(
            prompt.includes('Testing Decisions'),
            'points the agent at the spec seams'
        )
    }
)

test('renderPrompt instructs agent to report [x] items',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt(
            'spec body here', ticket,
            { testCmd:'npm test' }
        )
        t.ok(
            prompt.includes('[x]'),
            'prompt mentions [x] format'
        )
    }
)

test('renderPrompt includes the test command',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt(
            'spec body here', ticket,
            { testCmd:'npm run check' }
        )
        t.ok(
            prompt.includes('npm run check'),
            'names the test command'
        )
    })

test('renderPrompt with an empty test command names no gate',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const withCmd = renderPrompt(
            'spec body here', ticket,
            { testCmd:'npm run check' }
        )
        const without = renderPrompt(
            'spec body here', ticket,
            { testCmd:'' }
        )
        t.ok(
            withCmd.includes('npm run check'),
            'non-empty command is named'
        )
        t.ok(
            !without.includes('npm run check'),
            'empty command is not named'
        )
        t.ok(
            !without.includes('``'),
            'no empty code span for the command'
        )
    })

test('renderPrompt names the install command when given',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const withCmd = renderPrompt(
            'spec body', ticket,
            { testCmd:'npm test', installCmd:'pnpm i -x' }
        )
        const without = renderPrompt(
            'spec body', ticket,
            { testCmd:'npm test' }
        )
        t.ok(
            withCmd.includes('pnpm i -x'),
            'names the install command'
        )
        t.ok(
            !without.includes('pnpm i -x'),
            'no install line without an install command'
        )
    })

test('renderPrompt contains git push rule', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body', ticket,
        { testCmd:'npm test' })
    t.ok(
        prompt.toLowerCase().includes('git push'),
        'prompt mentions git push'
    )
})

test('renderPrompt contains current directory rule',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt('spec body', ticket,
            { testCmd:'npm test' })
        t.ok(
            prompt.toLowerCase().includes(
                'current directory'
            ),
            'prompt mentions current directory'
        )
    })

test('renderMergePrompt names the install command when ' +
    'given', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderMergePrompt(
        'spec body', ticket, { installCmd:'pnpm i -x' }
    )
    t.ok(
        prompt.includes('pnpm i -x'),
        'names the install command'
    )
})

test('renderMergePrompt contains git push rule', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderMergePrompt('spec body', ticket)
    t.ok(
        prompt.toLowerCase().includes('git push'),
        'merge prompt mentions git push'
    )
})

test('renderMergePrompt contains current directory rule', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderMergePrompt('spec body', ticket)
    t.ok(
        prompt.toLowerCase().includes('current directory'),
        'merge prompt mentions current directory'
    )
})

test('renderPrompt asks agent to record learnings in AGENTS.md',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt('spec body', ticket,
            { testCmd:'npm test' })
        t.ok(
            prompt.includes('AGENTS.md'),
            'prompt mentions AGENTS.md'
        )
        t.ok(
            prompt.toLowerCase().includes('nearest'),
            'prefers the nearest AGENTS.md over the root'
        )
    })

test('renderPrompt contains test integrity rule', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body', ticket,
        { testCmd:'npm test' })
    const lower = prompt.toLowerCase()
    t.ok(
        lower.includes('weaken'),
        'forbids weakening tests to get green'
    )
    t.ok(
        lower.includes('leave it unchecked'),
        'tells the agent not to fake [x] lines'
    )
})

test('renderPrompt asks agent to read nearby docs first',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt('spec body', ticket,
            { testCmd:'npm test' })
        t.ok(
            prompt.includes('CONTEXT.md'),
            'prompt mentions CONTEXT.md'
        )
        t.ok(
            prompt.includes('docs/adr/'),
            'prompt mentions ADRs'
        )
    })

test('renderPrompt asks for a commit per checklist item',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt('spec body', ticket,
            { testCmd:'npm test' })
        t.ok(
            prompt.toLowerCase().includes(
                'commit after each checklist item'
            ),
            'prompt asks for per-item commits'
        )
    })

test('renderPrompt includes history when provided ' +
    '(AC4.1)', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const token = randomUUID()
    const history = `Some history\ncontaining ${token}`
    const prompt = renderPrompt('spec body', ticket, {
        testCmd:'npm test',
        history,
    })
    const tokenIdx = prompt.indexOf(token)
    const ticketEnd = prompt.indexOf(ticket.body) + ticket.body.length
    const instructionsIdx = prompt.indexOf(
        'AGENT INSTRUCTIONS'
    )
    t.ok(
        tokenIdx >= 0,
        'prompt contains history token'
    )
    t.ok(
        tokenIdx > ticketEnd,
        'history token appears after the ticket body'
    )
    t.ok(
        tokenIdx < instructionsIdx,
        'history token appears before AGENT INSTRUCTIONS'
    )
})

test('renderPrompt with empty history equals no history ' +
    '(AC4.2)', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const noHistory = renderPrompt('spec body', ticket,
        { testCmd:'npm test' })
    const emptyHistory = renderPrompt('spec body', ticket, {
        testCmd:'npm test',
        history:'',
    })
    t.equal(
        noHistory,
        emptyHistory,
        'empty history string produces same prompt as no history'
    )

    // History adds exactly its own text plus one blank line, so the
    // no-history prompt cannot carry an empty header or extra lines
    const history = 'HIST-' + randomUUID()
    const withHistory = renderPrompt('spec body', ticket, {
        testCmd:'npm test',
        history,
    })
    t.equal(
        withHistory.replace(history + '\n\n', ''),
        noHistory,
        'history adds exactly its text and one blank line'
    )
})

test('renderPrompt includes NOTES_PATH', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body', ticket,
        { testCmd:'npm test' })
    t.ok(
        prompt.includes(NOTES_PATH),
        'prompt mentions NOTES_PATH'
    )
})

test('renderMergePrompt keeps both sides of doc conflicts',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderMergePrompt('spec body', ticket)
        t.ok(
            prompt.includes('AGENTS.md'),
            'merge prompt mentions AGENTS.md'
        )
        t.ok(
            prompt.toLowerCase().includes('both sides'),
            'merge prompt says to keep both sides'
        )
    })

// -- spawnAgent --

test('spawnAgent with cwd option runs in that directory',
    async t => {
        const base = tmp()
        const cwd = tmp()
        const logPath = join(base, 'test.log')

        const MOCK_CWD = join(
            process.cwd(), 'test', 'mock-agent-create-file.js'
        )

        const result = await spawnAgent({
            prompt:'test',
            agentCmd:MOCK_CWD,
            model:null,
            timeout:10,
            logPath,
            cwd,
        })

        t.equal(
            result.exitCode, 0,
            'should exit successfully'
        )
        t.ok(
            existsSync(logPath),
            'log file should be created'
        )
        const logContent = readFileSync(
            logPath, 'utf8'
        )
        t.ok(
            logContent.includes(cwd),
            'log should contain the cwd'
        )
    }
)

test('spawnAgent collects completed items from output',
    async t => {
        const base = tmp()
        const logPath = join(base, 'test.log')

        const MOCK_CHECKLIST = join(
            process.cwd(),
            'test',
            'mock-agent-checklist.js'
        )

        const result = await spawnAgent({
            prompt:'test',
            agentCmd:MOCK_CHECKLIST,
            model:null,
            timeout:10,
            logPath,
        })

        t.equal(
            result.exitCode, 0,
            'agent exits successfully'
        )
        t.deepEqual(
            result.completedItems,
            ['first item', 'third item'],
            'collects [x] items from output'
        )
    }
)

test('spawnAgent keeps logging stderr after stdout closes',
    async t => {
        const base = tmp()
        const logPath = join(base, 'test.log')

        const MOCK_CLOSE_STDOUT = join(
            process.cwd(),
            'test',
            'mock-agent-close-stdout-first.js'
        )

        const result = await spawnAgent({
            prompt:'test',
            agentCmd:MOCK_CLOSE_STDOUT,
            model:null,
            timeout:10,
            logPath,
        })

        t.equal(result.exitCode, 0, 'agent exits successfully')
        const logContent = readFileSync(logPath, 'utf8')
        t.ok(
            logContent.includes('stdout before close'),
            'log has the stdout output'
        )
        t.ok(
            logContent.includes('stderr after stdout closed'),
            'stdout EOF does not end the log before stderr is done'
        )
    }
)

test('spawnAgent reports spawn errors through onLine and the log',
    async t => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'test-spawn-err-'))
        try {
            const lines:string[] = []
            const logPath = join(tmpDir, 'agent.log')

            const result = await spawnAgent({
                prompt:'x',
                agentCmd:join(tmpDir, 'nightralph-no-such-agent'),
                model:null,
                timeout:10,
                logPath,
                onLine:(line:string) => lines.push(line),
            })

            t.equal(result.exitCode, 1, 'spawn failure exits 1')
            t.ok(
                lines.some(line => line.includes('ENOENT')),
                'spawn error is sent to onLine'
            )
            t.ok(
                existsSync(logPath) &&
                readFileSync(logPath, 'utf8').includes('ENOENT'),
                'spawn error is written to the log'
            )
        } finally {
            rmSync(tmpDir, { recursive:true, force:true })
        }
    }
)

// -- runWaves (integration) --

const MOCK_PASS = join(
    process.cwd(), 'test', 'mock-agent-pass.js'
)
const MOCK_FAIL = join(
    process.cwd(), 'test', 'mock-agent-fail.js'
)
test('runWaves completes unblocked tickets', async t => {
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

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
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

    for (const ticket of tickets) {
        t.equal(
            ticket.status,
            'done',
            `${ticket.filename} completed`
        )
    }
})

test('runWaves stops dependents when agent fails', async t => {
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_FAIL, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

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
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

    t.ok(
        existsSync(join(logsDir, '01-task.log')),
        'log file created'
    )
})

test('runWaves skips already-done tickets', async t => {
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

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
    const base = initTempGitRepo()
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

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
    } finally {
        process.chdir(originalCwd)
    }

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

// -- runWaves return value --

test('runWaves returns allDone:true when all tickets ' +
    'complete', async t => {
    const base = initTempGitRepo()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)

    writeFileSync(
        join(issuesDir, '01-pass.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )

    const tickets = scanTickets(issuesDir)

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        const result = await runWaves(
            tickets, 'test spec',
            MOCK_PASS, null, 10, logsDir,
            'npm test',
        )
        t.equal(
            result.allDone, true,
            'allDone is true when all tickets complete'
        )
    } finally {
        process.chdir(originalCwd)
    }
})

test('runWaves returns allDone:false when agent fails',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            const result = await runWaves(
                tickets, 'test spec',
                MOCK_FAIL, null, 10, logsDir,
                'npm test',
            )
            t.equal(
                result.allDone, false,
                'allDone is false when agent fails'
            )
        } finally {
            process.chdir(originalCwd)
        }
    })

const MOCK_FAIL_TICKET_01 = join(
    process.cwd(), 'test', 'mock-agent-fail-ticket-01.js'
)

test('runWaves - a failed ticket is not re-run in a later wave',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '03-dependent.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[2],
            })
        )

        const tickets = scanTickets(issuesDir)
        const invocationLog = join(base, 'invocations.log')

        const originalCwd = process.cwd()
        const originalEnv = process.env.MOCK_INVOCATION_LOG
        process.env.MOCK_INVOCATION_LOG = invocationLog
        process.chdir(base)
        try {
            await runWaves(
                tickets, 'test spec',
                MOCK_FAIL_TICKET_01, null, 10, logsDir,
                'npm test',
                undefined, undefined, undefined, 0,
            )

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'failed ticket stays ready-for-agent'
            )
            t.equal(
                tickets[2].status,
                'done',
                'dependent ticket ran in a later wave'
            )

            const invocations = existsSync(invocationLog) ?
                readFileSync(invocationLog, 'utf8')
                    .split('\n').filter(Boolean).length :
                0
            t.equal(
                invocations, 1,
                'failed ticket was only attempted once ' +
                'across the whole run'
            )
        } finally {
            process.chdir(originalCwd)
            if (originalEnv === undefined) {
                delete process.env.MOCK_INVOCATION_LOG
            } else {
                process.env.MOCK_INVOCATION_LOG = originalEnv
            }
        }
    })

// -- dryRunIsolated --

test('dryRunIsolated basic test', t => {
    const tickets:Array<Ticket> = [
        makeTicket({
            num:1,
            filename:'01-test.md',
            status:'ready-for-agent',
            blockers:[],
        }),
    ]

    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }

    try {
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'respawn',
            progressPath:'.scratch/feature/progress.md',
        })
        t.ok(true, 'function executed without error')
    } finally {
        console.log = originalLog
    }
})

function captureLog (fn:() => void):string {
    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }
    try {
        fn()
    } finally {
        console.log = originalLog
    }
    return output.join('\n')
}

test('dryRunIsolated prints (none) for an empty test command',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-test.md',
                status:'ready-for-agent',
                blockers:[],
            }),
        ]

        const out = captureLog(() => {
            dryRunIsolated({
                tickets,
                specBody:'test spec body',
                repoName:'myapp',
                conflictStrategy:'respawn',
                progressPath:'.scratch/feature/progress.md',
                testCmd:'',
            })
        })

        t.ok(out.includes('Test command: (none)'),
            'prints (none) for the empty command')
    })

test('dryRunIsolated prints the test command when set', t => {
    const tickets:Array<Ticket> = [
        makeTicket({
            num:1,
            filename:'01-test.md',
            status:'ready-for-agent',
            blockers:[],
        }),
    ]

    const out = captureLog(() => {
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'respawn',
            progressPath:'.scratch/feature/progress.md',
            testCmd:'npm test',
        })
    })

    t.ok(out.includes('Test command: npm test'),
        'prints the command')
    t.ok(!out.includes('Test command: (none)'),
        'does not print (none) for the test command')
})

test('dryRun prints (none) for an empty test command', t => {
    const tickets:Array<Ticket> = [
        makeTicket({
            num:1,
            filename:'01-test.md',
            status:'ready-for-agent',
            blockers:[],
        }),
    ]

    const out = captureLog(() => {
        dryRun(tickets, 'spec body', '')
    })

    t.ok(out.includes('Test command: (none)'),
        'in-place dry run prints (none)')
})

test('dryRunIsolated shows worktree paths and branches',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-add-auth.md',
                status:'ready-for-agent',
                blockers:[],
            }),
            makeTicket({
                num:2,
                filename:'02-add-api.md',
                status:'ready-for-agent',
                blockers:[1],
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRunIsolated({
                tickets,
                specBody:'test spec body',
                repoName:'myapp',
                conflictStrategy:'respawn',
                progressPath:'.scratch/my-feature/progress.md',
            })

            const fullOutput = output.join('\n')

            t.ok(
                fullOutput.includes('01-add-auth.md'),
                'includes ticket filename'
            )
            t.ok(
                fullOutput.includes('../myapp.01-add-auth'),
                'includes worktree path'
            )
            t.ok(
                fullOutput.includes('myapp--01-add-auth'),
                'includes branch name'
            )
            t.ok(
                fullOutput.includes(
                    'respawn (re-run agent on conflict)'
                ),
                'includes merge strategy with description'
            )
            t.ok(
                fullOutput.includes(
                    '.scratch/my-feature/progress.md'
                ),
                'includes progress file path'
            )
            t.ok(
                fullOutput.includes('test spec body'),
                'includes prompt preview'
            )
        } finally {
            console.log = originalLog
        }
    }
)

test('dryRunIsolated respects wave dependencies', t => {
    const tickets:Array<Ticket> = [
        makeTicket({
            num:1,
            filename:'01-base.md',
            status:'ready-for-agent',
            blockers:[],
        }),
        makeTicket({
            num:2,
            filename:'02-depends-on-1.md',
            status:'ready-for-agent',
            blockers:[1],
        }),
        makeTicket({
            num:3,
            filename:'03-depends-on-2.md',
            status:'ready-for-agent',
            blockers:[2],
        }),
    ]

    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }

    try {
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'stop',
            progressPath:'.scratch/feature/progress.md',
        })

        const fullOutput = output.join('\n')

        t.ok(
            fullOutput.includes('Wave 1:'),
            'has wave 1'
        )
        t.ok(
            fullOutput.includes('Wave 2:'),
            'has wave 2'
        )
        t.ok(
            fullOutput.includes('Wave 3:'),
            'has wave 3'
        )
        t.ok(
            fullOutput.includes(
                'stop (stop merging on conflict)'
            ),
            'includes stop strategy description'
        )
    } finally {
        console.log = originalLog
    }
})

test('dryRunIsolated handles multiple tickets per wave', t => {
    const tickets:Array<Ticket> = [
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
            blockers:[],
        }),
        makeTicket({
            num:3,
            filename:'03-c.md',
            status:'ready-for-agent',
            blockers:[1, 2],
        }),
    ]

    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }

    try {
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'respawn',
            progressPath:'.scratch/f/progress.md',
        })

        const fullOutput = output.join('\n')

        t.ok(
            fullOutput.includes('01-a.md, 02-b.md'),
            'wave 1 has both parallel tickets'
        )
        t.ok(
            fullOutput.includes('../myapp.01-a'),
            'wave 1 includes first worktree'
        )
        t.ok(
            fullOutput.includes('../myapp.02-b'),
            'wave 1 includes second worktree'
        )
        t.ok(
            fullOutput.includes('03-c.md'),
            'wave 2 has dependent'
        )
    } finally {
        console.log = originalLog
    }
})

test('dryRunIsolated prints 0s retry delay when omitted',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-test.md',
                status:'ready-for-agent',
                blockers:[],
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRunIsolated({
                tickets,
                specBody:'test spec body',
                repoName:'myapp',
                conflictStrategy:'respawn',
                progressPath:'.scratch/f/progress.md',
            })
        } finally {
            console.log = originalLog
        }

        const fullOutput = output.join('\n')
        t.ok(
            fullOutput.includes('Retry delay:  0s'),
            'prints 0s when retryDelay is omitted'
        )
    })

test('dryRunIsolated prints the concurrency cap', t => {
    const tickets:Array<Ticket> = [
        makeTicket({
            num:1,
            filename:'01-test.md',
            status:'ready-for-agent',
            blockers:[],
        }),
    ]

    const output:Array<string> = []
    const originalLog = console.log
    console.log = function (msg:unknown) {
        output.push(String(msg))
    }

    let withDefault = ''
    let withValue = ''
    try {
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'respawn',
            progressPath:'.scratch/f/progress.md',
            testCmd:'npm test',
        })
        withDefault = output.join('\n')
        output.length = 0
        dryRunIsolated({
            tickets,
            specBody:'test spec body',
            repoName:'myapp',
            conflictStrategy:'respawn',
            progressPath:'.scratch/f/progress.md',
            testCmd:'npm test',
            concurrency:2,
        })
        withValue = output.join('\n')
    } finally {
        console.log = originalLog
    }

    t.ok(
        withDefault.includes(
            `Concurrency:  ${DEFAULT_CONCURRENCY}`
        ),
        'prints the default when concurrency is omitted'
    )
    t.ok(
        withValue.includes('Concurrency:  2'),
        'prints the given concurrency'
    )
})

test(
    'dryRunIsolated multi-feature shows feature-prefixed ' +
    'worktree paths',
    t => {
        const tickets:Array<Ticket> = [
            makeTicket({
                num:1,
                filename:'01-login.md',
                status:'ready-for-agent',
                feature:'auth',
            }),
            makeTicket({
                num:1,
                filename:'01-stripe.md',
                status:'ready-for-agent',
                feature:'payments',
            }),
        ]

        const output:Array<string> = []
        const originalLog = console.log
        console.log = function (msg:unknown) {
            output.push(String(msg))
        }

        try {
            dryRunIsolated({
                tickets,
                specBody:'test spec body',
                repoName:'myapp',
                conflictStrategy:'respawn',
                progressPath:'.scratch/f/progress.md',
                testCmd:'npm test',
            })
        } finally {
            console.log = originalLog
        }

        const fullOutput = output.join('\n')
        t.ok(
            fullOutput.includes(
                '../myapp.auth.01-login'
            ),
            'auth worktree path has feature prefix'
        )
        t.ok(
            fullOutput.includes(
                '../myapp.payments.01-stripe'
            ),
            'payments worktree path has feature prefix'
        )
    }
)

// -- US-003: provider adapter argument construction --

test('getProviderArgs - claude provider adds stream flags',
    t => {
        const args = getProviderArgs('claude')
        t.deepEqual(
            args,
            [
                '--print', '--verbose',
                '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
            ],
            'claude gets stream-json and skip-permissions'
        )
    })

test('getProviderArgs - codex provider adds exec and ' +
    'bypass flag', t => {
    const args = getProviderArgs('codex')
    t.deepEqual(
        args,
        ['exec', '--dangerously-bypass-approvals-and-sandbox'],
        'codex gets exec and the approvals/sandbox bypass'
    )
})

test('getProviderArgs - unknown provider returns empty',
    t => {
        const args = getProviderArgs('my-custom-agent')
        t.deepEqual(
            args,
            [],
            'unknown provider gets no extra args'
        )
    })

test('getProviderArgs - full path with claude basename',
    t => {
        const args = getProviderArgs(
            '/usr/local/bin/claude'
        )
        t.deepEqual(
            args,
            [
                '--print', '--verbose',
                '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
            ],
            'full path to claude still gets stream flags'
        )
    })

test('getProviderArgs - full path with codex basename',
    t => {
        const args = getProviderArgs(
            '/opt/codex/bin/codex'
        )
        t.deepEqual(
            args,
            ['exec', '--dangerously-bypass-approvals-and-sandbox'],
            'full path to codex still gets the bypass flag'
        )
    })

// -- formatStreamLine --

test('formatStreamLine - parses assistant text', t => {
    const line = JSON.stringify({
        type:'assistant',
        message:{
            content:[{ type:'text', text:'Hello world' }],
        },
    })
    t.equal(
        formatStreamLine(line),
        'Hello world',
        'should extract text from assistant message'
    )
})

test('formatStreamLine - skips tool_use blocks', t => {
    const line = JSON.stringify({
        type:'assistant',
        message:{
            content:[{
                type:'tool_use',
                name:'Read',
                input:{},
            }],
        },
    })
    t.equal(
        formatStreamLine(line),
        null,
        'should return null for tool_use-only messages'
    )
})

test('formatStreamLine - parses result with cost', t => {
    const line = JSON.stringify({
        type:'result',
        subtype:'done',
        total_cost_usd:0.42,
    })
    t.equal(
        formatStreamLine(line),
        'done ($0.42)',
        'should format result with cost'
    )
})

test('formatStreamLine - parses result without cost', t => {
    const line = JSON.stringify({
        type:'result',
        subtype:'end_turn',
    })
    t.equal(
        formatStreamLine(line),
        'end_turn',
        'should format result without cost'
    )
})

test('formatStreamLine - returns null for thinking', t => {
    const line = JSON.stringify({
        type:'system',
        subtype:'thinking_tokens',
        input_tokens:100,
    })
    t.equal(
        formatStreamLine(line),
        null,
        'should skip thinking token events'
    )
})

test('formatStreamLine - shows api retries', t => {
    const line = JSON.stringify({
        type:'system',
        subtype:'api_retry',
        error:'rate limited',
    })
    t.equal(
        formatStreamLine(line),
        'retry: rate limited',
        'should show retry errors'
    )
})

test('formatStreamLine - returns raw non-JSON lines',
    t => {
        t.equal(
            formatStreamLine('plain text output'),
            'plain text output',
            'should pass through non-JSON lines'
        )
    })

// -- createPiStreamFormatter --

function piTextDelta (text:string):string {
    return JSON.stringify({
        assistantMessageEvent:{
            type:'text_delta',
            delta:text,
        },
    })
}

function piToolCallStart (
    index:number, name:string
):string {
    return JSON.stringify({
        assistantMessageEvent:{
            type:'toolcall_start',
            contentIndex:index,
            toolName:name,
        },
    })
}

function piToolCallDelta (
    index:number, delta:string
):string {
    return JSON.stringify({
        assistantMessageEvent:{
            type:'toolcall_delta',
            contentIndex:index,
            delta,
        },
    })
}

function piToolCallEnd (index:number):string {
    return JSON.stringify({
        assistantMessageEvent:{
            type:'toolcall_end',
            contentIndex:index,
        },
    })
}

test('piFormatter - buffers tokens until newline',
    t => {
        const fmt = createPiStreamFormatter()
        t.deepEqual(
            fmt.process(piTextDelta('hello ')),
            [],
            'no output before newline'
        )
        t.deepEqual(
            fmt.process(piTextDelta('world')),
            [],
            'still no output'
        )
        t.deepEqual(
            fmt.process(piTextDelta('\n')),
            ['hello world'],
            'emits line on newline'
        )
    })

test('piFormatter - multiple lines in one delta',
    t => {
        const fmt = createPiStreamFormatter()
        t.deepEqual(
            fmt.process(
                piTextDelta('line one\nline two\n')
            ),
            ['line one', 'line two'],
            'emits all complete lines'
        )
    })

test('piFormatter - newline mid-token keeps remainder',
    t => {
        const fmt = createPiStreamFormatter()
        t.deepEqual(
            fmt.process(
                piTextDelta('first\nsecond')
            ),
            ['first'],
            'emits first line'
        )
        t.deepEqual(
            fmt.process(piTextDelta(' part\n')),
            ['second part'],
            'second line includes buffered text'
        )
    })

test('piFormatter - flush emits remaining buffer',
    t => {
        const fmt = createPiStreamFormatter()
        fmt.process(piTextDelta('no newline'))
        t.deepEqual(
            fmt.flush(),
            ['no newline'],
            'flush emits buffered text'
        )
    })

test('piFormatter - flush with empty buffer', t => {
    const fmt = createPiStreamFormatter()
    t.deepEqual(
        fmt.flush(),
        [],
        'flush with nothing buffered returns empty'
    )
})

test('piFormatter - tool calls returned as lines',
    t => {
        const fmt = createPiStreamFormatter()
        t.deepEqual(
            fmt.process(piToolCallStart(0, 'Bash')),
            [],
        )
        t.deepEqual(
            fmt.process(piToolCallDelta(
                0, '{"command":"ls"}'
            )),
            [],
        )
        t.deepEqual(
            fmt.process(piToolCallEnd(0)),
            ['[Bash] ls'],
            'tool call end emits formatted line'
        )
    })

test('piFormatter - text buffer flushed before ' +
    'tool output', t => {
    const fmt = createPiStreamFormatter()
    fmt.process(piTextDelta('buffered text'))
    t.deepEqual(
        fmt.process(piToolCallStart(0, 'Read')),
        ['buffered text'],
        'pending text emitted before tool event'
    )
})

test('piFormatter - non-JSON lines returned as-is',
    t => {
        const fmt = createPiStreamFormatter()
        t.deepEqual(
            fmt.process('plain text'),
            ['plain text'],
            'raw lines pass through'
        )
    })

// -- stripSpecSection --

const SPEC = [
    '# Feature',
    '',
    '## Problem Statement',
    'p',
    '',
    '## User Stories',
    '1. As a user',
    '',
    '### Nested under stories',
    'still stories',
    '',
    '## Implementation Decisions',
    'keep me',
    '',
].join('\n')

test('stripSpecSection removes the section and nested ' +
    'subsections', t => {
    const out = stripSpecSection(SPEC, 'User Stories')
    t.ok(!out.includes('As a user'), 'body removed')
    t.ok(!out.includes('still stories'), 'nested removed')
    t.ok(out.includes('## Problem Statement'), 'before kept')
    t.ok(out.includes('keep me'), 'after kept')
})

test('stripSpecSection is a no-op when heading absent', t => {
    t.equal(
        stripSpecSection(SPEC, 'Out of Scope'),
        SPEC,
        'unchanged'
    )
})

test('stripSpecSection matches heading text at any level',
    t => {
        const out = stripSpecSection(
            SPEC, 'Nested under stories'
        )
        t.ok(!out.includes('still stories'), 'h3 removed')
        t.ok(
            out.includes('## Implementation Decisions'),
            'stops at the next h2'
        )
        t.ok(out.includes('As a user'), 'parent kept')
    })

test('stripSpecSection ignores # inside fenced blocks',
    t => {
        const specWithFence = [
            '# Feature',
            '',
            '## Remove me',
            'This section has code:',
            '',
            '```',
            '# not a heading',
            'console.log("test")',
            '```',
            '',
            'End of remove section',
            '',
            '## Keep',
            'This section should survive',
        ].join('\n')

        const out = stripSpecSection(
            specWithFence, 'Remove me'
        )
        t.ok(
            !out.includes('# not a heading'),
            'fenced line removed with section'
        )
        t.ok(
            !out.includes(
                'End of remove section'
            ),
            'section content removed'
        )
        t.ok(
            out.includes('## Keep'),
            'next section heading kept'
        )
        t.ok(
            out.includes(
                'This section should survive'
            ),
            'next section content kept'
        )
    })

// -- escalateEffort --

test('escalateEffort - returns high when level is undefined', t => {
    t.equal(
        escalateEffort('pi', undefined),
        'high',
        'pi: undefined -> high'
    )
    t.equal(
        escalateEffort('claude', undefined),
        'high',
        'claude: undefined -> high'
    )
    t.equal(
        escalateEffort('codex', undefined),
        'high',
        'codex: undefined -> high'
    )
})

test('escalateEffort - steps up one rung per provider', t => {
    t.equal(
        escalateEffort('pi', 'medium'),
        'high',
        'pi: medium -> high'
    )
    t.equal(
        escalateEffort('claude', 'medium'),
        'high',
        'claude: medium -> high'
    )
    t.equal(
        escalateEffort('codex', 'medium'),
        'high',
        'codex: medium -> high'
    )
})

test('escalateEffort - clamps at provider highest level', t => {
    t.equal(
        escalateEffort('pi', 'max'),
        'max',
        'pi: max stays max'
    )
    t.equal(
        escalateEffort('claude', 'max'),
        'max',
        'claude: max stays max'
    )
    t.equal(
        escalateEffort('codex', 'high'),
        'high',
        'codex: high stays high (codex max)'
    )
})

test('escalateEffort - handles level not in provider ladder', t => {
    t.equal(
        escalateEffort('claude', 'off'),
        'off',
        'claude: off not in ladder, returns off'
    )
    t.equal(
        escalateEffort('codex', 'max'),
        'max',
        'codex: max not in ladder, returns max'
    )
})

test('DEFAULT_RETRIES equals 3', t => {
    t.equal(DEFAULT_RETRIES, 3, 'DEFAULT_RETRIES is 3')
})

// -- retryDelayFor --

test('retryDelayFor - doubles from the base each attempt', t => {
    t.equal(
        retryDelayFor(30, 2), 30,
        'first retry waits the base delay'
    )
    t.equal(
        retryDelayFor(30, 3), 60,
        'second retry doubles the base delay'
    )
    t.equal(
        retryDelayFor(30, 4), 120,
        'third retry doubles again'
    )
})

test('retryDelayFor - a zero base never waits', t => {
    t.equal(
        retryDelayFor(0, 3), 0,
        'zero base stays zero at any attempt'
    )
})

test('DEFAULT_RETRY_DELAY is 30', t => {
    t.equal(DEFAULT_RETRY_DELAY, 30, 'default retry delay')
})

test('runWaves retries a failed agent with escalated effort',
    async t => {
        const base = initTempGitRepo()
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-flaky.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)

        const MOCK_FAIL_THEN_PASS = join(
            process.cwd(), 'test', 'mock-agent-fail-then-pass.js'
        )
        symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            const result = await runWaves(
                tickets, 'test spec',
                join(binDir, 'pi'), null, 10, logsDir,
                'npm test',
                undefined, undefined, undefined, 1, 0,
            )
            t.equal(result.allDone, true, 'all done after retry')
            t.equal(tickets[0].status, 'done', 'ticket done')
            t.ok(
                existsSync(join(logsDir, '01-flaky.attempt2.log')),
                'retry wrote its own log'
            )
        } finally {
            process.chdir(originalCwd)
            rmSync(binDir, { recursive:true, force:true })
        }
    })

test('runWaves waits retryDelay seconds before a retry', async t => {
    const base = initTempGitRepo()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir)
    writeFileSync(
        join(issuesDir, '01-flaky.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    const tickets = scanTickets(issuesDir)

    const MOCK_FAIL_THEN_PASS = join(
        process.cwd(), 'test', 'mock-agent-fail-then-pass.js'
    )
    symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
    chmodSync(join(binDir, 'pi'), 0o755)

    const originalCwd = process.cwd()
    process.chdir(base)
    try {
        const start = Date.now()
        const result = await runWaves(
            tickets, 'test spec',
            join(binDir, 'pi'), null, 10, logsDir,
            'npm test',
            undefined, undefined, undefined, 1, 1,
        )
        const elapsed = Date.now() - start
        t.equal(result.allDone, true, 'all done after retry')
        t.ok(
            elapsed >= 1000,
            `waited for the retry delay (elapsed ${elapsed}ms)`
        )
    } finally {
        process.chdir(originalCwd)
        rmSync(binDir, { recursive:true, force:true })
    }
})

// -- provider flag mapping (AC3) --

test(
    'spawnAgent: claude receives --effort flag (AC3.1)',
    async t => {
        const binDir = mkdtempSync(join(tmpdir(), 'test-claude-'))
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-logs-')
        )
        const ECHO_AGENT = join(
            process.cwd(), 'test', 'mock-agent-echo-args.js'
        )

        symlinkSync(ECHO_AGENT, join(binDir, 'claude'))
        chmodSync(join(binDir, 'claude'), 0o755)

        try {
            const logPath = join(logsDir, 'test.log')

            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'claude'),
                model:null,
                timeout:10,
                logPath,
                effort:'high',
            })

            const logContent = readFileSync(logPath, 'utf8')
            const lines = logContent.trim().split('\n')
            let args:string[] = []
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    if (Array.isArray(parsed)) {
                        args = parsed
                        break
                    }
                } catch {
                    // continue
                }
            }

            t.ok(
                args.length > 0,
                'found agent args in log'
            )
            const effortIdx = args.indexOf('--effort')
            t.ok(
                effortIdx >= 0,
                'args contain --effort flag'
            )
            t.equal(
                args[effortIdx + 1], 'high',
                '--effort value is "high"'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: pi receives --thinking flag (AC3.2)',
    async t => {
        const binDir = mkdtempSync(join(tmpdir(), 'test-pi-'))
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-logs-')
        )
        const ECHO_AGENT = join(
            process.cwd(), 'test', 'mock-agent-echo-args.js'
        )

        symlinkSync(ECHO_AGENT, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        try {
            const logPath = join(logsDir, 'test.log')

            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logPath,
                effort:'high',
            })

            const logContent = readFileSync(logPath, 'utf8')
            const lines = logContent.trim().split('\n')
            let args:string[] = []
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    if (Array.isArray(parsed)) {
                        args = parsed
                        break
                    }
                } catch {
                    // continue
                }
            }

            t.ok(
                args.length > 0,
                'found agent args in log'
            )
            const thinkingIdx = args.indexOf('--thinking')
            t.ok(
                thinkingIdx >= 0,
                'args contain --thinking flag'
            )
            t.equal(
                args[thinkingIdx + 1], 'high',
                '--thinking value is "high"'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: codex receives ' +
    'model_reasoning_effort via -c flag (AC3.3)',
    async t => {
        const binDir = mkdtempSync(join(tmpdir(), 'test-codex-'))
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-logs-')
        )
        const ECHO_AGENT = join(
            process.cwd(), 'test', 'mock-agent-echo-args.js'
        )

        symlinkSync(ECHO_AGENT, join(binDir, 'codex'))
        chmodSync(join(binDir, 'codex'), 0o755)

        try {
            const logPath = join(logsDir, 'test.log')

            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'codex'),
                model:null,
                timeout:10,
                logPath,
                effort:'high',
            })

            const logContent = readFileSync(logPath, 'utf8')
            const lines = logContent.trim().split('\n')
            let args:string[] = []
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    if (Array.isArray(parsed)) {
                        args = parsed
                        break
                    }
                } catch {
                    // continue
                }
            }

            t.ok(
                args.length > 0,
                'found agent args in log'
            )
            const cIdx = args.indexOf('-c')
            t.ok(
                cIdx >= 0,
                'args contain -c flag'
            )
            t.equal(
                args[cIdx + 1],
                'model_reasoning_effort=high',
                '-c value is "model_reasoning_effort=high"'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: no effort flag when omitted (AC3.4)',
    async t => {
        const binDir = mkdtempSync(join(tmpdir(), 'test-noflag-'))
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-logs-')
        )
        const ECHO_AGENT = join(
            process.cwd(), 'test', 'mock-agent-echo-args.js'
        )

        symlinkSync(ECHO_AGENT, join(binDir, 'claude'))
        chmodSync(join(binDir, 'claude'), 0o755)

        try {
            const logPath = join(logsDir, 'test.log')

            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'claude'),
                model:null,
                timeout:10,
                logPath,
                // effort intentionally omitted
            })

            const logContent = readFileSync(logPath, 'utf8')
            const lines = logContent.trim().split('\n')
            let args:string[] = []
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    if (Array.isArray(parsed)) {
                        args = parsed
                        break
                    }
                } catch {
                    // continue
                }
            }

            t.ok(
                args.length > 0,
                'found agent args in log'
            )
            const hasEffort = args.includes('--effort')
            const hasThinking = args.includes('--thinking')
            const hasE = args.includes('-e')
            t.ok(!hasEffort, 'no --effort flag')
            t.ok(!hasThinking, 'no --thinking flag')
            t.ok(!hasE, 'no -e flag')
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: validates effort against provider ladder (AC1.2)',
    async t => {
        const binDir = mkdtempSync(
            join(tmpdir(), 'test-validate-')
        )
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-logs-')
        )
        const ECHO_AGENT = join(
            process.cwd(), 'test', 'mock-agent-echo-args.js'
        )

        symlinkSync(ECHO_AGENT, join(binDir, 'claude'))
        chmodSync(join(binDir, 'claude'), 0o755)

        try {
            const warnings:string[] = []
            const logPath = join(logsDir, 'test.log')

            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'claude'),
                model:null,
                timeout:10,
                logPath,
                effort:'off' as EffortLevel, // invalid for claude
                onLine:(line:string) => {
                    if (line.includes('Warning')) {
                        warnings.push(line)
                    }
                },
            })

            t.ok(
                warnings.length > 0,
                'warning emitted for invalid effort'
            )
            t.ok(
                warnings[0].includes('off'),
                'warning mentions invalid effort level'
            )

            const logContent = readFileSync(logPath, 'utf8')
            const lines = logContent.trim().split('\n')
            let args:string[] = []
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    if (Array.isArray(parsed)) {
                        args = parsed
                        break
                    }
                } catch {
                    // continue
                }
            }

            const hasEffort = args.includes('--effort')
            t.ok(
                !hasEffort,
                '--effort not passed when invalid'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

// -- AC1.1: ALL_EFFORT_LEVELS export --

test('AC1.1 - ALL_EFFORT_LEVELS exported with correct values',
    t => {
        t.deepEqual(
            ALL_EFFORT_LEVELS,
            [
                'off', 'minimal', 'low', 'medium',
                'high', 'xhigh', 'max',
            ],
            'ALL_EFFORT_LEVELS has all expected values in order'
        )
    }
)

// -- AC2.3: Effort resets to starting level for each new ticket --

test('AC2.3 - Effort resets to starting level for each ' +
    'new ticket', async t => {
    const originalCwd = process.cwd()
    const base = initTempGitRepo()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-effort-reset-test-')
    )
    const issuesDir = join(base, '.scratch', 'feature')
    const logsDir = join(base, 'logs')
    const argsLogPath = join(base, 'args.log')
    mkdirSync(issuesDir, { recursive:true })

    // Create two independent tickets (both ready, no blockers)
    writeFileSync(
        join(issuesDir, '01-ticket1.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )
    writeFileSync(
        join(issuesDir, '02-ticket2.md'),
        makeTicketBody({ status:'ready-for-agent' })
    )

    // Commit the tickets so working tree is clean
    process.chdir(base)
    execSync(
        'git add .scratch && git commit -m "add tickets" --no-verify',
        {
            stdio:'pipe',
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        }
    )

    const tickets = scanTickets(issuesDir)
    const repoName = 'test-repo'

    const MOCK_FAIL_CAPTURE = join(
        originalCwd,
        'test', 'mock-agent-fail-capture-args.js'
    )
    mkdirSync(binDir, { recursive:true })
    const piPath = join(binDir, 'pi')
    copyFileSync(MOCK_FAIL_CAPTURE, piPath)
    chmodSync(piPath, 0o755)

    const originalEnv = process.env.ARGS_LOG_PATH
    process.env.ARGS_LOG_PATH = argsLogPath
    // Already chdir'd to base above
    // process.chdir(base)
    try {
        const { runWavesIsolated } = await import(
            '../src/orchestrator.js'
        )
        // Pass effort:'medium' so all first attempts start
        // with medium. If an attempt fails and retries, it
        // escalates to high. But ticket 02's first attempt
        // should still be 'medium', not 'high'.
        await runWavesIsolated({
            tickets,
            specBody:'test spec',
            agentCmd:join(binDir, 'pi'),
            model:null,
            timeout:10,
            logsDir,
            featureName:'feature',
            repoName,
            conflictStrategy:'respawn',
            progressPath:'.scratch/feature/progress.md',
            testCmd:'true',
            effort:'medium' as EffortLevel,
            retries:1,
            retryDelay:0,
        })

        t.equal(
            tickets[0].status, 'done',
            'ticket 1 should be done after retry'
        )
        t.equal(
            tickets[1].status, 'done',
            'ticket 2 should be done after retry'
        )

        // Read captured args
        t.ok(
            existsSync(argsLogPath),
            'args log file should exist'
        )
        const argsLogContent = readFileSync(
            argsLogPath, 'utf8'
        )
        const argsLines = argsLogContent
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))

        t.ok(
            argsLines.length >= 2,
            'should have captured args for multiple attempts'
        )

        // Separate attempts by ticket worktree in cwd
        const invocationsByTicket:Record<
            string, Array<any>
        > = {}
        for (const log of argsLines) {
            // worktree paths are like
            // .../nightralph-orch-test-Pvx0hc.01-ticket1
            const ticketMatch = log.cwd
                .match(/\.(\d+)-/)
            if (ticketMatch) {
                const num = ticketMatch[1]
                if (!invocationsByTicket[num]) {
                    invocationsByTicket[num] = []
                }
                invocationsByTicket[num].push(log)
            }
        }

        t.ok(
            invocationsByTicket['02'],
            'should have attempts for ticket 02 ' +
                '(found tickets: ' +
                Object.keys(invocationsByTicket).join(', ') +
                ')'
        )
        t.ok(
            invocationsByTicket['02'].length >= 1,
            'ticket 02 should have at least one attempt'
        )

        // Sort by timestamp to get first attempt first
        const ticket02Attempts =
            invocationsByTicket['02'].sort(
                (a:any, b:any) =>
                    a.timestamp - b.timestamp
            )

        // First attempt for ticket 02 should have
        // --thinking medium (not escalated)
        const ticket02FirstAttempt = ticket02Attempts[0]
        const thinkingIdx1 =
            ticket02FirstAttempt.args
                .indexOf('--thinking')
        const firstThinkingValue =
            thinkingIdx1 >= 0 ?
                ticket02FirstAttempt.args[thinkingIdx1 + 1] :
                null

        t.equal(
            firstThinkingValue, 'medium',
            'ticket 02 first attempt should have ' +
                '--thinking medium (starting effort, not ' +
                'escalated from ticket 01 retries)'
        )

        // Second attempt should have --thinking high
        if (ticket02Attempts.length >= 2) {
            const ticket02SecondAttempt =
                ticket02Attempts[1]
            const thinkingIdx =
                ticket02SecondAttempt.args
                    .indexOf('--thinking')
            const secondThinkingValue =
                thinkingIdx >= 0 ?
                    ticket02SecondAttempt.args[
                        thinkingIdx + 1
                    ] :
                    null
            t.equal(
                secondThinkingValue, 'high',
                'ticket 02 second attempt should have ' +
                    '--thinking high (escalated on retry)'
            )
        }
    } finally {
        process.chdir(originalCwd)
        if (originalEnv === undefined) {
            delete process.env.ARGS_LOG_PATH
        } else {
            process.env.ARGS_LOG_PATH = originalEnv
        }
        rmSync(binDir, { recursive:true, force:true })
    }
})

// -- max-turns per-provider mapping --

function parseArgsFromLog (logPath:string):string[] {
    const content = readFileSync(logPath, 'utf8')
    for (const line of content.trim().split('\n')) {
        try {
            const parsed = JSON.parse(line)
            if (Array.isArray(parsed)) return parsed
        } catch {
            // continue
        }
    }
    return []
}

test(
    'spawnAgent: claude receives --max-turns',
    async t => {
        const binDir = mkdtempSync(
            join(tmpdir(), 'test-mt-claude-')
        )
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-mt-logs-')
        )
        const ECHO = join(
            process.cwd(),
            'test', 'mock-agent-echo-args.js'
        )
        symlinkSync(ECHO, join(binDir, 'claude'))
        chmodSync(join(binDir, 'claude'), 0o755)

        try {
            const logPath = join(logsDir, 'test.log')
            await spawnAgent({
                prompt:'test',
                agentCmd:join(binDir, 'claude'),
                model:null,
                timeout:10,
                logPath,
                maxTurns:25,
            })

            const args = parseArgsFromLog(logPath)
            const idx = args.indexOf('--max-turns')
            t.ok(
                idx >= 0,
                'claude args contain --max-turns'
            )
            t.equal(
                args[idx + 1], '25',
                '--max-turns value is "25"'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: codex does not receive --max-turns',
    async t => {
        const binDir = mkdtempSync(
            join(tmpdir(), 'test-mt-codex-')
        )
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-mt-logs-')
        )
        const ECHO = join(
            process.cwd(),
            'test', 'mock-agent-echo-args.js'
        )
        symlinkSync(ECHO, join(binDir, 'codex'))
        chmodSync(join(binDir, 'codex'), 0o755)

        const warnings:string[] = []
        try {
            const logPath = join(logsDir, 'test.log')
            await spawnAgent({
                prompt:'test',
                agentCmd:join(binDir, 'codex'),
                model:null,
                timeout:10,
                logPath,
                maxTurns:25,
                onLine:(line) => {
                    if (line.includes('Warning')) {
                        warnings.push(line)
                    }
                },
            })

            const args = parseArgsFromLog(logPath)
            t.ok(
                !args.includes('--max-turns'),
                'codex args do not contain --max-turns'
            )
            t.ok(
                warnings.length > 0,
                'warning emitted for unsupported ' +
                    '--max-turns'
            )
            t.ok(
                warnings[0].includes('codex'),
                'warning names the provider'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

test(
    'spawnAgent: pi does not receive --max-turns',
    async t => {
        const binDir = mkdtempSync(
            join(tmpdir(), 'test-mt-pi-')
        )
        const logsDir = mkdtempSync(
            join(tmpdir(), 'test-mt-logs-')
        )
        const ECHO = join(
            process.cwd(),
            'test', 'mock-agent-echo-args.js'
        )
        symlinkSync(ECHO, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        const warnings:string[] = []
        try {
            const logPath = join(logsDir, 'test.log')
            await spawnAgent({
                prompt:'test',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logPath,
                maxTurns:25,
                onLine:(line) => {
                    if (line.includes('Warning')) {
                        warnings.push(line)
                    }
                },
            })

            const args = parseArgsFromLog(logPath)
            t.ok(
                !args.includes('--max-turns'),
                'pi args do not contain --max-turns'
            )
            t.ok(
                warnings.length > 0,
                'warning emitted for unsupported ' +
                    '--max-turns'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logsDir, { recursive:true, force:true })
        }
    }
)

// -- concurrency --

const MOCK_CONCURRENT = join(
    process.cwd(), 'test', 'mock-agent-concurrent.js'
)

function readPeak (dir:string):number {
    const lines = readFileSync(join(dir, 'peaks'), 'utf8')
        .trim().split('\n')
    return Math.max(...lines.map(Number))
}

test('runWaves never runs more agents than concurrency ' +
    'allows', async t => {
    const base = initTempGitRepo()
    const issuesDir = join(base, 'issues')
    const logsDir = join(base, 'logs')
    const markerDir = join(base, 'markers')
    mkdirSync(issuesDir)
    mkdirSync(markerDir)

    for (let i = 1; i <= 5; i++) {
        writeFileSync(
            join(issuesDir, `0${i}-t${i}.md`),
            makeTicketBody({ status:'ready-for-agent' })
        )
    }

    const tickets = scanTickets(issuesDir)

    const originalCwd = process.cwd()
    const originalEnv = process.env.MOCK_CONCURRENCY_DIR
    process.chdir(base)
    process.env.MOCK_CONCURRENCY_DIR = markerDir
    try {
        await runWaves(
            tickets, 'test spec',
            MOCK_CONCURRENT, null, 10, logsDir,
            'npm test',
            undefined, undefined, undefined,
            0, 0,
            2,
        )
    } finally {
        process.chdir(originalCwd)
        if (originalEnv === undefined) {
            delete process.env.MOCK_CONCURRENCY_DIR
        } else {
            process.env.MOCK_CONCURRENCY_DIR = originalEnv
        }
    }

    for (const ticket of tickets) {
        t.equal(ticket.status, 'done',
            `${ticket.filename} completed`)
    }
    const peak = readPeak(markerDir)
    t.ok(
        peak <= 2,
        `peak concurrent agents ${peak} is at most 2`
    )
    t.ok(peak >= 2, 'the cap was actually used, not 1')
})

test('renderFinishSummary is one line with no human tickets', t => {
    const tickets = [
        makeTicket({ num:1, filename:'01-a.md', status:'done' }),
        makeTicket({
            num:2, filename:'02-b.md', status:'ready-for-agent',
        }),
    ]
    const out = renderFinishSummary(
        tickets, 1, new Set([ticketKey('', 2)])
    )
    t.equal(out.split('\n').length, 1, 'single line')
    t.ok(out.includes('1 completed'), 'counts completed')
    t.ok(out.includes('1 remaining'), 'counts remaining')
    t.ok(out.includes('1 failed'), 'counts failed')
    t.ok(!out.includes(HUMAN_STATUS), 'no human section')
})

test('renderFinishSummary AC2.2: names a blocker outside the run',
    t => {
        const ref:BlockerRef = {
            feature:'b', num:1, where:'pending', status:'ready-for-agent',
        }
        const ticket = makeTicket({
            num:2, filename:'02-x.md', feature:'a', blockers:[ref],
        })
        const out = renderFinishSummary([ticket], 0, new Set())
        t.ok(out.includes(ticketLabel(ticket)), 'names the ticket')
        t.ok(out.includes(blockerLabel(ref)), 'names the blocker')
    })

test('renderFinishSummary AC2.4: lists a blocker that matches no ticket',
    t => {
        const ref:BlockerRef = { feature:'a', num:9, where:'missing' }
        const ticket = makeTicket({
            num:3, filename:'03-x.md', feature:'a', blockers:[ref],
        })
        const out = renderFinishSummary([ticket], 0, new Set())
        t.ok(out.includes(ticketLabel(ticket)), 'names the ticket')
        t.ok(out.includes(blockerLabel(ref)), 'names the blocker')
    })

test('renderFinishSummary leaves failed tickets out of the blocker ' +
    'paragraph', t => {
    const ref:BlockerRef = {
        feature:'b', num:1, where:'pending', status:'ready-for-agent',
    }
    const ticket = makeTicket({
        num:2, filename:'02-x.md', feature:'a', blockers:[ref],
    })
    const out = renderFinishSummary(
        [ticket], 0, new Set([ticketKey('a', 2)])
    )
    t.ok(!out.includes(blockerLabel(ref)), 'failed ticket not listed')
    t.equal(out.split('\n').length, 1, 'only the counts line')
})

test('renderFinishSummary AC2.9: repeats typo warnings', t => {
    const ticket = makeTicket({
        num:4, filename:'04-x.md', feature:'a', status:'done',
    })
    const out = renderFinishSummary([ticket], 1, new Set(), [
        { ticket:'a/04', kind:'typo', text:'nwsletter-audit' },
    ])
    t.ok(out.includes('nwsletter-audit'), 'names the word')
    t.ok(out.includes('a/04'), 'names the ticket')
})

test('renderFinishSummary names every ready-for-human ticket', t => {
    const tickets = [
        makeTicket({ num:1, filename:'01-a.md', status:'done' }),
        makeTicket({
            num:7, filename:'07-secret.md', status:HUMAN_STATUS,
        }),
        makeTicket({
            num:8, filename:'08-staging.md', status:HUMAN_STATUS,
        }),
    ]
    const out = renderFinishSummary(tickets, 1, new Set())
    t.ok(out.includes('2 need a human'), 'counts human tickets')
    t.ok(out.includes(HUMAN_STATUS), 'names the status')
    t.ok(out.includes('07-secret.md'), 'lists first ticket')
    t.ok(out.includes('08-staging.md'), 'lists second ticket')
    t.ok(!out.includes('01-a.md'), 'does not list done ticket')
    t.ok(
        !/\d+ remaining/.test(out),
        'no ready-for-agent tickets remain'
    )
})

test(
    'renderFinishSummary lists agent tickets blocked by human ones',
    t => {
        const tickets = [
            makeTicket({
                num:7, filename:'07-secret.md', status:HUMAN_STATUS,
            }),
            makeTicket({
                num:9,
                filename:'09-after.md',
                status:'ready-for-agent',
                blockers:[7],
            }),
            makeTicket({
                num:10,
                filename:'10-free.md',
                status:'ready-for-agent',
            }),
        ]
        const out = renderFinishSummary(tickets, 0, new Set())
        t.ok(out.includes('2 remaining'), 'counts remaining')
        t.ok(out.includes('07-secret.md'), 'lists human ticket')
        const after = out.indexOf('09-after.md')
        t.ok(after > out.indexOf('07-secret.md'),
            'blocked ticket listed after the human one')
        t.ok(!out.includes('10-free.md'),
            'unblocked ticket is not listed as blocked')
        t.ok(out.includes('run nightralph again'),
            'tells the user to rerun')
    }
)

test(
    'renderFinishSummary produces per-feature breakdown ' +
    'when >1 feature',
    t => {
        const tickets = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:1,
                filename:'01-c.md',
                status:'done',
                feature:'payments',
            }),
            makeTicket({
                num:2,
                filename:'02-d.md',
                status:'ready-for-agent',
                feature:'payments',
            }),
        ]
        const out = renderFinishSummary(
            tickets, 3, new Set()
        )
        t.ok(
            out.includes('auth'),
            'mentions auth feature'
        )
        t.ok(
            out.includes('payments'),
            'mentions payments feature'
        )
        t.ok(
            out.includes('3 completed'),
            'total line counts all completed'
        )
    }
)

test(
    'renderFinishSummary single-line when all tickets ' +
    'share one feature',
    t => {
        const tickets = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:2,
                filename:'02-b.md',
                status:'done',
                feature:'auth',
            }),
        ]
        const out = renderFinishSummary(
            tickets, 2, new Set()
        )
        const lines = out.split('\n')
        t.equal(lines.length, 1, 'single line')
        t.ok(
            !out.includes('auth'),
            'does not name the feature'
        )
    }
)

test(
    'renderFinishSummary compound keys disambiguate ' +
    'same-numbered tickets across features',
    t => {
        const tickets = [
            makeTicket({
                num:1,
                filename:'01-a.md',
                status:'done',
                feature:'auth',
            }),
            makeTicket({
                num:1,
                filename:'01-b.md',
                status:'ready-for-agent',
                feature:'payments',
            }),
            makeTicket({
                num:2,
                filename:'02-c.md',
                status:'ready-for-agent',
                feature:'auth',
            }),
        ]
        const failedKeys = new Set([
            ticketKey('auth', 2),
        ])
        const out = renderFinishSummary(
            tickets, 1, failedKeys
        )
        t.ok(
            out.includes('1 failed'),
            'counts exactly 1 failed'
        )
        t.ok(
            out.includes('1 completed'),
            'counts 1 completed'
        )
        t.ok(
            out.includes('1 remaining'),
            'counts 1 remaining'
        )
        t.ok(
            out.includes('auth') && out.includes('payments'),
            'per-feature breakdown present'
        )
    }
)

test('runWaves with nothing runnable reports no blocked tickets',
    async t => {
        // Ticket 3 is ready-for-agent but blocked by the human
        // ticket, so nothing is ready and no wave starts. It is
        // still a blocked ticket, so any report of blocked tickets
        // outside a wave would call setBlocked for it.
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-done.md'),
            makeTicketBody({ status:'done' })
        )
        writeFileSync(
            join(issuesDir, '02-human.md'),
            makeTicketBody({ status:HUMAN_STATUS })
        )
        writeFileSync(
            join(issuesDir, '03-waiting.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[2],
            })
        )
        const tickets = scanTickets(issuesDir)
        const logs:string[] = []
        const display = {
            startRun () {
                t.fail('no startRun should be called')
            },
            startWave () {
                t.fail('no wave should start')
            },
            setTicketStatus () {},
            setBlocked () {
                t.fail('no setBlocked should be called')
            },
            log (m:string) { logs.push(m) },
            cleanup () {},
        }

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            const result = await runWaves(
                tickets, 'test spec',
                MOCK_PASS, null, 10, logsDir,
                'npm test', display,
            )
            t.equal(result.allDone, false,
                'ticket 3 is still waiting, so not allDone')
        } finally {
            process.chdir(originalCwd)
            rmSync(base, { recursive:true, force:true })
        }
        const all = logs.join('\n')
        t.ok(all.includes('02-human.md'),
            'summary names the human ticket')
    }
)

test('runWaves with only human tickets logs them and is allDone',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-done.md'),
            makeTicketBody({ status:'done' })
        )
        writeFileSync(
            join(issuesDir, '02-human.md'),
            makeTicketBody({ status:HUMAN_STATUS })
        )
        const tickets = scanTickets(issuesDir)
        const logs:string[] = []
        const display = {
            startRun () {
                t.fail('no startRun should be called')
            },
            startWave () {
                t.fail('no wave should start')
            },
            setTicketStatus () {},
            setBlocked () {
                t.fail('no setBlocked should be called')
            },
            log (m:string) { logs.push(m) },
            cleanup () {},
        }

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            const result = await runWaves(
                tickets, 'test spec',
                MOCK_PASS, null, 10, logsDir,
                'npm test', display,
            )
            t.equal(result.allDone, true,
                'nothing left for an agent, so allDone')
        } finally {
            process.chdir(originalCwd)
        }
        const all = logs.join('\n')
        t.ok(all.includes('02-human.md'),
            'summary names the human ticket')
        t.ok(all.includes(HUMAN_STATUS),
            'summary names the status')
    }
)

// -- historyFor --

// Appends a done entry whose notes are `marker` to a learnings log.
function appendDone (
    path:string,
    feature:string,
    num:number,
    marker:string
):void {
    appendEntry(path, renderEntry({
        key:ticketKey(feature, num),
        label:`${feature}/${String(num).padStart(2, '0')}`,
        attempt:1,
        now:new Date('2026-10-09T00:00:00Z'),
        outcome:'done',
        run:{
            exitCode:0, completedItems:[], timedOut:false, notes:marker,
        },
    }))
}

// A ticket at <scratch>/<feature>/issues/02-x.md with these refs.
function historyTicket (
    scratch:string,
    feature:string,
    blockers:BlockerRef[]
):Ticket {
    const issues = join(scratch, feature, 'issues')
    mkdirSync(issues, { recursive:true })
    const filepath = join(issues, '02-x.md')
    writeFileSync(filepath, '**Status:** ready-for-agent\n')
    return makeTicket({
        num:2, filename:'02-x.md', feature, filepath, blockers,
    })
}

test('historyFor AC2.7: reads a cross-feature blocker\'s done entry',
    t => {
        const scratch = join(tmp(), '.scratch')
        mkdirSync(join(scratch, 'b'), { recursive:true })
        appendDone(
            join(scratch, 'b', 'learnings.md'), 'b', 1,
            'marker-b-01-notes'
        )
        const ticket = historyTicket(scratch, 'a', [
            { feature:'b', num:1, where:'done', status:'done' },
        ])
        const out = historyFor(join(scratch, 'a', 'learnings.md'), ticket)
        t.ok(out.includes('marker-b-01-notes'), 'b/01 notes are included')
    })

test('historyFor still reads a same-feature blocker', t => {
    const scratch = join(tmp(), '.scratch')
    const ticket = historyTicket(scratch, 'a', [
        { feature:'a', num:1, where:'run' },
    ])
    const learnings = join(scratch, 'a', 'learnings.md')
    appendDone(learnings, 'a', 1, 'marker-a-01-notes')
    t.ok(
        historyFor(learnings, ticket).includes('marker-a-01-notes'),
        'a/01 notes are included'
    )
})

test('historyFor: a feature with no learnings.md is no error', t => {
    const scratch = join(tmp(), '.scratch')
    const ticket = historyTicket(scratch, 'a', [
        { feature:'b', num:1, where:'done', status:'done' },
    ])
    t.equal(
        historyFor(join(scratch, 'a', 'learnings.md'), ticket),
        '',
        'no history'
    )
})

test('historyFor: a nested feature reads blockers beside .scratch',
    t => {
        const scratch = join(tmp(), '.scratch')
        mkdirSync(join(scratch, 'b'), { recursive:true })
        appendDone(
            join(scratch, 'b', 'learnings.md'), 'b', 1,
            'marker-nested-notes'
        )
        const ticket = historyTicket(scratch, 'x/y', [
            { feature:'b', num:1, where:'done', status:'done' },
        ])
        const out = historyFor(
            join(scratch, 'x', 'y', 'learnings.md'), ticket
        )
        t.ok(out.includes('marker-nested-notes'), 'b/01 notes are included')
    })

// -- nothingReady / renderNothingReady --

const OUTSIDE:BlockerRef = {
    feature:'b', num:1, where:'pending', status:'ready-for-agent',
}

test('nothingReady stops only when a ready-for-agent ticket waits',
    t => {
        t.equal(nothingReady([]), false, 'no tickets')
        t.equal(nothingReady([
            makeTicket({ num:1, filename:'01-a.md', status:'done' }),
        ]), false, 'all done')
        t.equal(nothingReady([
            makeTicket({
                num:1, filename:'01-a.md', status:HUMAN_STATUS,
            }),
        ]), false, 'only human work')
        const blocked = makeTicket({
            num:1, filename:'01-a.md', feature:'a', blockers:[OUTSIDE],
        })
        t.equal(nothingReady([blocked]), true, 'one blocked ticket')
        const free = makeTicket({
            num:2, filename:'02-b.md', feature:'a',
        })
        t.equal(
            nothingReady([blocked, free]), false,
            'one ticket can start'
        )
    })

test('renderNothingReady names a blocker outside the run', t => {
    const out = renderNothingReady([
        makeTicket({
            num:1, filename:'01-a.md', feature:'a', blockers:[OUTSIDE],
        }),
    ], [])
    t.ok(out.includes(blockerLabel(OUTSIDE)), 'names the blocker')
})

test('renderNothingReady reports a cycle', t => {
    const tickets = [
        makeTicket({
            num:1, filename:'01-a.md', feature:'a', blockers:[2],
        }),
        makeTicket({
            num:2, filename:'02-b.md', feature:'a', blockers:[1],
        }),
    ]
    const out = renderNothingReady(tickets, [])
    t.ok(out.includes('Deadlocked tickets'), 'reports the cycle')
    t.ok(out.includes(ticketLabel(tickets[0])), 'names a/01')
    t.ok(out.includes(ticketLabel(tickets[1])), 'names a/02')
})

test('renderNothingReady reports human work, not a cycle', t => {
    const out = renderNothingReady([
        makeTicket({
            num:1,
            filename:'01-human.md',
            feature:'a',
            status:HUMAN_STATUS,
        }),
        makeTicket({
            num:2, filename:'02-waits.md', feature:'a', blockers:[1],
        }),
    ], [])
    t.ok(out.includes('01-human.md'), 'names the human ticket')
    t.ok(!out.includes('Deadlocked tickets'), 'no cycle line')
})

test('renderNothingReady names a blocker in another status', t => {
    const triage = makeTicket({
        num:1,
        filename:'01-triage.md',
        feature:'a',
        status:'needs-triage',
    })
    const out = renderNothingReady([
        triage,
        makeTicket({
            num:2, filename:'02-waits.md', feature:'a', blockers:[1],
        }),
    ], [])
    t.ok(out.includes(ticketLabel(triage)), 'names the blocker')
    t.ok(out.includes('needs-triage'), 'names its status')
})
