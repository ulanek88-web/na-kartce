# Wdrożenie, aktualizacja i rollback

## Wymagania
Node 22+ (wbudowany `node:sqlite`) albo Docker. Za reverse proxy z HTTPS (Caddy/nginx) – WebSocket musi być przekazywany jako WSS.

## Pierwsze uruchomienie (Docker)
1. `cp .env.example .env`, ustaw `ADMIN_PASSWORD` (min. 10 znaków), `ALLOWED_ORIGINS` (adres strony), `TRUST_PROXY=1`, jeśli aplikacja stoi za jednym reverse proxy.
2. `docker compose up -d --build` – aplikacja słucha tylko na `127.0.0.1:3000`; wystaw ją przez proxy.
3. Panel: `https://twoja-domena/admin/` (login `admin`). Dane (baza, klucz tokenów `secret.key`, kopie) są w wolumenie `/data`.

Przykład Caddy: `twoja-domena { reverse_proxy 127.0.0.1:3000 }` (WebSocket i HSTS działają bez dodatkowej konfiguracji; aplikacja sama ustawia CSP i pozostałe nagłówki).
Przykład nginx – dodaj do `location /`: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 120s;`

## Aktualizacja
1. **Kopia przed zmianą:** `docker compose exec nakartce node -e "require('./server/db').backup()"` (plik w `/data/backups/`, zachowywanych `BACKUP_KEEP`, domyślnie 7) lub w panelu: Ustawienia → „Pobierz kopię zapasową”. Skopiuj też `secret.key`.
2. `git pull && docker compose up -d --build`. Migracje uruchamiają się automatycznie przy starcie, w ustalonej kolejności (`server/migrations.js`, wersja zapisana w `PRAGMA user_version`); są addytywne (tworzą tabele/kolumny, nie usuwają danych) i idempotentne – sprawdza to `test/backup_migration.test.js`.
3. Kontrola: `curl -fs https://twoja-domena/health`, logowanie, jedna partia z botem, forum.
4. Zatrzymanie (`docker stop`) jest łagodne: serwer zamyka połączenia i zapisuje WAL. Partie w toku nie przetrwają restartu (stan trzymany w pamięci) – wdrażaj poza godzinami szczytu; niedokończone partie są po starcie usuwane z bazy.

## Rollback
1. `docker compose down` (wolumen z danymi zostaje).
2. Wróć do poprzedniej wersji kodu: `git checkout <poprzedni-tag-lub-commit>`.
3. **Jeżeli nowa wersja zmieniła schemat bazy** (zmienił się numer `user_version` w `server/migrations.js`): odtwórz kopię z kroku „Aktualizacja 1”: `docker compose run --rm -v $PWD/backup:/b nakartce sh -c "cp /b/nakartce-RRRR-MM-DD.db /data/nakartce.db && rm -f /data/nakartce.db-wal /data/nakartce.db-shm"`. Starsza wersja kodu nie rozumie nowszego schematu, dlatego sama zmiana kodu bez odtworzenia bazy bywa niewystarczająca (dodatkowe kolumny/tabele są ignorowane, ale nie ma gwarancji dla wszystkich zmian).
4. `docker compose up -d --build`, kontrola jak wyżej. Klucz `secret.key` musi pozostać ten sam, inaczej wszyscy zostaną wylogowani.

## Odtwarzanie po awarii
Zatrzymaj aplikację, podmień `/data/nakartce.db` kopią z `/data/backups/`, usuń pliki `-wal` i `-shm`, uruchom. Procedura jest sprawdzana testem (`test/backup_migration.test.js`: integrity_check, odtworzenie do nowego katalogu).

## Zmienne środowiskowe (skrót)
`ADMIN_PASSWORD`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `SECRET`, `MAX_WS`, `WS_PER_IP`, `AI_WORKERS`, `AI_MAX_QUEUE`, `BACKUP_KEEP`, `DATA_DIR`, `PORT`. Pełna lista: `.env.example`.

## Bezpieczeństwo – lista kontrolna przed publicznym startem
- [ ] `ADMIN_PASSWORD` ustawione i silne; zmień je po pierwszym logowaniu.
- [ ] Aplikacja dostępna wyłącznie przez HTTPS/WSS; `TRUST_PROXY` zgodne z liczbą proxy.
- [ ] `ALLOWED_ORIGINS` = adresy Twojej strony (i aplikacji natywnej, jeśli dotyczy).
- [ ] Regularne kopie `/data/backups/` poza serwerem + osobna kopia `secret.key`.
- [ ] `npm audit` w CI, aktualizacje obrazu bazowego `node:22-alpine`.
