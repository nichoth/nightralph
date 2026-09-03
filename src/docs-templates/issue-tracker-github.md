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
