# Issue tracker: GitHub

Issues and specs for this repo live as GitHub Issues, managed via the `gh` CLI.

## Conventions

- One feature per GitHub issue milestone (optional, for grouping)
- Specs are tracked as issues with label `spec`
- Implementation issues are tracked as GitHub issues, one per task
- Triage state is recorded via issue labels (see `triage-labels.md` for the role strings)
- Comments and conversation history are on the GitHub issue thread
- Use task lists in issue bodies for sub-tasks that don't warrant separate issues

## Prerequisites

Install the `gh` CLI: https://cli.github.com

Authenticate with your GitHub account:

```bash
gh auth login
```

Verify authentication:

```bash
gh auth status
```

## Basic Operations

### Create an issue (publish to tracker)

```bash
gh issue create --title "Issue title" --body "Issue description"
```

For an issue with labels:

```bash
gh issue create --title "Fix login bug" --body "Users see 404 on login page" --label "bug,p0"
```

### View an issue (fetch the relevant ticket)

```bash
gh issue view <number>
```

Example:

```bash
gh issue view 42
```

### List issues

Show all open issues:

```bash
gh issue list
```

Show issues with a specific label:

```bash
gh issue list --label "bug"
```

Show issues assigned to you:

```bash
gh issue list --assignee "@me"
```

### Add a comment

```bash
gh issue comment <number> --body "Comment text"
```

### Close an issue

```bash
gh issue close <number>
```

To close with a comment:

```bash
gh issue close <number> --comment "Resolved in PR #99"
```

### Reopen an issue

```bash
gh issue reopen <number>
```

## Label Management

### Apply labels

Add a label to an existing issue:

```bash
gh issue edit <number> --add-label "in-progress"
```

### Remove labels

Remove a label from an issue:

```bash
gh issue edit <number> --remove-label "blocked"
```

### View available labels

```bash
gh label list
```

## When a skill says "publish to the issue tracker"

Create a new GitHub issue:

```bash
gh issue create --title "..." --body "..." --label "..."
```

Then note the issue number for reference.

## When a skill says "fetch the relevant ticket"

View the issue:

```bash
gh issue view <number>
```

The user will normally pass the issue number.

## Wayfinding Operations

Used by `/wayfinder` and similar domain-driven agents. GitHub Issues uses native features for navigation:

- **Map**: A pinned issue or GitHub project that lists related issues as task items
- **Child issues**: Related issues linked via GitHub issue dependencies (see below)
- **Blocking**: Use GitHub issue dependencies to mark blocking relationships
- **Frontier**: Query with `gh issue list --state open --assignee "" --label "available"`
- **Claim**: Assign the issue to yourself with `gh issue edit <number> --add-assignee "@me"`
- **Resolve**: Close the issue and link to context (PR, gist, decision record) in the final comment

## Blocking and Dependencies

### Mark as blocked

Add the `blocked` label and optionally a comment referencing the blocking issue:

```bash
gh issue edit <number> --add-label "blocked"
gh issue comment <number> --body "Blocked by #42"
```

### Link related issues

Use issue references in comments and body text. GitHub auto-links:

```bash
# In an issue comment or body, write:
Relates to #123
Depends on #456
Blocks #789
Fixed in #999
```

These create bidirectional links visible in the issue UI.

### Check if unblocked

Query the blocking issues referenced in the issue's comments or description. An issue is unblocked when no blocking issues remain open.

## Frontier Query and Workflow

### Find available issues

Query for open, unassigned issues:

```bash
gh issue list --state open --assignee "" --label "available,p0" --json number,title
```

### Claim an issue

Assign to yourself when starting work:

```bash
gh issue edit <number> --add-assignee "@me"
```

Optionally add `in-progress` label:

```bash
gh issue edit <number> --add-label "in-progress"
```

### Resolve an issue

Work through the issue in a PR. When done, close the issue and link the PR:

```bash
gh issue close <number> --comment "Resolved in PR #999"
```

Alternatively, create a closing comment with a reference:

```bash
gh issue comment <number> --body "Fixed in PR #999"
gh issue close <number>
```

## Tips

- Use GitHub milestones to group related features
- Use `gh issue create --web` to open the issue creation form in your browser
- Use `gh issue edit <number> --web` to open an issue in the browser for complex edits
- Save frequently-used queries as saved views in the GitHub web UI
