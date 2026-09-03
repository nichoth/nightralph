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

export function runTestCmd (opts:{
    cmd:string
    cwd:string
    timeout:number
}):Promise<TestResult> {
    return new Promise(resolve => {
        let settled = false
        const child = spawn('sh', ['-c', opts.cmd], {
            cwd:opts.cwd,
            stdio:['ignore', 'pipe', 'pipe'],
            detached:true,
        })
        const chunks:string[] = []
        child.stdout.on('data', d => chunks.push(String(d)))
        child.stderr.on('data', d => chunks.push(String(d)))

        const timer = setTimeout(() => {
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch {
                    // No process group (or it already
                    // exited); fall back to the child.
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
            chunks.push(String(err))
            resolve({
                exitCode:1,
                output:chunks.join(''),
            })
        })

        child.on('close', code => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
                exitCode:code ?? 1,
                output:chunks.join(''),
            })
        })
    })
}
