import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Ticket } from './orchestrator.js'

const TICKET_FILENAME_RE = /^(\d+)-(.+)\.md$/

const execFileAsync = promisify(execFile)

export type TicketProgress = {
    num:number
    slug:string
    filename:string
    done:boolean
    branch:string|null
    exitCode:number|null
    completedAt:string|null
}

export type ProgressData = {
    feature:string
    startedAt:string
    tickets:Array<TicketProgress>
}

export function generateProgress (
    feature:string,
    tickets:ReadonlyArray<Ticket>
):ProgressData {
    return {
        feature,
        startedAt:new Date().toISOString(),
        tickets:tickets.map((ticket) => ({
            num:ticket.num,
            slug:ticket.slug,
            filename:ticket.filename,
            done:false,
            branch:null,
            exitCode:null,
            completedAt:null,
        })),
    }
}

export function generateMultiFeatureProgress (
    tickets:ReadonlyArray<Ticket>
):Map<string, ProgressData> {
    const byFeature = new Map<string, Ticket[]>()
    for (const t of tickets) {
        const key = t.feature || ''
        const arr = byFeature.get(key) ?? []
        arr.push(t)
        byFeature.set(key, arr)
    }
    const result = new Map<string, ProgressData>()
    for (const [feat, ft] of byFeature) {
        result.set(feat, generateProgress(feat, ft))
    }
    return result
}

export type ProgressTracker = {
    dataFor:(feature:string) => ProgressData
    pathFor:(feature:string) => string
}

export function createProgressTracker (opts:{
    progressPaths:Map<string, string>
    dataMap:Map<string, ProgressData>
    fallbackPath:string
    fallbackData:ProgressData
}):ProgressTracker {
    return {
        dataFor (feature:string):ProgressData {
            return opts.dataMap.get(feature) ??
                opts.fallbackData
        },
        pathFor (feature:string):string {
            return opts.progressPaths.get(feature) ??
                opts.fallbackPath
        },
    }
}

export function isSpecComplete (
    progressPath:string
):boolean {
    const data = readProgress(progressPath)
    if (!data) return false
    if (data.tickets.length === 0) return false
    return data.tickets.every(t => t.done)
}

export function readProgress (
    progressPath:string
):ProgressData|null {
    let content:string
    try {
        content = readFileSync(progressPath, 'utf8')
    } catch {
        return null
    }

    const featureMatch = content.match(/^# Progress: (.*)$/m)
    const startedMatch = content.match(/^Started: (.*)$/m)

    const tickets:Array<TicketProgress> = []
    let current:TicketProgress|null = null

    for (const line of content.split('\n')) {
        const ticketMatch = line.match(/^- \[( |x)\] (.+)$/)
        if (ticketMatch) {
            if (current) tickets.push(current)
            const filename = ticketMatch[2]
            const parsed = filename.match(TICKET_FILENAME_RE)
            current = {
                num:parsed ? Number(parsed[1]) : NaN,
                slug:parsed ? parsed[2] : '',
                filename,
                done:ticketMatch[1] === 'x',
                branch:null,
                exitCode:null,
                completedAt:null,
            }
            continue
        }
        if (!current) continue

        const branchMatch = line.match(/^ {2}branch: (.*)$/)
        if (branchMatch) {
            current.branch = branchMatch[1]
            continue
        }
        const exitMatch = line.match(/^ {2}exit: (-?\d+)$/)
        if (exitMatch) {
            current.exitCode = Number(exitMatch[1])
            continue
        }
        const completedMatch = line.match(/^ {2}completed: (.*)$/)
        if (completedMatch) {
            current.completedAt = completedMatch[1]
            continue
        }
    }
    if (current) tickets.push(current)

    return {
        feature:featureMatch ? featureMatch[1] : '',
        startedAt:startedMatch ? startedMatch[1] : '',
        tickets,
    }
}

export function mergeProgress (
    fresh:ProgressData,
    existing:ProgressData|null
):ProgressData {
    if (!existing) return fresh

    const existingByFilename = new Map(
        existing.tickets.map((t) => [t.filename, t])
    )

    return {
        ...fresh,
        tickets:fresh.tickets.map((ticket) => {
            const prior = existingByFilename.get(ticket.filename)
            return (prior && prior.done) ? { ...prior } : ticket
        }),
    }
}

export function renderProgress (data:ProgressData):string {
    const lines:Array<string> = [
        `# Progress: ${data.feature}`,
        '',
        `Started: ${data.startedAt}`,
        '',
    ]

    for (const ticket of data.tickets) {
        const checkbox = ticket.done ? '[x]' : '[ ]'
        lines.push(`- ${checkbox} ${ticket.filename}`)

        if (ticket.done || ticket.exitCode !== null) {
            if (ticket.branch) {
                lines.push(
                    `  branch: ${ticket.branch}`
                )
            }
            if (ticket.exitCode !== null) {
                lines.push(
                    `  exit: ${ticket.exitCode}`
                )
            }
            if (ticket.completedAt) {
                lines.push(
                    `  completed: ${ticket.completedAt}`
                )
            }
        }
    }

    return lines.join('\n') + '\n'
}

export function checkTicket (
    data:ProgressData,
    ticketNum:number,
    result:{ branch:string; exitCode:number; done?:boolean }
):void {
    const ticket = data.tickets.find(
        (t) => t.num === ticketNum
    )
    if (!ticket) return

    ticket.done = result.done ?? true
    ticket.branch = result.branch
    ticket.exitCode = result.exitCode
    if (ticket.done) {
        ticket.completedAt = new Date().toISOString()
    }
}

export function writeProgress (
    progressPath:string,
    data:ProgressData
):void {
    writeFileSync(
        progressPath,
        renderProgress(data)
    )
}

export async function commitProgress (
    repoRoot:string,
    paths:string|string[],
    message:string
):Promise<boolean> {
    const list = typeof paths === 'string' ?
        [paths] :
        paths
    await execFileAsync(
        'git',
        ['add', '--force', '--', ...list],
        { cwd:repoRoot }
    )

    try {
        await execFileAsync(
            'git',
            ['diff', '--cached', '--quiet', '--', ...list],
            { cwd:repoRoot }
        )
        return false
    } catch {
        // non-zero exit means the staged file differs from HEAD
    }

    await execFileAsync(
        'git',
        ['commit', '-m', message, '--', ...list],
        { cwd:repoRoot }
    )
    return true
}
