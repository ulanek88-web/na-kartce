'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch (e) { /* np. Windows */ }
/* migracja ze starej nazwy bazy (GRALNIA -> Na kartce) */
const DB_PATH = path.join(DATA_DIR, process.env.DB_FILE || 'nakartce.db'), OLD_DB = path.join(DATA_DIR, 'gralnia.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB)) for (const x of ['', '-wal', '-shm']) { try { fs.renameSync(OLD_DB + x, DB_PATH + x); } catch (e) { /* brak pliku */ } }
const db = new DatabaseSync(DB_PATH);
/* zabezpieczenia: klucze obce, brak zaufanych schematów/funkcji, nadpisywanie usuniętych danych, prawa 0600 */
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;');
for (const x of ['', '-wal', '-shm']) { try { fs.chmodSync(DB_PATH + x, 0o600); } catch (e) { /* jeszcze nie istnieje */ } }
{ const ic = db.prepare('PRAGMA quick_check').get(); if (Object.values(ic)[0] !== 'ok') { console.error('UWAGA: kontrola integralności bazy nie przeszła:', ic); } }

const cache = new Map();
const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
const get = (sql, ...p) => st(sql).get(...p);
const all = (sql, ...p) => st(sql).all(...p);
const run = (sql, ...p) => { const r = st(sql).run(...p); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; };
const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
};
const now = () => Date.now();

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, nick TEXT NOT NULL, nick_lc TEXT NOT NULL UNIQUE, email TEXT, email_lc TEXT UNIQUE,
  pass_hash TEXT, pass_salt TEXT, guest INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'user',
  hue INTEGER NOT NULL DEFAULT 150, bio TEXT NOT NULL DEFAULT '', banned_until INTEGER NOT NULL DEFAULT 0, ban_reason TEXT,
  muted_until INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS games(
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '?', icon_url TEXT,
  hue INTEGER NOT NULL DEFAULT 150, category TEXT NOT NULL DEFAULT 'Planszowe', description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '', engine TEXT, params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'soon',
  time_sec INTEGER NOT NULL DEFAULT 0, inc_sec INTEGER NOT NULL DEFAULT 0, rated INTEGER NOT NULL DEFAULT 1,
  bots INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 100, base_online INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ratings(
  user_id INTEGER NOT NULL, game_id INTEGER NOT NULL, rating INTEGER NOT NULL, games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, game_id));
