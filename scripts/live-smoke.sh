#!/usr/bin/env bash
# Optional live soak. Not called from scripts/test.sh or CI.
# Starts a local process with HIREAPI_LIVE_ATS=1 and walks:
#   1. a real public Greenhouse or Ashby job URL
#   2. its board URL
#   3. a closed/404 job URL → 200 closed:true (after ingest) or 404 job_closed
# Never invents salary. Never hits LinkedIn or Indeed.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "PASS: $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing $1"
}

need curl
need python3
need node
[[ -f package.json ]] || fail "run from the hireapi checkout"

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

PORT="${PORT:-38765}"
BASE="http://127.0.0.1:${PORT}"
KEY="${HIREAPI_BOOTSTRAP_KEY:-hk_test_live_smoke}"
DB="${HIREAPI_DATABASE:-$(mktemp -t hireapi-live-smoke.XXXXXX.sqlite)}"
JOB_URL="${HIREAPI_SMOKE_JOB_URL:-https://jobs.ashbyhq.com/linear/1bfdcabe-aa5f-4999-9a6d-b8a824dd779b}"
BOARD_URL="${HIREAPI_SMOKE_BOARD_URL:-https://jobs.ashbyhq.com/linear}"
# After the first live GET of this URL, the process 404s it so a *known* job
# becomes 200 closed:true. Default is the same open job we just ingested.
CLOSED_URL="${HIREAPI_SMOKE_CLOSED_URL:-${JOB_URL}}"
LOG="$(mktemp -t hireapi-live-smoke-server.XXXXXX.log)"
PID=""

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "${JOB_URL}${BOARD_URL}${CLOSED_URL}" in
  *linkedin.com*|*indeed.com*|*indeed.*)
    fail "live-smoke must not target LinkedIn or Indeed"
    ;;
esac

echo "== start server HIREAPI_LIVE_ATS=1 PORT=${PORT} =="
HIREAPI_LIVE_ATS=1 \
  HIREAPI_SMOKE_FORCE_CLOSED="${CLOSED_URL}" \
  HIREAPI_DATABASE="${DB}" \
  HIREAPI_BOOTSTRAP_KEY="${KEY}" \
  PORT="${PORT}" \
  NODE_ENV=development \
  npm start >"${LOG}" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 50); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "${PID}" 2>/dev/null; then
    cat "${LOG}" >&2 || true
    fail "server exited before /healthz"
  fi
  sleep 0.2
done
[[ "${ready}" -eq 1 ]] || {
  cat "${LOG}" >&2 || true
  fail "server never became healthy"
}
ok "server up ${BASE} pid=${PID}"

auth=(-H "Authorization: Bearer ${KEY}" -H "Accept: application/json")

curl_json() {
  local method="$1"
  local path="$2"
  local out="$3"
  local code
  code="$(curl -sS -o "${out}" -w '%{http_code}' "${auth[@]}" "${BASE}${path}")"
  echo "${code}"
}

check_no_invented_salary() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
body = json.load(open(path))
data = body.get("data")
if not isinstance(data, dict):
    sys.exit(0)
salary = data.get("salary")
if salary is None:
    sys.exit(0)
if not isinstance(salary, dict):
    print("salary is not an object", file=sys.stderr)
    sys.exit(1)
raw = salary.get("raw")
if raw is None or not str(raw).strip():
    print("salary present without raw text", file=sys.stderr)
    sys.exit(1)
if salary.get("min") is None and salary.get("max") is None:
    print("salary object with no amounts", file=sys.stderr)
    sys.exit(1)
PY
}

echo "== 1. live job URL =="
job_body="$(mktemp -t hireapi-live-smoke-job.XXXXXX.json)"
job_code="$(curl_json GET "/v1/jobs/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${JOB_URL}")" "${job_body}")"
echo "HTTP ${job_code} ${JOB_URL}"
python3 - "${job_body}" "${job_code}" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
code = int(sys.argv[2])
if code != 200:
    print(json.dumps(body, indent=2)[:2000], file=sys.stderr)
    raise SystemExit(f"job URL expected 200, got {code}")
data = body["data"]
assert data.get("closed") is False, data
assert data.get("title"), data
assert data.get("company", {}).get("name"), data
assert data.get("source") in ("greenhouse", "ashby", "lever"), data
md = data.get("descriptionMarkdown") or ""
assert "<div>" not in md and "<script" not in md, "HTML leaked into Markdown"
assert data.get("source") not in ("linkedin", "indeed"), data
print(f"source={data['source']} title={data['title']!r} company={data['company']['name']!r} salary={data.get('salary')} desc_chars={len(md)}")
PY
check_no_invented_salary "${job_body}"
ok "job URL → typed open record"

echo "== 2. live board URL =="
board_body="$(mktemp -t hireapi-live-smoke-board.XXXXXX.json)"
board_code="$(curl_json GET "/v1/boards/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${BOARD_URL}")" "${board_body}")"
echo "HTTP ${board_code} ${BOARD_URL}"
python3 - "${board_body}" "${board_code}" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
code = int(sys.argv[2])
if code != 200:
    print(json.dumps(body, indent=2)[:2000], file=sys.stderr)
    raise SystemExit(f"board URL expected 200, got {code}")
data = body["data"]
assert isinstance(data, list), type(data)
assert len(data) >= 1, "board returned no open jobs"
for row in data:
    assert row.get("title"), row
    assert row.get("hasFullDescription") is False, row
    assert "descriptionMarkdown" not in row, row
    assert row.get("closed") is False, row
print(f"open_jobs={len(data)} first={data[0]['title']!r} apply={data[0]['applyUrl']}")
PY
ok "board URL → ≥1 summary job, no Markdown"

echo "== 3. closed / 404 job URL (known job after live 404) =="
# Step 1 already ingested JOB_URL. A second by-url of the same posting is
# forced to ATS 404 via HIREAPI_SMOKE_FORCE_CLOSED → 200 closed:true.
closed_body="$(mktemp -t hireapi-live-smoke-closed.XXXXXX.json)"
closed_code="$(curl_json GET "/v1/jobs/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${CLOSED_URL}")" "${closed_body}")"
echo "HTTP ${closed_code} ${CLOSED_URL}"

python3 - "${closed_body}" "${closed_code}" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
code = int(sys.argv[2])
if code != 200:
    print(json.dumps(body, indent=2)[:2000], file=sys.stderr)
    raise SystemExit(f"known closed URL expected 200 closed:true, got {code}")
data = body["data"]
if data.get("closed") is not True:
    raise SystemExit(f"200 without closed:true: {data}")
if data.get("descriptionMarkdown") not in ("", None):
    raise SystemExit("closed job must not keep serving the old description")
if not data.get("closedAt"):
    raise SystemExit("closed:true missing closedAt")
print(f"closed:true id={data.get('id')} closedAt={data.get('closedAt')}")
PY
ok "closed/404 URL → 200 closed:true"

echo "OK: live smoke walked job + board + closed/404 against real ATS"
echo "log=${LOG}"
