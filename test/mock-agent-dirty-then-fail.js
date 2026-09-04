#!/usr/bin/env node
// Writes untracked files into its cwd then exits 1 for ticket
// 01-*. Any other ticket succeeds like mock-agent-pass.js.
// Used to verify that a failed attempt's dirty worktree is
// cleaned up by removeWorktree with force.
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

let prompt = ''
process.stdin.resume()
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
    const isTicketOne = /\b01-\S+\.md/.test(prompt)

    if (isTicketOne) {
        writeFileSync(
            join(process.cwd(), 'dirty-leftover.txt'),
            'untracked dirty file'
        )
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
