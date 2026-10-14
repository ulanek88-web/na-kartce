'use strict';
/* Stoły (lobby przed partią) – w pełni obsługiwane przez WebSocket.
 *  - host (korona): ustawienia, wyrzucanie, zaproszenia; po wyjściu hosta rola przechodzi na kolejnego gracza
 *  - stół publiczny / prywatny (PIN), progi rankingu (co 50 pkt), tryb rankingowy, cofanie ruchów, zegar (na turę / łączny)
 *  - gotowość graczy, czat stołowy z cenzurą i limitem, szybkie wiadomości, zaproszenia z pop-upem
 *  - boty CPU: opcja stołu „Zezwalaj na gry z CPU” (domyślnie włączona), ręczne dodanie bota na wolne miejsce oraz automatyczny bot
 *    (gdy samotny gracz czeka przy publicznym stole dłużej niż `bot_autojoin_sec`, domyślnie 120 s). Partie z botem nie dają ELO.
 * Wszystkie uprawnienia są sprawdzane po stronie serwera (klient tylko wysyła żądania).
 * Zdarzenia → klient: tables, table (pełny widok stołu), table_left, table_kicked, table_chat, table_invite, table_lobby. */
const crypto = require('crypto');

const PER_GAME = Math.max(4, Math.min(60, Number(process.env.TABLES_PER_GAME) || 20));
const QUICK = ['Twój ruch!', 'Dobra gra!', 'UPS!', 'Dzięki!', 'Powodzenia!', 'Szybciej, proszę 🙂'];
const BOT_RATING = { e: 900, m: 1300, h: 1700 }, BOT_FALLBACK = { e: 'Bot Ania', m: 'Bot Marek', h: 'Bot Hektor' };
const NICK_OK = /^[A-Za-z0-9ĄąĆćĘęŁłŃńÓóŚśŹźŻż._-]{3,16}$/;
const KICK_BAN_MS = 5 * 60000, INVITE_TTL = 60000, VIEW_TTL = 15000;

