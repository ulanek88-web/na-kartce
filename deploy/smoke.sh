#!/usr/bin/env bash
# Kontrola po wdrożeniu (uruchom z dowolnego komputera z curl):  bash deploy/smoke.sh https://twoja-domena
# Sprawdza: działanie, HTTPS i przekierowanie, nagłówki bezpieczeństwa, ochronę panelu admina, WebSocket i wtyczkę gry.
BASE=${1:?Użycie: bash deploy/smoke.sh https://twoja-domena}; BASE=${BASE%/}
fail=0; ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; fail=1; }
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" 2>/dev/null; }
hdrs=$(curl -s -m 15 -D - -o /dev/null "$BASE/" 2>/dev/null)
[ "$(code "$BASE/health")" = 200 ] && ok "/health odpowiada 200" || bad "/health nie odpowiada 200"
echo "$hdrs" | grep -qi '^content-security-policy:' && ok "nagłówek Content-Security-Policy" || bad "brak Content-Security-Policy"
echo "$hdrs" | grep -qi '^x-content-type-options: *nosniff' && ok "nagłówek X-Content-Type-Options: nosniff" || bad "brak nosniff"
if [[ "$BASE" == https://* ]]; then
  echo "$hdrs" | grep -qi '^strict-transport-security:' && ok "HSTS (potwierdza poprawne TRUST_PROXY za proxy)" || bad "brak HSTS – sprawdź TRUST_PROXY i proxy (X-Forwarded-Proto)"
  r=$(code "http://${BASE#https://}/"); [[ "$r" =~ ^30[1278]$ ]] && ok "HTTP przekierowuje na HTTPS ($r)" || bad "HTTP nie przekierowuje na HTTPS (kod $r)"
fi
[ "$(code "$BASE/admin/")" = 200 ] && ok "strona panelu /admin/ dostępna" || bad "/admin/ niedostępny"
r=$(code "$BASE/api/admin/stats"); [[ "$r" =~ ^40[13]$ ]] && ok "API admina bez logowania odrzucone ($r)" || bad "API admina bez logowania zwróciło $r (oczekiwano 401/403)"
r=$(code --http1.1 -m 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $BASE" "$BASE/ws")
[ "$r" = 101 ] && ok "WebSocket /ws przyjmuje połączenie (101)" || bad "WebSocket /ws zwrócił $r (oczekiwano 101) – sprawdź proxy i ALLOWED_ORIGINS"
r=$(code "$BASE/plugins/67-nocy-apokalipsy/game.js"); [ "$r" = 200 ] && ok "wtyczka „67 nocy apokalipsy” serwowana" || bad "wtyczka gry zwróciła $r"
curl -s -m 15 -D - -o /dev/null "$BASE/plugins/67-nocy-apokalipsy/index.html" 2>/dev/null | grep -qi "sandbox allow-scripts" && ok "wtyczka działa w piaskownicy (CSP sandbox)" || bad "brak CSP sandbox dla wtyczek"
echo; [ $fail = 0 ] && echo "WYNIK: wszystko w porządku" || { echo "WYNIK: są uwagi (✗) – popraw przed udostępnieniem użytkownikom"; exit 1; }
