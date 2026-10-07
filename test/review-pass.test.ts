import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
    realpathSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import {
    runReviewer,
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
