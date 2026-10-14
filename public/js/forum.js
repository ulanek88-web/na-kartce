/* Na kartce — forum w aplikacji (SPA/PWA/APK). Widoki: #/forum, #/forum/b/ID[/strona], #/forum/t/ID[/strona|last],
   #/forum/p/POST, #/forum/u/NICK, #/forum/new/DZIAŁ. Uprawnienia egzekwuje serwer – tu tylko ukrywamy niedostępne przyciski. */
import { api, get, post, del } from './api.js';

const BB = () => window.NKBBCode;
let H = null;                       // zależności z app.js
let cache = { posts: {}, topic: null };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);

export function initForum(deps) { H = deps; }

/* ---------- elementy wspólne ---------- */
const ago = (ts) => { const d = Date.now() - ts; if (d < 60000) return 'przed chwilą'; if (d < 3600000) return Math.floor(d / 60000) + ' min temu'; if (d < 86400000) return Math.floor(d / 3600000) + ' godz. temu'; return H.fmtDate(ts); };
const authorLine = (a) => `<div class="fauthor">${H.avatar(a.nick, a.hue, 'sm')}<div class="grow trunc"><a class="fnick" href="#/forum/u/${encodeURIComponent(a.nick)}">${esc(a.nick)}</a>${a.badge ? ` <span class="tag acc">${esc(a.badge)}</span>` : ''}<div class="muted small">${esc(a.rank)} · ${a.posts} ${a.posts === 1 ? 'post' : 'postów'} · od ${new Date(a.joined).toLocaleDateString('pl-PL', { month: 'short', year: 'numeric' })}</div></div></div>`;
function pager(base, page, pages) {
  if (pages <= 1) return '';
  const nums = []; for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
  let out = '', prev = 0;
  for (const n of nums) { if (prev && n - prev > 1) out += '<span class="muted">…</span>'; out += `<button class="chip ${n === page ? 'on' : ''}" data-go="${base}/${n}">${n}</button>`; prev = n; }
  return `<div class="pager">${out}</div>`;
}
const crumbs = (items) => `<nav class="fcrumbs small">${items.map(([t, h]) => (h ? `<a href="${h}">${esc(t)}</a>` : `<span>${esc(t)}</span>`)).join(' › ')}</nav>`;
function guestBox(me) {
  if (!me) return '';
  if (me.guest) return `<div class="card stack"><b>Czytasz jako gość</b><span class="muted small">Musisz się zarejestrować, aby móc rozmawiać z innymi graczami.</span><button class="btn pri" data-act="auth" data-mode="register">Załóż konto</button></div>`;
  if (!me.canWrite && me.writeMsg) return `<div class="card err">${esc(me.writeMsg)}</div>`;
  return '';
}

/* ---------- edytor BBCode (pasek narzędzi + podgląd) ---------- */
export function composer(id, { placeholder, value, submit, withTitle, titleValue, me }) {
  const dis = me && !me.canWrite;
  const tb = [['b', '<b>B</b>', 'Pogrubienie'], ['i', '<i>I</i>', 'Pochylenie'], ['u', '<u>U</u>', 'Podkreślenie'], ['s', '<s>S</s>', 'Przekreślenie'], ['list', '• Lista', 'Lista'], ['url', '🔗', 'Link'], ['img', '🖼', 'Obrazek'], ['quote', '❝', 'Cytat'], ['code', '&lt;/&gt;', 'Kod']];
  return `<form class="fcomp card stack" data-fform="${esc(id)}">
    ${withTitle ? `<label class="fld"><span>Tytuł tematu</span><input name="title" maxlength="120" required value="${esc(titleValue || '')}" ${dis ? 'readonly' : ''}></label>` : ''}
    <div class="ftb" role="toolbar" aria-label="Formatowanie">${tb.map(([k, l, t]) => `<button type="button" class="btn sm ghost" data-fa="fmt" data-k="${k}" title="${t}" aria-label="${t}">${l}</button>`).join('')}<button type="button" class="btn sm ghost" data-fa="preview">Podgląd</button></div>
    <textarea name="body" rows="6" maxlength="10000" required placeholder="${esc(placeholder || 'Napisz wiadomość…')}" ${dis ? 'readonly' : ''}>${esc(value || '')}</textarea>
    <div class="fprev bbody" hidden></div>
    <p class="err" data-ferr></p>
    <div class="row"><button class="btn pri grow" type="submit">${esc(submit || 'Wyślij')}</button></div>
    ${dis ? `<p class="muted small">${esc(me.writeMsg || '')}</p>` : '<p class="muted small">Formatowanie: BBCode – [b] [i] [u] [s] [url] [img] [quote] [list] [code]. Odstęp między postami: 30 s.</p>'}
  </form>`;
}
function applyFmt(ta, k) {
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  let open = `[${k}]`, close = `[/${k}]`, mid = sel;
  if (k === 'url') { const u = prompt('Adres linku (https://…)'); if (!u) return; open = `[url=${u.trim()}]`; mid = sel || 'tekst linku'; }
  else if (k === 'img') { const u = prompt('Adres obrazka (https://…)'); if (!u) return; open = '[img]'; mid = u.trim(); }
  else if (k === 'list') { open = '[list]\n[*]'; close = '\n[/list]'; mid = sel ? sel.split('\n').join('\n[*]') : 'pozycja'; }
  ta.value = ta.value.slice(0, a) + open + mid + close + ta.value.slice(b);
  const pos = a + open.length + mid.length; ta.focus(); ta.setSelectionRange(pos, pos);
}

