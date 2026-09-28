import { test } from '@substrate-system/tapzero'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    mkdirSync, writeFileSync, mkdtempSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
    StatusDisplay,
    PlainDisplay,
    createDisplay,
    color,
    renderDot,
    type DisplayTicket,
    type Display,
} from '../src/display.js'
import {
    spawnAgent, runWaves, runWavesIsolated, scanTickets,
} from '../src/orchestrator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// -- helpers --

class MockStream {
    private buffer:string = ''
    rows:number = 24
    columns:number = 80
    isTTY:boolean = true
    private listeners:Map<string, Set<() => void>> = new Map()

    write (data:string):void {
        this.buffer += data
    }

    getOutput ():string {
        return this.buffer
    }

    clear ():void {
        this.buffer = ''
    }

    on (event:string, listener:() => void):void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(listener)
    }

    removeListener (event:string, listener:() => void):void {
        const eventListeners = this.listeners.get(event)
        if (eventListeners) {
            eventListeners.delete(listener)
        }
    }

    emit (event:string):void {
        const eventListeners = this.listeners.get(event)
        if (eventListeners) {
            eventListeners.forEach(listener => listener())
        }
    }

    hasListener (event:string):boolean {
        const eventListeners = this.listeners.get(event)
        return eventListeners !== undefined && eventListeners.size > 0
    }
}

function createMockStream ():MockStream&NodeJS.WriteStream {
    return new MockStream() as MockStream&NodeJS.WriteStream
}

function createTestTickets ():Array<DisplayTicket> {
    return [
        { num:1, filename:'task1.md', status:'pending' },
        { num:2, filename:'task2.md', status:'pending' },
        { num:3, filename:'task3.md', status:'pending' },
    ]
}

function stripAnsi (output:string):string {
    const esc = String.fromCharCode(27)
    const ansiRe = new RegExp(esc + '\\[[0-9;?]*[A-Za-z]', 'g')
    return output.replace(ansiRe, '')
}

function lastFrame (output:string):string {
    const plain = stripAnsi(output)
    const matches = [...plain.matchAll(/Wave \d+\/\d+/g)]
    if (matches.length === 0) return ''
    const last = matches[matches.length - 1]
    return plain.substring(last.index ?? 0)
}

function rawLastFrame (output:string):string {
    const plain = stripAnsi(output)
    const matches = [...plain.matchAll(/Wave \d+\/\d+/g)]
    if (matches.length === 0) return ''
    const last = matches[matches.length - 1]
    return last ? output.substring(
        output.lastIndexOf(last[0]),
    ) : ''
}

function headerNumbers (frame:string):{
    waveNum:number
    totalWaves:number
    done:number
    total:number
    pct:number
}|null {
    const plain = stripAnsi(frame)
    const match = plain.match(
        /Wave (\d+)\/(\d+)\D+(\d+)\/(\d+)\D+(\d+)%/,
    )
    if (!match) return null
    return {
        waveNum:parseInt(match[1], 10),
        totalWaves:parseInt(match[2], 10),
        done:parseInt(match[3], 10),
        total:parseInt(match[4], 10),
        pct:parseInt(match[5], 10),
    }
}

// -- Tests for AC4.1 and AC4.2: Wave transitions --

test('startWave initializes display with tickets in pending status', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 2, tickets)

    const output = stream.getOutput()
    t.ok(
        output.includes('Wave 1/2'),
        'should display wave number and total'
    )
    t.ok(
        output.includes('task1.md'),
        'should display first ticket filename'
    )
    t.ok(
        output.includes('task2.md'),
        'should display second ticket filename'
    )
    t.ok(
        output.includes('task3.md'),
        'should display third ticket filename'
    )
})

test('startWave does not reset ticket list on second call', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const allTickets = [
        { num:1, filename:'wave1-task.md' },
        { num:2, filename:'wave2-task.md' },
    ]

    display.startRun(allTickets)

    display.startWave(1, 2, [allTickets[0]])
    display.startWave(2, 2, [allTickets[1]])

    const frame = lastFrame(stream.getOutput())

    t.ok(
        frame.includes('wave1-task.md'),
        'last frame should display wave1 ticket'
    )
    t.ok(
        frame.includes('wave2-task.md'),
        'last frame should display wave2 ticket'
    )
})

test('startWave updates wave number in status line', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()

    display.startWave(1, 3, tickets)
    const output1 = stream.getOutput()

    stream.clear()
    display.startWave(2, 3, tickets)
    const output2 = stream.getOutput()

    t.ok(
        output1.includes('Wave 1/3'),
        'first wave should show Wave 1/3'
    )
    t.ok(
        output2.includes('Wave 2/3'),
        'second wave should show Wave 2/3'
    )
})

// -- Tests for AC1: Status list rendering --

test('renders dot and filename for each ticket', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    t.ok(output.includes('task1.md'), 'should include task1 filename')
    t.ok(output.includes('task2.md'), 'should include task2 filename')
    t.ok(output.includes('task3.md'), 'should include task3 filename')
})

test('pending ticket shows empty/dim dot (AC1.2)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = [
        { num:1, filename:'pending.md' },
    ]
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    // The empty dot is ○, possibly with dim ANSI codes
    t.ok(
        output.includes('○') || output.includes('\x1b[2m'),
        'pending ticket should have dim or empty dot'
    )
    t.ok(
        output.includes('pending.md'),
        'pending ticket should show filename'
    )
})

test('in-progress ticket shows yellow filled dot (AC1.3)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = [
        { num:1, filename:'work.md' },
    ]
    display.startWave(1, 1, tickets)
    stream.clear()
    display.setTicketStatus(1, 'in-progress')

    const output = stream.getOutput()
    // Yellow ANSI code is \x1b[33m
    t.ok(
        output.includes('\x1b[33m') || output.includes('●'),
        'in-progress ticket should have yellow color or filled dot'
    )
    t.ok(
        output.includes('work.md'),
        'in-progress ticket should show filename'
    )
})

test('done ticket shows green filled dot (AC1.4)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = [
        { num:1, filename:'done.md' },
    ]
    display.startWave(1, 1, tickets)
    stream.clear()
    display.setTicketStatus(1, 'done')

    const output = stream.getOutput()
    // Green ANSI code is \x1b[32m
    t.ok(
        output.includes('\x1b[32m') || output.includes('●'),
        'done ticket should have green color or filled dot'
    )
    t.ok(
        output.includes('done.md'),
        'done ticket should show filename'
    )
})

