# Darmowy serwer krok po kroku (Oracle Cloud Always Free + DuckDNS + Caddy)

## Dlaczego akurat to
Portal zapisuje dane w pliku SQLite w katalogu `/data` i trzyma partie oraz WebSockety w pamięci. Dlatego potrzebuje serwera, który działa bez przerwy i ma **trwały dysk**.

- **Oracle Cloud Always Free:** prawdziwa maszyna wirtualna z trwałym dyskiem, bez usypiania. Obecny limit darmowych maszyn ARM (Ampere A1) to łącznie 2 OCPU i 12 GB RAM (wcześniej 4/24). Do tego do dwóch maszyn AMD z 1 GB RAM. Wymaga karty płatniczej tylko do weryfikacji.
- **Render (plan darmowy) odpada:** usypia po 15 minutach bez ruchu, a darmowy plan nie ma trwałego dysku, więc baza kasowałaby się przy każdym restarcie lub wdrożeniu.
- Koszty i limity zmieniają się często. Przed założeniem konta sprawdź stronę *oracle.com/cloud/free*.

Znane problemy Oracle: w popularnych regionach często jest komunikat „Out of capacity” dla ARM (wtedy użyj maszyny AMD albo spróbuj za jakiś czas), a maszyny bardzo mało używane mogą zostać odzyskane przez Oracle po ostrzeżeniu.

## Krok po kroku
1. **Konto:** załóż je na *oracle.com/cloud/free*. Region wybierz najbliższy (np. Frankfurt). Kartę podajesz tylko do weryfikacji.
2. **Maszyna:** *Compute → Instances → Create instance*. Obraz: **Ubuntu 24.04** (lub 22.04). Kształt: *Ampere VM.Standard.A1.Flex* (2 OCPU, 12 GB). Jeśli pojawi się „Out of capacity”, wybierz *VM.Standard.E2.1.Micro* (AMD, 1 GB, wystarczy). Zaznacz **Assign a public IPv4 address**, pobierz klucz SSH (`.key`) i utwórz instancję. Zapisz **publiczny adres IP**.
3. **Porty w chmurze:** *Networking → Virtual Cloud Networks → twoja sieć → podsieć → Default Security List → Add Ingress Rules*: źródło `0.0.0.0/0`, protokół TCP, port docelowy `80`. Dodaj drugą regułę tak samo dla portu `443`.
4. **Darmowa domena:** wejdź na *duckdns.org*, zaloguj się, utwórz subdomenę (np. `nakartce`), w polu „current ip” wpisz IP z kroku 2 i zapisz. Domena to `nakartce.duckdns.org`.
5. **Wgraj projekt** (z komputera, w katalogu z paczką):
   `scp -i klucz.key nakartce-gotowe-do-wdrozenia.zip ubuntu@IP:~`
6. **Zaloguj się:** `ssh -i klucz.key ubuntu@IP` (na Linuksie/macOS najpierw `chmod 600 klucz.key`).
7. **Rozpakuj:** `sudo apt-get update && sudo apt-get install -y unzip && unzip nakartce-gotowe-do-wdrozenia.zip && cd nakartce`
8. **Uruchom instalator:** `bash deploy/setup.sh`. Poda domenę (np. `nakartce.duckdns.org`) i hasło administratora (min. 10 znaków). Zainstaluje Dockera, doda swap przy małym RAM, otworzy porty 80/443 w systemie, zbuduje obraz i wystartuje aplikację. Pierwsza budowa trwa kilka minut.
9. **Sprawdź i zaloguj się:** po 1–2 minutach (wystawianie certyfikatu HTTPS) wejdź na `https://twoja-domena/admin/`, login `admin`, hasło to podane w kroku 8. Szczegóły i reset hasła: `docs/LOGOWANIE-ADMIN.md`.
10. **Kontrola po wdrożeniu:** z dowolnego komputera `bash deploy/smoke.sh https://twoja-domena` (wszystko ma być ✓), a na serwerze `bash deploy/restore-drill.sh`. Dalsze kroki przed publicznym startem są w `docs/CHECKLISTA-PRZED-STARTEM.md`. Do ich zakończenia nie rozsyłaj adresu.
11. **Gra:** „67 nocy apokalipsy” zainstaluje się sama przy pierwszym starcie. Znajdziesz ją na liście gier.

## Codzienna obsługa
- **Logi:** `sudo docker compose -f docker-compose.prod.yml logs --tail 100 -f`
- **Restart:** `sudo docker compose -f docker-compose.prod.yml restart`
- **Aktualizacja:** wgraj nowy projekt (kroki 5–7 do nowego katalogu lub nadpisz pliki, zachowując `.env`), potem `sudo docker compose -f docker-compose.prod.yml up -d --build`. Dane w wolumenie zostają. Partie w toku przerwie restart.
- **Kopia zapasowa:** panel → Ustawienia → „Pobierz kopię zapasową”. Skopiuj też klucz tokenów: `sudo docker compose -f docker-compose.prod.yml cp nakartce:/data/secret.key .` Zrób to przed każdą aktualizacją i raz w tygodniu.
- **Nie usuwaj** wolumenów `nakartce-data` (dane) ani `caddy-data` (certyfikaty), np. przez `down -v`.

## Gdy coś nie działa
- **Strona się nie otwiera:** sprawdź, czy domena w DuckDNS wskazuje na właściwe IP (`nslookup twoja-domena`) i czy reguły z kroku 3 są dodane. Instalator otwiera porty tylko w systemie, a w chmurze trzeba to zrobić ręcznie.
- **Błąd certyfikatu:** `sudo docker compose -f docker-compose.prod.yml logs caddy`. Najczęściej domena jeszcze nie wskazuje na serwer.
- **Budowa kończy się brakiem pamięci:** upewnij się, że działa swap (`swapon --show`); instalator dodaje go sam przy RAM poniżej ok. 2 GB.
- **Nie pamiętasz hasła admina:** `.env` służy tylko do utworzenia konta, więc użyj resetu z `docs/LOGOWANIE-ADMIN.md`.
