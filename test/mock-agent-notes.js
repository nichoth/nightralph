#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Records what it was asked, leaves agent notes, then acts on
// MOCK_MODE:
//   pass       commit a new file with `git add -A`, exit 0
//   fail       exit 1
//   fail-once  exit 1 the first time per worktree, then pass
//   hang       never exit
// Each invocation writes one JSON record into MOCK_RECORD_DIR:
// { time, cwd, token, prompt }. The notes contain the token, so a
// test can tell which run's notes reached which prompt.

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

// `git add -A` on purpose: the orchestrator's
// .nightralph/.gitignore must keep the notes out even when an
// agent stages everything. Retries past transient lock
// contention from sibling agents, like mock-agent-pass.js.
function commitEverything () {
    const filename = `mock-agent-change-${randomUUID()}.txt`
    writeFileSync(join(process.cwd(), filename), String(Date.now()))
    let lastErr
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            execSync('git add -A', { stdio:'ignore', env:GIT_ENV })
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

function run (prompt) {
    const recordDir = process.env.MOCK_RECORD_DIR
    if (!recordDir) {
        process.stderr.write('MOCK_RECORD_DIR is required\n')
        process.exit(2)
    }
    const cwd = process.cwd()
    const token = randomUUID()

    // Both writes are synchronous and happen before any mode runs,
    // so a hanging agent has left them by the time it is killed.
    writeFileSync(
        join(recordDir, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ time:Date.now(), cwd, token, prompt })
    )
    mkdirSync(join(cwd, '.nightralph'), { recursive:true })
    writeFileSync(
        join(cwd, '.nightralph', 'notes.md'),
        `notes-token ${token}\n`
    )

    const mode = process.env.MOCK_MODE
    if (mode === 'pass') {
        commitEverything()
        process.exit(0)
    }
    if (mode === 'fail') process.exit(1)
    if (mode === 'fail-once') {
        // The worktree directory name is stable across attempts
        // of one ticket, so the marker counts per ticket.
        const marker = join(recordDir, `failed-${basename(cwd)}`)
        if (!existsSync(marker)) {
            writeFileSync(marker, '')
            process.exit(1)
        }
        commitEverything()
        process.exit(0)
    }
    if (mode === 'hang') {
        setInterval(() => {}, 1000)
        return
    }
    process.stderr.write(`unknown MOCK_MODE: ${mode}\n`)
    process.exit(2)
}

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    run(Buffer.concat(chunks).toString('utf8'))
})
