'use strict';
/* Forum dyskusyjne zintegrowane z kontami graczy (jedno konto do gry i forum).
 *
 * Struktura: kategorie -> działy -> tematy -> posty (tabele forum_categories, forum_boards, forum_topics, forum_posts).
 * Kategoria „STREFA GIER” ma działy generowane automatycznie dla każdej AKTYWNEJ gry (syncGames()).
 *
 * Uprawnienia (liczone wyłącznie na serwerze):
 *   gość            – tylko czyta (zakaz pisania: „Musisz się zarejestrować…”)
 *   gracz           – zakłada tematy (poza działami „tylko personel”), odpowiada, cytuje, edytuje WŁASNE posty
 *   Moderator Forum – wpis w forum_moderators (nadaje Super Admin w /admin); NIE ma dostępu do panelu /admin.
 *                     Edytuje/usuwa cudze posty, przykleja, zamyka, przenosi i usuwa tematy, wystawia ostrzeżenia i blokady pisania.
 *   Moderator (rola mod z panelu) ma te same uprawnienia na forum; Super Admin dodatkowo zarządza kategoriami i działami.
 * Anty-spam: cenzura (censor.js) tytułu i treści, odstęp między postami (ustawienie forum_cooldown_sec, domyślnie 30 s),
 *            limit linków/obrazków, wykrywanie powtórzonego posta, limit godzinowy, blokady pisania (forum_bans), wyciszenie konta. */
const D = require('./db');
const A = require('./auth');
const G = require('./game');
const RT = require('./realtime');
const CENSOR = require('./censor');
const BB = require('../shared/bbcode');
const { HttpError, clientIp } = require('./http');

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const ip = clientIp;

const PER_TOPICS = 20, PER_POSTS = 15, MAX_BODY = 10000, MAX_LINKS = 5, MAX_IMAGES = 5;

/* ---------- rangi użytkowników (liczba postów / wygrane rankingowe) ---------- */
const POST_RANKS = [[0, 'Nowicjusz'], [5, 'Uczeń Kartki'], [25, 'Stały Bywalec'], [100, 'Weteran Kartki'], [300, 'Legenda Forum']];
const MASTER_WINS = 25;      // tyle wygranych rankingowych w jednej grze daje tytuł „Mistrz …”
const GENITIVE = { szachy: 'Szachów', warcaby: 'Warcabów', gomoku: 'Gomoku', 'kolko-krzyzyk': 'Kółka i Krzyżyka', czworki: 'Czwórek', reversi: 'Reversi',
  'kolko-krzyzyk-5': 'Kółka i Krzyżyka 5×5', 'piatki-19': 'Piątek 19×19', 'czworki-xl': 'Czwórek XL' };
function rankFor(posts, top) {
  if (top && top.wins >= MASTER_WINS) return GENITIVE[top.slug] ? 'Mistrz ' + GENITIVE[top.slug] : 'Mistrz gry ' + top.name;
  let r = POST_RANKS[0][1]; for (const [min, name] of POST_RANKS) if (posts >= min) r = name;
  return r;
}

/* ---------- uprawnienia ---------- */
const enabled = () => D.sBool('forum_enabled');
const needEnabled = () => { if (!enabled()) throw new HttpError(403, 'Forum jest chwilowo wyłączone'); };
const isForumMod = (uid) => !!D.get('SELECT 1 FROM forum_moderators WHERE user_id=?', uid);
function levelOf(u) { if (!u) return 0; if (u.role === 'admin') return 3; if (u.role === 'mod') return 2; return isForumMod(u.id) ? 1 : 0; }
const BADGE = { 3: 'Super Admin', 2: 'Moderator', 1: 'Moderator Forum' };
function perms(u) {
  const lvl = levelOf(u);
  return { level: lvl, staff: lvl >= 1, admin: lvl === 3, signedIn: !!u, guest: !!(u && u.guest) };
}
function activeBan(uid) {
  const b = D.get('SELECT * FROM forum_bans WHERE user_id=?', uid);
  return b && (b.until === -1 || b.until > Date.now()) ? b : null;
}
/** Zwraca komunikat, dlaczego użytkownik NIE może pisać (albo null). */
function writeBlock(u) {
  if (!u) return 'Zaloguj się, aby pisać na forum';
  if (u.guest) return RT.GUEST_CHAT_MSG;
  const b = activeBan(u.id);
  if (b) return 'Masz blokadę pisania na forum' + (b.until > 0 ? ' do ' + new Date(b.until).toLocaleString('pl-PL') : ' (bezterminowo)') + (b.reason ? ': ' + b.reason : '');
  if (u.muted_until === -1 || u.muted_until > Date.now()) return 'Twoje konto jest wyciszone – nie możesz pisać na forum';
  return null;
}
function writer(req) {
  needEnabled();
  const u = A.requireUser(req), msg = writeBlock(u);
  if (msg) throw new HttpError(403, msg);
  return { u, P: perms(u) };
}
const meInfo = (u) => { const P = perms(u), msg = writeBlock(u); return { signedIn: !!u, guest: !!(u && u.guest), canWrite: !msg, writeMsg: msg, staff: P.staff, admin: P.admin, id: u ? u.id : 0 }; };

