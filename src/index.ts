#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { select } from '@inquirer/prompts'
import { setup, checkGhAuth, type TrackerKind } from './setup.js'
import {
    scanTickets,
    dryRun,
    dryRunIsolated,
    runWaves,
    runWavesIsolated,
    stripSpecSection,
} from './orchestrator.js'
import { detectTestCmd } from './testcmd.js'
import { createDisplay } from './display.js'
import {
    findFeatureDirs,
    resolveIssuesDir,
    getScriptDir,
} from './resolve.js'
import { getRepoRoot, getRepoName } from './worktree.js'

export { findFeatureDirs, resolveIssuesDir }

const scriptDir = getScriptDir(import.meta.url)

yargs(hideBin(process.argv))
    .scriptName('nightralph')
    .usage('$0 <command>')
    .command(
        'init',
        'Install bundled skills and doc templates',
        y => y.option('claude', {
            type:'boolean',
            describe:'Also create .claude/skills/ symlinks',
            default:true,
        }),
        async argv => {
            const tracker = await select<TrackerKind>({
                message:'Issue tracker format',
                choices:[
                    {
                        name:'Local Markdown',
                        value:'local' as const,
                        description:'Issues as .md files in ' +
                            '.scratch/',
                    },
                    {
                        name:'GitHub Issues',
                        value:'github' as const,
                        description:'Issues via gh CLI',
                    },
                ],
            })

            if (tracker === 'github') {
                if (!checkGhAuth()) {
                    console.error(
                        'GitHub Issues requires the gh CLI, ' +
                        'authenticated.\n' +
                        'Install: https://cli.github.com\n' +
                        'Then run: gh auth login'
                    )
                    process.exit(2)
                }
            }

            setup({
                bundledSkillsDir:join(scriptDir, 'skills'),
                docsTemplatesDir:join(
                    scriptDir, 'docs-templates'
                ),
                projectDir:process.cwd(),
                claude:argv.claude,
                tracker,
            })
        }
    )
    .command(
        '$0 <provider>',
        'Execute tickets with the given provider',
        y => y
            .positional('provider', {
                type:'string',
                describe:'Agent CLI to spawn ' +
                    '(e.g. claude, codex, pi)',
                demandOption:true,
            })
            .option('m', {
                alias:'model',
                type:'string',
                describe:'Model passed to the agent',
            })
            .option('spec', {
                type:'string',
                describe:'Feature name ' +
                    '(resolves .scratch/<name>/)',
            })
            .option('dry-run', {
                type:'boolean',
                describe:'Show wave order without running',
                default:false,
            })
            .option('timeout', {
                type:'number',
                describe:'Kill agent after N seconds',
                default:900,
            })
            .option('test-cmd', {
                type:'string',
                describe:'Command run in each worktree ' +
                    'after the agent exits; non-zero ' +
                    'exit rejects the ticket. Defaults ' +
                    'to "npm test" when package.json ' +
                    'has a test script. Pass "" to ' +
                    'disable.',
            })
            .option('X', {
                type:'boolean',
                describe:'Stop on merge conflict instead of ' +
                    're-spawning',
                default:false,
            }),
        async argv => {
            await runExecute({
                provider:argv.provider as string,
                model:argv.model as string|undefined,
                spec:argv.spec as string|undefined,
                dryRun:argv.dryRun as boolean|undefined,
                timeout:argv.timeout as
                    number|undefined,
                testCmd:argv.testCmd as string|undefined,
                stopOnConflict:argv.X as
                    boolean|undefined,
            })
        }
    )
    .strict()
    .demandCommand(1, 'Specify a command or provider')
    .help()
    .parse()

function isGitRepo ():boolean {
    try {
        getRepoRoot()
        return true
    } catch {
        return false
    }
}

function extractFeatureName (spec:string):string {
    const parts = spec.split(
        /[\\/]/
    )
    const scratchIndex = parts.indexOf('.scratch')
    if (scratchIndex >= 0 && scratchIndex < parts.length - 1) {
        return parts[scratchIndex + 1]
    }
    return parts[parts.length - 2] ??
        parts[parts.length - 1] ?? 'feature'
}

async function runExecute (argv:{
    provider:string
    model?:string
    spec?:string
    dryRun?:boolean
    timeout?:number
    testCmd?:string
    stopOnConflict?:boolean
}):Promise<void> {
    const { dir, spec } = await resolveIssuesDir(
        argv.spec
    )

    if (!existsSync(dir)) {
        console.error(`Directory not found: ${dir}`)
        process.exit(2)
    }
    if (!existsSync(spec)) {
        console.error(`Spec file not found: ${spec}`)
        process.exit(2)
    }

    const specBody = stripSpecSection(
        readFileSync(spec, 'utf8'),
        'User Stories'
    )
    const tickets = scanTickets(dir)

    if (tickets.length === 0) {
        console.log('No ticket files found. Exiting.')
        return
    }

    console.log(`Found ${tickets.length} tickets`)

    const knownNums = new Set(tickets.map(t => t.num))
    for (const t of tickets) {
        const unknown = t.blockers.filter(
            b => !knownNums.has(b)
        )
        if (unknown.length > 0) {
            console.warn(
                `${t.filename}: blockers ` +
                `[${unknown.join(', ')}] ` +
                'not found in directory'
            )
        }
        t.blockers = t.blockers.filter(
            b => knownNums.has(b)
        )
    }

    const logsDir = join(dirname(dir), 'logs')
    const timeout = argv.timeout ?? 900
    const testCmd = argv.testCmd === undefined ?
        detectTestCmd(process.cwd()) :
        (argv.testCmd || null)
    const featureName = extractFeatureName(spec)
    const conflictStrategy = argv.stopOnConflict ?
        'stop' :
        'respawn'
    const progressPath = join(
        dirname(dir), 'progress.md'
    )

    if (argv.dryRun) {
        if (isGitRepo()) {
            const repoName = getRepoName()
            dryRunIsolated({
                tickets,
                specBody,
                repoName,
                conflictStrategy,
                progressPath,
                testCmd,
            })
        } else {
            dryRun(tickets, specBody)
        }
        return
    }

    const display = createDisplay()
    let result:{ allDone:boolean }

    if (isGitRepo()) {
        result = await runWavesIsolated({
            tickets,
            specBody,
            agentCmd:argv.provider,
            model:argv.model ?? null,
            timeout,
            logsDir,
            featureName,
            conflictStrategy,
            display,
            testCmd,
        })
    } else {
        result = await runWaves(
            tickets, specBody,
            argv.provider, argv.model ?? null,
            timeout,
            logsDir,
            display,
        )
    }

    if (!result.allDone) {
        process.exit(1)
    }
}
