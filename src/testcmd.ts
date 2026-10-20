import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TestResult = {
    exitCode:number
    output:string
}

// Returns the command to run the project's tests, or null
// when the project does not declare one.
export function detectTestCmd (projectDir:string):string|null {
    const pkgPath = join(projectDir, 'package.json')
    if (!existsSync(pkgPath)) return null
    try {
        const pkg = JSON.parse(
            readFileSync(pkgPath, 'utf8')
        ) as { scripts?:Record<string, string> }
        return pkg.scripts?.test ?
            'npm test' :
            null
    } catch {
        return null
    }
}

// Returns the command that installs dependencies in a fresh
// worktree, or null when the project has no package.json.
// Follows the project's lockfile, so the worktree gets the
// same dependency tree as the main checkout, and never
// writes a lockfile a ticket branch would then commit.
export function detectInstallCmd (projectDir:string):string|null {
    const has = (name:string) => existsSync(join(projectDir, name))
    if (!has('package.json')) return null
    if (has('pnpm-lock.yaml')) {
        return 'pnpm install --prefer-offline --frozen-lockfile'
    }
    if (has('package-lock.json')) {
        return 'npm ci --prefer-offline --no-audit --no-fund'
    }
    return 'npm install --prefer-offline --no-audit ' +
        '--no-fund --no-package-lock'
}

export function runTestCmd (opts:{
    cmd:string
    cwd:string
    timeout:number
    registry?:Set<number>
    progress?:{
        label:string
        onLine:(line:string) => void
    }
}):Promise<TestResult> {
    return new Promise(resolve => {
        let settled = false
        const started = performance.now()
        const report = (message:string):void => {
            if (opts.progress) {
                opts.progress.onLine(
                    `  ${opts.progress.label}: ${message}`
                )
            }
        }
        report(`starting tests: ${opts.cmd}`)
        report(`worktree ${opts.cwd}; timeout ${opts.timeout}s`)
        report('output is saved when tests finish')
        const heartbeat = opts.progress ? setInterval(() => {
            const elapsed = Math.floor(
                (performance.now() - started) / 1000
            )
            report(`tests still running (${elapsed}s elapsed)`)
        }, 15000) : undefined
        heartbeat?.unref()
        const child = spawn('sh', ['-c', opts.cmd], {
            cwd: opts.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        })

        if (child.pid !== undefined && opts.registry) {
            opts.registry.add(child.pid)
        }

        const chunks:string[] = []
        child.stdout.on('data', d => chunks.push(String(d)))
        child.stderr.on('data', d => chunks.push(String(d)))

        const timer = setTimeout(() => {
            clearInterval(heartbeat)
            report(`timeout reached (${opts.timeout}s); stopping tests`)
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch {
                    child.kill('SIGKILL')
                }
            } else {
                child.kill('SIGKILL')
            }
        }, opts.timeout * 1000)

        child.on('error', err => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearInterval(heartbeat)
            if (child.pid !== undefined && opts.registry) {
                opts.registry.delete(child.pid)
            }
            chunks.push(String(err))
            resolve({
                exitCode: 1,
                output: chunks.join(''),
            })
        })

        child.on('close', code => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearInterval(heartbeat)
            if (child.pid !== undefined && opts.registry) {
                opts.registry.delete(child.pid)
            }
            resolve({
                exitCode: code ?? 1,
                output: chunks.join(''),
            })
        })
    })
}
