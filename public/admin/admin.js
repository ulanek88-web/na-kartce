/* Na kartce — panel administratora (CMS). Czysty JS, bez bibliotek. */
const TOKEN_KEY = 'nakartce.token';
const E = window.NKEngines;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
const lsSet = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } };
let token = lsGet(), me = null;

async function api(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('Brak połączenia z serwerem'); }
  let d = null; try { d = await r.json(); } catch (e) { /* pusta */ }
  if (!r.ok) { const err = new Error((d && d.error) || 'Błąd ' + r.status); err.status = r.status; throw err; }
  return d;
}
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2800); }
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + '%';
const toLocalInput = (ts) => { if (!ts) return ''; const d = new Date(ts), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

function dlg(html) {
  const l = $('#layer');
  l.innerHTML = `<div class="scrim" data-act="scrim"><div class="dlg" role="dialog" aria-modal="true">${html}</div></div>`;
}
const closeDlg = () => { $('#layer').innerHTML = ''; };
function ask(text, ok, danger) {
  return new Promise((res) => {
    dlg(`<h3>${esc(text)}</h3><div class="cols"><button class="btn" data-x="no">Anuluj</button><button class="btn ${danger ? 'bad' : 'pri'}" data-x="yes">${esc(ok || 'OK')}</button></div>`);
    const l = $('#layer');
    const h = (e) => { const b = e.target.closest('[data-x]'); if (!b) return; e.stopPropagation(); l.removeEventListener('click', h, true); closeDlg(); res(b.dataset.x === 'yes'); };
    l.addEventListener('click', h, true);
  });
}

/* ---------- logowanie ---------- */
function loginView(msg) {
  $('#root').innerHTML = `<form class="login" data-form="login"><h1>Panel Na kartce</h1><p class="muted">Zaloguj się kontem administratora.</p>
    <label class="fld"><span>Nick lub e-mail</span><input name="login" autocomplete="username" required></label>
    <label class="fld"><span>Hasło</span><input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" id="lerr">${esc(msg || '')}</p><button class="btn pri block" type="submit">Zaloguj</button><a href="/" class="small">← Wróć do gry</a></form>`;
}
async function init() {
  if (token) { try { me = await api('GET', '/api/admin/me'); } catch (e) { me = null; if (e.status === 401) { token = null; lsSet(null); } } }
  if (!me) return loginView(token ? 'To konto nie ma uprawnień do panelu.' : '');
  shell(); window.addEventListener('hashchange', route); route();
}

/* ---------- powłoka ---------- */
const isAdmin = () => me && me.role === 'admin';
const can = (cap) => !!me && (me.caps || []).some((c) => c === '*' || c === cap);
const navOk = (n) => (n[2] === 0 ? true : n[2] === 1 ? isAdmin() : can(n[2]));   // RBAC: 0 wszyscy, 1 Super Admin, tekst = wymagane uprawnienie
const ROLE_NAME = { admin: 'Super Admin', mod: 'Moderator', user: 'Gracz' };
const NAV = [['dash', 'Pulpit', 'stats'], ['games', 'Gry', 1], ['ads', 'Reklamy', 'ads'], ['content', 'Treści', 1], ['users', 'Użytkownicy', 0], ['reports', 'Moderacja', 0], ['tournaments', 'Turnieje', 1], ['settings', 'Ustawienia', 1]];
function shell() {
  const items = NAV.filter(navOk);
  $('#root').innerHTML = `<div class="bar-top"><b>Na kartce</b><span class="grow small" style="opacity:.7">${esc(me.nick)} · ${esc(ROLE_NAME[me.role] || me.role)}</span><a class="btn sm" href="/" target="_blank" rel="noopener">Otwórz grę</a><button class="btn sm" data-act="logout">Wyloguj</button></div>
    <nav class="nav">${items.map((n) => `<a href="#/${n[0]}" data-n="${n[0]}">${n[1]}</a>`).join('')}</nav><div class="wrap" id="view"></div>`;
}
const VIEWS = { dash: vDash, games: vGames, ads: vAds, content: vContent, users: vUsers, reports: vReports, tournaments: vTournaments, settings: vSettings };
/* moduły dodatkowe: Układ gier (drag&drop), Pluginy, Ogłoszenia */
const ex = await import('/admin/extras.js');
ex.init({ NAV, VIEWS, api, esc, toast, $, fmt, getToken: () => token });
const fx = await import('/admin/forum.js');
fx.init({ NAV, VIEWS, api, esc, toast, fmt, ask, dlg, closeDlg });
let rid = 0;
async function route() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] || (can('stats') ? 'dash' : 'users');
  const allowed = NAV.filter(navOk).map((n) => n[0]);
  const key = allowed.includes(name) ? name : allowed[0];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.n === key));
  const id = ++rid, v = $('#view');
  v.innerHTML = '<p class="muted">Ładowanie…</p>';
  try { await VIEWS[key](v, () => id === rid); } catch (e) {
    if (id !== rid) return;
    if (e.status === 401) { token = null; lsSet(null); return loginView('Sesja wygasła. Zaloguj się ponownie.'); }
    v.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><button class="btn" data-act="reload">Spróbuj ponownie</button></div>`;
  }
}
const reload = () => route();

/* ---------- pulpit ---------- */
function barChart(vals, labels, color) {
  const W = 320, H = 110, n = vals.length, mx = Math.max(1, ...vals), bw = W / n;
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 16}" role="img">${vals.map((v, i) => { const h = Math.round((v / mx) * H); return `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="3" fill="${color}"><title>${esc(labels[i])}: ${v}</title></rect>`; }).join('')}
    <text x="0" y="${H + 12}">${esc(labels[0])}</text><text x="${W}" y="${H + 12}" text-anchor="end">${esc(labels[n - 1])}</text></svg>`;
}
async function vDash(v, ok) {
  const s = await api('GET', '/api/admin/stats'); if (!ok()) return;
  const k = (b, l) => `<div class="kpi"><b>${b}</b><span>${l}</span></div>`;
  const mxG = Math.max(1, ...s.byGame.map((g) => g.n));
  v.innerHTML = `<div class="head"><h2>Pulpit</h2><button class="btn sm" data-act="reload">Odśwież</button></div>
    <div class="grid">${k(s.live.online, 'online teraz')}${k(s.live.activeMatches, 'partii trwa')}${k(s.live.queued, 'w kolejce')}${k(s.newToday, 'nowych dziś')}${k(s.dau, 'aktywni 24 h')}${k(s.wau, 'aktywni 7 dni')}${k(s.mau, 'aktywni 30 dni')}
      ${k(s.registered + ' / ' + s.guests, 'konta / goście')}${k(s.matchesToday, 'partii dziś')}${k(s.matchesTotal, 'partii łącznie')}${k(s.avgMinutes + ' min', 'śr. czas partii')}${k(s.openReports, 'otwarte zgłoszenia')}</div>
    <div class="two"><div class="card stack"><b>Partie – ostatnie 14 dni</b>${barChart(s.perDay.map((d) => d.matches), s.perDay.map((d) => d.day.slice(5)), 'var(--pri)')}</div>
      <div class="card stack"><b>Nowi gracze – ostatnie 14 dni</b>${barChart(s.perDay.map((d) => d.users), s.perDay.map((d) => d.day.slice(5)), 'var(--accent)')}</div>
      <div class="card stack"><b>Najpopularniejsze gry (7 dni)</b>${s.byGame.length ? s.byGame.map((g) => `<div class="hbar"><span style="width:110px">${esc(g.name)}</span><div class="bar"><i style="width:${(g.n / mxG) * 100}%"></i></div><b>${g.n}</b></div>`).join('') : '<p class="muted">Jeszcze brak partii.</p>'}</div>
      <div class="card stack"><b>Godziny gry (7 dni)</b>${barChart(s.hours, ['0:00', ...new Array(22).fill(''), '23:00'], 'var(--pri)')}</div>
      <div class="card stack"><b>Reklamy</b><div class="grid"><div class="kpi"><b>${s.ads.active}</b><span>aktywnych</span></div><div class="kpi"><b>${s.ads.impressions}</b><span>wyświetleń</span></div><div class="kpi"><b>${s.ads.clicks}</b><span>kliknięć</span></div><div class="kpi"><b>${pct(s.ads.ctr)}</b><span>CTR</span></div></div></div>
      <div class="card stack"><b>Gry</b><div class="grid"><div class="kpi"><b>${s.games.active}</b><span>aktywne</span></div><div class="kpi"><b>${s.games.soon}</b><span>wkrótce</span></div><div class="kpi"><b>${s.games.hidden}</b><span>ukryte</span></div><div class="kpi"><b>${s.tournaments}</b><span>turnieje w toku</span></div></div></div></div>`;
}

