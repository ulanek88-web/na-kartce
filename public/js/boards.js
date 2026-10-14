/* Plansze SVG dla wszystkich silników + logika wyboru ruchu (dotyk/klik).
   Kontekst c: { kind, board, state, you, legal, ui, result, myTurn } */
const E = () => window.NKEngines;

/* ---------- pomocnicze ---------- */
const lineSet = (c) => new Set((c.result && c.result.line) || []);

/* ---------- mnk: kółko i krzyżyk / gomoku / czwórki ---------- */
function mnkStyle(b) { return b.gravity ? 'c4' : (b.w >= 9 || b.h >= 9) ? 'gomoku' : 'ttt'; }

function mnkSVG(c) {
  const { w, h } = c.board, s = c.state, st = mnkStyle(c.board), win = lineSet(c), last = s.last;
  const legalCells = new Set(c.myTurn ? c.legal : []);
  let o = '';
  if (st === 'ttt') {
    const W = w * 100, H = h * 100;
    o += `<svg class="board" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plansza ${w}×${h}"><rect width="${W}" height="${H}" fill="var(--surface)"/>`;
    for (let i = 1; i < w; i++) o += `<line x1="${i * 100}" y1="8" x2="${i * 100}" y2="${H - 8}" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>`;
    for (let i = 1; i < h; i++) o += `<line y1="${i * 100}" x1="8" y2="${i * 100}" x2="${W - 8}" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>`;
    for (let i = 0; i < w * h; i++) {
      const x = (i % w) * 100, y = ((i / w) | 0) * 100, v = s.b[i];
      if (win.has(i)) o += `<rect x="${x + 4}" y="${y + 4}" width="92" height="92" rx="12" fill="var(--pri-soft)"/>`;
      else if (i === last) o += `<rect x="${x + 4}" y="${y + 4}" width="92" height="92" rx="12" fill="var(--surface2)"/>`;
      if (v === 1) o += `<path d="M${x + 26} ${y + 26}L${x + 74} ${y + 74}M${x + 74} ${y + 26}L${x + 26} ${y + 74}" stroke="var(--pri)" stroke-width="12" stroke-linecap="round"/>`;
      else if (v === 2) o += `<circle cx="${x + 50}" cy="${y + 50}" r="26" fill="none" stroke="var(--mark-o)" stroke-width="11"/>`;
      else if (legalCells.has(i)) o += `<circle cx="${x + 50}" cy="${y + 50}" r="5" fill="var(--line)"/>`;
      o += `<rect data-act="cell" data-i="${i}" x="${x}" y="${y}" width="100" height="100" fill="transparent"/>`;
    }
    return o + '</svg>';
  }
  if (st === 'gomoku') {
    const g = 40, m = 24, W = (w - 1) * g + m * 2, H = (h - 1) * g + m * 2;
    o += `<svg class="board" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plansza gomoku"><rect width="${W}" height="${H}" fill="var(--wood)"/>`;
    for (let i = 0; i < w; i++) o += `<line x1="${m + i * g}" y1="${m}" x2="${m + i * g}" y2="${H - m}" stroke="var(--wood-line)" stroke-width="1.4"/>`;
    for (let i = 0; i < h; i++) o += `<line y1="${m + i * g}" x1="${m}" y2="${m + i * g}" x2="${W - m}" stroke="var(--wood-line)" stroke-width="1.4"/>`;
    if (w === 15 && h === 15) for (const [px, py] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) o += `<circle cx="${m + px * g}" cy="${m + py * g}" r="3.5" fill="var(--wood-line)"/>`;
    for (let i = 0; i < w * h; i++) {
      const cx = m + (i % w) * g, cy = m + ((i / w) | 0) * g, v = s.b[i];
      if (v) {
        o += `<circle cx="${cx}" cy="${cy}" r="17" fill="${v === 1 ? 'var(--stone-b)' : 'var(--stone-w)'}" stroke="${v === 1 ? '#000' : '#8a8576'}" stroke-width="1"/>`;
        if (v === 1) o += `<circle cx="${cx - 5}" cy="${cy - 5}" r="5" fill="#fff" opacity=".12"/>`;
        if (win.has(i)) o += `<circle cx="${cx}" cy="${cy}" r="21" fill="none" stroke="var(--accent)" stroke-width="3.5"/>`;
        else if (i === last) o += `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${v === 1 ? '#fff' : '#d33'}"/>`;
      }
      o += `<rect data-act="cell" data-i="${i}" x="${cx - g / 2}" y="${cy - g / 2}" width="${g}" height="${g}" fill="transparent"/>`;
    }
    return o + '</svg>';
  }
  /* czwórki (grawitacja) */
  const g = 64, W = w * g, H = h * g;
  o += `<svg class="board" viewBox="0 0 ${W} ${H + 8}" style="aspect-ratio:${W}/${H + 8}" role="img" aria-label="Plansza czwórki"><rect width="${W}" height="${H + 8}" rx="10" fill="var(--c4)"/>`;
  for (let i = 0; i < w * h; i++) {
    const cx = (i % w) * g + g / 2, cy = ((i / w) | 0) * g + g / 2 + 4, v = s.b[i];
    const fill = v === 1 ? '#E5384B' : v === 2 ? '#FFC93C' : 'var(--c4-hole)';
    o += `<circle cx="${cx}" cy="${cy}" r="26" fill="${fill}"/>`;
    if (v) o += `<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="3"/>`;
    if (win.has(i)) o += `<circle cx="${cx}" cy="${cy}" r="28" fill="none" stroke="#fff" stroke-width="4"/>`;
    else if (i === last) o += `<circle cx="${cx}" cy="${cy}" r="7" fill="rgba(255,255,255,.7)"/>`;
  }
  for (let x = 0; x < w; x++) o += `<rect data-act="cell" data-i="${x}" x="${x * g}" y="0" width="${g}" height="${H + 8}" fill="transparent"/>`;
  return o + '</svg>';
}
function mnkClick(c, i) {
  if (!c.myTurn) return null;
  const col = c.board.gravity ? i % c.board.w : i;
  return c.legal.includes(col) ? { move: col } : null;
}

