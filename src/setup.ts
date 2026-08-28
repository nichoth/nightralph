import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

export const SKILL_DIRS = [
    'grill', 'grilling', 'domain-modeling',
    'to-spec', 'to-tickets', 'tdd',
] as const

export const DOC_TEMPLATES = [
    'triage-labels.md',
    'domain.md',
] as const

export function checkGhAuth ():boolean {
    try {
        execSync('gh auth status', { stdio:'ignore' })
        return true
    } catch {
        return false
    }
}

export type TrackerKind = 'github'|'local'

export type SetupOpts = {
    bundledSkillsDir:string
    docsTemplatesDir:string
    projectDir:string
    claude?:boolean
    tracker:TrackerKind
}

const TRACKER_TEMPLATES:Record<TrackerKind, string> = {
    local:'issue-tracker.md',
    github:'issue-tracker-github.md',
}

export function setup (opts:SetupOpts):void {
    const {
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        claude,
        tracker,
    } = opts
    const agentsSkillsDir = join(
        projectDir, '.agents', 'skills'
    )

    const upstream = JSON.parse(
        readFileSync(
            join(bundledSkillsDir, 'upstream.json'),
            'utf8'
        )
    ) as { repo:string; commit:string }

    console.log('Installing skills to .agents/skills/\n')

    for (const skill of SKILL_DIRS) {
        const src = join(bundledSkillsDir, skill)
        const dest = join(agentsSkillsDir, skill)
        mkdirSync(dest, { recursive:true })
        cpSync(src, dest, { recursive:true })
        const files = readdirSync(src)
        console.log(
            `  ${skill}/ (${files.join(', ')})`
        )
    }

    if (claude) {
        const claudeSkillsDir = join(
            projectDir, '.claude', 'skills'
        )
        mkdirSync(claudeSkillsDir, { recursive:true })

        for (const skill of SKILL_DIRS) {
            const linkPath = join(claudeSkillsDir, skill)
            const target = join(
                '..', '..', '.agents', 'skills', skill
            )
            if (existsSync(linkPath)) continue
            symlinkSync(target, linkPath)
        }

        console.log(
            '\nCreated symlinks in .claude/skills/'
        )
    }

    const docsAgentsDir = join(
        projectDir, 'docs', 'agents'
    )
    mkdirSync(docsAgentsDir, { recursive:true })

    console.log('')
    for (const tmpl of DOC_TEMPLATES) {
        const dest = join(docsAgentsDir, tmpl)
        if (existsSync(dest)) {
            console.log(
                `  docs/agents/${tmpl} (already exists)`
            )
            continue
        }
        const src = join(docsTemplatesDir, tmpl)
        writeFileSync(dest, readFileSync(src, 'utf8'))
        console.log(`  docs/agents/${tmpl} (created)`)
    }

    const trackerSrc = join(
        docsTemplatesDir, TRACKER_TEMPLATES[tracker]
    )
    const trackerDest = join(docsAgentsDir, 'issue-tracker.md')
    writeFileSync(trackerDest, readFileSync(trackerSrc, 'utf8'))
    console.log(
        `  docs/agents/issue-tracker.md (${tracker})`
    )

    const trackerLine = tracker === 'github' ?
        'Issues are tracked via GitHub Issues using the `gh` ' +
        'CLI.' :
        'Issues are tracked as local markdown files under ' +
        '`.scratch/`.'

    const agentsMd = [
        '## Agent skills',
        '',
        '### Issue tracker',
        '',
        `${trackerLine} See \`docs/agents/issue-tracker.md\`.`,
        '',
        '### Triage labels',
        '',
        'Default label vocabulary. See ' +
        '`docs/agents/triage-labels.md`.',
        '',
        '### Domain docs',
        '',
        'Single-context layout. See `docs/agents/domain.md`.',
        '',
    ].join('\n')

    writeFileSync(join(projectDir, 'AGENTS.md'), agentsMd)
    console.log('\n  AGENTS.md (updated)')

    console.log(
        `\nSource: ${upstream.repo} @ ${upstream.commit}`
    )
}
