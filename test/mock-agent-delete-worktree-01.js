#!/usr/bin/env node
// Deletes its own working directory (simulating an agent that
// removes its worktree), then exits 0. This triggers a throw
// in runTicketAttempt when it tries to check isDirty / hasNewCommits
// on the now-missing worktree.
//
// Only fires for tickets whose filename matches 01-*.md.
// Other tickets get the normal mock-agent-pass behavior.
import { execSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

function commitFile (filename) {
    let lastErr
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            execSync(`git add ${filename}`, {
                stdio:'ignore', env:GIT_ENV,
            })
            execSync(
                'git commit -m "mock agent change" --no-verify',
                { stdio:'pipe', env:GIT_ENV }
            )
            return
        } catch (err) {
            const msg = String(err.stderr || err)
            if (msg.includes('nothing to commit')) return
            lastErr = err
            const until = Date.now() + 20 + Math.random() * 30
            while (Date.now() < until) { /* busy-wait */ }
        }
    }
    throw lastErr
}

let prompt = ''
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
    const isTicket01 = /\b01-\w+\.md\b/.test(prompt)

    if (isTicket01) {
        // Delete our own worktree directory
        rmSync(process.cwd(), { recursive:true, force:true })
    } else {
        // Normal pass behavior: create a file and commit
        try {
            const filename = `mock-change-${randomUUID()}.txt`
            writeFileSync(
                join(process.cwd(), filename),
                String(Date.now())
            )
            commitFile(filename)
        } catch {
            // not inside a git repo
        }
    }

    process.exit(0)
})
