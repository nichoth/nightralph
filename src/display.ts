export type TicketStatus =
    | 'pending'
    | 'in-progress'
    | 'awaiting-merge'
    | 'done'
    | 'failed'
    | 'blocked'

export type DisplayTicket = {
    readonly num:number
    readonly filename:string
    readonly feature?:string
    status:TicketStatus
    blockedBy?:ReadonlyArray<string>
}

export type TicketRef = {
    readonly num:number
    readonly filename:string
    readonly feature?:string
}

export type WaveState = {
    readonly waveNum:number
    readonly totalWaves:number
}

export type DisplayConfig = {
    readonly stream:NodeJS.WriteStream
}

/**
 * Progress across the whole run, not just the current wave.
 * `completed` counts this run's tickets done before the wave
 * started; `total` is the size of this run's ticket list. Only
 * PlainDisplay prints it; StatusDisplay counts from its own list.
 */
export type RunProgress = {
    readonly completed:number
    readonly total:number
}

export type Display = {
    /**
     * Called once at the start of the run, fixes the ticket list
     * for the entire session.
     */
    startRun(tickets:ReadonlyArray<TicketRef>):void
    startWave(
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<TicketRef>,
        progress?:RunProgress,
    ):void
    setTicketStatus(
        num:number,
        status:TicketStatus,
        feature?:string,
    ):void
    /**
     * Mark a ticket as blocked; `blockedBy` holds display labels
     * of the upstream tickets that failed or need a human.
     */
    setBlocked(
        num:number,
        feature:string|undefined,
        blockedBy:ReadonlyArray<string>,
    ):void
    log(message:string):void
    cleanup():void
}

const ESC = '\x1b['

export const ansi = {
    cursorUp (n:number):string {
        return `${ESC}${n}A`
    },
    cursorTo (col:number):string {
        return `${ESC}${col}G`
    },
    eraseLine ():string {
        return `${ESC}2K`
    },
    eraseLines (n:number):string {
        let out = ''
        for (let i = 0; i < n; i++) {
            out += ansi.eraseLine()
            if (i < n - 1) out += ansi.cursorUp(1)
        }
        return out
    },
    cursorHide ():string {
        return `${ESC}?25l`
    },
    cursorShow ():string {
        return `${ESC}?25h`
    },
} as const

export const color = {
    green (text:string):string {
        return `${ESC}32m${text}${ESC}0m`
    },
    yellow (text:string):string {
        return `${ESC}33m${text}${ESC}0m`
    },
    red (text:string):string {
        return `${ESC}31m${text}${ESC}0m`
    },
    cyan (text:string):string {
        return `${ESC}36m${text}${ESC}0m`
    },
    dim (text:string):string {
        return `${ESC}2m${text}${ESC}0m`
    },
} as const

export function ticketLabel (
    ticket:{ num:number; filename:string; feature?:string },
):string {
    if (ticket.feature) {
        const padded = String(ticket.num).padStart(2, '0')
        return `${ticket.feature}/${padded}`
    }
    return ticket.filename
}

const FILLED_DOT = '●'
const EMPTY_DOT = '○'
const SEPARATOR_WIDTH = 50
const DEFAULT_COLUMNS = 80
const MIN_LOG_ROWS = 1
const MAX_MESSAGE_BUFFER = 200

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

function rowText (ticket:DisplayTicket):string {
    const label = ticketLabel(ticket)
    if (ticket.status !== 'blocked' || !ticket.blockedBy?.length) {
        return label
    }
    return `${label} (blocked by ${ticket.blockedBy.join(', ')})`
}

/**
 * Clamp a line to `width` visible columns so it can never wrap.
 * A wrapped line occupies more terminal rows than `render`
 * counts, which leaves stale rows behind on the next erase.
 */
export function fitLine (line:string, width:number):string {
    const visible = line.replace(ANSI_RE, '')
    if (visible.length <= width) return line
    return visible.slice(0, width)
}

/**
 * Split a line into rows of at most `width` visible columns,
 * the way a terminal would wrap it. Short lines keep their
 * ANSI styling; long lines are wrapped on visible text only,
 * so `render` can count every row it emits.
 */
export function wrapLine (line:string, width:number):Array<string> {
    const visible = line.replace(ANSI_RE, '')
    if (visible.length <= width) return [line]
    const rows:Array<string> = []
    for (let i = 0; i < visible.length; i += width) {
        rows.push(visible.slice(i, i + width))
    }
    return rows
}

