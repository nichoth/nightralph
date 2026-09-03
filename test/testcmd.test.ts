import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, writeFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectTestCmd, runTestCmd } from '../src/testcmd.js'

function tmp ():string {
    return mkdtempSync(join(tmpdir(), 'nightralph-testcmd-'))
}

test('detectTestCmd - no package.json', t => {
    const dir = tmp()
    try {
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - package.json without test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts:{ build:'tsc' } })
        )
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - package.json with test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts:{ test:'node t.js' } })
        )
        t.equal(detectTestCmd(dir), 'npm test', 'uses npm test')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('detectTestCmd - unparseable package.json', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{ nope')
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - exit code and output of a passing ' +
    'command', async t => {
    const dir = tmp()
    try {
        const result = await runTestCmd({
            cmd:'echo ok',
            cwd:dir,
            timeout:10,
        })
        t.equal(result.exitCode, 0, 'exit 0')
        t.ok(result.output.includes('ok'), 'captures stdout')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - exit code of a failing command',
    async t => {
        const dir = tmp()
        try {
            const result = await runTestCmd({
                cmd:'echo bad >&2; exit 3',
                cwd:dir,
                timeout:10,
            })
            t.equal(result.exitCode, 3, 'exit 3')
            t.ok(
                result.output.includes('bad'),
                'captures stderr'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

test('runTestCmd - runs in the given directory', async t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'marker.txt'), '')
        const result = await runTestCmd({
            cmd:'test -f marker.txt',
            cwd:dir,
            timeout:10,
        })
        t.equal(result.exitCode, 0, 'found the marker')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('runTestCmd - kills the command after the timeout',
    async t => {
        const dir = tmp()
        try {
            const started = Date.now()
            const result = await runTestCmd({
                cmd:'sleep 30',
                cwd:dir,
                timeout:1,
            })
            t.ok(result.exitCode !== 0, 'non-zero exit')
            t.ok(
                Date.now() - started < 10_000,
                'returned well before 30 seconds'
            )
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })
