#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${OSNOVA_PROJECT:-$PWD}"
TASK_FILE="$PROJECT_DIR/.osnova/task.yaml"
REPORT_FILE="$PROJECT_DIR/.osnova/report.yaml"
CURSORBIN="${CURSORBIN:-cursor-agent}"
TIMEOUT_SEC="${SMITH_TIMEOUT:-300}"
ID="UNKNOWN"

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
else
  PYTHON=python
fi

mkdir -p "$PROJECT_DIR/.osnova"
if [ -f "$TASK_FILE" ]; then
  ID="$($PYTHON - <<'PY' "$TASK_FILE"
import sys, yaml
with open(sys.argv[1], "r", encoding="utf-8") as f:
    d = yaml.safe_load(f) or {}
print(d.get("id", "UNKNOWN"))
PY
)"
fi

start_ts="$(date +%s)"
result_err=""
ok=0

run_model() {
  local model="$1"
  timeout "$TIMEOUT_SEC" "$CURSORBIN" run --model "$model" --input "$TASK_FILE"
}

for model in auto composer-2-fast composer-2; do
  if run_model "$model"; then
    ok=1
    break
  fi
  result_err="cursor-agent failed on model: $model"
done

elapsed="$(( $(date +%s) - start_ts ))"
status="OK"
[ "$ok" -eq 1 ] || status="BLK"

$PYTHON - <<'PY' "$REPORT_FILE" "$ID" "$status" "$elapsed" "$result_err"
import sys, yaml
path, atm_id, status, elapsed, err = sys.argv[1:]
report = {
    "v": 5,
    "t": "RPT",
    "id": atm_id,
    "s": status,
    "tests": {"passed": 0, "total": 0},
    "changed": [],
    "elapsed": int(elapsed),
    "err": err or None,
}
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(report, f, sort_keys=False, allow_unicode=True)
PY

git -C "$PROJECT_DIR" add ".osnova/report.yaml" || true
git -C "$PROJECT_DIR" commit -m "smith report $ID $status" || true
git -C "$PROJECT_DIR" push || true

