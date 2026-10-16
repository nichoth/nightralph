import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, readFileSync,
    readdirSync, existsSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import type { Display } from '../src/display.js'
import { runWavesIsolated, scanTickets } from '../src/orchestrator.js'
import { parseReviewEntries } from '../src/review.js'
import { subagentRule } from '../src/rules.js'
import { renderRunStats } from '../src/stats.js'

const MOCK = join(process.cwd(), 'test', 'mock-agent-review.js')
const FAKE_CLAUDE = join(process.cwd(), 'test', 'fake-claude', 'claude')
const FEAT = 'feat'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
}

function git (cwd:string, args:string[]):string {
    return execFileSync('git', args, {
        cwd, env: GIT_ENV, encoding: 'utf8',
    }).trim()
}

function quietDisplay ():Display {
    const noop = ():void => {}
    return {
        startRun: noop,
        startWave: noop,
        setTicketStatus: noop,
        setBlocked: noop,
        setTicketStats: noop,
        log: noop,
        cleanup: noop,
    }
}

type Roles = { reviewer:number; fixer:number; ticket:number }

function countRoles (recordDir:string):Roles {
    const counts:Roles = { reviewer: 0, fixer: 0, ticket: 0 }
    for (const f of readdirSync(recordDir)) {
        const { role } = JSON.parse(
            readFileSync(join(recordDir, f), 'utf8')
        ) as { role:keyof Roles }
        counts[role]++
    }
    return counts
}

// The prompts each role received, from the mock's records
function promptsByRole (recordDir:string):Record<keyof Roles, string[]> {
    const prompts:Record<keyof Roles, string[]> = {
        reviewer: [], fixer: [], ticket: [],
    }
    for (const f of readdirSync(recordDir)) {
        const { role, prompt } = JSON.parse(
            readFileSync(join(recordDir, f), 'utf8')
        ) as { role:keyof Roles; prompt:string }
        prompts[role].push(prompt)
    }
    return prompts
}

function hasEveryLine (text:string, lines:string[]):boolean {
    return lines.every(line => text.includes(line))
}

type RunOpts = Parameters<typeof runWavesIsolated>[0]

type Harness = {
    projectDir:string
    recordDir:string
    reviewPath:string
    run:(
        review?:boolean,
        display?:Display,
        forkedFrom?:string,
        // spread last, over the harness defaults
        extra?:Partial<RunOpts>
    ) => Promise<{
        allDone:boolean
        branch:string
    }>
}

const ENV_KEYS = [
    'MOCK_RECORD_DIR', 'MOCK_REVIEW', 'MOCK_FIX', 'MOCK_TICKET',
    'FAKE_CLAUDE_DELEGATE', 'FAKE_CLAUDE_ENV_LOG', 'FAKE_CLAUDE_STREAM',
    'FAKE_CLAUDE_PROMPT_DIR', 'FAKE_CLAUDE_HANG', 'FAKE_CLAUDE_FAIL_ONCE',
    'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

async function withHarness (
    env:Partial<Record<typeof ENV_KEYS[number], string>>,
    fn:(h:Harness) => Promise<void>
):Promise<void> {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'nightralph-ri-'))
    const recordDir = mkdtempSync(join(tmpdir(), 'nightralph-rec-'))
    const saved = Object.fromEntries(
        ENV_KEYS.map(k => [k, process.env[k]])
    )
    const originalCwd = process.cwd()
    try {
        execFileSync('git', ['init', `--template=${templateDir}`],
            { cwd: projectDir, stdio: 'ignore' })
        execSync('git config core.excludesFile /dev/null',
            { cwd: projectDir })
        execSync('git config core.hooksPath /dev/null',
            { cwd: projectDir })
        const base = join(projectDir, '.scratch', FEAT)
        const issuesDir = join(base, 'issues')
        mkdirSync(issuesDir, { recursive: true })
        writeFileSync(join(projectDir, '.gitignore'),
            '.scratch/*/logs/\n')
        writeFileSync(join(issuesDir, '01-only.md'),
            '# Ticket\n\n**Status:** ready-for-agent\n')
        git(projectDir, ['add', '-A'])
        git(projectDir, ['commit', '-m', 'init'])
        git(projectDir, ['branch', '-M', 'main'])

        // Start from a clean slate so values exported in the shell
        // cannot leak into the mocks
        for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k)
        process.env.MOCK_RECORD_DIR = recordDir
        for (const [k, v] of Object.entries(env)) process.env[k] = v
        process.chdir(projectDir)

        const reviewPath = join(base, 'review.md')
        await fn({
            projectDir,
            recordDir,
            reviewPath,
            run: (
                review = true,
                display = quietDisplay(),
                forkedFrom,
                extra = {}
            ) => {
                return runWavesIsolated({
                    tickets: scanTickets(issuesDir, FEAT),
                    specBody: 'SPEC',
                    specBodies: new Map([[FEAT, 'SPEC']]),
                    progressPaths: new Map([
                        [FEAT, join(base, 'progress.md')],
                    ]),
                    agentCmd: MOCK,
                    model: null,
                    timeout: 30,
                    logsDir: join(base, 'logs'),
                    featureName: FEAT,
                    conflictStrategy: 'respawn',
                    display,
                    testCmd: 'test ! -f broken.txt',
                    retries: 0,
                    retryDelay: 0,
                    review: review ? { reviewPath, forkedFrom } : undefined,
                    ...extra,
                })
            },
        })
    } finally {
        process.chdir(originalCwd)
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) {
                Reflect.deleteProperty(process.env, k)
            } else {
                process.env[k] = saved[k]
            }
        }
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(recordDir, { recursive: true, force: true })
        rmSync(templateDir, { recursive: true, force: true })
    }
}

