import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    readFileSync, existsSync, rmSync, chmodSync,
    symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, execSync, spawn } from 'node:child_process'
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
    killRunningAgents,
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
const MOCK_HANG = join(
    process.cwd(), 'test', 'mock-agent-hang.js'
)
const MOCK_COMMIT_THEN_HANG = join(
    process.cwd(), 'test', 'mock-agent-commit-then-hang.js'
)
const MOCK_GRANDCHILD_HANG = join(
    process.cwd(), 'test', 'mock-agent-grandchild-hang.js'
)
const MOCK_GRANDCHILD_EXIT = join(
    process.cwd(), 'test', 'mock-agent-grandchild-exit.js'
)
const MOCK_FAIL_TICKET_01 = join(
    process.cwd(), 'test', 'mock-agent-fail-ticket-01.js'
)
const MOCK_DELETE_WORKTREE_01 = join(
    process.cwd(), 'test', 'mock-agent-delete-worktree-01.js'
)
const MOCK_DIRTY_THEN_FAIL = join(
    process.cwd(), 'test', 'mock-agent-dirty-then-fail.js'
)

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Test',
    GIT_COMMITTER_EMAIL:'test@example.com',
    GIT_AUTHOR_NAME:'Test',
    GIT_AUTHOR_EMAIL:'test@example.com',
}

function commitAll (dir:string, message:string):void {
    execSync('git add -A', { cwd:dir })
    execSync(
        `git commit -m "${message}" --no-verify`,
        { cwd:dir, env:GIT_ENV }
    )
}

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
        commitAll(projectDir, 'add tickets')

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

