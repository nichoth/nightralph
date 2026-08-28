import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { select } from '@inquirer/prompts'

export function findFeatureDirs (cwd:string):{
    name:string;
    dir:string;
    spec:string
}[] {
    const scratchDir = join(cwd, '.scratch')
    if (!existsSync(scratchDir)) return []
    const entries = readdirSync(
        scratchDir, { withFileTypes:true }
    )
    const results:{ name:string; dir:string; spec:string }[] = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const issuesDir = join(
            scratchDir, entry.name, 'issues'
        )
        const specFile = join(
            scratchDir, entry.name, 'spec.md'
        )
        if (existsSync(issuesDir)) {
            results.push({
                name:entry.name,
                dir:issuesDir,
                spec:specFile,
            })
        }
    }
    return results
}

export async function resolveIssuesDir (
    dirFlag:string|undefined,
    specFlag:string|undefined,
    cwd:string = process.cwd(),
):Promise<{ dir:string; spec:string }> {
    if (dirFlag && specFlag) {
        return { dir:dirFlag, spec:specFlag }
    }

    const features = findFeatureDirs(cwd)

    if (features.length === 0) {
        console.error(
            'No .scratch/<feature>/issues/ directories ' +
            'found.\nProvide --dir and --spec explicitly.'
        )
        process.exit(2)
    }

    let chosen:typeof features[0]
    if (features.length === 1) {
        chosen = features[0]
        console.log(`Using feature: ${chosen.name}`)
    } else {
        const name = await select({
            message:'Which feature?',
            choices:features.map(f => ({
                name:f.name,
                value:f.name,
            })),
        })
        chosen = features.find(f => f.name === name)!
    }

    const dir = dirFlag ?? chosen.dir
    const spec = specFlag ?? chosen.spec

    return { dir, spec }
}
