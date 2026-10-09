#!/usr/bin/env node
// A stand-in for the claude CLI. Tests run it through
// test/fake-claude/claude, whose basename makes spawnAgent take
// the claude branch. With FAKE_CLAUDE_DELEGATE set to a
// test/mock-agent-*.js path, it then runs that mock with the same
// prompt, cwd, env and arguments and exits with its status.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks)
    const envLog = process.env.FAKE_CLAUDE_ENV_LOG
    if (envLog) {
        const value = process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null
        appendFileSync(envLog, JSON.stringify(value) + '\n')
    }
    const stream = process.env.FAKE_CLAUDE_STREAM
    if (stream) {
        const lines = readFileSync(stream, 'utf8')
            .split('\n')
            .filter(line => line !== '')
        for (const line of lines) process.stdout.write(line + '\n')
    }
    const delegate = process.env.FAKE_CLAUDE_DELEGATE
    if (delegate) {
        const r = spawnSync(
            process.execPath,
            [delegate, ...process.argv.slice(2)],
            { input:prompt, stdio:['pipe', 'inherit', 'inherit'] }
        )
        process.exitCode = r.status ?? 1
        return
    }
    if (process.env.FAKE_CLAUDE_HANG === '1') {
        setInterval(() => {}, 1000)
        return
    }
    process.exitCode = 0
})
