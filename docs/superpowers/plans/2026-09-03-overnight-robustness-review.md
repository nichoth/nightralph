# Adversarial review of the overnight robustness plan

Reviewed 2026-09-03 at local `main` commit `2ac5820`.

The plan needs revision before implementation. Three process-lifecycle gaps
can still leave child processes running or allow Git worktree operations to
race. Four other defects weaken progress reporting, cleanup, prompt guidance,
and dry-run accuracy.

## Findings

### 1. High: signals can orphan a running test gate

The shutdown registry tracks only agents
([plan, line 969](2026-09-03-overnight-robustness.md#L969)). The signal
handler then exits immediately
([plan, line 991](2026-09-03-overnight-robustness.md#L991)).

Test gates also run in detached process groups
([testcmd.ts, line 34](../../../src/testcmd.ts#L34)). If SIGINT or SIGTERM
arrives after the agent exits but while its test gate is running,
`runningAgents` is empty. The CLI exits and leaves the detached test process
and its children alive.

Use one subprocess registry for agents and test gates. Add SIGINT and SIGTERM
tests that signal the CLI during the test-gate phase.

### 2. High: worktree mutation is only partly serialized

Task 5 queues `createWorktree`
([plan, line 828](2026-09-03-overnight-robustness.md#L828)). Task 10 still
runs `git worktree remove` outside that queue
([plan, line 1581](2026-09-03-overnight-robustness.md#L1581)).

Ticket attempts remain concurrent. A fast failure can remove one worktree
while a queued creation is pruning metadata, deleting a branch, or adding
another worktree. That preserves the shared `.git/worktrees` race that Task 5
is supposed to remove.

Put every worktree metadata mutation through one queue per repository. Add a
deterministic test that mixes creation, removal, and retry. The proposed test
explicitly permits a pass without reproducing the race
([plan, line 814](2026-09-03-overnight-robustness.md#L814)).

### 3. High: a normally exiting agent can leave its children alive

The timeout callback does nothing after the agent exits
([plan, line 718](2026-09-03-overnight-robustness.md#L718)). The exit fallback
only destroys the stdout and stderr streams
([plan, line 732](2026-09-03-overnight-robustness.md#L732)). It never kills
the remaining process group.

An agent can start a dev server and then exit successfully. The fallback makes
`spawnAgent` settle, but the server keeps running. The process registry also
drops the group when `close` fires.

When the grace period expires, kill the original process group before
destroying the streams. Add a mock agent that starts a child and exits zero.

### 4. Medium: several failures never reach progress.md

The design says `progress.md` records an exhausted failure
([plan, line 65](2026-09-03-overnight-robustness.md#L65)). Task 2 adds
`failedNums` for `worktree-error`, `no-commits`, and `failed`
([plan, line 436](2026-09-03-overnight-robustness.md#L436)). Its progress
changes cover only the existing failed, done, respawned, and merge-failed
writes.

Task 8 has the same omission. Its new `error` branch updates the display and
continues without updating progress
([plan, line 1353](2026-09-03-overnight-robustness.md#L1353)).

Call `checkTicket` and `saveProgress` for every terminal failure. Extend the
outcome data when progress needs a branch name or exit code.

### 5. Medium: final no-commit and error attempts can leak worktrees

Task 10 only strengthens calls already made through
`removeWorktreeQuietly`
([plan, line 1458](2026-09-03-overnight-robustness.md#L1458)). The current
no-commit path returns without cleanup
([orchestrator.ts, line 1142](../../../src/orchestrator.ts#L1142)). Task 8's
`error` outcome also discards the worktree path.

Final no-commit and error attempts can therefore leave directories, branches,
or stale worktree metadata behind. Carry `worktreePath` and `branchName` in
these outcomes and force-clean them before a retry or terminal return.

### 6. Medium: merge agents do not receive the worktree restriction

The normal prompt says to remain in the current directory
([plan, line 1422](2026-09-03-overnight-robustness.md#L1422)). The merge
prompt only forbids `git push`
([plan, line 1429](2026-09-03-overnight-robustness.md#L1429)).

A merge-conflict respawn has the same access to the sibling checkout. Apply
the same directory and branch rules to both prompt variants, and test both.
The title should describe these rules as guidance, not confinement, unless the
implementation adds an operating-system sandbox.

### 7. Low: library dry-run reports the wrong retry default

The design sets the library default to zero seconds
([plan, line 67](2026-09-03-overnight-robustness.md#L67)). The planned
`dryRunIsolated` output falls back to `DEFAULT_RETRY_DELAY`, which is 30
seconds
([plan, line 1161](2026-09-03-overnight-robustness.md#L1161)).

Use `opts.retryDelay ?? 0` in `dryRunIsolated`. The CLI already supplies its
explicit 30-second default.

## Validation

The review covered all 1,749 lines of the plan. An independent reviewer ran
the checks in a detached worktree at commit `2ac5820`.

- `npm ci` exited 0 and installed 216 packages.
- `npm run lint` exited 0.
- `npm test` exited 1.

Before the failure, the runner reported:

```text
# tests 153
# pass  153
# ok
```

The first CLI smoke test then reported:

```text
not ok 12 exit code 0
    expected: 0
    actual:   1
not ok 13 log file created
Error: ENOENT: no such file or directory, open
'.../.scratch/test-feat/logs/01-echo.log'
```

The target contains a plan, not its proposed implementation. These baseline
checks do not validate the planned changes, and the detached review
environment did not produce a fully green baseline suite.
