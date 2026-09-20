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
    ALL_EFFORT_LEVELS,
    DEFAULT_RETRIES,
    DEFAULT_RETRY_DELAY,
    DEFAULT_CONCURRENCY,
    killRunningAgents,
    type EffortLevel,
} from './orchestrator.js'
import { detectTestCmd } from './testcmd.js'
import { createDisplay } from './display.js'
import { findFeatureDirs, resolveIssuesDir, getScriptDir } from './resolve.js'
import { getRepoRoot, getRepoName } from './worktree.js'

export { findFeatureDirs, resolveIssuesDir }

const scriptDir = getScriptDir(import.meta.url)

yargs(hideBin(process.argv))
    .scriptName('nightralph')
    .usage('$0 <command>')
    .command(
        'init',
        'Install bundled skills and doc templates',
        y => y,
        async () => {
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
                tracker,
            })
        }
    )
    .command(
        '$0 <provider> [turns]',
        'Execute tickets with the given provider',
        y => y
            .positional('provider', {
                type:'string',
                describe:'Agent CLI to spawn ' +
                    '(e.g. claude, codex, pi)',
                demandOption:true,
            })
            .positional('turns', {
                type:'number',
                describe:'Max agentic turns per ' +
                    'ticket (shorthand for ' +
                    '--max-turns)',
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
                default:3600,
            })
            .option('test-cmd', {
                type:'string',
                describe:'Command run in each worktree ' +
                    'after the agent exits; non-zero ' +
                    'exit rejects the ticket. Defaults ' +
                    'to "npm test".',
            })
            .option('X', {
                type:'boolean',
                describe:'Stop on merge conflict instead of ' +
                    're-spawning',
                default:false,
            })
            .option('max-turns', {
                type:'number',
                describe:'Max agentic turns per ticket ' +
                    '(forwarded to the agent CLI)',
            })
            .option('effort', {
                type:'string',
                choices:ALL_EFFORT_LEVELS,
                describe:'Starting effort level. ' +
                    'Omitted = provider default. ' +
                    'Retries step up from here.',
            })
            .option('retries', {
                type:'number',
                default:DEFAULT_RETRIES,
                describe:'Extra attempts per ticket ' +
                    'after a failed run, each with a ' +
                    'higher effort level. 0 ' +
                    'disables retries.',
            })
            .option('retry-delay', {
                type:'number',
                default:DEFAULT_RETRY_DELAY,
                describe:'Seconds to wait before the ' +
                    'first retry; doubles each further ' +
                    'retry. 0 disables the wait.',
            })
            .option('concurrency', {
                type:'number',
                default:DEFAULT_CONCURRENCY,
                describe:'Max agents running at once ' +
                    'within a wave.',
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
                maxTurns:(argv.maxTurns ??
                    argv.turns) as number|undefined,
                effort:argv.effort as
                    EffortLevel|undefined,
                retries:argv.retries as
                    number|undefined,
                retryDelay:argv.retryDelay as
                    number|undefined,
                concurrency:argv.concurrency as
                    number|undefined,
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
    maxTurns?:number
    effort?:EffortLevel
    retries?:number
    retryDelay?:number
    concurrency?:number
}):Promise<void> {
    const selections = await resolveIssuesDir(
        argv.spec
    )

    let anyFailed = false
    for (const selection of selections) {
        const { dir, spec, name } = selection

        if (!existsSync(dir)) {
            console.error(
                `Directory not found: ${dir}`
            )
            process.exit(2)
        }
        if (!existsSync(spec)) {
            console.error(
                `Spec file not found: ${spec}`
            )
            process.exit(2)
        }

        const specBody = stripSpecSection(
            readFileSync(spec, 'utf8'),
            'User Stories'
        )
        const tickets = scanTickets(dir)

        if (tickets.length === 0) {
            console.log(
                'No ticket files found for ' +
                `${name}. Skipping.`
            )
            continue
        }

        console.log(
            `[${name}] Found ${tickets.length} tickets`
        )

        const knownNums = new Set(
            tickets.map(t => t.num)
        )
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
        const testCmd = argv.testCmd || detectTestCmd(
            isGitRepo() ?
                getRepoRoot() :
                process.cwd()
        ) || 'npm test'
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
                    effort:argv.effort,
                    retries:argv.retries,
                    retryDelay:argv.retryDelay,
                    concurrency:argv.concurrency,
                })
            } else {
                dryRun(tickets, specBody, testCmd)
            }
            continue
        }

        const display = createDisplay()

        function onSignal (exitCode:number):void {
            killRunningAgents()
            display.cleanup()
            process.exit(exitCode)
        }
        process.on('SIGINT', () => onSignal(130))
        process.on('SIGTERM', () => onSignal(143))

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
                maxTurns:argv.maxTurns,
                effort:argv.effort,
                retries:argv.retries,
                retryDelay:argv.retryDelay,
                concurrency:argv.concurrency,
            })
        } else {
            result = await runWaves(
                tickets, specBody,
                argv.provider, argv.model ?? null,
                timeout,
                logsDir,
                testCmd,
                display,
                argv.maxTurns,
                argv.effort,
                argv.retries,
                argv.retryDelay,
                argv.concurrency,
            )
        }

        if (!result.allDone) {
            anyFailed = true
        }
    }

    if (anyFailed) {
        process.exit(1)
    }
}
