import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
    generateProgress,
    renderProgress,
    checkTicket,
    writeProgress,
    readProgress,
    mergeProgress,
    commitProgress,
    isSpecComplete,
} from '../src/progress.js'
import type { Ticket } from '../src/orchestrator.js'

// -- helpers --

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

function initTempRepo ():string {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-progress-test-')
    )
    execSync('git init', { cwd:dir })
    execSync('git config core.hooksPath /dev/null', { cwd:dir })
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

// -- generateProgress --

test(
    'generateProgress creates entries for all tickets, all marked not done',
    t => {
        const tickets = [
            makeTestTicket({ num:1, slug:'add-auth' }),
            makeTestTicket({ num:2, slug:'add-api' }),
            makeTestTicket({ num:3, slug:'add-tests' }),
        ]

        const data = generateProgress('my-feature', tickets)

        t.equal(
            data.feature,
            'my-feature',
            'should set feature name'
        )
        t.equal(
            data.tickets.length,
            3,
            'should have all tickets'
        )
        t.equal(
            data.tickets[0].num,
            1,
            'should preserve ticket number'
        )
        t.equal(
            data.tickets[0].done,
            false,
            'should mark all as not done'
        )
        t.equal(
            data.tickets[1].done,
            false,
            'all tickets should be not done'
        )
        t.equal(
            data.tickets[2].done,
            false,
            'all tickets should be not done'
        )
        t.equal(
            data.tickets[0].branch,
            null,
            'branch should be null'
        )
        t.equal(
            data.tickets[0].exitCode,
            null,
            'exitCode should be null'
        )
        t.equal(
            data.tickets[0].completedAt,
            null,
            'completedAt should be null'
        )
    }
)

// -- renderProgress --

test(
    'renderProgress produces valid markdown with unchecked boxes',
    t => {
        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
            makeTestTicket({ num:2, filename:'02-add-api.md' }),
        ]

        const data = generateProgress('test-feature', tickets)
        const markdown = renderProgress(data)

        t.ok(
            markdown.includes('# Progress: test-feature'),
            'should have feature title'
        )
        t.ok(
            markdown.includes('Started:'),
            'should have Started line'
        )
        t.ok(
            markdown.includes('- [ ] 01-add-auth.md'),
            'should have unchecked checkbox for ticket 1'
        )
        t.ok(
            markdown.includes('- [ ] 02-add-api.md'),
            'should have unchecked checkbox for ticket 2'
        )
        t.equal(
            markdown.includes('branch:'),
            false,
            'should not have metadata for unchecked items'
        )
    }
)

// -- checkTicket --

test(
    'checkTicket marks the right ticket done and fills metadata',
    t => {
        const tickets = [
            makeTestTicket({ num:1, slug:'add-auth' }),
            makeTestTicket({ num:2, slug:'add-api' }),
        ]

        const data = generateProgress('feature', tickets)
        const beforeCheck = data.tickets[0].done
        t.equal(beforeCheck, false, 'should start not done')

        checkTicket(data, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:0,
        })

        t.equal(
            data.tickets[0].done,
            true,
            'should mark done'
        )
        t.equal(
            data.tickets[0].branch,
            'nightralph/01-add-auth',
            'should set branch'
        )
        t.equal(
            data.tickets[0].exitCode,
            0,
            'should set exitCode'
        )
        t.ok(
            data.tickets[0].completedAt,
            'should set completedAt'
        )
        t.equal(
            data.tickets[1].done,
            false,
            'should not affect other tickets'
        )
    }
)

// -- renderProgress after checkTicket --

test(
    'renderProgress after checkTicket shows [x] with metadata lines',
    t => {
        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]

        const data = generateProgress('feature', tickets)
        checkTicket(data, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:0,
        })

        const markdown = renderProgress(data)

        t.ok(
            markdown.includes('- [x] 01-add-auth.md'),
            'should have checked checkbox'
        )
        t.ok(
            markdown.includes('branch: nightralph/01-add-auth'),
            'should have branch metadata'
        )
        t.ok(
            markdown.includes('exit: 0'),
            'should have exit code metadata'
        )
        t.ok(
            markdown.includes('completed:'),
            'should have completed timestamp'
        )
    }
)

