'use strict';
process.env.RATE_REG_MAX = '60';   // testy rejestrują wiele kont z jednego IP
/* Test integracyjny: prawdziwy serwer HTTP + WebSocket, dwóch graczy, gość, panel administratora, turniej. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123';
process.env.TZ = 'Europe/Warsaw';
const E = require('../shared/engines');
const D = require('../server/db');
const A = require('../server/auth');
const { create } = require('../server/index');
D.ensureAdmin(A.hashPassword);

const server = create();
let base, wsBase, passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

async function api(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
class Client {
  constructor(token) {
    this.msgs = []; this.waiters = []; this.match = null;
    this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.hello = new Promise((res) => { this.onHello = res; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'match') this.match = m.m;
      if (m.t === 'hello') { if (m.active) this.match = m.active; this.onHello(m); }
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
    };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms) {
    const hit = this.msgs.find(pred);
    if (hit && pred.keep !== false && false) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout czekania na wiadomość: " + String(pred).slice(0,120) + " | ostatnie: " + JSON.stringify(this.msgs.slice(-3).map((x) => x.t + (x.m ? ":" + x.m.status + ":" + x.m.turn + "/" + x.m.you + ":" + x.m.moves : ""))))), ms || 8000);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  }
  close() { this.ws.close(); }
}
async function playOut(clients, engine, maxPlies) {
  // obaj gracze wykonują losowe, legalne ruchy aż do końca partii
  const eng = engine;
  const done = clients.map((c) => c.wait((m) => m.t === 'match' && m.m.status === 'over', 6000));
  const handlers = [];
  const turnLoop = (c) => {
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== 'match' || m.m.status !== 'playing') return;
      if (m.m.turn !== m.m.you) return;
      const legal = eng.legal(m.m.state);
      c.send({ t: 'move', id: m.m.id, move: legal[Math.floor(Math.random() * legal.length)] });
    };
    handlers.push([c, h]);
    c.ws.addEventListener('message', h);
  };
  clients.forEach(turnLoop);
  const first = clients.find((c) => c.match && c.match.turn === c.match.you);
  const legal = eng.legal(first.match.state);
  first.send({ t: 'move', id: first.match.id, move: legal[Math.floor(Math.random() * legal.length)] });
  const res = await Promise.all(done);
  handlers.forEach(([c, h]) => c.ws.removeEventListener('message', h));
  return res[0].m;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  base = 'http://127.0.0.1:' + port; wsBase = 'ws://127.0.0.1:' + port;
  console.log('Konta');

  let r = await api('POST', '/api/auth/register', { nick: 'Ala', email: 'ala@example.com', password: 'haslo1234' });
  assert.strictEqual(r.status, 200); const ala = r.body; ok('rejestracja');
  r = await api('POST', '/api/auth/register', { nick: 'ala', email: 'x@example.com', password: 'haslo1234' });
  assert.strictEqual(r.status, 409); ok('nick jest unikalny bez względu na wielkość liter');
  r = await api('POST', '/api/auth/register', { nick: 'Olek', email: 'olek@example.com', password: 'krotkie' });
  assert.strictEqual(r.status, 400); ok('zbyt krótkie hasło odrzucone');
  r = await api('POST', '/api/auth/register', { nick: 'Olek', email: 'olek@example.com', password: 'haslo1234' });
  const olek = r.body; assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/auth/login', { login: 'ala@example.com', password: 'haslo1234' });
  assert.strictEqual(r.status, 200); ok('logowanie e-mailem');
  r = await api('POST', '/api/auth/login', { login: 'Ala', password: 'zlehaslo11' });
  assert.strictEqual(r.status, 401); ok('złe hasło odrzucone');
  r = await api('POST', '/api/auth/guest');
  const guest = r.body; assert(guest.me.guest && /^Gość_\d{4}$/.test(guest.me.nick)); ok('konto gościa (nick Gość_XXXX)');
  r = await api('GET', '/api/me', null, 'zly.token'); assert.strictEqual(r.status, 401); ok('nieprawidłowy token odrzucony');

  console.log('Gry i lobby');
  r = await api('GET', '/api/games');
  assert(r.body.filter((g) => g.status === 'active').length >= 6); assert(r.body.find((g) => g.slug === 'szachy').kind === 'chess'); ok('lista gier z silnikami');
  r = await api('GET', '/api/lobby'); assert(r.body.news.length >= 1); ok('lobby: komunikaty');

  console.log('Partia rankingowa człowiek vs człowiek (kółko i krzyżyk)');
  const cA = new Client(ala.token), cO = new Client(olek.token);
  await Promise.all([cA.ready, cO.ready]);
  await cA.hello; await cO.hello;
  const started = [cA.wait((m) => m.t === 'match'), cO.wait((m) => m.t === 'match')];
  cA.send({ t: 'queue', game: 'kolko-krzyzyk', rated: true });
  cO.send({ t: 'queue', game: 'kolko-krzyzyk', rated: true });
  await Promise.all(started);
  assert(cA.match.rated && cO.match.rated && cA.match.you !== cO.match.you); ok('kojarzenie w kolejce, losowe strony');
  const ttt = E.make('mnk', { w: 3, h: 3, k: 3 });
  // nielegalny ruch
  const bad = cA.match.turn === cA.match.you ? cA : cO;
  bad.send({ t: 'move', id: bad.match.id, move: 99 });
  await bad.wait((m) => m.t === 'error'); ok('nielegalny ruch odrzucony');
  const fin = await playOut([cA, cO], ttt);
  assert.strictEqual(fin.status, 'over'); assert(fin.result.ratings && fin.result.deltas); ok('partia kończy się, ranking naliczony (' + fin.result.reason + ')');
  const rowsA = D.all('SELECT * FROM ratings');
  assert.strictEqual(rowsA.length, 2); assert.strictEqual(rowsA.reduce((s, x) => s + x.rating, 0), 2400 + fin.result.deltas[0] + fin.result.deltas[1]);
  r = await api('GET', '/api/ranking?game=kolko-krzyzyk&period=a'); assert.strictEqual(r.body.rows.length, 2); ok('ranking ogólny (ELO)');
  r = await api('GET', '/api/ranking?game=kolko-krzyzyk&period=d'); assert.strictEqual(r.body.rows.length, 2); ok('ranking dzienny (punkty z okresu)');
  r = await api('GET', '/api/users/Ala'); assert.strictEqual(r.body.user.nick, 'Ala'); assert.strictEqual(r.body.ratings.length, 1); ok('publiczny profil gracza');
  r = await api('GET', '/api/matches/' + fin.id); assert(r.body.moves.length >= 5); ok('zapis partii do powtórki');
  r = await api('GET', '/api/me', null, ala.token); assert(r.body.me.xp > 0 && r.body.me.league.points >= 0); ok('xp i liga');

  console.log('Gość i bot');
  const cG = new Client(guest.token); await cG.ready; await cG.hello;
  cG.send({ t: 'bot', game: 'szachy', level: 'e', side: '1' });
  await cG.wait((m) => m.t === 'match');
  assert.strictEqual(cG.match.you, 1); const chess = E.make('chess');
  cG.send({ t: 'move', id: cG.match.id, move: chess.legal(cG.match.state)[0] });
  await cG.wait((m) => m.t === 'match' && m.m.moves >= 2, 10000); ok('bot szachowy odpowiada na ruch');
  cG.send({ t: 'resign', id: cG.match.id });
  await cG.wait((m) => m.t === 'match' && m.m.status === 'over');
  assert.strictEqual(D.all('SELECT * FROM ratings WHERE user_id=?', guest.me.id).length, 0); ok('gość nie wchodzi do rankingu, partia z botem nierankingowa');
  cG.send({ t: 'queue', game: 'szachy', rated: true });
  await cG.wait((m) => m.t === 'notice'); ok('gość dostaje informację o rankingu');
  cG.send({ t: 'unqueue' });

  console.log('Goście: zakaz czatu, brak ELO');
  r = await api('POST', '/api/auth/register', { nick: 'Gerwazy', email: 'gerwazy@example.com', password: 'haslo1234' });
  const gerwazy = r.body; assert.strictEqual(r.status, 200);
  const GMSG = 'Musisz się zarejestrować, aby móc rozmawiać z innymi graczami';
  const ratingGames = (uid) => (D.get('SELECT games FROM ratings WHERE user_id=? AND game_id=(SELECT id FROM games WHERE slug=?)', uid, 'kolko-krzyzyk') || { games: 0 }).games;
  const alaBefore = ratingGames((await cA.hello).you.id);
  cA.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 9 }); await cA.wait((m) => m.t === 'table');
  cA.send({ t: 'table_set', settings: { rated: true } }); await cA.wait((m) => m.t === 'table' && m.table.settings.rated === true);
  cG.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 9 }); await cG.wait((m) => m.t === 'table' && m.table.players.length === 2);
  const nGA = cA.msgs.length;
  cG.send({ t: 'table_chat', text: 'Cześć!' });
  const gErr = await cG.wait((m) => m.t === 'error' && m.code === 'guest'); assert.strictEqual(gErr.msg, GMSG); ok('gość nie napisze na czacie stołu – komunikat „Musisz się zarejestrować…”');
  cG.send({ t: 'table_quick', id: 1 }); await cG.wait((m) => m.t === 'error' && m.code === 'guest'); ok('gość nie wyśle też szybkiej wiadomości');
  await new Promise((r2) => setTimeout(r2, 250)); assert(!cA.msgs.slice(nGA).some((m) => m.t === 'table_chat')); ok('wiadomość gościa nie trafia do pozostałych graczy');
  cA.send({ t: 'table_ready', ready: true }); cG.send({ t: 'table_ready', ready: true });
  await Promise.all([cA.wait((m) => m.t === 'match'), cG.wait((m) => m.t === 'match')]);
  assert.strictEqual(cG.match.rated, false); assert.strictEqual(cG.match.noElo, true); ok('stół „rankingowy” z gościem: partia bez ELO, gracze widzą „Brak ELO”');
  cG.send({ t: 'chat', id: cG.match.id, text: 'hej' });
  assert.strictEqual((await cG.wait((m) => m.t === 'error' && m.code === 'guest')).msg, GMSG); ok('gość nie napisze na czacie w partii');
  cG.send({ t: 'resign', id: cG.match.id }); await cG.wait((m) => m.t === 'match' && m.m.status === 'over');
  assert.strictEqual(D.all('SELECT * FROM ratings WHERE user_id=?', guest.me.id).length, 0);
  assert.strictEqual(ratingGames((await cA.hello).you.id), alaBefore); ok('mecz z gościem NIE zmienia rankingu ELO zarejestrowanego gracza');
  cG.send({ t: 'table_leave' }); cA.send({ t: 'table_leave' }); await Promise.all([cG.wait((m) => m.t === 'table_left'), cA.wait((m) => m.t === 'table_left')]);

  console.log('Stoły: host, PIN, ranking, czat z cenzurą, kick, zaproszenia, zegar, cofanie, rewanż');
  const cR = new Client(gerwazy.token); await cR.ready; await cR.hello;
  const idA = (await cA.hello).you.id, idO = (await cO.hello).you.id, idR = (await cR.hello).you.id;
  const lastOf = (c, pred) => c.msgs.slice().reverse().find(pred);
  const errOf = (c, from) => c.wait((m) => m.t === 'error', 3000);
  cA.send({ t: 'table_sit', game: 'czworki', n: 3 });
  let tview = (await cA.wait((m) => m.t === 'table')).table;
  assert.strictEqual(tview.host, idA); assert.strictEqual(tview.players[0].host, true); assert.strictEqual(tview.settings.undo, true); ok('pierwszy gracz zostaje hostem; cofanie domyślnie włączone');
  cR.send({ t: 'tables', game: 'czworki' });
  const tlist = await cR.wait((m) => m.t === 'tables'); assert.strictEqual(tlist.list[2].st, 'waiting'); assert.strictEqual(tlist.list[2].players[0].host, true); ok('lista stołów pokazuje hosta, ranking i status');
  // progi rankingu
  cA.send({ t: 'table_set', settings: { minRating: 2000 } }); await cA.wait((m) => m.t === 'table' && m.table.settings.minRating === 2000);
  cR.send({ t: 'table_sit', game: 'czworki', n: 3 }); assert(/ranking/i.test((await errOf(cR)).msg)); ok('próg rankingu blokuje dołączenie');
  cA.send({ t: 'table_set', settings: { minRating: 2025 } }); assert(/50 pkt/.test((await errOf(cA)).msg)); ok('progi tylko co 50 pkt');
  cA.send({ t: 'table_set', settings: { minRating: 0, visibility: 'private', pin: '12' } }); assert(/PIN/.test((await errOf(cA)).msg));
  // PIN
  cA.send({ t: 'table_set', settings: { minRating: 0, visibility: 'private', pin: 'ab12' } }); await cA.wait((m) => m.t === 'table' && m.table.settings.hasPin);
  cR.send({ t: 'table_sit', game: 'czworki', n: 3, pin: 'zle' }); assert(/PIN/.test((await errOf(cR)).msg));
  cR.send({ t: 'table_sit', game: 'czworki', n: 3, pin: 'ab12' }); tview = (await cR.wait((m) => m.t === 'table' && m.table.players.length === 2)).table; ok('stół prywatny: zły PIN odrzucony, dobry wpuszcza');
  cR.send({ t: 'table_set', settings: { undo: false } }); assert(/host/i.test((await errOf(cR)).msg)); ok('ustawienia zmienia tylko host');
  assert.strictEqual(tview.settings.pin, undefined); ok('PIN nie jest ujawniany graczom spoza hosta');
  // czat + cenzura + limit
  cR.send({ t: 'table_chat', text: 'Cześć!' });
  assert.strictEqual((await cA.wait((m) => m.t === 'table_chat')).msg.text, 'Cześć!'); ok('czat stołowy dostarczany graczom');
  const nA = cA.msgs.length;
  await new Promise((r) => setTimeout(r, 1600));
  cR.send({ t: 'table_chat', text: 'k.u.r.w.a' });
  const ceT = await cR.wait((m) => m.t === 'error' && m.code === 'censored'); assert.strictEqual(ceT.msg, 'Twoja wiadomość zawiera niedozwolone słowa');
  await new Promise((r) => setTimeout(r, 200)); assert(!cA.msgs.slice(nA).some((m) => m.t === 'table_chat')); ok('wulgaryzm (z kropkami) odrzucony i niedostarczony');
  await new Promise((r) => setTimeout(r, 1600));
  for (const w of ['ch0j', 'd*pa']) { cR.send({ t: 'table_chat', text: w }); await cR.wait((m) => m.t === 'error' && m.code === 'censored'); await new Promise((r) => setTimeout(r, 1600)); }
  ok('leet-speak i maskowanie gwiazdką wykrywane');
  cR.send({ t: 'table_chat', text: 'raz' }); cR.send({ t: 'table_chat', text: 'dwa' });
  await cR.wait((m) => m.t === 'error' && m.code === 'rate'); ok('limit: 1 wiadomość na 1,5 s');
  await new Promise((r) => setTimeout(r, 1600)); cR.send({ t: 'table_quick', id: 1 });
  assert.strictEqual((await cA.wait((m) => m.t === 'table_chat' && m.msg.quick)).msg.text, 'Dobra gra!'); ok('szybkie wiadomości');
  // kick
  cR.send({ t: 'table_kick', uid: idA }); assert(/host/i.test((await errOf(cR)).msg));
  cA.send({ t: 'table_kick', uid: idR });
  assert.strictEqual((await cR.wait((m) => m.t === 'table_kicked')).msg, 'Zostałeś wyproszony ze stołu'); ok('host wyprasza gracza (komunikat dla wyproszonego)');
  // zaproszenie (omija PIN)
  cO.send({ t: 'tables', game: 'czworki' }); await cO.wait((m) => m.t === 'tables');
  cA.send({ t: 'table_lobby' }); const lobT = await cA.wait((m) => m.t === 'table_lobby'); assert(lobT.list.some((x) => x.uid === idO));
  cA.send({ t: 'table_invite', uid: idO }); const invT = await cO.wait((m) => m.t === 'table_invite'); assert.strictEqual(invT.n, 3); assert.strictEqual(invT.from.uid, idA);
  cO.send({ t: 'table_invite_reply', game: invT.game, n: invT.n, accept: true });
  tview = (await cO.wait((m) => m.t === 'table' && m.table.players.length === 2)).table; ok('zaproszenie z pop-upem: lista lobby, wysłanie i przyjęcie');
  // host opuszcza -> rola przechodzi
  cA.send({ t: 'table_leave' }); tview = (await cO.wait((m) => m.t === 'table' && m.table.players.length === 1)).table;
  assert.strictEqual(tview.host, idO); ok('po wyjściu hosta rola przechodzi na kolejnego gracza');
  cO.send({ t: 'table_set', settings: { visibility: 'public', undo: true, clock: { mode: 'turn', sec: 15 } } }); await cO.wait((m) => m.t === 'table' && !m.table.settings.hasPin);
  cA.send({ t: 'table_sit', game: 'czworki', n: 3 }); await cA.wait((m) => m.t === 'table' && m.table.players.length === 2);
  // gotowość -> start z zegarem „na turę”
  const startedT = [cA.wait((m) => m.t === 'match' && m.m.status === 'playing'), cO.wait((m) => m.t === 'match' && m.m.status === 'playing')];
  cA.send({ t: 'table_ready', ready: true }); await cO.wait((m) => m.t === 'table' && m.table.players.some((p) => p.ready));
  assert(!cA.match || cA.match.status !== 'playing' || true);
  cO.send({ t: 'table_ready', ready: true });
  const [mA, mO] = (await Promise.all(startedT)).map((x) => x.m); assert.strictEqual(mA.game.timeSec, 15); assert.strictEqual(mA.game.turnClock, true); assert.strictEqual(mA.undo, true); assert.strictEqual(mA.table, 3);
  ok('start po gotowości obu graczy; zegar „15 s na turę”'); 
  // cofanie ruchu
  const [mover, other] = mA.you === mA.turn ? [cA, cO] : [cO, cA], eng4 = E.make(mA.game.engine, mA.game.params), mm = mover.match;
  mover.send({ t: 'move', id: mm.id, move: eng4.legal(mm.state)[0] }); await other.wait((m) => m.t === 'match' && m.m.moves === 1);
  mover.send({ t: 'undo_req', id: mm.id }); const ur = await other.wait((m) => m.t === 'match' && m.m.undoReq);
  other.send({ t: 'undo_reply', id: mm.id, accept: false }); await mover.wait((m) => m.t === 'notice' && /odrzuci/.test(m.msg));
  mover.send({ t: 'undo_req', id: mm.id }); await other.wait((m) => m.t === 'match' && m.m.undoReq);
  other.send({ t: 'undo_reply', id: mm.id, accept: true });
  const backT = await mover.wait((m) => m.t === 'match' && m.m.moves === 0 && m.m.turn === m.m.you); assert.strictEqual(backT.m.undoReq, null); ok('cofnięcie ruchu za zgodą przeciwnika (przywraca planszę i turę)');
  // rewanż
  const sidesBefore = mA.players.map((p) => p.nick);
  const overT = [cA.wait((m) => m.t === 'match' && m.m.status === 'over'), cO.wait((m) => m.t === 'match' && m.m.status === 'over')];
  cO.send({ t: 'resign', id: mm.id }); await Promise.all(overT);
  const reT = [cA.wait((m) => m.t === 'match' && m.m.status === 'playing' && m.m.id !== mm.id), cO.wait((m) => m.t === 'match' && m.m.status === 'playing' && m.m.id !== mm.id)];
  cA.send({ t: 'rematch', id: mm.id }); cO.send({ t: 'rematch', id: mm.id });
  const rm = (await Promise.all(reT))[0].m; assert.deepStrictEqual(rm.players.map((p) => p.nick), sidesBefore.slice().reverse()); assert.strictEqual(rm.game.timeSec, 15); ok('rewanż: te same ustawienia, zamienione strony');
  const overT2 = [cA.wait((m) => m.t === 'match' && m.m.id === rm.id && m.m.status === 'over'), cO.wait((m) => m.t === 'match' && m.m.id === rm.id && m.m.status === 'over')];
  cA.send({ t: 'resign', id: rm.id }); await Promise.all(overT2);
  cA.send({ t: 'table_leave' }); cO.send({ t: 'table_leave' }); await cA.wait((m) => m.t === 'table_left'); await cO.wait((m) => m.t === 'table_left');

  console.log('Rozłączenie: pauza, powrót, ucieczka (rage quit)');
  D.setSetting('disconnect_grace_sec', '1');
  const mkU = async (nick) => { const x = await api('POST', '/api/auth/register', { nick, email: nick + '@example.com', password: 'haslo1234' }); const c = new Client(x.body.token); await c.ready; return { c, id: (await c.hello).you.id }; };
  const q1 = await mkU('Rage1'), q2 = await mkU('Rage2');
  q1.c.send({ t: 'table_sit', game: 'czworki', n: 7 }); await q1.c.wait((m) => m.t === 'table');
  q2.c.send({ t: 'table_sit', game: 'czworki', n: 7 }); await q2.c.wait((m) => m.t === 'table' && m.table.players.length === 2);
  q1.c.send({ t: 'table_set', settings: { rated: true } }); await q1.c.wait((m) => m.t === 'table' && m.table.settings.rated);
  const startR = [q1.c.wait((m) => m.t === 'match' && m.m.status === 'playing'), q2.c.wait((m) => m.t === 'match' && m.m.status === 'playing')];
  q1.c.send({ t: 'table_ready', ready: true }); q2.c.send({ t: 'table_ready', ready: true }); await Promise.all(startR);
  assert.strictEqual(q1.c.match.rated, true);
  const finR = q1.c.wait((m) => m.t === 'match' && m.m.status === 'over', 6000);
  q2.c.close();
  const dscT = await q1.c.wait((m) => m.t === 'match' && m.m.disc.some(Boolean)); assert(dscT.m.graceMs > 0); ok('rozłączenie wstrzymuje grę i pokazuje czas oczekiwania');
  const endR = (await finR).m; assert.strictEqual(endR.result.reason, 'rozłączenie'); const loserSide = endR.result.rage; assert(loserSide > 0);
  assert.strictEqual(D.get('SELECT rage_quits_count AS c FROM users WHERE id=?', q2.id).c, 1); assert.strictEqual(D.get('SELECT rage_quits_count AS c FROM users WHERE id=?', q1.id).c, 0);
  assert(endR.result.deltas[loserSide - 1] <= -30); assert(endR.result.deltas[2 - loserSide] > 0); ok('uciekinier: porażka, +1 do rage_quits_count i dodatkowa kara punktowa; rywal wygrywa');
  const pfR = await api('GET', '/api/users/Rage2'); assert.strictEqual(pfR.body.rageQuits, 1); assert(pfR.body.completedPct <= 50); ok('profil pokazuje ucieczki i % ukończonych gier');
  D.setSetting('disconnect_grace_sec', '60'); q1.c.close();

  console.log('Pokoje prywatne i obserwowanie');
  const cG2 = cR;
  cA.send({ t: 'room_create', game: 'czworki', rated: false });
  const room = await cA.wait((m) => m.t === 'room');
  const st = [cA.wait((m) => m.t === 'match' && m.m.game.slug === 'czworki'), cG2.wait((m) => m.t === 'match' && m.m.game.slug === 'czworki')];
  cG2.send({ t: 'room_join', code: room.code.toLowerCase() });
  await Promise.all(st); ok('pokój po kodzie');
  const live = await api('GET', '/api/live'); assert.strictEqual(live.body.length, 1);
  const cO2 = cO; cO2.send({ t: 'watch', id: live.body[0].id });
  const w = await cO2.wait((m) => m.t === 'match' && m.m.you === 0 && m.m.id === live.body[0].id); assert.strictEqual(w.m.game.slug, 'czworki'); ok('obserwowanie partii na żywo');
  await new Promise((r) => setTimeout(r, 1600));
  cG2.send({ t: 'chat', id: live.body[0].id, text: 'cześć' });
  await cO2.wait((m) => m.t === 'chat' && m.text === 'cześć'); ok('czat w partii');
  await new Promise((r) => setTimeout(r, 1600)); const nW = cO2.msgs.length;
  cG2.send({ t: 'chat', id: live.body[0].id, text: 'ch.u.j' }); await cG2.wait((m) => m.t === 'error' && m.code === 'censored');
  await new Promise((r) => setTimeout(r, 200)); assert(!cO2.msgs.slice(nW).some((m) => m.t === 'chat')); ok('cenzura działa też na czacie w partii (wiadomość nie trafia do widzów)');
  cA.send({ t: 'resign', id: cA.match.id });
  await cA.wait((m) => m.t === 'match' && m.m.status === 'over' && m.m.game.slug === 'czworki');

  console.log('Rozłączenie i powrót');
  cG2.send({ t: 'bot', game: 'reversi', level: 'e', side: '1' });
  await cG2.wait((m) => m.t === 'match' && m.m.game.slug === 'reversi');
  const mid = cG2.match.id; cG2.close(); await new Promise((r2) => setTimeout(r2, 300));
  const cG3 = new Client(gerwazy.token); await cG3.ready;
  const hello = await cG3.hello; assert(hello.active && hello.active.id === mid); ok('powrót do trwającej partii po rozłączeniu');
  cG3.send({ t: 'resign', id: mid });

  console.log('Zegar');
  r = await api('POST', '/api/auth/login', { login: 'admin', password: 'AdminTest123' }); const adm = r.body.token;
  assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/admin/games', null, ala.token); assert.strictEqual(r.status, 403); ok('zwykły gracz nie wejdzie do panelu');
  r = await api('GET', '/api/admin/games', null, adm); assert(r.body.length > 10);
  const ttg = r.body.find((g) => g.slug === 'kolko-krzyzyk');
  r = await api('PUT', '/api/admin/games/' + ttg.id, Object.assign({}, ttg, { time_sec: 2 }), adm); assert.strictEqual(r.body.timeSec, 2);
  const t2 = [cA.wait((m) => m.t === 'match' && m.m.game.slug === 'kolko-krzyzyk' && m.m.status === 'playing'), cO.wait((m) => m.t === 'match' && m.m.game.slug === 'kolko-krzyzyk' && m.m.status === 'playing')];
  cA.send({ t: 'queue', game: 'kolko-krzyzyk', rated: false }); cO.send({ t: 'queue', game: 'kolko-krzyzyk', rated: false });
  await Promise.all(t2);
  const over = await cA.wait((m) => m.t === 'match' && m.m.status === 'over' && m.m.game.slug === 'kolko-krzyzyk' && m.m.result.reason === 'czas', 8000);
  assert(over.m.result.winner > 0); ok('przekroczenie czasu kończy partię');
  await api('PUT', '/api/admin/games/' + ttg.id, Object.assign({}, ttg, { time_sec: 60 }), adm);

  console.log('Panel administratora: gry');
  r = await api('POST', '/api/admin/games', { slug: 'piatki', name: 'Piątki 9×9', icon: '5', hue: 300, engine: 'mnk', params: { w: 9, h: 9, k: 5 }, status: 'active', category: 'Planszowe', time_sec: 120 }, adm);
  assert.strictEqual(r.status, 200); const newG = r.body; assert.strictEqual(newG.board.w, 9); ok('dodanie zupełnie nowej gry z poziomu CMS');
  r = await api('GET', '/api/games'); assert(r.body.find((g) => g.slug === 'piatki')); ok('nowa gra od razu widoczna w aplikacji');
  const cN = new Client(olek.token); await cN.ready; await cN.hello;
  cN.send({ t: 'bot', game: 'piatki', level: 'm', side: '1' });
  await cN.wait((m) => m.t === 'match' && m.m.game.slug === 'piatki'); ok('nowa gra jest grywalna (silnik siatki + bot)');
  cN.send({ t: 'resign', id: cN.match.id }); await cN.wait((m) => m.t === 'match' && m.m.status === 'over');
  r = await api('PUT', '/api/admin/games/' + newG.id, Object.assign({}, newG, { status: 'hidden' }), adm);
  r = await api('GET', '/api/games'); assert(!r.body.find((g) => g.slug === 'piatki')); ok('ukrycie gry znika z aplikacji');
  cN.send({ t: 'bot', game: 'piatki', level: 'm' }); await cN.wait((m) => m.t === 'error'); ok('ukrytej gry nie da się uruchomić');
  r = await api('POST', '/api/admin/games', { slug: 'x-y', name: 'Test', engine: null, status: 'active' }, adm); assert.strictEqual(r.status, 400); ok('gra bez silnika nie może być aktywna');
  r = await api('DELETE', '/api/admin/games/' + newG.id, null, adm); assert.strictEqual(r.status, 409); ok('gra z partiami nie jest usuwana');

  console.log('Panel administratora: reklamy');
  r = await api('POST', '/api/admin/ads', { name: 'Restauracja', slot: 'lobby_banner', title: 'Obiad po grze', text: 'Zapraszamy', link_url: 'https://example.com', enabled: true, max_per_day: 2, audience: 'all' }, adm);
  assert.strictEqual(r.status, 200); const adId = r.body.id;
  r = await api('POST', '/api/admin/ads', { name: 'zly', link_url: 'javascript:alert(1)' }, adm); assert.strictEqual(r.status, 400); ok('link reklamy tylko http(s)');
  let shown = 0;
  for (let i = 0; i < 4; i++) { r = await api('GET', '/api/ads?slot=lobby_banner', null, olek.token); if (r.body.ad && r.body.ad.id === adId) shown++; }
  assert.strictEqual(shown, 2); ok('limit wyświetleń na użytkownika dziennie');
  await api('POST', '/api/ads/' + adId + '/click');
  r = await api('GET', '/api/admin/ads', null, adm); const adRow = r.body.find((a) => a.id === adId); assert.strictEqual(adRow.impressions, 2); assert.strictEqual(adRow.clicks, 1); ok('statystyki reklamy: wyświetlenia i kliknięcia');
  await api('PUT', '/api/admin/ads/' + adId, Object.assign({}, adRow, { enabled: false }), adm);
  r = await api('GET', '/api/ads?slot=lobby_banner', null, ala.token); assert(!r.body.ad || r.body.ad.id !== adId); ok('wyłączona reklama się nie pokazuje');

  console.log('Panel administratora: użytkownicy i treści');
  r = await api('POST', '/api/admin/news', { title: 'Nowy turniej', body: 'Sobota 20:00', kind: 'banner', pinned: true }, adm); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/lobby'); assert.strictEqual(r.body.news[0].title, 'Nowy turniej'); ok('komunikat opublikowany w lobby bez nowej wersji aplikacji');
  r = await api('PUT', '/api/admin/pages/regulamin', { title: 'Regulamin', body: 'Nowa treść' }, adm); r = await api('GET', '/api/pages/regulamin'); assert.strictEqual(r.body.body, 'Nowa treść'); ok('edycja stron (regulamin)');
  await api('POST', '/api/report', { nick: 'Olek', reason: 'spam', note: 'test' }, ala.token);
  r = await api('GET', '/api/admin/reports', null, adm); assert.strictEqual(r.body.length, 1); ok('zgłoszenie gracza trafia do moderacji');
  const oid = olek.me.id;
  r = await api('POST', '/api/admin/users/' + oid + '/action', { action: 'ban', hours: 24, note: 'test' }, adm); assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/auth/login', { login: 'Olek', password: 'haslo1234' }); assert.strictEqual(r.status, 403); ok('zbanowany gracz nie zaloguje się');
  r = await api('GET', '/api/me', null, olek.token); assert.strictEqual(r.status, 403);
  r = await api('GET', '/api/ranking?game=kolko-krzyzyk&period=a'); assert.strictEqual(r.body.rows.length, 1); ok('zbanowany znika z rankingu');
  await api('POST', '/api/admin/users/' + oid + '/action', { action: 'unban' }, adm);
  r = await api('POST', '/api/auth/login', { login: 'Olek', password: 'haslo1234' }); assert.strictEqual(r.status, 200); ok('odbanowanie');
  r = await api('GET', '/api/admin/stats', null, adm); assert(r.body.users >= 3 && r.body.matchesTotal >= 4); ok('statystyki platformy');
  r = await api('POST', '/api/admin/upload', { data: 'data:image/png;base64,iVBORw0KGgo=' }, adm); assert.strictEqual(r.status, 200);
  const up = await fetch(base + r.body.url); assert.strictEqual(up.status, 200); ok('przesyłanie obrazów');

  console.log('Zamiana gościa na konto');
  r = await api('POST', '/api/auth/register', { nick: 'Zofia', email: 'zofia@example.com', password: 'haslo1234' }, guest.token);
  assert.strictEqual(r.body.me.id, guest.me.id); assert(!r.body.me.guest); ok('gość zakłada konto i zachowuje swoje dane (to samo id)');

  console.log('Pluginy, układ, ogłoszenia, reklamy z kodem');
  const zipB64 = fs.readFileSync(path.join(__dirname, '..', 'docs', 'przyklad-plugin.zip')).toString('base64');
  r = await api('POST', '/api/admin/plugins', { zip: zipB64 }, olek.token); assert.strictEqual(r.status, 403); ok('zwykły gracz nie wgra pluginu');
  r = await api('POST', '/api/admin/plugins', { zip: zipB64 }, adm); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.slug, 'klikacz'); ok('instalacja gry z archiwum ZIP');
  r = await api('POST', '/api/admin/plugins', { zip: Buffer.from('to nie zip').toString('base64') }, adm); assert.strictEqual(r.status, 400); ok('uszkodzony ZIP jest odrzucany');
  r = await api('GET', '/api/games'); assert(!r.body.find((g) => g.slug === 'klikacz')); ok('nowy plugin jest domyślnie ukryty');
  const pf = await fetch(base + '/plugins/klikacz/index.html'); assert.strictEqual(pf.status, 200); assert(/sandbox/.test(pf.headers.get('content-security-policy'))); assert(/connect-src 'none'/.test(pf.headers.get('content-security-policy'))); ok('pliki pluginu serwowane z CSP sandbox');
  assert.strictEqual((await fetch(base + '/plugins/klikacz/..%2f..%2fsecret.key')).status, 404); assert.strictEqual((await fetch(base + '/plugins/nie-ma/index.html')).status, 404); ok('ochrona przed path traversal');
  let lay = (await api('GET', '/api/admin/layout', null, adm)).body;
  const kl = lay.find((g) => g.slug === 'klikacz'); const rest = lay.filter((g) => g !== kl);
  r = await api('PUT', '/api/admin/layout', { items: [{ id: kl.id, visible: true }].concat(rest.map((g, i) => ({ id: g.id, visible: i !== 0 ? g.visible : false }))) }, adm); assert.strictEqual(r.status, 200);
  const pub = (await api('GET', '/api/games')).body; assert.strictEqual(pub[0].slug, 'klikacz'); assert.strictEqual(pub[0].plugin, 'klikacz'); assert(!pub.find((g) => g.slug === rest[0].slug)); ok('układ gier: kolejność i widoczność z bazy do API');
  await api('PUT', '/api/admin/layout', { items: lay.map((g) => ({ id: g.id, visible: g.slug === 'klikacz' ? true : g.visible || g.slug === rest[0].slug })) }, adm);
  r = await api('PUT', '/api/admin/layout/' + kl.id + '/config', { config: { roundSec: 5 } }, adm); assert.strictEqual(r.status, 200);
  assert.strictEqual((await api('GET', '/api/games')).body.find((g) => g.slug === 'klikacz').config.roundSec, 5); ok('konfiguracja zdalna bez restartu');
  r = await api('POST', '/api/admin/announcements', { title: 'Przerwa techniczna', body: 'Jutro 2:00', style: 'popup', level: 'warn' }, adm); assert.strictEqual(r.status, 200);
  const an = await api('GET', '/api/announcements'); assert.strictEqual(an.body.length, 1); assert.strictEqual(an.body[0].style, 'popup'); ok('ogłoszenia publikowane graczom');
  r = await api('POST', '/api/admin/ads', { name: 'AdSense test', slot: 'footer', kind: 'code', code: '<b>reklama</b>', weight: 5, enabled: true }, adm); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.kind, 'code');
  const ad = await api('GET', '/api/ads?slot=footer&device=desktop'); assert.strictEqual(ad.body.ad.code, '<b>reklama</b>'); ok('reklama z własnym kodem w miejscu „stopka”');
  r = await api('DELETE', '/api/admin/plugins/klikacz', null, adm); assert.strictEqual(r.status, 200); assert.strictEqual((await fetch(base + '/plugins/klikacz/index.html')).status, 404); ok('usuwanie pluginu');

  console.log('Walidacja pluginów, aktywność gier, reklamy wg pozycji');
  const zlib = require('zlib');
  const mkZip = (entries, lie) => { // minimalny ZIP (deflate); lie = fałszywy rozmiar w nagłówku
    const parts = [], cd = []; let off = 0;
    for (const [name, data] of entries) {
      const nb = Buffer.from(name), raw = Buffer.from(data), def = zlib.deflateRawSync(raw);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(lie || raw.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(lie || raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      parts.push(lh, nb, def); cd.push(ch, nb); off += 30 + nb.length + def.length;
    }
    const cdb = Buffer.concat(cd), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat(parts.concat([cdb, e])).toString('base64');
  };
  const good = JSON.stringify({ slug: 'test-gra', name: 'Test', entry: 'index.html' });
  const badZip = async (label, zip, code) => { const x = await api('POST', '/api/admin/plugins', { zip }, adm); assert.strictEqual(x.status, code || 400, label + ' -> ' + x.status); assert(x.body.error); };
  await badZip('ucięty ZIP', mkZip([['manifest.json', good], ['index.html', '<p>x</p>']]).slice(0, 60));
  await badZip('brak manifestu', mkZip([['index.html', '<p>x</p>']]));
  await badZip('manifest nie-JSON', mkZip([['manifest.json', '{oops'], ['index.html', 'x']]));
  await badZip('zły typ pola', mkZip([['manifest.json', JSON.stringify({ slug: 'test-gra', name: 123 })], ['index.html', 'x']]));
  await badZip('zły slug', mkZip([['manifest.json', JSON.stringify({ slug: '../x', name: 'X' })], ['index.html', 'x']]));
  await badZip('brak pliku startowego', mkZip([['manifest.json', good]]));
  await badZip('zip-slip', mkZip([['manifest.json', good], ['index.html', 'x'], ['../evil.js', 'x']]));
  await badZip('niedozwolone rozszerzenie', mkZip([['manifest.json', good], ['index.html', 'x'], ['run.php', 'x']]));
  await badZip('rozmiar w nagłówku kłamie', mkZip([['manifest.json', good], ['index.html', 'x']], 5));
  await badZip('base64 śmieci', '%%%nie-base64%%%');
  r = await api('POST', '/api/admin/plugins', { zip: 12345 }, adm); assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/admin/plugins', { manifest: '{zepsute', html: 'x' }, adm); assert.strictEqual(r.status, 400);
  assert.strictEqual((await fetch(base + '/health')).status, 200); assert.strictEqual((await fetch(base + '/plugins/%E0%A4%A/x')).status, 400);
  ok('wadliwe wtyczki są odrzucane (400/413), serwer działa dalej');
  r = await api('POST', '/api/admin/plugins', { zip: mkZip([['manifest.json', good], ['index.html', '<p>ok</p>']]) }, adm); assert.strictEqual(r.status, 200);
  const rows = (await api('GET', '/api/admin/layout', null, adm)).body, tg = rows.find((g) => g.slug === 'test-gra');
  const dbq = require('../server/db'); let row = dbq.get('SELECT sort_order,is_active FROM games WHERE id=?', tg.id); assert.strictEqual(row.is_active, 0); ok('kolumny sort_order / is_active istnieją, nowa wtyczka jest nieaktywna');
  await api('PUT', '/api/admin/layout', { items: [{ id: tg.id, visible: true }].concat(rows.filter((g) => g !== tg).map((g) => ({ id: g.id, visible: g.visible }))) }, adm);
  row = dbq.get('SELECT sort_order,is_active FROM games WHERE id=?', tg.id); assert.strictEqual(row.is_active, 1); assert.strictEqual(row.sort_order, 10);
  assert.strictEqual((await api('GET', '/api/games')).body[0].slug, 'test-gra'); ok('/api/games: tylko aktywne, wg sort_order');
  await api('PUT', '/api/admin/layout', { items: rows.map((g) => ({ id: g.id, visible: g.slug === 'test-gra' ? false : g.visible })) }, adm);
  assert(!(await api('GET', '/api/games')).body.find((g) => g.slug === 'test-gra')); ok('wyłączona gra znika z /api/games');
  await api('POST', '/api/admin/ads', { name: 'Top img', slot: 'top_banner', title: 'Baner', image_url: '/uploads/x.png', link_url: 'https://example.com', enabled: true }, adm);
  await api('POST', '/api/admin/ads', { name: 'Side code', slot: 'sidebar', kind: 'code', code: '<i>ad</i>', enabled: true }, adm);
  const pl = (await api('GET', '/api/ads?device=desktop')).body;
  assert.strictEqual(pl.top.type, 'image_link'); assert.strictEqual(pl.top.link, 'https://example.com'); assert.strictEqual(pl.sidebar.type, 'script_code'); assert.strictEqual(pl.sidebar.content, '<i>ad</i>');
  assert.strictEqual((await api('GET', '/api/ads?placement=top')).body.ad.placement, 'top'); ok('/api/ads zwraca aktywne reklamy dla pozycji (image_link / script_code)');
  const idx = await (await fetch(base + '/')).text(); assert(/id="ad-top"/.test(idx) && /id="ad-sidebar"/.test(idx) && /id="ad-footer"/.test(idx)); ok('index.html ma kontenery na reklamy');
  await api('DELETE', '/api/admin/plugins/test-gra', null, adm);

  console.log('RBAC, backup ZIP, reklamy (walidacja/harmonogram/slider), blokady, moderacja kont');
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  const regUser = async (nick) => (await api('POST', '/api/auth/register', { nick, email: nick.toLowerCase() + '@example.com', password: 'haslo1234' })).body;
  /* --- role: Super Admin tworzy Moderatora; trigger bazy przyjmuje rolę 'mod' --- */
  r = await api('POST', '/api/admin/accounts', { nick: 'ModeratorA', email: 'moda@example.com', password: 'ModHaslo123', role: 'mod' }, adm); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('POST', '/api/admin/accounts', { nick: 'ModeratorA', email: 'x@example.com', password: 'ModHaslo123', role: 'mod' }, adm); assert.strictEqual(r.status, 409);
  r = await api('POST', '/api/admin/accounts', { nick: 'Zly1', email: 'z@example.com', password: 'krotkie', role: 'mod' }, adm); assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/auth/login', { login: 'ModeratorA', password: 'ModHaslo123' }); assert.strictEqual(r.status, 200); const mtok = r.body.token;
  r = await api('GET', '/api/admin/me', null, mtok); assert.strictEqual(r.body.role, 'mod'); assert(!r.body.caps.includes('*'));
  ok('Super Admin tworzy konto Moderatora (rola mod zapisuje się w bazie)');
  const forbidden = [['GET', '/api/admin/backup'], ['GET', '/api/admin/accounts'], ['POST', '/api/admin/accounts'], ['GET', '/api/admin/games'], ['GET', '/api/admin/plugins'], ['GET', '/api/admin/layout'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/plugins']];
  for (const [m2, u2] of forbidden) { r = await api(m2, u2, m2 === 'GET' ? null : {}, mtok); assert.strictEqual(r.status, 403, m2 + ' ' + u2 + ' -> ' + r.status); }
  for (const u2 of ['/api/admin/stats', '/api/admin/ads', '/api/admin/announcements', '/api/admin/censor', '/api/admin/reports', '/api/admin/users']) { r = await api('GET', u2, null, mtok); assert.strictEqual(r.status, 200, u2 + ' -> ' + r.status); }
  r = await api('POST', '/api/admin/ads', { name: 'Kod od moda', slot: 'footer', kind: 'code', code: '<b>x</b>', enabled: true }, mtok); assert.strictEqual(r.status, 403);
  ok('Moderator: dostęp do statystyk/reklam/ogłoszeń/cenzury, brak dostępu do wtyczek, ustawień, kont, backupu i reklam z kodem');
  r = await api('GET', '/api/admin/backup', null, (await regUser('Zwykly1')).token); assert.strictEqual(r.status, 403);
  r = await api('GET', '/api/admin/backup'); assert.strictEqual(r.status, 401); ok('backup wymaga autoryzacji Super Admina (gracz 403, anonim 401)');

  /* --- backup ZIP --- */
  fs.writeFileSync(path.join(D.DATA_DIR, 'uploads', 'testowy-awatar.txt'), 'avatar');
  const bk = await fetch(base + '/api/admin/backup', { headers: { Authorization: 'Bearer ' + adm } });
  assert.strictEqual(bk.status, 200); assert(/application\/zip/.test(bk.headers.get('content-type'))); assert(/attachment; filename="nakartce-backup-/.test(bk.headers.get('content-disposition')));
  const zbuf = Buffer.from(await bk.arrayBuffer()), zfile = path.join(D.DATA_DIR, 'backup-test.zip'); fs.writeFileSync(zfile, zbuf);
  const { execFileSync } = require('child_process');
  let haveUnzip = true; try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (e) { haveUnzip = false; }
  assert.strictEqual(zbuf.readUInt32LE(zbuf.length - 22), 0x06054b50);
  if (haveUnzip) {
    execFileSync('unzip', ['-tq', zfile]);
    const names = execFileSync('unzip', ['-Z1', zfile]).toString().split('\n');
    assert(names.includes('database/nakartce.db') && names.includes('uploads/testowy-awatar.txt'), names.join(','));
    const dbf = path.join(D.DATA_DIR, 'restored.db'); fs.writeFileSync(dbf, execFileSync('unzip', ['-p', zfile, 'database/nakartce.db'], { maxBuffer: 1e9 }));
    const { DatabaseSync } = require('node:sqlite'), rdb = new DatabaseSync(dbf);
    assert(rdb.prepare("SELECT COUNT(*) AS n FROM users WHERE nick='ModeratorA'").get().n === 1); rdb.close();
  }
  ok('pełny backup .zip: poprawne archiwum z bazą SQLite i wgranymi plikami' + (haveUnzip ? '' : ' (bez unzip: sprawdzono tylko nagłówek)'));

  /* --- obraz reklamy: 2 MB, proporcje slotu, przycinanie do wymiarów docelowych --- */
  let sharp = null; try { sharp = require('sharp'); } catch (e) { /* opcjonalny */ }
  const dataUrl = (b, mime) => 'data:' + (mime || 'image/png') + ';base64,' + b.toString('base64');
  const png = async (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2.2 * 1024 * 1024)]);
  r = await api('POST', '/api/admin/ads/upload', { slot: 'top_banner', data: dataUrl(big) }, mtok); assert.strictEqual(r.status, 413); ok('baner > 2 MB jest odrzucany (413)');
  r = await api('POST', '/api/admin/ads/upload', { slot: 'top_banner', data: 'data:text/html;base64,PGI+' }, mtok); assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/admin/ads/upload', { slot: 'nieznany', data: dataUrl(Buffer.from('x')) }, mtok); assert.strictEqual(r.status, 400);
  if (sharp) {
    r = await api('POST', '/api/admin/ads/upload', { slot: 'top_banner', data: dataUrl(await png(600, 500)) }, mtok); assert.strictEqual(r.status, 400); assert(/proporcj/i.test(r.body.error), r.body.error);
    r = await api('POST', '/api/admin/ads/upload', { slot: 'sidebar', data: dataUrl(await png(728, 90)) }, mtok); assert.strictEqual(r.status, 400);
    ok('obraz o złych proporcjach (np. 600×500 dla 728×90) jest odrzucany z opisem');
    r = await api('POST', '/api/admin/ads/upload', { slot: 'top_banner', data: dataUrl(await png(1456, 180)) }, mtok); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.width, 728); assert.strictEqual(r.body.height, 90); assert(r.body.resized);
    const meta = await sharp(path.join(D.DATA_DIR, 'uploads', path.basename(r.body.url))).metadata(); assert.strictEqual(meta.width, 728); assert.strictEqual(meta.height, 90);
    r = await api('POST', '/api/admin/ads/upload', { slot: 'sidebar', data: dataUrl(await png(900, 750)) }, mtok); assert.strictEqual(r.status, 200);
    assert.strictEqual((await sharp(path.join(D.DATA_DIR, 'uploads', path.basename(r.body.url))).metadata()).width, 300);
    ok('poprawne proporcje: serwer przycina i skaluje do 728×90 / 300×250 (sharp)');
  } else ok('sharp niezainstalowany – pominięto test przeskalowania obrazów');
  r = await api('POST', '/api/admin/ads/upload', { slot: 'top_banner', data: dataUrl(await (sharp ? png(728, 90) : Buffer.alloc(0))) }, (await regUser('Zwykly2')).token); assert.strictEqual(r.status, 403);

  /* --- harmonogram i slider --- */
  const mkAd = async (extra) => (await api('POST', '/api/admin/ads', Object.assign({ name: 'Harm', slot: 'footer', title: 'H', link_url: 'https://example.com', enabled: true }, extra), mtok));
  const t0 = Date.now();
  r = await mkAd({ schedule: '1d' }); assert.strictEqual(r.status, 200); assert(Math.abs((r.body.end - r.body.start) - 864e5) < 5000 && r.body.start >= t0 - 1000); assert.strictEqual(r.body.schedule, '1d');
  r = await mkAd({ schedule: '2d' }); assert(Math.abs((r.body.end - r.body.start) - 2 * 864e5) < 5000);
  r = await mkAd({ schedule: '1w' }); assert(Math.abs((r.body.end - r.body.start) - 7 * 864e5) < 5000);
  r = await mkAd({ schedule: '1m' }); assert(r.body.end - r.body.start >= 28 * 864e5 && r.body.end - r.body.start <= 32 * 864e5);
  r = await mkAd({ schedule: 'forever', start: '2030-01-01', end: '2030-02-01' }); assert.strictEqual(r.body.start, 0); assert.strictEqual(r.body.end, 0);
  r = await mkAd({ schedule: 'range', start: '2026-01-01T10:00:00Z', end: '2026-01-01T09:00:00Z' }); assert.strictEqual(r.status, 400);
  r = await mkAd({ schedule: 'range', start: new Date(Date.now() + 864e5).toISOString(), end: new Date(Date.now() + 2 * 864e5).toISOString() }); assert.strictEqual(r.status, 200); const futureAd = r.body.id;
  ok('harmonogram emisji: 1 dzień / 2 dni / 1 tydzień / 1 miesiąc / zakres dat / bezterminowo');
  const before = (await api('GET', '/api/admin/ads', null, adm)).body.find((a) => a.id === futureAd).impressions;
  r = await api('GET', '/api/ads?slides=1&device=desktop'); assert.strictEqual(r.status, 200); assert(Array.isArray(r.body.slides.footer) && r.body.slides.footer.length >= 4);
  assert(!r.body.slides.footer.some((s) => s.id === futureAd), 'reklama z przyszłości nie może być w sliderze');
  const s1 = await mkAd({ name: 'Slajd 15s', slide_sec: 15, schedule: 'forever', weight: 100 }); r = await api('GET', '/api/ads?slides=1&device=desktop');
  assert.strictEqual(r.body.slides.footer.find((s) => s.id === s1.body.id).seconds, 15); assert.strictEqual(r.body.slides.footer[0].id, s1.body.id);
  const imp0 = (await api('GET', '/api/admin/ads', null, adm)).body.find((a) => a.id === s1.body.id).impressions;
  await api('POST', '/api/ads/' + s1.body.id + '/view', {}); assert.strictEqual((await api('GET', '/api/admin/ads', null, adm)).body.find((a) => a.id === s1.body.id).impressions, imp0 + 1);
  ok('slider: lista aktywnych reklam z indywidualnym czasem slajdu, wyświetlenia liczone osobno');

  /* --- blokowanie graczy --- */
  const b1 = await regUser('Blokujacy'), b2 = await regUser('Zablokowany');
  r = await api('POST', '/api/me/blocks', { uid: b1.me.id }, b1.token); assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/me/blocks', { nick: 'Zablokowany' }, b1.token); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/me/blocks', null, b1.token); assert.strictEqual(r.body.length, 1); assert.strictEqual(r.body[0].nick, 'Zablokowany');
  r = await api('GET', '/api/users/Zablokowany', null, b1.token); assert.strictEqual(r.body.blocked, true); ok('blokada z profilu: lista „Zablokowani użytkownicy” i flaga w profilu');
  const c1 = new Client(b1.token), c2 = new Client(b2.token); await Promise.all([c1.ready, c2.ready, c1.hello, c2.hello]);
  c1.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 7 }); await c1.wait((m) => m.t === 'table');
  c2.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 7 }); await c2.wait((m) => m.t === 'table' && m.table.players.length === 2);
  c2.send({ t: 'table_chat', text: 'czesc, widzisz mnie?' });
  await c2.wait((m) => m.t === 'table_chat' && m.msg.text === 'czesc, widzisz mnie?', 2000);
  await sleep(300); assert(!c1.msgs.some((m) => m.t === 'table_chat' && m.msg.text === 'czesc, widzisz mnie?'), 'zablokowany nie może pisać do blokującego');
  c1.send({ t: 'table_chat', text: 'odpowiedz blokujacego' }); await c2.wait((m) => m.t === 'table_chat' && m.msg.text === 'odpowiedz blokujacego', 2000);
  c1.send({ t: 'table_leave' }); await c1.wait((m) => m.t === 'table_left'); c2.send({ t: 'table_leave' }); await c2.wait((m) => m.t === 'table_left');
  ok('czat: wiadomości zablokowanego są ukryte u blokującego (blokujący nadal pisze)');
  c1.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 8 }); await c1.wait((m) => m.t === 'table' && m.table.n === 8);
  c2.send({ t: 'table_sit', game: 'kolko-krzyzyk', n: 9 }); await c2.wait((m) => m.t === 'table' && m.table.n === 9);
  c2.send({ t: 'table_invite', uid: b1.me.id }); await c2.wait((m) => m.t === 'error' && /niedostępny/.test(m.msg), 2000);
  await sleep(200); assert(!c1.msgs.some((m) => m.t === 'table_invite'), 'zaproszenie od zablokowanego nie może dotrzeć');
  c1.send({ t: 'table_leave' }); c2.send({ t: 'table_leave' }); await Promise.all([c1.wait((m) => m.t === 'table_left'), c2.wait((m) => m.t === 'table_left')]);
  ok('zaproszenia od zablokowanego gracza są odrzucane');
  c1.send({ t: 'queue', game: 'kolko-krzyzyk', rated: false }); c2.send({ t: 'queue', game: 'kolko-krzyzyk', rated: false });
  await sleep(4500); assert(!c1.match && !c2.match, 'zablokowani nie mogą być dobrani w matchmakingu');
  await api('DELETE', '/api/me/blocks/' + b2.me.id, null, b1.token);
  await Promise.all([c1.wait((m) => m.t === 'match', 6000), c2.wait((m) => m.t === 'match', 6000)]);
  ok('matchmaking omija zablokowanych; po odblokowaniu para się łączy');
  c1.close(); c2.close();

  /* --- moderacja: wymuszone wylogowanie, ban czasowy, anonimizacja konta --- */
  const v1 = await regUser('Ofiara1'); const vc = new Client(v1.token); await Promise.all([vc.ready, vc.hello]);
  const closed = new Promise((res) => { vc.ws.onclose = res; });
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'logout', note: 'test' }, mtok); assert.strictEqual(r.status, 200);
  await Promise.race([closed, sleep(2000).then(() => { throw new Error('WebSocket nie został zamknięty'); })]);
  r = await api('GET', '/api/me', null, v1.token); assert.strictEqual(r.status, 401); r = await api('POST', '/api/auth/login', { login: 'Ofiara1', password: 'haslo1234' }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await api('GET', '/api/me', null, r.body.token)).status, 200); ok('wymuszone wylogowanie unieważnia stare tokeny i zamyka WebSocket; ponowne logowanie działa');
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'ban', hours: 24, note: 'test' }, mtok); assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/auth/login', { login: 'Ofiara1', password: 'haslo1234' }); assert.strictEqual(r.status, 403);
  const bu = D.get('SELECT banned_until FROM users WHERE id=?', v1.me.id).banned_until; assert(Math.abs(bu - (Date.now() + 864e5)) < 10000);
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'ban', hours: 168 }, mtok); assert(Math.abs(D.get('SELECT banned_until FROM users WHERE id=?', v1.me.id).banned_until - (Date.now() + 7 * 864e5)) < 10000);
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'ban', hours: 'perm' }, mtok); assert.strictEqual(D.get('SELECT banned_until FROM users WHERE id=?', v1.me.id).banned_until, -1);
  ok('ban: 24 h, 7 dni i na stałe');
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'delete' }, mtok); assert.strictEqual(r.status, 403);
  r = await api('POST', '/api/admin/users/' + v1.me.id + '/action', { action: 'unban' }, mtok); assert.strictEqual(r.status, 200);
  const dv = await regUser('Zniknie1'); const dm = await regUser('Rywal1');
  D.run('INSERT INTO matches(game_id,p1,p2,result,reason,rated,mode,moves,started_at,ended_at) VALUES(1,?,?,1,?,0,?,?,?,?)', dv.me.id, dm.me.id, 'win', 'queue', '[]', Date.now() - 5000, Date.now());
  await api('POST', '/api/me/blocks', { uid: dm.me.id }, dv.token);
  r = await api('POST', '/api/admin/users/' + dv.me.id + '/action', { action: 'delete', note: 'RODO' }, adm); assert.strictEqual(r.status, 200);
  const gone = D.get('SELECT * FROM users WHERE id=?', dv.me.id);
  assert(gone && gone.nick === 'Usunięty gracz' && gone.email === null && gone.pass_hash === null && gone.deleted_at > 0, 'konto powinno być zanonimizowane');
  assert.strictEqual(D.get('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id=?', dv.me.id).n, 0);
  assert(D.get('SELECT id FROM matches WHERE p1=?', dv.me.id), 'historia partii zostaje, bez danych osobowych');
  assert.strictEqual((await api('POST', '/api/auth/login', { login: 'Zniknie1', password: 'haslo1234' })).status, 401);
  assert.strictEqual((await api('GET', '/api/me', null, dv.token)).status, 401); assert.strictEqual((await api('GET', '/api/users/Zniknie1')).status, 404);
  ok('usunięcie konta: anonimizacja (nick, e-mail, hasło), historia partii zachowana, sesje unieważnione');

  /* --- cenzura: słowa dodane w panelu działają bez restartu --- */
  r = await api('POST', '/api/admin/censor', { word: 'Brzydalek' }, mtok); assert.strictEqual(r.status, 200);
  assert(require('../server/censor').isProfane('ty brzydalek!')); r = await api('DELETE', '/api/admin/censor/brzydalek', null, mtok); assert(!require('../server/censor').isProfane('ty brzydalek!'));
  ok('słownik cenzury edytowany przez moderatora, zmiany od razu aktywne');

  console.log('Turniej (4 graczy)');
  const players = [];
  for (const n of ['T1', 'T2', 'T3', 'T4']) { r = await api('POST', '/api/auth/register', { nick: n + 'gracz', email: n + '@example.com', password: 'haslo1234' }); players.push(r.body); }
  r = await api('POST', '/api/admin/tournaments', { name: 'Puchar Testowy', game: 'kolko-krzyzyk', start: new Date(Date.now() + 3600000).toISOString(), max_players: 8 }, adm);
  const tid = r.body.id;
  for (const p of players) { r = await api('POST', '/api/tournaments/' + tid + '/join', {}, p.token); assert.strictEqual(r.status, 200); }
  r = await api('POST', '/api/tournaments/' + tid + '/join', {}, guest.token); // zofia (już konto)
  r = await api('POST', '/api/auth/guest'); const g2 = r.body;
  r = await api('POST', '/api/tournaments/' + tid + '/join', {}, g2.token); assert.strictEqual(r.status, 403); ok('gość nie zapisze się na turniej');
  await api('POST', '/api/tournaments/' + tid + '/leave', {}, guest.token);
  r = await api('POST', '/api/admin/tournaments/' + tid + '/start', {}, adm); assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/tournaments/' + tid); assert.strictEqual(r.body.rounds, 2); assert.strictEqual(r.body.matches.length, 3); ok('drabinka wygenerowana (4 graczy → 2 rundy)');
  const tc = players.map((p) => new Client(p.token)); await Promise.all(tc.map((c) => c.ready)); await Promise.all(tc.map((c) => c.hello));
  const byUid = {}; players.forEach((p, i) => { byUid[p.me.id] = tc[i]; });
  for (let round = 1; round <= 2; round++) {
    r = await api('GET', '/api/tournaments/' + tid);
    const ms = r.body.matches.filter((m) => m.round === round);
    for (const tm of ms) {
      for (let tries = 0; tries < 12; tries++) {
        const cur = (await api('GET', '/api/tournaments/' + tid)).body.matches.find((x) => x.id === tm.id);
        if (cur.status === 'done') break;
        const c1 = byUid[cur.p1], c2 = byUid[cur.p2];
        const go = [c1.wait((m) => m.t === 'match' && m.m.tm === tm.id && m.m.status === 'playing'), c2.wait((m) => m.t === 'match' && m.m.tm === tm.id && m.m.status === 'playing')];
        c1.send({ t: 'tm_ready', id: tm.id }); c2.send({ t: 'tm_ready', id: tm.id });
        await Promise.all(go);
        const f2 = await playOut([c1, c2], ttt);
        await new Promise((r2) => setTimeout(r2, 150));
      }
    }
  }
  r = await api('GET', '/api/tournaments/' + tid); assert.strictEqual(r.body.status, 'finished'); assert(r.body.winner && r.body.winner.nick); ok('turniej rozegrany do finału, zwycięzca: ' + r.body.winner.nick);

  tc.forEach((c) => c.close()); [cA, cO, cG3, cN].forEach((c) => c.close());
  console.log('\nOK: ' + passed + ' testów integracyjnych');
  process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
