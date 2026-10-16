import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import {
    NOTES_PATH,
    formatDate,
    collectNotes,
    ensureNotesIgnored,
    appendEntry,
} from './learnings.js'
import { runTestCmd } from './testcmd.js'
import { commitProgress } from './progress.js'
import { runWithRetries, type EffortLevel } from './retry.js'
import {
    createNamedWorktree,
    deleteBranch,
    removeWorktree,
    commitDirty,
    hasNewCommits,
    isDirty,
    hasChangesOutside,
    headCommit,
    isAncestor,
    mergeBase,
} from './worktree.js'
import { mergeBranch } from './merge.js'
import type { AgentResult } from './orchestrator.js'
import {
    readDocsRule,
    installRule,
    subagentRule,
    testGateRule,
    LINT_RULE,
    integrityRule,
    CONFINEMENT_RULES,
    commitRule,
    notesRule,
    agentsMdRule,
} from './rules.js'

export const FINDINGS_FILE = 'findings.md'
export const FINDINGS_PATH = `${dirname(NOTES_PATH)}/${FINDINGS_FILE}`
export const NO_FINDINGS = 'No findings.'
// Bookkeeping lives here (tickets, progress, learnings, the
// review log), so the review never looks at it.
export const REVIEW_EXCLUDE = '.scratch'

export const REVIEW_MARKER = '---- REVIEW INSTRUCTIONS ----'
export const FIX_MARKER = '---- REVIEW FINDINGS ----'

// The bookkeeping directory for a review log: the nearest ancestor
// of reviewPath named .scratch, relative to the repo root, so a run
// launched from a subdirectory excludes the right path. Falls back
// to REVIEW_EXCLUDE when reviewPath is not under a .scratch.
export function reviewExcludeFor (
    repoRoot:string,
    reviewPath:string
):string {
    let dir = dirname(reviewPath)
    while (dirname(dir) !== dir) {
        if (basename(dir) === '.scratch') {
            const rel = relative(repoRoot, dir)
            if (rel && !rel.startsWith('..')) return rel
            break
        }
        dir = dirname(dir)
    }
    return REVIEW_EXCLUDE
}

export function reviewDiffCommand (
    from:string,
    to:string,
    exclude:string = REVIEW_EXCLUDE
):string {
    return `git diff ${from}..${to} -- . ':(exclude)${exclude}'`
}

export function renderReviewPrompt (opts:{
    specBody:string
    from:string
    to:string
    exclude?:string
    preferSubagent?:string
}):string {
    return [
        '---- SPEC CONTEXT ----',
        opts.specBody,
        '',
        REVIEW_MARKER,
        'You are reviewing work that autonomous agents merged ' +
            'into this branch, one ticket at a time. Review the ' +
            'combined change as a whole.',
        '',
        'The change to review:',
        '',
        `    ${reviewDiffCommand(opts.from, opts.to, opts.exclude)}`,
        '',
        'Follow these rules:',
        '- Read any AGENTS.md in or above the directories the ' +
            'change touches, plus CONTEXT.md and the relevant ' +
            'docs/adr/ entries if they exist. Treat their ' +
            'contracts and the spec above as the standard the ' +
            'code must meet.',
        '- Look for correctness bugs, missing or weak tests, ' +
            'and code that breaks a documented contract. Ignore ' +
            'style preferences.',
        '- You may run the tests or the type checker to confirm ' +
            'a suspicion.',
        ...subagentRule(opts.preferSubagent, true),
        '- Do NOT edit, stage, or commit code. Anything you ' +
            'change here is discarded.',
        ...CONFINEMENT_RULES,
        '',
        `Write your findings to \`${FINDINGS_PATH}\` (create the ` +
            'directory), most severe first, in exactly this form:',
        '',
        '- [ ] <one-line summary of the finding>',
        '    <file:line, and a concrete input or state that goes ' +
            'wrong>',
        '',
        'If you find nothing worth fixing, write the single line: ' +
            NO_FINDINGS,
        'Never git add or commit that file; the orchestrator ' +
            'collects it.',
        '',
    ].join('\n')
}

export type FixFailure =
    'install'|'exit'|'no-commits'|'tests'|'merge'

export const FIX_FAILURE_TEXT:Record<FixFailure, string> = {
    install: 'dependency install failed',
    exit: 'the agent exited with an error',
    'no-commits': 'the agent made no commits',
    tests: 'the test command failed after the agent finished',
    merge: 'the fix branch did not merge cleanly',
}

function findingLines (findings:ReadonlyArray<Finding>):string[] {
    return findings.flatMap(f => [
        `- [ ] ${f.summary}`,
        ...(f.detail ?
            f.detail.split('\n').map(l => `    ${l}`) :
            []),
    ])
}

