'use strict';
/* Publiczne API REST: konta, gry, lobby, rankingi, profile, reklamy, turnieje. */
const D = require('./db');
const G = require('./game');
const A = require('./auth');
const RT = require('./realtime');
const T = require('./tournaments');
const { HttpError, clientIp: ip } = require('./http');
const ACH = require('./achievements');

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };

function meView(u) {
  const ratings = D.all('SELECT r.*,g.slug,g.name FROM ratings r JOIN games g ON g.id=r.game_id WHERE r.user_id=? ORDER BY r.games DESC', u.id)
    .map((r) => ({ game: r.slug, gameName: r.name, rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, bestStreak: r.best_streak, peak: r.peak }));
  const unread = D.get('SELECT COUNT(*) AS n FROM notifs WHERE user_id=? AND read=0', u.id).n;
  return Object.assign(G.userPublic(u), { email: u.email, level: G.levelOfXp(u.xp), ratings, league: G.leagueFor(G.seasonPoints(u.id)), unread, achievements: ACH.forUser(u.id) });
}
function newToken(u) { return A.issue(u); }
function authResponse(u) { return { token: newToken(u), me: meView(u) }; }

function randomGuestNick() {
  for (let i = 0; i < 20; i++) {
    const n = 'Gość_' + (1000 + Math.floor(Math.random() * 9000));
    if (!D.get('SELECT 1 FROM users WHERE nick_lc=?', n.toLowerCase())) return n;
  }
  return 'Gość_' + Date.now().toString().slice(-7);
}
function checkCredentials(body) {
  const nick = str(body.nick, 16), email = str(body.email, 120).toLowerCase(), password = String(body.password || '');
  if (!A.validNick(nick)) throw new HttpError(400, 'Nick: 3–16 znaków (litery, cyfry, . _ -)');
  if (A.RESERVED.includes(nick.toLowerCase())) throw new HttpError(400, 'Ten nick jest zarezerwowany');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw new HttpError(400, 'Podaj poprawny adres e-mail');
  if (password.length < 8) throw new HttpError(400, 'Hasło musi mieć co najmniej 8 znaków');
  if (password.length > A.PASSWORD_MAX) throw new HttpError(400, 'Hasło może mieć do ' + A.PASSWORD_MAX + ' znaków');
  if (D.get('SELECT 1 FROM users WHERE nick_lc=?', nick.toLowerCase())) throw new HttpError(409, 'Ten nick jest już zajęty');
  if (D.get('SELECT 1 FROM users WHERE email_lc=?', email)) throw new HttpError(409, 'Ten e-mail jest już zarejestrowany');
  return { nick, email, password };
}

function matchRow(r, gamesById, meId) {
  const g = gamesById[r.game_id] || {};
  const nick = (id) => (id ? (D.get('SELECT nick FROM users WHERE id=?', id) || {}).nick : null);
  const bot = r.bot_level ? (r.bot_nick || ({ e: 'Bot Ania', m: 'Bot Marek', h: 'Bot Hektor' })[r.bot_level]) : null;
  const n1 = r.bot_side === 1 ? bot : nick(r.p1), n2 = r.bot_side === 2 ? bot : nick(r.p2);
  let outcome = null;
  if (meId && r.result != null) {
    const side = r.p1 === meId ? 1 : r.p2 === meId ? 2 : 0;
    outcome = r.result === 0 ? 'draw' : side === r.result ? 'win' : 'loss';
  }
  return { id: r.id, game: g.slug, gameName: g.name, icon: g.icon, hue: g.hue, p1: n1, p2: n2, result: r.result, reason: r.reason, rated: !!r.rated, mode: r.mode,
    endedAt: r.ended_at, startedAt: r.started_at, d1: r.d1, d2: r.d2, outcome, moves: undefined };
}
const gamesMap = () => { const o = {}; D.all('SELECT * FROM games').forEach((g) => { o[g.id] = g; }); return o; };

