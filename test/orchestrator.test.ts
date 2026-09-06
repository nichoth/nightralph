import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, readdirSync,
    rmSync, symlinkSync, chmodSync, copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
    parseTicketFilename,
    parseStatus,
    parseBlockers,
    scanTickets,
    findReadyTickets,
    markDone,
    checkItems,
    COMPLETED_RE,
    TOOL_USE_RE,
    renderPrompt,
    renderMergePrompt,
    stripSpecSection,
    runWaves,
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
    type Ticket,
    type EffortLevel,
} from '../src/orchestrator.js'

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
            const fullOutput = output.join('\n')
            t.ok(
                !fullOutput.includes(
                    'Wave 1: 02-b.md'
                ),
                'ticket 2 does not appear as ready ' +
                    'while its blocker is only claimed'
            )
        } finally {
            console.log = originalLog
        }
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
            const fullOutput = output.join('\n')
            t.ok(
                fullOutput.includes('Deadlocked tickets:') &&
                    fullOutput.includes('02-b.md'),
                'ticket 2 is reported as deadlocked'
            )
        } finally {
            console.log = originalLog
        }
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
    }

    checkItems(ticket, [itemText])

    const onDisk = readFileSync(filepath, 'utf8')
    t.ok(
        onDisk.includes(`- [x] ${itemText}`),
        'item with special chars checked'
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

test('renderPrompt instructs agent to report [x] items',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const prompt = renderPrompt(
            'spec body here', ticket
        )
        t.ok(
            prompt.includes('[x]'),
            'prompt mentions [x] format'
        )
    }
)

test('renderPrompt includes the test command when given',
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
        t.ok(
            prompt.includes('Testing Decisions'),
            'points the agent at the spec seams'
        )
    })

test('renderPrompt omits test rules when no test command',
    t => {
        const ticket = makeTicket({
            num:1,
            filename:'01-thing.md',
        })
        const withNull = renderPrompt(
            'spec body here', ticket, { testCmd:null }
        )
        const withNothing = renderPrompt(
            'spec body here', ticket
        )
        t.equal(withNull, withNothing,
            'null and omitted produce the same prompt')
        t.ok(
            !withNull.includes('Testing Decisions'),
            'no test rules without a command'
        )
    })

test('renderPrompt contains git push rule', t => {
    const ticket = makeTicket({
        num:1,
        filename:'01-thing.md',
    })
    const prompt = renderPrompt('spec body', ticket)
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
        const prompt = renderPrompt('spec body', ticket)
        t.ok(
            prompt.toLowerCase().includes(
                'current directory'
            ),
            'prompt mentions current directory'
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
                fullOutput.includes('myapp/01-add-auth'),
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
        escalateEffort('codex', 'xhigh'),
        'xhigh',
        'codex: xhigh stays xhigh (codex max)'
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
    'spawnAgent: codex receives -e flag (AC3.3)',
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
            const eIdx = args.indexOf('-e')
            t.ok(
                eIdx >= 0,
                'args contain -e flag'
            )
            t.equal(
                args[eIdx + 1], 'high',
                '-e value is "high"'
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
            testCmd:null,
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
