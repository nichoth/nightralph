import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync,
    writeFileSync,
    chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
    mergeBranch,
    rebaseBranch,
    mergeWave,
} from '../src/merge.js'

// -- helpers --

function initTempRepo ():string {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-merge-test-')
    )
    execSync('git init', { cwd:dir })
    execSync('git config core.hooksPath /dev/null', {
        cwd:dir,
    })
    execSync('git commit --allow-empty -m "init" --no-verify', {
        cwd:dir,
        env:{
            ...process.env,
            GIT_COMMITTER_NAME:'Test User',
            GIT_COMMITTER_EMAIL:'test@example.com',
            GIT_AUTHOR_NAME:'Test User',
            GIT_AUTHOR_EMAIL:'test@example.com',
        },
    })
    return dir
}

function initRepoWithFile (
    dir:string,
    filename:string,
    content:string
):void {
    writeFileSync(join(dir, filename), content)
    execSync('git add .', { cwd:dir })
    execSync('git commit -m "add ' + filename + '"', {
        cwd:dir,
        env:{
            ...process.env,
            GIT_COMMITTER_NAME:'Test User',
            GIT_COMMITTER_EMAIL:'test@example.com',
            GIT_AUTHOR_NAME:'Test User',
            GIT_AUTHOR_EMAIL:'test@example.com',
        },
    })
}

function createBranch (
    dir:string,
    branchName:string,
    filename:string,
    content:string
):void {
    execSync('git checkout -b ' + branchName, { cwd:dir })
    initRepoWithFile(dir, filename, content)
}

function getDefaultBranch (dir:string):string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', {
            cwd:dir,
        }).toString().trim()
    } catch {
        return 'main'
    }
}

// Installs a fake `git` on PATH that fails only
// `git merge <failBranch>`, passing every other
// command through to the real git binary. Used to
// simulate a merge failure that has nothing to do with
// content conflicts (e.g. a rebase that leaves the
// branch fast-forwardable still failing to merge).
function installMergeFailingGit (failBranch:string):{
    path:string
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
        path:binDir,
        restore:() => {
            process.env.PATH = originalPath
        },
    }
}

// -- test 1: mergeBranch merges a clean branch (no conflicts) --

test(
    'mergeBranch merges a clean branch (no conflicts)',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create a feature branch with a file
        createBranch(
            repoRoot,
            'feature-1',
            'feature1.txt',
            'feature 1 content'
        )

        // Go back to main/master and merge
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        const result = await mergeBranch(repoRoot, 'feature-1')

        t.equal(
            result.success,
            true,
            'mergeBranch should return success for clean merge'
        )

        // Verify file was merged
        const files = execSync('git ls-tree -r HEAD --name-only', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            files.includes('feature1.txt'),
            'should have merged file in HEAD'
        )
    }
)

// -- test 2: mergeBranch returns false and aborts on conflict --

test(
    'mergeBranch returns false and aborts on conflict',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create and commit a file on main/master
        initRepoWithFile(
            repoRoot,
            'conflict.txt',
            'main version\n'
        )

        // Create a branch that will be the merge source
        createBranch(
            repoRoot,
            'feature-2',
            'other.txt',
            'other content'
        )

        // Go back to main and modify conflict.txt
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'conflict.txt'),
            'updated main version\n'
        )
        execSync('git add conflict.txt', { cwd:repoRoot })
        execSync('git commit -m "update" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Go back to feature-2 and modify the conflict file
        execSync('git checkout feature-2', { cwd:repoRoot })
        writeFileSync(
            join(repoRoot, 'conflict.txt'),
            'feature version\n'
        )
        execSync('git add conflict.txt', { cwd:repoRoot })
        execSync('git commit -m "conflict" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Go back to main and try to merge
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        const result = await mergeBranch(repoRoot, 'feature-2')

        t.equal(
            result.success,
            false,
            'mergeBranch should return !success on conflict'
        )
        t.ok(
            result.stderr,
            'mergeBranch should include stderr on conflict'
        )

        // Verify git state is clean (merge aborted)
        const status = execSync('git status --porcelain', {
            cwd:repoRoot,
        }).toString()
        t.equal(
            status,
            '',
            'git should be clean after abort'
        )
    }
)

// -- test 3: rebaseBranch rebases a branch onto updated base --