test('failed ticket shows red filled dot (AC1.5)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = [
        { num:1, filename:'failed.md' },
    ]
    display.startWave(1, 1, tickets)
    stream.clear()
    display.setTicketStatus(1, 'failed')

    const output = stream.getOutput()
    // Red ANSI code is \x1b[31m
    t.ok(
        output.includes('\x1b[31m') || output.includes('●'),
        'failed ticket should have red color or filled dot'
    )
    t.ok(
        output.includes('failed.md'),
        'failed ticket should show filename'
    )
})

// -- Tests for AC2: Status line --

test('status line shows Wave N/M - done/total - pct% (AC2.1)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 2, tickets)

    const output = stream.getOutput()
    // Should match pattern like "Wave 1/2 - 0/3 done - 0%"
    t.ok(
        /Wave \d+\/\d+/.test(output),
        'header should have wave N/M'
    )
    t.ok(
        /\d+\/\d+ done/.test(output),
        'header should have done/total'
    )
    t.ok(
        /\d+%/.test(output),
        'header should have percent'
    )
})

test('percentage reflects completed tickets divided by total (AC2.2)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // Initially 0%
    let output = stream.getOutput()
    t.ok(
        output.includes('0%'),
        'with 0 done tickets, should show 0%'
    )

    // Mark one done
    stream.clear()
    display.setTicketStatus(1, 'done')
    output = stream.getOutput()
    t.ok(
        output.includes('33%') || output.includes('33 %'),
        'with 1 of 3 done, should show ~33%'
    )

    // Mark another done
    stream.clear()
    display.setTicketStatus(2, 'done')
    output = stream.getOutput()
    t.ok(
        output.includes('67%') || output.includes('66%') || output.includes('66 %'),
        'with 2 of 3 done, should show ~67% or 66%'
    )

    // Mark last done
    stream.clear()
    display.setTicketStatus(3, 'done')
    output = stream.getOutput()
    t.ok(
        output.includes('100%'),
        'with all 3 done, should show 100%'
    )
})

test('percentage only counts done tickets, not failed', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // Mark one done, one failed
    display.setTicketStatus(1, 'done')
    display.setTicketStatus(2, 'failed')
    stream.clear()
    display.setTicketStatus(3, 'done')
    const output = stream.getOutput()

    // 2 done + 1 failed out of 3, should be 67% or 66%
    t.ok(
        output.includes('67%') || output.includes('66%'),
        'failed tickets should not count as completed'
    )
})

test('percentage comes from fixed list, not progress arg', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    // startRun with 3 tickets (the fixed list)
    display.startRun([
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
    ])

    // startWave with progress arg (which is ignored)
    display.startWave(1, 2, [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
    ], { completed:10, total:100 })

    let output = stream.getOutput()
    t.ok(
        output.includes('0/3 done'),
        'should show 0/3 from fixed list'
    )
    t.ok(
        output.includes('0%'),
        'should show 0%, not 10% from progress arg'
    )

    stream.clear()
    display.setTicketStatus(1, 'done')
    output = stream.getOutput()
    t.ok(
        output.includes('1/3 done'),
        'one more done should show 1/3'
    )
    t.ok(
        output.includes('33%'),
        'one more done should show 33%'
    )

    // next wave -- fixed list stays the same
    stream.clear()
    display.startWave(2, 2, [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
    ], {
        completed:100,
        total:1000,
    })
    output = stream.getOutput()
    t.ok(
        output.includes('1/3 done'),
        'should still show 1/3 from fixed list'
    )
    t.ok(
        output.includes('33%'),
        'should show 33%, not 10% from new progress arg'
    )
})

test('rendered lines never exceed terminal width', t => {
    const stream = createMockStream()
    stream.columns = 40
    const display = new StatusDisplay({
        stream,
    })

    const tickets:Array<DisplayTicket> = [
        {
            num:1,
            filename:'a-very-long-ticket-filename-that-wraps.md',
            status:'pending',
        },
    ]
    display.startWave(1, 1, tickets)
    display.log('[bash] ' + 'x'.repeat(200))
    display.log(color.yellow('y'.repeat(100)))

    const esc = String.fromCharCode(27)
    const ansiRe = new RegExp(esc + '\\[[0-9;?]*[A-Za-z]', 'g')
    const plain = stream.getOutput().replace(ansiRe, '')
    const maxWidth = stream.columns - 1
    const tooLong = plain.split('\n').filter(l => l.length > maxWidth)
    t.equal(
        tooLong.length, 0,
        'no rendered line should be wider than columns-1: ' +
        JSON.stringify(tooLong)
    )
})

test('long log messages wrap instead of being cut off', t => {
    const stream = createMockStream()
    stream.columns = 40
    const display = new StatusDisplay({
        stream,
    })

    display.startWave(1, 1, createTestTickets())
    stream.clear()
    display.log('x'.repeat(100))

    const esc = String.fromCharCode(27)
    const ansiRe = new RegExp(esc + '\\[[0-9;?]*[A-Za-z]', 'g')
    const plain = stream.getOutput().replace(ansiRe, '')
    const xCount = (plain.match(/x/g) ?? []).length
    t.equal(xCount, 100, 'every character of the message is rendered')
    const tooLong = plain.split('\n').filter(l => l.length > 40)
    t.equal(tooLong.length, 0, 'wrapped rows stay within columns')
})

test('wrapped log rows still fit the terminal height', t => {
    const stream = createMockStream()
    stream.columns = 40
    // rows=8, 3 tickets -> 2 log rows
    stream.rows = 8
    const display = new StatusDisplay({
        stream,
    })

    display.startWave(1, 1, createTestTickets())
    stream.clear()
    display.log('a'.repeat(100) + 'END')

    const esc = String.fromCharCode(27)
    const ansiRe = new RegExp(esc + '\\[[0-9;?]*[A-Za-z]', 'g')
    const plain = stream.getOutput().replace(ansiRe, '')
    const nlCount = (plain.match(/\n/g) ?? []).length
    t.ok(
        nlCount <= stream.rows - 1,
        'newlines (' + nlCount + ') must not exceed rows-1'
    )
    t.ok(plain.includes('END'), 'the tail of the message is shown')
})

// -- Tests for scroll prevention --

