import { test } from '@substrate-system/tapzero'
import { randomUUID } from 'node:crypto'
import {
    spawnSync,
} from 'node:child_process'
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type {
    LearningEntry,
    EntryInput,
} from '../src/learnings.js'
import {
    MAX_OWN_ENTRIES,
    MAX_ENTRY_CHARS,
    TRUNCATED_MARKER,
    NOTES_PATH,
    renderEntry,
    parseEntries,
    selectHistory,
    renderHistory,
    tailLines,
    learningsPathFor,
    readEntries,
    appendEntry,
    collectNotes,
    ensureNotesIgnored,
} from '../src/learnings.js'

// -- AC1.1: Round-trip test for all outcome variants --

test('AC1.1: entries round-trip through render and parse', t => {
    const token = randomUUID()
    const itemToken = randomUUID()
    const notesToken = randomUUID()

    const entries:EntryInput[] = [
        {
            key:'my feature:1',
            label:'my feature/01',
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
                completedItems:[itemToken],
                timedOut:false,
                notes:notesToken,
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

    // Verify tests entry contains both item and notes tokens
    const testsEntry = parsed.find(e => e.outcome === 'tests')
    t.ok(
        testsEntry && testsEntry.body.includes(itemToken),
        'tests entry body should contain agent summary ' +
        'with completed item token'
    )
    t.ok(
        testsEntry && testsEntry.body.includes(notesToken),
        'tests entry body should contain notes section with token'
    )
})

// -- AC1.2: Entries with sentinel prefix in notes --

test('AC1.2: notes containing sentinel prefix parse as one entry', t => {
    const tokenInNotes = randomUUID()
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
                notes:(
                    'Some text\n' +
                    '<!-- nightralph:entry ' +
                    'ticket=x:1 attempt=1 outcome=done -->\n' +
                    `More text with token: ${tokenInNotes}`
                ),
            },
        },
    ]

    const rendered = renderEntry(entries[0])
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should have exactly one entry')
    t.equal(
        parsed[0].key,
        'test:1',
        'should parse original key correctly'
    )
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sanitized sentinel should be in body (hyphen instead colon)'
    )
    t.ok(
        parsed[0].body.includes(tokenInNotes),
        'random token from notes should be preserved'
    )
})

test('AC1.1/I1: key with space and = encodes and decodes correctly', t => {
    const entries:EntryInput[] = [
        {
            key:'my feature:1=test',
            label:'my-feature/01',
            attempt:1,
            now:new Date(),
            outcome:'done',
            run:{
                exitCode:0,
                completedItems:[],
                timedOut:false,
                notes:null,
            },
        },
    ]

    const rendered = renderEntry(entries[0])
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should parse entry with = in key')
    t.equal(
        parsed[0].key,
        'my feature:1=test',
        'should preserve = in key after roundtrip'
    )
})

test('AC1.2: completedItems and notes with sentinel are sanitized', t => {
    const token = randomUUID()
    const entries:EntryInput[] = [
        {
            key:'test:2',
            label:'test/02',
            attempt:1,
            now:new Date(),
            outcome:'done',
            run:{
                exitCode:0,
                completedItems:[
                    'item with sentinel <!-- nightralph:entry',
                ],
                timedOut:false,
                notes:`notes with sentinel <!-- nightralph:entry ${token}`,
            },
        },
    ]

    const rendered = renderEntry(entries[0])
    // Should find the sentinel in rendered output
    t.ok(
        rendered.includes('<!-- nightralph:entry'),
        'should have real sentinel line'
    )
    // Should find sanitized version in completedItems and notes
    t.ok(
        rendered.includes('<!-- nightralph-entry'),
        'sanitized sentinels should use hyphen'
    )
    t.ok(
        rendered.includes(token),
        'token in notes should be preserved'
    )
})

// -- AC1.2: Invalid entries are dropped --