test(
    'rebaseBranch rebases a branch onto updated base',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Add a file to base branch
        initRepoWithFile(repoRoot, 'base.txt', 'base content')

        // Create a feature branch
        createBranch(
            repoRoot,
            'feature-3',
            'feature3.txt',
            'feature content'
        )

        // Go back to base and add another commit
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        initRepoWithFile(repoRoot, 'base2.txt', 'more base')

        // Rebase feature-3 onto the updated base
        const result = await rebaseBranch(
            repoRoot,
            'feature-3',
            defaultBranch
        )

        t.equal(
            result.success,
            true,
            'rebaseBranch should return success on success'
        )

        // Verify HEAD is on base branch after success
        const currentBranch = execSync(
            'git rev-parse --abbrev-ref HEAD',
            { cwd:repoRoot }
        ).toString().trim()
        t.equal(
            currentBranch,
            defaultBranch,
            'HEAD should be on base branch after successful ' +
            'rebase'
        )

        // After rebase, base branch should have both base files
        const files = execSync('git ls-tree -r HEAD --name-only', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            files.includes('base.txt'),
            'base file should be in tree'
        )
        t.ok(
            files.includes('base2.txt'),
            'updated base file should be in tree'
        )

        // Verify feature branch was rebased successfully
        // by checking out the feature branch
        execSync('git checkout feature-3', { cwd:repoRoot })
        const featureFiles = execSync(
            'git ls-tree -r HEAD --name-only',
            { cwd:repoRoot }
        ).toString()
        t.ok(
            featureFiles.includes('feature3.txt'),
            'feature file should be in tree on feature branch ' +
            'after rebase'
        )
    }
)

// -- test 4: rebaseBranch returns false and aborts on conflict --

test(
    'rebaseBranch returns false and aborts on conflict',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create file on base branch
        initRepoWithFile(repoRoot, 'file.txt', 'base version\n')

        // Create feature branch with same file, different content
        createBranch(
            repoRoot,
            'feature-4',
            'file.txt',
            'feature version\n'
        )

        // Go back and modify the base file
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'file.txt'),
            'updated base version\n'
        )
        execSync('git add file.txt', { cwd:repoRoot })
        execSync('git commit -m "update file" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Try to rebase feature-4 onto base
        const result = await rebaseBranch(
            repoRoot,
            'feature-4',
            defaultBranch
        )

        t.equal(
            result.success,
            false,
            'rebaseBranch should return !success on conflict'
        )
        t.ok(
            result.stderr,
            'rebaseBranch should include stderr on conflict'
        )

        // Verify we're back on base branch
        const currentBranch = execSync(
            'git rev-parse --abbrev-ref HEAD',
            { cwd:repoRoot }
        ).toString().trim()
        t.equal(
            currentBranch,
            defaultBranch,
            'should be back on base branch after abort'
        )

        // Verify git state is clean
        const status = execSync('git status --porcelain', {
            cwd:repoRoot,
        }).toString()
        t.equal(
            status,
            '',
            'git should be clean after rebase abort'
        )
    }
)

// -- test 5: mergeWave merges multiple non-conflicting branches --

test(
    'mergeWave merges multiple non-conflicting branches sequentially',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create first feature branch
        createBranch(
            repoRoot,
            'feature-5a',
            'file-a.txt',
            'content A'
        )

        // Go back and create second feature branch
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        createBranch(
            repoRoot,
            'feature-5b',
            'file-b.txt',
            'content B'
        )

        // Go back to base
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        // Merge both branches
        const result = await mergeWave({
            repoRoot,
            baseBranch:defaultBranch,
            branches:[
                { branch:'feature-5a', ticketNum:1 },
                { branch:'feature-5b', ticketNum:2 },
            ],
            strategy:'stop',
        })

        t.equal(
            result.merged.length,
            2,
            'should merge both branches'
        )
        t.equal(
            result.merged[0].merged,
            true,
            'first branch should be merged'
        )
        t.equal(
            result.merged[1].merged,
            true,
            'second branch should be merged'
        )
        t.equal(
            result.stoppedAt,
            null,
            'should not stop (no conflicts)'
        )

        // Verify both files are in HEAD
        const files = execSync('git ls-tree -r HEAD --name-only', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            files.includes('file-a.txt'),
            'should have file-a.txt'
        )
        t.ok(
            files.includes('file-b.txt'),
            'should have file-b.txt'
        )
    }
)