function committedEntries (projectDir:string, reviewPath:string) {
    const rel = reviewPath.slice(projectDir.length + 1)
    return parseReviewEntries(
        git(projectDir, ['show', `HEAD:${rel}`])
    )
}

test('review pass - AC6.1 AC7.1 a fix merges and the log is ' +
    'committed', async t => {
    await withHarness({
        MOCK_REVIEW: 'findings', MOCK_FIX: 'pass', MOCK_TICKET: 'pass',
    }, async h => {
        const result = await h.run()
        t.ok(result.allDone, 'tickets done')
        t.equal(git(h.projectDir, ['status', '--porcelain']), '',
            'the run leaves a clean tree')
        t.equal(result.branch, 'main', 'AC2.4 reports the branch')
        t.deepEqual(countRoles(h.recordDir),
            { reviewer: 1, fixer: 1, ticket: 1 }, 'one of each')
        const entries = committedEntries(h.projectDir, h.reviewPath)
        t.equal(entries.length, 1, 'one committed entry')
        t.equal(entries[0].status, 'fixed', 'fixed')
        t.deepEqual(entries[0].findings.map(f => f.checked),
            [true, false], 'the echoed finding is checked')
        t.equal(entries[0].to, git(h.projectDir, ['rev-parse', 'HEAD~1']),
            'marker is the tip after the fix, before the log commit')
    })
})

test('review pass - prefer-subagent AC1.6 reaches the reviewer ' +
    'and the fixer', async t => {
    const logDir = mkdtempSync(join(tmpdir(), 'nightralph-envlog-'))
    const envLog = join(logDir, 'env.log')
    try {
        await withHarness({
            MOCK_REVIEW: 'findings',
            MOCK_FIX: 'pass',
            MOCK_TICKET: 'pass',
            FAKE_CLAUDE_DELEGATE: MOCK,
            FAKE_CLAUDE_ENV_LOG: envLog,
        }, async h => {
            const result = await h.run(true, quietDisplay(), undefined, {
                agentCmd: FAKE_CLAUDE,
                preferSubagent: 'haiku',
            })
            t.ok(result.allDone, 'tickets done')
            t.deepEqual(countRoles(h.recordDir),
                { reviewer: 1, fixer: 1, ticket: 1 }, 'one of each')
            const values = readFileSync(envLog, 'utf8')
                .split('\n')
                .filter(line => line !== '')
                .map(line => JSON.parse(line))
            t.deepEqual(values, ['haiku', 'haiku', 'haiku'],
                'the ticket, reviewer and fixer agents get the model')

            const rule = subagentRule('haiku')
            const readOnlyRule = subagentRule('haiku', true)
            const writeOnly = rule.filter(line => {
                return !readOnlyRule.includes(line)
            })
            const prompts = promptsByRole(h.recordDir)
            t.equal(writeOnly.length, 1,
                'one rule line is missing from the read-only variant')
            t.ok(prompts.reviewer.every(p => {
                return hasEveryLine(p, readOnlyRule)
            }), 'the reviewer prompt carries the read-only rule')
            t.ok(prompts.reviewer.every(p => {
                return writeOnly.every(line => !p.includes(line))
            }), 'the reviewer prompt omits the edit-and-commit line')
            t.ok(prompts.fixer.every(p => hasEveryLine(p, rule)),
                'the fixer prompt carries the full rule')
            t.ok(prompts.ticket.every(p => hasEveryLine(p, rule)),
                'the ticket prompt carries the full rule')
        })
    } finally {
        rmSync(logDir, { recursive: true, force: true })
    }
})

test('review pass - AC6.2 AC6.3 a red fix merges nothing but ' +
    'the marker advances', async t => {
    await withHarness({
        MOCK_REVIEW: 'findings', MOCK_FIX: 'break', MOCK_TICKET: 'pass',
    }, async h => {
        await h.run()
        t.ok(!existsSync(join(h.projectDir, 'broken.txt')),
            'the broken fix did not merge')
        const [entry] = committedEntries(h.projectDir, h.reviewPath)
        t.equal(entry.status, 'unresolved', 'unresolved')
        t.ok(entry.findings.every(f => !f.checked), 'all unchecked')

        await h.run()
        t.equal(countRoles(h.recordDir).reviewer, 1,
            'a second run does not review the same range')
    })
})

