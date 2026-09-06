#!/usr/bin/env node
// Simulates an agent that:
// 1. Captures args to ARGS_LOG file (from env)
// 2. Fails on first run (exit 1)
// 3. Passes on second run (when --thinking is present)
// 4. Creates a git commit on pass
import { execSync } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

const argsLogPath = process.env.ARGS_LOG_PATH
if (argsLogPath) {
    appendFileSync(argsLogPath, JSON.stringify({
        cwd:process.cwd(),
        args:process.argv,
        timestamp:Date.now(),
    }) + '\n')
}

// Fail on first attempt (--thinking medium or no --thinking)
// Pass on retry (--thinking high or higher)
const thinkingIdx = process.argv.indexOf('--thinking')
const thinking = thinkingIdx >= 0 ?
    process.argv[thinkingIdx + 1] :
    null
const escalated = thinking && thinking !== 'medium'

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
