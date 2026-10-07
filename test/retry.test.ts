import { test } from '@substrate-system/tapzero'
import {
    runWithRetries,
    type EffortLevel,
} from '../src/retry.js'

function noLog ():void {}

test('runWithRetries - stops at the first step that says stop',
    async t => {
        let calls = 0
        const result = await runWithRetries({
            maxAttempts:4,
            retryDelay:0,
            agentCmd:'claude',
            label:'x',
            log:noLog,
        }, async attempt => {
            calls++
            return { result:attempt, stop:true }
        })
        t.equal(calls, 1, 'ran once')
        t.equal(result, 1, 'returns that step\'s result')
    })

test('runWithRetries - runs maxAttempts and returns the last result',
    async t => {
        const seen:number[] = []
        const result = await runWithRetries({
            maxAttempts:3,
            retryDelay:0,
            agentCmd:'claude',
            label:'x',
            log:noLog,
        }, async attempt => {
            seen.push(attempt)
            return { result:`attempt ${attempt}`, stop:false }
        })
        t.deepEqual(seen, [1, 2, 3], 'attempts in order')
        t.equal(result, 'attempt 3', 'last result')
    })

test('runWithRetries - escalates effort for a known provider',
    async t => {
        const efforts:Array<EffortLevel|undefined> = []
        await runWithRetries({
            maxAttempts:3,
            retryDelay:0,
            agentCmd:'/usr/local/bin/claude',
            label:'x',
            log:noLog,
        }, async (_attempt, effort) => {
            efforts.push(effort)
            return { result:null, stop:false }
        })
        t.deepEqual(efforts, [undefined, 'high', 'xhigh'],
            'undefined, then high, then one rung up')
    })

test('runWithRetries - keeps effort for an unknown provider',
    async t => {
        const efforts:Array<EffortLevel|undefined> = []
        await runWithRetries({
            maxAttempts:2,
            retryDelay:0,
            agentCmd:'node',
            effort:'low',
            label:'x',
            log:noLog,
        }, async (_attempt, effort) => {
            efforts.push(effort)
            return { result:null, stop:false }
        })
        t.deepEqual(efforts, ['low', 'low'], 'unchanged')
    })

test('runWithRetries - waits with exponential backoff', async t => {
    const waits:number[] = []
    await runWithRetries({
        maxAttempts:3,
        retryDelay:30,
        agentCmd:'node',
        label:'x',
        log:noLog,
        wait:async ms => { waits.push(ms) },
    }, async () => ({ result:null, stop:false }))
    t.deepEqual(waits, [30_000, 60_000], 'base, then double')
})

test('runWithRetries - maxAttempts below 1 still runs once',
    async t => {
        let calls = 0
        await runWithRetries({
            maxAttempts:0,
            retryDelay:0,
            agentCmd:'node',
            label:'x',
            log:noLog,
        }, async () => {
            calls++
            return { result:null, stop:false }
        })
        t.equal(calls, 1, 'one attempt')
    })
