'use strict';
/* Moduł pluginów-gier i ogłoszeń.
 *  - instalacja gry z ZIP (base64) lub z kodu (manifest + html/js/css), bez zewnętrznych bibliotek
 *  - pliki w data/plugins/<slug>/, serwowane pod /plugins/<slug>/ z restrykcyjnym CSP (sandbox, brak sieci)
 *  - układ gier (kolejność + widoczność), konfiguracja zdalna, ogłoszenia
 * Plugin to strona HTML ładowana w <iframe sandbox>; komunikuje się z aplikacją przez postMessage (public/plugin-sdk.js). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const D = require('./db');
const A = require('./auth');
const { HttpError } = require('./http');

const PLUGINS = path.join(D.DATA_DIR, 'plugins');
fs.mkdirSync(PLUGINS, { recursive: true, mode: 0o700 });
const LIM = { zip: 6e6, file: 3e6, total: 12e6, files: 200 };
const EXT = /\.(html|js|css|json|png|jpe?g|gif|webp|svg|mp3|ogg|wav|woff2?|txt)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

/* ---------- minimalny czytnik ZIP (metody 0 i 8) ---------- */
/** Bezpieczny odczyt ZIP: każdy błąd formatu (zły offset, ucięty plik, bomba kompresji) kończy się HttpError 400/413, nigdy wyjątkiem. */
function readZip(buf) {
  try { return readZipUnsafe(buf); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Uszkodzone lub nieobsługiwane archiwum ZIP');
  }
}
function readZipUnsafe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new HttpError(400, 'To nie jest poprawny plik ZIP');
  if (buf.length > LIM.zip) throw new HttpError(413, 'Archiwum jest za duże (limit 6 MB)');
  let e = buf.length - 22;
  for (; e >= Math.max(0, buf.length - 65557); e--) if (buf.readUInt32LE(e) === 0x06054b50) break;
  if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) throw new HttpError(400, 'To nie jest poprawny plik ZIP');
  const n = buf.readUInt16LE(e + 10); let off = buf.readUInt32LE(e + 16), total = 0;
  if (n > LIM.files) throw new HttpError(400, 'Zbyt wiele plików w archiwum (limit ' + LIM.files + ')');
  const out = new Map(), seen = new Set();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new HttpError(400, 'Uszkodzone archiwum ZIP');
    const flags = buf.readUInt16LE(off + 8), method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nl).replace(/\\/g, '/'); off += 46 + nl + el + cl;
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (name.length > 150 || name.split('/').length > 8) throw new HttpError(400, 'Zbyt długa lub zbyt głęboka ścieżka: ' + name.slice(0, 40));
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new HttpError(400, 'Uszkodzony nagłówek pliku ' + name);
    if (flags & 1) throw new HttpError(400, 'Archiwum nie może być zaszyfrowane');
    if (usize > LIM.file) throw new HttpError(413, 'Plik ' + name + ' jest za duży');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new HttpError(400, 'Ucięte archiwum (plik ' + name + ')');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: LIM.file }); } catch (x) { throw new HttpError(400, 'Nie udało się rozpakować pliku ' + name); } }
    else throw new HttpError(400, 'Nieobsługiwana kompresja ZIP');
    /* limity liczone na faktycznie rozpakowanych danych (nagłówek ZIP może kłamać – „zip bomb”) */
    if (data.length !== usize) throw new HttpError(400, 'Rozmiar pliku ' + name + ' nie zgadza się z nagłówkiem');
    if ((total += data.length) > LIM.total) throw new HttpError(413, 'Rozpakowane pliki są za duże (limit 12 MB)');
    const lc = name.toLowerCase(); if (seen.has(lc)) throw new HttpError(400, 'Powtórzona nazwa pliku: ' + name); seen.add(lc);
    out.set(name, data);
  }
  return out;
}

