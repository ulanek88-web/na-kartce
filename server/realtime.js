'use strict';
/* Partie na żywo: WebSocket, kojarzenie graczy, pokoje, boty, zegary, wyniki i ranking. */
const D = require('./db');
const G = require('./game');
const A = require('./auth');
const AI = require('./ai');
const WS = require('./ws');
const { originAllowed, clientIp } = require('./http');
const E = require('../shared/engines');
const CENSOR = require('./censor');
let TQ = [];   // szybkie wiadomości (z server/tables.js)

/* Goście (konta anonimowe) nie mogą pisać nigdzie: czat stołu, czat partii, forum. */
const GUEST_CHAT_MSG = 'Musisz się zarejestrować, aby móc rozmawiać z innymi graczami';
const BOTS = { e: { nick: 'Bot Ania', rating: 900 }, m: { nick: 'Bot Marek', rating: 1300 }, h: { nick: 'Bot Hektor', rating: 1700 } };

const conns = new Map();       // uid -> Set<conn>
const matches = new Map();     // id -> match
const userMatch = new Map();   // uid -> match id (jedna aktywna partia)
const queues = new Map();      // "gid|rated" -> Map(uid -> wpis)
const rooms = new Map();       // kod -> pokój
const hooks = { tmReady: null, matchEnd: null };
let lastOnline = -1;

const send = (c, o) => { try { c.ws.send(JSON.stringify(o)); } catch (e) { /* ignore */ } };
const toUser = (uid, o) => { for (const c of conns.get(uid) || []) send(c, o); };
const onlineCount = () => conns.size;

/* ---------- migawka partii ---------- */
function playerInfo(p) {
  if (p.bot && p.nick) return Object.assign({ nick: p.nick, rating: p.rating == null ? null : p.rating, hue: p.hue == null ? 220 : p.hue }, p.disguised ? {} : { bot: p.bot });
  if (p.bot) return { bot: p.bot, nick: BOTS[p.bot].nick, rating: null, hue: 220 };
  return { uid: p.uid, nick: p.nick, rating: p.rating, hue: p.hue, guest: p.guest };
}
function cleanState(s) { if (s && s.reps) { const c = Object.assign({}, s); delete c.reps; return c; } return s; }
function snapshot(m, side) {
  const g = m.game;
  return {
    id: m.id, game: { slug: g.slug, name: g.name, icon: g.icon, hue: g.hue, engine: g.engine, params: G.parseParams(g), timeSec: Math.round(m.clockCfg ? m.clockCfg.sec : g.time_sec), incSec: Math.round(m.incMs / 1000), turnClock: !!m.turnMs },
    mode: m.mode, rated: m.rated, you: side, players: m.players.map(playerInfo), state: cleanState(m.state), turn: m.state.t,
    clocks: m.clocks, elapsed: (m.pauseStart || Date.now()) - m.turnStart, status: m.status, result: m.result || null, drawOffer: m.drawOffer,
    moves: m.moves.length, disc: m.disc.map((x) => !!x), discLeft: m.disc.map((x) => (x ? Math.max(0, (m.graceMs || 0) - (Date.now() - x)) : 0)), graceMs: m.graceMs || 0, tm: m.tmId || null,
    noElo: !m.rated && (!!m.botSide || m.players.some((p) => p.guest)), undo: m.undo && !m.tmId, undoReq: m.undoReq, rematch: [!!m.rematch[1], !!m.rematch[2]], table: m.tableKey ? Number(m.tableKey.split(':')[1]) : 0
  };
}
function sideOf(m, uid) { return m.players[0].uid === uid ? 1 : m.players[1].uid === uid ? 2 : 0; }
function broadcast(m) {
  for (let i = 0; i < 2; i++) {
    const p = m.players[i];
    if (p.uid) toUser(p.uid, { t: 'match', m: snapshot(m, i + 1) });
  }
  if (m.watchers.size) { const s = { t: 'match', m: snapshot(m, 0) }; for (const c of m.watchers) send(c, s); }
}