/* ---------- wspólne pomocnicze ---------- */
function logAction(adminId, userId, action, note) { D.run('INSERT INTO mod_actions(admin_id,user_id,action,note,until,ts) VALUES(?,?,?,?,0,?)', adminId, userId || null, action, String(note || '').slice(0, 200), D.now()); }

function authors(ids) {
  ids = [...new Set(ids.filter(Boolean))];
  const out = {}; if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const users = D.all(`SELECT id,nick,hue,role,created_at FROM users WHERE id IN (${ph})`, ...ids);
  const cnt = {}; D.all(`SELECT user_id,COUNT(*) AS n FROM forum_posts WHERE user_id IN (${ph}) GROUP BY user_id`, ...ids).forEach((x) => { cnt[x.user_id] = x.n; });
  const top = {}; D.all(`SELECT r.user_id,g.slug,g.name,r.wins FROM ratings r JOIN games g ON g.id=r.game_id WHERE r.user_id IN (${ph}) AND r.wins>0 ORDER BY r.wins DESC`, ...ids).forEach((x) => { if (!top[x.user_id]) top[x.user_id] = x; });
  const fm = new Set(D.all(`SELECT user_id FROM forum_moderators WHERE user_id IN (${ph})`, ...ids).map((x) => x.user_id));
  for (const u of users) {
    const lvl = u.role === 'admin' ? 3 : u.role === 'mod' ? 2 : fm.has(u.id) ? 1 : 0, posts = cnt[u.id] || 0;
    out[u.id] = { id: u.id, nick: u.nick, hue: u.hue, badge: BADGE[lvl] || null, level: lvl, rank: rankFor(posts, top[u.id]), posts, joined: u.created_at };
  }
  return out;
}
const ghost = (id) => ({ id, nick: 'Usunięty gracz', hue: 150, badge: null, level: 0, rank: POST_RANKS[0][1], posts: 0, joined: 0 });

/* odświeża liczniki tematu; usuwa temat, gdy nie ma w nim postów */
function refreshTopic(id) {
  const agg = D.get('SELECT COUNT(*) AS n, MAX(id) AS last FROM forum_posts WHERE topic_id=?', id);
  if (!agg.n) { D.run('DELETE FROM forum_topics WHERE id=?', id); return false; }
  const lp = D.get('SELECT user_id,created_at FROM forum_posts WHERE id=?', agg.last);
  D.run('UPDATE forum_topics SET posts_count=?, last_post_at=?, last_user_id=? WHERE id=?', agg.n, lp.created_at, lp.user_id, id);
  return true;
}

/* ---------- działy dla gier (automatycznie) ---------- */
let gameSig = null;
function syncGames() {
  const games = D.all('SELECT id,name,slug,status,sort_order FROM games ORDER BY sort_order,id');
  const sig = games.map((g) => g.id + ':' + g.name + ':' + g.status + ':' + g.sort_order).join('|');
  if (sig === gameSig) return;
  D.tx(() => {
    let cat = D.get("SELECT id FROM forum_categories WHERE system_key='games'");
    if (!cat) cat = { id: D.run("INSERT INTO forum_categories(title,sort,system_key,created_at) VALUES('STREFA GIER',20,'games',?)", D.now()).id };
    games.forEach((g, i) => {
      const active = g.status === 'active', b = D.get('SELECT id FROM forum_boards WHERE game_id=?', g.id);
      if (!b) {
        if (!active) return;
        D.run('INSERT INTO forum_boards(category_id,title,description,sort,game_id,created_at) VALUES(?,?,?,?,?,?)', cat.id, g.name,
          'Strategie, propozycje zmian w grze i szukanie rywali do turniejów – ' + g.name + '.', (i + 1) * 10, g.id, D.now());
      } else D.run('UPDATE forum_boards SET title=?, sort=?, game_off=? WHERE id=?', g.name, (i + 1) * 10, active ? 0 : 1, b.id);
    });
    D.run('UPDATE forum_boards SET game_off=1 WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games)');
  });
  gameSig = sig;
}

const visibleBoard = (b, P) => b && ((!b.hidden && !b.game_off) || (P && P.admin));
function boardOr404(id, P) {
  const b = D.get('SELECT b.*, c.title AS cat_title FROM forum_boards b JOIN forum_categories c ON c.id=b.category_id WHERE b.id=?', int(id, 0));
  if (!visibleBoard(b, P)) throw new HttpError(404, 'Nie ma takiego działu');
  return b;
}

