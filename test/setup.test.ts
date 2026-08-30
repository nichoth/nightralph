import { test } from '@substrate-system/tapzero'
import {
    mkdtempSync, mkdirSync, writeFileSync, existsSync,
    lstatSync, readlinkSync, readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    setup, SKILL_DIRS, DOC_TEMPLATES, checkGhAuth,
} from '../src/setup.js'

function makeTempProject ():{
    projectDir:string;
    bundledSkillsDir:string;
    docsTemplatesDir:string;
} {
    const base = mkdtempSync(
        join(tmpdir(), 'nightralph-test-')
    )
    const projectDir = join(base, 'project')
    mkdirSync(projectDir, { recursive:true })

    const bundledSkillsDir = join(base, 'bundled')
    mkdirSync(bundledSkillsDir, { recursive:true })

    writeFileSync(
        join(bundledSkillsDir, 'upstream.json'),
        JSON.stringify({
            repo:'test/repo',
            commit:'abc123',
        })
    )

    for (const skill of SKILL_DIRS) {
        const dir = join(bundledSkillsDir, skill)
        mkdirSync(dir, { recursive:true })
        writeFileSync(
            join(dir, 'SKILL.md'),
            `# ${skill}`
        )
    }

    const docsTemplatesDir = join(base, 'docs-templates')
    mkdirSync(docsTemplatesDir, { recursive:true })
    for (const tmpl of DOC_TEMPLATES) {
        writeFileSync(
            join(docsTemplatesDir, tmpl),
            `# ${tmpl}`
        )
    }
    writeFileSync(
        join(docsTemplatesDir, 'issue-tracker.md'),
        '# issue-tracker.md'
    )
    writeFileSync(
        join(docsTemplatesDir, 'issue-tracker-github.md'),
        '# issue-tracker-github.md'
    )

    return { projectDir, bundledSkillsDir, docsTemplatesDir }
}

test('setup copies skills to .agents/skills', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    for (const skill of SKILL_DIRS) {
        const dest = join(
            projectDir, '.agents', 'skills', skill
        )
        t.ok(
            existsSync(dest),
            `${skill}/ should exist in .agents/skills`
        )
        t.ok(
            existsSync(join(dest, 'SKILL.md')),
            `${skill}/SKILL.md should be copied`
        )
    }
})

test('setup does NOT create .claude/skills by default', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const claudeSkills = join(
        projectDir, '.claude', 'skills'
    )
    t.ok(
        !existsSync(claudeSkills),
        '.claude/skills should not exist without --claude'
    )
})

test('setup --claude creates symlinks in .claude/skills', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        claude:true,
        tracker:'local',
    })

    for (const skill of SKILL_DIRS) {
        const agentsDest = join(
            projectDir, '.agents', 'skills', skill
        )
        t.ok(
            existsSync(agentsDest),
            `${skill}/ should exist in .agents/skills`
        )

        const claudeDest = join(
            projectDir, '.claude', 'skills', skill
        )
        t.ok(
            existsSync(claudeDest),
            `${skill}/ should exist in .claude/skills`
        )

        if (!existsSync(claudeDest)) {
            t.fail(`symlink missing for ${skill}`)
            continue
        }

        const stat = lstatSync(claudeDest)
        t.ok(
            stat.isSymbolicLink(),
            `.claude/skills/${skill} should be a symlink`
        )

        const target = readlinkSync(claudeDest)
        const expected = join(
            '..', '..', '.agents', 'skills', skill
        )
        t.equal(
            target,
            expected,
            `symlink should point to ${expected}`
        )
    }
})

test('setup creates docs/agents/ templates', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    for (const tmpl of DOC_TEMPLATES) {
        const dest = join(
            projectDir, 'docs', 'agents', tmpl
        )
        t.ok(
            existsSync(dest),
            `docs/agents/${tmpl} should be created`
        )
    }
})

test('setup does not overwrite non-tracker docs', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()
    const triagePath = join(
        projectDir, 'docs', 'agents', 'triage-labels.md'
    )
    mkdirSync(join(projectDir, 'docs', 'agents'), {
        recursive:true,
    })
    writeFileSync(triagePath, 'custom triage content')

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const content = readFileSync(triagePath, 'utf8')
    t.equal(
        content,
        'custom triage content',
        'should preserve existing triage-labels.md'
    )
})

test('setup is idempotent', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()
    const opts = {
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        claude:true,
        tracker:'local' as const,
    }

    setup(opts)
    setup(opts)

    for (const skill of SKILL_DIRS) {
        const agentsDest = join(
            projectDir, '.agents', 'skills', skill
        )
        t.ok(
            existsSync(agentsDest),
            `${skill}/ should still exist after second run`
        )

        const claudeDest = join(
            projectDir, '.claude', 'skills', skill
        )
        if (!existsSync(claudeDest)) {
            t.fail(`symlink missing for ${skill}`)
            continue
        }
        const stat = lstatSync(claudeDest)
        t.ok(
            stat.isSymbolicLink(),
            `${skill} symlink should still be valid`
        )
    }

    for (const tmpl of DOC_TEMPLATES) {
        const dest = join(
            projectDir, 'docs', 'agents', tmpl
        )
        t.ok(
            existsSync(dest),
            `docs/agents/${tmpl} should still exist`
        )
    }
})

