import { NOTES_PATH } from './learnings.js'

// Rule lines shared by the agent prompts. `unit` is what the agent
// commits one at a time ("checklist item", "finding"); `subject` is
// what the orchestrator accepts or rejects ("ticket", "fix").

export function readDocsRule (subject:string):string {
    return '- Read the files directly relevant to the ' +
        `${subject} before writing code. Also read any ` +
        'AGENTS.md in or above the directories you ' +
        'will touch, plus CONTEXT.md and the ' +
        'relevant docs/adr/ entries if they exist. ' +
        'If they do not exist, proceed silently.'
}

// The rule for agents in a worktree the orchestrator has
// already installed dependencies into. Empty without one.
export function installRule (installCmd?:string):string[] {
    if (!installCmd) return []
    return [
        '- Dependencies are already installed with ' +
            `\`${installCmd}\`. Do NOT reinstall them ` +
            'with any other command; to reinstall, run ' +
            'that same command. To add a dependency, use ' +
            'the package manager that command uses, so ' +
            'its lockfile stays in sync.',
    ]
}

export function testGateRule (testCmd:string, subject:string):string {
    return '- While iterating, run only the tests ' +
        'relevant to what you changed. Run ' +
        `\`${testCmd}\` in full once, as the ` +
        'final gate before your last commit. Do ' +
        'not commit with failing tests. The ' +
        'orchestrator runs the same command after ' +
        `you exit and rejects the ${subject} if it ` +
        'fails.'
}

export const LINT_RULE = '- If the project has a lint script, run it ' +
    'and fix what it reports.'

export function integrityRule (unit:string):string {
    return '- INTEGRITY: never delete, skip, weaken, or ' +
        'write tautological tests to force a green ' +
        `result. Only report a ${unit} done ` +
        'when its real tests genuinely pass. If an ' +
        'item cannot be completed honestly, leave ' +
        'it unchecked and record what blocked you ' +
        'in your notes file.'
}

export const CONFINEMENT_RULES:string[] = [
    '- Do NOT read or modify files outside ' +
        'your current directory (the worktree).',
    '- Do NOT run git push.',
]

export function commitRule (unit:string):string {
    return `- Commit after each ${unit}, and make ` +
        'sure everything is committed when finished, ' +
        'except your notes file.'
}

export function notesRule (unit:string, subject:string):string {
    return `- Keep notes for this attempt in \`${NOTES_PATH}\` ` +
        '(create the directory). Update it after each ' +
        `${unit} and as soon as you hit a ` +
        'blocker, not only at the end. Record what you ' +
        'implemented, files changed, how you read any ' +
        'vague acceptance criteria, what blocked you, and ' +
        `anything the next attempt at this ${subject} should ` +
        'know. Never commit, git add, or delete this ' +
        'file; the orchestrator collects it.'
}

export function agentsMdRule (subject:string):string {
    return '- Before your final commit, record reusable ' +
        'learnings in the nearest AGENTS.md (in or ' +
        'above the directories you modified; ' +
        'prefer that over the repo root). Good ' +
        'additions: module conventions, gotchas, ' +
        'files that must change together, how to ' +
        'test that area, environment requirements. ' +
        `Do NOT add ${subject}-specific details or ` +
        'temporary debugging notes. Only write ' +
        'when you have knowledge that would help ' +
        'future work in that directory. Reusable ' +
        'patterns go in AGENTS.md; anything ' +
        `specific to this ${subject} goes in your ` +
        'notes file.'
}