test('review pass - AC4.4 bookkeeping-only changes skip the ' +
    'review', async t => {
    await withHarness({
        MOCK_REVIEW: 'findings', MOCK_FIX: 'pass', MOCK_TICKET: 'fail',
    }, async h => {
        await h.run()
        t.equal(countRoles(h.recordDir).reviewer, 0, 'no reviewer')
        t.ok(!existsSync(h.reviewPath), 'no review log')
    })
})

test('review pass - a clean review, then nothing new to review',
    async t => {
        await withHarness({
            MOCK_REVIEW: 'clean', MOCK_FIX: 'pass', MOCK_TICKET: 'pass',
        }, async h => {
            await h.run()
            const counts = countRoles(h.recordDir)
            t.equal(counts.reviewer, 1, 'reviewed once')
            t.equal(counts.fixer, 0, 'AC5.2 no fixer')
            t.equal(
                committedEntries(h.projectDir, h.reviewPath)[0].status,
                'clean', 'clean entry'
            )
            await h.run()
            t.equal(countRoles(h.recordDir).reviewer, 1,
                'the review log commit does not trigger a review')
        })
    })

test('review pass - AC7.2 a broken review does not change the ' +
    'result', async t => {
    await withHarness({
        MOCK_REVIEW: 'clean', MOCK_FIX: 'pass', MOCK_TICKET: 'pass',
    }, async h => {
        // A directory where the log file should be: appending throws
        mkdirSync(h.reviewPath, { recursive: true })
        writeFileSync(join(h.reviewPath, 'keep'), '')
        git(h.projectDir, ['add', '-A'])
        git(h.projectDir, ['commit', '-m', 'block the log'])
        const logs:string[] = []
        const display = {
            ...quietDisplay(),
            log: (msg:string) => { logs.push(msg) },
        }
        const result = await h.run(true, display)
        t.ok(result.allDone, 'still all done')
        t.ok(logs.some(m => m.includes('EISDIR')),
            'the review failure was logged')
    })
})

test('review pass - AC7.3 no review option, no reviewer',
    async t => {
        await withHarness({
            MOCK_REVIEW: 'findings',
            MOCK_FIX: 'pass',
            MOCK_TICKET: 'pass',
        }, async h => {
            await h.run(false)
            t.equal(countRoles(h.recordDir).reviewer, 0, 'no reviewer')
        })
    })

test('review pass - a reviewer that writes no findings file is ' +
    'review-failed and is retried next run', async t => {
    await withHarness({
        MOCK_REVIEW: 'none', MOCK_FIX: 'pass', MOCK_TICKET: 'pass',
    }, async h => {
        // As on an integration branch: the fork point is the floor
        git(h.projectDir, ['checkout', '-b', 'nightralph--feat'])
        await h.run(true, undefined, 'main')
        const counts = countRoles(h.recordDir)
        t.equal(counts.reviewer, 1, 'reviewed once')
        t.equal(counts.fixer, 0, 'no fixer')
        const entries = committedEntries(h.projectDir, h.reviewPath)
        t.equal(entries.length, 1, 'one entry')
        t.equal(entries[0].status, 'review-failed', 'review-failed')

        await h.run(true, undefined, 'main')
        t.equal(countRoles(h.recordDir).reviewer, 2,
            'the unreviewed range is reviewed again')
    })
})

test('review pass - prefer-subagent AC6.4 the stats tally counts ' +
    'the reviewer and the fixer', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nightralph-stream-'))
    const streamFile = join(dataDir, 'stream.jsonl')
    writeFileSync(streamFile, [
        {
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {},
                }],
            },
        },
        {
            type: 'result',
            subtype: 'success',
            total_cost_usd: 0.25,
            subagent_stats: { spawned: 1 },
        },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    try {
        await withHarness({
            MOCK_REVIEW: 'findings',
            MOCK_FIX: 'pass',
            MOCK_TICKET: 'pass',
            FAKE_CLAUDE_DELEGATE: MOCK,
            FAKE_CLAUDE_STREAM: streamFile,
        }, async h => {
            const logs:string[] = []
            const display = {
                ...quietDisplay(),
                log: (m:string) => { logs.push(m) },
            }
            const result = await h.run(true, display, undefined, {
                agentCmd: FAKE_CLAUDE,
            })
            t.ok(result.allDone, 'tickets done')
            t.deepEqual(countRoles(h.recordDir),
                { reviewer: 1, fixer: 1, ticket: 1 }, 'one of each')
            const expected = renderRunStats({
                agentRuns: 3, withCost: 3, subagents: 3, costUsd: 0.75,
            })
            t.ok(expected !== null, 'a stats line is expected')
            t.ok(logs.includes(expected as string),
                'the ticket, reviewer and fixer are tallied')
        })
    } finally {
        rmSync(dataDir, { recursive: true, force: true })
    }
})