/* ---------- reversi ---------- */
function reversiSVG(c) {
  const s = c.state, legal = new Set(c.myTurn ? c.legal : []);
  let o = `<svg class="board" viewBox="0 0 400 400" role="img" aria-label="Plansza reversi"><rect width="400" height="400" fill="var(--felt)"/>`;
  for (let i = 0; i <= 8; i++) o += `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="400" stroke="var(--felt-line)" stroke-width="2"/><line y1="${i * 50}" x1="0" y2="${i * 50}" x2="400" stroke="var(--felt-line)" stroke-width="2"/>`;
  for (let i = 0; i < 64; i++) {
    const cx = (i % 8) * 50 + 25, cy = ((i / 8) | 0) * 50 + 25, v = s.b[i];
    if (v) {
      o += `<circle cx="${cx}" cy="${cy}" r="20" fill="${v === 1 ? 'var(--stone-b)' : 'var(--stone-w)'}" stroke="${v === 1 ? '#000' : '#8a8576'}" stroke-width="1.2"/>`;
      if (i === s.last) o += `<circle cx="${cx}" cy="${cy}" r="5" fill="${v === 1 ? '#fff' : '#d33'}"/>`;
    } else if (legal.has(i)) o += `<circle cx="${cx}" cy="${cy}" r="6" fill="rgba(255,255,255,.45)"/>`;
    o += `<rect data-act="cell" data-i="${i}" x="${cx - 25}" y="${cy - 25}" width="50" height="50" fill="transparent"/>`;
  }
  return o + '</svg>';
}
function reversiClick(c, i) { return c.myTurn && c.legal.includes(i) ? { move: i } : null; }

