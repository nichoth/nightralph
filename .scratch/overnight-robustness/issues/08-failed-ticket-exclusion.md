# 08: A failed ticket is recorded once and not re-run this run

**What to build:** A ticket that exhausts its retry attempts is excluded from later waves of the same run. Its file keeps `ready-for-agent` so tomorrow's run picks it up, and `progress.md` records the failure. A `saveProgress` helper wraps `writeProgress` + `commitProgress` and logs instead of throwing on commit failure, so a progress commit failure never aborts the wave.

**Blocked by:** 01: commitProgress skips an unchanged file.

**Status:** ready-for-agent

- [ ] `saveProgress` helper logs commit failures instead of throwing
- [ ] `runWavesIsolated` and `runWaves` maintain a per-run `failedNums:Set<number>`
- [ ] `findReadyTickets` results are filtered by `failedNums`
- [ ] Failed tickets are added to `failedNums` on `worktree-error`, `no-commits`, and `failed` outcomes (not `merge-failed`)
- [ ] Final summary line includes failed count
- [ ] A test with two waves verifies that a ticket that fails in wave 1 is not re-run in wave 2, and the sibling ticket proceeds
