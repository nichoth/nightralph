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
        '- Commit your work when finished.',
        '',
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

export function createPiStreamFormatter ():((line:string) => string|null) {
    const calls = new Map<number, { name:string; buf:string }>()

    return (line:string):string|null => {
        let obj:Record<string, unknown>
        try {
            obj = JSON.parse(line) as
                Record<string, unknown>
        } catch {
            return line
        }

        const evt = obj.assistantMessageEvent as
            Record<string, unknown>|undefined
        if (!evt) return null

        const type = evt.type as string|undefined
        const ci = evt.contentIndex as
            number|undefined ?? -1

        if (type === 'text_delta') {
            return (evt.delta as string|undefined) ??
                null
        }

        if (type === 'toolcall_start') {
            calls.set(ci, {
                name:(evt.toolName as
                    string|undefined) ?? '?',
                buf:'',
            })
            return null
        }

        if (
            type === 'toolcall_delta' &&
            calls.has(ci)
        ) {
            calls.get(ci)!.buf +=
                (evt.delta as string|undefined) ?? ''
            return null
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
            return `[${call.name}] ${label}`
        }

        return null
    }
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

export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeout:number
    logPath:string
    cwd?:string
    label?:string
}):Promise<number> {
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

    const rl = createInterface({ input:proc.stdout })
    rl.on('line', line => {
        if (isClaude) {
            const formatted = formatStreamLine(line)
            if (formatted !== null) {
                console.log(`${prefix}${formatted}`)
            }
        } else if (piFormatter) {
            const formatted = piFormatter(line)
            if (formatted !== null) {
                console.log(`${prefix}${formatted}`)
            }
        } else {
            console.log(`${prefix}${line}`)
        }
    })

    proc.stderr.pipe(logStream)
    const rlErr = createInterface({ input:proc.stderr })
    rlErr.on('line', line => {
        console.error(`${prefix}${line}`)
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

    return new Promise<number>(resolve => {
        proc.on('close', code => {
            clearTimeout(timeout)
            rl.close()
            rlErr.close()
            logStream.end()
            if (promptFile) cleanupPromptFile(promptFile)
            resolve(code ?? 1)
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
            resolve(1)
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
            renderPrompt(opts.specBody, firstReady[0])
        )
    }

    const strategyDesc =
        opts.conflictStrategy === 'respawn' ?
            'respawn (re-run agent on conflict)' :
            'stop (stop merging on conflict)'
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
}):Promise<boolean> {
    await updateWorktreeFromBase(
        opts.worktreePath, opts.baseBranch
    )

    console.log(
        `  ${opts.ticket.filename}: respawning agent ` +
        'to resolve merge conflict'
    )
    const prompt = renderPrompt(opts.specBody, opts.ticket)
    const logPath = join(
        opts.logsDir,
        opts.ticket.filename.replace(/\.md$/, '.respawn.log')
    )
    const label = opts.ticket.filename.replace(
        /\.md$/, ''
    )
    const exitCode = await spawnAgent({
        prompt,
        agentCmd:opts.agentCmd,
        model:opts.model,
        timeout:opts.timeout,
        logPath,
        cwd:opts.worktreePath,
        label,
    })

    if (exitCode !== 0) {
        console.log(
            `  ${opts.ticket.filename}: respawned agent ` +
            `exited ${exitCode}`
        )
        return false
    }

    const merged = await mergeBranch(
        opts.repoRoot, opts.branch
    )
    if (!merged) {
        console.log(
            `  ${opts.ticket.filename}: merge still ` +
            'conflicted after respawn'
        )
    }
    return merged
}

export async function runWaves (
    tickets:Ticket[],
    specBody:string,
    agentCmd:string,
    model:string|null,
    timeout:number,
    logsDir:string,
):Promise<{ allDone:boolean }> {
    mkdirSync(logsDir, { recursive:true })

    let totalCompleted = 0
    let waveNum = 0

    while (true) {
        const ready = findReadyTickets(tickets)
        if (ready.length === 0) break

        waveNum++
        console.log(
            `\nWave ${waveNum}: ` +
            ready.map(t => t.filename).join(', ')
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
                console.log(`  Starting ${t.filename}`)
                const code = await spawnAgent({
                    prompt,
                    agentCmd,
                    model,
                    timeout,
                    logPath,
                    label,
                })
                return { ticket:t, exitCode:code }
            })
        )

        let waveCompleted = 0
        for (const r of results) {
            if (r.status === 'rejected') continue
            const { ticket, exitCode } = r.value
            if (exitCode !== 0) {
                console.log(
                    `  ${ticket.filename}: ` +
                    `agent exited ${exitCode}`
                )
                continue
            }

            markDone(ticket)
            waveCompleted++
            totalCompleted++
            console.log(
                `  ${ticket.filename}: done`
            )
        }

        if (waveCompleted === 0) {
            console.log(
                '\nNo tickets completed this wave. ' +
                'Stopping.'
            )
            break
        }
    }

    const remaining = tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    console.log(
        `\nFinished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '')
    )

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
}):Promise<{ allDone:boolean }> {
    mkdirSync(opts.logsDir, { recursive:true })

    const repoRoot = getRepoRoot()
    const repoName = getRepoName()
    const baseBranch = getCurrentBranch()

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
        console.log(
            `\nWave ${waveNum}: ` +
            ready.map(t => t.filename).join(', ')
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
                console.log(
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
                const prompt = renderPrompt(opts.specBody, t)
                const logPath = join(
                    opts.logsDir,
                    t.filename.replace(/\.md$/, '.log')
                )
                const label = t.filename.replace(
                    /\.md$/, ''
                )
                console.log(`  Starting ${t.filename}`)
                return spawnAgent({
                    prompt,
                    agentCmd:opts.agentCmd,
                    model:opts.model,
                    timeout:opts.timeout,
                    logPath,
                    cwd:worktrees[i].worktreePath,
                    label,
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
            const exitCode = r.value
            const ticket = activeTickets[i]
            const worktree = worktrees[i]

            if (exitCode !== 0) {
                console.log(
                    `  ${ticket.filename}: ` +
                    `agent exited ${exitCode}`
                )
                checkTicket(progress, ticket.num, {
                    branch:worktree.branchName,
                    exitCode,
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
                    console.error(
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
                    console.log(
                        `  ${ticket.filename}: ` +
                        'auto-committed remaining changes'
                    )
                }
            }

            if (!hasNewCommits(
                repoRoot, baseBranch, worktree.branchName
            )) {
                console.log(
                    `  ${ticket.filename}: agent exited 0 ` +
                    'but made no changes; leaving ticket ' +
                    'ready-for-agent'
                )
                continue
            }

            console.log(
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
                    console.log(
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
                            console.error(
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
                            }) :
                            false

                    if (recovered) {
                        markDone(ticket)
                        waveCompleted++
                        totalCompleted++
                        console.log(
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
                                console.error(
                                    '  Failed to remove worktree ' +
                                    `${worktreePath}: ` +
                                    formatErrorMessage(err)
                                )
                            }
                        }
                    } else {
                        console.log(
                            `  ${ticket.filename}: merge failed, ` +
                            'staying ready-for-agent'
                        )
                    }
                }
            }

            if (mergeResult.stoppedAt) {
                console.log(
                    '\nMerge stopped at ' +
                    `${mergeResult.stoppedAt.branch}`
                )

                for (const sb of successfulBranches) {
                    const ticket = ticketsByNum.get(sb.ticketNum)
                    if (ticket && ticket.status === 'done') continue
                    try {
                        await removeWorktree(sb.worktreePath)
                    } catch (err) {
                        console.error(
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
            console.log(
                '\nNo tickets completed this wave. ' +
                'Stopping.'
            )
            break
        }
    }

    const remaining = opts.tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    console.log(
        `\nFinished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '')
    )

    return { allDone:remaining.length === 0 }
}