test('render output never exceeds termHeight - 1 newlines', t => {
    const stream = createMockStream()
    stream.rows = 24
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // Count newlines in the initial render
    let output = stream.getOutput()
    let nlCount = (output.match(/\n/g) || []).length
    t.ok(
        nlCount <= stream.rows - 1,
        'initial render newlines (' + nlCount +
        ') should not exceed termHeight - 1 (' +
        (stream.rows - 1) + ')'
    )

    // After logging messages, the invariant still holds
    for (let i = 0; i < 30; i++) {
        display.log(`message ${i}`)
    }
    stream.clear()
    display.log('final message')
    output = stream.getOutput()
    nlCount = (output.match(/\n/g) || []).length
    t.ok(
        nlCount <= stream.rows - 1,
        'after many log messages, newlines (' + nlCount +
        ') should not exceed termHeight - 1 (' +
        (stream.rows - 1) + ')'
    )

    // After status change, invariant holds
    stream.clear()
    display.setTicketStatus(1, 'done')
    output = stream.getOutput()
    nlCount = (output.match(/\n/g) || []).length
    t.ok(
        nlCount <= stream.rows - 1,
        'after status change, newlines (' + nlCount +
        ') should not exceed termHeight - 1 (' +
        (stream.rows - 1) + ')'
    )

    display.cleanup()
})

test('render output stays within bounds across terminal sizes', t => {
    for (const rows of [8, 12, 16, 24, 40]) {
        const stream = createMockStream()
        stream.rows = rows
        const display = new StatusDisplay({
            stream,
        })

        const tickets = createTestTickets()
        display.startWave(1, 1, tickets)
        display.log('test message')

        stream.clear()
        display.setTicketStatus(1, 'in-progress')
        const output = stream.getOutput()
        const nlCount = (output.match(/\n/g) || []).length
        t.ok(
            nlCount <= rows - 1,
            `rows=${rows}: newlines (${nlCount}) should ` +
            `not exceed ${rows - 1}`
        )

        display.cleanup()
    }
})

// -- Tests for AC3: Rolling message area --

test('message area has fixed height of messageLines (AC3.1)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // With 0 messages, message area fills remaining rows
    // rows=24, header=1, tickets=3, separator=1,
    // 1 reserved for cursor -> logRows=18
    let output = stream.getOutput()
    const separatorIdx = output.lastIndexOf('-'.repeat(50))
    if (separatorIdx >= 0) {
        const messageAreaStart = output.indexOf('\n', separatorIdx) + 1
        const messageAreaEnd = output.length
        const messageAreaText = output.substring(messageAreaStart, messageAreaEnd)
        const messageAreaNewlines = (messageAreaText.match(/\n/g) || []).length
        t.equal(
            messageAreaNewlines, 18,
            'message area should fill remaining terminal rows'
        )
    }

    // Log 1 message, should have 1 message + 3 padding lines
    stream.clear()
    display.log('message 1')
    output = stream.getOutput()
    t.ok(
        output.includes('message 1'),
        'should display logged message'
    )

    // Log 2 more messages, area height stays the same
    stream.clear()
    display.log('message 2')
    output = stream.getOutput()
    const sepIdx = output.lastIndexOf('-'.repeat(50))
    if (sepIdx >= 0) {
        const msgStart = output.indexOf('\n', sepIdx) + 1
        const msgAreaText = output.substring(msgStart)
        const msgAreaNewlines = (msgAreaText.match(/\n/g) || []).length
        t.equal(
            msgAreaNewlines, 18,
            'message area height should remain stable'
        )
    }
})

test('new messages push old messages out (AC3.2)', t => {
    const stream = createMockStream()
    // rows=8, 3 tickets -> logRows = 8-3-3 = 2 visible log lines
    stream.rows = 8
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // Log more messages than visible log rows (2)
    display.log('msg1')
    display.log('msg2')
    stream.clear()
    display.log('msg3')
    const output = stream.getOutput()

    // msg1 should not be visible, msg3 should be there
    t.ok(
        !output.includes('msg1'),
        'oldest message should be removed when buffer full'
    )
    t.ok(
        output.includes('msg3'),
        'new message should be visible'
    )
    t.ok(
        output.includes('msg2'),
        'recent messages should remain'
    )
})

test('log accepts any string message (AC3.3)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    const messages = [
        'Agent started',
        'Processing task 1',
        'Task 1 complete',
    ]

    messages.forEach(msg => display.log(msg))

    const output = stream.getOutput()
    messages.forEach(msg => {
        t.ok(
            output.includes(msg),
            `should display message: ${msg}`
        )
    })
})

// -- Test setTicketStatus --

test('setTicketStatus updates ticket status and triggers render', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    stream.clear()
    display.setTicketStatus(1, 'in-progress')
    const output = stream.getOutput()

    // Should show updated status with in-progress color
    t.ok(
        output.includes('task1.md'),
        'should still show ticket filename'
    )
    t.ok(
        output.length > 0,
        'render should produce output'
    )
})

// -- Test cleanup --

test('log before any wave writes straight to the stream', t => {
    const stream = new MockStream()
    const display = new StatusDisplay({ stream:stream as any })
    display.log('nothing to run')
    t.ok(
        stream.getOutput().includes('nothing to run'),
        'message reaches the terminal without a wave'
    )
    t.ok(
        !stream.getOutput().includes('Wave '),
        'no status line is drawn'
    )
})

test('cleanup restores cursor visibility', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    stream.clear()
    display.cleanup()
    const output = stream.getOutput()

    // cursor show is \x1b[?25h
    t.ok(
        output.includes('\x1b[?25h'),
        'cleanup should write cursor show ANSI code'
    )
})

// -- Tests for non-wave tickets via startRun --

test('non-wave tickets render with pending dot', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        stream,
    })

    const allTickets = [
        { num:1, filename:'01-active.md' },
        { num:2, filename:'02-pending.md' },
    ]

    display.startRun(allTickets)
    display.startWave(1, 2, [allTickets[0]])

    const frame = lastFrame(stream.getOutput())
    t.ok(
        frame.includes('01-active.md'),
        'should display wave ticket'
    )
    t.ok(
        frame.includes('02-pending.md'),
        'should display non-wave ticket'
    )
})

