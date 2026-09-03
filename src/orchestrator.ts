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
        'Time is limited. Follow these rules:',
        '- Spend at most 2 minutes reading existing ' +
            'code. Read only the files directly relevant ' +
            'to the ticket.',
        '- Do NOT research external APIs or services ' +
            'via web search. Use the spec and ticket ' +
            'body as your sole reference for API shapes.',
        '- Start writing code as soon as you understand ' +
            'the immediate context. You can read more ' +
            'files as needed while implementing.',
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
    codex:['exec', '--full-auto'],
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
}

export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
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

    const timeout = setTimeout(() => {
        if (!proc.killed) {
            console.warn(
                'Agent did not exit in ' +
                `${opts.timeout}s; killing.`
            )
            proc.kill('SIGKILL')
        }
    }, opts.timeout * 1000)

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
            resolve({ exitCode:1, completedItems })
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
        `\nMerge strategy: ${strategyDesc}`
    )
    console.log(`Progress file: ${opts.progressPath}`)
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
    onLine?:(msg:string) => void
}):Promise<boolean> {
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
):Promise<{ allDone:boolean }> {
    mkdirSync(logsDir, { recursive:true })

    const d = display ?? createDisplay()
    let totalWaves = 0
    for (const _ of simulateWaves(tickets)) totalWaves++

    let totalCompleted = 0
    let waveNum = 0

    while (true) {
        const ready = findReadyTickets(tickets)
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
                const logPath = join(
                    logsDir,
                    t.filename.replace(/\.md$/, '.log')
                )
                const label = t.filename.replace(
                    /\.md$/, ''
                )
                d.setTicketStatus(t.num, 'in-progress')
                d.log(`  Starting ${t.filename}`)
                const result = await spawnAgent({
                    prompt,
                    agentCmd,
                    model,
                    timeout,
                    logPath,
                    label,
                    onLine:(line) => d.log(line),
                })
                return { ticket:t, result }
            })
        )

        let waveCompleted = 0
        for (const r of results) {
            if (r.status === 'rejected') continue
            const { ticket, result } = r.value
            if (result.exitCode !== 0) {
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
}):Promise<{ allDone:boolean }> {
    mkdirSync(opts.logsDir, { recursive:true })

    const d = opts.display ?? createDisplay()
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
    writeProgress(progressPath, progress)
    await commitProgress(
        repoRoot,
        progressPath,
        `nightralph: start ${opts.featureName}`
    )

    let totalCompleted = 0
    let waveNum = 0

    while (true) {
        const ready = findReadyTickets(opts.tickets)
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

        const worktreeSettled = await Promise.allSettled(
            ready.map(t => createWorktree({
                repoRoot,
                repoName,
                baseBranch,
                ticket:t,
            }))
        )

        const activeTickets:Array<Ticket> = []
        const worktrees:Array<{
            worktreePath:string
            branchName:string
        }> = []

        for (let i = 0; i < worktreeSettled.length; i++) {
            const settled = worktreeSettled[i]
            const ticket = ready[i]
            if (settled.status === 'rejected') {
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: failed to create ` +
                    `worktree: ${formatErrorMessage(settled.reason)}`
                )
                continue
            }
            activeTickets.push(ticket)
            worktrees.push(settled.value)
        }

        const results = await Promise.allSettled(
            activeTickets.map((t, i) => {
                const prompt = renderPrompt(
                    opts.specBody, t,
                    { testCmd:opts.testCmd }
                )
                const logPath = join(
                    opts.logsDir,
                    t.filename.replace(/\.md$/, '.log')
                )
                const label = t.filename.replace(
                    /\.md$/, ''
                )
                d.setTicketStatus(t.num, 'in-progress')
                d.log(`  Starting ${t.filename}`)
                return spawnAgent({
                    prompt,
                    agentCmd:opts.agentCmd,
                    model:opts.model,
                    timeout:opts.timeout,
                    logPath,
                    cwd:worktrees[i].worktreePath,
                    label,
                    onLine:(line) => d.log(line),
                })
            })
        )

        let waveCompleted = 0
        const successfulBranches:Array<{
            branch:string
            ticketNum:number
            worktreePath:string
        }> = []
        const ticketsByNum = new Map<number, Ticket>()
        const worktreePathsByNum = new Map<number, string>()

        for (let i = 0; i < results.length; i++) {
            const r = results[i]
            if (r.status === 'rejected') continue
            const agentResult = r.value
            const ticket = activeTickets[i]
            const worktree = worktrees[i]

            if (agentResult.exitCode !== 0) {
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: ` +
                    `agent exited ${agentResult.exitCode}`
                )
                checkItems(ticket, agentResult.completedItems)
                checkTicket(progress, ticket.num, {
                    branch:worktree.branchName,
                    exitCode:agentResult.exitCode,
                    done:false,
                })
                writeProgress(progressPath, progress)
                await commitProgress(
                    repoRoot,
                    progressPath,
                    `nightralph: ${ticket.filename} failed`
                )

                try {
                    await removeWorktree(worktree.worktreePath)
                } catch (err) {
                    d.log(
                        '  Failed to remove worktree ' +
                        `${worktree.worktreePath}: ` +
                        formatErrorMessage(err)
                    )
                }
                continue
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
                repoRoot, baseBranch, worktree.branchName
            )) {
                d.setTicketStatus(ticket.num, 'failed')
                d.log(
                    `  ${ticket.filename}: agent exited 0 ` +
                    'but made no changes; leaving ticket ' +
                    'ready-for-agent'
                )
                continue
            }

            if (opts.testCmd) {
                const testResult = await runTestCmd({
                    cmd:opts.testCmd,
                    cwd:worktree.worktreePath,
                    timeout:opts.timeout,
                })
                const testLogPath = join(
                    opts.logsDir,
                    ticket.filename.replace(
                        /\.md$/, '.test.log'
                    )
                )
                writeFileSync(testLogPath, testResult.output)

                if (testResult.exitCode !== 0) {
                    // Acceptance criteria are not met when
                    // the suite is red, so checklist items
                    // the agent claimed are not checked off.
                    d.setTicketStatus(ticket.num, 'failed')
                    d.log(
                        `  ${ticket.filename}: tests failed ` +
                        `(exit ${testResult.exitCode}); ` +
                        `see ${testLogPath}`
                    )
                    checkTicket(progress, ticket.num, {
                        branch:worktree.branchName,
                        exitCode:testResult.exitCode,
                        done:false,
                    })
                    writeProgress(progressPath, progress)
                    await commitProgress(
                        repoRoot,
                        progressPath,
                        `nightralph: ${ticket.filename} ` +
                            'tests failed'
                    )
                    try {
                        await removeWorktree(
                            worktree.worktreePath
                        )
                    } catch (err) {
                        d.log(
                            '  Failed to remove worktree ' +
                            `${worktree.worktreePath}: ` +
                            formatErrorMessage(err)
                        )
                    }
                    continue
                }

                d.log(`  ${ticket.filename}: tests passed`)
            }

            checkItems(ticket, agentResult.completedItems)
            d.log(
                `  ${ticket.filename}: agent finished, ` +
                'awaiting merge'
            )
            ticketsByNum.set(ticket.num, ticket)
            worktreePathsByNum.set(
                ticket.num, worktree.worktreePath
            )
            successfulBranches.push({
                branch:worktree.branchName,
                ticketNum:ticket.num,
                worktreePath:worktree.worktreePath,
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
                    writeProgress(progressPath, progress)
                    await commitProgress(
                        repoRoot,
                        progressPath,
                        `nightralph: ${ticket.filename} done`
                    )

                    const worktreePath = worktreePathsByNum.get(
                        ticket.num
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
                        writeProgress(progressPath, progress)
                        await commitProgress(
                            repoRoot,
                            progressPath,
                            `nightralph: ${ticket.filename} ` +
                            'done (respawn)'
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
                        writeProgress(progressPath, progress)
                        await commitProgress(
                            repoRoot,
                            progressPath,
                            `nightralph: ${ticket.filename} ` +
                            'merge failed'
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
            '')
    )
    d.cleanup()

    return { allDone:remaining.length === 0 }
}
