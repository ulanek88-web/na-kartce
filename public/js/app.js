/* Na kartce — aplikacja gracza (SPA). Ta sama baza kodu: strona WWW, PWA i aplikacja Android (Capacitor). */
import { api, get, post, del, store, getToken, setToken, Socket, assetUrl, isNative } from './api.js';
import { initExtras, openPlugin } from './extras.js';
import { boardSVG, onCell, promoHTML, symbolStyle } from './boards.js';
import { vForum, forumCard, initForum } from './forum.js';
import { createOfflineMatch, offlineGames, rememberGames, LEVELS } from './offline.js';

const E = window.NKEngines;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERIODS = { d: 'Dziś', w: 'Tydzień', m: 'Miesiąc', y: 'Rok', a: 'Ogólny' };
const BOT_LABEL = { e: ['Łatwy', 'Bot Ania'], m: ['Średni', 'Bot Marek'], h: ['Trudny', 'Bot Hektor'] };
const REASONS = { line: 'linia', draw: 'remis', blocked: 'brak ruchów', count: 'liczba pól', finish: 'meta', dnf: 'za dużo rozbić', limit: 'limit ruchów', mat: 'mat', pat: 'pat', time: 'czas', czas: 'czas', rozłączenie: 'rozłączenie przeciwnika', bezczynność: 'bezczynność (AFK)' };
const ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>',
  rank: '<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4v1a3 3 0 003 3M17 6h3v1a3 3 0 01-3 3"/></svg>',
  cup: '<svg viewBox="0 0 24 24"><path d="M5 4h14M6 4v6a6 6 0 0012 0V4M12 16v4M8 20h8"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 15-5 16 0"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 17V11a6 6 0 0112 0v6l2 2H4zM10 21h4"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  forum: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/></svg>'
};

const S = {
  cfg: {}, me: null, games: [], sock: null, online: 0, match: null, matchAt: 0, eng: null, ui: {}, chat: [], routeId: 0,
  waiting: null, played: 0, deferredInstall: null, lastBot: null, unread: 0, tick: null
};
const gameBy = (slug) => S.games.find((g) => g.slug === slug);
const isGuest = () => !!(S.me && S.me.guest);
const isAdmin = () => !!(S.me && S.me.role === 'admin');
const GUEST_MSG = 'Musisz się zarejestrować, aby móc rozmawiać z innymi graczami';
const isStaff = () => S.me && (S.me.role === 'admin' || S.me.role === 'mod');

/* ---------- narzędzia UI ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800); }
function avatar(nick, hue, cls) { return `<span class="avatar ${cls || ''}" style="--h:${hue == null ? 150 : hue}">${esc((nick || '?').trim().charAt(0).toUpperCase())}</span>`; }
function gameTile(g, cls) {
  const bg = g.iconUrl ? `;background-image:url('${esc(assetUrl(g.iconUrl))}')` : '';
  return `<span class="gt ${cls || ''}" style="--h:${g.hue}${bg}">${g.iconUrl ? '' : esc(g.icon || g.name.charAt(0))}</span>`;
}
function sheet(html, center) {
  closeSheet();
  const l = $('#layer');
  l.innerHTML = `<div class="scrim ${center ? 'center-modal' : ''}" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true">${center ? '' : '<div class="grab"></div>'}${html}</div></div>`;
  return l.firstElementChild;
}
function closeSheet() { $('#layer').innerHTML = ''; clearInterval(S.tablesTimer); S.tablesGame = null; S.tblOpen = false; }
function confirmBox(text, okLabel, danger) {
  return new Promise((res) => {
    sheet(`<h2>${esc(text)}</h2><div class="row"><button class="btn grow" data-act="no">Anuluj</button><button class="btn ${danger ? 'bad' : 'pri'} grow" data-act="yes">${esc(okLabel || 'OK')}</button></div>`, true);
    const l = $('#layer');
    const h = (e) => { const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act; if (a === 'yes' || a === 'no' || a === 'scrim') { e.stopPropagation(); l.removeEventListener('click', h, true); closeSheet(); res(a === 'yes'); } };
    l.addEventListener('click', h, true);
  });
}
const fmtClock = (ms) => { ms = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(ms / 60) + ':' + String(ms % 60).padStart(2, '0'); };
const fmtDate = (ts) => new Date(ts).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' });
const device = () => (isNative || innerWidth < 760 ? 'mobile' : 'desktop');
function haptic(ms) { try { if (navigator.vibrate && store.get('haptic') !== '0') navigator.vibrate(ms); } catch (e) { /* ignore */ } }
let actx;
function sfx(kind) {
  if (store.get('sound') === '0') return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    const f = { move: 520, mine: 640, win: 880, lose: 220, draw: 440 }[kind] || 500;
    o.frequency.setValueAtTime(f, t); if (kind === 'win') o.frequency.exponentialRampToValueAtTime(1320, t + .25);
    if (kind === 'lose') o.frequency.exponentialRampToValueAtTime(130, t + .3);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + (kind === 'move' || kind === 'mine' ? .09 : .35));
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + .4);
  } catch (e) { /* brak audio */ }
}
function applyTheme() {
  const t = store.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = $('meta[name=theme-color]'); if (m) m.content = dark ? '#0B1511' : '#0E7A4F';
}

/* ---------- reklamy ---------- */
async function loadAd(slot, game) {
  if (!S.cfg.adsEnabled) return null;
  try { return (await get('/api/ads?slot=' + slot + '&device=' + device() + (game ? '&game=' + encodeURIComponent(game) : ''))).ad; } catch (e) { return null; }
}
function adHTML(ad, big) {
  if (!ad) return '';
  if (ad.code) return `<div class="adslot"><iframe title="Reklama" loading="lazy" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(ad.code)}"></iframe></div>`;
  const img = ad.imageUrl ? `style="background-image:url('${esc(assetUrl(ad.imageUrl))}')"` : `style="--h:${esc(ad.color || 40)}"`;
  return `<button class="ad" data-act="ad" data-id="${ad.id}" data-url="${esc(ad.linkUrl || '')}"><span class="ad-img" ${img}></span><span class="grow"><small>Reklama${ad.advertiser ? ' · ' + esc(ad.advertiser) : ''}</small><b>${esc(ad.title)}</b>${ad.text ? `<span class="tx">${esc(ad.text)}</span>` : ''}</span></button>`;
}

/* ---------- start ---------- */
async function boot() {
  applyTheme();
  initExtras();
  initForum({ pageTitle, avatar, toast, sheet, closeSheet, confirmBox, fmtDate, reload: () => route(), isAdmin, isGuest, adminUrl: () => adminUrl() });
  try { S.cfg = await get('/api/config', 7000); S.netFail = false; } catch (e) { S.netFail = true; S.cfg = { siteName: 'Na kartce', allowGuests: true, allowRegister: true, forumEnabled: true, leagues: [] }; }
  try { S.games = await get('/api/games', 7000); rememberGames(S.games); } catch (e) { S.games = []; }
  if (getToken() && !S.netFail) {
    try { S.me = (await get('/api/me', 7000)).me; } catch (e) { if (e.status === 401 || e.status === 403) setToken(null); }
  }
  if (S.me) startApp(); else showWelcome();
  if ('serviceWorker' in navigator && !isNative && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredInstall = e; });
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('backButton', () => {
      const r = location.hash.replace(/^#\/?/, '');
      if (!r) window.Capacitor.Plugins.App.exitApp();
      else if (r === 'play' && S.match && S.match.status === 'playing') toast('Dokończ partię lub się poddaj');
      else if (['rank', 'tournaments', 'me'].some((x) => r.startsWith(x))) location.hash = '#/'; else history.back();
    });
  }
}

function showWelcome() {
  closeSheet();
  document.body.classList.add('hide-tabs');
  $('#app').innerHTML = `<div class="welcome">
    <div class="hero"><h1><i></i>Na kartce</h1><p class="lead">${esc(S.cfg.tagline || 'Gry planszowe online z całej Polski.')}</p>
    <div class="pieces">${S.games.filter((g) => g.status === 'active').slice(0, 6).map((g) => gameTile(g)).join('')}</div></div>
    <div class="stack">
      ${S.netFail ? '<div class="card small"><b>Brak połączenia z serwerem.</b> Możesz zagrać offline z komputerem – bez konta i bez internetu.</div>' : ''}
      ${S.cfg.allowGuests && !S.netFail ? '<button class="btn pri block" data-act="guest">Graj jako gość</button>' : ''}
      <button class="btn ${S.netFail ? 'pri' : 'ghost'} block" data-act="offline">🎮 Graj offline z CPU</button>
      ${S.cfg.allowRegister && !S.netFail ? '<button class="btn acc block" data-act="auth" data-mode="register">Załóż konto</button>' : ''}
      ${S.netFail ? '<button class="btn block" data-act="retry">↻ Spróbuj połączyć ponownie</button>' : '<button class="btn ghost block" data-act="auth" data-mode="login">Mam konto – zaloguj się</button>'}
      <p class="muted small" style="text-align:center">Gość gra bez rankingu. Konto daje rankingi, ligę i turnieje.</p>
      <p class="err" id="welErr"></p>
    </div></div>`;
}
function authSheet(mode) {
  const reg = mode === 'register';
  sheet(`<h2>${reg ? (isGuest() ? 'Zachowaj swój postęp' : 'Załóż konto') : 'Zaloguj się'}</h2>
    ${reg && isGuest() ? '<p class="muted small">Konto przejmie Twoje dotychczasowe partie i doświadczenie.</p>' : ''}
    <form data-form="${reg ? 'register' : 'login'}" class="stack" autocomplete="on">
      ${reg ? `<label class="fld"><span>Nick (3–16 znaków)</span><input name="nick" autocomplete="username" maxlength="16" required></label>
      <label class="fld"><span>E-mail</span><input name="email" type="email" autocomplete="email" required></label>`
    : `<label class="fld"><span>Nick lub e-mail</span><input name="login" autocomplete="username" required></label>`}
      <label class="fld"><span>Hasło${reg ? ' (min. 8 znaków)' : ''}</span><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 8 : 1}" required></label>
      <p class="err" id="authErr"></p>
      <button class="btn pri block" type="submit">${reg ? 'Utwórz konto' : 'Zaloguj'}</button>
    </form>
    <button class="btn ghost block" data-act="auth" data-mode="${reg ? 'login' : 'register'}">${reg ? 'Mam już konto' : 'Nie mam konta'}</button>`);
}
async function afterAuth(r) {
  setToken(r.token); S.me = r.me; closeSheet();
  if (S.sock) { S.sock.close(); S.sock = null; }
  S.match = null; startApp();
}