// -- checkTicket for failures --

test(
    'checkTicket with done:false records exit code and keeps done as false',
    t => {
        const tickets = [
            makeTestTicket({ num:1, slug:'add-auth' }),
        ]

        const data = generateProgress('feature', tickets)

        checkTicket(data, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:1,
            done:false,
        })

        t.equal(
            data.tickets[0].done,
            false,
            'should keep done as false'
        )
        t.equal(
            data.tickets[0].exitCode,
            1,
            'should set exitCode'
        )
        t.equal(
            data.tickets[0].branch,
            'nightralph/01-add-auth',
            'should set branch'
        )
        t.equal(
            data.tickets[0].completedAt,
            undefined,
            'should not stamp completedAt for a failed ticket'
        )
    }
)

test(
    'renderProgress shows unchecked box with exit code for failed ticket',
    t => {
        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]

        const data = generateProgress('feature', tickets)
        checkTicket(data, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:1,
            done:false,
        })

        const markdown = renderProgress(data)

        t.ok(
            markdown.includes('- [ ] 01-add-auth.md'),
            'should have unchecked checkbox'
        )
        t.ok(
            markdown.includes('exit: 1'),
            'should have exit code metadata'
        )
    }
)

// -- checkTicket for unknown ticket --

test(
    'checkTicket for unknown ticket number is a no-op',
    t => {
        const tickets = [
            makeTestTicket({ num:1, slug:'add-auth' }),
        ]

        const data = generateProgress('feature', tickets)

        let error:unknown = null
        try {
            checkTicket(data, 999, {
                branch:'fake',
                exitCode:0,
            })
        } catch (e) {
            error = e
        }

        t.equal(
            error,
            null,
            'should not throw'
        )
        t.equal(
            data.tickets[0].done,
            false,
            'should not modify data'
        )
    }
)

// -- commitProgress --

test(
    'commitProgress creates a git commit containing the progress file',
    async t => {
        const repoRoot = initTempRepo()
        const progressPath = 'progress.md'
        const fullProgressPath = join(repoRoot, progressPath)

        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
            makeTestTicket({ num:2, filename:'02-add-api.md' }),
        ]

        const data = generateProgress('test-feature', tickets)
        writeProgress(fullProgressPath, data)

        await commitProgress(
            repoRoot,
            progressPath,
            'Track progress on test-feature'
        )

        // Verify commit was created
        const logOutput = execSync('git log --oneline', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            logOutput.includes('Track progress on test-feature'),
            'should create commit with message'
        )

        // Verify file is in the commit
        const showOutput = execSync(
            'git show HEAD:progress.md',
            { cwd:repoRoot }
        ).toString()
        t.ok(
            showOutput.includes('test-feature'),
            'should have progress file in commit'
        )
    }
)

test(
    'commitProgress does not include pre-staged files',
    async t => {
        const repoRoot = initTempRepo()
        const progressPath = 'progress.md'
        const fullProgressPath = join(repoRoot, progressPath)

        const otherFile = join(repoRoot, 'other.txt')
        writeFileSync(otherFile, 'staged content\n')
        execSync('git add other.txt', { cwd:repoRoot })

        const tickets = [
            makeTestTicket({
                num:1,
                filename:'01-add-auth.md',
            }),
        ]

        const data = generateProgress('iso-test', tickets)
        writeProgress(fullProgressPath, data)

        await commitProgress(
            repoRoot,
            progressPath,
            'progress only'
        )

        const filesInCommit = execSync(
            'git diff-tree --no-commit-id --name-only -r HEAD',
            { cwd:repoRoot }
        ).toString().trim()

        t.ok(
            filesInCommit.includes('progress.md'),
            'commit should contain progress file'
        )
        t.equal(
            filesInCommit.includes('other.txt'),
            false,
            'commit should NOT contain pre-staged file'
        )

        const stagedAfter = execSync(
            'git diff --cached --name-only',
            { cwd:repoRoot }
        ).toString().trim()
        t.ok(
            stagedAfter.includes('other.txt'),
            'pre-staged file should still be staged'
        )
    }
)

