#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
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
    formatErrorMessage,
    type EffortLevel,
    type Ticket,
} from './orchestrator.js'
import { detectTestCmd, detectInstallCmd } from './testcmd.js'
import { resolveExecutable } from './preflight.js'
import { createDisplay } from './display.js'
import {
    findFeatureDirs,
    resolveIssuesDir,
    getScriptDir,
    type FeatureSelection,
} from './resolve.js'
import {
    getRepoRoot,
    getRepoName,
    prepareIntegrationBranch,
    describeIntegrationBranch,
    type IntegrationPlan,
} from './worktree.js'

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
                    'to "npm test" when package.json has ' +
                    'a test script; otherwise the run ' +
                    'has no test gate. "" disables it.',
            })
            .option('install-cmd', {
                type:'string',
                describe:'Command run in each fresh ' +
                    'worktree before the agent starts. ' +
                    'Defaults to the install command ' +
                    'for the project\'s lockfile (npm ci ' +
                    'or pnpm install); "" disables it.',
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
            })
            .option('review', {
                type:'boolean',
                default:true,
                describe:'Review the merged work and run one ' +
                    'fix pass at the end. --no-review skips it.',
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
                installCmd:argv.installCmd as
                    string|undefined,
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
                review:argv.review as boolean|undefined,
            })
        }
    )
    .strict()
    .demandCommand(1, 'Specify a command or provider')
    .help()
    .fail((
        msg:string|null,
        err:unknown,
        y:{ showHelp:() => void }
    ) => {
        // A thrown or rejected error from a command handler arrives
        // as fail(null, err): one line, exit 2, same code as the
        // usage errors runExecute exits with itself. No help text,
        // no stack. A msg+err pair (parser or YError usage errors)
        // is a usage error and keeps the help text and exit 1.
        if (err && !msg) {
            console.error(formatErrorMessage(err))
            process.exit(2)
        }
        // A parse or validation error: keep today's output.
        y.showHelp()
        console.error(`\n${msg}`)
        process.exit(1)
    })
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

type LoadedTickets = {
    allTickets:Ticket[]
    specBodies:Map<string, string>
    progressPaths:Map<string, string>
    issuesDirs:string[]
    firstFeatureName:string
    firstLogsDir:string
    // paths a selection needs that are not in the working tree
    missing:string[]
}

// Scans every selected feature's tickets from the working tree.
// `log` is a no-op for the silent re-scan after resuming an
// integration branch. A selection whose issues dir or spec is
// absent is skipped and reported in `missing`; the caller decides
// whether that is fatal.
function loadTickets (
    selections:FeatureSelection[],
    log:(msg:string) => void
):LoadedTickets {
    const allTickets:Ticket[] = []
    const specBodies = new Map<string, string>()
    const progressPaths = new Map<string, string>()
    const issuesDirs:string[] = []
    let firstFeatureName = ''
    let firstLogsDir = ''
    const missing:string[] = []

    for (const selection of selections) {
        const { dir, spec, name } = selection

        if (!existsSync(dir)) {
            missing.push(`Directory not found: ${dir}`)
            continue
        }
        if (!existsSync(spec)) {
            missing.push(`Spec file not found: ${spec}`)
            continue
        }

        const specBody = stripSpecSection(
            readFileSync(spec, 'utf8'),
            'User Stories'
        )
        const tickets = scanTickets(dir, name)

        if (tickets.length === 0) {
            log(
                'No ticket files found for ' +
                `${name}. Skipping.`
            )
            continue
        }

        log(
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
                log(
                    `${t.filename}: blockers ` +
                    `[${unknown.join(', ')}] ` +
                    'not found in directory'
                )
            }
            t.blockers = t.blockers.filter(
                b => knownNums.has(b)
            )
        }

        specBodies.set(name, specBody)
        progressPaths.set(
            name, join(dirname(dir), 'progress.md')
        )
        issuesDirs.push(dir)
        allTickets.push(...tickets)

        if (!firstFeatureName) {
            firstFeatureName = extractFeatureName(spec)
            firstLogsDir = join(dirname(dir), 'logs')
        }
    }

    return {
        allTickets,
        specBodies,
        progressPaths,
        issuesDirs,
        firstFeatureName,
        firstLogsDir,
        missing,
    }
}

// The first scan of a run: anything missing is a usage error.
function loadTicketsOrExit (
    selections:FeatureSelection[]
):LoadedTickets {
    const loaded = loadTickets(selections, console.log)
    if (loaded.missing.length > 0) {
        for (const msg of loaded.missing) console.error(msg)
        process.exit(2)
    }
    return loaded
}

// A resumed integration branch can predate the tickets or spec of
// this run. Puts the launch branch back and exits 2 with the fix.
function failStaleResume (
    plan:IntegrationPlan,
    problems:string[]
):never {
    try {
        execFileSync(
            'git', ['checkout', '--quiet', plan.launchBranch],
            { cwd:getRepoRoot(), stdio:'ignore' }
        )
    } catch {
        // report the problem below either way
    }
    const n = plan.behind
    console.error(
        `Cannot resume ${plan.branch}: ` +
        `${problems.join('; ')}. It is ${n} ` +
        `commit${n === 1 ? '' : 's'} behind ${plan.launchBranch}. ` +
        `Merge ${plan.launchBranch} into it, or delete it with ` +
        `\`git branch -D ${plan.branch}\`. ` +
        `Back on ${plan.launchBranch}.`
    )
    process.exit(2)
}