/* ---------- walidacja i instalacja ---------- */
const safeName = (n) => n.split('/').every((s) => s && s !== '.' && s !== '..' && !s.startsWith('.') && /^[\w.\- ()]+$/u.test(s));
const strv = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** Manifest: { slug, name, version?, icon?, hue?, category?, description?, rules?, entry?='index.html', config?{} } */
function cleanManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new HttpError(400, 'Manifest musi być obiektem JSON');
  for (const k of ['slug', 'name', 'entry', 'version', 'icon', 'category', 'description', 'rules']) if (m[k] != null && typeof m[k] !== 'string') throw new HttpError(400, 'Manifest: pole „' + k + '” musi być tekstem');
  if (m.hue != null && !Number.isFinite(Number(m.hue))) throw new HttpError(400, 'Manifest: „hue” musi być liczbą 0–359');
  if (m.config != null && (typeof m.config !== 'object' || Array.isArray(m.config) || JSON.stringify(m.config).length > 8000)) throw new HttpError(400, 'Manifest: „config” musi być obiektem JSON do 8 KB');
  const slug = strv(m.slug, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw new HttpError(400, 'Manifest: slug 3–40 znaków (a–z, 0–9, myślnik)');
  const name = strv(m.name, 60); if (!name) throw new HttpError(400, 'Manifest: brak nazwy gry');
  const entry = strv(m.entry || 'index.html', 120);
  if (!safeName(entry) || !/\.html$/i.test(entry)) throw new HttpError(400, 'Manifest: entry musi wskazywać plik .html');
  return { slug, name, entry, version: strv(m.version || '1.0.0', 20), icon: strv(m.icon || '🎮', 4), hue: ((parseInt(m.hue, 10) || 200) % 360 + 360) % 360,
    category: strv(m.category || 'Pluginy', 30), description: strv(m.description, 240), rules: strv(m.rules, 4000),
    config: m.config && typeof m.config === 'object' && !Array.isArray(m.config) ? m.config : {} };
}