function startApp() {
  document.body.classList.remove('hide-tabs');
  $('#app').innerHTML = `<header class="top"><a class="logo" href="#/"><i></i>Na kartce</a><div class="grow"></div>
    <div class="live"><span class="dot off" id="dot"></span><span id="onl">…</span></div>
    <a class="icon-btn" href="#/notifs" aria-label="Powiadomienia">${ICON.bell}<span class="badge" id="bdg" hidden></span></a></header>
    <main id="view"></main>
    <div class="tabbar"><nav>
      <a href="#/" data-tab="lobby">${ICON.home}Gry</a><a href="#/rank" data-tab="rank">${ICON.rank}Rankingi</a>
      <a href="#/tournaments" data-tab="tournaments">${ICON.cup}Turnieje</a>${S.cfg.forumEnabled === false ? '' : `<a href="#/forum" data-tab="forum">${ICON.forum}Forum</a>`}<a href="#/me" data-tab="me">${ICON.user}Profil</a></nav></div>`;
  setUnread(S.me.unread || 0);
  connectSocket();
  if (!S.tick) S.tick = setInterval(tickClocks, 250);
  window.removeEventListener('hashchange', route); window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/';
  route();
}
function setUnread(n) { S.unread = n; const b = $('#bdg'); if (b) { b.hidden = !n; b.textContent = n > 9 ? '9+' : n; } }

/* ---------- WebSocket ---------- */
function connectSocket() {
  const s = new Socket(); S.sock = s;
  const dot = (on) => { const d = $('#dot'); if (d) d.classList.toggle('off', !on); netBanner(!on); };
  s.on('open', () => dot(true)).on('close', () => dot(false));
  s.on('hello', (m) => { S.online = m.online; showOnline(); if (m.active) handleMatch(m.active); else if (S.match && S.match.status === 'playing' && !S.match.offline) { S.match = null; if (curRoute().name === 'play') location.hash = '#/'; } });
  s.on('online', (m) => { S.online = m.n; showOnline(); });
  s.on('match', (m) => handleMatch(m.m));
  s.on('queued', () => showWaiting('queue'));
  s.on('tables', (m) => renderTables(m));
  s.on('table', (m) => {
    S.tbl = m.table;
    if (S.match && S.match.status === 'playing') return;
    if (S.match && S.match.status === 'over' && curRoute().name === 'play') return renderMatch();
    if (S.tblOpen) paintTable(); else openTable();
  });
  s.on('table_chat', (m) => { if (S.tbl && S.tbl.n === m.n) { S.tbl.chat.push(m.msg); paintChat(); } });
  s.on('table_left', () => { S.tbl = null; S.tblOpen = false; closeSheet(); });
  s.on('table_kicked', (m) => { S.tbl = null; S.tblOpen = false; closeSheet(); toast(m.msg); location.hash = '#/'; });
  s.on('table_lobby', (m) => {
    const box = $('#tInv'); if (!box) return;
    box.innerHTML = `<div class="card stack"><b>Gracze w lobby tej gry</b>${m.list.length ? m.list.map((p) => `<div class="row">${avatar(p.nick, p.hue, 'sm')}<span class="grow">${esc(p.nick)} <span class="muted small">${p.rating}</span></span><button class="btn sm pri" data-act="tinv" data-uid="${p.uid}">Zaproś</button></div>`).join('') : '<span class="muted small">Nikt teraz nie czeka w lobby tej gry.</span>'}</div>`;
  });
  s.on('table_invite', (m) => {
    S.invite = m;
    sheet(`<h2>${esc(m.from.nick)} zaprasza Cię do gry</h2><p class="muted">${esc(m.gameName)} · stół ${m.n}${m.needPin ? ' (prywatny – zaproszenie omija PIN)' : ''}</p><div class="row"><button class="btn grow" data-act="inv_no">Odrzuć</button><button class="btn pri grow" data-act="inv_yes">Dołącz</button></div>`, true);
  });
  s.on('room', (m) => showWaiting('room', m.code));
  s.on('room_closed', () => { if (S.waiting) { S.waiting = null; closeSheet(); } });
  s.on('chat', (m) => { if (S.match && S.match.id === m.id) { S.chat.push(m); renderChat(); } });
  s.on('notice', (m) => toast(m.msg));
  s.on('error', (m) => {
    toast(m.msg);
    if (!m.fatal) return;
    /* sesja zakończona przez serwer: sprawdzamy, czy token nadal działa (np. po zmianie hasła dostaliśmy nowy) – wtedy łączymy się ponownie, inaczej wylogowanie */
    S.sock.close();
    setTimeout(async () => {
      try { S.me = (await get('/api/me', 7000)).me; connectSocket(); } catch (e) { if (e.status === 401 || e.status === 403) { setToken(null); S.me = null; showWelcome(); } else { connectSocket(); } }
    }, 1500);
  });
  s.on('notif', (m) => { toast(m.text); setUnread(S.unread + 1); haptic(60); });
  s.connect();
}
function netBanner(off) {
  let b = $('#netb');
  if (off && !b) { b = document.createElement('div'); b.id = 'netb'; b.className = 'banner-net'; b.textContent = 'Łączenie z serwerem…'; document.body.appendChild(b); }
  if (!off && b) b.remove();
}
function showOnline() { const o = $('#onl'); if (o) o.textContent = S.online + ' online'; }

/* ---------- routing ---------- */
function curRoute() { const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); return { name: p[0] || 'lobby', a: p[1], b: p[2], c: p[3] }; }
const VIEWS = { forum: (v, r, ok) => vForum(v, r, ok), offline: vOffline, lobby: vLobby, rank: vRank, tournaments: vTournaments, tournament: vTournament, me: vMe, u: vUser, page: vPage, play: vPlay, replay: vReplay, notifs: vNotifs };
async function route() {
  if (!S.me && !S.offlineShell) return;
  const r = curRoute(), id = ++S.routeId;
  if (S.offlineShell && r.name !== 'offline' && r.name !== 'play') { location.hash = '#/offline'; return; }
  if (r.name !== 'play' && S.match && S.match.status === 'over') S.match = null;
  const view = $('#view'); if (!view) return;
  if (S.watching && r.name !== 'play') { S.sock.send({ t: 'unwatch', id: S.watching }); S.watching = null; if (S.match && S.match.you === 0) S.match = null; }
  document.body.classList.toggle('hide-tabs', r.name === 'play');
  view.className = r.name === 'play' ? 'play' : '';
  const tab = { lobby: 'lobby', rank: 'rank', tournaments: 'tournaments', tournament: 'tournaments', me: 'me', u: 'me', forum: 'forum' }[r.name];
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  view.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  window.scrollTo(0, 0);
  try { await (VIEWS[r.name] || vLobby)(view, r, () => id === S.routeId); } catch (e) {
    if (id !== S.routeId) return;
    view.innerHTML = `<div class="empty">${esc(e.message)}<br><br><button class="btn" data-act="reload">Spróbuj ponownie</button></div>`;
  }
}
const pageTitle = (t, back) => `<div class="play-top">${back ? `<a class="icon-btn" href="${back}" aria-label="Wstecz">${ICON.back}</a>` : ''}<h2 style="font-size:24px">${esc(t)}</h2></div>`;

/* ---------- LOBBY ---------- */
async function vLobby(v, r, ok) {
  const [games, lobby, ad] = await Promise.all([get('/api/games'), get('/api/lobby'), loadAd('lobby_banner')]);
  if (!ok()) return;
  S.games = games; S.online = lobby.online; showOnline();
  const active = games.filter((g) => g.status === 'active'), soon = games.filter((g) => g.status === 'soon');
  const news = lobby.news[0];
  const cardOf = (g) => `<button class="gcard ${g.status === 'soon' ? 'soon' : ''}" data-act="game" data-g="${esc(g.slug)}"><span class="art" style="--h:${g.hue}${g.iconUrl ? `;background-image:url('${esc(assetUrl(g.iconUrl))}')` : ''}">${g.iconUrl ? '' : esc(g.icon || g.name.charAt(0))}</span>
    <span class="info"><b>${esc(g.name)}</b><small>${g.status === 'soon' ? 'Wkrótce' : (g.playing ? g.playing + ' gra teraz' : esc(g.category || ''))}</small></span></button>`;
  v.innerHTML = `
    ${S.cfg.maintenance ? `<div class="maint">${esc(S.cfg.maintenanceMsg || 'Trwają prace techniczne.')}</div>` : ''}
    ${S.match && S.match.status === 'playing' ? `<a class="notice" style="text-decoration:none;color:inherit;background:var(--pri);color:var(--pri-ink)" href="#/play"><small>Trwa partia</small><b>Wróć do gry: ${esc(S.match.game.name)}</b></a>` : ''}
    ${isGuest() ? `<div class="card stack"><b>Grasz jako gość</b><span class="muted small">Załóż darmowe konto, aby wejść do rankingów, ligi i turniejów. Twoje partie zostaną zachowane.</span><button class="btn pri" data-act="auth" data-mode="register">Załóż konto</button></div>` : ''}
    ${news ? `<div class="notice"><small>${esc(news.kind === 'event' ? 'Wydarzenie' : news.kind === 'warn' ? 'Ważne' : 'Aktualności')}</small><b>${esc(news.title)}</b>${news.body ? `<span>${esc(news.body)}</span>` : ''}</div>` : ''}
    ${adHTML(ad)}
    <button class="card row" style="text-align:left;width:100%" data-go="#/offline"><span style="font-size:26px">🎮</span><span class="grow"><b>Gra offline z CPU</b><br><span class="muted small">Łatwy / Średni / Trudny – działa bez internetu, bez wpływu na ranking</span></span></button>
    <section class="sec"><div class="sec-h"><h2>Wybierz grę</h2><span class="muted small">${lobby.stats.activeMatches} partii trwa</span></div>
      <div class="gamegrid">${active.map(cardOf).join('') || '<div class="empty">Brak aktywnych gier.</div>'}</div></section>
    ${lobby.live.length ? `<section class="sec"><div class="sec-h"><h2>Na żywo</h2></div><div class="card live-list">${lobby.live.slice(0, 6).map((m) => `<button class="item" data-act="watch" data-id="${m.id}">${gameTile({ hue: m.hue, icon: m.icon, name: m.gameName }, '')}<span class="grow"><b>${esc(m.players.join(' vs '))}</b><br><small class="muted">${esc(m.gameName)} · ${m.moves} ruchów${m.rated ? ' · ranking' : ''}</small></span><span class="tag good">Oglądaj</span></button>`).join('')}</div></section>` : ''}
    ${soon.length ? `<section class="sec"><div class="sec-h"><h2>Wkrótce</h2></div><div class="gamegrid">${soon.map(cardOf).join('')}</div></section>` : ''}
    <section class="sec"><div class="row" style="justify-content:center;gap:18px">${S.cfg.forumEnabled === false ? '' : '<a href="#/forum" class="small">Forum</a>'}<a href="#/page/regulamin" class="small">Regulamin</a><a href="#/page/pomoc" class="small">Pomoc</a><a href="#/page/prywatnosc" class="small">Prywatność</a></div></section>`;
}