/* ---------- INDEKS ---------- */
async function vIndex(v, ok) {
  const d = await get('/api/forum'); if (!ok()) return;
  const lastLine = (l) => (l ? `<span class="muted small trunc">${esc(l.title)} · ${esc(l.nick)} · ${ago(l.ts)}</span>` : '<span class="muted small">Brak tematów</span>');
  v.innerHTML = `${H.pageTitle('Forum')}
    ${guestBox(d.me)}
    ${H.isAdmin() ? '<div class="row"><button class="btn sm" data-fa="manage">⚙ Zarządzaj forum</button><a class="btn sm ghost" target="_blank" rel="noopener" href="' + esc(H.adminUrl()) + '#/forum">Panel CMS</a></div>' : ''}
    ${d.categories.map((c) => `<section class="sec"><div class="sec-h"><h2>${esc(c.title)}</h2></div><div class="card flist">${c.boards.map((b) => `<button class="frow" data-go="#/forum/b/${b.id}">
      <span class="fico">${b.staffOnly ? '📣' : b.game ? '🎮' : '💬'}</span><span class="grow ftxt"><b>${esc(b.title)}</b><br><span class="muted small fdesc">${esc(b.description)}</span><br>${lastLine(b.last)}</span>
      <span class="fcnt num"><b>${b.topics}</b><small>tematów</small></span></button>`).join('')}</div></section>`).join('')}
    ${d.latest.length ? `<section class="sec"><div class="sec-h"><h2>Ostatnia aktywność</h2></div><div class="card flist">${d.latest.map((t) => `<button class="frow" data-go="#/forum/t/${t.id}/last"><span class="grow ftxt"><b>${esc(t.title)}</b><br><span class="muted small">${esc(t.board)} · ${esc(t.nick)} · ${ago(t.ts)}</span></span><span class="fcnt num"><b>${t.replies}</b><small>odp.</small></span></button>`).join('')}</div></section>` : ''}`;
}

/* ---------- DZIAŁ ---------- */
async function vBoard(v, r, ok) {
  const page = Math.max(1, parseInt(r.c, 10) || 1), d = await get('/api/forum/boards/' + encodeURIComponent(r.b) + '?page=' + page); if (!ok()) return;
  const b = d.board;
  v.innerHTML = `${H.pageTitle(b.title, '#/forum')}${crumbs([['Forum', '#/forum'], [b.category, ''], [b.title, '']])}
    ${b.description ? `<p class="muted small">${esc(b.description)}</p>` : ''}
    ${guestBox(d.me)}
    ${d.canCreate ? `<button class="btn pri" data-go="#/forum/new/${b.id}">+ Nowy temat</button>` : (b.staffOnly && d.me.canWrite ? '<div class="card muted small">W tym dziale tematy zakłada tylko administracja – możesz odpowiadać w istniejących.</div>' : '')}
    <div class="card flist">${d.topics.length ? d.topics.map((t) => `<button class="frow ftopic ${t.sticky ? 'sticky' : ''}" data-go="#/forum/t/${t.id}"><span class="fico">${t.sticky ? '📌' : t.locked ? '🔒' : '💬'}</span>
      <span class="grow ftxt"><b>${esc(t.title)}</b> ${t.sticky ? '<span class="tag acc">przyklejony</span>' : ''}${t.locked ? ' <span class="tag">zamknięty</span>' : ''}<br><span class="muted small">${esc(t.author)} · ${H.fmtDate(t.createdAt)} · ostatni: ${esc(t.last.nick)}, ${ago(t.last.ts)}</span></span>
      <span class="fcnt num"><b>${t.replies}</b><small>odp.</small></span></button>`).join('') : '<div class="empty">Brak tematów. Zacznij pierwszy!</div>'}</div>
    ${pager('#/forum/b/' + b.id, d.page, d.pages)}`;
}

