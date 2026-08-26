# night-ralph

A minimal Node-based "Ralph-style" orchestrator that selects a single child issue for a PRD, invokes an agent CLI once with a combined PRD+issue prompt, then verifies the issue state.

This package is a small starting point — it intentionally keeps dependencies to a minimum and mirrors the selection behavior from Shaurya-Sethi/nightshift (parent/blocked-by parsing, ready-for-agent label).

## Quickstart

Prerequisites:
- Node 18+ and npm
- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
- An agent CLI available on PATH (default: `claude`).

Install (local):

```bash
# clone or download the zip
node bin/ralph.js --help
```

Usage:

```bash
# Dry run to inspect prompt
node bin/ralph.js --prd 12 --repo myorg/myrepo --dry-run

# Run against repo with the claude agent
node bin/ralph.js --prd 12 --repo myorg/myrepo --agent claude --model claude-sonnet-4-6
```

Notes:
- Issues are filtered by the `ready-for-agent` label and must include a `## Parent` section with the PRD number to be considered.
- Blockers are read from a `## Blocked by` section; the script skips issues with open blockers.
- After the agent exits, the script checks whether the selected issue is closed.

## Files
- `bin/ralph.js` - main CLI
- `package.json` - package manifest

## Licensing
MIT
