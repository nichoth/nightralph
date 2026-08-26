# night-ralph

A minimal Node-based "Ralph-style" orchestrator that now supports both GitHub issue mode and a local Markdown ticket mode compatible with Matt Pocock's `to-tickets` local output.

Local mode highlights

- Provide `--local-dir ./tickets` and either `--prd-file ./tickets/PRD.md` or create `PRD.md` in the directory.
- The tool reads all `*.md` files (excluding the PRD file) and treats them as child tickets.
- It matches child tickets to the PRD by looking for a `## Parent` section that contains the PRD filename or PRD title, or by a numeric `#<number>` if you also use GitHub numbering.
- Blockers are read from `## Blocked by` and can reference other ticket filenames (e.g. `other-ticket.md`). If a blocker file is present and not moved to `done/`, the ticket is considered blocked.
- Successful agent runs (exit code 0) move the processed ticket to `<local-dir>/done/`. Prompts and agent logs are saved to `<local-dir>/prompts/` and `<local-dir>/logs/` respectively.

Usage examples

Local mode:

```bash
node bin/ralph.js --local-dir ./tickets --prd-file ./tickets/PRD.md --agent claude --model claude-sonnet-4-6

# Dry run
node bin/ralph.js --local-dir ./tickets --prd-file ./tickets/PRD.md --dry-run
```

GitHub mode (unchanged):

```bash
node bin/ralph.js --prd 12 --repo myorg/myrepo --agent claude --model claude-sonnet-4-6
```
