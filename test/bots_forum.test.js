'use strict';
process.env.RATE_REG_MAX = '80';
process.env.BOT_SCAN_MS = '200';          // szybkie skanowanie auto-bota w testach
/* Test: boty CPU przy stołach (ręczne i automatyczne) oraz forum (struktura, uprawnienia, moderacja, anty-spam). */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-forum-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123';
const E = require('../shared/engines');
const D = require('../server/db');
const A = require('../server/auth');
const { create } = require('../server/index');
D.ensureAdmin(A.hashPassword);
const server = create();
let base, wsBase, passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
class Client {
  constructor(token) {
    this.msgs = []; this.waiters = []; this.match = null;
    this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data); if (m.t === 'match') this.match = m.m; if (m.t === 'table') this.table = m.table;
      this.msgs.push(m); this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
    };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout: ' + String(pred).slice(0, 100) + ' | ostatnie: ' + JSON.stringify(this.msgs.slice(-3).map((x) => x.t)))), ms || 8000); this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } }); }); }
  close() { this.ws.close(); }
}
const reg = async (nick) => (await api('POST', '/api/auth/register', { nick, email: nick.toLowerCase() + '@example.com', password: 'haslo1234' })).body;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; base = 'http://127.0.0.1:' + port; wsBase = 'ws://127.0.0.1:' + port;
  const admin = (await api('POST', '/api/auth/login', { login: 'admin', password: 'AdminTest123' })).body;
  const ala = await reg('Ala'), olek = await reg('Olek'), ewa = await reg('Ewa'), zbyszek = await reg('Zbyszek'), marta = await reg('Marta');
  const guest = (await api('POST', '/api/auth/guest')).body;

  /* ================= BOTY PRZY STOŁACH ================= */
  console.log('Boty CPU przy stołach');
  const cA = new Client(ala.token); await cA.ready;
  cA.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 1 }); let tv = (await cA.wait((m) => m.t === 'table')).table;
  assert.strictEqual(tv.settings.allowBots, true); ok('opcja „Zezwalaj na gry z CPU” jest domyślnie WŁĄCZONA');
  cA.send({ t: 'table_set', settings: { allowBots: false } }); await cA.wait((m) => m.t === 'table' && m.table.settings.allowBots === false);
  cA.send({ t: 'table_add_bot', level: 'e' }); assert(/CPU.*wyłączone/.test((await cA.wait((m) => m.t === 'error')).msg)); ok('gdy host wyłączy CPU, ręczne dodanie bota jest odrzucone');
  cA.send({ t: 'table_set', settings: { allowBots: true } }); await cA.wait((m) => m.t === 'table' && m.table.settings.allowBots === true);
  cA.send({ t: 'table_add_bot', level: 'e' });
  tv = (await cA.wait((m) => m.t === 'table' && m.table.players.length === 2)).table;
  const bp = tv.players[1]; assert(bp.uid === -1 && bp.ready && bp.rating > 0 && bp.nick && !bp.cpu); assert.strictEqual(tv.eloOff, 'bot'); ok('gracz ręcznie dodaje bota na wolne miejsce (losowy nick, awatar i ranking jak u gracza; „Brak ELO”)');
  const names = D.settings().bot_names.split(','); assert(names.includes(bp.nick)); ok('nick bota pochodzi z listy konfigurowanej w CMS');
  cA.send({ t: 'table_add_bot', level: 'e' }); assert(/pełny/.test((await cA.wait((m) => m.t === 'error')).msg)); ok('nie można dodać drugiego bota (stół pełny)');
  cA.send({ t: 'table_ready', ready: true });
  await cA.wait((m) => m.t === 'match'); const m1 = cA.match;
  assert.strictEqual(m1.rated, false); assert.strictEqual(m1.noElo, true); assert(m1.players.some((p) => p.nick === bp.nick) && !m1.players.some((p) => p.bot)); ok('mecz z botem startuje po gotowości człowieka, jest bez ELO, a bot nie jest oznaczony jako CPU');
  const ttt = E.make('mnk', { w: 3, h: 3, k: 3 });
  const meSide = m1.you; let fin = null;
  for (let i = 0; i < 12 && !fin; i++) {
    if (cA.match.status === 'over') { fin = cA.match; break; }
    if (cA.match.turn === meSide) { const l = ttt.legal(cA.match.state); cA.send({ t: 'move', id: cA.match.id, move: l[Math.floor(Math.random() * l.length)] }); }
    await sleep(900);
  }
  assert(cA.match.moves >= 2, 'bot odpowiada na ruchy'); ok('bot przy stole odpowiada na ruchy gracza');
  if (cA.match.status !== 'over') { cA.send({ t: 'resign', id: cA.match.id }); await cA.wait((m) => m.t === 'match' && m.m.status === 'over'); }
  const alaId = D.get('SELECT id FROM users WHERE nick=?', 'Ala').id;
  assert.strictEqual(D.all('SELECT * FROM ratings WHERE user_id=?', alaId).length, 0); assert.strictEqual(D.get('SELECT rated, bot_nick FROM matches ORDER BY id DESC LIMIT 1').rated, 0);
  assert.strictEqual(D.get('SELECT bot_nick FROM matches ORDER BY id DESC LIMIT 1').bot_nick, bp.nick); ok('mecz z botem NIE zmienia rankingu ELO; nick bota zapisany w historii');
  const live = await api('GET', '/api/live'); assert.strictEqual(live.body.length, 0); ok('partie z botem nie są pokazywane jako „na żywo”');

  /* prawdziwy gracz wypiera bota przed startem */
  await sleep(200);
  assert(cA.table.players.some((p) => p.uid === -1)); ok('po zakończeniu meczu bot zostaje przy stole');
  const cO = new Client(olek.token); await cO.ready;
  cA.send({ t: 'table_leave' }); await cA.wait((m) => m.t === 'table_left');

  /* ręczny bot, a potem człowiek zajmuje jego miejsce */
  cA.send({ t: 'table_sit', game: 'reversi', n: 2 }); await cA.wait((m) => m.t === 'table');
  cA.send({ t: 'table_add_bot', level: 'm' }); await cA.wait((m) => m.t === 'table' && m.table.players.some((p) => p.uid === -1));
  cO.send({ t: 'table_sit', game: 'reversi', n: 2 }); const sw = (await cO.wait((m) => m.t === 'table')).table;
  assert(sw.players.length === 2 && !sw.players.some((p) => p.uid === -1) && sw.eloOff === null); ok('prawdziwy gracz zajmuje miejsce bota (przed startem partii)');
  cA.send({ t: 'table_leave' }); cO.send({ t: 'table_leave' }); await sleep(200);

  /* auto-bot */
  D.setSetting('bot_autojoin_sec', '1'); D.setSetting('bot_auto_level', 'e');
  cA.send({ t: 'table_sit', game: 'czworki', n: 4 }); await cA.wait((m) => m.t === 'table');
  cA.send({ t: 'table_set', settings: { visibility: 'private', pin: 'abcd' } }); await cA.wait((m) => m.t === 'table' && m.table.settings.hasPin);
  await sleep(2200); assert(!cA.table.players.some((p) => p.uid === -1)); ok('Auto-Bot NIE dołącza do stołu prywatnego');
  cA.send({ t: 'table_set', settings: { visibility: 'public', allowBots: false } }); await cA.wait((m) => m.t === 'table' && m.table.settings.visibility === 'public');
  await sleep(2200); assert(!cA.table.players.some((p) => p.uid === -1)); ok('Auto-Bot respektuje wyłączone „Zezwalaj na gry z CPU”');
  cA.send({ t: 'table_set', settings: { allowBots: true } }); await cA.wait((m) => m.t === 'table' && m.table.settings.allowBots === true);
  const notice = cA.wait((m) => m.t === 'notice' && /CPU/.test(m.msg), 7000);
  const withBot = await cA.wait((m) => m.t === 'table' && m.table.players.length === 2, 7000);
  assert(withBot.table.players[1].uid === -1 && withBot.table.eloOff === 'bot'); await notice; ok('samotny gracz przy stole publicznym dostaje auto-bota po ustawionym czasie (CMS: bot_autojoin_sec) i komunikat o braku ELO');
  cA.send({ t: 'table_ready', ready: true }); await cA.wait((m) => m.t === 'match'); assert.strictEqual(cA.match.rated, false); ok('partia z auto-botem startuje bez ELO');
  cA.send({ t: 'resign', id: cA.match.id }); await cA.wait((m) => m.t === 'match' && m.m.status === 'over'); cA.send({ t: 'table_leave' }); await sleep(200);
  D.setSetting('bot_autojoin_sec', '0');
  cA.send({ t: 'table_sit', game: 'czworki', n: 5 }); await cA.wait((m) => m.t === 'table'); await sleep(1500); assert(!cA.table.players.some((p) => p.uid === -1)); ok('bot_autojoin_sec=0 wyłącza automatycznych botów'); cA.send({ t: 'table_leave' });
  /* gość też może grać z botem, bez ELO */
  const cG = new Client(guest.token); await cG.ready;
  cG.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 6 }); await cG.wait((m) => m.t === 'table'); cG.send({ t: 'table_add_bot', level: 'e' }); await cG.wait((m) => m.t === 'table' && m.table.players.length === 2);
  cG.send({ t: 'table_ready', ready: true }); await cG.wait((m) => m.t === 'match'); assert.strictEqual(cG.match.rated, false); ok('gość gra z botem (online), bez ELO');
  cG.send({ t: 'resign', id: cG.match.id }); await cG.wait((m) => m.t === 'match' && m.m.status === 'over');
  const settings = (await api('PUT', '/api/admin/settings', { bot_autojoin_sec: '90', bot_auto_level: 'h', bot_names: 'Abc, Defg\nHijk' }, admin.token));
  assert.strictEqual(settings.body.bot_autojoin_sec, '90'); assert.strictEqual(settings.body.bot_names, 'Abc,Defg,Hijk');
  assert.strictEqual((await api('PUT', '/api/admin/settings', { bot_names: 'a,b' }, admin.token)).status, 400); ok('CMS: czas auto-bota, poziom i lista nicków są konfigurowalne (z walidacją)');
  [cA, cO, cG].forEach((c) => c.close());

  /* ================= FORUM ================= */
  console.log('Forum: struktura');
  let r = await api('GET', '/api/forum', null, ala.token); assert.strictEqual(r.status, 200);
  const cats = r.body.categories, boardsOf = (c) => cats.find((x) => x.title === c).boards.map((b) => b.title);
  assert.deepStrictEqual(cats.map((c) => c.title), ['OGÓLNE', 'STREFA GIER', 'TURNIEJE I LIGI', 'POMOC I SUGESTIE']);
  assert.deepStrictEqual(boardsOf('OGÓLNE'), ['Ogłoszenia i Aktualności', 'Witamy się!', 'Luźne Rozmowy / Hydepark']);
  assert.deepStrictEqual(boardsOf('TURNIEJE I LIGI'), ['Zapowiedzi i Zapisy na Turnieje', 'Relacje i Wyniki Meczy']);
  assert.deepStrictEqual(boardsOf('POMOC I SUGESTIE'), ['Zgłaszanie Błędów (Bug Tracker)', 'Pomysły na Nowe Gry i Funkcje']); ok('kategorie i działy zgodne ze specyfikacją');
  const activeGames = D.all("SELECT name FROM games WHERE status='active' ORDER BY sort_order,id").map((g) => g.name);
  assert.deepStrictEqual(boardsOf('STREFA GIER'), activeGames); assert(boardsOf('STREFA GIER').includes('Kółko i krzyżyk') && boardsOf('STREFA GIER').includes('Szachy')); ok('STREFA GIER: automatyczny dział dla KAŻDEJ aktywnej gry (' + activeGames.length + ')');
  const gid = D.get("SELECT id FROM games WHERE slug='hex'").id;
  r = await api('PUT', '/api/admin/games/' + gid, { name: 'Hex', slug: 'hex', engine: 'mnk', params: { w: 7, h: 7, k: 4 }, status: 'active', rated: 1, bots: 1 }, admin.token); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/forum', null, ala.token); assert(r.body.categories.find((c) => c.title === 'STREFA GIER').boards.some((b) => b.title === 'Hex')); ok('uaktywnienie nowej gry tworzy jej dział na forum');
  await api('PUT', '/api/admin/games/' + gid, { name: 'Hex', slug: 'hex', engine: 'mnk', params: { w: 7, h: 7, k: 4 }, status: 'hidden' }, admin.token);
  r = await api('GET', '/api/forum', null, ala.token); assert(!r.body.categories.find((c) => c.title === 'STREFA GIER').boards.some((b) => b.title === 'Hex')); ok('wyłączona gra: jej dział znika (treści zostają w bazie)');
  const B = (title) => cats.flatMap((c) => c.boards).find((b) => b.title === title).id;

  console.log('Forum: goście, tematy, posty');
  r = await api('POST', '/api/forum/boards/' + B('Witamy się!') + '/topics', { title: 'Cześć wszystkim', body: 'Jestem gościem' }, guest.token);
  assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'Musisz się zarejestrować, aby móc rozmawiać z innymi graczami'); ok('gość nie założy tematu na forum (komunikat o rejestracji)');
  r = await api('GET', '/api/forum/boards/' + B('Witamy się!'), null, guest.token); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.canCreate, false); assert.strictEqual(r.body.me.guest, true); ok('gość może czytać forum');
  r = await api('POST', '/api/forum/boards/' + B('Witamy się!') + '/topics', { title: 'Hej', body: 'x' }); assert.strictEqual(r.status, 401); ok('niezalogowany nie pisze (401)');
  r = await api('POST', '/api/forum/boards/' + B('Ogłoszenia i Aktualności') + '/topics', { title: 'Mój temat', body: 'treść ogłoszenia' }, ala.token);
  assert.strictEqual(r.status, 403); ok('Ogłoszenia: gracz nie zakłada tematów');
  r = await api('POST', '/api/forum/boards/' + B('Witamy się!') + '/topics', { title: 'Cześć, jestem Ala', body: 'Gram w [b]szachy[/b] i kółko i krzyżyk.\n[quote=Bob;1]stary cytat[/quote]' }, ala.token);
  assert.strictEqual(r.status, 200); const topicId = r.body.id, firstPost = r.body.postId; ok('gracz zakłada temat (BBCode)');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'druga wiadomość od razu' }, ala.token);
  assert.strictEqual(r.status, 429); assert(/Poczekaj jeszcze \d+ s/.test(r.body.error)); ok('rate-limit: max 1 post na 30 s');
  D.run('UPDATE forum_posts SET created_at=created_at-31000'); // symulacja upływu 30 s
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'Witaj Alu! Super, że jesteś.' }, olek.token);
  assert.strictEqual(r.status, 200); const olekPost = r.body.id; ok('odpowiedź w temacie');
  assert.strictEqual(D.get('SELECT COUNT(*) AS n FROM notifs WHERE user_id=(SELECT id FROM users WHERE nick=?)', 'Ala').n, 1); ok('autor tematu dostaje powiadomienie o odpowiedzi');
  D.run('UPDATE forum_posts SET created_at=created_at-31000');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'Witaj Alu! Super, że jesteś.' }, olek.token);
  assert(r.status === 200 || r.status === 409); // ten sam post -> 409 w oknie 10 min
  assert.strictEqual(r.status, 409); ok('powtórzony post jest odrzucany');
  D.run('UPDATE forum_posts SET created_at=created_at-31000');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'k.u.r.w.a' }, ewa.token); assert.strictEqual(r.status, 400); assert(/niedozwolone/.test(r.body.error)); ok('cenzura (censor.js) blokuje wulgarny post');
  r = await api('POST', '/api/forum/boards/' + B('Witamy się!') + '/topics', { title: 'ch0j w tytule', body: 'normalna treść' }, ewa.token); assert.strictEqual(r.status, 400); ok('cenzura obejmuje tytuły (leet-speak)');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'a https://a.pl b https://b.pl c https://c.pl d https://d.pl e https://e.pl f https://f.pl' }, ewa.token); assert.strictEqual(r.status, 400); ok('limit linków w poście (anty-spam)');
  r = await api('GET', '/api/forum/topics/' + topicId, null, ala.token);
  assert.strictEqual(r.body.posts.length, 2); assert.strictEqual(r.body.posts[0].author.nick, 'Ala'); assert.strictEqual(r.body.posts[0].author.rank, 'Nowicjusz'); assert.strictEqual(r.body.posts[0].canEdit, true); assert.strictEqual(r.body.posts[1].canEdit, false);
  assert.strictEqual(r.body.posts[0].author.posts, 1); assert(r.body.posts[0].author.joined > 0); ok('autor widzi „edytuj” tylko przy własnych postach; ranga i licznik postów w profilu autora');
  r = await api('PUT', '/api/forum/posts/' + olekPost, { body: 'zmieniam cudzy post' }, ala.token); assert.strictEqual(r.status, 403); ok('nie można edytować cudzych postów');
  r = await api('PUT', '/api/forum/posts/' + firstPost, { title: 'Cześć, jestem Ala (nowa)', body: 'Gram w [i]szachy[/i].' }, ala.token); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/forum/topics/' + topicId, null, ala.token); assert.strictEqual(r.body.topic.title, 'Cześć, jestem Ala (nowa)'); assert(r.body.posts[0].editedAt > 0); ok('edycja własnego posta (i tytułu pierwszego posta), ślad „edytowano”');
  r = await api('GET', '/api/forum/posts/' + olekPost); assert.strictEqual(r.body.topicId, topicId); assert.strictEqual(r.body.page, 1); ok('link do konkretnego posta (cytaty, powiadomienia)');

  console.log('Forum: moderacja i role');
  r = await api('POST', '/api/forum/topics/' + topicId + '/mod', { action: 'sticky' }, olek.token); assert.strictEqual(r.status, 403); ok('zwykły gracz nie moderuje');
  r = await api('POST', '/api/forum/admin/moderators', { nick: 'Olek' }, admin.token); assert.strictEqual(r.status, 200); ok('Super Admin nadaje rolę „Moderator Forum”');
  r = await api('GET', '/api/admin/me', null, olek.token); assert.strictEqual(r.status, 403); r = await api('GET', '/api/admin/users', null, olek.token); assert.strictEqual(r.status, 403); ok('Moderator Forum NIE ma dostępu do panelu /admin');
  r = await api('GET', '/api/forum/admin/overview', null, olek.token); assert.strictEqual(r.status, 403); r = await api('POST', '/api/forum/admin/boards', { title: 'X', category_id: 1 }, olek.token); assert.strictEqual(r.status, 403); ok('Moderator Forum nie zarządza kategoriami i działami');
  r = await api('POST', '/api/forum/admin/moderators', { nick: 'Ala' }, olek.token); assert.strictEqual(r.status, 403);
  r = await api('POST', '/api/forum/topics/' + topicId + '/mod', { action: 'sticky' }, olek.token); assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/forum/topics/' + topicId + '/mod', { action: 'lock' }, olek.token); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/forum/boards/' + B('Witamy się!'), null, ala.token); assert(r.body.topics[0].sticky && r.body.topics[0].locked); ok('przyklejanie i zamykanie tematu przez Moderatora Forum');
  D.run('UPDATE forum_posts SET created_at=created_at-31000');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'odpowiedź do zamkniętego' }, ala.token); assert.strictEqual(r.status, 403); assert(/zamkni/i.test(r.body.error)); ok('zamknięty temat: gracz nie odpowiada');
  r = await api('PUT', '/api/forum/posts/' + firstPost, { body: 'edycja w zamkniętym' }, ala.token); assert.strictEqual(r.status, 403); ok('zamknięty temat: autor nie edytuje');
  r = await api('PUT', '/api/forum/posts/' + firstPost, { body: 'Moderator poprawił treść.' }, olek.token); assert.strictEqual(r.status, 200); ok('moderator edytuje cudzy post');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'Moderator może pisać w zamkniętym.' }, olek.token); assert.strictEqual(r.status, 200); const modPost = r.body.id;
  r = await api('POST', '/api/forum/topics/' + topicId + '/mod', { action: 'unlock' }, olek.token);
  r = await api('POST', '/api/forum/topics/' + topicId + '/mod', { action: 'move', board: B('Luźne Rozmowy / Hydepark') }, olek.token); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/forum/topics/' + topicId, null, ala.token); assert.strictEqual(r.body.topic.board.title, 'Luźne Rozmowy / Hydepark'); ok('przenoszenie tematu do innego działu');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'x' }, ala.token);
  r = await api('POST', '/api/forum/users/' + ala.me.id + '/warn', { reason: 'Test ostrzeżenia' }, olek.token); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.warnings, 1);
  r = await api('GET', '/api/forum/users/Ala', null, ala.token); assert.strictEqual(r.body.warnings.length, 1); assert.strictEqual(r.body.user.posts, 1); ok('ostrzeżenie (warn): licznik i powiadomienie dla gracza');
  r = await api('POST', '/api/forum/users/' + ala.me.id + '/ban', { hours: 24, reason: 'Spam' }, olek.token); assert.strictEqual(r.status, 200);
  D.run('UPDATE forum_posts SET created_at=created_at-31000');
  r = await api('POST', '/api/forum/topics/' + topicId + '/posts', { body: 'Czy mogę coś napisać?' }, ala.token); assert.strictEqual(r.status, 403); assert(/blokad/i.test(r.body.error)); ok('blokada pisania na forum (ban) – gracz nadal może czytać');
  r = await api('GET', '/api/forum/topics/' + topicId, null, ala.token); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.canReply, false);
  r = await api('POST', '/api/forum/users/' + ala.me.id + '/unban', {}, olek.token); assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/forum/users/' + (await api('GET', '/api/me', null, admin.token)).body.me.id + '/ban', { hours: 1 }, olek.token); assert.strictEqual(r.status, 403); ok('moderator nie karze administratora; unban działa');
  r = await api('DELETE', '/api/forum/posts/' + modPost, null, ala.token); assert.strictEqual(r.status, 403);
  r = await api('DELETE', '/api/forum/posts/' + olekPost, null, olek.token); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.topicDeleted, false); ok('moderator usuwa cudzy post');
  r = await api('POST', '/api/forum/boards/' + B('Pomysły na Nowe Gry i Funkcje') + '/topics', { title: 'Domino online', body: 'Dodajcie domino!' }, marta.token); assert.strictEqual(r.status, 200); const t2 = r.body.id;
  r = await api('DELETE', '/api/forum/posts/' + r.body.postId, null, olek.token); assert.strictEqual(r.body.topicDeleted, true);
  r = await api('GET', '/api/forum/topics/' + t2); assert.strictEqual(r.status, 404); ok('usunięcie pierwszego posta usuwa cały temat');
  assert(D.get("SELECT COUNT(*) AS n FROM mod_actions WHERE action LIKE 'forum:%'").n >= 6); ok('działania moderatorów trafiają do dziennika (mod_actions)');
  /* moderator panelu (rola mod) też moderuje forum; Super Admin ogłasza */
  r = await api('POST', '/api/forum/boards/' + B('Ogłoszenia i Aktualności') + '/topics', { title: 'Witamy na forum!', body: 'Zasady: [list][*]kultura[*]brak spamu[/list]' }, admin.token); assert.strictEqual(r.status, 200); ok('Super Admin zakłada temat w dziale Ogłoszenia (bez limitu 30 s)');
  const ann = r.body.id;
  r = await api('POST', '/api/forum/topics/' + ann + '/posts', { body: 'Dziękujemy za informację!' }, ewa.token); assert.strictEqual(r.status, 200); ok('gracz odpowiada w temacie ogłoszenia');
  r = await api('GET', '/api/forum/topics/' + ann); assert.strictEqual(r.status, 200); ok('forum jest czytelne bez logowania (GET)');

  console.log('Forum: rangi, CMS, bezpieczeństwo');
  const ewaId = D.get("SELECT id FROM users WHERE nick='Ewa'").id, kk = D.get("SELECT id FROM games WHERE slug='kolko-krzyzyk'").id;
  D.run('INSERT INTO ratings(user_id,game_id,rating,games,wins,peak,updated_at) VALUES(?,?,?,?,?,?,?)', ewaId, kk, 1300, 30, 26, 1300, Date.now());
  r = await api('GET', '/api/forum/users/Ewa'); assert.strictEqual(r.body.user.rank, 'Mistrz Kółka i Krzyżyka'); ok('ranga „Mistrz Kółka i Krzyżyka” z liczby wygranych');
  r = await api('GET', '/api/forum/users/Olek'); assert.strictEqual(r.body.user.badge, 'Moderator Forum'); r = await api('GET', '/api/forum/users/admin'); assert.strictEqual(r.body.user.badge, 'Super Admin'); ok('odznaki Moderator Forum / Super Admin');
  const { rankFor } = require('../server/forum'); assert.deepStrictEqual([0, 5, 25, 100, 300].map((n) => rankFor(n, null)), ['Nowicjusz', 'Uczeń Kartki', 'Stały Bywalec', 'Weteran Kartki', 'Legenda Forum']); ok('rangi wg liczby postów');
  r = await api('POST', '/api/forum/admin/categories', { title: 'Offtop' }, admin.token); const catId = r.body.id; assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/forum/admin/boards', { title: 'Kącik Szachistów', description: 'Debiuty i końcówki', category_id: catId, staffOnly: false }, admin.token); const bId = r.body.id; assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/forum/boards/' + bId + '/topics', { title: 'Debiut włoski', body: '1. e4 e5 2. Sf3 Sc6 3. Gc4' }, marta.token); assert.strictEqual(r.status, 200); ok('CMS: Super Admin tworzy kategorię i dział, gracze w nim piszą');
  r = await api('DELETE', '/api/forum/admin/boards/' + bId, null, admin.token); assert.strictEqual(r.status, 409); ok('usunięcie niepustego działu wymaga potwierdzenia');
  r = await api('PUT', '/api/forum/admin/boards/' + bId, { title: 'Kącik Szachistów', category_id: catId, hidden: true }, admin.token);
  r = await api('GET', '/api/forum', null, ala.token); assert(!r.body.categories.some((c) => c.title === 'Offtop')); ok('ukryty dział znika dla graczy');
  r = await api('DELETE', '/api/forum/admin/boards/' + bId + '?force=1', null, admin.token); assert.strictEqual(r.status, 200); r = await api('DELETE', '/api/forum/admin/categories/' + catId, null, admin.token); assert.strictEqual(r.status, 200);
  const gb = D.get('SELECT id FROM forum_boards WHERE game_id IS NOT NULL LIMIT 1').id; r = await api('DELETE', '/api/forum/admin/boards/' + gb + '?force=1', null, admin.token); assert.strictEqual(r.status, 400); ok('działów gier nie można usunąć (są zarządzane automatycznie)');
  const first = D.get("SELECT id FROM forum_categories ORDER BY sort LIMIT 1").id; await api('POST', '/api/forum/admin/reorder', { type: 'category', id: first, dir: 1 }, admin.token);
  r = await api('GET', '/api/forum/admin/overview', null, admin.token); assert.strictEqual(r.body.categories[1].id, first); assert(r.body.moderators.some((m) => m.nick === 'Olek')); ok('CMS: kolejność kategorii, lista moderatorów forum');
  r = await api('DELETE', '/api/forum/admin/moderators/' + olek.me.id, null, admin.token); r = await api('POST', '/api/forum/topics/' + ann + '/mod', { action: 'lock' }, olek.token); assert.strictEqual(r.status, 403); ok('odebranie roli Moderatora Forum działa od razu');
  const long = 'a'.repeat(10001); D.run('UPDATE forum_posts SET created_at=created_at-31000');
  r = await api('POST', '/api/forum/topics/' + ann + '/posts', { body: long }, zbyszek.token); assert.strictEqual(r.status, 413); ok('limit długości posta');
  r = await api('POST', '/api/forum/topics/' + ann + '/posts', { body: '<script>alert(1)</script> [url=javascript:alert(1)]x[/url]' }, zbyszek.token); assert.strictEqual(r.status, 200);
  const raw = D.get('SELECT body FROM forum_posts WHERE id=?', r.body.id).body; assert(raw.includes('<script>')); ok('serwer przechowuje surowy BBCode (escapowanie i walidacja linków przy wyświetlaniu – patrz test BBCode)');
  await api('PUT', '/api/admin/settings', { forum_enabled: '0' }, admin.token);
  r = await api('GET', '/api/forum', null, ala.token); assert.strictEqual(r.status, 403); r = await api('GET', '/api/config'); assert.strictEqual(r.body.forumEnabled, false); await api('PUT', '/api/admin/settings', { forum_enabled: '1' }, admin.token); ok('wyłącznik forum w CMS');
  r = await api('GET', '/api/me/matches', null, ala.token); assert(Array.isArray(r.body)); ok('historia partii (z nickiem bota) nadal działa');
  console.log('\nOK: ' + passed + ' testów botów i forum');
  process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
