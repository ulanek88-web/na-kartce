'use strict';
/* Obustronne rozłączenie graczy: gdy obaj są poza serwerem po upływie karencji, partia kończy się bez rozstrzygnięcia
   (bez zwycięzcy, kary za ucieczkę, zmian ELO i XP). Gdy jeden gracz jest połączony – działanie jak dotąd (walkower + kara).
   Turnieje: zachowanie NIEZMIENIONE (decyzja otwarta) – test przypina stan obecny, patrz ostatnia sekcja. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-disc2-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123'; process.env.RATE_REG_MAX = '200';
const D = require('../server/db'), A = require('../server/auth'), RT = require('../server/realtime'), { create } = require('../server/index');
D.ensureAdmin(A.hashPassword);
const server = create(); let base, wsBase, passed = 0, seq = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, token) { const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }
class Client {
  constructor(token) {
    this.msgs = []; this.waiters = []; this.match = null; this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'match') this.match = m.m; this.msgs.push(m); this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; }); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms) { const f = this.msgs.find(pred); if (f) return Promise.resolve(f); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout; ostatnie: ' + JSON.stringify(this.msgs.slice(-3)).slice(0, 300))), ms || 8000); this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } }); }); }
  close() { this.ws.close(); }
}
const reg = async (nick) => (await api('POST', '/api/auth/register', { nick: nick + (++seq), email: nick.toLowerCase() + seq + '@example.com', password: 'haslo1234' })).body;
const GRACE = 2;                       // s – karencja w testach
const SLUG = 'kolko-krzyzyk';
const gid = () => D.get('SELECT id FROM games WHERE slug=?', SLUG).id;
const userRow = (id) => D.get('SELECT xp,rage_quits_count AS rage FROM users WHERE id=?', id);
const ratingRow = (id) => D.get('SELECT rating,games,wins,losses,draws FROM ratings WHERE user_id=? AND game_id=?', id, gid());
const eventsN = (id) => D.get('SELECT COUNT(*) AS n FROM events WHERE user_id=?', id).n;

/* dwóch nowych graczy w partii z kolejki; zwraca klientów, tokeny i id partii */
async function pair(rated) {
  const [ua, ub] = [await reg('Dwa'), await reg('Dwa')];
  const [ca, cb] = [new Client(ua.token), new Client(ub.token)]; await Promise.all([ca.ready, cb.ready]);
  ca.send({ t: 'queue', game: SLUG, rated }); cb.send({ t: 'queue', game: SLUG, rated });
  await Promise.all([ca.wait((m) => m.t === 'match' && m.m.status === 'playing'), cb.wait((m) => m.t === 'match' && m.m.status === 'playing')]);
  const id = ca.match.id; assert.strictEqual(ca.match.rated, !!rated);
  return { ua, ub, ca, cb, id, ida: ua.me.id, idb: ub.me.id, before: { a: [userRow(ua.me.id), ratingRow(ua.me.id)], b: [userRow(ub.me.id), ratingRow(ub.me.id)] } };
}
const matchRow = (id) => D.get('SELECT result,reason,rated,d1,d2,r1,r2,ended_at,p1,p2 FROM matches WHERE id=?', id);

