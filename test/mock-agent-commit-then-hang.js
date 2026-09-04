#!/usr/bin/env node
// Simulates an agent that did real work and then got stuck:
// commits one file, leaves a second file uncommitted, and
// never exits. Only the orchestrator's timeout ends it.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

process.stdin.resume()
process.stdin.on('end', () => {
    writeFileSync(join(process.cwd(), 'committed.txt'), 'done')
    execSync('git add committed.txt', {
        stdio:'ignore', env:GIT_ENV,
    })
    execSync(
        'git commit -m "mock agent partial work" --no-verify',
        { stdio:'pipe', env:GIT_ENV }
    )
    writeFileSync(
        join(process.cwd(), 'uncommitted.txt'), 'in progress'
    )
    setInterval(() => {}, 1000)
})
