#!/bin/bash
# Deletion proofs — the check that the SUITE can detect a disconnected control.
#
# WHY THIS EXISTS. Tests that assert a MECHANISM cannot tell you whether that
# mechanism is still wired up. This repo shipped nine controls that were correct,
# tested, and — for five of them — deletable with the whole suite still green. A
# committee round found that by hand; this script makes it repeatable.
#
# For each named control it removes the call SEMANTICALLY (never by breaking the
# syntax), confirms the result still typechecks, and runs the suite. A control whose
# removal leaves the suite green is a control the suite is blind to.
#
# The tsc gate is load-bearing: an early hand-run of these proofs left a brace
# unbalanced and reported 32 failures as though they proved wiring. A broken build is
# not evidence.
#
#   bash tools/deletion-proofs.sh                 # every known control
#   bash tools/deletion-proofs.sh heartbeat-lock  # just one
#
# Expected output: every control shows at least 1 failing test. A "Tests N passed"
# line with no failures is a FINDING — that control is unprotected.
set -u
cd "$(dirname "$0")/.." || exit 2

ALL="update-lock finish-lock heartbeat-lock reap-lock reopen-lock
     touch-update touch-finish touch-heartbeat reap-dest-guard"
TARGETS="${*:-$ALL}"

BASE=$(mktemp)
cp src/lock/store.ts "$BASE"
restore() { cp "$BASE" src/lock/store.ts; }
trap 'restore; rm -f "$BASE"' EXIT

for name in $TARGETS; do
  restore
  if ! python3 tools/deletion_proof_mutate.py "$name"; then
    printf '%-18s MUTATION FAILED (anchor moved? update tools/deletion_proof_mutate.py)\n' "$name"
    continue
  fi
  if ! ./node_modules/.bin/tsc --noEmit >/dev/null 2>&1; then
    printf '%-18s TSC BROKEN — proof invalid, NOT a result\n' "$name"
    continue
  fi
  ./node_modules/.bin/tsup >/dev/null 2>&1
  printf '%-18s %s\n' "$name" \
    "$(./node_modules/.bin/vitest run 2>&1 | /usr/bin/grep -E '^      Tests ' | head -1)"
done

restore
./node_modules/.bin/tsup >/dev/null 2>&1
echo "--- restored to baseline ---"