// -- test 6: mergeWave with stop strategy stops at conflict --

test(
    'mergeWave with strategy:stop stops at first conflict ' +
    'and returns stoppedAt',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create and commit a file on main/master
        initRepoWithFile(repoRoot, 'shared.txt', 'base version')

        // Create first feature branch (merges cleanly)
        createBranch(
            repoRoot,
            'feature-6a',
            'file-a.txt',
            'content A'
        )

        // Go back to main and modify shared.txt for second branch
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'shared.txt'),
            'updated base version'
        )
        execSync('git add shared.txt', { cwd:repoRoot })
        execSync('git commit -m "update shared" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Create second feature from the original base,
        // which will conflict when merged
        execSync('git checkout HEAD~1', { cwd:repoRoot })
        execSync('git checkout -b feature-6b', { cwd:repoRoot })
        writeFileSync(
            join(repoRoot, 'shared.txt'),
            'conflicting version'
        )
        execSync('git add shared.txt', { cwd:repoRoot })
        execSync('git commit -m "modify shared" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Go back to base
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        // Merge with stop strategy
        const result = await mergeWave({
            repoRoot,
            baseBranch:defaultBranch,
            branches:[
                { branch:'feature-6a', ticketNum:1 },
                { branch:'feature-6b', ticketNum:2 },
            ],
            strategy:'stop',
        })

        t.equal(
            result.merged.length,
            2,
            'should return results for both'
        )
        t.equal(
            result.merged[0].merged,
            true,
            'first branch merged'
        )
        t.equal(
            result.merged[1].conflicted,
            true,
            'second branch conflicted'
        )
        t.ok(
            result.stoppedAt !== null,
            'stoppedAt should not be null'
        )
        t.equal(
            result.stoppedAt?.ticketNum,
            2,
            'stoppedAt should be ticket 2'
        )
    }
)

// -- test 6b: mergeWave with stop strategy stops when first
// branch conflicts --

test(
    'mergeWave with strategy:stop stops when first branch ' +
    'conflicts',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create and commit a file on main/master
        initRepoWithFile(repoRoot, 'shared.txt', 'base version')

        // Create first feature branch with same file, different
        // content (will conflict)
        createBranch(
            repoRoot,
            'feature-6b-a',
            'shared.txt',
            'feature version'
        )

        // Go back to main and modify shared.txt
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'shared.txt'),
            'updated base version'
        )
        execSync('git add shared.txt', { cwd:repoRoot })
        execSync('git commit -m "update shared" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Create second feature from the original base
        execSync('git checkout HEAD~2', { cwd:repoRoot })
        execSync('git checkout -b feature-6b-b', {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'other.txt'),
            'other content'
        )
        execSync('git add other.txt', { cwd:repoRoot })
        execSync('git commit -m "add other" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Go back to base
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        // Merge with stop strategy -- first branch should conflict
        const result = await mergeWave({
            repoRoot,
            baseBranch:defaultBranch,
            branches:[
                { branch:'feature-6b-a', ticketNum:1 },
                { branch:'feature-6b-b', ticketNum:2 },
            ],
            strategy:'stop',
        })

        t.equal(
            result.merged.length,
            1,
            'should only return first branch (stopped)'
        )
        t.equal(
            result.merged[0].conflicted,
            true,
            'first branch should be conflicted'
        )
        t.ok(
            result.stoppedAt !== null,
            'stoppedAt should not be null'
        )
        t.equal(
            result.stoppedAt?.ticketNum,
            1,
            'stoppedAt should be ticket 1'
        )
    }
)

// -- test 7: mergeWave with respawn strategy continues past conflict --

