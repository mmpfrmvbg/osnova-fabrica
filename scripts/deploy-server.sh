#!/usr/bin/env bash
# scripts/deploy-server.sh
# Деплой Осириса на Ubuntu VPS (systemd, HTTP, без tunnel).
# Запускать от root на сервере: bash scripts/deploy-server.sh
# Репозиторий должен быть уже склонирован в /opt/osnova
# ИЛИ скрипт склонирует его сам если /opt/osnova не существует.

set -euo pipefail

INSTALL_DIR="/opt/osnova"
OSIRIS_DIR="$INSTALL_DIR/apps/osiris"
LOG_DIR="/var/log/osiris"
SERVICE_NAME="osiris"
OSIRIS_USER="osnova"
NODE_MIN_VERSION=20

# ── GitHub Token ──────────────────────────────────────────────────────────
# Передавать при запуске: GITHUB_TOKEN=ghp_xxx bash scripts/deploy-server.sh
# Или: export GITHUB_TOKEN=ghp_xxx && bash scripts/deploy-server.sh
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[ОШИБКА] GITHUB_TOKEN не задан."
  echo "  Запуск: GITHUB_TOKEN=ghp_xxx bash scripts/deploy-server.sh"
  echo "  Токен: https://github.com/settings/tokens → repo (read)"
  exit 1
fi
REPO_URL="https://${GITHUB_TOKEN}@github.com/mmpfrmvbg/osnova-fabrica.git"

echo ""
echo "=== Деплой ОСИРИСА на сервер ==="
echo ""

# ── 1. Проверка root ────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "[ОШИБКА] Скрипт должен запускаться от root"
  exit 1
fi

# ── 2. Зависимости системы ──────────────────────────────────────────────────
echo "[1/8] Установка системных зависимостей..."
apt-get update -qq
apt-get install -y -qq git curl build-essential python3 python3-pip

# ── 3. Node.js >= 20 ────────────────────────────────────────────────────────
echo "[2/8] Проверка Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$MAJOR" -lt $NODE_MIN_VERSION ]; then
    echo "  Node.js $NODE_VER < $NODE_MIN_VERSION — обновляем через NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "  Node.js $NODE_VER — OK"
  fi
else
  echo "  Node.js не найден — устанавливаем v20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  node $(node --version), npm $(npm --version)"

# ── 4. Пользователь ─────────────────────────────────────────────────────────
echo "[3/8] Настройка пользователя $OSIRIS_USER..."
if ! id "$OSIRIS_USER" &>/dev/null; then
  useradd -r -s /bin/false "$OSIRIS_USER"
  echo "  Пользователь $OSIRIS_USER создан"
else
  echo "  Пользователь $OSIRIS_USER уже существует"
fi

# ── 5. Репозиторий ──────────────────────────────────────────────────────────
echo "[4/8] Репозиторий..."
export GIT_TERMINAL_PROMPT=0
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Репозиторий существует — git pull..."
  cd "$INSTALL_DIR"
  # Обновляем remote URL с токеном на случай если изменился
  git remote set-url origin "$REPO_URL"
  git pull origin main
else
  echo "  Клонируем приватный репозиторий → $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$OSIRIS_USER":"$OSIRIS_USER" "$INSTALL_DIR"
# Убрать токен из remote URL после клонирования (безопасность)
git -C "$INSTALL_DIR" remote set-url origin \
  "https://github.com/mmpfrmvbg/osnova-fabrica.git"

# ── 6. npm install ──────────────────────────────────────────────────────────
echo "[5/8] Установка зависимостей npm (включая компиляцию better-sqlite3)..."
cd "$OSIRIS_DIR"
# Устанавливаем от root чтобы node-gyp мог компилировать нативные модули
npm install --no-audit --no-fund
chown -R "$OSIRIS_USER":"$OSIRIS_USER" "$OSIRIS_DIR/node_modules"