/* ---------- start partii ---------- */
function humanInfo(uid, gid) {
  const u = D.get('SELECT id,nick,hue,guest FROM users WHERE id=?', uid);
  return { uid: u.id, nick: u.nick, hue: u.hue, guest: !!u.guest, rating: G.ratingValue(uid, gid) };
}
function startMatch({ game, p1, p2, rated, mode, tmId, clock, undo, tableKey, priv }) {
  const eng = G.engineOf(game);
  const humans = [p1, p2].filter((p) => !p.bot).length;
  rated = !!rated && humans === 2 && !p1.guest && !p2.guest && !!game.rated && !tmId;
  const botSide = p1.bot ? 1 : p2.bot ? 2 : 0;
  const now = D.now();
  const botP = botSide ? (p1.bot ? p1 : p2) : null;
  const id = D.run('INSERT INTO matches(game_id,p1,p2,bot_level,bot_side,rated,mode,started_at,tm_id,bot_nick) VALUES(?,?,?,?,?,?,?,?,?,?)',
    game.id, p1.uid || null, p2.uid || null, botP ? botP.bot : null, botSide, rated ? 1 : 0, mode, now, tmId || null, botP && botP.nick ? botP.nick : null).id;
  const ms = (clock ? clock.sec : game.time_sec) * 1000;           // zegar z ustawień stołu albo z gry
  const turnMs = clock && clock.mode === 'turn' ? ms : 0;            // tryb „czas na turę”: zegar gracza wraca do pełnej wartości po jego ruchu
  const m = {
    id, game, eng, state: eng.init(), players: [p1, p2], rated, mode, status: 'playing', moves: [], result: null, drawOffer: null,
    clocks: ms ? [botSide === 1 ? null : ms, botSide === 2 ? null : ms] : [null, null], turnStart: now, started: now,
    watchers: new Set(), disc: [null, null], discTimers: [null, null], tmId: tmId || null, botSide, chatAt: {},
    turnMs, incMs: clock ? 0 : game.inc_sec * 1000, clockCfg: clock || null, tableKey: tableKey || null, priv: !!priv, hist: [], undoReq: null, rematch: {}, pauseStart: null,
    undo: undo != null ? !!undo : (mode === 'bot' || mode === 'room')
  };
  matches.set(id, m);
  for (const p of [p1, p2]) if (p.uid) userMatch.set(p.uid, id);
  for (const p of [p1, p2]) if (p.uid) leaveQueue(p.uid);
  broadcast(m);
  if (tableKey) T.attach(tableKey, m);
  maybeBot(m);
  return m;
}

/* ---------- boty ---------- */
function maybeBot(m) {
  if (m.status !== 'playing' || !m.botSide || m.state.t !== m.botSide) return;
  const ply = m.moves.length;
  const level = m.players[m.botSide - 1].bot;
  const human = m.players[m.botSide - 1].disguised;      // bot udający gracza „myśli” dłużej
  const delay = human ? 900 + Math.floor(Math.random() * 1700) : 350 + Math.floor(Math.random() * 450);
  const t0 = Date.now();
  AI.move(m.game.engine, G.parseParams(m.game), m.state, level).then((mv) => {
    const wait = Math.max(0, delay - (Date.now() - t0));
    setTimeout(() => {
      if (m.status !== 'playing' || m.moves.length !== ply || m.state.t !== m.botSide) return;
      if (mv == null) return endMatch(m, 3 - m.botSide, 'bot bez ruchu');
      applyMove(m, m.botSide, mv, true);
    }, wait);
  });
}

/* ---------- ruchy ---------- */
function applyMove(m, side, move, isBot) {
  if (m.status !== 'playing' || m.state.t !== side) return 'Nie Twoja kolej';
  if (!m.botSide && (m.disc[0] || m.disc[1])) return 'Przeciwnik się rozłączył – partia czeka na jego powrót';
  const key = m.eng.mkey(move);
  const list = m.eng.legal(m.state), idx = list.findIndex((x) => m.eng.mkey(x) === key);
  if (idx < 0) return 'Niedozwolony ruch';
  const legal = list[idx];
  const now = Date.now();
  m.hist.push({ state: structuredClone(m.state), clocks: m.clocks.slice(), n: m.moves.length, t: side });   // do cofania ruchów
  if (m.hist.length > 300) m.hist.shift();
  if (m.clocks[side - 1] != null) {
    m.clocks[side - 1] -= now - m.turnStart;
    if (m.clocks[side - 1] <= 0) { m.clocks[side - 1] = 0; m.hist.pop(); endMatch(m, 3 - side, m.turnMs ? 'bezczynność' : 'czas'); return null; }
    m.clocks[side - 1] = m.turnMs ? m.turnMs : m.clocks[side - 1] + m.incMs;
  }
  m.state = m.eng.play(m.state, legal);
  m.moves.push(legal);
  m.turnStart = now;
  m.drawOffer = null; m.undoReq = null;
  const r = m.eng.result(m.state);
  if (r) { endMatch(m, r.winner, r.reason, r); return null; }
  broadcast(m);
  maybeBot(m);
  return null;
}

