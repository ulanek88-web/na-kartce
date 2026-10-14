'use strict';
const assert = require('assert');
const E = require('../shared/engines');
let ok = 0;
const t = (name, fn) => { const t0 = Date.now(); fn(); ok++; console.log('  ✓', name, '(' + (Date.now() - t0) + ' ms)'); };

/* ---------- szachy: perft ---------- */
function fromFEN(fen) {
  const [pos, turn, cas, ep] = fen.split(' ');
  const b = [];
  for (const ch of pos) { if (ch === '/') continue; if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) b.push(''); else b.push(ch); }
  const s = { b, t: turn === 'w' ? 1 : 2, cas: cas === '-' ? '' : cas, ep: ep === '-' ? -1 : (8 - +ep[1]) * 8 + (ep.charCodeAt(0) - 97), hm: 0, fm: 1, last: null, n: 0, reps: {} };
  return s;
}
const chess = E.make('chess');
function perft(s, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of chess.legal(s)) n += perft(chess.play(s, m, { search: true }), d - 1);
  return n;
}
console.log('Szachy');
t('perft start d=3 = 8902', () => assert.strictEqual(perft(chess.init(), 3), 8902));
t('perft start d=4 = 197281', () => assert.strictEqual(perft(chess.init(), 4), 197281));
const kiwi = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -';
t('perft Kiwipete d=2 = 2039', () => assert.strictEqual(perft(fromFEN(kiwi), 2), 2039));
t('perft Kiwipete d=3 = 97862', () => assert.strictEqual(perft(fromFEN(kiwi), 3), 97862));
t('perft pozycja 3 d=4 = 43238', () => assert.strictEqual(perft(fromFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -'), 4), 43238));
t('perft pozycja 4 d=3 = 9467', () => assert.strictEqual(perft(fromFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -'), 3), 9467));
t('mat Szewca', () => {
  let s = chess.init();
  const mv = (f, to, promo) => { const m = chess.legal(s).find((x) => x.from === f && x.to === to && (!promo || x.promo === promo)); assert(m, 'brak ruchu ' + f + '-' + to); s = chess.play(s, m); };
  const sq = (a) => (8 - +a[1]) * 8 + (a.charCodeAt(0) - 97);
  mv(sq('e2'), sq('e4')); mv(sq('e7'), sq('e5')); mv(sq('f1'), sq('c4')); mv(sq('b8'), sq('c6')); mv(sq('d1'), sq('h5')); mv(sq('g8'), sq('f6')); mv(sq('h5'), sq('f7'));
  const r = chess.result(s); assert(r && r.winner === 1 && r.reason === 'mat');
});
t('pat i brak materiału', () => {
  const s = fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - -'); s.reps = {};
  const r = chess.result(s); assert(r && r.winner === 0 && r.reason === 'pat');
  assert.strictEqual(chess.result(fromFEN('8/8/8/4k3/8/3K4/8/8 w - -')).reason, 'za mało materiału');
});
t('bot szachowy daje legalny ruch (3 poziomy)', () => {
  for (const lv of ['e', 'm', 'h']) { const s = chess.init(); const m = chess.ai(s, lv); assert(chess.legal(s).some((x) => chess.mkey(x) === chess.mkey(m))); }
});
t('bot widzi mata w jednym ruchu', () => {
  const s = fromFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - -');
  const m = chess.ai(s, 'h'); const r = chess.result(chess.play(s, m)); assert(r && r.winner === 1);
});

/* ---------- warcaby ---------- */
console.log('Warcaby');
const ck = E.make('checkers', { n: 10 });
t('start: 20 pionów na stronę, 9 ruchów otwarcia dla białych', () => {
  const s = ck.init(); assert.strictEqual(s.b.filter((v) => v === 1).length, 20); assert.strictEqual(s.b.filter((v) => v === 2).length, 20);
  assert.strictEqual(ck.legal(s).length, 9);
});
const custom = (cells, t) => { const s = ck.init(); s.b = new Array(100).fill(0); for (const [i, v] of Object.entries(cells)) s.b[i] = v; s.t = t || 1; return s; };
t('bicie wstecz pionem i obowiązek bicia', () => {
  const s = custom({ 55: 1, 46: 2, 24: 2 }, 1); // 55=(5,5)
  const L = ck.legal(s); assert(L.length >= 1 && L.every((m) => m.c.length >= 1));
});
t('zasada największego bicia', () => {
  // biały pion może zbić 1 lub 2 — dozwolone tylko bicie dwóch
  const s = custom({ 87: 1, 76: 2, 54: 2, 65: 2 }, 1);
  const L = ck.legal(s); const mx = Math.max(...L.map((m) => m.c.length)); assert(L.every((m) => m.c.length === mx));
});
t('damka latająca bije z dystansu i może lądować za pionem', () => {
  const s = custom({ 90: 3, 63: 2 }, 1); // damka na (0,9), czarny pion na (3,6)
  const L = ck.legal(s); assert(L.length >= 1 && L.every((m) => m.c.includes(63)));
  assert(L.some((m) => m.p[m.p.length - 1] === 36) || L.length >= 2);
});
t('promocja tylko po zakończeniu ruchu na ostatnim rzędzie', () => {
  const s = custom({ 11: 1, 40: 2 }, 1); // biały pion (1,1) idzie na (0,0) lub (2,0)
  const m = ck.legal(s).find((x) => x.p[1] === 0 || x.p[1] === 2); assert(m);
  assert.strictEqual(ck.play(s, m).b[m.p[1]], 3);
});
t('brak ruchów = porażka', () => {
  const s = custom({ 0: 2 }, 1); assert.strictEqual(ck.result(s).winner, 2);
});
t('bot warcabowy: legalne ruchy i pełna partia bez wyjątków', () => {
  let s = ck.init(), i = 0;
  while (!ck.result(s) && i < 300) { const lv = s.t === 1 ? 'm' : 'e'; const m = ck.ai(s, lv); assert(ck.legal(s).some((x) => ck.mkey(x) === ck.mkey(m))); s = ck.play(s, m); i++; }
  assert(i > 10);
});
t('losowe partie warcabowe kończą się legalnie', () => {
  for (let g = 0; g < 20; g++) { let s = ck.init(), i = 0; while (!ck.result(s) && i < 400) { const L = ck.legal(s); s = ck.play(s, L[Math.floor(Math.random() * L.length)]); i++; } }
});

/* ---------- mnk ---------- */
console.log('Siatka mnk');
const ttt = E.make('mnk', { w: 3, h: 3, k: 3 }), gom = E.make('mnk', { w: 15, h: 15, k: 5 }), c4 = E.make('mnk', { w: 7, h: 6, k: 4, gravity: true });
const play = (E_, s, moves) => { for (const m of moves) s = E_.play(s, m); return s; };
t('kółko i krzyżyk: wygrana i remis', () => {
  assert.strictEqual(ttt.result(play(ttt, ttt.init(), [0, 3, 1, 4, 2])).winner, 1);
  assert.strictEqual(ttt.result(play(ttt, ttt.init(), [0, 1, 2, 4, 3, 5, 7, 6, 8])).winner, 0);
});
t('kółko i krzyżyk: bot trudny nie przegrywa z losowym', () => {
  for (let g = 0; g < 30; g++) { let s = ttt.init(); while (!ttt.result(s)) s = ttt.play(s, s.t === 2 ? ttt.ai(s, 'h') : (() => { const L = ttt.legal(s); return L[Math.floor(Math.random() * L.length)]; })()); assert.notStrictEqual(ttt.result(s).winner, 1); }
});
t('gomoku: pięć w linii wygrywa', () => assert.strictEqual(gom.result(play(gom, gom.init(), [0, 15, 1, 16, 2, 17, 3, 18, 4])).winner, 1));
t('czwórki: grawitacja, wygrana pionowa', () => {
  const s = play(c4, c4.init(), [0, 1, 0, 1, 0, 1, 0]);
  assert.strictEqual(c4.result(s).winner, 1); assert.strictEqual(s.b[35], 1);
});
t('czwórki: bot blokuje oczywistą wygraną', () => {
  const s = play(c4, c4.init(), [0, 6, 0, 6, 0]); // gracz 1 ma 3 w kolumnie 0; teraz ruch 2
  assert.strictEqual(c4.ai(s, 'h'), 0);
});
t('gomoku: bot dokończy 4 w linii', () => {
  let s = gom.init(); s = play(gom, s, [112, 0, 113, 2, 114, 4, 115]); // białe rozrzucone
  s.t = 1; assert([111, 116].includes(gom.ai(s, 'm')));
});
t('boty mnk dają legalne ruchy na wszystkich poziomach', () => {
  for (const e of [ttt, gom, c4]) for (const lv of ['e', 'm', 'h']) { let s = e.init(); for (let i = 0; i < 6; i++) { const m = e.ai(s, lv); assert(e.legal(s).includes(m)); s = e.play(s, m); } }
});

/* ---------- reversi ---------- */
console.log('Reversi');
const rv = E.make('reversi');
t('start: 4 ruchy, partie boty kończą się', () => {
  assert.strictEqual(rv.legal(rv.init()).length, 4);
  for (const [a, b] of [['e', 'e'], ['m', 'h'], ['h', 'm']]) { let s = rv.init(), i = 0; while (!rv.result(s) && i < 200) { const m = rv.ai(s, s.t === 1 ? a : b); assert(rv.legal(s).includes(m)); s = rv.play(s, m); i++; } assert(rv.result(s)); }
});
t('trudny bot pokonuje losowego', () => {
  let w = 0; for (let g = 0; g < 6; g++) { let s = rv.init(); while (!rv.result(s)) s = rv.play(s, rv.ai(s, s.t === 2 ? 'h' : 'e')); if (rv.result(s).winner === 2) w++; } assert(w >= 5, 'wygrane: ' + w);
});
t('cleanParams ogranicza wartości', () => {
  const p = E.cleanParams('mnk', { w: 99, h: 1, k: 50, gravity: 'false' }); assert.deepStrictEqual(p, { w: 25, h: 3, k: 25, gravity: false });
});
console.log('\nOK: ' + ok + ' testów silników');
