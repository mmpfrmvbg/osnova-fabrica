#!/usr/bin/env bash
# scripts/onboarding-check.sh
# Проверяет готовность окружения перед первым запуском ОСИРИСА.
# Запускать из корня монорепо: bash scripts/onboarding-check.sh

set -euo pipefail

PASS=0
FAIL=0

ok()   { echo "  [OK]  $1"; PASS=$((PASS+1)); }
fail() { echo "  [!!]  $1"; FAIL=$((FAIL+1)); }
info() { echo "  [--]  $1"; }

echo ""
echo "=== ОСИРИС — Проверка готовности окружения ==="
echo ""

# 1. Node.js версия >= 20
echo "[ Node.js ]"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null | sed 's/v//')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node v$NODE_VER (требуется >= 20)"
  else
    fail "node v$NODE_VER — нужна версия >= 20 (установить через nvm: nvm install 20)"
  fi
else
  fail "node не найден — установить с https://nodejs.org"
fi
echo ""

# 2. apps/osiris/.env существует
echo "[ Конфигурация ]"
if [ -f "apps/osiris/.env" ]; then
  ok "apps/osiris/.env найден"
else
  fail "apps/osiris/.env не найден — выполни: cp apps/osiris/.env.example apps/osiris/.env"
  info "Затем заполни: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, OSNOVA_PROVIDER"
fi

# 3. LLM_API_KEY заполнен (не пустой)
if [ -f "apps/osiris/.env" ]; then
  LLM_KEY_VAL=$(grep -E '^LLM_API_KEY=' apps/osiris/.env | cut -d= -f2- | tr -d '[:space:]' || true)
  if [ -n "$LLM_KEY_VAL" ]; then
    ok "LLM_API_KEY заполнен"
  else
    # Проверяем OSNOVA_PROVIDER — если qwen-cli, ключ не нужен
    PROVIDER_VAL=$(grep -E '^OSNOVA_PROVIDER=' apps/osiris/.env | cut -d= -f2- | tr -d '[:space:]' || echo "qwen-cli")
    if [ "$PROVIDER_VAL" = "qwen-cli" ]; then
      ok "LLM_API_KEY пуст — нормально для OSNOVA_PROVIDER=qwen-cli"
    else
      fail "LLM_API_KEY пуст — нужен для провайдера $PROVIDER_VAL"
    fi
  fi
fi
echo ""

# 4. cloudflared установлен
echo "[ Tunnel ]"
if command -v cloudflared &>/dev/null; then
  CFTVER=$(cloudflared --version 2>/dev/null | head -1 || echo "установлен")
  ok "cloudflared: $CFTVER"
else
  fail "cloudflared не найден"
  info "Установить: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/"
  info "Без cloudflared: npm run osiris:http (только локальная сеть)"
fi
echo ""

# 5. Сервер — health check (необязательно, если ещё не запущен)
echo "[ Сервер ]"
HEALTH_URL="${OSIRIS_HEALTH_URL:-http://localhost:3000}"
if [ -f "apps/osiris/.env" ]; then
  ENV_HEALTH=$(grep -E '^OSIRIS_HEALTH_URL=' apps/osiris/.env | cut -d= -f2- | tr -d '[:space:]' || true)
  if [ -n "$ENV_HEALTH" ]; then
    HEALTH_URL="$ENV_HEALTH"
  fi
fi
if curl -sf --max-time 2 "$HEALTH_URL/health" &>/dev/null; then
  ok "Сервер отвечает на $HEALTH_URL/health"
else
  info "Сервер не запущен ($HEALTH_URL/health недоступен) — это нормально перед первым стартом"
fi
echo ""

# 6. node_modules установлены
echo "[ Зависимости ]"
if [ -d "apps/osiris/node_modules" ]; then
  ok "apps/osiris/node_modules существует"
else
  fail "apps/osiris/node_modules не найден — выполни: cd apps/osiris && npm install"
fi
echo ""

# Итог
echo "==================================="
if [ "$FAIL" -eq 0 ]; then
  echo "  Все проверки прошли. ОСИРИС готов к запуску."
  echo ""
  echo "  Запуск:"
  echo "    cd apps/osiris && npm run osiris:tunnel   # с публичным URL"
  echo "    cd apps/osiris && npm run osiris:http     # только локальная сеть"
else
  echo "  Проверок провалено: $FAIL. Исправь ошибки выше и запусти снова."
fi
echo "==================================="
echo ""
