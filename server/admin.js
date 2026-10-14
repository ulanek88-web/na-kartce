'use strict';
/* API panelu administratora (CMS): gry, reklamy, treści, użytkownicy, moderacja, turnieje, ustawienia. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const G = require('./game');
const A = require('./auth');
const RT = require('./realtime');
const T = require('./tournaments');
const E = require('../shared/engines');
const { HttpError } = require('./http');

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const admin = (req) => A.requireRole(req, 'admin');
const mod = (req) => A.requireRole(req, 'mod');
const cap = (req, c) => A.requireCap(req, c);          // RBAC: uprawnienie wg roli (patrz A.CAPS)
const IMG = require('./imaging');
const Z = require('./zipwrite');
const CENSOR = require('./censor');
const logAction = (adminId, userId, action, note, until) => D.run('INSERT INTO mod_actions(admin_id,user_id,action,note,until,ts) VALUES(?,?,?,?,?,?)', adminId, userId, action, note || '', until || 0, D.now());

/* ---------- gry ---------- */
function cleanGame(body, existing) {
  const out = {};
  const slug = existing ? existing.slug : str(body.slug, 30).toLowerCase();
  if (!existing && !/^[a-z0-9-]{2,30}$/.test(slug)) throw new HttpError(400, 'Adres gry (slug): 2–30 znaków, małe litery, cyfry i myślniki');
  if (!existing && D.get('SELECT 1 FROM games WHERE slug=?', slug)) throw new HttpError(409, 'Gra o takim adresie już istnieje');
  out.slug = slug;
  out.name = str(body.name, 40);
  if (!out.name) throw new HttpError(400, 'Podaj nazwę gry');
  out.icon = str(body.icon, 4) || '?';
  out.icon_url = str(body.icon_url, 300) || null;
  out.hue = ((int(body.hue, 150) % 360) + 360) % 360;
  out.category = str(body.category, 30) || 'Planszowe';
  out.description = str(body.description, 300);
  out.rules = str(body.rules, 6000);
  const engine = body.engine ? str(body.engine, 20) : null;
  if (engine && !E.registry[engine]) throw new HttpError(400, 'Nieznany silnik gry');
  out.engine = engine;
  out.params = JSON.stringify(engine ? E.cleanParams(engine, body.params || {}) : {});
  const status = ['active', 'soon', 'hidden'].includes(body.status) ? body.status : 'hidden';
  if (status === 'active' && !engine) throw new HttpError(400, 'Gra bez silnika nie może być aktywna. Wybierz silnik albo ustaw „wkrótce”.');
  out.status = status;
  out.time_sec = Math.max(0, Math.min(7200, int(body.time_sec, 0)));
  out.inc_sec = Math.max(0, Math.min(60, int(body.inc_sec, 0)));
  out.rated = bool(body.rated == null ? 1 : body.rated);
  out.bots = bool(body.bots == null ? 1 : body.bots);
  out.sort = int(body.sort, 100);
  return out;
}
const gameAdmin = (g) => Object.assign(G.gamePublic(g), {
  iconUrl: g.icon_url, params: G.parseParams(g), sort: g.sort,
  matches: D.get('SELECT COUNT(*) AS n FROM matches WHERE game_id=?', g.id).n,
  players: D.get('SELECT COUNT(*) AS n FROM ratings WHERE game_id=? AND games>0', g.id).n
});

/* ---------- statystyki ---------- */
function stats() {
  const now = D.now(), day = 86400000;
  const midnight = G.periodStart('d');
  const c = (sql, ...p) => D.get(sql, ...p).n;
  const users = c('SELECT COUNT(*) AS n FROM users'), guests = c('SELECT COUNT(*) AS n FROM users WHERE guest=1');
  const perDay = [];
  for (let i = 13; i >= 0; i--) {
    const from = midnight - i * day;
    perDay.push({ day: new Date(from).toISOString().slice(0, 10), users: c('SELECT COUNT(*) AS n FROM users WHERE created_at>=? AND created_at<?', from, from + day),
      matches: c('SELECT COUNT(*) AS n FROM matches WHERE started_at>=? AND started_at<?', from, from + day) });
  }
  const byGame = D.all(`SELECT g.name,g.slug,COUNT(m.id) AS n FROM games g LEFT JOIN matches m ON m.game_id=g.id AND m.started_at>=? GROUP BY g.id HAVING n>0 ORDER BY n DESC LIMIT 10`, now - 7 * day);
  const hours = new Array(24).fill(0);
  D.all('SELECT started_at FROM matches WHERE started_at>=?', now - 7 * day).forEach((m) => { hours[new Date(m.started_at).getHours()]++; });
  const ad = D.get('SELECT COALESCE(SUM(impressions),0) AS imp, COALESCE(SUM(clicks),0) AS clk FROM ads');
  return {
    users, guests, registered: users - guests, newToday: c('SELECT COUNT(*) AS n FROM users WHERE created_at>=?', midnight),
    dau: c('SELECT COUNT(*) AS n FROM users WHERE last_seen>=?', now - day), wau: c('SELECT COUNT(*) AS n FROM users WHERE last_seen>=?', now - 7 * day),
    mau: c('SELECT COUNT(*) AS n FROM users WHERE last_seen>=?', now - 30 * day), live: RT.stats(),
    matchesToday: c('SELECT COUNT(*) AS n FROM matches WHERE started_at>=?', midnight), matchesTotal: c('SELECT COUNT(*) AS n FROM matches'),
    avgMinutes: Math.round((D.get('SELECT AVG(ended_at-started_at) AS a FROM matches WHERE ended_at IS NOT NULL AND started_at>=?', now - 7 * day).a || 0) / 6000) / 10,
    perDay, byGame, hours, ads: { impressions: ad.imp, clicks: ad.clk, active: c('SELECT COUNT(*) AS n FROM ads WHERE enabled=1'), ctr: ad.imp ? ad.clk / ad.imp : 0 },
    openReports: c("SELECT COUNT(*) AS n FROM reports WHERE status='open'"), tournaments: c("SELECT COUNT(*) AS n FROM tournaments WHERE status IN ('open','running')"),
    games: { active: c("SELECT COUNT(*) AS n FROM games WHERE status='active'"), soon: c("SELECT COUNT(*) AS n FROM games WHERE status='soon'"), hidden: c("SELECT COUNT(*) AS n FROM games WHERE status='hidden'") }
  };
}