/** Cofnięcie ostatniego ruchu gracza `side`: przywracamy stan sprzed tego ruchu (razem z zegarami). */
function doUndo(m, side) {
  let i = m.hist.length - 1; while (i >= 0 && m.hist[i].t !== side) i--;
  if (i < 0) return;
  const h = m.hist[i]; m.hist.length = i;
  m.state = h.state; m.moves.length = h.n; m.clocks = h.clocks; m.turnStart = Date.now();
  m.drawOffer = null; m.undoReq = null;
  broadcast(m); maybeBot(m);
}

/* ---------- koniec partii ---------- */
const RAGE_PENALTY = Number(process.env.RAGE_PENALTY) || 30;   // dodatkowa kara ELO za ucieczkę z rankingowej partii
function endMatch(m, winner, reason, extra) {
  if (m.status === 'over') return;
  m.status = 'over';
  const [a, b] = m.players;
  const neutral = !!(extra && extra.neutral);        // zakończenie bez rozstrzygnięcia (obustronne rozłączenie): bez rankingu, XP i kar
  const rated = m.rated && !a.bot && !b.bot && !neutral;
  const deltas = [0, 0], ratings = [a.rating, b.rating];
  const outcomeFor = (side) => (winner === 0 ? 0 : winner === side ? 1 : -1);
  try { D.tx(() => {
    if (rated) {
      const ra = G.ratingOf(a.uid, m.game.id), rb = G.ratingOf(b.uid, m.game.id);
      const sa = winner === 0 ? 0.5 : winner === 1 ? 1 : 0;
      deltas[0] = G.eloDelta(ra.rating, rb.rating, sa, ra.games);
      deltas[1] = G.eloDelta(rb.rating, ra.rating, 1 - sa, rb.games);
      [[a, ra, 0, 1], [b, rb, 1, 2]].forEach(([p, r, i, side]) => {
        if (extra && extra.rage === side) deltas[i] -= RAGE_PENALTY;   // kara za ucieczkę: dodatkowe punkty ujemne
        const o = outcomeFor(side), nr = Math.max(100, r.rating + deltas[i]);
        deltas[i] = nr - r.rating;
        const streak = o === 1 ? r.streak + 1 : 0;
        D.run(`UPDATE ratings SET rating=?,games=games+1,wins=wins+?,losses=losses+?,draws=draws+?,streak=?,best_streak=MAX(best_streak,?),peak=MAX(peak,?),updated_at=? WHERE user_id=? AND game_id=?`,
          nr, o === 1 ? 1 : 0, o === -1 ? 1 : 0, o === 0 ? 1 : 0, streak, streak, nr, D.now(), p.uid, m.game.id);
        D.run('INSERT INTO events(user_id,game_id,ts,outcome,pts,delta,league_pts) VALUES(?,?,?,?,?,?,?)',
          p.uid, m.game.id, D.now(), o, o === 1 ? 3 : o === 0 ? 1 : 0, deltas[i], o === 1 ? 25 : o === 0 ? 10 : -8);
        ratings[i] = nr;
      });
    }
    if (extra && extra.rage) { const rq = extra.rage === 1 ? a : b; if (rq.uid) D.run('UPDATE users SET rage_quits_count=rage_quits_count+1 WHERE id=?', rq.uid); }
    [[a, 1], [b, 2]].forEach(([p, side]) => {
      if (!p.uid || reason === 'porzucona' || neutral) return;
      const o = outcomeFor(side);
      D.run('UPDATE users SET xp=xp+? WHERE id=?', o === 1 ? 25 : o === 0 ? 10 : 5, p.uid);
    });
    D.run('UPDATE matches SET result=?,reason=?,moves=?,ended_at=?,d1=?,d2=?,r1=?,r2=?,rated=? WHERE id=?',
      winner, reason, JSON.stringify(m.moves), D.now(), deltas[0], deltas[1], rated ? ratings[0] : null, rated ? ratings[1] : null, m.rated && !neutral ? 1 : 0, m.id);
  }); } catch (e) {            // awaria zapisu (np. blokada bazy): partia i tak się kończy, a gracze nie zostają uwięzieni w „trwającej” partii
    console.error('endMatch: zapis wyniku nieudany, partia #' + m.id, e.message); deltas[0] = deltas[1] = 0; ratings[0] = a.rating; ratings[1] = b.rating;
  }
  m.result = { winner, reason, rage: extra && extra.rage || 0, line: extra && extra.line, score: extra && extra.score, deltas: rated ? deltas : null, ratings: rated ? ratings : null };
  if (rated) { a.rating = ratings[0]; b.rating = ratings[1]; }
  m.drawOffer = null;
  for (const t of m.discTimers) clearTimeout(t);
  broadcast(m);
  for (const p of m.players) if (p.uid && userMatch.get(p.uid) === m.id) userMatch.delete(p.uid);
  if (T) T.onMatchEnd(m);
  if (hooks.matchEnd) { try { hooks.matchEnd(m); } catch (e) { console.error('matchEnd hook', e); } }
  setTimeout(() => matches.delete(m.id), 120000).unref();
}

