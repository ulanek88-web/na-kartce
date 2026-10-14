'use strict';
/* Wyścig Wektorowy: tor, rozbicia (utrata 3 kolejek), linie kontrolne i kierunek, meta z wyrównaniem rund, wypadnięcie (DNF),
   limit ruchów, boty, rejestracja gry w API oraz egzekwowanie kolejek przez serwer. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-race-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123'; process.env.RATE_REG_MAX = '100';
const E = require('../shared/engines');
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

const eng = E.make('race', { laps: 1 }), T = eng._t, W = eng.w, H = eng.h;
/* stan z ręcznie ustawionymi samochodami */
const mk = (o) => { const s = clone(eng.init()); for (const k of Object.keys(o)) s[k] = clone(o[k]); return s; };

console.log('Tor i reguły');
{
  const road = eng.road, cells = road.reduce((a, b) => a + b, 0);
  const seen = new Set([15 + 15 * W]), q = [15 + 15 * W];
  for (let h = 0; h < q.length; h++) { const x = q[h] % W, y = (q[h] / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = (y + dy) * W + x + dx; if ((dx || dy) && T.isRoad(x + dx, y + dy) && !seen.has(i)) { seen.add(i); q.push(i); } } }
  assert.strictEqual(seen.size, cells, 'cały tor jest spójny');
  const s = eng.init(); assert(T.isRoad(...s.p[0]) && T.isRoad(...s.p[1]), 'pola startowe leżą na torze');
  for (const d of T.getFields()) assert(road.every((r, i) => !r || d[i] >= 0), 'pole odległości obejmuje cały tor');
  for (const k of eng.checkpoints) {                               // każda linia kontrolna przecina drogę na całej szerokości
    let n = 0; for (let t = Math.ceil(k.lo); t <= Math.floor(k.hi); t++) { const x = k.ax === 'x' ? Math.floor(k.v) : t, y = k.ax === 'x' ? t : Math.floor(k.v); if (T.isRoad(x, y)) n++; }
    assert(n >= 4, 'linia kontrolna przecina ≥ 4 pola toru');
  }
  assert.strictEqual(s.t, 1); assert.strictEqual(eng.result(s), null); assert.strictEqual(eng.legal(s).length, 9);
  ok('tor jest spójny (' + cells + ' pól), pola startowe i linie kontrolne poprawne, pola odległości kompletne');
}
{
  const s = mk({ v: [[4, 0], [0, 0]] });
  const L = eng.legal(s); assert.deepStrictEqual(L, [0, 1, 3, 4, 6, 7]);      // ax=+1 (m=2,5,8) przekroczyłoby limit prędkości 4
  assert.deepStrictEqual(eng.legal(mk({ end: { winner: 1, reason: 'finish' } })), []);
  ok('limit prędkości ±4 na oś odcina niedozwolone przyspieszenia; po zakończeniu brak ruchów');
}
{
  // kierunek linii kontrolnej: meta liczy się tylko przy przejeździe w prawo, w zakresie toru
  assert.strictEqual(T.crosses(14, 16, 15, 16, 0), true);
  assert.strictEqual(T.crosses(15, 16, 13, 16, 0), false, 'jazda pod prąd nie liczy się');
  assert.strictEqual(T.crosses(14, 10, 15, 10, 0), false, 'poza zakresem linii');
  assert.strictEqual(T.crosses(26, 10, 26, 8, 1), true); assert.strictEqual(T.crosses(26, 8, 26, 10, 1), false);
  assert.strictEqual(T.crosses(16, 3, 12, 3, 2), true); assert.strictEqual(T.crosses(12, 3, 16, 3, 2), false);
  assert.strictEqual(T.crosses(3, 8, 3, 11, 3), true); assert.strictEqual(T.crosses(3, 11, 3, 8, 3), false);
  ok('linie kontrolne liczą tylko przejazd we właściwym kierunku (meta, prawa, górna, lewa)');
}
{
  // rozbicie: ruch poza tor = stoisz w miejscu z prędkością 0 i tracisz 3 kolejki (rywal rusza 4 razy z rzędu)
  let s = eng.init();
  s = eng.play(s, 1); assert.deepStrictEqual(s.p[0], [15, 14]); assert.strictEqual(s.t, 2);
  s = eng.play(s, 4); assert.strictEqual(s.t, 1);
  s = eng.play(s, 1);                                              // (15,14) → (15,12): przejazd przez trawę
  assert.strictEqual(s.cr[0], 1); assert.deepStrictEqual(s.p[0], [15, 14]); assert.deepStrictEqual(s.v[0], [0, 0]); assert.strictEqual(s.sk[0], 3);
  assert.deepStrictEqual(s.bk[0], [[15, 12]]); assert.strictEqual(s.t, 2);
  const turns = [];
  for (let i = 0; i < 4; i++) { s = eng.play(s, 4); turns.push(s.t); }
  assert.deepStrictEqual(turns, [2, 2, 2, 1], 'rywal ma 4 ruchy z rzędu, potem wraca gracz 1'); assert.strictEqual(s.sk[0], 0);
  ok('rozbicie: pozycja bez zmian, prędkość 0, zapis rozbicia, rywal wykonuje 4 ruchy z rzędu (utrata 3 kolejek)');
}
{
  // meta i wyrównanie rund (1 okrążenie): c=3 → następna linia to meta
  const fin = { p: [[13, 16], [15, 16]], v: [[2, 0], [0, 0]], c: [3, 0] };
  let s = eng.play(mk(fin), 4);                                    // gracz 1 przejeżdża metę
  assert.strictEqual(s.fin[0], 1); assert.strictEqual(s.end, null, 'rywal ma jeszcze swoją kolejkę'); assert.strictEqual(s.t, 2);
  let r = eng.play(s, 4); assert.deepStrictEqual(eng.result(r), { winner: 1, reason: 'finish', score: [1, 0] });
  // obaj kończą w tej samej rundzie = remis
  s = eng.play(mk({ p: [[13, 16], [13, 15]], v: [[2, 0], [2, 0]], c: [3, 3] }), 4); r = eng.play(s, 4);
  assert.strictEqual(eng.result(r).winner, 0); assert.strictEqual(eng.result(r).reason, 'draw');
  // rywal kończy, a gracz 1 nie → wygrywa gracz 2
  s = eng.play(mk({ p: [[15, 15], [13, 15]], v: [[0, 0], [2, 0]], c: [0, 3] }), 4); r = eng.play(s, 4);
  assert.deepStrictEqual(eng.result(r).winner, 2);
  // gracz 2 ma zmarnowaną kolejkę po rozbiciu: runda kończy się od razu, wygrywa gracz 1
  s = eng.play(mk({ p: [[13, 16], [15, 16]], v: [[2, 0], [0, 0]], c: [3, 0], sk: [0, 2] }), 4);
  assert.strictEqual(eng.result(s).winner, 1); assert.strictEqual(eng.result(s).reason, 'finish');
  ok('meta: rywal dokańcza rundę (remis przy równym czasie), zmarnowana kolejka nie daje dodatkowego ruchu');
}
{
  // czwarte rozbicie = wypadnięcie z wyścigu
  const s = eng.play(mk({ p: [[15, 14], [15, 16]], v: [[0, -1], [0, 0]], cr: [3, 0] }), 1);
  assert.strictEqual(s.cr[0], 4); assert.deepStrictEqual(eng.result(s), { winner: 2, reason: 'dnf', score: [0, 0] });
  // limit ruchów rozstrzyga postępem; równy postęp = remis
  assert.deepStrictEqual(eng.result(mk({ n: 300, c: [1, 0] })), { winner: 1, reason: 'limit', score: [0, 0] });
  assert.strictEqual(eng.result(mk({ n: 300, p: [[15, 15], [15, 15]] })).winner, 0);
  assert.strictEqual(eng.result(mk({ n: 299 })), null);
  ok('4. rozbicie wyklucza z wyścigu; po 300 ruchach decyduje postęp (równy = remis)');
}
{
  // play nie modyfikuje wejścia i stan jest czystym JSON-em
  const s = mk({}), before = JSON.stringify(s); eng.play(s, 5);
  assert.strictEqual(JSON.stringify(s), before);
  let a = eng.init(), b = clone(a); for (const m of [5, 4, 5, 2, 1]) { a = eng.play(a, m); b = eng.play(clone(b), m); }
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(E.cleanParams('race', { laps: 9 }), { laps: 2 }); assert.deepStrictEqual(E.cleanParams('race', { laps: '3' }), { laps: 3 });
  ok('play jest czysty i deterministyczny, parametry okrążeń są walidowane');
}

