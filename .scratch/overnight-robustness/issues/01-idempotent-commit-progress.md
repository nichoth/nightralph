# 01: commitProgress skips an unchanged file

**What to build:** When the orchestrator records the same outcome for a ticket more than once (e.g. a ticket that fails again in a later wave), `commitProgress` should detect that the staged progress file matches HEAD and return `false` instead of throwing `nothing to commit`. This prevents a crash mid-wave that leaves other tickets in the wave unmerged.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `commitProgress` returns `Promise<boolean>` -- `true` when a commit was made, `false` when the file is unchanged
- [x] Uses `git diff --cached --quiet` to detect a no-op before attempting the commit
- [x] A test commits progress, writes identical content, and verifies the second call returns `false` without throwing
