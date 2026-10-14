'use strict';
/* Konto administratora: hasło ze znakami specjalnymi, brak hasła w logach, logowanie, rola, reset hasła. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), http = require('http'), { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), PW = 'T#st9!aB7@xK2$mP4&zQ8wLn', NEW = 'Zmienione-Haslo-55!', PORT = 39000 + Math.floor(Math.random() * 900);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-adm-'));
const env = (extra) => Object.assign({}, process.env, { DATA_DIR: dir, PORT: String(PORT), FORCE_COLOR: '0', NO_COLOR: '1', NODE_DISABLE_COLORS: '1' }, extra);
const call = (method, p, body, token) => new Promise((ok, no) => { const d = body ? JSON.stringify(body) : null; const r = http.request({ port: PORT, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}) }, (res) => { let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* nie-JSON */ } ok({ s: res.statusCode, j }); }); }); r.on('error', no); if (d) r.write(d); r.end(); });
const startServer = () => new Promise((ok, no) => { let out = ''; const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: env({ ADMIN_PASSWORD: PW }) }); c.stdout.on('data', (d) => { out += d; if (/działa/.test(out)) ok({ c, out: () => out }); }); c.stderr.on('data', (d) => (out += d)); c.on('error', no); setTimeout(() => no(new Error('serwer nie wystartował')), 15000); });
const stopServer = (s) => new Promise((ok) => { s.c.once('exit', ok); s.c.kill('SIGTERM'); });

(async () => {
  let s = await startServer();
  assert(!s.out().includes(PW), 'hasło wypisane w logach'); console.log('  ✓ hasło administratora nie trafia do logów');
  let r = await call('POST', '/api/auth/login', { login: 'admin', password: PW }); assert.strictEqual(r.s, 200);
  const me = await call('GET', '/api/admin/me', null, r.j.token); assert.strictEqual(me.j.role, 'admin'); assert.deepStrictEqual(me.j.caps, ['*']);
  console.log('  ✓ konto admin z hasłem ze znakami specjalnymi ($ # & ! @) loguje się i ma rolę administratora');
  assert.strictEqual((await call('POST', '/api/auth/login', { login: 'admin', password: PW + 'x' })).s, 401); console.log('  ✓ błędne hasło odrzucone (401)');
  await stopServer(s);
  const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/reset-admin.js'], { cwd: ROOT, env: env({ NEW_PASSWORD: 'krotkie' }), encoding: 'utf8' });
  assert.strictEqual(bad.status, 1); console.log('  ✓ reset odrzuca zbyt krótkie hasło');
  const good = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/reset-admin.js'], { cwd: ROOT, env: env({ NEW_PASSWORD: NEW }), encoding: 'utf8' });
  assert.strictEqual(good.status, 0, good.stderr);
  s = await startServer();
  assert.strictEqual((await call('POST', '/api/auth/login', { login: 'admin', password: PW })).s, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { login: 'admin', password: NEW })).s, 200);
  assert.strictEqual((await call('GET', '/api/admin/me', null, r.j.token)).s, 401);
  console.log('  ✓ po resecie działa tylko nowe hasło, a stara sesja jest unieważniona');
  await stopServer(s); console.log('\nOK: 5 testów konta administratora'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