console.log('Boty');
{
  let maxMs = 0;
  for (const laps of [1, 2]) for (const lv of ['e', 'm', 'h']) {
    const e2 = E.make('race', { laps }); let s = e2.init();
    while (!e2.result(s)) { const t0 = Date.now(); const mv = e2.ai(s, lv); maxMs = Math.max(maxMs, Date.now() - t0); assert(e2.legal(s).includes(mv), 'bot ' + lv + ' zagrał nielegalnie'); s = e2.play(s, mv); assert(s.n <= 300); }
    assert(e2.result(s).reason !== 'limit', 'bot ' + lv + ' ukończył wyścig (' + laps + ' okr.)');
  }
  assert(maxMs < 1000, 'ruch bota trwał ' + maxMs + ' ms');
  ok('boty łatwy/średni/trudny kończą wyścig (1 i 2 okrążenia) legalnymi ruchami; najdłuższy ruch ' + maxMs + ' ms');
}
{
  let hw = 0, mw = 0, N = 16;
  for (let g = 0; g < N; g++) {
    for (const [lv, ctr] of [['h', 'hw'], ['m', 'mw']]) {
      const side = g % 2 ? 2 : 1; let s = eng.init();
      while (!eng.result(s)) s = eng.play(s, eng.ai(s, s.t === side ? lv : 'e'));
      if (eng.result(s).winner === side) { if (ctr === 'hw') hw++; else mw++; }
    }
  }
  assert(hw >= 14, 'trudny wygrał z łatwym tylko ' + hw + '/' + N); assert(mw >= 12, 'średni wygrał z łatwym tylko ' + mw + '/' + N);
  ok('trudny wygrywa z łatwym ' + hw + '/' + N + ', średni ' + mw + '/' + N);
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
  const g = D.get("SELECT * FROM games WHERE slug='wyscig-wektorowy'");
  assert(g, 'gra jest w bazie'); assert.strictEqual(g.engine, 'race'); assert.strictEqual(g.status, 'active'); assert.strictEqual(g.bots, 1);
  const list = await api('GET', '/api/games'); assert.strictEqual(list.status, 200);
  const pub = (list.body.games || list.body).find((x) => x.slug === 'wyscig-wektorowy');
  assert(pub); assert.strictEqual(pub.kind, 'race'); assert.deepStrictEqual(pub.board, { w: 30, h: 20, lp: 2 });
  ok('gra „Wyścig Wektorowy” jest w bazie i na liście publicznej (kind=race, tor 30×20, 2 okrążenia)');

  const [ua, ub] = [await reg('Wys1'), await reg('Wys2')];
  const [ca, cb] = [new Client(ua.token), new Client(ub.token)]; await Promise.all([ca.ready, cb.ready]);
  ca.send({ t: 'queue', game: 'wyscig-wektorowy', rated: false }); cb.send({ t: 'queue', game: 'wyscig-wektorowy', rated: false });
  await Promise.all([ca.wait((m) => m.t === 'match' && m.m.status === 'playing'), cb.wait((m) => m.t === 'match' && m.m.status === 'playing')]);
  const first = ca.match.you === 1 ? ca : cb, second = first === ca ? cb : ca, id = ca.match.id;
  const lastErr = (c, from) => c.msgs.slice(from).filter((m) => m.t === 'error').map((m) => m.msg);
  const mv = async (c, move) => { c.send({ t: 'move', id, move }); await sleep(130); };
  await mv(first, 1); await mv(second, 4); await mv(first, 1);                  // gracz 1 rozbija się (przejazd przez trawę)
  assert.strictEqual(first.match.state.cr[0], 1); assert.strictEqual(first.match.state.sk[0], 3); assert.strictEqual(first.match.turn, 2);
  let n0 = first.msgs.length; await mv(first, 4);
  assert(lastErr(first, n0).some((e) => /kolej/i.test(e)), 'rozbity gracz nie może ruszyć, dopóki jego kolejki są zmarnowane');
  const turns = [];
  for (let i = 0; i < 4; i++) { await mv(second, 4); turns.push(first.match.turn); }
  assert.deepStrictEqual(turns, [2, 2, 2, 1], 'serwer daje rywalowi 4 ruchy z rzędu po rozbiciu');
  n0 = first.msgs.length; await mv(first, 9); await mv(first, -1);
  assert(lastErr(first, n0).length >= 2, 'ruchy spoza 0..8 są odrzucane');
  assert.strictEqual(D.get('SELECT result FROM matches WHERE id=?', id).result, null);
  ok('serwer egzekwuje utratę kolejek po rozbiciu (rywal 4 ruchy z rzędu), odrzuca ruch poza kolejnością i spoza 0..8');
  ca.close(); cb.close();

  console.log('\nOK: ' + passed + ' testów Wyścigu Wektorowego'); process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