/* ---------- walidacja treści (anty-spam) ---------- */
const lastPostAt = new Map();
function checkContent(P, title, body) {
  if (title != null) {
    if (title.length < 3) throw new HttpError(400, 'Tytuł tematu: co najmniej 3 znaki');
    if (CENSOR.isProfane(title)) throw new HttpError(400, 'Twój tytuł zawiera niedozwolone słowa');
  }
  if (body.length < 2) throw new HttpError(400, 'Post jest za krótki');
  if (body.length > MAX_BODY) throw new HttpError(413, 'Post może mieć do ' + MAX_BODY + ' znaków');
  if (CENSOR.isProfane(body)) throw new HttpError(400, 'Twój post zawiera niedozwolone słowa');
  if (!P.staff) {
    const c = BB.count(body);
    if (c.links > MAX_LINKS) throw new HttpError(400, 'Maksymalnie ' + MAX_LINKS + ' linków w jednym poście');
    if (c.images > MAX_IMAGES) throw new HttpError(400, 'Maksymalnie ' + MAX_IMAGES + ' obrazków w jednym poście');
  }
}
/** Limit: 1 post na `forum_cooldown_sec` (domyślnie 30 s) + 60 postów na godzinę; personel jest zwolniony. Sprawdzenie i zapis są synchroniczne (brak wyścigu). */
function checkRate(u, P, body) {
  if (P.staff) return;
  const cd = Math.max(0, D.sNum('forum_cooldown_sec') || 0), last = D.get('SELECT body,created_at FROM forum_posts WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id);
  if (last && cd) {
    const left = Math.ceil((last.created_at + cd * 1000 - Date.now()) / 1000);
    if (left > 0) throw new HttpError(429, 'Poczekaj jeszcze ' + left + ' s przed kolejnym postem');
  }
  if (last && last.body === body && Date.now() - last.created_at < 600000) throw new HttpError(409, 'Taki sam post został już wysłany');
  A.rateLimit('forumpost:' + u.id, 60, 3600000);
}
const clampPage = (v, pages) => Math.max(1, Math.min(pages, int(v, 1)));

/* sankcje: wyższy poziom może karać niższy; nikt nie karze siebie */
function sanctionTarget(me, id) {
  const t = D.get('SELECT * FROM users WHERE id=? AND deleted_at=0', int(id, 0));
  if (!t) throw new HttpError(404, 'Nie ma takiego użytkownika');
  if (t.id === me.id) throw new HttpError(400, 'Nie możesz wykonać tej akcji na sobie');
  if (t.guest) throw new HttpError(400, 'Goście i tak nie mogą pisać na forum');
  if (levelOf(t) >= levelOf(me)) throw new HttpError(403, 'Nie masz uprawnień do karania tego użytkownika');
  return t;
}
const needStaff = (req) => { needEnabled(); const u = A.requireUser(req); if (levelOf(u) < 1) throw new HttpError(403, 'Tylko moderatorzy forum'); return u; };
const viewSeen = new Map();

function register(r) {
  /* ================= PUBLICZNE: odczyt ================= */
  r.get('/api/forum', (req) => {
    needEnabled(); syncGames();
    const u = A.optionalUser(req);
    const cats = D.all('SELECT * FROM forum_categories ORDER BY sort,id');
    const boards = D.all('SELECT b.*, g.slug AS game_slug FROM forum_boards b LEFT JOIN games g ON g.id=b.game_id WHERE b.hidden=0 AND b.game_off=0 ORDER BY b.sort,b.id');
    const agg = {}; D.all('SELECT board_id, COUNT(*) AS topics, COALESCE(SUM(posts_count),0) AS posts FROM forum_topics GROUP BY board_id').forEach((x) => { agg[x.board_id] = x; });
    const lastT = {}; const uids = [];
    for (const b of boards) {
      const t = D.get('SELECT id,title,last_post_at,last_user_id FROM forum_topics WHERE board_id=? ORDER BY last_post_at DESC LIMIT 1', b.id);
      if (t) { lastT[b.id] = t; uids.push(t.last_user_id); }
    }
    const latest = D.all(`SELECT t.id,t.title,t.last_post_at,t.last_user_id,t.posts_count,b.title AS board FROM forum_topics t JOIN forum_boards b ON b.id=t.board_id
      WHERE b.hidden=0 AND b.game_off=0 ORDER BY t.last_post_at DESC LIMIT 6`);
    latest.forEach((t) => uids.push(t.last_user_id));
    const au = authors(uids), nick = (id) => (au[id] || ghost(id)).nick;
    return {
      categories: cats.map((c) => ({ id: c.id, title: c.title, boards: boards.filter((b) => b.category_id === c.id).map((b) => ({
        id: b.id, title: b.title, description: b.description, staffOnly: !!b.staff_only, game: b.game_slug || null,
        topics: (agg[b.id] || {}).topics || 0, posts: (agg[b.id] || {}).posts || 0,
        last: lastT[b.id] ? { topicId: lastT[b.id].id, title: lastT[b.id].title, nick: nick(lastT[b.id].last_user_id), ts: lastT[b.id].last_post_at } : null })) })).filter((c) => c.boards.length),
      latest: latest.map((t) => ({ id: t.id, title: t.title, board: t.board, replies: t.posts_count - 1, nick: nick(t.last_user_id), ts: t.last_post_at })),
      me: meInfo(u)
    };
  });

  r.get('/api/forum/boards/:id', (req, res, p, body, q) => {
    needEnabled(); syncGames();
    const u = A.optionalUser(req), P = perms(u), b = boardOr404(p.id, P);
    const total = D.get('SELECT COUNT(*) AS n FROM forum_topics WHERE board_id=?', b.id).n, pages = Math.max(1, Math.ceil(total / PER_TOPICS)), page = clampPage(q.get('page'), pages);
    const rows = D.all('SELECT * FROM forum_topics WHERE board_id=? ORDER BY sticky DESC, last_post_at DESC LIMIT ? OFFSET ?', b.id, PER_TOPICS, (page - 1) * PER_TOPICS);
    const au = authors(rows.flatMap((t) => [t.user_id, t.last_user_id])), nm = (id) => (au[id] || ghost(id)).nick;
    const me = meInfo(u);
    return {
      board: { id: b.id, title: b.title, description: b.description, staffOnly: !!b.staff_only, category: b.cat_title, hidden: !!(b.hidden || b.game_off) },
      topics: rows.map((t) => ({ id: t.id, title: t.title, sticky: !!t.sticky, locked: !!t.locked, author: nm(t.user_id), replies: t.posts_count - 1, views: t.views, createdAt: t.created_at, last: { nick: nm(t.last_user_id), ts: t.last_post_at } })),
      page, pages, total, canCreate: me.canWrite && (!b.staff_only || P.staff), me
    };
  });

  r.get('/api/forum/topics/:id', (req, res, p, body, q) => {
    needEnabled(); syncGames();
    const u = A.optionalUser(req), P = perms(u), t = D.get('SELECT * FROM forum_topics WHERE id=?', int(p.id, 0));
    if (!t) throw new HttpError(404, 'Nie ma takiego tematu');
    const b = boardOr404(t.board_id, P);
    const pages = Math.max(1, Math.ceil(t.posts_count / PER_POSTS));
    let page = clampPage(q.get('page'), pages);
    if (q.get('post')) { const idx = D.get('SELECT COUNT(*) AS n FROM forum_posts WHERE topic_id=? AND id<=?', t.id, int(q.get('post'), 0)).n; if (idx) page = clampPage(Math.ceil(idx / PER_POSTS), pages); }
    if (q.get('page') === 'last') page = pages;
    const key = (u ? 'u' + u.id : 'ip' + ip(req)) + ':' + t.id, nowT = Date.now();
    if (nowT - (viewSeen.get(key) || 0) > 1800000) {
      viewSeen.set(key, nowT); D.run('UPDATE forum_topics SET views=views+1 WHERE id=?', t.id);
      if (viewSeen.size > 20000) for (const [k, v] of viewSeen) if (nowT - v > 1800000) viewSeen.delete(k);
    }
    const rows = D.all('SELECT * FROM forum_posts WHERE topic_id=? ORDER BY id LIMIT ? OFFSET ?', t.id, PER_POSTS, (page - 1) * PER_POSTS);
    const au = authors(rows.flatMap((x) => [x.user_id, x.edited_by])), first = D.get('SELECT MIN(id) AS id FROM forum_posts WHERE topic_id=?', t.id).id;
    const me = meInfo(u);
    const canTouch = (post) => {         // kto może edytować/usuwać dany post
      if (!u) return { edit: false, del: false };
      const au2 = au[post.user_id] || ghost(post.user_id), own = post.user_id === u.id;
      const mod = P.staff && (P.admin || au2.level < P.level || own);
      return { edit: me.canWrite && ((own && (!t.locked || P.staff)) || mod), del: P.staff && mod };
    };
    return {
      topic: { id: t.id, title: t.title, sticky: !!t.sticky, locked: !!t.locked, views: t.views + 0, posts: t.posts_count, createdAt: t.created_at, firstPostId: first,
        board: { id: b.id, title: b.title, category: b.cat_title }, authorId: t.user_id },
      posts: rows.map((x, i) => { const c = canTouch(x); return { id: x.id, n: (page - 1) * PER_POSTS + i + 1, author: au[x.user_id] || ghost(x.user_id), body: x.body, createdAt: x.created_at, editedAt: x.edited_at || 0, editedBy: x.edited_by ? (au[x.edited_by] || ghost(x.edited_by)).nick : null, canEdit: c.edit, canDelete: c.del, first: x.id === first }; }),
      page, pages, me,
      canReply: me.canWrite && (!t.locked || P.staff), replyBlock: !me.canWrite ? me.writeMsg : (t.locked && !P.staff ? 'Temat jest zamknięty' : null)
    };
  });

  r.get('/api/forum/posts/:id', (req, res, p) => {      // rozwiązuje numer posta na temat + stronę (linki z cytatów i powiadomień)
    needEnabled();
    const post = D.get('SELECT id,topic_id FROM forum_posts WHERE id=?', int(p.id, 0));
    if (!post) throw new HttpError(404, 'Ten post już nie istnieje');
    const idx = D.get('SELECT COUNT(*) AS n FROM forum_posts WHERE topic_id=? AND id<=?', post.topic_id, post.id).n;
    return { topicId: post.topic_id, page: Math.ceil(idx / PER_POSTS) };
  });

  r.get('/api/forum/users/:nick', (req, res, p) => {
    needEnabled();
    const me = A.optionalUser(req), P = perms(me);
    const u = D.get('SELECT * FROM users WHERE nick_lc=? AND guest=0 AND deleted_at=0', p.nick.toLowerCase());
    if (!u) throw new HttpError(404, 'Nie ma takiego gracza');
    const a = authors([u.id])[u.id];
    const topics = D.get('SELECT COUNT(*) AS n FROM forum_topics WHERE user_id=?', u.id).n;
    const recent = D.all(`SELECT p.id,p.created_at,p.body,t.id AS tid,t.title FROM forum_posts p JOIN forum_topics t ON t.id=p.topic_id JOIN forum_boards b ON b.id=t.board_id
      WHERE p.user_id=? AND b.hidden=0 AND b.game_off=0 ORDER BY p.id DESC LIMIT 8`, u.id).map((x) => ({ id: x.id, topicId: x.tid, title: x.title, excerpt: BB.strip(x.body, 120), ts: x.created_at }));
    const self = me && me.id === u.id, see = P.staff || self;
    const ban = see ? activeBan(u.id) : null;
    return {
      user: Object.assign({}, a, { topics }), recent,
      warnings: see ? D.all('SELECT w.id,w.reason,w.created_at,m.nick AS mod FROM forum_warnings w LEFT JOIN users m ON m.id=w.mod_id WHERE w.user_id=? ORDER BY w.id DESC LIMIT 20', u.id).map((w) => ({ id: w.id, reason: w.reason, ts: w.created_at, mod: P.staff ? w.mod : null })) : null,
      ban: ban ? { until: ban.until, reason: ban.reason } : null,
      canSanction: !!(P.staff && me.id !== u.id && levelOf(u) < P.level)
    };
  });

  /* ================= PISANIE ================= */
  r.post('/api/forum/boards/:id/topics', (req, res, p, body) => {
    const { u, P } = writer(req);
    syncGames();
    const b = boardOr404(p.id, P);
    if (b.staff_only && !P.staff) throw new HttpError(403, 'W tym dziale tematy zakładają tylko administratorzy i moderatorzy – możesz odpowiadać w istniejących');
    const title = str(body.title, 120).replace(/\s+/g, ' '), text = String(body.body || '').replace(/\r\n?/g, '\n').trim();
    checkContent(P, title, text); checkRate(u, P, text);
    const now = D.now();
    return D.tx(() => {
      const tid = D.run('INSERT INTO forum_topics(board_id,user_id,title,posts_count,last_user_id,created_at,last_post_at) VALUES(?,?,?,1,?,?,?)', b.id, u.id, title, u.id, now, now).id;
      const pid = D.run('INSERT INTO forum_posts(topic_id,user_id,body,created_at) VALUES(?,?,?,?)', tid, u.id, text, now).id;
      return { id: tid, postId: pid };
    });
  });

  r.post('/api/forum/topics/:id/posts', (req, res, p, body) => {
    const { u, P } = writer(req);
    const t = D.get('SELECT * FROM forum_topics WHERE id=?', int(p.id, 0));
    if (!t) throw new HttpError(404, 'Nie ma takiego tematu');
    boardOr404(t.board_id, P);
    if (t.locked && !P.staff) throw new HttpError(403, 'Temat jest zamknięty');
    const text = String(body.body || '').replace(/\r\n?/g, '\n').trim();
    checkContent(P, null, text); checkRate(u, P, text);
    const now = D.now();
    const out = D.tx(() => { const pid = D.run('INSERT INTO forum_posts(topic_id,user_id,body,created_at) VALUES(?,?,?,?)', t.id, u.id, text, now).id; refreshTopic(t.id); return pid; });
    const n = D.get('SELECT posts_count AS n FROM forum_topics WHERE id=?', t.id).n;
    if (t.user_id !== u.id) { try { RT.notify(t.user_id, u.nick + ' odpowiedział(a) w Twoim temacie „' + t.title.slice(0, 60) + '”', '#/forum/p/' + out); } catch (e) { /* powiadomienie nie jest krytyczne */ } }
    return { id: out, topicId: t.id, page: Math.ceil(n / PER_POSTS) };
  });

  r.put('/api/forum/posts/:id', (req, res, p, body) => {
    const { u, P } = writer(req);
    const post = D.get('SELECT * FROM forum_posts WHERE id=?', int(p.id, 0));
    if (!post) throw new HttpError(404, 'Ten post już nie istnieje');
    const t = D.get('SELECT * FROM forum_topics WHERE id=?', post.topic_id); boardOr404(t.board_id, P);
    const own = post.user_id === u.id, target = authors([post.user_id])[post.user_id] || ghost(post.user_id);
    const mod = P.staff && (P.admin || target.level < P.level || own);
    if (!(own && (!t.locked || P.staff)) && !mod) throw new HttpError(403, t.locked && own ? 'Temat jest zamknięty' : 'Możesz edytować tylko własne posty');
    const text = String(body.body || '').replace(/\r\n?/g, '\n').trim();
    const first = D.get('SELECT MIN(id) AS id FROM forum_posts WHERE topic_id=?', t.id).id === post.id;
    const title = first && body.title != null ? str(body.title, 120).replace(/\s+/g, ' ') : null;
    checkContent(P, title, text);
    D.tx(() => {
      D.run('UPDATE forum_posts SET body=?, edited_at=?, edited_by=? WHERE id=?', text, D.now(), u.id, post.id);
      if (title != null && title !== t.title) D.run('UPDATE forum_topics SET title=? WHERE id=?', title, t.id);
    });
    if (!own) logAction(u.id, post.user_id, 'forum:edit_post', '#' + post.id + ' w „' + t.title + '”');
    return { ok: true };
  });

  r.delete('/api/forum/posts/:id', (req, res, p) => {
    const u = needStaff(req), P = perms(u);
    const post = D.get('SELECT * FROM forum_posts WHERE id=?', int(p.id, 0));
    if (!post) throw new HttpError(404, 'Ten post już nie istnieje');
    const target = authors([post.user_id])[post.user_id] || ghost(post.user_id);
    if (!(P.admin || target.level < P.level || post.user_id === u.id)) throw new HttpError(403, 'Nie możesz usunąć posta osoby z wyższymi uprawnieniami');
    const t = D.get('SELECT * FROM forum_topics WHERE id=?', post.topic_id);
    const first = D.get('SELECT MIN(id) AS id FROM forum_posts WHERE topic_id=?', t.id).id === post.id;
    D.tx(() => { if (first) D.run('DELETE FROM forum_topics WHERE id=?', t.id); else { D.run('DELETE FROM forum_posts WHERE id=?', post.id); refreshTopic(t.id); } });
    logAction(u.id, post.user_id, first ? 'forum:delete_topic' : 'forum:delete_post', '„' + t.title + '”');
    return { ok: true, topicDeleted: first, boardId: t.board_id };
  });

  /* ================= MODERACJA TEMATÓW ================= */
  r.post('/api/forum/topics/:id/mod', (req, res, p, body) => {
    const u = needStaff(req), P = perms(u);
    const t = D.get('SELECT * FROM forum_topics WHERE id=?', int(p.id, 0));
    if (!t) throw new HttpError(404, 'Nie ma takiego tematu');
    const act = str(body.action, 12), note = '„' + t.title.slice(0, 80) + '”';
    switch (act) {
      case 'sticky': case 'unsticky': D.run('UPDATE forum_topics SET sticky=? WHERE id=?', act === 'sticky' ? 1 : 0, t.id); break;
      case 'lock': case 'unlock': D.run('UPDATE forum_topics SET locked=? WHERE id=?', act === 'lock' ? 1 : 0, t.id); break;
      case 'move': {
        const b = D.get('SELECT * FROM forum_boards WHERE id=?', int(body.board, 0));
        if (!visibleBoard(b, P)) throw new HttpError(400, 'Wybierz dział docelowy');
        D.run('UPDATE forum_topics SET board_id=? WHERE id=?', b.id, t.id); break;
      }
      case 'delete': D.run('DELETE FROM forum_topics WHERE id=?', t.id); break;
      default: throw new HttpError(400, 'Nieznana akcja');
    }
    logAction(u.id, t.user_id, 'forum:' + act, note);
    return { ok: true };
  });

  r.get('/api/forum/boards', (req) => {          // lista działów do wyboru przy przenoszeniu tematu (tylko personel)
    const u = needStaff(req); syncGames();
    const P = perms(u);
    return D.all(`SELECT b.id,b.title,c.title AS category FROM forum_boards b JOIN forum_categories c ON c.id=b.category_id
      WHERE (b.hidden=0 AND b.game_off=0) OR ${P.admin ? '1' : '0'} ORDER BY c.sort,c.id,b.sort,b.id`);
  });

  /* ================= SANKCJE ================= */
  r.post('/api/forum/users/:id/warn', (req, res, p, body) => {
    const me = needStaff(req), t = sanctionTarget(me, p.id), reason = str(body.reason, 200);
    if (!reason) throw new HttpError(400, 'Podaj powód ostrzeżenia');
    D.run('INSERT INTO forum_warnings(user_id,mod_id,reason,created_at) VALUES(?,?,?,?)', t.id, me.id, reason, D.now());
    RT.notify(t.id, 'Ostrzeżenie od moderatora forum: ' + reason, '#/forum');
    logAction(me.id, t.id, 'forum:warn', reason);
    return { ok: true, warnings: D.get('SELECT COUNT(*) AS n FROM forum_warnings WHERE user_id=?', t.id).n };
  });
  r.post('/api/forum/users/:id/ban', (req, res, p, body) => {
    const me = needStaff(req), t = sanctionTarget(me, p.id), reason = str(body.reason, 200);
    const perm = body.hours === 'perm' || body.hours === -1, h = Math.max(1, Math.min(24 * 365, int(body.hours, 24)));
    const until = perm ? -1 : Date.now() + h * 3600000;
    D.run('INSERT INTO forum_bans(user_id,until,reason,mod_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET until=excluded.until,reason=excluded.reason,mod_id=excluded.mod_id,created_at=excluded.created_at', t.id, until, reason, me.id, D.now());
    RT.notify(t.id, 'Otrzymałeś blokadę pisania na forum' + (reason ? ': ' + reason : ''), '#/forum');
    logAction(me.id, t.id, 'forum:ban', (perm ? 'bezterminowo' : h + ' h') + (reason ? ' – ' + reason : ''));
    return { ok: true };
  });
  r.post('/api/forum/users/:id/unban', (req, res, p) => {
    const me = needStaff(req), t = D.get('SELECT id FROM users WHERE id=?', int(p.id, 0));
    if (!t) throw new HttpError(404, 'Nie ma takiego użytkownika');
    D.run('DELETE FROM forum_bans WHERE user_id=?', t.id); logAction(me.id, t.id, 'forum:unban', '');
    return { ok: true };
  });

  /* ================= CMS FORUM (Super Admin) ================= */
  const admin = (req) => A.requireRole(req, 'admin');
  r.get('/api/forum/admin/overview', (req) => {
    admin(req); syncGames();
    const agg = {}; D.all('SELECT board_id, COUNT(*) AS topics, COALESCE(SUM(posts_count),0) AS posts FROM forum_topics GROUP BY board_id').forEach((x) => { agg[x.board_id] = x; });
    const boards = D.all('SELECT b.*, g.slug AS game_slug FROM forum_boards b LEFT JOIN games g ON g.id=b.game_id ORDER BY b.sort,b.id');
    const now = D.now();
    return {
      categories: D.all('SELECT * FROM forum_categories ORDER BY sort,id').map((c) => ({ id: c.id, title: c.title, sort: c.sort, system: !!c.system_key, boards: boards.filter((b) => b.category_id === c.id).map((b) => ({
        id: b.id, title: b.title, description: b.description, sort: b.sort, staffOnly: !!b.staff_only, hidden: !!b.hidden, gameOff: !!b.game_off, game: b.game_slug || null, system: !!b.system_key,
        topics: (agg[b.id] || {}).topics || 0, posts: (agg[b.id] || {}).posts || 0 })) })),
      moderators: D.all('SELECT m.user_id AS id, u.nick, m.created_at FROM forum_moderators m JOIN users u ON u.id=m.user_id ORDER BY m.created_at').map((m) => ({ id: m.id, nick: m.nick, since: m.created_at })),
      bans: D.all('SELECT b.user_id AS id,u.nick,b.until,b.reason,b.created_at,m.nick AS mod FROM forum_bans b JOIN users u ON u.id=b.user_id LEFT JOIN users m ON m.id=b.mod_id WHERE b.until=-1 OR b.until>? ORDER BY b.created_at DESC', now)
        .map((b) => ({ id: b.id, nick: b.nick, until: b.until, reason: b.reason, mod: b.mod, ts: b.created_at })),
      warnings: D.all('SELECT w.id,w.reason,w.created_at,u.nick,m.nick AS mod FROM forum_warnings w JOIN users u ON u.id=w.user_id LEFT JOIN users m ON m.id=w.mod_id ORDER BY w.id DESC LIMIT 30')
        .map((w) => ({ id: w.id, nick: w.nick, mod: w.mod, reason: w.reason, ts: w.created_at })),
      stats: { topics: D.get('SELECT COUNT(*) AS n FROM forum_topics').n, posts: D.get('SELECT COUNT(*) AS n FROM forum_posts').n }
    };
  });
  const cleanCat = (b) => { const title = str(b.title, 60); if (title.length < 2) throw new HttpError(400, 'Podaj nazwę kategorii (min. 2 znaki)'); return { title }; };
  r.post('/api/forum/admin/categories', (req, res, p, body) => {
    const me = admin(req), c = cleanCat(body), mx = D.get('SELECT COALESCE(MAX(sort),0) AS n FROM forum_categories').n;
    const id = D.run('INSERT INTO forum_categories(title,sort,created_at) VALUES(?,?,?)', c.title, mx + 10, D.now()).id; logAction(me.id, null, 'forum:cat_add', c.title); return { id };
  });
  r.put('/api/forum/admin/categories/:id', (req, res, p, body) => {
    const me = admin(req), c = cleanCat(body);
    if (!D.run('UPDATE forum_categories SET title=? WHERE id=?', c.title, int(p.id, 0)).changes) throw new HttpError(404, 'Nie ma takiej kategorii');
    logAction(me.id, null, 'forum:cat_edit', c.title); return { ok: true };
  });
  r.delete('/api/forum/admin/categories/:id', (req, res, p, body, q) => {
    const me = admin(req), c = D.get('SELECT * FROM forum_categories WHERE id=?', int(p.id, 0));
    if (!c) throw new HttpError(404, 'Nie ma takiej kategorii');
    if (c.system_key === 'games') throw new HttpError(400, 'Kategoria STREFA GIER jest tworzona automatycznie dla gier – nie można jej usunąć');
    const n = D.get('SELECT COUNT(*) AS n FROM forum_boards WHERE category_id=?', c.id).n;
    if (n && q.get('force') !== '1') throw new HttpError(409, 'Kategoria zawiera działy (' + n + '). Potwierdź usunięcie wraz z całą zawartością.');
    if (D.get('SELECT 1 FROM forum_boards WHERE category_id=? AND game_id IS NOT NULL', c.id)) throw new HttpError(400, 'Kategoria zawiera działy gier – przenieś je najpierw do innej kategorii');
    D.run('DELETE FROM forum_categories WHERE id=?', c.id); logAction(me.id, null, 'forum:cat_del', c.title); return { ok: true };
  });
  const cleanBoard = (b) => {
    const title = str(b.title, 60), cat = D.get('SELECT id FROM forum_categories WHERE id=?', int(b.category_id, 0));
    if (title.length < 2) throw new HttpError(400, 'Podaj nazwę działu (min. 2 znaki)');
    if (!cat) throw new HttpError(400, 'Wybierz kategorię');
    return { title, description: str(b.description, 300), category_id: cat.id, staff_only: bool(b.staffOnly), hidden: bool(b.hidden) };
  };
  r.post('/api/forum/admin/boards', (req, res, p, body) => {
    const me = admin(req), b = cleanBoard(body), mx = D.get('SELECT COALESCE(MAX(sort),0) AS n FROM forum_boards WHERE category_id=?', b.category_id).n;
    const id = D.run('INSERT INTO forum_boards(category_id,title,description,sort,staff_only,hidden,created_at) VALUES(?,?,?,?,?,?,?)', b.category_id, b.title, b.description, mx + 10, b.staff_only, b.hidden, D.now()).id;
    logAction(me.id, null, 'forum:board_add', b.title); return { id };
  });
  r.put('/api/forum/admin/boards/:id', (req, res, p, body) => {
    const me = admin(req), ex = D.get('SELECT * FROM forum_boards WHERE id=?', int(p.id, 0));
    if (!ex) throw new HttpError(404, 'Nie ma takiego działu');
    const b = cleanBoard(body);
    D.run('UPDATE forum_boards SET category_id=?,title=?,description=?,staff_only=?,hidden=? WHERE id=?', b.category_id, ex.game_id ? ex.title : b.title, b.description, b.staff_only, b.hidden, ex.id);
    logAction(me.id, null, 'forum:board_edit', b.title); return { ok: true };
  });
  r.delete('/api/forum/admin/boards/:id', (req, res, p, body, q) => {
    const me = admin(req), b = D.get('SELECT * FROM forum_boards WHERE id=?', int(p.id, 0));
    if (!b) throw new HttpError(404, 'Nie ma takiego działu');
    if (b.game_id) throw new HttpError(400, 'Dział gry jest zarządzany automatycznie. Aby go schować, użyj opcji „ukryty”.');
    const n = D.get('SELECT COUNT(*) AS n FROM forum_topics WHERE board_id=?', b.id).n;
    if (n && q.get('force') !== '1') throw new HttpError(409, 'Dział zawiera tematy (' + n + '). Potwierdź usunięcie wraz z całą zawartością.');
    D.run('DELETE FROM forum_boards WHERE id=?', b.id); logAction(me.id, null, 'forum:board_del', b.title); return { ok: true };
  });
  r.post('/api/forum/admin/reorder', (req, res, p, body) => {     // przesunięcie kategorii / działu o jedno miejsce (dir: -1 w górę, 1 w dół)
    admin(req);
    const isCat = body.type === 'category', dir = body.dir === -1 ? -1 : 1, id = int(body.id, 0);
    const table = isCat ? 'forum_categories' : 'forum_boards', row = D.get(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) throw new HttpError(404, 'Nie znaleziono elementu');
    const sibs = isCat ? D.all('SELECT id FROM forum_categories ORDER BY sort,id') : D.all('SELECT id FROM forum_boards WHERE category_id=? ORDER BY sort,id', row.category_id);
    const i = sibs.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= sibs.length) return { ok: true };
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    D.tx(() => sibs.forEach((x, k) => D.run(`UPDATE ${table} SET sort=? WHERE id=?`, (k + 1) * 10, x.id)));
    return { ok: true };
  });
  r.post('/api/forum/admin/moderators', (req, res, p, body) => {      // nadanie roli „Moderator Forum”
    const me = admin(req), nick = str(body.nick, 16).toLowerCase();
    const u = D.get('SELECT id,nick,guest,role FROM users WHERE nick_lc=? AND deleted_at=0', nick);
    if (!u) throw new HttpError(404, 'Nie ma użytkownika o takim nicku');
    if (u.guest) throw new HttpError(400, 'Gość nie może być moderatorem – użytkownik musi mieć konto');
    if (u.role !== 'user') throw new HttpError(400, 'Ten użytkownik ma już uprawnienia personelu (' + (u.role === 'admin' ? 'Super Admin' : 'Moderator') + ')');
    D.run('INSERT OR IGNORE INTO forum_moderators(user_id,granted_by,created_at) VALUES(?,?,?)', u.id, me.id, D.now());
    RT.notify(u.id, 'Zostałeś Moderatorem Forum! Masz teraz rozszerzone uprawnienia na forum.', '#/forum');
    logAction(me.id, u.id, 'forum:mod_grant', u.nick); return { ok: true, id: u.id, nick: u.nick };
  });
  r.delete('/api/forum/admin/moderators/:uid', (req, res, p) => {
    const me = admin(req); D.run('DELETE FROM forum_moderators WHERE user_id=?', int(p.uid, 0)); logAction(me.id, int(p.uid, 0), 'forum:mod_revoke', ''); return { ok: true };
  });
}

module.exports = { register, syncGames, rankFor, levelOf, perms, PER_POSTS, PER_TOPICS };
