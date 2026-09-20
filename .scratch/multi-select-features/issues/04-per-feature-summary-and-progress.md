# 04: Per-feature finish summary and progress tracking

**What to build:** `renderFinishSummary` produces a combined total
line followed by per-feature breakdowns when tickets from more than
one feature were processed. Each feature keeps its own
`progress.md` (at `.scratch/<feature>/progress.md`). The
orchestrator updates the correct feature's progress file as tickets
complete. `renderPrompt` receives the per-ticket spec body so that
each ticket's prompt contains the spec from its own feature, not a
single global spec.

**Blocked by:** 01: Ticket compound identity and feature-prefixed
branch naming

**Touches:** `src/orchestrator.ts` (`renderFinishSummary`,
`renderPrompt`), `src/progress.ts` (per-feature paths),
`test/orchestrator.test.ts`, `test/progress.test.ts`

**Status:** done

- [x] `renderFinishSummary` accepts tickets with `feature` fields and produces per-feature breakdown lines when >1 distinct feature is present
- [x] `renderFinishSummary` produces the same single-line output as today when all tickets share one feature
- [x] `renderPrompt` accepts the spec body as a parameter (already does) and the orchestrator is structured to look up per-ticket spec content by feature
- [x] Progress generation and file writing support per-feature paths (one progress.md per feature directory)
- [x] Existing `renderFinishSummary` tests still pass; new test verifies multi-feature breakdown format
