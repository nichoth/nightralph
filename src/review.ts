import { dirname } from 'node:path'
import { NOTES_PATH, formatDate } from './learnings.js'

export const FINDINGS_FILE = 'findings.md'
export const FINDINGS_PATH = `${dirname(NOTES_PATH)}/${FINDINGS_FILE}`
export const NO_FINDINGS = 'No findings.'
// Bookkeeping lives here (tickets, progress, learnings, the
// review log), so the review never looks at it.
export const REVIEW_EXCLUDE = '.scratch'

const SENTINEL_PREFIX = '<!-- nightralph:review'
const SENTINEL_RE = /^<!-- nightralph:review (.*) -->$/
const SHA_RE = /^[0-9a-f]{4,64}$/
const FIX_HEADING = '### Fix'
const FINDING_RE = /^ ?[-*+]\s+\[([ xX])\]\s+(.+)$/

export const REVIEW_STATUSES = [
    'clean', 'fixed', 'unresolved', 'review-failed',
] as const

export type ReviewStatus = typeof REVIEW_STATUSES[number]

export type Finding = {
    summary:string
    detail:string
    checked:boolean
}

export type FixRecord = {
    attempts:number
    maxAttempts:number
    effort?:string
    exitCode:number|null
    result:string
    notes:string|null
}

export type ReviewEntryInput = {
    from:string
    to:string
    status:ReviewStatus
    now:Date
    findings:Finding[]
    fix?:FixRecord
}

export type ReviewEntry = {
    from:string
    to:string
    status:ReviewStatus
    findings:Finding[]
    body:string
}

export type ReviewOutcome = {
    status:ReviewStatus|'skipped'
    findings:number
    fixed:number
}

function isReviewStatus (value:string):value is ReviewStatus {
    return (REVIEW_STATUSES as readonly string[]).includes(value)
}

function collapse (s:string):string {
    return s.replace(/\s+/g, ' ').trim()
}

function normalize (s:string):string {
    return collapse(s).toLowerCase()
}

function sanitize (text:string):string {
    return text.replace(
        new RegExp(SENTINEL_PREFIX, 'g'),
        '<!-- nightralph-review'
    )
}

function splitLines (text:string):string[] {
    return text.split('\n').map(line => {
        return line.endsWith('\r') ? line.slice(0, -1) : line
    })
}

// The reviewer's checklist: `- [ ] summary` lines, each followed
// by its detail lines. [] for an explicit "No findings.", null
// when the text is neither, which fails the review attempt.
export function parseFindings (text:string):Finding[]|null {
    const findings:Finding[] = []
    const details:string[][] = []
    for (const line of splitLines(text)) {
        const m = line.match(FINDING_RE)
        if (m) {
            findings.push({
                summary:collapse(m[2]),
                detail:'',
                checked:m[1] !== ' ',
            })
            details.push([])
        } else if (findings.length > 0 && line.trim()) {
            details[details.length - 1].push(line.trim())
        }
    }
    if (findings.length > 0) {
        return findings.map((f, i) => {
            return { ...f, detail:details[i].join('\n') }
        })
    }
    const clean = splitLines(text).some(line => {
        return normalize(line) === NO_FINDINGS.toLowerCase()
    })
    return clean ? [] : null
}

// Checks off the findings the fixer echoed as `[x] <summary>`,
// compared loosely like ticket checklist items.
export function markFixed (
    findings:ReadonlyArray<Finding>,
    completedItems:ReadonlyArray<string>
):Finding[] {
    const done = new Set(completedItems.map(normalize))
    return findings.map(f => {
        return { ...f, checked:done.has(normalize(f.summary)) }
    })
}

function headline (input:ReviewEntryInput):string {
    const n = input.findings.length
    const fixed = input.findings.filter(f => f.checked).length
    switch (input.status) {
        case 'clean': return 'no findings'
        case 'fixed': return `${fixed} of ${n} fixed`
        case 'unresolved': return `${n} findings, fix failed`
        case 'review-failed': return 'review failed'
        default: {
            const _exhaustive:never = input.status
            return _exhaustive
        }
    }
}

