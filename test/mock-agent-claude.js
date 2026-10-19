#!/usr/bin/env node
// A stand-in for the claude CLI. Tests run it through
// test/fake-claude/claude, whose basename makes spawnAgent take
// the claude branch. With FAKE_CLAUDE_DELEGATE set to a
// test/mock-agent-*.js path, it then runs that mock with the same
// prompt, cwd, env and arguments and exits with its status.
// With FAKE_CLAUDE_ARGV_LOG set, it appends its arguments to that
// file as one JSON array per run.
// With FAKE_CLAUDE_PROMPT_DIR set, it writes each prompt it reads
// to a uniquely named file in that directory. With
// FAKE_CLAUDE_FAIL_ONCE set to a marker path, the first run exits 1.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
    appendFileSync,
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks)
    const envLog = process.env.FAKE_CLAUDE_ENV_LOG
    if (envLog) {
        const value = process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null
        appendFileSync(envLog, JSON.stringify(value) + '\n')
    }
    const argvLog = process.env.FAKE_CLAUDE_ARGV_LOG
    if (argvLog) {
        appendFileSync(
            argvLog,
            JSON.stringify(process.argv.slice(2)) + '\n'
        )
    }
    const promptDir = process.env.FAKE_CLAUDE_PROMPT_DIR
    if (promptDir) {
        const name = `${process.pid}-${randomUUID()}.txt`
        writeFileSync(join(promptDir, name), prompt)
    }
    const stream = process.env.FAKE_CLAUDE_STREAM
    if (stream) {
        const lines = readFileSync(stream, 'utf8')
            .split('\n')
            .filter(line => line !== '')
        for (const line of lines) process.stdout.write(line + '\n')
    }
    // The first run creates the marker file and exits 1; later runs
    // see it and carry on.
    const failOnce = process.env.FAKE_CLAUDE_FAIL_ONCE
    if (failOnce && !existsSync(failOnce)) {
        writeFileSync(failOnce, '')
        process.exitCode = 1
        return
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
