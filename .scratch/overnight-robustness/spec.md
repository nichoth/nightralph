# Spec: Overnight Robustness

Status: done
Tickets: `.scratch/overnight-robustness/issues/`

## Problem Statement

An operator who kicks off an overnight nightralph run expects to wake up to a
completed feature. Instead, the run is fragile in ways that only surface when
nobody is watching: a progress commit that throws on a no-op crashes the wave;
an agent that dies before reading its prompt takes down the whole orchestrator
with EPIPE; a timed-out agent leaves orphaned grandchildren holding pipes so
the run never advances; concurrent worktree creation corrupts git refs; a
provider outage burns every retry in seconds; a failed agent's dirty worktree
blocks cleanup; a failed ticket gets re-run (and re-fails) in every later wave;
one ticket throwing kills every sibling in its wave; and Ctrl-C leaves agent
processes running while the terminal is left in a broken ANSI state. Every one
of these turns "run it overnight" into "lose the night."

## Solution

Make a single unattended run self-healing and safely interruptible. Progress
commits become idempotent. Agent lifecycle is contained: stdin errors are
logged, timeouts kill the whole process group, and pipe readers always settle.
Worktree operations are serialized and cleanup is forced. Retries back off
exponentially with a configurable delay, so a transient outage is waited out
rather than exhausted. Failed tickets are recorded once and excluded from
later waves of the same run, while still being picked up tomorrow. Errors
inside one ticket's attempt fail only that ticket. Ctrl-C and SIGTERM stop the
run and kill every agent process, restoring the terminal. Prompts confine
agents to their worktree so a sibling agent can't wander into the live
checkout.

## User Stories

1. As an operator running an overnight batch, I want progress commits that
   already match HEAD to be a no-op, so that re-recording a ticket outcome
   doesn't crash the wave mid-run.
2. As an operator, I want a crash during a progress commit to be logged rather
   than fatal, so that the remaining tickets in the wave still merge.
3. As an operator, I want an agent that exits before reading its prompt to
   resolve as a failed ticket, so that an auth error or bad flag doesn't take
   down the entire orchestrator with an uncaught EPIPE.
4. As an operator, I want stdin errors from agents written to the ticket log,
   so that I can diagnose why an agent died without reproducing the run.
5. As an operator, I want a timed-out agent's entire process group killed, so
   that dev servers or watchers it spawned don't outlive the run.
6. As an operator, I want the agent's output pipes to always settle after
   exit, so that an escaped grandchild holding the pipes can't hang the run
   forever.
7. As an operator, I want concurrent worktree creation to be serialized, so
   that git ref races never fail a ticket before its agent even starts.
8. As an operator, I want a configurable delay between ticket retries, so
   that a provider outage is waited out instead of burning every attempt in
   seconds.
9. As an operator, I want the retry delay to double per attempt, so that
   repeated failures back off instead of hammering the provider.
10. As an operator, I want to disable retry delays entirely, so that test
    runs and local debugging stay fast.
11. As an operator, I want a failed ticket excluded from later waves of the
    same run, so that I don't pay for the same failure three more times
    overnight.
12. As an operator, I want a failed ticket's file to keep its ready status, so
    that tomorrow's run picks it up automatically.
13. As an operator, I want failures recorded in progress.md exactly once, so
    that the morning summary reflects reality.
14. As an operator, I want a throw inside one ticket's attempt to fail only
    that ticket, so that one agent deleting its own worktree doesn't kill the
    siblings in its wave.
15. As an operator, I want failed and stopped worktrees removed even when
    dirty, so that a failed agent's untracked files don't leak worktree
    directories onto disk.
16. As an operator, I want worktree removal after a successful or stopped
    merge to stay unforced, so that genuine dirt at the base checkout is still
    surfaced rather than silently destroyed.
17. As an operator, I want prompts to confine agents to their worktree
    directory, so that an agent can't `cd` into the live checkout through the
    sibling-directory layout.
18. As an operator, I want prompts to forbid `git push` and branch
    deletion/switching, so that agents can't mutate anything outside the run.
19. As an operator, I want Ctrl-C to kill every running agent's process group
    and exit with 130, so that interrupting a run doesn't leave agents working
    in the background.
20. As an operator, I want SIGTERM to behave the same way with exit 143, so
    that process managers can shut a run down cleanly.
21. As an operator, I want the terminal restored (cursor visible, ANSI state
    cleared) after an interrupt, so that my shell isn't left in a broken
    state.
22. As an operator, I want the display to stop installing its own signal
    handlers, so that interrupt semantics live in one place.
23. As an operator, I want a final summary that includes the failed-ticket
    count, so that I know at a glance whether the night was fully clean.
24. As an operator re-running after a failed run, I want stale worktrees and
    leftover branches from the previous attempt cleaned up before new ones are
    created, so that a crashed night doesn't require manual git surgery.
