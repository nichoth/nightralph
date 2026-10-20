import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, writeFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    detectTestCmd, detectInstallCmd, runTestCmd,
} from '../src/testcmd.js'

function tmp ():string {
    return mkdtempSync(join(tmpdir(), 'nightralph-testcmd-'))
}

test('detectTestCmd - no package.json', t => {
    const dir = tmp()
    try {
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectTestCmd - package.json without test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts: { build: 'tsc' } })
        )
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectTestCmd - package.json with test script', t => {
    const dir = tmp()
    try {
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts: { test: 'node t.js' } })
        )
        t.equal(detectTestCmd(dir), 'npm test', 'uses npm test')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectTestCmd - unparseable package.json', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{ nope')
        t.equal(detectTestCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectInstallCmd - no package.json', t => {
    const dir = tmp()
    try {
        t.equal(detectInstallCmd(dir), null, 'returns null')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectInstallCmd - pnpm lockfile', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{}')
        writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
        t.equal(
            detectInstallCmd(dir),
            'pnpm install --prefer-offline --frozen-lockfile',
            'frozen pnpm install'
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectInstallCmd - npm lockfile', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{}')
        writeFileSync(join(dir, 'package-lock.json'), '{}')
        t.equal(
            detectInstallCmd(dir),
            'npm ci --prefer-offline --no-audit --no-fund',
            'npm ci'
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('detectInstallCmd - no lockfile', t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'package.json'), '{}')
        t.equal(
            detectInstallCmd(dir),
            'npm install --prefer-offline --no-audit ' +
                '--no-fund --no-package-lock',
            'npm install that writes no lockfile'
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd - exit code and output of a passing ' +
    'command', async t => {
    const dir = tmp()
    try {
        const result = await runTestCmd({
            cmd: 'echo ok',
            cwd: dir,
            timeout: 10,
        })
        t.equal(result.exitCode, 0, 'exit 0')
        t.ok(result.output.includes('ok'), 'captures stdout')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd - exit code of a failing command',
    async t => {
        const dir = tmp()
        try {
            const result = await runTestCmd({
                cmd: 'echo bad >&2; exit 3',
                cwd: dir,
                timeout: 10,
            })
            t.equal(result.exitCode, 3, 'exit 3')
            t.ok(
                result.output.includes('bad'),
                'captures stderr'
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

test('runTestCmd - runs in the given directory', async t => {
    const dir = tmp()
    try {
        writeFileSync(join(dir, 'marker.txt'), '')
        const result = await runTestCmd({
            cmd: 'test -f marker.txt',
            cwd: dir,
            timeout: 10,
        })
        t.equal(result.exitCode, 0, 'found the marker')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd - kills the command after the timeout',
    async t => {
        const dir = tmp()
        try {
            const started = Date.now()
            const result = await runTestCmd({
                cmd: 'sleep 30; echo done',
                cwd: dir,
                timeout: 1,
            })
            t.ok(result.exitCode !== 0, 'non-zero exit')
            t.ok(
                Date.now() - started < 10_000,
                'returned well before 30 seconds'
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

test('runTestCmd - registers pid in registry during ' +
    'execution and removes it after', async t => {
    const dir = tmp()
    try {
        const registry = new Set<number>()
        const result = await runTestCmd({
            cmd: 'sleep 0.5; echo done',
            cwd: dir,
            timeout: 10,
            registry,
        })
        // We can't inspect registry mid-run from outside
        // the promise without a side channel; instead
        // verify it's empty after completion.
        t.equal(registry.size, 0, 'pid removed after close')
        t.equal(result.exitCode, 0, 'exit 0')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd - pid is in registry during execution',
    async t => {
        const dir = tmp()
        try {
            const registry = new Set<number>()
            // Run a command that sleeps so we can check
            // the registry mid-execution.
            const promise = runTestCmd({
                cmd: 'sleep 5',
                cwd: dir,
                timeout: 10,
                registry,
            })
            // Give the child time to spawn.
            await new Promise(r => setTimeout(r, 200))
            t.ok(
                registry.size > 0,
                'pid is in registry during execution'
            )
            const pid = [...registry][0]
            // Kill the process so the test doesn't wait.
            try { process.kill(-pid, 'SIGKILL') } catch {}
            await promise
            t.equal(
                registry.size, 0,
                'pid removed after close'
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

test('runTestCmd - pid removed from registry on spawn ' +
    'error', async t => {
    const dir = tmp()
    const missing = join(dir, 'missing')
    try {
        const registry = new Set<number>()
        const result = await runTestCmd({
            cmd: 'echo ok',
            cwd: missing,
            timeout: 10,
            registry,
        })
        t.equal(registry.size, 0, 'pid removed on error')
        t.ok(result.exitCode !== 0, 'non-zero exit')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd - cwd does not exist', async t => {
    const dir = tmp()
    const missing = join(dir, 'missing')
    try {
        const result = await runTestCmd({
            cmd: 'echo ok',
            cwd: missing,
            timeout: 10,
        })
        t.ok(result.exitCode !== 0, 'non-zero exit')
        t.ok(
            result.output.includes('ENOENT'),
            'output contains the error text'
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runTestCmd reports a live gate and stops reporting on exit',
    async t => {
        const dir = tmp()
        const lines:string[] = []
        const registry = new Set<number>()
        let finished = false
        let observedLive = false
        writeFileSync(join(dir, 'gate.cjs'), [
            "const fs = require('node:fs')",
            "process.stdout.write('stdout marker\\n')",
            "process.stderr.write('stderr marker\\n')",
            'setInterval(() => {',
            "  if (fs.existsSync('release')) process.exit(0)",
            '}, 25)',
        ].join('\n'))
        try {
            const result = await runTestCmd({
                cmd: 'exec node gate.cjs',
                cwd: dir,
                timeout: 30,
                registry,
                progress: {
                    label: 'feature/01 attempt 1',
                    onLine: line => {
                        lines.push(line)
                        if (line.includes('still running')) {
                            observedLive = !finished && registry.size > 0
                            writeFileSync(join(dir, 'release'), '')
                        }
                    },
                },
            })
            finished = true
            t.equal(result.exitCode, 0, 'released command passes')
            t.ok(observedLive, 'heartbeat arrived during execution')
            t.ok(lines[0]?.includes('exec node gate.cjs'),
                'start names the command')
            t.ok(lines.some(line => line.includes(dir)),
                'start identifies the worktree')
            t.ok(lines.some(line => line.includes('timeout 30s')),
                'start names the timeout')
            t.ok(lines.every(line => line.includes('feature/01')),
                'messages retain their owner')
            t.ok(result.output.includes('stdout marker'),
                'stdout still captured')
            t.ok(result.output.includes('stderr marker'),
                'stderr still captured')
            t.ok(!result.output.includes('still running'),
                'progress stays out of the test log')
            t.equal(registry.size, 0, 'registry cleared')
            const count = lines.length
            await new Promise(resolve => setTimeout(resolve, 16000))
            t.equal(lines.length, count, 'no progress after completion')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

test('runTestCmd clears progress on failure and timeout', async t => {
    const dir = tmp()
    const cases = [
        { cmd: 'exit 3', cwd: dir, timeout: 5, code: 3 },
        {
            cmd: 'true',
            cwd: join(dir, 'missing'),
            timeout: 5,
            code: 1,
        },
        { cmd: 'exec sleep 30', cwd: dir, timeout: 0.1, code: 1 },
    ]
    try {
        const observations = await Promise.all(cases.map(async c => {
            const lines:string[] = []
            const registry = new Set<number>()
            const result = await runTestCmd({
                ...c,
                registry,
                progress: {
                    label: c.cmd,
                    onLine: line => { lines.push(line) },
                },
            })
            t.equal(result.exitCode, c.code, 'exit behavior retained')
            t.equal(registry.size, 0, 'terminal path clears registry')
            if (c.timeout === 0.1) {
                t.ok(lines.some(line => line.includes('timeout reached')),
                    'timeout explained')
            }
            return { lines, count: lines.length }
        }))
        await new Promise(resolve => setTimeout(resolve, 16000))
        for (const item of observations) {
            t.equal(item.lines.length, item.count,
                'terminal command has no remaining heartbeat')
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