test('non-wave tickets show pending empty dot', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        stream,
    })

    const allTickets = [
        { num:1, filename:'active.md' },
        { num:2, filename:'pending.md' },
    ]

    display.startRun(allTickets)
    display.startWave(1, 2, [allTickets[0]])

    const raw = stream.getOutput()
    const rawLines = raw.split('\n')
    const pendingLine = rawLines.find(
        l => stripAnsi(l).includes('pending.md'),
    )

    t.ok(
        pendingLine && pendingLine.includes(renderDot('pending')),
        'non-wave ticket should show pending dot'
    )
})

test('setTicketStatus does not affect non-wave tickets', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        stream,
    })

    const allTickets = [
        { num:1, filename:'active.md' },
        { num:2, filename:'pending.md' },
    ]

    display.startRun(allTickets)
    display.startWave(1, 2, [allTickets[0]])

    stream.clear()
    display.setTicketStatus(1, 'in-progress')

    const raw = stream.getOutput()
    const rawLines = raw.split('\n')
    const pendingLine = rawLines.find(
        l => stripAnsi(l).includes('pending.md'),
    )

    t.ok(
        pendingLine && pendingLine.includes(renderDot('pending')),
        'non-wave ticket should still show empty dot'
    )
})

test('non-wave tickets are included in pagination', t => {
    const stream = createMockStream()
    stream.rows = 12
    const display = new StatusDisplay({
        stream,
    })

    const waveTickets = [
        { num:1, filename:'wave-1.md' },
        { num:2, filename:'wave-2.md' },
    ]
    const allTickets = [
        ...waveTickets,
        ...Array.from({ length:10 }, (_, i) => ({
            num:i + 3,
            filename:`pending-${i + 3}.md`,
        })),
    ]

    display.startRun(allTickets)
    display.startWave(1, 3, waveTickets)

    const output = stream.getOutput()
    t.ok(
        output.includes('more below'),
        'should paginate when wave + non-wave exceed viewport'
    )
})

// -- Tests for stable-ticket-list AC1-AC3 --

test('AC1.1: all session tickets rendered after startRun', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
        { num:4, filename:'task4.md' },
    ]
    display.startRun(tickets)
    display.startWave(1, 2, [tickets[0]])

    const frame = lastFrame(stream.getOutput())
    t.ok(
        frame.includes('task1.md'),
        'should show wave ticket'
    )
    t.ok(
        frame.includes('task2.md'),
        'should show non-wave ticket 2'
    )
    t.ok(
        frame.includes('task3.md'),
        'should show non-wave ticket 3'
    )
    t.ok(
        frame.includes('task4.md'),
        'should show non-wave ticket 4'
    )
})

test('AC1.2/AC1.5: done status persists, failed persists', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 2, tickets)
    display.setTicketStatus(1, 'done')
    display.setTicketStatus(2, 'failed')

    stream.clear()
    display.startWave(2, 2, [])

    const raw = rawLastFrame(stream.getOutput())
    const rawLines = raw.split('\n')

    const line1Raw = rawLines.find(
        l => stripAnsi(l).includes('task1.md'),
    )
    const line2Raw = rawLines.find(
        l => stripAnsi(l).includes('task2.md'),
    )

    t.ok(
        line1Raw &&
        line1Raw.includes(renderDot('done')) &&
        !line1Raw.includes(renderDot('failed')),
        'task1 should have done dot (green, not red)'
    )
    t.ok(
        line2Raw &&
        line2Raw.includes(renderDot('failed')) &&
        !line2Raw.includes(renderDot('done')),
        'task2 should have failed dot (red, not green)'
    )
})

test('AC1.3: ticket order is stable across waves', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'first.md' },
        { num:2, filename:'second.md' },
        { num:3, filename:'third.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 2, [tickets[2], tickets[0]])
    display.setTicketStatus(2, 'in-progress')
    display.setTicketStatus(3, 'done')

    stream.clear()
    display.startWave(2, 2, [tickets[1]])
    display.setTicketStatus(1, 'in-progress')

    const frame = lastFrame(stream.getOutput())
    const plain = frame.split('\n')
    const labels = plain
        .filter(l => l.includes('.md'))
        .map(l => {
            const match = l.match(/([a-z-]+\.md)/)
            return match ? match[1] : null
        })
        .filter(Boolean)

    t.equal(labels[0], 'first.md', 'first should be first')
    t.equal(labels[1], 'second.md', 'second should be second')
    t.equal(labels[2], 'third.md', 'third should be third')
})

test('AC1.7: without startRun, wave seeds list once', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    display.startWave(1, 2, [
        { num:1, filename:'a.md' },
        { num:2, filename:'b.md' },
    ])

    display.startWave(2, 2, [
        { num:3, filename:'c.md' },
    ])

    const frame = lastFrame(stream.getOutput())
    t.ok(
        frame.includes('a.md') && frame.includes('b.md'),
        'should show seeded tickets from wave 1'
    )
    t.ok(
        !frame.includes('c.md'),
        'should not add wave 2 tickets'
    )
})

test('AC1.8: setTicketStatus for unknown ticket ignored', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
    ]
    display.startRun(tickets)
    display.startWave(1, 1, tickets)

    let plain = stripAnsi(stream.getOutput())
    const initialRowCount = plain.split('\n')
        .filter(l => l.includes('.md')).length

    display.setTicketStatus(999, 'in-progress')
    plain = stripAnsi(stream.getOutput())
    const afterRowCount = plain.split('\n')
        .filter(l => l.includes('.md')).length

    t.equal(
        afterRowCount, initialRowCount,
        'unknown ticket should not add new row'
    )
})

test('AC1.9: pagination and auto-scroll with fixed list', t => {
    const stream = createMockStream()
    stream.rows = 12
    const display = new StatusDisplay({ stream })

    const tickets = Array.from({ length:20 }, (_, i) => ({
        num:i + 1,
        filename:`task${String(i + 1).padStart(2, '0')}.md`,
    }))

    display.startRun(tickets)
    display.startWave(1, 1, [tickets[0], tickets[1]])

    display.setTicketStatus(15, 'in-progress')

    const plain = stripAnsi(stream.getOutput())

    t.ok(
        plain.includes('task15.md'),
        'auto-scroll should show in-progress ticket'
    )
})

