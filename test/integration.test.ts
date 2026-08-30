import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, rmSync, chmodSync,
    symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, execSync } from 'node:child_process'
import {
    findFeatureDirs,
    resolveIssuesDir,
    getScriptDir,
} from '../src/resolve.js'
import { setup, SKILL_DIRS } from '../src/setup.js'
import {
    runWavesIsolated,
    scanTickets,
    spawnAgent,
} from '../src/orchestrator.js'

function tmp ():string {
    return mkdtempSync(
        join(tmpdir(), 'nightralph-int-test-')
    )
}

test('getScriptDir - derives dir from a file:// module URL', t => {
    const result = getScriptDir(
        'file:///opt/nightralph/dist/index.js'
    )
    t.equal(result, '/opt/nightralph/dist',
        'strips the filename, keeping the containing dir')
})

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

test('resolveIssuesDir - resolves name to .scratch/',
    async t => {
        const dir = tmp()
        try {
            const result = await resolveIssuesDir(
                'my-feature',
                dir,
            )
            t.equal(
                result.dir,
                join(dir, '.scratch', 'my-feature',
                    'issues'),
                'dir resolves to .scratch/<name>/issues',
            )
            t.equal(
                result.spec,
                join(dir, '.scratch', 'my-feature',
                    'spec.md'),
                'spec resolves to .scratch/<name>/spec.md',
            )
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
const MOCK_AGENT_FAIL = join(
    process.cwd(), 'test', 'mock-agent-fail.js'
)

function spawnCli (
    args:string[],
    opts?:{ cwd?:string },
):Promise<{
    code:number
    stdout:string
    stderr:string
}> {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            [CLI, ...args],
            { timeout:30_000, cwd:opts?.cwd },
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

const FEAT = 'test-feat'

function scratchDirs (projectDir:string):{
    issuesDir:string
    specPath:string
    logsDir:string
} {
    const base = join(
        projectDir, '.scratch', FEAT
    )
    const issuesDir = join(base, 'issues')
    const specPath = join(base, 'spec.md')
    const logsDir = join(base, 'logs')
    mkdirSync(issuesDir, { recursive:true })
    writeFileSync(specPath, '# Test spec')
    return { issuesDir, specPath, logsDir }
}

test('CLI subprocess - --model flag forwarded to agent',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir, logsDir } =
                scratchDirs(projectDir)

            writeFileSync(
                join(issuesDir, '01-echo.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                }),
            )

            const { code } = await spawnCli([
                MOCK_ECHO,
                '--spec', FEAT,
                '--timeout', '10',
                '-m', 'test-model',
            ], { cwd:projectDir })

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
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - --dry-run output', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir } = scratchDirs(projectDir)

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
            '--spec', FEAT,
            '--dry-run',
        ], { cwd:projectDir })

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
        rmSync(projectDir, {
            recursive:true, force:true,
        })
    }
})

test('CLI subprocess - no tickets exits gracefully',
    async t => {
        const projectDir = tmp()
        try {
            scratchDirs(projectDir)

            const { code, stdout } = await spawnCli([
                MOCK_AGENT,
                '--spec', FEAT,
            ], { cwd:projectDir })

            t.equal(code, 0, 'exit code 0 (graceful)')
            t.ok(
                stdout.includes('No ticket files found'),
                'stdout contains no-tickets message',
            )
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - error for nonexistent feature',
    async t => {
        const projectDir = tmp()
        try {
            const { code, stderr } = await spawnCli([
                MOCK_AGENT,
                '--spec', 'nonexistent',
            ], { cwd:projectDir })

            t.ok(code !== 0, 'exit code is non-zero')
            t.ok(
                stderr.includes('not found'),
                'stderr contains not found',
            )
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - unknown blocker warning and stripping',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir, logsDir } =
                scratchDirs(projectDir)

            writeFileSync(
                join(issuesDir, '01-task.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                    blockers:[99],
                }),
            )

            const { code, stdout, stderr } = await spawnCli([
                MOCK_AGENT,
                '--spec', FEAT,
                '--timeout', '10',
            ], { cwd:projectDir })

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
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - dry-run deadlock detection',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir } = scratchDirs(projectDir)

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
                '--spec', FEAT,
                '--dry-run',
            ], { cwd:projectDir })

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
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - execute smoke test', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir, logsDir } =
            scratchDirs(projectDir)

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
            '--spec', FEAT,
            '--timeout', '10',
        ], { cwd:projectDir })

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
        rmSync(projectDir, {
            recursive:true, force:true,
        })
    }
})

