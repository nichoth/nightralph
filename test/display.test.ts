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
    type DisplayTicket,
    type Display,
} from '../src/display.js'
import {
    spawnAgent, runWaves, scanTickets,
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

// -- Tests for AC4.1 and AC4.2: Wave transitions --

test('startWave initializes display with tickets in pending status', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
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

test('startWave resets ticket list on second call', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const wave1Tickets = [
        { num:1, filename:'wave1-task.md', status:'pending' as const },
    ]
    const wave2Tickets = [
        { num:2, filename:'wave2-task.md', status:'pending' as const },
    ]

    display.startWave(1, 2, wave1Tickets)
    const output1 = stream.getOutput()

    stream.clear()
    display.startWave(2, 2, wave2Tickets)
    const output2 = stream.getOutput()

    t.ok(
        output1.includes('wave1-task.md'),
        'first wave should display wave1 ticket'
    )
    t.ok(
        output2.includes('wave2-task.md'),
        'second wave should display wave2 ticket'
    )
    t.ok(
        !output2.includes('wave1-task.md'),
        'second wave should not contain wave1 ticket'
    )
})

test('startWave updates wave number in status line', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
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
        messageLines:4,
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
        messageLines:4,
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
        messageLines:4,
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
        messageLines:4,
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
        messageLines:4,
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

test('status line shows Wave {current}/{total} -- {pct}% complete (AC2.1)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 2, tickets)

    const output = stream.getOutput()
    // Should match pattern like "Wave 1/2 -- 0% complete"
    t.ok(
        /Wave \d+\/\d+ -+ \d+%/.test(output),
        'status line should have format Wave {current}/{total} -- {pct}%'
    )
})

test('percentage reflects completed tickets divided by total (AC2.2)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
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
        messageLines:4,
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

test('percentage reflects overall run progress when given', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    // wave 2 of 3; 3 of 11 tickets already done before this wave
    const tickets = createTestTickets()
    display.startWave(2, 3, tickets, { completed:3, total:11 })

    let output = stream.getOutput()
    t.ok(
        output.includes('27%'),
        'should show 3/11 = 27% at wave start, not 0%'
    )

    stream.clear()
    display.setTicketStatus(1, 'done')
    output = stream.getOutput()
    t.ok(
        output.includes('36%'),
        'one more done should show 4/11 = 36%'
    )

    // next wave carries the running total forward
    stream.clear()
    display.startWave(3, 3, createTestTickets(), {
        completed:6,
        total:11,
    })
    output = stream.getOutput()
    t.ok(
        output.includes('55%'),
        'new wave should show 6/11 = 55%, not reset to 0%'
    )
})

test('rendered lines never exceed terminal width', t => {
    const stream = createMockStream()
    stream.columns = 40
    const display = new StatusDisplay({
        messageLines:4,
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
    const tooLong = plain.split('\n').filter(l => l.length > 40)
    t.equal(
        tooLong.length, 0,
        'no rendered line should be wider than columns: ' +
        JSON.stringify(tooLong)
    )
})

// -- Tests for AC3: Rolling message area --

test('message area has fixed height of messageLines (AC3.1)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // With 0 messages, message area should be 4 empty lines (all padding)
    let output = stream.getOutput()
    const separatorIdx = output.lastIndexOf('-'.repeat(50))
    if (separatorIdx >= 0) {
        const messageAreaStart = output.indexOf('\n', separatorIdx) + 1
        const messageAreaEnd = output.length
        const messageAreaText = output.substring(messageAreaStart, messageAreaEnd)
        const messageAreaNewlines = (messageAreaText.match(/\n/g) || []).length
        t.equal(
            messageAreaNewlines, 4,
            'message area with 0 messages should have 4 newlines (4 empty lines)'
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

    // Log 2 more messages, message area should still be 4 lines
    // (2 messages + 2 padding lines)
    stream.clear()
    display.log('message 2')
    output = stream.getOutput()
    const sepIdx = output.lastIndexOf('-'.repeat(50))
    if (sepIdx >= 0) {
        const msgStart = output.indexOf('\n', sepIdx) + 1
        const msgAreaText = output.substring(msgStart)
        const msgAreaNewlines = (msgAreaText.match(/\n/g) || []).length
        t.equal(
            msgAreaNewlines, 4,
            'message area with 2 messages should still have 4 newlines total'
        )
    }
})

test('new messages push old messages out (AC3.2)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:3, // Small buffer for testing
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    // Log more messages than messageLines
    display.log('msg1')
    display.log('msg2')
    display.log('msg3')
    stream.clear()
    display.log('msg4')
    const output = stream.getOutput()

    // msg1 should be gone, msg4 should be there
    t.ok(
        !output.includes('msg1'),
        'oldest message should be removed when buffer full'
    )
    t.ok(
        output.includes('msg4'),
        'new message should be visible'
    )
    t.ok(
        output.includes('msg2') && output.includes('msg3'),
        'recent messages should remain'
    )
})

test('log accepts any string message (AC3.3)', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
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
        messageLines:4,
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

test('cleanup restores cursor visibility', t => {
    const stream = createMockStream()
    const display = new StatusDisplay({
        messageLines:4,
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

// -- Tests for remaining tickets --

test('startWave renders remaining tickets with empty dots', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const waveTickets = [
        { num:6, filename:'06-active.md' },
    ]
    const remaining = [
        { num:7, filename:'07-queued.md' },
        { num:8, filename:'08-queued.md' },
    ]
    display.startWave(1, 3, waveTickets, undefined, remaining)

    const output = stream.getOutput()
    t.ok(
        output.includes('06-active.md'),
        'should display wave ticket'
    )
    t.ok(
        output.includes('07-queued.md'),
        'should display first remaining ticket'
    )
    t.ok(
        output.includes('08-queued.md'),
        'should display second remaining ticket'
    )
})

test('remaining tickets show dim empty dot', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const waveTickets = [
        { num:1, filename:'active.md' },
    ]
    const remaining = [
        { num:2, filename:'queued.md' },
    ]
    display.startWave(1, 2, waveTickets, undefined, remaining)

    const output = stream.getOutput()
    const lines = output.split('\n')
    const queuedLine = lines.find(l => l.includes('queued.md'))
    t.ok(queuedLine, 'should have a line for queued ticket')
    t.ok(
        queuedLine!.includes('○'),
        'remaining ticket should use empty dot'
    )
})

test('setTicketStatus does not affect remaining tickets', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const waveTickets = [
        { num:1, filename:'active.md' },
    ]
    const remaining = [
        { num:2, filename:'queued.md' },
    ]
    display.startWave(1, 2, waveTickets, undefined, remaining)

    // Setting status on a wave ticket triggers re-render;
    // remaining ticket should still have empty dot
    stream.clear()
    display.setTicketStatus(1, 'in-progress')

    const output = stream.getOutput()
    const lines = output.split('\n')
    const queuedLine = lines.find(l => l.includes('queued.md'))
    t.ok(queuedLine, 'remaining ticket should still be rendered')
    t.ok(
        queuedLine!.includes('○'),
        'remaining ticket should still show empty dot'
    )
})

test('remaining tickets are included in pagination', t => {
    const stream = createMockStream()
    stream.rows = 12
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const waveTickets = [
        { num:1, filename:'wave-1.md' },
        { num:2, filename:'wave-2.md' },
    ]
    const remaining = Array.from({ length:10 }, (_, i) => ({
        num:i + 3,
        filename:`remaining-${i + 3}.md`,
    }))
    display.startWave(1, 3, waveTickets, undefined, remaining)

    const output = stream.getOutput()
    t.ok(
        output.includes('more below'),
        'should paginate when wave + remaining exceed viewport'
    )
})

test('startWave without remaining works as before', t => {
    const stream = createMockStream()
    stream.rows = 40
    const display = new StatusDisplay({
        messageLines:4,
        stream,
    })

    const tickets = createTestTickets()
    display.startWave(1, 1, tickets)

    const output = stream.getOutput()
    t.ok(
        output.includes('task1.md'),
        'should still work without remaining parameter'
    )
    t.ok(
        output.includes('task2.md'),
        'should still display all wave tickets'
    )
})

// -- Tests for AC5: Pagination --

test('viewport limits rendering when tickets exceed available rows', t => {
    const stream = createMockStream()
    stream.rows = 12 // Small terminal: 12 rows total
    // Overhead: 1 (status) + 1 (separator) + 4 (messages) = 6
    // Available for tickets: 12 - 6 = 6 rows
    const display = new StatusDisplay({
        messageLines:4,
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
    stream.rows = 12
    const display = new StatusDisplay({
        messageLines:4,
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
        messageLines:4,
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
    stream.rows = 12 // 6 rows available for tickets
    const display = new StatusDisplay({
        messageLines:4,
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
    stream.rows = 12
    const display = new StatusDisplay({
        messageLines:4,
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
        messageLines:4,
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
        messageLines:4,
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

    startWave (
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<{
            num:number
            filename:string
        }>,
        progress?:any,
        remaining?:ReadonlyArray<{
            num:number
            filename:string
        }>,
    ):void {
        this.calls.push({
            method:'startWave',
            args:[
                waveNum, totalWaves, tickets,
                progress, remaining,
            ],
        })
    }

    setTicketStatus (num:number, status:string):void {
        this.calls.push({
            method:'setTicketStatus',
            args:[num, status],
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
    'runWaves passes remaining tickets to startWave',
    async t => {
        const base = initTempGitRepo()
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir)

        // ticket 1 is ready, ticket 2 is blocked by 1
        writeFileSync(
            join(issuesDir, '01-first.md'),
            '# First\n\n**Status:** ready-for-agent\n'
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            '# Second\n\n**Status:** ready-for-agent\n' +
            '**Blocked by:** 1\n'
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
                display,
            )
        } finally {
            process.chdir(originalCwd)
        }

        const startWaveCalls =
            display.getCallsByMethod('startWave')
        t.ok(
            startWaveCalls.length >= 1,
            'startWave should be called'
        )

        // First wave: ticket 1 is ready, ticket 2 is
        // remaining (blocked)
        const firstCall = startWaveCalls[0]
        const remaining = firstCall[4] as
            Array<{ num:number; filename:string }>|undefined
        t.ok(
            remaining && remaining.length === 1,
            'first wave should have 1 remaining ticket'
        )
        t.equal(
            remaining?.[0]?.filename,
            '02-second.md',
            'remaining ticket should be the blocked one'
        )
    }
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
