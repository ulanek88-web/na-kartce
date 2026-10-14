/*
 * Na kartce — silniki gier (współdzielone przez serwer i przeglądarkę).
 *
 * Każdy silnik implementuje ten sam interfejs, dzięki czemu platforma nie musi
 * znać zasad konkretnej gry:
 *   init()            -> stan początkowy (czysty JSON)
 *   legal(s)          -> lista dozwolonych ruchów (czysty JSON)
 *   mkey(m)           -> klucz ruchu do porównań
 *   play(s, m)        -> nowy stan po ruchu
 *   result(s)         -> null albo { winner: 0|1|2, reason, line? }
 *   ai(s, level)      -> ruch bota ('e' łatwy, 'm' średni, 'h' trudny)
 * Gracz 1 zaczyna. s.t to gracz na ruchu.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NKEngines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];
  const D4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

  /* ================= SIATKA m×n, k W LINII (kółko i krzyżyk, gomoku, czwórki…) ================= */
  function makeMNK(P) {
    const w = clamp(P.w, 3, 25, 3), h = clamp(P.h, 3, 25, 3);
    const k = clamp(P.k, 3, Math.max(w, h), 3), grav = !!P.gravity, N = w * h;
    const eng = { kind: 'mnk', w, h, k, gravity: grav };
    eng.init = () => ({ b: new Array(N).fill(0), t: 1, last: -1, n: 0 });
    const landing = (s, c) => { for (let y = h - 1; y >= 0; y--) if (!s.b[y * w + c]) return y * w + c; return -1; };
    eng.legal = (s) => {
      const m = [];
      if (grav) { for (let c = 0; c < w; c++) if (!s.b[c]) m.push(c); }
      else for (let i = 0; i < N; i++) if (!s.b[i]) m.push(i);
      return m;
    };
    eng.mkey = (m) => String(m);
    eng.cellOf = (s, m) => (grav ? landing(s, m) : m);
    eng.play = (s, m) => {
      const i = grav ? landing(s, m) : m, b = s.b.slice();
      b[i] = s.t;
      return { b, t: 3 - s.t, last: i, n: s.n + 1 };
    };
    eng.result = (s) => {
      if (s.last >= 0) {
        const p = s.b[s.last], x = s.last % w, y = (s.last / w) | 0;
        for (const [dx, dy] of D4) {
          const line = [s.last];
          for (let sg = 1; sg >= -1; sg -= 2) {
            for (let q = 1; ; q++) {
              const xx = x + dx * q * sg, yy = y + dy * q * sg;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h || s.b[yy * w + xx] !== p) break;
              line.push(yy * w + xx);
            }
          }
          if (line.length >= k) return { winner: p, reason: 'line', line };
        }
      }
      return s.n >= N ? { winner: 0, reason: 'draw' } : null;
    };
    const pat = (c, o) => {
      const d = k - c;
      if (d <= 0) return 1e6;
      if (d === 1) return o === 2 ? 2e4 : o === 1 ? 4e3 : 0;
      if (d === 2) return o === 2 ? 2500 : o === 1 ? 300 : 0;
      if (d === 3) return o === 2 ? 200 : o === 1 ? 30 : 0;
      return o === 2 ? 10 : o === 1 ? 2 : 0;
    };
    const sc = (b, i, p) => {
      const x = i % w, y = (i / w) | 0;
      let tot = 0;
      for (const [dx, dy] of D4) {
        let c = 1, o = 0;
        for (let sg = 1; sg >= -1; sg -= 2) {
          for (let q = 1; ; q++) {
            const xx = x + dx * q * sg, yy = y + dy * q * sg;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
            const v = b[yy * w + xx];
            if (v === p) { c++; continue; }
            if (v === 0) o++;
            break;
          }
        }
        tot += pat(c, o);
      }
      return tot;
    };
    function mm(s) {
      const r = eng.result(s);
      if (r) return r.winner === 0 ? 0 : (r.winner === s.t ? 1 : -1);
      let best = -2;
      for (const m of eng.legal(s)) {
        const v = -mm(eng.play(s, m));
        if (v > best) { best = v; if (best === 1) break; }
      }
      return best;
    }
    eng.ai = (s, level) => {
      const L = eng.legal(s), me = s.t;
      if (!L.length) return null;
      // wygrana w jednym ruchu / blokada — poziom średni i wyżej, łatwy czasem
      const winNow = (p) => L.find((m) => { const i = eng.cellOf(s, m); return sc(s.b, i, p) >= 1e6; });
      if (level !== 'e' || Math.random() < 0.5) { const a = winNow(me); if (a != null) return a; }
      if (level !== 'e' || Math.random() < 0.3) { const d = winNow(3 - me); if (d != null) return d; }
      if (level === 'e' && Math.random() < 0.55) return pick(L);
      if (N <= 9 && level === 'h') {
        let best = -2, pool = [];
        for (const m of L) { const v = -mm(eng.play(s, m)); if (v > best) { best = v; pool = [m]; } else if (v === best) pool.push(m); }
        return pick(pool);
      }
      let cand = L;
      const any = s.b.some((v) => v);
      if (!grav && N >= 100) {
        if (!any) return (h >> 1) * w + (w >> 1);
        cand = L.filter((m) => {
          const x = m % w, y = (m / w) | 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && s.b[yy * w + xx]) return true;
          }
          return false;
        });
        if (!cand.length) cand = L;
      }
      let best = -Infinity, pool = [];
      for (const m of cand) {
        const c = eng.cellOf(s, m), cx = c % w, cy = (c / w) | 0;
        const a = sc(s.b, c, me), d = sc(s.b, c, 3 - me);
        let v;
        if (level === 'e') v = (a * 0.6 + d * 0.4) * (0.2 + Math.random() * 1.6);
        else if (level === 'm') v = (a + d * 0.9) * (0.85 + Math.random() * 0.3);
        else v = a * 1.05 + d + (w / 2 - Math.abs(cx - (w - 1) / 2)) * 0.4 + (h / 2 - Math.abs(cy - (h - 1) / 2)) * 0.2;
        if (grav) {
          const above = c - w;
          if (above >= 0 && !s.b[above] && level !== 'e') {
            if (sc(s.b, above, 3 - me) >= 1e6 && a < 1e6) v -= 5e5;
            else if (level === 'h' && sc(s.b, above, me) >= 1e6) v += 3e3;
          }
        }
        if (v > best + 1e-9) { best = v; pool = [m]; } else if (Math.abs(v - best) <= 1e-9) pool.push(m);
      }
      return pick(pool);
    };
    return eng;
  }

  /* ================= REVERSI ================= */
  const RW = (function () {
    const q = [[100, -20, 10, 5], [-20, -50, -2, -2], [10, -2, -1, -1], [5, -2, -1, -1]], w = [];
    for (let i = 0; i < 64; i++) { const x = i % 8, y = (i / 8) | 0; w.push(q[Math.min(y, 7 - y)][Math.min(x, 7 - x)]); }
    return w;
  })();
  function rflips(b, i, p) {
    if (b[i]) return [];
    const x = i % 8, y = (i / 8) | 0;
    let out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      let xx = x + dx, yy = y + dy;
      const tmp = [];
      while (xx >= 0 && yy >= 0 && xx < 8 && yy < 8 && b[yy * 8 + xx] === 3 - p) { tmp.push(yy * 8 + xx); xx += dx; yy += dy; }
      if (tmp.length && xx >= 0 && yy >= 0 && xx < 8 && yy < 8 && b[yy * 8 + xx] === p) out = out.concat(tmp);
    }
    return out;
  }
  const rmoves = (b, p) => { const m = []; for (let i = 0; i < 64; i++) if (!b[i] && rflips(b, i, p).length) m.push(i); return m; };
  const rapply = (b, i, p) => { const nb = b.slice(); nb[i] = p; rflips(b, i, p).forEach((f) => { nb[f] = p; }); return nb; };
  const reval = (b, t) => {
    let s = 0;
    for (let i = 0; i < 64; i++) { if (b[i] === t) s += RW[i]; else if (b[i]) s -= RW[i]; }
    return s + 4 * (rmoves(b, t).length - rmoves(b, 3 - t).length);
  };
  function rnm(b, t, d, al, be) {
    const m = rmoves(b, t);
    if (!m.length) {
      const om = rmoves(b, 3 - t);
      if (!om.length) { let df = 0; b.forEach((v) => { if (v === t) df++; else if (v) df--; }); return df * 200; }
      return -rnm(b, 3 - t, d - 1, -be, -al);
    }
    if (d <= 0) return reval(b, t);
    let best = -1e9;
    for (let k = 0; k < m.length; k++) {
      const v = -rnm(rapply(b, m[k], t), 3 - t, d - 1, -be, -al);
      if (v > best) best = v;
      if (best > al) al = best;
      if (al >= be) break;
    }
    return best;
  }
  function makeReversi() {
    const eng = { kind: 'reversi', w: 8, h: 8 };
    eng.init = () => { const b = new Array(64).fill(0); b[27] = 2; b[28] = 1; b[35] = 1; b[36] = 2; return { b, t: 1, last: -1, n: 0 }; };
    eng.legal = (s) => rmoves(s.b, s.t);
    eng.mkey = (m) => String(m);
    eng.play = (s, i) => {
      const b = rapply(s.b, i, s.t);
      let nx = 3 - s.t;
      if (!rmoves(b, nx).length && rmoves(b, s.t).length) nx = s.t;
      return { b, t: nx, last: i, n: s.n + 1 };
    };
    eng.result = (s) => {
      if (rmoves(s.b, 1).length || rmoves(s.b, 2).length) return null;
      let a = 0, c = 0;
      s.b.forEach((v) => { if (v === 1) a++; else if (v === 2) c++; });
      return { winner: a > c ? 1 : c > a ? 2 : 0, reason: 'count', score: [a, c] };
    };
    eng.ai = (s, level) => {
      const m = rmoves(s.b, s.t);
      if (!m.length) return null;
      if (level === 'e') return pick(m);
      let best = -1e9, pool = [];
      m.forEach((x) => {
        let v;
        if (level === 'm') v = RW[x] * 2 + rflips(s.b, x, s.t).length + Math.random();
        else v = -rnm(rapply(s.b, x, s.t), 3 - s.t, 3, -1e9, 1e9);
        if (v > best) { best = v; pool = [x]; } else if (v === best) pool.push(x);
      });
      return pick(pool);
    };
    return eng;
  }

  /* ================= WARCABY (polskie 10×10 / 8×8): bicie obowiązkowe, najwięcej pionów, damki latające ================= */
  function makeCheckers(P) {
    const n = P.n === 8 ? 8 : 10, rows = (n / 2 - 1) | 0, NN = n * n;
    const eng = { kind: 'checkers', n };
    const DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const own = (v) => (v === 1 || v === 3 ? 1 : v === 2 || v === 4 ? 2 : 0);
    eng.init = () => {
      const b = new Array(NN).fill(0);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if ((x + y) % 2 !== 1) continue;
        if (y < rows) b[y * n + x] = 2; else if (y >= n - rows) b[y * n + x] = 1;
      }
      return { b, t: 1, q: 0, last: null, n: 0 };
    };
    function captures(b, from, p) {
      const king = b[from] >= 3, out = [], caps = new Set(), path = [from];
      const empty = (i) => b[i] === 0 || i === from;
      (function rec(pos) {
        let found = false;
        const x = pos % n, y = (pos / n) | 0;
        for (const [dx, dy] of DIRS) {
          if (!king) {
            const lx = x + 2 * dx, ly = y + 2 * dy;
            if (lx < 0 || ly < 0 || lx >= n || ly >= n) continue;
            const ei = (y + dy) * n + (x + dx), li = ly * n + lx;
            if (own(b[ei]) === 3 - p && !caps.has(ei) && empty(li)) {
              found = true; caps.add(ei); path.push(li); rec(li); path.pop(); caps.delete(ei);
            }
          } else {
            let xx = x + dx, yy = y + dy;
            while (xx >= 0 && yy >= 0 && xx < n && yy < n && empty(yy * n + xx)) { xx += dx; yy += dy; }
            if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
            const ei = yy * n + xx;
            if (own(b[ei]) !== 3 - p || caps.has(ei)) continue;
            const ls = [];
            let lx = xx + dx, ly = yy + dy;
            while (lx >= 0 && ly >= 0 && lx < n && ly < n && empty(ly * n + lx)) { ls.push(ly * n + lx); lx += dx; ly += dy; }
            for (const li of ls) { found = true; caps.add(ei); path.push(li); rec(li); path.pop(); caps.delete(ei); }
          }
        }
        if (!found && path.length > 1) out.push({ p: path.slice(), c: Array.from(caps) });
      })(from);
      return out;
    }
    function quiet(b, from, p) {
      const x = from % n, y = (from / n) | 0, king = b[from] >= 3, out = [];
      for (const [dx, dy] of DIRS) {
        if (!king) {
          if (dy !== (p === 1 ? -1 : 1)) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < n && yy < n && !b[yy * n + xx]) out.push({ p: [from, yy * n + xx], c: [] });
        } else {
          let xx = x + dx, yy = y + dy;
          while (xx >= 0 && yy >= 0 && xx < n && yy < n && !b[yy * n + xx]) { out.push({ p: [from, yy * n + xx], c: [] }); xx += dx; yy += dy; }
        }
      }
      return out;
    }
    eng.legal = (s) => {
      let caps = [], mx = 0;
      for (let i = 0; i < NN; i++) {
        if (own(s.b[i]) !== s.t) continue;
        for (const m of captures(s.b, i, s.t)) {
          if (m.c.length > mx) { mx = m.c.length; caps = [m]; } else if (m.c.length === mx) caps.push(m);
        }
      }
      if (caps.length) return caps;
      const q = [];
      for (let i = 0; i < NN; i++) if (own(s.b[i]) === s.t) for (const m of quiet(s.b, i, s.t)) q.push(m);
      return q;
    };
    eng.mkey = (m) => m.p.join('-');
    eng.play = (s, m) => {
      const b = s.b.slice(), from = m.p[0], to = m.p[m.p.length - 1];
      let v = b[from];
      b[from] = 0;
      m.c.forEach((i) => { b[i] = 0; });
      const p = own(v), ty = (to / n) | 0;
      if (v < 3 && ((p === 1 && ty === 0) || (p === 2 && ty === n - 1))) v = p === 1 ? 3 : 4;
      b[to] = v;
      const q = (s.b[from] >= 3 && !m.c.length) ? s.q + 1 : 0;
      return { b, t: 3 - s.t, q, last: { from, to, p: m.p }, n: s.n + 1 };
    };
    eng.result = (s) => {
      if (s.q >= 50) return { winner: 0, reason: 'draw' };
      if (!eng.legal(s).length) return { winner: 3 - s.t, reason: 'blocked' };
      return null;
    };
    const evalS = (s) => {
      let sc = 0;
      for (let i = 0; i < NN; i++) {
        const v = s.b[i];
        if (!v) continue;
        const p = own(v), y = (i / n) | 0, x = i % n;
        let val;
        if (v >= 3) val = 330 + (x > 1 && x < n - 2 ? 6 : 0);
        else val = 100 + (p === 1 ? (n - 1 - y) : y) * 4 + (x === 0 || x === n - 1 ? -3 : 0);
        sc += p === s.t ? val : -val;
      }
      return sc;
    };
    const TIMEOUT = { timeout: true };
    function nm(s, d, al, be, ext, dl) {
      if (Date.now() > dl) throw TIMEOUT;
      if (s.q >= 50) return 0;
      const L = eng.legal(s);
      if (!L.length) return -1e5 - d;
      if (d <= 0 && (L[0].c.length === 0 || ext <= 0)) return evalS(s);
      let best = -Infinity;
      for (const m of L) {
        const v = -nm(eng.play(s, m), d - 1, -be, -al, d <= 0 ? ext - 1 : ext, dl);
        if (v > best) best = v;
        if (best > al) al = best;
        if (al >= be) break;
      }
      return best;
    }
    eng.ai = (s, level) => {
      const L = eng.legal(s);
      if (!L.length) return null;
      if (L.length === 1) return L[0];
      if (level === 'e') {
        const sc = L.map((m) => ({ m, v: -evalS(eng.play(s, m)) + Math.random() * 260 }));
        sc.sort((a, b) => b.v - a.v);
        return sc[0].m;
      }
      const maxD = level === 'm' ? 3 : 10, tl = level === 'm' ? 350 : 1100, dl = Date.now() + tl;
      let best = pick(L);
      for (let d = 1; d <= maxD; d++) {
        try {
          let bv = -Infinity, bm = null, al = -Infinity;
          for (const m of L) {
            const v = -nm(eng.play(s, m), d - 1, -Infinity, -al, 4, dl);
            if (v > bv + (level === 'm' ? Math.random() * 4 : 0)) { bv = v; bm = m; }
            if (bv > al) al = bv;
          }
          best = bm;
        } catch (e) { if (e === TIMEOUT) break; throw e; }
      }
      return best;
    };
    return eng;
  }

  /* ================= SZACHY (pełne zasady: roszada, bicie w przelocie, promocja, remisy) ================= */
  const PV = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const KNO = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KGO = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const chOwner = (c) => (c === '' ? 0 : (c === c.toUpperCase() ? 1 : 2));
  function chAttacked(b, sq, by) {
    const r = sq >> 3, f = sq & 7;
    const pr = by === 1 ? r + 1 : r - 1;
    if (pr >= 0 && pr < 8) for (const df of [-1, 1]) {
      const ff = f + df;
      if (ff >= 0 && ff < 8 && b[pr * 8 + ff] === (by === 1 ? 'P' : 'p')) return true;
    }
    const N = by === 1 ? 'N' : 'n', K = by === 1 ? 'K' : 'k';
    for (const [dr, df] of KNO) { const rr = r + dr, ff = f + df; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === N) return true; }
    for (const [dr, df] of KGO) { const rr = r + dr, ff = f + df; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === K) return true; }
    const B = by === 1 ? 'B' : 'b', R = by === 1 ? 'R' : 'r', Q = by === 1 ? 'Q' : 'q';
    for (const [dr, df] of KGO) {
      const diag = dr !== 0 && df !== 0;
      let rr = r + dr, ff = f + df;
      while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
        const c = b[rr * 8 + ff];
        if (c) { if (c === Q || (diag ? c === B : c === R)) return true; break; }
        rr += dr; ff += df;
      }
    }
    return false;
  }
  function chKing(b, p) { const K = p === 1 ? 'K' : 'k'; for (let i = 0; i < 64; i++) if (b[i] === K) return i; return -1; }
  function chApplyBoard(b, m, t) {
    const nb = b.slice(), pc = nb[m.from];
    nb[m.to] = pc; nb[m.from] = '';
    const lp = pc.toLowerCase();
    if (lp === 'p' && (m.from & 7) !== (m.to & 7) && !b[m.to]) nb[(m.from >> 3) * 8 + (m.to & 7)] = ''; // bicie w przelocie
    if (lp === 'k' && Math.abs(m.to - m.from) === 2) {
      if (m.to > m.from) { nb[m.from + 1] = nb[m.from + 3]; nb[m.from + 3] = ''; }
      else { nb[m.from - 1] = nb[m.from - 4]; nb[m.from - 4] = ''; }
    }
    if (m.promo) nb[m.to] = t === 1 ? m.promo.toUpperCase() : m.promo.toLowerCase();
    return nb;
  }
  function chPseudo(s, capsOnly) {
    const b = s.b, t = s.t, out = [];
    const add = (from, to, promo) => out.push(promo ? { from, to, promo } : { from, to });
    for (let sq = 0; sq < 64; sq++) {
      const c = b[sq];
      if (!c || chOwner(c) !== t) continue;
      const r = sq >> 3, f = sq & 7, lp = c.toLowerCase();
      if (lp === 'p') {
        const dr = t === 1 ? -1 : 1, start = t === 1 ? 6 : 1, pr = t === 1 ? 0 : 7;
        const r1 = r + dr;
        if (r1 < 0 || r1 > 7) continue;
        if (!b[r1 * 8 + f] && (!capsOnly || r1 === pr)) {
          if (r1 === pr) for (const pm of ['q', 'r', 'b', 'n']) add(sq, r1 * 8 + f, pm);
          else {
            add(sq, r1 * 8 + f);
            if (r === start && !b[(r + 2 * dr) * 8 + f]) add(sq, (r + 2 * dr) * 8 + f);
          }
        }
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const to = r1 * 8 + ff, tc = b[to];
          if ((tc && chOwner(tc) === 3 - t) || (!tc && to === s.ep)) {
            if (r1 === pr) for (const pm of ['q', 'r', 'b', 'n']) add(sq, to, pm); else add(sq, to);
          }
        }
      } else if (lp === 'n' || lp === 'k') {
        for (const [dr, df] of (lp === 'n' ? KNO : KGO)) {
          const rr = r + dr, ff = f + df;
          if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
          const to = rr * 8 + ff, tc = b[to];
          if (tc && chOwner(tc) === t) continue;
          if (capsOnly && !tc) continue;
          add(sq, to);
        }
        if (lp === 'k' && !capsOnly) {
          const home = t === 1 ? 60 : 4, en = 3 - t;
          if (sq === home && !chAttacked(b, home, en)) {
            const K = t === 1 ? 'K' : 'k', Q = t === 1 ? 'Q' : 'q', R = t === 1 ? 'R' : 'r';
            if (s.cas.includes(K) && !b[home + 1] && !b[home + 2] && b[home + 3] === R && !chAttacked(b, home + 1, en)) add(sq, home + 2);
            if (s.cas.includes(Q) && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === R && !chAttacked(b, home - 1, en)) add(sq, home - 2);
          }
        }
      } else {
        for (const [dr, df] of KGO) {
          const diag = dr !== 0 && df !== 0;
          if (lp === 'b' && !diag) continue;
          if (lp === 'r' && diag) continue;
          let rr = r + dr, ff = f + df;
          while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
            const to = rr * 8 + ff, tc = b[to];
            if (tc) { if (chOwner(tc) === 3 - t) add(sq, to); break; }
            if (!capsOnly) add(sq, to);
            rr += dr; ff += df;
          }
        }
      }
    }
    return out;
  }
  function chLegal(s, capsOnly) {
    const out = [];
    for (const m of chPseudo(s, capsOnly)) {
      const nb = chApplyBoard(s.b, m, s.t), k = chKing(nb, s.t);
      if (k >= 0 && !chAttacked(nb, k, 3 - s.t)) out.push(m);
    }
    return out;
  }
  function chKey(s) {
    // pole bicia w przelocie liczy się tylko gdy takie bicie jest możliwe
    let ep = '-';
    if (s.ep >= 0) {
      const r = s.ep >> 3, f = s.ep & 7, pr = s.t === 1 ? r + 1 : r - 1, P = s.t === 1 ? 'P' : 'p';
      if ((f > 0 && s.b[pr * 8 + f - 1] === P) || (f < 7 && s.b[pr * 8 + f + 1] === P)) ep = String(s.ep);
    }
    return s.b.map((c) => c || '.').join('') + s.t + s.cas + ep;
  }
  function chInsufficient(b) {
    const bishops = [];
    let knights = 0, other = false;
    for (let i = 0; i < 64; i++) {
      const c = b[i];
      if (!c) continue;
      const l = c.toLowerCase();
      if (l === 'k') continue;
      if (l === 'b') bishops.push(((i >> 3) + (i & 7)) & 1);
      else if (l === 'n') knights++;
      else other = true;
    }
    if (other) return false;
    if (!bishops.length && knights <= 1) return true;
    if (!knights) return bishops.every((x) => x === bishops[0]);
    return false;
  }
  const CH_START = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';
  function makeChess() {
    const eng = { kind: 'chess' };
    eng.init = () => {
      const s = { b: CH_START.split('').map((c) => (c === '.' ? '' : c)), t: 1, cas: 'KQkq', ep: -1, hm: 0, fm: 1, last: null, n: 0, reps: {} };
      s.reps[chKey(s)] = 1;
      return s;
    };
    eng.legal = (s) => chLegal(s, false);
    eng.mkey = (m) => m.from + '-' + m.to + (m.promo || '');
    eng.inCheck = (s) => { const k = chKing(s.b, s.t); return k >= 0 && chAttacked(s.b, k, 3 - s.t); };
    eng.play = (s, m, opts) => {
      const t = s.t, pc = s.b[m.from], cap = s.b[m.to], lp = pc.toLowerCase();
      const b = chApplyBoard(s.b, m, t);
      let ep = -1, hm = s.hm + 1, cas = s.cas;
      if (lp === 'p') {
        hm = 0;
        if (Math.abs(m.to - m.from) === 16) ep = (m.from + m.to) / 2;
      }
      if (cap || (lp === 'p' && (m.from & 7) !== (m.to & 7))) hm = 0;
      if (lp === 'k') cas = cas.replace(t === 1 ? /[KQ]/g : /[kq]/g, '');
      const strip = (sq) => {
        if (sq === 63) cas = cas.replace('K', ''); if (sq === 56) cas = cas.replace('Q', '');
        if (sq === 7) cas = cas.replace('k', ''); if (sq === 0) cas = cas.replace('q', '');
      };
      strip(m.from); strip(m.to);
      const ns = { b, t: 3 - t, cas, ep, hm, fm: s.fm + (t === 2 ? 1 : 0), last: { from: m.from, to: m.to }, n: s.n + 1, reps: s.reps };
      if (!(opts && opts.search)) {
        const reps = Object.assign({}, s.reps), key = chKey(ns);
        reps[key] = (reps[key] || 0) + 1;
        ns.reps = reps;
      }
      return ns;
    };
    eng.result = (s) => {
      const L = chLegal(s, false);
      if (!L.length) return eng.inCheck(s) ? { winner: 3 - s.t, reason: 'mat' } : { winner: 0, reason: 'pat' };
      if (s.hm >= 100) return { winner: 0, reason: '50 ruchów' };
      if (s.reps[chKey(s)] >= 3) return { winner: 0, reason: 'powtórzenie pozycji' };
      if (chInsufficient(s.b)) return { winner: 0, reason: 'za mało materiału' };
      return null;
    };
    // ----- bot -----
    const cen = (r, f) => -(Math.abs(f - 3.5) + Math.abs(r - 3.5));
    function evalW(s) {
      let sc = 0;
      for (let i = 0; i < 64; i++) {
        const c = s.b[i];
        if (!c) continue;
        const l = c.toLowerCase(), w = c === c.toUpperCase(), r = i >> 3, f = i & 7;
        let v = PV[l];
        if (l === 'p') v += (w ? 6 - r : r - 1) * 7 + (f > 1 && f < 6 ? 4 : 0);
        else if (l === 'n' || l === 'b') v += cen(r, f) * 7;
        else if (l === 'q') v += cen(r, f) * 2;
        else if (l === 'k') v += ((w ? r >= 6 : r <= 1) ? 12 : -8);
        sc += w ? v : -v;
      }
      return sc;
    }
    const TIMEOUT = { timeout: true };
    const order = (s, ms) => ms.map((m) => {
      const cp = s.b[m.to], mover = s.b[m.from].toLowerCase();
      return { m, v: (cp ? 10 * PV[cp.toLowerCase()] - PV[mover] : 0) + (m.promo ? 800 : 0) };
    }).sort((a, b) => b.v - a.v).map((x) => x.m);
    function qs(s, al, be, d, dl) {
      const stand = (s.t === 1 ? 1 : -1) * evalW(s);
      if (d <= 0) return stand;
      if (stand >= be) return stand;
      if (stand > al) al = stand;
      for (const m of order(s, chLegal(s, true))) {
        const v = -qs(eng.play(s, m, { search: true }), -be, -al, d - 1, dl);
        if (v >= be) return v;
        if (v > al) al = v;
      }
      return al;
    }
    function nm(s, d, al, be, ply, dl) {
      if (Date.now() > dl) throw TIMEOUT;
      const L = chLegal(s, false);
      if (!L.length) return eng.inCheck(s) ? -1e5 + ply : 0;
      if (s.hm >= 100) return 0;
      if (d <= 0) return qs(s, al, be, 3, dl);
      let best = -Infinity;
      for (const m of order(s, L)) {
        const v = -nm(eng.play(s, m, { search: true }), d - 1, -be, -al, ply + 1, dl);
        if (v > best) best = v;
        if (best > al) al = best;
        if (al >= be) break;
      }
      return best;
    }
    eng.ai = (s, level) => {
      const L = chLegal(s, false);
      if (!L.length) return null;
      if (L.length === 1) return L[0];
      const maxD = level === 'e' ? 1 : level === 'm' ? 2 : 6, tl = level === 'e' ? 150 : level === 'm' ? 500 : 1500;
      if (level === 'e' && Math.random() < 0.3) return pick(L);
      const dl = Date.now() + tl;
      let best = pick(L);
      const sorted = order(s, L);
      for (let d = 1; d <= maxD; d++) {
        try {
          let bv = -Infinity, bm = null, al = -Infinity;
          for (const m of sorted) {
            const v = -nm(eng.play(s, m, { search: true }), d - 1, -Infinity, -al, 1, dl) + (level !== 'h' ? Math.random() * (level === 'e' ? 60 : 12) : 0);
            if (v > bv) { bv = v; bm = m; }
            if (bv > al) al = bv;
          }
          best = bm;
        } catch (e) { if (e === TIMEOUT) break; throw e; }
      }
      return best;
    };
    return eng;
  }

  /* ================= REJESTR ================= */
  /* ================= KROPKI I PUDEŁKA (w×h kropek): zamknięcie pudełka = punkt + dodatkowy ruch ================= */
  /* Krawędzie: poziome 0..HN-1 (y*(w-1)+x), pionowe HN..EN-1 (HN + y*w + x). Ruch = indeks wolnej krawędzi.
     Stan: { e: właściciel krawędzi (0/1/2), b: właściciel pudełka, t, last, n, sc: [pudełka gracza 1, gracza 2] }. */
  function makeDots(P) {
    const w = clamp(P.w, 3, 9, 6), h = clamp(P.h, 3, 9, 6);
    const BW = w - 1, BN = BW * (h - 1), HN = h * BW, EN = HN + (h - 1) * w;
    const eng = { kind: 'dots', w, h, boxes: BN, edges: EN };
    const boxEdges = [];                                                   // pudełko -> [góra, dół, lewo, prawo]
    for (let by = 0; by < h - 1; by++) for (let bx = 0; bx < BW; bx++) boxEdges.push([by * BW + bx, (by + 1) * BW + bx, HN + by * w + bx, HN + by * w + bx + 1]);
    const edgeBoxes = Array.from({ length: EN }, () => []);                // krawędź -> pudełka, które do niej przylegają
    boxEdges.forEach((es, b) => es.forEach((x) => edgeBoxes[x].push(b)));
    eng.boxEdges = boxEdges; eng.edgeBoxes = edgeBoxes;
    eng.init = () => ({ e: new Array(EN).fill(0), b: new Array(BN).fill(0), t: 1, last: -1, n: 0, sc: [0, 0] });
    eng.legal = (s) => { const L = []; for (let i = 0; i < EN; i++) if (!s.e[i]) L.push(i); return L; };
    eng.mkey = (m) => String(m);
    eng.play = (s, m) => {
      const e = s.e.slice(), b = s.b.slice(), sc = s.sc.slice();
      e[m] = s.t;
      let got = 0;
      for (const bx of edgeBoxes[m]) if (!b[bx] && boxEdges[bx].every((x) => e[x])) { b[bx] = s.t; got++; }
      sc[s.t - 1] += got;
      return { e, b, t: got ? s.t : 3 - s.t, last: m, n: s.n + 1, sc };          // zamknięcie pudełka = dodatkowy ruch
    };
    eng.result = (s) => {
      if (s.sc[0] + s.sc[1] < BN) return null;
      return { winner: s.sc[0] > s.sc[1] ? 1 : s.sc[1] > s.sc[0] ? 2 : 0, reason: 'count', score: s.sc.slice() };
    };
    const sides = (s) => boxEdges.map((es) => (s.e[es[0]] ? 1 : 0) + (s.e[es[1]] ? 1 : 0) + (s.e[es[2]] ? 1 : 0) + (s.e[es[3]] ? 1 : 0));
    /* ile pudełek zabierze rywal zachłannie po moim ruchu e (do oceny „oddawania” łańcuchów) */
    const give = (s, e) => {
      const opp = 3 - s.t; let st = eng.play(s, e);
      for (;;) {
        const c = sides(st), cap = eng.legal(st).find((x) => edgeBoxes[x].some((b) => c[b] === 3));
        if (cap === undefined || st.t !== opp) break;
        st = eng.play(st, cap);
      }
      return st.sc[opp - 1] - s.sc[opp - 1];
    };
    /* dokładne rozwiązanie końcówki (≤16 wolnych krawędzi): wartość = (moje − ich) pudełka do końca, z pamięcią podręczną po masce */
    const solve = (s, L) => {
      const n = L.length, loc = new Map(L.map((x, j) => [x, j])), open = [];
      const bm = [];                                                       // maski wolnych krawędzi niezamkniętych pudełek
      boxEdges.forEach((es, b) => { if (s.b[b]) return; let m = 0; for (const x of es) if (loc.has(x)) m |= 1 << loc.get(x); bm[b] = m; open.push(b); });
      const adj = L.map((x) => edgeBoxes[x].filter((b) => !s.b[b]));
      const memo = new Int8Array(1 << n).fill(-128), FULL = (1 << n) - 1;
      const gain = (mask, j) => { const nm = mask | (1 << j); let c = 0; for (const b of adj[j]) if ((nm & bm[b]) === bm[b]) c++; return c ? c + val(nm) : -val(nm); };
      const val = (mask) => {
        if (mask === FULL) return 0;
        if (memo[mask] !== -128) return memo[mask];
        let best = -127;
        for (let j = 0; j < n; j++) if (!(mask & (1 << j))) { const g = gain(mask, j); if (g > best) best = g; }
        return (memo[mask] = best);
      };
      let best = -1e9, pool = [];
      for (let j = 0; j < n; j++) { const g = gain(0, j); if (g > best) { best = g; pool = [L[j]]; } else if (g === best) pool.push(L[j]); }
      return pick(pool);
    };
    eng.ai = (s, level) => {
      const L = eng.legal(s);
      if (!L.length) return null;
      const c = sides(s), caps = L.filter((x) => edgeBoxes[x].some((b) => c[b] === 3));
      if (level === 'e') return caps.length && Math.random() < 0.6 ? pick(caps) : pick(L);
      if (level === 'h' && L.length <= 16) return solve(s, L);
      if (caps.length) return pick(caps);
      const safe = L.filter((x) => edgeBoxes[x].every((b) => c[b] < 2));
      if (safe.length) return pick(safe);
      let best = 1e9, pool = [];
      for (const x of L) { const g = give(s, x); if (g < best) { best = g; pool = [x]; } else if (g === best) pool.push(x); }
      return pick(pool);
    };
    return eng;
  }

  /* ================= WYŚCIG WEKTOROWY (tor na kratce, 2 graczy): przyspieszenie −1/0/+1 na oś, rozbicie = utrata 3 kolejek ================= */
  /* Ruch m ∈ 0..8: ax = (m % 3) − 1, ay = ⌊m / 3⌋ − 1. Samochody się nie zderzają (przenikają). Sloty graczy ściśle się przeplatają;
     po zakończeniu rundy (slot gracza 2), w której ktoś ukończył wyścig, gra się kończy – obaj mają tyle samo kolejek. */
  function makeRace(P) {
    const laps = [1, 2, 3].includes(+P.laps) ? +P.laps : 2;
    const W = 30, H = 20, CX = 14.5, CY = 9.5, VMAX = 4, MAXCR = 3, PEN = 3, LIMIT = 300, K = 4;
    const eng = { kind: 'race', w: W, h: H, laps };
    const road = new Array(W * H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = ((x - CX) / 13.5) ** 2 + ((y - CY) / 8.5) ** 2, i = ((x - CX) / 9) ** 2 + ((y - CY) / 4.5) ** 2;
      if (o <= 1 && i >= 1) road[y * W + x] = 1;
    }
    eng.road = road;
    const isRoad = (x, y) => x >= 0 && y >= 0 && x < W && y < H && road[y * W + x] === 1;
    /* linie kontrolne w kolejności jazdy (przeciwnie do ruchu wskazówek zegara): meta, prawa, górna, lewa; v = współrzędna linii na osi ax, lo..hi = zakres na drugiej osi */
    const CP = [
      { ax: 'x', v: 14.5, lo: 13.5, hi: 18.5, dir: 1 }, { ax: 'y', v: 9.5, lo: 23.5, hi: 28.5, dir: -1 },
      { ax: 'x', v: 14.5, lo: 0.5, hi: 5.5, dir: -1 }, { ax: 'y', v: 9.5, lo: 0.5, hi: 5.5, dir: 1 }
    ];
    eng.checkpoints = CP; eng.laps = laps;
    const pathOK = (x0, y0, x1, y1) => {
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy, x = x0, y = y0;
      for (;;) {
        if (!isRoad(x, y)) return false;
        if (x === x1 && y === y1) return true;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
      }
    };
    const crosses = (x0, y0, x1, y1, k) => {
      const c = CP[k], a0 = c.ax === 'x' ? x0 : y0, a1 = c.ax === 'x' ? x1 : y1, b0 = c.ax === 'x' ? y0 : x0, b1 = c.ax === 'x' ? y1 : x1;
      if (!(c.dir > 0 ? a0 < c.v && a1 > c.v : a0 > c.v && a1 < c.v)) return false;
      const b = b0 + (c.v - a0) / (a1 - a0) * (b1 - b0);
      return b >= c.lo && b <= c.hi;
    };
    const moves = (vx, vy) => {
      const L = [];
      for (let m = 0; m < 9; m++) { const nx = vx + (m % 3) - 1, ny = vy + ((m / 3) | 0) - 1; if (Math.abs(nx) <= VMAX && Math.abs(ny) <= VMAX) L.push(m); }
      return L;
    };
    const stepCar = (car, m) => {
      const vx = car.vx + (m % 3) - 1, vy = car.vy + ((m / 3) | 0) - 1, nx = car.x + vx, ny = car.y + vy;
      if (!pathOK(car.x, car.y, nx, ny)) return { x: car.x, y: car.y, vx: 0, vy: 0, c: car.c, crash: true, done: false, tx: nx, ty: ny };
      const c = car.c + (crosses(car.x, car.y, nx, ny, (car.c + 1) % K) ? 1 : 0);
      return { x: nx, y: ny, vx, vy, c, crash: false, done: c >= laps * K };
    };
    /* pola odległości (BFS po kratkach toru) do „drugiej strony” każdej linii kontrolnej – do oceny postępu przez bota */
    let fields = null;
    const getFields = () => {
      if (fields) return fields;
      fields = CP.map((c) => {
        const d = new Int16Array(W * H).fill(-1), q = [], edge = Math.floor(c.v) + (c.dir > 0 ? 1 : 0);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (!road[y * W + x]) continue;
          const on = c.ax === 'x' ? x === edge && y >= c.lo && y <= c.hi : y === edge && x >= c.lo && x <= c.hi;
          if (on) { d[y * W + x] = 0; q.push(y * W + x); }
        }
        for (let h = 0; h < q.length; h++) {
          const cx = q[h] % W, cy = (q[h] / W) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if ((dx || dy) && isRoad(nx, ny) && d[ny * W + nx] < 0) { d[ny * W + nx] = d[q[h]] + 1; q.push(ny * W + nx); }
          }
        }
        return d;
      });
      return fields;
    };
    const progress = (x, y, c) => { const d = getFields()[(c + 1) % K][y * W + x]; return c * 1000 - (d < 0 ? 500 : d); };
    eng._t = { stepCar, pathOK, crosses, moves, getFields, progress, isRoad };
    eng.init = () => ({ p: [[15, 15], [15, 16]], v: [[0, 0], [0, 0]], c: [0, 0], cr: [0, 0], sk: [0, 0], fin: [0, 0], pa: [[[15, 15]], [[15, 16]]], bk: [[], []], t: 1, last: -1, n: 0, end: null, lp: laps });
    eng.legal = (s) => (s.end ? [] : moves(s.v[s.t - 1][0], s.v[s.t - 1][1]));
    eng.mkey = (m) => String(m);
    const advance = (st, who) => {
      let w = who;
      for (let g = 0; g < 64; g++) {
        if (w === 2 && !st.end && (st.fin[0] || st.fin[1])) st.end = st.fin[0] && st.fin[1] ? { winner: 0, reason: 'draw' } : { winner: st.fin[0] ? 1 : 2, reason: 'finish' };
        if (st.end) { st.t = 3 - w; return; }
        const nx = 3 - w;
        if (st.sk[nx - 1] > 0) { st.sk[nx - 1]--; w = nx; continue; }          // zmarnowana kolejka po rozbiciu
        st.t = nx; return;
      }
    };
    eng.play = (s, m) => {
      const p = s.t - 1;
      const st = { p: s.p.map((a) => a.slice()), v: s.v.map((a) => a.slice()), c: s.c.slice(), cr: s.cr.slice(), sk: s.sk.slice(), fin: s.fin.slice(), pa: s.pa.map((a) => a.slice()), bk: s.bk.map((a) => a.slice()), t: s.t, last: m, n: s.n + 1, end: null, lp: laps };
      const r = stepCar({ x: s.p[p][0], y: s.p[p][1], vx: s.v[p][0], vy: s.v[p][1], c: s.c[p] }, m);
      st.p[p] = [r.x, r.y]; st.v[p] = [r.vx, r.vy]; st.c[p] = r.c;
      if (r.crash) { st.cr[p]++; st.sk[p] = PEN; st.bk[p].push([r.tx, r.ty]); } else st.pa[p].push([r.x, r.y]);
      if (r.done) st.fin[p] = 1;
      if (st.cr[p] > MAXCR) st.end = { winner: 2 - p, reason: 'dnf' };              // 4. rozbicie = wypadnięcie z wyścigu
      advance(st, s.t);
      return st;
    };
    eng.result = (s) => {
      const laps2 = s.c.map((c) => Math.floor(c / K));
      if (s.end) return { winner: s.end.winner, reason: s.end.reason, score: laps2 };
      if (s.n < LIMIT) return null;
      const a = progress(s.p[0][0], s.p[0][1], s.c[0]), b = progress(s.p[1][0], s.p[1][1], s.c[1]);
      return { winner: a > b ? 1 : b > a ? 2 : 0, reason: 'limit', score: laps2 };
    };
    /* bot: przeszukiwanie wgłąb (łatwy 2, średni 3, trudny 4 ruchy), ocena = postęp po torze, kara za rozbicie i za brak możliwości wyhamowania */
    const canStop = (r) => {
      let { x, y, vx, vy } = r;
      for (let i = 0; i < 6 && (vx || vy); i++) {
        vx -= Math.sign(vx); vy -= Math.sign(vy);
        if (!pathOK(x, y, x + vx, y + vy)) return false;
        x += vx; y += vy;
      }
      return true;
    };
    const score = (r, d) => {
      if (r.done) return 1e6 + d * 10;
      if (r.crash) return progress(r.x, r.y, r.c) - 40;
      if (d === 0) return progress(r.x, r.y, r.c) + (canStop(r) ? 0 : -30);
      let best = -1e9;
      for (const m of moves(r.vx, r.vy)) { const v = score(stepCar(r, m), d - 1); if (v > best) best = v; }
      return best;
    };
    eng.ai = (s, level) => {
      if (s.end) return null;
      const p = s.t - 1, car = { x: s.p[p][0], y: s.p[p][1], vx: s.v[p][0], vy: s.v[p][1], c: s.c[p] }, L = moves(car.vx, car.vy);
      if (level === 'e' && Math.random() < 0.3) return pick(L);
      const depth = level === 'h' ? 5 : level === 'm' ? 3 : 2;
      let best = -1e9, pool = [];
      for (const m of L) { const v = score(stepCar(car, m), depth - 1); if (v > best) { best = v; pool = [m]; } else if (v === best) pool.push(m); }
      return pick(pool);
    };
    return eng;
  }

  function clamp(v, lo, hi, def) { v = parseInt(v, 10); if (isNaN(v)) return def; return Math.max(lo, Math.min(hi, v)); }
  const registry = {
    mnk: {
      label: 'Siatka m×n, k w linii (kółko i krzyżyk, gomoku, czwórki…)',
      params: [
        { key: 'w', label: 'Szerokość planszy', type: 'number', def: 3, min: 3, max: 25 },
        { key: 'h', label: 'Wysokość planszy', type: 'number', def: 3, min: 3, max: 25 },
        { key: 'k', label: 'Ile w linii wygrywa', type: 'number', def: 3, min: 3, max: 25 },
        { key: 'gravity', label: 'Grawitacja (żetony spadają, jak w „Czwórkach”)', type: 'bool', def: false }
      ],
      make: makeMNK
    },
    reversi: { label: 'Reversi (Othello)', params: [], make: makeReversi },
    checkers: { label: 'Warcaby (bicie obowiązkowe, damki latające)', params: [{ key: 'n', label: 'Rozmiar planszy', type: 'select', def: 10, options: [8, 10] }], make: makeCheckers },
    chess: { label: 'Szachy', params: [], make: makeChess },
    dots: {
      label: 'Kropki i Pudełka (zamknięte pudełko = punkt i dodatkowy ruch)',
      params: [
        { key: 'w', label: 'Kropki w poziomie', type: 'number', def: 6, min: 3, max: 9 },
        { key: 'h', label: 'Kropki w pionie', type: 'number', def: 6, min: 3, max: 9 }
      ],
      make: makeDots
    },
    race: {
      label: 'Wyścig Wektorowy (tor na kratce, rozbicie = utrata 3 kolejek)',
      params: [{ key: 'laps', label: 'Liczba okrążeń', type: 'select', def: 2, options: [1, 2, 3] }],
      make: makeRace
    }
  };
  const cache = {};
  function make(id, params) {
    const r = registry[id];
    if (!r) throw new Error('Nieznany silnik: ' + id);
    const key = id + JSON.stringify(params || {});
    return cache[key] || (cache[key] = r.make(params || {}));
  }
  function cleanParams(id, params) {
    const r = registry[id], out = {};
    if (!r) return out;
    for (const p of r.params) {
      const v = (params || {})[p.key];
      if (p.type === 'bool') out[p.key] = !!v && v !== 'false';
      else if (p.type === 'select') out[p.key] = p.options.includes(+v) ? +v : p.def;
      else out[p.key] = clamp(v, p.min, p.max, p.def);
    }
    if (id === 'mnk') out.k = Math.min(out.k, Math.max(out.w, out.h));
    return out;
  }
  return { make, registry, cleanParams, _internals: { chLegal, chKey } };
});
