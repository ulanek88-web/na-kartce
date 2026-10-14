# Checklista przed publicznym startem (na podstawie audytu przedwdrożeniowego)

Status wg audytu: **warunkowo gotowa do wdrożenia testowego**. Najpierw prywatny serwer testowy z HTTPS, bez zapraszania szerokiej publiczności, dopóki poniższe punkty nie są odhaczone. To nie jest certyfikat bezpieczeństwa ani zewnętrzny test penetracyjny.

## Już zrobione i potwierdzone
- [x] 16/16 plików testowych przechodzi (także z wymuszonymi kolorami terminala: `FORCE_COLOR=1 node test/run.js`). Wcześniejszy „błąd migracji” był wadą testu (parsowanie liczby z kolorowego wyjścia), nie aplikacji; test poprawiono, a procesy potomne działają teraz zawsze bez kolorów.
- [x] Kontrola składni i skan sekretów (`npm run check`).
- [x] Test obciążeniowy lokalny (`node tools/loadtest.js 25,100,250 12`, maszyna 1 CPU / 4 GB, generator na tej samej maszynie): 250 wirtualnych graczy, 786 partii, 0 błędów, REST p95 7 ms, RSS 114 MB. To dolne oszacowanie, nie deklaracja pojemności produkcyjnej. Powtórz na docelowym serwerze, np. `node tools/loadtest.js 25,100,250 15` (Oracle A1 ma 2 OCPU).

## Do zrobienia na serwerze testowym
1. **Konfiguracja produkcyjna.** Po `bash deploy/setup.sh` uruchom z dowolnego komputera: `bash deploy/smoke.sh https://twoja-domena`. Sprawdza: HTTPS i przekierowanie z HTTP, nagłówki bezpieczeństwa, HSTS (potwierdza poprawne `TRUST_PROXY`), odrzucanie API admina bez logowania, WebSocket (101) i wtyczkę gry. Wszystko ma być ✓. Zmień hasło administratora po pierwszym logowaniu. Trwałość danych: `sudo docker volume ls` musi pokazywać `nakartce_nakartce-data`; sprawdź ją restartem (`sudo docker compose -f docker-compose.prod.yml restart`), po którym konta nadal istnieją.
2. **Próba odtworzenia z kopii.** Na serwerze: `bash deploy/restore-drill.sh`. Tworzy kopię, uruchamia ją w osobnym jednorazowym kontenerze (produkcja nie jest dotykana) i wypisuje `integrity`, wersję bazy oraz liczby użytkowników, partii i gier. Porównaj te liczby z panelem. Dodatkowo raz sprawdź ręcznie, czy po odtworzeniu są ranking, turnieje, wtyczki i wgrane pliki (`/data/uploads`, `/data/plugins`; kopia `.db` ich nie zawiera, więc kopiuj też te katalogi i `secret.key`).
3. **Test obciążeniowy na serwerze.** Patrz wyżej. Obserwuj błędy WS/REST, pamięć i CPU. Przy 1 GB RAM (maszyna AMD) zacznij od `25,100`.
4. **Testy interfejsu (telefon i komputer).** Testy automatyczne wymagają Chromium (nie było go w środowisku audytu). Na komputerze z internetem: `pip install playwright && playwright install chromium && python3 test/responsive.py` (zrzuty w `/tmp/nk-shots/`, kod wyjścia 1 przy krytycznych naruszeniach). Potem ręcznie na prawdziwym telefonie: rejestracja i logowanie, lobby, plansze gier, turnieje, forum, panel admina, formularze i gra „67 nocy apokalipsy” (joystick, przyciski, wynik).
5. **Aplikacja Android.** Zbuduj APK (`npm run cap:sync`, `npm run cap:open`, Android Studio) i sprawdź na fizycznym urządzeniu: logowanie, utratę i odzyskanie połączenia, przycisk Wstecz, aktualizację aplikacji. W `ALLOWED_ORIGINS` dodaj adresy używane przez aplikację natywną.

## Decyzja o publicznym starcie
Szeroko udostępniaj dopiero, gdy punkty 1–5 są odhaczone, a próba odtworzenia i test obciążeniowy przeszły na docelowej konfiguracji. Do tego czasu nie rozsyłaj adresu serwera publicznie.