function cleanAd(body, existing) {
  const slot = ['lobby_banner', 'after_game', 'interstitial', 'game_tile', 'top_banner', 'sidebar', 'footer'].includes(body.slot) ? body.slot : 'lobby_banner';
  const g = body.game ? G.gameBySlug(str(body.game, 40)) : null;
  const date = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
  const name = str(body.name, 80);
  if (!name) throw new HttpError(400, 'Podaj nazwę kampanii');
  const link = str(body.link_url, 400);
  if (link && !/^https?:\/\//i.test(link)) throw new HttpError(400, 'Link musi zaczynać się od http:// lub https://');
  /* harmonogram emisji: 1 dzień / 2 dni / 1 tydzień / 1 miesiąc (liczone od zapisu), zakres dat albo bezterminowo */
  const schedule = ['1d', '2d', '1w', '1m', 'range', 'forever'].includes(body.schedule) ? body.schedule : 'range';
  let start_at = date(body.start), end_at = date(body.end);
  if (schedule === 'forever') { start_at = 0; end_at = 0; }
  else if (schedule !== 'range') {
    if (existing && existing.schedule === schedule && !body.restart) { start_at = existing.start_at; end_at = existing.end_at; }
    else {
      start_at = Date.now(); const e = new Date(start_at);
      if (schedule === '1m') e.setMonth(e.getMonth() + 1); else e.setTime(start_at + ({ '1d': 1, '2d': 2, '1w': 7 })[schedule] * 864e5);
      end_at = e.getTime();
    }
  }
  if (schedule === 'range' && start_at && end_at && end_at <= start_at) throw new HttpError(400, 'Data zakończenia musi być późniejsza niż rozpoczęcia');
  return {
    schedule, slide_sec: Math.max(2, Math.min(120, int(body.slide_sec, 8))),
    kind: body.kind === 'code' ? 'code' : 'banner', code: body.kind === 'code' ? String(body.code || '').slice(0, 8000) : '',
    name, slot, title: str(body.title, 80), text: str(body.text, 240), image_url: str(body.image_url, 400) || null, link_url: link || null,
    color: ((int(body.color, 40) % 360) + 360) % 360, game_id: g ? g.id : null, audience: ['all', 'guests', 'users'].includes(body.audience) ? body.audience : 'all',
    device: ['all', 'mobile', 'desktop'].includes(body.device) ? body.device : 'all', enabled: bool(body.enabled), start_at, end_at,
    max_per_day: Math.max(0, int(body.max_per_day, 0)), weight: Math.max(1, Math.min(100, int(body.weight, 1))), budget_note: str(body.budget_note, 120), advertiser: str(body.advertiser, 80)
  };
}
const adOut = (a) => ({ kind: a.kind, code: a.code, id: a.id, name: a.name, slot: a.slot, title: a.title, text: a.text, image_url: a.image_url, link_url: a.link_url, color: a.color,
  game: a.game_id ? (G.gameById(a.game_id) || {}).slug : '', audience: a.audience, device: a.device, enabled: !!a.enabled, start: a.start_at, end: a.end_at,
  max_per_day: a.max_per_day, weight: a.weight, impressions: a.impressions, clicks: a.clicks, ctr: a.impressions ? a.clicks / a.impressions : 0, budget_note: a.budget_note, advertiser: a.advertiser,
  schedule: a.schedule || 'range', slide_sec: a.slide_sec || 8, size: IMG.SLOT_SIZES[a.slot] || null });

function cleanTournament(body) {
  const g = G.gameBySlug(str(body.game, 40));
  if (!g || !G.playable(g)) throw new HttpError(400, 'Wybierz aktywną grę');
  const name = str(body.name, 80);
  if (!name) throw new HttpError(400, 'Podaj nazwę turnieju');
  const start = new Date(body.start).getTime();
  if (isNaN(start)) throw new HttpError(400, 'Podaj datę i godzinę startu');
  return { name, game_id: g.id, start_at: start, max_players: Math.max(2, Math.min(1024, int(body.max_players, 32))), prize: str(body.prize, 120), sponsor: str(body.sponsor, 80), description: str(body.description, 400) };
}

function register(r) {
  /* ----- ogólne ----- */
  r.get('/api/admin/me', (req) => { const u = mod(req); return { id: u.id, nick: u.nick, role: u.role, caps: (A.CAPS[u.role] || []).slice() }; });
  r.get('/api/admin/stats', (req) => { cap(req, 'stats'); return stats(); });
  r.get('/api/admin/engines', (req) => {
    mod(req);
    return Object.entries(E.registry).map(([id, e]) => ({ id, label: e.label, params: e.params }));
  });

  /* ----- gry ----- */
  r.get('/api/admin/games', (req) => { admin(req); return D.all('SELECT * FROM games ORDER BY sort,id').map(gameAdmin); });
  r.post('/api/admin/games', (req, res, p, body) => {
    admin(req);
    const g = cleanGame(body, null);
    const id = D.run('INSERT INTO games(slug,name,icon,icon_url,hue,category,description,rules,engine,params,status,time_sec,inc_sec,rated,bots,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      g.slug, g.name, g.icon, g.icon_url, g.hue, g.category, g.description, g.rules, g.engine, g.params, g.status, g.time_sec, g.inc_sec, g.rated, g.bots, g.sort, D.now()).id;
    return gameAdmin(G.gameById(id));
  });
  r.put('/api/admin/games/:id', (req, res, p, body) => {
    admin(req);
    const ex = G.gameById(int(p.id, 0));
    if (!ex) throw new HttpError(404, 'Nie ma takiej gry');
    const g = cleanGame(Object.assign({}, body), ex);
    D.run('UPDATE games SET name=?,icon=?,icon_url=?,hue=?,category=?,description=?,rules=?,engine=?,params=?,status=?,time_sec=?,inc_sec=?,rated=?,bots=?,sort=? WHERE id=?',
      g.name, g.icon, g.icon_url, g.hue, g.category, g.description, g.rules, g.engine, g.params, g.status, g.time_sec, g.inc_sec, g.rated, g.bots, g.sort, ex.id);
    return gameAdmin(G.gameById(ex.id));
  });
  r.delete('/api/admin/games/:id', (req, res, p) => {
    admin(req);
    const ex = G.gameById(int(p.id, 0));
    if (!ex) throw new HttpError(404, 'Nie ma takiej gry');
    if (D.get('SELECT 1 FROM matches WHERE game_id=? LIMIT 1', ex.id)) throw new HttpError(409, 'Ta gra ma rozegrane partie. Ukryj ją zamiast usuwać.');
    D.run('DELETE FROM games WHERE id=?', ex.id);
    return { ok: true };
  });

  /* ----- reklamy ----- */
  r.get('/api/admin/ads', (req) => { cap(req, 'ads'); return D.all('SELECT * FROM ads ORDER BY enabled DESC, id DESC').map(adOut); });
  r.post('/api/admin/ads', (req, res, p, body) => {
    const me = cap(req, 'ads');
    if (body.kind === 'code' && me.role !== 'admin') throw new HttpError(403, 'Reklamy z własnym kodem może dodawać tylko Super Admin');
    const a = cleanAd(body);
    const id = D.run('INSERT INTO ads(name,slot,title,text,image_url,link_url,color,game_id,audience,device,enabled,start_at,end_at,max_per_day,weight,budget_note,advertiser,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      a.name, a.slot, a.title, a.text, a.image_url, a.link_url, a.color, a.game_id, a.audience, a.device, a.enabled, a.start_at, a.end_at, a.max_per_day, a.weight, a.budget_note, a.advertiser, D.now()).id;
    D.run('UPDATE ads SET kind=?,code=?,schedule=?,slide_sec=? WHERE id=?', a.kind, a.code, a.schedule, a.slide_sec, id);
    return adOut(D.get('SELECT * FROM ads WHERE id=?', id));
  });
  r.put('/api/admin/ads/:id', (req, res, p, body) => {
    const me = cap(req, 'ads');
    const id = int(p.id, 0), ex = D.get('SELECT * FROM ads WHERE id=?', id);
    if (!ex) throw new HttpError(404, 'Nie ma takiej reklamy');
    if ((body.kind === 'code' || ex.kind === 'code') && me.role !== 'admin') throw new HttpError(403, 'Reklamy z własnym kodem może zmieniać tylko Super Admin');
    const a = cleanAd(body, ex);
    D.run('UPDATE ads SET name=?,slot=?,title=?,text=?,image_url=?,link_url=?,color=?,game_id=?,audience=?,device=?,enabled=?,start_at=?,end_at=?,max_per_day=?,weight=?,budget_note=?,advertiser=? WHERE id=?',
      a.name, a.slot, a.title, a.text, a.image_url, a.link_url, a.color, a.game_id, a.audience, a.device, a.enabled, a.start_at, a.end_at, a.max_per_day, a.weight, a.budget_note, a.advertiser, id);
    D.run('UPDATE ads SET kind=?,code=?,schedule=?,slide_sec=? WHERE id=?', a.kind, a.code, a.schedule, a.slide_sec, id);
    return adOut(D.get('SELECT * FROM ads WHERE id=?', id));
  });
  r.delete('/api/admin/ads/:id', (req, res, p) => { cap(req, 'ads'); D.run('DELETE FROM ads WHERE id=?', int(p.id, 0)); D.run('DELETE FROM ad_views WHERE ad_id=?', int(p.id, 0)); return { ok: true }; });
  r.post('/api/admin/ads/:id/reset', (req, res, p) => { cap(req, 'ads'); D.run('UPDATE ads SET impressions=0,clicks=0 WHERE id=?', int(p.id, 0)); return { ok: true }; });

  /* ----- treści ----- */
  r.get('/api/admin/news', (req) => { admin(req); return D.all('SELECT * FROM news ORDER BY pinned DESC, created_at DESC').map((n) => ({ id: n.id, title: n.title, body: n.body, kind: n.kind, pinned: !!n.pinned, active: !!n.active, createdAt: n.created_at })); });
  const cleanNews = (b) => { const t = str(b.title, 120); if (!t) throw new HttpError(400, 'Podaj tytuł'); return { title: t, body: str(b.body, 600), kind: b.kind === 'banner' ? 'banner' : 'news', pinned: bool(b.pinned), active: bool(b.active == null ? 1 : b.active) }; };
  r.post('/api/admin/news', (req, res, p, body) => { admin(req); const n = cleanNews(body); return { id: D.run('INSERT INTO news(title,body,kind,pinned,active,created_at) VALUES(?,?,?,?,?,?)', n.title, n.body, n.kind, n.pinned, n.active, D.now()).id }; });
  r.put('/api/admin/news/:id', (req, res, p, body) => { admin(req); const n = cleanNews(body); D.run('UPDATE news SET title=?,body=?,kind=?,pinned=?,active=? WHERE id=?', n.title, n.body, n.kind, n.pinned, n.active, int(p.id, 0)); return { ok: true }; });
  r.delete('/api/admin/news/:id', (req, res, p) => { admin(req); D.run('DELETE FROM news WHERE id=?', int(p.id, 0)); return { ok: true }; });
  r.get('/api/admin/pages', (req) => { admin(req); return D.all('SELECT * FROM pages ORDER BY slug'); });
  r.put('/api/admin/pages/:slug', (req, res, p, body) => {
    admin(req);
    const slug = str(p.slug, 40).toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new HttpError(400, 'Nieprawidłowy adres strony');
    const title = str(body.title, 100);
    if (!title) throw new HttpError(400, 'Podaj tytuł strony');
    D.run('INSERT INTO pages(slug,title,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at', slug, title, str(body.body, 20000), D.now());
    return { ok: true };
  });
  r.delete('/api/admin/pages/:slug', (req, res, p) => { admin(req); D.run('DELETE FROM pages WHERE slug=?', p.slug); return { ok: true }; });

  /* ----- użytkownicy i moderacja ----- */
  r.get('/api/admin/users', (req, res, p, body, q) => {
    mod(req);
    const term = '%' + str(q.get('q'), 40).toLowerCase() + '%', page = Math.max(0, int(q.get('page'), 0));
    const filter = q.get('filter');
    let where = '(nick_lc LIKE ? OR COALESCE(email_lc,\'\') LIKE ?) AND deleted_at=0';
    if (filter === 'guests') where += ' AND guest=1'; else if (filter === 'registered') where += ' AND guest=0';
    else if (filter === 'banned') where += ' AND (banned_until=-1 OR banned_until>' + D.now() + ')';
    else if (filter === 'staff') where += " AND role<>'user'";
    const total = D.get('SELECT COUNT(*) AS n FROM users WHERE ' + where, term, term).n;
    const rows = D.all('SELECT * FROM users WHERE ' + where + ' ORDER BY last_seen DESC LIMIT 25 OFFSET ?', term, term, page * 25).map((u) => ({
      id: u.id, nick: u.nick, email: u.email, guest: !!u.guest, role: u.role, xp: u.xp, createdAt: u.created_at, lastSeen: u.last_seen, bannedUntil: u.banned_until,
      banReason: u.ban_reason, mutedUntil: u.muted_until, online: RT.isOnline(u.id), matches: D.get('SELECT COUNT(*) AS n FROM matches WHERE p1=? OR p2=?', u.id, u.id).n
    }));
    return { rows, total, page };
  });
  r.post('/api/admin/users/:id/action', (req, res, p, body) => {
    const me = mod(req), id = int(p.id, 0);
    const u = D.get('SELECT * FROM users WHERE id=?', id);
    if (!u) throw new HttpError(404, 'Nie ma takiego użytkownika');
    const act = str(body.action, 20), note = str(body.note, 200);
    const until = (h) => (h === 'perm' || h === 0 || h === '0' ? -1 : Date.now() + Math.max(1, int(h, 24)) * 3600000);
    if (u.id === me.id && ['ban', 'role', 'delete', 'mute'].includes(act)) throw new HttpError(400, 'Nie możesz wykonać tej akcji na sobie');
    if (u.role !== 'user' && me.role !== 'admin') throw new HttpError(403, 'Tylko administrator może zarządzać personelem');
    if (u.role === 'admin' && me.role === 'admin' && ['ban', 'delete'].includes(act)) throw new HttpError(400, 'Najpierw odbierz rolę administratora');
    switch (act) {
      case 'warn': RT.notify(u.id, 'Ostrzeżenie od moderatora: ' + (note || 'przestrzegaj regulaminu'), null); logAction(me.id, u.id, 'warn', note); break;
      case 'ban': { const t = until(body.hours); D.run('UPDATE users SET banned_until=?,ban_reason=? WHERE id=?', t, note, u.id); RT.kick(u.id, 'Konto zablokowane'); logAction(me.id, u.id, 'ban', note, t); break; }
      case 'unban': D.run('UPDATE users SET banned_until=0,ban_reason=NULL WHERE id=?', u.id); logAction(me.id, u.id, 'unban', note); break;
      case 'mute': { const t = until(body.hours); D.run('UPDATE users SET muted_until=? WHERE id=?', t, u.id); logAction(me.id, u.id, 'mute', note, t); break; }
      case 'unmute': D.run('UPDATE users SET muted_until=0 WHERE id=?', u.id); logAction(me.id, u.id, 'unmute', note); break;
      case 'role': {
        if (me.role !== 'admin') throw new HttpError(403, 'Tylko administrator');
        const role = ['user', 'mod', 'admin'].includes(body.role) ? body.role : 'user';
        if (u.guest) throw new HttpError(400, 'Gość nie może być moderatorem');
        if (u.role === 'admin' && role !== 'admin' && D.get("SELECT COUNT(*) AS n FROM users WHERE role='admin'").n <= 1) throw new HttpError(400, 'To jedyny administrator');
        D.run('UPDATE users SET role=? WHERE id=?', role, u.id); logAction(me.id, u.id, 'role:' + role, note); break;
      }
      case 'reset_rating': {
        if (me.role !== 'admin') throw new HttpError(403, 'Tylko administrator');
        const def = D.sNum('default_rating') || 1200;
        if (body.game) { const g = G.gameBySlug(str(body.game, 40)); if (g) D.run('UPDATE ratings SET rating=?,games=0,wins=0,losses=0,draws=0,streak=0,best_streak=0,peak=? WHERE user_id=? AND game_id=?', def, def, u.id, g.id); }
        else D.run('UPDATE ratings SET rating=?,games=0,wins=0,losses=0,draws=0,streak=0,best_streak=0,peak=? WHERE user_id=?', def, def, u.id);
        logAction(me.id, u.id, 'reset_rating', body.game || 'all'); break;
      }
      case 'set_password': {
        if (me.role !== 'admin') throw new HttpError(403, 'Tylko administrator');
        if (u.guest) throw new HttpError(400, 'Gość nie ma hasła');
        const pw = String(body.password || '');
        if (pw.length < 8) throw new HttpError(400, 'Hasło musi mieć co najmniej 8 znaków');
        const h = A.hashPassword(pw); D.run('UPDATE users SET pass_hash=?,pass_salt=?,token_version=token_version+1 WHERE id=?', h.hash, h.salt, u.id); RT.kick(u.id, 'Hasło zostało zmienione – zaloguj się ponownie'); logAction(me.id, u.id, 'set_password'); break;
      }
      case 'logout': {            // natychmiastowe wylogowanie ze wszystkich urządzeń (unieważnia tokeny + zamyka połączenia WebSocket)
        D.run('UPDATE users SET token_version=token_version+1 WHERE id=?', u.id);
        RT.kick(u.id, 'Zostałeś wylogowany przez administratora');
        logAction(me.id, u.id, 'force_logout', note); break;
      }
      case 'delete': {            // trwałe usunięcie konta + anonimizacja historii (RODO): partie zostają, ale bez danych osobowych
        if (me.role !== 'admin') throw new HttpError(403, 'Tylko administrator');
        if (u.deleted_at) throw new HttpError(400, 'Konto jest już usunięte');
        RT.kick(u.id, 'Konto usunięte');
        D.tx(() => {
          for (const t of ['ratings', 'events', 'notifs']) D.run('DELETE FROM ' + t + ' WHERE user_id=?', u.id);
          D.run('DELETE FROM tournament_players WHERE user_id=?', u.id);
          D.run('DELETE FROM user_blocks WHERE blocker_id=? OR blocked_id=?', u.id, u.id);
          D.run('UPDATE reports SET note=\'\' WHERE reporter_id=?', u.id);
          D.run(`UPDATE users SET nick='Usunięty gracz', nick_lc=?, email=NULL, email_lc=NULL, pass_hash=NULL, pass_salt=NULL, bio='', guest=0, role='user',
            banned_until=-1, ban_reason='konto usunięte', muted_until=0, xp=0, rage_quits_count=0, deleted_at=?, token_version=token_version+1 WHERE id=?`, 'deleted-' + u.id, D.now(), u.id);
        });
        logAction(me.id, null, 'delete:#' + u.id, note); break;
      }
      default: throw new HttpError(400, 'Nieznana akcja');
    }
    return { ok: true };
  });
  r.get('/api/admin/reports', (req, res, p, body, q) => {
    mod(req);
    const status = q.get('status') === 'closed' ? 'closed' : 'open';
    return D.all(`SELECT r.*,a.nick AS reporter,b.nick AS target,b.id AS target_id2,g.name AS game_name FROM reports r JOIN users a ON a.id=r.reporter_id JOIN users b ON b.id=r.target_id
      LEFT JOIN games g ON g.id=r.game_id WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`, status)
      .map((x) => ({ id: x.id, reporter: x.reporter, target: x.target, targetId: x.target_id2, reason: x.reason, note: x.note, game: x.game_name, matchId: x.match_id, createdAt: x.created_at, resolution: x.resolution }));
  });
  r.post('/api/admin/reports/:id/close', (req, res, p, body) => {
    const me = mod(req);
    D.run("UPDATE reports SET status='closed',resolution=?,handled_by=?,handled_at=? WHERE id=?", str(body.resolution, 200) || 'zamknięte', me.id, D.now(), int(p.id, 0));
    return { ok: true };
  });
  r.get('/api/admin/modlog', (req) => {
    mod(req);
    return D.all('SELECT m.*,a.nick AS admin_nick,u.nick AS user_nick FROM mod_actions m LEFT JOIN users a ON a.id=m.admin_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.ts DESC LIMIT 60')
      .map((x) => ({ id: x.id, admin: x.admin_nick, user: x.user_nick, action: x.action, note: x.note, until: x.until, ts: x.ts }));
  });

  /* ----- turnieje ----- */
  r.get('/api/admin/tournaments', (req) => {
    admin(req);
    return D.all('SELECT * FROM tournaments ORDER BY start_at DESC LIMIT 100').map((t) => {
      const g = G.gameById(t.game_id);
      return { id: t.id, name: t.name, game: g.slug, gameName: g.name, startAt: t.start_at, maxPlayers: t.max_players, prize: t.prize, sponsor: t.sponsor, description: t.description, status: t.status,
        players: D.get('SELECT COUNT(*) AS n FROM tournament_players WHERE tid=?', t.id).n, winner: t.winner_id ? (D.get('SELECT nick FROM users WHERE id=?', t.winner_id) || {}).nick : null };
    });
  });
  r.post('/api/admin/tournaments', (req, res, p, body) => {
    admin(req);
    const t = cleanTournament(body);
    return { id: D.run('INSERT INTO tournaments(name,game_id,start_at,max_players,prize,sponsor,description,created_at) VALUES(?,?,?,?,?,?,?,?)', t.name, t.game_id, t.start_at, t.max_players, t.prize, t.sponsor, t.description, D.now()).id };
  });
  r.put('/api/admin/tournaments/:id', (req, res, p, body) => {
    admin(req);
    const ex = D.get('SELECT * FROM tournaments WHERE id=?', int(p.id, 0));
    if (!ex) throw new HttpError(404, 'Nie ma takiego turnieju');
    if (ex.status !== 'open') throw new HttpError(400, 'Edytować można tylko turniej z otwartymi zapisami');
    const t = cleanTournament(body);
    D.run('UPDATE tournaments SET name=?,game_id=?,start_at=?,max_players=?,prize=?,sponsor=?,description=? WHERE id=?', t.name, t.game_id, t.start_at, t.max_players, t.prize, t.sponsor, t.description, ex.id);
    return { ok: true };
  });
  r.post('/api/admin/tournaments/:id/start', (req, res, p) => {
    admin(req);
    if (!T.start(int(p.id, 0))) throw new HttpError(400, 'Nie można uruchomić turnieju (za mało graczy lub już wystartował)');
    return { ok: true };
  });
  r.post('/api/admin/tournaments/:id/cancel', (req, res, p) => {
    admin(req);
    D.run("UPDATE tournaments SET status='cancelled' WHERE id=? AND status IN ('open','running')", int(p.id, 0));
    return { ok: true };
  });
  r.post('/api/admin/tournament-matches/:id/winner', (req, res, p, body) => {
    admin(req);
    if (!T.setWinner(int(p.id, 0), int(body.uid, 0))) throw new HttpError(400, 'Nie można ustawić zwycięzcy');
    return { ok: true };
  });

  /* ----- ustawienia ----- */
  r.get('/api/admin/settings', (req) => { admin(req); return D.settings(); });
  r.put('/api/admin/settings', (req, res, p, body) => {
    admin(req);
    for (const [k, v] of Object.entries(body || {})) {
      if (!(k in D.DEFAULT_SETTINGS)) continue;
      let val = String(v);
      if (k === 'leagues') {
        let arr;
        try { arr = JSON.parse(val); } catch (e) { throw new HttpError(400, 'Ligi: nieprawidłowy format'); }
        if (!Array.isArray(arr) || !arr.length || arr.some((l) => typeof l.n !== 'string' || !Number.isFinite(+l.min))) throw new HttpError(400, 'Ligi: lista nazw i progów punktów');
        val = JSON.stringify(arr.map((l) => ({ n: l.n.slice(0, 30), min: Math.max(0, +l.min), color: /^#[0-9a-fA-F]{6}$/.test(l.color) ? l.color : '#888888' })).sort((a, b) => a.min - b.min));
      } else if (['allow_guests', 'allow_register', 'maintenance', 'ads_enabled', 'forum_enabled', 'bot_disguise'].includes(k)) val = bool(v) ? '1' : '0';
      else if (['default_rating', 'k_factor', 'disconnect_grace_sec'].includes(k)) val = String(Math.max(1, Math.min(3000, int(v, 1))));
      else if (k === 'bot_autojoin_sec') val = String(Math.max(0, Math.min(3600, int(v, 120))));      // 0 = auto-bot wyłączony
      else if (k === 'forum_cooldown_sec') val = String(Math.max(0, Math.min(3600, int(v, 30))));
      else if (k === 'bot_auto_level') val = ['e', 'm', 'h'].includes(val) ? val : 'm';
      else if (k === 'bot_names') {
        const names = [...new Set(val.split(/[\n,;]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9ĄąĆćĘęŁłŃńÓóŚśŹźŻż._-]{3,16}$/.test(x)))].slice(0, 200);
        if (names.length < 3) throw new HttpError(400, 'Lista botów: podaj co najmniej 3 poprawne nicki (3–16 znaków: litery, cyfry, . _ -)');
        val = names.join(',');
      }
      else val = val.slice(0, 300);
      D.setSetting(k, val);
    }
    return D.settings();
  });

  /* ----- konta personelu (Super Admin tworzy Moderatorów / Młodszych Adminów / kolejnych Super Adminów) ----- */
  r.get('/api/admin/accounts', (req) => {
    admin(req);
    return D.all("SELECT id,nick,email,role,created_at,last_seen,banned_until FROM users WHERE role<>'user' AND deleted_at=0 ORDER BY role DESC, id").map((u) => ({
      id: u.id, nick: u.nick, email: u.email, role: u.role, createdAt: u.created_at, lastSeen: u.last_seen, banned: u.banned_until === -1 || u.banned_until > D.now() }));
  });
  r.post('/api/admin/accounts', (req, res, p, body) => {
    const me = admin(req);
    A.rateLimit('staff:' + me.id, 20, 3600000);
    const nick = str(body.nick, 16), email = str(body.email, 120).toLowerCase(), pw = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : body.role === 'mod' ? 'mod' : null;
    if (!role) throw new HttpError(400, 'Wybierz rolę: Moderator lub Super Admin');
    if (!A.validNick(nick) || A.RESERVED.includes(nick.toLowerCase())) throw new HttpError(400, 'Nieprawidłowy nick (3–16 znaków: litery, cyfry, . _ -)');
    if (!/^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,}$/.test(email)) throw new HttpError(400, 'Podaj poprawny adres e-mail');
    if (pw.length < 8) throw new HttpError(400, 'Hasło musi mieć co najmniej 8 znaków');
    if (D.get('SELECT 1 FROM users WHERE nick_lc=?', nick.toLowerCase())) throw new HttpError(409, 'Ten nick jest już zajęty');
    if (D.get('SELECT 1 FROM users WHERE email_lc=?', email)) throw new HttpError(409, 'Ten e-mail jest już użyty');
    const h = A.hashPassword(pw), now = D.now();
    const id = D.run('INSERT INTO users(nick,nick_lc,email,email_lc,pass_hash,pass_salt,guest,role,hue,created_at,last_seen) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
      nick, nick.toLowerCase(), email, email, h.hash, h.salt, role, Math.floor(Math.random() * 360), now, now).id;
    logAction(me.id, id, 'create_account:' + role);
    return { id, nick, role };
  });

  /* ----- pełna kopia zapasowa (.zip): baza SQLite + wgrane pliki + wtyczki; wyłącznie Super Admin ----- */
  r.get('/api/admin/backup', async (req, res) => {
    const me = admin(req);
    A.rateLimit('backup:' + me.id, 3, 600000);
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-backup-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
    try {
      const dbCopy = path.join(tmp, 'nakartce.db');
      D.db.exec("VACUUM INTO '" + dbCopy.replace(/'/g, "''") + "'");        // spójna migawka bazy (użytkownicy, rankingi, turnieje, powiadomienia…)
      const entries = [{ name: 'database/nakartce.db', file: dbCopy }];
      Z.walk(path.join(D.DATA_DIR, 'uploads'), 'uploads/', entries);        // banery reklamowe, obrazy, awatary
      Z.walk(path.join(D.DATA_DIR, 'plugins'), 'plugins/', entries);        // zainstalowane wtyczki / gry
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
      entries.push({ name: 'README.txt', data: Buffer.from('Kopia zapasowa Na kartce – ' + new Date().toISOString() + '\n\ndatabase/nakartce.db – baza SQLite (zawiera dane użytkowników i klucz SECRET: przechowuj kopię bezpiecznie)\nuploads/ – wgrane obrazy i banery\nplugins/ – zainstalowane gry-wtyczki\n\nPrzywracanie: zatrzymaj serwer, wgraj te elementy do katalogu data/ (database/nakartce.db -> data/nakartce.db) i uruchom ponownie.\n') });
      const zipPath = path.join(tmp, 'backup.zip'), size = Z.writeZip(zipPath, entries);
      logAction(me.id, null, 'backup_download', entries.length + ' plików');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size, 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="nakartce-backup-' + stamp + '.zip"' });
      /* handler czeka na koniec strumienia – router nie próbuje wtedy dopisać odpowiedzi JSON do trwającego pobierania */
      await new Promise((resolve) => {
        const rs = fs.createReadStream(zipPath);
        rs.on('error', () => { res.destroy(); resolve(); });
        res.on('close', resolve); rs.pipe(res);
      });
      cleanup();
    } catch (e) { cleanup(); console.error('Backup ZIP:', e); throw new HttpError(500, 'Nie udało się utworzyć kopii zapasowej'); }
  });

  /* ----- słownik cenzury czatu (moderator i admin) ----- */
  const reloadCensor = () => CENSOR.setWords(D.all('SELECT word FROM censor_words').map((x) => x.word));
  reloadCensor();
  r.get('/api/admin/censor', (req) => { cap(req, 'censor'); return D.all('SELECT word,created_at FROM censor_words ORDER BY word'); });
  r.post('/api/admin/censor', (req, res, p, body) => {
    const me = cap(req, 'censor'), w = CENSOR.normWord(str(body.word, 30));
    if (w.length < 3) throw new HttpError(400, 'Słowo musi mieć co najmniej 3 litery');
    D.run('INSERT OR IGNORE INTO censor_words(word,added_by,created_at) VALUES(?,?,?)', w, me.id, D.now());
    logAction(me.id, null, 'censor_add', w); reloadCensor(); return { ok: true };
  });
  r.delete('/api/admin/censor/:word', (req, res, p) => {
    const me = cap(req, 'censor'); D.run('DELETE FROM censor_words WHERE word=?', p.word); logAction(me.id, null, 'censor_del', p.word); reloadCensor(); return { ok: true };
  });

  /* ----- obraz reklamy: limit 2 MB, kontrola proporcji slotu, automatyczne przycięcie i przeskalowanie (sharp) ----- */
  r.post('/api/admin/ads/upload', async (req, res, p, body) => {
    cap(req, 'ads');
    const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'Dozwolone są pliki PNG, JPG, WEBP i GIF');
    const buf = Buffer.from(m[2], 'base64');
    let out;
    try { out = await IMG.processAdImage(buf, str(body.slot, 30)); } catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw e; }
    const name = crypto.randomBytes(8).toString('hex') + '.' + out.ext;
    fs.writeFileSync(path.join(D.DATA_DIR, 'uploads', name), out.buf);
    return { url: '/uploads/' + name, width: out.w, height: out.h, resized: out.resized, bytes: out.buf.length };
  });

  /* ----- przesyłanie obrazów (do reklam i ikon gier) ----- */
  r.post('/api/admin/upload', (req, res, p, body) => {
    admin(req);
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'Dozwolone są pliki PNG, JPG, WEBP i GIF');
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 600 * 1024) throw new HttpError(413, 'Obraz może mieć do 600 KB');
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(D.DATA_DIR, 'uploads', name), buf);
    return { url: '/uploads/' + name };
  });
}

module.exports = { register };
