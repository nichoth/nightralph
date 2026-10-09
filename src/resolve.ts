import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkbox, Separator } from '@inquirer/prompts'
import { isSpecComplete } from './progress.js'
import {
    scanTickets,
    findReadyTickets,
    blockerLabel,
    type Ticket,
} from './orchestrator.js'
import { ticketLabel } from './display.js'
import {
    parseBlockerField,
    resolveBlockers,
    type BlockerWarning,
} from './blockers.js'

export type { BlockerWarning }

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

export type LoadedSelection = {
    tickets:Ticket[];
    warnings:BlockerWarning[];
}

// Names of the features under scratchDir: dirs with an issues
// subdir, complete or not.
function knownFeatureNames (scratchDir:string):Set<string> {
    if (!existsSync(scratchDir)) return new Set()
    return new Set(
        readdirSync(scratchDir, { withFileTypes:true })
            .filter(e => (
                e.isDirectory() &&
                existsSync(join(scratchDir, e.name, 'issues'))
            ))
            .map(e => e.name)
    )
}

/**
 * Tickets of the named features with every blocker resolved, and
 * the problems found on the way. An unselected feature is scanned
 * only when a ref points into it, once.
 */
export function loadSelection (
    scratchDir:string,
    names:ReadonlyArray<string>
):LoadedSelection {
    const known = knownFeatureNames(scratchDir)
    const issuesDir = (name:string) => join(scratchDir, name, 'issues')

    const tickets:Ticket[] = []
    const selected = new Map<string, Set<number>>()
    for (const name of new Set(names)) {
        const dir = issuesDir(name)
        const found = existsSync(dir) ?
            scanTickets(dir, name, known) :
            []
        selected.set(name, new Set(found.map(t => t.num)))
        tickets.push(...found)
    }

    const outside = new Map<string, Map<number, string>>()
    const lookup = (feature:string, num:number) => {
        if (!known.has(feature)) return undefined
        let statuses = outside.get(feature)
        if (!statuses) {
            statuses = new Map(
                scanTickets(issuesDir(feature), feature)
                    .map(t => [t.num, t.status])
            )
            outside.set(feature, statuses)
        }
        return statuses.get(num)
    }

    const warnings:BlockerWarning[] = []
    for (const t of tickets) {
        const parsed = parseBlockerField(t.body, known)
        t.blockers = resolveBlockers(
            parsed.refs, t.feature, selected, lookup
        )
        const ticket = ticketLabel(t)
        for (const word of parsed.typos) {
            warnings.push({ ticket, kind:'typo', text:word })
        }
        for (const ref of t.blockers) {
            if (ref.where !== 'missing') continue
            warnings.push({
                ticket, kind:'missing', text:blockerLabel(ref),
            })
        }
    }
    return { tickets, warnings }
}

export type FeatureCounts = {
    ready:number;
    total:number;
    badBlockers:number;   // refs that match no ticket
}

/**
 * Counts for one feature as if it ran alone: the same
 * loadSelection a `--spec <name>` run uses.
 */
export function featureCounts (
    scratchDir:string,
    name:string
):FeatureCounts {
    const { tickets, warnings } = loadSelection(scratchDir, [name])
    return {
        ready:findReadyTickets(tickets).length,
        total:tickets.length,
        badBlockers:warnings.filter(w => w.kind === 'missing').length,
    }
}

export function featureChoiceLabel (
    scratchDir:string,
    name:string
):string {
    const c = featureCounts(scratchDir, name)
    const bad = c.badBlockers === 0 ?
        '' :
        `, ${c.badBlockers} bad blocker` +
            (c.badBlockers === 1 ? '' : 's')
    return `${name} (${c.ready}/${c.total} ready${bad})`
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

    const scratchDir = join(cwd, '.scratch')
    const featureChoices = features.map(f => ({
        name:featureChoiceLabel(scratchDir, f.name),
        value:f.name,
    }))

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