25. As an operator, I want a timed-out agent's work to still be evaluated
    (auto-committed, test-gated, merged if it's good), so that a slow but
    correct agent isn't treated as a failure.
26. As a maintainer, I want every new flag and behavior documented in README
    and the AGENTS.md contracts, so that future sessions don't rediscover
    these guarantees by reading source.

## Implementation Decisions

- **Idempotent progress commits**: `commitProgress` returns a boolean promise
  (committed vs. no-op), detecting the no-op via a quiet diff of the index
  against HEAD before committing. It stages with force so gitignored paths are
  covered. Callers never see a "nothing to commit" throw.
- **Agent stdin guard**: `spawnAgent` installs an error listener on the
  child's stdin before writing the prompt; the listener writes to the log
  stream and never throws.
- **Process-group lifecycle**: agents spawn detached as process-group leaders.
  The timeout kill targets the whole group (falling back to a direct kill).
  After `exit`, a grace timer (2 seconds) destroys the stdio streams — and
  kills the group again first — so the close promise always settles even when
  a grandchild escaped the group and holds a pipe.
- **Agent registry**: a module-level set tracks live agent pids; agents are
  added on spawn and removed on exit. A kill function iterates the set and
  kills each process group, used by both the signal handlers and anything
  that needs to tear down in-flight agents.
- **Serialized worktree ops**: worktree creation and removal go through a
  module-level promise queue so concurrent calls can't race on shared git
  refs. Creation pre-cleans any stale worktree and leftover branch at the
  target name, making re-runs after a failed run safe. Removal accepts a
  force option; the orchestrator forces removal for failed and stopped
  tickets only.
- **Retry backoff**: a pure function computes the per-attempt delay
  (base doubled per retry, starting at the base for the first retry). A
  default constant (30 seconds) applies at the CLI; library calls default to
  no delay so the test suite stays fast. Both in-place and isolated wave
  runners sleep before each retry; dry-run output shows the configured delay.
  Timeouts are not retried — a timed-out agent's work flows through the
  normal new-commits/test-gate/merge path instead.
- **Effort escalation**: each retry for a known provider escalates one rung up
  that provider's effort ladder, starting from high when no level was given,
  clamped at the provider's max.
- **Failed-ticket exclusion**: wave runners keep a per-run set of failed
  ticket numbers, populated on terminal failure outcomes (worktree error,
  throw, no commits, exhausted retries — but not a merge conflict handled by
  strategy), and filter ready tickets against it. Ticket files keep their
  ready status; only progress.md records the failure. The final summary line
  reports the failed count.
- **Error containment**: a per-ticket outcome union gains an error variant.
  Each attempt is wrapped so a throw anywhere in the attempt (dirty checks,
  commit detection, agent deleting its own worktree) produces an error outcome
  for that ticket rather than rejecting the wave's parallel promise.
- **Prompt confinement**: both the standard and merge-conflict prompts carry
  explicit rules: work only inside the current directory, never `git push`,
  never switch or delete branches.
- **Signal handling ownership**: signal handling moves out of the display into
  the CLI, which installs SIGINT/SIGTERM handlers that kill all tracked
  agents, run display cleanup to restore the terminal, and exit with the
  conventional codes (130/143). The display no longer installs or removes
  process-level signal handlers.
- **Documentation**: README covers the retry-delay flag, backoff, signal
  handling, process groups, `.scratch` gitignore guidance, timeout
  recommendations, and the pi provider's approval flag. AGENTS.md contracts
  are updated for every changed module, with the verification date refreshed.

## Testing Decisions

- A good test observes external behavior only: what a spawned agent process
  resolves to, what a git operation does to a real repository, what exit code
  a CLI invocation produces — never internal call ordering or private state.
- **Agent lifecycle** is tested through the highest seam: real mock-agent
  scripts (exit before reading stdin, spawn a grandchild that hangs holding
  the pipes, hang forever, dirty files then exit non-zero, delete its own
  worktree) run through the actual spawn path, asserting resolved exit codes,
  timing, and that grandchildren are killed. Prior art: the orchestrator and
  display integration tests.
- **Git behavior** is tested against real repositories in temp directories:
  concurrent worktree creation rounds, force-removal of dirty worktrees,
  no-op progress commits returning false. Prior art: the worktree, progress,
  and merge test suites.
- **CLI behavior** is tested by invoking the built CLI as a subprocess with
  flags (`--retry-delay 0` to keep retry tests fast) and by delivering real
  signals to a run with a hanging mock agent, asserting the agent tree dies
  and the exit code. Prior art: the integration test suite.
- **Pure logic** (delay math, effort escalation, prompt rule text) is unit
  tested directly. Prior art: orchestrator unit tests.

## Out of Scope

- Parallel-wave dependency resolution beyond the existing readiness model.
- Any change to the provider CLIs themselves (claude, codex, pi) or their
  flag surfaces beyond what the orchestrator already forwards.
- Persisting retry/effort history across runs beyond the single progress.md
  record of the final attempt.
- Automatic re-queueing of failed tickets within the same run.
- Merge-conflict strategy changes beyond the existing respawn/stop options.
- Windows support for process groups and signals.

## Further Notes

- The worktree layout makes worktrees siblings of the repo root — this is why
  prompt confinement matters: without it, `cd ../<repo>` reaches the live
  checkout.
- A timed-out agent is deliberately not a failure: its worktree is kept, dirty
  changes auto-committed, and the branch goes through the same merge path as
  an exit-0 agent. The timeout exists to bound the night, not to judge the
  work.
- `killProcessGroup` sends SIGKILL to the negative pid (the group); the direct
  kill fallback covers platforms or races where the group signal misses.
- Ticket 11 (documentation) is blocked by all others; tickets 08 and 10 depend
  on earlier tickets (01; 03; 05, 08 respectively). Everything else can start
  immediately.