/* ---------- TEMAT ---------- */
function postHTML(p, t, d) {
  cache.posts[p.id] = p;
  const acts = [];
  if (d.canReply) acts.push(`<button class="btn sm ghost" data-fa="quote" data-id="${p.id}">❝ Cytuj</button>`);
  if (p.canEdit) acts.push(`<button class="btn sm ghost" data-fa="edit" data-id="${p.id}">Edytuj</button>`);
  if (p.canDelete) acts.push(`<button class="btn sm ghost" data-fa="delpost" data-id="${p.id}" data-first="${p.first ? 1 : 0}">Usuń</button>`);
  if (d.me.signedIn && !d.me.guest && p.author.id !== d.me.id) acts.push(`<button class="btn sm ghost" data-act="report" data-nick="${esc(p.author.nick)}">Zgłoś</button>`);
  return `<article class="fpost card" id="p${p.id}" data-post="${p.id}">${authorLine(p.author)}
    <div class="bbody" data-body>${BB().render(p.body)}</div>
    <div class="fmeta muted small"><a href="#/forum/p/${p.id}" class="muted">#${p.n}</a> · ${H.fmtDate(p.createdAt)}${p.editedAt ? ` · edytowano ${H.fmtDate(p.editedAt)}${p.editedBy ? ' (' + esc(p.editedBy) + ')' : ''}` : ''}</div>
    ${acts.length ? `<div class="fact">${acts.join('')}</div>` : ''}</article>`;
}
async function vTopic(v, r, ok) {
  const q = r.c === 'last' ? 'page=last' : 'page=' + (parseInt(r.c, 10) || 1);
  const d = await get('/api/forum/topics/' + encodeURIComponent(r.b) + '?' + q); if (!ok()) return;
  const t = d.topic; cache.topic = d; cache.posts = {};
  const mod = d.me.staff ? `<div class="card fmod stack"><b class="small">Moderacja tematu</b><div class="row" style="flex-wrap:wrap;gap:6px">
      <button class="btn sm" data-fa="tmod" data-a="${t.sticky ? 'unsticky' : 'sticky'}">${t.sticky ? 'Odklej' : '📌 Przyklej'}</button><button class="btn sm" data-fa="tmod" data-a="${t.locked ? 'unlock' : 'lock'}">${t.locked ? 'Otwórz' : '🔒 Zamknij'}</button>
      <button class="btn sm" data-fa="tmove">Przenieś</button><button class="btn sm bad" data-fa="tdel">Usuń temat</button></div></div>` : '';
  v.innerHTML = `${H.pageTitle(t.title, '#/forum/b/' + t.board.id)}${crumbs([['Forum', '#/forum'], [t.board.title, '#/forum/b/' + t.board.id]])}
    <div class="row" style="flex-wrap:wrap;gap:6px">${t.sticky ? '<span class="tag acc">przyklejony</span>' : ''}${t.locked ? '<span class="tag">zamknięty</span>' : ''}<span class="muted small">${t.posts} ${t.posts === 1 ? 'post' : 'postów'} · ${t.views} wyświetleń</span></div>
    ${mod}${d.posts.map((p) => postHTML(p, t, d)).join('')}${pager('#/forum/t/' + t.id, d.page, d.pages)}
    ${d.canReply ? `<section id="reply">${composer('reply', { placeholder: 'Twoja odpowiedź…', submit: 'Odpowiedz', me: d.me })}</section>` : `<div class="card ${d.me.guest ? '' : 'muted'} small">${esc(d.replyBlock || '')}${d.me.guest ? '<br><br><button class="btn pri" data-act="auth" data-mode="register">Załóż konto</button>' : ''}</div>`}`;
  if (r.c === 'last' || r.fragment) { const el = r.fragment && document.getElementById('p' + r.fragment); if (el) el.scrollIntoView(); }
}