function renderFindings (input:ReviewEntryInput):string[] {
    if (input.status === 'review-failed') {
        return ['The reviewer left no usable findings file.']
    }
    if (input.findings.length === 0) return [NO_FINDINGS]
    return input.findings.flatMap(f => {
        const box = f.checked ? '[x]' : '[ ]'
        const detail = f.detail ?
            f.detail.split('\n').map(l => `    ${sanitize(l)}`) :
            []
        return [`- ${box} ${sanitize(collapse(f.summary))}`, ...detail]
    })
}

function renderFix (fix?:FixRecord):string[] {
    if (!fix) return []
    return [
        '',
        FIX_HEADING,
        `- attempts: ${fix.attempts} of ${fix.maxAttempts}`,
        ...(fix.effort ? [`- effort: ${fix.effort}`] : []),
        `- agent exit code: ${fix.exitCode ?? 'none'}`,
        `- result: ${sanitize(fix.result)}`,
        '',
        fix.notes ? sanitize(fix.notes) : 'The fixer left no notes.',
    ]
}

export function renderReviewEntry (input:ReviewEntryInput):string {
    return [
        `${SENTINEL_PREFIX} from=${input.from} to=${input.to} ` +
            `status=${input.status} -->`,
        `## ${formatDate(input.now)} -- review ` +
            `${input.from.slice(0, 7)}..${input.to.slice(0, 7)} ` +
            `-- ${headline(input)}`,
        ...renderFindings(input),
        ...renderFix(input.fix),
        '---',
        '',
    ].join('\n')
}

function parseEntry (
    sentinel:string,
    bodyLines:string[]
):ReviewEntry|null {
    const attrs:Record<string, string> = {}
    for (const part of sentinel.split(/\s+/).filter(Boolean)) {
        const idx = part.indexOf('=')
        if (idx > 0) attrs[part.slice(0, idx)] = part.slice(idx + 1)
    }
    const { from, to, status } = attrs
    if (!from || !SHA_RE.test(from)) return null
    if (!to || !SHA_RE.test(to)) return null
    if (!status || !isReviewStatus(status)) return null

    const lines = [...bodyLines]
    while (lines.length > 0 && !lines[lines.length - 1].trim()) {
        lines.pop()
    }
    if (lines[lines.length - 1] === '---') lines.pop()
    const fixAt = lines.indexOf(FIX_HEADING)
    const findingLines = fixAt === -1 ? lines : lines.slice(0, fixAt)
    return {
        from,
        to,
        status,
        findings:parseFindings(findingLines.join('\n')) ?? [],
        body:lines.join('\n').trim(),
    }
}

// Malformed entries are dropped, not thrown; text before the
// first sentinel is ignored.
export function parseReviewEntries (text:string):ReviewEntry[] {
    const entries:ReviewEntry[] = []
    let sentinel:string|null = null
    let body:string[] = []
    const flush = ():void => {
        if (sentinel === null) return
        const entry = parseEntry(sentinel, body)
        if (entry) entries.push(entry)
    }
    for (const line of splitLines(text)) {
        const m = line.match(SENTINEL_RE)
        if (m) {
            flush()
            sentinel = m[1]
            body = []
        } else if (sentinel !== null) {
            body.push(line)
        }
    }
    flush()
    return entries
}

// Where the review range starts: the last reviewed commit while
// it is still on this branch, else the fork point from the
// default branch, else the commit the run started from.
export function selectReviewBase (
    entries:ReadonlyArray<ReviewEntry>,
    opts:{
        isAncestor:(sha:string) => boolean
        forkPoint:string|null
        launchCommit:string
    }
):string {
    const last = [...entries].reverse().find(e => {
        return e.status !== 'review-failed'
    })
    if (last && opts.isAncestor(last.to)) return last.to
    return opts.forkPoint ?? opts.launchCommit
}

// One line for the finish summary; null when no review ran.
export function renderReviewSummary (
    outcome:ReviewOutcome,
    reviewPath:string
):string|null {
    const see = ` -- see ${reviewPath}`
    const plural = outcome.findings === 1 ? '' : 's'
    switch (outcome.status) {
        case 'skipped': return null
        case 'clean': return `Review: no findings${see}`
        case 'fixed':
            return `Review: ${outcome.findings} finding${plural}, ` +
                `${outcome.fixed} fixed${see}`
        case 'unresolved':
            return `Review: ${outcome.findings} finding${plural}, ` +
                `fix failed${see}`
        case 'review-failed':
            return `Review: the reviewer failed${see}`
        default: {
            const _exhaustive:never = outcome.status
            return _exhaustive
        }
    }
}
