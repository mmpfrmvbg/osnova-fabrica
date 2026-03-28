#!/usr/bin/env bash
# Cursor: only the agent CLI binary is invoked (no separate HTTP API client in forge).
# Headless: agent -p --yolo --trust --workspace <repo> "<prompt>" — https://cursor.com/docs/cli/headless
# Not interactive TUI (`agent say hello` / follow-up prompts). Auth for the same CLI: `agent login`, or CURSOR_API_KEY for non-interactive envs (still the agent binary).
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
# Windows: cursorexec may set CURSOR_AGENT_NODE + CURSOR_AGENT_INDEX_JS (node.exe + index.js) to bypass agent.cmd/ps1 shims under Git Bash.
# FORGE_SMITH_NO_INNER_TIMEOUT=1 (default on Windows): skip GNU `timeout` — it often kills node agent with 124 while work is still running; outer python FORGE_SMITH_WRAP_TIMEOUT remains.
run_with_inner_timeout() {
  if [ "${FORGE_SMITH_NO_INNER_TIMEOUT:-0}" = "1" ]; then
    "$@"
  else
    timeout "$TIMEOUT_SEC" "$@"
  fi
}

run_with_model() {
  local model_token="$1"
  local rc=0
  if [ -n "${CURSOR_AGENT_NODE:-}" ] && [ -n "${CURSOR_AGENT_INDEX_JS:-}" ]; then
    if [ "${FORGE_SMITH_NO_INNER_TIMEOUT:-0}" = "1" ]; then
      echo "smith: starting agent (node bundle) model=${model_token:-_} inner_timeout=off node=${CURSOR_AGENT_NODE}" >&2
    else
      echo "smith: starting agent (node bundle) model=${model_token:-_} inner_timeout=${TIMEOUT_SEC}s node=${CURSOR_AGENT_NODE}" >&2
    fi
    if [ "$model_token" = "_" ] || [ -z "$model_token" ]; then
      run_with_inner_timeout \
        "$CURSOR_AGENT_NODE" "$CURSOR_AGENT_INDEX_JS" -p --yolo --trust --workspace "$PROJECT_DIR" \
        "$(cat "$PROMPT_FILE")" || rc=$?
    else
      run_with_inner_timeout \
        "$CURSOR_AGENT_NODE" "$CURSOR_AGENT_INDEX_JS" -p --yolo --trust --workspace "$PROJECT_DIR" \
        --model "$model_token" \
        "$(cat "$PROMPT_FILE")" || rc=$?
    fi
  else
    if [ "${FORGE_SMITH_NO_INNER_TIMEOUT:-0}" = "1" ]; then
      echo "smith: starting agent model=${model_token:-_} inner_timeout=off CURSORBIN=${CURSORBIN}" >&2
    else
      echo "smith: starting agent model=${model_token:-_} inner_timeout=${TIMEOUT_SEC}s CURSORBIN=${CURSORBIN}" >&2
    fi
    if [ "$model_token" = "_" ] || [ -z "$model_token" ]; then
      run_with_inner_timeout \
        "$CURSORBIN" -p --yolo --trust --workspace "$PROJECT_DIR" \
        "$(cat "$PROMPT_FILE")" || rc=$?
    else
      run_with_inner_timeout \
        "$CURSORBIN" -p --yolo --trust --workspace "$PROJECT_DIR" \
        --model "$model_token" \
        "$(cat "$PROMPT_FILE")" || rc=$?
    fi
  fi
  # 124 = GNU timeout; 127 = command not found; 0 = success
  echo "smith: agent finished exit=${rc}" >&2
  return $((0 + rc))
}

if ! command -v timeout >/dev/null 2>&1; then
  echo "smith: WARN: no 'timeout' in PATH — SMITH_TIMEOUT may not kill a stuck agent (install Git Bash coreutils)" >&2
fi
# Git Bash: `command -v` often fails for Windows agent.cmd / full paths (no Unix +x); use -f as fallback.
# No `return` inside this helper — broken CRLF can split `return` into `ret` + `urn` and crash the script.
smith_cursorbin_ok() {
  local b="$1" n
  if command -v "$b" >/dev/null 2>&1; then
    true
  elif [ -f "$b" ]; then
    true
  elif [[ "$b" == *\\* ]]; then
    n=$(printf '%s' "$b" | tr '\\' '/')
    if [ -f "$n" ]; then
      true
    else
      false
    fi
  else
    false
  fi
}
if [ -n "${CURSOR_AGENT_NODE:-}" ] && [ -n "${CURSOR_AGENT_INDEX_JS:-}" ]; then
  if [ ! -f "$CURSOR_AGENT_NODE" ] || [ ! -f "$CURSOR_AGENT_INDEX_JS" ]; then
    echo "smith: ERROR: CURSOR_AGENT_NODE or CURSOR_AGENT_INDEX_JS not a file" >&2
  fi
else
  if ! smith_cursorbin_ok "$CURSORBIN"; then
    echo "smith: ERROR: CURSORBIN not found (PATH or file): ${CURSORBIN}" >&2
  fi
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