function previousBlock (
    previous?:{ reason:FixFailure; notes:string|null }
):string[] {
    if (!previous) return []
    return [
        '---- PREVIOUS FIX ATTEMPT ----',
        `It failed: ${FIX_FAILURE_TEXT[previous.reason]}.`,
        previous.notes ?? 'It left no notes.',
        '',
    ]
}

export function renderFixPrompt (opts:{
    specBody:string
    findings:ReadonlyArray<Finding>
    testCmd:string
    installCmd?:string
    preferSubagent?:string
    previous?:{ reason:FixFailure; notes:string|null }
}):string {
    return [
        '---- SPEC CONTEXT ----',
        opts.specBody,
        '',
        FIX_MARKER,
        ...findingLines(opts.findings),
        '',
        ...previousBlock(opts.previous),
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent. Fix the review ' +
            'findings above using /tdd.',
        '',
        'Follow these rules:',
        readDocsRule('findings'),
        '- Fix ONLY the listed findings. Do not fix unrelated ' +
            'problems you notice.',
        ...installRule(opts.installCmd),
        ...subagentRule(opts.preferSubagent),
        '- Use /tdd for every finding: write a failing test that ' +
            'shows the problem, then write only enough code to ' +
            'make it pass, then refactor.',
        testGateRule(opts.testCmd, 'fix'),
        LINT_RULE,
        integrityRule('finding'),
        ...CONFINEMENT_RULES,
        commitRule('finding'),
        notesRule('finding', 'fix'),
        '- After fixing each finding, print a line: ' +
            '[x] <finding summary> (matching the summary ' +
            'text exactly).',
        '- If a finding is wrong or cannot be fixed honestly, ' +
            'leave it unchecked and explain why in your notes ' +
            'file.',
        agentsMdRule('fix'),
        '',
    ].join('\n')
}

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
                summary: collapse(m[2]),
                detail: '',
                checked: m[1] !== ' ',
            })
            details.push([])
        } else if (findings.length > 0 && line.trim()) {
            details[details.length - 1].push(line.trim())
        }
    }
    if (findings.length > 0) {
        return findings.map((f, i) => {
            return { ...f, detail: details[i].join('\n') }
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
        return { ...f, checked: done.has(normalize(f.summary)) }
    })
}