test('runWavesIsolated - a failed ticket is not re-run ' +
    'in a later wave', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '03-dependent.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[2],
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const invocationLog = join(
            projectDir, 'invocations.log'
        )

        const originalCwd = process.cwd()
        const originalEnv = process.env.MOCK_INVOCATION_LOG
        process.env.MOCK_INVOCATION_LOG = invocationLog
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_FAIL_TICKET_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-no-rerun',
                conflictStrategy:'respawn',
                retries:0,
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'failed ticket stays ready-for-agent'
            )
            t.equal(
                tickets[2].status,
                'done',
                'dependent ticket ran in a later wave'
            )

            const invocations = existsSync(invocationLog) ?
                readFileSync(invocationLog, 'utf8')
                    .split('\n').filter(Boolean).length :
                0
            t.equal(
                invocations, 1,
                'failed ticket was only attempted once ' +
                'across the whole run'
            )
        } finally {
            process.chdir(originalCwd)
            if (originalEnv === undefined) {
                delete process.env.MOCK_INVOCATION_LOG
            } else {
                process.env.MOCK_INVOCATION_LOG = originalEnv
            }
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

test('runWavesIsolated - failing test command keeps the ' +
    'ticket ready-for-agent', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

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
                featureName:'test-feature',
                conflictStrategy:'respawn',
                testCmd:'echo suite failed; exit 1',
            })

            t.equal(result.allDone, false, 'run not done')
            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket left for retry'
            )
            const testLog = join(logsDir, '01-first.test.log')
            t.ok(existsSync(testLog), 'test log written')
            t.ok(
                readFileSync(testLog, 'utf8')
                    .includes('suite failed'),
                'test log holds command output'
            )
            const progress = readFileSync(
                join(projectDir, 'progress.md'), 'utf8'
            )
            t.ok(
                !progress.includes('[x] 01-first.md'),
                'progress does not show the ticket done'
            )
            const log = execSync(
                'git log --oneline', { cwd:projectDir }
            ).toString()
            t.ok(
                !log.includes('mock agent change'),
                'branch was not merged into base'
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

test('runWavesIsolated - passing test command runs in the ' +
    'worktree and the ticket completes', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

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
                featureName:'test-feature',
                conflictStrategy:'respawn',
                // Only succeeds inside the worktree where
                // the mock agent wrote its file.
                testCmd:'ls mock-agent-change-*.txt',
            })

            t.equal(result.allDone, true, 'run done')
            t.equal(tickets[0].status, 'done', 'ticket done')
            t.ok(
                existsSync(join(logsDir, '01-first.test.log')),
                'test log written on success too'
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
    'ticket stays ready-for-agent and worktree is cleaned up',
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
        commitAll(projectDir, 'add tickets')

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
            t.equal(
                existsSync(worktreePath),
                false,
                'worktree cleaned up when agent made no commits'
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
    'auto-committed and merged successfully',
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
        commitAll(projectDir, 'add tickets')

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
                'done',
                'ticket with auto-committed changes ' +
                'should be done'
            )

            const repoName = projectDir.split('/').pop()
            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-dirty`
            )
            t.equal(
                existsSync(worktreePath),
                false,
                'worktree removed after successful merge'
            )

            const logOutput = execSync(
                'git log --oneline',
                { cwd:projectDir }
            ).toString()
            t.ok(
                logOutput.includes('auto-commit'),
                'git log contains auto-commit message'
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

test('runWavesIsolated - agent killed at the timeout keeps ' +
    'its committed and uncommitted work', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-slow.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_COMMIT_THEN_HANG,
                model:null,
                timeout:2,
                logsDir,
                featureName:'test-feature-timeout',
                conflictStrategy:'respawn',
            })

            t.equal(
                tickets[0].status,
                'done',
                'timed-out agent with new commits still ' +
                'completes the ticket'
            )
            t.ok(
                existsSync(join(projectDir, 'committed.txt')),
                'work the agent committed is merged into ' +
                'the base branch'
            )
            t.ok(
                existsSync(join(projectDir, 'uncommitted.txt')),
                'work the agent left uncommitted is ' +
                'auto-committed and merged'
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
            commitAll(projectDir, 'add tickets')

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
            commitAll(projectDir, 'add tickets')

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
            commitAll(projectDir, 'add tickets')

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
            commitAll(projectDir, 'add tickets')

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

test('runWavesIsolated - dirty worktree from failed agent is ' +
    'cleaned up', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-dirty-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        writeFileSync(
            join(issuesDir, '02-clean-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_DIRTY_THEN_FAIL,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-dirty-fail',
                conflictStrategy:'respawn',
                retryDelay:0,
                retries:0,
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'failed dirty ticket keeps ready status'
            )

            t.equal(
                tickets[1].status,
                'done',
                'clean ticket still completes'
            )

            const repoName = projectDir
                .split('/').pop()
            const worktreePath = join(
                projectDir, '..',
                `${repoName}.01-dirty-fail`
            )
            t.equal(
                existsSync(worktreePath),
                false,
                'dirty worktree removed after failed agent'
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
        commitAll(projectDir, 'add tickets')
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
            commitAll(projectDir, 'add tickets')

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
            commitAll(projectDir, 'add tickets')

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
        commitAll(projectDir, 'add tickets')

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
        commitAll(projectDir, 'add tickets')

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
        commitAll(projectDir, 'add tickets')

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
        commitAll(projectDir, 'add tickets')

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

test('runWavesIsolated - test gate runs again after a ' +
    'merge-conflict respawn', async t => {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}/01-first`
    const fakeGit = installMergeFailOnceGit(failBranch)
    // Lives outside the worktree so the gate cannot dirty
    // the tree it is judging.
    const counter = join(
        mkdtempSync(join(tmpdir(), 'nightralph-gate-')),
        'count'
    )
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            // Green on the first run, red on the second:
            // the merge conflict happens in between, so
            // only the post-respawn gate can reject this.
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_PASS,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-respawn-gate',
                conflictStrategy:'respawn',
                testCmd:`n=$(cat ${counter} ` +
                    '2>/dev/null || echo 0); ' +
                    `echo $((n + 1)) > ${counter}; ` +
                    'test "$n" -lt 1',
            })

            t.equal(result.allDone, false, 'run not done')
            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket not marked done when the suite ' +
                'is red after the respawn'
            )
            t.equal(
                readFileSync(counter, 'utf8').trim(),
                '2',
                'gate ran twice: once per agent run'
            )

            const log = execSync(
                'git log --oneline', { cwd:projectDir }
            ).toString()
            t.ok(
                !log.includes('mock agent change'),
                'branch was not merged into base'
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
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:join(binDir, 'claude'),
            model:'test-model',
            timeout:10,
            logPath,
        })

        t.equal(result.exitCode, 0, 'agent exits 0')

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
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:join(binDir, 'codex'),
            model:null,
            timeout:10,
            logPath,
        })

        t.equal(result.exitCode, 0, 'agent exits 0')

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