module.exports = function createTables(ctx) {
  const { send, toUser, conns, G, D, humanInfo, startMatch, activeFor, matches, chatCheck, endMatch } = ctx;
  const tables = new Map();          // "gid:n" -> table
  const seat = new Map();            // uid -> klucz stołu
  const tkey = (gid, n) => gid + ':' + n;
  const now = () => Date.now();
  const eqPin = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  /* ---------- statystyki widoczne przy stole: ucieczki i % ukończonych gier ---------- */
  function stats(uid) {
    const u = D.get('SELECT rage_quits_count AS rq FROM users WHERE id=?', uid) || { rq: 0 };
    const tot = D.get('SELECT COUNT(*) AS c FROM matches WHERE (p1=? OR p2=?) AND bot_side=0 AND result IS NOT NULL', uid, uid).c;
    return { rage: u.rq, completed: tot ? Math.max(0, Math.round(100 * (tot - u.rq) / tot)) : 100 };
  }

  /* ---------- ustawienia ---------- */
  function defaults(game) { return { visibility: 'public', pin: '', minRating: 0, maxRating: 0, rated: false, undo: true, allowBots: true, clock: { mode: 'total', sec: game.time_sec || 300 } }; }
  /** Waliduje i scala ustawienia; rzuca string z komunikatem błędu. */
  function clean(raw, base, game, hostGuest) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const s = JSON.parse(JSON.stringify(base));
    if (raw.visibility != null) s.visibility = raw.visibility === 'private' ? 'private' : 'public';
    if (raw.pin != null) s.pin = String(raw.pin).trim();
    if (s.visibility === 'private') { if (!/^[A-Za-z0-9]{4,8}$/.test(s.pin)) throw 'Stół prywatny wymaga PIN-u (4–8 znaków: litery lub cyfry)'; } else s.pin = '';
    for (const k of ['minRating', 'maxRating']) {
      if (raw[k] == null) continue;
      const v = parseInt(raw[k], 10);
      if (!Number.isFinite(v) || v < 0 || v > 4000 || (v && v % 50)) throw 'Progi rankingu ustawia się co 50 pkt (0 = bez limitu)';
      s[k] = v;
    }
    if (s.minRating && s.maxRating && s.minRating > s.maxRating) throw 'Min. ranking nie może być większy niż max.';
    if (raw.rated != null) s.rated = !!raw.rated && !!game.rated && !hostGuest;
    if (raw.undo != null) s.undo = !!raw.undo;
    if (raw.allowBots != null) s.allowBots = !!raw.allowBots;
    if (raw.clock) {
      const mode = raw.clock.mode === 'turn' ? 'turn' : 'total', sec = parseInt(raw.clock.sec, 10);
      const [lo, hi] = mode === 'turn' ? [10, 300] : [60, 3600];
      if (!Number.isFinite(sec) || sec < lo || sec > hi) throw mode === 'turn' ? 'Czas na turę: 10–300 s' : 'Czas całkowity: 1–60 min';
      s.clock = { mode, sec };
    }
    return s;
  }

  /* ---------- boty CPU ---------- */
  const rnd = (n) => Math.floor(Math.random() * n);
  /** Bot siedzący przy stole (nie jest w t.ps – to nie konto). Losowy nick z listy (CMS: bot_names), losowy awatar, jak prawdziwy gracz. */
  function makeBot(level, t) {
    const lv = BOT_RATING[level] ? level : 'm', disguised = D.sBool('bot_disguise');
    const taken = new Set(t.ps.map((u) => humanInfo(u, t.gid).nick.toLowerCase()));
    const names = String(D.settings().bot_names || '').split(',').map((x) => x.trim()).filter((x) => NICK_OK.test(x) && !taken.has(x.toLowerCase()));
    const nick = disguised && names.length ? names[rnd(names.length)] : BOT_FALLBACK[lv];
    return { uid: -1, bot: lv, nick, hue: rnd(360), rating: BOT_RATING[lv] + (rnd(21) - 10) * 10, rage: rnd(2), completed: 90 + rnd(10), disguised: disguised && names.length > 0 };
  }
  const botPlayer = (b) => ({ bot: b.bot, nick: b.nick, hue: b.hue, rating: b.rating, disguised: b.disguised });
  /** Dlaczego partia przy tym stole nie da ELO: 'bot' | 'guest' | null (ikonka „Brak ELO”) */
  function eloOff(t) { if (t.bot) return 'bot'; if (t.ps.some((u) => humanInfo(u, t.gid).guest)) return 'guest'; return null; }
  function addBot(t, level, auto) {
    t.bot = makeBot(level, t); t.aloneSince = 0;
    sys(t, t.bot.nick + ' dosiadł się do stołu');
    sys(t, 'Partia z CPU nie przyznaje punktów ELO (Brak ELO).');
    push(t);
    if (auto) for (const uid of t.ps) toUser(uid, { t: 'notice', msg: 'Przeciwnik dołączył do stołu. Partie z CPU nie liczą się do rankingu ELO.' });
    tryStart(t);
  }
  function removeBot(t) { const b = t.bot; t.bot = null; if (b) sys(t, b.nick + ' opuścił stół'); }
  /** Matchmaking Auto-Bot: samotny gracz przy stole PUBLICZNYM czeka dłużej niż `bot_autojoin_sec` -> serwer dosadza bota. */
  function autoBots() {
    const sec = D.sNum('bot_autojoin_sec');
    if (!(sec > 0) || D.sBool('maintenance')) return;
    const n = now();
    for (const t of tables.values()) {
      const alone = !t.matchId && t.ps.length === 1 && !t.bot && t.settings.visibility === 'public' && t.settings.allowBots;
      if (!alone) { t.aloneSince = 0; continue; }
      if (!t.aloneSince) { t.aloneSince = n; continue; }
      if (n - t.aloneSince < sec * 1000) continue;
      const game = G.gameById(t.gid);
      if (!game || !game.bots || !G.playable(game) || activeFor(t.ps[0])) continue;
      addBot(t, D.settings().bot_auto_level, true);
    }
  }
  setInterval(autoBots, Number(process.env.BOT_SCAN_MS) || 5000).unref();

  /* ---------- widoki ---------- */
  const ranking = (t, uid) => G.ratingValue(uid, t.gid);
  function view(t, forUid) {
    const g = G.gameById(t.gid), s = t.settings;
    return {
      n: t.n, game: g.slug, gameName: g.name, host: t.host, you: forUid, status: t.matchId ? 'playing' : 'lobby', matchId: t.matchId,
      players: t.ps.map((uid) => { const i = humanInfo(uid, t.gid); return { uid, nick: i.nick, hue: i.hue, guest: i.guest, rating: i.rating, ready: !!t.ready[uid], host: uid === t.host, ...stats(uid) }; })
        .concat(t.bot ? [{ uid: -1, nick: t.bot.nick, hue: t.bot.hue, guest: false, rating: t.bot.rating, ready: true, host: false, rage: t.bot.rage, completed: t.bot.completed, cpu: !t.bot.disguised }] : []),
      eloOff: eloOff(t), botAllowed: !!s.allowBots && !!g.bots,
      settings: { visibility: s.visibility, hasPin: !!s.pin, pin: forUid === t.host ? s.pin : undefined, minRating: s.minRating, maxRating: s.maxRating, rated: s.rated, undo: s.undo, allowBots: s.allowBots, clock: s.clock },
      chat: t.chat.filter((c) => c.sys || c.uid === forUid || !D.isBlocked(forUid, c.uid)).slice(-30), quick: QUICK
    };
  }
  const push = (t) => { for (const uid of t.ps) toUser(uid, { t: 'table', table: view(t, uid) }); };
  const sys = (t, text) => { t.chat.push({ sys: true, text, ts: now() }); if (t.chat.length > 60) t.chat.shift(); };

  /** Czy `uid` może dołączyć? -> 'ok' | 'full' | 'rating' | 'pin' | 'banned' | 'playing' */
  function joinState(t, uid, bypassPin) {
    if (t.ps.includes(uid)) return 'ok';
    if (t.matchId) return 'playing';
    if (t.ps.length >= 2) return 'full';
    if ((t.banned.get(uid) || 0) > now()) return 'banned';
    const s = t.settings, r = ranking(t, uid);
    if ((s.minRating && r < s.minRating) || (s.maxRating && r > s.maxRating)) return 'rating';
    if (s.pin && !bypassPin) return 'pin';
    return 'ok';
  }
  function list(game, uid) {
    const out = [];
    for (let n = 1; n <= PER_GAME; n++) {
      const t = tables.get(tkey(game.id, n));
      if (!t) { out.push({ n, st: 'free' }); continue; }
      const s = t.settings, st = t.matchId ? 'playing' : 'waiting', js = joinState(t, uid, false);
      out.push({ n, st, priv: !!s.pin, minR: s.minRating, maxR: s.maxRating, rated: s.rated, undo: s.undo, clock: s.clock,
        eloOff: eloOff(t), bots: !!s.allowBots,
        players: t.ps.map((p) => { const i = humanInfo(p, t.gid); return { nick: i.nick, rating: i.rating, ready: !!t.ready[p], host: p === t.host }; })
          .concat(t.bot ? [{ nick: t.bot.nick, rating: t.bot.rating, ready: true, host: false }] : []),
        join: js === 'pin' ? 'ok' : js, needPin: !!s.pin && js === 'ok' || js === 'pin', mine: t.ps.includes(uid) });
    }
    return out;
  }

  /* ---------- operacje ---------- */
  function create(game, uid) {
    const t = { gid: game.id, n: 0, host: uid, ps: [uid], ready: {}, settings: defaults(game), chat: [], matchId: 0, banned: new Map(), invited: new Map(), fails: new Map() };
    return t;
  }
  function join(t, uid, silent) {
    t.ps.push(uid); t.ready[uid] = false; seat.set(uid, tkey(t.gid, t.n));
    if (!silent) sys(t, humanInfo(uid, t.gid).nick + ' dosiadł się do stołu');
    push(t);
  }
  /** Opuszczenie stołu. Podczas partii oznacza poddanie. Host przekazywany kolejnej osobie. */
  function leave(uid, opts) {
    const key = seat.get(uid); const t = key && tables.get(key); if (!t) return false;
    if (t.matchId) {
      const m = matches.get(t.matchId), side = m && m.players[0].uid === uid ? 1 : m && m.players[1].uid === uid ? 2 : 0;
      if (m && m.status === 'playing' && side) endMatch(m, 3 - side, 'poddanie');
    }
    t.ps = t.ps.filter((x) => x !== uid); delete t.ready[uid]; seat.delete(uid);
    if (!(opts && opts.silent)) toUser(uid, { t: 'table_left' });
    if (!t.ps.length) { tables.delete(key); return true; }
    if (t.host === uid) { t.host = t.ps[0]; sys(t, humanInfo(t.host, t.gid).nick + ' został nowym hostem 👑'); }
    for (const p of t.ps) t.ready[p] = false;
    push(t); return true;
  }
  function tryStart(t) {
    if (t.matchId || t.ps.length + (t.bot ? 1 : 0) < 2 || !t.ps.every((u) => t.ready[u])) return;
    const game = G.gameById(t.gid); if (!G.playable(game)) return;
    if (t.ps.some((u) => activeFor(u))) return;
    const flip = Math.random() < 0.5, [a, b] = t.ps.map((u) => humanInfo(u, t.gid)).concat(t.bot ? [botPlayer(t.bot)] : []);
    const m = startMatch({ game, p1: flip ? a : b, p2: flip ? b : a, rated: t.settings.rated, mode: 'table', clock: t.settings.clock, undo: t.settings.undo, tableKey: tkey(t.gid, t.n), priv: t.settings.visibility === 'private' });
    if (m) { for (const u of t.ps) t.ready[u] = false; sys(t, 'Partia rozpoczęta'); }
  }
  function sit(uid, game, n, pin, bypass, conn, err) {
    if (!G.playable(game)) return err('Ta gra jest niedostępna');
    if (!(n >= 1 && n <= PER_GAME)) return err('Nie ma takiego stołu');
    if (activeFor(uid)) return err('Masz już trwającą partię');
    const key = tkey(game.id, n), cur = seat.get(uid);
    if (cur === key) { const t0 = tables.get(key); if (t0) return send(conn, { t: 'table', table: view(t0, uid) }); }
    if (cur) { const tc = tables.get(cur); if (tc && tc.matchId) return err('Najpierw zakończ partię przy swoim stole'); leave(uid, { silent: true }); }
    let t = tables.get(key);
    if (!t) { t = create(game, uid); t.n = n; tables.set(key, t); seat.set(uid, key); sys(t, 'Stół utworzony – host: ' + humanInfo(uid, game.id).nick + ' 👑'); push(t); return; }
    const js = joinState(t, uid, bypass);
    if (js === 'pin') {
      const f = t.fails.get(uid) || { c: 0, until: 0 };
      if (f.until > now()) return err('Zbyt wiele prób PIN-u – spróbuj za chwilę');
      if (!pin || !eqPin(pin, t.settings.pin)) { f.c++; if (f.c >= 5) { f.c = 0; f.until = now() + 60000; } t.fails.set(uid, f); return err(pin ? 'Nieprawidłowy PIN' : 'Ten stół wymaga PIN-u'); }
      t.fails.delete(uid);
    } else if (js === 'rating') return err('Ten stół wymaga rankingu ' + (t.settings.minRating || '0') + '–' + (t.settings.maxRating || '∞'));
    else if (js === 'full') return err('Stół jest pełny');
    else if (js === 'playing') return err('Przy stole trwa już gra');
    else if (js === 'banned') return err('Zostałeś wyproszony z tego stołu – spróbuj później');
    if (t.bot) removeBot(t);        // prawdziwy gracz zawsze ma pierwszeństwo przed botem (przed startem partii)
    join(t, uid);
  }

  /* ---------- obsługa komunikatów ---------- */
  function mine(uid) { const k = seat.get(uid); return k && tables.get(k); }
  function handle(conn, msg, u, err) {
    const uid = u.id;
    switch (msg.t) {
      case 'tables': {
        const game = G.gameBySlug(String(msg.game || '')); if (!G.playable(game)) return err('Ta gra jest niedostępna');
        conn.view = { slug: game.slug, ts: now() };
        return send(conn, { t: 'tables', game: game.slug, list: list(game, uid), you: ratingFor(uid, game.id) });
      }
      case 'table_sit': {
        if (D.sBool('maintenance')) return err(D.settings().maintenance_msg);
        return sit(uid, G.gameBySlug(String(msg.game || '')), parseInt(msg.n, 10), msg.pin, false, conn, err);
      }
      case 'table_leave': return leave(uid) || send(conn, { t: 'table_left' });
      case 'table_set': {
        const t = mine(uid); if (!t) return err('Nie siedzisz przy stole');
        if (t.host !== uid) return err('Tylko host może zmieniać ustawienia');
        if (t.matchId) return err('Ustawień nie zmienisz w trakcie partii');
        try { t.settings = clean(msg.settings, t.settings, G.gameById(t.gid), !!u.guest); } catch (e) { if (typeof e === 'string') return err(e); throw e; }
        for (const p of t.ps) t.ready[p] = false;
        // gracze spoza nowych progów rankingu opuszczają stół (poza hostem)
        for (const p of t.ps.slice()) if (p !== t.host && joinState({ ...t, ps: [], matchId: 0, banned: new Map() }, p, true) === 'rating') { toUser(p, { t: 'table_kicked', msg: 'Twój ranking nie spełnia nowych wymagań stołu' }); t.ps = t.ps.filter((x) => x !== p); delete t.ready[p]; seat.delete(p); }
        if (t.bot && !t.settings.allowBots) removeBot(t);
        sys(t, 'Host zmienił ustawienia stołu'); return push(t);
      }
      case 'table_ready': {
        const t = mine(uid); if (!t || t.matchId) return;
        t.ready[uid] = !!msg.ready; push(t); return tryStart(t);
      }
      case 'table_kick': {
        const t = mine(uid); if (!t) return err('Nie siedzisz przy stole');
        if (t.host !== uid) return err('Tylko host może wyprosić gracza');
        const target = parseInt(msg.uid, 10);
        if (target === -1 && t.bot) { if (t.matchId) return err('Nie można wyprosić gracza w trakcie partii'); removeBot(t); return push(t); }
        if (target === uid || !t.ps.includes(target)) return err('Nie ma takiego gracza przy stole');
        if (t.matchId) return err('Nie można wyprosić gracza w trakcie partii');
        t.ps = t.ps.filter((x) => x !== target); delete t.ready[target]; seat.delete(target); t.banned.set(target, now() + KICK_BAN_MS);
        toUser(target, { t: 'table_kicked', msg: 'Zostałeś wyproszony ze stołu' });
        for (const p of t.ps) t.ready[p] = false;
        sys(t, 'Gracz został wyproszony'); return push(t);
      }
      case 'table_add_bot': {      // gracz ręcznie dodaje CPU na wolne miejsce (poziom: e / m / h)
        const t = mine(uid); if (!t) return err('Nie siedzisz przy stole');
        const game = G.gameById(t.gid);
        if (t.matchId) return err('Partia już trwa');
        if (!game.bots || !t.settings.allowBots) return err('Gry z CPU są przy tym stole wyłączone');
        if (t.ps.length >= 2 || t.bot) return err('Stół jest pełny');
        return addBot(t, BOT_RATING[msg.level] ? msg.level : 'm', false);
      }
      case 'table_chat': case 'table_quick': {
        const t = mine(uid); if (!t) return;
        const quick = msg.t === 'table_quick', text = quick ? QUICK[parseInt(msg.id, 10)] : String(msg.text || '');
        if (quick && !text) return;
        const bad = chatCheck(u, text, quick); if (bad) return send(conn, { t: 'error', msg: bad.msg, code: bad.code });
        const c = { nick: u.nick, uid, text: text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140), ts: now(), quick };
        if (!c.text) return;
        t.chat.push(c); if (t.chat.length > 60) t.chat.shift();
        for (const p of t.ps) if (p === uid || !D.isBlocked(p, uid)) toUser(p, { t: 'table_chat', n: t.n, msg: c });   // zablokowany nadawca jest dla odbiorcy niewidoczny
        return;
      }
      case 'table_lobby': {          // lista graczy „w lobby gry” = ci, którzy w ostatnich 15 s oglądali stoły tej gry
        const t = mine(uid); if (!t) return err('Najpierw usiądź przy stole');
        const game = G.gameById(t.gid), out = [];
        for (const [id, set] of conns) {
          if (id === uid || seat.has(id) || activeFor(id) || D.blockedEither(id, uid)) continue;
          if (![...set].some((c) => c.view && c.view.slug === game.slug && now() - c.view.ts < VIEW_TTL)) continue;
          const i = humanInfo(id, game.id); out.push({ uid: id, nick: i.nick, rating: i.rating, hue: i.hue });
        }
        return send(conn, { t: 'table_lobby', list: out.slice(0, 50) });
      }
      case 'table_invite': {
        const t = mine(uid); if (!t) return err('Najpierw usiądź przy stole');
        if (t.matchId || t.ps.length >= 2) return err('Stół jest pełny');
        const target = parseInt(msg.uid, 10);
        if (!conns.has(target) || target === uid || seat.has(target) || activeFor(target) || D.isBlocked(target, uid)) return err('Ten gracz jest niedostępny');   // blokada: zaproszenia odrzucane bez ujawniania powodu
        if (now() - (t.lastInvite || 0) < 2000) return err('Poczekaj chwilę przed kolejnym zaproszeniem');
        t.lastInvite = now(); t.invited.set(target, now() + INVITE_TTL);
        const g = G.gameById(t.gid);
        toUser(target, { t: 'table_invite', from: { uid, nick: u.nick }, game: g.slug, gameName: g.name, n: t.n, needPin: !!t.settings.pin });
        return send(conn, { t: 'notice', msg: 'Zaproszenie wysłane' });
      }
      case 'table_invite_reply': {
        const game = G.gameBySlug(String(msg.game || '')), n = parseInt(msg.n, 10), t = game && tables.get(tkey(game.id, n));
        if (!t || (t.invited.get(uid) || 0) < now()) return err('Zaproszenie wygasło');
        t.invited.delete(uid);
        if (!msg.accept) { toUser(t.host, { t: 'notice', msg: u.nick + ' odrzucił zaproszenie' }); return; }
        return sit(uid, game, n, null, true, conn, err);   // zaproszenie omija PIN (ale nie próg rankingu)
      }
      default: return false;
    }
  }
  function ratingFor(uid, gid) { return G.ratingValue(uid, gid); }

  /* ---------- zdarzenia z reszty serwera ---------- */
  function attach(key, m) { const t = tables.get(key); if (t) { t.matchId = m.id; for (const u of t.ps) t.ready[u] = false; push(t); } }
  function onMatchEnd(m) {
    const t = m.tableKey && tables.get(m.tableKey); if (!t) return;
    t.matchId = 0;
    for (const uid of t.ps.slice()) if (!conns.has(uid)) { t.ps = t.ps.filter((x) => x !== uid); seat.delete(uid); }
    if (!t.ps.length) return tables.delete(m.tableKey);
    if (!t.ps.includes(t.host)) t.host = t.ps[0];
    for (const u of t.ps) t.ready[u] = false;
    push(t);
  }
  function onDisconnect(uid) { const t = mine(uid); if (t && !t.matchId) leave(uid, { silent: true }); }
  function onConnect(conn, uid) { const t = mine(uid); if (t) send(conn, { t: 'table', table: view(t, uid) }); }
  return { handle, leave, attach, onMatchEnd, onDisconnect, onConnect, autoBots, QUICK, PER_GAME };
};