/* ---------- zegary ---------- */
setInterval(() => {
  const now = Date.now();
  for (const m of matches.values()) {
    if (m.status !== 'playing') continue;
    if (!m.botSide && m.pauseStart) continue;                     // zegary stoją, gdy ktoś jest rozłączony
    const side = m.state.t, c = m.clocks[side - 1];
    if (c != null && c - (now - m.turnStart) <= 0) { m.clocks[side - 1] = 0; endMatch(m, 3 - side, m.turnMs ? 'bezczynność' : 'czas'); }
  }
}, 1000).unref();

/* ---------- kolejka i pokoje ---------- */
const qkey = (gid, rated) => gid + '|' + (rated ? 1 : 0);
function leaveQueue(uid) {
  for (const q of queues.values()) q.delete(uid);
}
function tryMatch(key) {
  const q = queues.get(key);
  if (!q || q.size < 2) return;
  const now = Date.now(), arr = Array.from(q.values()).sort((x, y) => x.since - y.since);
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      const win = 100 + 30 * (Math.max(now - a.since, now - b.since) / 1000);
      if (D.blockedEither(a.uid, b.uid)) continue;        // blokada użytkownika wyklucza parę z automatycznego dobierania
      if (Math.abs(a.rating - b.rating) <= win && a.uid !== b.uid) {
        q.delete(a.uid); q.delete(b.uid);
        const game = G.gameById(a.gid);
        if (!G.playable(game)) return;
        const flip = Math.random() < 0.5;
        const pa = humanInfo(a.uid, a.gid), pb = humanInfo(b.uid, a.gid);
        startMatch({ game, p1: flip ? pa : pb, p2: flip ? pb : pa, rated: a.rated, mode: 'queue' });
        return tryMatch(key);
      }
    }
  }
}
setInterval(() => { for (const k of queues.keys()) tryMatch(k); }, 2000).unref();
setInterval(() => { const now = Date.now(); for (const [code, r] of rooms) if (now - r.createdAt > 20 * 60000) rooms.delete(code); }, 60000).unref();

/* stoły (lobby przed partią) – patrz server/tables.js */
let T = null;

function roomCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += ch[Math.floor(Math.random() * ch.length)]; if (!rooms.has(c)) return c; }
}

/* ---------- połączenia ---------- */
function activeFor(uid) { const id = userMatch.get(uid); return id ? matches.get(id) : null; }

/** Gracz wrócił w czasie karencji: gra rusza dalej od momentu przerwania (zegary były zatrzymane). */
function resumeSide(m, side) {
  if (!m.disc[side - 1]) return;
  clearTimeout(m.discTimers[side - 1]); m.disc[side - 1] = null;
  if (!m.disc[0] && !m.disc[1] && m.pauseStart) { m.turnStart += Date.now() - m.pauseStart; m.pauseStart = null; }
  maybeBot(m);
}

