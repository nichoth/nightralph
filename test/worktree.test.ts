import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync,
    existsSync,
    realpathSync,
    writeFileSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
    getRepoName,
    getCurrentBranch,
    createWorktree,
    removeWorktree,
    buildBranchName,
    listWorktrees,
    hasNewCommits,
    isDirty,
    commitDirty,
} from '../src/worktree.js'
import type { Ticket } from '../src/orchestrator.js'

// -- helpers --

function initTempRepo ():string {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-worktree-test-')
    )
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
    execSync('git commit --allow-empty -m "init" --no-verify', {
        cwd:dir,
        env:{
            ...process.env,
            GIT_COMMITTER_NAME:'Test',
            GIT_COMMITTER_EMAIL:'test@example.com',
            GIT_AUTHOR_NAME:'Test',
            GIT_AUTHOR_EMAIL:'test@example.com',
        },
    })
    return dir
}

function getDefaultBranch (repoRoot:string):string {
    const originalCwd = process.cwd()
    try {
        process.chdir(repoRoot)
        return getCurrentBranch()
    } finally {
        process.chdir(originalCwd)
    }
}

function makeTestTicket (overrides?:Partial<Ticket>):Ticket {
    return {
        num:1,
        slug:'test-feature',
        filename:'01-test-feature.md',
        filepath:'/fake/01-test-feature.md',
        body:'# Test ticket',
        status:'ready-for-agent',
        blockers:[],
        ...overrides,
    }
}

// -- getRepoName --

test('getRepoName returns the main repo basename', t => {
    const dir = initTempRepo()
    const originalCwd = process.cwd()
    try {
        process.chdir(dir)
        const name = getRepoName()
        t.equal(
            basename(dir),
            name,
            'should return main repo basename'
        )
    } finally {
        process.chdir(originalCwd)
    }
})

test(
    'getRepoName returns the main repo name from a ' +
    'linked worktree',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({
            num:99, slug:'name-check',
        })

        const { worktreePath } = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        const originalCwd = process.cwd()
        try {
            process.chdir(worktreePath)
            const name = getRepoName()
            t.equal(
                name,
                repoName,
                'should return main repo name, not ' +
                'worktree directory name'
            )
        } finally {
            process.chdir(originalCwd)
        }
    }
)

// -- getCurrentBranch --

test('getCurrentBranch returns the branch name', t => {
    const dir = initTempRepo()
    const originalCwd = process.cwd()
    try {
        process.chdir(dir)
        const branch = getCurrentBranch()
        t.ok(
            branch === 'master' || branch === 'main',
            `branch should be master or main, got ${branch}`
        )
    } finally {
        process.chdir(originalCwd)
    }
})

// -- createWorktree --

test(
    'createWorktree creates a worktree at the expected path',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:1, slug:'add-auth' })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        const worktreePath = join(
            repoRoot, '..',
            `${repoName}.01-add-auth`
        )
        t.equal(
            result.worktreePath,
            worktreePath,
            'worktree path should be in parent dir'
        )
        t.ok(
            existsSync(worktreePath),
            'worktree directory should exist'
        )
    }
)

test(
    'createWorktree creates with the expected branch name',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:2, slug:'add-logging' })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        const expectedBranch = `${repoName}--02-add-logging`
        t.equal(
            result.branchName,
            expectedBranch,
            'branch name should match pattern'
        )

        // Verify the branch exists
        const branches = execSync('git branch -a', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            branches.includes(expectedBranch),
            'branch should exist in repo'
        )
    }
)

test(
    'createWorktree branch is based on specified base branch',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const currentBranch = getDefaultBranch(repoRoot)

        // Create a secondary branch first
        execSync('git checkout -b develop', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })
        execSync('git commit --allow-empty -m "on develop" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })
        execSync(`git checkout ${currentBranch}`, {
            cwd:repoRoot,
        })

        const ticket = makeTestTicket({ num:3, slug:'test-branch' })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch:'develop',
            ticket,
        })

        // The worktree should exist and be on the develop branch
        const worktreeBranches = execSync(
            'git branch',
            { cwd:result.worktreePath }
        ).toString()
        t.ok(
            worktreeBranches.includes(
                `${repoName}--03-test-branch`
            ),
            'worktree should have the feature branch'
        )
    }
)

test(
    'createWorktree deletes a pre-existing branch from a prior ' +
    'failed run and succeeds',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:7, slug:'retry-branch' })
        const branchName = `${repoName}--07-retry-branch`

        // Simulate a leftover branch from a previous failed run,
        // with no worktree attached to it.
        execSync(`git branch ${branchName}`, { cwd:repoRoot })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        t.equal(
            result.branchName,
            branchName,
            'branch name should still match the expected pattern'
        )
        t.ok(
            existsSync(result.worktreePath),
            'worktree directory should exist after re-creation'
        )
    }
)