/* ---------- NOWY TEMAT ---------- */
async function vNew(v, r, ok) {
  const d = await get('/api/forum/boards/' + encodeURIComponent(r.b)); if (!ok()) return;
  v.innerHTML = `${H.pageTitle('Nowy temat', '#/forum/b/' + d.board.id)}${crumbs([['Forum', '#/forum'], [d.board.title, '#/forum/b/' + d.board.id]])}${guestBox(d.me)}
    ${d.canCreate ? composer('newtopic', { withTitle: true, placeholder: 'Treść pierwszego posta…', submit: 'Opublikuj temat', me: d.me }) : '<div class="card muted small">Nie możesz zakładać tematów w tym dziale.</div>'}`;
  const f = v.querySelector('form'); if (f) f.dataset.board = d.board.id;
}

/* ---------- PROFIL FORUMOWY ---------- */
async function vUser(v, r, ok) {
  const d = await get('/api/forum/users/' + encodeURIComponent(r.b || '')); if (!ok()) return;
  const u = d.user;
  v.innerHTML = `${H.pageTitle('Profil na forum', 'javascript:history.back()')}
    <div class="hero-p">${H.avatar(u.nick, u.hue, 'lg')}<div class="grow"><h2 style="font-size:26px">${esc(u.nick)}</h2>${u.badge ? `<span class="tag acc">${esc(u.badge)}</span> ` : ''}<span class="tag good">${esc(u.rank)}</span>
      <div class="muted small" style="margin-top:4px">Konto od ${H.fmtDate(u.joined)}</div></div></div>
    <div class="stat-grid"><div><b>${u.posts}</b><small>postów</small></div><div><b>${u.topics}</b><small>tematów</small></div><div><b>${d.warnings ? d.warnings.length : '—'}</b><small>ostrzeżeń</small></div></div>
    ${d.ban ? `<div class="card err">Blokada pisania na forum ${d.ban.until > 0 ? 'do ' + H.fmtDate(d.ban.until) : '(bezterminowo)'}${d.ban.reason ? ': ' + esc(d.ban.reason) : ''}</div>` : ''}
    <div class="row" style="flex-wrap:wrap;gap:6px"><a class="btn sm ghost" href="#/u/${encodeURIComponent(u.nick)}">Profil gracza</a>${d.canSanction ? `<button class="btn sm" data-fa="warn" data-id="${u.id}">Ostrzeż</button><button class="btn sm bad" data-fa="ban" data-id="${u.id}">Zablokuj pisanie</button>${d.ban ? `<button class="btn sm" data-fa="unban" data-id="${u.id}">Zdejmij blokadę</button>` : ''}` : ''}</div>
    ${d.warnings && d.warnings.length ? `<section class="sec"><h2>Ostrzeżenia</h2><div class="card">${d.warnings.map((w) => `<div class="small" style="padding:4px 0">${H.fmtDate(w.ts)} — ${esc(w.reason)}${w.mod ? ' <span class="muted">(' + esc(w.mod) + ')</span>' : ''}</div>`).join('')}</div></section>` : ''}
    <section class="sec"><h2>Ostatnie posty</h2><div class="card flist">${d.recent.length ? d.recent.map((p) => `<button class="frow" data-go="#/forum/p/${p.id}"><span class="grow ftxt"><b>${esc(p.title)}</b><br><span class="muted small">${esc(p.excerpt)}</span></span><span class="muted small">${ago(p.ts)}</span></button>`).join('') : '<div class="empty small">Brak postów.</div>'}</div></section>`;
}