/* ---------- reklamy ---------- */
function eligibleAds(slot, gameSlug, user, device, ipAddr) {
  if (!D.sBool('ads_enabled')) return { ads: [], who: '', day: '' };
  const now = D.now(), day = new Date().toISOString().slice(0, 10);
  const g = gameSlug ? G.gameBySlug(gameSlug) : null;
  const who = user ? 'u' + user.id : 'ip' + ipAddr;
  const ads = D.all('SELECT * FROM ads WHERE enabled=1 AND slot=?', slot).filter((a) => {
    if (a.start_at && a.start_at > now) return false;
    if (a.end_at && a.end_at < now) return false;
    if (a.game_id && (!g || a.game_id !== g.id)) return false;
    if (a.audience === 'guests' && !(user && user.guest)) return false;
    if (a.audience === 'users' && !(user && !user.guest)) return false;
    if (a.device !== 'all' && a.device !== device) return false;
    if (a.max_per_day) { const v = D.get('SELECT n FROM ad_views WHERE ad_id=? AND who=? AND day=?', a.id, who, day); if (v && v.n >= a.max_per_day) return false; }
    return true;
  });
  return { ads, who, day };
}
const adCountView = (ad, who, day) => {
  D.run('UPDATE ads SET impressions=impressions+1 WHERE id=?', ad.id);
  D.run('INSERT INTO ad_views(ad_id,who,day,n) VALUES(?,?,?,1) ON CONFLICT(ad_id,who,day) DO UPDATE SET n=n+1', ad.id, who, day);
};
const adPublic = (ad) => ({ id: ad.id, slot: ad.slot, title: ad.title, text: ad.text, imageUrl: ad.image_url, linkUrl: ad.link_url, color: ad.color, advertiser: ad.advertiser, code: ad.kind === 'code' ? ad.code : '', slideSec: ad.slide_sec || 8 });
function pickAd(slot, gameSlug, user, device, ipAddr) {
  const { ads, who, day } = eligibleAds(slot, gameSlug, user, device, ipAddr);
  if (!ads.length) return null;
  const total = ads.reduce((s, a) => s + Math.max(1, a.weight), 0);
  let r = Math.random() * total, ad = ads[0];
  for (const a of ads) { r -= Math.max(1, a.weight); if (r <= 0) { ad = a; break; } }
  adCountView(ad, who, day);
  return adPublic(ad);
}

