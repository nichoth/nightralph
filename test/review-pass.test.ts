import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
    realpathSync, readdirSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import {
    runReviewer,
    runFixer,
    FIX_FAILURE_TEXT,
    FINDINGS_PATH,
    NO_FINDINGS,
    type ReviewDeps,
    type ReviewPassOpts,
    type SpawnAgentFn,
} from '../src/review.js'
import { localBranchExists } from '../src/worktree.js'

const GIT_ENV = {
    ...process.env,
    GIT_COMMITTER_NAME:'Test',
    GIT_COMMITTER_EMAIL:'test@example.com',
    GIT_AUTHOR_NAME:'Test',
    GIT_AUTHOR_EMAIL:'test@example.com',
}

function git (cwd:string, args:string[]):string {
    return execFileSync('git', args, {
        cwd, env:GIT_ENV, encoding:'utf8',
    }).trim()
}

// A hermetic repo on main with one code commit, plus cleanup of
// any sibling worktrees the review created.
function withRepo (
    fn:(repoRoot:string) => Promise<void>
):Promise<void> {
    const templateDir = mkdtempSync(join(tmpdir(), 'nightralph-tpl-'))
    const repoRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'nightralph-review-'))
    )
    execFileSync('git', ['init', `--template=${templateDir}`],
        { cwd:repoRoot, stdio:'ignore' })
    execSync('git config core.excludesFile /dev/null', { cwd:repoRoot })
    execSync('git config core.hooksPath /dev/null', { cwd:repoRoot })
    git(repoRoot, ['commit', '--allow-empty', '-m', 'init'])
    git(repoRoot, ['branch', '-M', 'main'])
    writeFileSync(join(repoRoot, 'a.ts'), 'export const a = 1\n')
    git(repoRoot, ['add', 'a.ts'])
    git(repoRoot, ['commit', '-m', 'code'])
    const cleanup = ():void => {
        for (const name of ['review', 'review-fix']) {
            rmSync(join(repoRoot, '..', `${basename(repoRoot)}.${name}`),
                { recursive:true, force:true })
        }
        rmSync(repoRoot, { recursive:true, force:true })
        rmSync(templateDir, { recursive:true, force:true })
    }
    return fn(repoRoot).finally(cleanup)
}

function passOpts (
    repoRoot:string,
    overrides?:Partial<ReviewPassOpts>
):ReviewPassOpts {
    const logsDir = join(repoRoot, '.scratch', 'feat', 'logs')
    mkdirSync(logsDir, { recursive:true })
    return {
        repoRoot,
        repoName:basename(repoRoot),
        baseBranch:'main',
        reviewPath:join(repoRoot, '.scratch', 'feat', 'review.md'),
        launchCommit:git(repoRoot, ['rev-parse', 'HEAD~1']),
        specBody:'SPEC',
        agentCmd:'node',
        model:null,
        timeout:30,
        logsDir,
        testCmd:'true',
        retries:0,
        retryDelay:0,
        log:() => {},
        ...overrides,
    }
}

// A fake agent: records each call's prompt and cwd, then runs
// `act` inside the worktree.
function fakeAgent (
    act:(cwd:string, call:number) => Partial<{
        exitCode:number
        timedOut:boolean
        completedItems:string[]
    }>|void
):{
    spawnAgent:SpawnAgentFn;
    calls:Array<{
        prompt:string; cwd:string
    }>
} {
    const calls:Array<{ prompt:string; cwd:string }> = []
    const spawnAgent:SpawnAgentFn = async opts => {
        const cwd = opts.cwd ?? process.cwd()
        calls.push({ prompt:opts.prompt, cwd })
        const r = act(cwd, calls.length) ?? {}
        return {
            exitCode:r.exitCode ?? 0,
            timedOut:r.timedOut ?? false,
            completedItems:r.completedItems ?? [],
        }
    }
    return { spawnAgent, calls }
}

function writeFindings (cwd:string, text:string):void {
    mkdirSync(join(cwd, '.nightralph'), { recursive:true })
    writeFileSync(join(cwd, FINDINGS_PATH), text)
}

function range (repoRoot:string):{ from:string; to:string } {
    return {
        from:git(repoRoot, ['rev-parse', 'HEAD~1']),
        to:git(repoRoot, ['rev-parse', 'HEAD']),
    }
}

test('runReviewer - AC5.1 returns findings and removes its ' +
    'worktree and branch', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            writeFindings(cwd, '- [ ] one\n    a.ts:1\n- [ ] two\n')
        })
        const deps:ReviewDeps = { spawnAgent:agent.spawnAgent }
        const opts = passOpts(repoRoot)
        const found = await runReviewer(opts, deps, range(repoRoot))

        t.deepEqual(found?.map(f => f.summary), ['one', 'two'],
            'parsed findings')
        t.ok(!existsSync(agent.calls[0].cwd), 'worktree removed')
        t.ok(!localBranchExists(repoRoot, `${opts.repoName}--review`),
            'branch deleted')
    })
})

test('runReviewer - AC5.2 a clean review returns []', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => writeFindings(cwd, NO_FINDINGS))
        const found = await runReviewer(
            passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
            range(repoRoot)
        )
        t.deepEqual(found, [], 'clean')
    })
})

test('runReviewer - AC5.3 findings written before a timeout count',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent(cwd => {
                writeFindings(cwd, '- [ ] slow one\n')
                return { exitCode:137, timedOut:true }
            })
            const found = await runReviewer(
                passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(found?.length, 1, 'kept')
        })
    })

