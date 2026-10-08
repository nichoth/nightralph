import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export type ResolveExecutableOpts = {
    // PATH to search for a bare name; default process.env.PATH
    path?:string
    // directory a relative path is resolved against; default
    // process.cwd()
    cwd?:string
}

function isExecutableFile (file:string):boolean {
    try {
        if (!statSync(file).isFile()) return false
        accessSync(file, constants.X_OK)
        return true
    } catch {
        return false
    }
}

// Where a command would run from, or null when it would not run.
// A name with a slash is a path, resolved against cwd. A bare name
// is looked up in each PATH entry in order. Never throws.
export function resolveExecutable (
    cmd:string,
    opts:ResolveExecutableOpts = {}
):string|null {
    if (cmd === '') return null
    const cwd = opts.cwd ?? process.cwd()
    if (cmd.includes('/')) {
        const full = resolve(cwd, cmd)
        return isExecutableFile(full) ? full : null
    }
    const path = opts.path ?? process.env.PATH ?? ''
    for (const dir of path.split(delimiter)) {
        if (dir === '') continue
        const candidate = join(dir, cmd)
        if (isExecutableFile(candidate)) return candidate
    }
    return null
}
