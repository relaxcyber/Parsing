#!/usr/bin/env bash
# Керування застосунком на сервері (Linux із systemd).
#   scripts/server.sh install   — перше встановлення і автозапуск
#   scripts/server.sh update    — оновити код, перезібрати, перезапустити
#   scripts/server.sh status | logs | stop
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
UNIT="$HOME/.config/systemd/user/parsing.service"
PORT="${PORT:-3000}"

die() { echo "Помилка: $*" >&2; exit 1; }

check() {
  command -v node >/dev/null || die "не знайдено Node.js (потрібен 22.12 або новіший)"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
    || die "Node.js $(node -v) застарий — потрібен 22.12 або новіший"
  [ -f .env ] || die "немає .env — скопіюйте .env.example у .env і заповніть"
  for k in DATABASE_URL MASTER_KEY DASHBOARD_PASSWORD; do
    grep -Eq "^$k=.+" .env || die "у .env не заповнено $k"
  done
}

build() {
  npm ci
  npm run db:migrate || die "міграції не застосувалися — перевірте DATABASE_URL і доступність бази"
  npm run build
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if out=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then echo "Сервер працює: $out"; return 0; fi
    sleep 1
  done
  echo "Сервер не відповів за 30 с. Останні рядки журналу:" >&2
  journalctl --user -u parsing -n 20 --no-pager >&2 || true
  exit 1
}

case "${1:-}" in
  install)
    check
    command -v systemctl >/dev/null || die "на сервері немає systemd — запускайте «npm start» власним способом"
    build
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Parsing dashboard
After=network-online.target

[Service]
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=PATH=$(dirname "$(command -v node)"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v npm) start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now parsing
    # Щоб сервіс працював і після виходу з SSH та перезавантаження сервера.
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "Увага: виконайте «sudo loginctl enable-linger $USER», інакше сервіс зупиниться після виходу з SSH."
    wait_healthy
    ;;
  update)
    check
    git pull --ff-only
    build
    systemctl --user restart parsing
    wait_healthy
    ;;
  status) systemctl --user status parsing --no-pager ;;
  logs) journalctl --user -u parsing -n "${2:-100}" --no-pager ;;
  stop) systemctl --user stop parsing ;;
  *) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