test(
    'commitProgress commits a progress file under a gitignored path',
    async t => {
        const repoRoot = initTempRepo()
        const progressDir = '.scratch'
        const progressPath = join(progressDir, 'progress.md')
        const fullProgressDir = join(repoRoot, progressDir)
        const fullProgressPath = join(repoRoot, progressPath)

        mkdirSync(fullProgressDir, { recursive:true })
        writeFileSync(
            join(repoRoot, '.gitignore'),
            '.scratch/\n'
        )
        execSync('git add .gitignore', { cwd:repoRoot })
        execSync(
            'git commit -m "add gitignore" --no-verify',
            {
                cwd:repoRoot,
                env:{
                    ...process.env,
                    GIT_COMMITTER_NAME:'Test',
                    GIT_COMMITTER_EMAIL:'test@example.com',
                    GIT_AUTHOR_NAME:'Test',
                    GIT_AUTHOR_EMAIL:'test@example.com',
                },
            }
        )

        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]

        const data = generateProgress('gitignored-feature', tickets)
        writeProgress(fullProgressPath, data)

        let error:unknown = null
        try {
            await commitProgress(
                repoRoot,
                progressPath,
                'Track progress on gitignored-feature'
            )
        } catch (e) {
            error = e
        }

        t.equal(
            error,
            null,
            'should not throw when progress path is gitignored'
        )

        const logOutput = execSync('git log --oneline', {
            cwd:repoRoot,
        }).toString()
        t.ok(
            logOutput.includes(
                'Track progress on gitignored-feature'
            ),
            'should create commit with message'
        )
    }
)

test(
    'commitProgress returns true when a commit was made',
    async t => {
        const repoRoot = initTempRepo()
        const progressPath = 'progress.md'
        const fullProgressPath = join(repoRoot, progressPath)

        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]

        const data = generateProgress('return-value-feature', tickets)
        writeProgress(fullProgressPath, data)

        const committed = await commitProgress(
            repoRoot,
            progressPath,
            'Track progress on return-value-feature'
        )

        t.equal(committed, true, 'should return true')
    }
)

test(
    'commitProgress returns false and does not commit when unchanged',
    async t => {
        const repoRoot = initTempRepo()
        const progressPath = 'progress.md'
        const fullProgressPath = join(repoRoot, progressPath)

        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]

        const data = generateProgress('unchanged-feature', tickets)
        writeProgress(fullProgressPath, data)

        const first = await commitProgress(
            repoRoot,
            progressPath,
            'Track progress on unchanged-feature'
        )
        t.equal(first, true, 'first call should commit')

        const countBefore = execSync('git rev-list --count HEAD', {
            cwd:repoRoot,
        }).toString().trim()

        let error:unknown = null
        let second:boolean|undefined
        try {
            second = await commitProgress(
                repoRoot,
                progressPath,
                'Track progress on unchanged-feature'
            )
        } catch (e) {
            error = e
        }

        t.equal(error, null, 'should not throw on unchanged file')
        t.equal(second, false, 'second call should return false')

        const countAfter = execSync('git rev-list --count HEAD', {
            cwd:repoRoot,
        }).toString().trim()
        t.equal(
            countAfter,
            countBefore,
            'should not create a new commit'
        )
    }
)

// -- readProgress --

test(
    'readProgress returns null when the file does not exist',
    t => {
        const dir = mkdtempSync(
            join(tmpdir(), 'nightralph-read-progress-test-')
        )
        const missingPath = join(dir, 'progress.md')

        t.equal(
            readProgress(missingPath),
            null,
            'should return null for a missing file'
        )
    }
)

