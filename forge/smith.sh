#!/usr/bin/env bash
# Cursor Agent CLI (2025+): headless mode is `agent -p --yolo ...`, not `agent run --input`.
set -euo pipefail

PROJECT_DIR="${OSNOVA_PROJECT:-$PWD}"
TASK_FILE="$PROJECT_DIR/.osnova/task.yaml"
REPORT_FILE="$PROJECT_DIR/.osnova/report.yaml"
PROMPT_FILE="$PROJECT_DIR/.osnova/smith-agent-prompt.txt"
CURSORBIN="${CURSORBIN:-cursor-agent}"
TIMEOUT_SEC="${SMITH_TIMEOUT:-300}"
# Space-separated model names; "_" = omit --model (CLI default). Try "_" first — "auto" fails on some Windows CLI builds.
# Example: SMITH_MODELS="auto" or SMITH_MODELS="gpt-4.1 _"
SMITH_MODELS="${SMITH_MODELS:-_ auto}"
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

$PYTHON - "$PROJECT_DIR" "$TASK_FILE" "$PROMPT_FILE" <<'PY'
import sys
from pathlib import Path

project = Path(sys.argv[1])
task = Path(sys.argv[2])
out = Path(sys.argv[3])
text = f"""OSNOVA Forge — execute one ATM (atom).

Read the full atom definition in this YAML file (open it with your tools):
{task.resolve().as_posix()}

Workspace (git repo root):
{project.resolve().as_posix()}

Follow goal, scope, steps, and priority from that file. Respect notouch paths.
Make concrete file edits; be minimal. When finished, the atom's `done` command should be runnable from the repo root.
"""
out.write_text(text, encoding="utf-8")
PY

start_ts="$(date +%s)"
result_err=""
ok=0
# Default for set -u: never read $status before assignment (Git Bash can choke on `|| status=...`).
status="BLK"

# Lines on stderr → forge log (cursorexec) even when cursor-agent writes nothing to pipes.
run_with_model() {
  local model_token="$1"
  local rc=0
  echo "smith: starting agent model=${model_token:-_} timeout=${TIMEOUT_SEC}s CURSORBIN=${CURSORBIN}" >&2
  if [ "$model_token" = "_" ] || [ -z "$model_token" ]; then
    timeout "$TIMEOUT_SEC" \
      "$CURSORBIN" -p --yolo --trust --workspace "$PROJECT_DIR" \
      "$(cat "$PROMPT_FILE")" || rc=$?
  else
    timeout "$TIMEOUT_SEC" \
      "$CURSORBIN" -p --yolo --trust --workspace "$PROJECT_DIR" \
      --model "$model_token" \
      "$(cat "$PROMPT_FILE")" || rc=$?
  fi
  # 124 = GNU timeout; 127 = command not found; 0 = success
  echo "smith: agent finished exit=${rc}" >&2
  return "$rc"
}

if ! command -v timeout >/dev/null 2>&1; then
  echo "smith: WARN: no 'timeout' in PATH — SMITH_TIMEOUT may not kill a stuck agent (install Git Bash coreutils)" >&2
fi
# Git Bash: `command -v` often fails for Windows agent.cmd / full paths (no Unix +x); use -f as fallback.
smith_cursorbin_ok() {
  local b="$1"
  command -v "$b" >/dev/null 2>&1 && return 0
  [ -f "$b" ] && return 0
  case "$b" in
    *\\*)
      local n
      n=$(printf '%s' "$b" | tr '\\' '/')
      [ -f "$n" ] && return 0
      ;;
  esac
  return 1
}
if ! smith_cursorbin_ok "$CURSORBIN"; then
  echo "smith: ERROR: CURSORBIN not found (PATH or file): ${CURSORBIN}" >&2
fi

echo "smith: preflight ATM=${ID} models=${SMITH_MODELS}" >&2

for model in $SMITH_MODELS; do
  if run_with_model "$model"; then
    ok=1
    break
  fi
  result_err="agent -p failed (model token: ${model})"
done

elapsed="$(( $(date +%s) - start_ts ))"
if [ "$ok" -eq 1 ]; then
  status="OK"
else
  status="BLK"
fi

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
git -C "$PROJECT_DIR" push || true  # non-zero if nothing to push — ignore
