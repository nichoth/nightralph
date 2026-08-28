# Phase 2: Future Work -- Orchestrator GitHub Support

## Goal

Enable `nightralph <provider>` to pull tickets from GitHub Issues instead of `.scratch/` when the project is configured for GitHub tracking. This allows teams to use GitHub Issues as a native issue tracking system while leveraging nightralph's orchestrator for workflow execution.

## Overview

Phase 1 established the choice between local markdown and GitHub Issues for issue tracking. Phase 2 extends the orchestrator (`src/orchestrator.ts`) to support GitHub-backed issues, enabling end-to-end integration from issue discovery through status updates.

## Changes Required in the Orchestrator

### Tracker Detection

The orchestrator needs to detect which tracker is in use by reading the title line from `docs/agents/issue-tracker.md`:

- If title is `# Issue tracker: GitHub`, use GitHub mode
- If title is `# Issue tracker: Local Markdown`, use local mode (current behavior)

### Scan Tickets (`scanTickets()` function)

Currently, `scanTickets()` reads `.scratch/<feature>/issues/` for numbered markdown files.

**GitHub variant:**
- Query `gh issue list --json number,title,body,labels,state --label <feature>` to retrieve issues
- Parse JSON output into ticket objects
- Handle pagination if needed

**Local variant:**
- Keep existing implementation (reads markdown files)

### Status Parsing

Currently, the orchestrator reads `Status:` lines from markdown files.

**GitHub variant:**
- Map GitHub labels to status: look for labels like `status-pending`, `status-in-progress`, `status-done`, `status-blocked`
- Extract status from issue label set

**Local variant:**
- Keep existing implementation (reads markdown Status: field)

### Blocker Parsing

Currently, the orchestrator reads `Blocked by:` lines from markdown files.

**GitHub variant:**
- Query issue dependencies via `gh api repos/{owner}/{repo}/issues/{issue_number}/blocking_issues_and_pull_requests`
- Extract blocker relationships from API response

**Local variant:**
- Keep existing implementation (reads markdown Blocked by: field)

### Status Updates

Currently, when a wave completes, the orchestrator writes `Status: done` to the markdown file.

**GitHub variant:**
- Run `gh issue close <issue_number>` to close the issue
- Optionally add a comment or label to mark completion

**Local variant:**
- Keep existing implementation (writes to markdown file)

## CLI Surface Changes

The `--dir` and `--spec` flags assume local file-based issues. GitHub mode requires different scoping mechanisms:

### New Flags for GitHub Mode

- `--label <label>` -- filter issues by GitHub label (e.g., `nightralph`, `phase-1`)
- `--milestone <milestone>` -- filter issues by GitHub milestone
- `--assignee <user>` -- filter issues assigned to a specific user

### Feature Selection

The `resolveIssuesDir` function in `index.ts` currently prompts for a local feature directory. A GitHub-aware variant would:

1. Query `gh issue list --label nightralph --json labels` to discover available labels
2. Prompt user to select which label(s) to execute
3. Optional: support milestone selection if `--milestone` is not specified

## Testing Considerations

### Test Strategy

GitHub orchestrator tests need to handle the challenge of testing against external API calls:

**Option 1: Mocked `gh` Output**
- Mock the `gh` command output using standard test mocking patterns
- Provide fixed JSON fixtures for different issue scenarios
- Tests run fast and require no network access

**Option 2: Test Repository**
- Set up a dedicated test GitHub repository
- Run integration tests against real GitHub Issues
- More realistic but slower and requires GitHub API rate-limit budget

**Option 3: Hybrid Approach**
- Unit tests with mocked `gh` output for core logic
- Optional integration tests with test repository for end-to-end validation
- Recommended for this project

### Execution Model Remains Unchanged

The wave-based execution model (parallel independent tickets, sequential blocked ones) stays the same. GitHub mode only changes the I/O layer for reading and writing issue state.

## Implementation Phases

### Phase 2a: Tracker Detection
- Add function to detect active tracker from `docs/agents/issue-tracker.md`
- Route `scanTickets()` based on detection

### Phase 2b: GitHub Scan and Parse
- Implement `scanTicketsFromGitHub()` function
- Add status and blocker parsing for GitHub labels and API calls
- Add error handling for `gh` CLI availability and authentication

### Phase 2c: GitHub Status Updates
- Implement status update logic for GitHub Issues
- Handle issue closing and labeling

### Phase 2d: CLI and UX
- Add `--label` and `--milestone` flags
- Implement GitHub-aware feature selection prompt
- Add documentation for GitHub workflow

### Phase 2e: Testing
- Write unit tests with mocked `gh` output
- Optional: add integration tests with test repository
- Verify backward compatibility with local markdown mode

## Dependencies

- `gh` CLI must be installed and authenticated
- GitHub repository must be configured in current git remote
- Existing test infrastructure (@substrate-system/tapzero, temp directories)

## Backward Compatibility

- Local markdown mode continues to work without changes
- Projects using local markdown issue tracking are unaffected
- The orchestrator can serve projects with either tracker type
- No breaking changes to existing CLI surface for local mode
