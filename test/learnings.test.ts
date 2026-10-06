import { test } from '@substrate-system/tapzero'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
    LearningEntry,
    EntryInput,
} from '../src/learnings.js'
import {
    MAX_OWN_ENTRIES,
    MAX_ENTRY_CHARS,
    TRUNCATED_MARKER,
    renderEntry,
    parseEntries,
    selectHistory,
    renderHistory,
    tailLines,
    learningsPathFor,
} from '../src/learnings.js'

// -- AC1.1: Round-trip test for all outcome variants --

test('AC1.1: entries round-trip through render and parse', t => {
    const token = randomUUID()

    const entries:EntryInput[] = [
        {
            key:'my-feature:1',
            label:'my-feature/01',
            attempt:1,
            now:new Date('2026-10-06T14:30:45'),
            outcome:'done',
            run:{
                exitCode:0,
                completedItems:['item a', 'item b'],
                timedOut:false,
                notes:'All good',
            },
            effort:'high',
        },
        {
            key:'my-feature:2',
            label:'my-feature/02',
            attempt:2,
            now:new Date('2026-10-06T15:00:00'),
            outcome:'exit',
            run:{
                exitCode:42,
                completedItems:[],
                timedOut:true,
                notes:null,
            },
        },
        {
            key:'my-feature:3',
            label:'my-feature/03',
            attempt:1,
            now:new Date('2026-10-06T15:30:00'),
            outcome:'tests',
            run:{
                exitCode:1,
                completedItems:['test item'],
                timedOut:false,
                notes:'Test notes',
            },
            logName:'npm-test.log',
            logTail:'line 1\nline 2\nline 3',
        },
        {
            key:'my-feature:4',
            label:'my-feature/04',
            attempt:1,
            now:new Date('2026-10-06T16:00:00'),
            outcome:'install',
            logName:'npm-install.log',
            logTail:'install failed',
        },
        {
            key:'my-feature:5',
            label:'my-feature/05',
            attempt:1,
            now:new Date('2026-10-06T16:30:00'),
            outcome:'no-commits',
            run:{
                exitCode:0,
                completedItems:[],
                timedOut:false,
                notes:'No commits made',
            },
        },
        {
            key:'my-feature:6',
            label:'my-feature/06',
            attempt:1,
            now:new Date('2026-10-06T17:00:00'),
            outcome:'error',
            error:'Something went wrong: ' + token,
        },
        {
            key:'my-feature:7',
            label:'my-feature/07',
            attempt:0,
            now:new Date('2026-10-06T17:30:00'),
            outcome:'merge',
            stderr:'CONFLICT (content): Merge conflict in file.txt',
        },
    ]

    const rendered = entries.map(e => renderEntry(e)).join('')
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, entries.length, 'should parse all entries')

    parsed.forEach((entry, i) => {
        const input = entries[i]
        t.equal(
            entry.key,
            input.key,
            `entry ${i}: key matches`
        )
        t.equal(
            entry.attempt,
            input.attempt,
            `entry ${i}: attempt matches`
        )
        t.equal(
            entry.outcome,
            input.outcome,
            `entry ${i}: outcome matches`
        )

        const expectedTimedOut = 'run' in input && input.run.timedOut
        t.equal(
            entry.timedOut,
            expectedTimedOut,
            `entry ${i}: timedOut matches`
        )
    })

    // Verify error entry contains the unique token
    const errorEntry = parsed.find(e => e.outcome === 'error')
    t.ok(
        errorEntry && errorEntry.body.includes(token),
        'error entry should preserve unique content'
    )
})

// -- AC1.2: Entries with sentinel prefix in notes --

test('AC1.2: notes containing sentinel prefix parse as one entry', t => {
    const entries:EntryInput[] = [
        {
            key:'test:1',
            label:'test/01',
            attempt:1,
            now:new Date(),
            outcome:'done',
            run:{
                exitCode:0,
                completedItems:[],
                timedOut:false,
                notes:('Some text\n' +
                    '<!-- nightralph:entry ticket=x:1 attempt=1 outcome=done -->\n' +
                    'More text after the fake sentinel'),
            },
        },
    ]

    const rendered = renderEntry(entries[0])
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should have exactly one entry')
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sanitized sentinel should be in body (hyphen instead of colon)'
    )
})

// -- AC1.2: Invalid entries are dropped --

test('AC1.2: invalid entries are dropped without throwing', t => {
    const text = `
<!-- nightralph:entry ticket= attempt=1 outcome=done -->
empty ticket
<!-- nightralph:entry ticket=valid:1 attempt=not-a-number outcome=done -->
non-numeric attempt
<!-- nightralph:entry ticket=%E0%A attempt=1 outcome=done -->
malformed escape
<!-- nightralph:entry ticket=valid:2 attempt=1 outcome=done -->
this one is valid
<!-- nightralph:entry ticket=valid:3 attempt=1 outcome=unknown -->
unknown outcome
`

    const parsed = parseEntries(text)

    t.equal(parsed.length, 1, 'should parse only the valid entry')
    t.equal(parsed[0].key, 'valid:2', 'should be the valid entry')
})

// -- AC1.3: tailLines --

test('AC1.3: tailLines returns last n lines', t => {
    const lines:string[] = []
    for (let i = 1; i <= 50; i++) {
        lines.push(`line ${i}`)
    }
    const text = lines.join('\n')

    const result = tailLines(text, 40)
    const resultLines = result.split('\n')

    t.equal(
        resultLines.length,
        40,
        'should return 40 lines'
    )
    t.ok(
        resultLines[resultLines.length - 1].includes('50'),
        'last line should be line 50'
    )
    t.ok(
        resultLines[0].includes('11'),
        'first of tail should be line 11'
    )
})

