import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync,
    appendFileSync, copyFileSync,
    readFileSync, existsSync, rmSync, chmodSync,
    symlinkSync, readdirSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
    execFile, execFileSync, execSync, spawn,
} from 'node:child_process'
import {
    findFeatureDirs,
    resolveIssuesDir,
    getScriptDir,
} from '../src/resolve.js'
import { setup, SKILL_DIRS } from '../src/setup.js'
import { ticketLabel, type Display } from '../src/display.js'
import {
    runWavesIsolated,
    scanTickets,
    spawnAgent,
    killRunningAgents,
    killProcessGroup,
    ticketKey,
    blockerLabel,
    type Ticket,
} from '../src/orchestrator.js'
import type { BlockerRef } from '../src/blockers.js'
import { parseEntries, readEntries } from '../src/learnings.js'
import { readProgress } from '../src/progress.js'
import { parseReviewEntries } from '../src/review.js'

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

test('findFeatureDirs - excludes completed specs', t => {
    const dir = tmp()
    try {
        const scratch = join(dir, '.scratch')
        mkdirSync(
            join(scratch, 'done-feat', 'issues'),
            { recursive:true },
        )
        writeFileSync(
            join(scratch, 'done-feat', 'spec.md'),
            '# spec',
        )
        writeFileSync(
            join(scratch, 'done-feat', 'progress.md'),
            [
                '# Progress: done-feat',
                '',
                'Started: 2026-01-01T00:00:00.000Z',
                '',
                '- [x] 01-task.md',
                '  branch: repo--01-task',
                '  exit: 0',
                '  completed: 2026-01-01T00:01:00.000Z',
            ].join('\n') + '\n',
        )

        mkdirSync(
            join(scratch, 'open-feat', 'issues'),
            { recursive:true },
        )
        writeFileSync(
            join(scratch, 'open-feat', 'spec.md'),
            '# spec',
        )

        const result = findFeatureDirs(dir)
        t.equal(result.length, 1,
            'only the incomplete spec is returned')
        t.equal(result[0].name, 'open-feat',
            'returns the open feature')
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
                result[0].dir,
                join(dir, '.scratch', 'my-feature',
                    'issues'),
                'dir resolves to .scratch/<name>/issues',
            )
            t.equal(
                result[0].spec,
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
    opts?:{
        cwd?:string
        env?:NodeJS.ProcessEnv
        closeStdin?:boolean
    },
):Promise<{
    code:number
    stdout:string
    stderr:string
}> {
    return new Promise(resolve => {
        const child = execFile(
            process.execPath,
            [CLI, ...args],
            { timeout:30_000, cwd:opts?.cwd, env:opts?.env },
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
        if (opts?.closeStdin) child.stdin?.end()
    })
}

// True when some line of `text` is a stack frame.
function hasStackLine (text:string):boolean {
    return text.split('\n').some(l => l.startsWith('    at '))
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

test('CLI subprocess - unknown blocker keeps the ticket from running',
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

            // Positive control: the run loaded the ticket and ended
            // normally, so the assertions below are not explained by
            // an early failure (exit 2) or a timeout.
            t.equal(code, 0, 'nothing to run is not an error')
            t.ok(
                stdout.includes('Found 1 tickets'),
                'the CLI scanned the ticket',
            )
            const combined = stdout + stderr
            t.ok(
                combined.includes('99'),
                'the summary names blocker 99',
            )
            t.ok(
                combined.includes('not found'),
                'the summary says it was not found',
            )

            const ticket = readFileSync(
                join(issuesDir, '01-task.md'), 'utf8'
            )
            t.ok(
                ticket.includes('**Status:** ready-for-agent'),
                'ticket is still waiting on its blocker',
            )
            t.ok(
                !existsSync(join(logsDir, '01-task.log')),
                'no agent ran',
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
                stdout.includes(`${FEAT}/01`),
                'deadlock lists first ticket',
            )
            t.ok(
                stdout.includes(`${FEAT}/02`),
                'deadlock lists second ticket',
            )
        } finally {
            rmSync(projectDir, {
                recursive:true, force:true,
            })
        }
    })

test('CLI subprocess - AC2.9: the finish summary repeats a typo ' +
    'warning', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir } = scratchDirs(projectDir)

        writeFileSync(
            join(issuesDir, '01-done.md'),
            makeTicketBody({ status:'done' }),
        )
        // The typo ref falls back to own ticket 01, which is done,
        // so 02 runs and the warning only shows in the summary.
        writeFileSync(
            join(issuesDir, '02-typo.md'),
            '# Test ticket\n\n**Status:** ready-for-agent\n' +
            '**Blocked by:** nwsletter-audit 01\n',
        )

        const { code, stdout, stderr } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--timeout', '10',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit code 0')
        t.ok(
            (stdout + stderr).includes('nwsletter-audit'),
            'the summary names the misspelt feature',
        )
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
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
const MOCK_NOTES = join(
    process.cwd(), 'test', 'mock-agent-notes.js'
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

// With `templateDir`, the repo also ignores the machine's git
// template and global excludes file, so neither can hide paths
// from `git add -A` or receive writes meant for this repo.
function initTempGitRepo (opts?:{ templateDir?:string }):string {
    const dir = tmp()
    if (opts?.templateDir) {
        execFileSync(
            'git', ['init', `--template=${opts.templateDir}`],
            { cwd:dir, stdio:'ignore' }
        )
        execSync('git config core.excludesFile /dev/null', { cwd:dir })
    } else {
        execSync('git init', { cwd:dir })
    }
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
                testCmd:'true',
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
                testCmd:'true',
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

test('runWavesIsolated - an empty test command writes no test ' +
    'log and merges the branch', async t => {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const projectDir = initTempGitRepo({ templateDir })
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
                testCmd:'',
            })

            t.equal(result.allDone, true, 'run done')
            t.equal(tickets[0].status, 'done', 'ticket done')
            t.ok(
                !existsSync(join(logsDir, '01-first.test.log')),
                'no test log without a gate'
            )
            const log = execSync(
                'git log --oneline',
                { cwd:projectDir }
            ).toString()
            t.ok(
                log.includes('mock agent change'),
                'branch with commits is merged'
            )
        } finally {
            process.chdir(originalCwd)
        }
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - install command runs in the ' +
    'worktree before the test gate', async t => {
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
                installCmd:'echo ok > install-marker',
                // Only succeeds where the install ran.
                testCmd:'test -f install-marker',
                retries:0,
            })

            t.equal(result.allDone, true, 'run done')
            t.equal(tickets[0].status, 'done', 'ticket done')
            t.ok(
                existsSync(
                    join(logsDir, '01-first.install.log')
                ),
                'install log written'
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

test('runWavesIsolated - a failed install fails the ' +
    'ticket without running the agent', async t => {
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
                installCmd:'exit 1',
                testCmd:'true',
                retries:0,
            })

            t.equal(result.allDone, false, 'run not done')
            t.equal(
                tickets[0].status, 'ready-for-agent',
                'ticket not done'
            )
            t.ok(
                !existsSync(join(logsDir, '01-first.log')),
                'agent never ran'
            )
            t.ok(
                existsSync(
                    join(logsDir, '01-first.install.log')
                ),
                'install log written'
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
                testCmd:'true',
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
                testCmd:'true',
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
                testCmd:'true',
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
                    testCmd:'true',
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
                    testCmd:'true',
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
                    testCmd:'true',
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
                    testCmd:'true',
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
                testCmd:'true',
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
            `git branch ${repoName}--01-retry`,
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
                testCmd:'true',
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
                    testCmd:'true',
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
                    testCmd:'true',
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
    const failBranch = `${repoName}--01-first`
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
                testCmd:'true',
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
    const failBranch = `${repoName}--01-conflict`
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
                testCmd:'true',
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

// -- session list and blocked reporting (runWavesIsolated) --

type DisplayCall = { method:string; args:Array<unknown> }

// Records every Display call, in order, so tests can assert on
// call order and arguments rather than rendered text.
function recordingDisplay ():{
    display:Display
    calls:Array<DisplayCall>
} {
    const calls:Array<DisplayCall> = []
    const record = (method:string) => (...args:Array<unknown>) => {
        calls.push({ method, args })
    }
    return {
        calls,
        display:{
            startRun:record('startRun'),
            startWave:record('startWave'),
            setTicketStatus:record('setTicketStatus'),
            setBlocked:record('setBlocked'),
            log:record('log'),
            cleanup:record('cleanup'),
        },
    }
}

// Fixture lookup that fails loudly, naming the missing ticket,
// instead of crashing later on an undefined value.
function mustFind (
    tickets:ReadonlyArray<Ticket>,
    num:number,
):Ticket {
    const found = tickets.find(t => t.num === num)
    if (!found) throw new Error(`fixture has no ticket ${num}`)
    return found
}

// The ticket numbers passed to one startRun or startWave call.
function refNums (tickets:unknown):Array<number> {
    return (tickets as ReadonlyArray<{ num:number }>)
        .map(r => r.num)
}

function removeWorktreesAndRepo (projectDir:string):void {
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

test('runWavesIsolated - AC4.2 AC4.3: startRun once with the ' +
    'session set, then setBlocked for human and failed ' +
    'blockers', async t => {
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
            join(issuesDir, '02-after-fail.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            })
        )
        writeFileSync(
            join(issuesDir, '03-after-human.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[4],
            })
        )
        writeFileSync(
            join(issuesDir, '04-human.md'),
            makeTicketBody({ status:'ready-for-human' })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const { display, calls } = recordingDisplay()

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_FAIL_TICKET_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-blocked',
                conflictStrategy:'respawn',
                retries:0,
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const startRuns = calls.filter(c => c.method === 'startRun')
        t.equal(startRuns.length, 1, 'exactly one startRun call')
        const startRunIndex = calls.findIndex(
            c => c.method === 'startRun'
        )
        const firstWave = calls.findIndex(
            c => c.method === 'startWave'
        )
        t.ok(
            startRunIndex >= 0 && firstWave > startRunIndex,
            'startRun comes before the first startWave'
        )
        t.deepEqual(
            refNums(startRuns[0]?.args[0] ?? []),
            [1, 2, 3],
            'session set is tickets 1, 2, 3 in order'
        )
        // Ticket 4 (human) is outside the session, so it counts
        // toward neither the completed nor the total figure.
        t.deepEqual(
            calls[firstWave]?.args[3],
            { completed:0, total:3 },
            'wave progress counts only the session set'
        )

        const blockedThree = calls.findIndex(c => (
            c.method === 'setBlocked' && c.args[0] === 3
        ))
        t.ok(
            blockedThree > startRunIndex &&
            blockedThree < firstWave,
            'ticket 3 is reported blocked before the first wave'
        )
        t.deepEqual(
            calls[blockedThree]?.args[2],
            [ticketLabel(mustFind(tickets, 4))],
            'ticket 3 names ticket 4'
        )

        const blockedTwo = calls.findIndex((c, i) => (
            i > firstWave &&
            c.method === 'setBlocked' &&
            c.args[0] === 2
        ))
        t.ok(
            blockedTwo > firstWave,
            'ticket 2 is reported blocked after the first wave'
        )
        t.deepEqual(
            calls[blockedTwo]?.args[2],
            [ticketLabel(mustFind(tickets, 1))],
            'ticket 2 names ticket 1'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
    }
})

test('runWavesIsolated - AC2.2 AC2.4 AC2.5: blocked rows name ' +
    'outside, missing and chained blockers', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        for (const name of [
            '01-ready.md', '02-pending.md', '03-missing.md',
            '04-chain.md', '05-mid.md',
        ]) {
            writeFileSync(
                join(issuesDir, name),
                makeTicketBody({ status:'ready-for-agent' })
            )
        }

        const tickets = scanTickets(issuesDir)
        const pendingRef:BlockerRef = {
            feature:'other',
            num:7,
            where:'pending',
            status:'ready-for-agent',
        }
        const missingRef:BlockerRef = {
            feature:'other', num:9, where:'missing',
        }
        const chainRef:BlockerRef = {
            feature:'other',
            num:8,
            where:'pending',
            status:'ready-for-human',
        }
        mustFind(tickets, 2).blockers = [pendingRef]
        mustFind(tickets, 3).blockers = [missingRef]
        mustFind(tickets, 4).blockers = [
            { feature:'', num:5, where:'run' },
        ]
        mustFind(tickets, 5).blockers = [chainRef]
        commitAll(projectDir, 'add tickets')
        const { display, calls } = recordingDisplay()

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
                featureName:'test-feature-outside',
                conflictStrategy:'respawn',
                retries:0,
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const labelsFor = (n:number) => calls.find(c => (
            c.method === 'setBlocked' && c.args[0] === n
        ))?.args[2]
        t.deepEqual(
            labelsFor(2), [blockerLabel(pendingRef)],
            'ticket 2 names the outside ticket and its status'
        )
        t.deepEqual(
            labelsFor(3), [blockerLabel(missingRef)],
            'ticket 3 names the blocker that was not found'
        )
        t.deepEqual(
            labelsFor(4), [blockerLabel(chainRef)],
            'ticket 4 names the outside ticket behind ticket 5'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
    }
})

test('runWavesIsolated - AC4.3: a dependent of a failed ' +
    'ticket is reported blocked before the next wave', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        // Wave 1 is {1, 3}: ticket 1 fails, ticket 3 passes. That
        // is progress, so wave 2 runs {4}, and ticket 2 must be
        // reported blocked between the two waves.
        writeFileSync(
            join(issuesDir, '01-fail.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-after-fail.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            })
        )
        writeFileSync(
            join(issuesDir, '03-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '04-after-pass.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[3],
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const { display, calls } = recordingDisplay()

        const originalCwd = process.cwd()
        process.chdir(projectDir)
        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_FAIL_TICKET_01,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature-blocked-between',
                conflictStrategy:'respawn',
                retries:0,
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const waveIndexes = calls
            .map((c, i) => (c.method === 'startWave' ? i : -1))
            .filter(i => i >= 0)
        t.equal(waveIndexes.length, 2, 'two waves run')
        t.deepEqual(
            waveIndexes.map(i => refNums(calls[i]?.args[2] ?? [])),
            [[1, 3], [4]],
            'wave 1 is tickets 1 and 3, wave 2 is ticket 4'
        )

        const blockedTwo = calls.findIndex(c => (
            c.method === 'setBlocked' && c.args[0] === 2
        ))
        const [firstWave = -1, secondWave = -1] = waveIndexes
        t.ok(
            blockedTwo > firstWave && blockedTwo < secondWave,
            'ticket 2 is first reported blocked between wave 1 ' +
            'and wave 2'
        )
        t.deepEqual(
            calls[blockedTwo]?.args,
            [
                2,
                mustFind(tickets, 2).feature,
                [ticketLabel(mustFind(tickets, 1))],
            ],
            'ticket 2 is blocked by ticket 1'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
    }
})

test('runWavesIsolated - AC4.4: no runnable tickets never ' +
    'starts a run or a wave', async t => {
    const projectDir = initTempGitRepo()
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-done.md'),
            makeTicketBody({ status:'done' })
        )
        writeFileSync(
            join(issuesDir, '02-human.md'),
            makeTicketBody({ status:'ready-for-human' })
        )
        // Ready-for-agent but blocked by the human ticket: nothing
        // is ready, yet any blocked report outside a wave would
        // call setBlocked for it.
        writeFileSync(
            join(issuesDir, '03-waiting.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[2],
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const { display, calls } = recordingDisplay()

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
                featureName:'test-feature-none-runnable',
                conflictStrategy:'respawn',
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const methods = calls.map(c => c.method)
        t.ok(!methods.includes('startRun'), 'startRun never called')
        t.ok(
            !methods.includes('startWave'),
            'startWave never called'
        )
        t.ok(
            !methods.includes('setBlocked'),
            'setBlocked never called'
        )
        const logged = calls
            .filter(c => c.method === 'log')
            .map(c => String(c.args[0]))
            .join('\n')
        t.ok(
            logged.includes('02-human.md'),
            'finish summary is logged and names the human ticket'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
    }
})

// Shared setup for the AC2.6 tests: the merge of ticket 1's
// branch always fails, and ticket 2 depends on ticket 1.
async function runWithFailedMerge (
    conflictStrategy:'respawn'|'stop',
):Promise<{
    calls:Array<DisplayCall>
    tickets:ReturnType<typeof scanTickets>
}> {
    const projectDir = initTempGitRepo()
    const repoName = projectDir.split('/').pop()
    const failBranch = `${repoName}--01-conflict`
    const fakeGit = installMergeFailingGit(failBranch)
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        mkdirSync(issuesDir)

        writeFileSync(
            join(issuesDir, '01-conflict.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-after.md'),
            makeTicketBody({
                status:'ready-for-agent',
                blockers:[1],
            })
        )

        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')
        const { display, calls } = recordingDisplay()

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
                featureName:'test-feature-merge-blocked',
                conflictStrategy,
                testCmd:'true',
                display,
            })
        } finally {
            process.chdir(originalCwd)
        }
        return { calls, tickets }
    } finally {
        fakeGit.restore()
        removeWorktreesAndRepo(projectDir)
    }
}

test('runWavesIsolated - AC2.6: an unrecovered merge failure ' +
    'marks the ticket failed and blocks its dependents',
async t => {
    const { calls, tickets } = await runWithFailedMerge('respawn')
    const one = mustFind(tickets, 1)

    t.ok(
        calls.some(c => (
            c.method === 'setTicketStatus' &&
            c.args[0] === 1 &&
            c.args[1] === 'failed'
        )),
        'ticket 1 row is set to failed'
    )
    const blockedTwo = calls.find(c => (
        c.method === 'setBlocked' && c.args[0] === 2
    ))
    t.deepEqual(
        blockedTwo?.args[2],
        [ticketLabel(one)],
        'ticket 2 is reported blocked by ticket 1'
    )
})

test('runWavesIsolated - AC2.6: with the stop strategy the ' +
    'merge failure still blocks dependents', async t => {
    const { calls, tickets } = await runWithFailedMerge('stop')
    const one = mustFind(tickets, 1)

    const blockedTwo = calls.find(c => (
        c.method === 'setBlocked' && c.args[0] === 2
    ))
    t.deepEqual(
        blockedTwo?.args[2],
        [ticketLabel(one)],
        'ticket 2 is reported blocked by ticket 1'
    )
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
    const failBranch = `${repoName}--02-second`
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
                testCmd:'true',
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
    const failBranch = `${repoName}--01-conflict`
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
                testCmd:'true',
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
    const failBranch = `${repoName}--01-first`
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

        const killed = killRunningAgents()
        t.ok(killed >= 1, `killRunningAgents returns a count (${killed})`)

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
    t.equal(
        killRunningAgents(), 0,
        'empty registry reports a count of 0'
    )
})

test('killProcessGroup - falls back to a direct kill ' +
    'when the pid is not a group leader', async t => {
    // The child was not spawned detached, so it is not its own
    // process group leader; the group kill (-pid) fails and the
    // fallback must kill the child directly.
    const child = spawn('sleep', ['30'])
    t.ok(child.pid, 'child spawned')
    killProcessGroup(child.pid)
    const signal = await new Promise<string|null>(
        resolve => child.once('exit', (_c, s) => resolve(s))
    )
    t.equal(
        signal, 'SIGKILL',
        'child was killed by the direct-kill fallback'
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

// -- effort escalation --

test('spawnAgent - effort maps to --thinking for pi provider',
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
                effort:'high',
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

test('spawnAgent - codex provider receives ' +
    'model_reasoning_effort via -c flag',
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
            effort:'high',
        })

        const log = readFileSync(logPath, 'utf8')
        const args = JSON.parse(log.trim())
        const idx = args.indexOf('-c')
        t.ok(idx >= 0, 'spawned process received -c')
        t.equal(
            args[idx + 1],
            'model_reasoning_effort=high',
            'the reasoning effort config follows -c'
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
    'escalated effort and the retry can succeed', async t => {
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
                testCmd:'true',
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
                testCmd:'true',
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
                testCmd:'true',
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

test('CLI subprocess - --effort is forwarded to a pi agent',
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
                '--effort', 'medium',
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

test('CLI subprocess - --effort rejects an unknown level',
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
                '--effort', 'galaxy-brain',
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

test('CLI subprocess - --dry-run in a git repo prints effort ' +
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
            '--effort', 'low',
            '--retries', '3',
            '--retry-delay', '15',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit code 0')
        t.ok(
            /Effort:\s+low/.test(stdout),
            'prints the starting effort level'
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
                testCmd:'true',
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
                testCmd:'true',
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

// -- concurrency --

const MOCK_CONCURRENT = join(
    process.cwd(), 'test', 'mock-agent-concurrent.js'
)

test('runWavesIsolated never runs more agents than ' +
    'concurrency allows', async t => {
    const projectDir = initTempGitRepo()
    const originalCwd = process.cwd()
    const originalEnv = process.env.MOCK_CONCURRENCY_DIR
    try {
        const issuesDir = join(projectDir, 'issues')
        const logsDir = join(projectDir, '.logs')
        const markerDir = join(tmpdir(), `nr-markers-${Date.now()}`)
        mkdirSync(issuesDir)
        mkdirSync(markerDir, { recursive:true })

        for (let i = 1; i <= 5; i++) {
            writeFileSync(
                join(issuesDir, `0${i}-t${i}.md`),
                makeTicketBody({ status:'ready-for-agent' })
            )
        }
        const tickets = scanTickets(issuesDir)
        commitAll(projectDir, 'add tickets')

        process.chdir(projectDir)
        process.env.MOCK_CONCURRENCY_DIR = markerDir
        try {
            await runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_CONCURRENT,
                model:null,
                timeout:10,
                logsDir,
                featureName:'test-feature',
                conflictStrategy:'respawn',
                testCmd:'true',
                retries:0,
                concurrency:2,
            })
        } finally {
            process.chdir(originalCwd)
        }

        const peaks = readFileSync(join(markerDir, 'peaks'), 'utf8')
            .trim().split('\n').map(Number)
        t.equal(peaks.length, 5, 'every agent ran')
        const peak = Math.max(...peaks)
        t.ok(peak <= 2,
            `peak concurrent agents ${peak} is at most 2`)
        t.ok(peak >= 2, 'the cap was actually used, not 1')
        rmSync(markerDir, { recursive:true, force:true })
    } finally {
        if (originalEnv === undefined) {
            delete process.env.MOCK_CONCURRENCY_DIR
        } else {
            process.env.MOCK_CONCURRENCY_DIR = originalEnv
        }
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - --concurrency is accepted and shown ' +
    'in dry-run output', async t => {
    const projectDir = initTempGitRepo()
    try {
        const { issuesDir } = scratchDirs(projectDir)
        writeFileSync(
            join(issuesDir, '01-alpha.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        commitAll(projectDir, 'add tickets')

        const { code, stdout, stderr } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--dry-run',
            '--concurrency', '2',
        ], { cwd:projectDir })

        t.equal(code, 0, `exit code 0 (stderr: ${stderr})`)
        t.ok(
            stdout.includes('Concurrency:  2'),
            'dry-run output shows the concurrency cap',
        )
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('runWavesIsolated - multi-feature tickets write ' +
    'per-feature progress files', async t => {
    const projectDir = initTempGitRepo()
    const originalCwd = process.cwd()
    try {
        const authDir = join(
            projectDir, '.scratch', 'auth', 'issues'
        )
        const payDir = join(
            projectDir, '.scratch', 'payments', 'issues'
        )
        mkdirSync(authDir, { recursive:true })
        mkdirSync(payDir, { recursive:true })

        writeFileSync(
            join(authDir, '01-login.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )
        writeFileSync(
            join(payDir, '01-stripe.md'),
            makeTicketBody({ status:'ready-for-agent' }),
        )

        const authTickets = scanTickets(authDir, 'auth')
        const payTickets = scanTickets(payDir, 'payments')
        const allTickets = [...authTickets, ...payTickets]

        commitAll(projectDir, 'add tickets')

        const logsDir = join(projectDir, '.scratch', 'logs')
        const authProgressPath = join(
            projectDir, '.scratch', 'auth', 'progress.md'
        )
        const payProgressPath = join(
            projectDir, '.scratch', 'payments',
            'progress.md'
        )

        const specBodies = new Map([
            ['auth', '# Auth spec'],
            ['payments', '# Payments spec'],
        ])
        const progressPaths = new Map([
            ['auth', authProgressPath],
            ['payments', payProgressPath],
        ])

        const logs:string[] = []
        const display = {
            startRun () {},
            startWave () {},
            setTicketStatus () {},
            setBlocked () {},
            log (m:string) { logs.push(m) },
            cleanup () {},
        }

        process.chdir(projectDir)

        await runWavesIsolated({
            tickets:allTickets,
            specBody:'# fallback',
            specBodies,
            agentCmd:MOCK_PASS,
            model:null,
            timeout:30,
            logsDir,
            featureName:'auth',
            conflictStrategy:'respawn',
            display,
            testCmd:'true',
            retries:0,
            progressPaths,
        })

        t.ok(
            existsSync(authProgressPath),
            'auth progress file created'
        )
        t.ok(
            existsSync(payProgressPath),
            'payments progress file created'
        )

        const authProgress = readFileSync(
            authProgressPath, 'utf8'
        )
        const payProgress = readFileSync(
            payProgressPath, 'utf8'
        )
        t.ok(
            authProgress.includes('auth'),
            'auth progress names the feature'
        )
        t.ok(
            payProgress.includes('payments'),
            'payments progress names the feature'
        )
    } finally {
        process.chdir(originalCwd)
        cleanupWorktrees(projectDir)
        rmSync(projectDir, { recursive:true, force:true })
    }
})

// -- attempt learnings, end to end (runWavesIsolated) --

type NotesRecord = {
    time:number
    cwd:string
    token:string
    prompt:string
}

function toNotesRecord (value:unknown):NotesRecord {
    if (
        typeof value === 'object' && value !== null &&
        'time' in value && typeof value.time === 'number' &&
        'cwd' in value && typeof value.cwd === 'string' &&
        'token' in value && typeof value.token === 'string' &&
        'prompt' in value && typeof value.prompt === 'string'
    ) {
        return {
            time:value.time,
            cwd:value.cwd,
            token:value.token,
            prompt:value.prompt,
        }
    }
    throw new Error('malformed mock-agent-notes record')
}

// Every record the notes mock wrote, oldest first
function readNotesRecords (dir:string):NotesRecord[] {
    return readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => toNotesRecord(
            JSON.parse(readFileSync(join(dir, f), 'utf8'))
        ))
        .sort((a, b) => a.time - b.time)
}

// Records from agents that ran in one ticket's worktree, which is
// named `<repo>.<NN>-<slug>` after the ticket file
function recordsFor (
    records:NotesRecord[],
    filename:string
):NotesRecord[] {
    const suffix = '.' + filename.replace(/\.md$/, '')
    return records.filter(r => basename(r.cwd).endsWith(suffix))
}

function gitOut (cwd:string, args:string[]):string {
    return execFileSync('git', args, { cwd, encoding:'utf8' })
}

function restoreEnv (name:string, value:string|undefined):void {
    if (value === undefined) {
        Reflect.deleteProperty(process.env, name)
    } else {
        process.env[name] = value
    }
}

type RunIsolatedOpts = Parameters<typeof runWavesIsolated>[0]

type NotesRepo = {
    projectDir:string
    issuesDir:string
    recordDir:string
    learningsPath:string
    addTicket:(filename:string, blockers?:number[]) => void
    run:(
        tickets:Ticket[],
        overrides?:Partial<RunIsolatedOpts>
    ) => Promise<{ allDone:boolean }>
}

// A hermetic repo driven by the notes mock: MOCK_RECORD_DIR points
// at a fresh dir, and cwd, env and temp dirs are restored after.
// The test sets MOCK_MODE itself.
async function withNotesRepo (
    fn:(repo:NotesRepo) => Promise<void>
):Promise<void> {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    const originalCwd = process.cwd()
    const savedRecordDir = process.env.MOCK_RECORD_DIR
    const savedMode = process.env.MOCK_MODE
    let projectDir = ''
    try {
        projectDir = initTempGitRepo({ templateDir })
        const issuesDir = join(projectDir, 'issues')
        mkdirSync(issuesDir)
        const logsDir = join(projectDir, '.logs')
        process.env.MOCK_RECORD_DIR = recordDir
        process.chdir(projectDir)
        await fn({
            projectDir,
            issuesDir,
            recordDir,
            learningsPath:join(projectDir, 'learnings.md'),
            addTicket:(filename, blockers) => {
                writeFileSync(
                    join(issuesDir, filename),
                    makeTicketBody({
                        status:'ready-for-agent',
                        blockers,
                    })
                )
            },
            run:(tickets, overrides) => runWavesIsolated({
                tickets,
                specBody:'test spec',
                agentCmd:MOCK_NOTES,
                model:null,
                timeout:30,
                logsDir,
                featureName:'test-feature-learnings',
                conflictStrategy:'respawn',
                display:recordingDisplay().display,
                testCmd:'true',
                retries:0,
                retryDelay:0,
                ...overrides,
            }),
        })
    } finally {
        process.chdir(originalCwd)
        restoreEnv('MOCK_RECORD_DIR', savedRecordDir)
        restoreEnv('MOCK_MODE', savedMode)
        if (projectDir) removeWorktreesAndRepo(projectDir)
        rmSync(recordDir, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
}

// The base-branch commit right before the agent's work landed:
// the first parent of the oldest first-parent commit whose tree
// holds a file the notes mock committed
function commitBeforeAgentWork (dir:string):string {
    const commits = gitOut(dir, [
        'log', '--first-parent', '--reverse', '--format=%H', 'HEAD',
    ]).split('\n').filter(Boolean)
    const landed = commits.find(c => {
        return gitOut(dir, ['ls-tree', '--name-only', c])
            .split('\n')
            .some(f => f.startsWith('mock-agent-change-'))
    })
    if (!landed) throw new Error('the agent work never landed')
    return gitOut(dir, ['rev-parse', `${landed}^1`]).trim()
}

function learningsAt (dir:string, commit:string):string {
    try {
        return gitOut(dir, ['show', `${commit}:learnings.md`])
    } catch {
        return ''
    }
}

test('runWavesIsolated - AC5.1 AC5.2 AC7.1 AC7.2: a retry sees ' +
    'its first attempt\'s notes and the log is committed',
async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'fail-once'
        repo.addTicket('01-flaky.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')

        t.ok(
            !existsSync(join(
                repo.projectDir, '.git', 'info', 'exclude'
            )),
            'the repo has no template exclude file to lean on'
        )

        await repo.run(tickets, { retries:1 })

        const records = readNotesRecords(repo.recordDir)
        t.equal(records.length, 2, 'the agent ran twice')
        t.ok(
            !records[0].prompt.includes(records[1].token),
            'the first prompt does not carry later notes'
        )
        t.ok(
            records[1].prompt.includes(records[0].token),
            'the retry prompt carries the first attempt\'s notes'
        )

        const key = ticketKey(tickets[0].feature, tickets[0].num)
        const entries = readEntries(repo.learningsPath)
            .filter(e => e.key === key)
        t.deepEqual(
            entries.map(e => [e.attempt, e.outcome]),
            [[1, 'exit'], [2, 'done']],
            'one entry per attempt, in order, with its outcome'
        )
        t.equal(tickets[0].status, 'done', 'the retry finished it')

        const paths = gitOut(repo.projectDir, [
            'log', '--all', '--name-only', '--format=',
        ]).split('\n')
        t.ok(
            paths.some(p => p.startsWith('mock-agent-change-')),
            'the agent\'s `git add -A` commit is in the history'
        )
        t.deepEqual(
            paths.filter(p => p.startsWith('.nightralph/')),
            [],
            'no commit on any ref contains a .nightralph/ path'
        )

        t.ok(
            gitOut(repo.projectDir, ['ls-files', 'learnings.md'])
                .trim(),
            'learnings.md is tracked'
        )
        t.equal(
            gitOut(repo.projectDir, [
                'status', '--porcelain', '--', 'learnings.md',
            ]),
            '',
            'learnings.md has no uncommitted changes'
        )

        // The log is committed before the merge, not only by a
        // later progress commit, so the base tree is clean while
        // the branch merges
        const beforeMerge = commitBeforeAgentWork(repo.projectDir)
        const committed = parseEntries(
            learningsAt(repo.projectDir, beforeMerge)
        ).filter(e => e.key === key)
        t.equal(
            committed.length, 2,
            'both entries were committed before the branch merged'
        )
    })
})

test('runWavesIsolated - AC5.3: a downstream ticket\'s prompt ' +
    'carries its blocker\'s notes', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'pass'
        repo.addTicket('01-first.md')
        repo.addTicket('02-second.md', [1])
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')

        await repo.run(tickets)

        const records = readNotesRecords(repo.recordDir)
        const first = recordsFor(records, '01-first.md')
        const second = recordsFor(records, '02-second.md')
        t.equal(first.length, 1, 'ticket 1 ran once')
        t.equal(second.length, 1, 'ticket 2 ran once')
        t.ok(
            second[0]?.prompt.includes(first[0]?.token ?? '-'),
            'ticket 2\'s prompt carries ticket 1\'s notes'
        )
        t.ok(
            !first[0]?.prompt.includes(second[0]?.token ?? '-'),
            'ticket 1\'s prompt does not carry ticket 2\'s notes'
        )
    })
})

test('runWavesIsolated - AC5.4: a second run\'s first prompt ' +
    'carries notes from the first run', async t => {
    await withNotesRepo(async repo => {
        repo.addTicket('01-again.md')
        // Keeps the first run's logs from dirtying the base tree,
        // which would make the second run refuse to start
        writeFileSync(
            join(repo.projectDir, '.gitignore'), '.logs/\n'
        )
        commitAll(repo.projectDir, 'add tickets')

        process.env.MOCK_MODE = 'fail'
        await repo.run(scanTickets(repo.issuesDir))
        const firstRun = readNotesRecords(repo.recordDir)
        t.equal(firstRun.length, 1, 'the first run ran once')

        process.env.MOCK_MODE = 'pass'
        const tickets = scanTickets(repo.issuesDir)
        await repo.run(tickets)
        const secondRun = readNotesRecords(repo.recordDir)
            .slice(firstRun.length)

        t.equal(secondRun.length, 1, 'the second run ran once')
        t.ok(
            secondRun[0]?.prompt.includes(firstRun[0]?.token ?? '-'),
            'the second run\'s prompt carries the first run\'s notes'
        )
        t.equal(tickets[0].status, 'done', 'the second run finished')
    })
})

test('runWavesIsolated - AC6.1: notes written before a timeout ' +
    'kill reach a timed-out entry', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'hang'
        repo.addTicket('01-slow.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')

        await repo.run(tickets, { timeout:2 })

        const records = readNotesRecords(repo.recordDir)
        t.equal(
            records.length, 1,
            'the agent left its notes before the kill'
        )
        const key = ticketKey(tickets[0].feature, tickets[0].num)
        const entries = readEntries(repo.learningsPath)
            .filter(e => e.key === key)
        t.equal(entries.length, 1, 'one entry for the attempt')
        t.equal(entries[0]?.timedOut, true, 'marked timed out')
        t.ok(
            entries[0]?.body.includes(records[0]?.token ?? '-'),
            'the entry holds the notes written before the kill'
        )
    })
})

test('runWavesIsolated - AC6.2: a red test gate\'s entry has ' +
    'outcome tests and the test log tail', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'pass'
        repo.addTicket('01-red.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')
        const testToken = randomUUID()

        await repo.run(tickets, {
            testCmd:`echo ${testToken}; exit 1`,
        })

        const key = ticketKey(tickets[0].feature, tickets[0].num)
        const entries = readEntries(repo.learningsPath)
            .filter(e => e.key === key)
        t.deepEqual(
            entries.map(e => e.outcome), ['tests'],
            'one entry, with outcome tests'
        )
        t.ok(
            entries[0]?.body.includes(testToken),
            'the entry holds the tail of the test log'
        )
    })
})

test('runWavesIsolated - AC6.3: an unrecovered merge failure ' +
    'appends a merge entry', async t => {
    await withNotesRepo(async repo => {
        const repoName = basename(repo.projectDir)
        const fakeGit = installMergeFailingGit(
            `${repoName}--01-clash`
        )
        try {
            process.env.MOCK_MODE = 'pass'
            repo.addTicket('01-clash.md')
            const tickets = scanTickets(repo.issuesDir)
            commitAll(repo.projectDir, 'add tickets')

            await repo.run(tickets, { conflictStrategy:'stop' })

            const key = ticketKey(
                tickets[0].feature, tickets[0].num
            )
            const outcomes = readEntries(repo.learningsPath)
                .filter(e => e.key === key)
                .map(e => e.outcome)
            t.deepEqual(
                outcomes, ['done', 'merge'],
                'the attempt entry is followed by a merge entry'
            )
            t.equal(
                tickets[0].status, 'ready-for-agent',
                'the merge was not recovered'
            )
        } finally {
            fakeGit.restore()
        }
    })
})

test('runWavesIsolated - AC7.3: an unwritable learnings.md never ' +
    'fails the ticket or the progress commit', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'pass'
        repo.addTicket('01-steady.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')
        // An empty directory is invisible to `git status`, so the
        // dirty-tree check still passes
        mkdirSync(repo.learningsPath)

        await repo.run(tickets)

        t.equal(tickets[0].status, 'done', 'the ticket finished')
        t.equal(
            gitOut(repo.projectDir, [
                'status', '--porcelain', '--', 'progress.md',
            ]),
            '',
            'the final progress state is committed'
        )
        const progress = readProgress(
            join(repo.projectDir, 'progress.md')
        )
        t.deepEqual(
            progress?.tickets.map(p => [p.num, p.done]),
            [[tickets[0].num, true]],
            'progress.md records the ticket as done'
        )
    })
})

test('runWavesIsolated - AC6: an attempt that throws appends ' +
    'an error entry', async t => {
    await withNotesRepo(async repo => {
        repo.addTicket('01-vanish.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')

        await repo.run(tickets, { agentCmd:MOCK_DELETE_WORKTREE_01 })

        const key = ticketKey(tickets[0].feature, tickets[0].num)
        t.deepEqual(
            readEntries(repo.learningsPath)
                .filter(e => e.key === key)
                .map(e => [e.attempt, e.outcome]),
            [[1, 'error']],
            'one entry, with outcome error'
        )
        t.equal(
            tickets[0].status, 'ready-for-agent',
            'the ticket did not finish'
        )
    })
})

test('runWavesIsolated - AC6: a failed install appends an ' +
    'install entry with the install log tail', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'pass'
        repo.addTicket('01-deps.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')
        const installToken = randomUUID()

        await repo.run(tickets, {
            installCmd:`echo ${installToken}; exit 1`,
        })

        t.deepEqual(
            readNotesRecords(repo.recordDir), [],
            'the agent never ran'
        )
        const key = ticketKey(tickets[0].feature, tickets[0].num)
        const entries = readEntries(repo.learningsPath)
            .filter(e => e.key === key)
        t.deepEqual(
            entries.map(e => e.outcome), ['install'],
            'one entry, with outcome install'
        )
        t.ok(
            entries[0]?.body.includes('01-deps.install.log'),
            'the entry names the install log'
        )
        t.ok(
            entries[0]?.body.includes(installToken),
            'the entry holds the tail of the install log'
        )
    })
})

