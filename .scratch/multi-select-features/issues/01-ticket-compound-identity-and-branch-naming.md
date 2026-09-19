# 01: Ticket compound identity and feature-prefixed branch naming

**What to build:** The `Ticket` type gains a `feature:string` field
that identifies which feature directory a ticket came from.
`scanTickets` accepts a feature name parameter and populates it on
every ticket it returns. All identity-based lookups in pure
orchestrator functions -- `findReadyTickets`, `simulateWaves`,
`detectDeadlocks` -- switch from bare `num` to compound
`feature:num` keys so that two features with overlapping ticket
numbers do not collide. `buildBranchName` always returns
`<repo>--<feature>-<num>-<slug>` (breaking change from
`<repo>--<num>-<slug>`). Worktree sibling directories follow
suit: `<repo>.<feature>-<num>-<slug>`.

**Blocked by:** None (can start immediately)

**Touches:** `src/orchestrator.ts` (`Ticket` type, `scanTickets`,
`findReadyTickets`, `simulateWaves`, `detectDeadlocks`),
`src/worktree.ts` (`buildBranchName`, `createWorktreeNow`),
`test/orchestrator.test.ts`, `test/worktree.test.ts`

**Status:** ready-for-agent

- [x] `Ticket` type has a `feature:string` field
- [x] `scanTickets` accepts a `feature` parameter and sets it on every returned ticket
- [x] `buildBranchName` returns `<repo>--<feature>-<num>-<slug>` for any ticket
- [x] `createWorktreeNow` creates worktrees at `<repo>.<feature>-<num>-<slug>` sibling paths
- [x] `findReadyTickets` uses compound `feature:num` identity so overlapping numbers across features do not unblock each other
- [x] `simulateWaves` and `detectDeadlocks` use compound identity
- [x] Existing worktree tests updated for the new branch name format
- [x] New orchestrator test: `findReadyTickets` with two features sharing ticket number 01 -- completing feature-A/01 does not unblock feature-B/02 that depends on feature-B/01
