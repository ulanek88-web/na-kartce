'use strict';
/* Testy mechaniki gier: inwarianty silników na losowych partiach (wszystkie warianty z katalogu), test różnicowy Reversi i siatki m×n
   względem niezależnych implementacji, poprawność i czas ruchów botów na każdym poziomie. */
const assert = require('assert');
const E = require('../shared/engines');
let n = 0; const ok = (name, ms) => { n++; console.log('  ✓ ' + name + (ms != null ? ' (' + ms + ' ms)' : '')); };
const rnd = (k) => Math.floor(Math.random() * k);

const VARIANTS = [
  ['szachy', 'chess', {}, 12, 220], ['warcaby 10×10', 'checkers', { n: 10 }, 40, 300], ['warcaby 8×8', 'checkers', { n: 8 }, 40, 300],
  ['kółko i krzyżyk 3×3', 'mnk', { w: 3, h: 3, k: 3, gravity: false }, 200, 9], ['kółko i krzyżyk 5×5 (4)', 'mnk', { w: 5, h: 5, k: 4, gravity: false }, 100, 25],
  ['gomoku 15×15', 'mnk', { w: 15, h: 15, k: 5, gravity: false }, 15, 225], ['piątki 19×19', 'mnk', { w: 19, h: 19, k: 5, gravity: false }, 8, 361],
  ['czwórki 7×6', 'mnk', { w: 7, h: 6, k: 4, gravity: true }, 100, 42], ['czwórki XL 9×7', 'mnk', { w: 9, h: 7, k: 5, gravity: true }, 60, 63], ['reversi', 'reversi', {}, 60, 70]
];

/* ---- niezależne implementacje do testów różnicowych ---- */
function mnkWinner(b, w, h, k) {            // b: tablica 0/1/2 (wiersze), zwraca 1|2|0 (brak)
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : b[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = at(x, y); if (!v) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) { let c = 1; while (at(x + dx * c, y + dy * c) === v) c++; if (c >= k) return v; }
  }
  return 0;
}
function reversiMoves(b, p) {               // b: 64 pól 0/1/2; zwraca posortowane indeksy legalnych pól
  const out = [];
  for (let i = 0; i < 64; i++) {
    if (b[i]) continue; const x = i % 8, y = (i / 8) | 0; let ok2 = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      let cx = x + dx, cy = y + dy, seen = 0;
      while (cx >= 0 && cy >= 0 && cx < 8 && cy < 8 && b[cy * 8 + cx] === 3 - p) { cx += dx; cy += dy; seen++; }
      if (seen && cx >= 0 && cy >= 0 && cx < 8 && cy < 8 && b[cy * 8 + cx] === p) { ok2 = true; break; }
    }
    if (ok2) out.push(i);
  }
  return out;
}

console.log('Inwarianty silników (losowe partie)');
for (const [name, id, params, games, cap] of VARIANTS) {
  const eng = E.make(id, params); const t0 = Date.now(); let plies = 0, ended = 0;
  for (let g = 0; g < games; g++) {
    let s = eng.init();
    for (let i = 0; i < cap + 50; i++) {
      const res = eng.result(s), L = eng.legal(s);
      if (res) { ended++; assert([0, 1, 2].includes(res.winner), name + ': zły zwycięzca'); break; }
      assert(L.length > 0, name + ': brak ruchów, a partia nie jest zakończona (zawieszenie gry) po ' + i + ' ruchach');
      const keys = L.map((m) => eng.mkey(m)); assert.strictEqual(new Set(keys).size, keys.length, name + ': zduplikowane ruchy');
      const before = JSON.stringify(s), m = L[rnd(L.length)], s2 = eng.play(s, m);
      assert.strictEqual(JSON.stringify(s), before, name + ': play() zmodyfikował stan wejściowy');
      assert(s2.t === 1 || s2.t === 2); assert.deepStrictEqual(JSON.parse(JSON.stringify(s2)), s2, name + ': stan nie jest czystym JSON-em');
      s = s2; plies++;
    }
  }
  if (id !== 'chess') assert(ended === games, name + ': ' + (games - ended) + ' partii nie zakończyło się w limicie ruchów');
  ok(name + ': ' + games + ' partii, ' + plies + ' ruchów, ' + ended + ' zakończonych', Date.now() - t0);
}

