/* Na kartce — rozszerzenia aplikacji gracza: ogłoszenia, dodatkowe miejsca reklam, uruchamianie gier-pluginów. */
import { get, post, store } from './api.js';
const sliderTimers = new Map();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => (window.NK_CONFIG && window.NK_CONFIG.apiBase) || '';
const device = () => (matchMedia('(max-width:700px)').matches ? 'mobile' : 'desktop');

/* --- ogłoszenia: pasek u góry lub pop-up; zamknięte pamiętamy lokalnie --- */
async function announcements() {
  let list = []; try { list = await get('/api/announcements'); } catch (e) { return; }
  let seen = []; try { seen = JSON.parse(store.get('ann') || '[]'); } catch (e) { /* ignore */ }
  const fresh = list.filter((a) => !seen.includes(a.id)), dismiss = (id) => { seen.push(id); store.set('ann', JSON.stringify(seen.slice(-50))); };
  let bar = document.getElementById('annbar'); if (bar) bar.remove();
  const bars = fresh.filter((a) => a.style === 'bar');
  if (bars.length) {
    bar = document.createElement('div'); bar.id = 'annbar';
    bar.innerHTML = bars.map((a) => `<div class="ann ${esc(a.level)}"><span><b>${esc(a.title)}</b> ${esc(a.body)}</span><button aria-label="Zamknij" data-id="${a.id}">✕</button></div>`).join('');
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { dismiss(+b.dataset.id); b.parentElement.remove(); } });
    document.body.prepend(bar);
  }
  const pop = fresh.find((a) => a.style === 'popup');
  if (pop && !document.getElementById('annpop')) {
    const d = document.createElement('div'); d.id = 'annpop'; d.className = 'ann-pop';
    d.innerHTML = `<div class="ann-card ${esc(pop.level)}" role="dialog" aria-modal="true"><h2>${esc(pop.title)}</h2><p>${esc(pop.body)}</p><button class="btn pri block">OK</button></div>`;
    d.querySelector('button').onclick = () => { dismiss(pop.id); d.remove(); };
    document.body.appendChild(d);
  }
}

/* --- reklamy: kontenery #ad-top / #ad-sidebar / #ad-footer z index.html wypełniane z GET /api/ads ---
   type 'image_link' -> baner z linkiem (liczymy kliknięcia); type 'script_code' -> iframe sandbox (np. kod AdSense).
   Pozycja „between_games” jest wstawiana przez aplikację między partiami (interstitial). */
function paint(box, ad) {
  if (!ad) { box.hidden = true; box.innerHTML = ''; return; }
  if (ad.type === 'script_code') box.innerHTML = `<iframe title="Reklama" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(ad.content)}"></iframe>`;
  else {
    const src = /^https?:/.test(ad.content) ? ad.content : base() + ad.content, ok = /^https?:\/\//.test(ad.link || '');
    box.innerHTML = `<small>Reklama</small><a href="${esc(ok ? ad.link : '#')}" target="_blank" rel="noopener sponsored">${ad.content ? `<img alt="${esc(ad.title)}" src="${esc(src)}">` : `<span class="adtxt"><b>${esc(ad.title)}</b> ${esc(ad.text)}</span>`}</a>`;
    box.querySelector('a').onclick = () => { post('/api/ads/' + ad.id + '/click').catch(() => {}); };
  }
  box.hidden = false;
}
/* płynny slider: każdy baner ma własny czas wyświetlania (seconds); wyświetlenie liczymy przy każdym pokazie slajdu */
function slider(box, slides) {
  clearTimeout(sliderTimers.get(box));
  if (!slides.length) { paint(box, null); return; }
  let i = 0;
  const show = () => {
    const ad = slides[i];
    paint(box, ad); post('/api/ads/' + ad.id + '/view').catch(() => {});
    box.classList.remove('ad-in'); void box.offsetWidth; box.classList.add('ad-in');       // animacja pojawiania (CSS)
    if (slides.length > 1) sliderTimers.set(box, setTimeout(() => {
      box.classList.add('ad-out');
      setTimeout(() => { box.classList.remove('ad-out'); i = (i + 1) % slides.length; show(); }, 350);
    }, Math.max(2, ad.seconds || 8) * 1000));
  };
  show();
}
async function ads() {
  let r; try { r = await get('/api/ads?slides=1&device=' + device()); } catch (e) { return; }
  document.querySelectorAll('.adslot[data-placement]').forEach((box) => slider(box, (r.slides || {})[box.dataset.placement] || []));
}
export function initExtras() { announcements(); ads(); setInterval(() => { announcements(); ads(); }, 300000); }

/* --- uruchamianie gry-pluginu w pełnoekranowym iframe sandbox (bez dostępu do sesji i sieci) --- */
export function openPlugin(g, user) {
  const layer = document.getElementById('layer'); layer.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'plug';
  wrap.innerHTML = `<div class="plug-bar"><button class="btn sm" data-x>✕ Zamknij</button><b class="grow">${esc(g.name)}</b><button class="btn sm" data-r>↻ Od nowa</button></div><iframe title="${esc(g.name)}" sandbox="allow-scripts" src="${base()}/plugins/${encodeURIComponent(g.plugin)}/index.html"></iframe>`;
  layer.appendChild(wrap);
  const fr = wrap.querySelector('iframe'), send = (cmd, extra) => fr.contentWindow && fr.contentWindow.postMessage(Object.assign({ nk: 'cmd', cmd }, extra), '*');
  let timer;
  const onMsg = (e) => {
    if (e.source !== fr.contentWindow || !e.data) return;
    if (e.data.nk === 'ready') { send('init', { config: g.config || {}, user: { nick: user && user.nick } }); send('start'); }
    else if (e.data.nk === 'event' && e.data.type === 'state' && e.data.payload === 'over') wrap.classList.add('over');
  };
  window.addEventListener('message', onMsg);
  /* zdalna konfiguracja: odświeżamy co minutę bez przeładowania */
  timer = setInterval(async () => { try { const l = await get('/api/games'); const n = l.find((x) => x.slug === g.slug); if (n) send('config', { config: n.config || {} }); } catch (e) { /* offline */ } }, 60000);
  const close = () => { send('destroy'); clearInterval(timer); window.removeEventListener('message', onMsg); layer.innerHTML = ''; };
  wrap.querySelector('[data-x]').onclick = close;
  wrap.querySelector('[data-r]').onclick = () => { wrap.classList.remove('over'); send('reset'); send('start'); };
}
