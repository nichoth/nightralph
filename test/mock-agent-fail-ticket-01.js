#!/usr/bin/env node
// Fails every time it is asked to work on ticket 01-*, and
// records each such invocation to MOCK_INVOCATION_LOG (if set)
// so a test can assert the ticket was only attempted once
// across the whole run, not re-run in a later wave. Any other
// ticket succeeds like mock-agent-pass.js so an independent
// ticket in the same wave can complete and let the run continue.
import { execSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

let prompt = ''
process.stdin.resume()
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
    const isTicketOne = /\b01-\S+\.md/.test(prompt)

    if (isTicketOne) {
        if (process.env.MOCK_INVOCATION_LOG) {
            appendFileSync(process.env.MOCK_INVOCATION_LOG, '1\n')
        }
        process.exit(1)
    }

    try {
        const filename = `mock-agent-change-${randomUUID()}.txt`
        writeFileSync(
            join(process.cwd(), filename), String(Date.now())
        )
        execSync(`git add ${filename}`, {
            stdio:'ignore', env:GIT_ENV,
        })
        execSync(
            'git commit -m "mock agent change" --no-verify',
            { stdio:'pipe', env:GIT_ENV }
        )
    } catch {
        // not inside a git repo; nothing to verify against
    }
    process.exit(0)
})