test('runWavesIsolated - AC6: an attempt with no commits ' +
    'appends a no-commits entry with its notes', async t => {
    await withNotesRepo(async repo => {
        process.env.MOCK_MODE = 'no-commit'
        repo.addTicket('01-idle.md')
        const tickets = scanTickets(repo.issuesDir)
        commitAll(repo.projectDir, 'add tickets')

        await repo.run(tickets)

        const records = readNotesRecords(repo.recordDir)
        t.equal(records.length, 1, 'the agent ran once')
        const key = ticketKey(tickets[0].feature, tickets[0].num)
        const entries = readEntries(repo.learningsPath)
            .filter(e => e.key === key)
        t.deepEqual(
            entries.map(e => e.outcome), ['no-commits'],
            'one entry, with outcome no-commits'
        )
        t.ok(
            entries[0]?.body.includes(records[0]?.token ?? '-'),
            'the entry holds the notes the agent left'
        )
    })
})

// A git repo on `main` with the scratch layout and its logs
// ignored, ready for CLI runs that use worktrees.
function cliGitRepo ():{
    projectDir:string
    issuesDir:string
    templateDir:string
} {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const projectDir = initTempGitRepo({ templateDir })
    execSync('git branch -M main', { cwd:projectDir })
    writeFileSync(
        join(projectDir, '.gitignore'), '.scratch/*/logs/\n'
    )
    const { issuesDir } = scratchDirs(projectDir)
    return { projectDir, issuesDir, templateDir }
}

