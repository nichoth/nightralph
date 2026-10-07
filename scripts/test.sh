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
    orchestrator
    retry
    worktree
    progress
    learnings
    merge
    display
    testcmd
    resolve
    integration
)

RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/nightralph-testrun-XXXXXX")

cleanup () {
    rm -rf "$RUN_TMP" || true
    rm -f mock-change-*.txt || true
}
trap cleanup EXIT

export TMPDIR="$RUN_TMP"

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
