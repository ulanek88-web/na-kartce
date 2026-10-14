#!/usr/bin/env bash
# Próba odtworzenia z kopii zapasowej NA OSOBNYM, tymczasowym wolumenie (produkcja nie jest dotykana).
# Użycie na serwerze, w katalogu projektu:  bash deploy/restore-drill.sh
set -euo pipefail; cd "$(dirname "$0")/.."
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"; C="$SUDO docker compose -f docker-compose.prod.yml"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 777 "$TMP"
echo "1/4 Tworzę świeżą kopię w działającej aplikacji…"
$C exec -T nakartce node -e "require('./server/db').backup()"
FILE=$($C exec -T nakartce sh -c 'ls -1t /data/backups/*.db | head -1' | tr -d '\r')
echo "    plik: $FILE"
echo "2/4 Kopiuję kopię na hosta…"
$C cp "nakartce:$FILE" "$TMP/nakartce.db"; $C cp nakartce:/data/secret.key "$TMP/secret.key"
echo "3/4 Uruchamiam kopię w osobnym, jednorazowym kontenerze (ten sam obraz)…"
IMG=$($C images -q nakartce | head -1)
OUT=$($SUDO docker run --rm --user root -e DATA_DIR=/data -e ADMIN_PASSWORD='Drill-Only-Pass-1' -v "$TMP":/data --entrypoint node "$IMG" --disable-warning=ExperimentalWarning -e "
const D=require('./server/db');require('./server/migrations')(D);
const q=(s)=>D.get(s).n;
console.log(JSON.stringify({integrity:D.get('PRAGMA integrity_check').integrity_check,version:D.get('PRAGMA user_version').user_version,users:q('SELECT COUNT(*) n FROM users'),matches:q('SELECT COUNT(*) n FROM matches'),games:q('SELECT COUNT(*) n FROM games'),plugins:q('SELECT COUNT(*) n FROM games WHERE plugin IS NOT NULL')}))")
echo "4/4 Wynik odtworzenia: $OUT"
echo "$OUT" | grep -q '"integrity":"ok"' && echo "OK: kopia odtwarza się poprawnie. Porównaj liczby (users/matches/games) z panelem produkcyjnym." || { echo "BŁĄD: kopia nie przeszła kontroli spójności"; exit 1; }
