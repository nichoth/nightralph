import { basename } from 'node:path'

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

export function retryDelayFor (base:number, attempt:number):number {
    return base * 2 ** (attempt - 2)
}

export function sleep (ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export type AttemptStep<T> = { result:T; stop:boolean }

export type RetryOpts = {
    maxAttempts:number
    // seconds before the first retry; doubles each further retry
    retryDelay:number
    agentCmd:string
    // starting effort level; unset = provider's default
    effort?:EffortLevel
    // names the work in log lines, e.g. a ticket filename
    label:string
    log:(msg:string) => void
    // test seam; defaults to sleep
    wait?:(ms:number) => Promise<void>
}

// Runs `run` until a step says stop or the attempt cap is hit,
// escalating effort for known providers and backing off
// exponentially between attempts. Returns the last step's result.
export async function runWithRetries<T> (
    opts:RetryOpts,
    run:(
        attempt:number,
        effort:EffortLevel|undefined
    ) => Promise<AttemptStep<T>>
):Promise<T> {
    const maxAttempts = Math.max(1, opts.maxAttempts)
    const providerName = basename(opts.agentCmd)
    const isKnown = providerName in EFFORT_LADDERS
    const wait = opts.wait ?? sleep
    let effort = opts.effort

    for (let attempt = 1; ; attempt++) {
        if (attempt === 1) {
            opts.log(`  Starting ${opts.label}`)
        } else {
            if (isKnown) {
                effort = escalateEffort(
                    providerName as ProviderName,
                    effort
                )
            }
            const delay = retryDelayFor(opts.retryDelay, attempt)
            opts.log(
                `  ${opts.label}: retrying ` +
                `(attempt ${attempt}/${maxAttempts}` +
                (isKnown && effort ?
                    `, effort ${effort}` : '') +
                (delay > 0 ?
                    `, waiting ${delay}s` : '') +
                ')'
            )
            if (delay > 0) await wait(delay * 1000)
        }
        const step = await run(attempt, effort)
        if (step.stop || attempt >= maxAttempts) return step.result
    }
}