function gameSheet(slug) {
  const g = gameBy(slug);
  if (!g) return;
  if (g.status !== 'active') { toast(g.name + ' – wkrótce!'); return; }
  if (g.plugin) return openPlugin(g, S.me);
  const canRate = g.rated && !isGuest();
  const time = g.timeSec ? `${Math.round(g.timeSec / 60 * 10) / 10} min${g.incSec ? ' + ' + g.incSec + ' s' : ''}` : 'bez limitu';
  sheet(`<div class="row">${gameTile(g)}<div class="grow"><h2>${esc(g.name)}</h2><span class="muted small">${esc(g.description || '')}</span></div></div>
    <div class="row" style="flex-wrap:wrap;gap:6px"><span class="tag">Czas: ${time}</span>${g.rated ? '<span class="tag good">Ranking</span>' : ''}${g.bots ? '<span class="tag">Boty</span>' : ''}</div>
    <div class="stack">
      ${g.rated ? `<button class="opt" data-act="queue" data-g="${g.slug}" data-rated="1" ${canRate ? '' : 'disabled style="opacity:.55"'}><span class="grow"><b>Gra rankingowa</b><small>${canRate ? 'Losowy rywal o zbliżonym rankingu' : 'Wymaga konta – załóż je w Profilu'}</small></span></button>` : ''}
      <button class="opt" data-act="tables" data-g="${g.slug}"><span class="grow"><b>Stoły (numerowane pokoje)</b><small>Wybierz stół i zagraj z przeciwnikiem</small></span></button>
      <button class="opt" data-act="queue" data-g="${g.slug}"><span class="grow"><b>Szybka gra online</b><small>Towarzyska, bez wpływu na ranking</small></span></button>
      ${g.bots ? `<button class="opt" data-act="botpick" data-g="${g.slug}"><span class="grow"><b>Graj z botem</b><small>Trzy poziomy trudności</small></span></button>` : ''}
      <button class="opt" data-act="room" data-g="${g.slug}"><span class="grow"><b>Pokój prywatny</b><small>Zaproś znajomego kodem</small></span></button>
      <button class="opt" data-act="joinpick"><span class="grow"><b>Mam kod pokoju</b><small>Dołącz do gry znajomego</small></span></button>
      ${g.rules ? `<details class="rules"><summary>Zasady gry</summary><p>${esc(g.rules)}</p></details>` : ''}
    </div>`);
}
/* ---------- stoły: lista, lobby stołu (host, ustawienia, gotowość), czat, zaproszenia ---------- */
const QUICK = ['Twój ruch!', 'Dobra gra!', 'UPS!', 'Dzięki!', 'Powodzenia!', 'Szybciej, proszę 🙂'];
const clockTxt = (c) => (c ? (c.mode === 'turn' ? c.sec + ' s na turę' : Math.round(c.sec / 60) + ' min na gracza') : '');
const rangeTxt = (a, b) => (a || b ? `ranking ${a || 0}–${b || '∞'}` : '');
const CSEC = { turn: [15, 30, 60], total: [180, 300, 600] };
const round50 = (v) => Math.max(0, Math.round(v / 50) * 50);
function tablesSheet(slug) {
  const g = gameBy(slug); if (!g) return;
  sheet(`<h2>${esc(g.name)} – stoły</h2><p class="muted small">Usiądź przy wolnym stole (zostaniesz hostem 👑) albo dołącz do gracza, który czeka.</p><div id="tbl" class="tbls" data-g="${g.slug}"><p class="muted">Ładowanie…</p></div>`);
  S.tablesGame = g.slug;
  const ask = () => S.sock && S.sock.send({ t: 'tables', game: g.slug });
  ask(); S.tablesTimer = setInterval(ask, 3000);
}
function renderTables(m) {
  const box = $('#tbl'); if (!box || box.dataset.g !== m.game) return;
  box.innerHTML = m.list.map((t) => {
    if (t.st === 'free') return `<div class="tbl free"><b>${t.n}</b><span class="small muted">wolny</span><button class="btn sm" data-act="sit" data-g="${esc(m.game)}" data-n="${t.n}">Usiądź</button></div>`;
    const pl = t.players.map((p) => `<div class="small trunc">${p.host ? '👑 ' : ''}${esc(p.nick)} <span class="muted">${p.rating}</span> ${p.ready ? '<span class="tag good">gotowy</span>' : ''}</div>`).join('');
    const chips = [t.priv ? '🔒 PIN' : '', t.rated ? 'ranking' : '', t.eloOff ? '⊘ Brak ELO' : '', rangeTxt(t.minR, t.maxR), clockTxt(t.clock), t.undo ? '' : 'bez cofania'].filter(Boolean).map((c) => `<span class="tag">${esc(c)}</span>`).join(' ');
    let btn;
    if (t.mine) btn = '<button class="btn sm pri" data-act="totable">Wróć do stołu</button>';
    else if (t.st === 'playing') btn = '<button class="btn sm" disabled>Trwa gra</button>';
    else if (t.join === 'ok') btn = `<button class="btn sm pri" data-act="sit" data-g="${esc(m.game)}" data-n="${t.n}" data-pin="${t.priv ? 1 : 0}">Dołącz</button>`;
    else btn = `<button class="btn sm" disabled>Dołącz</button><span class="small muted">${t.join === 'rating' ? 'Wymagany ' + esc(rangeTxt(t.minR, t.maxR)) : t.join === 'full' ? 'Stół pełny' : 'Niedostępny'}</span>`;
    return `<div class="tbl ${t.st}"><b>${t.n}</b>${pl}<div>${chips}</div>${btn}</div>`;
  }).join('');
}
function openTable() {
  const tv = S.tbl; if (!tv) return;
  sheet(`<div class="row"><h2 class="grow">Stół ${tv.n} · ${esc(tv.gameName)}</h2><button class="btn sm bad" data-act="tleave">Opuść stół</button></div>
    <div id="tElo"></div><div id="tPlayers" class="stack"></div><div id="tInv"></div><div id="tSet"></div>
    <button class="btn pri block" id="tReady" data-act="tready"></button>
    <div class="chat tchat"><div class="log" id="tLog"></div><div class="quick" id="tQuick"></div><form data-form="tchat"><input name="text" maxlength="140" placeholder="${isGuest() ? 'Goście nie mogą pisać – załóż konto' : 'Wiadomość do stołu…'}" autocomplete="off" ${isGuest() ? 'readonly' : ''}><button class="btn sm" type="submit">Wyślij</button></form></div>`);
  S.tblOpen = true; S.tDirty = false; paintTable(true);
}
function paintChat() {
  const log = $('#tLog'); if (!log || !S.tbl) return;
  log.innerHTML = S.tbl.chat.slice(-30).map((c) => c.sys ? `<div class="muted small"><i>${esc(c.text)}</i></div>` : `<div><b>${esc(c.nick)}:</b> ${esc(c.text)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}
function paintTable() {
  const tv = S.tbl; if (!tv || !$('#tPlayers')) return;
  const iAmHost = tv.host === tv.you, me = tv.players.find((p) => p.uid === tv.you);
  $('#tPlayers').innerHTML = tv.players.map((p) => `<div class="tp ${p.ready ? 'rdy' : ''}">${avatar(p.nick, p.hue, 'sm')}
    <div class="grow trunc"><b>${p.host ? '👑 ' : ''}${esc(p.nick)}</b> <span class="muted small">${p.rating}</span>
      <div class="muted small">ucieczki: ${p.rage} · ukończone gry: ${p.completed}%</div></div>
    <span class="tag ${p.ready ? 'good' : ''}">${p.ready ? 'Gotowy' : 'Nie gotowy'}</span>
    ${p.uid !== tv.you && !p.guest && p.uid > 0 ? `<button class="btn sm ghost" data-act="block" data-uid="${p.uid}" data-nick="${esc(p.nick)}" data-stay="1">Zablokuj</button>` : ''}
    ${iAmHost && p.uid !== tv.you ? `<button class="btn sm bad" data-act="tkick" data-uid="${p.uid}">Wyproś</button>` : ''}</div>`).join('')
    + (tv.players.length < 2 ? `<div class="tp empty stack"><div class="row"><span class="grow muted">Wolne miejsce…</span><button class="btn sm" data-act="tinvite">Zaproś gracza</button></div>${tv.botAllowed ? `<div class="row small" style="flex-wrap:wrap"><span class="muted">Dodaj CPU:</span>${['e', 'm', 'h'].map((l) => `<button class="btn sm ghost" data-act="tbot" data-l="${l}">${BOT_LABEL[l][0]}</button>`).join('')}</div>` : ''}</div>` : '');
  $('#tElo').innerHTML = tv.eloOff ? `<div class="card small row"><span class="tag bad">⊘ Brak ELO</span><span class="grow muted">${tv.eloOff === 'bot' ? 'Partie z CPU nie przyznają punktów rankingowych.' : 'Gość przy stole – partia nie przyznaje punktów rankingowych.'}</span></div>` : '';
  const st = tv.settings;
  if (!S.tDirty) {
    const g = gameBy(tv.game), canRate = g && g.rated && !isGuest();
    const rOpts = (cur) => '<option value="0">Bez limitu</option>' + Array.from({ length: 59 }, (_, i) => 100 + i * 50).map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
    const cOpts = (mode, cur) => { const l = CSEC[mode].slice(); if (!l.includes(cur)) l.push(cur); return l.sort((a, b) => a - b).map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${mode === 'turn' ? v + ' s' : v / 60 + ' min'}</option>`).join(''); };
    $('#tSet').innerHTML = iAmHost ? `<form id="tsetf" data-form="tset" class="card stack"><b>Ustawienia stołu (host)</b>
      <label class="fld"><span>Widoczność</span><select name="visibility"><option value="public" ${st.visibility === 'public' ? 'selected' : ''}>Publiczny</option><option value="private" ${st.visibility === 'private' ? 'selected' : ''}>Prywatny (PIN)</option></select></label>
      <label class="fld" id="tPin" ${st.visibility === 'private' ? '' : 'hidden'}><span>PIN (4–8 liter lub cyfr)</span><input name="pin" maxlength="8" value="${esc(st.pin || '')}" autocomplete="off"></label>
      <div class="cols"><label class="fld"><span>Min. ranking</span><select name="minRating">${rOpts(st.minRating)}</select></label><label class="fld"><span>Max. ranking</span><select name="maxRating">${rOpts(st.maxRating)}</select></label></div>
      <label class="fld"><span>Zakres od mojego rankingu</span><select name="around"><option value="">— wybierz —</option><option value="50">± 50</option><option value="100">± 100</option><option value="200">± 200</option><option value="0">Bez limitu</option></select></label>
      <div class="cols"><label class="fld"><span>Zegar</span><select name="cmode"><option value="turn" ${st.clock.mode === 'turn' ? 'selected' : ''}>Czas na turę</option><option value="total" ${st.clock.mode === 'total' ? 'selected' : ''}>Czas łączny na gracza</option></select></label><label class="fld"><span>Limit</span><select name="csec">${cOpts(st.clock.mode, st.clock.sec)}</select></label></div>
      <label class="row small"><input type="checkbox" name="undo" ${st.undo ? 'checked' : ''}> Zezwalaj na cofanie ruchów</label>
      ${gameBy(tv.game) && gameBy(tv.game).bots ? `<label class="row small"><input type="checkbox" name="allowBots" ${st.allowBots ? 'checked' : ''}> Zezwalaj na gry z CPU</label>` : ''}
      ${canRate ? `<label class="row small"><input type="checkbox" name="rated" ${st.rated ? 'checked' : ''}> Partia rankingowa</label>` : ''}
      <button class="btn" type="submit">Zapisz ustawienia</button></form>`
      : `<div class="card small stack"><b>Ustawienia stołu</b><span>${st.visibility === 'private' ? '🔒 Prywatny' : 'Publiczny'} · ${esc(clockTxt(st.clock))} · ${st.rated ? 'rankingowa' : 'towarzyska'}</span><span>${esc(rangeTxt(st.minRating, st.maxRating) || 'Bez limitu rankingu')} · cofanie ruchów: ${st.undo ? 'tak' : 'nie'}</span></div>`;
  }
  const rb = $('#tReady'); rb.textContent = me && me.ready ? 'Nie jestem gotowy' : 'Gotowy do gry'; rb.classList.toggle('pri', !(me && me.ready));
  $('#tQuick').innerHTML = QUICK.map((q, i) => `<button class="btn sm ghost" data-act="tquick" data-q="${i}">${esc(q)}</button>`).join('');
  paintChat();
}
document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('#tSet')) S.tDirty = true; });
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('#tsetf'); if (!f) return;
  if (e.target.name === 'visibility') f.querySelector('#tPin').hidden = e.target.value !== 'private';
  if (e.target.name === 'cmode') { const sel = f.elements.csec, mode = e.target.value; sel.innerHTML = CSEC[mode].map((v) => `<option value="${v}">${mode === 'turn' ? v + ' s' : v / 60 + ' min'}</option>`).join(''); }
  if (e.target.name === 'around') {
    const x = parseInt(e.target.value, 10), me = S.tbl && S.tbl.players.find((p) => p.uid === S.tbl.you); if (isNaN(x) || !me) return;
    const lo = x ? Math.max(100, round50(me.rating - x)) : 0, hi = x ? round50(me.rating + x) : 0;
    f.elements.minRating.value = String(lo); f.elements.maxRating.value = String(hi);
  }
});
function botSheet(slug) {
  const g = gameBy(slug);
  sheet(`<h2>Bot: ${esc(g.name)}</h2><p class="muted small">Wybierz poziom i swoją stronę.</p>
    <div class="seg" id="sideSeg"><button data-act="side" data-s="1" class="on">Zaczynam</button><button data-act="side" data-s="2">Drugi</button><button data-act="side" data-s="0">Losowo</button></div>
    <div class="lvls">${['e', 'm', 'h'].map((l) => `<button data-act="bot" data-g="${g.slug}" data-l="${l}">${BOT_LABEL[l][0]}<small>${BOT_LABEL[l][1]}</small></button>`).join('')}</div>`);
}
function joinSheet() {
  sheet(`<h2>Dołącz do pokoju</h2><form data-form="join" class="stack"><label class="fld"><span>Kod pokoju</span><input name="code" maxlength="6" autocapitalize="characters" autocomplete="off" required style="text-transform:uppercase;font-size:24px;letter-spacing:.2em;text-align:center"></label><button class="btn pri block" type="submit">Dołącz</button></form>`);
}
function showWaiting(kind, code) {
  S.waiting = kind;
  if (kind === 'queue') sheet(`<div class="wait"><div class="spin"></div><h2>Szukamy przeciwnika…</h2><p class="muted">Zwykle trwa to kilka sekund.</p><button class="btn block" data-act="unqueue">Anuluj</button></div>`, true);
  else sheet(`<div class="wait"><h2>Pokój prywatny</h2><p class="muted">Podaj ten kod znajomemu:</p><div class="code">${esc(code)}</div><div class="spin"></div><p class="muted small">Czekamy na dołączenie…</p>
    <button class="btn" data-act="sharecode" data-code="${esc(code)}">Udostępnij kod</button><button class="btn ghost block" data-act="roomcancel">Zamknij pokój</button></div>`, true);
}