test(
    'mergeWave with strategy:respawn marks conflicted branch ' +
    'and continues',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        // Create and commit a file on main/master
        initRepoWithFile(repoRoot, 'shared.txt', 'base version')

        // Create first feature branch (merges cleanly)
        createBranch(
            repoRoot,
            'feature-7a',
            'file-a.txt',
            'content A'
        )

        // Go back to main and modify shared.txt for second branch
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        writeFileSync(
            join(repoRoot, 'shared.txt'),
            'updated base version'
        )
        execSync('git add shared.txt', { cwd:repoRoot })
        execSync('git commit -m "update shared" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Create second feature from the original base
        execSync('git checkout HEAD~2', { cwd:repoRoot })
        execSync('git checkout -b feature-7b', { cwd:repoRoot })
        writeFileSync(
            join(repoRoot, 'shared.txt'),
            'conflicting version'
        )
        execSync('git add shared.txt', { cwd:repoRoot })
        execSync('git commit -m "modify shared" --no-verify', {
            cwd:repoRoot,
            env:{
                ...process.env,
                GIT_COMMITTER_NAME:'Test User',
                GIT_COMMITTER_EMAIL:'test@example.com',
                GIT_AUTHOR_NAME:'Test User',
                GIT_AUTHOR_EMAIL:'test@example.com',
            },
        })

        // Go back to main and create third feature
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        createBranch(
            repoRoot,
            'feature-7c',
            'file-c.txt',
            'content C'
        )

        // Go back to base
        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        // Merge with respawn strategy
        const result = await mergeWave({
            repoRoot,
            baseBranch:defaultBranch,
            branches:[
                { branch:'feature-7a', ticketNum:1 },
                { branch:'feature-7b', ticketNum:2 },
                { branch:'feature-7c', ticketNum:3 },
            ],
            strategy:'respawn',
        })

        t.equal(
            result.merged.length,
            3,
            'should process all branches'
        )
        t.equal(
            result.merged[0].merged,
            true,
            'first branch merged'
        )
        t.equal(
            result.merged[1].conflicted,
            true,
            'second branch marked conflicted'
        )
        t.equal(
            result.merged[2].merged,
            true,
            'third branch still merged despite second conflict'
        )
        t.equal(
            result.stoppedAt,
            null,
            'stoppedAt should be null with respawn strategy'
        )
    }
)

// -- test 8: mergeWave sets conflicted:true when rebase
// succeeds but merge fails --

test(
    'mergeWave sets conflicted:true and merged:false when ' +
    'rebase succeeds but merge fails',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        createBranch(
            repoRoot,
            'feature-8a',
            'file-a.txt',
            'content A'
        )

        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        createBranch(
            repoRoot,
            'feature-8b',
            'file-b.txt',
            'content B'
        )

        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        const fakeGit = installMergeFailingGit('feature-8b')
        try {
            const result = await mergeWave({
                repoRoot,
                baseBranch:defaultBranch,
                branches:[
                    { branch:'feature-8a', ticketNum:1 },
                    { branch:'feature-8b', ticketNum:2 },
                ],
                strategy:'respawn',
            })

            t.equal(
                result.merged[0].merged,
                true,
                'first branch merged cleanly'
            )
            t.equal(
                result.merged[1].merged,
                false,
                'second branch merge should fail'
            )
            t.equal(
                result.merged[1].conflicted,
                true,
                'second branch should be marked conflicted ' +
                'even though rebase succeeded'
            )
        } finally {
            fakeGit.restore()
        }
    }
)

// -- test 9: mergeWave with strategy:stop sets stoppedAt
// when rebase succeeds but merge fails --

test(
    'mergeWave with strategy:stop sets stoppedAt when ' +
    'rebase succeeds but merge fails',
    async t => {
        const repoRoot = initTempRepo()
        const defaultBranch = getDefaultBranch(repoRoot)

        createBranch(
            repoRoot,
            'feature-9a',
            'file-a.txt',
            'content A'
        )

        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })
        createBranch(
            repoRoot,
            'feature-9b',
            'file-b.txt',
            'content B'
        )

        execSync('git checkout ' + defaultBranch, {
            cwd:repoRoot,
        })

        const fakeGit = installMergeFailingGit('feature-9b')
        try {
            const result = await mergeWave({
                repoRoot,
                baseBranch:defaultBranch,
                branches:[
                    { branch:'feature-9a', ticketNum:1 },
                    { branch:'feature-9b', ticketNum:2 },
                ],
                strategy:'stop',
            })

            t.ok(
                result.stoppedAt !== null,
                'stoppedAt should not be null'
            )
            t.equal(
                result.stoppedAt?.ticketNum,
                2,
                'stoppedAt should be ticket 2'
            )
            t.equal(
                result.stoppedAt?.conflicted,
                true,
                'stoppedAt result should be conflicted'
            )
        } finally {
            fakeGit.restore()
        }
    }
)