test('AC2.8: blocked row fits terminal width', t => {
    const stream = createMockStream()
    stream.columns = 30
    const display = new StatusDisplay({ stream })

    // Create enough tickets to make long header
    const tickets = Array.from({ length:100 }, (_, i) => ({
        num:i + 1,
        filename:`t${i + 1}.md`,
        feature:'f',
    }))

    display.startRun(tickets)
    display.startWave(99, 99, tickets.slice(0, 10))
    // Mark 50 as done to make header show "49/100 done" (setBlocked(2) un-dones ticket 2)
    for (let i = 0; i < 50; i++) {
        display.setTicketStatus(i + 1, 'done')
    }
    display.setBlocked(2, 'f', [
        'f/01', 'f/03', 'f/04', 'f/05',
    ])

    const plain = stripAnsi(stream.getOutput())
    const maxWidth = stream.columns - 1
    const tooLong = plain.split('\n').filter(
        l => l.length > maxWidth,
    )

    t.equal(
        tooLong.length, 0,
        'all rows including blocked should fit: ' +
        JSON.stringify(tooLong)
    )
})

test('AC2.8: blocked row shows blocked dot', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)
    display.setBlocked(2, undefined, ['01-task.md'])

    const raw = rawLastFrame(stream.getOutput())
    const rawLines = raw.split('\n')
    const rawTask2Row = rawLines.find(
        l => stripAnsi(l).includes('task2.md'),
    )

    t.ok(
        rawTask2Row && rawTask2Row.includes(renderDot('blocked')),
        'blocked row should contain blocked dot'
    )
    const rawTask1Row = rawLines.find(
        l => stripAnsi(l).includes('task1.md'),
    )
    t.ok(
        rawTask1Row &&
        !rawTask1Row.includes(renderDot('blocked')),
        'non-blocked row should not contain blocked dot'
    )
})

test('blocked suffix contains blocker label', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01.md', feature:'f' },
        { num:2, filename:'02.md', feature:'f' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)
    display.setBlocked(2, 'f', ['f/01'])

    const plain = stripAnsi(lastFrame(stream.getOutput()))
    const lines = plain.split('\n')
    const f02Line = lines.find(l => l.includes('f/02'))

    t.ok(
        f02Line && f02Line.includes('f/01'),
        'blocked row for f/02 should contain f/01'
    )
})

test('blocked suffix with multiple blockers', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01.md', feature:'f' },
        { num:2, filename:'02.md', feature:'f' },
        { num:3, filename:'03.md', feature:'f' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)
    display.setBlocked(2, 'f', ['f/01', 'f/03'])

    const plain = stripAnsi(lastFrame(stream.getOutput()))
    const lines = plain.split('\n')
    const f02Line = lines.find(l => l.includes('f/02'))

    t.ok(
        f02Line && f02Line.includes('f/01'),
        'blocked row should contain first blocker'
    )
    t.ok(
        f02Line && f02Line.includes('f/03'),
        'blocked row should contain second blocker'
    )
})

test('AC3.2/AC3.3: header shows done/total and 0% initially', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
        { num:4, filename:'task4.md' },
        { num:5, filename:'task5.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)

    const frame = lastFrame(stream.getOutput())
    const nums = headerNumbers(frame)
    t.ok(nums, 'should have valid header')
    if (nums) {
        t.equal(nums.done, 0, 'should show 0 done')
        t.equal(nums.total, 5, 'should show 5 total')
        t.equal(nums.pct, 0, 'should show 0%')
    }
})

test('AC3.4: header shows 100% when all done', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
        { num:4, filename:'task4.md' },
        { num:5, filename:'task5.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)

    for (const ticket of tickets) {
        display.setTicketStatus(ticket.num, 'done')
    }

    const frame = lastFrame(stream.getOutput())
    const nums = headerNumbers(frame)
    t.ok(nums, 'should have valid header')
    if (nums) {
        t.equal(nums.done, 5, 'should show 5 done')
        t.equal(nums.total, 5, 'should show 5 total')
        t.equal(nums.pct, 100, 'should show 100%')
    }
})

test('AC3.5: failed and blocked do not count as done', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'task1.md' },
        { num:2, filename:'task2.md' },
        { num:3, filename:'task3.md' },
        { num:4, filename:'task4.md' },
        { num:5, filename:'task5.md' },
    ]

    display.startRun(tickets)
    display.startWave(1, 1, tickets)

    display.setTicketStatus(1, 'done')
    display.setTicketStatus(2, 'done')
    display.setTicketStatus(3, 'failed')
    display.setBlocked(4, undefined, ['blocker'])
    display.setTicketStatus(5, 'pending')

    const frame = lastFrame(stream.getOutput())
    const nums = headerNumbers(frame)
    t.ok(nums, 'should have valid header')
    if (nums) {
        t.equal(nums.done, 2, 'should show 2 done')
        t.equal(nums.total, 5, 'should show 5 total')
        t.equal(nums.pct, 40, 'should show 40%')
    }
})

// -- Tests for AC5: Pagination --

test('viewport limits rendering when tickets exceed available rows', t => {
    const stream = createMockStream()
    stream.rows = 12 // Small terminal: 12 rows total
    // Overhead: 1 (status) + 1 (separator) + 4 (messages) = 6
    // Available for tickets: 12 - 6 = 6 rows
    const display = new StatusDisplay({
        stream,
    })

    // Create 10 tickets, only 6 should fit
    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()

    // Should show overflow indicator for items below
    t.ok(
        output.includes('... ') && output.includes('more below'),
        'should show "more below" indicator when tickets exceed viewport'
    )

    // Should show a subset of tickets, not all 10
    const taskLines = (output.match(/task\d+\.md/g) || []).length
    t.ok(
        taskLines < 10 && taskLines >= 5,
        'should show subset of tickets (accounting for indicators)'
    )
})

