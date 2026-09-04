# 04: Worktree creation is serialized

**What to build:** Concurrent `createWorktree` calls race inside git and occasionally fail on half-written ref entries. The function should queue calls module-wide and run them one at a time, keeping its existing signature and return type.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The existing `createWorktree` body moves to a private `createWorktreeNow`
- [ ] A module-level promise queue serializes calls through `enqueue()`
- [ ] A test runs 50 concurrent `createWorktree` calls across 5 rounds with zero failures
