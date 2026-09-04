import { spawn } from 'node:child_process'
import {
    createWriteStream,
    mkdirSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createInterface } from 'node:readline'
import {
    getRepoRoot,
    getRepoName,
    getCurrentBranch,
    createWorktree,
    removeWorktree,
    hasNewCommits,
    isDirty,
    commitDirty,
} from './worktree.js'
import {
    generateProgress,
    readProgress,
    mergeProgress,
    writeProgress,
    commitProgress,
    checkTicket,
    type ProgressData,
} from './progress.js'
import {
    mergeBranch,
    mergeWave,
    updateWorktreeFromBase,
    type MergeConflictStrategy,
} from './merge.js'
import {
    createDisplay,
    type RunProgress,
    type Display,
} from './display.js'
import { runTestCmd } from './testcmd.js'

export type Ticket = {
    num:number
    slug:string
    filename:string
    filepath:string
    body:string
    status:string
    blockers:number[]
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
        await removeWorktree(worktreePath)
    } catch (err) {
        d.log(
            '  Failed to remove worktree ' +
            `${worktreePath}: ` +
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

export function scanTickets (dir:string):Ticket[] {
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
        }
    })
}

export function findReadyTickets (
    tickets:ReadonlyArray<Ticket>
):Ticket[] {
    const doneNums = new Set(
        tickets
            .filter(t => t.status === 'done')
            .map(t => t.num)
    )
    return tickets.filter(t => {
        if (t.status !== 'ready-for-agent') return false
        return t.blockers.every(b => doneNums.has(b))
    })
}

export const COMPLETED_RE = /^\[x\]\s+(.+)$/i
export const TOOL_USE_RE = /^\[[\w.]+\]/

export function checkItems (
    ticket:Ticket,
    completedItems:string[]
):void {
    if (completedItems.length === 0) return
    let body = ticket.body
    for (const item of completedItems) {
        const escaped = item.replace(
            /[.*+?^${}()|[\]\\]/g, '\\$&'
        )
        body = body.replace(
            new RegExp(
                `- \\[ \\] ${escaped}`,
                'i'
            ),
            `- [x] ${item}`
        )
    }
    writeFileSync(ticket.filepath, body)
    ticket.body = body
}