function register(r) {
  /* ----- konfiguracja i lobby ----- */
  r.get('/api/config', () => {
    const s = D.settings();
    return { siteName: s.site_name, tagline: s.tagline, allowGuests: s.allow_guests === '1', allowRegister: s.allow_register === '1',
      maintenance: s.maintenance === '1', maintenanceMsg: s.maintenance_msg, adsEnabled: s.ads_enabled === '1', forumEnabled: s.forum_enabled === '1', leagues: G.leagues() };
  });
  r.get('/api/games', () => {
    const per = RT.perGameOnline();
    return D.all("SELECT * FROM games WHERE is_active=1 ORDER BY sort_order,id").map((g) => Object.assign(G.gamePublic(g), { playing: per[g.slug] || 0 }));
  });
  r.get('/api/lobby', () => {
    const news = D.all("SELECT id,title,body,kind,pinned,created_at FROM news WHERE active=1 ORDER BY pinned DESC, created_at DESC LIMIT 6");
    return { online: RT.onlineCount(), news, live: RT.liveMatches(), per: RT.perGameOnline(), stats: RT.stats() };
  });
  r.get('/api/live', () => RT.liveMatches());
  r.get('/api/pages/:slug', (req, res, p) => {
    const pg = D.get('SELECT slug,title,body,updated_at FROM pages WHERE slug=?', p.slug);
    if (!pg) throw new HttpError(404, 'Nie ma takiej strony');
    return pg;
  });

  /* ----- konta ----- */
  r.post('/api/auth/guest', (req, res, p, body) => {
    A.rateLimit('guest:' + ip(req), 15, 3600000);
    if (!D.sBool('allow_guests')) throw new HttpError(403, 'Gra jako gość jest wyłączona');
    const nick = randomGuestNick(), now = D.now();
    const id = D.run('INSERT INTO users(nick,nick_lc,guest,hue,created_at,last_seen) VALUES(?,?,1,?,?,?)', nick, nick.toLowerCase(), Math.floor(Math.random() * 360), now, now).id;
    return authResponse(D.get('SELECT * FROM users WHERE id=?', id));
  });
  r.post('/api/auth/register', async (req, res, p, body) => {
    A.rateLimit('reg:' + ip(req), Number(process.env.RATE_REG_MAX) || 10, 3600000);
    if (!D.sBool('allow_register')) throw new HttpError(403, 'Rejestracja jest tymczasowo wyłączona');
    const c = checkCredentials(body), h = await A.hashPasswordAsync(c.password), now = D.now();
    checkCredentials(body);          // ponowna kontrola po asynchronicznym haszowaniu (unikalność nicku/e-maila – brak wyścigu)
    const cur = A.optionalUser(req);
    let id;
    if (cur && cur.guest) { // zamiana konta gościa na pełne: zachowujemy historię i postępy
      D.run('UPDATE users SET nick=?,nick_lc=?,email=?,email_lc=?,pass_hash=?,pass_salt=?,guest=0,last_seen=? WHERE id=?', c.nick, c.nick.toLowerCase(), c.email, c.email, h.hash, h.salt, now, cur.id);
      id = cur.id;
    } else {
      id = D.run('INSERT INTO users(nick,nick_lc,email,email_lc,pass_hash,pass_salt,guest,hue,created_at,last_seen) VALUES(?,?,?,?,?,?,0,?,?,?)',
        c.nick, c.nick.toLowerCase(), c.email, c.email, h.hash, h.salt, Math.floor(Math.random() * 360), now, now).id;
    }
    return authResponse(D.get('SELECT * FROM users WHERE id=?', id));
  });
  r.post('/api/auth/login', async (req, res, p, body) => {
    A.rateLimit('login:' + ip(req), 20, 600000);
    const who = str(body.login, 120).toLowerCase(), pw = String(body.password || '');
    const fkey = 'loginfail:' + who;
    A.failCheck(fkey, 8, 900000);                      // max 8 nieudanych prób na konto / 15 min (niezależnie od IP)
    const u = D.get('SELECT * FROM users WHERE guest=0 AND (nick_lc=? OR email_lc=?)', who, who);
    if (!(await A.verifyPasswordAsync(pw, u && u.pass_salt, u && u.pass_hash)) || !u) { A.failHit(fkey); throw new HttpError(401, 'Nieprawidłowy login lub hasło'); }
    A.failClear(fkey);
    const b = A.banState(u);
    if (b.banned) throw new HttpError(403, 'Konto zablokowane' + (b.reason ? ': ' + b.reason : '') + (b.until > 0 ? ' (do ' + new Date(b.until).toLocaleString('pl-PL') + ')' : ''));
    D.run('UPDATE users SET last_seen=? WHERE id=?', D.now(), u.id);
    return authResponse(u);
  });
  r.get('/api/me', (req) => ({ me: meView(A.requireUser(req)) }));
  r.put('/api/me', (req, res, p, body) => {
    const u = A.requireUser(req);
    if (body.hue != null) D.run('UPDATE users SET hue=? WHERE id=?', ((int(body.hue, 150) % 360) + 360) % 360, u.id);
    if (body.bio != null) D.run('UPDATE users SET bio=? WHERE id=?', str(body.bio, 160), u.id);
    if (body.nick != null && body.nick !== u.nick) {
      if (u.guest) throw new HttpError(400, 'Gość nie może zmienić nicku. Załóż konto.');
      const n = str(body.nick, 16);
      if (!A.validNick(n) || A.RESERVED.includes(n.toLowerCase())) throw new HttpError(400, 'Nieprawidłowy nick');
      if (D.get('SELECT 1 FROM users WHERE nick_lc=? AND id<>?', n.toLowerCase(), u.id)) throw new HttpError(409, 'Ten nick jest już zajęty');
      D.run('UPDATE users SET nick=?,nick_lc=? WHERE id=?', n, n.toLowerCase(), u.id);
    }
    return { me: meView(D.get('SELECT * FROM users WHERE id=?', u.id)) };
  });
  r.post('/api/me/password', async (req, res, p, body) => {
    const u = A.requireUser(req);
    if (u.guest) throw new HttpError(400, 'Gość nie ma hasła');
    const fkey = 'pwfail:' + u.id; A.failCheck(fkey, 5, 900000);
    if (!(await A.verifyPasswordAsync(String(body.old || ''), u.pass_salt, u.pass_hash))) { A.failHit(fkey); throw new HttpError(403, 'Obecne hasło jest nieprawidłowe'); }
    const np = String(body.password || '');
    if (np.length < 8) throw new HttpError(400, 'Nowe hasło musi mieć co najmniej 8 znaków');
    if (np.length > A.PASSWORD_MAX) throw new HttpError(400, 'Hasło może mieć do ' + A.PASSWORD_MAX + ' znaków');
    A.failClear(fkey);
    const h = await A.hashPasswordAsync(np);
    D.run('UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?', h.hash, h.salt, u.id);
    A.revokeSessions(u.id);                                  // zmiana hasła wylogowuje wszystkie inne urządzenia i połączenia
    RT.kick(u.id, 'Hasło zostało zmienione – zaloguj się ponownie');
    return { ok: true, token: A.issue(D.get('SELECT * FROM users WHERE id=?', u.id)) };
  });
  r.post('/api/auth/logout', (req) => {                      // unieważnia sesję (wszystkie urządzenia konta); gość – bez zmian
    const u = A.optionalUser(req);
    if (u && !u.guest) { A.revokeSessions(u.id); RT.kick(u.id, 'Wylogowano'); }
    return { ok: true };
  });
  r.get('/api/me/matches', (req) => {
    const u = A.requireUser(req), gm = gamesMap();
    return D.all('SELECT * FROM matches WHERE (p1=? OR p2=?) AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 40', u.id, u.id).map((m) => matchRow(m, gm, u.id));
  });
  r.get('/api/matches/:id', (req, res, p) => {
    const m = D.get('SELECT * FROM matches WHERE id=?', int(p.id, 0));
    if (!m || m.ended_at == null) throw new HttpError(404, 'Nie znaleziono partii');
    const g = D.get('SELECT * FROM games WHERE id=?', m.game_id), gm = gamesMap();
    return Object.assign(matchRow(m, gm, null), { game: G.gamePublic(g), moves: JSON.parse(m.moves) });
  });
  r.get('/api/notifs', (req) => {
    const u = A.requireUser(req);
    return D.all('SELECT id,text,link,ts,read FROM notifs WHERE user_id=? ORDER BY ts DESC LIMIT 30', u.id);
  });
  r.post('/api/notifs/read', (req) => { const u = A.requireUser(req); D.run('UPDATE notifs SET read=1 WHERE user_id=?', u.id); return { ok: true }; });

  /* ----- rankingi i profile ----- */
  r.get('/api/ranking', (req, res, p, body, q) => {
    const g = G.gameBySlug(q.get('game') || '');
    if (!g) throw new HttpError(404, 'Nie ma takiej gry');
    const per = ['d', 'w', 'm', 'y', 'a'].includes(q.get('period')) ? q.get('period') : 'a';
    const me = A.optionalUser(req);
    const out = G.ranking(g.id, per, Math.max(1, Math.min(100, int(q.get('limit'), 50))), me && !me.guest ? me.id : null);
    return Object.assign(out, { game: g.slug, period: per, system: per === 'a' ? 'elo' : 'pts' });
  });
  r.get('/api/users/:nick', (req, res, p) => {
    const u = D.get('SELECT * FROM users WHERE nick_lc=? AND guest=0 AND deleted_at=0', p.nick.toLowerCase());
    if (!u) throw new HttpError(404, 'Nie ma takiego gracza');
    const gm = gamesMap();
    const ratings = D.all('SELECT r.*,g.slug,g.name FROM ratings r JOIN games g ON g.id=r.game_id WHERE r.user_id=? AND r.games>0 ORDER BY r.rating DESC', u.id)
      .map((x) => ({ game: x.slug, gameName: x.name, rating: x.rating, games: x.games, wins: x.wins, losses: x.losses, draws: x.draws, bestStreak: x.best_streak, peak: x.peak }));
    const recent = D.all('SELECT * FROM matches WHERE (p1=? OR p2=?) AND ended_at IS NOT NULL AND mode<>? ORDER BY ended_at DESC LIMIT 15', u.id, u.id, 'bot').map((m) => matchRow(m, gm, u.id));
    const total = D.get('SELECT COUNT(*) AS n FROM matches WHERE (p1=? OR p2=?) AND ended_at IS NOT NULL', u.id, u.id).n;
    /* ucieczki (rage quit) i odsetek ukończonych partii z ludźmi */
    const human = D.get('SELECT COUNT(*) AS n FROM matches WHERE (p1=? OR p2=?) AND bot_side=0 AND result IS NOT NULL', u.id, u.id).n;
    const rageQuits = u.rage_quits_count || 0, completedPct = human ? Math.max(0, Math.round(100 * (human - rageQuits) / human)) : 100;
    const me2 = A.optionalUser(req);
    return { blocked: !!(me2 && D.isBlocked(me2.id, u.id)), user: Object.assign(G.userPublic(u), { achievements: ACH.forUser(u.id), level: G.levelOfXp(u.xp), online: RT.isOnline(u.id) }), ratings, recent, total, rageQuits, completedPct, league: G.leagueFor(G.seasonPoints(u.id)) };
  });
  /* ----- blokowanie graczy (user-to-user) ----- */
  r.get('/api/me/blocks', (req) => {
    const u = A.requireUser(req);
    return D.all('SELECT b.blocked_id AS uid, x.nick, x.hue, b.created_at AS since FROM user_blocks b JOIN users x ON x.id=b.blocked_id WHERE b.blocker_id=? AND x.deleted_at=0 ORDER BY b.created_at DESC', u.id);
  });
  r.post('/api/me/blocks', (req, res, p, body) => {
    const u = A.requireUser(req);
    A.rateLimit('block:' + u.id, 30, 3600000);
    const t = body.uid ? D.get('SELECT id,role FROM users WHERE id=? AND deleted_at=0', int(body.uid, 0)) : D.get('SELECT id,role FROM users WHERE nick_lc=? AND deleted_at=0', str(body.nick, 16).toLowerCase());
    if (!t) throw new HttpError(404, 'Nie ma takiego gracza');
    if (t.id === u.id) throw new HttpError(400, 'Nie możesz zablokować samego siebie');
    if (D.get('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id=?', u.id).n >= 200) throw new HttpError(400, 'Osiągnięto limit 200 zablokowanych użytkowników');
    D.run('INSERT OR IGNORE INTO user_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)', u.id, t.id, D.now());
    return { ok: true };
  });
  r.delete('/api/me/blocks/:uid', (req, res, p) => { const u = A.requireUser(req); D.run('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?', u.id, int(p.uid, 0)); return { ok: true }; });
  r.post('/api/report', (req, res, p, body) => {
    const u = A.requireUser(req);
    A.rateLimit('report:' + u.id, 8, 3600000);
    const target = D.get('SELECT id FROM users WHERE nick_lc=?', str(body.nick, 16).toLowerCase());
    if (!target || target.id === u.id) throw new HttpError(400, 'Nie można zgłosić tego gracza');
    const reason = ['obrażanie', 'spam', 'oszustwo', 'niewłaściwe zachowanie'].includes(body.reason) ? body.reason : 'niewłaściwe zachowanie';
    const g = body.game ? G.gameBySlug(str(body.game, 40)) : null;
    D.run('INSERT INTO reports(reporter_id,target_id,game_id,match_id,reason,note,created_at) VALUES(?,?,?,?,?,?,?)', u.id, target.id, g ? g.id : null, int(body.match, null), reason, str(body.note, 300), D.now());
    return { ok: true };
  });

  /* ----- reklamy ----- */
  const legacyAd = (req, q) => {
    const slot = ['lobby_banner', 'after_game', 'interstitial', 'game_tile', 'top_banner', 'sidebar', 'footer'].includes(q.get('slot')) ? q.get('slot') : 'lobby_banner';
    const device = q.get('device') === 'desktop' ? 'desktop' : 'mobile';
    return { ad: pickAd(slot, q.get('game'), A.optionalUser(req), device, ip(req)) };
  };
  /* Reklamy wg pozycji: GET /api/ads            -> { top:{…}|null, sidebar, between_games, footer }
                        GET /api/ads?placement=top -> { placement, ad:{ id,title,placement,type:'image_link'|'script_code',content,link } | null }
     (stary format ?slot=… nadal działa dla aplikacji). Wybór wg wagi, harmonogramu, odbiorców i limitów. */
  const PLACEMENT = { top: 'top_banner', sidebar: 'sidebar', between_games: 'interstitial', footer: 'footer' };
  const shape = (placement, ad) => !ad ? null : ad.code
    ? { id: ad.id, title: ad.title, placement, type: 'script_code', content: ad.code, seconds: ad.slideSec || 8 }
    : { id: ad.id, title: ad.title, placement, type: 'image_link', content: ad.imageUrl || '', link: ad.linkUrl || '', text: ad.text || '', seconds: ad.slideSec || 8 };
  /* slider: wszystkie aktywne reklamy miejsca (kolejność wg wagi), każda z własnym czasem wyświetlania; wyświetlenie liczy POST /api/ads/:id/view */
  const slidesFor = (pl, q, user, device, who) => eligibleAds(PLACEMENT[pl], q.get('game'), user, device, who).ads
    .sort((a, b) => b.weight - a.weight || a.id - b.id).map((a) => shape(pl, adPublic(a)));
  r.get('/api/ads', (req, res, p, body, q) => {
    if (q.get('slot')) return legacyAd(req, q);
    const device = q.get('device') === 'mobile' ? 'mobile' : 'desktop', user = A.optionalUser(req), who = ip(req);
    const one = (pl) => shape(pl, pickAd(PLACEMENT[pl], q.get('game'), user, device, who));
    if (q.get('slides') === '1') {           // tryb slidera: { top:[…], sidebar:[…], … } bez zliczania wyświetleń
      const out = {}; for (const pl of Object.keys(PLACEMENT)) out[pl] = slidesFor(pl, q, user, device, who);
      return { slides: out };
    }
    if (PLACEMENT[q.get('placement')]) return { placement: q.get('placement'), ad: one(q.get('placement')) };
    const out = {}; for (const pl of Object.keys(PLACEMENT)) out[pl] = one(pl);
    return out;
  });
  r.post('/api/ads/:id/click', (req, res, p) => { A.rateLimit('adclick:' + ip(req) + ':' + p.id, 5, 60000); D.run('UPDATE ads SET clicks=clicks+1 WHERE id=?', int(p.id, 0)); return { ok: true }; });
  r.post('/api/ads/:id/view', (req, res, p) => {      // wyświetlenie slajdu (liczone raz na pokaz, z limitem na gracza/dzień)
    const ad = D.get('SELECT * FROM ads WHERE id=? AND enabled=1', int(p.id, 0)); if (!ad) return { ok: false };
    const u = A.optionalUser(req); A.rateLimit('adview:' + (u ? u.id : ip(req)), 120, 60000);
    adCountView(ad, u ? 'u' + u.id : 'ip' + ip(req), new Date().toISOString().slice(0, 10)); return { ok: true };
  });

  /* ----- turnieje ----- */
  r.get('/api/tournaments', (req) => {
    const me = A.optionalUser(req);
    return D.all("SELECT * FROM tournaments WHERE status<>'cancelled' ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, start_at LIMIT 30").map((t) => {
      const g = G.gameById(t.game_id);
      const cnt = D.get('SELECT COUNT(*) AS n FROM tournament_players WHERE tid=?', t.id).n;
      const joined = me ? !!D.get('SELECT 1 FROM tournament_players WHERE tid=? AND user_id=?', t.id, me.id) : false;
      return { id: t.id, name: t.name, game: { slug: g.slug, name: g.name, icon: g.icon, hue: g.hue }, startAt: t.start_at, maxPlayers: t.max_players, players: cnt,
        format: t.format, prize: t.prize, sponsor: t.sponsor, status: t.status, joined, winner: t.winner_id ? (D.get('SELECT nick FROM users WHERE id=?', t.winner_id) || {}).nick : null };
    });
  });
  r.get('/api/tournaments/:id', (req, res, p) => {
    const me = A.optionalUser(req), d = T.detail(int(p.id, 0), me && me.id);
    if (!d) throw new HttpError(404, 'Nie ma takiego turnieju');
    return d;
  });
  r.post('/api/tournaments/:id/join', (req, res, p) => {
    const u = A.requireUser(req), tid = int(p.id, 0);
    const t = D.get('SELECT * FROM tournaments WHERE id=?', tid);
    if (!t || t.status !== 'open') throw new HttpError(400, 'Zapisy do tego turnieju są zamknięte');
    if (u.guest) throw new HttpError(403, 'Aby zapisać się na turniej, załóż konto');
    const cnt = D.get('SELECT COUNT(*) AS n FROM tournament_players WHERE tid=?', tid).n;
    if (cnt >= t.max_players) throw new HttpError(400, 'Turniej jest pełny');
    D.run('INSERT OR IGNORE INTO tournament_players(tid,user_id,joined_at) VALUES(?,?,?)', tid, u.id, D.now());
    return { ok: true };
  });
  r.post('/api/tournaments/:id/leave', (req, res, p) => {
    const u = A.requireUser(req), tid = int(p.id, 0);
    const t = D.get('SELECT * FROM tournaments WHERE id=?', tid);
    if (!t || t.status !== 'open') throw new HttpError(400, 'Nie można już się wypisać');
    D.run('DELETE FROM tournament_players WHERE tid=? AND user_id=?', tid, u.id);
    return { ok: true };
  });
}

module.exports = { register, meView, pickAd };