CREATE INDEX IF NOT EXISTS ix_ratings_game ON ratings(game_id, rating DESC);
CREATE TABLE IF NOT EXISTS matches(
  id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, p1 INTEGER, p2 INTEGER, bot_level TEXT, bot_side INTEGER NOT NULL DEFAULT 0,
  result INTEGER, reason TEXT, rated INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'queue', moves TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, ended_at INTEGER, d1 INTEGER NOT NULL DEFAULT 0, d2 INTEGER NOT NULL DEFAULT 0,
  r1 INTEGER, r2 INTEGER, tm_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_matches_p1 ON matches(p1, ended_at DESC);
CREATE INDEX IF NOT EXISTS ix_matches_p2 ON matches(p2, ended_at DESC);
CREATE INDEX IF NOT EXISTS ix_matches_game ON matches(game_id, ended_at DESC);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, game_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  outcome INTEGER NOT NULL, pts INTEGER NOT NULL, delta INTEGER NOT NULL, league_pts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_game_ts ON events(game_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_user_ts ON events(user_id, ts);
CREATE TABLE IF NOT EXISTS ads(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'lobby_banner', title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', image_url TEXT, link_url TEXT, color INTEGER NOT NULL DEFAULT 40, game_id INTEGER,
  audience TEXT NOT NULL DEFAULT 'all', device TEXT NOT NULL DEFAULT 'all', enabled INTEGER NOT NULL DEFAULT 1,
  start_at INTEGER NOT NULL DEFAULT 0, end_at INTEGER NOT NULL DEFAULT 0, max_per_day INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
  budget_note TEXT NOT NULL DEFAULT '', advertiser TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ad_views(ad_id INTEGER NOT NULL, who TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ad_id, who, day));
CREATE TABLE IF NOT EXISTS news(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'news',
  pinned INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pages(slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, target_id INTEGER NOT NULL, game_id INTEGER, match_id INTEGER,
  reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', resolution TEXT,
  created_at INTEGER NOT NULL, handled_by INTEGER, handled_at INTEGER);
CREATE TABLE IF NOT EXISTS mod_actions(id INTEGER PRIMARY KEY, admin_id INTEGER, user_id INTEGER, action TEXT NOT NULL, note TEXT, until INTEGER, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tournaments(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, game_id INTEGER NOT NULL, start_at INTEGER NOT NULL, max_players INTEGER NOT NULL DEFAULT 32,
  format TEXT NOT NULL DEFAULT 'elimination', prize TEXT NOT NULL DEFAULT '', sponsor TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', winner_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tournament_players(tid INTEGER NOT NULL, user_id INTEGER NOT NULL, seed INTEGER, joined_at INTEGER NOT NULL, PRIMARY KEY(tid, user_id));
CREATE TABLE IF NOT EXISTS tournament_matches(
  id INTEGER PRIMARY KEY, tid INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, p1 INTEGER, p2 INTEGER,
  winner INTEGER, match_id INTEGER, status TEXT NOT NULL DEFAULT 'waiting', bye INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_tm ON tournament_matches(tid, round, slot);
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL, link TEXT, ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_notifs ON notifs(user_id, read, ts);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

/* ---------- migracje i wzmocnienia (bezpieczne do wielokrotnego uruchamiania) ---------- */
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_users_role BEFORE UPDATE OF role ON users WHEN NEW.role NOT IN ('user','mod','admin') BEGIN SELECT RAISE(ABORT,'bad role'); END;
CREATE TRIGGER IF NOT EXISTS trg_users_role_i BEFORE INSERT ON users WHEN NEW.role NOT IN ('user','mod','admin') BEGIN SELECT RAISE(ABORT,'bad role'); END;
CREATE TRIGGER IF NOT EXISTS trg_games_status BEFORE UPDATE OF status ON games WHEN NEW.status NOT IN ('active','soon','hidden','off') BEGIN SELECT RAISE(ABORT,'bad status'); END;
CREATE INDEX IF NOT EXISTS ix_users_seen ON users(last_seen);
CREATE INDEX IF NOT EXISTS ix_reports_status ON reports(status, created_at);
`);
db.exec("UPDATE settings SET value='Na kartce' WHERE key='site_name' AND value IN ('GRALNIA','Gralnia')");

/* ---------- kopie zapasowe (spójne, VACUUM INTO) + sprzątanie ---------- */
function backup() {
  if (closed) return;
  try {
    const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, 'nakartce-' + new Date().toISOString().slice(0, 10) + '.db');
    if (!fs.existsSync(f)) { db.exec("VACUUM INTO '" + f.replace(/'/g, "''") + "'"); try { fs.chmodSync(f, 0o600); } catch (e) { /* ignore */ } }
    const keep = Number(process.env.BACKUP_KEEP || 7);
    fs.readdirSync(dir).filter((n) => /^nakartce-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort().slice(0, -keep).forEach((n) => fs.unlinkSync(path.join(dir, n)));
  } catch (e) { console.error('Backup nieudany:', e.message); }
}
/** Partie bez zakończenia mogą istnieć tylko jeśli serwer został zatrzymany w trakcie gry – stan w pamięci przepadł, więc nie da się ich wznowić. Turniejowych nie ruszamy. */
function cleanupOrphans(olderThanMs) {
  const r = st('DELETE FROM matches WHERE ended_at IS NULL AND tm_id IS NULL AND started_at<?').run(Date.now() - (olderThanMs || 0));
  return Number(r.changes);
}
function housekeeping() {
  if (closed) return;
  const t = Date.now();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    st('DELETE FROM notifs WHERE ts<?').run(t - 90 * 864e5);
    cleanupOrphans(24 * 3600e3);
    st('DELETE FROM ad_views WHERE day<?').run(new Date(t - 60 * 864e5).toISOString().slice(0, 10));
    st("DELETE FROM users WHERE guest=1 AND last_seen<? AND id NOT IN (SELECT p1 FROM matches WHERE p1 IS NOT NULL UNION SELECT p2 FROM matches WHERE p2 IS NOT NULL)").run(t - 30 * 864e5);
  } catch (e) { console.error('Sprzątanie bazy:', e.message); }
}
setTimeout(() => { backup(); housekeeping(); }, 5000).unref();
setInterval(() => { backup(); housekeeping(); }, 6 * 3600e3).unref();

/* ---------- ustawienia ---------- */
const DEFAULT_SETTINGS = {
  site_name: 'Na kartce',
  tagline: 'Gry online. Zagraj z innymi.',
  allow_guests: '1',
  allow_register: '1',
  maintenance: '0',
  maintenance_msg: 'Trwają prace techniczne. Wróć za chwilę.',
  ads_enabled: '1',
  default_rating: '1200',
  k_factor: '24',
  disconnect_grace_sec: '60',
  bot_autojoin_sec: '120',        // po ilu sekundach samotnego oczekiwania przy stole publicznym dołącza bot CPU (0 = wyłączone)
  bot_auto_level: 'm',            // poziom automatycznego bota: e / m / h
  bot_disguise: '1',              // 1 = bot przy stole ma losowy nick i awatar (jak prawdziwy gracz)
  bot_names: 'Krzysiek92,Ania_Kartka,PancernyMarek,Kasia_W,Tomek_Szachista,Zbyszek77,MagdaGra,Wojtek.K,Bartek_Pro,Ola_Kropka,Darek1985,Natalia_N,Marcin_B,Kuba_Warcab,Iga_Gomoku,Staszek,Paulina_M,Rafał_T,Gosia2000,Kamil_Reversi,Mietek,Agata_P,Łukasz88,Bartosz_Z,Weronika_K,Czesiek,Dominik_L,Ewa_Kółko,Janek_Statki,Zosia_Mat',
  forum_enabled: '1',             // wyłącznik całego forum
  forum_cooldown_sec: '30',       // odstęp między postami jednego użytkownika (anty-spam)
  leagues: JSON.stringify([
    { n: 'Brązowa', min: 0, color: '#B07A4A' }, { n: 'Srebrna', min: 150, color: '#98A5AD' },
    { n: 'Złota', min: 400, color: '#D9A400' }, { n: 'Diamentowa', min: 800, color: '#3FB6E8' },
    { n: 'Mistrzowska', min: 1500, color: '#C23B5A' }
  ])
};
let settingsCache = null;
function settings() {
  if (!settingsCache) {
    const o = Object.assign({}, DEFAULT_SETTINGS);
    for (const r of all('SELECT key,value FROM settings')) o[r.key] = r.value;
    settingsCache = o;
  }
  return settingsCache;
}
function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) return false;
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  settingsCache = null;
  return true;
}
const sBool = (k) => settings()[k] === '1';
const sNum = (k) => Number(settings()[k]);

/* ---------- sekret do podpisywania tokenów ---------- */
function secret() {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* nowy */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

/* ---------- dane startowe ---------- */
const SEED_GAMES = [
  { slug: 'szachy', name: 'Szachy', icon: '♞', hue: 215, category: 'Planszowe', engine: 'chess', params: {}, status: 'active', time_sec: 600, base: 1240,
    description: 'Klasyczna gra strategiczna dla dwóch osób. Zamatuj króla przeciwnika.',
    rules: 'Biali zaczynają. Każda bierka porusza się inaczej: pion o jedno pole do przodu (z pozycji wyjściowej o dwa), a bije na ukos; skoczek skacze w kształcie litery L; goniec porusza się po przekątnych; wieża po liniach i kolumnach; hetman jak wieża i goniec razem; król o jedno pole.\n\nSzach: król jest atakowany, trzeba go obronić. Mat: obrony nie ma i partia kończy się wygraną atakującego. Pat lub trzykrotne powtórzenie pozycji, reguła 50 ruchów oraz zbyt mały materiał kończą partię remisem.\n\nSpecjalne ruchy: roszada (król i wieża, jeśli jeszcze się nie ruszały, a pola między nimi są wolne i nie są atakowane), bicie w przelocie oraz promocja piona na ostatnim rzędzie (do hetmana, wieży, gońca lub skoczka).' },
  { slug: 'warcaby', name: 'Warcaby', icon: '◉', hue: 12, category: 'Planszowe', engine: 'checkers', params: { n: 10 }, status: 'active', time_sec: 600, base: 620,
    description: 'Polskie warcaby 10×10 z bicie obowiązkowym i damkami latającymi.',
    rules: 'Plansza 10×10, każdy gracz ma 20 pionów. Piony poruszają się po przekątnej o jedno pole do przodu. Bicie jest obowiązkowe, można bić do przodu i do tyłu, a gdy jest kilka dróg bicia, trzeba wybrać tę, która zbija najwięcej bierek.\n\nPion, który kończy ruch na ostatnim rzędzie, zostaje damką. Damka porusza się po przekątnej o dowolną liczbę pól i bije z dystansu. Wygrywa ten, kto zbije lub zablokuje wszystkie bierki przeciwnika. 25 posunięć samymi damkami bez bicia to remis.' },
  { slug: 'gomoku', name: 'Gomoku', icon: '●', hue: 160, category: 'Planszowe', engine: 'mnk', params: { w: 15, h: 15, k: 5, gravity: false }, status: 'active', time_sec: 300, base: 320,
    description: 'Ułóż pięć swoich kamieni w jednej linii na planszy 15×15.',
    rules: 'Gracze na zmianę stawiają kamienie na przecięciach linii. Czarne zaczynają. Wygrywa ten, kto pierwszy ułoży pięć (lub więcej) swoich kamieni w nieprzerwanej linii: poziomo, pionowo lub po przekątnej.' },
  { slug: 'kolko-krzyzyk', name: 'Kółko i krzyżyk', icon: '✕', hue: 40, category: 'Planszowe', engine: 'mnk', params: { w: 3, h: 3, k: 3, gravity: false }, status: 'active', time_sec: 60, base: 410,
    description: 'Klasyk 3×3. Trzy w linii wygrywają.',
    rules: 'Gracze na zmianę zajmują wolne pola planszy 3×3. Wygrywa ten, kto pierwszy ułoży trzy swoje znaki w jednej linii. Przy rozsądnej grze obu stron partia kończy się remisem.' },
  { slug: 'czworki', name: 'Czwórki', icon: '▥', hue: 205, category: 'Planszowe', engine: 'mnk', params: { w: 7, h: 6, k: 4, gravity: true }, status: 'active', time_sec: 180, base: 280,
    description: 'Wrzucaj żetony do kolumn i ułóż cztery w jednej linii.',
    rules: 'Plansza ma 7 kolumn i 6 rzędów. W swoim ruchu wybierasz kolumnę, a żeton spada na najniższe wolne pole. Wygrywa ten, kto pierwszy ułoży cztery żetony w poziomie, pionie lub po przekątnej.' },
  { slug: 'reversi', name: 'Reversi', icon: '◐', hue: 140, category: 'Planszowe', engine: 'reversi', params: {}, status: 'active', time_sec: 300, base: 260,
    description: 'Otaczaj pionki przeciwnika i przejmuj je na swoją stronę.',
    rules: 'Stawiasz pionek tak, aby między nim a innym Twoim pionkiem (w linii prostej lub na ukos) znalazły się pionki przeciwnika. Wszystkie zostają przejęte. Jeśli nie masz ruchu, pasujesz. Gdy nikt nie może się ruszyć, wygrywa ten, kto ma więcej pionków.' }
];
const SOON = [
  ['chinczyk', 'Chińczyk', '⚄', 350, 'Planszowe', 510], ['literaki', 'Literaki', 'Ab', 50, 'Słowne', 830], ['mlynek', 'Młynek', '▦', 28, 'Planszowe', 190],
  ['domino', 'Domino', '⠿', 260, 'Planszowe', 240], ['statki', 'Statki', '⚓', 200, 'Planszowe', 280], ['tysiac', 'Tysiąc', '♠', 230, 'Karcianki', 350],
  ['makao', 'Makao', '♥', 355, 'Karcianki', 300], ['duren', 'Dureń', '♣', 120, 'Karcianki', 400], ['remik', 'Remik', '♦', 20, 'Karcianki', 180],
  ['go', 'Go', '◎', 100, 'Planszowe', 120], ['hex', 'Hex', '⬡', 300, 'Planszowe', 60], ['mancala', 'Mancala', '◠', 75, 'Planszowe', 90], ['kulki', 'Kulki', '○', 185, 'Logiczne', 340]
];
function seed() {
  if (!get('SELECT 1 FROM games LIMIT 1')) {
    let i = 0;
    for (const g of SEED_GAMES) {
      run('INSERT INTO games(slug,name,icon,hue,category,description,rules,engine,params,status,time_sec,sort,base_online,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        g.slug, g.name, g.icon, g.hue, g.category, g.description, g.rules, g.engine, JSON.stringify(g.params), g.status, g.time_sec, (i++) * 10, g.base, now());
    }
    for (const [slug, name, icon, hue, cat, base] of SOON) {
      run('INSERT INTO games(slug,name,icon,hue,category,description,engine,status,sort,base_online,created_at) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)',
        slug, name, icon, hue, cat, 'Ta gra pojawi się w jednej z kolejnych aktualizacji.', 'soon', 100 + (i++) * 10, base, now());
    }
  }
  if (!get('SELECT 1 FROM pages LIMIT 1')) {
    const P = (slug, title, body) => run('INSERT INTO pages(slug,title,body,updated_at) VALUES(?,?,?,?)', slug, title, body, now());
    P('regulamin', 'Regulamin', 'Wzór regulaminu do uzupełnienia przez administratora w panelu (Treści → Strony).\n\n1. Serwis Na kartce udostępnia gry online dla graczy.\n2. Zabronione są: obrażanie innych graczy, spam, oszukiwanie i używanie programów podpowiadających ruchy.\n3. Administrator może wyciszyć lub zablokować konto naruszające regulamin.\n4. Konto gościa może zostać usunięte po dłuższym okresie nieaktywności.');
    P('pomoc', 'Pomoc i FAQ', 'Jak zacząć? Wybierz grę w lobby i naciśnij „Graj online”, aby znaleźć rywala, albo „Z botem”, aby poćwiczyć.\n\nCzy muszę mieć konto? Nie. Jako gość zagrasz w każdą grę, ale partie rankingowe i miejsce w rankingu wymagają założenia konta. Konto gościa możesz później zamienić na pełne bez utraty historii.\n\nJak działa ranking? Dla każdej gry prowadzimy osobny ranking ELO. Wygrane z innymi graczami w partiach rankingowych podnoszą ranking, porażki obniżają.\n\nJak zgłosić gracza? Na ekranie partii lub w profilu gracza wybierz „Zgłoś”.');
    P('prywatnosc', 'Polityka prywatności', 'Wzór do uzupełnienia przez administratora. Opisz, jakie dane zbierasz (nick, e-mail, wyniki partii), w jakim celu i jak długo je przechowujesz oraz jak użytkownik może poprosić o ich usunięcie.');
  }
  if (!get('SELECT 1 FROM news LIMIT 1')) {
    run('INSERT INTO news(title,body,kind,pinned,created_at) VALUES(?,?,?,?,?)', 'Witaj na kartce', 'Sześć gier na start: szachy, warcaby, gomoku, kółko i krzyżyk, czwórki i reversi. Zagraj jako gość albo załóż konto i wejdź do rankingu.', 'banner', 1, now());
  }
  if (!get('SELECT 1 FROM ads LIMIT 1')) {
    run('INSERT INTO ads(name,slot,title,text,color,enabled,advertiser,budget_note,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'Przykładowa reklama w lobby', 'lobby_banner', 'Tu może być Twoja reklama', 'To jest reklama testowa. Usuń ją albo edytuj w panelu administratora (Reklamy).', 40, 0, 'Na kartce', '', now());
  }
}
const EXTRA = [
  { slug: 'kolko-krzyzyk-5', name: 'Kółko i krzyżyk 5×5', icon: '✖', hue: 25, engine: 'mnk', params: { w: 5, h: 5, k: 4, gravity: false }, time_sec: 120, base: 150, description: 'Większa plansza, cztery w linii – więcej taktyki niż w klasyku.', rules: 'Plansza 5×5. Gracze na zmianę stawiają znaki. Wygrywa ten, kto pierwszy ułoży cztery swoje znaki w jednej linii (poziomo, pionowo lub na ukos). Pełna plansza bez zwycięzcy to remis.' },
  { slug: 'piatki-19', name: 'Piątki 19×19', icon: '◌', hue: 95, engine: 'mnk', params: { w: 19, h: 19, k: 5, gravity: false }, time_sec: 420, base: 90, description: 'Gomoku na dużej planszy 19×19 – dla cierpliwych strategów.', rules: 'Gracze na zmianę kładą kamienie na przecięciach linii. Wygrywa ten, kto pierwszy ułoży pięć swoich kamieni w jednej linii.' },
  { slug: 'czworki-xl', name: 'Czwórki XL', icon: '▦', hue: 185, engine: 'mnk', params: { w: 9, h: 7, k: 5, gravity: true }, time_sec: 240, base: 70, description: 'Większa wersja Czwórek: plansza 9×7, do wygranej potrzeba pięciu żetonów.', rules: 'Wrzucasz żeton do wybranej kolumny – spada na dno lub na inne żetony. Wygrywa ten, kto pierwszy ułoży pięć swoich żetonów w linii.' },
  { slug: 'kropki-pudelka', name: 'Kropki i Pudełka', icon: '▣', hue: 330, engine: 'dots', params: { w: 6, h: 6 }, time_sec: 300, base: 120, description: 'Łącz kropki ołówkiem i długopisem – kto zamknie więcej pudełek, wygrywa.', rules: 'Na przemian rysujecie jedną kreskę między sąsiednimi kropkami. Kto dorysuje czwarty bok pudełka, zdobywa je (punkt) i rysuje kolejną kreskę. Gra kończy się, gdy wszystkie pudełka są zamknięte – wygrywa ten, kto ma ich więcej. Plansza 6×6 kropek ma 25 pudełek, więc remisu nie ma. Uwaga: dorysowanie trzeciego boku pudełka oddaje je rywalowi!' },
  { slug: 'wyscig-wektorowy', name: 'Wyścig Wektorowy', icon: '⇉', hue: 20, engine: 'race', params: { laps: 2 }, time_sec: 600, base: 60, description: 'Tor na kartce w kratkę: planuj wektor prędkości i wyprzedź rywala, nie wypadając z drogi.', rules: 'Każdy ma samochód, który zachowuje prędkość z poprzedniego ruchu. W swojej kolejce zmieniasz ją o co najwyżej 1 kratkę w każdej osi (dziewięć możliwości) i przesuwasz się o nowy wektor – cała kreska musi leżeć na torze. Wyjazd z drogi to rozbicie: stoisz w miejscu i tracisz trzy kolejki; czwarte rozbicie wyklucza z wyścigu. Trzeba minąć kolejne linie kontrolne i ukończyć okrążenia (domyślnie 2). Gdy ktoś dojedzie do mety, rywal dokańcza rundę – ten sam czas ruchów to remis. Samochody nie zderzają się ze sobą.' }
];
function ensureExtras() {
  let sort = 55;
  for (const g of EXTRA) {
    if (get('SELECT 1 FROM games WHERE slug=?', g.slug)) continue;
    run('INSERT INTO games(slug,name,icon,hue,category,description,rules,engine,params,status,time_sec,sort,base_online,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      g.slug, g.name, g.icon, g.hue, 'Planszowe', g.description, g.rules, g.engine, JSON.stringify(g.params), 'active', g.time_sec, sort++, g.base, now());
  }
}
seed();
ensureExtras();

/* ---------- administrator ---------- */
function ensureAdmin(hash) {
  if (get("SELECT 1 FROM users WHERE role='admin' LIMIT 1")) return null;
  const weak = ['ZmienMnie123', 'admin', 'password', 'haslo1234', '12345678'];
  let pw = process.env.ADMIN_PASSWORD;
  if (pw && (pw.length < 10 || weak.includes(pw))) { console.warn('UWAGA: ADMIN_PASSWORD jest zbyt słabe lub przykładowe – wygenerowano losowe hasło.'); pw = null; }
  pw = pw || crypto.randomBytes(9).toString('base64url');
  const nick = process.env.ADMIN_NICK || 'admin';
  const h = hash(pw);
  run('INSERT INTO users(nick,nick_lc,email,email_lc,pass_hash,pass_salt,guest,role,hue,created_at,last_seen) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
    nick, nick.toLowerCase(), process.env.ADMIN_EMAIL || null, process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null, h.hash, h.salt, 'admin', 150, now(), now());
  return { nick, password: pw, generated: pw !== process.env.ADMIN_PASSWORD };
}

/* blokady użytkownik->użytkownik (tabela user_blocks, migracja 4) */
const isBlocked = (blockerId, blockedId) => !!get('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?', blockerId, blockedId);
const blockedEither = (a, b) => isBlocked(a, b) || isBlocked(b, a);

/** Łagodne zamknięcie bazy (checkpoint WAL) – wołane przy SIGTERM/SIGINT. */
let closed = false;
function close() { closed = true; try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { /* już zamknięta */ } }
module.exports = { backup, cleanupOrphans, close, isBlocked, blockedEither, db, get, all, run, tx, now, settings, setSetting, sBool, sNum, secret, ensureAdmin, DATA_DIR, DEFAULT_SETTINGS };