export function markDone (ticket:Ticket):void {
    const updated = ticket.body.replace(
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

export function renderPrompt (
    specBody:string,
    ticket:Ticket,
    opts:{ testCmd?:string|null } = {}
):string {
    const testRules = opts.testCmd ?
        [
            '- Work test-first. For each checklist ' +
                'item, write a failing test at the ' +
                'seams named in the spec\'s Testing ' +
                'Decisions section, then write only ' +
                'enough code to make it pass.',
            `- Run \`${opts.testCmd}\` before ` +
                'committing. Do not commit with failing ' +
                'tests. The orchestrator runs the same ' +
                'command after you exit and rejects the ' +
                'ticket if it fails.',
        ] :
        []

    return [
        '---- SPEC CONTEXT ----',
        specBody,
        '',
        '---- TICKET ----',
        ticket.filename,
        ticket.body,
        '',
        '---- AGENT INSTRUCTIONS ----',
        'You are an autonomous coding agent. ' +
            'Implement the ticket.',
        '',
        'Follow these rules:',
        '- Read the files directly relevant to the ' +
            'ticket before writing code.',
        '- Do NOT research external APIs or services ' +
            'via web search. Use the spec and ticket ' +
            'body as your sole reference for API shapes.',
        ...testRules,
        '- Commit your work when finished.',
        '- After completing each checklist item in the ' +
            'ticket, print a line: [x] <item text> ' +
            '(matching the checklist text exactly).',
        '',
    ].join('\n')
}

export function renderMergePrompt (
    specBody:string,
    ticket:Ticket
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
        '2. Make sure the code compiles and tests pass.',
        '3. Commit the resolved files.',
        '',
        'Do NOT re-implement the ticket from scratch.',
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
        tickets.map(t => [t.num, t.status])
    )
    let wave = 1
    while (true) {
        const doneNums = new Set(
            [...sim.entries()]
                .filter(([, s]) => s === 'done')
                .map(([n]) => n)
        )
        const ready = [...tickets].filter(t => {
            if (sim.get(t.num) !== 'ready-for-agent') {
                return false
            }
            return t.blockers.every(
                b => doneNums.has(b)
            )
        })
        if (ready.length === 0) break
        yield { wave, ready }
        for (const t of ready) {
            sim.set(t.num, 'done')
        }
        wave++
    }
}

function detectDeadlocks (
    tickets:ReadonlyArray<Ticket>
):Array<Ticket> {
    const doneNums = new Set<number>()
    const ready = new Set<number>()

    for (const t of tickets) {
        if (t.status === 'ready-for-agent') {
            ready.add(t.num)
        } else if (t.status === 'done') {
            doneNums.add(t.num)
        }
    }

    let changed = true
    while (changed) {
        changed = false
        for (const num of ready) {
            const ticket = tickets.find(t =>
                t.num === num
            )!
            if (ticket.blockers.every(
                b => doneNums.has(b)
            )) {
                doneNums.add(num)
                ready.delete(num)
                changed = true
            }
        }
    }

    return [...ready].map(num =>
        tickets.find(t => t.num === num)!
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

// The thinking levels pi accepts, lowest to highest.
export const THINKING_LEVELS = [
    'off', 'minimal', 'low', 'medium',
    'high', 'xhigh', 'max',
] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]

// The level for a retry. Without a starting level the
// first retry jumps to high; otherwise step one rung up
// and stop at max.
export function escalateThinking (
    level?:ThinkingLevel
):ThinkingLevel {
    if (!level) return 'high'
    const i = THINKING_LEVELS.indexOf(level)
    return THINKING_LEVELS[
        Math.min(i + 1, THINKING_LEVELS.length - 1)
    ]
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

export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
    maxTurns?:number
    // pi only; other providers ignore it
    thinking?:ThinkingLevel
    onLine?:(line:string) => void
}):Promise<AgentResult> {
    const args:string[] = [
        ...getProviderArgs(opts.agentCmd),
    ]
    if (opts.model) {
        args.push('--model', opts.model)
    }
    if (opts.maxTurns) {
        args.push('--max-turns', String(opts.maxTurns))
    }

    const providerName = basename(opts.agentCmd)
    const isClaude = providerName === 'claude'
    const isPi = providerName === 'pi'
    if (isPi && opts.thinking) {
        args.push('--thinking', opts.thinking)
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
    })

    proc.stdout.pipe(logStream)

    const piFormatter = isPi ?
        createPiStreamFormatter() :
        null

    const completedItems:string[] = []

    function collectCompleted (text:string):void {
        const match = text.match(COMPLETED_RE)
        if (match) completedItems.push(match[1])
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

    proc.stderr.pipe(logStream)
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
        proc.kill('SIGKILL')
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
        proc.on('close', code => {
            clearTimeout(timeout)
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
            resolve({
                exitCode:code ?? 1,
                completedItems,
                timedOut,
            })
        })
        proc.on('error', err => {
            clearTimeout(timeout)
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
    specBody:string
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
            renderPrompt(specBody, firstReady[0])
        )
    }
}

export function dryRunIsolated (opts:{
    tickets:Array<Ticket>
    specBody:string
    repoName:string
    conflictStrategy:MergeConflictStrategy
    progressPath:string
    testCmd?:string|null
    thinking?:ThinkingLevel
    retries?:number
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
            const branchName =
                `${opts.repoName}/${num}-${t.slug}`
            const worktreePath =
                `../${opts.repoName}.${num}-${t.slug}`
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
                { testCmd:opts.testCmd }
            )
        )
    }

    const strategyDesc =
        opts.conflictStrategy === 'respawn' ?
            'respawn (re-run agent on conflict)' :
            'stop (stop merging on conflict)'
    console.log(
        `\nTest command: ${opts.testCmd ?? '(none)'}`
    )
    console.log(
        `Thinking:     ${opts.thinking ?? '(provider default)'}`
    )
    console.log(
        `Retries:      ${opts.retries ?? DEFAULT_RETRIES}`
    )
    console.log(
        `\nMerge strategy: ${strategyDesc}`
    )
    console.log(`Progress file: ${opts.progressPath}`)
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
}):Promise<boolean> {
    const result = await runTestCmd({
        cmd:opts.testCmd,
        cwd:opts.worktreePath,
        timeout:opts.timeout,
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
    testCmd?:string|null
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

    const prompt = renderMergePrompt(
        opts.specBody, opts.ticket
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

    if (opts.testCmd) {
        const passed = await runTestGate({
            testCmd:opts.testCmd,
            ticket:opts.ticket,
            worktreePath:opts.worktreePath,
            timeout:opts.timeout,
            logsDir:opts.logsDir,
            log,
        })
        if (!passed) {
            log(
                `  ${opts.ticket.filename}: tests failed ` +
                'after conflict respawn; not merging'
            )
            return false
        }
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

export const DEFAULT_RETRIES = 2

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
    | { kind:'no-commits' }
    | {
        kind:'failed'
        reason:'exit'|'tests'
        branchName:string
        exitCode:number
        completedItems:string[]
    }
    | {
        kind:'ready'
        worktreePath:string
        branchName:string
        completedItems:string[]
    }

type TicketAttemptOpts = {
    ticket:Ticket
    repoRoot:string
    repoName:string
    baseBranch:string
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    testCmd?:string|null
    maxTurns?:number
    thinking?:ThinkingLevel
    d:Display
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

    d.setTicketStatus(ticket.num, 'in-progress')
    const agentResult = await spawnAgent({
        prompt:renderPrompt(
            opts.specBody, ticket,
            { testCmd:opts.testCmd }
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
        thinking:opts.thinking,
        onLine:(line) => d.log(line),
    })

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
        return { kind:'no-commits' }
    }

    if (opts.testCmd) {
        const passed = await runTestGate({
            testCmd:opts.testCmd,
            ticket,
            worktreePath:worktree.worktreePath,
            timeout:opts.timeout,
            logsDir:opts.logsDir,
            attempt:opts.attempt,
            log:(msg) => d.log(msg),
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
            }
        }
    }

    return {
        kind:'ready',
        worktreePath:worktree.worktreePath,
        branchName:worktree.branchName,
        completedItems:agentResult.completedItems,
    }
}

// Runs a ticket until an attempt is ready to merge or the
// retry cap is hit. Each retry starts from a fresh worktree
// and, for pi, a higher thinking level.
async function runTicketAttempts (
    opts:TicketAttemptOpts&{ retries:number }
):Promise<TicketOutcome> {
    const { ticket, d } = opts
    const maxAttempts = opts.retries + 1
    const isPi = basename(opts.agentCmd) === 'pi'
    let thinking = opts.thinking
    let outcome:TicketOutcome = { kind:'no-commits' }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt === 1) {
            d.log(`  Starting ${ticket.filename}`)
        } else {
            thinking = escalateThinking(thinking)
            d.log(
                `  ${ticket.filename}: retrying ` +
                `(attempt ${attempt}/${maxAttempts}` +
                (isPi ? `, thinking ${thinking}` : '') +
                ')'
            )
        }
        outcome = await runTicketAttempt({
            ...opts, attempt, thinking,
        })
        if (
            outcome.kind === 'ready' ||
            outcome.kind === 'worktree-error'
        ) {
            return outcome
        }
    }
    return outcome
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
    try {
        await commitProgress(repoRoot, progressPath, message)
    } catch (err) {
        d.log(
            '  Failed to commit progress: ' +
            formatErrorMessage(err)
        )
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
    display?:Display,
    maxTurns?:number,
    thinking?:ThinkingLevel,
    retries?:number,
):Promise<{ allDone:boolean }> {
    mkdirSync(logsDir, { recursive:true })

    const d = display ?? createDisplay()
    const maxAttempts = (retries ?? DEFAULT_RETRIES) + 1
    const isPi = basename(agentCmd) === 'pi'
    let totalWaves = 0
    for (const _ of simulateWaves(tickets)) totalWaves++

    let totalCompleted = 0
    let waveNum = 0
    const failedNums = new Set<number>()

    while (true) {
        const ready = findReadyTickets(tickets).filter(
            t => !failedNums.has(t.num)
        )
        if (ready.length === 0) break

        waveNum++
        const readyNums = new Set(ready.map(t => t.num))
        const remaining = tickets.filter(t =>
            t.status === 'ready-for-agent' &&
            !readyNums.has(t.num)
        )
        d.startWave(
            waveNum,
            totalWaves,
            ready.map(t => ({
                num:t.num,
                filename:t.filename,
            })),
            runProgress(tickets),
            remaining.map(t => ({
                num:t.num,
                filename:t.filename,
            })),
        )

        const results = await Promise.allSettled(
            ready.map(async t => {
                const prompt = renderPrompt(specBody, t)
                const label = t.filename.replace(
                    /\.md$/, ''
                )
                d.setTicketStatus(t.num, 'in-progress')
                d.log(`  Starting ${t.filename}`)
                let level = thinking
                let result = await spawnAgent({
                    prompt,
                    agentCmd,
                    model,
                    timeout,
                    logPath:attemptLogPath(logsDir, t, 1, '.log'),
                    label,
                    maxTurns,
                    thinking:level,
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
                    level = escalateThinking(level)
                    d.log(
                        `  ${t.filename}: agent exited ` +
                        `${result.exitCode}; retrying ` +
                        `(attempt ${attempt}/${maxAttempts}` +
                        (isPi ? `, thinking ${level}` : '') +
                        ')'
                    )
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
                        thinking:level,
                        onLine:(line) => d.log(line),
                    })
                }
                return { ticket:t, result }
            })
        )

        let waveCompleted = 0
        for (const r of results) {
            if (r.status === 'rejected') continue
            const { ticket, result } = r.value
            if (result.exitCode !== 0) {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
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
            d.setTicketStatus(ticket.num, 'done')
            d.log(
                `  ${ticket.filename}: done`
            )
        }

        if (waveCompleted === 0) {
            d.log(
                '\nNo tickets completed this wave. ' +
                'Stopping.'
            )
            break
        }
    }

    const remaining = tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    d.log(
        `\nFinished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '') +
        (failedNums.size > 0 ?
            `, ${failedNums.size} failed` :
            '')
    )
    d.cleanup()

    return { allDone:remaining.length === 0 }
}

export async function runWavesIsolated (opts:{
    tickets:Array<Ticket>
    specBody:string
    agentCmd:string
    model:string|null
    timeout:number
    logsDir:string
    featureName:string
    conflictStrategy:MergeConflictStrategy
    display?:Display
    testCmd?:string|null
    maxTurns?:number
    // starting thinking level for pi; unset = pi's default
    thinking?:ThinkingLevel
    // extra attempts per ticket after a failure; default 2
    retries?:number
}):Promise<{ allDone:boolean }> {
    mkdirSync(opts.logsDir, { recursive:true })

    const d = opts.display ?? createDisplay()
    const retries = opts.retries ?? DEFAULT_RETRIES
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

    const progressPath = join(
        dirname(opts.logsDir), 'progress.md'
    )
    const progress:ProgressData = mergeProgress(
        generateProgress(opts.featureName, opts.tickets),
        readProgress(progressPath)
    )
    await saveProgress(
        repoRoot,
        progressPath,
        progress,
        `nightralph: start ${opts.featureName}`,
        d,
    )

    if (!opts.testCmd) {
        d.log('  Test gate disabled: no test command')
    }

    let totalCompleted = 0
    let waveNum = 0
    const failedNums = new Set<number>()

    while (true) {
        const ready = findReadyTickets(opts.tickets).filter(
            t => !failedNums.has(t.num)
        )
        if (ready.length === 0) break

        waveNum++
        const readyNums = new Set(ready.map(t => t.num))
        const remaining = opts.tickets.filter(t =>
            t.status === 'ready-for-agent' &&
            !readyNums.has(t.num)
        )
        d.startWave(
            waveNum,
            totalWaves,
            ready.map(t => ({
                num:t.num,
                filename:t.filename,
            })),
            runProgress(opts.tickets),
            remaining.map(t => ({
                num:t.num,
                filename:t.filename,
            })),
        )

        // Each ticket runs its own attempt loop in parallel.
        // Progress is recorded afterwards, sequentially, so
        // commits on the base branch never race each other.
        const outcomes = await Promise.all(
            ready.map(t => runTicketAttempts({
                ticket:t,
                repoRoot,
                repoName,
                baseBranch,
                specBody:opts.specBody,
                agentCmd:opts.agentCmd,
                model:opts.model,
                timeout:opts.timeout,
                logsDir:opts.logsDir,
                testCmd:opts.testCmd,
                maxTurns:opts.maxTurns,
                thinking:opts.thinking,
                retries,
                d,
            }))
        )

        let waveCompleted = 0
        const successfulBranches:Array<{
            branch:string
            ticketNum:number
            worktreePath:string
        }> = []
        const ticketsByNum = new Map<number, Ticket>()
        const worktreePathsByNum = new Map<number, string>()

        for (let i = 0; i < outcomes.length; i++) {
            const outcome = outcomes[i]
            const ticket = ready[i]

            if (outcome.kind === 'worktree-error') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: failed to create ` +
                    `worktree: ${formatErrorMessage(outcome.error)}`
                )
                continue
            }

            if (outcome.kind === 'no-commits') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: agent exited 0 ` +
                    'but made no changes; leaving ticket ' +
                    'ready-for-agent'
                )
                continue
            }

            if (outcome.kind === 'failed') {
                failedNums.add(ticket.num)
                d.setTicketStatus(ticket.num, 'failed')
                if (outcome.reason === 'exit') {
                    checkItems(ticket, outcome.completedItems)
                }
                // Acceptance criteria are not met when the
                // suite is red, so checklist items the agent
                // claimed are not checked off in that case.
                checkTicket(progress, ticket.num, {
                    branch:outcome.branchName,
                    exitCode:outcome.exitCode,
                    done:false,
                })
                await saveProgress(
                    repoRoot,
                    progressPath,
                    progress,
                    `nightralph: ${ticket.filename} ` +
                    (outcome.reason === 'tests' ?
                        'tests failed' :
                        'failed'),
                    d,
                )
                continue
            }

            checkItems(ticket, outcome.completedItems)
            d.log(
                `  ${ticket.filename}: agent finished, ` +
                'awaiting merge'
            )
            ticketsByNum.set(ticket.num, ticket)
            worktreePathsByNum.set(
                ticket.num, outcome.worktreePath
            )
            successfulBranches.push({
                branch:outcome.branchName,
                ticketNum:ticket.num,
                worktreePath:outcome.worktreePath,
            })
        }

        if (successfulBranches.length > 0) {
            const mergeResult = await mergeWave({
                repoRoot,
                baseBranch,
                branches:successfulBranches,
                strategy:opts.conflictStrategy,
            })

            for (const branchResult of mergeResult.merged) {
                const ticket = ticketsByNum.get(
                    branchResult.ticketNum
                )
                if (!ticket) continue

                if (branchResult.merged) {
                    markDone(ticket)
                    waveCompleted++
                    totalCompleted++
                    d.setTicketStatus(ticket.num, 'done')
                    d.log(
                        `  ${ticket.filename}: done`
                    )
                    checkTicket(progress, ticket.num, {
                        branch:branchResult.branch,
                        exitCode:0,
                    })
                    await saveProgress(
                        repoRoot,
                        progressPath,
                        progress,
                        `nightralph: ${ticket.filename} done`,
                        d,
                    )

                    const worktreePath = worktreePathsByNum.get(
                        ticket.num
                    )
                    if (worktreePath) {
                        await removeWorktreeQuietly(
                            worktreePath, d
                        )
                    }
                } else {
                    const worktreePath = worktreePathsByNum.get(
                        ticket.num
                    )
                    const recovered =
                        opts.conflictStrategy === 'respawn' &&
                        worktreePath ?
                            await respawnAndRetryMerge({
                                repoRoot,
                                baseBranch,
                                branch:branchResult.branch,
                                ticket,
                                worktreePath,
                                specBody:opts.specBody,
                                agentCmd:opts.agentCmd,
                                model:opts.model,
                                timeout:opts.timeout,
                                logsDir:opts.logsDir,
                                testCmd:opts.testCmd,
                                maxTurns:opts.maxTurns,
                                onLine:(msg) => d.log(msg),
                            }) :
                            false

                    if (recovered) {
                        markDone(ticket)
                        waveCompleted++
                        totalCompleted++
                        d.setTicketStatus(ticket.num, 'done')
                        d.log(
                            `  ${ticket.filename}: done ` +
                            '(resolved via respawn)'
                        )
                        checkTicket(progress, ticket.num, {
                            branch:branchResult.branch,
                            exitCode:0,
                        })
                        await saveProgress(
                            repoRoot,
                            progressPath,
                            progress,
                            `nightralph: ${ticket.filename} ` +
                            'done (respawn)',
                            d,
                        )

                        if (worktreePath) {
                            try {
                                await removeWorktree(worktreePath)
                            } catch (err) {
                                d.log(
                                    '  Failed to remove worktree ' +
                                    `${worktreePath}: ` +
                                    formatErrorMessage(err)
                                )
                            }
                        }
                    } else {
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
                        checkTicket(progress, ticket.num, {
                            branch:branchResult.branch,
                            exitCode:0,
                            done:false,
                        })
                        await saveProgress(
                            repoRoot,
                            progressPath,
                            progress,
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
                    const ticket = ticketsByNum.get(sb.ticketNum)
                    if (ticket && ticket.status === 'done') continue
                    try {
                        await removeWorktree(sb.worktreePath)
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
            d.log(
                '\nNo tickets completed this wave. ' +
                'Stopping.'
            )
            break
        }
    }

    const remaining = opts.tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    d.log(
        `\nFinished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '') +
        (failedNums.size > 0 ?
            `, ${failedNums.size} failed` :
            '')
    )
    d.cleanup()

    return { allDone:remaining.length === 0 }
}
