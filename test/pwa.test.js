'use strict';
/* PWA: manifest i ikony, kompletność powłoki offline, logika Service Workera (co jest, a czego NIE ma być w cache), brak prywatnych danych w cache. */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const PUB = path.join(__dirname, '..', 'public'); let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };
const man = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
assert(man.name && man.short_name && man.start_url === '/' && man.scope === '/' && man.display === 'standalone' && man.theme_color && man.background_color && man.id);
const png = (f) => { const b = fs.readFileSync(path.join(PUB, f)); assert.strictEqual(b.toString('latin1', 1, 4), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
for (const i of man.icons) { const [w, h] = png(i.src); assert.strictEqual(w + 'x' + h, i.sizes, i.src); }
assert(man.icons.some((i) => i.sizes === '192x192') && man.icons.some((i) => i.sizes === '512x512') && man.icons.some((i) => /maskable/.test(i.purpose || ''))); ok('manifest kompletny; ikony 192/512 i maskable mają deklarowane rozmiary');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'); assert(/rel="manifest"/.test(html) && /apple-touch-icon/.test(html) && /viewport/.test(html) && /theme-color/.test(html)); ok('index.html: manifest, apple-touch-icon, viewport, theme-color');
const swSrc = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'), shell = JSON.parse(/const SHELL = (\[[^\]]*\])/.exec(swSrc)[1].replace(/'/g, '"'));
const served = (u) => (u === '/' ? 'index.html' : u.startsWith('/shared/') ? '../shared/' + u.slice(8) : u.slice(1));
for (const u of shell) assert(fs.existsSync(path.join(PUB, served(u))), 'brak pliku powłoki: ' + u);
const imports = [...fs.readFileSync(path.join(PUB, 'js/app.js'), 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => '/js/' + m[1]);
for (const u of imports) assert(shell.includes(u), 'moduł importowany przez app.js nie jest w powłoce offline: ' + u);
for (const u of ['/js/offline-worker.js', '/shared/engines.js', '/shared/bbcode.js']) assert(shell.includes(u), u); ok('powłoka offline zawiera wszystkie pliki (' + shell.length + '), w tym moduły importowane przez app.js, silniki gier i worker trybu offline');

/* symulacja Service Workera */
function sandbox() {
  const listeners = {}, store = new Map(), puts = [];
  const caches = { open: async () => ({ addAll: async () => {}, put: async (r, res) => { puts.push(r.url); store.set(r.url, res); } }), match: async (r) => store.get(typeof r === 'string' ? 'https://x.pl' + r : r.url), keys: async () => [], delete: async () => true };
  const ctx = { self: { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} } }, location: { origin: 'https://x.pl' }, caches, URL, Response, fetch: null };
  vm.createContext(ctx); vm.runInContext(swSrc, ctx); return { ctx, listeners, store, puts };
}
async function fire(sb, url, { method = 'GET', mode = 'cors', net }) {
  let responded = null; sb.ctx.fetch = net;
  sb.listeners.fetch({ request: { url, method, mode }, respondWith: (p) => { responded = p; } });
  return responded ? { handled: true, res: await responded } : { handled: false };
}
(async () => {
  const sb = sandbox(), good = () => { const r = new Response('ok', { status: 200 }); Object.defineProperty(r, 'type', { value: 'basic' }); return Promise.resolve(r); }, down = () => Promise.reject(new Error('offline'));
  for (const u of ['/api/me', '/api/forum', '/ws', '/admin/', '/admin/admin.js', '/uploads/a.png', '/plugins/x/index.html', '/health']) assert(!(await fire(sb, 'https://x.pl' + u, { net: good })).handled, 'SW przechwycił ' + u);
  assert(!(await fire(sb, 'https://x.pl/api/me', { method: 'POST', net: good })).handled); assert(!(await fire(sb, 'https://cdn.evil.com/x.js', { net: good })).handled); ok('Service Worker nie dotyka API, WebSocketu, panelu admina, uploadów, pluginów, healthchecka, żądań innych domen ani metod innych niż GET');
  await fire(sb, 'https://x.pl/js/app.js', { net: good }); await new Promise((r) => setTimeout(r, 10)); assert(sb.puts.includes('https://x.pl/js/app.js'));
  await fire(sb, 'https://x.pl/js/err.js', { net: () => Promise.resolve(new Response('x', { status: 500 })) }); await new Promise((r) => setTimeout(r, 10)); assert(!sb.puts.includes('https://x.pl/js/err.js')); ok('do cache trafiają tylko poprawne (2xx) odpowiedzi własnej domeny');
  sb.store.set('https://x.pl/', new Response('<html>shell</html>')); sb.store.set('https://x.pl/js/app.js', new Response('code'));
  const nav = await fire(sb, 'https://x.pl/forum/abc', { mode: 'navigate', net: down }); assert.strictEqual(await nav.res.text(), '<html>shell</html>');
  const js = await fire(sb, 'https://x.pl/js/app.js', { net: down }); assert.strictEqual(await js.res.text(), 'code');
  const miss = await fire(sb, 'https://x.pl/js/nie-ma.js', { net: down }); assert.strictEqual(miss.res.status, 503); assert(!(await miss.res.text()).includes('<html')); ok('offline: nawigacja dostaje powłokę aplikacji, pliki z cache działają, brakujący skrypt dostaje 503 (a nie stronę HTML udającą skrypt)');
  const fresh = await fire(sb, 'https://x.pl/js/app.js', { net: () => { const r = new Response('NOWY KOD'); Object.defineProperty(r, 'type', { value: 'basic' }); return Promise.resolve(r); } }); assert.strictEqual(await fresh.res.text(), 'NOWY KOD'); ok('online: sieć ma pierwszeństwo – po wdrożeniu użytkownik dostaje nowy kod, nie stary z cache');
  assert(/skipWaiting/.test(swSrc) && /clients\.claim/.test(swSrc) && /caches\.delete/.test(swSrc)); ok('nowa wersja SW przejmuje kontrolę od razu i czyści stare cache');
  console.log('\nOK: ' + n + ' testów PWA'); process.exit(0);
})().catch((e) => { console.error('BŁĄD TESTU:', e); process.exit(1); });