test('spawnAgent - agent that never exits is killed at ' +
    'the timeout and the timeout is reported', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-timeout-log-')
    )
    try {
        const logPath = join(logDir, 'hang.log')
        const lines:string[] = []
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_HANG,
            model:null,
            timeout:1,
            logPath,
            onLine:line => lines.push(line),
        })

        t.equal(
            result.timedOut, true,
            'result reports the timeout'
        )
        t.ok(
            result.exitCode !== 0,
            'a killed agent does not count as exit 0'
        )
        t.ok(
            lines.some(l => /timed out/i.test(l)),
            'timeout is reported through onLine so the ' +
            'display shows it'
        )
        const log = readFileSync(logPath, 'utf8')
        t.ok(
            /timed out/i.test(log),
            'timeout is recorded in the agent log'
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('spawnAgent - an agent that exits before reading ' +
    'stdin does not crash the run', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-epipe-log-')
    )
    const MOCK_EXIT_BEFORE_READING = join(
        process.cwd(), 'test',
        'mock-agent-exit-before-reading.js'
    )
    try {
        const logPath = join(logDir, 'epipe.log')
        // Large enough that the OS pipe buffer cannot
        // absorb it in one write, so the writer observes
        // EPIPE once the reader has exited and closed its
        // end of the pipe.
        const bigPrompt = 'x'.repeat(2 * 1024 * 1024)
        const result = await spawnAgent({
            prompt:bigPrompt,
            agentCmd:MOCK_EXIT_BEFORE_READING,
            model:null,
            timeout:10,
            logPath,
        })

        t.equal(
            result.exitCode, 1,
            'resolves with the process exit code, not a crash'
        )
        t.equal(
            result.timedOut, false,
            'this is not a timeout'
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('spawnAgent - timeout kills the process group, ' +
    'so spawnAgent still resolves promptly when a ' +
    'grandchild holds the stdout pipe open', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-grandchild-log-')
    )
    try {
        const logPath = join(logDir, 'grandchild.log')
        const pidFile = join(logDir, 'grandchild.pid')
        const start = Date.now()
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_GRANDCHILD_HANG,
            model:null,
            timeout:1,
            logPath,
            cwd:logDir,
        })
        const elapsedMs = Date.now() - start

        t.equal(
            result.timedOut, true,
            'result reports the timeout'
        )
        t.ok(
            elapsedMs < 6000,
            'spawnAgent resolves within a few seconds of ' +
            'the timeout even though a grandchild holds ' +
            `the pipe open (took ${elapsedMs}ms)`
        )

        const grandchildPid = Number(
            readFileSync(pidFile, 'utf8').trim()
        )
        let grandchildAlive = true
        try {
            process.kill(grandchildPid, 0)
        } catch {
            grandchildAlive = false
        }
        t.equal(
            grandchildAlive, false,
            'the grandchild process was killed along with ' +
            'the agent'
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('killRunningAgents - kills a tracked agent\'s ' +
    'process group and lets spawnAgent resolve', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-killrunning-log-')
    )
    try {
        const logPath = join(logDir, 'hang.log')
        const resultPromise = spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_HANG,
            model:null,
            timeout:30,
            logPath,
        })

        // Give the process a moment to actually spawn and
        // register itself before we try to kill it.
        await new Promise(r => setTimeout(r, 300))

        killRunningAgents()

        const start = Date.now()
        const result = await resultPromise
        const elapsedMs = Date.now() - start

        t.ok(
            result.exitCode !== 0,
            'a killed agent does not count as exit 0'
        )
        t.equal(
            result.timedOut, false,
            'killRunningAgents is not the timeout path'
        )
        t.ok(
            elapsedMs < 6000,
            `spawnAgent resolved promptly (${elapsedMs}ms)`
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('killRunningAgents - is a no-op when no agents ' +
    'are running', t => {
    let threw = false
    try {
        killRunningAgents()
    } catch {
        threw = true
    }
    t.equal(
        threw, false,
        'calling with an empty registry does not throw'
    )
})

test('spawnAgent - unknown provider passes through ' +
    'with no extra args', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-log-')
    )
    try {
        const logPath = join(logDir, 'unknown.log')
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_ECHO,
            model:'m1',
            timeout:10,
            logPath,
        })

        t.equal(result.exitCode, 0, 'agent exits 0')

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

test('CLI subprocess - SIGINT kills the running ' +
    'agent and its child processes', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir } = scratchDirs(projectDir)

        writeFileSync(
            join(issuesDir, '01-hang.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )

        const child = spawn(process.execPath, [
            CLI, MOCK_GRANDCHILD_HANG,
            '--spec', FEAT,
            '--timeout', '30',
        ], { cwd:projectDir })

        const pidFile = join(projectDir, 'grandchild.pid')
        const deadline = Date.now() + 15_000
        while (
            !existsSync(pidFile) &&
            Date.now() < deadline
        ) {
            await new Promise(r => setTimeout(r, 100))
        }
        t.ok(
            existsSync(pidFile),
            'agent\'s grandchild process started'
        )
        const grandchildPid = Number(
            readFileSync(pidFile, 'utf8').trim()
        )

        child.kill('SIGINT')

        const exitCode:number = await new Promise(resolve => {
            child.on('exit', code => resolve(code ?? -1))
        })

        t.equal(
            exitCode, 130,
            'CLI exits 130 on SIGINT'
        )

        let grandchildAlive = true
        try {
            process.kill(grandchildPid, 0)
        } catch {
            grandchildAlive = false
        }
        t.equal(
            grandchildAlive, false,
            'the agent\'s child process was killed too'
        )
    } finally {
        rmSync(projectDir, {
            recursive:true, force:true,
        })
    }
})

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
                '--retry-delay', '0',
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

// -- thinking escalation --

test('spawnAgent - pi provider receives --thinking when set',
    async t => {
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        const logDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-log-')
        )
        try {
            symlinkSync(MOCK_ECHO, join(binDir, 'pi'))
            chmodSync(join(binDir, 'pi'), 0o755)

            const logPath = join(logDir, 'pi.log')
            const result = await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logPath,
                thinking:'high',
            })

            t.equal(result.exitCode, 0, 'agent exits 0')

            const log = readFileSync(logPath, 'utf8')
            const args = JSON.parse(log.trim().split('\n')[0])
            const idx = args.indexOf('--thinking')
            t.ok(idx >= 0, 'spawned process received --thinking')
            t.equal(
                args[idx + 1], 'high',
                'the level follows the flag'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logDir, { recursive:true, force:true })
        }
    })

