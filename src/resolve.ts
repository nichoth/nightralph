import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { select } from '@inquirer/prompts'
import { isSpecComplete } from './progress.js'

export function getScriptDir (metaUrl:string):string {
    return dirname(fileURLToPath(metaUrl))
}

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
        if (!existsSync(issuesDir)) continue
        const progressFile = join(
            scratchDir, entry.name, 'progress.md'
        )
        if (isSpecComplete(progressFile)) continue
        results.push({
            name:entry.name,
            dir:issuesDir,
            spec:specFile,
        })
    }
    return results
}

export async function resolveIssuesDir (
    specName:string|undefined,
    cwd:string = process.cwd(),
):Promise<{ dir:string; spec:string }> {
    if (specName) {
        const featureDir = join(cwd, '.scratch', specName)
        return {
            dir:join(featureDir, 'issues'),
            spec:join(featureDir, 'spec.md'),
        }
    }

    const features = findFeatureDirs(cwd)

    if (features.length === 0) {
        console.error(
            'No .scratch/<feature>/issues/ directories ' +
            'found.\nProvide --spec <feature-name>.'
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

    return { dir:chosen.dir, spec:chosen.spec }
}
