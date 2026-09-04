# 03: The timeout kill takes the agent's process group and always resolves

**What to build:** Agents spawn with `detached:true` in their own process group. The timeout kill sends SIGKILL to the entire group (`-proc.pid`) so children like dev servers or watchers die with the agent. A fallback destroys stdout/stderr 2 seconds after `exit` so the `close` promise always settles, even when a grandchild escaped the group and still holds the pipes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `spawn` call uses `detached:true`
- [ ] `killProcessGroup(proc)` sends SIGKILL to `-proc.pid`, falling back to `proc.kill('SIGKILL')`
- [ ] An `exit` handler destroys stdio after `CLOSE_GRACE_MS` (2000 ms)
- [ ] A mock agent that spawns a long-lived child sharing stdio resolves within a few seconds of the timeout, and the child process is killed
