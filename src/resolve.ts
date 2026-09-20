import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkbox, Separator } from '@inquirer/prompts'
import { isSpecComplete } from './progress.js'
import { scanTickets, findReadyTickets } from './orchestrator.js'

export type FeatureSelection = {
    dir:string;
    spec:string;
    name:string;
}

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
    results.sort((a, b) => a.name.localeCompare(b.name))
    return results
}

const ALL_VALUE = '__all__'

export async function resolveIssuesDir (
    specName:string|undefined,
    cwd:string = process.cwd(),
):Promise<FeatureSelection[]> {
    if (specName) {
        const featureDir = join(cwd, '.scratch', specName)
        return [{
            dir:join(featureDir, 'issues'),
            spec:join(featureDir, 'spec.md'),
            name:specName,
        }]
    }

    const features = findFeatureDirs(cwd)

    if (features.length === 0) {
        console.error(
            'No .scratch/<feature>/issues/ directories ' +
            'found.\nProvide --spec <feature-name>.'
        )
        process.exit(2)
    }

    if (features.length === 1) {
        const f = features[0]
        console.log(`Using feature: ${f.name}`)
        return [{ dir:f.dir, spec:f.spec, name:f.name }]
    }

    const featureChoices = features.map(f => {
        const tickets = scanTickets(f.dir)
        const ready = findReadyTickets(tickets).length
        return {
            name:`${f.name} (${ready}/${tickets.length} ready)`,
            value:f.name,
        }
    })

    while (true) {
        const selected = await checkbox({
            message:'Which features?',
            choices:[
                { name:'All', value:ALL_VALUE },
                new Separator(),
                ...featureChoices,
            ],
        })

        if (selected.length === 0) {
            console.log('Select at least one feature')
            continue
        }

        const names = selected.includes(ALL_VALUE) ?
            features.map(f => f.name) :
            selected

        return names.map(name => {
            const f = features.find(
                ff => ff.name === name
            )!
            return { dir:f.dir, spec:f.spec, name:f.name }
        })
    }
}
