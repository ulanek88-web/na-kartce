'use strict';
/* Wspólne funkcje domeny: gry, rankingi, ligi. */
const D = require('./db');
const E = require('../shared/engines');

function parseParams(g) { try { return JSON.parse(g.params || '{}'); } catch (e) { return {}; } }
function engineOf(g) {
  if (!g.engine) throw new Error('Gra nie ma silnika');
  return E.make(g.engine, parseParams(g));
}
function gamePublic(g) {
  let kind = null, extra = {};
  if (g.engine && E.registry[g.engine]) {
    const e = E.make(g.engine, parseParams(g));
    kind = e.kind;
    if (e.kind === 'mnk') extra = { w: e.w, h: e.h, k: e.k, gravity: e.gravity };
    if (e.kind === 'checkers') extra = { n: e.n };
    if (e.kind === 'dots') extra = { w: e.w, h: e.h };
    if (e.kind === 'race') extra = { w: e.w, h: e.h, lp: e.laps };
  }
  return {
    id: g.id, slug: g.slug, name: g.name, icon: g.icon, iconUrl: g.icon_url || null, hue: g.hue, category: g.category,
    description: g.description, rules: g.rules, engine: g.engine, kind, board: extra, status: g.status,
    timeSec: g.time_sec, incSec: g.inc_sec, rated: !!g.rated, bots: !!g.bots,
    plugin: g.plugin || null, version: g.plugin_version || null, config: (() => { try { return JSON.parse(g.cfg || '{}'); } catch (e) { return {}; } })()
  };
}
const gameBySlug = (slug) => D.get('SELECT * FROM games WHERE slug=?', slug);
const gameById = (id) => D.get('SELECT * FROM games WHERE id=?', id);
const playable = (g) => g && g.status === 'active' && g.engine && E.registry[g.engine];

function ratingOf(uid, gid) {
  let r = D.get('SELECT * FROM ratings WHERE user_id=? AND game_id=?', uid, gid);
  if (!r) {
    const def = D.sNum('default_rating') || 1200;
    D.run('INSERT OR IGNORE INTO ratings(user_id,game_id,rating,peak,updated_at) VALUES(?,?,?,?,?)', uid, gid, def, def, D.now());
    r = D.get('SELECT * FROM ratings WHERE user_id=? AND game_id=?', uid, gid);
  }
  return r;
}
function ratingValue(uid, gid) {
  const r = D.get('SELECT rating FROM ratings WHERE user_id=? AND game_id=?', uid, gid);
  return r ? r.rating : (D.sNum('default_rating') || 1200);
}
function eloDelta(r, rOpp, score, games) {
  const k = (D.sNum('k_factor') || 24) * (games < 30 ? 1.5 : 1);
  const e = 1 / (1 + Math.pow(10, (rOpp - r) / 400));
  return Math.round(k * (score - e));
}

/* ---------- okresy ---------- */
function periodStart(p) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (p === 'd') return d.getTime();
  if (p === 'w') { const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getTime(); }
  if (p === 'm') { d.setDate(1); return d.getTime(); }
  if (p === 'y') { d.setMonth(0, 1); return d.getTime(); }
  return 0;
}
const weekStart = () => periodStart('w');
function daysToWeekEnd() { return Math.max(1, Math.ceil((weekStart() + 7 * 86400000 - Date.now()) / 86400000)); }

/* ---------- ligi (punkty tygodniowe z partii rankingowych) ---------- */
function leagues() { try { return JSON.parse(D.settings().leagues); } catch (e) { return []; } }
function leagueFor(pts) {
  const L = leagues();
  let i = 0;
  L.forEach((l, k) => { if (pts >= l.min) i = k; });
  const nx = L[i + 1] || null;
  return { index: i, name: L[i] ? L[i].n : '', color: L[i] ? L[i].color : '#888', points: pts, next: nx ? { name: nx.n, min: nx.min } : null,
    pct: nx ? Math.max(0, Math.min(1, (pts - L[i].min) / (nx.min - L[i].min))) : 1, daysLeft: daysToWeekEnd() };
}
function seasonPoints(uid) {
  const r = D.get('SELECT COALESCE(SUM(league_pts),0) AS p FROM events WHERE user_id=? AND ts>=?', uid, weekStart());
  return Math.max(0, r.p);
}

/* ---------- ranking ---------- */
const notBanned = '(u.banned_until=0 OR (u.banned_until>0 AND u.banned_until<?))';
function ranking(gid, period, limit, meId) {
  const now = D.now();
  let rows;
  if (period === 'a' || !period) {
    rows = D.all(`SELECT u.id,u.nick,u.hue,r.rating,r.games,r.wins,r.losses,r.draws,r.peak FROM ratings r JOIN users u ON u.id=r.user_id
      WHERE r.game_id=? AND u.guest=0 AND ${notBanned} AND r.games>0 ORDER BY r.rating DESC, r.games DESC LIMIT 5000`, gid, now);
    rows.forEach((r) => { r.pts = r.rating; });
  } else {
    rows = D.all(`SELECT u.id,u.nick,u.hue,COALESCE(r.rating,0) AS rating,COUNT(*) AS games,SUM(e.outcome=1) AS wins,SUM(e.outcome=-1) AS losses,SUM(e.outcome=0) AS draws,
      SUM(e.pts) AS pts,SUM(e.delta) AS delta FROM events e JOIN users u ON u.id=e.user_id LEFT JOIN ratings r ON r.user_id=e.user_id AND r.game_id=e.game_id
      WHERE e.game_id=? AND e.ts>=? AND u.guest=0 AND ${notBanned} GROUP BY e.user_id ORDER BY pts DESC, wins DESC, games ASC LIMIT 5000`, gid, periodStart(period), now);
  }
  rows.forEach((r, i) => { r.rank = i + 1; });
  let me = null;
  if (meId) { const f = rows.find((r) => r.id === meId); if (f) me = Object.assign({}, f); }
  const top = rows.slice(0, limit).map((r) => ({ rank: r.rank, uid: r.id, nick: r.nick, hue: r.hue, rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, pts: r.pts, delta: r.delta || 0 }));
  return { rows: top, total: rows.length, me: me && { rank: me.rank, rating: me.rating, pts: me.pts, games: me.games } };
}

function userPublic(u) {
  return { id: u.id, nick: u.nick, hue: u.hue, guest: !!u.guest, role: u.role, bio: u.bio, xp: u.xp, createdAt: u.created_at };
}
const levelOfXp = (xp) => 1 + Math.floor(xp / 100);

module.exports = { parseParams, engineOf, gamePublic, gameBySlug, gameById, playable, ratingOf, ratingValue, eloDelta, periodStart, weekStart,
  leagueFor, seasonPoints, leagues, ranking, userPublic, levelOfXp, daysToWeekEnd };
