#!/usr/bin/env node
// Records how many sibling agents are running at the same
// time. Each agent drops a marker file in the directory
// named by MOCK_CONCURRENCY_DIR, sleeps, then appends the
// peak marker count it observed to <dir>/peaks.
import {
    writeFileSync, appendFileSync, readdirSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = process.env.MOCK_CONCURRENCY_DIR
const marker = join(dir, `running-${randomUUID()}`)

function countRunning () {
    return readdirSync(dir)
        .filter(n => n.startsWith('running-')).length
}

process.stdin.resume()
process.stdin.on('end', () => {
    writeFileSync(marker, '')
    let peak = countRunning()
    const until = Date.now() + 400
    const tick = setInterval(() => {
        peak = Math.max(peak, countRunning())
        if (Date.now() >= until) {
            clearInterval(tick)
            unlinkSync(marker)
            appendFileSync(join(dir, 'peaks'), `${peak}\n`)
            process.exit(0)
        }
    }, 20)
})
