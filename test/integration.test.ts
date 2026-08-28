import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import {
    findFeatureDirs,
    resolveIssuesDir,
} from '../src/resolve.js'
import { setup, SKILL_DIRS } from '../src/setup.js'

function tmp ():string {
    return mkdtempSync(
        join(tmpdir(), 'nightralph-int-test-')
    )
}

test('findFeatureDirs - no .scratch dir', t => {
    const dir = tmp()
    try {
        const result = findFeatureDirs(dir)
        t.deepEqual(result, [],
            'returns empty array when .scratch/ missing')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('findFeatureDirs - dirs without issues/', t => {
    const dir = tmp()
    try {
        const scratch = join(dir, '.scratch')
        mkdirSync(join(scratch, 'feat-a'), {
            recursive:true,
        })
        mkdirSync(join(scratch, 'feat-b'), {
            recursive:true,
        })
        const result = findFeatureDirs(dir)
        t.deepEqual(result, [],
            'returns empty when no issues/ subdirs')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('findFeatureDirs - valid feature dirs', t => {
    const dir = tmp()
    try {
        const scratch = join(dir, '.scratch')
        mkdirSync(
            join(scratch, 'feat-x', 'issues'),
            { recursive:true },
        )
        writeFileSync(
            join(scratch, 'feat-x', 'spec.md'),
            '# spec',
        )

        const result = findFeatureDirs(dir)
        t.equal(result.length, 1, 'finds one feature')
        t.equal(result[0].name, 'feat-x',
            'correct name')
        t.equal(result[0].dir,
            join(scratch, 'feat-x', 'issues'),
            'correct dir path')
        t.equal(result[0].spec,
            join(scratch, 'feat-x', 'spec.md'),
            'correct spec path')
    } finally {
        rmSync(dir, { recursive:true, force:true })
    }
})

test('findFeatureDirs - ignores non-directory entries',
    t => {
        const dir = tmp()
        try {
            const scratch = join(dir, '.scratch')
            mkdirSync(scratch, { recursive:true })
            writeFileSync(
                join(scratch, 'not-a-dir.txt'),
                'just a file',
            )
            mkdirSync(
                join(scratch, 'real-feat', 'issues'),
                { recursive:true },
            )

            const result = findFeatureDirs(dir)
            t.equal(result.length, 1,
                'only returns the directory entry')
            t.equal(result[0].name, 'real-feat',
                'returns the valid feature')
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

test('resolveIssuesDir - returns explicit flags directly',
    async t => {
        const dir = tmp()
        try {
            const result = await resolveIssuesDir(
                '/my/issues',
                '/my/spec.md',
                dir,
            )
            t.equal(result.dir, '/my/issues',
                'dir matches the flag value')
            t.equal(result.spec, '/my/spec.md',
                'spec matches the flag value')
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

test('resolveIssuesDir - no filesystem scanning with flags',
    async t => {
        const dir = tmp()
        try {
            const flagDir = join(dir, 'explicit-issues')
            const flagSpec = join(dir, 'explicit-spec.md')
            const result = await resolveIssuesDir(
                flagDir,
                flagSpec,
                dir,
            )
            t.equal(result.dir, flagDir,
                'returns dir without scanning')
            t.equal(result.spec, flagSpec,
                'returns spec without scanning')
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

// -- subprocess CLI smoke tests --

const CLI = join(process.cwd(), 'dist', 'index.js')
const MOCK_AGENT = join(
    process.cwd(), 'test', 'mock-agent-pass.js'
)
const MOCK_ECHO = join(
    process.cwd(), 'test', 'mock-agent-echo-args.js'
)

function spawnCli (args:string[]):Promise<{
    code:number
    stdout:string
    stderr:string
}> {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            [CLI, ...args],
            { timeout:30_000 },
            (err, stdout, stderr) => {
                const code = err && 'code' in err ?
                    (err as { code:number }).code :
                    (err ? 1 : 0)
                resolve({
                    code:code as number,
                    stdout,
                    stderr,
                })
            },
        )
    })
}

function makeTicketBody (opts:{
    status:string
    blockers?:number[]
}):string {
    const lines = [
        '# Test ticket',
        '',
        `**Status:** ${opts.status}`,
    ]
    if (opts.blockers && opts.blockers.length > 0) {
        lines.push(
            `**Blocked by:** ${opts.blockers.join(', ')}`
        )
    }
    return lines.join('\n')
}

test('CLI subprocess - --model flag forwarded to agent',
    async t => {
        const base = tmp()
        try {
            const issuesDir = join(base, 'issues')
            const logsDir = join(base, 'logs')
            mkdirSync(issuesDir, { recursive:true })

            const specPath = join(base, 'spec.md')
            writeFileSync(specPath, '# Test spec')

            writeFileSync(
                join(issuesDir, '01-echo.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                }),
            )

            const { code } = await spawnCli([
                MOCK_ECHO,
                '--dir', issuesDir,
                '--spec', specPath,
                '--timeout-secs', '10',
                '-m', 'test-model',
            ])

            t.equal(code, 0, 'exit code 0')

            const logPath = join(logsDir, '01-echo.log')
            t.ok(
                existsSync(logPath),
                'log file created',
            )

            const logContent = readFileSync(
                logPath, 'utf8'
            )
            t.ok(
                logContent.includes('--model'),
                'log contains --model flag',
            )
            t.ok(
                logContent.includes('test-model'),
                'log contains model value',
            )
        } finally {
            rmSync(base, { recursive:true, force:true })
        }
    })

test('CLI subprocess - --dry-run output', async t => {
    const base = tmp()
    try {
        const issuesDir = join(base, 'issues')
        mkdirSync(issuesDir, { recursive:true })

        const specPath = join(base, 'spec.md')
        writeFileSync(specPath, '# Test spec')

        writeFileSync(
            join(issuesDir, '01-alpha.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        writeFileSync(
            join(issuesDir, '02-beta.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            }),
        )

        const { code, stdout } = await spawnCli([
            MOCK_AGENT,
            '--dir', issuesDir,
            '--spec', specPath,
            '--dry-run',
        ])

        t.equal(code, 0, 'exit code 0')

        t.ok(
            stdout.includes('Wave 1:') &&
            stdout.includes('01-alpha.md'),
            'stdout contains Wave 1 with first ticket',
        )
        t.ok(
            stdout.includes('Wave 2:') &&
            stdout.includes('02-beta.md'),
            'stdout contains Wave 2 with second ticket',
        )
        t.ok(
            stdout.includes('AGENT INSTRUCTIONS'),
            'stdout contains prompt preview',
        )

        const ticket1 = readFileSync(
            join(issuesDir, '01-alpha.md'), 'utf8'
        )
        t.ok(
            ticket1.includes('**Status:** ready-for-agent'),
            'ticket 1 NOT modified',
        )
        const ticket2 = readFileSync(
            join(issuesDir, '02-beta.md'), 'utf8'
        )
        t.ok(
            ticket2.includes('**Status:** ready-for-agent'),
            'ticket 2 NOT modified',
        )
    } finally {
        rmSync(base, { recursive:true, force:true })
    }
})

test('CLI subprocess - no tickets exits gracefully',
    async t => {
        const base = tmp()
        try {
            const issuesDir = join(base, 'issues')
            mkdirSync(issuesDir, { recursive:true })

            const specPath = join(base, 'spec.md')
            writeFileSync(specPath, '# Empty spec')

            const { code, stdout } = await spawnCli([
                MOCK_AGENT,
                '--dir', issuesDir,
                '--spec', specPath,
            ])

            t.equal(code, 0, 'exit code 0 (graceful)')
            t.ok(
                stdout.includes('No ticket files found'),
                'stdout contains no-tickets message',
            )
        } finally {
            rmSync(base, { recursive:true, force:true })
        }
    })

test('CLI subprocess - error for missing --dir', async t => {
    const base = tmp()
    try {
        const specPath = join(base, 'spec.md')
        writeFileSync(specPath, '# Valid spec')

        const { code, stderr } = await spawnCli([
            MOCK_AGENT,
            '--dir', '/nonexistent/path',
            '--spec', specPath,
        ])

        t.ok(code !== 0, 'exit code is non-zero')
        t.ok(
            stderr.includes('not found'),
            'stderr contains not found',
        )
    } finally {
        rmSync(base, { recursive:true, force:true })
    }
})

test('CLI subprocess - error for missing --spec', async t => {
    const base = tmp()
    try {
        const issuesDir = join(base, 'issues')
        mkdirSync(issuesDir, { recursive:true })

        const { code, stderr } = await spawnCli([
            MOCK_AGENT,
            '--dir', issuesDir,
            '--spec', '/nonexistent/spec.md',
        ])

        t.ok(code !== 0, 'exit code is non-zero')
        t.ok(
            stderr.includes('not found'),
            'stderr contains not found',
        )
    } finally {
        rmSync(base, { recursive:true, force:true })
    }
})

test('CLI subprocess - unknown blocker warning and stripping',
    async t => {
        const base = tmp()
        try {
            const issuesDir = join(base, 'issues')
            const logsDir = join(base, 'logs')
            mkdirSync(issuesDir, { recursive:true })

            const specPath = join(base, 'spec.md')
            writeFileSync(specPath, '# Test spec')

            writeFileSync(
                join(issuesDir, '01-task.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                    blockers:[99],
                }),
            )

            const { code, stdout, stderr } = await spawnCli([
                MOCK_AGENT,
                '--dir', issuesDir,
                '--spec', specPath,
                '--timeout-secs', '10',
            ])

            const combined = stdout + stderr
            t.ok(
                combined.includes('99'),
                'output warns about blocker 99',
            )
            t.ok(
                combined.includes('not found'),
                'output mentions blocker not found',
            )

            t.equal(code, 0, 'exit code 0')

            const ticket = readFileSync(
                join(issuesDir, '01-task.md'), 'utf8'
            )
            t.ok(
                ticket.includes('**Status:** done'),
                'ticket completed after blocker stripped',
            )

            t.ok(
                existsSync(join(logsDir, '01-task.log')),
                'log file created',
            )
        } finally {
            rmSync(base, { recursive:true, force:true })
        }
    })

test('CLI subprocess - dry-run deadlock detection',
    async t => {
        const base = tmp()
        try {
            const issuesDir = join(base, 'issues')
            mkdirSync(issuesDir, { recursive:true })

            const specPath = join(base, 'spec.md')
            writeFileSync(specPath, '# Test spec')

            writeFileSync(
                join(issuesDir, '01-alpha.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                    blockers:[2],
                }),
            )
            writeFileSync(
                join(issuesDir, '02-beta.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                    blockers:[1],
                }),
            )

            const { code, stdout } = await spawnCli([
                MOCK_AGENT,
                '--dir', issuesDir,
                '--spec', specPath,
                '--dry-run',
            ])

            t.equal(code, 0, 'exit code 0')
            t.ok(
                stdout.includes('Deadlocked tickets'),
                'output contains Deadlocked tickets',
            )
            t.ok(
                stdout.includes('01-alpha.md'),
                'deadlock lists first ticket',
            )
            t.ok(
                stdout.includes('02-beta.md'),
                'deadlock lists second ticket',
            )
        } finally {
            rmSync(base, { recursive:true, force:true })
        }
    })

test('CLI subprocess - execute smoke test', async t => {
    const base = tmp()
    try {
        const issuesDir = join(base, 'issues')
        const logsDir = join(base, 'logs')
        mkdirSync(issuesDir, { recursive:true })

        const specPath = join(base, 'spec.md')
        writeFileSync(specPath, '# Test spec\nDo things.')

        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            }),
        )

        const { code } = await spawnCli([
            MOCK_AGENT,
            '--dir', issuesDir,
            '--spec', specPath,
            '--timeout-secs', '10',
        ])

        t.equal(code, 0, 'exit code 0')

        const ticket1 = readFileSync(
            join(issuesDir, '01-first.md'), 'utf8'
        )
        t.ok(
            ticket1.includes('**Status:** done'),
            'ticket 1 marked done',
        )

        const ticket2 = readFileSync(
            join(issuesDir, '02-second.md'), 'utf8'
        )
        t.ok(
            ticket2.includes('**Status:** done'),
            'ticket 2 marked done',
        )

        t.ok(
            existsSync(join(logsDir, '01-first.log')),
            'log file created for ticket 1',
        )
        t.ok(
            existsSync(join(logsDir, '02-second.log')),
            'log file created for ticket 2',
        )
    } finally {
        rmSync(base, { recursive:true, force:true })
    }
})

// -- US-010: setup-then-execute composition --

const DIST_DIR = join(process.cwd(), 'dist')

test('setup-then-execute composition', async t => {
    const projectDir = tmp()
    try {
        setup({
            bundledSkillsDir:join(DIST_DIR, 'skills'),
            docsTemplatesDir:join(
                DIST_DIR, 'docs-templates'
            ),
            projectDir,
            tracker:'local',
        })

        const feature = 'my-feature'
        const issuesDir = join(
            projectDir, '.scratch', feature, 'issues'
        )
        const specPath = join(
            projectDir, '.scratch', feature, 'spec.md'
        )
        mkdirSync(issuesDir, { recursive:true })
        writeFileSync(specPath, '# Feature spec\nDo things.')

        writeFileSync(
            join(issuesDir, '01-alpha.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        writeFileSync(
            join(issuesDir, '02-beta.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            }),
        )

        const { code } = await spawnCli([
            MOCK_AGENT,
            '--dir', issuesDir,
            '--spec', specPath,
            '--timeout-secs', '10',
        ])

        t.equal(code, 0, 'exit code 0')

        const ticket1 = readFileSync(
            join(issuesDir, '01-alpha.md'), 'utf8'
        )
        t.ok(
            ticket1.includes('**Status:** done'),
            'ticket 1 marked done',
        )

        const ticket2 = readFileSync(
            join(issuesDir, '02-beta.md'), 'utf8'
        )
        t.ok(
            ticket2.includes('**Status:** done'),
            'ticket 2 marked done',
        )

        const logsDir = join(
            projectDir, '.scratch', feature, 'logs'
        )
        t.ok(
            existsSync(join(logsDir, '01-alpha.log')),
            'log file created for ticket 1',
        )
        t.ok(
            existsSync(join(logsDir, '02-beta.log')),
            'log file created for ticket 2',
        )

        t.ok(
            existsSync(join(
                projectDir, 'docs', 'agents',
                'issue-tracker.md',
            )),
            'docs/agents/issue-tracker.md exists from setup',
        )

        for (const skill of SKILL_DIRS) {
            t.ok(
                existsSync(join(
                    projectDir, '.agents', 'skills',
                    skill,
                )),
                `.agents/skills/${skill}/ exists from setup`,
            )
        }
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})
