'use strict';
/* Wtyczki dołączone do portalu (plugins-bundled/): instalacja przy starcie, włączenie, idempotencja, serwowanie plików, brak nadpisania zmian admina. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-bund-')); process.env.ADMIN_PASSWORD = 'AdminTest123';
const D = require('../server/db'); require('../server/migrations')(D); const PLUG = require('../server/plugins'); const { create } = require('../server/index');
const SLUG = '67-nocy-apokalipsy';
const row = () => D.get('SELECT slug,name,status,plugin,cfg FROM games WHERE slug=?', SLUG);

assert.deepStrictEqual(PLUG.installBundled(), [SLUG]);
assert(row() && row().plugin === SLUG && row().status === 'active'); console.log('  ✓ gra zainstalowana przy starcie i od razu włączona');
assert.deepStrictEqual(PLUG.installBundled(), []); console.log('  ✓ drugi start niczego nie dubluje');
D.run("UPDATE games SET status='hidden', cfg=? WHERE slug=?", JSON.stringify({ maxNight: 10 }), SLUG);
PLUG.installBundled(); assert.strictEqual(row().status, 'hidden'); assert.strictEqual(JSON.parse(row().cfg).maxNight, 10); console.log('  ✓ ukrycie i konfiguracja ustawione przez admina nie są nadpisywane');
D.run("UPDATE games SET status='active' WHERE slug=?", SLUG);
const g = fs.readFileSync(path.join(__dirname, '..', 'plugins-bundled', SLUG, 'game.js'), 'utf8');
assert(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket|eval\(/.test(g)); console.log('  ✓ kod gry nie używa sieci ani storage (sandbox portalu ich nie udostępnia)');

const srv = create(); srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const get = (p) => new Promise((ok) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok({ s: r.statusCode, h: r.headers, b })); }));
  (async () => {
    const i = await get('/plugins/' + SLUG + '/index.html'); assert.strictEqual(i.s, 200); assert(/sandbox allow-scripts/.test(i.h['content-security-policy']) && /connect-src 'none'/.test(i.h['content-security-policy']));
    assert.strictEqual((await get('/plugins/' + SLUG + '/game.js')).s, 200); assert.strictEqual((await get('/plugins/' + SLUG + '/manifest.json')).s, 200);
    console.log('  ✓ /plugins/' + SLUG + '/ serwuje pliki z restrykcyjnym CSP');
    const l = JSON.parse((await get('/api/games')).b); const e = l.find((x) => x.slug === SLUG);
    assert(e && e.plugin === SLUG && e.name === '67 nocy apokalipsy'); console.log('  ✓ gra widoczna na liście GET /api/games');
    console.log('\nOK: 5 testów wtyczki dołączonej'); process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
});