/* ---------- czat: cenzura + limit (1 wiadomość / 1,5 s) – wspólne dla czatu partii i stołu ---------- */
const chatAt = new Map();
function chatCheck(u, text, quick) {
  if (u.guest) return { msg: GUEST_CHAT_MSG, code: 'guest' };      // całkowity zakaz pisania dla gości (także szybkie wiadomości)
  if (u.muted_until === -1 || u.muted_until > Date.now()) return { msg: 'Masz wyciszony czat', code: 'muted' };
  const now = Date.now();
  if (now - (chatAt.get(u.id) || 0) < 1500) return { msg: 'Pisz wolniej – maksymalnie 1 wiadomość na 1,5 s', code: 'rate' };
  chatAt.set(u.id, now); if (chatAt.size > 5000) for (const [k, v] of chatAt) if (now - v > 60000) chatAt.delete(k);
  if (!quick && CENSOR.isProfane(text)) return { msg: 'Twoja wiadomość zawiera niedozwolone słowa', code: 'censored' };
  return null;
}

function onDisconnect(conn) {
  const uid = conn.user.id, set = conns.get(uid);
  if (set) { set.delete(conn); if (!set.size) conns.delete(uid); }
  for (const m of matches.values()) m.watchers.delete(conn);
  if (conns.has(uid)) return;
  leaveQueue(uid);
  for (const [code, r] of rooms) if (r.uid === uid) rooms.delete(code);
  T.onDisconnect(uid);
  const m = activeFor(uid);
  if (!m || m.status !== 'playing') return;
  const side = sideOf(m, uid);
  if (!side) return;
  m.disc[side - 1] = Date.now();
  const humanOpp = !m.botSide;
  const grace = humanOpp ? (D.sNum('disconnect_grace_sec') || 60) * 1000 : 10 * 60000;
  m.graceMs = grace;
  if (humanOpp && !m.pauseStart) m.pauseStart = Date.now();
  broadcast(m);
  const expire = () => {
    if (m.status !== 'playing' || !m.disc[side - 1]) return;
    if (!humanOpp) return endMatch(m, m.botSide, 'porzucona');
    const opp = 3 - side;
    if (!m.disc[opp - 1] || m.tmId) return endMatch(m, opp, 'rozłączenie', { rage: side });   // rywal jest połączony: walkower i kara jak dotąd (turnieje: bez zmian)
    /* Rywal też jest nieobecny – nikt na nikogo nie czekał. Czekamy do końca JEGO karencji: jeśli wróci, uciekinierem pozostaje ten, kto przekroczył limit;
       jeśli nie wróci, partia kończy się bez rozstrzygnięcia (bez zwycięzcy, kary, ELO i XP). Timer zajmuje to samo miejsce w m.discTimers, więc powrót gracza lub endMatch go anuluje. */
    const left = grace - (Date.now() - m.disc[opp - 1]);
    if (left > 0) { m.discTimers[side - 1] = setTimeout(expire, left); m.discTimers[side - 1].unref(); return; }
    endMatch(m, 0, 'obustronne rozłączenie', { neutral: true });
  };
  m.discTimers[side - 1] = setTimeout(expire, grace);
  m.discTimers[side - 1].unref();
}

