# 10: A throw inside an attempt fails that attempt, not the wave

**What to build:** `runTicketAttempts` wraps each attempt in try/catch so that a throw (e.g. from `isDirty` or `hasNewCommits` when the agent deleted its worktree) fails that single ticket instead of rejecting the `Promise.all` and killing every ticket in the wave. A new `{ kind:'error'; error:unknown }` variant joins the `TicketOutcome` union.

**Blocked by:** 08: A failed ticket is recorded once and not re-run this run; 05: Backoff between retries.

**Status:** ready-for-agent

- [ ] `TicketOutcome` gains `{ kind:'error'; error:unknown }`
- [ ] `runTicketAttempts` catches errors around `runTicketAttempt` and returns the error outcome
- [ ] The outcome loop in `runWavesIsolated` handles the `error` kind: adds to `failedNums`, sets status to failed, logs the error
- [ ] A mock agent that deletes its own working directory for ticket 01 fails that ticket while the sibling ticket in the same wave succeeds