test('spawnAgent - non-pi provider never receives --thinking',
    async t => {
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
            await spawnAgent({
                prompt:'test prompt',
                agentCmd:join(binDir, 'codex'),
                model:null,
                timeout:10,
                logPath,
                thinking:'high',
            })

            const log = readFileSync(logPath, 'utf8')
            const args = JSON.parse(log.trim())
            t.equal(
                args.includes('--thinking'), false,
                'codex does not get the pi-only flag'
            )
        } finally {
            rmSync(binDir, { recursive:true, force:true })
            rmSync(logDir, { recursive:true, force:true })
        }
    })

const MOCK_FAIL_THEN_PASS = join(
    process.cwd(), 'test', 'mock-agent-fail-then-pass.js'
)

function cleanupWorktrees (projectDir:string):void {
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
}

test('runWavesIsolated - a failed pi agent is retried with ' +
    'escalated thinking and the retry can succeed', async t => {
    const projectDir = initTempGitRepo()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    try {
        symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-flaky.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                retries:2,
                retryDelay:0,
            })

            t.equal(result.allDone, true, 'run reports all done')
            t.equal(
                tickets[0].status, 'done',
                'ticket is done after the retry'
            )
            t.ok(
                existsSync(join(logsDir, '01-flaky.log')),
                'first attempt log exists'
            )
            t.ok(
                existsSync(join(logsDir, '01-flaky.attempt2.log')),
                'second attempt gets its own log'
            )
            t.equal(
                existsSync(join(logsDir, '01-flaky.attempt3.log')),
                false,
                'no third attempt once the retry succeeds'
            )
            const progressContent = readFileSync(
                join(projectDir, 'progress.md'), 'utf8'
            )
            t.ok(
                progressContent.includes('[x] 01-flaky.md'),
                'progress records the ticket as done'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
        rmSync(binDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - retries:0 disables the retry so the ' +
    'failure stands', async t => {
    const projectDir = initTempGitRepo()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    try {
        symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-flaky.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                retries:0,
            })

            t.equal(result.allDone, false, 'run is not all done')
            t.equal(
                tickets[0].status, 'ready-for-agent',
                'ticket stays ready-for-agent'
            )
            t.equal(
                existsSync(join(logsDir, '01-flaky.attempt2.log')),
                false,
                'no second attempt was made'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
        rmSync(binDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - omitting retryDelay does not ' +
    'wait between retries', async t => {
    const projectDir = initTempGitRepo()
    const binDir = mkdtempSync(
        join(tmpdir(), 'nightralph-provider-test-')
    )
    try {
        symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
        chmodSync(join(binDir, 'pi'), 0o755)

        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-flaky.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            const started = Date.now()
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:join(binDir, 'pi'),
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                retries:2,
            })
            const elapsed = Date.now() - started

            t.equal(result.allDone, true, 'run reports all done')
            t.ok(
                elapsed < 10_000,
                'retried without the CLI default delay ' +
                `(elapsed ${elapsed}ms)`
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
        rmSync(binDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - --thinking is forwarded to a pi agent',
    async t => {
        const projectDir = tmp()
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        try {
            symlinkSync(MOCK_ECHO, join(binDir, 'pi'))
            chmodSync(join(binDir, 'pi'), 0o755)
            const { issuesDir, logsDir } =
                scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-echo.md'),
                makeTicketBody({ status:'ready-for-agent' }),
            )

            const { code } = await spawnCli([
                join(binDir, 'pi'),
                '--spec', FEAT,
                '--timeout', '10',
                '--thinking', 'medium',
            ], { cwd:projectDir })

            t.equal(code, 0, 'exit code 0')
            const logContent = readFileSync(
                join(logsDir, '01-echo.log'), 'utf8'
            )
            const args = JSON.parse(
                logContent.trim().split('\n')[0]
            )
            const idx = args.indexOf('--thinking')
            t.ok(idx >= 0, 'agent received --thinking')
            t.equal(args[idx + 1], 'medium', 'with the level')
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
            rmSync(binDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - --thinking rejects an unknown level',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir } = scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-echo.md'),
                makeTicketBody({ status:'ready-for-agent' }),
            )
            const { code } = await spawnCli([
                MOCK_ECHO,
                '--spec', FEAT,
                '--thinking', 'galaxy-brain',
            ], { cwd:projectDir })
            t.notEqual(code, 0, 'non-zero exit')
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - --retries 0 disables the retry',
    async t => {
        const projectDir = tmp()
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        try {
            symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
            chmodSync(join(binDir, 'pi'), 0o755)
            const { issuesDir, logsDir } =
                scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-flaky.md'),
                makeTicketBody({ status:'ready-for-agent' }),
            )

            const { code } = await spawnCli([
                join(binDir, 'pi'),
                '--spec', FEAT,
                '--timeout', '10',
                '--retries', '0',
            ], { cwd:projectDir })

            t.equal(code, 1, 'run fails')
            t.equal(
                existsSync(join(logsDir, '01-flaky.attempt2.log')),
                false,
                'no retry happened'
            )
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
            rmSync(binDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - default retries recover a flaky pi agent',
    async t => {
        const projectDir = tmp()
        const binDir = mkdtempSync(
            join(tmpdir(), 'nightralph-provider-test-')
        )
        try {
            symlinkSync(MOCK_FAIL_THEN_PASS, join(binDir, 'pi'))
            chmodSync(join(binDir, 'pi'), 0o755)
            const { issuesDir, logsDir } =
                scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-flaky.md'),
                makeTicketBody({ status:'ready-for-agent' }),
            )

            const { code } = await spawnCli([
                join(binDir, 'pi'),
                '--spec', FEAT,
                '--timeout', '10',
                '--retry-delay', '0',
            ], { cwd:projectDir })

            t.equal(code, 0, 'run succeeds with default retries')
            t.ok(
                existsSync(join(logsDir, '01-flaky.attempt2.log')),
                'second attempt ran'
            )
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
            rmSync(binDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - --dry-run in a git repo prints thinking ' +
    'and retries', async t => {
    const projectDir = initTempGitRepo()
    try {
        const { issuesDir } = scratchDirs(projectDir)
        writeFileSync(
            join(issuesDir, '01-alpha.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        commitAll(projectDir, 'add tickets')

        const { code, stdout } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--dry-run',
            '--thinking', 'low',
            '--retries', '3',
            '--retry-delay', '15',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit code 0')
        t.ok(
            /Thinking:\s+low/.test(stdout),
            'prints the starting thinking level'
        )
        t.ok(
            /Retries:\s+3/.test(stdout),
            'prints the retry cap'
        )
        t.ok(
            /Retry delay:\s+15s/.test(stdout),
            'prints the retry delay'
        )
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - a red test gate on the first attempt ' +
    'is retried from a fresh worktree', async t => {
    const projectDir = initTempGitRepo()
    const markerDir = mkdtempSync(
        join(tmpdir(), 'nightralph-gate-marker-')
    )
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)
        writeFileSync(
            join(issuesDir, '01-gate.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        // Fails the first time it runs, passes afterwards.
        const marker = join(markerDir, 'seen')
        const testCmd =
            `test -f ${marker} || { touch ${marker}; false; }`

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
                featureName:'test-feature',
                conflictStrategy:'respawn',
                testCmd,
                retries:1,
                retryDelay:0,
            })

            t.equal(result.allDone, true, 'run reports all done')
            t.equal(tickets[0].status, 'done', 'ticket is done')
            t.ok(
                existsSync(join(logsDir, '01-gate.test.log')),
                'first attempt test log kept'
            )
            t.ok(
                existsSync(
                    join(logsDir, '01-gate.attempt2.test.log')
                ),
                'second attempt test log written'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
        rmSync(markerDir, { recursive:true, force:true })
    }
})

// -- US-008: A throw inside an attempt fails that attempt, not the wave --

test('runWavesIsolated - agent that deletes its worktree ' +
    'fails its ticket but the other ticket succeeds', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-doomed.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-survivor.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        const originalCwd = process.cwd()
        process.chdir(projectDir)

        try {
            const result = await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_DELETE_WORKTREE_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                retries:0,
                retryDelay:0,
            })

            t.equal(
                tickets[0].status,
                'ready-for-agent',
                'ticket 01 stays ready-for-agent ' +
                '(error failed the ticket, not the wave)'
            )
            t.equal(
                tickets[1].status,
                'done',
                'ticket 02 completes successfully'
            )
            t.equal(
                result.allDone,
                false,
                'run reports not all done'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('spawnAgent - grace timer kills process group ' +
    'when agent exits but grandchild holds stdout', async t => {
    const logDir = mkdtempSync(
        join(tmpdir(), 'nightralph-grandchild-exit-')
    )
    try {
        const logPath = join(logDir, 'exit.log')
        const pidFile = join(logDir, 'grandchild.pid')
        const start = Date.now()
        const result = await spawnAgent({
            prompt:'test prompt',
            agentCmd:MOCK_GRANDCHILD_EXIT,
            model:null,
            timeout:30,
            logPath,
            cwd:logDir,
        })
        const elapsedMs = Date.now() - start

        t.equal(
            result.exitCode, 0,
            'agent exited 0'
        )
        t.equal(
            result.timedOut, false,
            'not a timeout -- agent exited voluntarily'
        )
        t.ok(
            elapsedMs < 10000,
            'spawnAgent resolves within 10s ' +
            `(took ${elapsedMs}ms)`
        )

        const grandchildPid = Number(
            readFileSync(pidFile, 'utf8').trim()
        )
        // Small delay to let SIGKILL fully propagate
        await new Promise(r => setTimeout(r, 200))
        let grandchildAlive = true
        try {
            process.kill(grandchildPid, 0)
        } catch {
            grandchildAlive = false
        }
        t.equal(
            grandchildAlive, false,
            'grandchild process is no longer alive'
        )
    } finally {
        rmSync(logDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - no-commits outcome is recorded ' +
    'in progress.md with exit code 0',
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
        commitAll(projectDir, 'add tickets')

        const progressPath = join(
            projectDir, 'progress.md'
        )

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
                featureName:'test-feature',
                conflictStrategy:'respawn',
            })

            t.equal(
                existsSync(progressPath),
                true,
                'progress.md exists after no-commits outcome'
            )

            const content = readFileSync(
                progressPath, 'utf8'
            )
            t.ok(
                content.includes('- [ ]'),
                'progress.md has unchecked ticket'
            )
            t.ok(
                content.includes('exit: 0'),
                'progress.md records exit code 0'
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