// One feature keeps its review log next to its progress file; a
// multi-feature run reviews one combined diff, so its log sits in
// .scratch/ itself.
function reviewPathFor (issuesDirs:string[]):string {
    const featureDir = dirname(issuesDirs[0])
    return issuesDirs.length === 1 ?
        join(featureDir, 'review.md') :
        join(dirname(featureDir), 'review.md')
}

async function runExecute (argv:{
    provider:string
    model?:string
    spec?:string
    dryRun?:boolean
    timeout?:number
    testCmd?:string
    installCmd?:string
    stopOnConflict?:boolean
    maxTurns?:number
    effort?:EffortLevel
    retries?:number
    retryDelay?:number
    concurrency?:number
    review?:boolean
}):Promise<void> {
    const selections = await resolveIssuesDir(
        argv.spec
    )

    let loaded = loadTicketsOrExit(selections)
    if (loaded.allTickets.length === 0) return

    const providerPath = resolveExecutable(argv.provider)
    // A path is never searched on PATH, so say what was checked
    const providerMissing = argv.provider.includes('/') ?
        'not found or not executable' :
        'not found on PATH'
    if (providerPath === null && !argv.dryRun) {
        console.error(
            `Provider '${argv.provider}' ${providerMissing}`
        )
        process.exit(2)
    }

    const isolated = isGitRepo()
    const featureNames = [...loaded.specBodies.keys()]
    let plan:IntegrationPlan|null = null
    if (isolated && !argv.dryRun) {
        try {
            plan = prepareIntegrationBranch(
                getRepoRoot(), featureNames
            )
        } catch (err) {
            console.error(formatErrorMessage(err))
            process.exit(2)
        }
        if (plan.created) {
            console.log(
                `Created branch ${plan.branch} ` +
                `from ${plan.launchBranch}`
            )
        } else if (plan.resumed) {
            console.log(
                `Resumed ${plan.branch}` +
                (plan.fastForwarded ?
                    ` (fast-forwarded to ${plan.launchBranch})` :
                    '') +
                (plan.behind > 0 ?
                    ` (${plan.launchBranch} is ${plan.behind} ` +
                    `commit${plan.behind === 1 ? '' : 's'} ahead)` :
                    '')
            )
            // Ticket statuses live on the branch just checked out
            loaded = loadTickets(selections, () => {})
            if (loaded.missing.length > 0) {
                failStaleResume(plan, loaded.missing)
            }
            if (loaded.allTickets.length === 0) {
                failStaleResume(plan, ['no tickets'])
            }
        }
    }

    const {
        allTickets, specBodies, progressPaths,
        firstFeatureName, firstLogsDir,
    } = loaded

    const timeout = argv.timeout ?? 900
    const testCmd = argv.testCmd ?? detectTestCmd(
        isolated ?
            getRepoRoot() :
            process.cwd()
    ) ?? ''
    if (argv.testCmd === undefined && testCmd === '') {
        console.log(
            'No test command detected; running without a ' +
            'test gate. Pass --test-cmd to add one.'
        )
    }
    // Only worktrees start without dependencies, so only an
    // isolated run installs. An explicit "" disables it.
    const installCmd = argv.installCmd ??
        (isolated ?
            detectInstallCmd(getRepoRoot()) ?? undefined :
            undefined)
    const conflictStrategy = argv.stopOnConflict ?
        'stop' :
        'respawn'
    const logsDir = firstLogsDir
    const fallbackSpec = specBodies.values().next().value!

    if (argv.dryRun) {
        console.log(
            `Provider:     ${providerPath ?? providerMissing}`
        )
        if (isolated) {
            const repoName = getRepoName()
            dryRunIsolated({
                tickets:allTickets,
                specBody:fallbackSpec,
                repoName,
                conflictStrategy,
                progressPath:progressPaths.values()
                    .next().value!,
                testCmd,
                installCmd,
                effort:argv.effort,
                retries:argv.retries,
                retryDelay:argv.retryDelay,
                concurrency:argv.concurrency,
            })
            console.log(
                describeIntegrationBranch(
                    getRepoRoot(), featureNames
                )
            )
            const reviewState = argv.review === false ? 'off' : 'on'
            console.log(`Review:       ${reviewState}`)
        } else {
            dryRun(allTickets, fallbackSpec, testCmd)
        }
        return
    }

    const display = createDisplay()

    function onSignal (exitCode:number):void {
        killRunningAgents()
        display.cleanup()
        process.exit(exitCode)
    }
    process.on('SIGINT', () => onSignal(130))
    process.on('SIGTERM', () => onSignal(143))

    let result:{ allDone:boolean; branch?:string }

    if (isolated) {
        result = await runWavesIsolated({
            tickets:allTickets,
            specBody:fallbackSpec,
            specBodies,
            agentCmd:argv.provider,
            model:argv.model ?? null,
            timeout,
            logsDir,
            featureName:firstFeatureName,
            conflictStrategy,
            display,
            testCmd,
            installCmd,
            maxTurns:argv.maxTurns,
            effort:argv.effort,
            retries:argv.retries,
            retryDelay:argv.retryDelay,
            concurrency:argv.concurrency,
            progressPaths,
            review:argv.review === false ?
                undefined :
                {
                    reviewPath:reviewPathFor(loaded.issuesDirs),
                    forkedFrom:plan?.forkedFrom ?? undefined,
                },
        })
    } else {
        result = await runWaves(
            allTickets, fallbackSpec,
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
        process.exit(1)
    }
}