/** Karta „Forum” dołączana do profilu gracza (zwraca HTML; błędy ignorujemy). */
export async function forumCard(nick) {
  try {
    const d = await get('/api/forum/users/' + encodeURIComponent(nick), 8000), u = d.user;
    return `<section class="sec"><div class="sec-h"><h2>Forum</h2><a class="small" href="#/forum/u/${encodeURIComponent(nick)}">Zobacz</a></div><div class="card row">
      <span class="grow"><b>${esc(u.rank)}</b>${u.badge ? ` <span class="tag acc">${esc(u.badge)}</span>` : ''}<br><span class="muted small">${u.posts} postów · ${u.topics} tematów</span></span></div></section>`;
  } catch (e) { return ''; }
}

/* ---------- router widoków ---------- */
export async function vForum(v, r, ok) {
  if (r.a === 'b') return vBoard(v, r, ok);
  if (r.a === 't') return vTopic(v, r, ok);
  if (r.a === 'new') return vNew(v, r, ok);
  if (r.a === 'u') return vUser(v, r, ok);
  if (r.a === 'p') {                              // przekierowanie z numeru posta
    const d = await get('/api/forum/posts/' + encodeURIComponent(r.b));
    if (!ok()) return;
    r.fragment = r.b; r.b = String(d.topicId); r.c = String(d.page);
    return vTopic(v, r, ok);
  }
  return vIndex(v, ok);
}