function handle(conn, msg) {
  const u = conn.user, uid = u.id;
  const err = (text) => send(conn, { t: 'error', msg: text });
  const fresh = D.get('SELECT banned_until,muted_until,guest,token_version,deleted_at FROM users WHERE id=?', uid);
  if (!fresh || fresh.deleted_at || A.banState(fresh).banned) return conn.ws.close(4003);
  if ((fresh.token_version || 0) !== conn.ver) { send(conn, { t: 'error', msg: 'Sesja wygasła – zaloguj się ponownie', fatal: true }); return conn.ws.close(4001); }   // hasło zmienione / wylogowanie
  u.guest = fresh.guest; u.muted_until = fresh.muted_until;
  /* stoły: wszystkie zdarzenia table_* obsługuje server/tables.js (uprawnienia sprawdzane po stronie serwera) */
  if (msg.t === 'tables' || (typeof msg.t === 'string' && msg.t.startsWith('table_'))) { T.handle(conn, msg, u, err); return; }
  if (['queue', 'bot', 'room_create', 'room_join'].includes(msg.t) && !activeFor(uid)) T.leave(uid, { silent: true });
  switch (msg.t) {
    case 'ping': return send(conn, { t: 'pong' });
    case 'queue': {
      if (D.sBool('maintenance')) return err(D.settings().maintenance_msg);
      const game = G.gameBySlug(String(msg.game || ''));
      if (!G.playable(game)) return err('Ta gra jest niedostępna');
      if (activeFor(uid)) return err('Masz już trwającą partię');
      const rated = !!msg.rated && !u.guest && !!game.rated;
      if (msg.rated && u.guest) send(conn, { t: 'notice', msg: 'Jako gość grasz partie nierankingowe. Załóż konto, aby wejść do rankingu.' });
      leaveQueue(uid);
      const key = qkey(game.id, rated);
      if (!queues.has(key)) queues.set(key, new Map());
      queues.get(key).set(uid, { uid, gid: game.id, rated, rating: G.ratingValue(uid, game.id), since: Date.now() });
      send(conn, { t: 'queued', game: game.slug, rated });
      tryMatch(key);
      return;
    }
    case 'unqueue': leaveQueue(uid); return send(conn, { t: 'unqueued' });
    case 'bot': {
      const game = G.gameBySlug(String(msg.game || ''));
      if (!G.playable(game) || !game.bots) return err('Ta gra nie ma botów');
      if (activeFor(uid)) return err('Masz już trwającą partię');
      const lv = BOTS[msg.level] ? msg.level : 'm';
      const me = humanInfo(uid, game.id), bot = { bot: lv };
      const side = msg.side === '1' ? 1 : msg.side === '2' ? 2 : (Math.random() < 0.5 ? 1 : 2);
      leaveQueue(uid);
      startMatch({ game, p1: side === 1 ? me : bot, p2: side === 1 ? bot : me, rated: false, mode: 'bot' });
      return;
    }
    case 'room_create': {
      const game = G.gameBySlug(String(msg.game || ''));
      if (!G.playable(game)) return err('Ta gra jest niedostępna');
      if (activeFor(uid)) return err('Masz już trwającą partię');
      for (const [code, r] of rooms) if (r.uid === uid) rooms.delete(code);
      leaveQueue(uid);
      const code = roomCode();
      rooms.set(code, { code, gid: game.id, uid, rated: !!msg.rated && !u.guest && !!game.rated, createdAt: Date.now() });
      return send(conn, { t: 'room', code, game: game.slug, rated: rooms.get(code).rated });
    }
    case 'room_cancel': for (const [code, r] of rooms) if (r.uid === uid) rooms.delete(code); return send(conn, { t: 'room_closed' });
    case 'room_join': {
      const code = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) return err('Nie ma takiego pokoju. Sprawdź kod.');
      if (r.uid === uid) return err('To Twój własny pokój');
      if (activeFor(uid)) return err('Masz już trwającą partię');
      if (!conns.has(r.uid) || activeFor(r.uid)) { rooms.delete(code); return err('Pokój jest już zamknięty'); }
      const game = G.gameById(r.gid);
      if (!G.playable(game)) return err('Ta gra jest niedostępna');
      rooms.delete(code);
      const a = humanInfo(r.uid, game.id), b = humanInfo(uid, game.id), flip = Math.random() < 0.5;
      startMatch({ game, p1: flip ? a : b, p2: flip ? b : a, rated: r.rated && !u.guest, mode: 'room' });
      return;
    }
    case 'move': {
      const m = matches.get(msg.id);
      if (!m) return err('Partia już się zakończyła');
      const side = sideOf(m, uid);
      if (!side) return err('To nie Twoja partia');
      const e = applyMove(m, side, msg.move, false);
      if (e) { err(e); send(conn, { t: 'match', m: snapshot(m, side) }); }
      return;
    }
    case 'resign': {
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.status !== 'playing') return;
      return endMatch(m, 3 - side, 'poddanie');
    }
    case 'draw': {
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.status !== 'playing') return;
      if (m.botSide) return send(conn, { t: 'notice', msg: 'Bot nie przyjmuje remisu. Graj dalej albo się poddaj.' });
      if (m.drawOffer === 3 - side) return endMatch(m, 0, 'zgoda na remis');
      m.drawOffer = side;
      return broadcast(m);
    }
    case 'draw_decline': {
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.drawOffer !== 3 - side) return;
      m.drawOffer = null;
      return broadcast(m);
    }
    case 'chat': case 'quick': {
      const m = matches.get(msg.id);
      if (!m) return;
      const side = sideOf(m, uid), quick = msg.t === 'quick';
      if (!side && !m.watchers.has(conn)) return;          // tylko uczestnicy i widzowie tej partii mogą pisać (nie można wysyłać wiadomości do cudzych partii)
      const text = quick ? TQ[parseInt(msg.q, 10)] : String(msg.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
      if (!text) return;
      const bad = chatCheck(u, text, quick);
      if (bad) return send(conn, { t: 'error', msg: bad.msg, code: bad.code });   // wiadomość NIE trafia do pozostałych graczy
      const out = { t: 'chat', id: m.id, nick: u.nick, side, text, ts: Date.now(), quick };
      for (const p of m.players) if (p.uid && !D.isBlocked(p.uid, uid)) toUser(p.uid, out);   // odbiorca, który zablokował nadawcę, nie widzi wiadomości
      for (const c of m.watchers) send(c, out);
      return;
    }
    case 'undo_req': {          // prośba o cofnięcie ostatniego ruchu (wymaga zgody przeciwnika; bot zgadza się od razu)
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.status !== 'playing') return;
      if (!m.undo || m.tmId) return err('Cofanie ruchów jest wyłączone przy tym stole');
      if (!m.hist.some((h) => h.t === side)) return err('Nie masz ruchu do cofnięcia');
      if (m.undoReq) return;
      if (m.botSide) return doUndo(m, side);
      m.undoReq = side; return broadcast(m);
    }
    case 'undo_reply': {
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.status !== 'playing' || m.undoReq !== 3 - side) return;
      if (msg.accept && m.undo) return doUndo(m, 3 - side);
      toUser(m.players[m.undoReq - 1].uid, { t: 'notice', msg: 'Przeciwnik odrzucił prośbę o cofnięcie ruchu' });
      m.undoReq = null; return broadcast(m);
    }
    case 'rematch': {           // rewanż: gdy obaj gracze zechcą, nowa partia z zamienionymi stronami i tymi samymi ustawieniami
      const m = matches.get(msg.id), side = m && sideOf(m, uid);
      if (!m || !side || m.status !== 'over' || m.tmId || m.botSide) return;
      m.rematch[side] = true;
      if (!(m.rematch[1] && m.rematch[2])) return broadcast(m);
      const [a, b] = m.players;
      if (activeFor(a.uid) || activeFor(b.uid)) return err('Ktoś rozpoczął już inną partię');
      m.rematch = {};
      startMatch({ game: m.game, p1: humanInfo(b.uid, m.game.id), p2: humanInfo(a.uid, m.game.id), rated: m.rated, mode: m.mode, clock: m.clockCfg, undo: m.undo, tableKey: m.tableKey, priv: m.priv });
      return;
    }
    case 'watch': {
      const m = matches.get(msg.id);
      if (!m || m.mode === 'bot' || m.botSide || m.priv) return err('Tej partii nie można oglądać');
      if (sideOf(m, uid)) return;
      m.watchers.add(conn);
      return send(conn, { t: 'match', m: snapshot(m, 0) });
    }
    case 'unwatch': { const m = matches.get(msg.id); if (m) m.watchers.delete(conn); return; }
    case 'tm_ready': if (hooks.tmReady) hooks.tmReady(uid, Number(msg.id), (e) => err(e)); return;
    default:
  }
}