test(
    'createWorktree removes a stale worktree directory left over ' +
    'from a prior run at the same path',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:8, slug:'retry-worktree' })

        const first = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        // Simulate the ticket failing and re-running without ever
        // cleaning up the worktree or branch from the first attempt.
        const second = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        t.equal(
            second.worktreePath,
            first.worktreePath,
            'worktree path should be re-created at the same location'
        )
        t.ok(
            existsSync(second.worktreePath),
            'worktree directory should exist after re-creation'
        )
    }
)

test(
    'buildBranchName uses -- separator',
    t => {
        const ticket = makeTestTicket({
            num:1, slug:'clean-prefix',
        })
        const name = buildBranchName('myrepo', ticket)
        t.equal(
            name,
            'myrepo--01-clean-prefix',
            'uses -- separator'
        )
    }
)

test(
    'createWorktree succeeds when repoName matches ' +
    'an existing branch',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)

        execSync(
            `git branch ${repoName}`,
            { cwd:repoRoot }
        )

        const ticket = makeTestTicket({
            num:9, slug:'ref-conflict',
        })
        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        t.equal(
            result.branchName,
            `${repoName}--09-ref-conflict`,
            'uses flat separator to avoid conflict'
        )
        t.ok(
            existsSync(result.worktreePath),
            'worktree created successfully'
        )
    }
)

test(
    'createWorktree serializes 50 concurrent calls across 5 rounds ' +
    'of 10 without racing on shared git refs',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)

        for (let round = 0; round < 5; round++) {
            const tickets = Array.from({ length:10 }, (_, i) => {
                const num = round * 10 + i
                return makeTestTicket({
                    num,
                    slug:`concurrent-${num}`,
                })
            })

            const results = await Promise.all(tickets.map(ticket => (
                createWorktree({
                    repoRoot,
                    repoName,
                    baseBranch,
                    ticket,
                })
            )))

            for (const result of results) {
                t.ok(
                    existsSync(result.worktreePath),
                    `worktree ${result.worktreePath} should exist`
                )
            }
        }
    }
)

// -- removeWorktree --

test('removeWorktree removes the worktree', async t => {
    const repoRoot = initTempRepo()
    const repoName = basename(repoRoot)
    const baseBranch = getDefaultBranch(repoRoot)
    const ticket = makeTestTicket({ num:4, slug:'removable' })

    const result = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket,
    })

    const worktreePath = result.worktreePath
    t.ok(
        existsSync(worktreePath),
        'worktree should exist before removal'
    )

    await removeWorktree(worktreePath)

    t.equal(
        existsSync(worktreePath),
        false,
        'worktree should not exist after removal'
    )
})

// -- listWorktrees --

test('listWorktrees returns all worktree paths', async t => {
    const repoRoot = initTempRepo()
    const repoName = basename(repoRoot)
    const baseBranch = getDefaultBranch(repoRoot)

    const ticket1 = makeTestTicket({ num:5, slug:'first' })
    const ticket2 = makeTestTicket({ num:6, slug:'second' })

    const result1 = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket:ticket1,
    })

    const result2 = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket:ticket2,
    })

    const worktrees = await listWorktrees(repoRoot)
    const normalizedWorktrees = worktrees.map(w => {
        try {
            return realpathSync(w)
        } catch {
            return w
        }
    })
    const normalizedPath1 = realpathSync(result1.worktreePath)
    const normalizedPath2 = realpathSync(result2.worktreePath)

    t.ok(
        normalizedWorktrees.includes(normalizedPath1),
        'should include first worktree'
    )
    t.ok(
        normalizedWorktrees.includes(normalizedPath2),
        'should include second worktree'
    )
})

test(
    'removeWorktree with force removes a dirty worktree',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({
            num:7, slug:'force-dirty',
        })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        writeFileSync(
            join(result.worktreePath, 'untracked.txt'),
            'dirty content'
        )

        await removeWorktree(result.worktreePath, {
            force:true,
        })

        t.equal(
            existsSync(result.worktreePath),
            false,
            'dirty worktree removed with force'
        )
    }
)

test(
    'removeWorktree without force fails on a dirty worktree',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({
            num:8, slug:'no-force-dirty',
        })

        const result = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        writeFileSync(
            join(result.worktreePath, 'untracked.txt'),
            'dirty content'
        )

        try {
            await removeWorktree(result.worktreePath)
            t.fail('should have thrown for dirty worktree')
        } catch (error) {
            t.ok(
                error instanceof Error,
                'throws on dirty worktree without force'
            )
        }
    }
)