/* ---------- warcaby ---------- */
function checkersSVG(c) {
  const n = c.board.n, s = c.state, u = 800 / n, flip = c.you === 2;
  const path = c.ui.path || [];
  const pos = (i) => { const x = i % n, y = (i / n) | 0; return flip ? [(n - 1 - x) * u, (n - 1 - y) * u] : [x * u, y * u]; };
  let targets = new Set(), origins = new Set();
  if (c.myTurn) {
    if (!path.length) c.legal.forEach((m) => origins.add(m.p[0]));
    else c.legal.forEach((m) => { if (m.p.length > path.length && path.every((q, k) => m.p[k] === q)) targets.add(m.p[path.length]); });
  }
  const lastSet = new Set(s.last ? [s.last.from, s.last.to] : []);
  let o = `<svg class="board" viewBox="0 0 800 800" role="img" aria-label="Plansza warcabów">`;
  for (let i = 0; i < n * n; i++) {
    const [x, y] = pos(i), dark = ((i % n) + ((i / n) | 0)) % 2 === 1;
    o += `<rect x="${x}" y="${y}" width="${u}" height="${u}" fill="${dark ? 'var(--sq-dark)' : 'var(--sq-light)'}"/>`;
    if (dark && lastSet.has(i)) o += `<rect x="${x}" y="${y}" width="${u}" height="${u}" fill="var(--accent)" opacity=".35"/>`;
  }
  for (let i = 0; i < n * n; i++) {
    const v = s.b[i], [x, y] = pos(i), cx = x + u / 2, cy = y + u / 2;
    if (path[0] === i || path.includes(i)) o += `<rect x="${x}" y="${y}" width="${u}" height="${u}" fill="var(--pri)" opacity=".45"/>`;
    if (v) {
      const white = v === 1 || v === 3;
      o += `<circle cx="${cx}" cy="${cy + u * .05}" r="${u * .4}" fill="rgba(0,0,0,.28)"/><circle cx="${cx}" cy="${cy}" r="${u * .4}" fill="${white ? '#F4EFE2' : '#2B2522'}" stroke="${white ? '#9d9585' : '#000'}" stroke-width="3"/>`;
      o += `<circle cx="${cx}" cy="${cy}" r="${u * .27}" fill="none" stroke="${white ? '#cfc8b6' : '#4a423d'}" stroke-width="3"/>`;
      if (v >= 3) o += `<path d="M${cx - u * .17} ${cy + u * .08}l-${u * .03}-${u * .2} ${u * .1} ${u * .1} ${u * .1}-${u * .16} ${u * .1} ${u * .16} ${u * .1}-${u * .1}-${u * .03} ${u * .2}z" fill="var(--accent)" stroke="#6b4e00" stroke-width="2"/>`;
    }
    if (origins.has(i)) o += `<circle cx="${cx}" cy="${cy}" r="${u * .46}" fill="none" stroke="var(--pri)" stroke-width="5" stroke-dasharray="10 8"/>`;
    if (targets.has(i)) o += `<circle cx="${cx}" cy="${cy}" r="${u * .15}" fill="var(--pri)" opacity=".85"/>`;
    o += `<rect data-act="cell" data-i="${i}" x="${x}" y="${y}" width="${u}" height="${u}" fill="transparent"/>`;
  }
  return o + '</svg>';
}
function checkersClick(c, i) {
  if (!c.myTurn) return null;
  const path = c.ui.path || [], next = path.concat(i);
  const full = c.legal.find((m) => m.p.length === next.length && next.every((q, k) => m.p[k] === q));
  if (full && path.length) return { move: full };
  const part = c.legal.some((m) => m.p.length > next.length && next.every((q, k) => m.p[k] === q));
  if (part && path.length) return { ui: { path: next } };
  if (c.legal.some((m) => m.p[0] === i)) return { ui: { path: [i] } };
  return path.length ? { ui: { path: [] } } : null;
}

