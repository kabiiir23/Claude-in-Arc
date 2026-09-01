#!/usr/bin/env bash
# Run every harness. Requires a build: ./scripts/fetch-upstream.sh && node scripts/apply-patches.mjs
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
for t in tests/test-*.mjs; do
  printf '\n=== %s\n' "$(basename "$t")"
  node "$t" || fail=1
done
exit $fail
