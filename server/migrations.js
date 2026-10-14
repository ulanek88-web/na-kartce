'use strict';
/* Migracje schematu SQLite (PRAGMA user_version). Każda migracja uruchamia się raz, w transakcji.
   Aby dodać kolejną: dopisz funkcję na końcu tablicy MIGRATIONS – nigdy nie edytuj już wydanych. */
const MIGRATIONS = [
  /* 1: gry-pluginy, konfiguracja zdalna, reklamy z własnym kodem, ogłoszenia */
  (D) => {
    const cols = (t) => D.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    const add = (t, c, def) => { if (!cols(t).includes(c)) D.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
    add('games', 'plugin', 'TEXT');                         // slug pluginu (katalog data/plugins/<slug>)
    add('games', 'plugin_version', 'TEXT');
    add('games', 'cfg', "TEXT NOT NULL DEFAULT '{}'");      // zdalna konfiguracja gry (JSON) – zmiana bez restartu
    add('ads', 'kind', "TEXT NOT NULL DEFAULT 'banner'");   // banner | code
    add('ads', 'code', "TEXT NOT NULL DEFAULT ''");         // własny kod HTML/JS (AdSense itp.), wyświetlany w iframe sandbox
    D.run(`CREATE TABLE IF NOT EXISTS announcements(
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT 'bar',
      level TEXT NOT NULL DEFAULT 'info', active INTEGER NOT NULL DEFAULT 1, start_at INTEGER NOT NULL DEFAULT 0,
      end_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    D.run('CREATE INDEX IF NOT EXISTS ix_games_sort ON games(sort, id)');
  },
  /* 2: kolumny sort_order i is_active w games (pluginy żyją w tej samej tabeli: games.plugin IS NOT NULL).
     Źródłem prawdy pozostają sort/status (używa ich reszta panelu), a triggery synchronizują kolumny pochodne –
     dzięki temu żadna ścieżka zapisu (panel gier, układ, plugin) nie rozjedzie widoczności. */
  (D) => {
    const cols = D.all('PRAGMA table_info(games)').map((c) => c.name);
    if (!cols.includes('sort_order')) D.db.exec('ALTER TABLE games ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('is_active')) D.db.exec('ALTER TABLE games ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
    D.db.exec(`
      UPDATE games SET sort_order=sort, is_active=CASE WHEN status IN ('active','soon') THEN 1 ELSE 0 END;
      CREATE INDEX IF NOT EXISTS ix_games_order ON games(is_active, sort_order, id);
      CREATE TRIGGER IF NOT EXISTS trg_games_sync_u AFTER UPDATE OF sort, status ON games BEGIN
        UPDATE games SET sort_order=NEW.sort, is_active=CASE WHEN NEW.status IN ('active','soon') THEN 1 ELSE 0 END WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_games_sync_i AFTER INSERT ON games BEGIN
        UPDATE games SET sort_order=NEW.sort, is_active=CASE WHEN NEW.status IN ('active','soon') THEN 1 ELSE 0 END WHERE id=NEW.id; END;`);
  },
  /* 3: licznik ucieczek (rage quit) */
  (D) => {
    if (!D.all('PRAGMA table_info(users)').some((c) => c.name === 'rage_quits_count')) D.db.exec('ALTER TABLE users ADD COLUMN rage_quits_count INTEGER NOT NULL DEFAULT 0');
  },
  /* 4: blokowanie graczy, unieważnianie sesji, anonimizacja kont, harmonogram i slider reklam, słownik cenzury,
     poprawka triggera roli (kod zapisuje 'mod', a stary trigger przyjmował tylko 'moderator' – nadanie roli kończyło się błędem) */
  (D) => {
    const cols = (t) => D.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    const add = (t, c, def) => { if (!cols(t).includes(c)) D.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
    add('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'deleted_at', 'INTEGER NOT NULL DEFAULT 0');
    add('ads', 'slide_sec', 'INTEGER NOT NULL DEFAULT 8');
    add('ads', 'schedule', "TEXT NOT NULL DEFAULT 'range'");
    D.db.exec(`
      CREATE TABLE IF NOT EXISTS user_blocks(blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id, blocked_id));
      CREATE INDEX IF NOT EXISTS ix_blocks_blocked ON user_blocks(blocked_id);
      CREATE TABLE IF NOT EXISTS censor_words(word TEXT PRIMARY KEY, added_by INTEGER, created_at INTEGER NOT NULL);
      DROP TRIGGER IF EXISTS trg_users_role;
      DROP TRIGGER IF EXISTS trg_users_role_i;
      CREATE TRIGGER trg_users_role BEFORE UPDATE OF role ON users WHEN NEW.role NOT IN ('user','mod','admin') BEGIN SELECT RAISE(ABORT,'bad role'); END;
      CREATE TRIGGER trg_users_role_i BEFORE INSERT ON users WHEN NEW.role NOT IN ('user','mod','admin') BEGIN SELECT RAISE(ABORT,'bad role'); END;`);
    /* ogłoszone dotąd reklamy bez harmonogramu zostają z zakresem dat, który mają */
  },
  /* 5: forum (kategorie, działy, tematy, posty, moderatorzy, ostrzeżenia, blokady) + nick bota w partiach */
  (D) => {
    const cols = (t) => D.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    if (!cols('matches').includes('bot_nick')) D.db.exec('ALTER TABLE matches ADD COLUMN bot_nick TEXT');
    D.db.exec(`
      CREATE TABLE IF NOT EXISTS forum_categories(
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 100, system_key TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS forum_boards(
        id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 100,
        staff_only INTEGER NOT NULL DEFAULT 0,       -- tematy zakłada tylko personel (np. Ogłoszenia)
        hidden INTEGER NOT NULL DEFAULT 0,           -- ukryty ręcznie przez Super Admina
        game_id INTEGER UNIQUE,                      -- dział wygenerowany dla gry
        game_off INTEGER NOT NULL DEFAULT 0,         -- gra przestała być aktywna -> dział schowany automatycznie
        system_key TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_fboards_cat ON forum_boards(category_id, sort);
      CREATE TABLE IF NOT EXISTS forum_topics(
        id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES forum_boards(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
        title TEXT NOT NULL, sticky INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
        posts_count INTEGER NOT NULL DEFAULT 1, last_user_id INTEGER, created_at INTEGER NOT NULL, last_post_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_ftopics_board ON forum_topics(board_id, sticky DESC, last_post_at DESC);
      CREATE INDEX IF NOT EXISTS ix_ftopics_board_last ON forum_topics(board_id, last_post_at DESC);
      CREATE INDEX IF NOT EXISTS ix_ftopics_last ON forum_topics(last_post_at DESC);
      CREATE TABLE IF NOT EXISTS forum_posts(
        id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
        body TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER NOT NULL DEFAULT 0, edited_by INTEGER);
      CREATE INDEX IF NOT EXISTS ix_fposts_topic ON forum_posts(topic_id, id);
      CREATE INDEX IF NOT EXISTS ix_fposts_user ON forum_posts(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS forum_moderators(user_id INTEGER PRIMARY KEY, granted_by INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS forum_warnings(
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, mod_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_fwarn_user ON forum_warnings(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS forum_bans(
        user_id INTEGER PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', mod_id INTEGER, created_at INTEGER NOT NULL);`);
    /* struktura startowa – tworzona tylko raz; Super Admin może ją dowolnie zmieniać */
    const now = Date.now();
    const cat = (key, title, sort) => D.run('INSERT INTO forum_categories(title,sort,system_key,created_at) VALUES(?,?,?,?)', title, sort, key, now).id;
    const board = (c, key, title, desc, sort, staff) => D.run('INSERT INTO forum_boards(category_id,title,description,sort,staff_only,system_key,created_at) VALUES(?,?,?,?,?,?,?)', c, title, desc, sort, staff ? 1 : 0, key, now);
    const c1 = cat('general', 'OGÓLNE', 10);
    board(c1, 'announcements', 'Ogłoszenia i Aktualności', 'Oficjalne informacje od administracji. Tematy zakładają Admini i Moderatorzy – Ty możesz odpowiadać.', 10, true);
    board(c1, 'welcome', 'Witamy się!', 'Przedstaw się społeczności – kim jesteś i w co lubisz grać?', 20, false);
    board(c1, 'hydepark', 'Luźne Rozmowy / Hydepark', 'Dowolne tematy, humoreski i wspomnienia z lekcji, na których grało się na kartce.', 30, false);
    cat('games', 'STREFA GIER', 20);
    const c3 = cat('tournaments', 'TURNIEJE I LIGI', 30);
    board(c3, 'tournament-signup', 'Zapowiedzi i Zapisy na Turnieje', 'Ogłoszenia turniejów, zapisy i regulaminy.', 10, false);
    board(c3, 'tournament-results', 'Relacje i Wyniki Meczy', 'Wyniki, relacje, analizy partii.', 20, false);
    const c4 = cat('help', 'POMOC I SUGESTIE', 40);
    board(c4, 'bugs', 'Zgłaszanie Błędów (Bug Tracker)', 'Coś nie działa? Opisz problem: urządzenie, przeglądarka lub aplikacja, kroki do powtórzenia.', 10, false);
    board(c4, 'ideas', 'Pomysły na Nowe Gry i Funkcje', 'Zaproponuj grę lub funkcję i przekonaj innych, że warto.', 20, false);
  }
];
module.exports = function migrate(D) {
  let v = Number(D.get('PRAGMA user_version').user_version) || 0;
  for (; v < MIGRATIONS.length; v++) {
    D.tx(() => { MIGRATIONS[v](D); });
    D.db.exec('PRAGMA user_version=' + (v + 1));
  }
};
