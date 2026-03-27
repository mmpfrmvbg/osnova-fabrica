#!/usr/bin/env bash
# OSNOVA Brain — создание labels в репозитории
# Запусти один раз: bash .osnova/setup-labels.sh
#
# Требует: GITHUB_TOKEN с правами repo + gh CLI или curl
# Использование: GH_TOKEN=ghp_xxx bash .osnova/setup-labels.sh

set -euo pipefail

REPO="mmpfrmvbg/osnova-fabrica"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "❌ Укажи GH_TOKEN или GITHUB_TOKEN"
  exit 1
fi

create_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  # Проверяем существует ли label
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/labels/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$name'))")"
  )

  if [ "$status" = "200" ]; then
    echo "✅ Label '$name' уже существует"
  else
    curl -s -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      "https://api.github.com/repos/$REPO/labels" \
      -d "{\"name\":\"$name\",\"color\":\"$color\",\"description\":\"$description\"}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"✅ Created: {d.get('name','?')} #{d.get('color','?')}\")" \
      2>/dev/null || echo "⚠️  Label '$name' — проверь вручную"
  fi
}

echo "🏷️  Создание OSNOVA Brain labels в $REPO..."
echo ""

# Brain / приоритеты
create_label "brain-epic"   "7B68EE"  "EPIC от Brain-планировщика (Perplexity Tasks)"
create_label "P0"           "B60205"  "Критический приоритет: self-fix, срочно"
create_label "P1"           "E4430F"  "Высокий приоритет: improvement"
create_label "P2"           "F9A825"  "Средний приоритет: feature"
create_label "P3"           "0075CA"  "Низкий приоритет: research"
create_label "blocker"      "CC0000"  "ATM заблокирован, требует ручного вмешательства"

# Служебные
create_label "done"         "0E8A16"  "EPIC выполнен Forge"
create_label "watchdog"     "5319E7"  "Алерт от GHA watchdog"
create_label "heart-alert"  "D93F0B"  "Heart: forge перезапущен или мёртв"
create_label "ci-failure"   "B60205"  "CI тесты упали на main"

echo ""
echo "✅ Готово! Все labels созданы в $REPO"
echo "   Проверь: https://github.com/$REPO/labels"