test('AC1.2: invalid entries are dropped without throwing', t => {
    const text = `
<!-- nightralph:entry ticket= attempt=1 outcome=done -->
empty ticket
<!-- nightralph:entry ticket=valid:1 attempt=not-a-number outcome=done -->
non-numeric attempt
<!-- nightralph:entry ticket=valid:1a attempt=1abc outcome=done -->
attempt with suffix
<!-- nightralph:entry ticket=valid:1b attempt=1.5 outcome=done -->
fractional attempt
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

// -- Parsing robustness: CRLF line endings --

test('Parsing robustness: CRLF line endings are handled', t => {
    const token = randomUUID()
    const entry:EntryInput = {
        key:'test:crlf',
        label:'test/crlf',
        attempt:1,
        now:new Date(),
        outcome:'done',
        run:{
            exitCode:0,
            completedItems:[],
            timedOut:false,
            notes:`Note with CRLF and token: ${token}`,
        },
    }

    const rendered = renderEntry(entry)
    // Replace LF with CRLF to simulate autocrlf=true
    const crlfText = rendered.replace(/\n/g, '\r\n')
    const parsed = parseEntries(crlfText)

    t.equal(parsed.length, 1, 'should parse CRLF file')
    t.equal(parsed[0].key, 'test:crlf', 'key should be correct')
    t.ok(
        parsed[0].body.includes(token),
        'token should be preserved with CRLF'
    )
})

// -- AC1.2+: Sanitization of free-text fields --

test('AC1.2+: logTail with sentinel is sanitized', t => {
    const token = randomUUID()
    const sentinel =
        '<!-- nightralph:entry ticket=x:1 attempt=1 ' +
        'outcome=done -->'
    const entry:EntryInput = {
        key:'test:1',
        label:'test/01',
        attempt:1,
        now:new Date(),
        outcome:'tests',
        run:{
            exitCode:1,
            completedItems:[],
            timedOut:false,
            notes:null,
        },
        logName:'test.log',
        logTail:`some output\n${sentinel}\n${token}`,
    }

    const rendered = renderEntry(entry)
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should parse single entry')
    t.ok(
        parsed[0].body.includes(token),
        'logTail token should be preserved in body'
    )
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sentinel in logTail should be sanitized'
    )
})

test('AC1.2+: install logTail with sentinel is sanitized', t => {
    const token = randomUUID()
    const sentinel =
        '<!-- nightralph:entry ticket=x:1 attempt=1 ' +
        'outcome=done -->'
    const entry:EntryInput = {
        key:'test:2',
        label:'test/02',
        attempt:1,
        now:new Date(),
        outcome:'install',
        logName:'install.log',
        logTail:`some output\n${sentinel}\n${token}`,
    }

    const parsed = parseEntries(renderEntry(entry))

    t.equal(parsed.length, 1, 'should parse single entry')
    t.equal(parsed[0].key, 'test:2', 'should keep the original key')
    t.ok(
        parsed[0].body.includes(token),
        'install logTail token should be preserved in body'
    )
})

test('AC1.2+: error field with sentinel is sanitized', t => {
    const token = randomUUID()
    const sentinel =
        '<!-- nightralph:entry ticket=x:1 attempt=1 ' +
        'outcome=done -->'
    const entry:EntryInput = {
        key:'test:2',
        label:'test/02',
        attempt:1,
        now:new Date(),
        outcome:'error',
        error:`error occurred\n${sentinel}\n${token}`,
    }

    const rendered = renderEntry(entry)
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should parse single entry')
    t.ok(
        parsed[0].body.includes(token),
        'error token should be preserved in body'
    )
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sentinel in error should be sanitized'
    )
})

test('AC1.2+: stderr field with sentinel is sanitized', t => {
    const token = randomUUID()
    const sentinel =
        '<!-- nightralph:entry ticket=x:1 attempt=1 ' +
        'outcome=done -->'
    const entry:EntryInput = {
        key:'test:3',
        label:'test/03',
        attempt:0,
        now:new Date(),
        outcome:'merge',
        stderr:`conflict here\n${sentinel}\n${token}`,
    }

    const rendered = renderEntry(entry)
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should parse single entry')
    t.ok(
        parsed[0].body.includes(token),
        'stderr token should be preserved in body'
    )
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sentinel in stderr should be sanitized'
    )
})

test('AC1.2+: completedItems with sentinel are sanitized', t => {
    const token = randomUUID()
    const sentinel =
        '<!-- nightralph:entry ticket=x:1 attempt=1 ' +
        'outcome=done -->'
    const entry:EntryInput = {
        key:'test:4',
        label:'test/04',
        attempt:1,
        now:new Date(),
        outcome:'done',
        run:{
            exitCode:0,
            completedItems:[`item\n${sentinel}\n${token}`],
            timedOut:false,
            notes:null,
        },
    }

    const rendered = renderEntry(entry)
    const parsed = parseEntries(rendered)

    t.equal(parsed.length, 1, 'should parse single entry')
    t.ok(
        parsed[0].body.includes(token),
        'completedItems token should be preserved'
    )
    t.ok(
        parsed[0].body.includes('<!-- nightralph-entry'),
        'sentinel in completedItems should be sanitized'
    )
})

test('AC1.2+: variable-length code fence preserved', t => {
    const token = randomUUID()
    const logTail = (
        'normal line\n' +
        '````\n' +
        'backtick run of length 4\n' +
        '````\n' +
        `${token}`
    )
    const entry:EntryInput = {
        key:'test:5',
        label:'test/05',
        attempt:1,
        now:new Date(),
        outcome:'tests',
        run:{
            exitCode:1,
            completedItems:[],
            timedOut:false,
            notes:null,
        },
        logName:'test.log',
        logTail,
    }

    const rendered = renderEntry(entry)
    const parsed = parseEntries(rendered)

    t.equal(
        parsed.length,
        1,
        'should parse as single entry with 4-backtick content'
    )
    t.ok(
        parsed[0].body.includes(token),
        'token after backtick fence should be preserved'
    )

    // A content line of 4 backticks would close a shorter fence early,
    // so the opening fence must be longer than any run in the content
    const opening = rendered.split('\n').find(l => /^`{3,}$/.test(l))
    t.ok(
        opening && opening.length > 4,
        'opening fence should be longer than the content backtick run'
    )
})

