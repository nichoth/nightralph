import { spawn, execFile } from 'node:child_process'
import {
    createWriteStream,
    mkdirSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    readdirSync,
    statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import {
    getRepoRoot,
    getRepoName,
    getCurrentBranch,
    createWorktree,
    removeWorktree,
    buildBranchName,
    hasNewCommits,
    isDirty,
    commitDirty,
} from './worktree.js'
import {
    generateProgress,
    generateMultiFeatureProgress,
    createProgressTracker,
    readProgress,
    mergeProgress,
    writeProgress,
    commitProgress,
    checkTicket,
    type ProgressData,
    type ProgressTracker,
} from './progress.js'
import {
    mergeBranch,
    mergeWave,
    updateWorktreeFromBase,
    type MergeConflictStrategy,
} from './merge.js'
import {
    createDisplay,
    ticketLabel,
    type RunProgress,
    type Display,
    type TicketRef,
} from './display.js'
import { runTestCmd } from './testcmd.js'
import {
    NOTES_PATH,
    LOG_TAIL_LINES,
    appendEntry,
    collectNotes,
    ensureNotesIgnored,
    learningsPathFor,
    readEntries,
    renderEntry,
    renderHistory,
    selectHistory,
    tailLines,
    type AgentRunRecord,
    type EntryInput,
} from './learnings.js'

export type Ticket = {
    num:number
    slug:string
    filename:string
    filepath:string
    body:string
    status:string
    blockers:number[]
    feature:string
}

export function formatErrorMessage (error:unknown):string {
    return error instanceof Error ?
        error.message :
        String(error)
}

// Removes a ticket's worktree, logging and swallowing any
// failure instead of letting it interrupt the wave.
async function removeWorktreeQuietly (
    worktreePath:string,
    d:Display
):Promise<void> {
    try {
        await removeWorktree(worktreePath, { force:true })
    } catch (err) {
        d.log(
            '  Failed to remove worktree ' +
            `${worktreePath}: ` +
            formatErrorMessage(err)
        )
    }
}

async function commitTicketFiles (
    repoRoot:string,
    tickets:Ticket[],
    d:Display
):Promise<void> {
    const paths = tickets.map(t => t.filepath)
    if (paths.length === 0) return
    try {
        await execFileAsync(
            'git',
            ['add', '--force', ...paths],
            { cwd:repoRoot }
        )
        try {
            await execFileAsync(
                'git',
                ['diff', '--cached', '--quiet',
                    '--', ...paths],
                { cwd:repoRoot }
            )
            return
        } catch {
            // staged files differ from HEAD
        }
        await execFileAsync(
            'git',
            ['commit', '-m',
                'nightralph: update ticket checklists',
                '--', ...paths],
            { cwd:repoRoot }
        )
    } catch (err) {
        d.log(
            '  Failed to commit ticket updates: ' +
            formatErrorMessage(err)
        )
    }
}

export const TICKET_RE = /^(\d+)-(.+)\.md$/

export function parseTicketFilename (
    filename:string
):{ num:number; slug:string }|null {
    const m = filename.match(TICKET_RE)
    if (!m) return null
    return { num:Number(m[1]), slug:m[2] }
}

export function parseStatus (body:string):string {
    const m = body.match(/\*\*Status:\*\*\s*(.+)/i)
    return m ? m[1].trim().toLowerCase() : ''
}

export function parseBlockers (body:string):number[] {
    const m = body.match(/\*\*Blocked by:\*\*\s*(.+)/i)
    if (!m) return []
    const text = m[1]
    if (/none/i.test(text)) return []
    const nums:number[] = []
    const re = /(\d+)/g
    let match
    while ((match = re.exec(text))) {
        nums.push(Number(match[1]))
    }
    return nums
}

export function scanTickets (
    dir:string,
    feature:string = ''
):Ticket[] {
    const files = readdirSync(dir)
        .filter(f => TICKET_RE.test(f))
        .sort((a, b) => a.localeCompare(
            b,
            undefined,
            { numeric:true, sensitivity:'base' }
        ))

    return files.map(filename => {
        const parsed = parseTicketFilename(filename)!
        const filepath = join(dir, filename)
        const body = readFileSync(filepath, 'utf8')
        return {
            num:parsed.num,
            slug:parsed.slug,
            filename,
            filepath,
            body,
            status:parseStatus(body),
            blockers:parseBlockers(body),
            feature,
        }
    })
}

export function ticketKey (feature:string, num:number):string {
    return `${feature}:${num}`
}

export function findReadyTickets (
    tickets:ReadonlyArray<Ticket>
):Ticket[] {
    const doneKeys = new Set(
        tickets
            .filter(t => t.status === 'done')
            .map(t => ticketKey(t.feature, t.num))
    )
    return tickets.filter(t => {
        if (t.status !== 'ready-for-agent') return false
        return t.blockers.every(b =>
            doneKeys.has(ticketKey(t.feature, b))
        )
    })
}

/**
 * Tickets that cannot run this session because a ticket they
 * depend on (directly or through a chain, within their own
 * feature) is dead: in `failedKeys`, or in a status that is
 * neither done nor ready-for-agent, e.g. ready-for-human.
 * Returns ticketKey -> dead upstream ticketKeys. Only
 * ready-for-agent tickets that have not failed are keys. A
 * blocker number with no matching ticket is not dead.
 */
export function findBlockedTickets (
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>,
):Map<string, Array<string>> {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )

    function collectDead (
        ticket:Ticket,
        visited:Set<string>,
        found:Set<string>,
    ):void {
        for (const b of ticket.blockers) {
            const key = ticketKey(ticket.feature, b)
            if (visited.has(key)) continue
            visited.add(key)
            const blocker = byKey.get(key)
            if (!blocker || blocker.status === 'done') continue
            if (
                failedKeys.has(key) ||
                blocker.status !== 'ready-for-agent'
            ) {
                found.add(key)
                continue
            }
            collectDead(blocker, visited, found)
        }
    }

    const blocked = new Map<string, Array<string>>()
    for (const t of tickets) {
        const key = ticketKey(t.feature, t.num)
        if (t.status !== 'ready-for-agent') continue
        if (failedKeys.has(key)) continue
        const found = new Set<string>()
        collectDead(t, new Set([key]), found)
        if (found.size > 0) blocked.set(key, [...found])
    }
    return blocked
}

// Matches an agent-reported completed item. Agents echo items
// as markdown checklist lines (`- [x] item`) as often as bare
// `[x] item` lines, so the bullet prefix is optional.
export const COMPLETED_RE = /^\s*[-*+]?\s*\[x\]\s+(.+)$/i
export const TOOL_USE_RE = /^\[[\w.]+\]/

// Matches one checklist line in a ticket file: optional indent
// and bullet, the `[ ]` / `[x]` box, and the item text.
const CHECKBOX_RE = /^(\s*[-*+] )\[( |x|X)\]( .*)$/

// The unchecked-box variant, used for the actual flip to [x].
const UNCHECKED_BOX_RE = /^(\s*[-*+] )\[( )\]/

// Normalizes checklist text for matching: agents echo an item as
// one logical line while ticket files wrap items across lines,
// so compare with whitespace runs collapsed, case-insensitively.
function normalizeItemText (s:string):string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

// Drops an optional markdown bullet/checkbox prefix so items match
// whether or not the caller already stripped the `[x]` marker.
function stripCheckboxPrefix (s:string):string {
    return s.replace(/^\s*[-*+]?\s*\[[ xX]\]\s+/, '')
}

type ParsedItem = { start:number; text:string }

