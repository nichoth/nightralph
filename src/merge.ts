import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type MergeConflictStrategy = 'respawn'|'stop'

export type MergeResult = {
    branch:string
    ticketNum:number
    merged:boolean
    conflicted:boolean
    stderr?:string
}

export type WaveMergeResult = {
    merged:Array<MergeResult>
    stoppedAt:MergeResult|null
}

export type GitOpResult = {
    success:boolean
    stderr?:string
}

export async function mergeBranch (
    repoRoot:string,
    branch:string
):Promise<GitOpResult> {
    if (!repoRoot || typeof repoRoot !== 'string') {
        throw new Error('repoRoot must be a non-empty string')
    }
    if (!branch || typeof branch !== 'string') {
        throw new Error('branch must be a non-empty string')
    }

    try {
        await execFileAsync(
            'git',
            ['merge', branch, '--no-edit'],
            { cwd: repoRoot }
        )
        return { success: true }
    } catch (err) {
        const execErr = err as {
            stdout?:string; stderr?:string
        }
        const stderr =
            execErr.stderr || execErr.stdout
        try {
            await execFileAsync(
                'git',
                ['merge', '--abort'],
                { cwd: repoRoot }
            )
        } catch {
            // no merge in progress to abort
        }
        return { success: false, stderr }
    }
}

export async function rebaseBranch (
    repoRoot:string,
    branch:string,
    onto:string,
    worktreePath?:string
):Promise<GitOpResult> {
    if (!repoRoot || typeof repoRoot !== 'string') {
        throw new Error('repoRoot must be a non-empty string')
    }
    if (!branch || typeof branch !== 'string') {
        throw new Error('branch must be a non-empty string')
    }
    if (!onto || typeof onto !== 'string') {
        throw new Error('onto must be a non-empty string')
    }

    // When the branch has its own worktree, it is already checked
    // out there -- checking it out in repoRoot too would fail with
    // "already used by worktree", so rebase in place instead.
    if (worktreePath) {
        try {
            await execFileAsync(
                'git',
                ['rebase', onto],
                { cwd: worktreePath }
            )
            return { success: true }
        } catch (err) {
            const execErr = err as {
                stdout?:string; stderr?:string
            }
            const stderr =
                execErr.stderr || execErr.stdout
            try {
                await execFileAsync(
                    'git',
                    ['rebase', '--abort'],
                    { cwd: worktreePath }
                )
            } catch {
                // ignore abort errors
            }
            return { success: false, stderr }
        }
    }

    try {
        await execFileAsync(
            'git',
            ['checkout', branch],
            { cwd: repoRoot }
        )

        await execFileAsync(
            'git',
            ['rebase', onto],
            { cwd: repoRoot }
        )

        await execFileAsync(
            'git',
            ['checkout', onto],
            { cwd: repoRoot }
        )

        return { success: true }
    } catch (err) {
        const stderr =
            (err as { stderr?:string }).stderr
        try {
            await execFileAsync(
                'git',
                ['rebase', '--abort'],
                { cwd: repoRoot }
            )
        } catch {
            // ignore abort errors
        }
        try {
            await execFileAsync(
                'git',
                ['checkout', onto],
                { cwd: repoRoot }
            )
        } catch {
            // ignore checkout errors
        }
        return { success: false, stderr }
    }
}

// Merges baseBranch into the worktree's branch so a
// respawned agent sees the latest code. Conflicts are
// left in place (not aborted) so the agent can resolve
// and commit them.
export async function updateWorktreeFromBase (
    worktreePath:string,
    baseBranch:string
):Promise<void> {
    try {
        await execFileAsync(
            'git',
            ['merge', baseBranch, '--no-edit'],
            { cwd: worktreePath }
        )
    } catch {
        // conflict markers intentionally left for the
        // respawned agent to resolve
    }
}

export async function mergeWave (
    opts:Readonly<{
        repoRoot:string
        baseBranch:string
        branches:ReadonlyArray<{
            branch:string
            ticketNum:number
            worktreePath?:string
        }>
        strategy:MergeConflictStrategy
    }>
):Promise<WaveMergeResult> {
    const { repoRoot, baseBranch, branches, strategy } = opts

    if (!repoRoot || typeof repoRoot !== 'string') {
        throw new Error('repoRoot must be a non-empty string')
    }
    if (!baseBranch || typeof baseBranch !== 'string') {
        throw new Error('baseBranch must be a non-empty string')
    }

    const merged:Array<MergeResult> = []
    let stoppedAt:MergeResult|null = null

    for (let i = 0; i < branches.length; i++) {
        const { branch, ticketNum, worktreePath } = branches[i]
        const mergingResult:MergeResult = {
            branch,
            ticketNum,
            merged: false,
            conflicted: false,
        }

        if (i === 0) {
            const result = await mergeBranch(
                repoRoot,
                branch
            )
            mergingResult.merged = result.success
            mergingResult.conflicted = !result.success
            if (!result.success) {
                mergingResult.stderr = result.stderr
            }

            if (!result.success) {
                if (strategy === 'stop') {
                    stoppedAt = mergingResult
                    merged.push(mergingResult)
                    break
                }
                merged.push(mergingResult)
                continue
            }
        } else {
            const rebaseResult = await rebaseBranch(
                repoRoot,
                branch,
                baseBranch,
                worktreePath
            )

            if (!rebaseResult.success) {
                mergingResult.conflicted = true
                mergingResult.stderr = rebaseResult.stderr

                if (strategy === 'stop') {
                    stoppedAt = mergingResult
                    merged.push(mergingResult)
                    break
                } else {
                    // strategy === 'respawn'
                    merged.push(mergingResult)
                    continue
                }
            }

            const mergeResult = await mergeBranch(
                repoRoot,
                branch
            )
            mergingResult.merged = mergeResult.success
            mergingResult.conflicted = !mergeResult.success
            if (!mergeResult.success) {
                mergingResult.stderr = mergeResult.stderr
            }

            if (!mergeResult.success) {
                if (strategy === 'stop') {
                    stoppedAt = mergingResult
                    merged.push(mergingResult)
                    break
                }
                merged.push(mergingResult)
                continue
            }
        }

        merged.push(mergingResult)
    }

    return {
        merged,
        stoppedAt,
    }
}