test('viewport shows "more above" indicator when scrolled down', t => {
    const stream = createMockStream()
    stream.rows = 9
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`item${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    // Manually set a ticket to in-progress to test auto-scroll
    // This will be tested more thoroughly in Task 2, but here we just verify
    // the basic viewport structure works
    display.setTicketStatus(8, 'in-progress')

    const output = stream.getOutput()

    // When scrolled to show ticket 8, we should see "more above"
    t.ok(
        output.includes('more above'),
        'should show "more above" indicator when scrolled down'
    )
})

test('no pagination when all tickets fit in available rows', t => {
    const stream = createMockStream()
    stream.rows = 24 // Large terminal
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:4 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()

    // All tickets should be visible, no overflow indicators
    t.ok(
        !output.includes('more above') && !output.includes('more below'),
        'should not show overflow indicators when all tickets fit'
    )
    t.ok(
        output.includes('task1.md') &&
        output.includes('task2.md') &&
        output.includes('task3.md') &&
        output.includes('task4.md'),
        'should display all tickets'
    )
})

test('auto-scroll on in-progress status change when below viewport', t => {
    const stream = createMockStream()
    stream.rows = 9 // 6 rows available for tickets
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    stream.clear()
    // Set ticket 9 (which is index 8) to in-progress
    display.setTicketStatus(9, 'in-progress')

    const output = stream.getOutput()

    // Should now show task9 and nearby tickets
    t.ok(
        output.includes('task9.md'),
        'viewport should scroll to show in-progress ticket 9'
    )
    // Should show "more above" because we scrolled down
    t.ok(
        output.includes('more above'),
        'should show "more above" indicator after scrolling'
    )
})

test('auto-scroll on in-progress status change when above viewport', t => {
    const stream = createMockStream()
    stream.rows = 9
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    // First scroll the viewport down by setting a later ticket in-progress
    display.setTicketStatus(8, 'in-progress')
    stream.clear()

    // Then set an earlier ticket in-progress, should scroll back up
    display.setTicketStatus(2, 'in-progress')

    const output = stream.getOutput()

    // Should now show task2 in the viewport
    t.ok(
        output.includes('task2.md'),
        'viewport should scroll up to show in-progress ticket 2'
    )
})

test('resize event triggers re-render', t => {
    const stream = createMockStream()
    stream.rows = 12
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    // Verify resize listener was registered
    t.ok(
        stream.hasListener('resize'),
        'should register resize listener when stream is TTY'
    )

    // Change rows and emit resize event
    stream.rows = 8
    stream.clear()
    stream.emit('resize')

    const output = stream.getOutput()
    t.ok(
        output.length > 0,
        'resize event should trigger re-render'
    )
})

test('cleanup removes resize listener', t => {
    const stream = createMockStream()
    stream.rows = 12
    const display = new StatusDisplay({
        stream,
    })

    const tickets = Array.from({ length:10 }, (_, i) => ({
        num:i + 1,
        filename:`task${i + 1}.md`,
    }))
    display.startWave(1, 1, tickets)

    // Verify listener is registered
    t.ok(
        stream.hasListener('resize'),
        'should have resize listener before cleanup'
    )

    // Clean up
    display.cleanup()

    // Verify listener is removed
    t.ok(
        !stream.hasListener('resize'),
        'should remove resize listener after cleanup'
    )
})

// -- Tests for Task 1 and Task 2: Display type and createDisplay factory --

test('createDisplay returns PlainDisplay when stream.isTTY is false', t => {
    const stream = createMockStream()
    stream.isTTY = false

    const display = createDisplay(stream)

    t.ok(
        display instanceof PlainDisplay,
        'should return PlainDisplay when isTTY is false'
    )
})

test('createDisplay returns StatusDisplay when stream.isTTY is true', t => {
    const stream = createMockStream()
    stream.isTTY = true

    const display = createDisplay(stream)

    t.ok(
        display instanceof StatusDisplay,
        'should return StatusDisplay when isTTY is true'
    )
})

test('createDisplay uses process.stdout by default', t => {
    // Save original stdout.isTTY
    const originalIsTTY = process.stdout.isTTY

    try {
        // Mock process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', {
            value:false,
            writable:true,
            configurable:true,
        })

        const display = createDisplay()

        t.ok(
            display instanceof PlainDisplay,
            'should use process.stdout and return PlainDisplay when not TTY'
        )
    } finally {
        // Restore original value
        Object.defineProperty(process.stdout, 'isTTY', {
            value:originalIsTTY,
            writable:true,
            configurable:true,
        })
    }
})

// -- Tests for Task 7: Integration and TTY fallback --

test('PlainDisplay implements Display interface with no ANSI', t => {
    const display = new PlainDisplay()
    const tickets = createTestTickets()

    // Capture console.log output
    const capturedOutput:string[] = []
    const originalLog = console.log
    console.log = (...args:Array<any>):void => {
        capturedOutput.push(args.join(' '))
    }

    try {
        // Call PlainDisplay methods
        display.startWave(1, 2, tickets)
        display.setTicketStatus(1, 'in-progress')
        display.log('Test message')
        display.cleanup()

        // Verify output was captured
        t.ok(
            capturedOutput.length > 0,
            'PlainDisplay should produce output'
        )

        // Verify no ANSI escape sequences in output
        const allOutput = capturedOutput.join('\n')
        const ansiPattern = new RegExp(String.fromCharCode(27) + '\\[')
        const hasAnsi = ansiPattern.test(allOutput)
        t.ok(
            !hasAnsi,
            'PlainDisplay output should contain no ANSI escape codes'
        )
    } finally {
        console.log = originalLog
    }
})

test('spawnAgent onLine callback receives agent output lines', t => {
    return new Promise<void>(resolve => {
        const lines:string[] = []

        spawnAgent({
            prompt:'hello',
            agentCmd:'node',
            model:null,
            timeout:5,
            logPath:'/tmp/test-online.log',
            cwd:__dirname,
            onLine:(line:string) => {
                lines.push(line)
            },
        }).then(() => {
            // The callback should have been called at least once
            t.ok(
                lines.length > 0,
                'onLine callback should receive at least one line'
            )

            // Each line should have content
            const allText = lines.join('\n')
            t.ok(
                allText.length > 0,
                'callback lines should have content'
            )

            resolve()
        }).catch((err:any) => {
            t.fail(`spawnAgent should not error: ${String(err)}`)
            resolve()
        })
    })
})

// -- Tests for AC7: Integration with runWaves --

// Mock Display implementation that records all method calls
class RecordingDisplay implements Display {
    private calls:Array<{
        method:string
        args:Array<any>
    }> = []

    startRun (tickets:ReadonlyArray<any>):void {
        this.calls.push({
            method:'startRun',
            args:[tickets],
        })
    }

    startWave (
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<{
            num:number
            filename:string
        }>,
        progress?:any,
    ):void {
        this.calls.push({
            method:'startWave',
            args:[
                waveNum, totalWaves, tickets,
                progress,
            ],
        })
    }

    setTicketStatus (num:number, status:string):void {
        this.calls.push({
            method:'setTicketStatus',
            args:[num, status],
        })
    }

    setBlocked (
        num:number,
        feature:string|undefined,
        blockedBy:ReadonlyArray<string>,
    ):void {
        this.calls.push({
            method:'setBlocked',
            args:[num, feature, blockedBy],
        })
    }

    log (message:string):void {
        this.calls.push({
            method:'log',
            args:[message],
        })
    }

    cleanup ():void {
        this.calls.push({
            method:'cleanup',
            args:[],
        })
    }

    getCalls ():Array<{ method:string; args:Array<any> }> {
        return this.calls
    }

    getCallsByMethod (method:string):Array<Array<any>> {
        return this.calls
            .filter(c => c.method === method)
            .map(c => c.args)
    }
}

// Helper to create a temp git repo and ticket files
function initTempGitRepo ():string {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-display-test-')
    )
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

function makeTicketBody (status:string):string {
    return `# Test ticket\n\n**Status:** ${status}`
}

const MOCK_AGENT_PASS = join(
    process.cwd(), 'test', 'mock-agent-pass.js'
)

test(
    'AC7.1 -- runWaves calls display methods in correct ' +
    'sequence',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)

        // Create a simple ticket
        writeFileSync(
            join(issuesDir, '01-test.md'),
            makeTicketBody('ready-for-agent')
        )

        const tickets = scanTickets(issuesDir)
        const display = new RecordingDisplay()

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            await runWaves(
                tickets,
                'test spec',
                MOCK_AGENT_PASS,
                null,
                10,
                logsDir,
                'true',
                display,
            )
        } finally {
            process.chdir(originalCwd)
        }

        const calls = display.getCalls()

        // Should have startWave called
        const startWaveCalls =
            display.getCallsByMethod('startWave')
        t.equal(
            startWaveCalls.length, 1,
            'startWave should be called once'
        )

        // Should have setTicketStatus with
        // 'in-progress'
        const inProgressCalls =
            display.getCallsByMethod('setTicketStatus')
                .filter(args => args[1] === 'in-progress')
        t.equal(
            inProgressCalls.length, 1,
            'setTicketStatus should be called with ' +
            'in-progress'
        )

        // Should have setTicketStatus with 'done'
        const doneCalls =
            display.getCallsByMethod('setTicketStatus')
                .filter(args => args[1] === 'done')
        t.equal(
            doneCalls.length, 1,
            'setTicketStatus should be called with done'
        )

        // Should have cleanup called
        const cleanupCalls =
            display.getCallsByMethod('cleanup')
        t.equal(
            cleanupCalls.length, 1,
            'cleanup should be called once'
        )

        // Verify order: startWave, then in-progress,
        // then done, then cleanup
        const methodSequence = calls.map(c => c.method)
        t.ok(
            methodSequence.indexOf('startWave') <
            methodSequence.indexOf('setTicketStatus'),
            'startWave should come before setTicketStatus'
        )
        t.ok(
            methodSequence.lastIndexOf('cleanup') >
            methodSequence.lastIndexOf('setTicketStatus'),
            'cleanup should come after setTicketStatus'
        )
    }
)