// -- parseEntries: separator stripping --

test('parseEntries strips only a whole --- separator line', t => {
    const token = randomUUID()
    // No separator line, so a suffix-based strip would eat the
    // trailing --- of the body text itself
    const text =
        '<!-- nightralph:entry ticket=p:2 attempt=1 outcome=done -->\n' +
        `notes ${token}---\n`

    const parsed = parseEntries(text)

    t.equal(parsed.length, 1, 'should parse entry')
    t.ok(
        parsed[0].body.endsWith(`${token}---`),
        'body should keep a trailing --- that is not its own line'
    )
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

test('AC2.3: excludes unrelated entries and transitive blockers', t => {
    const entries:LearningEntry[] = [
        // Own entry for feat:4 (the ticket we're looking at)
        {
            key:'feat:4',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'own entry for feat:4',
        },
        // Same number in different feature (should exclude)
        {
            key:'other:4',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'other:4 should not appear',
        },
        // Unrelated feature (should exclude)
        {
            key:'unrelated:1',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'unrelated should not appear',
        },
        // Direct blocker with failures only (should exclude)
        {
            key:'blocker:1',
            attempt:1,
            outcome:'exit',
            timedOut:false,
            body:'blocker failed first',
        },
        {
            key:'blocker:1',
            attempt:2,
            outcome:'exit',
            timedOut:false,
            body:'blocker still failing',
        },
        // Blocker-of-blocker (should exclude - not in blockerKeys)
        {
            key:'blocker-of-blocker:1',
            attempt:1,
            outcome:'done',
            timedOut:false,
            body:'transitive blocker',
        },
        // Valid direct blocker's done entry (should include)
        {
            key:'direct-blocker:1',
            attempt:1,
            outcome:'exit',
            timedOut:false,
            body:'direct blocker first failed',
        },
        {
            key:'direct-blocker:1',
            attempt:2,
            outcome:'done',
            timedOut:false,
            body:'direct blocker succeeded',
        },
        {
            key:'direct-blocker:1',
            attempt:3,
            outcome:'exit',
            timedOut:false,
            body:'direct blocker failed again',
        },
    ]

    const selection = selectHistory(entries, {
        key:'feat:4',
        blockerKeys:['blocker:1', 'direct-blocker:1'],
    })

    t.equal(
        selection.own.length,
        1,
        'should have exactly one own entry'
    )
    t.equal(
        selection.own[0].key,
        'feat:4',
        'own entry should be for feat:4'
    )
    t.equal(
        selection.own[0].attempt,
        1,
        'own entry should have attempt 1'
    )
    t.equal(
        selection.blockers.length,
        1,
        'should have exactly one blocker entry'
    )
    t.equal(
        selection.blockers[0].key,
        'direct-blocker:1',
        'blocker should be direct-blocker:1'
    )
    t.equal(
        selection.blockers[0].attempt,
        2,
        'blocker should be the latest done (attempt 2)'
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

test('renderHistory with only blockers has no double blank line', t => {
    const blocker:LearningEntry = {
        key:'feat:1',
        attempt:1,
        outcome:'done',
        timedOut:false,
        body:randomUUID(),
    }
    const result = renderHistory({ own:[], blockers:[blocker] })

    t.ok(result.includes(blocker.body), 'should include blocker body')
    t.ok(!result.includes('\n\n\n'), 'should not have a double blank line')
})

// -- AC2.5: Truncation --

test('AC2.5: renderHistory truncates long entries', t => {
    const longBody = 'x'.repeat(MAX_ENTRY_CHARS * 3)
    const emptyBody = ''

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
            body:emptyBody,
        },
    ]

    const selectionA = selectHistory(entries, {
        key:'feat:1',
        blockerKeys:[],
    })

    const selectionB = selectHistory(entries, {
        key:'feat:2',
        blockerKeys:[],
    })

    const resultA = renderHistory(selectionA)
    const resultB = renderHistory(selectionB)

    // Verify truncation happened
    t.ok(
        resultA.includes(TRUNCATED_MARKER),
        'should include truncation marker for long entry'
    )

    // Verify the difference in lengths
    const lengthDiff = resultA.length - resultB.length
    const maxAllowedDiff =
        MAX_ENTRY_CHARS + TRUNCATED_MARKER.length + 1

    t.ok(
        lengthDiff <= maxAllowedDiff,
        `length difference ${lengthDiff} <= ` +
        `${maxAllowedDiff} (max)`
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

// -- Helper for git tests --

function initTempRepo ():{
    repoRoot:string
    templateDir:string
} {
    const repoRoot = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-test-')
    )
    const templateDir = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-template-')
    )

    const result = spawnSync('git', ['init', '--template=' + templateDir], {
        cwd:repoRoot,
        encoding:'utf8',
    })
    if (result.status !== 0) {
        throw new Error(`git init failed: ${result.stderr}`)
    }

    const hookResult = spawnSync(
        'git',
        ['config', 'core.hooksPath', '/dev/null'],
        { cwd:repoRoot, encoding:'utf8' }
    )
    if (hookResult.status !== 0) {
        throw new Error(
            `git config core.hooksPath failed: ${hookResult.stderr}`
        )
    }

    const excludeResult = spawnSync(
        'git',
        ['config', 'core.excludesFile', '/dev/null'],
        { cwd:repoRoot, encoding:'utf8' }
    )
    if (excludeResult.status !== 0) {
        throw new Error(
            `git config core.excludesFile failed: ${excludeResult.stderr}`
        )
    }

    const commitResult = spawnSync(
        'git',
        ['commit', '--allow-empty', '-m', 'init', '--no-verify'],
        {
            cwd:repoRoot,
            encoding:'utf8',
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        }
    )
    if (commitResult.status !== 0) {
        throw new Error(`git commit failed: ${commitResult.stderr}`)
    }

    return { repoRoot, templateDir }
}

// -- AC3.1: collectNotes returns file contents and removes file --

test('AC3.1: collectNotes returns notes file contents', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-')
    )
    try {
        const notesPath = join(dir, NOTES_PATH)
        const notesDir = dirname(notesPath)
        const content = `random token: ${randomUUID()}`

        // Create notes file
        mkdirSync(notesDir, { recursive:true })
        writeFileSync(notesPath, content)

        const result = collectNotes(dir)

        t.equal(
            result,
            content,
            'should return notes file content'
        )

        // Verify file and directory are removed
        const fileExists = existsSync(notesPath)
        const dirExists = existsSync(notesDir)

        t.equal(
            fileExists,
            false,
            'notes file should be removed'
        )
        t.equal(
            dirExists,
            false,
            'notes directory should be removed'
        )
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test(
    'AC3.1: collectNotes removes dir when no notes file exists',
    t => {
        const dir = mkdtempSync(
            join(tmpdir(), 'nightralph-learnings-')
        )
        try {
            const notesPath = join(dir, NOTES_PATH)
            const notesDir = dirname(notesPath)

            // The real setup: the dir holds only its .gitignore
            ensureNotesIgnored(dir)
            t.ok(
                existsSync(join(notesDir, '.gitignore')),
                'precondition: .gitignore exists'
            )

            const result = collectNotes(dir)

            t.equal(
                result,
                null,
                'should return null when no notes file'
            )

            const dirExists = existsSync(notesDir)
            t.equal(
                dirExists,
                false,
                '.nightralph directory should be removed'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    }
)

// -- AC3.2: collectNotes returns null for missing file or blank --

test('AC3.2: collectNotes returns null for missing file', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-')
    )
    try {
        const result = collectNotes(dir)

        t.equal(
            result,
            null,
            'should return null when notes file missing'
        )
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('AC3.2: collectNotes returns null for blank notes', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-')
    )
    try {
        const notesPath = join(dir, NOTES_PATH)
        const notesDir = dirname(notesPath)

        // Create blank notes file with only whitespace
        mkdirSync(notesDir, { recursive:true })
        writeFileSync(notesPath, '   ')

        const result = collectNotes(dir)

        t.equal(
            result,
            null,
            'should return null for whitespace-only notes'
        )
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

// -- AC3.4: readEntries returns [] for missing file --

test('AC3.4: readEntries returns empty array for missing file', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-')
    )
    try {
        const missingPath = join(dir, 'missing.md')
        const result = readEntries(missingPath)

        t.deepEqual(
            result,
            [],
            'should return empty array for missing file'
        )
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

// -- Round trip through disk --

test(
    'appendEntry and readEntries round-trip entries correctly',
    t => {
        const dir = mkdtempSync(
            join(tmpdir(), 'nightralph-learnings-')
        )
        try {
            const logPath = join(dir, 'subdir', 'learnings.md')

            const entry1:EntryInput = {
                key:'feat:1',
                label:'feat/01',
                attempt:1,
                now:new Date('2026-10-06T14:30:00'),
                outcome:'done',
                run:{
                    exitCode:0,
                    completedItems:['item 1', 'item 2'],
                    timedOut:false,
                    notes:'some notes',
                },
            }

            const entry2:EntryInput = {
                key:'feat:2',
                label:'feat/02',
                attempt:1,
                now:new Date('2026-10-06T15:00:00'),
                outcome:'done',
                run:{
                    exitCode:0,
                    completedItems:[],
                    timedOut:false,
                    notes:null,
                },
            }

            const rendered1 = renderEntry(entry1)
            const rendered2 = renderEntry(entry2)

            appendEntry(logPath, rendered1)
            appendEntry(logPath, rendered2)

            const parsed = readEntries(logPath)

            t.equal(
                parsed.length,
                2,
                'should read 2 entries'
            )
            t.equal(
                parsed[0].key,
                'feat:1',
                'first entry key correct'
            )
            t.equal(
                parsed[1].key,
                'feat:2',
                'second entry key correct'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    }
)

// -- AC3.3: ensureNotesIgnored git check-ignore works --

test('AC3.3: ensureNotesIgnored creates .gitignore', t => {
    const repoRoot = mkdtempSync(
        join(tmpdir(), 'nightralph-learnings-')
    )
    try {
        ensureNotesIgnored(repoRoot)

        const gitignorePath = join(repoRoot, '.nightralph', '.gitignore')
        const exists = existsSync(gitignorePath)
        t.equal(exists, true, '.gitignore should exist')

        t.equal(
            readFileSync(gitignorePath, 'utf8'),
            '*\n',
            '.gitignore should contain "*\\n"'
        )
    } finally {
        rmSync(repoRoot, { recursive:true, force:true })
    }
})

test(
    'AC3.3: ensureNotesIgnored hermetic git repo with ' +
    'empty template and core.excludesFile',
    t => {
        const { repoRoot, templateDir } = initTempRepo()
        try {
            // Snapshot info/exclude before ensureNotesIgnored
            const excludePath = join(repoRoot, '.git', 'info', 'exclude')
            const excludeContentBefore = existsSync(excludePath) ?
                readFileSync(excludePath, 'utf8') :
                null

            // Call ensureNotesIgnored twice (should be idempotent)
            ensureNotesIgnored(repoRoot)
            ensureNotesIgnored(repoRoot)

            // Write notes file
            const notesPath = join(repoRoot, NOTES_PATH)
            mkdirSync(dirname(notesPath), { recursive:true })
            writeFileSync(notesPath, 'test notes')

            // git check-ignore should exit 0
            const checkIgnore = spawnSync(
                'git',
                ['check-ignore', '-q', '.nightralph/notes.md'],
                { cwd:repoRoot, encoding:'utf8' }
            )
            t.equal(
                checkIgnore.status,
                0,
                'git check-ignore should exit 0'
            )

            // git status --porcelain should show nothing
            const status = spawnSync(
                'git',
                ['status', '--porcelain'],
                { cwd:repoRoot, encoding:'utf8' }
            )
            t.equal(
                status.stdout,
                '',
                'git status should show no changes (gitignore ignored)'
            )

            // Verify info/exclude is unchanged
            const excludeContentAfter = existsSync(excludePath) ?
                readFileSync(excludePath, 'utf8') :
                null
            t.equal(
                excludeContentAfter,
                excludeContentBefore,
                'info/exclude should be unchanged'
            )

            // Verify it's not a symlink
            // lstat, not existsSync: a dangling link must still count
            const isLink = lstatSync(excludePath, { throwIfNoEntry:false })
                ?.isSymbolicLink() ?? false
            t.equal(
                isLink,
                false,
                'info/exclude must not be a symlink ' +
                '(should be regular file or not exist)'
            )
        } finally {
            rmSync(repoRoot, { recursive:true, force:true })
            rmSync(templateDir, { recursive:true, force:true })
        }
    }
)

test(
    'AC3.3 worktree: ensureNotesIgnored in linked worktree',
    t => {
        const { repoRoot, templateDir } = initTempRepo()
        let worktreePath:string|undefined

        try {
            // Create a linked worktree
            worktreePath = join(
                dirname(repoRoot),
                `${basename(repoRoot)}.worktree`
            )

            const addWorktree = spawnSync(
                'git',
                ['worktree', 'add', worktreePath, '-b', 'test-branch'],
                { cwd:repoRoot, encoding:'utf8' }
            )
            if (addWorktree.status !== 0) {
                throw new Error(
                    `git worktree add failed: ${addWorktree.stderr}`
                )
            }

            // Call ensureNotesIgnored in the worktree
            ensureNotesIgnored(worktreePath)

            // Write notes file in worktree
            const notesPath = join(worktreePath, NOTES_PATH)
            mkdirSync(dirname(notesPath), { recursive:true })
            writeFileSync(notesPath, 'worktree notes')

            // git check-ignore should exit 0 in worktree
            const checkIgnore = spawnSync(
                'git',
                ['check-ignore', '-q', '.nightralph/notes.md'],
                { cwd:worktreePath, encoding:'utf8' }
            )
            t.equal(
                checkIgnore.status,
                0,
                'git check-ignore in worktree should exit 0'
            )

            // git status --porcelain should show nothing in worktree
            const status = spawnSync(
                'git',
                ['status', '--porcelain'],
                { cwd:worktreePath, encoding:'utf8' }
            )
            t.equal(
                status.stdout,
                '',
                'git status in worktree should show no changes'
            )
        } finally {
            if (worktreePath) {
                const removeWorktree = spawnSync(
                    'git',
                    ['worktree', 'remove', '--force', worktreePath],
                    { cwd:repoRoot, encoding:'utf8' }
                )
                if (removeWorktree.status !== 0) {
                    rmSync(worktreePath, { recursive:true, force:true })
                }
            }
            rmSync(repoRoot, { recursive:true, force:true })
            rmSync(templateDir, { recursive:true, force:true })
        }
    }
)