// -- runWavesIsolated integration tests --

const MOCK_PASS = join(
    process.cwd(), 'test', 'mock-agent-pass.js'
)
const MOCK_NOOP = join(
    process.cwd(), 'test', 'mock-agent-noop.js'
)
const MOCK_DIRTY = join(
    process.cwd(), 'test', 'mock-agent-dirty.js'
)
const MOCK_FAIL = join(
    process.cwd(), 'test', 'mock-agent-fail.js'
)

function initTempGitRepo ():string {
    const dir = tmp()
    execSync('git init', { cwd:dir })
    execSync(
        'git config user.email test@example.com',
        { cwd:dir }
    )
    execSync(
        'git config user.name "Test User"',
        { cwd:dir }
    )
    execSync(
        'git config core.hooksPath /dev/null',
        { cwd:dir }
    )
    execSync(
        'git commit --allow-empty -m "init" --no-verify',
        {
            cwd:dir,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        }
    )
    return dir
}

test('runWavesIsolated - two independent tickets ' +
    'run in parallel worktrees', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        // Change to project directory for git operations
        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'done',
                'ticket 1 should be done'
            )
            t.equal(
                tickets[1].status,
                'done',
                'ticket 2 should be done'
            )

            t.ok(
                existsSync(join(logsDir, '01-first.log')),
                'log file for ticket 1 created'
            )
            t.ok(
                existsSync(join(logsDir, '02-second.log')),
                'log file for ticket 2 created'
            )

            const progressPath = join(
                projectDir, 'progress.md'
            )
            t.ok(
                existsSync(progressPath),
                'progress.md should be created'
            )

            const progressContent = readFileSync(
                progressPath, 'utf8'
            )
            t.ok(
                progressContent.includes('[x] 01-first.md'),
                'progress should show ticket 1 as done'
            )
            t.ok(
                progressContent.includes('[x] 02-second.md'),
                'progress should show ticket 2 as done'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - agent exits 0 but makes no commits, ' +
    'ticket stays ready-for-agent and worktree is preserved',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-noop.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_NOOP,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-noop',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket without commits stays ready-for-agent'
            )

            const repoName = projectDir.split('/').pop()
            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-noop`
            )
            t.ok(
                existsSync(worktreePath),
                'worktree preserved when agent made no commits'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - agent leaves uncommitted changes, ' +
    'ticket stays ready-for-agent and worktree is preserved',
async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-dirty.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_DIRTY,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-dirty',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket with uncommitted changes stays ' +
                'ready-for-agent'
            )

            const repoName = projectDir.split('/').pop()
            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-dirty`
            )
            t.ok(
                existsSync(worktreePath),
                'worktree preserved when agent left it dirty'
            )
            t.ok(
                existsSync(
                    join(worktreePath, 'uncommitted-change.txt')
                ),
                'uncommitted file is still present'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - worktrees removed after successful merge',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-first.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            writeFileSync(
                join(issuesDir, '02-second.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_PASS,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature-cleanup',
                    conflictStrategy:'respawn',
                })

                t.equal(
                    tickets[0].status,
                    'done',
                    'ticket 1 should be done'
                )
                t.equal(
                    tickets[1].status,
                    'done',
                    'ticket 2 should be done'
                )

                const repoName = projectDir.split('/').pop()
                const worktreePath1 = join(
                    projectDir, '..', `${repoName}.01-first`
                )
                const worktreePath2 = join(
                    projectDir, '..', `${repoName}.02-second`
                )
                t.equal(
                    existsSync(worktreePath1),
                    false,
                    'worktree 1 removed after successful merge'
                )
                t.equal(
                    existsSync(worktreePath2),
                    false,
                    'worktree 2 removed after successful merge'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring('worktree '.length))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true
                    }))
            } catch {
            }
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('runWavesIsolated - two-wave scenario with dependency',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-base.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            writeFileSync(
                join(issuesDir, '02-depends-on-1.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                    blockers:[1],
                })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_PASS,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature-waves',
                    conflictStrategy:'respawn',
                })

                t.equal(
                    tickets[0].status,
                    'done',
                    'ticket 1 done'
                )
                t.equal(
                    tickets[1].status,
                    'done',
                    'ticket 2 done'
                )

                // Verify log files exist for both
                t.ok(
                    existsSync(join(logsDir, '01-base.log')),
                    'log file for ticket 1'
                )
                t.ok(
                    existsSync(join(logsDir, '02-depends-on-1.log')),
                    'log file for ticket 2'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring('worktree '.length))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true
                    }))
            } catch {
            }
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('runWavesIsolated - progress.md committed after each ticket',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-ticket-a.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            writeFileSync(
                join(issuesDir, '02-ticket-b.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_PASS,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature-progress',
                    conflictStrategy:'respawn',
                })

                // Check git log for progress commits
                const logOutput = execSync(
                    'git log --oneline',
                    { cwd:projectDir }
                ).toString()

                t.ok(
                    logOutput.includes('nightralph: start'),
                    'should have initial progress commit'
                )
                t.ok(
                    logOutput.includes('01-ticket-a.md done'),
                    'should have commit for ticket a done'
                )
                t.ok(
                    logOutput.includes('02-ticket-b.md done'),
                    'should have commit for ticket b done'
                )

                // Verify progress.md content
                const progressPath = join(
                    projectDir, 'progress.md'
                )
                const content = readFileSync(
                    progressPath, 'utf8'
                )
                t.ok(
                    content.includes('[x] 01-ticket-a.md'),
                    'progress shows a done'
                )
                t.ok(
                    content.includes('[x] 02-ticket-b.md'),
                    'progress shows b done'
                )
                t.ok(
                    content.includes('branch:'),
                    'progress includes branch info'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring('worktree '.length))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true
                    }))
            } catch {
            }
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('runWavesIsolated - failed ticket worktree is cleaned up',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-will-fail.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_FAIL,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature-fail',
                    conflictStrategy:'respawn',
                })

                t.equal(
                    tickets[0].status,
                    'ready-for-agent',
                    'failed ticket keeps ready status'
                )

                // Verify worktree is cleaned up after failure
                const repoName = projectDir
                    .split('/').pop()
                const worktreePath = join(
                    projectDir, '..',
                    `${repoName}.01-will-fail`
                )
                t.equal(
                    existsSync(worktreePath),
                    false,
                    'worktree should be removed after failure'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring('worktree '.length))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true
                    }))
            } catch {
            }
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('runWavesIsolated - re-run after a prior failed run does not ' +
    'crash when the branch already exists', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-retry.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)
        const repoName = projectDir.split('/').pop()

        // Simulate a branch left over from a prior failed run,
        // with no worktree currently attached to it.
        execSync(
            `git branch ${repoName}/01-retry`,
            { cwd:projectDir }
        )

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-retry',
                conflictStrategy:'respawn',
            })

            t.equal(
                result.allDone,
                true,
                'run completes instead of crashing on the ' +
                'pre-existing branch'
            )
            t.equal(
                tickets[0].status,
                'done',
                'ticket completes on the re-run'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated returns allDone:false when agent fails',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-fail.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                const result = await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_FAIL,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-fail-result',
                    conflictStrategy:'respawn',
                })
                t.equal(
                    result.allDone, false,
                    'allDone is false when agent fails'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring(
                        'worktree '.length
                    ))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true,
                    }))
            } catch {
            }
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('runWavesIsolated - conflictStrategy stop halts on first failure',
    async t => {
        const projectDir = initTempGitRepo()
        try {
            const issuesDir = join(projectDir, 'issues')
            const logsDir = join(projectDir, '.logs')
            mkdirSync(issuesDir)

            writeFileSync(
                join(issuesDir, '01-first.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            writeFileSync(
                join(issuesDir, '02-second.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const tickets = scanTickets(issuesDir)

            const originalCwd = process.cwd()
            process.chdir(projectDir)

            try {
                await runWavesIsolated({
                    tickets,
                    specBody:'test spec',
                    agentCmd:MOCK_FAIL,
                    model:null,
                    timeout:10,
                    logsDir,
                    featureName:'test-feature-stop',
                    conflictStrategy:'stop',
                })

                t.equal(
                    tickets[0].status,
                    'ready-for-agent',
                    'first ticket fails and stays ready'
                )
                t.equal(
                    tickets[1].status,
                    'ready-for-agent',
                    'second ticket not attempted when stop strategy'
                )
            } finally {
                process.chdir(originalCwd)
            }
        } finally {
            try {
                execSync(
                    'git worktree list --porcelain',
                    { cwd:projectDir }
                ).toString()
                    .split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.substring('worktree '.length))
                    .filter(p => p !== projectDir)
                    .forEach(p => rmSync(p, {
                        recursive:true, force:true
                    }))
            } catch {
            }
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('runWavesIsolated - conflictStrategy stop cleans up ' +
    'worktrees for un-merged branches', async t => {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}/01-first`
    const fakeGit = installMergeFailingGit(failBranch)
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-stop-cleanup',
                conflictStrategy:'stop',
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket whose merge failed stays ready'
            )
            t.equal(
                tickets[1].status,
                'ready-for-agent',
                'ticket after the stop point stays ready'
            )

            const worktreePath1 = join(
                projectDir, '..',
                `${repoName}.01-first`
            )
            const worktreePath2 = join(
                projectDir, '..',
                `${repoName}.02-second`
            )
            t.equal(
                existsSync(worktreePath1),
                false,
                'worktree 1 removed after merge stopped'
            )
            t.equal(
                existsSync(worktreePath2),
                false,
                'worktree 2 removed for un-attempted branch'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        fakeGit.restore()
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

function installMergeFailingGit (failBranch:string):{
    restore:() => void
} {
    const realGit = execSync('command -v git')
        .toString().trim()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-fake-git-')
    )
    writeFileSync(
        join(binDir, 'git'),
        '#!/bin/sh\n' +
        'if [ "$1" = "merge" ] && [ "$2" = "' +
            failBranch + '" ]; then\n' +
        '  exit 1\n' +
        'fi\n' +
        'exec "' + realGit + '" "$@"\n'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = binDir + ':' + originalPath

    return {
        restore:() => {
            process.env.PATH = originalPath
        },
    }
}

test('runWavesIsolated - agent succeeds but merge conflicts, ' +
    'ticket stays ready-for-agent', async t => {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}/01-conflict`
    const fakeGit = installMergeFailingGit(failBranch)
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-conflict.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-conflict',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'agent-succeeded but merge-conflicted ticket ' +
                'stays ready-for-agent'
            )

            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-conflict`
            )
            t.ok(
                existsSync(worktreePath),
                'worktree should still exist after merge conflict'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        fakeGit.restore()
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

// -- US-005: respawn on merge conflict --

const MOCK_ONCE = join(
    process.cwd(), 'test', 'mock-agent-once.js'
)

// Installs a fake `git` on PATH whose `git merge
// <failBranch>` fails the first time it is called and
// succeeds on every subsequent call, simulating a
// conflict that the respawned agent resolves.
function installMergeFailOnceGit (failBranch:string):{
    restore:() => void
} {
    const realGit = execSync('command -v git')
        .toString().trim()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-fake-git-once-')
    )
    const counterFile = join(binDir, 'calls')
    writeFileSync(
        join(binDir, 'git'),
        '#!/bin/sh\n' +
        'COUNTER="' + counterFile + '"\n' +
        'if [ "$1" = "merge" ] && [ "$2" = "' +
            failBranch + '" ]; then\n' +
        '  if [ ! -f "$COUNTER" ]; then\n' +
        '    echo called > "$COUNTER"\n' +
        '    exit 1\n' +
        '  fi\n' +
        'fi\n' +
        'exec "' + realGit + '" "$@"\n'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = binDir + ':' + originalPath

    return {
        restore:() => {
            process.env.PATH = originalPath
        },
    }
}

test('runWavesIsolated - two-branch wave, second branch ' +
    'conflicts, agent respawned and succeeds on retry',
async t => {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}/02-second`
    const fakeGit = installMergeFailOnceGit(failBranch)
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-respawn',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'done',
                'ticket 1 should be done'
            )
            t.equal(
                tickets[1].status,
                'done',
                'ticket 2 should be done after respawn retry'
            )

            const repoNameLocal = repoName
            const worktreePath2 = join(
                projectDir, '..',
                `${repoNameLocal}.02-second`
            )
            t.equal(
                existsSync(worktreePath2),
                false,
                'worktree 2 removed after respawn success'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        fakeGit.restore()
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - respawned agent fails, ' +
    'ticket stays ready-for-agent', async t => {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}/01-conflict`
    const fakeGit = installMergeFailingGit(failBranch)
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-conflict.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_ONCE,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-respawn-fail',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket stays ready-for-agent when the ' +
                'respawned agent fails'
            )

            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-conflict`
            )
            t.ok(
                existsSync(worktreePath),
                'worktree should still exist after ' +
                'respawn failure'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        fakeGit.restore()
        try {
            execSync(
                'git worktree list --porcelain',
                { cwd:projectDir }
            ).toString()
                .split('\n')
                .filter(l => l.startsWith('worktree '))
                .map(l => l.substring('worktree '.length))
                .filter(p => p !== projectDir)
                .forEach(p => rmSync(p, {
                    recursive:true, force:true
                }))
        } catch {
        }
        rmSync(projectDir, { recursive:true, force:true })
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
            '--spec', feature,
            '--timeout', '10',
        ], { cwd:projectDir })

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

// -- US-003: provider adapter integration --

test('spawnAgent - claude provider prepends --print ' +
    'to spawned process args', async t => {
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-log-')
    )
    try {
        symlinkSync(MOCK_ECHO, join(binDir, 'claude'))
        chmodSync(join(binDir, 'claude'), 0o755)

        const logPath = join(logDir, 'claude.log')
        const exitCode = await spawnAgent({
            prompt:'test prompt',
            agentCmd:join(binDir, 'claude'),
            model:'test-model',
            timeout:10,
            logPath,
        })

        t.equal(exitCode, 0, 'agent exits 0')

        const log = readFileSync(logPath, 'utf8')
        const args = JSON.parse(log.trim())
        t.ok(
            args.includes('--print'),
            'spawned process received --print'
        )
        t.ok(
            args.includes('--model') &&
            args.includes('test-model'),
            '--model still forwarded after --print'
        )
    } finally {
        rmSync(binDir, { recursive:true, force:true })
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('spawnAgent - codex provider prepends exec ' +
    'to spawned process args', async t => {
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-log-')
    )
    try {
        symlinkSync(MOCK_ECHO, join(binDir, 'codex'))
        chmodSync(join(binDir, 'codex'), 0o755)

        const logPath = join(logDir, 'codex.log')
        const exitCode = await spawnAgent({
            prompt:'test prompt',
            agentCmd:join(binDir, 'codex'),
            model:null,
            timeout:10,
            logPath,
        })

        t.equal(exitCode, 0, 'agent exits 0')

        const log = readFileSync(logPath, 'utf8')
        const args = JSON.parse(log.trim())
        t.ok(
            args.includes('exec'),
            'spawned process received exec'
        )
    } finally {
        rmSync(binDir, { recursive:true, force:true })
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('spawnAgent - unknown provider passes through ' +
    'with no extra args', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-log-')
    )
    try {
        const logPath = join(logDir, 'unknown.log')
        const exitCode = await spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_ECHO,
            model:'m1',
            timeout:10,
            logPath,
        })

        t.equal(exitCode, 0, 'agent exits 0')

        const log = readFileSync(logPath, 'utf8')
        const args:string[] = JSON.parse(log.trim())
        t.ok(
            !args.includes('--print') &&
            !args.includes('exec'),
            'no provider-specific args injected'
        )
        t.ok(
            args.includes('--model') &&
            args.includes('m1'),
            '--model still forwarded for unknown provider'
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

// -- exit code tests --

test('CLI subprocess exits 1 when agent fails',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir } = scratchDirs(projectDir)

            writeFileSync(
                join(issuesDir, '01-fail.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                }),
            )

            const { code } = await spawnCli([
                MOCK_AGENT_FAIL,
                '--spec', FEAT,
                '--timeout', '10',
            ], { cwd:projectDir })

            t.ok(
                code !== 0,
                'exit code is nonzero when agent fails'
            )
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess exits 0 when all tickets complete',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir } = scratchDirs(projectDir)

            writeFileSync(
                join(issuesDir, '01-pass.md'),
                makeTicketBody({
                    status:'ready-for-agent',
                }),
            )

            const { code } = await spawnCli([
                MOCK_AGENT,
                '--spec', FEAT,
                '--timeout', '10',
            ], { cwd:projectDir })

            t.equal(code, 0,
                'exit code 0 when all tickets done')
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })
