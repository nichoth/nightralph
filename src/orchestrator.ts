import { spawn } from 'node:child_process'
import {
    createWriteStream,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
} from 'node:fs'
import { join } from 'node:path'

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
            .filter(t => t.status !== 'ready-for-agent')
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
    ].join('\n')
}

export function spawnAgent (opts:{
    prompt:string
    agentCmd:string
    model:string|null
    timeoutSecs:number
    logPath:string
}):Promise<number> {
    const args:string[] = []
    if (opts.model) {
        args.push('--model', opts.model)
    }

    const logStream = createWriteStream(
        opts.logPath,
        { flags:'w' }
    )
    const proc = spawn(opts.agentCmd, args, {
        stdio:['pipe', 'pipe', 'pipe'],
    })

    proc.stdout.pipe(logStream)
    proc.stderr.pipe(logStream)

    const timeout = setTimeout(() => {
        if (!proc.killed) {
            console.warn(
                'Agent did not exit in ' +
                `${opts.timeoutSecs}s; killing.`
            )
            proc.kill('SIGKILL')
        }
    }, opts.timeoutSecs * 1000)

    proc.stdin.write(opts.prompt)
    proc.stdin.end()

    return new Promise<number>(resolve => {
        proc.on('close', code => {
            clearTimeout(timeout)
            logStream.end()
            resolve(code ?? 1)
        })
        proc.on('error', err => {
            clearTimeout(timeout)
            logStream.end()
            console.error(
                'Agent process error:',
                formatErrorMessage(err)
            )
            resolve(1)
        })
    })
}

export function dryRun (
    tickets:Ticket[],
    specBody:string
):void {
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

    console.log('\nSimulated wave order:')
    const sim = new Map(
        tickets.map(t => [t.num, t.status])
    )
    let wave = 1
    while (true) {
        const doneNums = new Set(
            [...sim.entries()]
                .filter(([, s]) => s !== 'ready-for-agent')
                .map(([n]) => n)
        )
        const ready = tickets.filter(t => {
            if (sim.get(t.num) !== 'ready-for-agent') {
                return false
            }
            return t.blockers.every(
                b => doneNums.has(b)
            )
        })
        if (ready.length === 0) break
        console.log(
            `  Wave ${wave}: ` +
            ready.map(t => t.filename).join(', ')
        )
        for (const t of ready) {
            sim.set(t.num, 'done')
        }
        wave++
    }

    const stuck = tickets.filter(
        t => sim.get(t.num) === 'ready-for-agent'
    )
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

export async function runWaves (
    tickets:Ticket[],
    specBody:string,
    agentCmd:string,
    model:string|null,
    timeoutSecs:number,
    logsDir:string,
):Promise<void> {
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
                console.log(`  Starting ${t.filename}`)
                const code = await spawnAgent({
                    prompt,
                    agentCmd,
                    model,
                    timeoutSecs,
                    logPath,
                })
                return { ticket:t, exitCode:code }
            })
        )

        let waveCompleted = 0
        for (const r of results) {
            if (r.status === 'rejected') continue
            const { ticket, exitCode } = r.value
            if (exitCode === 0) {
                markDone(ticket)
                waveCompleted++
                totalCompleted++
                console.log(
                    `  ${ticket.filename}: done`
                )
            } else {
                console.log(
                    `  ${ticket.filename}: ` +
                    `agent exited ${exitCode}`
                )
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

    const remaining = tickets.filter(
        t => t.status === 'ready-for-agent'
    )
    console.log(
        `\nFinished: ${totalCompleted} completed` +
        (remaining.length > 0 ?
            `, ${remaining.length} remaining` :
            '')
    )
}