console.log('Testy różnicowe');
{
  let checked = 0;
  const rv = E.make('reversi', {});
  for (let g = 0; g < 80; g++) {
    let s = rv.init();
    for (let i = 0; i < 120 && !rv.result(s); i++) {
      const mine = reversiMoves(s.b, s.t), L = rv.legal(s).map(Number).sort((a, b) => a - b);
      if (mine.length) assert.deepStrictEqual(L, mine, 'reversi: różne legalne ruchy'); else assert.deepStrictEqual(L, [], 'reversi: silnik widzi ruchy, a niezależny generator nie');
      checked++; const Lr = rv.legal(s); s = rv.play(s, Lr[rnd(Lr.length)]);
    }
    const res = rv.result(s);
    if (res) { const c1 = s.b.filter((v) => v === 1).length, c2 = s.b.filter((v) => v === 2).length; assert.strictEqual(res.winner, c1 > c2 ? 1 : c2 > c1 ? 2 : 0, 'reversi: zły zwycięzca względem liczby pionów'); }
  }
  ok('Reversi: legalne ruchy i wynik zgodne z niezależną implementacją (' + checked + ' pozycji)');
  for (const [, id, params] of VARIANTS.filter((v) => v[1] === 'mnk')) {
    const eng = E.make(id, params); let cnt = 0;
    for (let g = 0; g < 60; g++) {
      let s = eng.init();
      for (let i = 0; i < params.w * params.h + 2; i++) {
        const res = eng.result(s), ref = mnkWinner(s.b, params.w, params.h, params.k), full = s.b.every((v) => v);
        if (ref) assert.strictEqual(res && res.winner, ref, 'mnk ' + params.w + 'x' + params.h + ': winner'); else if (full) assert(res && res.winner === 0, 'mnk: pełna plansza bez remisu'); else assert(!res, 'mnk: wynik bez linii');
        cnt++; if (res) break; const L = eng.legal(s); s = eng.play(s, L[rnd(L.length)]);
      }
    }
    if (params.gravity) { const s = eng.init(); assert.strictEqual(eng.legal(s).length, params.w, 'grawitacja: tylko kolumny'); }
  }
  ok('siatka m×n: wykrywanie zwycięstwa/remisu zgodne z niezależnym detektorem; grawitacja ogranicza ruchy do kolumn');
  const ck = E.make('checkers', { n: 10 }); let s = ck.init(); const pieces = (st) => st.b.filter(Boolean).length;
  for (let i = 0; i < 300 && !ck.result(s); i++) { const L = ck.legal(s), m = L[rnd(L.length)], before = pieces(s), a = ck.play(s, m); assert.strictEqual(pieces(a), before - m.c.length, 'warcaby: liczba zbitych pionów'); if (L.some((x) => x.c.length)) assert(L.every((x) => x.c.length === Math.max(...L.map((y) => y.c.length))), 'warcaby: bicie większości'); s = a; }
  ok('warcaby: bicie obowiązkowe i największe, zgodna liczba zbitych pionów');
}

console.log('Boty: poprawność i czas (poziom -> maks. ms na ruch)');
const LIMIT = { e: 1500, m: 4000, h: 7500 };            // serwer przerywa obliczenia po 8 s – musimy mieścić się z zapasem
const times = {};
for (const [name, id, params] of VARIANTS) {
  const eng = E.make(id, params);
  for (const lv of ['e', 'm', 'h']) {
    let worst = 0, s = eng.init();
    const samples = id === 'chess' || (id === 'mnk' && params.w >= 15) ? 4 : 8;
    const pos = [s]; for (let i = 0; i < 40 && !eng.result(s); i++) { const L = eng.legal(s); s = eng.play(s, L[rnd(L.length)]); if (i % 5 === 0) pos.push(s); }
    for (const p of pos.slice(0, samples)) {
      if (eng.result(p)) continue;
      const t0 = Date.now(), mv = eng.ai(p, lv), dt = Date.now() - t0; worst = Math.max(worst, dt);
      assert(mv != null && eng.legal(p).some((x) => eng.mkey(x) === eng.mkey(mv)), name + '/' + lv + ': bot zwrócił nielegalny ruch');
    }
    times[name + '/' + lv] = worst; assert(worst <= LIMIT[lv], name + '/' + lv + ': ruch bota trwa ' + worst + ' ms (limit ' + LIMIT[lv] + ')');
  }
  ok(name + ': e=' + times[name + '/e'] + ' m=' + times[name + '/m'] + ' h=' + times[name + '/h'] + ' ms');
}
{ /* bot gra kompletną partię z samym sobą w każdej grze (poziom e vs m) bez wyjątków i w skończonym czasie */
  for (const [name, id, params, , cap] of VARIANTS.filter((v) => v[1] !== 'chess')) {
    const eng = E.make(id, params); let s = eng.init(), i = 0; const t0 = Date.now();
    while (!eng.result(s) && i < cap + 100) { const m = eng.ai(s, s.t === 1 ? 'e' : 'm'); assert(eng.legal(s).some((x) => eng.mkey(x) === eng.mkey(m)), name + ': nielegalny ruch bota w partii'); s = eng.play(s, m); i++; }
    assert(eng.result(s), name + ': partia botów nie zakończyła się');
  }
  ok('pełne partie bot vs bot kończą się w każdej grze (poza szachami – patrz test szachów)');
}
console.log('\nOK: ' + n + ' grup testów mechaniki gier');
