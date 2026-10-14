# Konto administratora i logowanie

## Dane logowania
- **Login:** `admin`
- **Hasło:** to, które wpiszesz podczas instalacji (zmienna `ADMIN_PASSWORD`). Hasła **nie zapisujemy w żadnym pliku paczki**, a serwer nie wypisuje go w logach.

## Skąd się bierze konto
Konto `admin` (rola administratora) powstaje **automatycznie, raz**, przy pierwszym starcie serwera na pustej bazie, z hasła w `ADMIN_PASSWORD`. Hasło musi mieć min. 10 znaków (inaczej serwer wygeneruje losowe i wypisze je w logach jednorazowo). Zmiana `ADMIN_PASSWORD` **po** utworzeniu konta niczego nie zmienia. Użyj wtedy resetu (niżej).

## Jak założyć konto na serwerze
1. Uruchom `bash deploy/setup.sh`.
2. Gdy zapyta o hasło administratora, wpisz/wklej swoje hasło (podczas wpisywania nic się nie wyświetla, to normalne). Hasło nie może zawierać apostrofu `'`; znaki `$ # & ! @` są dozwolone.
3. Instalator zapisze je w pliku `.env` (dostęp tylko dla właściciela) i uruchomi serwer, który utworzy konto.

Wersja bez pytań (hasło trafi do historii powłoki, więc wolę pytanie):
`DOMAIN=twoja-domena ADMIN_PASSWORD='twoje-haslo' bash deploy/setup.sh`

Do testów lokalnych bez Dockera: `ADMIN_PASSWORD='twoje-haslo' node server/index.js`

## Jak się zalogować
1. Otwórz `https://twoja-domena/admin/` (lokalnie `http://localhost:3000/admin/`).
2. W polu „Nick lub e-mail” wpisz `admin`, w polu „Hasło” swoje hasło i kliknij **Zaloguj**.
3. Po zalogowaniu masz dostęp do pełnego panelu (gry, wtyczki, użytkownicy, forum, ustawienia, kopie zapasowe).

To samo konto działa też na stronie głównej gry (logowanie zwykłe).

## Po pierwszym logowaniu (ważne)
Hasło zostało przesłane w czacie, więc **traktuj je jako ujawnione i zmień na nowe**: na stronie głównej *Profil → Zmień hasło*. Nowego hasła nie wysyłaj nikomu w wiadomościach. Zmiana unieważnia stare sesje. Zapisz nowe hasło w menedżerze haseł. Jeśli ma służyć też w `.env`, nie musi się zgadzać, bo `.env` jest używane tylko przy tworzeniu konta.

## Zabezpieczenia logowania
Po 8 nieudanych próbach na jedno konto logowanie jest chwilowo blokowane (15 minut), a ruch z jednego adresu IP jest ograniczony. Jeśli „zablokujesz” się sam, poczekaj 15 minut albo użyj resetu poniżej.

## Reset hasła administratora (zapomniane hasło)
Na serwerze, w katalogu projektu:

`sudo docker compose -f docker-compose.prod.yml exec -e NEW_PASSWORD='nowe-haslo-min-10-znakow' nakartce node server/reset-admin.js`

Narzędzie ustawia nowe hasło konta `admin` i unieważnia wszystkie jego sesje (inny login: dopisz go na końcu polecenia). Bez Dockera: `NEW_PASSWORD='...' node server/reset-admin.js`.
