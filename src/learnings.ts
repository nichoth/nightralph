import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// -- Constants and types --

export const MAX_OWN_ENTRIES = 4
export const MAX_ENTRY_CHARS = 4000
export const LOG_TAIL_LINES = 40
export const NOTES_PATH = '.nightralph/notes.md'

const SENTINEL_PREFIX = '<!-- nightralph:entry'
export const TRUNCATED_MARKER = '[truncated]'

export const LEARNING_OUTCOMES = [
    'done',
    'exit',
    'tests',
    'install',
    'no-commits',
    'error',
    'merge',
] as const
export type LearningOutcome = typeof LEARNING_OUTCOMES[number]

export type LearningEntry = {
    key:string
    attempt:number
    outcome:LearningOutcome
    timedOut:boolean
    // Everything after the sentinel line, trimmed, without
    // the trailing `---` separator
    body:string
}

type EntryBase = {
    key:string  // ticketKey(feature, num)
    label:string  // ticketLabel(ticket), e.g. "my-feature/04"
    attempt:number  // 0 for merge entries
    now:Date
}

// What one agent process did. Phase 4 attaches this to every attempt
// outcome where an agent actually ran.
export type AgentRunRecord = {
    exitCode:number
    completedItems:string[]
    timedOut:boolean
    notes:string|null
}

type AgentFields = { run:AgentRunRecord; effort?:string }

type LogTail = { logName:string; logTail:string }

export type EntryInput = EntryBase&(
    | (AgentFields&{ outcome:'done'|'exit'|'no-commits' })
    | (AgentFields&LogTail&{ outcome:'tests' })
    | (LogTail&{ outcome:'install' })
    | { outcome:'error'; error:string }
    | { outcome:'merge'; stderr:string }
)

export type HistorySelection = {
    own:LearningEntry[]
    blockers:LearningEntry[]
}

// -- Helpers --

function encodeKey (key:string):string {
    return key
        .replace(/%/g, '%25')
        .replace(/\s/g, c => encodeURIComponent(c))
}