/* ---------- gry ---------- */
const STATUS = { active: ['Aktywna', 'good'], soon: ['Wkrótce', 'acc'], hidden: ['Ukryta', ''] };
let gamesCache = [], enginesCache = [];
async function vGames(v, ok) {
  const [games, engines] = await Promise.all([api('GET', '/api/admin/games'), api('GET', '/api/admin/engines')]); if (!ok()) return;
  gamesCache = games; enginesCache = engines;
  v.innerHTML = `<div class="head"><h2>Gry</h2><button class="btn pri" data-act="gameNew">+ Nowa gra</button></div>
    <p class="hint">Przełącznik statusu działa od razu: <b>Aktywna</b> – gracze mogą grać, <b>Wkrótce</b> – widoczna jako zapowiedź, <b>Ukryta</b> – niewidoczna. Nową grę dodasz, wybierając gotowy silnik (np. siatka m×n daje kółko i krzyżyk, gomoku, czwórki i własne warianty).</p>
    <div class="card list">${games.map((g) => `<div class="item"><span class="gt" style="--h:${g.hue}${g.iconUrl ? `;background-image:url('${esc(g.iconUrl)}')` : ''}">${g.iconUrl ? '' : esc(g.icon)}</span>
      <div class="grow"><b>${esc(g.name)}</b><small>${esc(g.engine ? (enginesCache.find((e) => e.id === g.engine) || { label: g.engine }).label.split('(')[0] : 'bez silnika')} · ${g.matches} partii · ${g.players} w rankingu</small></div>
      <div class="seg">${['active', 'soon', 'hidden'].map((s) => `<button data-act="gameStatus" data-id="${g.id}" data-s="${s}" class="${g.status === s ? 'on' : ''}">${STATUS[s][0]}</button>`).join('')}</div>
      <button class="btn sm" data-act="gameEdit" data-id="${g.id}">Edytuj</button></div>`).join('')}</div>`;
}
const TEMPLATES = [
  ['Gomoku 19×19', { name: 'Gomoku 19×19', slug: 'gomoku-19', icon: '●', hue: 160, engine: 'mnk', params: { w: 19, h: 19, k: 5 }, rules: 'Zdobądź pięć kamieni w jednej linii – poziomo, pionowo lub po skosie.' }],
  ['Kółko i krzyżyk 5×5', { name: 'Kółko i krzyżyk 5×5', slug: 'kik-5', icon: '✕', hue: 30, engine: 'mnk', params: { w: 5, h: 5, k: 4 }, rules: 'Ułóż cztery znaki w linii na planszy 5×5.' }],
  ['Czwórki duże 9×8', { name: 'Czwórki XL', slug: 'czworki-xl', icon: '◉', hue: 215, engine: 'mnk', params: { w: 9, h: 8, k: 4, gravity: true }, rules: 'Wrzucaj żetony do kolumn. Pierwszy z czterema w linii wygrywa.' }],
  ['Warcaby 8×8', { name: 'Warcaby 8×8', slug: 'warcaby-8', icon: '◎', hue: 20, engine: 'checkers', params: { n: 8 }, rules: 'Warcaby polskie na planszy 8×8. Bicie jest obowiązkowe.' }]
];
function paramsFields(engineId, values) {
  const e = enginesCache.find((x) => x.id === engineId);
  if (!e || !e.params.length) return '<p class="hint">Ten silnik nie ma dodatkowych ustawień.</p>';
  return `<div class="cols">${e.params.map((p) => {
    const val = values && values[p.key] != null ? values[p.key] : p.def;
    if (p.type === 'bool') return `<label class="chk" style="grid-column:1/-1"><input type="checkbox" name="p_${p.key}" ${val ? 'checked' : ''}> ${esc(p.label)}</label>`;
    if (p.type === 'select') return `<label class="fld"><span>${esc(p.label)}</span><select name="p_${p.key}">${p.options.map((o) => `<option ${+val === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    return `<label class="fld"><span>${esc(p.label)} (${p.min}–${p.max})</span><input type="number" name="p_${p.key}" min="${p.min}" max="${p.max}" value="${esc(val)}"></label>`;
  }).join('')}</div>`;
}
function gameForm(g) {
  const isNew = !g.id;
  dlg(`<h3>${isNew ? 'Nowa gra' : 'Edycja: ' + esc(g.name)}</h3>
    ${isNew ? `<div><span class="hint">Szablony – kliknij, aby wypełnić formularz:</span><div class="tpls" style="margin-top:6px">${TEMPLATES.map((t, i) => `<button class="chip" type="button" data-act="gameTpl" data-i="${i}">${esc(t[0])}</button>`).join('')}</div></div>` : ''}
    <form data-form="game" data-id="${g.id || ''}" class="stack">
      <div class="cols"><label class="fld"><span>Nazwa</span><input name="name" maxlength="40" required value="${esc(g.name)}"></label>
      <label class="fld"><span>Adres (slug)</span><input name="slug" maxlength="30" ${isNew ? '' : 'disabled'} placeholder="np. gomoku-19" value="${esc(g.slug)}"></label></div>
      <div class="cols3"><label class="fld"><span>Ikona (znak)</span><input name="icon" maxlength="4" value="${esc(g.icon)}"></label>
      <label class="fld"><span>Kolor (0–360)</span><input name="hue" type="number" min="0" max="360" value="${esc(g.hue)}"></label>
      <label class="fld"><span>Kategoria</span><input name="category" maxlength="30" value="${esc(g.category)}"></label></div>
      <div class="fld"><span>Grafika kafelka (opcjonalnie)</span><div class="row"><span class="thumb" id="iconPrev" style="${g.iconUrl ? `background-image:url('${esc(g.iconUrl)}')` : ''}"></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload="icon_url"><input type="hidden" name="icon_url" value="${esc(g.iconUrl || '')}"></div></div>
      <label class="fld"><span>Krótki opis</span><input name="description" maxlength="300" value="${esc(g.description)}"></label>
      <label class="fld"><span>Zasady gry (widoczne dla graczy)</span><textarea name="rules" maxlength="6000">${esc(g.rules)}</textarea></label>
      <label class="fld"><span>Silnik gry</span><select name="engine" data-act-change="engine"><option value="">— brak (tylko zapowiedź) —</option>${enginesCache.map((e) => `<option value="${e.id}" ${g.engine === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
      <div id="paramBox">${paramsFields(g.engine, g.params)}</div>
      <div class="cols3"><label class="fld"><span>Czas na partię (min)</span><input name="time_min" type="number" min="0" max="120" step="0.5" value="${esc(Math.round((g.timeSec || 0) / 6) / 10)}"></label>
      <label class="fld"><span>Przyrost (s/ruch)</span><input name="inc_sec" type="number" min="0" max="60" value="${esc(g.incSec || 0)}"></label>
      <label class="fld"><span>Kolejność</span><input name="sort" type="number" value="${esc(g.sort == null ? 100 : g.sort)}"></label></div>
      <div class="cols"><label class="chk"><input type="checkbox" name="rated" ${g.rated !== false ? 'checked' : ''}> Ranking</label><label class="chk"><input type="checkbox" name="bots" ${g.bots !== false ? 'checked' : ''}> Gra z botem</label></div>
      <label class="fld"><span>Status</span><select name="status">${Object.keys(STATUS).map((s) => `<option value="${s}" ${(g.status || 'hidden') === s ? 'selected' : ''}>${STATUS[s][0]}</option>`).join('')}</select></label>
      <p class="err" id="ferr"></p>
      <div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div>
      ${!isNew ? `<button class="btn bad" type="button" data-act="gameDel" data-id="${g.id}">Usuń grę</button>` : ''}
    </form>`);
}
const blankGame = () => ({ name: '', slug: '', icon: '★', hue: 150, category: 'Planszowe', description: '', rules: '', engine: 'mnk', params: {}, status: 'hidden', timeSec: 300, incSec: 0, sort: 100, rated: true, bots: true });

/* ---------- reklamy ---------- */
const SLOTS = { top_banner: 'Top – 728×90 (góra strony)', sidebar: 'Sidebar – 300×250 (szerokie ekrany)', footer: 'Footer – 728×90 (stopka)', interstitial: 'Między grami – 300×250 (pełny ekran)', lobby_banner: 'Baner w lobby – 728×90', after_game: 'Po zakończeniu partii – 300×250', game_tile: 'Kafelek gry – 300×250' };
const SLOT_SIZE = { top_banner: '728×90', footer: '728×90', lobby_banner: '728×90', sidebar: '300×250', interstitial: '300×250', after_game: '300×250', game_tile: '300×250' };
const SCHEDULES = [['forever', 'Bezterminowo'], ['1d', '1 dzień'], ['2d', '2 dni'], ['1w', '1 tydzień'], ['1m', '1 miesiąc'], ['range', 'Zakres dat']];
let adsCache = [];
async function vAds(v, ok) {
  const [ads, games] = await Promise.all([api('GET', '/api/admin/ads'), api('GET', '/api/admin/games')]); if (!ok()) return;
  adsCache = ads; gamesCache = games;
  v.innerHTML = `<div class="head"><h2>Reklamy</h2><button class="btn pri" data-act="adNew">+ Nowa reklama</button></div>
    <p class="hint">Reklamy wyświetlają się w aplikacji i na stronie. Możesz ją włączyć/wyłączyć jednym kliknięciem, ograniczyć do gry, grupy graczy, urządzenia, dat i limitu wyświetleń na gracza dziennie. Globalny wyłącznik reklam: Ustawienia.</p>
    <div class="card list">${ads.length ? ads.map((a) => `<div class="item"><span class="thumb" style="${a.image_url ? `background-image:url('${esc(a.image_url)}')` : `background:hsl(${a.color} 60% 55%)`}"></span>
      <div class="grow"><b>${esc(a.name)} ${a.enabled ? '<span class="tag good">włączona</span>' : '<span class="tag">wyłączona</span>'}</b><small>${esc(SLOTS[a.slot])}${a.game ? ' · gra: ' + esc(a.game) : ''} · ${a.impressions} wyśw. · ${a.clicks} klik. · CTR ${pct(a.ctr)}${a.advertiser ? ' · ' + esc(a.advertiser) : ''}</small></div>
      <div class="acts"><button class="btn sm" data-act="adToggle" data-id="${a.id}">${a.enabled ? 'Wyłącz' : 'Włącz'}</button><button class="btn sm" data-act="adEdit" data-id="${a.id}">Edytuj</button></div></div>`).join('') : '<div class="empty muted" style="padding:20px;text-align:center">Brak reklam. Dodaj pierwszą kampanię.</div>'}</div>`;
}
const blankAd = () => ({ schedule: 'forever', slide_sec: 8, kind: 'banner', code: '', name: '', slot: 'lobby_banner', title: '', text: '', image_url: '', link_url: '', color: 40, game: '', audience: 'all', device: 'all', enabled: true, start: 0, end: 0, max_per_day: 0, weight: 1, advertiser: '', budget_note: '' });
function adForm(a) {
  const isNew = !a.id;
  dlg(`<h3>${isNew ? 'Nowa reklama' : 'Edycja reklamy'}</h3>
    <form data-form="ad" data-id="${a.id || ''}" class="stack">
      <div class="cols"><label class="fld"><span>Nazwa kampanii (wewn.)</span><input name="name" maxlength="80" required value="${esc(a.name)}"></label><label class="fld"><span>Reklamodawca</span><input name="advertiser" maxlength="80" value="${esc(a.advertiser)}"></label></div>
      <label class="fld"><span>Miejsce wyświetlania</span><select name="slot">${Object.keys(SLOTS).map((s) => `<option value="${s}" ${a.slot === s ? 'selected' : ''}>${SLOTS[s]}</option>`).join('')}</select></label>
      <label class="fld"><span>Rodzaj reklamy</span><select name="kind"><option value="banner" ${a.kind !== 'code' ? 'selected' : ''}>Baner (obrazek + link)</option><option value="code" ${a.kind === 'code' ? 'selected' : ''}>Własny kod (HTML / JS, np. AdSense)</option></select></label>
      <label class="fld"><span>Kod reklamy (tylko dla rodzaju „Własny kod” – działa w izolowanym iframe)</span><textarea name="code" maxlength="8000" style="min-height:80px;font-family:monospace">${esc(a.code || '')}</textarea></label>
      <label class="fld"><span>Nagłówek</span><input name="title" maxlength="80" value="${esc(a.title)}" data-prev></label>
      <label class="fld"><span>Tekst</span><textarea name="text" maxlength="240" style="min-height:64px" data-prev>${esc(a.text)}</textarea></label>
      <div class="fld"><span>Obrazek (PNG/JPG/WEBP/GIF, maks. 2 MB). Proporcje muszą pasować do miejsca (<b id="adSize">${SLOT_SIZE[a.slot] || ''}</b>) – serwer sam przytnie i przeskaluje do idealnych wymiarów; plik o złych proporcjach zostanie odrzucony.</span><div class="row"><span class="thumb" id="adPrevImg" style="${a.image_url ? `background-image:url('${esc(a.image_url)}')` : ''}"></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload="image_url"><input type="hidden" name="image_url" value="${esc(a.image_url || '')}"></div></div>
      <div class="cols"><label class="fld"><span>Link po kliknięciu (https://…)</span><input name="link_url" type="url" maxlength="400" value="${esc(a.link_url || '')}"></label><label class="fld"><span>Kolor tła bez obrazka (0–360)</span><input name="color" type="number" min="0" max="360" value="${esc(a.color)}"></label></div>
      <div class="cols3"><label class="fld"><span>Gra</span><select name="game"><option value="">Wszystkie</option>${gamesCache.map((g) => `<option value="${g.slug}" ${a.game === g.slug ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Odbiorcy</span><select name="audience">${[['all', 'Wszyscy'], ['guests', 'Goście'], ['users', 'Zarejestrowani']].map(([k, l]) => `<option value="${k}" ${a.audience === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Urządzenie</span><select name="device">${[['all', 'Wszystkie'], ['mobile', 'Telefon / aplikacja'], ['desktop', 'Komputer']].map(([k, l]) => `<option value="${k}" ${a.device === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div class="cols"><label class="fld"><span>Harmonogram emisji</span><select name="schedule">${SCHEDULES.map(([k, l]) => `<option value="${k}" ${(a.schedule || 'range') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="fld"><span>Czas slajdu w sliderze (s)</span><input name="slide_sec" type="number" min="2" max="120" value="${esc(a.slide_sec || 8)}"></label></div>
      <p class="hint">Gotowe okresy liczone są od chwili zapisu${a.id && ['1d','2d','1w','1m'].includes(a.schedule) ? ` (obecnie do ${fmt(a.end)})` : ''}. <label class="chk"><input type="checkbox" name="restart"> licz od nowa</label></p>
      <div class="cols"><label class="fld"><span>Od (tylko „Zakres dat”)</span><input name="start" type="datetime-local" value="${toLocalInput(a.start)}"></label><label class="fld"><span>Do (tylko „Zakres dat”)</span><input name="end" type="datetime-local" value="${toLocalInput(a.end)}"></label></div>
      <div class="cols3"><label class="fld"><span>Limit / gracz / dzień (0 = brak)</span><input name="max_per_day" type="number" min="0" value="${esc(a.max_per_day)}"></label><label class="fld"><span>Waga (1–100)</span><input name="weight" type="number" min="1" max="100" value="${esc(a.weight)}"></label><label class="chk" style="align-self:end"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}> Włączona</label></div>
      <label class="fld"><span>Notatka (budżet/umowa)</span><input name="budget_note" maxlength="120" value="${esc(a.budget_note || '')}"></label>
      <div><span class="hint">Podgląd:</span><div class="preview" id="adPrev"></div></div>
      <p class="err" id="ferr"></p>
      <div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div>
      ${!isNew ? `<div class="cols"><button class="btn" type="button" data-act="adReset" data-id="${a.id}">Zeruj statystyki</button><button class="btn bad" type="button" data-act="adDel" data-id="${a.id}">Usuń</button></div>` : ''}
    </form>`);
  adPreview();
}
function adPreview() {
  const f = $('form[data-form=ad]'); if (!f) return;
  const img = f.image_url.value, hue = f.color.value || 40;
  $('#adPrev').innerHTML = `<div style="display:flex;gap:12px;align-items:center;border:1px dashed var(--line);border-radius:14px;padding:12px;background:var(--surface)"><span class="thumb" style="width:64px;height:64px;${img ? `background-image:url('${esc(img)}')` : `background:hsl(${esc(hue)} 60% 55%)`}"></span><span><small class="hint" style="font-weight:800;letter-spacing:.08em;text-transform:uppercase">Reklama${f.advertiser.value ? ' · ' + esc(f.advertiser.value) : ''}</small><b style="display:block">${esc(f.title.value) || 'Nagłówek reklamy'}</b><span class="muted small">${esc(f.text.value)}</span></span></div>`;
}

/* ---------- treści ---------- */
async function vContent(v, ok) {
  const [news, pages] = await Promise.all([api('GET', '/api/admin/news'), api('GET', '/api/admin/pages')]); if (!ok()) return;
  window._news = news; window._pages = pages;
  v.innerHTML = `<div class="head"><h2>Treści</h2></div>
    <div class="card list"><div class="head"><b style="font-size:18px" class="grow">Aktualności i komunikaty w lobby</b><button class="btn sm pri" data-act="newsNew">+ Dodaj</button></div>
      ${news.map((n) => `<div class="item"><div class="grow"><b>${esc(n.title)} ${n.pinned ? '<span class="tag acc">przypięty</span>' : ''} ${n.active ? '' : '<span class="tag">ukryty</span>'}</b><small>${esc(n.body).slice(0, 90)}</small></div><button class="btn sm" data-act="newsEdit" data-id="${n.id}">Edytuj</button></div>`).join('') || '<p class="muted">Brak wpisów.</p>'}</div>
    <div class="card list"><div class="head"><b style="font-size:18px" class="grow">Strony (regulamin, pomoc, prywatność…)</b><button class="btn sm pri" data-act="pageNew">+ Nowa strona</button></div>
      ${pages.map((p) => `<div class="item"><div class="grow"><b>${esc(p.title)}</b><small>/#/page/${esc(p.slug)} · zmieniono ${fmt(p.updated_at)}</small></div><button class="btn sm" data-act="pageEdit" data-slug="${esc(p.slug)}">Edytuj</button></div>`).join('')}</div>`;
}
function newsForm(n) {
  dlg(`<h3>${n.id ? 'Edycja wpisu' : 'Nowy wpis'}</h3><form data-form="news" data-id="${n.id || ''}" class="stack">
    <label class="fld"><span>Tytuł</span><input name="title" maxlength="120" required value="${esc(n.title)}"></label>
    <label class="fld"><span>Treść</span><textarea name="body" maxlength="600">${esc(n.body)}</textarea></label>
    <label class="fld"><span>Rodzaj</span><select name="kind"><option value="news" ${n.kind !== 'banner' ? 'selected' : ''}>Aktualność</option><option value="banner" ${n.kind === 'banner' ? 'selected' : ''}>Komunikat</option></select></label>
    <div class="cols"><label class="chk"><input type="checkbox" name="pinned" ${n.pinned ? 'checked' : ''}> Przypięty na górze</label><label class="chk"><input type="checkbox" name="active" ${n.active !== false ? 'checked' : ''}> Widoczny</label></div>
    <p class="err" id="ferr"></p><div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div>
    ${n.id ? `<button class="btn bad" type="button" data-act="newsDel" data-id="${n.id}">Usuń</button>` : ''}</form>`);
}
function pageForm(p) {
  dlg(`<h3>${p.slug ? 'Edycja strony' : 'Nowa strona'}</h3><form data-form="page" class="stack">
    <label class="fld"><span>Adres (slug)</span><input name="slug" maxlength="40" ${p.slug ? 'readonly' : ''} required value="${esc(p.slug || '')}"></label>
    <label class="fld"><span>Tytuł</span><input name="title" maxlength="100" required value="${esc(p.title || '')}"></label>
    <label class="fld"><span>Treść</span><textarea name="body" style="min-height:240px">${esc(p.body || '')}</textarea></label>
    <p class="err" id="ferr"></p><div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div>
    ${p.slug ? `<button class="btn bad" type="button" data-act="pageDel" data-slug="${esc(p.slug)}">Usuń stronę</button>` : ''}</form>`);
}

/* ---------- użytkownicy ---------- */
let uq = { q: '', filter: '', page: 0 }, usersCache = [];
async function vUsers(v, ok) {
  const d = await api('GET', `/api/admin/users?q=${encodeURIComponent(uq.q)}&filter=${uq.filter}&page=${uq.page}`); if (!ok()) return;
  usersCache = d.rows;
  const now = Date.now(), banned = (u) => u.bannedUntil === -1 || u.bannedUntil > now, muted = (u) => u.mutedUntil === -1 || u.mutedUntil > now;
  v.innerHTML = `<div class="head"><h2>Użytkownicy <span class="muted small">(${d.total})</span></h2></div>
    <form data-form="usearch" class="row"><input class="grow" name="q" placeholder="Szukaj po nicku lub e-mailu" value="${esc(uq.q)}" style="min-height:44px;border:1px solid var(--line);border-radius:10px;padding:0 12px;background:var(--surface);font-size:16px"><button class="btn pri" type="submit">Szukaj</button></form>
    <div class="seg">${[['', 'Wszyscy'], ['registered', 'Konta'], ['guests', 'Goście'], ['banned', 'Zablokowani'], ['staff', 'Personel']].map(([k, l]) => `<button data-act="ufilter" data-f="${k}" class="${uq.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card list">${d.rows.map((u) => `<div class="item"><div class="grow"><b>${esc(u.nick)} ${u.guest ? '<span class="tag">gość</span>' : ''}${u.role !== 'user' ? ` <span class="tag acc">${u.role}</span>` : ''}${u.online ? ' <span class="tag good">online</span>' : ''}${banned(u) ? ' <span class="tag bad">ban</span>' : ''}${muted(u) ? ' <span class="tag bad">wyciszony</span>' : ''}</b>
      <small>${esc(u.email || 'bez e-maila')} · ${u.matches} partii · XP ${u.xp} · ostatnio ${fmt(u.lastSeen)}</small></div><button class="btn sm" data-act="userOpen" data-id="${u.id}">Akcje</button></div>`).join('') || '<p class="muted">Brak wyników.</p>'}</div>
    <div class="pager"><button class="btn sm" data-act="upage" data-d="-1" ${uq.page ? '' : 'disabled'}>‹</button><span class="muted small">Strona ${uq.page + 1} z ${Math.max(1, Math.ceil(d.total / 25))}</span><button class="btn sm" data-act="upage" data-d="1" ${(uq.page + 1) * 25 < d.total ? '' : 'disabled'}>›</button></div>`;
}
function userDlg(u) {
  const adm = isAdmin();
  dlg(`<h3>${esc(u.nick)}</h3><p class="muted small">${esc(u.email || 'gość')} · dołączył ${fmt(u.createdAt)}${u.banReason ? '<br>Powód bana: ' + esc(u.banReason) : ''}</p>
    <form data-form="uact" data-id="${u.id}" class="stack">
      <label class="fld"><span>Notatka / powód (widoczny w dzienniku)</span><input name="note" maxlength="200"></label>
      <label class="fld"><span>Czas kary</span><select name="hours"><option value="1">1 godzina</option><option value="24" selected>24 godziny</option><option value="168">7 dni</option><option value="720">30 dni</option><option value="perm">Na stałe</option></select></label>
      <div class="cols"><button class="btn" type="button" data-act="uact" data-a="warn" data-id="${u.id}">Ostrzeż</button><button class="btn" type="button" data-act="uact" data-a="mute" data-id="${u.id}">Wycisz czat</button>
      <button class="btn" type="button" data-act="uact" data-a="unmute" data-id="${u.id}">Zdejmij wyciszenie</button><button class="btn bad" type="button" data-act="uact" data-a="ban" data-id="${u.id}">Zablokuj</button></div>
      <div class="cols"><button class="btn" type="button" data-act="uact" data-a="unban" data-id="${u.id}">Odblokuj konto</button><button class="btn" type="button" data-act="uact" data-a="logout" data-id="${u.id}">Wymuś wylogowanie</button></div>
      ${adm && !u.guest ? `<label class="fld"><span>Rola</span><select name="role"><option value="user" ${u.role === 'user' ? 'selected' : ''}>Gracz</option><option value="mod" ${u.role === 'mod' ? 'selected' : ''}>Moderator</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Super Admin</option></select></label><button class="btn" type="button" data-act="uact" data-a="role" data-id="${u.id}">Zmień rolę</button>
      <label class="fld"><span>Nowe hasło (min. 8 znaków)</span><input name="password" type="text" autocomplete="off"></label><button class="btn" type="button" data-act="uact" data-a="set_password" data-id="${u.id}">Ustaw hasło</button>` : ''}
      ${adm ? `<div class="cols"><button class="btn" type="button" data-act="uact" data-a="reset_rating" data-id="${u.id}">Zeruj rankingi</button><button class="btn bad" type="button" data-act="uact" data-a="delete" data-id="${u.id}">Usuń i zanonimizuj konto</button></div>` : ''}
      <button class="btn ghost" type="button" data-act="close">Zamknij</button></form>`);
}

/* ---------- moderacja ---------- */
let rstatus = 'open';
async function vReports(v, ok) {
  const [reps, log] = await Promise.all([api('GET', '/api/admin/reports?status=' + rstatus), api('GET', '/api/admin/modlog')]); if (!ok()) return;
  v.innerHTML = `<div class="head"><h2>Moderacja</h2></div>
    <div class="seg"><button data-act="rstatus" data-s="open" class="${rstatus === 'open' ? 'on' : ''}">Otwarte</button><button data-act="rstatus" data-s="closed" class="${rstatus === 'closed' ? 'on' : ''}">Zamknięte</button></div>
    <div class="card list">${reps.map((r) => `<div class="item"><div class="grow"><b>${esc(r.target)} <span class="tag bad">${esc(r.reason)}</span></b><small>zgłosił ${esc(r.reporter)} · ${fmt(r.createdAt)}${r.game ? ' · ' + esc(r.game) : ''}${r.note ? '<br>„' + esc(r.note) + '”' : ''}${r.resolution ? '<br>Decyzja: ' + esc(r.resolution) : ''}</small></div>
      ${rstatus === 'open' ? `<div class="acts"><button class="btn sm" data-act="userByNick" data-nick="${esc(r.target)}">Karz</button><button class="btn sm pri" data-act="rclose" data-id="${r.id}">Zamknij</button></div>` : ''}</div>`).join('') || '<p class="muted">Brak zgłoszeń.</p>'}</div>
    <div class="card"><b style="font-size:18px">Dziennik moderacji</b><div class="scroll-x"><table class="tbl"><tr><th>Kiedy</th><th>Kto</th><th>Akcja</th><th>Gracz</th><th>Notatka</th></tr>${log.map((l) => `<tr><td>${fmt(l.ts)}</td><td>${esc(l.admin || '—')}</td><td>${esc(l.action)}</td><td>${esc(l.user || '—')}</td><td>${esc(l.note)}</td></tr>`).join('')}</table></div></div>`;
}

/* ---------- turnieje ---------- */
async function vTournaments(v, ok) {
  const [list, games] = await Promise.all([api('GET', '/api/admin/tournaments'), api('GET', '/api/admin/games')]); if (!ok()) return;
  gamesCache = games; window._tours = list;
  const ST = { open: 'Zapisy', running: 'Trwa', finished: 'Zakończony', cancelled: 'Odwołany' };
  v.innerHTML = `<div class="head"><h2>Turnieje</h2><button class="btn pri" data-act="tNew">+ Nowy turniej</button></div>
    <p class="hint">Turniej pucharowy (drabinka z wolnymi losami, rozstawienie wg rankingu). Startuje automatycznie o wyznaczonej godzinie albo od razu przyciskiem „Start”.</p>
    <div class="card list">${list.map((t) => `<div class="item"><div class="grow"><b>${esc(t.name)} <span class="tag ${t.status === 'open' ? 'good' : t.status === 'running' ? 'acc' : ''}">${ST[t.status]}</span></b><small>${esc(t.gameName)} · ${fmt(t.startAt)} · ${t.players}/${t.maxPlayers} graczy${t.prize ? ' · ' + esc(t.prize) : ''}${t.winner ? ' · 🏆 ' + esc(t.winner) : ''}</small></div>
      <div class="acts">${t.status === 'open' ? `<button class="btn sm" data-act="tEdit" data-id="${t.id}">Edytuj</button><button class="btn sm pri" data-act="tStart" data-id="${t.id}">Start</button>` : ''}${t.status === 'running' ? `<button class="btn sm" data-act="tManage" data-id="${t.id}">Mecze</button>` : ''}${t.status === 'open' || t.status === 'running' ? `<button class="btn sm bad" data-act="tCancel" data-id="${t.id}">Odwołaj</button>` : ''}</div></div>`).join('') || '<p class="muted">Brak turniejów.</p>'}</div>`;
}
function tForm(t) {
  const play = gamesCache.filter((g) => g.status === 'active');
  dlg(`<h3>${t.id ? 'Edycja turnieju' : 'Nowy turniej'}</h3><form data-form="tour" data-id="${t.id || ''}" class="stack">
    <label class="fld"><span>Nazwa</span><input name="name" maxlength="80" required value="${esc(t.name || '')}"></label>
    <div class="cols"><label class="fld"><span>Gra</span><select name="game">${play.map((g) => `<option value="${g.slug}" ${t.game === g.slug ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label><label class="fld"><span>Maks. graczy</span><input name="max_players" type="number" min="2" max="1024" value="${esc(t.maxPlayers || 32)}"></label></div>
    <label class="fld"><span>Start</span><input name="start" type="datetime-local" required value="${toLocalInput(t.startAt || Date.now() + 3600000)}"></label>
    <div class="cols"><label class="fld"><span>Nagroda</span><input name="prize" maxlength="120" value="${esc(t.prize || '')}"></label><label class="fld"><span>Sponsor</span><input name="sponsor" maxlength="80" value="${esc(t.sponsor || '')}"></label></div>
    <label class="fld"><span>Opis</span><textarea name="description" maxlength="400">${esc(t.description || '')}</textarea></label>
    <p class="err" id="ferr"></p><div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div></form>`);
}
async function tManage(id) {
  const t = await api('GET', '/api/tournaments/' + id);
  const ms = t.matches.filter((m) => m.status !== 'done' && m.p1 && m.p2);
  dlg(`<h3>${esc(t.name)} – mecze w toku</h3><p class="hint">Jeśli rywale nie rozegrają meczu, możesz ręcznie wskazać zwycięzcę.</p><div class="list">${ms.map((m) => `<div class="item"><div class="grow"><b>${esc(m.n1)} vs ${esc(m.n2)}</b><small>runda ${m.round} · ${m.status === 'playing' ? 'trwa partia' : 'czeka'}</small></div><div class="acts"><button class="btn sm" data-act="tWin" data-m="${m.id}" data-u="${m.p1}">${esc(m.n1)} wygrywa</button><button class="btn sm" data-act="tWin" data-m="${m.id}" data-u="${m.p2}">${esc(m.n2)} wygrywa</button></div></div>`).join('') || '<p class="muted">Brak oczekujących meczów.</p>'}</div><button class="btn" data-act="close">Zamknij</button>`);
}

/* ---------- ustawienia ---------- */
async function vSettings(v, ok) {
  const s = await api('GET', '/api/admin/settings'); if (!ok()) return;
  let leagues = []; try { leagues = JSON.parse(s.leagues); } catch (e) { /* ignore */ }
  const sw = (k, l, hint) => `<label class="chk" style="align-items:flex-start"><input type="checkbox" name="${k}" ${s[k] === '1' ? 'checked' : ''}><span>${l}${hint ? `<br><span class="hint" style="font-weight:400">${hint}</span>` : ''}</span></label>`;
  v.innerHTML = `<div class="head"><h2>Ustawienia</h2></div><form data-form="settings" class="stack">
    <div class="card stack"><b>Serwis</b><label class="fld"><span>Nazwa serwisu</span><input name="site_name" maxlength="60" value="${esc(s.site_name)}"></label><label class="fld"><span>Hasło reklamowe (tagline)</span><input name="tagline" maxlength="120" value="${esc(s.tagline)}"></label>
      ${sw('allow_guests', 'Gra jako gość', 'Gość gra bez rankingu.')}${sw('allow_register', 'Rejestracja nowych kont')}${sw('ads_enabled', 'Reklamy włączone', 'Globalny wyłącznik wszystkich reklam.')}
      ${sw('maintenance', 'Tryb prac technicznych', 'Pokazuje graczom komunikat w lobby.')}<label class="fld"><span>Komunikat o pracach</span><input name="maintenance_msg" maxlength="200" value="${esc(s.maintenance_msg)}"></label></div>
    <div class="card stack"><b>Rankingi i gra</b><div class="cols3"><label class="fld"><span>Startowy Elo</span><input name="default_rating" type="number" value="${esc(s.default_rating)}"></label><label class="fld"><span>Współczynnik K</span><input name="k_factor" type="number" value="${esc(s.k_factor)}"></label><label class="fld"><span>Rozłączenie (s)</span><input name="disconnect_grace_sec" type="number" value="${esc(s.disconnect_grace_sec)}"></label></div>
      <p class="hint">Zmiana startowego Elo i K dotyczy kolejnych kont/partii. Czas na powrót po rozłączeniu dotyczy partii z ludźmi.</p></div>
    <div class="card stack"><b>Boty CPU przy stołach</b>
      <p class="hint">Host stołu włącza/wyłącza „Zezwalaj na gry z CPU” (domyślnie włączone). Gdy gracz czeka sam przy stole <u>publicznym</u>, po tym czasie serwer dosadza bota. Partie z botami nie dają punktów ELO.</p>
      <div class="cols"><label class="fld"><span>Auto-bot po (sekundy; 0 = wyłączony)</span><input name="bot_autojoin_sec" type="number" min="0" max="3600" value="${esc(s.bot_autojoin_sec)}"><span class="hint">Domyślnie 120 s (2 minuty).</span></label>
        <label class="fld"><span>Poziom automatycznego bota</span><select name="bot_auto_level">${[['e', 'Łatwy'], ['m', 'Średni'], ['h', 'Trudny']].map(([k, l]) => `<option value="${k}" ${s.bot_auto_level === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      ${sw('bot_disguise', 'Bot udaje prawdziwego gracza', 'Losowy nick z listy poniżej i losowy awatar. Wyłączone: bot ma nazwę „Bot Ania / Marek / Hektor”.')}
      <label class="fld"><span>Lista nicków botów (po przecinku lub w nowych liniach; 3–16 znaków)</span><textarea name="bot_names" rows="4">${esc(String(s.bot_names || '').split(',').join(', '))}</textarea></label></div>
    <div class="card stack"><b>Kopia zapasowa</b><p class="hint">Serwer sam tworzy dzienną kopię bazy w katalogu danych (<code>backups/</code>, ostatnie 7). Tutaj pobierzesz pełną kopię (baza, wgrane pliki, pluginy) – przechowuj ją poza serwerem, razem z plikiem <code>secret.key</code>.</p><button type="button" class="btn" data-act="backupdl">Pobierz kopię zapasową (ZIP)</button></div>
    <div class="card stack"><b>Forum</b>${sw('forum_enabled', 'Forum włączone', 'Wyłącznik całego forum (struktura i treści zostają).')}
      <label class="fld"><span>Odstęp między postami jednego użytkownika (s)</span><input name="forum_cooldown_sec" type="number" min="0" max="3600" value="${esc(s.forum_cooldown_sec)}"><span class="hint">Ochrona przed spamem, domyślnie 30 s. Moderatorzy są zwolnieni z limitu. Kategorie, działy i moderatorów zmienisz w zakładce „Forum”.</span></label></div>
    <div class="card stack"><b>Ligi tygodniowe</b><p class="hint">Progi punktów (wygrana +25, remis +10, porażka −8). Liga resetuje się co tydzień.</p><div id="leagueBox" class="stack">${leagues.map((l) => leagueRow(l)).join('')}</div><button class="btn sm" type="button" data-act="leagueAdd">+ Dodaj ligę</button></div>
    <p class="err" id="ferr"></p><button class="btn pri block" type="submit">Zapisz ustawienia</button></form>`;
}
const leagueRow = (l) => `<div class="league-row"><input name="ln" value="${esc(l.n)}" maxlength="30" placeholder="Nazwa" style="min-height:44px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--surface);font-size:16px"><input name="lm" type="number" min="0" value="${esc(l.min)}" style="min-height:44px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--surface);font-size:16px"><input name="lc" type="color" value="${esc(l.color || '#888888')}"><button class="btn sm" type="button" data-act="leagueDel" aria-label="Usuń">✕</button></div>`;

/* ---------- obrazy ---------- */
function fileToData(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('Nie można odczytać pliku'));
    fr.onload = () => {
      if (file.size <= 480 * 1024 || file.type === 'image/gif') return res(fr.result);
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, 1000 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => rej(new Error('To nie jest poprawny obraz'));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/* ---------- akcje ---------- */
const val = (f, k) => f.elements[k] ? f.elements[k].value : '';
const chk = (f, k) => !!(f.elements[k] && f.elements[k].checked);
const ACT = {
  async backupdl() {          // pobranie kopii zapasowej (baza + pliki) jako ZIP – wymaga roli administratora
    try {
      const r = await fetch('/api/admin/backup', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Błąd ' + r.status);
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'nakartce-kopia-' + new Date().toISOString().slice(0, 10) + '.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message); }
  },
  logout() { token = null; lsSet(null); me = null; loginView(); },
  reload, close: closeDlg,
  scrim(el, e) { if (e.target === el) closeDlg(); },
  /* gry */
  async gameStatus(el) { try { await api('PUT', '/api/admin/games/' + el.dataset.id, Object.assign({}, gamesCache.find((g) => g.id === +el.dataset.id), { status: el.dataset.s, time_sec: gamesCache.find((g) => g.id === +el.dataset.id).timeSec, inc_sec: gamesCache.find((g) => g.id === +el.dataset.id).incSec, icon_url: gamesCache.find((g) => g.id === +el.dataset.id).iconUrl })); toast('Zapisano'); reload(); } catch (e) { toast(e.message); } },
  gameNew() { gameForm(blankGame()); },
  gameEdit(el) { gameForm(gamesCache.find((g) => g.id === +el.dataset.id)); },
  gameTpl(el) {
    const t = TEMPLATES[+el.dataset.i][1], f = $('form[data-form=game]');
    Object.assign(f.elements.name, { value: t.name }); f.elements.slug.value = t.slug; f.elements.icon.value = t.icon; f.elements.hue.value = t.hue; f.elements.rules.value = t.rules; f.elements.engine.value = t.engine;
    $('#paramBox').innerHTML = paramsFields(t.engine, t.params);
  },
  async gameDel(el) { if (!(await ask('Usunąć tę grę? (możliwe tylko, jeśli nie ma rozegranych partii)', 'Usuń', true))) return; try { await api('DELETE', '/api/admin/games/' + el.dataset.id); closeDlg(); toast('Usunięto'); reload(); } catch (e) { closeDlg(); toast(e.message); } },
  /* reklamy */
  adNew() { adForm(blankAd()); },
  adEdit(el) { adForm(adsCache.find((a) => a.id === +el.dataset.id)); },
  async adToggle(el) { const a = adsCache.find((x) => x.id === +el.dataset.id); try { await api('PUT', '/api/admin/ads/' + a.id, Object.assign({}, a, { enabled: !a.enabled })); reload(); } catch (e) { toast(e.message); } },
  async adReset(el) { await api('POST', '/api/admin/ads/' + el.dataset.id + '/reset'); closeDlg(); toast('Wyzerowano'); reload(); },
  async adDel(el) { if (!(await ask('Usunąć tę reklamę?', 'Usuń', true))) return; await api('DELETE', '/api/admin/ads/' + el.dataset.id); closeDlg(); toast('Usunięto'); reload(); },
  /* treści */
  newsNew() { newsForm({}); }, newsEdit(el) { newsForm(window._news.find((n) => n.id === +el.dataset.id)); },
  async newsDel(el) { if (!(await ask('Usunąć wpis?', 'Usuń', true))) return; await api('DELETE', '/api/admin/news/' + el.dataset.id); closeDlg(); reload(); },
  pageNew() { pageForm({}); }, pageEdit(el) { pageForm(window._pages.find((p) => p.slug === el.dataset.slug)); },
  async pageDel(el) { if (!(await ask('Usunąć stronę?', 'Usuń', true))) return; await api('DELETE', '/api/admin/pages/' + el.dataset.slug); closeDlg(); reload(); },
  /* użytkownicy */
  ufilter(el) { uq.filter = el.dataset.f; uq.page = 0; reload(); },
  upage(el) { uq.page = Math.max(0, uq.page + +el.dataset.d); reload(); },
  userOpen(el) { userDlg(usersCache.find((u) => u.id === +el.dataset.id)); },
  async userByNick(el) { const d = await api('GET', '/api/admin/users?q=' + encodeURIComponent(el.dataset.nick)); const u = d.rows.find((x) => x.nick === el.dataset.nick); if (u) { usersCache = d.rows; userDlg(u); } },
  async uact(el) {
    const f = $('form[data-form=uact]'), a = el.dataset.a, id = el.dataset.id;
    if (['ban', 'delete', 'reset_rating', 'logout'].includes(a) && !(await ask({ ban: 'Zablokować to konto?', delete: 'Trwale usunąć konto i zanonimizować jego historię? Tej operacji nie można cofnąć.', reset_rating: 'Wyzerować rankingi gracza?', logout: 'Natychmiast wylogować użytkownika ze wszystkich urządzeń?' }[a], 'Potwierdź', true))) return;
    try { await api('POST', `/api/admin/users/${id}/action`, { action: a, note: val(f, 'note'), hours: val(f, 'hours'), role: val(f, 'role'), password: val(f, 'password') }); closeDlg(); toast('Wykonano'); reload(); } catch (e) { toast(e.message); }
  },
  rstatus(el) { rstatus = el.dataset.s; reload(); },
  async rclose(el) { dlg(`<h3>Zamknij zgłoszenie</h3><form data-form="rclose" data-id="${el.dataset.id}" class="stack"><label class="fld"><span>Decyzja</span><input name="resolution" maxlength="200" placeholder="np. ostrzeżenie, ban 24 h, bezzasadne"></label><div class="cols"><button class="btn" type="button" data-act="close">Anuluj</button><button class="btn pri" type="submit">Zamknij</button></div></form>`); },
  /* turnieje */
  tNew() { tForm({}); }, tEdit(el) { tForm(window._tours.find((t) => t.id === +el.dataset.id)); },
  async tStart(el) { try { await api('POST', `/api/admin/tournaments/${el.dataset.id}/start`); toast('Turniej wystartował'); reload(); } catch (e) { toast(e.message); } },
  async tCancel(el) { if (!(await ask('Odwołać turniej?', 'Odwołaj', true))) return; await api('POST', `/api/admin/tournaments/${el.dataset.id}/cancel`); reload(); },
  tManage(el) { tManage(el.dataset.id).catch((e) => toast(e.message)); },
  async tWin(el) { try { await api('POST', `/api/admin/tournament-matches/${el.dataset.m}/winner`, { uid: +el.dataset.u }); closeDlg(); toast('Zapisano'); reload(); } catch (e) { toast(e.message); } },
  /* ustawienia */
  leagueAdd() { $('#leagueBox').insertAdjacentHTML('beforeend', leagueRow({ n: '', min: 0, color: '#888888' })); },
  leagueDel(el) { el.closest('.league-row').remove(); }
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (fn) fn(el, e);
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.name === 'slot' && t.closest('form[data-form=ad]')) { const z = $('#adSize'); if (z) z.textContent = SLOT_SIZE[t.value] || ''; }
  if (t.dataset.actChange === 'engine') { $('#paramBox').innerHTML = paramsFields(t.value, {}); return; }
  if (t.dataset.upload && t.files && t.files[0]) {
    const f = t.closest('form'), key = t.dataset.upload;
    try {
      toast('Wysyłanie…');
      const isAd = f.dataset.form === 'ad';
      if (isAd && t.files[0].size > 2 * 1024 * 1024) throw new Error('Plik może mieć maksymalnie 2 MB');
      const data = await fileToData(t.files[0]), r = isAd ? await api('POST', '/api/admin/ads/upload', { data, slot: val(f, 'slot') }) : await api('POST', '/api/admin/upload', { data });
      f.elements[key].value = r.url;
      const prev = $('#adPrevImg') || $('#iconPrev'); if (prev) prev.style.backgroundImage = `url('${r.url}')`;
      if (f.dataset.form === 'ad') adPreview();
      toast(r.resized ? `Obraz przycięty i przeskalowany do ${r.width}×${r.height}` : 'Obraz wgrany'); t.value = '';
    } catch (x) { toast(x.message); }
  }
});
document.addEventListener('input', (e) => { if (e.target.closest('form[data-form=ad]')) adPreview(); });
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form, id = f.dataset.id, err = $('#ferr'), btn = f.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    if (kind === 'login') {
      const r = await api('POST', '/api/auth/login', { login: val(f, 'login'), password: val(f, 'password') });
      token = r.token; lsSet(token); await init(); return;
    }
    if (kind === 'usearch') { uq.q = val(f, 'q'); uq.page = 0; reload(); return; }
    if (kind === 'game') {
      const engine = val(f, 'engine'), params = {};
      const eng = enginesCache.find((x) => x.id === engine);
      if (eng) eng.params.forEach((p) => { params[p.key] = p.type === 'bool' ? chk(f, 'p_' + p.key) : val(f, 'p_' + p.key); });
      const body = { name: val(f, 'name'), slug: val(f, 'slug'), icon: val(f, 'icon'), hue: +val(f, 'hue'), category: val(f, 'category'), icon_url: val(f, 'icon_url'), description: val(f, 'description'), rules: val(f, 'rules'),
        engine: engine || null, params, time_sec: Math.round(parseFloat(val(f, 'time_min') || 0) * 60), inc_sec: +val(f, 'inc_sec'), sort: +val(f, 'sort'), rated: chk(f, 'rated'), bots: chk(f, 'bots'), status: val(f, 'status') };
      await api(id ? 'PUT' : 'POST', '/api/admin/games' + (id ? '/' + id : ''), body); closeDlg(); toast('Gra zapisana'); reload();
    } else if (kind === 'ad') {
      const body = { name: val(f, 'name'), advertiser: val(f, 'advertiser'), slot: val(f, 'slot'), kind: val(f, 'kind'), code: val(f, 'code'), title: val(f, 'title'), text: val(f, 'text'), image_url: val(f, 'image_url'), link_url: val(f, 'link_url'), color: +val(f, 'color'), game: val(f, 'game'),
        audience: val(f, 'audience'), device: val(f, 'device'), start: fromLocalInput(val(f, 'start')), end: fromLocalInput(val(f, 'end')), max_per_day: +val(f, 'max_per_day'), weight: +val(f, 'weight'), enabled: chk(f, 'enabled'), budget_note: val(f, 'budget_note'), schedule: val(f, 'schedule'), slide_sec: +val(f, 'slide_sec'), restart: chk(f, 'restart') };
      await api(id ? 'PUT' : 'POST', '/api/admin/ads' + (id ? '/' + id : ''), body); closeDlg(); toast('Reklama zapisana'); reload();
    } else if (kind === 'news') {
      await api(id ? 'PUT' : 'POST', '/api/admin/news' + (id ? '/' + id : ''), { title: val(f, 'title'), body: val(f, 'body'), kind: val(f, 'kind'), pinned: chk(f, 'pinned'), active: chk(f, 'active') }); closeDlg(); reload();
    } else if (kind === 'page') {
      await api('PUT', '/api/admin/pages/' + encodeURIComponent(val(f, 'slug')), { title: val(f, 'title'), body: val(f, 'body') }); closeDlg(); toast('Zapisano'); reload();
    } else if (kind === 'rclose') {
      await api('POST', `/api/admin/reports/${id}/close`, { resolution: val(f, 'resolution') }); closeDlg(); reload();
    } else if (kind === 'tour') {
      const body = { name: val(f, 'name'), game: val(f, 'game'), max_players: +val(f, 'max_players'), start: fromLocalInput(val(f, 'start')), prize: val(f, 'prize'), sponsor: val(f, 'sponsor'), description: val(f, 'description') };
      await api(id ? 'PUT' : 'POST', '/api/admin/tournaments' + (id ? '/' + id : ''), body); closeDlg(); toast('Turniej zapisany'); reload();
    } else if (kind === 'settings') {
      const names = [...f.querySelectorAll('[name=ln]')], mins = [...f.querySelectorAll('[name=lm]')], cols = [...f.querySelectorAll('[name=lc]')];
      const leagues = names.map((n, i) => ({ n: n.value.trim(), min: +mins[i].value || 0, color: cols[i].value })).filter((l) => l.n);
      await api('PUT', '/api/admin/settings', { site_name: val(f, 'site_name'), tagline: val(f, 'tagline'), maintenance_msg: val(f, 'maintenance_msg'), allow_guests: chk(f, 'allow_guests'), allow_register: chk(f, 'allow_register'),
        ads_enabled: chk(f, 'ads_enabled'), maintenance: chk(f, 'maintenance'), default_rating: val(f, 'default_rating'), k_factor: val(f, 'k_factor'), disconnect_grace_sec: val(f, 'disconnect_grace_sec'), leagues: JSON.stringify(leagues),
        bot_autojoin_sec: val(f, 'bot_autojoin_sec'), bot_auto_level: val(f, 'bot_auto_level'), bot_disguise: chk(f, 'bot_disguise'), bot_names: val(f, 'bot_names'),
        forum_enabled: chk(f, 'forum_enabled'), forum_cooldown_sec: val(f, 'forum_cooldown_sec') });
      toast('Ustawienia zapisane');
    }
  } catch (x) { if (err) err.textContent = x.message; else toast(x.message); } finally { if (btn) btn.disabled = false; }
});

init();
