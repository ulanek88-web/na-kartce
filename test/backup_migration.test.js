'use strict';
/* Migracje (kolejność, idempotencja, brak utraty danych), kopia zapasowa i odtworzenie bazy – na tymczasowych katalogach. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'nk-' + n + '-'));
/** uruchamia fragment kodu w osobnym procesie na wskazanym katalogu danych (osobny proces = czysty stan modułów) */
const run = (dir, code) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { env: Object.assign({}, process.env, { DATA_DIR: dir, ADMIN_PASSWORD: 'AdminTest123', FORCE_COLOR: '0', NO_COLOR: '1', NODE_DISABLE_COLORS: '1' }), cwd: root, encoding: 'utf8' }).trim();
const LOAD = "const D=require('./server/db');require('./server/migrations')(D);";
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };

/* 1. świeża baza -> aktualna wersja */
const d1 = tmp('mig1');
const v = Number(run(d1, LOAD + "console.log(D.get('PRAGMA user_version').user_version)"));
assert(v >= 5); ok('świeża baza migruje do wersji ' + v);
/* 2. baza w wersji 4 (sprzed forum) z danymi -> migracja nie niszczy danych i dodaje forum */
run(d1, LOAD + `
  const now=Date.now();
  D.run("INSERT INTO users(nick,nick_lc,email,email_lc,guest,created_at,last_seen) VALUES('Stary','stary','s@x.pl','s@x.pl',0,?,?)",now,now);
  const g=D.get("SELECT id FROM games WHERE slug='szachy'").id;
  D.run("INSERT INTO matches(game_id,p1,p2,rated,mode,started_at,ended_at,result,reason,moves) VALUES(?,1,1,1,'queue',?,?,1,'mat','[1,2]')",g,now,now);
  D.run("INSERT INTO matches(game_id,p1,rated,mode,started_at) VALUES(?,1,0,'queue',?)",g,now);   // partia przerwana restartem
  D.db.exec("DROP TABLE forum_posts;DROP TABLE forum_topics;DROP TABLE forum_boards;DROP TABLE forum_categories;DROP TABLE forum_moderators;DROP TABLE forum_warnings;DROP TABLE forum_bans;ALTER TABLE matches DROP COLUMN bot_nick;PRAGMA user_version=4;");`);
const before = JSON.parse(run(d1, "const D=require('./server/db');console.log(JSON.stringify({u:D.get('SELECT COUNT(*) n FROM users').n,m:D.get('SELECT COUNT(*) n FROM matches').n,v:D.get('PRAGMA user_version').user_version}))"));
assert.strictEqual(before.v, 4);
const after = JSON.parse(run(d1, LOAD + "console.log(JSON.stringify({u:D.get('SELECT COUNT(*) n FROM users').n,m:D.get('SELECT COUNT(*) n FROM matches').n,v:D.get('PRAGMA user_version').user_version,boards:D.get('SELECT COUNT(*) n FROM forum_boards').n,cats:D.get('SELECT COUNT(*) n FROM forum_categories').n,col:D.all('PRAGMA table_info(matches)').some(c=>c.name==='bot_nick')}))"));
assert.deepStrictEqual([after.u, after.m, after.v >= 5, after.boards, after.cats, after.col], [before.u, before.m, true, 7, 4, true]); ok('migracja 4→5: dane użytkowników i partii nienaruszone, dodane forum (4 kategorie, 7 działów) i kolumna bot_nick');
const again = JSON.parse(run(d1, LOAD + "console.log(JSON.stringify({boards:D.get('SELECT COUNT(*) n FROM forum_boards').n,v:D.get('PRAGMA user_version').user_version}))")); assert.strictEqual(again.boards, 7); ok('ponowne uruchomienie migracji jest idempotentne (bez duplikatów)');
/* 3. sprzątanie przerwanych partii tylko przy starcie */
assert.strictEqual(Number(run(d1, LOAD + "console.log(D.cleanupOrphans(0))")), 1); ok('partie przerwane restartem są usuwane, zakończone zostają');
/* 4. kopia zapasowa i odtworzenie */
const d2 = tmp('bk');
run(d2, LOAD + "D.secret();const now=Date.now();D.run(\"INSERT INTO users(nick,nick_lc,guest,created_at,last_seen) VALUES('Kopia','kopia',1,?,?)\",now,now);D.backup();");
const bdir = path.join(d2, 'backups'), files = fs.readdirSync(bdir); assert.strictEqual(files.length, 1); assert(/^nakartce-\d{4}-\d{2}-\d{2}\.db$/.test(files[0]));
const mode = fs.statSync(path.join(bdir, files[0])).mode & 0o777; assert.strictEqual(mode, 0o600);
const chk = run(d2, `const {DatabaseSync}=require('node:sqlite');const b=new DatabaseSync(${JSON.stringify(path.join(bdir, files[0]))},{readOnly:true});console.log(Object.values(b.prepare('PRAGMA integrity_check').get())[0]+'|'+b.prepare("SELECT COUNT(*) n FROM users WHERE nick='Kopia'").get().n)`);
assert.strictEqual(chk, 'ok|1'); ok('kopia zapasowa: spójna (integrity_check = ok), zawiera dane, prawa 0600');
const d3 = tmp('restore'); fs.copyFileSync(path.join(bdir, files[0]), path.join(d3, 'nakartce.db')); fs.copyFileSync(path.join(d2, 'secret.key'), path.join(d3, 'secret.key'));
const rest = run(d3, LOAD + "console.log(D.get(\"SELECT COUNT(*) n FROM users WHERE nick='Kopia'\").n+'|'+D.get('PRAGMA user_version').user_version)"); assert(/^1\|\d+$/.test(rest)); ok('odtworzenie: baza skopiowana do nowego katalogu startuje i zawiera dane');
const keep = tmp('keep'); run(keep, "process.env.BACKUP_KEEP='2';" + LOAD + "const fs=require('fs'),p=require('path');const d=p.join(D.DATA_DIR,'backups');fs.mkdirSync(d,{recursive:true});for(const x of ['2020-01-01','2020-01-02','2020-01-03','2020-01-04'])fs.writeFileSync(p.join(d,'nakartce-'+x+'.db'),'x');D.backup();");
assert.strictEqual(fs.readdirSync(path.join(keep, 'backups')).length, 2); ok('rotacja kopii: zostają tylko najnowsze (BACKUP_KEEP)');
console.log('\nOK: ' + n + ' testów migracji i kopii zapasowych'); process.exit(0);
