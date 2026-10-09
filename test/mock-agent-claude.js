#!/usr/bin/env node
// A stand-in for the claude CLI. Tests run it through
// test/fake-claude/claude, whose basename makes spawnAgent take
// the claude branch.
import { appendFileSync, readFileSync } from 'node:fs'

process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
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
    if (process.env.FAKE_CLAUDE_HANG === '1') {
        setInterval(() => {}, 1000)
        return
    }
    process.exitCode = 0
})