function headline (input:ReviewEntryInput):string {
    const n = input.findings.length
    const fixed = input.findings.filter(f => f.checked).length
    switch (input.status) {
        case 'clean': return 'no findings'
        case 'fixed': return `${fixed} of ${n} fixed`
        case 'unresolved':
            return `${n} finding${n === 1 ? '' : 's'}, fix failed`
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
        findings: parseFindings(findingLines.join('\n')) ?? [],
        body: lines.join('\n').trim(),
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

export type SpawnAgentFn = (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
    maxTurns?:number
    effort?:EffortLevel
    // claude only: model for subagents; unset = off
    preferSubagent?:string
    onLine?:(line:string) => void
}) => Promise<AgentResult>

export type ReviewDeps = {
    spawnAgent:SpawnAgentFn
    // running child pids, so SIGINT also kills installs and tests
    registry?:Set<number>
}

export type ReviewPassOpts = {
    repoRoot:string
    repoName:string
    // the branch the run merged into; the fix merges here too
    baseBranch:string
    reviewPath:string
    // the default branch, when baseBranch is an integration branch
    forkedFrom?:string
    launchCommit:string
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    testCmd:string
    installCmd?:string
    maxTurns?:number
    effort?:EffortLevel
    // claude only: model for subagents; unset = off
    preferSubagent?:string
    retries:number
    retryDelay:number
    log:(msg:string) => void
    now?:() => Date
}

// Same naming as ticket logs: the first attempt keeps the plain
// name, later attempts get their own file.
function logPath (
    logsDir:string,
    stem:string,
    attempt:number,
    ext:string
):string {
    const suffix = attempt > 1 ? `.attempt${attempt}` : ''
    return join(logsDir, `${stem}${suffix}${ext}`)
}

// Runs a shell step (install or tests) in a worktree, writing its
// output to `path`; true only on exit 0.
async function runStep (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    cmd:string,
    cwd:string,
    path:string
):Promise<boolean> {
    const result = await runTestCmd({
        cmd,
        cwd,
        timeout: opts.timeout,
        registry: deps.registry,
    })
    writeFileSync(path, result.output)
    return result.exitCode === 0
}

async function discardWorktree (
    opts:ReviewPassOpts,
    wt:{ worktreePath:string; branchName:string }
):Promise<void> {
    try {
        await removeWorktree(wt.worktreePath, { force: true })
        await deleteBranch(opts.repoRoot, wt.branchName)
    } catch (err) {
        opts.log(
            `  Failed to remove ${wt.worktreePath}: ` +
            (err instanceof Error ? err.message : String(err))
        )
    }
}

// Asks an agent to review from..to and returns its findings:
// [] when clean, null when no attempt produced a usable findings
// file. The worktree and anything the reviewer changed in it are
// always discarded.
export async function runReviewer (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    range:{ from:string; to:string }
):Promise<Finding[]|null> {
    return runWithRetries({
        maxAttempts: opts.retries + 1,
        retryDelay: opts.retryDelay,
        agentCmd: opts.agentCmd,
        effort: opts.effort,
        label: 'review',
        log: opts.log,
    }, async (attempt, effort) => {
        const wt = await createNamedWorktree({
            repoRoot: opts.repoRoot,
            repoName: opts.repoName,
            baseBranch: opts.baseBranch,
            name: 'review',
        })
        try {
            if (opts.installCmd && !(await runStep(
                opts, deps, opts.installCmd, wt.worktreePath,
                logPath(opts.logsDir, 'review', attempt, '.install.log')
            ))) {
                opts.log('  review: install failed')
                return { result: null, stop: false }
            }
            ensureNotesIgnored(wt.worktreePath)
            await deps.spawnAgent({
                prompt: renderReviewPrompt({
                    specBody: opts.specBody,
                    ...range,
                    exclude: reviewExcludeFor(
                        opts.repoRoot, opts.reviewPath
                    ),
                    preferSubagent: opts.preferSubagent,
                }),
                agentCmd: opts.agentCmd,
                model: opts.model,
                timeout: opts.timeout,
                logPath: logPath(opts.logsDir, 'review', attempt, '.log'),
                cwd: wt.worktreePath,
                label: 'review',
                maxTurns: opts.maxTurns,
                effort,
                preferSubagent: opts.preferSubagent,
                onLine: opts.log,
            })
            const text = collectNotes(wt.worktreePath, FINDINGS_FILE)
            const findings = text === null ? null : parseFindings(text)
            if (findings === null) {
                opts.log('  review: no usable findings file')
            }
            return { result: findings, stop: findings !== null }
        } finally {
            await discardWorktree(opts, wt)
        }
    })
}

export type FixResult = {
    merged:boolean
    // checked per the fixer's [x] lines when merged; all
    // unchecked otherwise
    findings:Finding[]
    attempts:number
    effort?:EffortLevel
    exitCode:number|null
    result:string
    notes:string|null
}

// Asks an agent to fix the findings in a fresh worktree off the
// branch tip. Its work merges only after a green test gate;
// every failure is retried like a ticket.
export async function runFixer (
    opts:ReviewPassOpts,
    deps:ReviewDeps,
    findings:ReadonlyArray<Finding>
):Promise<FixResult> {
    const unchecked = findings.map(f => ({ ...f, checked: false }))
    let previous:{ reason:FixFailure; notes:string|null }|undefined

    return runWithRetries<FixResult>({
        maxAttempts: opts.retries + 1,
        retryDelay: opts.retryDelay,
        agentCmd: opts.agentCmd,
        effort: opts.effort,
        label: 'review fix',
        log: opts.log,
    }, async (attempt, effort) => {
        const fail = (
            reason:FixFailure,
            exitCode:number|null,
            notes:string|null
        ) => {
            previous = { reason, notes }
            opts.log(`  review fix: ${FIX_FAILURE_TEXT[reason]}`)
            return {
                result: {
                    merged: false,
                    findings: unchecked,
                    attempts: attempt,
                    effort,
                    exitCode,
                    result: FIX_FAILURE_TEXT[reason],
                    notes,
                },
                stop: false,
            }
        }

        const wt = await createNamedWorktree({
            repoRoot: opts.repoRoot,
            repoName: opts.repoName,
            baseBranch: opts.baseBranch,
            name: 'review-fix',
        })
        try {
            if (opts.installCmd && !(await runStep(
                opts, deps, opts.installCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt,
                    '.install.log'
                )
            ))) {
                return fail('install', null, null)
            }
            ensureNotesIgnored(wt.worktreePath)
            const agent = await deps.spawnAgent({
                prompt: renderFixPrompt({
                    specBody: opts.specBody,
                    findings,
                    testCmd: opts.testCmd,
                    installCmd: opts.installCmd,
                    previous,
                    preferSubagent: opts.preferSubagent,
                }),
                agentCmd: opts.agentCmd,
                model: opts.model,
                timeout: opts.timeout,
                logPath: logPath(
                    opts.logsDir, 'review-fix', attempt, '.log'
                ),
                cwd: wt.worktreePath,
                label: 'review-fix',
                maxTurns: opts.maxTurns,
                effort,
                preferSubagent: opts.preferSubagent,
                onLine: opts.log,
            })
            // Before any auto-commit, so notes never get committed
            const notes = collectNotes(wt.worktreePath)

            if (!agent.timedOut && agent.exitCode !== 0) {
                return fail('exit', agent.exitCode, notes)
            }
            if (isDirty(wt.worktreePath)) {
                await commitDirty(
                    wt.worktreePath,
                    'nightralph: auto-commit review fix ' +
                    'remaining changes'
                )
            }
            if (!hasNewCommits(
                opts.repoRoot, opts.baseBranch, wt.branchName
            )) {
                return fail('no-commits', agent.exitCode, notes)
            }
            if (opts.testCmd === '') {
                opts.log('  review fix: no test gate')
            } else if (!(await runStep(
                opts, deps, opts.testCmd, wt.worktreePath,
                logPath(
                    opts.logsDir, 'review-fix', attempt, '.test.log'
                )
            ))) {
                return fail('tests', agent.exitCode, notes)
            }
            const merged = await mergeBranch(
                opts.repoRoot, wt.branchName
            )
            if (!merged.success) {
                return fail(
                    'merge',
                    agent.exitCode,
                    [notes, merged.stderr].filter(Boolean)
                        .join('\n\n') || null
                )
            }
            opts.log('  review fix: merged')
            return {
                result: {
                    merged: true,
                    findings: markFixed(findings, agent.completedItems),
                    attempts: attempt,
                    effort,
                    exitCode: agent.exitCode,
                    result: 'merged',
                    notes,
                },
                stop: true,
            }
        } finally {
            await discardWorktree(opts, wt)
        }
    })
}