/* Wspólne asercje „zakończenie neutralne” */
function assertNeutral(p, label) {
  const r = matchRow(p.id);
  assert.strictEqual(r.result, 0, label + ': wynik 0 (bez zwycięzcy)');
  assert.strictEqual(r.reason, 'obustronne rozłączenie', label + ': powód');
  assert.strictEqual(r.rated, 0, label + ': matches.rated=0');
  assert.strictEqual(r.d1, 0); assert.strictEqual(r.d2, 0); assert.strictEqual(r.r1, null); assert.strictEqual(r.r2, null);
  assert(r.ended_at != null, label + ': ended_at ustawione');
  for (const [uid, i] of [[p.ida, 'a'], [p.idb, 'b']]) {
    const u = userRow(uid), rt = ratingRow(uid), [u0, rt0] = p.before[i];
    assert.strictEqual(u.rage, u0.rage, label + ': brak kary za ucieczkę'); assert.strictEqual(u.xp, u0.xp, label + ': brak XP');
    assert.strictEqual(eventsN(uid), 0, label + ': brak zdarzeń rankingowych');
    assert.strictEqual(rt ? rt.rating : null, rt0 ? rt0.rating : null, label + ': ELO bez zmian');
    assert.strictEqual(rt ? rt.games : 0, rt0 ? rt0.games : 0, label + ': licznik gier rankingowych bez zmian');
  }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; base = 'http://127.0.0.1:' + port; wsBase = 'ws://127.0.0.1:' + port;
  D.setSetting('disconnect_grace_sec', String(GRACE));
  const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); origErr(...a); };

  console.log('1–2. Obaj gracze offline (ranking / nieranking)');
  for (const rated of [true, false]) {
    const p = await pair(rated);
    p.ca.close(); await sleep(60); p.cb.close();
    await sleep((GRACE + 0.9) * 1000);
    assertNeutral(p, rated ? 'rankingowa' : 'nierankingowa');
    assert.strictEqual(RT.activeFor(p.ida), null); assert.strictEqual(RT.activeFor(p.idb), null);
    ok((rated ? 'rankingowa' : 'nierankingowa') + ': wynik 0 „obustronne rozłączenie”, matches.rated=0, bez kary, ELO i XP');
    // historia: API zwraca partię jako remis, bez rankingu
    const h = await api('GET', '/api/matches/' + p.id); assert.strictEqual(h.status, 200); assert.strictEqual(h.body.result, 0); assert.strictEqual(h.body.reason, 'obustronne rozłączenie');
    ok((rated ? 'rankingowa' : 'nierankingowa') + ': historia (API) spójna z zapisem w bazie');
    // gracze nie są uwięzieni w partii
    const cn = new Client(p.ua.token), cm = new Client(p.ub.token); await Promise.all([cn.ready, cm.ready]);
    const hello = await cn.wait((m) => m.t === 'hello'); assert.strictEqual(hello.active, null);
    cn.close(); cm.close();
  }

  console.log('3. Jeden gracz wraca przed limitem, drugi nie wraca');
  {
    const p = await pair(true);
    p.ca.close(); await sleep(60); p.cb.close();
    await sleep(900);
    const back = new Client(p.ua.token); await back.ready;
    const hello = await back.wait((m) => m.t === 'hello'); assert(hello.active && hello.active.id === p.id && hello.active.status === 'playing');
    const over = await back.wait((m) => m.t === 'match' && m.m.status === 'over', (GRACE + 3) * 1000);
    assert.strictEqual(over.m.result.reason, 'rozłączenie'); assert.strictEqual(over.m.result.rage, over.m.you === 1 ? 2 : 1); assert.strictEqual(over.m.result.winner, over.m.you);
    const r = matchRow(p.id); assert.strictEqual(r.rated, 1); assert.strictEqual(r.reason, 'rozłączenie');
    const loser = p.idb, winner = p.ida;                       // wraca A (połączony), B pozostaje poza serwerem
    assert.strictEqual(userRow(loser).rage, p.before[loser === p.ida ? 'a' : 'b'][0].rage + 1); assert.strictEqual(userRow(winner).rage, p.before[winner === p.ida ? 'a' : 'b'][0].rage);
    assert(over.m.result.deltas[(over.m.you === 1 ? 2 : 1) - 1] <= -30); assert(over.m.result.deltas[over.m.you - 1] > 0);
    ok('wracający wygrywa walkowerem; nieobecny dostaje porażkę, +1 do licznika ucieczek i karę ELO (partia nadal rankingowa)');
    back.close();
  }
  {
    // rywal wypadł później niż uciekinier i wrócił po upływie limitu pierwszego, ale przed końcem własnej karencji → uciekinierem jest ten, kto przekroczył limit
    const p = await pair(true);
    p.ca.close(); await sleep(1000); p.cb.close();                   // A: t0, B: t0+1 s
    await sleep(1500);                                              // t0+2,5 s: limit A (2 s) minął, limit B (3 s) jeszcze nie
    assert.strictEqual(matchRow(p.id).ended_at, null);              // partia trwa – nie kończy się neutralnie przed końcem karencji B
    const back = new Client(p.ub.token); await back.ready;
    const over = await back.wait((m) => m.t === 'match' && m.m.status === 'over', (GRACE + 3) * 1000);
    assert.strictEqual(over.m.result.reason, 'rozłączenie'); assert.strictEqual(over.m.result.winner, over.m.you);
    assert.strictEqual(userRow(p.ida).rage, p.before.a[0].rage + 1); assert.strictEqual(userRow(p.idb).rage, p.before.b[0].rage);
    ok('A wypadł pierwszy, B wrócił po limicie A, ale przed własnym: wygrywa B, A dostaje karę (karencja B nie została skrócona)');
    back.close();
  }

  console.log('4–5. Brak podwójnego zakończenia i niepożądanych zmian');
  {
    const p = await pair(true); const before = errs.length;
    p.ca.close(); p.cb.close();                                      // niemal jednocześnie
    await sleep((GRACE + 0.9) * 1000);
    const r1 = matchRow(p.id); assertNeutral(p, 'jednoczesne');
    await sleep((GRACE + 1.5) * 1000);                               // dłużej niż drugi timer
    const r2 = matchRow(p.id); assert.deepStrictEqual(r2, r1); assertNeutral(p, 'po dodatkowym czekaniu');
    assert.strictEqual(D.get('SELECT COUNT(*) AS n FROM matches WHERE id=?', p.id).n, 1);
    assert.strictEqual(errs.length, before, 'brak błędów w logu: ' + errs.slice(before).join(' | '));
    ok('niemal jednoczesne rozłączenie: jedno zakończenie, rekord niezmieniony po upływie obu timerów, brak błędów');
  }

  console.log('7. Turnieje (stan obecny, bez zmian – decyzja otwarta)');
  {
    let r = await api('POST', '/api/auth/login', { login: 'admin', password: 'AdminTest123' }); const adm = r.body.token;
    const pls = []; for (let i = 0; i < 4; i++) pls.push(await reg('Tur'));
    r = await api('POST', '/api/admin/tournaments', { name: 'Puchar rozłączeń', game: SLUG, start: new Date(Date.now() + 3600000).toISOString(), max_players: 8 }, adm); const tid = r.body.id;
    for (const pl of pls) { r = await api('POST', '/api/tournaments/' + tid + '/join', {}, pl.token); assert.strictEqual(r.status, 200); }
    r = await api('POST', '/api/admin/tournaments/' + tid + '/start', {}, adm); assert.strictEqual(r.status, 200);
    r = await api('GET', '/api/tournaments/' + tid); const tm = r.body.matches.find((x) => x.round === 1 && x.status === 'ready');
    const byUid = {}; pls.forEach((pl) => { byUid[pl.me.id] = new Client(pl.token); });
    const c1 = byUid[tm.p1], c2 = byUid[tm.p2]; await Promise.all([c1.ready, c2.ready]);
    const go = [c1.wait((m) => m.t === 'match' && m.m.tm === tm.id && m.m.status === 'playing'), c2.wait((m) => m.t === 'match' && m.m.tm === tm.id && m.m.status === 'playing')];
    c1.send({ t: 'tm_ready', id: tm.id }); c2.send({ t: 'tm_ready', id: tm.id }); await Promise.all(go);
    const mid = c1.match.id;
    c1.close(); await sleep(60); c2.close();
    await sleep((GRACE + 0.9) * 1000);
    const row = matchRow(mid);
    assert.notStrictEqual(row.reason, 'obustronne rozłączenie', 'turniej: zakończenie neutralne NIE jest stosowane do czasu decyzji');
    assert.strictEqual(row.reason, 'rozłączenie'); assert(row.result === 1 || row.result === 2);
    r = await api('GET', '/api/tournaments/' + tid); const after = r.body.matches.find((x) => x.id === tm.id);
    assert.strictEqual(after.status, 'done'); assert(after.winner);
    ok('mecz turniejowy: obustronne rozłączenie rozstrzyga się jak dotąd (decyzja o regule turniejowej odroczona; ten test trzeba zaktualizować po decyzji)');
  }

  console.error = origErr;
  console.log('\nOK: ' + passed + ' testów obustronnego rozłączenia'); process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
