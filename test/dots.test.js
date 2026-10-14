'use strict';
/* Kropki i Pudełka: reguły silnika (dodatkowy ruch po zamknięciu pudełka), boty, dokładny solver końcówki,
   rejestracja gry w API oraz dodatkowy ruch w partii online (serwer jest źródłem prawdy). */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-dots-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123'; process.env.RATE_REG_MAX = '100';
const E = require('../shared/engines');
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- silnik ---------- */
const eng = E.make('dots', { w: 6, h: 6 });
const HN = 6 * 5;                                   // krawędzie poziome; pionowe zaczynają się od HN
console.log('Silnik');
{
  const s = eng.init();
  assert.strictEqual(eng.boxes, 25); assert.strictEqual(eng.edges, 60); assert.strictEqual(eng.legal(s).length, 60);
  assert.strictEqual(eng.result(s), null); assert.strictEqual(s.t, 1);
  ok('plansza 6×6 kropek: 25 pudełek, 60 krawędzi, gra rusza od gracza 1');
}
{
  // pudełko 0: góra 0, dół 5, lewo HN, prawo HN+1
  let s = eng.init();
  s = eng.play(s, 0); assert.strictEqual(s.t, 2);
  s = eng.play(s, 5); assert.strictEqual(s.t, 1);
  s = eng.play(s, HN); assert.strictEqual(s.t, 2);
  s = eng.play(s, HN + 1);                          // gracz 2 zamyka pudełko
  assert.strictEqual(s.b[0], 2); assert.deepStrictEqual(s.sc, [0, 1]); assert.strictEqual(s.t, 2, 'po zamknięciu pudełka ruch zostaje przy tym samym graczu');
  s = eng.play(s, 1); assert.strictEqual(s.t, 1, 'bez zamknięcia tura przechodzi na rywala');
  ok('zamknięcie pudełka daje punkt i dodatkowy ruch, zwykły ruch oddaje turę');
}
{
  // jedna krawędź zamyka dwa pudełka naraz (wspólna pionowa HN+1 między pudełkami 0 i 1)
  let s = eng.init();
  for (const m of [0, HN, 5, 1, HN + 2, 6]) s = eng.play(s, m);        // wszystko poza wspólną krawędzią
  assert.deepStrictEqual(s.sc, [0, 0]);
  const t = s.t; s = eng.play(s, HN + 1);
  assert.strictEqual(s.sc[t - 1], 2); assert.strictEqual(s.t, t); assert.strictEqual(s.b[0], t); assert.strictEqual(s.b[1], t);
  ok('jedna krawędź może zamknąć dwa pudełka (+2 punkty, ruch zostaje)');
}
{
  // pełne partie losowe: koniec dokładnie po zamknięciu 25 pudełek, brak remisu, spójne punkty
  for (let g = 0; g < 200; g++) {
    let s = eng.init(), plies = 0;
    while (!eng.result(s)) { const L = eng.legal(s); assert(L.length > 0); s = eng.play(s, L[Math.floor(Math.random() * L.length)]); plies++; assert(plies <= 60); }
    const r = eng.result(s);
    assert.strictEqual(s.sc[0] + s.sc[1], 25); assert.strictEqual(plies, 60); assert.strictEqual(eng.legal(s).length, 0);
    assert.strictEqual(r.reason, 'count'); assert(r.winner === 1 || r.winner === 2, 'nieparzysta liczba pudełek = brak remisu');
    assert.strictEqual(r.winner, s.sc[0] > s.sc[1] ? 1 : 2);
    assert.strictEqual(s.b.filter((v) => v === 1).length, s.sc[0]); assert.strictEqual(s.b.filter((v) => v === 2).length, s.sc[1]);
  }
  ok('200 losowych partii: kończą się po 60 ruchach, wynik 25 pudełek, brak remisu, punkty spójne z planszą');
}
{
  const small = E.make('dots', { w: 3, h: 3 });      // 4 pudełka – remis możliwy
  let draws = 0;
  for (let g = 0; g < 400; g++) { let s = small.init(); while (!small.result(s)) { const L = small.legal(s); s = small.play(s, L[Math.floor(Math.random() * L.length)]); } const r = small.result(s); assert.strictEqual(r.winner === 0, s.sc[0] === s.sc[1]); if (r.winner === 0) draws++; }
  assert(draws > 0, 'na planszy 3×3 kropki remis jest możliwy');
  assert.deepStrictEqual(E.cleanParams('dots', { w: 99, h: 1 }), { w: 9, h: 3 }); assert.deepStrictEqual(E.cleanParams('dots', {}), { w: 6, h: 6 });
  ok('plansza o parzystej liczbie pudełek dopuszcza remis; parametry są przycinane do 3–9');
}