/* ---------- akcje ---------- */
const ask = (t, danger) => H.confirmBox(t, 'OK', danger);
const fail = (e) => H.toast(e.message);
const FA = {
  fmt(el) { const ta = el.closest('form').querySelector('textarea'); if (!ta.readOnly) applyFmt(ta, el.dataset.k); else H.toast(cache.topic && cache.topic.me.writeMsg || 'Nie możesz pisać na forum'); },
  preview(el) {
    const f = el.closest('form'), box = f.querySelector('.fprev'), on = box.hidden;
    box.hidden = !on; el.textContent = on ? 'Edytuj' : 'Podgląd';
    if (on) box.innerHTML = BB().render(f.querySelector('textarea').value) || '<span class="muted">Nic do pokazania</span>';
  },
  quote(el) {
    const p = cache.posts[el.dataset.id], ta = $('#reply textarea'); if (!p || !ta) return;
    let body = p.body; for (let i = 0; i < 5; i++) body = body.replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, '');
    body = body.trim().slice(0, 400);
    ta.value += (ta.value ? '\n' : '') + `[quote=${p.author.nick};${p.id}]${body}[/quote]\n`;
    ta.focus(); ta.scrollIntoView({ block: 'center' });
  },
  edit(el) {
    const p = cache.posts[el.dataset.id], art = $('#p' + p.id); if (!art) return;
    art.querySelector('[data-body]').outerHTML = `<div data-edit>${composer('edit:' + p.id, { value: p.body, submit: 'Zapisz zmiany', withTitle: p.first, titleValue: cache.topic.topic.title, me: cache.topic.me })}<button class="btn sm ghost" data-fa="canceledit">Anuluj</button></div>`;
  },
  canceledit() { H.reload(); },
  async delpost(el) {
    const first = el.dataset.first === '1';
    if (!(await ask(first ? 'Usunąć cały temat (to jego pierwszy post)?' : 'Usunąć ten post?', true))) return;
    try { const r = await del('/api/forum/posts/' + el.dataset.id); if (r.topicDeleted) location.hash = '#/forum/b/' + r.boardId; else H.reload(); } catch (e) { fail(e); }
  },
  async tmod(el) { try { await post('/api/forum/topics/' + cache.topic.topic.id + '/mod', { action: el.dataset.a }); H.reload(); } catch (e) { fail(e); } },
  async tdel() { if (!(await ask('Usunąć cały temat wraz z postami?', true))) return; try { await post('/api/forum/topics/' + cache.topic.topic.id + '/mod', { action: 'delete' }); location.hash = '#/forum/b/' + cache.topic.topic.board.id; } catch (e) { fail(e); } },
  async tmove() {
    try {
      const list = await get('/api/forum/boards');
      H.sheet(`<h2>Przenieś temat</h2><form data-fform="move" class="stack"><label class="fld"><span>Dział docelowy</span><select name="board">${list.map((b) => `<option value="${b.id}">${esc(b.category)} › ${esc(b.title)}</option>`).join('')}</select></label><button class="btn pri block" type="submit">Przenieś</button></form>`);
    } catch (e) { fail(e); }
  },
  async warn(el) { const reason = prompt('Powód ostrzeżenia:'); if (!reason) return; try { const r = await post('/api/forum/users/' + el.dataset.id + '/warn', { reason }); H.toast('Ostrzeżenie wysłane (łącznie: ' + r.warnings + ')'); H.reload(); } catch (e) { fail(e); } },
  async ban(el) {
    const h = prompt('Na ile godzin zablokować pisanie? (liczba, albo „perm” = bezterminowo)', '24'); if (!h) return;
    const reason = prompt('Powód blokady:') || '';
    try { await post('/api/forum/users/' + el.dataset.id + '/ban', { hours: h.trim() === 'perm' ? 'perm' : parseInt(h, 10) || 24, reason }); H.toast('Blokada nałożona'); H.reload(); } catch (e) { fail(e); }
  },
  async unban(el) { try { await post('/api/forum/users/' + el.dataset.id + '/unban'); H.reload(); } catch (e) { fail(e); } },
  manage() { manage(); }
};
document.addEventListener('click', (e) => { const el = e.target.closest('[data-fa]'); if (el && FA[el.dataset.fa]) { e.preventDefault(); FA[el.dataset.fa](el); } });
/* próba pisania przez gościa: komunikat zamiast edycji */
document.addEventListener('focusin', (e) => { const ta = e.target; if (ta.matches && ta.matches('.fcomp textarea[readonly], .fcomp input[readonly]')) { H.toast((cache.topic && cache.topic.me.writeMsg) || (H.isGuest() ? 'Musisz się zarejestrować, aby móc rozmawiać z innymi graczami' : 'Nie możesz teraz pisać na forum')); } });

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-fform]'); if (!f) return;
  e.preventDefault();
  const kind = f.dataset.fform, d = Object.fromEntries(new FormData(f).entries()), err = f.querySelector('[data-ferr]'), btn = f.querySelector('button[type=submit]');
  if (err) err.textContent = '';
  if (btn) btn.disabled = true;
  try {
    if (kind === 'reply') { const r = await post('/api/forum/topics/' + cache.topic.topic.id + '/posts', { body: d.body }); location.hash = '#/forum/p/' + r.id; }
    else if (kind === 'newtopic') { const r = await post('/api/forum/boards/' + f.dataset.board + '/topics', { title: d.title, body: d.body }); location.hash = '#/forum/t/' + r.id; }
    else if (kind.startsWith('edit:')) { await api('PUT', '/api/forum/posts/' + kind.slice(5), { body: d.body, title: d.title }); H.reload(); }
    else if (kind === 'move') { await post('/api/forum/topics/' + cache.topic.topic.id + '/mod', { action: 'move', board: +d.board }); H.closeSheet(); H.reload(); }
    else if (kind.startsWith('adm:')) await adminSubmit(kind, d);
  } catch (x) { if (err) err.textContent = x.message; H.toast(x.message); } finally { if (btn) btn.disabled = false; }
});