test(
    'concurrent create and remove do not race on ' +
    'git worktree metadata',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)

        const ticketA = makeTestTicket({
            num:20, slug:'race-a',
        })
        const ticketB = makeTestTicket({
            num:21, slug:'race-b',
        })

        const resultA = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket:ticketA,
        })

        t.ok(
            existsSync(resultA.worktreePath),
            'worktree A exists before concurrent ops'
        )

        const [, resultB] = await Promise.all([
            removeWorktree(resultA.worktreePath),
            createWorktree({
                repoRoot,
                repoName,
                baseBranch,
                ticket:ticketB,
            }),
        ])

        t.equal(
            existsSync(resultA.worktreePath),
            false,
            'worktree A removed'
        )
        t.ok(
            existsSync(resultB.worktreePath),
            'worktree B created'
        )
    }
)

// -- error paths --

test('removeWorktree throws for non-existent path', async t => {
    const nonExistentPath = '/nonexistent/path/to/worktree'

    try {
        await removeWorktree(nonExistentPath)
        t.fail('should have thrown an error')
    } catch (error) {
        t.ok(error instanceof Error, 'should throw an Error')
    }
})

// -- hasNewCommits --

test(
    'hasNewCommits is false when branch has no new commits',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:1, slug:'no-op' })

        const { branchName } = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        t.equal(
            hasNewCommits(repoRoot, baseBranch, branchName),
            false,
            'a freshly branched worktree has no new commits'
        )
    }
)

test(
    'hasNewCommits is true after a commit on the branch',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({ num:2, slug:'has-commit' })

        const { worktreePath, branchName } = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        writeFileSync(join(worktreePath, 'change.txt'), 'hi')
        execSync('git add change.txt', { cwd:worktreePath })
        execSync('git commit -m "change" --no-verify', {
            cwd:worktreePath,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        t.equal(
            hasNewCommits(repoRoot, baseBranch, branchName),
            true,
            'branch with a new commit is detected'
        )
    }
)

// -- isDirty --

test('isDirty is false for a clean worktree', async t => {
    const repoRoot = initTempRepo()
    const repoName = basename(repoRoot)
    const baseBranch = getDefaultBranch(repoRoot)
    const ticket = makeTestTicket({ num:3, slug:'clean' })

    const { worktreePath } = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket,
    })

    t.equal(
        isDirty(worktreePath),
        false,
        'a freshly created worktree is clean'
    )
})

test('isDirty is true when there are uncommitted changes', async t => {
    const repoRoot = initTempRepo()
    const repoName = basename(repoRoot)
    const baseBranch = getDefaultBranch(repoRoot)
    const ticket = makeTestTicket({ num:4, slug:'dirty' })

    const { worktreePath } = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket,
    })

    writeFileSync(join(worktreePath, 'untracked.txt'), 'oops')

    t.equal(
        isDirty(worktreePath),
        true,
        'an untracked file makes the worktree dirty'
    )
})

// -- commitDirty --

test('commitDirty commits dirty state and returns true',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({
            num:5, slug:'auto-commit',
        })

        const { worktreePath, branchName } =
            await createWorktree({
                repoRoot,
                repoName,
                baseBranch,
                ticket,
            })

        writeFileSync(
            join(worktreePath, 'new-file.txt'),
            'agent work'
        )

        const committed = await commitDirty(worktreePath)
        t.equal(committed, true, 'returns true when dirty')
        t.equal(
            isDirty(worktreePath),
            false,
            'worktree is clean after commitDirty'
        )
        t.equal(
            hasNewCommits(repoRoot, baseBranch, branchName),
            true,
            'branch has new commits after commitDirty'
        )
    })

test('commitDirty returns false on a clean worktree',
    async t => {
        const repoRoot = initTempRepo()
        const repoName = basename(repoRoot)
        const baseBranch = getDefaultBranch(repoRoot)
        const ticket = makeTestTicket({
            num:6, slug:'clean-commit',
        })

        const { worktreePath } = await createWorktree({
            repoRoot,
            repoName,
            baseBranch,
            ticket,
        })

        const committed = await commitDirty(worktreePath)
        t.equal(
            committed, false,
            'returns false when nothing to commit'
        )
    })

test('commitDirty uses custom message', async t => {
    const repoRoot = initTempRepo()
    const repoName = basename(repoRoot)
    const baseBranch = getDefaultBranch(repoRoot)
    const ticket = makeTestTicket({
        num:7, slug:'custom-msg',
    })

    const { worktreePath } = await createWorktree({
        repoRoot,
        repoName,
        baseBranch,
        ticket,
    })

    writeFileSync(
        join(worktreePath, 'work.txt'),
        'content'
    )

    await commitDirty(
        worktreePath,
        'nightralph: auto-commit test'
    )

    const log = execSync(
        'git log -1 --format=%s',
        { cwd:worktreePath, encoding:'utf8' }
    ).trim()
    t.equal(
        log,
        'nightralph: auto-commit test',
        'commit message matches'
    )
})