export function renderDot (status:TicketStatus):string {
    switch (status) {
        case 'pending':
            return color.dim(EMPTY_DOT)
        case 'in-progress':
            return color.yellow(FILLED_DOT)
        // The agent and its test gate are finished; the branch
        // waits for the rest of the wave before it is merged. It
        // stays cyan through the merge and any conflict respawn.
        case 'awaiting-merge':
            return color.cyan(FILLED_DOT)
        case 'done':
            return color.green(FILLED_DOT)
        case 'failed':
            return color.red(FILLED_DOT)
        case 'blocked':
            // Ticket cannot run this session because an upstream
            // ticket failed or needs a human.
            return color.dim(FILLED_DOT)
    }
}

export class StatusDisplay implements Display {
    private wave:WaveState|null = null
    private tickets:Array<DisplayTicket> = []
    private hasRun:boolean = false
    private messages:Array<string> = []
    private renderedLines:number = 0
    private config:DisplayConfig
    private viewportStart:number = 0
    private resizeListener:(() => void)|null = null

    constructor (config?:Readonly<Partial<DisplayConfig>>) {
        this.config = {
            stream:config?.stream ?? process.stdout,
        }
    }

    private getAvailableRows ():number {
        const termHeight = this.config.stream.rows ?? 24
        const overhead = 2 + MIN_LOG_ROWS
        const available = termHeight - overhead
        return Math.max(1, available)
    }

    private findTicket (
        num:number,
        feature?:string,
    ):DisplayTicket|null {
        const found = feature ?
            this.tickets.find(
                t => t.num === num && t.feature === feature,
            ) :
            this.tickets.find(t => t.num === num)
        return found ?? null
    }

    startRun (tickets:ReadonlyArray<TicketRef>):void {
        this.tickets = tickets.map(t => ({
            ...t,
            status:'pending' as const,
        }))
        this.hasRun = true
        this.viewportStart = 0
    }

    startWave (
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<TicketRef>,
        _progress?:RunProgress,
    ):void {
        if (!this.hasRun) {
            this.startRun(tickets)
        }

        this.wave = {
            waveNum,
            totalWaves,
        }
        this.messages = []
        this.viewportStart = 0
        this.config.stream.write(ansi.cursorHide())

        if (this.config.stream.isTTY) {
            if (this.resizeListener) {
                this.config.stream.removeListener(
                    'resize', this.resizeListener,
                )
            }
            this.resizeListener = () => this.render()
            this.config.stream.on(
                'resize', this.resizeListener,
            )
        }

        this.render()
    }

    setTicketStatus (
        num:number,
        status:TicketStatus,
        feature?:string,
    ):void {
        const ticket = this.findTicket(num, feature)
        if (!ticket) return

        ticket.status = status

        if (status === 'in-progress') {
            const ticketIndex = this.tickets.indexOf(ticket)
            const availableRows = this.getAvailableRows()
            const totalTickets = this.tickets.length

            if (ticketIndex < this.viewportStart) {
                this.viewportStart = ticketIndex
            } else if (ticketIndex >= this.viewportStart + availableRows) {
                // offset by 3 to keep context visible below
                // the active ticket
                this.viewportStart = ticketIndex - availableRows + 3
            }
            this.viewportStart = Math.max(
                0,
                Math.min(this.viewportStart, totalTickets - 1),
            )
        }

        this.render()
    }

    setBlocked (
        num:number,
        feature:string|undefined,
        blockedBy:ReadonlyArray<string>,
    ):void {
        const ticket = this.findTicket(num, feature)
        if (!ticket) return

        ticket.status = 'blocked'
        ticket.blockedBy = [...blockedBy]
        this.render()
    }

    log (message:string):void {
        // Before the first wave there is no grid to repaint,
        // so a message would otherwise be dropped. Write it
        // straight to the stream instead. A later render
        // never erases these rows, since renderedLines is 0.
        if (!this.wave) {
            this.config.stream.write(message + '\n')
            return
        }
        for (const line of message.split('\n')) {
            this.messages.push(line)
        }
        while (this.messages.length > MAX_MESSAGE_BUFFER) {
            this.messages.shift()
        }
        this.render()
    }

    cleanup ():void {
        // Remove resize listener if it exists
        if (this.resizeListener && this.config.stream.isTTY) {
            this.config.stream.removeListener('resize', this.resizeListener)
        }
        this.config.stream.write(ansi.cursorShow())
    }

