# CLI audit fixes implementation plan -- phase 4

**Goal:** Publishing always builds and runs the test suite first.

**Architecture:** One npm lifecycle script. `prepublishOnly` runs
before the package is packed, for `npm publish` and `npm publish
--dry-run` alike (npm 11 `lib/commands/publish.js` runs it before
the dry-run branch), and a non-zero exit aborts the publish. It does
not run for `npm pack`. The existing `postversion` script, which
calls `npm publish`, therefore builds and tests without any change.

`postversion` is reordered to `npm publish && git push --follow-tags`
(it was `git push --follow-tags && npm publish`). Before this phase,
`npm version` pushed the version commit and tag first, and only then
ran `prepublishOnly`. A red test suite aborted the publish but left
the version commit and tag on the remote. With the reorder, build and
tests run before anything is pushed, so a red suite leaves only a
local commit and tag. `preversion` is unchanged.

**Tech Stack:** npm 11 lifecycle scripts.

**Scope:** Phase 4 of 5 from
`docs/design-plans/2026-10-07-cli-audit-fixes.md`.

**Codebase verified:** 2026-10-07

---

## Acceptance Criteria Coverage

This phase is infrastructure; it is verified operationally. The
design's acceptance criteria for it are checked by running commands,
not by automated tests:

### cli-audit-fixes.AC4: Publishing builds first
- **cli-audit-fixes.AC4.1 Success:** `npm publish --dry-run` runs
  `npm run build` and `npm test` before listing the tarball.
- **cli-audit-fixes.AC4.2 Failure:** With a deliberately failing
  test, `npm publish --dry-run` exits non-zero and publishes
  nothing.

---

<!-- START_TASK_1 -->
### Task 1: `prepublishOnly` script

**Verifies:** None (infrastructure; AC4.1 and AC4.2 are verified by
the commands below)

**Files:**
- Modify: `package.json:16-29` (the `scripts` block)

**Step 1: Add the script**

Add one entry to `scripts`, after `"preversion"` (line 24) so the
lifecycle scripts sit together:

```json
    "prepublishOnly": "npm run build && npm test",
```

Order matters inside the command: `scripts/test.sh` does not build,
and the integration suite runs `dist/index.js`, so `build` must come
first.

**Step 2: Verify operationally (AC4.1)**

Run: `npm publish --dry-run; echo "exit=$?"`
Expected: the output shows the `prepublishOnly` script running, the
esbuild build lines, every test suite passing, and then the
`Tarball Contents` listing. Nothing is published.

After the listing npm prints `You cannot publish over the previously
published versions` and exits non-zero, because the version in
`package.json` is already on the registry. That error is expected
here and is not a failure of this step. The check that matters is
the order: build, then tests, then the tarball listing. Do not pass
`--force` or bump the version to silence it.

**Step 3: Verify the abort path (AC4.2)**

Make one test fail on purpose: add `t.ok(false, 'temporary')` to
any test in `test/retry.test.ts`.

Run: `npm publish --dry-run; echo "exit=$?"`
Expected: the test run stops at the failing suite. The output starts
with the `> nightralph@0.0.53 prepublishOnly` header, then an `npm
error command failed` block naming the command `npm run build && npm
test` (the script name appears only in that header, not in the error
block). No `Tarball Contents` listing is printed, and the exit code is
non-zero. The absence of the listing is what distinguishes this from
Step 2.

Revert the temporary change: `git checkout -- test/retry.test.ts`.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: build and test before publish"
```
<!-- END_TASK_1 -->