test('AC1.3: tailLines returns all when fewer than n lines', t => {
    const text = 'line 1\nline 2\nline 3'
    const result = tailLines(text, 40)
    const lines = result.split('\n')

    t.equal(lines.length, 3, 'should return all 3 lines')
})

test('AC1.3: tailLines handles trailing newline correctly', t => {
    const text = 'line 1\nline 2\nline 3\n'
    const result = tailLines(text, 40)
    const lines = result.split('\n')

    t.equal(
        lines.length,
        3,
        'should not produce extra empty line from trailing newline'
    )
})

// -- AC2.1: History selection - own entries --

test('AC2.1: selectHistory keeps most recent own entries', t => {
    const entries:LearningEntry[] = [
        {
            key:'feat:1',
            attempt:1,
            outcome:'exit',
            timedOut:false,
            body:'first',
        },
        {
            key:'feat:1',
            attempt:2,
            outcome:'exit',
            timedOut:false,
            body:'second',
        },
        {
            key:'feat:1',
            attempt:3,
            outcome:'done',
            timedOut:false,
            body:'third',
        },
        {
            key:'feat:1',
            attempt:4,
            outcome:'exit',
            timedOut:false,
            body:'fourth',
        },
        {
            key:'feat:1',
            attempt:5,
            outcome:'exit',
            timedOut:false,
            body:'fifth',
        },
        {
            key:'feat:1',
            attempt:6,
            outcome:'exit',
            timedOut:false,
            body:'sixth',
        },
    ]

    const selection = selectHistory(entries, {
        key:'feat:1',
        blockerKeys:[],
    })

    t.equal(
        selection.own.length,
        MAX_OWN_ENTRIES,
        `should keep only last ${MAX_OWN_ENTRIES} entries`
    )

    const attempts = selection.own.map(e => e.attempt)
    const expected = [3, 4, 5, 6]
    t.deepEqual(
        attempts,
        expected,
        'should keep most recent entries in order'
    )
})

// -- AC2.2: Blocker selection --

test('AC2.2: selectHistory includes most recent done entry from blocker', t => {
    const entries:LearningEntry[] = [
        {
            key:'blocker:1',
            attempt:1,
            outcome:'exit',
            timedOut:false,
            body:'blocker failed',
        },
        {
            key:'blocker:1',
            attempt:2,
            outcome:'done',
            timedOut:false,
            body:'blocker first success',
        },
        {
            key:'blocker:1',
            attempt:3,
            outcome:'exit',
            timedOut:false,
            body:'blocker failed again',
        },
        {
            key:'blocker:1',
            attempt:4,
            outcome:'done',
            timedOut:false,
            body:'blocker second success',
        },
    ]

    const selection = selectHistory(entries, {
        key:'feat:1',
        blockerKeys:['blocker:1'],
    })

    t.equal(
        selection.blockers.length,
        1,
        'should have one blocker entry'
    )
    t.equal(
        selection.blockers[0].attempt,
        4,
        'should be the most recent done entry'
    )
})

// -- AC2.3: Exclusions --

test('AC2.3: excludes unrelated entries', t => {
    const entries:LearningEntry[] = [
        {
            key:'unrelated:1',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'unrelated',
        },
        {
            key:'feat:4',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'same number different feature',
        },
        {
            key:'blocker:1',
            attempt:1,
            outcome:'exit',
            timedOut:false,
            body:'blocker failed',
        },
        {
            key:'blocker:1',
            attempt:2,
            outcome:'exit',
            timedOut:false,
            body:'blocker still failing',
        },
    ]

    const selection = selectHistory(entries, {
        key:'feat:1',
        blockerKeys:['blocker:1'],
    })

    t.equal(
        selection.own.length,
        0,
        'should have no own entries'
    )
    t.equal(
        selection.blockers.length,
        0,
        'should exclude blocker with no done entries'
    )
})

// -- AC2.4: Empty selection --

test('AC2.4: renderHistory of empty selection returns empty string', t => {
    const result = renderHistory({
        own:[],
        blockers:[],
    })

    t.equal(result, '', 'should be empty string')
})

// -- AC2.5: Truncation --

test('AC2.5: renderHistory truncates long entries', t => {
    const longBody = 'x'.repeat(MAX_ENTRY_CHARS * 3)
    const shortBody = ''

    const entries:LearningEntry[] = [
        {
            key:'feat:1',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:longBody,
        },
        {
            key:'feat:2',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:shortBody,
        },
    ]

    const selection = selectHistory(entries, {
        key:'feat:1',
        blockerKeys:['feat:2'],
    })

    const result = renderHistory(selection)

    const truncatedLength =
        MAX_ENTRY_CHARS + TRUNCATED_MARKER.length + 1

    t.ok(
        result.includes(TRUNCATED_MARKER),
        'should include truncation marker'
    )

    t.ok(
        result.length < longBody.length,
        'output should be much shorter than long input'
    )

    t.ok(
        result.length <= truncatedLength * 2,
        'total length should be reasonable'
    )
})

// -- learningsPathFor --

test('learningsPathFor returns correct path', t => {
    const progressPath = join('a', 'b', 'progress.md')
    const result = learningsPathFor(progressPath)

    t.equal(
        result,
        join('a', 'b', 'learnings.md'),
        'should replace progress.md with learnings.md'
    )
})