function install(files) {
  if (!files.has('manifest.json')) { // archiwum z jednym folderem nadrzędnym
    const tops = new Set(Array.from(files.keys()).map((k) => k.split('/')[0]));
    if (tops.size === 1) { const p = Array.from(tops)[0] + '/'; const f2 = new Map(); for (const [k, v] of files) f2.set(k.slice(p.length), v); files = f2; }
  }
  if (!files.has('manifest.json')) throw new HttpError(400, 'W archiwum brakuje pliku manifest.json');
  if (files.get('manifest.json').length > 50000) throw new HttpError(400, 'manifest.json jest za duży (limit 50 KB)');
  let man; try { man = cleanManifest(JSON.parse(files.get('manifest.json').toString('utf8'))); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'manifest.json nie jest poprawnym JSON-em'); }
  if (!files.has(man.entry)) throw new HttpError(400, 'Brak pliku startowego: ' + man.entry);
  for (const k of files.keys()) if (!safeName(k) || !EXT.test(k)) throw new HttpError(400, 'Niedozwolony plik w archiwum: ' + k);
  const ex = D.get('SELECT id, plugin FROM games WHERE slug=?', man.slug);
  if (ex && !ex.plugin) throw new HttpError(409, 'Slug „' + man.slug + '” jest zajęty przez wbudowaną grę');
  /* instalacja atomowa: zapis do katalogu tymczasowego -> podmiana -> zapis w bazie; przy błędzie stan wraca do poprzedniego */
  const tmp = path.join(PLUGINS, '.tmp-' + man.slug + '-' + Date.now()), dest = path.join(PLUGINS, man.slug), old = dest + '.old-' + Date.now();
  let moved = false;
  try {
    for (const [k, v] of files) { const f = path.join(tmp, k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
    if (fs.existsSync(dest)) { fs.renameSync(dest, old); moved = true; }
    fs.renameSync(tmp, dest);
    D.tx(() => {
      if (ex) {
        D.run('UPDATE games SET name=?,icon=?,hue=?,category=?,description=?,rules=?,plugin_version=?,cfg=? WHERE id=?',
          man.name, man.icon, man.hue, man.category, man.description, man.rules, man.version, JSON.stringify(man.config), ex.id);
      } else { // nowa gra startuje jako ukryta – włączysz ją w Układzie gier
        const sort = (D.get('SELECT MAX(sort) AS m FROM games').m || 0) + 10;
        D.run("INSERT INTO games(slug,name,icon,hue,category,description,rules,engine,params,status,rated,bots,sort,plugin,plugin_version,cfg,created_at) VALUES(?,?,?,?,?,?,?,NULL,'{}','hidden',0,0,?,?,?,?,?)",
          man.slug, man.name, man.icon, man.hue, man.category, man.description, man.rules, sort, man.slug, man.version, JSON.stringify(man.config), D.now());
      }
    });
    if (moved) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    console.error('Instalacja pluginu nieudana:', man.slug, e.message);
    try { fs.rmSync(tmp, { recursive: true, force: true }); if (moved) { fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(old, dest); } } catch (x) { /* best effort */ }
    throw e instanceof HttpError ? e : new HttpError(500, 'Nie udało się zainstalować pluginu (poprzednia wersja pozostała bez zmian)');
  }
  return { slug: man.slug, name: man.name, version: man.version, entry: man.entry, updated: !!ex };
}

/* ---------- serwowanie /plugins/<slug>/... ---------- */
const PLUGIN_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self' https://localhost capacitor://localhost" + (process.env.ALLOWED_ORIGINS ? ' ' + process.env.ALLOWED_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean).join(' ') : '');
function serve(req, res, p) {
  let rel; try { rel = decodeURIComponent(p.slice('/plugins/'.length)); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  const seg = rel.split('/'), slug = seg.shift();
  const g = /^[a-z0-9-]{3,40}$/.test(slug) && D.get("SELECT status,plugin FROM games WHERE slug=? AND plugin IS NOT NULL", slug);
  const sub = seg.join('/') || 'index.html';
  const f = path.join(PLUGINS, slug || '_', sub);
  const ok = g && g.status !== 'off' && safeName(sub) && f.startsWith(path.join(PLUGINS, slug) + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile();
  if (!ok) { res.writeHead(404); return res.end(); }
  res.removeHeader('X-Frame-Options'); // dostęp w <iframe> kontroluje frame-ancestors z CSP poniżej
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Security-Policy': PLUGIN_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}


/* ---------- wtyczki dołączone do portalu (katalog plugins-bundled/<slug>/) ----------
 * Przy starcie instalujemy każdą, której jeszcze nie ma w bazie, i od razu ją włączamy.
 * Istniejących wtyczek NIE nadpisujemy (administrator mógł zmienić konfigurację, układ albo ukryć grę). */
function installBundled(dir) {
  dir = dir || path.join(__dirname, '..', 'plugins-bundled');
  const done = [];
  if (!fs.existsSync(dir)) return done;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const files = new Map(), root = path.join(dir, e.name);
      (function walk(d, pre) { for (const x of fs.readdirSync(d, { withFileTypes: true })) { if (x.isDirectory()) walk(path.join(d, x.name), pre + x.name + '/'); else files.set(pre + x.name, fs.readFileSync(path.join(d, x.name))); } })(root, '');
      if (!files.has('manifest.json')) continue;
      const slug = String(JSON.parse(files.get('manifest.json').toString('utf8')).slug || '').toLowerCase();
      if (D.get('SELECT id FROM games WHERE slug=?', slug)) continue;
      install(files);
      D.run("UPDATE games SET status='active' WHERE slug=? AND plugin IS NOT NULL", slug);
      done.push(slug);
    } catch (err) { console.error('Wtyczka dołączona „' + e.name + '” nie została zainstalowana:', err.message); }
  }
  return done;
}

/* ---------- API ---------- */
const int = (v, d) => { v = parseInt(v, 10); return isNaN(v) ? d : v; };
function register(r) {
  const admin = (req) => A.requireRole(req, 'admin');
  const announce = (req) => A.requireCap(req, 'announce');

  // pluginy
  r.get('/api/admin/plugins', (req) => { admin(req); return D.all('SELECT id,slug,name,icon,status,plugin,plugin_version FROM games WHERE plugin IS NOT NULL ORDER BY sort,id'); });
  r.post('/api/admin/plugins', (req, res, p, body) => {
    admin(req);
    if (body.zip != null) {
      if (typeof body.zip !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(body.zip)) throw new HttpError(400, 'Pole „zip” musi zawierać archiwum zakodowane w base64');
      return install(readZip(Buffer.from(body.zip, 'base64')));
    }
    // tryb „kod”: manifest + html (+ js, css)
    const man = cleanManifest(typeof body.manifest === 'string' ? (() => { try { return JSON.parse(body.manifest); } catch (e) { throw new HttpError(400, 'Manifest nie jest poprawnym JSON-em'); } })() : body.manifest);
    const files = new Map(), put = (n, s) => { s = String(s == null ? '' : s); if (Buffer.byteLength(s) > LIM.file) throw new HttpError(413, 'Plik ' + n + ' jest za duży'); files.set(n, Buffer.from(s)); };
    put('manifest.json', JSON.stringify(man));
    let html = String(body.html || ''); if (!html.trim()) throw new HttpError(400, 'Podaj kod HTML gry');
    if (body.css) { put('game.css', body.css); if (!/game\.css/.test(html)) html = html.replace(/<\/head>|$/i, '<link rel="stylesheet" href="game.css">$&'); }
    if (body.js) { put('game.js', body.js); if (!/game\.js/.test(html)) html = html.replace(/<\/body>|$/i, '<script src="game.js"></script>$&'); }
    put(man.entry, html);
    return install(files);
  });
  r.delete('/api/admin/plugins/:slug', (req, res, p) => {
    admin(req);
    const g = D.get('SELECT id FROM games WHERE slug=? AND plugin IS NOT NULL', p.slug);
    if (!g) throw new HttpError(404, 'Nie ma takiego pluginu');
    D.run('DELETE FROM games WHERE id=?', g.id);
    fs.rmSync(path.join(PLUGINS, p.slug.replace(/[^a-z0-9-]/g, '')), { recursive: true, force: true });
    return { ok: true };
  });

  // układ gier: kolejność + widoczność + konfiguracja zdalna
  r.get('/api/admin/layout', (req) => { admin(req); return D.all('SELECT id,slug,name,icon,status,plugin,cfg FROM games ORDER BY sort,id').map((g) => ({ id: g.id, slug: g.slug, name: g.name, icon: g.icon, status: g.status, plugin: !!g.plugin, visible: g.status !== 'hidden' && g.status !== 'off', config: g.cfg })); });
  r.put('/api/admin/layout', (req, res, p, body) => {
    admin(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    D.tx(() => items.forEach((it, i) => {
      const g = D.get('SELECT id,status,engine,plugin FROM games WHERE id=?', int(it.id, 0)); if (!g) return;
      let st = g.status;
      if (it.visible) { if (st === 'hidden') st = (g.engine || g.plugin) ? 'active' : 'soon'; } else st = 'hidden';
      D.run('UPDATE games SET sort=?, status=? WHERE id=?', (i + 1) * 10, st, g.id);
    }));
    return { ok: true };
  });
  r.put('/api/admin/layout/:id/config', (req, res, p, body) => {
    admin(req);
    const cfg = body.config; if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new HttpError(400, 'Konfiguracja musi być obiektem JSON');
    const s = JSON.stringify(cfg); if (s.length > 8000) throw new HttpError(400, 'Konfiguracja jest za duża');
    if (!D.run('UPDATE games SET cfg=? WHERE id=?', s, int(p.id, 0)).changes) throw new HttpError(404, 'Nie ma takiej gry');
    return { ok: true };
  });

  // ogłoszenia
  const ann = (a) => ({ id: a.id, title: a.title, body: a.body, style: a.style, level: a.level, active: !!a.active, start: a.start_at, end: a.end_at });
  const clean = (b) => {
    const title = strv(b.title, 120); if (!title) throw new HttpError(400, 'Podaj tytuł ogłoszenia');
    const t = (v) => { const x = new Date(v).getTime(); return v && !isNaN(x) ? x : 0; };
    return { title, body: strv(b.body, 1000), style: b.style === 'popup' ? 'popup' : 'bar', level: ['info', 'warn', 'good'].includes(b.level) ? b.level : 'info', active: b.active === false || b.active === 0 || b.active === 'false' ? 0 : 1, start: t(b.start), end: t(b.end) };
  };
  r.get('/api/admin/announcements', (req) => { announce(req); return D.all('SELECT * FROM announcements ORDER BY id DESC').map(ann); });
  r.post('/api/admin/announcements', (req, res, p, b) => { announce(req); const a = clean(b); return { id: D.run('INSERT INTO announcements(title,body,style,level,active,start_at,end_at,created_at) VALUES(?,?,?,?,?,?,?,?)', a.title, a.body, a.style, a.level, a.active, a.start, a.end, D.now()).id }; });
  r.put('/api/admin/announcements/:id', (req, res, p, b) => { announce(req); const a = clean(b); D.run('UPDATE announcements SET title=?,body=?,style=?,level=?,active=?,start_at=?,end_at=? WHERE id=?', a.title, a.body, a.style, a.level, a.active, a.start, a.end, int(p.id, 0)); return { ok: true }; });
  r.delete('/api/admin/announcements/:id', (req, res, p) => { announce(req); D.run('DELETE FROM announcements WHERE id=?', int(p.id, 0)); return { ok: true }; });
  r.get('/api/announcements', () => { const n = D.now(); return D.all('SELECT * FROM announcements WHERE active=1 AND (start_at=0 OR start_at<=?) AND (end_at=0 OR end_at>=?) ORDER BY id DESC LIMIT 5', n, n).map(ann); });
}
module.exports = { register, serve, install, readZip, installBundled };