test(
    'readProgress parses a previously written progress file',
    t => {
        const dir = mkdtempSync(
            join(tmpdir(), 'nightralph-read-progress-test-')
        )
        const progressPath = join(dir, 'progress.md')

        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
            makeTestTicket({ num:2, filename:'02-add-api.md' }),
        ]
        const data = generateProgress('my-feature', tickets)
        checkTicket(data, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:0,
        })
        writeProgress(progressPath, data)

        const parsed = readProgress(progressPath)

        t.ok(parsed !== null, 'should parse the file')
        t.equal(
            parsed?.feature,
            'my-feature',
            'should parse feature name'
        )
        t.equal(
            parsed?.tickets.length,
            2,
            'should parse both tickets'
        )
        t.equal(
            parsed?.tickets[0].filename,
            '01-add-auth.md',
            'should parse filename'
        )
        t.equal(
            parsed?.tickets[0].done,
            true,
            'should parse the done ticket as checked'
        )
        t.equal(
            parsed?.tickets[0].branch,
            'nightralph/01-add-auth',
            'should parse branch metadata'
        )
        t.equal(
            parsed?.tickets[0].exitCode,
            0,
            'should parse exitCode metadata'
        )
        t.equal(
            parsed?.tickets[1].done,
            false,
            'should parse the not-done ticket as unchecked'
        )
    }
)

// -- mergeProgress --

test(
    'mergeProgress carries forward completed tickets from a prior run',
    t => {
        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
            makeTestTicket({ num:2, filename:'02-add-api.md' }),
        ]

        const existing = generateProgress('my-feature', tickets)
        checkTicket(existing, 1, {
            branch:'nightralph/01-add-auth',
            exitCode:0,
        })

        const fresh = generateProgress('my-feature', tickets)
        const merged = mergeProgress(fresh, existing)

        t.equal(
            merged.tickets[0].done,
            true,
            'should carry forward the completed ticket'
        )
        t.equal(
            merged.tickets[0].branch,
            'nightralph/01-add-auth',
            'should carry forward branch metadata'
        )
        t.equal(
            merged.tickets[1].done,
            false,
            'should leave not-done tickets as fresh'
        )
    }
)

test(
    'mergeProgress leaves fresh data unchanged when no prior run exists',
    t => {
        const tickets = [
            makeTestTicket({ num:1, filename:'01-add-auth.md' }),
        ]
        const fresh = generateProgress('my-feature', tickets)

        const merged = mergeProgress(fresh, null)

        t.equal(
            merged,
            fresh,
            'should return the fresh data unchanged'
        )
    }
)

// -- isSpecComplete --

test('isSpecComplete - returns false when file missing',
    t => {
        t.equal(
            isSpecComplete('/nonexistent/progress.md'),
            false,
            'missing file is not complete'
        )
    })

test('isSpecComplete - returns false when tickets ' +
    'are incomplete', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-isc-')
    )
    const path = join(dir, 'progress.md')
    writeFileSync(path, [
        '# Progress: feat',
        '',
        'Started: 2026-01-01T00:00:00.000Z',
        '',
        '- [x] 01-done.md',
        '  branch: repo--01-done',
        '  exit: 0',
        '  completed: 2026-01-01T00:01:00.000Z',
        '- [ ] 02-todo.md',
    ].join('\n') + '\n')
    t.equal(
        isSpecComplete(path),
        false,
        'partial progress is not complete'
    )
})

test('isSpecComplete - returns true when all ' +
    'tickets checked', t => {
    const dir = mkdtempSync(
        join(tmpdir(), 'nightralph-isc-')
    )
    const path = join(dir, 'progress.md')
    writeFileSync(path, [
        '# Progress: feat',
        '',
        'Started: 2026-01-01T00:00:00.000Z',
        '',
        '- [x] 01-first.md',
        '  branch: repo--01-first',
        '  exit: 0',
        '  completed: 2026-01-01T00:01:00.000Z',
        '- [x] 02-second.md',
        '  branch: repo--02-second',
        '  exit: 0',
        '  completed: 2026-01-01T00:02:00.000Z',
    ].join('\n') + '\n')
    t.equal(
        isSpecComplete(path),
        true,
        'all checked off means complete'
    )
})