/* ---------- zarządzanie forum w aplikacji (Super Admin) ---------- */
async function manage() {
  try {
    const d = await get('/api/forum/admin/overview');
    H.sheet(`<h2>Zarządzaj forum</h2><p class="muted small">${d.stats.topics} tematów, ${d.stats.posts} postów. Pełny panel (sankcje, dziennik): zakładka „Forum” w /admin.</p>
      ${d.categories.map((c) => `<div class="card stack"><div class="row"><b class="grow trunc">${esc(c.title)}</b><button class="btn sm" data-fa="mv" data-t="category" data-id="${c.id}" data-d="-1">▲</button><button class="btn sm" data-fa="mv" data-t="category" data-id="${c.id}" data-d="1">▼</button><button class="btn sm" data-fa="catedit" data-id="${c.id}" data-title="${esc(c.title)}">Nazwa</button>${c.system && c.title === 'STREFA GIER' ? '' : `<button class="btn sm bad" data-fa="catdel" data-id="${c.id}">✕</button>`}</div>
        ${c.boards.map((b) => `<div class="row small"><span class="grow trunc">${esc(b.title)} <span class="muted">${b.topics} tem.</span>${b.hidden || b.gameOff ? ' <span class="tag">ukryty</span>' : ''}${b.staffOnly ? ' <span class="tag acc">personel</span>' : ''}</span>
          <button class="btn sm" data-fa="mv" data-t="board" data-id="${b.id}" data-d="-1">▲</button><button class="btn sm" data-fa="mv" data-t="board" data-id="${b.id}" data-d="1">▼</button>
          <button class="btn sm" data-fa="bedit" data-id="${b.id}" data-cat="${c.id}" data-title="${esc(b.title)}" data-desc="${esc(b.description)}" data-staff="${b.staffOnly ? 1 : 0}" data-hidden="${b.hidden ? 1 : 0}">Edytuj</button>${b.game ? '' : `<button class="btn sm bad" data-fa="bdel" data-id="${b.id}" data-n="${b.topics}">✕</button>`}</div>`).join('')}
        <button class="btn sm ghost" data-fa="badd" data-cat="${c.id}">+ Dział</button></div>`).join('')}
      <button class="btn block" data-fa="cadd">+ Kategoria</button>
      <div class="card stack"><b>Moderatorzy Forum</b>${d.moderators.map((m) => `<div class="row small"><span class="grow">${esc(m.nick)}</span><button class="btn sm bad" data-fa="modrm" data-id="${m.id}">Odbierz</button></div>`).join('') || '<span class="muted small">Brak.</span>'}
        <form data-fform="adm:mod" class="row"><input class="grow" name="nick" placeholder="nick gracza" maxlength="16" required style="min-height:44px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--surface);font-size:16px"><button class="btn pri sm" type="submit">Nadaj</button></form></div>`);
  } catch (e) { fail(e); }
}
async function adminSubmit(kind, d) { if (kind === 'adm:mod') { await post('/api/forum/admin/moderators', { nick: d.nick }); H.toast('Nadano rolę Moderatora Forum'); manage(); } }
const mAct = async (fn) => { try { await fn(); manage(); } catch (e) { fail(e); } };
Object.assign(FA, {
  mv(el) { return mAct(() => post('/api/forum/admin/reorder', { type: el.dataset.t, id: +el.dataset.id, dir: +el.dataset.d })); },
  cadd() { const t = prompt('Nazwa nowej kategorii:'); if (t) return mAct(() => post('/api/forum/admin/categories', { title: t })); },
  catedit(el) { const t = prompt('Nowa nazwa kategorii:', el.dataset.title); if (t) return mAct(() => api('PUT', '/api/forum/admin/categories/' + el.dataset.id, { title: t })); },
  async catdel(el) { if (!confirm('Usunąć kategorię?')) return; try { await del('/api/forum/admin/categories/' + el.dataset.id); } catch (e) { if (e.status === 409 && confirm(e.message)) await del('/api/forum/admin/categories/' + el.dataset.id + '?force=1').catch(fail); else if (e.status !== 409) fail(e); } manage(); },
  badd(el) { const t = prompt('Nazwa nowego działu:'); if (!t) return; const desc = prompt('Opis działu (opcjonalnie):') || ''; const staff = confirm('Czy tematy mają zakładać tylko administratorzy i moderatorzy?'); return mAct(() => post('/api/forum/admin/boards', { title: t, description: desc, category_id: +el.dataset.cat, staffOnly: staff })); },
  bedit(el) {
    const t = prompt('Nazwa działu:', el.dataset.title); if (!t) return; const desc = prompt('Opis działu:', el.dataset.desc) || '';
    const staff = confirm('Tematy zakłada tylko personel? (OK = tak)'), hid = confirm('Ukryć dział przed graczami? (OK = ukryj)');
    return mAct(() => api('PUT', '/api/forum/admin/boards/' + el.dataset.id, { title: t, description: desc, category_id: +el.dataset.cat, staffOnly: staff, hidden: hid }));
  },
  async bdel(el) { if (!confirm('Usunąć dział' + (+el.dataset.n ? ' wraz z ' + el.dataset.n + ' tematami' : '') + '?')) return; await del('/api/forum/admin/boards/' + el.dataset.id + '?force=1').catch(fail); manage(); },
  modrm(el) { return mAct(() => del('/api/forum/admin/moderators/' + el.dataset.id)); }
});
