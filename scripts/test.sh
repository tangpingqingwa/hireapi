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
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh llms.txt; do
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

echo "== adapters default to fixtures; live ATS is env-gated =="
if [[ -d src/adapters ]]; then
  [[ -f src/adapters/lever.ts ]] || fail "missing src/adapters/lever.ts"
  [[ -f src/adapters/live.ts ]] || fail "missing src/adapters/live.ts"
  grep -q 'HIREAPI_LIVE_ATS' src/adapters/transport.ts \
    || fail "live ATS env gate missing from src/adapters/transport.ts"
  grep -q 'isLiveAtsEnabled' src/adapters/index.ts \
    || fail "src/adapters/index.ts must select live fetch via isLiveAtsEnabled"
  grep -q 'createLiveFetchPage' src/adapters/index.ts \
    || fail "src/adapters/index.ts must call createLiveFetchPage when gated on"
  grep -q 'createFixtureFetchPage' src/adapters/index.ts \
    || fail "src/adapters/index.ts must default to createFixtureFetchPage"
  if grep -RInE '(^|[^[:alnum:]_])(fetch|axios|got)\s*\(' src/adapters/greenhouse.ts src/adapters/ashby.ts src/adapters/lever.ts src/adapters/parse.ts src/adapters/fixtures.ts src/core >/dev/null; then
    fail "live HTTP client call outside src/adapters/live.ts"
  fi
  if grep -RInE 'linkedin\.com|indeed\.com' src/adapters/live.ts >/dev/null; then
    fail "live adapter must not target LinkedIn or Indeed"
  fi
  if [[ -n "${HIREAPI_LIVE_ATS:-}" ]]; then
    fail "HIREAPI_LIVE_ATS must be unset in CI / scripts/test.sh"
  fi
  [[ -f tests/live.test.ts ]] || fail "missing tests/live.test.ts"
fi

if [[ -d src/core ]]; then
  echo "== boards + closed lifecycle files =="
  [[ -f src/core/boards.ts ]] || fail "missing src/core/boards.ts"
  [[ -f src/migrations/002_jobs.sql ]] || fail "missing jobs table migration"
  [[ -f tests/closed.test.ts ]] || fail "missing tests/closed.test.ts"
  grep -q 'CREATE TABLE jobs' src/migrations/002_jobs.sql || fail "jobs migration does not create jobs"
  [[ -f src/core/search.ts ]] || fail "missing src/core/search.ts"
  [[ -f src/core/companies.ts ]] || fail "missing src/core/companies.ts"
  [[ -f src/migrations/003_companies.sql ]] || fail "missing companies migration"
  [[ -f tests/search.test.ts ]] || fail "missing tests/search.test.ts"
  grep -q 'CREATE TABLE companies' src/migrations/003_companies.sql \
    || fail "companies migration does not create companies"
fi

echo "== MCP tools wrap core/* (PR 6) =="
[[ -f src/mcp/server.ts ]] || fail "missing src/mcp/server.ts"
[[ -f src/mcp/tools.ts ]] || fail "missing src/mcp/tools.ts"
[[ -f tests/mcp.test.ts ]] || fail "missing tests/mcp.test.ts"
[[ -f llms.txt ]] || fail "missing llms.txt"
grep -q 'get_job' src/mcp/tools.ts || fail "src/mcp/tools.ts missing get_job"
grep -q 'list_board' src/mcp/tools.ts || fail "src/mcp/tools.ts missing list_board"
grep -q 'search_jobs' src/mcp/tools.ts || fail "src/mcp/tools.ts missing search_jobs"
grep -q 'getJobByUrl' src/mcp/tools.ts || fail "get_job must call core/jobs"
grep -q 'getBoardByUrl' src/mcp/tools.ts || fail "list_board must call core/boards"
grep -q 'searchIngestedJobs' src/mcp/tools.ts || fail "search_jobs must call core/search"
grep -q 'get_job' llms.txt || fail "llms.txt missing get_job"
grep -q 'list_board' llms.txt || fail "llms.txt missing list_board"
grep -q 'search_jobs' llms.txt || fail "llms.txt missing search_jobs"
grep -q 'When not to call' llms.txt || fail "llms.txt missing when-not-to-call"
grep -qi 'we do not apply' llms.txt || fail "llms.txt missing do-not-apply skill"
grep -qi 'LinkedIn' llms.txt || fail "llms.txt missing LinkedIn disclaimer"
grep -qi 'salary may be null' llms.txt || fail "llms.txt missing salary-null skill"
if grep -RInE 'adapters/' src/mcp src/http >/dev/null 2>&1; then
  fail "MCP and HTTP must call core/* only"
fi
if grep -RInE '(^|[^[:alnum:]_])(fetch|axios|got)\s*\(' src/mcp >/dev/null; then
  fail "live HTTP client call in src/mcp (fixture transport only)"
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
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md llms.txt | grep -qiE 'utf-8|us-ascii' \
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
