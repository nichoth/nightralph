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
    runWaves,
} from './orchestrator.js'
import {
    findFeatureDirs,
    resolveIssuesDir,
} from './resolve.js'

export { findFeatureDirs, resolveIssuesDir }

const scriptDir = dirname(process.argv[1])

yargs(hideBin(process.argv))
    .scriptName('nightralph')
    .usage('$0 <command>')
    .command(
        'setup',
        'Install bundled skills and doc templates',
        y => y.option('claude', {
            type:'boolean',
            describe:'Also create .claude/skills/ symlinks',
            default:false,
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
                describe:'Agent CLI to spawn (e.g. claude, codex)',
                demandOption:true,
            })
            .option('m', {
                alias:'model',
                type:'string',
                describe:'Model passed to the agent',
            })
            .option('dir', {
                type:'string',
                describe:'Path to the issues directory',
            })
            .option('spec', {
                type:'string',
                describe:'Path to the spec file',
            })
            .option('dry-run', {
                type:'boolean',
                describe:'Show wave order without running',
                default:false,
            })
            .option('timeout-secs', {
                type:'number',
                describe:'Kill agent after N seconds',
                default:300,
            }),
        async argv => {
            await runExecute({
                provider:argv.provider as string,
                model:argv.model as string|undefined,
                dir:argv.dir as string|undefined,
                spec:argv.spec as string|undefined,
                dryRun:argv.dryRun as boolean|undefined,
                timeoutSecs:argv.timeoutSecs as
                    number|undefined,
            })
        }
    )
    .strict()
    .demandCommand(1, 'Specify a command or provider')
    .help()
    .parse()

async function runExecute (argv:{
    provider:string
    model?:string
    dir?:string
    spec?:string
    dryRun?:boolean
    timeoutSecs?:number
}):Promise<void> {
    const { dir, spec } = await resolveIssuesDir(
        argv.dir, argv.spec
    )

    if (!existsSync(dir)) {
        console.error(`Directory not found: ${dir}`)
        process.exit(2)
    }
    if (!existsSync(spec)) {
        console.error(`Spec file not found: ${spec}`)
        process.exit(2)
    }

    const specBody = readFileSync(spec, 'utf8')
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

    if (argv.dryRun) {
        dryRun(tickets, specBody)
        return
    }

    const logsDir = join(dirname(dir), 'logs')
    const timeoutSecs = argv.timeoutSecs ?? 300
    await runWaves(
        tickets, specBody,
        argv.provider, argv.model ?? null, timeoutSecs,
        logsDir,
    )
}
