import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
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
    return basename(getRepoRoot())
}

export function getCurrentBranch ():string {
    const stdout = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding:'utf8' }
    )
    return stdout.trim()
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

async function createWorktreeNow (
    opts:{
        repoRoot:string
        repoName:string
        baseBranch:string
        ticket:Ticket
    }
):Promise<{ worktreePath:string; branchName:string }> {
    const { repoRoot, repoName, baseBranch, ticket } = opts
    const branchName = `${repoName}/${String(
        ticket.num
    ).padStart(2, '0')}-${ticket.slug}`
    const worktreePath = join(
        repoRoot,
        '..',
        `${repoName}.${String(
            ticket.num
        ).padStart(2, '0')}-${ticket.slug}`
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

export async function removeWorktree (
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
