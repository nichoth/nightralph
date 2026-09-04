# 05: Backoff between retries

**What to build:** A configurable delay before each retry of a failed ticket, doubling per attempt (30s, 60s, 120s by default), so a provider outage is waited out instead of burning every attempt in seconds. The CLI exposes `--retry-delay <seconds>` (default 30, 0 disables). Library functions default to 0 so the existing test suite stays fast.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `retryDelayFor(base, attempt)` returns `base * 2 ** (attempt - 2)`, exported
- [ ] `DEFAULT_RETRY_DELAY = 30`, exported
- [ ] `runWavesIsolated` and `runWaves` accept `retryDelay` and sleep before each retry
- [ ] `dryRunIsolated` prints the retry delay
- [ ] CLI flag `--retry-delay` with default `DEFAULT_RETRY_DELAY`
- [ ] Existing CLI subprocess tests that exercise retries pass `--retry-delay 0` to stay fast
- [ ] A unit test verifies the doubling math
- [ ] An integration test verifies the delay is actually waited
