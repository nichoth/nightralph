# 02: Multi-select resolveIssuesDir

**What to build:** The interactive feature picker in
`resolveIssuesDir` becomes a checkbox prompt where the user
toggles features with spacebar and confirms with enter. An
"All" option at the top selects every feature in one shot
(one-shot toggle, no auto-sync). Each choice label shows
`<name> (<ready>/<total> ready)` with ticket counts drawn
from scanning the feature's issues directory. The function
returns `Array<{ dir, spec, name }>` instead of a single
`{ dir, spec }`. An empty selection re-prompts with "Select
at least one feature". When exactly one feature directory
exists, the prompt is skipped and it auto-selects (current
behavior preserved). The `--spec` flag path is unchanged --
it still returns a single-element array.

**Blocked by:** None (can start immediately)

**Touches:** `src/resolve.ts` (`resolveIssuesDir`,
`findFeatureDirs`), `src/index.ts` (import of `checkbox`
and `Separator` from `@inquirer/prompts`, update
`resolveIssuesDir` call site type), `test/resolve.test.ts`
(new file)

**Status:** ready-for-agent

- [ ] `resolveIssuesDir` uses `checkbox` + `Separator` from `@inquirer/prompts` instead of `select`
- [ ] "All" appears as the first choice with a `Separator` below it; checking it selects every feature
- [ ] Each feature choice label shows `<name> (<ready>/<total> ready)` with counts from `scanTickets`
- [ ] Return type is `Array<{ dir, spec, name }>`; `--spec` flag returns a single-element array
- [ ] Empty selection re-prompts with "Select at least one feature"
- [ ] When exactly 1 feature directory exists, the prompt is skipped and the sole feature is auto-selected
- [ ] `findFeatureDirs` results are sorted alphabetically by name
