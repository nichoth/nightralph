# Correctness audit

Date: 2026-08-29

## Scope

This audit reviewed the CLI implementation, Git and worktree behavior,
dependency handling, progress tracking, package metadata, test coverage,
and `README.md` as the primary user guide.

No source files were changed during the audit.

## Result

The repository is not release-ready. The high-level purpose is visible in
the README, but its setup and execution instructions do not describe a
working, safe path through the current implementation.

| Area | Score |
| --- | ---: |
| Core execution | 1/4 |
| Git safety | 1/4 |
| Dependencies and progress | 2/4 |
| Runtime compatibility | 1/4 |
| README and operability | 2/4 |
| **Total** | **7/20** |

Rating: Poor

## Findings

### P0: Installed setup resolves assets from the npm bin directory

Location:

- [`src/index.ts`](../../src/index.ts#L24)
- [`package.json`](../../package.json#L6)
- [`README.md`](../../README.md#L42)

The CLI derives its bundled asset directory from `process.argv[1]`. When npm
invokes the executable through `node_modules/.bin/nightralph`, that value is
the symlink path. The CLI therefore looks for `.bin/skills` and
`.bin/docs-templates`, neither of which exists.

This blocks the first setup command documented in the README. The asset path
should come from `import.meta.url`, which identifies the installed module
instead of its invocation symlink.

### P0: Successful agents can lose their work

Location:

- [`src/orchestrator.ts`](../../src/orchestrator.ts#L125)
- [`src/orchestrator.ts`](../../src/orchestrator.ts#L595)
- [`src/orchestrator.ts`](../../src/orchestrator.ts#L642)

An agent exit code of zero makes its branch eligible for merging. The prompt
does not require a commit, and the orchestrator does not commit or verify the
agent's working tree. An unchanged branch can therefore merge successfully,
after which the ticket is marked `done`.

A reproduction created an uncommitted file in the agent worktree. The base
branch never received the file, but the ticket became `done`. Worktree removal
then failed because the worktree was dirty.

The orchestrator should verify that the agent produced committed changes and
that the worktree is clean before it marks a ticket complete. It must preserve
and clearly report any uncommitted work.

### P1: Documented providers lack non-interactive adapters

Location:

- [`src/orchestrator.ts`](../../src/orchestrator.ts#L223)
- [`README.md`](../../README.md#L107)

`spawnAgent` executes the provider name with an optional `--model` argument.
Codex requires its `exec` subcommand for non-interactive operation. Claude
documents `--print` for non-interactive operation. The provider positional
argument cannot include a subcommand because it is passed as one executable
name.

The documented Claude and Codex examples therefore do not define reliable
invocations. The CLI needs explicit provider adapters or a command and
argument configuration that can represent each provider correctly.

### P1: Progress commits include unrelated staged changes

Location:

- [`src/progress.ts`](../../src/progress.ts#L103)
- [`src/orchestrator.ts`](../../src/orchestrator.ts#L531)

`commitProgress` stages the progress file and then runs an unrestricted
`git commit`. Any files already staged by the user are included in that
commit.

A reproduction staged `user-change.txt` before calling `commitProgress`.
The resulting progress commit contained both `progress.md` and
`user-change.txt`.

Progress commits should limit the commit to the progress path. The CLI should
also check repository state before it begins an isolated run.

### P1: Dependency validation can run tickets out of order

Location:

- [`src/orchestrator.ts`](../../src/orchestrator.ts#L101)
- [`src/index.ts`](../../src/index.ts#L183)
- [`test/integration.test.ts`](../../test/integration.test.ts#L356)

`findReadyTickets` treats every status other than `ready-for-agent` as
completed. A blocker with `needs-info`, `ready-for-human`, or `wontfix` can
therefore unlock dependent work.

The CLI also warns about unknown blocker numbers and then removes them. The
ticket becomes runnable even though the dependency cannot be shown to have
completed. The integration suite explicitly expects this behavior.

Only a completed status should satisfy a dependency. Duplicate and unknown
ticket numbers should fail validation before any agents start.

### P1: Failed runs exit successfully

Location:

- [`src/orchestrator.ts`](../../src/orchestrator.ts#L488)
- [`src/orchestrator.ts`](../../src/orchestrator.ts#L744)
- [`src/index.ts`](../../src/index.ts#L226)

Both execution paths report agent failures but return normally. A reproduction
produced an agent exit code of 1 and a nightralph process exit code of 0.

Shell scripts, CI, and overnight monitoring cannot distinguish a completed run
from an incomplete one. The command should return a nonzero status when any
ready ticket fails, remains blocked by an execution failure, or cannot merge.

### P1: The advertised Node 18 support is false

Location:

- [`package.json`](../../package.json#L9)
- [`package-lock.json`](../../package-lock.json#L872)
- [`package-lock.json`](../../package-lock.json#L3365)

The package declares Node 18 support. The installed Inquirer version requires
Node 20.17 or newer, and yargs requires Node 20.19 or newer. Running the CLI
under Node 19 produced a syntax error, so the advertised Node 18 range cannot
work.

The project must either raise its engine requirement or select dependencies
that support Node 18. CI should test every advertised runtime line.

### P1: The README claims unsupported GitHub execution

Location:

- [`README.md`](../../README.md#L8)
- [`src/index.ts`](../../src/index.ts#L160)
- [`src/setup.ts`](../../src/setup.ts#L42)

The README says the orchestrator reads local markdown tickets or remote GitHub
issues. Execution always resolves a local `.scratch/<feature>/issues/`
directory and calls `scanTickets` on it.

Choosing GitHub during setup installs GitHub tracker instructions for skills.
It does not add a GitHub issue source to the orchestrator. The README should
distinguish ticket creation from ticket execution until a remote issue adapter
exists.

### P1: Setup silently replaces the target project's AGENTS.md

Location:

- [`src/setup.ts`](../../src/setup.ts#L133)
- [`src/setup.ts`](../../src/setup.ts#L151)
- [`README.md`](../../README.md#L44)

Setup writes a new `AGENTS.md` without preserving existing instructions or
creating a backup. The README describes setup as copying skills and templates,
but does not warn that it replaces this file.

Setup should merge a managed section or require confirmation before replacing
an existing file. The README must describe the behavior clearly.

## Secondary findings

### P2: Existing completed tickets start unchecked in progress output

[`generateProgress`](../../src/progress.ts#L24) initializes every ticket with
`done: false`, regardless of its parsed status. A resumed run therefore shows
previously completed tickets as incomplete.

### P2: Failed worktrees prevent a straightforward retry

Failed or conflicted worktrees are retained. A later run attempts to create the
same branch and worktree path, which causes `git worktree add -b` to fail.
There is no resume behavior, cleanup command, or recovery guidance in the
README.

### P2: README paths and option coverage are inaccurate

The README names `./claude/skills/` and `./agents.skills/`. The implementation
uses `.agents/skills/` by default and optionally creates `.claude/skills/`
symlinks when setup receives `--claude`.

The local `skills/upstream.json` link is broken because the repository stores
the source at `src/skills/upstream.json`. The flags table also omits `-X`.

### P2: The npm package contains development artifacts

`npm pack --dry-run` reported 140 files and an unpacked size of about 995 KB.
The package contains sources, tests, source maps, implementation plans, WIP
files, logs, and local tool settings. The runtime package should include the
CLI output, bundled skills, templates, license, README, and package metadata.

## Test coverage assessment

The baseline checks are green:

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed all 303 tests.

The suite does not cover the highest-risk installed behavior:

- It does not install a packed artifact and invoke setup through the npm bin
  symlink.
- The isolated-agent success mock exits without making or committing code
  changes, so the tests accept a no-op merge as completed work.
- It does not verify that progress commits exclude existing staged files.
- It does not test real provider command construction.
- It expects unknown blockers to be removed.
- It does not assert a nonzero CLI status for an incomplete run.
- It does not run the CLI on every advertised Node version.

## Positive findings

- The source builds cleanly under the current development runtime.
- Lint passes, and TypeScript source lines follow the repository's line-length
  agreement.
- Wave scheduling, basic parsing, worktree naming, rebasing, merge conflicts,
  and progress rendering have unit or integration coverage.
- Dry-run output shows wave order, branch names, worktree paths, and the first
  prompt without changing ticket files.
- The external `to-tickets` reference is live and agrees with the documented
  local `.scratch/<feature>/issues/<NN>-<slug>.md` layout.

## Recommended order of work

1. Fix installed asset resolution and add a packed-package setup test.
2. Define provider-specific non-interactive command adapters.
3. Require and verify committed agent changes before merging or marking done.
4. Isolate progress commits from the user's Git index.
5. Validate statuses, ticket numbers, and dependency references before work.
6. Return nonzero status for incomplete runs and document recovery behavior.
7. Align the Node engine range with runtime dependencies and CI.
8. Preserve existing project instructions during setup.
9. Rewrite the README against the corrected behavior.
10. Limit the published package contents.