test('runReviewer - AC5.4 no findings file is retried, then null',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent(() => {})
            const found = await runReviewer(
                passOpts(repoRoot, { retries:1 }),
                { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(agent.calls.length, 2, 'retried once')
            t.equal(found, null, 'failed review')
        })
    })

test('runReviewer - AC5.5 reviewer commits never reach main',
    async t => {
        await withRepo(async repoRoot => {
            const before = git(repoRoot, ['rev-parse', 'main'])
            const agent = fakeAgent(cwd => {
                writeFileSync(join(cwd, 'sneaky.ts'), 'x')
                git(cwd, ['add', 'sneaky.ts'])
                git(cwd, ['commit', '-m', 'sneaky'])
                writeFindings(cwd, NO_FINDINGS)
            })
            await runReviewer(
                passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
                range(repoRoot)
            )
            t.equal(git(repoRoot, ['rev-parse', 'main']), before,
                'main unchanged')
        })
    })

const FINDINGS = [
    { summary:'first thing', detail:'', checked:false },
    { summary:'second thing', detail:'', checked:false },
]

function commitIn (cwd:string, file:string):void {
    writeFileSync(join(cwd, file), String(Date.now()))
    git(cwd, ['add', file])
    git(cwd, ['commit', '-m', `add ${file}`])
}

test('runFixer - AC6.1 a green fix merges and checks echoed ' +
    'findings', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'fix.ts')
            return { completedItems:['first thing'] }
        })
        const result = await runFixer(
            passOpts(repoRoot), { spawnAgent:agent.spawnAgent },
            FINDINGS
        )
        t.ok(result.merged, 'merged')
        t.deepEqual(result.findings.map(f => f.checked),
            [true, false], 'only the echoed finding is checked')
        t.ok(existsSync(join(repoRoot, 'fix.ts')),
            'the fix is on main')
        t.ok(!existsSync(agent.calls[0].cwd), 'worktree removed')
    })
})

test('runFixer - an empty test command writes no fixer test log ' +
    'and merges', async t => {
    await withRepo(async repoRoot => {
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'fix.ts')
            return { completedItems:['first thing'] }
        })
        const opts = passOpts(repoRoot, { testCmd:'' })
        const result = await runFixer(
            opts, { spawnAgent:agent.spawnAgent }, FINDINGS
        )
        t.ok(result.merged, 'merged')
        t.ok(existsSync(join(repoRoot, 'fix.ts')),
            'the fix is on main')
        const testLogs = readdirSync(opts.logsDir).filter(
            f => /^review-fix.*\.test\.log$/.test(f)
        )
        t.equal(testLogs.length, 0, 'no fixer test log')
    })
})

test('runFixer - AC6.2 a red test gate is retried, then nothing ' +
    'merges', async t => {
    await withRepo(async repoRoot => {
        const before = git(repoRoot, ['rev-parse', 'main'])
        const agent = fakeAgent(cwd => {
            commitIn(cwd, 'broken.txt')
            return { completedItems:['first thing'] }
        })
        const result = await runFixer(
            passOpts(repoRoot, {
                retries:1, testCmd:'test ! -f broken.txt',
            }),
            { spawnAgent:agent.spawnAgent },
            FINDINGS
        )
        t.equal(agent.calls.length, 2, 'retried once')
        t.ok(!result.merged, 'not merged')
        t.ok(result.findings.every(f => !f.checked),
            'every finding unchecked')
        t.equal(git(repoRoot, ['rev-parse', 'main']), before,
            'main unchanged')
    })
})

test('runFixer - non-zero exit and no commits both fail',
    async t => {
        await withRepo(async repoRoot => {
            const exitAgent = fakeAgent(() => ({ exitCode:1 }))
            const exited = await runFixer(
                passOpts(repoRoot), { spawnAgent:exitAgent.spawnAgent },
                FINDINGS
            )
            t.ok(!exited.merged, 'exit 1 does not merge')
            t.equal(exited.result, FIX_FAILURE_TEXT.exit, 'exit reason')

            const idleAgent = fakeAgent(() => {})
            const idle = await runFixer(
                passOpts(repoRoot), { spawnAgent:idleAgent.spawnAgent },
                FINDINGS
            )
            t.ok(!idle.merged, 'no commits does not merge')
            t.equal(idle.result, FIX_FAILURE_TEXT['no-commits'],
                'no-commits reason')
        })
    })

test('runFixer - AC6.4 a retry sees the previous attempt\'s notes',
    async t => {
        await withRepo(async repoRoot => {
            const agent = fakeAgent((cwd, call) => {
                if (call === 1) {
                    mkdirSync(join(cwd, '.nightralph'),
                        { recursive:true })
                    writeFileSync(
                        join(cwd, '.nightralph', 'notes.md'),
                        'NOTES-TOKEN'
                    )
                    return { exitCode:1 }
                }
                commitIn(cwd, 'fix.ts')
            })
            await runFixer(
                passOpts(repoRoot, { retries:1 }),
                { spawnAgent:agent.spawnAgent },
                FINDINGS
            )
            t.ok(!agent.calls[0].prompt.includes('NOTES-TOKEN'),
                'first prompt has no notes')
            t.ok(agent.calls[1].prompt.includes('NOTES-TOKEN'),
                'retry prompt carries them')
        })
    })
