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
        { encoding:'utf8' }
    )
    return stdout.trim()
}

export function getRepoName ():string {
    const commonDir = execFileSync(
        'git',
        ['rev-parse', '--git-common-dir'],
        { encoding:'utf8' }
    ).trim()
    return basename(dirname(resolve(commonDir)))
}

export function getCurrentBranch ():string {
    const stdout = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding:'utf8' }
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
            { cwd:repoRoot, stdio:'ignore' }
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
                cwd:repoRoot,
                encoding:'utf8',
                stdio:['ignore', 'pipe', 'ignore'],
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

async function branchExists (
    repoRoot:string,
    branchName:string
):Promise<boolean> {
    try {
        await execFileAsync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { cwd:repoRoot }
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

async function createWorktreeNow (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, baseBranch, ticket } = opts
    const branchName = buildBranchName(repoName, ticket)
    const num = String(ticket.num).padStart(2, '0')
    const prefix = ticket.feature ?
        `${ticket.feature}-` :
        ''
    const worktreePath = join(
        repoRoot,
        '..',
        `${repoName}.${prefix}${num}-${ticket.slug}`
    )

    if (existsSync(worktreePath)) {
        try {
            await execFileAsync(
                'git',
                ['worktree', 'remove', '--force', worktreePath],
                { cwd:repoRoot }
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
            { cwd:repoRoot }
        )
    } catch {
        // best-effort cleanup of stale worktree metadata
    }

    if (await branchExists(repoRoot, branchName)) {
        await execFileAsync(
            'git',
            ['branch', '-D', branchName],
            { cwd:repoRoot }
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
        { cwd:repoRoot }
    )

    return { worktreePath, branchName }
}

let worktreeQueue:Promise<unknown> = Promise.resolve()

export function createWorktree (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const result = worktreeQueue.then(() => createWorktreeNow(opts))
    worktreeQueue = result.catch(() => {})
    return result
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

export function removeWorktree (
    worktreePath:string,
    opts?:{ force?:boolean }
):Promise<void> {
    const result = worktreeQueue.then(
        () => removeWorktreeNow(worktreePath, opts)
    )
    worktreeQueue = result.catch(() => {})
    return result
}

export function hasNewCommits (
    repoRoot:string,
    base:string,
    branch:string
):boolean {
    const stdout = execFileSync(
        'git',
        ['rev-list', '--count', `${base}..${branch}`],
        { cwd:repoRoot, encoding:'utf8' }
    )
    return Number(stdout.trim()) > 0
}

export function isDirty (cwd:string):boolean {
    const stdout = execFileSync(
        'git',
        ['status', '--porcelain'],
        { cwd, encoding:'utf8' }
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
        { cwd:repoRoot }
    )
    return stdout
        .trim()
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => line.substring('worktree '.length))
}
