# Na kartce – platforma gier online

Strona WWW + aplikacja na telefon (PWA i APK) + własny panel administratora (CMS). Jeden serwer Node.js, baza SQLite w jednym pliku. Jedyna (opcjonalna) zależność to `sharp` – przycinanie banerów reklamowych; bez niej wszystko działa, tylko obrazy są walidowane, a nie przeskalowywane.

**Gry:** szachy, warcaby (polskie 10×10), gomoku, kółko i krzyżyk (3×3 i 5×5), czwórki (i XL), piątki 19×19, reversi. Każda: gra z botem (3 poziomy), szybka gra online, **ponumerowane stoły**, pokoje prywatne po kodzie, ranking i turnieje. Kolejne gry dodasz z panelu (patrz niżej).

## 1. Uruchomienie (komputer / serwer)

Wymagany Node.js **22.13 lub nowszy**.

```bash
ADMIN_PASSWORD='TwojeHaslo123' npm start
```

- Gra: http://localhost:3000
- Panel administratora: http://localhost:3000/admin/ (login: `admin`, hasło z `ADMIN_PASSWORD`; jeśli go nie podasz, zostanie wygenerowane i wypisane w konsoli przy pierwszym starcie)
- Dane (baza, wgrane obrazy) leżą w `data/` – to jedyny katalog do backupu.
- Testy: `npm test` (silniki gier + test integracyjny z prawdziwymi graczami, turniejem i panelem).

### Docker
```bash
ADMIN_PASSWORD='TwojeHaslo123' docker compose up -d --build
```

### Publiczny serwer (VPS)
1. Wynajmij mały VPS (1 vCPU / 1 GB RAM wystarczy na start), zainstaluj Docker.
2. Skieruj domenę na serwer i postaw przed aplikacją HTTPS. Najprościej Caddy (WebSocket działa automatycznie):
   ```
   nakartce.pl {
     reverse_proxy localhost:3000
   }
   ```
3. HTTPS jest **konieczny** dla instalacji PWA i aplikacji Android.

## 1a. Stoły (lobby przed partią)
Po wybraniu gry → **Stoły**: numerowane stoły 1–20 (`TABLES_PER_GAME`, 4–60). Kto pierwszy usiądzie, zostaje **hostem 👑**. Wszystko działa przez WebSocket (`server/tables.js`), a uprawnienia sprawdza serwer.
- **Host:** ustawienia stołu (publiczny / prywatny z PIN-em 4–8 znaków, min./max. ranking co 50 pkt albo „± 50/100/200 od mojego”, partia rankingowa, zezwolenie na cofanie – domyślnie włączone, zegar „na turę” 15/30/60 s lub „łączny” 3/5/10 min na gracza), wyrzucanie gracza (komunikat „Zostałeś wyproszony ze stołu”, blokada powrotu na 5 min), zapraszanie. Gdy host wyjdzie, rolę dostaje następny gracz.
- **Gotowość:** przy stole widać nick, ranking, status Gotowy/Nie gotowy, liczbę ucieczek i % ukończonych gier. Partia startuje, gdy obaj są gotowi.
- **Dołączanie:** przycisk jest zablokowany z opisem, gdy ranking jest poza zakresem lub stół pełny; stół z PIN-em pyta o PIN (5 błędnych prób = 60 s blokady). **Zaproszenie** (pop-up „[nick] zaprasza Cię do gry”) omija PIN, ale nie próg rankingu. Lista zapraszanych = gracze, którzy w ostatnich 15 s oglądali stoły tej gry.
- **Czat** (stół i partia): serwer odrzuca w całości wiadomości z wulgaryzmami (`server/censor.js`: odmiany, polskie znaki, powtórzone litery, `k.u.r.w.a`, `ch0j`, `d*pa`), nadawca dostaje „Twoja wiadomość zawiera niedozwolone słowa”, reszta nic nie widzi. Limit: 1 wiadomość / 1,5 s. 6 szybkich wiadomości jednym kliknięciem. Własne słowa: `CENSOR_EXTRA=slowo1,slowo2`.
- **Cofanie ruchu:** przycisk „Cofnij ruch” → prośba do przeciwnika → po zgodzie serwer przywraca planszę, zegary i turę (z botem – od razu). Gdy host wyłączy opcję, przycisku nie ma.
- **Zegary:** liczy serwer. „Na turę” – brak ruchu w limicie = walkower dla rywala (powód: bezczynność/AFK); „łączny” – skończony czas = przegrana. Zegary stoją, gdy ktoś jest rozłączony.
- **Rozłączenie:** gra czeka na powrót (domyślnie 60 s, ustawienie `disconnect_grace_sec`, rywal widzi odliczanie) i wznawia się od przerwanego momentu. Brak powrotu = porażka uciekiniera, `users.rage_quits_count` +1, dodatkowa kara `RAGE_PENALTY` (domyślnie 30 pkt ELO w partii rankingowej), rywal wygrywa. Ucieczki i % ukończonych gier widać w profilu i przy stole.
- **Rewanż:** w podsumowaniu; gdy obaj klikną, startuje nowa partia z zamienionymi stronami i tymi samymi ustawieniami.

