# 02: An agent that exits before reading stdin cannot crash the run

**What to build:** When a CLI agent exits immediately (auth error, bad flag) before reading its prompt from stdin, `spawnAgent` should resolve with `{ exitCode:1, timedOut:false }` instead of crashing the orchestrator process with an uncaught EPIPE. A `proc.stdin.on('error')` listener logs the error to the agent's log file.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `spawnAgent` installs an error listener on `proc.stdin` before writing the prompt
- [x] The listener writes the error to the log stream, never throws
- [x] A mock agent that exits without reading stdin, paired with a 2 MB prompt, resolves cleanly with exit code 1