/* ---------- szachy ---------- */
const PIECE = {
  p: '<circle cx="50" cy="31" r="13"/><path d="M37 54Q50 44 63 54L68 74H32Z"/><rect x="25" y="74" width="50" height="10" rx="4"/>',
  r: '<path d="M27 84V73h46v11zM33 73V44h34v29zM27 44V21h11v8h7v-8h10v8h7v-8h11v23z"/>',
  n: '<path d="M27 84V74c0-20 10-24 16-36l-14 5-5-9 24-19c25 1 40 20 40 43v26z"/><circle cx="46" cy="33" r="3" class="eye"/>',
  b: '<path d="M50 12c-6 0-9 4-9 8 0 3 2 5 3 7-12 9-17 22-12 35h36c5-13 0-26-12-35 1-2 3-4 3-7 0-4-3-8-9-8z"/><rect x="27" y="70" width="46" height="13" rx="5"/><path d="M50 30v14M43 37h14" class="det"/>',
  q: '<path d="M25 76L16 30l20 22 14-30 14 30 20-22-9 46z"/><rect x="25" y="76" width="50" height="10" rx="4"/><circle cx="16" cy="28" r="5"/><circle cx="36" cy="18" r="5"/><circle cx="50" cy="14" r="5"/><circle cx="64" cy="18" r="5"/><circle cx="84" cy="28" r="5"/>',
  k: '<path d="M50 8v22M39 18h22" class="det" style="stroke-width:6"/><path d="M28 80L24 54c4-14 14-20 26-20s22 6 26 20l-4 26z"/><rect x="24" y="80" width="52" height="10" rx="4"/>'
};
function pieceInner(ch) {
  const white = ch === ch.toUpperCase(), t = ch.toLowerCase();
  const f = white ? '#F7F3E8' : '#2E2A28', s = white ? '#1b1b1b' : '#000', d = white ? '#1b1b1b' : '#e9e4d6';
  const body = PIECE[t].replace(/class="det"/g, `fill="none" stroke="${d}"`).replace(/class="eye"/g, `fill="${d}" stroke="none"`);
  return `<g fill="${f}" stroke="${s}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">${body}</g>`;
}
export function pieceSVG(ch, size) {
  return `<svg viewBox="0 0 100 100" ${size ? `width="${size}" height="${size}"` : ''} aria-hidden="true">${pieceInner(ch)}</svg>`;
}
function chessSVG(c) {
  const s = c.state, flip = c.you === 2, sel = c.ui.sel;
  const pos = (i) => { const f = i % 8, r = (i / 8) | 0; return flip ? [(7 - f) * 100, (7 - r) * 100] : [f * 100, r * 100]; };
  const targets = new Map();
  if (c.myTurn && sel != null) c.legal.forEach((m) => { if (m.from === sel) targets.set(m.to, true); });
  const origins = new Set(c.myTurn ? c.legal.map((m) => m.from) : []);
  let checkSq = -1;
  const eng = E().make('chess', {});
  if (!c.result && eng.inCheck && eng.inCheck(s)) checkSq = s.b.indexOf(s.t === 1 ? 'K' : 'k');
  let o = `<svg class="board" viewBox="0 0 800 800" role="img" aria-label="Szachownica">`;
  for (let i = 0; i < 64; i++) {
    const [x, y] = pos(i), light = (((i % 8) + ((i / 8) | 0)) % 2) === 0;
    o += `<rect x="${x}" y="${y}" width="100" height="100" fill="${light ? 'var(--sq-light)' : 'var(--sq-dark)'}"/>`;
    if (s.last && (i === s.last.from || i === s.last.to)) o += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--accent)" opacity=".4"/>`;
    if (i === checkSq) o += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--bad)" opacity=".55"/>`;
    if (i === sel) o += `<rect x="${x}" y="${y}" width="100" height="100" fill="var(--pri)" opacity=".5"/>`;
  }
  /* opisy pól */
  for (let k = 0; k < 8; k++) {
    const fileIdx = flip ? 7 - k : k, rankNum = flip ? k + 1 : 8 - k;
    o += `<text x="${k * 100 + 6}" y="793" font-size="20" font-weight="700" fill="${(k + 7) % 2 ? 'var(--sq-dark)' : 'var(--sq-light)'}" opacity=".9">${'abcdefgh'[fileIdx]}</text>`;
    o += `<text x="780" y="${k * 100 + 24}" text-anchor="end" font-size="20" font-weight="700" fill="${k % 2 ? 'var(--sq-light)' : 'var(--sq-dark)'}" opacity=".9">${rankNum}</text>`;
  }
  for (let i = 0; i < 64; i++) {
    const v = s.b[i], [x, y] = pos(i);
    if (v) o += `<g transform="translate(${x} ${y})">${pieceInner(v)}</g>`;
    if (targets.has(i)) o += v ? `<circle cx="${x + 50}" cy="${y + 50}" r="46" fill="none" stroke="var(--pri)" stroke-width="8" opacity=".85"/>` : `<circle cx="${x + 50}" cy="${y + 50}" r="15" fill="var(--pri)" opacity=".8"/>`;
    o += `<rect data-act="cell" data-i="${i}" x="${x}" y="${y}" width="100" height="100" fill="transparent"/>`;
  }
  return o + '</svg>';
}
function chessClick(c, i) {
  if (!c.myTurn) return null;
  const sel = c.ui.sel;
  if (sel != null) {
    const ms = c.legal.filter((m) => m.from === sel && m.to === i);
    if (ms.length > 1) return { ui: { sel, promo: { from: sel, to: i } } };
    if (ms.length === 1) return { move: ms[0] };
  }
  if (c.legal.some((m) => m.from === i)) return { ui: { sel: i === sel ? null : i } };
  return sel != null ? { ui: { sel: null } } : null;
}