# ── 7. .env ─────────────────────────────────────────────────────────────────
echo "[6/8] Настройка .env..."
if [ ! -f "$OSIRIS_DIR/.env" ]; then
  cp "$OSIRIS_DIR/.env.example" "$OSIRIS_DIR/.env"
  # Серверные настройки: HTTP без tunnel
  sed -i 's/^TRANSPORT=.*/TRANSPORT=http/' "$OSIRIS_DIR/.env"
  sed -i 's/^USE_TUNNEL=.*/USE_TUNNEL=false/' "$OSIRIS_DIR/.env"
  sed -i 's/^HTTP_PORT=.*/HTTP_PORT=3000/' "$OSIRIS_DIR/.env"
  sed -i 's|^OSIRIS_HEALTH_URL=.*|OSIRIS_HEALTH_URL=http://localhost:3000|' "$OSIRIS_DIR/.env"
  # LLM: оставить заглушку — заполнить вручную если нужен openai-compatible
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────────┐"
  echo "  │  .env создан из .env.example.                               │"
  echo "  │  Для работы пайплайна заполни вручную:                      │"
  echo "  │    $OSIRIS_DIR/.env                                         │"
  echo "  │                                                              │"
  echo "  │  Вариант A (бесплатно):                                     │"
  echo "  │    OSNOVA_PROVIDER=qwen-cli                                 │"
  echo "  │    npm install -g @qwen-code/qwen-coder  (от root)          │"
  echo "  │                                                              │"
  echo "  │  Вариант B (DeepSeek API):                                  │"
  echo "  │    OSNOVA_PROVIDER=openai-compatible                        │"
  echo "  │    LLM_API_KEY=sk-...  (platform.deepseek.com)              │"
  echo "  │    LLM_BASE_URL=https://api.deepseek.com                    │"
  echo "  │    LLM_MODEL=deepseek-chat                                  │"
  echo "  └─────────────────────────────────────────────────────────────┘"
  echo ""
else
  echo "  .env уже существует — не перезаписываем"
fi
chown "$OSIRIS_USER":"$OSIRIS_USER" "$OSIRIS_DIR/.env"

# ── 8. Логи ─────────────────────────────────────────────────────────────────
echo "[7/8] Директория логов..."
mkdir -p "$LOG_DIR"
chown "$OSIRIS_USER":"$OSIRIS_USER" "$LOG_DIR"

# ── 9. systemd unit ─────────────────────────────────────────────────────────
echo "[8/8] systemd unit..."
# Создаём unit для HTTP (без tunnel) — отличается от scripts/osiris.service
cat > /etc/systemd/system/osiris.service << 'UNIT'
[Unit]
Description=ОСИРИС backend (HTTP, VPS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=osnova
WorkingDirectory=/opt/osnova/apps/osiris
ExecStart=/usr/bin/npm run osiris:http
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/osiris/osiris.log
StandardError=append:/var/log/osiris/osiris.err.log
Environment=NODE_ENV=production
EnvironmentFile=/opt/osnova/apps/osiris/.env

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable osiris
systemctl restart osiris
echo "  systemd unit osiris.service активирован"

# ── 10. Firewall ─────────────────────────────────────────────────────────────
echo ""
echo "[ Firewall ]"
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp comment "Осирис HTTP" 2>/dev/null || true
  echo "  ufw: порт 3000 открыт"
fi
if command -v iptables &>/dev/null; then
  iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || \
    iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
  echo "  iptables: порт 3000 открыт"
fi

# ── 11. Health check ─────────────────────────────────────────────────────────
echo ""
echo "[ Проверка ]"
echo "  Ждём запуска сервиса (5 сек)..."
sleep 5

if curl -sf --max-time 5 http://localhost:3000/health > /tmp/osiris_health.json 2>/dev/null; then
  echo "  ✓ Сервер отвечает: $(cat /tmp/osiris_health.json)"
else
  echo "  ✗ Сервер не ответил на /health — проверь логи:"
  echo "    journalctl -u osiris -n 30 --no-pager"
  echo "    tail -20 /var/log/osiris/osiris.err.log"
fi

echo ""
echo "==================================="
echo "  Деплой завершён."
echo ""
echo "  Управление:"
echo "    systemctl status osiris"
echo "    systemctl restart osiris"
echo "    journalctl -u osiris -f"
echo ""
echo "  Health: curl http://90.156.210.111:3000/health"
echo "==================================="
echo ""