## 1b. Bezpieczeństwo i baza danych
- Katalog `data/` i baza mają prawa `0700/0600`; SQLite z `trusted_schema=OFF`, `secure_delete`, kluczami obcymi i kontrolą integralności przy starcie; zapytania wyłącznie parametryzowane.
- Automatyczna kopia (`VACUUM INTO`) do `data/backups/` co 6 h (jedna na dobę, ostatnie 7 – `BACKUP_KEEP`) oraz sprzątanie starych powiadomień, wyświetleń reklam i nieaktywnych gości.
- Wyzwalacze bazy blokują nieprawidłowe role i statusy gier. Hasła: scrypt + sól, porównanie w stałym czasie, limity prób logowania/rejestracji.
- CORS tylko dla własnej domeny (`ALLOWED_ORIGINS=https://nakartce.pl,https://www.nakartce.pl`) i aplikacji Android; nagłówki CSP, HSTS (za HTTPS), X-Frame-Options, Permissions-Policy.
- **Przed uruchomieniem produkcyjnym:** ustaw `ADMIN_PASSWORD` i stały `SECRET`, włącz HTTPS (Caddy), a kopie z `data/backups/` wysyłaj poza serwer.

## 2. Panel administratora (`/admin/`)

Działa na telefonie i komputerze.

| Zakładka | Co zrobisz |
|---|---|
| Pulpit | online, aktywni gracze, partie, wykresy, godziny gry, CTR reklam |
| Gry | **włączasz / wyłączasz / ukrywasz gry** jednym kliknięciem; **dodajesz nowe gry** |
| Reklamy | dodajesz kampanie: miejsce, obrazek, link, gra, odbiorcy, urządzenie, daty, limit na gracza, waga; statystyki wyświetleń i kliknięć |
| Treści | aktualności w lobby, strony (regulamin, pomoc, prywatność) |
| Użytkownicy | wyszukiwanie, ostrzeżenia, wyciszenia, bany, role (moderator/admin), reset rankingu, zmiana hasła |
| Moderacja | zgłoszenia graczy, dziennik działań |
| Turnieje | tworzenie, automatyczny start, ręczne wskazanie zwycięzcy |
| Ustawienia | gość/rejestracja, wyłącznik reklam, tryb prac, Elo, ligi |

### Jak dodać całkiem nową grę
Gry opisuje **silnik** + parametry. Dostępne silniki: *siatka m×n z k w linii* (kółko i krzyżyk, gomoku, czwórki i dowolne własne warianty – wystarczy ustawić rozmiar planszy), *reversi*, *warcaby* (8×8 / 10×10), *szachy*. W panelu: Gry → **+ Nowa gra** → wybierz szablon lub silnik → ustaw status „Aktywna”. Gra pojawia się graczom od razu, z rankingiem, botami, pokojami i turniejami.
Gra o zupełnie nowych zasadach (np. chińczyk, literaki) wymaga napisania nowego silnika w `shared/engines.js` (interfejs `init / legal / play / result / ai`) i jednego wpisu w rejestrze – reszta platformy działa bez zmian.

## 2a. Gry-pluginy, układ, reklamy, ogłoszenia (moduły rozszerzeń)