/* ---------- PARTIA ---------- */
function engineFor(m) {
  const key = m.game.engine + JSON.stringify(m.game.params);
  if (!S.eng || S.eng.key !== key) { const eng = E.make(m.game.engine, m.game.params || {}); S.eng = { key, eng, board: { w: eng.w, h: eng.h, k: eng.k, gravity: eng.gravity, n: eng.n } }; }
  return S.eng;
}
function handleMatch(m) {
  const prev = S.match, isNew = !prev || prev.id !== m.id;
  const prevTurn = prev && prev.id === m.id ? prev.turn : null;
  if (isNew && prev && prev.offline && !m.offline && S.offCtl) { S.offCtl.destroy(); S.offCtl = null; }
  S.match = m; S.matchAt = Date.now();
  if (isNew) { S.ui = {}; S.chat = []; S.overShown = false; }
  else if (prevTurn !== m.turn || m.status !== 'playing') S.ui = {};
  if (S.waiting || isNew) { S.waiting = null; closeSheet(); }
  if (m.you === 0 && isNew) S.watching = m.id;
  if (isNew && curRoute().name !== 'play') { location.hash = '#/play'; return; }
  if (!isNew && prev.moves !== m.moves) { if (m.status === 'playing' && m.turn === m.you) { sfx('mine'); haptic(25); } else sfx('move'); }
  if (curRoute().name === 'play') renderMatch();
  if (m.status === 'over' && !S.overShown) { S.overShown = true; onMatchOver(m); }
}
function onMatchOver(m) {
  const r = m.result, you = m.you;
  sfx(!you || r.winner === 0 ? 'draw' : r.winner === you ? 'win' : 'lose');
  if (m.offline) return;           // offline: nic nie trafia do rankingu ani statystyk
  if (you) { S.played++; refreshMe(); }
  if (you && S.played % 3 === 0) setTimeout(async () => { const ad = await loadAd('interstitial', m.game.slug); if (ad && curRoute().name === 'play') showInterstitial(ad); }, 1200);
}
async function refreshMe() { try { S.me = (await get('/api/me')).me; setUnread(S.me.unread || 0); } catch (e) { /* ignore */ } }
function showInterstitial(ad) {
  const d = document.createElement('div'); d.className = 'inter';
  d.innerHTML = `${adHTML(ad, true)}<button class="btn" data-act="closeinter" disabled id="skip">Pomiń za 3</button>`;
  document.body.appendChild(d);
  let n = 3; const t = setInterval(() => { n--; const b = $('#skip'); if (!b) return clearInterval(t); if (n <= 0) { b.disabled = false; b.textContent = 'Zamknij'; clearInterval(t); } else b.textContent = 'Pomiń za ' + n; }, 1000);
}