test(
    'AC7.2 -- Agent output feeds into display log ' +
    '(runWaves portion)',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)

        // Create a simple ticket
        writeFileSync(
            join(issuesDir, '01-test.md'),
            makeTicketBody('ready-for-agent')
        )

        const tickets = scanTickets(issuesDir)
        const display = new RecordingDisplay()

        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            await runWaves(
                tickets,
                'test spec',
                MOCK_AGENT_PASS,
                null,
                10,
                logsDir,
                'true',
                display,
            )
        } finally {
            process.chdir(originalCwd)
        }

        // Should have called log() with various
        // messages
        const logCalls = display.getCallsByMethod('log')
        t.ok(
            logCalls.length > 0,
            'log should be called at least once'
        )

        // Should have logged at least the ticket
        // filename or status message
        const logMessages = logCalls
            .map(args => String(args[0]))
        const hasTicketRef = logMessages.some(msg =>
            msg.includes('test.md') ||
            msg.includes('Starting') ||
            msg.includes('done')
        )
        t.ok(
            hasTicketRef,
            'log should include ticket-related messages'
        )
    }
)

test('awaiting-merge dot differs from the running and ' +
    'done dots', t => {
    const waiting = renderDot('awaiting-merge')
    t.equal(typeof waiting, 'string', 'renders a dot')
    t.notEqual(
        waiting, renderDot('in-progress'),
        'a finished agent must not look like a running one'
    )
    t.notEqual(
        waiting, renderDot('done'),
        'an unmerged ticket must not look done'
    )
    t.notEqual(
        waiting, renderDot('pending'),
        'a finished agent must not look unstarted'
    )
})

test(
    'runWavesIsolated marks a ticket awaiting-merge ' +
    'between its agent finishing and the merge',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-test.md'),
            makeTicketBody('ready-for-agent')
        )
        const tickets = scanTickets(issuesDir)
        execSync('git add -A', { cwd:base })
        execSync(
            'git commit -m "add tickets" --no-verify',
            { cwd:base }
        )

        const display = new RecordingDisplay()
        const originalCwd = process.cwd()
        process.chdir(base)
        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_AGENT_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const statuses = display
            .getCallsByMethod('setTicketStatus')
            .filter(args => args[0] === 1)
            .map(args => args[1])
        t.deepEqual(
            statuses,
            ['in-progress', 'awaiting-merge', 'done'],
            'status moves from running to awaiting-merge ' +
            'to done'
        )
    }
)

test('StatusDisplay - startWave does not install ' +
    'SIGINT/SIGTERM handlers', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })

    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')

    display.startWave(1, 1, createTestTickets())

    t.equal(
        process.listenerCount('SIGINT'), sigintBefore,
        'startWave adds no SIGINT listener'
    )
    t.equal(
        process.listenerCount('SIGTERM'), sigtermBefore,
        'startWave adds no SIGTERM listener'
    )

    display.cleanup()
})

test('StatusDisplay - cleanup does not touch ' +
    'process signal listeners', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({ stream })
    display.startWave(1, 1, createTestTickets())

    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')

    display.cleanup()

    t.equal(
        process.listenerCount('SIGINT'), sigintBefore,
        'cleanup leaves SIGINT listeners untouched'
    )
    t.equal(
        process.listenerCount('SIGTERM'), sigtermBefore,
        'cleanup leaves SIGTERM listeners untouched'
    )
})

// -- Tests for feature/num prefix rendering --

