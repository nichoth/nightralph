# 09: Ctrl-C and SIGTERM stop the run and the agents

**What to build:** Signal handling moves from the display to the CLI. `StatusDisplay` no longer installs SIGINT/SIGTERM handlers (which had the side effect of removing Node's default exit). The CLI installs handlers that call a new `killRunningAgents()` function (which kills the process group of every agent `spawnAgent` started that hasn't closed), restore the cursor via `display.cleanup()`, and exit with 130 (SIGINT) or 143 (SIGTERM).

**Blocked by:** 03: The timeout kill takes the agent's process group and always resolves.

**Status:** done

- [x] `StatusDisplay.startWave` no longer registers signal handlers
- [x] `StatusDisplay.cleanup` no longer removes signal handlers
- [x] `runningAgents` set tracks live agent processes in the orchestrator
- [x] `killRunningAgents()` is exported, kills all tracked agents' process groups, returns count
- [x] `spawnAgent` adds/removes agents from the registry on spawn/close
- [x] The CLI installs SIGINT/SIGTERM handlers that kill agents and exit
- [x] A display test verifies no signal handlers are added by `startWave`
- [x] A CLI test verifies SIGINT kills the agent process tree and exits
