#!/usr/bin/env node
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

// Multiple mock agents may run concurrently against the same
// working tree in in-place (non-worktree) test scenarios, so
// retry the add+commit pair past transient index/ref lock
// contention from sibling processes.
function commitFileWithRetry (filename) {
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
            // A sibling process may have already committed this
            // file (it stages whatever is in the index, not just
            // its own write) -- that counts as success here.
            const msg = String(err.stderr || err)
            if (msg.includes('nothing to commit')) return
            lastErr = err
            const until = Date.now() + 20 + Math.random() * 30
            while (Date.now() < until) { /* busy-wait */ }
        }
    }
    throw lastErr
}

process.stdin.resume()
process.stdin.on('end', () => {
    try {
        const filename = `mock-agent-change-${randomUUID()}.txt`
        writeFileSync(
            join(process.cwd(), filename),
            String(Date.now())
        )
        commitFileWithRetry(filename)
    } catch {
        // not inside a git repo; nothing to verify against
    }
    process.exit(0)
})
