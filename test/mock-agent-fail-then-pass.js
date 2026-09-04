#!/usr/bin/env node
// Simulates an agent that only succeeds once the orchestrator
// escalates it: exits 1 unless it was given --thinking, in
// which case it commits a file like mock-agent-pass.js does.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

const escalated = process.argv.includes('--thinking')

process.stdin.resume()
process.stdin.on('end', () => {
    if (!escalated) process.exit(1)
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