export function readReviewEntries (path:string):ReviewEntry[] {
    if (!existsSync(path)) return []
    return parseReviewEntries(readFileSync(path, 'utf8'))
}

// Reviews everything since the last reviewed commit, runs one fix
// pass when there are findings, and appends and commits one entry
// to the review log. Skips entirely when the range only touches
// bookkeeping under REVIEW_EXCLUDE.
export async function runReviewPass (
    opts:ReviewPassOpts,
    deps:ReviewDeps
):Promise<ReviewOutcome> {
    const now = opts.now ?? (() => new Date())
    const to = headCommit(opts.repoRoot)
    const forkPoint = opts.forkedFrom ?
        mergeBase(opts.repoRoot, opts.forkedFrom, to) :
        null
    const from = selectReviewBase(readReviewEntries(opts.reviewPath), {
        isAncestor: sha => isAncestor(opts.repoRoot, sha, to),
        forkPoint,
        launchCommit: opts.launchCommit,
    })
    const exclude = reviewExcludeFor(opts.repoRoot, opts.reviewPath)
    if (!hasChangesOutside(opts.repoRoot, from, to, exclude)) {
        opts.log('\nReview: nothing new to review')
        return { status: 'skipped', findings: 0, fixed: 0 }
    }

    opts.log(`\nReviewing ${from.slice(0, 7)}..${to.slice(0, 7)}`)
    const findings = await runReviewer(opts, deps, { from, to })

    let entry:ReviewEntryInput
    if (findings === null) {
        entry = {
            from,
            to,
            status: 'review-failed',
            now: now(),
            findings: []
        }
    } else if (findings.length === 0) {
        entry = { from, to, status: 'clean', now: now(), findings: [] }
    } else {
        opts.log(
            `Review: ${findings.length} finding` +
            `${findings.length === 1 ? '' : 's'}`
        )
        const fix = await runFixer(opts, deps, findings)
        entry = {
            from,
            // A merged fix counts as reviewed
            to: fix.merged ? headCommit(opts.repoRoot) : to,
            status: fix.merged ? 'fixed' : 'unresolved',
            now: now(),
            findings: fix.findings,
            fix: {
                attempts: fix.attempts,
                maxAttempts: opts.retries + 1,
                effort: fix.effort,
                exitCode: fix.exitCode,
                result: fix.result,
                notes: fix.notes,
            },
        }
    }

    appendEntry(opts.reviewPath, renderReviewEntry(entry))
    await commitProgress(
        opts.repoRoot, opts.reviewPath, 'nightralph: record review'
    )
    return {
        status: entry.status,
        findings: entry.findings.length,
        fixed: entry.findings.filter(f => f.checked).length,
    }
}