function fence (content:string):string {
    const longest = Math.max(
        0,
        ...[...content.matchAll(/`+/g)].map(m => m[0].length)
    )
    const ticks = '`'.repeat(Math.max(3, longest + 1))
    return `${ticks}\n${content}\n${ticks}`
}

function sanitize (text:string|null):string {
    if (!text) return ''
    return text.replace(
        new RegExp(SENTINEL_PREFIX, 'g'),
        '<!-- nightralph-entry'
    )
}

function renderAgentSummary (
    run:AgentRunRecord,
    effort?:string
):string {
    const effortLine = effort ?
        `Effort: ${effort}.` :
        ''

    const exitLine = `Agent exit: ${run.exitCode}.`

    const itemsText = run.completedItems.length > 0 ?
        run.completedItems.map(item =>
            `"${sanitize(item)}"`
        ).join(', ') + '.' :
        'none.'

    const itemsLine = `Checked items: ${itemsText}`

    return [
        effortLine,
        exitLine,
        itemsLine,
    ].filter(Boolean).join(' ')
}

function renderNotesSection (notes:string|null):string {
    const notesSanitized = sanitize(notes)
    return notesSanitized.trim() ?
        `### Agent notes\n${notesSanitized}` :
        'The agent left no notes.'
}

function formatDate (date:Date):string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
}

export function isLearningOutcome (
    value:string
):value is LearningOutcome {
    return LEARNING_OUTCOMES.some(o => o === value)
}

export function renderEntry (input:EntryInput):string {
    const encodedKey = encodeKey(input.key)

    const hasRun = 'run' in input
    const timedOut = hasRun && input.run.timedOut

    const timedOutStr = timedOut ?
        ' timedout=true' :
        ''

    const sentinel =
        `<!-- nightralph:entry ticket=${encodedKey} ` +
        `attempt=${input.attempt} outcome=${input.outcome}` +
        `${timedOutStr} -->`

    const timestamp = formatDate(input.now)
    const attemptStr = input.outcome === 'merge' ?
        '' :
        ` attempt ${input.attempt}`

    let description:string

    switch (input.outcome) {
        case 'done':
            description = 'done'
            break
        case 'exit':
            description = `failed (exit ${input.run.exitCode})`
            break
        case 'tests':
            description = 'failed (tests)'
            break
        case 'install':
            description = 'failed (install)'
            break
        case 'no-commits':
            description = 'no commits'
            break
        case 'error':
            description = 'error'
            break
        case 'merge':
            description = 'merge failed'
            break
        default: {
            const _exhaustive:never = input
            description = _exhaustive
        }
    }

    const timedOutPrefix = timedOut ?
        'timed out, then ' :
        ''

    const heading =
        `## ${timestamp} -- ${input.label}${attemptStr} -- ` +
        `${timedOutPrefix}${description}`

    let body:string

    switch (input.outcome) {
        case 'done':
        case 'exit':
        case 'no-commits': {
            const run = input.run
            const summary = renderAgentSummary(run, input.effort)
            const notesSection = renderNotesSection(run.notes)
            body = summary + '\n\n' + notesSection
            break
        }
        case 'tests': {
            const logTail = sanitize(input.logTail)
            const fenced = fence(logTail)
            const summary = renderAgentSummary(
                input.run,
                input.effort
            )
            const notesSection = renderNotesSection(input.run.notes)

            const lastNLines =
                `Last ${LOG_TAIL_LINES} lines of ` +
                `\`${sanitize(input.logName)}\`:`

            body =
                summary + '\n\n' +
                'Test gate failed.\n' +
                `${lastNLines}\n` +
                `${fenced}\n\n` +
                notesSection
            break
        }
        case 'install': {
            const logTail = sanitize(input.logTail)
            const fenced = fence(logTail)

            const lastNLines =
                `Last ${LOG_TAIL_LINES} lines of ` +
                `\`${sanitize(input.logName)}\`:`

            body =
                'Install failed.\n' +
                `${lastNLines}\n` +
                fenced
            break
        }
        case 'error': {
            const errorText = sanitize(input.error)
            const fenced = fence(errorText)
            body = fenced
            break
        }
        case 'merge': {
            const stderrText = sanitize(input.stderr)
            const fenced = fence(stderrText)
            body = `Merge failed.\n${fenced}`
            break
        }
        default: {
            const unknown:never = input
            throw new Error(`Unknown outcome: ${JSON.stringify(unknown)}`)
        }
    }

    return `${sentinel}\n${heading}\n\n${body}\n\n---\n`
}

export function parseEntries (text:string):LearningEntry[] {
    const lines = text.split('\n').map(line => {
        // Strip trailing \r for CRLF support
        return line.endsWith('\r') ? line.slice(0, -1) : line
    })
    const entries:LearningEntry[] = []

    let currentSentinel:string|null = null
    let currentBody:string[] = []

    const sentinelRegex = /^<!-- nightralph:entry (.*) -->$/

    for (const line of lines) {
        const match = line.match(sentinelRegex)

        if (match) {
            // Process previous entry if exists
            if (currentSentinel !== null) {
                const entry = parseSentinel(currentSentinel, currentBody)
                if (entry) {
                    entries.push(entry)
                }
            }

            currentSentinel = match[1]
            currentBody = []
        } else if (currentSentinel !== null) {
            currentBody.push(line)
        }
    }

    // Process last entry
    if (currentSentinel !== null) {
        const entry = parseSentinel(currentSentinel, currentBody)
        if (entry) {
            entries.push(entry)
        }
    }

    return entries
}

function parseSentinel (
    sentinel:string,
    bodyLines:string[]
):LearningEntry|null {
    const parts = sentinel.split(/\s+/).filter(Boolean)
    const attrs:Record<string, string> = {}

    for (const part of parts) {
        const idx = part.indexOf('=')
        if (idx > 0) {
            const key = part.slice(0, idx)
            const value = part.slice(idx + 1)
            if (value) {
                attrs[key] = value
            }
        }
    }

    // Validate ticket
    let key = attrs.ticket
    if (!key) return null

    try {
        key = decodeURIComponent(key)
    } catch (_e) {
        return null
    }

    if (!key.trim()) return null

    // Validate attempt
    const attemptStr = attrs.attempt
    if (!attemptStr) return null

    if (!/^\d+$/.test(attemptStr)) return null
    const attempt = Number(attemptStr)

    // Validate outcome
    const outcome = attrs.outcome
    if (!outcome || !isLearningOutcome(outcome)) return null

    // Parse timedOut
    const timedOut = attrs.timedout === 'true'

    // Parse body
    let body = bodyLines.join('\n').trim()

    // Remove trailing --- line (full line only)
    const lines = body.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '---') {
        body = lines.slice(0, -1).join('\n').trim()
    }

    return {
        key,
        attempt,
        outcome,
        timedOut,
        body,
    }
}

export function selectHistory (
    entries:LearningEntry[],
    opts:{ key:string; blockerKeys:string[] }
):HistorySelection {
    const own = entries
        .filter(e => e.key === opts.key)
        .slice(-MAX_OWN_ENTRIES)

    const blockers = opts.blockerKeys.flatMap(k => {
        const done = entries.filter(e => {
            return e.key === k && e.outcome === 'done'
        })
        const last = done[done.length - 1]
        return last ? [last] : []
    })

    return { own, blockers }
}

export function renderHistory (selection:HistorySelection):string {
    if (selection.own.length === 0 && selection.blockers.length === 0) {
        return ''
    }

    const framing =
        'These are records of earlier runs. The ticket or spec may ' +
        'have changed since then; where they disagree, follow the ' +
        'ticket and spec. Do not repeat an approach these notes say ' +
        'failed unless you can see why it failed.'

    const parts = [framing, '']

    if (selection.own.length > 0) {
        parts.push('---- PREVIOUS ATTEMPTS AT THIS TICKET ----')
        parts.push(selection.own.map(e => capEntry(e)).join('\n\n'))
        parts.push('')
    }

    if (selection.blockers.length > 0) {
        parts.push('---- WHAT THE BLOCKING TICKETS DID ----')
        parts.push(selection.blockers.map(e => capEntry(e)).join('\n\n'))
    }

    return parts.join('\n')
}

function capEntry (entry:LearningEntry):string {
    if (entry.body.length <= MAX_ENTRY_CHARS) {
        return entry.body
    }

    return entry.body.slice(0, MAX_ENTRY_CHARS) + '\n' + TRUNCATED_MARKER
}

export function tailLines (text:string, n:number):string {
    let lines = text.split('\n')

    // Remove empty string at end if text ended with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines = lines.slice(0, -1)
    }

    // Keep last n
    if (lines.length > n) {
        lines = lines.slice(-n)
    }

    return lines.join('\n')
}

