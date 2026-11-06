#!/usr/bin/env bash
set -euo pipefail

# Run the test suite with a private TMPDIR, so every temp file and
# directory the tests (and the agents and CLIs they spawn) create
# is removed when the run ends -- pass, fail, or Ctrl-C. Also
# removes the mock-change-*.txt files mock agents write into the
# repo root.

cd "$(dirname "$0")/.."
PATH="$PWD/node_modules/.bin:$PATH"

TESTS=(
    setup
    blockers
    orchestrator
    retry
    worktree
    progress
    learnings
    stats
    review
    review-pass
    merge
    display
    testcmd
    preflight
    resolve
    graph
    integration
    review-integration
)

RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/nightralph-testrun-XXXXXX")

cleanup () {
    rm -rf "$RUN_TMP" || true
    rm -f mock-change-*.txt || true
}
trap cleanup EXIT

export TMPDIR="$RUN_TMP"

# Hide the machine's global and system git config, as on a CI runner
# with no identity. useConfigOnly stops git from guessing one from
# the user name and hostname, so a test repo that does not set
# user.name and user.email fails here, not only in CI.
GIT_CONFIG_GLOBAL="$RUN_TMP/gitconfig"
printf '[user]\n\tuseConfigOnly = true\n' > "$GIT_CONFIG_GLOBAL"
export GIT_CONFIG_GLOBAL
export GIT_CONFIG_NOSYSTEM=1

SOURCES=()
for name in "${TESTS[@]}"; do
    SOURCES+=("test/$name.test.ts")
done

esbuild "${SOURCES[@]}" --format=esm --bundle \
    --packages=external --outdir=dist/test --sourcemap

# Stops at the first failing suite, like the old `&&` chain
for name in "${TESTS[@]}"; do
    node "dist/test/$name.test.js"
done
