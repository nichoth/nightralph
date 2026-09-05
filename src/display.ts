export type TicketStatus =
    | 'pending'
    | 'in-progress'
    | 'done'
    | 'failed'

export type DisplayTicket = {
    readonly num:number
    readonly filename:string
    status:TicketStatus
}

export type WaveState = {
    readonly waveNum:number
    readonly totalWaves:number
    readonly tickets:Array<DisplayTicket>
}

export type DisplayConfig = {
    readonly stream:NodeJS.WriteStream
}

/**
 * Progress across the whole run, not just the current wave.
 * `completed` counts tickets done before the wave started;
 * tickets that finish during the wave are added on top.
 */
export type RunProgress = {
    readonly completed:number
    readonly total:number
}

export type Display = {
    startWave(
        waveNum:number,
        totalWaves:number,
        tickets:ReadonlyArray<{
            num:number
            filename:string
        }>,
        progress?:RunProgress,
        remaining?:ReadonlyArray<{
            num:number
            filename:string
        }>,
    ):void
    setTicketStatus(num:number, status:TicketStatus):void
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
    dim (text:string):string {
        return `${ESC}2m${text}${ESC}0m`
    },
} as const

const FILLED_DOT = '●'
const EMPTY_DOT = '○'
const SEPARATOR_WIDTH = 50
const DEFAULT_COLUMNS = 80
const MIN_LOG_ROWS = 1
const MAX_MESSAGE_BUFFER = 200

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

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

export function renderDot (status:TicketStatus):string {
    switch (status) {
        case 'pending':
            return color.dim(EMPTY_DOT)
        case 'in-progress':
            return color.yellow(FILLED_DOT)
        case 'done':
            return color.green(FILLED_DOT)
        case 'failed':
            return color.red(FILLED_DOT)
    }
}

export class StatusDisplay implements Display {
    private wave:WaveState|null = null
    private progress:RunProgress|null = null
    private remaining:Array<DisplayTicket> = []
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

    startWave (
        waveNum:number,
        totalWaves:number,
        tickets:Array<Readonly<{ num:number; filename:string }>>,
        progress?:RunProgress,
        remaining?:ReadonlyArray<{
            num:number
            filename:string
        }>,
    ):void {
        this.wave = {
            waveNum,
            totalWaves,
            tickets:tickets.map(t => ({
                ...t,
                status:'pending' as const,
            })),
        }
        this.remaining = (remaining ?? []).map(t => ({
            ...t,
            status:'pending' as const,
        }))
        this.progress = progress ?? null
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

    setTicketStatus (num:number, status:TicketStatus):void {
        if (!this.wave) return

        const ticket = this.wave.tickets.find(t => t.num === num)
        if (ticket) {
            ticket.status = status

            if (status === 'in-progress') {
                const ticketIndex = this.wave.tickets.indexOf(ticket)
                const availableRows = this.getAvailableRows()
                const totalTickets = this.wave.tickets.length

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
    }

    log (message:string):void {
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

        const doneInWave = this.wave.tickets.filter(
            t => t.status === 'done',
        ).length
        const completed = doneInWave + (this.progress?.completed ?? 0)
        const total = this.progress?.total ?? this.wave.tickets.length
        const pct = total === 0 ? 0 : Math.round((completed / total) * 100)
        const width = Math.max(
            1,
            (this.config.stream.columns ?? DEFAULT_COLUMNS) - 1,
        )

        output += `Wave ${this.wave.waveNum}/` +
            `${this.wave.totalWaves} - ` +
            `${pct}% complete\n`

        // Pagination logic
        const availableRows = this.getAvailableRows()
        const tickets:ReadonlyArray<DisplayTicket> = [
            ...this.wave.tickets,
            ...this.remaining,
        ]
        let renderedTicketCount = 0

        if (tickets.length <= availableRows) {
            // All tickets fit, no pagination
            for (const ticket of tickets) {
                const dot = renderDot(ticket.status)
                const name = fitLine(ticket.filename, width - 2)
                output += `${dot} ${name}\n`
            }
            renderedTicketCount = tickets.length
        } else {
            // Need pagination -- iterative clamp
            this.viewportStart = Math.max(
                0,
                Math.min(
                    this.viewportStart,
                    tickets.length - 1,
                ),
            )

            let hasMoreAbove = this.viewportStart > 0
            let tentativeCount =
                availableRows - (hasMoreAbove ? 1 : 0)
            let hasMoreBelow =
                this.viewportStart + tentativeCount <
                tickets.length
            let ticketsToShow = Math.max(
                0,
                tentativeCount - (hasMoreBelow ? 1 : 0),
            )

            const maxStart = Math.max(
                0,
                tickets.length - Math.max(1, ticketsToShow),
            )
            if (this.viewportStart > maxStart) {
                this.viewportStart = maxStart
                hasMoreAbove = this.viewportStart > 0
                tentativeCount = availableRows - (hasMoreAbove ? 1 : 0)
                hasMoreBelow = (
                    this.viewportStart +
                    tentativeCount < tickets.length
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
            const visibleTickets = tickets.slice(
                this.viewportStart,
                this.viewportStart + ticketsToShow,
            )

            for (const ticket of visibleTickets) {
                const dot = renderDot(ticket.status)
                const name = fitLine(ticket.filename, width - 2)
                output += `${dot} ${name}\n`
            }

            // Show "more below" indicator if needed
            if (hasMoreBelow) {
                const moreCount = (
                    tickets.length -
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
        const visibleMessages = this.messages.slice(-logRows)
        for (const msg of visibleMessages) {
            output += `${fitLine(msg, width)}\n`
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
    startWave (
        waveNum:number,
        _totalWaves:number,
        tickets:ReadonlyArray<{ num:number; filename:string }>,
        progress?:RunProgress,
        _remaining?:ReadonlyArray<{
            num:number
            filename:string
        }>,
    ):void {
        const pct = progress && progress.total > 0 ?
            ` (${progress.completed}/${progress.total} done)` :
            ''
        console.log(
            `\nWave ${waveNum}${pct}: ` +
            tickets.map(t => t.filename).join(', ')
        )
    }

    setTicketStatus (_num:number, _status:TicketStatus):void {
        // no-op: plain mode reports via log()
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