const LIMITS = { perUser: 6, perIp: Number(process.env.WS_PER_IP) || 40, total: Number(process.env.MAX_WS) || 5000, burst: 30, perSec: 10, maxDrops: 100 };
const ipConns = new Map();
function handleUpgrade(req, socket) {
  /* 1) Origin: strona z obcej domeny nie otworzy gniazda w imieniu użytkownika (ochrona przed Cross-Site WebSocket Hijacking) */
  if (!originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  /* 2) limity połączeń: łącznie i z jednego adresu */
  const ipa = clientIp(req);
  if (onlineSockets() >= LIMITS.total || (ipConns.get(ipa) || 0) >= LIMITS.perIp) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\n\r\n'); return socket.destroy(); }
  const url = new URL(req.url, 'http://x');
  const user = A.userFromToken(url.searchParams.get('token'));
  const ws = WS.upgrade(req, socket);
  if (!ws) return;
  const conn = { ws, user: null, alive: true, ip: ipa, ver: user ? (user.token_version || 0) : 0 };
  if (!user || A.banState(user).banned) { ws.send(JSON.stringify({ t: 'error', msg: 'Nieprawidłowa sesja', fatal: true })); setTimeout(() => ws.close(4001), 50); return; }
  ipConns.set(ipa, (ipConns.get(ipa) || 0) + 1);
  ws.on('close', () => { const n = (ipConns.get(ipa) || 1) - 1; if (n > 0) ipConns.set(ipa, n); else ipConns.delete(ipa); });
  conn.user = { id: user.id, nick: user.nick, guest: user.guest, muted_until: user.muted_until, role: user.role };
  if (!conns.has(user.id)) conns.set(user.id, new Set());
  const mine = conns.get(user.id);
  while (mine.size >= LIMITS.perUser) { const old = mine.values().next().value; mine.delete(old); old.ws.close(4008); }   // najstarsze połączenie ustępuje miejsca nowemu
  mine.add(conn);
  // wznowienie partii po rozłączeniu
  const m = activeFor(user.id);
  if (m) {
    const side = sideOf(m, user.id);
    resumeSide(m, side);
  }
  send(conn, { t: 'hello', online: onlineCount(), you: { id: user.id, nick: user.nick, guest: !!user.guest }, active: m ? snapshot(m, sideOf(m, user.id)) : null });
  if (m) broadcast(m);
  T.onConnect(conn, user.id);
  const bucket = { tokens: LIMITS.burst, at: Date.now(), drops: 0 };      // limit częstotliwości: seria 30 komunikatów, potem 10/s
  ws.on('message', (data) => {
    const nowT = Date.now();
    bucket.tokens = Math.min(LIMITS.burst, bucket.tokens + (nowT - bucket.at) * LIMITS.perSec / 1000); bucket.at = nowT;
    if (bucket.tokens < 1) { if (++bucket.drops > LIMITS.maxDrops) ws.close(1008); return; }
    bucket.tokens--;
    if (data.length > 4096) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(conn, msg); } catch (e) { console.error('ws handler', msg.t, e); send(conn, { t: 'error', msg: 'Błąd serwera' }); }
  });
  ws.on('close', () => onDisconnect(conn));
}