    private render ():void {
        if (!this.wave) return

        let output = ''

        if (this.renderedLines > 0) {
            output += ansi.eraseLines(this.renderedLines + 1)
        }

        const done = this.tickets.filter(
            t => t.status === 'done',
        ).length
        const total = this.tickets.length
        const pct = total === 0 ? 0 : Math.round((done / total) * 100)
        const width = Math.max(
            1,
            (this.config.stream.columns ?? DEFAULT_COLUMNS) - 1,
        )

        const header = `Wave ${this.wave.waveNum}/` +
            `${this.wave.totalWaves} - ` +
            `${done}/${total} done - ${pct}%`
        output += fitLine(header, width) + '\n'

        // Pagination logic
        const availableRows = this.getAvailableRows()
        let renderedTicketCount = 0

        if (this.tickets.length <= availableRows) {
            // All tickets fit, no pagination
            for (const ticket of this.tickets) {
                const dot = renderDot(ticket.status)
                const text = rowText(ticket)
                const name = fitLine(text, width - 2)
                output += `${dot} ${name}\n`
            }
            renderedTicketCount = this.tickets.length
        } else {
            // Need pagination -- iterative clamp
            this.viewportStart = Math.max(
                0,
                Math.min(
                    this.viewportStart,
                    this.tickets.length - 1,
                ),
            )

            let hasMoreAbove = this.viewportStart > 0
            let tentativeCount =
                availableRows - (hasMoreAbove ? 1 : 0)
            let hasMoreBelow =
                this.viewportStart + tentativeCount <
                this.tickets.length
            let ticketsToShow = Math.max(
                0,
                tentativeCount - (hasMoreBelow ? 1 : 0),
            )

            const maxStart = Math.max(
                0,
                this.tickets.length - Math.max(1, ticketsToShow),
            )
            if (this.viewportStart > maxStart) {
                this.viewportStart = maxStart
                hasMoreAbove = this.viewportStart > 0
                tentativeCount = availableRows - (hasMoreAbove ? 1 : 0)
                hasMoreBelow = (
                    this.viewportStart +
                    tentativeCount < this.tickets.length
                )
                ticketsToShow = Math.max(
                    0,
                    tentativeCount - (hasMoreBelow ? 1 : 0)
                )
            }

            // Show "more above" indicator if needed
            if (hasMoreAbove) {
                const moreCount = this.viewportStart
                output += `  ... ${moreCount} more above\n`
            }

            // Get visible tickets and render them
            const visibleTickets = this.tickets.slice(
                this.viewportStart,
                this.viewportStart + ticketsToShow,
            )

            for (const ticket of visibleTickets) {
                const dot = renderDot(ticket.status)
                const text = rowText(ticket)
                const name = fitLine(text, width - 2)
                output += `${dot} ${name}\n`
            }

            // Show "more below" indicator if needed
            if (hasMoreBelow) {
                const moreCount = (
                    this.tickets.length -
                    (this.viewportStart + ticketsToShow)
                )
                output += `  ... ${moreCount} more below\n`
            }

            renderedTicketCount = (hasMoreAbove ? 1 : 0) +
                visibleTickets.length +
                (hasMoreBelow ? 1 : 0)
        }

        output += '-'.repeat(Math.min(SEPARATOR_WIDTH, width)) + '\n'

        const termHeight = this.config.stream.rows ?? 24
        const logRows = Math.max(
            0,
            termHeight - 3 - renderedTicketCount,
        )
        const wrapped = this.messages.flatMap(
            msg => wrapLine(msg, width),
        )
        const visibleMessages = wrapped.slice(-logRows)
        for (const row of visibleMessages) {
            output += `${row}\n`
        }
        const emptyRows = logRows - visibleMessages.length
        for (let i = 0; i < emptyRows; i++) {
            output += '\n'
        }

        this.renderedLines = 2 + renderedTicketCount + logRows
        this.config.stream.write(output)
    }
}

export class PlainDisplay implements Display {
    startRun (_tickets:ReadonlyArray<TicketRef>):void {
        // no-op: plain mode has no fixed list
    }

    startWave (
        waveNum:number,
        _totalWaves:number,
        tickets:ReadonlyArray<TicketRef>,
        progress?:RunProgress,
    ):void {
        const pct = progress && progress.total > 0 ?
            ` (${progress.completed}/${progress.total} done)` :
            ''
        console.log(
            `\nWave ${waveNum}${pct}: ` +
            tickets.map(t => ticketLabel(t)).join(', ')
        )
    }

    setTicketStatus (
        _num:number,
        _status:TicketStatus,
        _feature?:string,
    ):void {
        // no-op: plain mode reports via log()
    }

    setBlocked (
        _num:number,
        _feature:string|undefined,
        _blockedBy:ReadonlyArray<string>,
    ):void {
        // no-op: plain mode has no fixed list
    }

    log (message:string):void {
        console.log(message)
    }

    cleanup ():void {
        // no-op
    }
}

export function createDisplay (stream?:NodeJS.WriteStream):Display {
    const s = stream ?? process.stdout
    if (s.isTTY) {
        return new StatusDisplay({ stream:s })
    }

    return new PlainDisplay()
}