console.log('Boty');
{
  for (const level of ['e', 'm', 'h']) {
    let s = eng.init(), guard = 0;
    while (!eng.result(s)) { const mv = eng.ai(s, level); assert(eng.legal(s).includes(mv), 'bot ' + level + ' zwrócił nielegalny ruch ' + mv); s = eng.play(s, mv); assert(++guard <= 60); }
    assert.strictEqual(s.sc[0] + s.sc[1], 25);
  }
  ok('boty łatwy / średni / trudny grają całe partie wyłącznie legalnymi ruchami');
}
{
  // bot zawsze zamyka pudełko, gdy może (średni i trudny); nie oddaje pudełka, gdy ma bezpieczny ruch
  let s = eng.init();
  for (const m of [0, 5, HN]) s = eng.play(s, m);                  // pudełko 0 ma 3 boki, na ruchu gracz 2 (po 3 ruchach: t=2)
  assert.strictEqual(s.t, 2);
  for (let i = 0; i < 30; i++) { assert.strictEqual(eng.ai(s, 'm'), HN + 1); assert.strictEqual(eng.ai(s, 'h'), HN + 1); }
  let s2 = eng.init(); for (const m of [0, 5]) s2 = eng.play(s2, m);   // pudełko 0 ma 2 boki – trzeci bok oddałby je
  for (let i = 0; i < 40; i++) { const mv = eng.ai(s2, 'm'); assert(![HN, HN + 1].includes(mv), 'średni bot nie dorysowuje trzeciego boku, gdy ma bezpieczny ruch'); }
  ok('bot zamyka dostępne pudełko i nie oddaje pudełek, gdy ma bezpieczny ruch');
}
{
  // solver końcówki vs niezależna pełna minimaksowa weryfikacja (plansza 3×4 kropki = 6 pudełek, 17 krawędzi)
  const sm = E.make('dots', { w: 3, h: 4 });
  const memo = new Map();
  const value = (s) => {                                          // (mój − ich) wynik końcowy dla gracza na ruchu
    const key = s.e.join(''); if (memo.has(key)) return memo.get(key);
    let best = -99;
    for (const m of sm.legal(s)) { const n = sm.play(s, m), g = (n.sc[s.t - 1] - s.sc[s.t - 1]); const v = n.t === s.t ? g + value(n) : g - value(n); if (v > best) best = v; }
    if (sm.legal(s).length === 0) best = 0;
    memo.set(key, best); return best;
  };
  const moveValue = (s, m) => { const n = sm.play(s, m), g = n.sc[s.t - 1] - s.sc[s.t - 1]; return n.t === s.t ? g + value(n) : g - value(n); };
  let checked = 0;
  for (let g = 0; g < 25; g++) {
    let s = sm.init();
    while (sm.legal(s).length > 11) { const L = sm.legal(s); s = sm.play(s, L[Math.floor(Math.random() * L.length)]); }
    if (sm.result(s)) continue;
    const best = Math.max(...sm.legal(s).map((m) => moveValue(s, m))), mv = sm.ai(s, 'h');
    assert.strictEqual(moveValue(s, mv), best, 'trudny bot wybrał ruch nieoptymalny w końcówce'); checked++;
  }
  assert(checked >= 15);
  ok('trudny bot gra optymalnie w końcówce (' + checked + ' pozycji sprawdzonych niezależnym minimaksem)');
}
{
  // budżet czasu: pozycja z 16 wolnymi krawędziami na planszy 6×6
  let s = eng.init(); while (eng.legal(s).length > 16) { const L = eng.legal(s); s = eng.play(s, L[Math.floor(Math.random() * L.length)]); }
  const t0 = Date.now(); eng.ai(s, 'h'); const ms = Date.now() - t0;
  assert(ms < 2000, 'solver 16 krawędzi trwał ' + ms + ' ms');
  ok('solver końcówki (16 wolnych krawędzi) mieści się w budżecie: ' + ms + ' ms');
}
{
  // trudny vs łatwy: trudny powinien wyraźnie częściej wygrywać
  let hardWins = 0, games = 24;
  for (let g = 0; g < games; g++) {
    const hardSide = g % 2 ? 2 : 1; let s = eng.init();
    while (!eng.result(s)) s = eng.play(s, eng.ai(s, s.t === hardSide ? 'h' : 'e'));
    if (eng.result(s).winner === hardSide) hardWins++;
  }
  assert(hardWins >= 16, 'trudny wygrał tylko ' + hardWins + '/' + games);
  ok('trudny bot wygrywa z łatwym ' + hardWins + '/' + games + ' partii');
}

