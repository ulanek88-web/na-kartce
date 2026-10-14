/* Na kartce — tryb offline (Single Player): gra z CPU w przeglądarce/aplikacji, bez serwera i bez konta.
   Wyniki NIE trafiają do rankingu ELO ani statystyk (nic nie jest wysyłane do serwera). */
import { store } from './api.js';
const E = window.NKEngines;

/* Wbudowany katalog gier – działa przy pierwszym uruchomieniu bez sieci. Po połączeniu z serwerem lista jest odświeżana i zapamiętywana. */
const BUILTIN = [
  ['szachy', 'Szachy', '♞', 215, 'chess', {}], ['warcaby', 'Warcaby', '◉', 12, 'checkers', { n: 10 }],
  ['gomoku', 'Gomoku', '●', 160, 'mnk', { w: 15, h: 15, k: 5, gravity: false }], ['kolko-krzyzyk', 'Kółko i krzyżyk', '✕', 40, 'mnk', { w: 3, h: 3, k: 3, gravity: false }],
  ['czworki', 'Czwórki', '▥', 205, 'mnk', { w: 7, h: 6, k: 4, gravity: true }], ['reversi', 'Reversi', '◐', 140, 'reversi', {}],
  ['kolko-krzyzyk-5', 'Kółko i krzyżyk 5×5', '✖', 25, 'mnk', { w: 5, h: 5, k: 4, gravity: false }], ['piatki-19', 'Piątki 19×19', '◌', 95, 'mnk', { w: 19, h: 19, k: 5, gravity: false }],
  ['czworki-xl', 'Czwórki XL', '▦', 185, 'mnk', { w: 9, h: 7, k: 5, gravity: true }]
].map(([slug, name, icon, hue, engine, params]) => ({ slug, name, icon, hue, engine, params, status: 'active' }));

export const LEVELS = { e: ['Łatwy', 'Ania'], m: ['Średni', 'Marek'], h: ['Trudny', 'Hektor'] };
export function rememberGames(list) {
  const g = (list || []).filter((x) => x.status === 'active' && x.engine && !x.plugin).map((x) => ({ slug: x.slug, name: x.name, icon: x.icon, iconUrl: x.iconUrl, hue: x.hue, engine: x.engine, kind: x.kind, board: x.board, params: boardParams(x) }));
  if (g.length) store.set('offgames', JSON.stringify(g));
}
const boardParams = (g) => { const b = g.board || {}; return g.engine === 'mnk' ? { w: b.w, h: b.h, k: b.k, gravity: b.gravity } : g.engine === 'checkers' ? { n: b.n } : {}; };
export function offlineGames() {
  let g = []; try { g = JSON.parse(store.get('offgames') || '[]'); } catch (e) { /* ignore */ }
  return (g.length ? g : BUILTIN).filter((x) => E && E.registry[x.engine]);
}

let worker = null, seq = 0; const pend = new Map();
function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker('/js/offline-worker.js');
    worker.onmessage = (e) => { const p = pend.get(e.data.id); if (p) { pend.delete(e.data.id); p(e.data); } };
    worker.onerror = () => { worker = false; for (const [k, f] of pend) { pend.delete(k); f({ error: 'worker' }); } };   // awaria wątku: reszta liczy się lokalnie
  } catch (e) { worker = false; }
  return worker;
}
function botMove(game, state, level) {
  return new Promise((resolve) => {
    const w = getWorker(), eng = E.make(game.engine, game.params);
    const local = () => { try { resolve(eng.ai(state, level)); } catch (e) { resolve(null); } };
    if (!w) return setTimeout(local, 30);
    const id = ++seq, t = setTimeout(() => { pend.delete(id); local(); }, 12000);
    pend.set(id, (d) => { clearTimeout(t); if (d.error) local(); else resolve(d.move); });
    try { w.postMessage({ id, engine: game.engine, params: game.params, state, level }); } catch (e) { clearTimeout(t); pend.delete(id); local(); }
  });
}

/** Lokalna partia z CPU. Udaje serwer: emituje migawki w tym samym formacie, więc działa na istniejącym widoku partii. */
export function createOfflineMatch(game, level, side, onSnap) {
  const eng = E.make(game.engine, game.params), human = side, botSide = 3 - side;
  let state = eng.init(), moves = [], hist = [], status = 'playing', result = null, token = 0;
  const id = 'offline-' + Date.now();
  const snap = () => ({
    id, offline: true, game: { slug: game.slug, name: game.name, icon: game.icon, hue: game.hue, engine: game.engine, params: game.params, timeSec: 0, incSec: 0, turnClock: false },
    mode: 'bot', rated: false, noElo: false, you: human,
    players: [human === 1 ? { nick: 'Ty', rating: null, hue: 150 } : { nick: 'CPU ' + LEVELS[level][0], rating: null, hue: 220 }, human === 2 ? { nick: 'Ty', rating: null, hue: 150 } : { nick: 'CPU ' + LEVELS[level][0], rating: null, hue: 220 }].map((p, i) => (i + 1 === botSide ? { nick: 'CPU (' + LEVELS[level][0] + ')', rating: null, hue: 220 } : { nick: 'Ty', rating: null, hue: 150 })),
    state, turn: state.t, clocks: [null, null], elapsed: 0, status, result, drawOffer: null, moves: moves.length, disc: [false, false], discLeft: [0, 0], graceMs: 0, tm: null,
    undo: true, undoReq: null, rematch: [false, false], table: 0
  });
  const emit = () => onSnap(snap());
  function finish(r) { status = 'over'; result = { winner: r.winner, reason: r.reason, line: r.line, score: r.score, rage: 0, deltas: null, ratings: null }; emit(); }
  async function maybeBot() {
    if (status !== 'playing' || state.t !== botSide) return;
    const my = ++token, ply = moves.length, t0 = Date.now();
    const mv = await botMove(game, state, level);
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0))));
    if (my !== token || status !== 'playing' || moves.length !== ply) return;
    if (mv == null) return finish({ winner: human, reason: 'bot bez ruchu' });
    apply(botSide, mv);
  }
  function apply(side, move) {
    if (status !== 'playing' || state.t !== side) return 'Nie Twoja kolej';
    const key = eng.mkey(move), legal = eng.legal(state).find((x) => eng.mkey(x) === key);
    if (!legal) return 'Niedozwolony ruch';
    hist.push({ state: structuredClone(state), n: moves.length, t: side });
    state = eng.play(state, legal); moves.push(legal); token++;
    const r = eng.result(state);
    if (r) return finish(r);
    emit(); maybeBot();
  }
  return {
    start() { emit(); maybeBot(); },
    destroy() { token++; status = 'over'; },
    send(msg) {
      if (msg.t === 'move') { const e = apply(human, msg.move); if (e) emit(); }
      else if (msg.t === 'resign' && status === 'playing') finish({ winner: botSide, reason: 'poddanie' });
      else if (msg.t === 'undo_req' && status === 'playing') {
        let i = hist.length - 1; while (i >= 0 && hist[i].t !== human) i--;
        if (i < 0) return;
        const h = hist[i]; hist.length = i; state = h.state; moves.length = h.n; token++; emit(); maybeBot();
      }
    }
  };
}
