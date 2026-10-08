import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveExecutable } from '../src/preflight.js'

function tmp ():string {
    return mkdtempSync(join(tmpdir(), 'nightralph-preflight-'))
}

function makeFixtures (root:string):{ a:string, b:string } {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    for (const dir of [a, b]) {
        const file = join(dir, 'tool')
        writeFileSync(file, '#!/bin/sh\nexit 0\n')
        chmodSync(file, 0o755)
    }
    const noexec = join(a, 'noexec')
    writeFileSync(noexec, '#!/bin/sh\nexit 0\n')
    chmodSync(noexec, 0o644)
    return { a, b }
}

test('resolveExecutable - bare name resolves to first PATH entry',
    t => {
        const root = tmp()
        try {
            const { a, b } = makeFixtures(root)
            t.equal(
                resolveExecutable('tool', { path:[a, b].join(delimiter) }),
                join(a, 'tool'),
                'first entry wins'
            )
            t.equal(
                resolveExecutable('tool', { path:[b, a].join(delimiter) }),
                join(b, 'tool'),
                'order of PATH is respected'
            )
        } finally {
            rmSync(root, { recursive:true, force:true })
        }
    })

test('resolveExecutable - path with a slash resolves against cwd',
    t => {
        const root = tmp()
        try {
            const { a } = makeFixtures(root)
            t.equal(
                resolveExecutable('./tool', { cwd:a }),
                join(a, 'tool'),
                'relative path resolved against cwd'
            )
            t.equal(
                resolveExecutable(join(a, 'tool')),
                join(a, 'tool'),
                'absolute path returned as is'
            )
        } finally {
            rmSync(root, { recursive:true, force:true })
        }
    })

test('resolveExecutable - returns null when nothing executable is found',
    t => {
        const root = tmp()
        try {
            const { a, b } = makeFixtures(root)
            const path = [a, b].join(delimiter)
            t.equal(
                resolveExecutable('nosuch', { path }),
                null,
                'name not on PATH'
            )
            t.equal(
                resolveExecutable(join(a, 'missing')),
                null,
                'path that does not exist'
            )
            t.equal(
                resolveExecutable('noexec', { path }),
                null,
                'file without execute permission'
            )
            t.equal(
                resolveExecutable('', { path }),
                null,
                'empty name'
            )
            t.equal(
                resolveExecutable('tool', {
                    path:[join(root, 'no-such-dir'), a].join(delimiter),
                }),
                join(a, 'tool'),
                'missing PATH directory is skipped'
            )
        } finally {
            rmSync(root, { recursive:true, force:true })
        }
    })