/* ---------- kropki i pudełka ---------- */
/* Ruch = indeks krawędzi: poziome 0..HN-1 (y*(w-1)+x), pionowe HN + y*w + x (jak w silniku). */
function dotsSVG(c) {
  const { w, h } = c.board, s = c.state, g = 60, m = 30, W = (w - 1) * g + m * 2, H = (h - 1) * g + m * 2;
  const HN = h * (w - 1), EN = HN + (h - 1) * w, free = new Set(c.myTurn ? c.legal : []);
  const col = (v) => (v === 1 ? 'var(--pri)' : 'var(--mark-o)');
  let o = `<svg class="board" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plansza kropki i pudełka ${w}×${h}"><rect width="${W}" height="${H}" fill="var(--surface)"/>`;
  for (let by = 0; by < h - 1; by++) for (let bx = 0; bx < w - 1; bx++) {
    const v = s.b[by * (w - 1) + bx]; if (!v) continue;
    const x = m + bx * g, y = m + by * g;
    o += `<rect x="${x + 5}" y="${y + 5}" width="${g - 10}" height="${g - 10}" rx="6" fill="${col(v)}" opacity=".16"/>`;
    o += v === 1 ? `<path d="M${x + 20} ${y + 20}L${x + 40} ${y + 40}M${x + 40} ${y + 20}L${x + 20} ${y + 40}" stroke="${col(1)}" stroke-width="5" stroke-linecap="round"/>` : `<circle cx="${x + 30}" cy="${y + 30}" r="11" fill="none" stroke="${col(2)}" stroke-width="5"/>`;
  }
  let hit = '';
  for (let i = 0; i < EN; i++) {
    let x1, y1, x2, y2;
    if (i < HN) { x1 = m + (i % (w - 1)) * g; y1 = m + ((i / (w - 1)) | 0) * g; x2 = x1 + g; y2 = y1; }
    else { const j = i - HN; x1 = m + (j % w) * g; y1 = m + ((j / w) | 0) * g; x2 = x1; y2 = y1 + g; }
    const v = s.e[i];
    if (v) {
      if (i === s.last) o += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--pri-soft)" stroke-width="16" stroke-linecap="round"/>`;
      o += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col(v)}" stroke-width="${v === 1 ? 5 : 7}" stroke-linecap="round"/>`;
    } else {
      o += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--line)" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>`;
      /* pole dotyku = romb wokół środka krawędzi (połowa przekątnej = pół kroku siatki): romby pokrywają planszę bez luk i nakładania, więc dotyk zawsze trafia w najbliższą wolną krawędź */
      if (free.has(i)) { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, r = g / 2; hit += `<polygon data-act="cell" data-i="${i}" points="${mx - r},${my} ${mx},${my - r} ${mx + r},${my} ${mx},${my + r}" fill="transparent"/>`; }
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o += `<circle cx="${m + x * g}" cy="${m + y * g}" r="5" fill="var(--ink)"/>`;
  return o + hit + '</svg>';
}
function dotsClick(c, i) { return c.myTurn && c.legal.includes(i) ? { move: i } : null; }