// Parses the checklist items out of a ticket body. An item is its
// checkbox line plus any immediately following indented lines
// (wrapped text), so items written across multiple lines can be
// matched by their full text. Code fences are skipped.
function parseChecklistItems (
    lines:string[]
):ParsedItem[] {
    const items:ParsedItem[] = []
    let inFence = false
    let i = 0
    while (i < lines.length) {
        if (/^\s*```/.test(lines[i])) {
            inFence = !inFence
            i++
            continue
        }
        if (inFence) {
            i++
            continue
        }
        const m = lines[i].match(CHECKBOX_RE)
        if (!m) {
            i++
            continue
        }
        const start = i
        let text = m[3]
        i++
        while (
            i < lines.length &&
            /^\s+\S/.test(lines[i]) &&
            !CHECKBOX_RE.test(lines[i])
        ) {
            text += ' ' + lines[i].trim()
            i++
        }
        items.push({
            start,
            text:normalizeItemText(text),
        })
    }
    return items
}

export function checkItems (
    ticket:Ticket,
    completedItems:string[]
):void {
    if (completedItems.length === 0) return
    // Read from disk: a merge or respawn may have changed the
    // file since the ticket was scanned, and writing the stale
    // body would drop those edits.
    let body:string
    try {
        body = readFileSync(ticket.filepath, 'utf8')
    } catch {
        body = ticket.body
    }
    const wanted = new Set(
        completedItems.map(item =>
            normalizeItemText(stripCheckboxPrefix(item))
        )
    )
    const lines = body.split('\n')
    let changed = false
    for (const item of parseChecklistItems(lines)) {
        if (!wanted.has(item.text)) continue
        const flipped = lines[item.start].replace(
            UNCHECKED_BOX_RE,
            '$1[x]'
        )
        if (flipped !== lines[item.start]) {
            lines[item.start] = flipped
            changed = true
        }
    }
    if (!changed) return
    body = lines.join('\n')
    writeFileSync(ticket.filepath, body)
    ticket.body = body
}

// Checks off every remaining unchecked item in a ticket body,
// ignoring fenced code blocks.
function checkAllItems (body:string):string {
    const lines = body.split('\n')
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        lines[i] = lines[i].replace(
            UNCHECKED_BOX_RE,
            '$1[x]'
        )
    }
    return lines.join('\n')
}

export function markDone (ticket:Ticket):void {
    // Re-read from disk: the merge may have brought the agent's
    // own edits to the ticket file into the repo, and writing
    // the body scanned at startup would drop them.
    let body:string
    try {
        body = readFileSync(ticket.filepath, 'utf8')
    } catch {
        body = ticket.body
    }
    // A done ticket's items are complete by definition, so check
    // off anything the agent did not report instead of leaving
    // the file claiming done with unchecked items.
    body = checkAllItems(body)
    const updated = body.replace(
        /\*\*Status:\*\*\s*.+/i,
        '**Status:** done'
    )
    writeFileSync(ticket.filepath, updated)
    ticket.status = 'done'
    ticket.body = updated
}

// Drops one markdown section from a spec. Used to keep the
// per-ticket prompt short: the User Stories list is useful
// to humans and to to-tickets but not to an implementing agent.
export function stripSpecSection (
    specBody:string,
    heading:string
):string {
    const out:string[] = []
    let skipping = false
    let skipLevel = 0
    let inFence = false

    for (const line of specBody.split('\n')) {
        // Toggle fence state on lines starting with ``` (after
        // optional whitespace)
        if (/^\s*```/.test(line)) {
            inFence = !inFence
        }

        // Only check for headings outside of code fences
        if (!inFence) {
            const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
            if (m) {
                const level = m[1].length
                if (skipping && level <= skipLevel) {
                    skipping = false
                }
                if (!skipping && m[2] === heading) {
                    skipping = true
                    skipLevel = level
                    continue
                }
            }
        }
        if (!skipping) out.push(line)
    }

    return out.join('\n')
}

export function lookupSpec (
    specBodies:Map<string, string>|undefined,
    fallback:string,
    feature:string
):string {
    if (!feature || !specBodies) return fallback
    return specBodies.get(feature) ?? fallback
}

// The rule for agents in a worktree the orchestrator has
// already installed dependencies into. Empty without one.
function installRule (installCmd?:string):string[] {
    if (!installCmd) return []
    return [
        '- Dependencies are already installed with ' +
            `\`${installCmd}\`. Do NOT reinstall them ` +
            'with any other command; to reinstall, run ' +
            'that same command. To add a dependency, use ' +
            'the package manager that command uses, so ' +
            'its lockfile stays in sync.',
    ]
}

function historyBlock (history?:string):string[] {
    if (!history) return []
    return [history, '']
}

export function renderPrompt (
    specBody:string,
    ticket:Ticket,
    opts:{
        testCmd:string
        installCmd?:string
        history?:string
    }
):string {
    return [
        '---- SPEC CONTEXT ----',
        specBody,
        '',
        '---- TICKET ----',
        ticket.filename,
        ticket.body,
        '',
        ...historyBlock(opts.history),
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent. ' +
            'Implement the ticket using /tdd.',
        '',
        'Follow these rules:',
        '- Read the files directly relevant to the ' +
            'ticket before writing code. Also read any ' +
            'AGENTS.md in or above the directories you ' +
            'will touch, plus CONTEXT.md and the ' +
            'relevant docs/adr/ entries if they exist. ' +
            'If they do not exist, proceed silently.',
        '- Work ONLY on this ticket. Do not fix ' +
            'unrelated problems you notice.',
        '- Do NOT research external APIs or services ' +
            'via web search. Use the spec and ticket ' +
            'body as your sole reference for API shapes.',
        ...installRule(opts.installCmd),
        '- Use /tdd for every checklist item. For ' +
            'each item, write a failing test at the ' +
            'seams named in the spec\'s Testing ' +
            'Decisions section, then write only ' +
            'enough code to make it pass, then ' +
            'refactor. For a checklist item that is ' +
            'pure scaffolding, config, or docs (where ' +
            'a test adds no value), skip test-first ' +
            'and record that decision in your notes ' +
            'file.',
        '- While iterating, run only the tests ' +
            'relevant to what you changed. Run ' +
            `\`${opts.testCmd}\` in full once, as the ` +
            'final gate before your last commit. Do ' +
            'not commit with failing tests. The ' +
            'orchestrator runs the same command after ' +
            'you exit and rejects the ticket if it ' +
            'fails.',
        '- If the project has a lint script, run it ' +
            'and fix what it reports.',
        '- INTEGRITY: never delete, skip, weaken, or ' +
            'write tautological tests to force a green ' +
            'result. Only report a checklist item done ' +
            'when its real tests genuinely pass. If an ' +
            'item cannot be completed honestly, leave ' +
            'it unchecked and record what blocked you ' +
            'in your notes file.',
        '- Do NOT read or modify files outside ' +
            'your current directory (the worktree).',
        '- Do NOT run git push.',
        '- Commit after each checklist item, and make ' +
            'sure everything is committed when finished, ' +
            'except your notes file.',
        `- Keep notes for this attempt in \`${NOTES_PATH}\` ` +
            '(create the directory). Update it after each ' +
            'checklist item and as soon as you hit a ' +
            'blocker, not only at the end. Record what you ' +
            'implemented, files changed, how you read any ' +
            'vague acceptance criteria, what blocked you, and ' +
            'anything the next attempt at this ticket should ' +
            'know. Never commit, git add, or delete this ' +
            'file; the orchestrator collects it.',
        '- After completing each checklist item in the ' +
            'ticket, print a line: [x] <item text> ' +
            '(matching the checklist text exactly).',
        '- Before your final commit, record reusable ' +
            'learnings in the nearest AGENTS.md (in or ' +
            'above the directories you modified; ' +
            'prefer that over the repo root). Good ' +
            'additions: module conventions, gotchas, ' +
            'files that must change together, how to ' +
            'test that area, environment requirements. ' +
            'Do NOT add ticket-specific details or ' +
            'temporary debugging notes. Only write ' +
            'when you have knowledge that would help ' +
            'future work in that directory. Reusable ' +
            'patterns go in AGENTS.md; anything ' +
            'specific to this ticket goes in your ' +
            'notes file.',
        '',
    ].join('\n')
}

export function renderMergePrompt (
    specBody:string,
    ticket:Ticket,
    opts:{ installCmd?:string } = {}
):string {
    return [
        '---- SPEC CONTEXT ----',
        specBody,
        '',
        '---- TICKET ----',
        ticket.filename,
        ticket.body,
        '',
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent resolving ' +
            'a merge conflict.',
        '',
        'Another agent already implemented this ticket ' +
            'on a feature branch. The branch was then ' +
            'merged with the base branch, but conflicts ' +
            'arose. The working tree may contain conflict ' +
            'markers that need resolution.',
        '',
        'Your task:',
        '1. Find and resolve all conflict markers ' +
            '(<<<<<<< / ======= / >>>>>>>).',
        '2. When AGENTS.md or other docs conflict, ' +
            'keep both sides\' additions rather than ' +
            'picking one.',
        '3. Make sure the code compiles and tests pass.',
        '4. Commit the resolved files.',
        '',
        'Do NOT re-implement the ticket from scratch.',
        ...installRule(opts.installCmd),
        'Do NOT read or modify files outside your ' +
            'current directory (the worktree).',
        'Do NOT run git push.',
    ].join('\n')
}

function listTickets (tickets:ReadonlyArray<Ticket>):void {
    console.log('\nTickets:')
    for (const t of tickets) {
        const blockerStr = t.blockers.length > 0 ?
            `blocked by [${t.blockers.join(', ')}]` :
            'no blockers'
        console.log(
            `  ${t.filename} ` +
            `(${t.status}) ${blockerStr}`
        )
    }
}

function * simulateWaves (
    tickets:ReadonlyArray<Ticket>
):Generator<{ wave:number; ready:Array<Ticket> }> {
    const sim = new Map(
        tickets.map(t => [
            ticketKey(t.feature, t.num),
            t.status,
        ])
    )
    let wave = 1
    while (true) {
        const doneKeys = new Set(
            [...sim.entries()]
                .filter(([, s]) => s === 'done')
                .map(([k]) => k)
        )
        const ready = [...tickets].filter(t => {
            const key = ticketKey(t.feature, t.num)
            if (sim.get(key) !== 'ready-for-agent') {
                return false
            }
            return t.blockers.every(b =>
                doneKeys.has(
                    ticketKey(t.feature, b)
                )
            )
        })
        if (ready.length === 0) break
        yield { wave, ready }
        for (const t of ready) {
            sim.set(
                ticketKey(t.feature, t.num),
                'done'
            )
        }
        wave++
    }
}

function detectDeadlocks (
    tickets:ReadonlyArray<Ticket>
):Array<Ticket> {
    const doneKeys = new Set<string>()
    const readyKeys = new Set<string>()

    for (const t of tickets) {
        const key = ticketKey(t.feature, t.num)
        if (t.status === 'ready-for-agent') {
            readyKeys.add(key)
        } else if (t.status === 'done') {
            doneKeys.add(key)
        }
    }

    let changed = true
    while (changed) {
        changed = false
        for (const key of readyKeys) {
            const ticket = tickets.find(t =>
                ticketKey(t.feature, t.num) === key
            )!
            if (ticket.blockers.every(b =>
                doneKeys.has(
                    ticketKey(ticket.feature, b)
                )
            )) {
                doneKeys.add(key)
                readyKeys.delete(key)
                changed = true
            }
        }
    }

    return [...readyKeys].map(key =>
        tickets.find(t =>
            ticketKey(t.feature, t.num) === key
        )!
    )
}

const PROVIDER_ARGS:Record<string, string[]> = {
    claude:[
        '--print', '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
    ],
    // codex removed --full-auto; this is the counterpart
    // of claude's --dangerously-skip-permissions, and the
    // workspace-write sandbox would block commits because
    // a worktree's .git link points outside the tree
    codex:['exec', '--dangerously-bypass-approvals-and-sandbox'],
    pi:[
        '-p', '--verbose',
        '--approve', '--no-session',
        '--mode', 'json',
    ],
}

export function getProviderArgs (cmd:string):string[] {
    const name = basename(cmd)
    return PROVIDER_ARGS[name] ?? []
}

// Per-provider effort ladders.
export const EFFORT_LADDERS = {
    pi:['off', 'minimal', 'low', 'medium',
        'high', 'xhigh', 'max'],
    claude:['low', 'medium', 'high',
        'xhigh', 'max'],
    codex:['low', 'medium', 'high'],
} as const

export type ProviderName =
    keyof typeof EFFORT_LADDERS

export type EffortLevel =
    typeof EFFORT_LADDERS[ProviderName][number]

export const ALL_EFFORT_LEVELS:EffortLevel[] = [
    'off', 'minimal', 'low', 'medium',
    'high', 'xhigh', 'max',
]

// Step up the effort ladder for a given provider.
// Without a starting level, the first retry jumps to high.
// Otherwise, step one rung up and stop at the provider's max.
export function escalateEffort (
    provider:ProviderName,
    level?:EffortLevel
):EffortLevel {
    if (!level) return 'high'
    const ladder = EFFORT_LADDERS[provider]
    const i = (ladder as readonly string[])
        .indexOf(level)
    if (i === -1) return level
    return ladder[
        Math.min(i + 1, ladder.length - 1)
    ] as EffortLevel
}

export function formatStreamLine (
    line:string
):string|null {
    let obj:Record<string, unknown>
    try {
        obj = JSON.parse(line) as Record<string, unknown>
    } catch {
        return line
    }

    if (obj.type === 'assistant') {
        const msg = obj.message as
            Record<string, unknown>|undefined
        const content = msg?.content as
            Array<Record<string, unknown>>|undefined
        if (!content) return null
        for (const block of content) {
            if (block.type === 'text') {
                return String(block.text)
            }
        }
        return null
    }

    if (obj.type === 'result') {
        const sub = obj.subtype as string|undefined ?? 'done'
        const cost = obj.total_cost_usd as number|undefined
        const costStr = cost != null ?
            ` ($${cost.toFixed(2)})` :
            ''
        return `${sub}${costStr}`
    }

    if (obj.type === 'system') {
        const sub = obj.subtype as string|undefined
        if (sub === 'api_retry') {
            const error = obj.error as string|undefined
            return `retry: ${error ?? 'unknown'}`
        }
    }

    return null
}

export type PiStreamFormatter = {
    process:(line:string) => string[]
    flush:() => string[]
}

export function createPiStreamFormatter (
):PiStreamFormatter {
    const calls = new Map<
        number, { name:string; buf:string }
    >()
    let textBuf = ''

    function drainLines ():string[] {
        const parts = textBuf.split('\n')
        if (parts.length === 1) return []
        textBuf = parts[parts.length - 1]
        return parts.slice(0, -1)
    }

    function flushBuf ():string[] {
        if (textBuf.length === 0) return []
        const out = textBuf
        textBuf = ''
        return [out]
    }

    function process (line:string):string[] {
        let obj:Record<string, unknown>
        try {
            obj = JSON.parse(line) as
                Record<string, unknown>
        } catch {
            return [line]
        }

        const evt = obj.assistantMessageEvent as
            Record<string, unknown>|undefined
        if (!evt) return []

        const type = evt.type as string|undefined
        const ci = evt.contentIndex as
            number|undefined ?? -1

        if (type === 'text_delta') {
            const delta =
                (evt.delta as string|undefined) ?? ''
            textBuf += delta
            return drainLines()
        }

        if (type === 'toolcall_start') {
            const flushed = flushBuf()
            calls.set(ci, {
                name:(evt.toolName as
                    string|undefined) ?? '?',
                buf:'',
            })
            return flushed
        }

        if (
            type === 'toolcall_delta' &&
            calls.has(ci)
        ) {
            calls.get(ci)!.buf +=
                (evt.delta as string|undefined) ?? ''
            return []
        }

        if (
            type === 'toolcall_end' &&
            calls.has(ci)
        ) {
            const call = calls.get(ci)!
            calls.delete(ci)
            let label = ''
            try {
                const args = JSON.parse(call.buf) as
                    Record<string, unknown>
                label = String(
                    args.command ??
                    args.file_path ??
                    args.query ?? ''
                ).split('\n')[0].slice(0, 72)
            } catch {
                // unparseable tool args
            }
            return [`[${call.name}] ${label}`]
        }

        return []
    }

    return { process, flush:flushBuf }
}

function writePromptFile (prompt:string):string {
    const name = `nightralph-${Date.now()}-` +
        `${Math.random().toString(36).slice(2)}.md`
    const filePath = join(tmpdir(), name)
    writeFileSync(filePath, prompt)
    return filePath
}

function cleanupPromptFile (filePath:string):void {
    try {
        unlinkSync(filePath)
    } catch {
        // already removed
    }
}

export type AgentResult = {
    exitCode:number
    completedItems:string[]
    // true when the orchestrator killed the agent at
    // the timeout; exitCode is non-zero in that case
    timedOut:boolean
}

// How long to wait after the process exits before giving up on a
// graceful pipe close and forcing the streams shut. A grandchild
// (dev server, watcher) that inherited the agent's stdout can keep
// the pipe open after the agent itself has been killed, which would
// otherwise leave spawnAgent's promise pending forever.
const CLOSE_GRACE_MS = 2000

// Agents are spawned with detached:true so they become their own
// process group leader; this lets us kill the whole tree (agent +
// any children it spawned, like dev servers) with one signal to
// -pid instead of leaving orphans behind. Exported for reuse by
// signal handling (Ctrl-C / SIGTERM).
export function killProcessGroup (pid:number|undefined):void {
    if (pid === undefined) return
    try {
        process.kill(-pid, 'SIGKILL')
    } catch {
        // The group kill failed (e.g. the group was already
        // reaped, or the pid is not a group leader). Fall back
        // to killing the process directly so a still-running
        // pid never escapes the kill.
        try {
            process.kill(pid, 'SIGKILL')
        } catch {
            // Process is already gone.
        }
    }
}

// Tracks every agent process spawnAgent currently has running, so
// a Ctrl-C or SIGTERM to the orchestrator itself can kill them all
// instead of leaving them running after the orchestrator exits.
const runningAgents = new Set<number>()

export function killRunningAgents ():number {
    let killed = 0
    for (const pid of runningAgents) {
        killProcessGroup(pid)
        killed++
    }
    return killed
}

export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
    maxTurns?:number
    effort?:EffortLevel
    onLine?:(line:string) => void
}):Promise<AgentResult> {
    const args:string[] = [
        ...getProviderArgs(opts.agentCmd),
    ]
    if (opts.model) {
        args.push('--model', opts.model)
    }
    const providerName = basename(opts.agentCmd)
    const isClaude = providerName === 'claude'
    const isPi = providerName === 'pi'

    if (opts.maxTurns) {
        if (isClaude) {
            args.push(
                '--max-turns',
                String(opts.maxTurns)
            )
        } else if (opts.onLine) {
            opts.onLine(
                'Warning: --max-turns not ' +
                `supported by ${providerName}, ` +
                'skipping'
            )
        }
    }
    if (opts.effort && providerName in EFFORT_LADDERS) {
        const ladder = EFFORT_LADDERS[
            providerName as ProviderName
        ]
        if (
            !(ladder as readonly string[])
                .includes(opts.effort)
        ) {
            if (opts.onLine) {
                opts.onLine(
                    'Warning: effort ' +
                    `'${opts.effort}' not ` +
                    'supported by ' +
                    `${providerName}, skipping`
                )
            }
        } else if (isPi) {
            args.push('--thinking', opts.effort)
        } else if (isClaude) {
            args.push('--effort', opts.effort)
        } else if (providerName === 'codex') {
            args.push(
                '-c',
                `model_reasoning_effort=${opts.effort}`
            )
        }
    }
    const prefix = opts.label ?
        `  [${opts.label}] ` :
        '  '

    let promptFile:string|null = null
    if (isPi) {
        promptFile = writePromptFile(opts.prompt)
        args.push(`@${promptFile}`)
    }

    const logStream = createWriteStream(
        opts.logPath,
        { flags:'w' }
    )
    const proc = spawn(opts.agentCmd, args, {
        stdio:['pipe', 'pipe', 'pipe'],
        cwd:opts.cwd,
        detached:true,
    })

    if (proc.pid !== undefined) runningAgents.add(proc.pid)

    // stdout and stderr share one log, so neither pipe may end
    // it: the first to reach EOF would end the log while the
    // other still has data, which drops that output or crashes
    // the run with ERR_STREAM_WRITE_AFTER_END. finish() ends it.
    proc.stdout.pipe(logStream, { end:false })

    const piFormatter = isPi ?
        createPiStreamFormatter() :
        null

    const completedItems:string[] = []
    const seenItems = new Set<string>()

    function collectCompleted (text:string):void {
        // Reported items arrive as one multi-line text block
        // (claude), as drained single lines (pi), or as raw
        // lines (other providers); matching per line covers all
        // three, including summaries with several [x] lines.
        for (const line of text.split('\n')) {
            const match = line.match(COMPLETED_RE)
            if (!match) continue
            const item = match[1].trim()
            if (!item || seenItems.has(item)) continue
            seenItems.add(item)
            completedItems.push(item)
        }
    }

    const rl = createInterface({ input:proc.stdout })
    rl.on('line', line => {
        if (isClaude) {
            const formatted = formatStreamLine(line)
            if (formatted !== null) {
                collectCompleted(formatted)
                const output = `${prefix}${formatted}`
                if (opts.onLine) {
                    opts.onLine(output)
                } else {
                    console.log(output)
                }
            }
        } else if (piFormatter) {
            const lines = piFormatter.process(line)
            for (const formatted of lines) {
                collectCompleted(formatted)
                const output = `${prefix}${formatted}`
                if (opts.onLine) {
                    opts.onLine(output)
                } else {
                    console.log(output)
                }
            }
        } else {
            collectCompleted(line)
            const output = `${prefix}${line}`
            if (opts.onLine) {
                opts.onLine(output)
            } else {
                console.log(output)
            }
        }
    })

    proc.stderr.pipe(logStream, { end:false })
    const rlErr = createInterface({ input:proc.stderr })
    rlErr.on('line', line => {
        if (isClaude && !TOOL_USE_RE.test(line)) return
        const output = `${prefix}${line}`
        if (opts.onLine) {
            opts.onLine(output)
        } else {
            console.error(output)
        }
    })

    let timedOut = false
    const timeout = setTimeout(() => {
        if (proc.killed) return
        timedOut = true
        const msg = 'agent timed out after ' +
            `${opts.timeout}s; killing it`
        // The status display repaints the screen, so a
        // bare console.warn would be painted over. Route
        // the reason through onLine and into the ticket
        // log so it is visible in both places.
        logStream.write(`nightralph: ${msg}\n`)
        if (opts.onLine) {
            opts.onLine(`${prefix}${msg}`)
        } else {
            console.warn(`${prefix}${msg}`)
        }
        killProcessGroup(proc.pid)
    }, opts.timeout * 1000)

    // An agent that exits before draining stdin (bad flags,
    // auth failure) closes its end of the pipe; writing to it
    // then raises EPIPE on proc.stdin. Without a listener that
    // is an uncaught 'error' event that kills the orchestrator.
    proc.stdin.on('error', err => {
        logStream.write(
            'nightralph: stdin write failed: ' +
            `${formatErrorMessage(err)}\n`
        )
    })

    if (!promptFile) {
        proc.stdin.write(opts.prompt)
    }
    proc.stdin.end()

    return new Promise<AgentResult>(resolve => {
        let settled = false
        let graceTimer:ReturnType<typeof setTimeout>|undefined

        function finish (exitCode:number):void {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (graceTimer) clearTimeout(graceTimer)
            if (proc.pid !== undefined) {
                runningAgents.delete(proc.pid)
            }
            if (piFormatter) {
                for (const line of piFormatter.flush()) {
                    collectCompleted(line)
                    const output = `${prefix}${line}`
                    if (opts.onLine) {
                        opts.onLine(output)
                    } else {
                        console.log(output)
                    }
                }
            }
            rl.close()
            rlErr.close()
            logStream.end()
            if (promptFile) cleanupPromptFile(promptFile)
            resolve({ exitCode, completedItems, timedOut })
        }

        // The process itself has exited, but 'close' waits for its
        // stdio streams to close too -- a grandchild that inherited
        // stdout/stderr can hold those pipes open indefinitely. Give
        // it a grace period, then destroy the streams ourselves so
        // the run does not hang forever on someone else's fd.
        proc.on('exit', code => {
            graceTimer = setTimeout(() => {
                killProcessGroup(proc.pid)
                proc.stdout.destroy()
                proc.stderr.destroy()
                finish(code ?? 1)
            }, CLOSE_GRACE_MS)
        })

        proc.on('close', code => {
            finish(code ?? 1)
        })
        proc.on('error', err => {
            if (settled) return
            settled = true
            if (graceTimer) clearTimeout(graceTimer)
            clearTimeout(timeout)
            if (proc.pid !== undefined) {
                runningAgents.delete(proc.pid)
            }
            rl.close()
            rlErr.close()
            logStream.end()
            if (promptFile) cleanupPromptFile(promptFile)
            console.error(
                'Agent process error:',
                formatErrorMessage(err)
            )
            resolve({
                exitCode:1,
                completedItems,
                timedOut,
            })
        })
    })
}

export function dryRun (
    tickets:Array<Ticket>,
    specBody:string,
    testCmd:string
):void {
    listTickets(tickets)

    console.log('\nSimulated wave order:')
    for (const { wave, ready } of simulateWaves(tickets)) {
        console.log(
            `  Wave ${wave}: ` +
            ready.map(t => t.filename).join(', ')
        )
    }

    const stuck = detectDeadlocks(tickets)
    if (stuck.length > 0) {
        console.log(
            '\nDeadlocked tickets: ' +
            stuck.map(t => t.filename).join(', ')
        )
    }

    const firstReady = findReadyTickets(tickets)
    if (firstReady.length > 0) {
        console.log(
            '\nPrompt for first ready ticket ' +
            `(${firstReady[0].filename}):\n`
        )
        console.log(
            renderPrompt(specBody, firstReady[0],
                { testCmd })
        )
    }
}

export function dryRunIsolated (opts:{
    tickets:Array<Ticket>
    specBody:string
    repoName:string
    conflictStrategy:MergeConflictStrategy
    progressPath:string
    testCmd:string
    installCmd?:string
    effort?:EffortLevel
    retries?:number
    retryDelay?:number
    concurrency?:number
}):void {
    listTickets(opts.tickets)

    console.log('\nSimulated wave order:')
    for (const { wave, ready } of simulateWaves(
        opts.tickets
    )) {
        console.log(
            `  Wave ${wave}: ` +
            ready.map(t => t.filename).join(', ')
        )
        for (const t of ready) {
            const num = String(t.num).padStart(2, '0')
            const branchName = buildBranchName(
                opts.repoName, t
            )
            const prefix = t.feature ?
                `${t.feature}.` : ''
            const worktreePath =
                `../${opts.repoName}.${prefix}${num}-${t.slug}`
            console.log(`    worktree: ${worktreePath}`)
            console.log(`    branch:   ${branchName}`)
        }
    }

    const stuck = detectDeadlocks(opts.tickets)
    if (stuck.length > 0) {
        console.log(
            '\nDeadlocked tickets: ' +
            stuck.map(t => t.filename).join(', ')
        )
    }

    const firstReady = findReadyTickets(opts.tickets)
    if (firstReady.length > 0) {
        console.log(
            '\nPrompt for first ready ticket ' +
            `(${firstReady[0].filename}):\n`
        )
        console.log(
            renderPrompt(
                opts.specBody, firstReady[0],
                {
                    testCmd:opts.testCmd,
                    installCmd:opts.installCmd,
                }
            )
        )
    }

    const strategyDesc =
        opts.conflictStrategy === 'respawn' ?
            'respawn (re-run agent on conflict)' :
            'stop (stop merging on conflict)'
    console.log(
        `\nTest command: ${opts.testCmd}`
    )
    console.log(
        `Install:      ${opts.installCmd || '(none)'}`
    )
    console.log(
        `Effort:       ${opts.effort ?? '(provider default)'}`
    )
    console.log(
        `Retries:      ${opts.retries ?? DEFAULT_RETRIES}`
    )
    console.log(
        'Retry delay:  ' +
        `${opts.retryDelay ?? 0}s`
    )
    console.log(
        'Concurrency:  ' +
        `${opts.concurrency ?? DEFAULT_CONCURRENCY}`
    )
    console.log(
        `\nMerge strategy: ${strategyDesc}`
    )
    console.log(`Progress file: ${opts.progressPath}`)
}

// Installs dependencies in a ticket's worktree before an
// agent runs there. Writes the output to a per-ticket log
// either way, and returns true only when the install exits 0.
async function runInstall (opts:{
    installCmd:string
    ticket:Ticket
    worktreePath:string
    timeout:number
    logsDir:string
    attempt?:number
    log:(msg:string) => void
    registry?:Set<number>
}):Promise<boolean> {
    const result = await runTestCmd({
        cmd:opts.installCmd,
        cwd:opts.worktreePath,
        timeout:opts.timeout,
        registry:opts.registry,
    })
    const installLogPath = attemptLogPath(
        opts.logsDir, opts.ticket, opts.attempt ?? 1,
        '.install.log'
    )
    writeFileSync(installLogPath, result.output)

    if (result.exitCode !== 0) {
        opts.log(
            `  ${opts.ticket.filename}: install failed ` +
            `(exit ${result.exitCode}); ` +
            `see ${installLogPath}`
        )
        return false
    }
    return true
}

// Runs the project's test command in a ticket's worktree.
// Writes the output to a per-ticket log either way, and
// returns true only when the suite is green.
async function runTestGate (opts:{
    testCmd:string
    ticket:Ticket
    worktreePath:string
    timeout:number
    logsDir:string
    attempt?:number
    log:(msg:string) => void
    registry?:Set<number>
}):Promise<boolean> {
    const result = await runTestCmd({
        cmd:opts.testCmd,
        cwd:opts.worktreePath,
        timeout:opts.timeout,
        registry:opts.registry,
    })
    const testLogPath = attemptLogPath(
        opts.logsDir, opts.ticket, opts.attempt ?? 1,
        '.test.log'
    )
    writeFileSync(testLogPath, result.output)

    if (result.exitCode !== 0) {
        opts.log(
            `  ${opts.ticket.filename}: tests failed ` +
            `(exit ${result.exitCode}); ` +
            `see ${testLogPath}`
        )
        return false
    }

    opts.log(`  ${opts.ticket.filename}: tests passed`)
    return true
}

// Re-runs the agent in a ticket's existing worktree
// after a merge conflict, then retries the merge once.
// Called at most once per ticket per wave.
async function respawnAndRetryMerge (opts:{
    repoRoot:string
    baseBranch:string
    branch:string
    ticket:Ticket
    worktreePath:string
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    testCmd:string
    installCmd?:string
    maxTurns?:number
    onLine?:(msg:string) => void
}):Promise<boolean> {
    const log = (msg:string):void => {
        if (opts.onLine) {
            opts.onLine(msg)
        } else {
            console.log(msg)
        }
    }

    await updateWorktreeFromBase(
        opts.worktreePath, opts.baseBranch
    )

    const msg1 = `  ${opts.ticket.filename}: respawning agent ` +
        'to resolve merge conflict'
    if (opts.onLine) {
        opts.onLine(msg1)
    } else {
        console.log(msg1)
    }

    // The base branch may have changed the dependencies.
    if (opts.installCmd) {
        const installed = await runInstall({
            installCmd:opts.installCmd,
            ticket:opts.ticket,
            worktreePath:opts.worktreePath,
            timeout:opts.timeout,
            logsDir:opts.logsDir,
            log,
            registry:runningAgents,
        })
        if (!installed) return false
    }

    const prompt = renderMergePrompt(
        opts.specBody, opts.ticket,
        { installCmd:opts.installCmd }
    )
    const logPath = join(
        opts.logsDir,
        opts.ticket.filename.replace(/\.md$/, '.respawn.log')
    )
    const label = opts.ticket.filename.replace(
        /\.md$/, ''
    )
    const result = await spawnAgent({
        prompt,
        agentCmd:opts.agentCmd,
        model:opts.model,
        timeout:opts.timeout,
        logPath,
        cwd:opts.worktreePath,
        label,
        maxTurns:opts.maxTurns,
        onLine:opts.onLine,
    })

    if (result.exitCode !== 0) {
        const msg2 = `  ${opts.ticket.filename}: respawned agent ` +
            `exited ${result.exitCode}`
        if (opts.onLine) {
            opts.onLine(msg2)
        } else {
            console.log(msg2)
        }
        return false
    }

    const passed = await runTestGate({
        testCmd:opts.testCmd,
        ticket:opts.ticket,
        worktreePath:opts.worktreePath,
        timeout:opts.timeout,
        logsDir:opts.logsDir,
        log,
        registry:runningAgents,
    })
    if (!passed) {
        log(
            `  ${opts.ticket.filename}: tests failed ` +
            'after conflict respawn; not merging'
        )
        return false
    }

    const mergeResult = await mergeBranch(
        opts.repoRoot, opts.branch
    )
    if (!mergeResult.success) {
        const msg3 = `  ${opts.ticket.filename}: merge still ` +
            'conflicted after respawn'
        if (opts.onLine) {
            opts.onLine(msg3)
        } else {
            console.log(msg3)
        }
        if (mergeResult.stderr) {
            const stderrMsg =
                `  git: ${mergeResult.stderr.trim()}`
            if (opts.onLine) {
                opts.onLine(stderrMsg)
            } else {
                console.log(stderrMsg)
            }
        }
    }
    return mergeResult.success
}

export const DEFAULT_RETRIES = 3

// Seconds to wait before the first retry; each later retry
// doubles the wait so a provider outage is waited out instead
// of burning every attempt back to back.
export const DEFAULT_RETRY_DELAY = 30

// Max agents running at the same time within a wave.
export const DEFAULT_CONCURRENCY = 5

// Runs `fn` over `items`, at most `limit` at a time, and
// resolves with the results in item order. Each call is
// settled individually so one rejection does not stop
// the others.
export async function runPool<T, R> (
    items:T[],
    limit:number,
    fn:(item:T) => Promise<R>,
):Promise<PromiseSettledResult<R>[]> {
    const size = Math.max(1, Math.floor(limit))
    const results:PromiseSettledResult<R>[] = new Array(
        items.length
    )
    let next = 0
    async function worker ():Promise<void> {
        while (next < items.length) {
            const i = next++
            try {
                results[i] = {
                    status:'fulfilled',
                    value:await fn(items[i]),
                }
            } catch (reason) {
                results[i] = { status:'rejected', reason }
            }
        }
    }
    const workers = Array.from(
        { length:Math.min(size, items.length) },
        () => worker()
    )
    await Promise.all(workers)
    return results
}

export function retryDelayFor (base:number, attempt:number):number {
    return base * 2 ** (attempt - 2)
}

function sleep (ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Log file for one attempt: the first attempt keeps the
// plain name so existing tooling still finds it, later
// attempts get their own file instead of overwriting it.
function attemptLogPath (
    logsDir:string,
    ticket:Ticket,
    attempt:number,
    ext:string
):string {
    const stem = ticket.filename.replace(/\.md$/, '')
    const suffix = attempt > 1 ? `.attempt${attempt}` : ''
    return join(logsDir, `${stem}${suffix}${ext}`)
}

type TicketOutcome =
    | { kind:'worktree-error'; error:unknown }
    | {
        kind:'error'
        error:unknown
        worktreePath?:string
        branchName?:string
    }
    | {
        kind:'no-commits'
        worktreePath:string
        branchName:string
        // null only for the placeholder outcome in
        // runTicketAttempts, which no agent produced
        agentRun:AgentRunRecord|null
    }
    | {
        // No agent ran, so there is no agent record
        kind:'failed'
        reason:'install'
        branchName:string
        exitCode:number
        completedItems:string[]
    }
    | {
        kind:'failed'
        reason:'exit'|'tests'
        branchName:string
        // A placeholder 1 for 'tests'; the agent's real exit
        // code is agentRun.exitCode
        exitCode:number
        completedItems:string[]
        agentRun:AgentRunRecord
    }
    | {
        kind:'ready'
        worktreePath:string
        branchName:string
        completedItems:string[]
        agentRun:AgentRunRecord
    }

type TicketAttemptOpts = {
    ticket:Ticket
    repoRoot:string
    repoName:string
    baseBranch:string
    specBody:string
    specBodies?:Map<string, string>
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    testCmd:string
    installCmd?:string
    maxTurns?:number
    effort?:EffortLevel
    learningsPath:string
    d:Display
}

// The ticket's own earlier attempts and its direct blockers'
// last successful runs, rendered for the prompt. Learnings are
// advisory, so an unreadable log means no history, not a failure.
function buildHistory (
    learningsPath:string,
    ticket:Ticket,
    d:Display
):string {
    try {
        return renderHistory(selectHistory(
            readEntries(learningsPath),
            {
                key:ticketKey(ticket.feature, ticket.num),
                blockerKeys:ticket.blockers.map(b => {
                    return ticketKey(ticket.feature, b)
                }),
            }
        ))
    } catch (err) {
        d.log(
            `  ${ticket.filename}: could not read ` +
            `learnings: ${formatErrorMessage(err)}`
        )
        return ''
    }
}

// One attempt at a ticket: a fresh worktree, one agent run,
// and the checks that decide whether the branch can merge.
// A failed attempt removes its worktree before returning.
async function runTicketAttempt (
    opts:TicketAttemptOpts&{ attempt:number }
):Promise<TicketOutcome> {
    const { ticket, d } = opts

    let worktree:{ worktreePath:string; branchName:string }
    try {
        worktree = await createWorktree({
            repoRoot:opts.repoRoot,
            repoName:opts.repoName,
            baseBranch:opts.baseBranch,
            ticket,
        })
    } catch (error) {
        return { kind:'worktree-error', error }
    }

    d.setTicketStatus(
        ticket.num, 'in-progress', ticket.feature
    )
    if (opts.installCmd) {
        const installed = await runInstall({
            installCmd:opts.installCmd,
            ticket,
            worktreePath:worktree.worktreePath,
            timeout:opts.timeout,
            logsDir:opts.logsDir,
            attempt:opts.attempt,
            log:(msg) => d.log(msg),
            registry:runningAgents,
        })
        if (!installed) {
            await removeWorktreeQuietly(
                worktree.worktreePath, d
            )
            return {
                kind:'failed',
                reason:'install',
                branchName:worktree.branchName,
                exitCode:1,
                completedItems:[],
            }
        }
    }

    // Keeps the agent's notes out of any `git add -A`.
    try {
        ensureNotesIgnored(worktree.worktreePath)
    } catch (err) {
        d.log(
            `  ${ticket.filename}: could not set up the notes ` +
            `directory: ${formatErrorMessage(err)}`
        )
    }

    const ticketSpec = lookupSpec(
        opts.specBodies, opts.specBody, ticket.feature
    )
    const agentResult = await spawnAgent({
        prompt:renderPrompt(
            ticketSpec, ticket,
            {
                testCmd:opts.testCmd,
                installCmd:opts.installCmd,
                // Rebuilt every attempt, so a retry sees the
                // entry its previous attempt just wrote
                history:buildHistory(
                    opts.learningsPath, ticket, d
                ),
            }
        ),
        agentCmd:opts.agentCmd,
        model:opts.model,
        timeout:opts.timeout,
        logPath:attemptLogPath(
            opts.logsDir, ticket, opts.attempt, '.log'
        ),
        cwd:worktree.worktreePath,
        label:ticket.filename.replace(/\.md$/, ''),
        maxTurns:opts.maxTurns,
        effort:opts.effort,
        onLine:(line) => d.log(line),
    })

    // Collect before anything commits or removes the worktree,
    // so the notes never reach the timeout auto-commit.
    let notes:string|null = null
    try {
        notes = collectNotes(worktree.worktreePath)
    } catch (err) {
        d.log(
            `  ${ticket.filename}: could not collect ` +
            `notes: ${formatErrorMessage(err)}`
        )
    }
    const agentRun:AgentRunRecord = {
        exitCode:agentResult.exitCode,
        completedItems:agentResult.completedItems,
        timedOut:agentResult.timedOut,
        notes,
    }

    // A timeout kill is not the agent reporting failure.
    // Keep whatever it committed and let the test gate and
    // merge decide, instead of discarding the worktree.
    if (agentResult.timedOut) {
        d.log(
            `  ${ticket.filename}: timed out; ` +
            'keeping the work it committed'
        )
    } else if (agentResult.exitCode !== 0) {
        d.log(
            `  ${ticket.filename}: ` +
            `agent exited ${agentResult.exitCode}`
        )
        await removeWorktreeQuietly(worktree.worktreePath, d)
        return {
            kind:'failed',
            reason:'exit',
            branchName:worktree.branchName,
            exitCode:agentResult.exitCode,
            completedItems:agentResult.completedItems,
            agentRun,
        }
    }

    if (isDirty(worktree.worktreePath)) {
        const committed = await commitDirty(
            worktree.worktreePath,
            'nightralph: auto-commit ' +
            `${ticket.filename} remaining changes`
        )
        if (committed) {
            d.log(
                `  ${ticket.filename}: ` +
                'auto-committed remaining changes'
            )
        }
    }

    if (!hasNewCommits(
        opts.repoRoot, opts.baseBranch, worktree.branchName
    )) {
        await removeWorktreeQuietly(worktree.worktreePath, d)
        return {
            kind:'no-commits',
            worktreePath:worktree.worktreePath,
            branchName:worktree.branchName,
            agentRun,
        }
    }

    const passed = await runTestGate({
        testCmd:opts.testCmd,
        ticket,
        worktreePath:worktree.worktreePath,
        timeout:opts.timeout,
        logsDir:opts.logsDir,
        attempt:opts.attempt,
        log:(msg) => d.log(msg),
        registry:runningAgents,
    })
    if (!passed) {
        await removeWorktreeQuietly(
            worktree.worktreePath, d
        )
        return {
            kind:'failed',
            reason:'tests',
            branchName:worktree.branchName,
            exitCode:1,
            completedItems:agentResult.completedItems,
            agentRun,
        }
    }

    return {
        kind:'ready',
        worktreePath:worktree.worktreePath,
        branchName:worktree.branchName,
        completedItems:agentResult.completedItems,
        agentRun,
    }
}

// The last lines of a log for a learnings entry; a missing or
// unreadable log gives an empty tail.
function readLogTail (path:string):string {
    try {
        return tailLines(readFileSync(path, 'utf8'), LOG_TAIL_LINES)
    } catch {
        return ''
    }
}

// Maps one attempt's outcome to a learnings entry, or null when
// there is nothing to record. The exit code always comes from the
// agent record, never the outcome's top-level `exitCode`, which is
// a progress.md placeholder.
function attemptEntry (opts:{
    logsDir:string
    ticket:Ticket
    attempt:number
    effort?:EffortLevel
    outcome:TicketOutcome
}):EntryInput|null {
    const { logsDir, ticket, attempt, effort, outcome } = opts
    const base = {
        key:ticketKey(ticket.feature, ticket.num),
        label:ticketLabel(ticket),
        attempt,
        now:new Date(),
    }
    const logFor = (ext:string) => {
        const path = attemptLogPath(logsDir, ticket, attempt, ext)
        return { logName:basename(path), logTail:readLogTail(path) }
    }

    switch (outcome.kind) {
        case 'ready':
            return {
                ...base,
                outcome:'done',
                run:outcome.agentRun,
                effort,
            }
        case 'failed':
            switch (outcome.reason) {
                case 'exit':
                    return {
                        ...base,
                        outcome:'exit',
                        run:outcome.agentRun,
                        effort,
                    }
                case 'tests':
                    return {
                        ...base,
                        outcome:'tests',
                        run:outcome.agentRun,
                        effort,
                        ...logFor('.test.log'),
                    }
                case 'install':
                    return {
                        ...base,
                        outcome:'install',
                        ...logFor('.install.log'),
                    }
                default: {
                    const _exhaustive:never = outcome
                    return _exhaustive
                }
            }
        case 'no-commits':
            if (!outcome.agentRun) return null
            return {
                ...base,
                outcome:'no-commits',
                run:outcome.agentRun,
                effort,
            }
        case 'error':
        case 'worktree-error':
            return {
                ...base,
                outcome:'error',
                error:formatErrorMessage(outcome.error),
            }
        default: {
            const _exhaustive:never = outcome
            return _exhaustive
        }
    }
}

// Appends one attempt's entry to the learnings log. Learnings are
// advisory: a failure is reported and never fails the ticket.
function recordAttempt (opts:{
    learningsPath:string
    logsDir:string
    ticket:Ticket
    attempt:number
    effort?:EffortLevel
    outcome:TicketOutcome
    d:Display
}):void {
    try {
        const entry = attemptEntry(opts)
        if (!entry) return
        appendEntry(opts.learningsPath, renderEntry(entry))
    } catch (err) {
        opts.d.log(
            `  ${opts.ticket.filename}: could not record ` +
            `learnings: ${formatErrorMessage(err)}`
        )
    }
}

// Runs a ticket until an attempt is ready to merge or the
// retry cap is hit. Each retry starts from a fresh worktree
// and a higher effort level.
async function runTicketAttempts (
    opts:TicketAttemptOpts&{ retries:number; retryDelay:number }
):Promise<TicketOutcome> {
    const { ticket, d } = opts
    const maxAttempts = opts.retries + 1
    const providerName = basename(opts.agentCmd)
    const isKnown = providerName in EFFORT_LADDERS
    let effort = opts.effort
    let outcome:TicketOutcome = {
        kind:'no-commits',
        worktreePath:'',
        branchName:'',
        agentRun:null,
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt === 1) {
            d.log(`  Starting ${ticket.filename}`)
        } else {
            if (isKnown) {
                effort = escalateEffort(
                    providerName as ProviderName,
                    effort
                )
            }
            const delay = retryDelayFor(opts.retryDelay, attempt)
            d.log(
                `  ${ticket.filename}: retrying ` +
                `(attempt ${attempt}/${maxAttempts}` +
                (isKnown && effort ?
                    `, effort ${effort}` : '') +
                (delay > 0 ?
                    `, waiting ${delay}s` : '') +
                ')'
            )
            if (delay > 0) await sleep(delay * 1000)
        }
        const record = (o:TicketOutcome):void => {
            recordAttempt({
                learningsPath:opts.learningsPath,
                logsDir:opts.logsDir,
                ticket,
                attempt,
                effort,
                outcome:o,
                d,
            })
        }
        try {
            outcome = await runTicketAttempt({
                ...opts, attempt, effort,
            })
        } catch (error) {
            d.log(
                `  ${ticket.filename}: attempt ${attempt} ` +
                `threw: ${formatErrorMessage(error)}`
            )
            const errorOutcome:TicketOutcome = { kind:'error', error }
            record(errorOutcome)
            return errorOutcome
        }
        record(outcome)
        if (outcome.kind === 'ready') {
            // The agent is no longer running, but the branch is
            // only merged once the whole wave has finished.
            d.setTicketStatus(
                ticket.num, 'awaiting-merge',
                ticket.feature,
            )
            return outcome
        }
        if (outcome.kind === 'worktree-error') return outcome
    }
    return outcome
}

function failureNote (reason:'exit'|'tests'|'install'):string {
    if (reason === 'tests') return 'tests failed'
    if (reason === 'install') return 'install failed'
    return 'failed'
}

// A path that git can stage as a file: a directory or other bad
// path must not make `git add` fail and take a commit down with it.
function isRegularFile (path:string):boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}

// Wraps writeProgress + commitProgress so callers do not each
// need to guard against a commit failure (e.g. a git lock held
// by a concurrent process) crashing the run.
async function saveProgress (
    repoRoot:string,
    progressPath:string,
    progress:ProgressData,
    message:string,
    d:Display
):Promise<void> {
    writeProgress(progressPath, progress)
    const learningsPath = learningsPathFor(progressPath)
    const paths = isRegularFile(learningsPath) ?
        [progressPath, learningsPath] :
        progressPath
    try {
        await commitProgress(repoRoot, paths, message)
    } catch (err) {
        d.log(
            '  Failed to commit progress: ' +
            formatErrorMessage(err)
        )
    }
}

export const HUMAN_STATUS = 'ready-for-human'

function indentFilenames (tickets:ReadonlyArray<Ticket>):string {
    return tickets.map(t => `  ${t.filename}`).join('\n')
}

/**
 * The text logged when a run ends. The first line is the
 * count summary. When tickets marked ready-for-human are
 * still open, further lines name them and say that an
 * agent cannot finish them, so a run that exits with open
 * tickets never looks like it silently gave up.
 */
export function renderFinishSummary (
    tickets:ReadonlyArray<Ticket>,
    totalCompleted:number,
    failedKeys:ReadonlySet<string>,
):string {
    const remaining = tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    const human = tickets.filter(t => t.status === HUMAN_STATUS)
    const humanNums = new Set(human.map(t => t.num))
    const blockedByHuman = remaining.filter(t =>
        !failedKeys.has(ticketKey(t.feature, t.num)) &&
        t.blockers.some(b => humanNums.has(b))
    )

    const counts = `Finished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '') +
        (failedKeys.size > 0 ?
            `, ${failedKeys.size} failed` :
            '') +
        (human.length > 0 ?
            `, ${human.length} need a human` :
            '')

    const lines:string[] = [counts]

    const features = new Set(
        tickets.map(t => t.feature).filter(Boolean)
    )
    if (features.size > 1) {
        lines.push('')
        for (const feat of [...features].sort()) {
            const ft = tickets.filter(
                t => t.feature === feat
            )
            const done = ft.filter(
                t => t.status === 'done'
            ).length
            const failed = ft.filter(
                t => failedKeys.has(
                    ticketKey(t.feature, t.num)
                )
            ).length
            const rem = ft.filter(
                t => t.status === 'ready-for-agent'
            ).length
            let detail = `  ${feat}: ${done} completed`
            if (rem > 0) detail += `, ${rem} remaining`
            if (failed > 0) detail += `, ${failed} failed`
            lines.push(detail)
        }
    }

    if (human.length === 0) return lines.join('\n')

    const noun = human.length === 1 ?
        'ticket is' :
        'tickets are'
    lines.push(
        '',
        (remaining.length === 0 && failedKeys.size === 0 ?
            `All remaining ${noun} marked ${HUMAN_STATUS}. ` :
            `${human.length} ${noun} marked ${HUMAN_STATUS}. `) +
        'nightralph only runs ready-for-agent tickets, ' +
        'so an agent cannot finish these:',
        indentFilenames(human),
    )
    if (blockedByHuman.length > 0) {
        const n = blockedByHuman.length
        lines.push(
            `${n} ready-for-agent ticket${n === 1 ? ' is' : 's are'} ` +
            'blocked until they are done:',
            indentFilenames(blockedByHuman),
        )
    }
    lines.push(
        'Do that work by hand, then set each ticket\'s ' +
        '**Status:** to done' +
        (blockedByHuman.length > 0 ?
            ' and run nightralph again.' :
            '.')
    )
    return lines.join('\n')
}

function sessionTickets (
    tickets:ReadonlyArray<Ticket>,
):Array<Ticket> {
    return [...tickets]
        .filter(t => t.status === 'ready-for-agent')
        .sort((a, b) => (
            a.feature.localeCompare(b.feature) || a.num - b.num
        ))
}

function toRef (t:Ticket):TicketRef {
    return { num:t.num, filename:t.filename, feature:t.feature }
}

function reportBlocked (
    d:Display,
    tickets:ReadonlyArray<Ticket>,
    failedKeys:ReadonlySet<string>,
):void {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    for (const [key, dead] of findBlockedTickets(
        tickets, failedKeys
    )) {
        const ticket = byKey.get(key)
        if (!ticket) continue
        const labels = dead
            .map(k => byKey.get(k))
            .filter((t):t is Ticket => t !== undefined)
            .map(t => ticketLabel(toRef(t)))
        d.setBlocked(ticket.num, ticket.feature, labels)
    }
}

function runProgress (tickets:ReadonlyArray<Ticket>):RunProgress {
    return {
        completed:tickets.filter(t => t.status === 'done').length,
        total:tickets.length,
    }
}

export async function runWaves (
    tickets:Ticket[],
    specBody:string,
    agentCmd:string,
    model:string|null,
    timeout:number,
    logsDir:string,
    testCmd:string,
    display?:Display,
    maxTurns?:number,
    effort?:EffortLevel,
    retries?:number,
    retryDelay?:number,
    concurrency?:number,
):Promise<{ allDone:boolean }> {
    mkdirSync(logsDir, { recursive:true })

    const d = display ?? createDisplay()
    const maxAttempts = (retries ?? DEFAULT_RETRIES) + 1
    const delayBase = retryDelay ?? 0
    const poolSize = concurrency ?? DEFAULT_CONCURRENCY
    const providerName = basename(agentCmd)
    const isKnown = providerName in EFFORT_LADDERS
    let totalWaves = 0
    for (const _ of simulateWaves(tickets)) totalWaves++

    let totalCompleted = 0
    let waveNum = 0
    const failedKeys = new Set<string>()
    const session = sessionTickets(tickets)

    while (true) {
        if (waveNum > 0) reportBlocked(d, tickets, failedKeys)

        const ready = findReadyTickets(tickets).filter(
            t => !failedKeys.has(
                ticketKey(t.feature, t.num)
            )
        )
        if (ready.length === 0) break

        waveNum++
        if (waveNum === 1) {
            d.startRun(session.map(toRef))
            reportBlocked(d, tickets, failedKeys)
        }
        d.startWave(
            waveNum,
            totalWaves,
            ready.map(t => ({
                num:t.num,
                filename:t.filename,
                feature:t.feature,
            })),
            runProgress(session),
        )

        const results = await runPool(
            ready, poolSize, async t => {
                const prompt = renderPrompt(specBody, t,
                    { testCmd })
                const label = t.filename.replace(
                    /\.md$/, ''
                )
                d.setTicketStatus(
                    t.num, 'in-progress', t.feature
                )
                d.log(`  Starting ${t.filename}`)
                let level = effort
                let result = await spawnAgent({
                    prompt,
                    agentCmd,
                    model,
                    timeout,
                    logPath:attemptLogPath(logsDir, t, 1, '.log'),
                    label,
                    maxTurns,
                    effort:level,
                    onLine:(line) => d.log(line),
                })
                // In-place runs have no worktree or test
                // gate, so a non-zero exit is the only
                // failure that can be retried here.
                for (
                    let attempt = 2;
                    result.exitCode !== 0 &&
                    !result.timedOut &&
                    attempt <= maxAttempts;
                    attempt++
                ) {
                    if (isKnown) {
                        level = escalateEffort(
                            providerName as ProviderName,
                            level
                        )
                    }
                    const delay = retryDelayFor(delayBase, attempt)
                    d.log(
                        `  ${t.filename}: agent exited ` +
                        `${result.exitCode}; retrying ` +
                        `(attempt ${attempt}/${maxAttempts}` +
                        (isKnown && level ?
                            `, effort ${level}` : '') +
                        (delay > 0 ?
                            `, waiting ${delay}s` : '') +
                        ')'
                    )
                    if (delay > 0) await sleep(delay * 1000)
                    result = await spawnAgent({
                        prompt,
                        agentCmd,
                        model,
                        timeout,
                        logPath:attemptLogPath(
                            logsDir, t, attempt, '.log'
                        ),
                        label,
                        maxTurns,
                        effort:level,
                        onLine:(line) => d.log(line),
                    })
                }
                return { ticket:t, result }
            }
        )

        let waveCompleted = 0
        for (const r of results) {
            if (r.status === 'rejected') continue
            const { ticket, result } = r.value
            if (result.exitCode !== 0) {
                failedKeys.add(
                    ticketKey(ticket.feature, ticket.num)
                )
                d.setTicketStatus(
                    ticket.num, 'failed', ticket.feature
                )
                d.log(
                    `  ${ticket.filename}: ` +
                    `agent exited ${result.exitCode}`
                )
                continue
            }

            checkItems(ticket, result.completedItems)
            markDone(ticket)
            waveCompleted++
            totalCompleted++
            d.setTicketStatus(
                ticket.num, 'done', ticket.feature
            )
            d.log(
                `  ${ticket.filename}: done`
            )
        }

        if (waveCompleted === 0) {
            const remaining = findReadyTickets(tickets)
                .filter(t => !failedKeys.has(
                    ticketKey(t.feature, t.num)
                ))
            if (remaining.length === 0) {
                d.log(
                    '\nNo tickets completed this wave ' +
                    'and no ready tickets remain. ' +
                    'Stopping.'
                )
                break
            }
            d.log(
                '\nNo tickets completed this wave. ' +
                `${remaining.length} ready ticket` +
                `${remaining.length === 1 ? '' : 's'} ` +
                'remain; continuing.'
            )
        }
    }

    if (waveNum > 0) reportBlocked(d, tickets, failedKeys)

    const remaining = tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    d.log('\n' + renderFinishSummary(
        tickets, totalCompleted, failedKeys
    ))
    d.cleanup()

    return { allDone:remaining.length === 0 }
}

export async function runWavesIsolated (opts:{
    tickets:Array<Ticket>
    specBody:string
    specBodies?:Map<string, string>
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    featureName:string
    conflictStrategy:MergeConflictStrategy
    display?:Display
    testCmd:string
    // run in each fresh worktree before the agent; unset or
    // empty = no install
    installCmd?:string
    maxTurns?:number
    // starting effort level; unset = provider's default
    effort?:EffortLevel
    // extra attempts per ticket after a failure; default 3
    retries?:number
    // seconds to wait before the first retry; default 30
    retryDelay?:number
    // max agents running at once within a wave; default 5
    concurrency?:number
    // per-feature progress paths for multi-feature runs
    progressPaths?:Map<string, string>
}):Promise<{ allDone:boolean }> {
    mkdirSync(opts.logsDir, { recursive:true })

    const d = opts.display ?? createDisplay()
    const retries = opts.retries ?? DEFAULT_RETRIES
    const retryDelay = opts.retryDelay ?? 0
    const poolSize = opts.concurrency ?? DEFAULT_CONCURRENCY
    let totalWaves = 0
    for (const _ of simulateWaves(opts.tickets)) totalWaves++

    const repoRoot = getRepoRoot()
    const repoName = getRepoName()
    const baseBranch = getCurrentBranch()

    if (isDirty(repoRoot)) {
        throw new Error(
            'Working tree is dirty; commit or stash ' +
            'changes before running'
        )
    }

    const features = new Set(
        opts.tickets.map(t => t.feature).filter(Boolean)
    )
    const multiFeature = features.size > 1 &&
        opts.progressPaths !== undefined

    const fallbackProgressPath = join(
        dirname(opts.logsDir), 'progress.md'
    )

    let tracker:ProgressTracker
    if (multiFeature) {
        const multiData = generateMultiFeatureProgress(
            opts.tickets
        )
        const dataMap = new Map<string, ProgressData>()
        for (const [feat, fresh] of multiData) {
            const path = opts.progressPaths!.get(feat) ??
                fallbackProgressPath
            const merged = mergeProgress(
                fresh, readProgress(path)
            )
            dataMap.set(feat, merged)
            await saveProgress(
                repoRoot, path, merged,
                `nightralph: start ${feat}`, d,
            )
        }
        tracker = createProgressTracker({
            progressPaths:opts.progressPaths!,
            dataMap,
            fallbackPath:fallbackProgressPath,
            fallbackData:generateProgress(
                opts.featureName, []
            ),
        })
    } else {
        const progressPath = fallbackProgressPath
        const progress:ProgressData = mergeProgress(
            generateProgress(
                opts.featureName, opts.tickets
            ),
            readProgress(progressPath)
        )
        await saveProgress(
            repoRoot, progressPath, progress,
            `nightralph: start ${opts.featureName}`, d,
        )
        tracker = createProgressTracker({
            progressPaths:new Map(),
            dataMap:new Map(),
            fallbackPath:progressPath,
            fallbackData:progress,
        })
    }

    let totalCompleted = 0
    let waveNum = 0
    const failedKeys = new Set<string>()
    const session = sessionTickets(opts.tickets)

    while (true) {
        if (waveNum > 0) reportBlocked(d, opts.tickets, failedKeys)

        const ready = findReadyTickets(opts.tickets).filter(
            t => !failedKeys.has(
                ticketKey(t.feature, t.num)
            )
        )
        if (ready.length === 0) break

        waveNum++
        if (waveNum === 1) {
            d.startRun(session.map(toRef))
            reportBlocked(d, opts.tickets, failedKeys)
        }
        d.startWave(
            waveNum,
            totalWaves,
            ready.map(t => ({
                num:t.num,
                filename:t.filename,
                feature:t.feature,
            })),
            runProgress(session),
        )

        // Each ticket runs its own attempt loop, at most
        // `poolSize` at a time. Progress is recorded
        // afterwards, sequentially, so commits on the base
        // branch never race each other.
        const settled = await runPool(
            ready, poolSize, t => runTicketAttempts({
                ticket:t,
                repoRoot,
                repoName,
                baseBranch,
                specBody:opts.specBody,
                specBodies:opts.specBodies,
                agentCmd:opts.agentCmd,
                model:opts.model,
                timeout:opts.timeout,
                logsDir:opts.logsDir,
                testCmd:opts.testCmd,
                installCmd:opts.installCmd,
                maxTurns:opts.maxTurns,
                effort:opts.effort,
                learningsPath:learningsPathFor(
                    tracker.pathFor(t.feature)
                ),
                retries,
                retryDelay,
                d,
            })
        )

        // Entries were appended while the pool ran, but not every
        // outcome below saves progress before merging. Commit them
        // now, so the base tree has no modified tracked files when
        // mergeWave touches it.
        const touched = new Set(ready.map(t => {
            return learningsPathFor(tracker.pathFor(t.feature))
        }))
        for (const path of touched) {
            if (!isRegularFile(path)) continue
            try {
                await commitProgress(
                    repoRoot, path,
                    'nightralph: record attempt learnings'
                )
            } catch (err) {
                d.log(
                    '  Failed to commit learnings: ' +
                    formatErrorMessage(err)
                )
            }
        }

        // runTicketAttempts never rejects (a throw inside an
        // attempt becomes an 'error' outcome), so every
        // result here is fulfilled.
        const outcomes:TicketOutcome[] = settled.map(r =>
            r.status === 'fulfilled' ?
                r.value :
                { kind:'error', error:r.reason }
        )

        let waveCompleted = 0
        const successfulBranches:Array<{
            branch:string
            ticketNum:number
            worktreePath:string
        }> = []
        const ticketsByKey = new Map<string, Ticket>()
        const worktreePathsByKey = new Map<string, string>()
        const branchToKey = new Map<string, string>()

        for (let i = 0; i < outcomes.length; i++) {
            const outcome = outcomes[i]
            const ticket = ready[i]
            const key = ticketKey(ticket.feature, ticket.num)

            if (outcome.kind === 'worktree-error') {
                failedKeys.add(key)
                d.setTicketStatus(
                    ticket.num, 'failed', ticket.feature
                )
                d.log(
                    `  ${ticket.filename}: failed to create ` +
                    `worktree: ${formatErrorMessage(outcome.error)}`
                )
                checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                    branch:'',
                    exitCode:-1,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    tracker.pathFor(ticket.feature),
                    tracker.dataFor(ticket.feature),
                    `nightralph: ${ticket.filename} ` +
                    'worktree error',
                    d,
                )
                continue
            }

            if (outcome.kind === 'error') {
                failedKeys.add(key)
                d.setTicketStatus(
                    ticket.num, 'failed', ticket.feature
                )
                d.log(
                    `  ${ticket.filename}: attempt error: ` +
                    formatErrorMessage(outcome.error)
                )
                checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                    branch:outcome.branchName ?? '',
                    exitCode:-1,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    tracker.pathFor(ticket.feature),
                    tracker.dataFor(ticket.feature),
                    `nightralph: ${ticket.filename} error`,
                    d,
                )
                continue
            }

            if (outcome.kind === 'no-commits') {
                failedKeys.add(key)
                d.setTicketStatus(
                    ticket.num, 'failed', ticket.feature
                )
                d.log(
                    `  ${ticket.filename}: agent exited 0 ` +
                    'but made no changes; leaving ticket ' +
                    'ready-for-agent'
                )
                checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                    branch:outcome.branchName,
                    exitCode:0,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    tracker.pathFor(ticket.feature),
                    tracker.dataFor(ticket.feature),
                    `nightralph: ${ticket.filename} ` +
                    'no commits',
                    d,
                )
                continue
            }

            if (outcome.kind === 'failed') {
                failedKeys.add(key)
                d.setTicketStatus(
                    ticket.num, 'failed', ticket.feature
                )
                if (outcome.reason === 'exit') {
                    checkItems(ticket, outcome.completedItems)
                }
                checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                    branch:outcome.branchName,
                    exitCode:outcome.exitCode,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    tracker.pathFor(ticket.feature),
                    tracker.dataFor(ticket.feature),
                    `nightralph: ${ticket.filename} ` +
                    failureNote(outcome.reason),
                    d,
                )
                continue
            }

            checkItems(ticket, outcome.completedItems)
            d.log(
                `  ${ticket.filename}: agent finished, ` +
                'awaiting merge'
            )
            ticketsByKey.set(key, ticket)
            worktreePathsByKey.set(
                key, outcome.worktreePath
            )
            branchToKey.set(outcome.branchName, key)
            successfulBranches.push({
                branch:outcome.branchName,
                ticketNum:ticket.num,
                worktreePath:outcome.worktreePath,
            })
        }

        if (successfulBranches.length > 0) {
            await commitTicketFiles(
                repoRoot,
                successfulBranches
                    .map(sb => {
                        const k = branchToKey.get(sb.branch)!
                        return ticketsByKey.get(k)!
                    }),
                d,
            )

            const mergeResult = await mergeWave({
                repoRoot,
                baseBranch,
                branches:successfulBranches,
                strategy:opts.conflictStrategy,
            })

            for (const branchResult of mergeResult.merged) {
                const bk = branchToKey.get(
                    branchResult.branch
                )
                const ticket = bk ?
                    ticketsByKey.get(bk) :
                    undefined
                if (!ticket) continue

                if (branchResult.merged) {
                    markDone(ticket)
                    waveCompleted++
                    totalCompleted++
                    d.setTicketStatus(
                        ticket.num, 'done', ticket.feature
                    )
                    d.log(
                        `  ${ticket.filename}: done`
                    )
                    checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                        branch:branchResult.branch,
                        exitCode:0,
                    })
                    await saveProgress(
                        repoRoot,
                        tracker.pathFor(ticket.feature),
                        tracker.dataFor(ticket.feature),
                        `nightralph: ${ticket.filename} done`,
                        d,
                    )

                    const worktreePath = bk ?
                        worktreePathsByKey.get(bk) :
                        undefined
                    if (worktreePath) {
                        await removeWorktreeQuietly(
                            worktreePath, d
                        )
                    }
                } else {
                    const wtKey = branchToKey.get(
                        branchResult.branch
                    )
                    const worktreePath = wtKey ?
                        worktreePathsByKey.get(wtKey) :
                        undefined
                    const recovered =
                        opts.conflictStrategy === 'respawn' &&
                        worktreePath ?
                            await respawnAndRetryMerge({
                                repoRoot,
                                baseBranch,
                                branch:branchResult.branch,
                                ticket,
                                worktreePath,
                                specBody:lookupSpec(
                                    opts.specBodies,
                                    opts.specBody,
                                    ticket.feature,
                                ),
                                agentCmd:opts.agentCmd,
                                model:opts.model,
                                timeout:opts.timeout,
                                logsDir:opts.logsDir,
                                testCmd:opts.testCmd,
                                installCmd:opts.installCmd,
                                maxTurns:opts.maxTurns,
                                onLine:(msg) => d.log(msg),
                            }) :
                            false

                    if (recovered) {
                        markDone(ticket)
                        waveCompleted++
                        totalCompleted++
                        d.setTicketStatus(
                            ticket.num, 'done',
                            ticket.feature,
                        )
                        d.log(
                            `  ${ticket.filename}: done ` +
                            '(resolved via respawn)'
                        )
                        checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                            branch:branchResult.branch,
                            exitCode:0,
                        })
                        await saveProgress(
                            repoRoot,
                            tracker.pathFor(ticket.feature),
                            tracker.dataFor(ticket.feature),
                            `nightralph: ${ticket.filename} ` +
                            'done (respawn)',
                            d,
                        )

                        if (worktreePath) {
                            try {
                                await removeWorktree(
                                    worktreePath,
                                    { force:true }
                                )
                            } catch (err) {
                                d.log(
                                    '  Failed to remove worktree ' +
                                    `${worktreePath}: ` +
                                    formatErrorMessage(err)
                                )
                            }
                        }
                    } else {
                        failedKeys.add(
                            ticketKey(ticket.feature, ticket.num)
                        )
                        d.setTicketStatus(
                            ticket.num, 'failed', ticket.feature
                        )
                        d.log(
                            `  ${ticket.filename}: merge failed, ` +
                            'staying ready-for-agent'
                        )
                        if (branchResult.stderr) {
                            d.log(
                                '  git: ' +
                                branchResult.stderr.trim()
                            )
                        }
                        checkTicket(tracker.dataFor(ticket.feature), ticket.num, {
                            branch:branchResult.branch,
                            exitCode:0,
                            done:false,
                        })
                        // saveProgress below commits this entry
                        try {
                            appendEntry(
                                learningsPathFor(
                                    tracker.pathFor(ticket.feature)
                                ),
                                renderEntry({
                                    outcome:'merge',
                                    key:ticketKey(
                                        ticket.feature, ticket.num
                                    ),
                                    label:ticketLabel(ticket),
                                    attempt:0,
                                    now:new Date(),
                                    stderr:branchResult.stderr ?? '',
                                })
                            )
                        } catch (err) {
                            d.log(
                                `  ${ticket.filename}: could not ` +
                                'record learnings: ' +
                                formatErrorMessage(err)
                            )
                        }
                        await saveProgress(
                            repoRoot,
                            tracker.pathFor(ticket.feature),
                            tracker.dataFor(ticket.feature),
                            `nightralph: ${ticket.filename} ` +
                            'merge failed',
                            d,
                        )
                    }
                }
            }

            if (mergeResult.stoppedAt) {
                d.log(
                    '\nMerge stopped at ' +
                    `${mergeResult.stoppedAt.branch}`
                )

                for (const sb of successfulBranches) {
                    const sbk = branchToKey.get(sb.branch)
                    const ticket = sbk ?
                        ticketsByKey.get(sbk) :
                        undefined
                    if (ticket && ticket.status === 'done') continue
                    try {
                        await removeWorktree(
                            sb.worktreePath,
                            { force:true }
                        )
                    } catch (err) {
                        d.log(
                            '  Failed to remove worktree ' +
                            `${sb.worktreePath}: ` +
                            formatErrorMessage(err)
                        )
                    }
                }

                break
            }
        }

        if (waveCompleted === 0) {
            const remaining = findReadyTickets(
                opts.tickets
            ).filter(t => !failedKeys.has(
                ticketKey(t.feature, t.num)
            ))
            if (remaining.length === 0) {
                d.log(
                    '\nNo tickets completed this wave ' +
                    'and no ready tickets remain. ' +
                    'Stopping.'
                )
                break
            }
            d.log(
                '\nNo tickets completed this wave. ' +
                `${remaining.length} ready ticket` +
                `${remaining.length === 1 ? '' : 's'} ` +
                'remain; continuing.'
            )
        }
    }

    if (waveNum > 0) reportBlocked(d, opts.tickets, failedKeys)

    const remaining = opts.tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    d.log('\n' + renderFinishSummary(
        opts.tickets, totalCompleted, failedKeys
    ))
    d.cleanup()

    return { allDone:remaining.length === 0 }
}
