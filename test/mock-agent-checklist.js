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

process.stdin.resume()
process.stdin.on('end', () => {
    console.log('[x] first item')
    console.log('some other output')
    console.log('[x] third item')

    try {
        const filename = `mock-change-${randomUUID()}.txt`
        writeFileSync(
            join(process.cwd(), filename),
            String(Date.now())
        )
        execSync(`git add ${filename}`, {
            stdio:'ignore', env:GIT_ENV,
        })
        execSync(
            'git commit -m "mock agent change" --no-verify',
            { stdio:'pipe', env:GIT_ENV }
        )
    } catch {
        // not inside a git repo
    }
    process.exit(0)
})