test('StatusDisplay renders feature/num when ' +
    'feature is present', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01-login.md', feature:'auth' },
        { num:3, filename:'03-refund.md', feature:'payments' },
    ]
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    t.ok(
        output.includes('auth/01'),
        'should render auth/01 for ticket with feature'
    )
    t.ok(
        output.includes('payments/03'),
        'should render payments/03 for ticket with feature'
    )
})

test('StatusDisplay falls back to filename when ' +
    'feature is absent', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01-task.md' },
        { num:2, filename:'02-task.md' },
    ]
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    t.ok(
        output.includes('01-task.md'),
        'should render filename when no feature'
    )
    t.ok(
        output.includes('02-task.md'),
        'should render filename when no feature'
    )
})

test('setTicketStatus uses compound identity when ' +
    'feature is present', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01-login.md', feature:'auth' },
        { num:1, filename:'01-setup.md', feature:'payments' },
    ]
    display.startWave(1, 1, tickets)

    stream.clear()
    display.setTicketStatus(1, 'done', 'auth')

    const output = stream.getOutput()
    const lines = output.split('\n')
    const authLine = lines.find(l => l.includes('auth/01'))
    const paymentsLine = lines.find(
        l => l.includes('payments/01')
    )
    t.ok(authLine, 'auth/01 line should exist')
    t.ok(paymentsLine, 'payments/01 line should exist')
    t.ok(
        authLine!.includes('●'),
        'auth/01 should show filled dot (done)'
    )
    t.ok(
        paymentsLine!.includes('○'),
        'payments/01 should still show empty dot (pending)'
    )
})

test('setTicketStatus matches by num alone when ' +
    'feature is absent', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01-task.md' },
        { num:2, filename:'02-task.md' },
    ]
    display.startWave(1, 1, tickets)

    stream.clear()
    display.setTicketStatus(1, 'in-progress')

    const output = stream.getOutput()
    t.ok(
        output.includes('01-task.md'),
        'ticket 1 should still render'
    )
})

test('PlainDisplay includes feature/num in ' +
    'startWave output', t => {
    const capturedOutput:string[] = []
    const originalLog = console.log
    console.log = (...args:Array<any>):void => {
        capturedOutput.push(args.join(' '))
    }

    const display = new PlainDisplay()
    const tickets = [
        {
            num:1,
            filename:'01-login.md',
            feature:'auth',
        },
        {
            num:3,
            filename:'03-refund.md',
            feature:'payments',
        },
    ]
    display.startWave(1, 2, tickets)
    console.log = originalLog

    const allOutput = capturedOutput.join('\n')
    t.ok(
        allOutput.includes('auth/01'),
        'PlainDisplay should show auth/01'
    )
    t.ok(
        allOutput.includes('payments/03'),
        'PlainDisplay should show payments/03'
    )
})

test('Display tests verify feature/num with tickets ' +
    'from multiple features', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({ stream })

    const tickets = [
        { num:1, filename:'01-login.md', feature:'auth' },
        { num:2, filename:'02-signup.md', feature:'auth' },
        { num:1, filename:'01-setup.md', feature:'payments' },
        { num:3, filename:'03-refund.md', feature:'payments' },
    ]
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    t.ok(output.includes('auth/01'), 'has auth/01')
    t.ok(output.includes('auth/02'), 'has auth/02')
    t.ok(output.includes('payments/01'), 'has payments/01')
    t.ok(output.includes('payments/03'), 'has payments/03')

    stream.clear()
    display.setTicketStatus(1, 'done', 'payments')

    const updated = stream.getOutput()
    const lines = updated.split('\n')

    const authOne = lines.find(l => l.includes('auth/01'))
    const payOne = lines.find(l => l.includes('payments/01'))
    t.ok(authOne, 'auth/01 still rendered')
    t.ok(payOne, 'payments/01 still rendered')
    t.ok(
        authOne!.includes('○'),
        'auth/01 is still pending'
    )
    t.ok(
        payOne!.includes('●'),
        'payments/01 is done'
    )
})

test('AC2.5: renderDot(blocked) differs from other statuses',
    t => {
        const blocked = renderDot('blocked')
        const pending = renderDot('pending')
        const inProgress = renderDot('in-progress')
        const awaitingMerge = renderDot('awaiting-merge')
        const done = renderDot('done')
        const failed = renderDot('failed')

        t.notEqual(blocked, pending, 'blocked differs from pending')
        t.notEqual(blocked, inProgress,
            'blocked differs from in-progress')
        t.notEqual(blocked, awaitingMerge,
            'blocked differs from awaiting-merge')
        t.notEqual(blocked, done, 'blocked differs from done')
        t.notEqual(blocked, failed, 'blocked differs from failed')
    }
)

test('AC4.5: PlainDisplay startRun and setBlocked are no-ops',
    t => {
        const logs:string[] = []
        const origLog = console.log
        console.log = (...args:unknown[]) => {
            logs.push(args.join(' '))
        }

        try {
            const display = new PlainDisplay()

            display.startRun([
                { num:1, filename:'task1.md' },
            ])
            display.setBlocked(1, undefined, ['task2.md'])
        } finally {
            console.log = origLog
        }

        t.equal(
            logs.length, 0,
            'no logs from startRun or setBlocked'
        )
    }
)

test('AC4.5: PlainDisplay output format unchanged', t => {
    const origLog = console.log
    const logs1:string[] = []
    const logs2:string[] = []

    try {
        // Run 1: with startRun and setBlocked
        console.log = (...args:unknown[]) => {
            logs1.push(args.join(' '))
        }

        const display1 = new PlainDisplay()
        display1.startRun([
            { num:1, filename:'task1.md' },
            { num:2, filename:'task2.md' },
        ])
        display1.setBlocked(1, undefined, ['task2.md'])
        display1.startWave(1, 2, [
            { num:1, filename:'task1.md' },
            { num:2, filename:'task2.md' },
        ], { completed:0, total:2 })

        // Run 2: without startRun and setBlocked
        console.log = (...args:unknown[]) => {
            logs2.push(args.join(' '))
        }

        const display2 = new PlainDisplay()
        display2.startWave(1, 2, [
            { num:1, filename:'task1.md' },
            { num:2, filename:'task2.md' },
        ], { completed:0, total:2 })
    } finally {
        console.log = origLog
    }

    // Verify format is identical
    t.deepEqual(
        logs1, logs2,
        'PlainDisplay output unchanged with/without startRun'
    )
})