async function vPlay(v, r, ok) {
  if (!S.match) { location.hash = '#/'; return; }
  v.innerHTML = '';
  renderMatch(true);
}
function matchCtx() {
  const m = S.match, { eng, board } = engineFor(m);
  const myTurn = m.status === 'playing' && m.you > 0 && m.turn === m.you;
  let legal = []; if (myTurn) { try { legal = eng.legal(m.state); } catch (e) { legal = []; } }
  return { m, eng, kind: eng.kind, board, state: m.state, you: m.you, legal, ui: S.ui, result: m.result, myTurn };
}
function playerCard(m, side, ctx) {
  const p = m.players[side - 1], turn = m.status === 'playing' && m.turn === side, hasClock = m.clocks && m.clocks[side - 1] != null;
  const rating = p.rating != null ? ` <span class="muted small">${p.rating}</span>` : '';
  return `<div class="pcard ${turn ? 'turn' : ''} ${m.disc && m.disc[side - 1] ? 'off' : ''}">
    <span class="sym" style="background:${symbolStyle(ctx.kind, ctx.board, side)}"></span>${avatar(p.nick, p.hue, 'sm')}
    <div class="grow trunc"><b>${esc(p.nick)}</b>${rating}${p.guest ? ' <span class="tag">gość</span>' : ''}${m.disc && m.disc[side - 1] ? ` <span class="tag bad" data-disc="${side}">rozłączony</span>` : ''}</div>
    ${hasClock ? `<span class="clock" data-clock="${side}">${fmtClock(m.clocks[side - 1])}</span>` : ''}</div>`;
}
function statusText(ctx) {
  const m = ctx.m;
  if (m.status === 'over') {
    const r = m.result, why = REASONS[r.reason] || r.reason;
    if (!m.you) return r.winner === 0 ? 'Remis' : 'Wygrał ' + m.players[r.winner - 1].nick;
    return r.winner === 0 ? 'Remis' : r.winner === m.you ? 'Wygrana!' : 'Przegrana' + (why ? '' : '');
  }
  if (!m.you) return 'Ruch: ' + m.players[m.turn - 1].nick;
  if (m.turn === m.you) return ctx.kind === 'chess' && ctx.eng.inCheck && ctx.eng.inCheck(m.state) ? 'Szach! Twój ruch' : 'Twój ruch';
  return 'Ruch przeciwnika…';
}
function renderMatch(full) {
  if (!S.match) return;
  const ctx = matchCtx(), m = ctx.m, top = m.you === 2 ? 1 : 2, bot = m.you === 2 ? 2 : 1;
  const v = $('#view'); if (!v) return;
  if (full || !$('#mv')) {
    v.innerHTML = `<div id="mv" class="stack" style="gap:10px">
      <div class="play-top"><a class="icon-btn" href="${m.offline ? '#/offline' : '#/'}" aria-label="Lobby" data-act="leaveplay">${ICON.back}</a><h2 class="trunc">${esc(m.game.name)}</h2><span class="tag ${m.rated ? 'good' : ''}" id="mvTag"></span></div>
      <div id="mvTop"></div><div class="boardwrap" id="mvBoard"></div><div id="mvBot"></div><div class="status" id="mvStatus"></div><div id="mvPromo" class="promo" hidden></div><div id="mvCtl"></div><div id="mvRes"></div>
      <div class="chat" id="mvChat"><div class="log" id="chatLog"></div><form data-form="chat"><input name="text" maxlength="140" placeholder="${isGuest() ? 'Goście nie mogą pisać – załóż konto' : 'Napisz wiadomość…'}" autocomplete="off" ${isGuest() ? 'readonly' : ''}><button class="btn sm" type="submit">Wyślij</button></form><div class="quick" id="mvQuick"></div></div></div>`;
  }
  $('#mvTag').textContent = m.offline ? 'Offline · bez ELO' : m.mode === 'bot' ? 'Z botem' : m.mode === 'tournament' ? 'Turniej' : m.rated ? 'Ranking' : m.noElo ? '⊘ Brak ELO' : 'Towarzyska';
  $('#mvTag').classList.toggle('bad', !!m.noElo);
  $('#mvTop').innerHTML = playerCard(m, top, ctx);
  $('#mvBot').innerHTML = playerCard(m, bot, ctx);
  $('#mvBoard').innerHTML = boardSVG(ctx);
  const st = $('#mvStatus'); st.textContent = statusText(ctx); st.classList.toggle('warn', !!(m.you && m.status === 'playing' && m.turn === m.you));
  const pr = $('#mvPromo'); pr.hidden = !S.ui.promo; if (S.ui.promo) pr.innerHTML = promoHTML(m.you);
  let ctl = '';
  if (m.status === 'playing' && m.you) {
    const offered = m.drawOffer && m.drawOffer !== m.you, mine = m.drawOffer === m.you;
    if (offered) ctl = `<div class="card stack" style="text-align:center"><b>Przeciwnik proponuje remis</b><div class="row"><button class="btn grow" data-act="draw_no">Odrzuć</button><button class="btn pri grow" data-act="draw">Przyjmij</button></div></div>`;
    else if (m.undoReq && m.undoReq !== m.you) ctl = `<div class="card stack" style="text-align:center"><b>Przeciwnik prosi o cofnięcie ruchu</b><div class="row"><button class="btn grow" data-act="undo_no">Odrzuć</button><button class="btn pri grow" data-act="undo_yes">Zgoda</button></div></div>`;
    else ctl = `<div class="ctl">${m.undo ? `<button class="btn sm" data-act="undo" ${m.undoReq === m.you ? 'disabled' : ''}>${m.undoReq === m.you ? 'Czekam na zgodę…' : 'Cofnij ruch'}</button>` : ''}${m.mode !== 'bot' ? `<button class="btn sm" data-act="draw" ${mine ? 'disabled' : ''}>${mine ? 'Zaproponowano remis' : 'Zaproponuj remis'}</button>` : ''}<button class="btn sm bad" data-act="resign">Poddaj się</button></div>`;
  }
  if (m.status === 'playing' && !m.you) ctl = '<div class="ctl"><span class="tag">Oglądasz partię</span></div>';
  $('#mvCtl').innerHTML = ctl;
  $('#mvRes').innerHTML = m.status === 'over' ? resultHTML(m) : '';
  if (m.status === 'over' && m.you) loadAd('after_game', m.game.slug).then((ad) => { const el = $('#adAfter'); if (el && ad) el.innerHTML = adHTML(ad); });
  $('#mvChat').hidden = m.mode === 'bot';
  $('#mvQuick').innerHTML = m.you ? QUICK.map((q, i) => `<button class="btn sm ghost" data-act="quick" data-q="${i}">${esc(q)}</button>`).join('') : '';
  renderChat(); tickClocks();
}
function resultHTML(m) {
  const r = m.result, you = m.you, why = REASONS[r.reason] || r.reason;
  const title = !you ? (r.winner === 0 ? 'Remis' : 'Wygrał ' + m.players[r.winner - 1].nick) : r.winner === 0 ? 'Remis' : r.winner === you ? 'Wygrana!' : 'Przegrana';
  const d = you && r.deltas ? r.deltas[you - 1] : null;
  const score = r.score ? `<p class="muted">Wynik: ${r.score[0]} : ${r.score[1]}</p>` : '';
  return `<div class="card result"><h3>${esc(title)}</h3><p class="muted">${esc(why || '')}</p>${score}
    ${d != null ? `<div class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d} <span class="muted small">→ ${r.ratings[you - 1]}</span></div>` : (you && m.mode === 'queue' && !m.rated ? '<p class="muted small">Partia nierankingowa.</p>' : '')}
    ${you && isGuest() ? '<button class="btn acc" data-act="auth" data-mode="register">Załóż konto i zdobywaj ranking</button>' : ''}
    ${r.rage ? `<p class="muted small">${r.rage === you ? 'Opuściłeś partię – dostajesz karę i +1 do licznika ucieczek.' : 'Przeciwnik uciekł z gry – wygrana walkowerem.'}</p>` : ''}
    ${m.mode === 'tournament' ? '<a class="btn pri" href="#/tournament/' + m.tm + '">Wróć do turnieju</a>' : you && m.mode !== 'bot' && !r.rage ? `<button class="btn pri" data-act="rematch" ${m.rematch && m.rematch[you - 1] ? 'disabled' : ''}>${m.rematch && m.rematch[you - 1] ? 'Czekam na przeciwnika…' : m.rematch && m.rematch[2 - you] ? 'Rewanż – przeciwnik czeka!' : 'Rewanż'}</button>` : ''}
    ${m.offline ? '<p class="muted small">Gra offline – wynik nie liczy się do rankingu ELO ani statystyk.</p>' : ''}
    ${you && m.mode !== 'tournament' ? `<button class="btn ${m.mode === 'bot' ? 'pri' : ''}" data-act="again">${m.mode === 'bot' ? 'Zagraj ponownie' : 'Nowa gra'}</button>` : ''}
    ${S.tbl && m.table && S.tbl.n === m.table ? '<button class="btn" data-act="totable">Wróć do stołu ' + m.table + '</button>' : ''}
    <a class="btn ghost" href="${m.offline ? '#/offline' : '#/'}">${m.offline ? 'Wróć do menu offline' : 'Wróć do lobby'}</a><div id="adAfter" style="width:100%"></div></div>`;
}
function renderChat() {
  const log = $('#chatLog'); if (!log) return;
  log.innerHTML = S.chat.slice(-30).map((c) => `<div><b>${esc(c.nick)}:</b> ${esc(c.text)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}
function tickClocks() {
  const m = S.match; if (!m || m.status !== 'playing') return;
  const paused = m.mode !== 'bot' && m.disc && m.disc.some(Boolean);          // zegary stoją, gdy ktoś jest rozłączony
  document.querySelectorAll('[data-disc]').forEach((el) => { const left = (m.discLeft[+el.dataset.disc - 1] || 0) - (Date.now() - S.matchAt); el.textContent = 'rozłączony · powrót w ' + Math.max(0, Math.ceil(left / 1000)) + ' s'; });
  const st = $('#mvStatus'); if (st && paused) { const left = Math.max(0, Math.ceil(Math.max(...m.discLeft) / 1000 - (Date.now() - S.matchAt) / 1000)); st.textContent = 'Oczekiwanie na powrót gracza… ' + left + ' s'; }
  if (!m.clocks) return;
  document.querySelectorAll('[data-clock]').forEach((el) => {
    const side = +el.dataset.clock; let ms = m.clocks[side - 1];
    if (ms == null) return;
    if (m.turn === side && !paused) ms -= (m.elapsed || 0) + (Date.now() - S.matchAt);
    else if (m.turn === side) ms -= (m.elapsed || 0);
    el.textContent = fmtClock(ms); el.classList.toggle('low', ms < 10000);
  });
}
/** Wysyła komunikat partii: do lokalnego bota (offline) albo przez WebSocket. */
function wsend(o) { if (S.match && S.match.offline) { if (S.offCtl) S.offCtl.send(o); return true; } return S.sock ? S.sock.send(o) : false; }
function cellClick(i) {
  const m = S.match; if (!m || m.status !== 'playing') return;
  const ctx = matchCtx(), out = onCell(ctx, i);
  if (!out) return;
  if (out.ui) { S.ui = out.ui; renderMatch(); return; }
  if (out.move != null) { S.ui = {}; wsend({ t: 'move', id: m.id, move: out.move }); }
}

/* ---------- POWTÓRKA ---------- */
async function vReplay(v, r, ok) {
  const d = await get('/api/matches/' + encodeURIComponent(r.a || 0));
  if (!ok()) return;
  const g = d.game, eng = E.make(g.engine, paramsOf(g));
  const states = [eng.init()];
  for (const mv of d.moves) states.push(eng.play(states[states.length - 1], mv));
  let idx = states.length - 1;
  const board = { w: eng.w, h: eng.h, k: eng.k, gravity: eng.gravity, n: eng.n };
  const draw = () => {
    const s = states[idx], res = idx === states.length - 1 ? { winner: d.result, reason: d.reason, line: (eng.result(s) || {}).line } : null;
    $('#rpBoard').innerHTML = boardSVG({ kind: eng.kind, board, state: s, you: 1, legal: [], ui: {}, result: res, myTurn: false });
    $('#rpPos').textContent = idx + ' / ' + (states.length - 1);
    $('#rpSlider').value = idx;
  };
  v.innerHTML = `${pageTitle('Powtórka', '#/me')}
    <div class="card row"><span class="grow"><b>${esc(d.p1 || '?')} vs ${esc(d.p2 || '?')}</b><br><span class="muted small">${esc(g.name)} · ${esc(d.endedAt ? fmtDate(d.endedAt) : '')}</span></span><span class="tag">${d.result === 0 ? 'Remis' : 'Wygrał ' + esc(d.result === 1 ? d.p1 : d.p2)}</span></div>
    <div class="boardwrap" id="rpBoard"></div>
    <input type="range" id="rpSlider" min="0" max="${states.length - 1}" value="${idx}" style="width:100%">
    <div class="ctl"><button class="btn" data-rp="start">«</button><button class="btn" data-rp="-1">‹</button><span class="btn ghost num" id="rpPos" style="pointer-events:none"></span><button class="btn" data-rp="1">›</button><button class="btn" data-rp="end">»</button></div>`;
  const go = (n) => { idx = Math.max(0, Math.min(states.length - 1, n)); draw(); };
  $('#rpSlider').oninput = (e) => go(+e.target.value);
  v.querySelectorAll('[data-rp]').forEach((b) => { b.onclick = () => { const a = b.dataset.rp; go(a === 'start' ? 0 : a === 'end' ? states.length - 1 : idx + +a); }; });
  draw();
}
const paramsOf = (g) => { const b = g.board || {}; return g.engine === 'mnk' ? { w: b.w, h: b.h, k: b.k, gravity: b.gravity } : g.engine === 'checkers' ? { n: b.n } : {}; };

/* ---------- RANKING ---------- */
async function vRank(v, r, ok) {
  const games = S.games.filter((g) => g.status === 'active'); if (!games.length) { v.innerHTML = '<div class="empty">Brak gier.</div>'; return; }
  const slug = r.a && gameBy(r.a) ? r.a : (store.get('rankGame') && gameBy(store.get('rankGame')) ? store.get('rankGame') : games[0].slug);
  const per = PERIODS[r.b] ? r.b : 'a';
  store.set('rankGame', slug);
  const d = await get(`/api/ranking?game=${encodeURIComponent(slug)}&period=${per}&limit=50`);
  if (!ok()) return;
  const meId = S.me && S.me.id, inTop = d.rows.some((x) => x.id === meId);
  v.innerHTML = `${pageTitle('Rankingi')}
    <div class="chips">${games.map((g) => `<a class="chip ${g.slug === slug ? 'on' : ''}" href="#/rank/${g.slug}/${per}">${esc(g.name)}</a>`).join('')}</div>
    <div class="seg">${Object.keys(PERIODS).map((p) => `<button data-go="#/rank/${slug}/${p}" class="${p === per ? 'on' : ''}">${PERIODS[p]}</button>`).join('')}</div>
    <div class="card">${d.rows.length ? d.rows.map((x) => `<button class="rk ${x.rank <= 3 ? 'top' + x.rank : ''} ${x.id === meId ? 'me' : ''}" data-go="#/u/${encodeURIComponent(x.nick)}"><span class="pl">${x.rank}</span>${avatar(x.nick, x.hue)}<span class="trunc"><b>${esc(x.nick)}</b><br><small class="muted">${x.games} partii · ${x.wins}W ${x.draws}R ${x.losses}P</small></span><span class="sc">${per === 'a' ? x.rating : x.pts}<small>${per === 'a' ? 'Elo' : 'pkt'}</small></span></button>`).join('')
      : `<div class="empty">Nikt jeszcze nie zagrał rankingowej partii${per === 'a' ? '' : ' w tym okresie'}.<br>Bądź pierwszy!</div>`}</div>
    ${d.me && !inTop ? `<div class="card row"><b>Twoje miejsce: #${d.me.rank}</b><span class="grow"></span><span class="num">${per === 'a' ? d.me.rating + ' Elo' : d.me.pts + ' pkt'}</span></div>` : ''}
    ${isGuest() ? '<div class="card muted small">Goście nie są wyświetlani w rankingu. Załóż konto, aby się w nim znaleźć.</div>' : ''}
    <p class="muted small" style="text-align:center">${per === 'a' ? 'Ranking Elo – tylko partie rankingowe między zarejestrowanymi graczami.' : 'Punkty okresu: wygrana 3, remis 1, porażka 0.'}</p>`;
}

/* ---------- TURNIEJE ---------- */
const T_STATUS = { open: ['Zapisy', 'good'], running: ['Trwa', 'acc'], finished: ['Zakończony', ''] };
async function vTournaments(v, r, ok) {
  const list = await get('/api/tournaments'); if (!ok()) return;
  v.innerHTML = `${pageTitle('Turnieje')}${list.length ? list.map((t) => `<button class="card tcard" data-go="#/tournament/${t.id}"><div class="row">${gameTile(t.game)}<div class="grow"><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.game.name)} · ${fmtDate(t.startAt)}</span></div><span class="tag ${T_STATUS[t.status][1]}">${T_STATUS[t.status][0]}</span></div>
    <div class="row small muted"><span>${t.players}/${t.maxPlayers} graczy</span>${t.prize ? `<span>· Nagroda: ${esc(t.prize)}</span>` : ''}${t.joined ? '<span class="tag good">Zapisany</span>' : ''}${t.winner ? `<span>· 🏆 ${esc(t.winner)}</span>` : ''}</div></button>`).join('') : '<div class="empty">Brak turniejów. Zajrzyj tu wkrótce!</div>'}`;
}
let tPoll;
async function vTournament(v, r, ok) {
  clearInterval(tPoll);
  const load = async () => {
    const t = await get('/api/tournaments/' + encodeURIComponent(r.a));
    if (!ok()) { clearInterval(tPoll); return; }
    const me = S.me.id, rounds = []; for (let i = 1; i <= t.rounds; i++) rounds.push(t.matches.filter((m) => m.round === i));
    const mine = t.matches.find((m) => (m.p1 === me || m.p2 === me) && (m.status === 'ready' || m.status === 'playing'));
    const name = (n, id, w) => `<div class="${w === id && id ? 'w' : w && id && w !== id ? 'l' : ''}"><span class="trunc">${esc(n || '—')}</span></div>`;
    v.innerHTML = `${pageTitle(t.name, '#/tournaments')}
      <div class="card stack"><div class="row">${gameTile(t.game)}<div class="grow"><b>${esc(t.game.name)}</b><br><span class="muted small">Start: ${fmtDate(t.startAt)} · ${t.players.length}/${t.maxPlayers} graczy</span></div><span class="tag ${T_STATUS[t.status][1]}">${T_STATUS[t.status][0]}</span></div>
        ${t.description ? `<p class="muted small">${esc(t.description)}</p>` : ''}${t.prize ? `<p><b>Nagroda:</b> ${esc(t.prize)}${t.sponsor ? ` <span class="muted small">(${esc(t.sponsor)})</span>` : ''}</p>` : ''}
        ${t.winner ? `<p><b>🏆 Zwycięzca: ${esc(t.winner.nick)}</b></p>` : ''}
        ${t.status === 'open' ? (t.joined ? '<button class="btn block" data-act="tleave" data-id="' + t.id + '">Wypisz się</button>' : '<button class="btn pri block" data-act="tjoin" data-id="' + t.id + '">Zapisz się</button>') : ''}
        ${mine ? `<button class="btn acc block" data-act="tready" data-id="${mine.id}" ${mine.status === 'playing' ? 'disabled' : ''}>${mine.status === 'playing' ? 'Partia trwa' : 'Graj – mój mecz'}</button>` : ''}</div>
      ${rounds.length ? `<section class="sec"><h2>Drabinka</h2><div class="bracket">${rounds.map((ms, i) => `<div class="col"><h4>${i === rounds.length - 1 ? 'Finał' : i === rounds.length - 2 ? 'Półfinał' : 'Runda ' + (i + 1)}</h4>${ms.map((m) => `<div class="bm ${m.p1 === me || m.p2 === me ? 'mine' : ''}">${name(m.n1 || (m.bye ? 'wolny los' : ''), m.p1, m.winner)}${name(m.n2 || (m.bye ? 'wolny los' : ''), m.p2, m.winner)}</div>`).join('')}</div>`).join('')}</div></section>` : ''}
      <section class="sec"><h2>Uczestnicy (${t.players.length})</h2><div class="card">${t.players.map((p) => `<button class="rk" style="grid-template-columns:40px 1fr" data-go="#/u/${encodeURIComponent(p.nick)}">${avatar(p.nick, p.hue)}<b class="trunc">${esc(p.nick)}</b></button>`).join('') || '<div class="empty">Jeszcze nikt się nie zapisał.</div>'}</div></section>`;
  };
  await load();
  tPoll = setInterval(() => { if (curRoute().name !== 'tournament') clearInterval(tPoll); else load().catch(() => {}); }, 6000);
}

/* ---------- PROFIL ---------- */
const outcomeBadge = (o) => (o ? `<span class="out ${o}">${{ win: 'W', loss: 'P', draw: 'R' }[o]}</span>` : '');
function ratingRows(ratings) {
  return ratings.length ? ratings.map((x) => { const g = gameBy(x.game) || { hue: 150, name: x.gameName, icon: x.gameName.charAt(0) };
    return `<div class="gr">${gameTile(g)}<div class="grow"><b>${esc(x.gameName)}</b><br><span class="muted small">${x.games} partii · ${x.wins}W ${x.draws}R ${x.losses}P · szczyt ${x.peak}</span></div><span class="sc" style="font:800 20px var(--font-d)">${x.rating}</span></div>`; }).join('') : '<div class="empty small">Jeszcze brak rankingowych partii.</div>';
}
function leagueCard(l) {
  if (!l || !l.name) return '';
  return `<div class="card league stack"><div class="row"><div class="grow"><small class="muted">Liga tygodniowa</small><div class="name" style="color:${esc(l.color)}">${esc(l.name)}</div></div><b class="num">${l.points} pkt</b></div>
    <div class="bar"><i style="width:${Math.round(l.pct * 100)}%;background:${esc(l.color)}"></i></div>
    <span class="muted small">${l.next ? `Do ligi ${esc(l.next.name)}: ${l.next.min - l.points} pkt · ` : 'Najwyższa liga! · '}reset za ${l.daysLeft} dni</span></div>`;
}
/** Karta osiągnięć z paskami postępu (profil własny i cudzy). */
function achCard(list) {
  if (!list || !list.length) return '';
  const done = list.filter((a) => a.done).length;
  return `<section class="sec"><div class="sec-h"><h2>Osiągnięcia</h2><span class="muted small">${done}/${list.length}</span></div><div class="ach-grid">${list.map((a) => `<div class="ach ${a.done ? 'done' : ''}" title="${esc(a.desc)}"><span class="ach-i">${a.icon}</span><div class="grow"><b>${esc(a.name)}</b><small>${a.done ? 'Zdobyte' : esc(a.desc)}</small>${a.done ? '' : `<div class="bar"><i style="width:${Math.round(100 * a.value / a.goal)}%"></i></div><small>${a.value}/${a.goal}</small>`}</div></div>`).join('')}</div></section>`;
}
async function vMe(v, r, ok) {
  await refreshMe();
  const [matches, blocks] = await Promise.all([get('/api/me/matches').catch(() => []), get('/api/me/blocks').catch(() => [])]); if (!ok()) return;
  const me = S.me, lvXp = me.xp % 100, theme = store.get('theme') || 'auto';
  v.innerHTML = `
    <div class="hero-p">${avatar(me.nick, me.hue, 'lg')}<div class="grow"><h2 style="font-size:26px">${esc(me.nick)}</h2><span class="muted">${me.guest ? 'Konto gościa' : esc(me.email || '')}</span>
      <div class="row small" style="margin-top:4px"><span class="tag acc">Poziom ${me.level}</span><div class="bar grow"><i style="width:${lvXp}%"></i></div></div></div></div>
    ${me.guest ? `<div class="card stack"><b>Zostałeś gościem</b><span class="muted small">Bez konta nie ma rankingu, ligi ani turniejów, a po wyczyszczeniu danych przeglądarki stracisz postęp.</span><button class="btn pri" data-act="auth" data-mode="register">Załóż konto</button><button class="btn ghost" data-act="auth" data-mode="login">Mam już konto</button></div>` : leagueCard(me.league)}
    ${isStaff() ? `<a class="btn acc block" href="${esc(adminUrl())}" target="_blank" rel="noopener">Panel administratora</a>` : ''}
    <section class="sec"><div class="sec-h"><h2>Moje rankingi</h2></div><div class="card">${ratingRows(me.ratings)}</div></section>
    ${achCard(me.achievements)}
    <section class="sec"><div class="sec-h"><h2>Ostatnie partie</h2></div><div class="card">${matches.length ? matches.slice(0, 15).map((m) => `<button class="mrow" data-go="#/replay/${m.id}">${outcomeBadge(m.outcome)}<span class="grow trunc"><b>${esc(m.p1 || '?')} vs ${esc(m.p2 || '?')}</b><br><small class="muted">${esc(m.gameName)} · ${m.mode === 'bot' ? 'bot' : m.rated ? 'ranking' : 'towarzyska'} · ${fmtDate(m.endedAt)}</small></span>${m.rated && m.outcome ? `<b class="${(m.p1 === me.nick ? m.d1 : m.d2) >= 0 ? 'up' : 'down'}">${(m.p1 === me.nick ? m.d1 : m.d2) >= 0 ? '+' : ''}${m.p1 === me.nick ? m.d1 : m.d2}</b>` : ''}</button>`).join('') : '<div class="empty small">Zagraj pierwszą partię!</div>'}</div></section>
    <section class="sec"><div class="sec-h"><h2>Zablokowani użytkownicy</h2></div><div class="card">${blocks.length ? blocks.map((b) => `<div class="row" style="padding:6px 0">${avatar(b.nick, b.hue, 'sm')}<b class="grow trunc">${esc(b.nick)}</b><button class="btn sm" data-act="unblock" data-uid="${b.uid}">Odblokuj</button></div>`).join('') : '<p class="muted small" style="margin:0">Nikogo nie zablokowałeś. Zablokowany gracz nie widzi Cię w czacie, nie wyśle zaproszenia i nie trafi na Ciebie w szybkiej grze.</p>'}</div></section>
    <section class="sec"><div class="sec-h"><h2>Ustawienia</h2></div><div class="card stack">
      <div><span class="muted small">Motyw</span><div class="seg" style="margin-top:6px">${[['auto', 'Auto'], ['light', 'Jasny'], ['dark', 'Ciemny']].map(([k, l]) => `<button data-act="theme" data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div><span class="muted small">Kolor awatara</span><div class="colorpick" style="margin-top:6px">${[150, 20, 45, 200, 260, 320, 0].map((h) => `<button data-act="hue" data-h="${h}" style="--h:${h}" class="${me.hue === h ? 'on' : ''}" aria-label="Kolor"></button>`).join('')}</div></div>
      <div class="row"><span class="grow">Dźwięki</span><button class="sw" role="switch" aria-checked="${store.get('sound') !== '0'}" data-act="sound"></button></div>
      <div class="row"><span class="grow">Wibracje</span><button class="sw" role="switch" aria-checked="${store.get('haptic') !== '0'}" data-act="haptic"></button></div>
      ${!me.guest ? '<button class="btn" data-act="pwd">Zmień hasło</button>' : ''}
      ${S.deferredInstall && !isNative ? '<button class="btn" data-act="install">Zainstaluj aplikację</button>' : ''}
      <button class="btn bad" data-act="logout">${me.guest ? 'Zakończ sesję gościa' : 'Wyloguj'}</button></div></section>`;
}
const adminUrl = () => { const c = window.NK_CONFIG || {}; return (c.apiBase || '') + '/admin/'; };

async function vUser(v, r, ok) {
  const d = await get('/api/users/' + encodeURIComponent(r.a || '')); if (!ok()) return;
  const u = d.user;
  v.innerHTML = `${pageTitle('Gracz', 'javascript:history.back()')}
    <div class="hero-p">${avatar(u.nick, u.hue, 'lg')}<div class="grow"><h2 style="font-size:26px">${esc(u.nick)}</h2><span class="muted">${u.online ? '<span class="tag good">online</span>' : 'od ' + fmtDay(u.createdAt)}</span><div style="margin-top:4px"><span class="tag acc">Poziom ${u.level}</span></div></div></div>
    ${u.bio ? `<p>${esc(u.bio)}</p>` : ''}${leagueCard(d.league)}
    <p class="muted small">Ukończone gry: <b>${d.completedPct}%</b> · ucieczki: <b>${d.rageQuits}</b></p>
    <div class="stat-grid"><div><b>${d.total}</b><small>partii</small></div><div><b>${d.ratings.reduce((s, x) => s + x.wins, 0)}</b><small>wygranych</small></div><div><b>${d.ratings.length ? Math.max(...d.ratings.map((x) => x.rating)) : '—'}</b><small>najlepszy Elo</small></div></div>
    <section class="sec"><h2>Rankingi</h2><div class="card">${ratingRows(d.ratings)}</div></section>
    <section class="sec"><h2>Ostatnie partie</h2><div class="card">${d.recent.length ? d.recent.map((m) => `<button class="mrow" data-go="#/replay/${m.id}">${outcomeBadge(m.outcome)}<span class="grow trunc"><b>${esc(m.p1 || '?')} vs ${esc(m.p2 || '?')}</b><br><small class="muted">${esc(m.gameName)} · ${fmtDate(m.endedAt)}</small></span></button>`).join('') : '<div class="empty small">Brak partii.</div>'}</div></section>
    ${achCard(u.achievements)}
    <div id="forumCard"></div>
    ${S.me && u.id !== S.me.id ? `<div class="cols"><button class="btn ghost" data-act="${d.blocked ? 'unblock' : 'block'}" data-uid="${u.id}" data-nick="${esc(u.nick)}">${d.blocked ? 'Odblokuj gracza' : 'Zablokuj gracza'}</button><button class="btn ghost" data-act="report" data-nick="${esc(u.nick)}">Zgłoś gracza</button></div>` : ''}`;
  if (S.cfg.forumEnabled !== false) forumCard(u.nick).then((h) => { const el = $('#forumCard'); if (el && ok()) el.innerHTML = h; });
}
async function vPage(v, r, ok) {
  const p = await get('/api/pages/' + encodeURIComponent(r.a || '')); if (!ok()) return;
  v.innerHTML = `${pageTitle(p.title, '#/')}<div class="page-text">${esc(p.body)}</div>`;
}
async function vNotifs(v, r, ok) {
  const list = await get('/api/notifs'); if (!ok()) return;
  v.innerHTML = `${pageTitle('Powiadomienia', '#/')}<div class="card">${list.length ? list.map((n) => `<button class="mrow" ${n.link ? `data-go="${esc(n.link)}"` : ''}><span class="grow"><span ${n.read ? 'class="muted"' : ''}>${esc(n.text)}</span><br><small class="muted">${fmtDate(n.ts)}</small></span>${n.read ? '' : '<span class="tag acc">nowe</span>'}</button>`).join('') : '<div class="empty">Brak powiadomień.</div>'}</div>`;
  if (list.some((n) => !n.read)) { post('/api/notifs/read').then(() => setUnread(0)).catch(() => {}); }
}

/* ---------- TRYB OFFLINE (gra z CPU bez serwera; bez ELO i statystyk) ---------- */
function startOffline() {
  S.offLevel = S.offLevel || 'm'; S.offSide = S.offSide || '1';
  if (!S.me) {
    S.offlineShell = true; document.body.classList.remove('hide-tabs');
    $('#app').innerHTML = `<header class="top"><a class="logo" href="#/offline"><i></i>Na kartce</a><span class="tag acc">Offline</span><div class="grow"></div><button class="btn sm" data-act="offexit">Wyjdź</button></header><main id="view"></main>`;
    window.removeEventListener('hashchange', route); window.addEventListener('hashchange', route);
    if (!S.tick) S.tick = setInterval(tickClocks, 250);
  }
  if (location.hash === '#/offline') route(); else location.hash = '#/offline';
}
function startOfflineMatch(slug) {
  const g = offlineGames().find((x) => x.slug === slug); if (!g) return toast('Ta gra nie jest dostępna offline');
  const side = S.offSide === '0' ? (Math.random() < 0.5 ? 1 : 2) : +S.offSide || 1;
  if (S.offCtl) S.offCtl.destroy();
  S.lastOff = { slug };
  S.offCtl = createOfflineMatch(g, S.offLevel || 'm', side, (snap) => handleMatch(snap));
  S.offCtl.start();
}
async function vOffline(v) {
  const games = offlineGames(), lv = S.offLevel || 'm', sd = S.offSide || '1';
  v.innerHTML = `${S.me ? pageTitle('Gra offline z CPU', '#/') : '<div class="play-top"><h2 style="font-size:24px">Gra offline z CPU</h2></div>'}
    ${S.match && S.match.offline && S.match.status === 'playing' ? '<a class="notice" style="text-decoration:none;background:var(--pri);color:var(--pri-ink)" href="#/play"><small>Trwa partia</small><b>Wróć do gry offline</b></a>' : ''}
    <div class="card small muted">Gra z komputerem działa bez internetu. Wyniki offline <b>nie liczą się</b> do rankingu ELO ani do statystyk gracza.</div>
    <div><span class="muted small">Poziom trudności</span><div class="seg" id="offLv" style="margin-top:6px">${['e', 'm', 'h'].map((l) => `<button data-act="offlevel" data-l="${l}" class="${l === lv ? 'on' : ''}">${LEVELS[l][0]}</button>`).join('')}</div></div>
    <div><span class="muted small">Twoja strona</span><div class="seg" id="offSd" style="margin-top:6px">${[['1', 'Zaczynam'], ['2', 'Drugi'], ['0', 'Losowo']].map(([k, l]) => `<button data-act="offside" data-s="${k}" class="${k === sd ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <section class="sec"><div class="sec-h"><h2>Wybierz grę</h2></div><div class="gamegrid">${games.map((g) => `<button class="gcard" data-act="offgame" data-g="${esc(g.slug)}"><span class="art" style="--h:${g.hue}${g.iconUrl ? `;background-image:url('${esc(assetUrl(g.iconUrl))}')` : ''}">${g.iconUrl ? '' : esc(g.icon || g.name.charAt(0))}</span><span class="info"><b>${esc(g.name)}</b><small>vs CPU</small></span></button>`).join('')}</div></section>`;
}

/* ---------- akcje (delegacja zdarzeń) ---------- */
const ACT = {
  async guest() { try { await afterAuth(await post('/api/auth/guest')); } catch (e) { const el = $('#welErr'); if (el) el.textContent = e.message; } },
  auth(el) { authSheet(el.dataset.mode); },
  scrim(el, ev) { if (ev.target === el && !S.waiting) closeSheet(); },
  game(el) { gameSheet(el.dataset.g); },
  tables(el) { tablesSheet(el.dataset.g); },
  sit(el) { let pin; if (el.dataset.pin === '1') { pin = prompt('PIN stołu:'); if (pin == null) return; } S.sock.send({ t: 'table_sit', game: el.dataset.g, n: +el.dataset.n, pin }) || toast('Brak połączenia'); },
  tleave() { S.sock.send({ t: 'table_leave' }); },
  totable() { if (S.tbl) { location.hash = '#/'; openTable(); } },
  tready() { const me = S.tbl && S.tbl.players.find((p) => p.uid === S.tbl.you); S.sock.send({ t: 'table_ready', ready: !(me && me.ready) }); },
  tkick(el) { S.sock.send({ t: 'table_kick', uid: +el.dataset.uid }); },
  async block(el) {
    try { await post('/api/me/blocks', { uid: +el.dataset.uid }); toast('Zablokowano: ' + (el.dataset.nick || 'gracz') + '. Odblokujesz w Profilu.'); if (!el.dataset.stay) route(); } catch (e) { toast(e.message); }
  },
  async unblock(el) { try { await del('/api/me/blocks/' + (+el.dataset.uid)); toast('Odblokowano'); route(); } catch (e) { toast(e.message); } },
  tinvite() { S.sock.send({ t: 'table_lobby' }); },
  tbot(el) { S.sock.send({ t: 'table_add_bot', level: el.dataset.l }); },
  offline() { startOffline(); },
  async retry() { await boot(); },
  offlevel(el) { S.offLevel = el.dataset.l; document.querySelectorAll('#offLv button').forEach((b) => b.classList.toggle('on', b === el)); },
  offside(el) { S.offSide = el.dataset.s; document.querySelectorAll('#offSd button').forEach((b) => b.classList.toggle('on', b === el)); },
  offgame(el) { startOfflineMatch(el.dataset.g); },
  async offexit() {
    if (S.offCtl) S.offCtl.destroy(); S.offCtl = null; S.match = null; S.offlineShell = false;
    if (getToken()) { try { S.me = (await get('/api/me', 6000)).me; return startApp(); } catch (e) { /* nadal offline */ } }
    S.netFail = false; showWelcome();
  },
  tinv(el) { S.sock.send({ t: 'table_invite', uid: +el.dataset.uid }); el.disabled = true; el.textContent = 'Wysłano'; },
  tquick(el) { if (isGuest()) return toast(GUEST_MSG); S.sock.send({ t: 'table_quick', id: +el.dataset.q }); },
  inv_yes() { const i = S.invite; closeSheet(); if (i) S.sock.send({ t: 'table_invite_reply', game: i.game, n: i.n, accept: true }); },
  inv_no() { const i = S.invite; closeSheet(); if (i) S.sock.send({ t: 'table_invite_reply', game: i.game, n: i.n, accept: false }); },
  undo() { wsend({ t: 'undo_req', id: S.match.id }); },
  undo_yes() { S.sock.send({ t: 'undo_reply', id: S.match.id, accept: true }); },
  undo_no() { S.sock.send({ t: 'undo_reply', id: S.match.id, accept: false }); },
  rematch() { S.sock.send({ t: 'rematch', id: S.match.id }); },
  quick(el) { if (isGuest()) return toast(GUEST_MSG); S.sock.send({ t: 'quick', id: S.match.id, q: +el.dataset.q }); },
  queue(el) { if (el.disabled) return; const g = el.dataset.g; S.sock.send({ t: 'queue', game: g, rated: !!el.dataset.rated }) || toast('Brak połączenia'); },
  unqueue() { S.sock.send({ t: 'unqueue' }); S.waiting = null; closeSheet(); },
  room(el) { S.sock.send({ t: 'room_create', game: el.dataset.g, rated: false }) || toast('Brak połączenia'); },
  roomcancel() { S.sock.send({ t: 'room_cancel' }); S.waiting = null; closeSheet(); },
  async sharecode(el) { const code = el.dataset.code, text = `Zagraj ze mną na kartce! (nakartce.pl) Kod pokoju: ${code}`; try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('Skopiowano'); } } catch (e) { /* anulowano */ } },
  joinpick() { joinSheet(); },
  botpick(el) { S.botSide = '1'; botSheet(el.dataset.g); },
  side(el) { S.botSide = el.dataset.s; document.querySelectorAll('#sideSeg button').forEach((b) => b.classList.toggle('on', b === el)); },
  bot(el) { const g = el.dataset.g, l = el.dataset.l; S.lastBot = { g, l, side: S.botSide || '1' }; S.sock.send({ t: 'bot', game: g, level: l, side: S.lastBot.side === '0' ? undefined : S.lastBot.side }) || toast('Brak połączenia'); },
  watch(el) { S.sock.send({ t: 'watch', id: +el.dataset.id }); },
  again() { const m = S.match; S.match = null; if (m && m.offline && S.lastOff) return startOfflineMatch(S.lastOff.slug); if (m && m.mode === 'bot' && S.lastBot) { S.sock.send({ t: 'bot', game: S.lastBot.g, level: S.lastBot.l, side: S.lastBot.side === '0' ? undefined : S.lastBot.side }); } else { location.hash = '#/'; if (m) setTimeout(() => gameSheet(m.game.slug), 50); } },
  leaveplay() { /* zwykły link do lobby */ },
  async resign() { if (await confirmBox('Na pewno się poddajesz?', 'Poddaj się', true)) wsend({ t: 'resign', id: S.match.id }); },
  draw() { S.sock.send({ t: 'draw', id: S.match.id }); },
  draw_no() { S.sock.send({ t: 'draw_decline', id: S.match.id }); },
  promo(el) { const p = S.ui.promo; if (!p) return; S.ui = {}; wsend({ t: 'move', id: S.match.id, move: { from: p.from, to: p.to, promo: el.dataset.p } }); },
  cell(el) { cellClick(+el.dataset.i); },
  async ad(el) { const id = el.dataset.id, url = el.dataset.url; post('/api/ads/' + id + '/click').catch(() => {}); if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener'); },
  closeinter() { const d = $('.inter'); if (d) d.remove(); },
  async tjoin(el) { try { await post('/api/tournaments/' + el.dataset.id + '/join'); toast('Zapisano na turniej!'); route(); } catch (e) { toast(e.message); if (isGuest()) authSheet('register'); } },
  async tleave(el) { try { await post('/api/tournaments/' + el.dataset.id + '/leave'); route(); } catch (e) { toast(e.message); } },
  tready(el) { S.sock.send({ t: 'tm_ready', id: +el.dataset.id }); },
  theme(el) { const t = el.dataset.t; if (t === 'auto') store.del('theme'); else store.set('theme', t); applyTheme(); route(); },
  async hue(el) { try { S.me = (await api('PUT', '/api/me', { hue: +el.dataset.h })).me; route(); } catch (e) { toast(e.message); } },
  sound(el) { const on = store.get('sound') === '0'; store.set('sound', on ? '1' : '0'); el.setAttribute('aria-checked', on); if (on) sfx('move'); },
  haptic(el) { const on = store.get('haptic') === '0'; store.set('haptic', on ? '1' : '0'); el.setAttribute('aria-checked', on); if (on) haptic(30); },
  pwd() { sheet(`<h2>Zmień hasło</h2><form data-form="pwd" class="stack"><label class="fld"><span>Obecne hasło</span><input name="old" type="password" autocomplete="current-password" required></label><label class="fld"><span>Nowe hasło (min. 8 znaków)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label><p class="err" id="authErr"></p><button class="btn pri block" type="submit">Zapisz</button></form>`); },
  async install() { const p = S.deferredInstall; if (!p) return; p.prompt(); S.deferredInstall = null; },
  async logout() {
    if (isGuest() && !(await confirmBox('Jako gość stracisz dostęp do tego konta. Wylogować?', 'Wyloguj', true))) return;
    try { await post('/api/auth/logout'); } catch (e) { /* offline – token i tak zostanie usunięty lokalnie */ }
    if (S.sock) S.sock.close(); S.sock = null; setToken(null); S.me = null; S.match = null; netBanner(false); showWelcome();
  },
  report(el) { sheet(`<h2>Zgłoś gracza ${esc(el.dataset.nick)}</h2><form data-form="report" class="stack"><input type="hidden" name="nick" value="${esc(el.dataset.nick)}"><label class="fld"><span>Powód</span><select name="reason"><option>obrażanie</option><option>spam</option><option>oszustwo</option><option>niewłaściwe zachowanie</option></select></label><label class="fld"><span>Opis (opcjonalnie)</span><textarea name="note" maxlength="300"></textarea></label><button class="btn pri block" type="submit">Wyślij zgłoszenie</button></form>`); },
  reload() { route(); }
};
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]'); if (go && !e.target.closest('[data-act]')) { location.hash = go.dataset.go; return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (fn) { if (el.tagName === 'A' && el.dataset.act !== 'leaveplay') e.preventDefault(); fn(el, e); }
});
document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches('.chat input[readonly]')) toast(GUEST_MSG); });
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f).entries()), kind = f.dataset.form, err = $('#authErr');
  const fail = (x) => { if (err) err.textContent = x.message; else toast(x.message); };
  const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (kind === 'login') await afterAuth(await post('/api/auth/login', { login: d.login, password: d.password }));
    else if (kind === 'register') await afterAuth(await post('/api/auth/register', d));
    else if (kind === 'join') { S.sock.send({ t: 'room_join', code: d.code }); closeSheet(); }
    else if (kind === 'tchat') { if (isGuest()) toast(GUEST_MSG); else if (d.text.trim()) S.sock.send({ t: 'table_chat', text: d.text }); f.reset(); }
    else if (kind === 'tset') { S.tDirty = false; S.sock.send({ t: 'table_set', settings: { visibility: d.visibility, pin: d.pin || '', minRating: +d.minRating || 0, maxRating: +d.maxRating || 0, undo: !!d.undo, allowBots: !!d.allowBots, rated: !!d.rated, clock: { mode: d.cmode, sec: +d.csec } } }); }
    else if (kind === 'chat') { if (isGuest()) toast(GUEST_MSG); else if (d.text.trim() && S.match) S.sock.send({ t: 'chat', id: S.match.id, text: d.text }); f.reset(); }
    else if (kind === 'pwd') { const r = await post('/api/me/password', { old: d.old, password: d.password }); if (r.token) setToken(r.token); closeSheet(); toast('Hasło zmienione – inne urządzenia zostały wylogowane'); }
    else if (kind === 'report') { await post('/api/report', d); closeSheet(); toast('Dziękujemy – zgłoszenie wysłane'); }
  } catch (x) { fail(x); } finally { if (btn) btn.disabled = false; }
});

boot();