**Architektura:** serwer to czysty Node.js (własny router w `server/http.js`, bez Expressa – dzięki temu zero zależności; moduły rejestrują trasy tak samo jak Express). Nowe pliki: `server/migrations.js` (migracje wg `PRAGMA user_version`), `server/plugins.js` (pluginy, układ, ogłoszenia), `public/js/extras.js` (klient), `public/admin/extras.js` (panel), `public/plugin-sdk.js` (SDK gier).

**Plugin gry** = paczka ZIP (lub kod wklejony w panelu: *Pluginy*) z `manifest.json` i `index.html`:
```json
{ "slug": "klikacz", "name": "Klikacz", "icon": "👆", "hue": 280, "version": "1.0.0", "description": "…", "config": { "roundSec": 10 } }
```
Interfejs gry (`/plugin-sdk.js`): `NaKartce.register({ init(ctx), render(), start(), reset(), destroy(), onConfig(cfg) })` oraz zdarzenia `NaKartce.emit('state', 'started'|'over')`, `NaKartce.emit('score', n)`. Działający wzór: `docs/przyklad-plugin/` (gotowy ZIP: `docs/przyklad-plugin.zip`).
Bezpieczeństwo: pliki idą z `/plugins/<slug>/` z CSP `sandbox` i `connect-src 'none'`; aplikacja ładuje je w `<iframe sandbox="allow-scripts">`, więc plugin nie widzi sesji, ciasteczek ani API – tylko `postMessage`. ZIP: limit 6 MB / 200 plików, tylko dozwolone rozszerzenia, ochrona przed zip-slip. Nowa gra jest **ukryta** do czasu włączenia w *Układ gier*. Pluginy działają w jednym oknie (gry solo / lokalne); gry sieciowe 1 na 1 nadal wymagają silnika w `shared/engines.js`.

**Darmowy serwer od zera:** `docs/DARMOWY-SERWER.md` (Oracle Cloud Always Free + DuckDNS + Caddy, instalator `deploy/setup.sh`, plik `docker-compose.prod.yml`).

**Konto administratora i logowanie:** `docs/LOGOWANIE-ADMIN.md` (login `admin`, hasło z `ADMIN_PASSWORD`, reset: `server/reset-admin.js`).

**Przed publicznym startem:** `docs/CHECKLISTA-PRZED-STARTEM.md` (kontrola po wdrożeniu `deploy/smoke.sh`, próba odtworzenia `deploy/restore-drill.sh`).

**Wtyczki dołączone do portalu (`plugins-bundled/`):** każdy katalog `plugins-bundled/<slug>/` z `manifest.json` jest instalowany przy starcie serwera, jeśli gry o tym slugu jeszcze nie ma w bazie, i od razu włączany. Istniejącej gry nie nadpisujemy (zachowujesz ustawienia z panelu: układ, ukrycie, konfigurację). Aktualizacja takiej gry = wgranie nowej wersji ZIP w panelu *Pluginy* albo usunięcie jej w panelu i restart. Pierwsza taka gra: **67 nocy apokalipsy** (`plugins-bundled/67-nocy-apokalipsy/`, gotowy ZIP: `docs/67-nocy-apokalipsy.zip`). Parametry w *Układ gier → ⚙*: `dayLengthSec`, `nightLengthSec`, `maxNight`, `resourceRespawnSec`, `difficulty`.

