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
    body:string
}

type EntryBase = {
    key:string
    label:string
    attempt:number
    now:Date
}

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
    return LEARNING_OUTCOMES.includes(value as LearningOutcome)
}

// -- Task 1: renderEntry --

export function renderEntry (input:EntryInput):string {
    const encodedKey = encodeKey(input.key)

    const timedOutStr = 'run' in input && input.run.timedOut
        ? ' timedout=true'
        : ''

    const sentinel =
        `<!-- nightralph:entry ticket=${encodedKey} ` +
        `attempt=${input.attempt} outcome=${input.outcome}${timedOutStr} -->`

    const timestamp = formatDate(input.now)
    const attemptStr = input.outcome === 'merge' ? '' : ` attempt ${input.attempt}`

    let description:string

    if (input.outcome === 'done') {
        description = 'done'
    } else if (input.outcome === 'exit') {
        const run = input.run
        description = `failed (exit ${run.exitCode})`
    } else if (input.outcome === 'tests') {
        description = 'failed (tests)'
    } else if (input.outcome === 'install') {
        description = 'failed (install)'
    } else if (input.outcome === 'no-commits') {
        description = 'no commits'
    } else if (input.outcome === 'error') {
        description = 'error'
    } else if (input.outcome === 'merge') {
        description = 'merge failed'
    } else {
        description = input.outcome
    }

    const timedOutPrefix = 'run' in input && input.run.timedOut
        ? 'timed out, then '
        : ''

    const heading =
        `## ${timestamp} -- ${input.label}${attemptStr} -- ` +
        `${timedOutPrefix}${description}`

    let body:string

    if (input.outcome === 'done' || input.outcome === 'exit' ||
        input.outcome === 'no-commits') {
        const run = input.run

        const effortLine = input.effort
            ? `Effort: ${input.effort}.`
            : ''

        const exitLine = `Agent exit: ${run.exitCode}.`

        const itemsText = run.completedItems.length > 0
            ? run.completedItems.map(item => `"${sanitize(item)}"`).join(', ') + '.'
            : 'none.'

        const itemsLine = `Checked items: ${itemsText}`

        const mainPart = [
            effortLine,
            exitLine,
            itemsLine,
        ].filter(Boolean).join(' ')

        const notesSanitized = sanitize(run.notes)
        const notesSection = notesSanitized.trim()
            ? `### Agent notes\n${notesSanitized}`
            : 'The agent left no notes.'

        body = mainPart + '\n\n' + notesSection
    } else if (input.outcome === 'tests' || input.outcome === 'install') {
        const prefix = input.outcome === 'tests'
            ? 'Test gate failed.'
            : 'Install failed.'

        const logTail = sanitize(input.logTail)
        const fenced = fence(logTail)

        if (input.outcome === 'tests') {
            const runNotes = input.run.notes
            const notesSanitized = sanitize(runNotes)
            const notesSection = notesSanitized.trim()
                ? `### Agent notes\n${notesSanitized}`
                : 'The agent left no notes.'

            body =
                `${prefix}\nLast ${LOG_TAIL_LINES} lines of \`${sanitize(input.logName)}\`:\n` +
                `${fenced}\n\n${notesSection}`
        } else {
            body =
                `${prefix}\nLast ${LOG_TAIL_LINES} lines of \`${sanitize(input.logName)}\`:\n` +
                fenced
        }
    } else if (input.outcome === 'error') {
        const errorText = sanitize(input.error)
        const fenced = fence(errorText)
        body = fenced
    } else if (input.outcome === 'merge') {
        const stderrText = sanitize(input.stderr)
        const fenced = fence(stderrText)
        body = `Merge failed.\n${fenced}`
    } else {
        body = ''
    }

    return `${sentinel}\n${heading}\n\n${body}\n\n---\n`
}

// -- Task 2: parseEntries --

export function parseEntries (text:string):LearningEntry[] {
    const lines = text.split('\n')
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
        const [key, value] = part.split('=')
        if (key && value) {
            attrs[key] = value
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

    const attempt = parseInt(attemptStr, 10)
    if (!Number.isInteger(attempt) || attempt < 0) return null

    // Validate outcome
    const outcome = attrs.outcome
    if (!outcome || !isLearningOutcome(outcome)) return null

    // Parse timedOut
    const timedOut = attrs.timedout === 'true'

    // Parse body
    let body = bodyLines.join('\n').trim()

    // Remove trailing --- separator
    if (body.endsWith('---')) {
        body = body.slice(0, -3).trim()
    }

    return {
        key,
        attempt,
        outcome,
        timedOut,
        body,
    }
}

// -- Task 2: selectHistory --

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

// -- Task 2: renderHistory --

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
        parts.push(
            ...selection.own.map(e => capEntry(e)).join('\n\n').split('\n')
        )
    }

    if (selection.blockers.length > 0) {
        parts.push('---- WHAT THE BLOCKING TICKETS DID ----')
        parts.push(
            ...selection.blockers.map(e => capEntry(e)).join('\n\n').split('\n')
        )
    }

    return parts.join('\n')
}

function capEntry (entry:LearningEntry):string {
    if (entry.body.length <= MAX_ENTRY_CHARS) {
        return entry.body
    }

    return entry.body.slice(0, MAX_ENTRY_CHARS) + '\n' + TRUNCATED_MARKER
}

// -- Task 2: tailLines --

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

// -- Task 2: learningsPathFor --

export function learningsPathFor (progressPath:string):string {
    return join(dirname(progressPath), 'learnings.md')
}
