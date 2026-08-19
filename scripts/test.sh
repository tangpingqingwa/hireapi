#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== adapters stay fixture-only (no live ATS hosts) =="
if [[ -d src/adapters ]]; then
  if grep -RInE '(^|[^[:alnum:]_])(fetch|axios|got)\s*\(' src/adapters src/core >/dev/null; then
    fail "live HTTP client call in adapters/core (fixture transport only)"
  fi
  [[ -f src/adapters/lever.ts ]] || fail "missing src/adapters/lever.ts"
fi

if [[ -d src/core ]]; then
  echo "== boards + closed lifecycle files =="
  [[ -f src/core/boards.ts ]] || fail "missing src/core/boards.ts"
  [[ -f src/migrations/002_jobs.sql ]] || fail "missing jobs table migration"
  [[ -f tests/closed.test.ts ]] || fail "missing tests/closed.test.ts"
  grep -q 'CREATE TABLE jobs' src/migrations/002_jobs.sql || fail "jobs migration does not create jobs"
  if [[ -d src/core/search.ts ]] || [[ -f src/core/search.ts ]]; then
    fail "search is PR 5; do not land it here"
  fi
fi

if [[ -d tests/fixtures/boards ]]; then
  echo "== fixture catalog =="
  [[ -f tests/fixtures/boards/index.json ]] || fail "missing tests/fixtures/boards/index.json"
  gh_n="$(find tests/fixtures/boards/greenhouse -name '*.html' 2>/dev/null | wc -l | tr -d ' ')"
  ashby_n="$(find tests/fixtures/boards/ashby -name '*.html' 2>/dev/null | wc -l | tr -d ' ')"
  lever_n="$(find tests/fixtures/boards/lever -name '*.html' 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$gh_n" -ge 8 ]] || fail "expected ≥8 Greenhouse fixtures, got $gh_n"
  [[ "$ashby_n" -ge 7 ]] || fail "expected ≥7 Ashby fixtures, got $ashby_n"
  [[ "$lever_n" -ge 5 ]] || fail "expected ≥5 Lever fixtures, got $lever_n"
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