**Układ gier:** panel → *Układ gier*: przeciąganie (⠿) lub strzałki ▲▼, przełącznik „widoczna”, zapis do SQLite (`games.sort`, `games.status`) i od razu w `GET /api/games` (strona, PWA, Android).
**Konfiguracja zdalna:** ⚙ przy grze w układzie zapisuje JSON (`games.cfg`), który gra dostaje w `ctx.config` i odświeżany jest co minutę bez restartu. Parametry platformy (czas partii, K-Elo, czas na powrót po rozłączeniu) zmieniasz w *Gry* / *Ustawienia* – też bez restartu.
**Reklamy:** miejsca: Top banner, Sidebar (ekrany ≥1100 px), Stopka, Interstitial, Lobby, Po partii, Kafelek. Rodzaj: baner (obrazek + link) albo **własny kod** HTML/JS wyświetlany w `<iframe sandbox>`; waga (priorytet), limit na gracza, daty, włącz/wyłącz globalnie (*Ustawienia*) i statystyki wyświetleń/kliknięć. Uwaga: Google AdSense w sandboxie bez `allow-same-origin` zwykle nie wyświetla reklam – dla AdSense użyj osobnej, własnej strony-opakowania pod swoją domeną jako baner/link albo oddzielnego iframe.
**API reklam wg pozycji:** `GET /api/ads` zwraca `{ top, sidebar, between_games, footer }` (każda pozycja: `{id,title,placement,type:'image_link'|'script_code',content,link}` albo `null`); `GET /api/ads?placement=top` – jedna pozycja. Mapowanie na miejsca w panelu: top = Top banner, sidebar = Sidebar, between_games = Pełny ekran (między partiami), footer = Stopka. Kontenery `#ad-top`, `#ad-sidebar`, `#ad-footer` są w `public/index.html`. Stary format `?slot=…` nadal działa.
**Gry:** tabela `games` (pluginy mają `plugin IS NOT NULL`) ma kolumny `sort_order` i `is_active` (migracja 2, synchronizowane triggerami z `sort`/`status`). `GET /api/games` zwraca tylko aktywne, wg `sort_order`.
**Walidacja wtyczek:** błędny/ucięty ZIP, zły manifest, zip-slip, „zip bomb”, powtórzone nazwy, niedozwolone pliki → 400/413 z opisem; instalacja jest atomowa (przy błędzie zostaje poprzednia wersja).

**Ogłoszenia:** panel → *Ogłoszenia*: pasek u góry lub pop-up, rodzaj (info/ostrzeżenie/nowość), okno czasowe; gracz zamyka je raz.
**Tryb konserwacji** i **analityka** (online, aktywni, partie, popularne gry, CTR reklam) – w *Ustawienia* i *Pulpit* (już były).

## 2b. Role (RBAC), kopia zapasowa, reklamy, blokady (v1.1)

**Role (wzorowane na WordPressie)** – uprawnienia sprawdza serwer (`A.CAPS` w `server/auth.js`), panel tylko ukrywa niedostępne zakładki.

| | Super Admin (`admin`) | Moderator / Młodszy Admin (`mod`) |
|---|---|---|
| Statystyki, reklamy (banery), ogłoszenia, cenzura, zgłoszenia, ostrzeżenia/wyciszenia/bany, wymuszone wylogowanie | ✔ | ✔ |
| Reklamy z własnym kodem HTML/JS | ✔ | ✘ |
| Gry, układ, wtyczki, ustawienia, turnieje, treści | ✔ | ✘ |
| Zmiana ról i haseł, zerowanie rankingów, usuwanie kont | ✔ | ✘ |
| Tworzenie kont personelu, **kopia zapasowa .zip** | ✔ | ✘ |

Super Admin tworzy konta w zakładce **Konta i kopia** (`POST /api/admin/accounts`).

**Kopia zapasowa:** zakładka *Konta i kopia* → „Pobierz pełną kopię zapasową (.zip)” (`GET /api/admin/backup`, tylko Super Admin, limit 3 pobrania / 10 min). Archiwum: `database/nakartce.db` (spójna migawka `VACUUM INTO`), `uploads/` (banery, obrazy, awatary), `plugins/` (gry-wtyczki) i `README.txt` z instrukcją przywracania. Plik zawiera dane osobowe i klucz sesji – trzymaj go bezpiecznie.

**Reklamy:** maks. 2 MB; proporcje muszą pasować do miejsca (Top/Footer 728×90, Sidebar/Między grami 300×250, tolerancja 3%) – inaczej plik jest odrzucany z opisem. Poprawny obraz serwer przycina (`cover`) i przeskalowuje do wymiarów docelowych (WebP, `sharp`). Harmonogram: 1 dzień / 2 dni / 1 tydzień / 1 miesiąc (od chwili zapisu), zakres dat, bezterminowo. Każda reklama ma własny czas slajdu; `GET /api/ads?slides=1` zwraca listę slajdów na miejsce, a klient robi płynny slider i zgłasza wyświetlenia przez `POST /api/ads/:id/view`.

