#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Plays every role in a run, picked from the prompt:
//   reviewer  (prompt has the review marker)  per MOCK_REVIEW:
//             findings | clean | none
//   fixer     (prompt has the findings marker) per MOCK_FIX:
//             pass | break
//   ticket    otherwise, per MOCK_TICKET: pass | fail
// Each run writes { time, role, cwd, prompt } into MOCK_RECORD_DIR.

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Mock Agent',
    GIT_COMMITTER_EMAIL:'mock@example.com',
    GIT_AUTHOR_NAME:'Mock Agent',
    GIT_AUTHOR_EMAIL:'mock@example.com',
}

function commitFile (name) {
    writeFileSync(join(process.cwd(), name), String(Date.now()))
    execSync(`git add ${name}`, { stdio:'ignore', env:GIT_ENV })
    execSync('git commit -m "mock change" --no-verify',
        { stdio:'ignore', env:GIT_ENV })
}

function writeFindings (text) {
    mkdirSync(join(process.cwd(), '.nightralph'), { recursive:true })
    writeFileSync(
        join(process.cwd(), '.nightralph', 'findings.md'), text
    )
}

function run (prompt) {
    const role = prompt.includes('---- REVIEW INSTRUCTIONS ----') ?
        'reviewer' :
        prompt.includes('---- REVIEW FINDINGS ----') ?
            'fixer' :
            'ticket'
    writeFileSync(
        join(process.env.MOCK_RECORD_DIR,
            `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({
            time:Date.now(), role, cwd:process.cwd(), prompt,
        })
    )

    if (role === 'reviewer') {
        const mode = process.env.MOCK_REVIEW
        if (mode === 'findings') {
            writeFindings(
                '- [ ] mock finding one\n' +
                '    src/x.ts:1 breaks\n' +
                '- [ ] mock finding two\n'
            )
        } else if (mode === 'clean') {
            writeFindings('No findings.\n')
        }
        process.exit(0)
    }
    if (role === 'fixer') {
        if (process.env.MOCK_FIX === 'break') {
            commitFile('broken.txt')
        } else {
            commitFile(`fix-${randomUUID()}.ts`)
            process.stdout.write('[x] mock finding one\n')
        }
        process.exit(0)
    }
    if (process.env.MOCK_TICKET === 'fail') process.exit(1)
    commitFile(`mock-change-${randomUUID()}.ts`)
    process.exit(0)
}

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
    run(Buffer.concat(chunks).toString('utf8'))
})
