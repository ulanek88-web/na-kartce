#!/usr/bin/env bash
# Instalacja „Na kartce” na świeżym Ubuntu/Debian (Oracle Cloud Always Free lub dowolny VPS).
# Użycie:  bash deploy/setup.sh      (z katalogu projektu; można uruchomić ponownie – jest idempotentny)
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

echo "== 1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $SUDO sh; fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true
$SUDO docker compose version >/dev/null

echo "== 2/5 Pamięć (swap przy małym RAM)"
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 1900 ] && ! swapon --show | grep -q .; then
  $SUDO fallocate -l 2G /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  echo "   dodano 2 GB swap (RAM: ${MEM_MB} MB)"
fi

echo "== 3/5 Zapora systemowa (porty 80 i 443)"
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443 >/dev/null; fi
if command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do $SUDO iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT; done
  $SUDO iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
  if ! command -v netfilter-persistent >/dev/null 2>&1; then $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true; fi
  $SUDO netfilter-persistent save >/dev/null 2>&1 || true
fi

echo "== 4/5 Konfiguracja (.env)"
if [ ! -f .env ]; then
  [ -n "${DOMAIN:-}" ] || read -rp "   Twoja domena (np. nakartce.duckdns.org): " DOMAIN
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
  [ -n "$DOMAIN" ] || { echo "Brak domeny."; exit 1; }
  PW="${ADMIN_PASSWORD:-}"
  until [ "${#PW}" -ge 10 ] && [[ "$PW" != *"'"* ]]; do
    [ -z "$PW" ] || echo "   Za krótkie lub zawiera apostrof – spróbuj ponownie."
    read -rsp "   Hasło administratora (min. 10 znaków, bez apostrofu '): " PW; echo
  done
  umask 077; printf "DOMAIN=%s\nADMIN_PASSWORD='%s'\n" "$DOMAIN" "$PW" > .env
else echo "   używam istniejącego .env"; fi
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

echo "== 5/5 Budowa i start (pierwszy raz kilka minut)"
$SUDO docker compose -f docker-compose.prod.yml up -d --build
echo "   czekam na start aplikacji…"
for i in $(seq 1 60); do
  if $SUDO docker compose -f docker-compose.prod.yml exec -T nakartce wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then OK=1; break; fi; sleep 2
done
[ "${OK:-0}" = 1 ] && echo "   aplikacja działa" || { echo "   aplikacja nie odpowiada – logi:  sudo docker compose -f docker-compose.prod.yml logs --tail 50"; exit 1; }
echo
echo "Gotowe. Za 1–2 minuty (wystawianie certyfikatu) wejdź na:  https://$DOMAIN"
echo "Panel administratora:  https://$DOMAIN/admin/   login: admin, hasło: to podane wyżej"
echo "Jeśli HTTPS nie działa: sprawdź, czy domena wskazuje na IP serwera i czy porty 80/443 są otwarte u dostawcy."
