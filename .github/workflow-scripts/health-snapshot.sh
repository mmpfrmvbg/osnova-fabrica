DATE=$(date -u +%Y-%m-%d)
: "${HEALTH_ANALYSIS_SINCE:?HEALTH_ANALYSIS_SINCE is required}"
mkdir -p runs/health-snapshots
SNAP_FILE="runs/health-snapshots/${DATE}.json"
if [ ! -f runs/traces.jsonl ]; then
  echo '{"total":0,"semantic_errors_in_success":0,"generated_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$SNAP_FILE"
else
  npx tsx src/scripts/analyze-language-health.ts \
    --json \
    --since "$HEALTH_ANALYSIS_SINCE" \
    > "$SNAP_FILE" || true
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('${SNAP_FILE}', 'utf-8'));
    data.generated_at = new Date().toISOString();
    fs.writeFileSync('${SNAP_FILE}', JSON.stringify(data, null, 2));
  "
fi
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add -f "$SNAP_FILE"
if git diff --cached --quiet; then
  echo "Snapshot не изменился — коммит пропущен"
else
  git commit -m "chore(snapshot): health snapshot ${DATE} [skip ci]"
  git push
fi