**Blokowanie graczy:** przycisk „Zablokuj” w profilu gracza i przy stole; lista z „Odblokuj” w Profilu (`/api/me/blocks`). Blokada ukrywa wiadomości zablokowanego (czat stołu i partii), odrzuca jego zaproszenia i wyklucza parę z szybkiego dobierania. Wszystko egzekwuje serwer.

**Moderacja kont:** ban 1 h / 24 h / 7 dni / 30 dni / na stałe, **wymuszone wylogowanie** (podbicie `users.token_version` unieważnia tokeny na wszystkich urządzeniach i zamyka WebSocket), **usunięcie z anonimizacją** (nick „Usunięty gracz”, brak e-maila i hasła, usunięte rankingi/powiadomienia/blokady; partie zostają bez danych osobowych).

**Cenzura:** wbudowany słownik + własne słowa w zakładce *Cenzura* (bez restartu).

**Naprawione błędy:** trigger bazy odrzucał rolę `mod` (nadanie roli moderatora kończyło się błędem) – migracja 4 go poprawia.

## 3. Aplikacja na telefon

### a) Jako strona / PWA (działa od razu)
Otwórz adres serwera w Chrome na telefonie → menu → **Zainstaluj aplikację** (lub „Dodaj do ekranu głównego”). Aplikacja uruchamia się na pełnym ekranie jak natywna.

### b) Jako plik APK (Android)
APK to ta sama aplikacja opakowana w Capacitor i łącząca się z **Twoim serwerem**.
Najprościej przez GitHub (nie trzeba nic instalować):
1. Wgraj ten katalog do repozytorium na GitHub.
2. Zakładka **Actions → Build Android APK → Run workflow**, wpisz adres serwera (`https://nakartce.pl`).
3. Po kilku minutach pobierz plik `app-debug.apk` z artefaktów, wyślij na telefon i zainstaluj (zezwól na instalację z nieznanych źródeł).

Lokalnie (Android Studio + JDK 17):
```bash
npm install
export NK_SERVER=https://nakartce.pl
node tools/prepare_www.js      # kopiuje aplikację do www/ i wpisuje adres serwera
npx cap add android            # tylko za pierwszym razem
npx cap sync android
npx cap open android           # Android Studio → Build → Build APK(s)
```
Do sklepu Google Play potrzebny jest podpisany pakiet AAB (konto deweloperskie Google, jednorazowo 25 USD) – wygenerujesz go z Android Studio z tego samego projektu.

## 4. Zasady rankingów
- Ranking **Elo** (start 1200) dla każdej gry osobno; liczą się tylko partie rankingowe między zarejestrowanymi graczami. Goście i partie z botami nie wpływają na ranking.
- Rankingi okresowe (dzień/tydzień/miesiąc/rok): wygrana 3 pkt, remis 1, porażka 0.
- Liga tygodniowa: +25 / +10 / −8 punktów za wygraną / remis / porażkę, progi lig ustawiasz w panelu.

## 5. Czego jeszcze nie ma (kolejne etapy)
Logowanie przez Google/Apple (wymaga kluczy OAuth), weryfikacja e-mail i odzyskiwanie hasła (wymaga skrzynki SMTP), powiadomienia push (Firebase), lista znajomych, płatności/premium, turnieje szwajcarskie i kołowe, samoobsługowe konta reklamodawców, gry wymagające nowych silników i widoków (chińczyk, literaki, domino, młynek, statki, karty – w panelu są oznaczone „wkrótce”).

## Struktura
```
server/    serwer HTTP + WebSocket, baza, API, panel (admin.js), boty (worker_threads)
shared/    silniki gier (te same pliki w serwerze i w przeglądarce)
public/    aplikacja gracza (SPA/PWA) i /admin/
tools/     ikony, przygotowanie aplikacji Android
test/      testy
```

## Testy, bezpieczeństwo, wdrożenie (audyt v1.3)
- `npm test` – 12 plików testowych uruchamianych równolegle z limitem czasu na plik (`test/run.js`); `npm run check` – składnia + skan sekretów; `npm run test:responsive` i `python3 test/xss.py` – testy w przeglądarce (Playwright); `npm run loadtest` – test obciążeniowy.
- Wdrożenie, aktualizacja i **rollback**: `docs/WDROZENIE.md`. Za reverse proxy ustaw `TRUST_PROXY=1` (bez proxy zostaw puste).