/* heartbeat + licznik online */
setInterval(() => {
  for (const set of conns.values()) for (const c of set) {
    if (!c.ws.alive) { c.ws.close(1001); continue; }
    c.ws.ping();
  }
  const n = onlineCount();
  if (n !== lastOnline) { lastOnline = n; for (const set of conns.values()) for (const c of set) send(c, { t: 'online', n }); }
}, 20000).unref();

/* ---------- API dla reszty serwera ---------- */
function liveMatches() {
  const out = [];
  for (const m of matches.values()) {
    if (m.status !== 'playing' || m.mode === 'bot' || m.botSide || m.priv) continue;
    out.push({ id: m.id, game: m.game.slug, gameName: m.game.name, hue: m.game.hue, icon: m.game.icon, players: m.players.map((p) => p.nick), moves: m.moves.length, rated: m.rated });
  }
  return out.sort((a, b) => b.moves - a.moves).slice(0, 20);
}
function perGameOnline() {
  const out = {};
  for (const m of matches.values()) if (m.status === 'playing') out[m.game.slug] = (out[m.game.slug] || 0) + m.players.filter((p) => p.uid).length;
  for (const [key, q] of queues) { const g = G.gameById(Number(key.split('|')[0])); if (g) out[g.slug] = (out[g.slug] || 0) + q.size; }
  return out;
}
const onlineSockets = () => { let n = 0; for (const s of conns.values()) n += s.size; return n; };
function closeAll() { for (const s of conns.values()) for (const c of s) { try { c.ws.close(1001); } catch (e) { /* ignore */ } } }
function kick(uid, reason) {
  for (const c of conns.get(uid) || []) { send(c, { t: 'error', msg: reason || 'Sesja zakończona', fatal: true }); c.ws.close(4003); }
}
function notify(uid, text, link) {
  D.run('INSERT INTO notifs(user_id,text,link,ts) VALUES(?,?,?,?)', uid, text, link || null, D.now());
  toUser(uid, { t: 'notif', text, link: link || null });
}
const stats = () => ({ online: onlineCount(), activeMatches: Array.from(matches.values()).filter((m) => m.status === 'playing').length, queued: Array.from(queues.values()).reduce((s, q) => s + q.size, 0), rooms: rooms.size });
const isOnline = (uid) => conns.has(uid);
function setHooks(h) { Object.assign(hooks, h); }

T = require('./tables')({ send, toUser, conns, G, D, humanInfo, startMatch, activeFor, matches, chatCheck, endMatch });
TQ = T.QUICK;

module.exports = { closeAll, GUEST_CHAT_MSG, handleUpgrade, startMatch, humanInfo, liveMatches, perGameOnline, kick, notify, stats, isOnline, setHooks, onlineCount, BOTS, activeFor, toUser };
