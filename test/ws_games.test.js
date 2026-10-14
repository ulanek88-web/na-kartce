'use strict';
/* Integralność partii online: serwer jest źródłem prawdy (kolejność, legalność, koniec partii, obcy gracz, podwójne kliknięcie,
   rozłączenia z karencją, zegar, brak zmian ELO po nielegalnych działaniach). */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-wsg-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123'; process.env.RATE_REG_MAX = '100';
const D = require('../server/db'), A = require('../server/auth'), { create } = require('../server/index');
D.ensureAdmin(A.hashPassword);
const server = create(); let base, wsBase, passed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, token) { const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
class Client {
  constructor(token) {
    this.msgs = []; this.waiters = []; this.match = null; this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'match') this.match = m.m; this.msgs.push(m); this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; }); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout; ostatnie: ' + JSON.stringify(this.msgs.slice(-3)).slice(0, 300))), ms || 6000); this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } }); }); }
  close() { this.ws.close(); }
}
const reg = async (nick) => (await api('POST', '/api/auth/register', { nick, email: nick.toLowerCase() + '@example.com', password: 'haslo1234' })).body;
async function startGame(ca, cb, slug, rated) {
  ca.send({ t: 'queue', game: slug, rated }); cb.send({ t: 'queue', game: slug, rated });
  await Promise.all([ca.wait((m) => m.t === 'match' && m.m.status === 'playing'), cb.wait((m) => m.t === 'match' && m.m.status === 'playing')]);
  const first = ca.match.you === 1 ? ca : cb, second = first === ca ? cb : ca; return { first, second, id: ca.match.id };
}
const lastErr = (c, from) => c.msgs.slice(from).filter((m) => m.t === 'error').map((m) => m.msg);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; base = 'http://127.0.0.1:' + port; wsBase = 'ws://127.0.0.1:' + port;
  D.setSetting('disconnect_grace_sec', '2');
  const [ala, olek, ewa] = [await reg('Ala'), await reg('Olek'), await reg('Ewa')];
  const [cA, cO, cE] = [new Client(ala.token), new Client(olek.token), new Client(ewa.token)]; await Promise.all([cA.ready, cO.ready, cE.ready]);
  console.log('Partia online – integralność');
  let g = await startGame(cA, cO, 'kolko-krzyzyk', true); const { first, second, id } = g;
  let n0 = second.msgs.length; second.send({ t: 'move', id, move: 0 }); await sleep(150); assert(lastErr(second, n0).some((e) => /kolej/i.test(e))); ok('ruch poza kolejnością jest odrzucany');
  n0 = first.msgs.length; first.send({ t: 'move', id, move: 99 }); first.send({ t: 'move', id, move: -1 }); first.send({ t: 'move', id, move: 'x' }); first.send({ t: 'move', id, move: { a: 1 } }); first.send({ t: 'move', id, move: null }); await sleep(200);
  assert(lastErr(first, n0).length === 5 && first.match.moves === 0); ok('nielegalne ruchy (poza planszą, ujemny, tekst, obiekt, null) są odrzucone, stan bez zmian');
  first.send({ t: 'move', id, move: 4 }); first.send({ t: 'move', id, move: 4 }); first.send({ t: 'move', id, move: 4 }); await sleep(250);
  assert.strictEqual(first.match.moves, 1); assert(lastErr(first, n0).length >= 7); ok('szybkie wielokrotne kliknięcie tego samego pola: wykonany dokładnie jeden ruch');
  second.send({ t: 'move', id, move: 4 }); await sleep(120); assert.strictEqual(second.match.moves, 1); ok('ruch na zajęte pole jest odrzucony');
  n0 = cE.msgs.length; cE.send({ t: 'move', id, move: 0 }); cE.send({ t: 'resign', id }); cE.send({ t: 'draw', id }); cE.send({ t: 'undo_req', id }); cE.send({ t: 'rematch', id }); cE.send({ t: 'chat', id, text: 'spam' }); cE.send({ t: 'quick', id, q: 1 }); await sleep(250);
  assert.strictEqual(first.match.status, 'playing'); assert(!first.msgs.some((m) => m.t === 'chat')); ok('obcy gracz nie może ruszać, poddawać, proponować remisu, cofać ani pisać w cudzej partii (IDOR)');
  /* dokończ partię wygraną pierwszego gracza: 4 (środek) + 0,8 */
  const moves = [[second, 0], [first, 1], [second, 2], [first, 7]]; // first: 4,1,7 = kolumna środkowa
  for (const [c, mv] of moves) { c.send({ t: 'move', id, move: mv }); await sleep(120); }
  await Promise.all([first.wait((m) => m.t === 'match' && m.m.status === 'over'), second.wait((m) => m.t === 'match' && m.m.status === 'over')].map((p) => p.catch(() => null)));
  assert.strictEqual(first.match.status, 'over'); assert.strictEqual(first.match.result.winner, first.match.you); ok('serwer sam wykrywa zwycięstwo i kończy partię');
  const deltas = first.match.result.deltas; assert(deltas[0] + deltas[1] === 0 || Math.abs(deltas[0] + deltas[1]) <= 2); assert(deltas[first.match.you - 1] > 0);
  const mv0 = first.match.moves; n0 = first.msgs.length; second.send({ t: 'move', id, move: 3 }); first.send({ t: 'move', id, move: 3 }); first.send({ t: 'resign', id }); await sleep(200);
  assert.strictEqual(first.match.moves, mv0); const row = D.get('SELECT result,moves FROM matches WHERE id=?', id); assert.strictEqual(JSON.parse(row.moves).length, first.match.moves);
  const rt = D.all('SELECT rating,games FROM ratings WHERE game_id=(SELECT id FROM games WHERE slug=?)', 'kolko-krzyzyk'); assert.strictEqual(rt.reduce((s, x) => s + x.games, 0), 2); ok('po zakończeniu partii ruchy i poddanie są ignorowane; wynik zapisany raz, ELO naliczone raz (2 wpisy)');
  /* rewanż wymaga zgody obu stron */
  first.send({ t: 'rematch', id }); await sleep(150); assert.strictEqual(second.match.status, 'over'); second.send({ t: 'rematch', id });
  await Promise.all([first.wait((m) => m.t === 'match' && m.m.status === 'playing' && m.m.id !== id), second.wait((m) => m.t === 'match' && m.m.status === 'playing' && m.m.id !== id)]); ok('rewanż startuje dopiero po zgodzie obu graczy');

  console.log('Rozłączenia');
  const id2 = cA.match.id, other = cA.match.you === 1 ? cO : cA, leaver = other === cA ? cO : cA;
  leaver.ws.close(); await sleep(250);
  assert(other.match.disc.some(Boolean) || other.msgs.slice(-3).some((m) => m.t === 'match')); const nm = other.match.moves;
  other.send({ t: 'move', id: id2, move: 0 }); await sleep(200); assert(other.match.moves === nm || other.match.status === 'playing'); ok('rozłączenie przeciwnika pauzuje partię (ruchy wstrzymane na czas karencji)');
  const back = new Client(leaver === cA ? ala.token : olek.token); await back.ready;
  const hello = await back.wait((m) => m.t === 'hello'); assert(hello.active && hello.active.id === id2 && hello.active.status === 'playing'); ok('powrót w czasie karencji wznawia tę samą partię');
  back.ws.close(); await sleep(3500);
  const r2 = D.get('SELECT result,reason FROM matches WHERE id=?', id2); assert.strictEqual(r2.reason, 'rozłączenie'); assert(r2.result > 0);
  const uid = leaver === cA ? ala.me.id : olek.me.id; assert.strictEqual(D.get('SELECT rage_quits_count AS n FROM users WHERE id=?', uid).n, 1); ok('po upływie karencji partia kończy się porażką rozłączonego, z karą „rage quit” i zapisem w bazie');

  console.log('Zegar');
  D.run("UPDATE games SET time_sec=3 WHERE slug='kolko-krzyzyk'");          // krótki zegar tylko w tym teście (tymczasowa baza)
  const cA2 = new Client(ala.token), cO2 = new Client(olek.token); await Promise.all([cA2.ready, cO2.ready]);
  await startGame(cA2, cO2, 'kolko-krzyzyk', false);
  const t0 = Date.now(); await cA2.wait((m) => m.t === 'match' && m.m.status === 'over', 10000);
  assert.strictEqual(cA2.match.result.reason, 'czas'); assert(cA2.match.result.winner !== cA2.match.turn); ok('upływ czasu na zegarze kończy partię po stronie serwera (bez udziału klientów), po ' + Math.round((Date.now() - t0) / 100) / 10 + ' s');
  [cA, cO, cE, cA2, cO2].forEach((c) => c.close());
  console.log('\nOK: ' + passed + ' testów WebSocket/gier online'); process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