/* ---------- API + serwer ---------- */
(async () => {
  const D = require('../server/db'), A = require('../server/auth'), { create } = require('../server/index');
  D.ensureAdmin(A.hashPassword);
  const server = create();
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; const base = 'http://127.0.0.1:' + port, wsBase = 'ws://127.0.0.1:' + port;
  async function api(method, url, body, token) { const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }
  class Client {
    constructor(token) {
      this.msgs = []; this.waiters = []; this.match = null; this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
      this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
      this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'match') this.match = m.m; this.msgs.push(m); this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; }); };
    }
    send(o) { this.ws.send(JSON.stringify(o)); }
    wait(pred, ms) { const f = this.msgs.find(pred); if (f) return Promise.resolve(f); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout; ostatnie: ' + JSON.stringify(this.msgs.slice(-3)).slice(0, 300))), ms || 6000); this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } }); }); }
    close() { this.ws.close(); }
  }
  const reg = async (nick) => (await api('POST', '/api/auth/register', { nick, email: nick.toLowerCase() + '@example.com', password: 'haslo1234' })).body;
  console.log('API i partia online');
  const g = D.get("SELECT * FROM games WHERE slug='kropki-pudelka'");
  assert(g, 'gra jest w bazie'); assert.strictEqual(g.engine, 'dots'); assert.strictEqual(g.status, 'active'); assert.strictEqual(g.bots, 1);
  const list = await api('GET', '/api/games'); assert.strictEqual(list.status, 200);
  const pub = (list.body.games || list.body).find((x) => x.slug === 'kropki-pudelka');
  assert(pub, 'gra jest na liście publicznej'); assert.strictEqual(pub.kind, 'dots'); assert.deepStrictEqual(pub.board, { w: 6, h: 6 });
  ok('gra „Kropki i Pudełka” jest w bazie i na liście publicznej (kind=dots, plansza 6×6)');

  const [ua, ub] = [await reg('Dwa1'), await reg('Dwa2')];
  const [ca, cb] = [new Client(ua.token), new Client(ub.token)]; await Promise.all([ca.ready, cb.ready]);
  ca.send({ t: 'queue', game: 'kropki-pudelka', rated: false }); cb.send({ t: 'queue', game: 'kropki-pudelka', rated: false });
  await Promise.all([ca.wait((m) => m.t === 'match' && m.m.status === 'playing'), cb.wait((m) => m.t === 'match' && m.m.status === 'playing')]);
  const first = ca.match.you === 1 ? ca : cb, second = first === ca ? cb : ca, id = ca.match.id;
  const lastErr = (c, from) => c.msgs.slice(from).filter((m) => m.t === 'error').map((m) => m.msg);
  const turnOf = () => first.match.turn;
  // pudełko 0: gracz 1: 0, gracz 2: 5, gracz 1: HN, gracz 2: HN+1 (zamyka) → dalej gracz 2
  first.send({ t: 'move', id, move: 0 }); await sleep(120);
  second.send({ t: 'move', id, move: 5 }); await sleep(120);
  first.send({ t: 'move', id, move: HN }); await sleep(120);
  second.send({ t: 'move', id, move: HN + 1 }); await sleep(150);
  assert.strictEqual(first.match.state.b[0], 2, 'pudełko 0 należy do gracza 2'); assert.deepStrictEqual(first.match.state.sc, [0, 1]);
  assert.strictEqual(turnOf(), 2, 'po zamknięciu pudełka kolej zostaje przy graczu 2');
  let n0 = first.msgs.length; first.send({ t: 'move', id, move: 1 }); await sleep(150);
  assert(lastErr(first, n0).some((e) => /kolej/i.test(e)), 'gracz 1 nie może ruszyć, gdy gracz 2 ma dodatkowy ruch');
  second.send({ t: 'move', id, move: 1 }); await sleep(150);
  assert.strictEqual(turnOf(), 1, 'po zwykłym ruchu tura przechodzi na gracza 1');
  n0 = first.msgs.length; first.send({ t: 'move', id, move: 0 }); await sleep(150);   // krawędź zajęta
  assert(lastErr(first, n0).length > 0, 'ruch na zajętą krawędź jest odrzucony');
  assert.strictEqual(D.get('SELECT result FROM matches WHERE id=?', id).result, null);
  ok('serwer egzekwuje dodatkowy ruch po zamknięciu pudełka i odrzuca ruch poza kolejnością oraz na zajętą krawędź');
  ca.close(); cb.close();

  console.log('\nOK: ' + passed + ' testów Kropek i Pudełek'); process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