export function learningsPathFor (progressPath:string):string {
    return join(dirname(progressPath), 'learnings.md')
}

// -- IO functions --

// A missing log means no history yet. Any other read error (e.g.
// the path is a directory) is thrown for the caller to report.
export function readEntries (path:string):LearningEntry[] {
    if (!existsSync(path)) return []
    return parseEntries(readFileSync(path, 'utf8'))
}

// Synchronous on purpose: tickets in a wave run concurrently in one
// Node thread, so sync appends can never interleave.
export function appendEntry (path:string, text:string):void {
    mkdirSync(dirname(path), { recursive:true })
    appendFileSync(path, text)
}

// Reads the agent's notes and removes the whole notes directory
// (also when there are no notes), so nothing in it can reach a
// commit. Blank notes count as none.
export function collectNotes (worktreePath:string):string|null {
    const notesPath = join(worktreePath, NOTES_PATH)
    const text = existsSync(notesPath) ?
        readFileSync(notesPath, 'utf8').trim() :
        ''
    rmSync(dirname(notesPath), { recursive:true, force:true })
    return text || null
}

// Makes the notes directory ignore itself, so an agent's
// `git add -A` cannot stage its notes. Deliberately not
// info/exclude: that file can be a symlink shared by every repo on
// the machine (e.g. via init.templateDir).
export function ensureNotesIgnored (worktreePath:string):void {
    const dir = join(worktreePath, dirname(NOTES_PATH))
    mkdirSync(dir, { recursive:true })
    writeFileSync(join(dir, '.gitignore'), '*\n')
}