/* ---------- wyścig wektorowy ---------- */
/* Ruch m = 0..8 (przyspieszenie ax = m % 3 − 1, ay = ⌊m / 3⌋ − 1). Dwuetapowo: dotknięcie wybiera ruch (podgląd na torze), ponowne dotknięcie go zatwierdza. */
const RACE_ARROWS = ['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘'];
function raceSVG(c) {
  const s = c.state, eng = E().make('race', { laps: s.lp || 2 }), T = eng._t, w = eng.w, h = eng.h, g = 16;
  const BW = w * g, BH = h * g, PY = BH + 10, PB = 66, W = BW, H = PY + PB * 3 + 6;
  const px = (v) => (v + 0.5) * g, sel = c.ui && c.ui.sel != null ? c.ui.sel : null;
  const col = (v) => (v === 1 ? 'var(--pri)' : 'var(--mark-o)');
  let o = `<svg class="board" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tor wyścigowy"><rect width="${W}" height="${H}" fill="var(--surface)"/>`;
  let road = '', border = '', grid = '';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!eng.road[y * w + x]) continue;
    road += `M${x * g} ${y * g}h${g}v${g}h${-g}z`;
    if (!T.isRoad(x, y - 1)) border += `M${x * g} ${y * g}h${g}`;
    if (!T.isRoad(x, y + 1)) border += `M${x * g} ${(y + 1) * g}h${g}`;
    if (!T.isRoad(x - 1, y)) border += `M${x * g} ${y * g}v${g}`;
    if (!T.isRoad(x + 1, y)) border += `M${(x + 1) * g} ${y * g}v${g}`;
  }
  for (let i = 0; i <= w; i++) grid += `M${i * g} 0V${BH}`;
  for (let i = 0; i <= h; i++) grid += `M0 ${i * g}H${BW}`;
  o += `<path d="${road}" fill="var(--surface2)"/><path d="${grid}" stroke="var(--line)" stroke-width=".6" fill="none"/><path d="${border}" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
  eng.checkpoints.forEach((k, i) => {
    const a = k.ax === 'x' ? [px(k.v), px(k.lo), px(k.v), px(k.hi)] : [px(k.lo), px(k.v), px(k.hi), px(k.v)];
    o += `<line x1="${a[0]}" y1="${a[1]}" x2="${a[2]}" y2="${a[3]}" stroke="${i ? 'var(--muted)' : 'var(--ink)'}" stroke-width="${i ? 1.5 : 3.5}" stroke-dasharray="${i ? '2 4' : '5 4'}"/>`;
  });
  /* HUD w środku toru */
  [1, 2].forEach((side) => {
    const i = side - 1, y = BH / 2 - 8 + i * 26;
    o += `<circle cx="${BW / 2 - 96}" cy="${y - 5}" r="6" fill="${col(side)}"/><text x="${BW / 2 - 82}" y="${y}" font-size="17" fill="var(--ink)">okr. ${Math.min(s.lp, Math.floor(s.c[i] / 4))}/${s.lp} · rozbicia ${s.cr[i]}</text>`;
  });
  /* ślady i rozbicia */
  [1, 2].forEach((side) => {
    const pts = s.pa[side - 1].map((q) => `${px(q[0])},${px(q[1])}`).join(' ');
    o += `<polyline points="${pts}" fill="none" stroke="${col(side)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"${side === 1 ? ' stroke-dasharray="7 4"' : ''} opacity=".9"/>`;
    s.bk[side - 1].forEach((q) => { const x = px(q[0]), y = px(q[1]); o += `<path d="M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}" stroke="var(--bad)" stroke-width="3" stroke-linecap="round"/>`; });
  });
  /* podgląd ruchu: wektor prędkości i dziewięć punktów docelowych */
  const me = c.you - 1, mine = c.myTurn && !s.end;
  if (mine) {
    const x0 = px(s.p[me][0]), y0 = px(s.p[me][1]), bx = s.p[me][0] + s.v[me][0], by = s.p[me][1] + s.v[me][1];
    if (s.v[me][0] || s.v[me][1]) o += `<line x1="${x0}" y1="${y0}" x2="${px(bx)}" y2="${px(by)}" stroke="var(--muted)" stroke-width="2" stroke-dasharray="3 3"/>`;
    for (const m of c.legal) {
      const dx = bx + (m % 3) - 1, dy = by + ((m / 3) | 0) - 1, ok = T.pathOK(s.p[me][0], s.p[me][1], dx, dy), x = px(dx), y = px(dy);
      if (m === sel) o += `<line x1="${x0}" y1="${y0}" x2="${x}" y2="${y}" stroke="${ok ? col(c.you) : 'var(--bad)'}" stroke-width="3"/>`;
      o += ok ? `<circle cx="${x}" cy="${y}" r="${m === sel ? 6 : 3.6}" fill="${m === sel ? col(c.you) : 'var(--pri-soft)'}" stroke="${col(c.you)}" stroke-width="1.4"/>` : `<circle cx="${x}" cy="${y}" r="${m === sel ? 6 : 3.6}" fill="none" stroke="var(--bad)" stroke-width="1.6"/>`;
      o += `<circle data-act="cell" data-i="${100 + m}" cx="${x}" cy="${y}" r="${g / 2}" fill="transparent"/>`;
    }
  }
  /* samochody */
  [1, 2].forEach((side) => { const q = s.p[side - 1]; o += `<circle cx="${px(q[0])}" cy="${px(q[1])}" r="7" fill="${col(side)}" stroke="var(--surface)" stroke-width="2"/><text x="${px(q[0])}" y="${px(q[1]) + 4}" font-size="10" text-anchor="middle" fill="#fff" font-weight="700">${side}</text>`; });
  /* panel przyspieszenia (3×3) */
  const bw = W / 3;
  for (let m = 0; m < 9; m++) {
    const x = (m % 3) * bw + 5, y = PY + ((m / 3) | 0) * PB, on = mine && c.legal.includes(m), isSel = on && m === sel;
    o += `<rect x="${x}" y="${y}" width="${bw - 10}" height="${PB - 8}" rx="10" fill="${isSel ? 'var(--pri-soft)' : 'var(--surface2)'}" stroke="${isSel ? 'var(--pri)' : 'var(--line)'}" stroke-width="${isSel ? 3 : 1.5}" opacity="${on ? 1 : 0.4}"/>`;
    o += `<text x="${x + (bw - 10) / 2}" y="${y + (PB - 8) / 2 + 9}" font-size="${m === 4 ? 30 : 28}" text-anchor="middle" fill="var(--ink)" opacity="${on ? 1 : 0.4}">${RACE_ARROWS[m]}${isSel ? '✓' : ''}</text>`;
    if (on) o += `<rect data-act="cell" data-i="${m}" x="${x}" y="${y}" width="${bw - 10}" height="${PB - 8}" fill="transparent"/>`;
  }
  return o + '</svg>';
}
function raceClick(c, i) {
  if (!c.myTurn) return null;
  const m = i >= 100 ? i - 100 : i;
  if (!c.legal.includes(m)) return null;
  return c.ui && c.ui.sel === m ? { move: m } : { ui: { sel: m } };
}

/* ---------- interfejs publiczny ---------- */
export function boardSVG(c) {
  switch (c.kind) {
    case 'mnk': return mnkSVG(c);
    case 'reversi': return reversiSVG(c);
    case 'checkers': return checkersSVG(c);
    case 'chess': return chessSVG(c);
    case 'dots': return dotsSVG(c);
    case 'race': return raceSVG(c);
    default: return '<div class="empty">Ta gra nie ma jeszcze planszy.</div>';
  }
}
export function onCell(c, i) {
  switch (c.kind) {
    case 'mnk': return mnkClick(c, i);
    case 'reversi': return reversiClick(c, i);
    case 'checkers': return checkersClick(c, i);
    case 'chess': return chessClick(c, i);
    case 'dots': return dotsClick(c, i);
    case 'race': return raceClick(c, i);
    default: return null;
  }
}
export function promoHTML(you) {
  return ['q', 'r', 'b', 'n'].map((p) => `<button data-act="promo" data-p="${p}" aria-label="Promocja">${pieceSVG(you === 1 ? p.toUpperCase() : p)}</button>`).join('');
}
export function engineKind(game) {
  const eng = game && game.engine;
  return { mnk: 'mnk', reversi: 'reversi', checkers: 'checkers', chess: 'chess', dots: 'dots', race: 'race' }[eng] || null;
}
/* symbol gracza (kolorowa kropka na karcie) */
export function symbolStyle(kind, board, side) {
  if (kind === 'chess') return side === 1 ? '#F7F3E8' : '#2E2A28';
  if (kind === 'checkers') return side === 1 ? '#F4EFE2' : '#2B2522';
  if (kind === 'reversi' || (kind === 'mnk' && board && mnkStyle(board) === 'gomoku')) return side === 1 ? '#15181A' : '#F7F5EE';
  if (kind === 'mnk' && board && board.gravity) return side === 1 ? '#E5384B' : '#FFC93C';
  return side === 1 ? 'var(--pri)' : 'var(--mark-o)';
}
