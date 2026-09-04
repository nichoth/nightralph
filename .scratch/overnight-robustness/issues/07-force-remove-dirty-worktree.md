# 07: A failed attempt's worktree is removed even when dirty

**What to build:** `removeWorktree` accepts an optional `{ force?:boolean }` parameter and passes `--force` to git when set. The orchestrator's `removeWorktreeQuietly` always passes `{ force:true }` so a failed agent that left modified or untracked files doesn't prevent worktree cleanup. The two `removeWorktree` calls after a successful or stopped merge remain unforced.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `removeWorktree` signature becomes `(path, opts?:{ force?:boolean })`
- [ ] `removeWorktreeQuietly` in the orchestrator passes `{ force:true }`
- [ ] A unit test creates a worktree, writes an untracked file, and verifies force-removal succeeds
- [ ] An integration test runs a mock agent that leaves files behind and exits 1, then verifies the worktree is gone