test('checkGhAuth exists and is callable', t => {
    t.equal(
        typeof checkGhAuth,
        'function',
        'checkGhAuth should be a function'
    )
})

test('setup with tracker:local copies local markdown template', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const trackerPath = join(
        projectDir, 'docs', 'agents', 'issue-tracker.md'
    )
    t.ok(
        existsSync(trackerPath),
        'docs/agents/issue-tracker.md should exist'
    )
    const content = readFileSync(trackerPath, 'utf8')
    t.ok(
        content.includes('# issue-tracker.md'),
        'should copy local markdown template'
    )
})

test('setup with tracker:github copies github template', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'github',
    })

    const trackerPath = join(
        projectDir, 'docs', 'agents', 'issue-tracker.md'
    )
    t.ok(
        existsSync(trackerPath),
        'docs/agents/issue-tracker.md should exist'
    )
    const content = readFileSync(trackerPath, 'utf8')
    t.ok(
        content.includes('# issue-tracker-github.md'),
        'should copy github template'
    )
})

test('setup creates AGENTS.md with local markdown text', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const agentsMdPath = join(projectDir, 'AGENTS.md')
    t.ok(
        existsSync(agentsMdPath),
        'AGENTS.md should exist'
    )
    const content = readFileSync(agentsMdPath, 'utf8')
    t.ok(
        content.includes('local markdown files'),
        'should mention local markdown'
    )
})

test('setup creates AGENTS.md with GitHub Issues text', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'github',
    })

    const agentsMdPath = join(projectDir, 'AGENTS.md')
    t.ok(
        existsSync(agentsMdPath),
        'AGENTS.md should exist'
    )
    const content = readFileSync(agentsMdPath, 'utf8')
    t.ok(
        content.includes('GitHub Issues'),
        'should mention GitHub Issues'
    )
})

test('setup creates AGENTS.md with managed markers when no file exists', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const content = readFileSync(
        join(projectDir, 'AGENTS.md'), 'utf8'
    )
    t.ok(
        content.includes('<!-- nightralph:start -->'),
        'should contain start marker'
    )
    t.ok(
        content.includes('<!-- nightralph:end -->'),
        'should contain end marker'
    )
    t.ok(
        content.includes('Agent skills'),
        'should contain managed content'
    )
})

test('setup appends managed section to existing AGENTS.md without markers', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    const agentsPath = join(projectDir, 'AGENTS.md')
    writeFileSync(agentsPath, '# My Project\n\nCustom instructions.\n')

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const content = readFileSync(agentsPath, 'utf8')
    t.ok(
        content.includes('# My Project'),
        'should preserve existing content'
    )
    t.ok(
        content.includes('Custom instructions.'),
        'should preserve existing instructions'
    )
    t.ok(
        content.includes('<!-- nightralph:start -->'),
        'should append start marker'
    )
    t.ok(
        content.includes('<!-- nightralph:end -->'),
        'should append end marker'
    )
    t.ok(
        content.includes('Agent skills'),
        'should include managed content'
    )
})

test('setup replaces only managed section in existing AGENTS.md', t => {
    const {
        projectDir, bundledSkillsDir, docsTemplatesDir,
    } = makeTempProject()

    const agentsPath = join(projectDir, 'AGENTS.md')
    writeFileSync(agentsPath, [
        '# My Project',
        '',
        'Custom instructions.',
        '',
        '<!-- nightralph:start -->',
        'old managed content',
        '<!-- nightralph:end -->',
        '',
        'More custom content.',
        '',
    ].join('\n'))

    setup({
        bundledSkillsDir,
        docsTemplatesDir,
        projectDir,
        tracker:'local',
    })

    const content = readFileSync(agentsPath, 'utf8')
    t.ok(
        content.includes('# My Project'),
        'should preserve content before markers'
    )
    t.ok(
        content.includes('Custom instructions.'),
        'should preserve instructions before markers'
    )
    t.ok(
        content.includes('More custom content.'),
        'should preserve content after markers'
    )
    t.ok(
        !content.includes('old managed content'),
        'should remove old managed content'
    )
    t.ok(
        content.includes('Agent skills'),
        'should insert new managed content'
    )
})

test(
    'tracker template overwrites when switching trackers',
    t => {
        const {
            projectDir, bundledSkillsDir,
            docsTemplatesDir,
        } = makeTempProject()

        setup({
            bundledSkillsDir,
            docsTemplatesDir,
            projectDir,
            tracker:'local',
        })

        const trackerPath = join(
            projectDir, 'docs', 'agents',
            'issue-tracker.md'
        )
        const localContent = readFileSync(
            trackerPath, 'utf8'
        )
        t.ok(
            localContent.includes('# issue-tracker.md'),
            'should have local template initially'
        )

        setup({
            bundledSkillsDir,
            docsTemplatesDir,
            projectDir,
            tracker:'github',
        })

        const githubContent = readFileSync(
            trackerPath, 'utf8'
        )
        t.ok(
            githubContent.includes('# issue-tracker-github.md'),
            'should overwrite with GitHub template'
        )
        t.ok(
            !githubContent.includes('# issue-tracker.md'),
            'should not contain local template anymore'
        )
    }
)