// Blocked by ticket 01 of other-feat, a feature outside the run.
const BLOCKED_BODY = '# Test ticket\n\n**Status:** ready-for-agent\n' +
    '**Blocked by:** other-feat 01\n'

// cliGitRepo plus test-feat/01 (`ticket01Body`) and an unselected
// feature other-feat whose ticket 01 has `otherStatus`, committed.
function twoFeatureRepo (ticket01Body:string, otherStatus:string):{
    projectDir:string
    issuesDir:string
    templateDir:string
} {
    const repo = cliGitRepo()
    writeFileSync(join(repo.issuesDir, '01-first.md'), ticket01Body)
    const otherDir = join(repo.projectDir, '.scratch', 'other-feat')
    mkdirSync(join(otherDir, 'issues'), { recursive:true })
    writeFileSync(join(otherDir, 'spec.md'), '# Other spec')
    writeFileSync(
        join(otherDir, 'issues', '01-other.md'),
        makeTicketBody({ status:otherStatus })
    )
    commitAll(repo.projectDir, 'add tickets')
    return repo
}

function integrationBranches (projectDir:string):string {
    return gitOut(projectDir, [
        'branch', '--list', '--format=%(refname:short)',
        'nightralph--*',
    ]).trim()
}

test('CLI subprocess - AC3.1 nothing ready stops before any branch ' +
    'work', async t => {
    const { projectDir, issuesDir, templateDir } =
        twoFeatureRepo(BLOCKED_BODY, 'ready-for-agent')
    try {
        const { code, stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(stdout.includes('other-feat/01'), 'names the blocker')
        t.equal(integrationBranches(projectDir), '', 'no new branch')
        t.equal(headBranch(projectDir), 'main', 'still on main')
        t.ok(
            readFileSync(join(issuesDir, '01-first.md'), 'utf8')
                .includes('**Status:** ready-for-agent'),
            'the ticket is unchanged'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.2 nothing ready stops before provider ' +
    'preflight', async t => {
    const { projectDir, templateDir } =
        twoFeatureRepo(BLOCKED_BODY, 'ready-for-agent')
    try {
        const { code } = await spawnCli([
            'nightralph-no-such-provider', '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0 with an unknown provider')
        t.equal(integrationBranches(projectDir), '', 'no new branch')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.3 a dry run with nothing ready explains ' +
    'why', async t => {
    const { projectDir, templateDir } =
        twoFeatureRepo(BLOCKED_BODY, 'ready-for-agent')
    try {
        const { code, stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT, '--dry-run',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(stdout.includes('other-feat/01'), 'names the blocker')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.4 a resumed branch with nothing ready ' +
    'goes back to the launch branch', async t => {
    const { projectDir, issuesDir, templateDir } = twoFeatureRepo(
        makeTicketBody({ status:'ready-for-agent' }), 'ready-for-agent'
    )
    try {
        execSync('git checkout -q -b nightralph--test-feat', {
            cwd:projectDir,
        })
        writeFileSync(join(issuesDir, '01-first.md'), BLOCKED_BODY)
        commitAll(projectDir, 'block ticket 01')
        execSync('git checkout -q main', { cwd:projectDir })

        const { code, stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(headBranch(projectDir), 'main', 'back on main')
        t.equal(
            integrationBranches(projectDir), 'nightralph--test-feat',
            'the integration branch is kept'
        )
        t.ok(stdout.includes('other-feat/01'), 'names the blocker')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - a resumed run leaves the zero-ready check to ' +
    'the re-scan', async t => {
    const { projectDir, templateDir } =
        twoFeatureRepo(BLOCKED_BODY, 'ready-for-agent')
    try {
        execSync('git branch nightralph--test-feat', { cwd:projectDir })

        const { code, stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(headBranch(projectDir), 'main', 'back on main')
        t.ok(stdout.includes('Resumed'), 'the branch was resumed first')
        t.ok(stdout.includes('other-feat/01'), 'names the blocker')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.5 a resumed branch with no open tickets ' +
    'carries on', async t => {
    const { projectDir, issuesDir, templateDir } = twoFeatureRepo(
        makeTicketBody({ status:'ready-for-agent' }), 'ready-for-agent'
    )
    try {
        execSync('git checkout -q -b nightralph--test-feat', {
            cwd:projectDir,
        })
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'done' })
        )
        commitAll(projectDir, 'finish ticket 01')
        execSync('git checkout -q main', { cwd:projectDir })

        const { code } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(
            headBranch(projectDir), 'nightralph--test-feat',
            'the run stayed on the integration branch'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.6 a ready ticket runs as before', async t => {
    const { projectDir, templateDir } =
        twoFeatureRepo(BLOCKED_BODY, 'done')
    try {
        const { code } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT,
            '--retry-delay', '0', '--test-cmd', 'true', '--no-review',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(
            integrationBranches(projectDir), 'nightralph--test-feat',
            'the integration branch was created'
        )
        t.ok(
            gitOut(projectDir, [
                'show',
                'nightralph--test-feat:.scratch/test-feat/issues/' +
                    '01-first.md',
            ]).includes('**Status:** done'),
            'the ticket is done on the integration branch'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC1.4 a provider not on PATH fails before ' +
    'git state changes', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')

        const missing = 'nightralph-no-such-provider'
        const { code, stderr } = await spawnCli([
            missing, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 2, 'exit 2')
        t.ok(stderr.includes(missing), 'stderr names the provider')
        t.equal(
            gitOut(projectDir, ['branch', '--list', 'nightralph--*'])
                .trim(),
            '',
            'no integration branch created'
        )
        t.equal(
            gitOut(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
                .trim(),
            'main',
            'still on main'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC1.5 an absolute path to a provider runs',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir, logsDir } = scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-task.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const { code } = await spawnCli([
                MOCK_AGENT, '--spec', FEAT, '--timeout', '10',
            ], { cwd:projectDir })

            t.equal(code, 0, 'exit 0')
            t.ok(
                existsSync(join(logsDir, '01-task.log')),
                'agent ran and wrote its log'
            )
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - AC1.6 dry-run with a provider not on PATH',
    async t => {
        const projectDir = tmp()
        try {
            const { issuesDir } = scratchDirs(projectDir)
            writeFileSync(
                join(issuesDir, '01-task.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )

            const { code, stdout } = await spawnCli([
                'nightralph-no-such-provider',
                '--spec', FEAT,
                '--dry-run',
            ], { cwd:projectDir })

            t.equal(code, 0, 'exit 0')
            t.ok(stdout.includes('Provider:'), 'prints a Provider line')
            t.ok(stdout.includes('not found'), 'says it was not found')
        } finally {
            rmSync(projectDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - AC1.4 a path provider that is not ' +
    'executable fails with a clear reason', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir } = scratchDirs(projectDir)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const noexec = join(projectDir, 'noexec-agent.js')
        writeFileSync(noexec, '#!/bin/sh\nexit 0\n')
        chmodSync(noexec, 0o644)

        const { code, stderr } = await spawnCli([
            noexec, '--spec', FEAT,
        ], { cwd:projectDir })

        t.equal(code, 2, 'exit 2')
        t.ok(stderr.includes(noexec), 'stderr names the provider')
        t.ok(stderr.includes('not executable'), 'says not executable')
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - a relative provider path runs from the ' +
    'launch directory, not the worktree', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        // bin/ is ignored, so the agent exists in the launch
        // directory only and never in a worktree
        writeFileSync(
            join(projectDir, '.gitignore'),
            '.scratch/*/logs/\nbin/\n'
        )
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        mkdirSync(join(projectDir, 'bin'))
        const agent = join(projectDir, 'bin', 'agent.mjs')
        copyFileSync(MOCK_AGENT, agent)
        chmodSync(agent, 0o755)

        const { code } = await spawnCli([
            './bin/agent.mjs', ...NO_GATE_RUN_ARGS,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(
            gitOut(projectDir, ['log', '--format=%s'])
                .includes('mock agent change'),
            'the ticket was merged onto the integration branch'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.1 a run from main lands on the ' +
    'integration branch', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writeFileSync(
            join(issuesDir, '01-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const mainBefore = gitOut(projectDir, ['rev-parse', 'main'])

        const { code } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--timeout', '10',
            '--retry-delay', '0',
            '--test-cmd', 'true',
            '--no-review',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.equal(
            gitOut(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
                .trim(),
            `nightralph--${FEAT}`,
            'left on the integration branch'
        )
        t.equal(gitOut(projectDir, ['rev-parse', 'main']), mainBefore,
            'main did not move')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.2 a run from main resumes the ' +
    'integration branch without redoing done tickets', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    try {
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        writeFileSync(
            join(issuesDir, '02-second.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        execSync(`git checkout -b nightralph--${FEAT}`,
            { cwd:projectDir })
        writeFileSync(
            join(issuesDir, '01-first.md'),
            makeTicketBody({ status:'done' })
        )
        commitAll(projectDir, 'first is done')
        execSync('git checkout main', { cwd:projectDir })

        const { code } = await spawnCli([
            MOCK_NOTES,
            '--spec', FEAT,
            '--timeout', '10',
            '--retry-delay', '0',
            '--test-cmd', 'true',
            '--no-review',
        ], {
            cwd:projectDir,
            env:{
                ...process.env,
                MOCK_RECORD_DIR:recordDir,
                MOCK_MODE:'pass',
            },
        })

        t.equal(code, 0, 'exit 0')
        const records = readNotesRecords(recordDir)
        t.equal(records.length, 1, 'only one agent ran')
        t.ok(records[0].prompt.includes('02-second.md'),
            'it ran the ticket that was not done')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(recordDir, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
})

// Fast CLI run flags: no retries, no install, no review.
const NO_GATE_RUN_ARGS = [
    '--spec', FEAT,
    '--retries', '0',
    '--install-cmd', '',
    '--timeout', '30',
    '--no-review',
]

function writePackageJson (dir:string, body:string):void {
    writeFileSync(join(dir, 'package.json'), body + '\n')
}

const NO_TEST_SCRIPT = '{"name":"p","private":true}'
const FAILING_TEST_SCRIPT =
    '{"name":"p","private":true,"scripts":{"test":"exit 7"}}'

function logFiles (logsDir:string):string[] {
    return existsSync(logsDir) ? readdirSync(logsDir) : []
}

test('CLI subprocess - AC2.4 --test-cmd "" completes a ticket ' +
    'in a project with no test script', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writePackageJson(projectDir, NO_TEST_SCRIPT)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const logsDir = join(projectDir, '.scratch', FEAT, 'logs')

        const { code } = await spawnCli([
            MOCK_AGENT, ...NO_GATE_RUN_ARGS, '--test-cmd', '',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(
            gitOut(projectDir, ['log', '--oneline'])
                .includes('mock agent change'),
            'the ticket branch merged'
        )
        t.ok(
            !logFiles(logsDir).some(f => f.endsWith('.test.log')),
            'no test log was written'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.9 an isolated run repeats a typo ' +
    'warning in the finish summary', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writePackageJson(projectDir, NO_TEST_SCRIPT)
        writeFileSync(
            join(issuesDir, '01-done.md'),
            makeTicketBody({ status:'done' })
        )
        // The typo ref falls back to own ticket 01, which is done.
        writeFileSync(
            join(issuesDir, '02-typo.md'),
            '# Test ticket\n\n**Status:** ready-for-agent\n' +
            '**Blocked by:** nwsletter-audit 01\n'
        )
        commitAll(projectDir, 'add tickets')

        const { code, stdout, stderr } = await spawnCli([
            MOCK_AGENT, ...NO_GATE_RUN_ARGS, '--test-cmd', '',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(
            gitOut(projectDir, ['log', '--oneline'])
                .includes('mock agent change'),
            'the ticket ran in a worktree and merged'
        )
        t.ok(
            (stdout + stderr).includes('nwsletter-audit'),
            'the summary names the misspelt feature'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.5 no flag and no test script warns ' +
    'once and completes the ticket', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writePackageJson(projectDir, NO_TEST_SCRIPT)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')

        const { code, stdout } = await spawnCli([
            MOCK_AGENT, ...NO_GATE_RUN_ARGS,
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(
            gitOut(projectDir, ['log', '--oneline'])
                .includes('mock agent change'),
            'the ticket branch merged'
        )
        t.equal(
            stdout.split('No test command detected').length - 1,
            1,
            'the warning prints once'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.6 a test script with no flag still ' +
    'runs npm test as the gate', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writePackageJson(projectDir, FAILING_TEST_SCRIPT)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const logsDir = join(projectDir, '.scratch', FEAT, 'logs')

        const { code, stdout } = await spawnCli([
            MOCK_AGENT, ...NO_GATE_RUN_ARGS,
        ], { cwd:projectDir })

        t.ok(code !== 0, 'the failing gate fails the run')
        t.ok(
            !stdout.includes('No test command detected'),
            'no detection warning'
        )
        t.ok(
            existsSync(join(logsDir, '01-task.test.log')),
            'the gate wrote its log'
        )
        t.ok(
            !gitOut(projectDir, ['log', '--oneline'])
                .includes('mock agent change'),
            'the ticket did not merge'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.7 --dry-run prints Test command: ' +
    '(none) for an empty command', async t => {
    const plain = tmp()
    try {
        const { issuesDir } = scratchDirs(plain)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const { stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT, '--dry-run', '--test-cmd', '',
        ], { cwd:plain })
        t.ok(stdout.includes('Test command: (none)'),
            'in-place printer prints (none)')
    } finally {
        rmSync(plain, { recursive:true, force:true })
    }

    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const { stdout } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT, '--dry-run', '--test-cmd', '',
        ], { cwd:projectDir })
        t.ok(stdout.includes('Test command: (none)'),
            'isolated printer prints (none)')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC2.8 --test-cmd "" on a project with a ' +
    'failing test script runs no gate and no warning', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writePackageJson(projectDir, FAILING_TEST_SCRIPT)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const logsDir = join(projectDir, '.scratch', FEAT, 'logs')

        const { code, stdout } = await spawnCli([
            MOCK_AGENT, ...NO_GATE_RUN_ARGS, '--test-cmd', '',
        ], { cwd:projectDir })

        t.equal(code, 0, 'exit 0')
        t.ok(
            gitOut(projectDir, ['log', '--oneline'])
                .includes('mock agent change'),
            'the ticket branch merged'
        )
        t.ok(
            !logFiles(logsDir).some(f => f.endsWith('.test.log')),
            'no test log was written'
        )
        t.ok(
            !stdout.includes('No test command detected'),
            'no detection warning'
        )
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

const MOCK_REVIEW_AGENT = join(
    process.cwd(), 'test', 'mock-agent-review.js'
)

function headBranch (dir:string):string {
    return gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

function countReviewerRuns (recordDir:string):number {
    return readdirSync(recordDir).filter(f => {
        const rec = JSON.parse(
            readFileSync(join(recordDir, f), 'utf8')
        ) as { role:string }
        return rec.role === 'reviewer'
    }).length
}

test('CLI subprocess - a stale integration branch is reported and ' +
    'the launch branch is checked back out', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        writeFileSync(
            join(issuesDir, '01-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        // The branch forks before the tickets exist and has a commit
        // of its own, so it is neither current nor an ancestor of main
        execSync(`git checkout -q -b nightralph--${FEAT} HEAD~1`,
            { cwd:projectDir })
        writeFileSync(join(projectDir, 'other.txt'), 'x')
        commitAll(projectDir, 'unrelated work')
        execSync('git checkout -q main', { cwd:projectDir })

        const { code } = await spawnCli([
            MOCK_AGENT,
            '--spec', FEAT,
            '--timeout', '10',
            '--retry-delay', '0',
            '--test-cmd', 'true',
            '--no-review',
        ], { cwd:projectDir })

        t.equal(code, 2, 'exit 2')
        t.equal(headBranch(projectDir), 'main',
            'the launch branch is checked out again')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - a review runs once across a run and its ' +
    'resume', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    try {
        writeFileSync(
            join(issuesDir, '01-pass.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        const args = [
            MOCK_REVIEW_AGENT,
            '--spec', FEAT,
            '--timeout', '30',
            '--retry-delay', '0',
            '--test-cmd', 'true',
        ]
        const env = {
            ...process.env,
            MOCK_RECORD_DIR:recordDir,
            MOCK_REVIEW:'clean',
            MOCK_FIX:'pass',
            MOCK_TICKET:'pass',
        }

        const first = await spawnCli(args, { cwd:projectDir, env })
        t.equal(first.code, 0, 'first run exits 0')
        t.equal(headBranch(projectDir), `nightralph--${FEAT}`,
            'left on the integration branch')
        const entries = parseReviewEntries(gitOut(projectDir, [
            'show', `HEAD:.scratch/${FEAT}/review.md`,
        ]))
        t.deepEqual(entries.map(e => e.status), ['clean'],
            'one committed clean entry')
        t.equal(countReviewerRuns(recordDir), 1, 'reviewed once')

        execSync('git checkout -q main', { cwd:projectDir })
        const second = await spawnCli(args, { cwd:projectDir, env })
        t.equal(second.code, 0, 'second run exits 0')
        t.equal(countReviewerRuns(recordDir), 1,
            'a resume with nothing new does not review again')
        t.equal(gitOut(projectDir, ['status', '--porcelain']), '',
            'working tree is clean')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(recordDir, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - a dry run from main changes no branch',
    async t => {
        const { projectDir, issuesDir, templateDir } = cliGitRepo()
        try {
            writeFileSync(
                join(issuesDir, '01-pass.md'),
                makeTicketBody({ status:'ready-for-agent' })
            )
            commitAll(projectDir, 'add tickets')

            const { code } = await spawnCli([
                MOCK_AGENT,
                '--spec', FEAT,
                '--dry-run',
            ], { cwd:projectDir })

            t.equal(code, 0, 'exit 0')
            t.equal(headBranch(projectDir), 'main', 'still on main')
            t.equal(
                gitOut(projectDir, ['branch', '--list', 'nightralph--*'])
                    .trim(),
                '', 'no integration branch created'
            )
        } finally {
            removeWorktreesAndRepo(projectDir)
            rmSync(templateDir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - AC3.1 a dirty tree on a feature branch exits ' +
    '2 with one error line and no help or stack', async t => {
    const { projectDir, issuesDir, templateDir } = cliGitRepo()
    try {
        execFileSync(
            'git', ['checkout', '-b', 'feature'],
            { cwd:projectDir, env:GIT_ENV }
        )
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        commitAll(projectDir, 'add tickets')
        appendFileSync(
            join(projectDir, '.scratch', FEAT, 'spec.md'),
            '\nuncommitted edit\n'
        )

        const { code, stdout, stderr } = await spawnCli([
            MOCK_AGENT, '--spec', FEAT, '--no-review',
        ], { cwd:projectDir })

        t.equal(code, 2, 'exit 2')
        t.ok(
            stderr.includes('Working tree is dirty'),
            'stderr names the dirty tree'
        )
        t.ok(!stderr.includes('Options:'), 'no help text on stderr')
        t.ok(!stdout.includes('Options:'), 'no help text on stdout')
        t.ok(!hasStackLine(stderr), 'no stack frames on stderr')
    } finally {
        removeWorktreesAndRepo(projectDir)
        rmSync(templateDir, { recursive:true, force:true })
    }
})

test('CLI subprocess - AC3.2 a usage error prints help and exits 1',
    async t => {
        const dir = tmp()
        try {
            const { code, stderr } = await spawnCli([], { cwd:dir })

            t.equal(code, 1, 'exit 1')
            t.ok(stderr.includes('Options:'), 'help text on stderr')
        } finally {
            rmSync(dir, { recursive:true, force:true })
        }
    })

test('CLI subprocess - AC3.3 a closed feature prompt exits 2 with ' +
    'one line and no stack', async t => {
    const projectDir = tmp()
    try {
        const { issuesDir } = scratchDirs(projectDir)
        writeFileSync(
            join(issuesDir, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )
        const otherIssues = join(
            projectDir, '.scratch', 'other', 'issues'
        )
        mkdirSync(otherIssues, { recursive:true })
        writeFileSync(
            join(projectDir, '.scratch', 'other', 'spec.md'),
            '# Other spec'
        )
        writeFileSync(
            join(otherIssues, '01-task.md'),
            makeTicketBody({ status:'ready-for-agent' })
        )

        const { code, stdout, stderr } = await spawnCli([MOCK_AGENT], {
            cwd:projectDir,
            closeStdin:true,
        })

        t.equal(code, 2, 'exit 2')
        t.ok(stdout.trim().length > 0, 'the feature prompt was reached')
        t.equal(
            stderr.trim().split('\n').length, 1,
            'stderr is one line'
        )
        t.ok(!hasStackLine(stderr), 'no stack frames on stderr')
    } finally {
        rmSync(projectDir, { recursive:true, force:true })
    }
})
