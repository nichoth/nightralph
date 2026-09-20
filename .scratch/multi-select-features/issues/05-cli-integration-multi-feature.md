# 05: CLI integration: multi-feature orchestration

**What to build:** `runExecute` handles the array return from
`resolveIssuesDir`, merges tickets from all selected features
into one unified pool with their `feature` fields populated,
looks up the correct `spec.md` content per ticket, and passes
compound-identity-aware data through `runWaves` /
`runWavesIsolated`. Internal maps in the orchestration loop
(`failedNums`, `ticketsByNum`, `worktreePathsByNum`,
`readyNums`) switch to compound `feature:num` string keys.
`--dry-run` shows the unified wave plan across all selected
features. The end-to-end flow of selecting multiple features,
running agents concurrently across them, and merging branches
back works.

**Blocked by:** 01: Ticket compound identity and feature-prefixed
branch naming, 02: Multi-select resolveIssuesDir,
03: Display feature/num prefix,
04: Per-feature finish summary and progress tracking

**Touches:** `src/index.ts` (`runExecute`),
`src/orchestrator.ts` (`runWaves`, `runWavesIsolated`,
`runTicketAttempts`, `runTicketAttempt`, `dryRun`,
`dryRunIsolated`, internal map types)

**Status:** ready-for-agent

- [x] `runExecute` iterates the array from `resolveIssuesDir`, scans tickets per feature, and merges them into one pool
- [x] Each ticket in the pool carries the correct `feature` and its spec body is looked up from the feature's `spec.md`
- [x] `runWaves` and `runWavesIsolated` use compound `feature:num` keys for `failedNums`, `ticketsByNum`, `worktreePathsByNum`, and `readyNums`
- [x] `--dry-run` prints the unified wave plan with feature-prefixed branch names and worktree paths across all selected features
- [x] Per-feature progress files are written to the correct `.scratch/<feature>/progress.md` path
- [x] `startWave` and `setTicketStatus` calls pass feature information to the display
