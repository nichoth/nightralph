# 06: The prompt confines the agent to its worktree

**What to build:** `renderPrompt` and `renderMergePrompt` gain rules telling the agent to work only inside its current directory (the worktree) and to never run `git push` or switch/delete branches. Worktrees are siblings of the repo, so without this an agent can `cd ../<repo>` into the live checkout.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `renderPrompt` includes rules about staying in the current directory and not running `git push`
- [x] `renderMergePrompt` includes a rule against `git push`
- [x] Tests verify both prompts contain the expected rule text
