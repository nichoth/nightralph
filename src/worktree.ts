import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Ticket } from './orchestrator.js'

const execFileAsync = promisify(execFile)

export function getRepoRoot ():string {
    const stdout = execFileSync(
        'git',
        ['rev-parse', '--show-toplevel'],
        { encoding: 'utf8' }
    )
    return stdout.trim()
}

export function getRepoName ():string {
    const commonDir = execFileSync(
        'git',
        ['rev-parse', '--git-common-dir'],
        { encoding: 'utf8' }
    ).trim()
    return basename(dirname(resolve(commonDir)))
}

export function getCurrentBranch (cwd?:string):string {
    const stdout = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd, encoding: 'utf8' }
    )
    return stdout.trim()
}

export function localBranchExists (
    repoRoot:string,
    name:string
):boolean {
    try {
        execFileSync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${name}`],
            { cwd: repoRoot, stdio: 'ignore' }
        )
        return true
    } catch {
        return false
    }
}

// The repo's default branch: what origin/HEAD points at, else a
// local main or master, else null.
export function getDefaultBranch (repoRoot:string):string|null {
    try {
        const ref = execFileSync(
            'git',
            [
                'symbolic-ref', '--quiet', '--short',
                'refs/remotes/origin/HEAD',
            ],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }
        ).trim()
        if (ref) return ref.replace(/^origin\//, '')
    } catch {
        // no origin/HEAD
    }
    for (const name of ['main', 'master']) {
        if (localBranchExists(repoRoot, name)) return name
    }
    return null
}

// Uses `--` rather than `/` for the same reason as
// buildBranchName: refs/heads/X/Y cannot coexist with
// refs/heads/X.
export function integrationBranchName (
    features:ReadonlyArray<string>
):string {
    const distinct = [...new Set(features.filter(Boolean))]
    return distinct.length === 1 ?
        `nightralph--${distinct[0]}` :
        'nightralph--all'
}

// The integration branch to use, or null to merge into the
// current branch as before. Only a run launched from the default
// branch gets one.
export function planIntegrationBranch (
    current:string,
    defaultBranch:string|null,
    features:ReadonlyArray<string>
):string|null {
    if (!defaultBranch || current === 'HEAD') return null
    if (current !== defaultBranch) return null
    return integrationBranchName(features)
}

export type IntegrationPlan = {
    // where this run's work lands
    branch:string
    created:boolean
    resumed:boolean
    // commits on the launch branch that `branch` lacks
    behind:number
    // true when a resumed branch that was already contained in the
    // launch branch was moved up to it
    fastForwarded:boolean
    launchBranch:string
    // the default branch when `branch` is an integration branch,
    // else null; the review falls back to its merge-base
    forkedFrom:string|null
}

function gitText (cwd:string, args:string[]):string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// Enters the integration branch when the run was launched from
// the default branch, creating it or resuming it. Callers must
// scan tickets after this, since ticket statuses live on the
// branch it checks out.
export function prepareIntegrationBranch (
    repoRoot:string,
    features:ReadonlyArray<string>
):IntegrationPlan {
    const current = getCurrentBranch(repoRoot)
    const defaultBranch = getDefaultBranch(repoRoot)
    const name = planIntegrationBranch(
        current, defaultBranch, features
    )
    if (!name) {
        const onIntegration = defaultBranch !== null &&
            current === integrationBranchName(features)
        return {
            branch: current,
            created: false,
            resumed: false,
            behind: 0,
            fastForwarded: false,
            launchBranch: current,
            forkedFrom: onIntegration ? defaultBranch : null,
        }
    }
    if (isDirty(repoRoot)) {
        throw new Error(
            'Working tree is dirty; commit or stash ' +
            'changes before running'
        )
    }
    if (localBranchExists(repoRoot, name)) {
        // Merged into the launch branch already: nothing of its own
        // to lose, so bring it up to date
        const contained = isAncestor(repoRoot, name, current)
        gitText(repoRoot, ['checkout', '--quiet', name])
        let behind = Number(gitText(
            repoRoot, ['rev-list', '--count', `${name}..${current}`]
        ))
        const fastForwarded = contained && behind > 0
        if (fastForwarded) {
            gitText(repoRoot, ['merge', '--ff-only', '--quiet', current])
            behind = 0
        }
        return {
            branch: name,
            created: false,
            resumed: true,
            behind,
            fastForwarded,
            launchBranch: current,
            forkedFrom: defaultBranch,
        }
    }
    gitText(repoRoot, ['checkout', '--quiet', '-b', name])
    return {
        branch: name,
        created: true,
        resumed: false,
        behind: 0,
        fastForwarded: false,
        launchBranch: current,
        forkedFrom: defaultBranch,
    }
}

// What prepareIntegrationBranch would do, for --dry-run.
export function describeIntegrationBranch (
    repoRoot:string,
    features:ReadonlyArray<string>
):string {
    const current = getCurrentBranch(repoRoot)
    const name = planIntegrationBranch(
        current, getDefaultBranch(repoRoot), features
    )
    if (!name) return `Branch:       merges into ${current}`
    return localBranchExists(repoRoot, name) ?
        `Branch:       would resume ${name}` :
        `Branch:       would create ${name} from ${current}`
}

async function branchExists (
    repoRoot:string,
    branchName:string
):Promise<boolean> {
    try {
        await execFileAsync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { cwd: repoRoot }
        )
        return true
    } catch {
        return false
    }
}

export function buildBranchName (
    repoName:string,
    ticket:Ticket
):string {
    const num = String(ticket.num).padStart(2, '0')
    const prefix = ticket.feature ?
        `${ticket.feature}-` :
        ''
    return `${repoName}--${prefix}${num}-${ticket.slug}`
}

async function removeWorktreeNow (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    const args = [
        '-C', worktreePath,
        'worktree', 'remove',
    ]
    if (opts?.force) args.push('--force')
    args.push(worktreePath)
    await execFileAsync('git', args)
}

// Creates a worktree on a fresh branch, first clearing any stale
// worktree at the path and any leftover branch of the same name,
// so re-running after a failed run is safe.
async function addWorktreeNow (opts:{
    repoRoot:string
    baseBranch:string
    branchName:string
    worktreePath:string
}):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, baseBranch, branchName, worktreePath } = opts

    if (existsSync(worktreePath)) {
        try {
            await execFileAsync(
                'git',
                ['worktree', 'remove', '--force', worktreePath],
                { cwd: repoRoot }
            )
        } catch {
            // directory may not be a registered worktree anymore;
            // prune stale entries below and let worktree add fail
            // loudly if the path is still unusable
        }
    }

    try {
        await execFileAsync(
            'git',
            ['worktree', 'prune'],
            { cwd: repoRoot }
        )
    } catch {
        // best-effort cleanup of stale worktree metadata
    }

    if (await branchExists(repoRoot, branchName)) {
        await execFileAsync(
            'git',
            ['branch', '-D', branchName],
            { cwd: repoRoot }
        )
    }

    await execFileAsync(
        'git',
        [
            'worktree',
            'add',
            '-b',
            branchName,
            worktreePath,
            baseBranch,
        ],
        { cwd: repoRoot }
    )

    return { worktreePath, branchName }
}

let worktreeQueue:Promise<unknown> = Promise.resolve()

// Serializes every worktree and branch mutation module-wide, so
// concurrent calls cannot race on shared git refs or on
// .git/worktrees metadata.
function enqueue<T> (fn:() => Promise<T>):Promise<T> {
    const result = worktreeQueue.then(fn)
    worktreeQueue = result.catch(() => {})
    return result
}

export function createWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, ticket } = opts
    const num = String(ticket.num).padStart(2, '0')
    const prefix = ticket.feature ?
        `${ticket.feature}-` :
        ''
    return enqueue(() => addWorktreeNow({
        repoRoot,
        baseBranch: opts.baseBranch,
        branchName: buildBranchName(repoName, ticket),
        worktreePath: join(
            repoRoot,
            '..',
            `${repoName}.${prefix}${num}-${ticket.slug}`
        ),
    }))
}

// A worktree that belongs to no ticket, e.g. the review pass:
// `<repo>.<name>` on branch `<repo>--<name>`. Ticket branches
// always carry a number, so the names cannot collide.
export function createNamedWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        name:string
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, name } = opts
    return enqueue(() => addWorktreeNow({
        repoRoot,
        baseBranch: opts.baseBranch,
        branchName: `${repoName}--${name}`,
        worktreePath: join(repoRoot, '..', `${repoName}.${name}`),
    }))
}

export function removeWorktree (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    return enqueue(() => removeWorktreeNow(worktreePath, opts))
}

// Deletes a local branch; a missing branch is not an error.
export function deleteBranch (
    repoRoot:string,
    name:string
):Promise<void> {
    return enqueue(async () => {
        if (!(await branchExists(repoRoot, name))) return
        await execFileAsync(
            'git', ['branch', '-D', name], { cwd: repoRoot }
        )
    })
}

export function hasNewCommits (
    repoRoot:string,
    base:string,
    branch:string
):boolean {
    const stdout = execFileSync(
        'git',
        ['rev-list', '--count', `${base}..${branch}`],
        { cwd: repoRoot, encoding: 'utf8' }
    )
    return Number(stdout.trim()) > 0
}

export function headCommit (cwd:string):string {
    return gitText(cwd, ['rev-parse', 'HEAD'])
}

export function mergeBase (
    cwd:string,
    a:string,
    b:string
):string|null {
    try {
        return gitText(cwd, ['merge-base', a, b]) || null
    } catch {
        return null
    }
}

// False when `ancestor` is not an ancestor of `of`, or is not a
// commit this repo knows.
export function isAncestor (
    cwd:string,
    ancestor:string,
    of:string
):boolean {
    try {
        execFileSync(
            'git',
            ['merge-base', '--is-ancestor', ancestor, of],
            { cwd, stdio: 'ignore' }
        )
        return true
    } catch {
        return false
    }
}

// True when from..to changes any path outside `excludeDir`.
export function hasChangesOutside (
    cwd:string,
    from:string,
    to:string,
    excludeDir:string
):boolean {
    try {
        execFileSync(
            'git',
            [
                'diff', '--quiet', `${from}..${to}`,
                '--', '.', `:(exclude)${excludeDir}`,
            ],
            { cwd, stdio: 'ignore' }
        )
        return false
    } catch {
        return true
    }
}

export function isDirty (cwd:string):boolean {
    const stdout = execFileSync(
        'git',
        ['status', '--porcelain'],
        { cwd, encoding: 'utf8' }
    )
    return stdout.trim().length > 0
}

export async function commitDirty (
    cwd:string,
    message?:string
):Promise<boolean> {
    if (!isDirty(cwd)) return false
    await execFileAsync(
        'git',
        ['add', '-A'],
        { cwd }
    )
    try {
        await execFileAsync(
            'git',
            [
                'commit', '-m',
                message ??
                    'nightralph: auto-commit ' +
                    'remaining changes',
            ],
            { cwd }
        )
        return true
    } catch {
        return false
    }
}

export async function listWorktrees (
    repoRoot:string
):Promise<Array<string>> {
    const { stdout } = await execFileAsync(
        'git',
        ['worktree', 'list', '--porcelain'],
        { cwd: repoRoot }
    )
    return stdout
        .trim()
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => line.substring('worktree '.length))
}
