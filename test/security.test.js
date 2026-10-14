'use strict';
/* Testy bezpieczeństwa: uwierzytelnianie, sesje, autoryzacja każdego endpointu administracyjnego, IDOR, WebSocket (Origin, flood, fragmenty),
   ZIP/pluginy, path traversal, limity ładunków. Wszystko na tymczasowej bazie – nigdy na produkcyjnej. */
const os = require('os'), fs = require('fs'), path = require('path'), net = require('net'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nakartce-sec-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest123';
process.env.RATE_REG_MAX = '200';
delete process.env.TRUST_PROXY;
const D = require('../server/db'), A = require('../server/auth');
const { create } = require('../server/index');
const Z = require('../server/zipwrite');
D.ensureAdmin(A.hashPassword);
const server = create();
let base, port, passed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, token, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}), body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch (e) { /* nie JSON */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const reg = async (nick, pw) => (await api('POST', '/api/auth/register', { nick, email: nick.toLowerCase() + '@example.com', password: pw || 'haslo1234' })).body;

/* ---- surowy klient WebSocket (pełna kontrola nad nagłówkami i ramkami) ---- */
function rawWS(token, { origin, hostHeader } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const st = { s, status: 0, msgs: [], closeCode: null, closed: false, buf: Buffer.alloc(0), hs: false };
    s.on('connect', () => s.write('GET /ws?token=' + encodeURIComponent(token) + ' HTTP/1.1\r\nHost: ' + (hostHeader || '127.0.0.1:' + port) + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' + (origin ? 'Origin: ' + origin + '\r\n' : '') + '\r\n'));
    s.on('data', (d) => {
      st.buf = Buffer.concat([st.buf, d]);
      if (!st.hs) { const i = st.buf.indexOf('\r\n\r\n'); if (i < 0) return; st.status = parseInt(st.buf.toString('latin1', 9, 12), 10); st.buf = st.buf.subarray(i + 4); st.hs = true; resolve(st); }
      for (;;) {
        const b = st.buf; if (b.length < 2) break;
        let len = b[1] & 0x7f, off = 2; if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; } else if (len === 127) break;
        if (b.length < off + len) break;
        const op = b[0] & 0x0f, pl = b.subarray(off, off + len); st.buf = b.subarray(off + len);
        if (op === 1) { try { st.msgs.push(JSON.parse(pl.toString())); } catch (e) { /* ignore */ } } else if (op === 8) st.closeCode = pl.length >= 2 ? pl.readUInt16BE(0) : 1005;
      }
    });
    s.on('close', () => { st.closed = true; if (!st.hs) resolve(st); });
    s.on('error', () => {});
  });
}
function frame({ op = 1, payload = Buffer.alloc(0), fin = true, mask = true, rsv = 0 }) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | op, (mask ? 0x80 : 0) | len]);
  else { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | (rsv << 4) | op; head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(len, 2); }
  if (!mask) return Buffer.concat([head, payload]);
  const m = Buffer.from([1, 2, 3, 4]), p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
  return Buffer.concat([head, m, p]);
}
const text = (o, opt) => frame(Object.assign({ payload: Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)) }, opt));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port; base = 'http://127.0.0.1:' + port;
  const admin = (await api('POST', '/api/auth/login', { login: 'admin', password: 'AdminTest123' })).body;
  const ala = await reg('Ala'), olek = await reg('Olek');

  console.log('Uwierzytelnianie i sesje');
  let r;
  /* blokada pojedynczego konta niezależnie od IP (credential stuffing z wielu adresów) – TRUST_PROXY=2 symuluje różne adresy */
  process.env.TRUST_PROXY = '1';
  let st429 = 0; for (let i = 0; i < 10; i++) { r = await api('POST', '/api/auth/login', { login: 'olek', password: 'zle-haslo-' + i }, null, { 'X-Forwarded-For': '172.16.0.' + i }); if (r.status === 429) st429++; }
  assert(st429 >= 2, 'brak blokady konta: ' + st429); ok('po 8 nieudanych próbach konto jest blokowane przed zgadywaniem hasła, nawet z różnych IP');
  r = await api('POST', '/api/auth/login', { login: 'olek', password: 'haslo1234' }, null, { 'X-Forwarded-For': '172.16.9.9' }); assert.strictEqual(r.status, 429); ok('w czasie blokady nawet poprawne hasło jest odrzucone (429)');
  delete process.env.TRUST_PROXY;
  r = await api('POST', '/api/auth/register', { nick: 'Dlugie', email: 'dl@example.com', password: 'a'.repeat(201) }); assert.strictEqual(r.status, 400); ok('limit długości hasła (ochrona przed kosztownym haszowaniem)');
  r = await api('POST', '/api/auth/login', '{"login": ', null); assert.strictEqual(r.status, 400); assert(!/at |\.js|\/home/.test(r.text)); ok('błędny JSON: 400 bez ujawniania ścieżek i stack trace');

  /* sesje: zmiana hasła i wylogowanie unieważniają tokeny */
  const zofia = await reg('Zofia', 'stare-haslo-1'), T1 = zofia.token;
  assert.strictEqual((await api('GET', '/api/me', null, T1)).status, 200);
  const w1 = await rawWS(T1); assert.strictEqual(w1.status, 101);
  r = await api('POST', '/api/me/password', { old: 'zle', password: 'nowe-haslo-123' }, T1); assert.strictEqual(r.status, 403);
  r = await api('POST', '/api/me/password', { old: 'stare-haslo-1', password: 'nowe-haslo-123' }, T1); assert.strictEqual(r.status, 200); const T2 = r.body.token;
  assert.strictEqual((await api('GET', '/api/me', null, T1)).status, 401); assert.strictEqual((await api('GET', '/api/me', null, T2)).status, 200); ok('zmiana hasła unieważnia stare tokeny, nowy token działa');
  await sleep(300); assert(w1.msgs.some((m) => m.fatal) || w1.closed); ok('zmiana hasła rozłącza otwarte połączenia WebSocket');
  assert.strictEqual((await api('POST', '/api/auth/login', { login: 'zofia', password: 'stare-haslo-1' })).status, 401); ok('stare hasło przestaje działać');
  /* limit prób na IP nie może dać się ominąć podrobionym X-Forwarded-For */
  let blocked = 0; for (let i = 0; i < 26; i++) { r = await api('POST', '/api/auth/login', { login: 'nikt' + i, password: 'x' }, null, { 'X-Forwarded-For': '10.0.0.' + i }); if (r.status === 429) blocked++; }
  assert(blocked >= 5, 'XFF omija limit: zablokowano ' + blocked); ok('podrobiony X-Forwarded-For nie omija limitu prób logowania (' + blocked + ' z 26 zablokowanych)');
  A.rateLimit.__reset && A.rateLimit.__reset();
  const hitsReset = () => { /* limity są w pamięci procesu – restart nie jest potrzebny, kolejne testy używają innych kluczy */ };

  r = await api('POST', '/api/auth/logout', {}, T2); assert.strictEqual(r.status, 200); assert.strictEqual((await api('GET', '/api/me', null, T2)).status, 401); ok('wylogowanie unieważnia token po stronie serwera');
  const tampered = T2.split('.')[0] + '.' + 'A'.repeat(43); assert.strictEqual((await api('GET', '/api/me', null, tampered)).status, 401);
  const forged = Buffer.from(JSON.stringify({ u: 1, e: Date.now() + 1e9, v: 0 })).toString('base64url') + '.x'; assert.strictEqual((await api('GET', '/api/admin/me', null, forged)).status, 401); ok('sfałszowany i zmodyfikowany token jest odrzucany');
  r = await api('POST', '/api/admin/users/' + ala.me.id + '/action', { action: 'ban', hours: 1 }, admin.token); assert.strictEqual((await api('GET', '/api/me', null, ala.token)).status, 403);
  await api('POST', '/api/admin/users/' + ala.me.id + '/action', { action: 'unban' }, admin.token); ok('zablokowane konto traci dostęp natychmiast');

  console.log('Autoryzacja endpointów');
  const src = ['admin.js', 'plugins.js', 'forum.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8')).join('\n');
  const routes = [...src.matchAll(/r\.(get|post|put|delete)\('(\/api\/(?:admin|forum\/admin)[^']*)'/g)].map((m) => [m[1].toUpperCase(), m[2]]);
  routes.push(['POST', '/api/forum/topics/:id/mod'], ['POST', '/api/forum/users/:id/warn'], ['POST', '/api/forum/users/:id/ban'], ['POST', '/api/forum/users/:id/unban'], ['GET', '/api/forum/boards'], ['DELETE', '/api/forum/posts/:id']);
  assert(routes.length > 60, 'za mało tras: ' + routes.length);
  let bad = [];
  for (const [m, p] of routes) {
    const url = p.replace(/:\w+/g, '1');
    const a1 = await api(m, url, m === 'GET' || m === 'DELETE' ? undefined : {}), a2 = await api(m, url, m === 'GET' || m === 'DELETE' ? undefined : {}, olek.token || ala.token);
    if (a1.status !== 401) bad.push('anon ' + m + ' ' + p + ' -> ' + a1.status);
    if (a2.status !== 403) bad.push('user ' + m + ' ' + p + ' -> ' + a2.status);
  }
  assert.deepStrictEqual(bad, []); ok('każda z ' + routes.length + ' tras administracyjnych i moderacyjnych: anonim 401, zwykły gracz 403');
  /* moderator (rola mod) nie wejdzie do sekcji tylko dla Super Admina */
  const mod = await reg('Modek'); await api('POST', '/api/admin/users/' + mod.me.id + '/action', { action: 'role', role: 'mod' }, admin.token);
  for (const [m, u] of [['GET', '/api/admin/settings'], ['GET', '/api/admin/users'.replace('users', 'accounts')], ['GET', '/api/admin/backup'], ['POST', '/api/admin/plugins'], ['GET', '/api/admin/games'], ['POST', '/api/admin/upload']]) {
    assert.strictEqual((await api(m, u, m === 'POST' ? {} : undefined, mod.token)).status, 403, 'mod: ' + u);
  }
  r = await api('POST', '/api/admin/users/' + admin.me.id + '/action', { action: 'ban', hours: 1 }, mod.token); assert.strictEqual(r.status, 403);
  r = await api('POST', '/api/admin/users/' + olek.me.id + '/action', { action: 'role', role: 'admin' }, mod.token); assert.strictEqual(r.status, 403); r = await api('POST', '/api/admin/users/' + mod.me.id + '/action', { action: 'role', role: 'admin' }, mod.token); assert.strictEqual(r.status, 400); ok('moderator nie ma dostępu do sekcji Super Admina i nie może karać administratora ani nadawać ról (brak eskalacji)');
  /* IDOR */
  r = await api('GET', '/api/me/matches', null, ala.token); assert(Array.isArray(r.body));
  r = await api('POST', '/api/me/blocks', { uid: ala.me.id }, ala.token); assert.strictEqual(r.status, 400);
  r = await api('PUT', '/api/me', { role: 'admin', xp: 99999, banned_until: 0, email: 'x@y.pl', guest: 0 }, olek.token); assert.strictEqual(D.get('SELECT role,xp FROM users WHERE id=?', olek.me.id).role, 'user'); assert.strictEqual(D.get('SELECT xp FROM users WHERE id=?', olek.me.id).xp, 0); ok('mass assignment: PUT /api/me nie pozwala ustawić roli ani XP');
  r = await api('GET', '/api/users/Olek'); assert(!('email' in r.body.user) && !JSON.stringify(r.body).includes('olek@example.com') && !JSON.stringify(r.body).includes('pass_')); ok('profil publiczny nie ujawnia e-maila ani skrótów haseł');
  r = await api('GET', '/api/ranking?game=szachy&limit=-1'); assert(r.status === 200 && r.body.rows.length <= 100); ok('ujemny limit rankingu nie zwraca całej tabeli');

  console.log('Ładunki, pliki, ścieżki');
  r = await api('POST', '/api/admin/plugins', 'x'.repeat(5e6)); assert.strictEqual(r.status, 401); ok('anonim nie zmusi serwera do czytania 5 MB (wymagane uwierzytelnienie przed odczytem dużego ładunku)');
  r = await api('POST', '/api/auth/login', 'x'.repeat(70000)); assert.strictEqual(r.status, 413); ok('zwykłe endpointy: limit 64 KB (413)');
  for (const p of ['/uploads/..%2fsecret.key', '/uploads/%2e%2e/secret.key', '/shared/..%2fserver/db.js', '/..%2fserver/db.js', '/%2e%2e/server/db.js', '/plugins/..%2f..%2fsecret.key', '/uploads/..%5csecret.key', '/%00', '/js/..%2f..%2fserver%2fdb.js']) {
    const rr = await fetch(base + p); const t = await rr.text(); assert(!/DatabaseSync|secret|SELECT/.test(t) || rr.headers.get('content-type').includes('html'), 'traversal: ' + p);
    assert(!t.includes('DatabaseSync'), 'wyciek kodu: ' + p);
  }
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'secret.key'), 'TAJNY-KLUCZ-TESTOWY');
  for (const p of ['/uploads/..%2fsecret.key', '/uploads/%2e%2e%2fsecret.key', '/plugins/x/..%2f..%2fsecret.key', '/secret.key']) { const t = await (await fetch(base + p)).text(); assert(!t.includes('TAJNY-KLUCZ'), p); }
  ok('path traversal (uploads, plugins, shared, public, kodowanie %2e/%5c/%00): brak dostępu do kodu i sekretów');
  const hdr = (await fetch(base + '/')).headers;
  assert(hdr.get('content-security-policy').includes("script-src 'self'") && !/connect-src[^;]*https:/.test(hdr.get('content-security-policy')) && hdr.get('x-content-type-options') === 'nosniff' && hdr.get('x-frame-options') === 'DENY'); ok('nagłówki bezpieczeństwa: CSP bez szerokiego connect-src, nosniff, X-Frame-Options');
  assert((await api('GET', '/api/config')).headers.get('access-control-allow-origin') === null); r = await api('GET', '/api/config', undefined, null, { Origin: 'https://evil.example' }); assert.strictEqual(r.headers.get('access-control-allow-origin'), null); ok('CORS: obca domena nie dostaje Access-Control-Allow-Origin');

  /* pluginy / ZIP */
  const zip = (entries) => { const f = path.join(process.env.DATA_DIR, 'z-' + Math.random() + '.zip'); Z.writeZip(f, entries); const b = fs.readFileSync(f).toString('base64'); fs.unlinkSync(f); return b; };
  const man = (slug) => ({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ slug, name: 'Test', entry: 'index.html' })) });
  const html = { name: 'index.html', data: Buffer.from('<h1>x</h1>') };
  r = await api('POST', '/api/admin/plugins', { zip: zip([man('good-plugin'), html]) }, admin.token); assert.strictEqual(r.status, 200); ok('poprawny plugin ZIP instaluje się');
  for (const [name, entries, st] of [
    ['zip-slip ../', [man('evil-one'), html, { name: '../../evil.js', data: Buffer.from('x') }], 400],
    ['ścieżka bezwzględna', [man('evil-two'), html, { name: '/etc/passwd', data: Buffer.from('x') }], 400],
    ['plik ukryty', [man('evil-three'), html, { name: '.env', data: Buffer.from('x') }], 400],
    ['niedozwolone rozszerzenie', [man('evil-four'), html, { name: 'shell.php', data: Buffer.from('x') }], 400],
    ['slug wbudowanej gry', [{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ slug: 'szachy', name: 'X' })) }, html], 409],
    ['slug z ../', [{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ slug: '../x', name: 'X' })) }, html], 400],
    ['bomba (plik 4 MB)', [man('evil-five'), html, { name: 'big.txt', data: Buffer.alloc(4e6) }], 413],
    ['bomba (suma > 12 MB)', [man('evil-six'), html].concat([1, 2, 3, 4, 5].map((i) => ({ name: 'p' + i + '.txt', data: Buffer.alloc(2.9e6, i) }))), 413],
    ['entry poza archiwum', [{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ slug: 'evil-seven', name: 'X', entry: 'nie-ma.html' })) }, html], 400]
  ]) { r = await api('POST', '/api/admin/plugins', { zip: zip(entries) }, admin.token); assert.strictEqual(r.status, st, name + ' -> ' + r.status + ' ' + r.text.slice(0, 80)); }
  r = await api('POST', '/api/admin/plugins', { zip: 'AAAA' }, admin.token); assert.strictEqual(r.status, 400); r = await api('POST', '/api/admin/plugins', { zip: Buffer.from('PK\x05\x06' + 'x'.repeat(100)).toString('base64') }, admin.token); assert.strictEqual(r.status, 400);
  assert(!fs.existsSync(path.join(process.env.DATA_DIR, 'evil.js')) && !fs.existsSync(path.join(process.env.DATA_DIR, '..', 'evil.js')));
  ok('ZIP: zip-slip, ścieżki bezwzględne, pliki ukryte, złe rozszerzenia, bomby kompresji, kolizja sluga, uszkodzone archiwa – wszystko odrzucone');
  r = await fetch(base + '/plugins/good-plugin/index.html'); const csp = r.headers.get('content-security-policy'); assert(/sandbox allow-scripts/.test(csp) && /connect-src 'none'/.test(csp) && !/allow-same-origin/.test(csp)); ok('plugin działa w sandboxie bez dostępu do sieci i bez allow-same-origin');

  console.log('WebSocket');
  const tok = (await reg('Wsgracz')).token;
  let w = await rawWS(tok, { origin: 'https://evil.example' }); assert.strictEqual(w.status, 403); ok('Origin obcej domeny: 403 (ochrona przed Cross-Site WebSocket Hijacking)');
  w = await rawWS(tok, { origin: 'http://127.0.0.1:' + port }); assert.strictEqual(w.status, 101); w.s.destroy(); ok('Origin własnej domeny: 101');
  w = await rawWS(tok); assert.strictEqual(w.status, 101); ok('klient bez Origin (aplikacja natywna): 101');
  w.s.write(frame({ op: 1, payload: Buffer.alloc(40000, 65), fin: false })); w.s.write(frame({ op: 0, payload: Buffer.alloc(40000, 65), fin: false })); await sleep(300);
  assert.strictEqual(w.closeCode, 1009); ok('wiadomość z fragmentów > 64 KB zamyka połączenie (brak wyczerpania pamięci)');
  w = await rawWS(tok); w.s.write(frame({ op: 1, payload: Buffer.from('{}'), rsv: 4 })); await sleep(200); assert.strictEqual(w.closeCode, 1002); ok('bit RSV: 1002');
  w = await rawWS(tok); w.s.write(frame({ op: 1, payload: Buffer.from('{}'), mask: false })); await sleep(200); assert.strictEqual(w.closeCode, 1002); ok('ramka bez maski od klienta: 1002');
  w = await rawWS(tok); w.s.write(frame({ op: 9, payload: Buffer.alloc(200) })); await sleep(200); assert.strictEqual(w.closeCode, 1002); ok('zbyt duża ramka kontrolna: 1002');
  w = await rawWS(tok); w.s.write(frame({ op: 5, payload: Buffer.alloc(2) })); await sleep(200); assert.strictEqual(w.closeCode, 1002); ok('nieznany opcode: 1002');
  w = await rawWS(tok); for (let i = 0; i < 150; i++) w.s.write(text({ t: 'ping' })); await sleep(500);
  const pongs = w.msgs.filter((m) => m.t === 'pong').length; assert(pongs > 0 && pongs < 60, 'pongs=' + pongs); ok('flood: z 150 komunikatów w kilka ms obsłużono ' + pongs + ' (limit częstotliwości)');
  for (let i = 0; i < 400; i++) w.s.write(text({ t: 'ping' })); await sleep(600); assert.strictEqual(w.closeCode, 1008); ok('uporczywy flood kończy się zamknięciem połączenia (1008)');
  w = await rawWS(tok); w.s.write(text('to nie jest json')); w.s.write(text('[1,2,3]')); w.s.write(text({ t: 5 })); w.s.write(text({ t: 'move', id: 'x', move: {} })); w.s.write(text({ t: 'table_set', settings: 'x' })); w.s.write(text({ t: '__proto__', x: 1 })); w.s.write(text('{"t":"table_sit","game":{"$":1},"n":"1; DROP"}')); await sleep(400);
  assert(!w.closed); w.s.write(text({ t: 'ping' })); await sleep(150); assert(w.msgs.some((m) => m.t === 'pong')); ok('zniekształcone i złośliwe komunikaty nie wywracają serwera ani połączenia');
  const many = []; for (let i = 0; i < 9; i++) many.push(await rawWS(tok)); await sleep(300);
  const alive = many.filter((c) => !c.closed && c.closeCode == null).length; assert(alive <= 6, 'żywych: ' + alive); ok('limit 6 połączeń na użytkownika (najstarsze ustępują): żywych ' + alive + ' z 9'); many.forEach((c) => c.s.destroy());

  console.log('\nOK: ' + passed + ' testów bezpieczeństwa');
  process.exit(0);
})().catch((e) => { console.error('\nBŁĄD TESTU:', e); process.exit(1); });
