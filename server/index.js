'use strict';
process.env.TZ = process.env.TZ || 'Europe/Warsaw';
const http = require('http');
const path = require('path');
const D = require('./db');
const A = require('./auth');
const { Router, HttpError, readBody, sendJSON, serveFile, safeJoin, originAllowed } = require('./http');
const RT = require('./realtime');
require('./tournaments');
const API = require('./api');
const ADMIN = require('./admin');

const PUBLIC = path.join(__dirname, '..', 'public');
const SHARED = path.join(__dirname, '..', 'shared');
const UPLOADS = path.join(D.DATA_DIR, 'uploads');

require('./migrations')(D);
const PLUG = require('./plugins');
const FORUM = require('./forum');
const router = new Router();
API.register(router);
ADMIN.register(router);
PLUG.register(router);
FORUM.register(router);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' wss: ws:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (p.startsWith('/api/')) {
    /* CORS: tylko własne domeny i aplikacja Android (ALLOWED_ORIGINS=https://nakartce.pl,https://www.nakartce.pl) */
    const org = req.headers.origin;
    if (org && originAllowed(req)) { res.setHeader('Access-Control-Allow-Origin', org); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const hit = router.match(req.method, p);
      if (!hit) throw new HttpError(404, 'Nie znaleziono');
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        /* duże ładunki (ZIP pluginu, obrazy) czytamy dopiero po sprawdzeniu uprawnień – anonim nie może zmusić serwera do buforowania megabajtów */
        const BIG = { '/api/admin/plugins': [9000000, 'admin'], '/api/admin/upload': [1300000, 'admin'], '/api/admin/ads/upload': [4200000, 'mod'] }[p];
        if (BIG) A.requireRole(req, BIG[1]);
        const raw = await readBody(req, BIG ? BIG[0] : 65536);
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'Nieprawidłowy JSON'); } }
      }
      const out = await hit.handler(req, res, hit.params, body, url.searchParams);
      if (!res.writableEnded) sendJSON(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof HttpError) { if (e.status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); } sendJSON(res, e.status, { error: e.message }); }
      else { console.error('API error', req.method, p, e); sendJSON(res, 500, { error: 'Błąd serwera' }); }
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (p === '/health') return sendJSON(res, 200, { ok: true });
  if (p.startsWith('/uploads/')) {
    const f = safeJoin(UPLOADS, p.slice(9));
    if (f && serveFile(req, res, f, 'public, max-age=31536000, immutable')) return;
    res.writeHead(404); return res.end();
  }
  if (p.startsWith('/plugins/')) return PLUG.serve(req, res, p);
  if (p.startsWith('/shared/')) {
    const f = safeJoin(SHARED, p.slice(8));
    if (f && serveFile(req, res, f, 'no-cache')) return;
  }
  let rel = decodeURIComponent(p);
  if (rel === '/admin') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const f = safeJoin(PUBLIC, rel);
  if (f) {
    const ext = path.extname(f);
    if (ext === '.html') res.setHeader('Content-Security-Policy', CSP);
    const cache = /\.(png|jpg|svg|ico|woff2)$/.test(ext) ? 'public, max-age=86400' : 'no-cache';
    if (serveFile(req, res, f, cache)) return;
  }
  if (!path.extname(rel)) { // fallback dla tras SPA
    res.setHeader('Content-Security-Policy', CSP);
    if (serveFile(req, res, path.join(PUBLIC, 'index.html'), 'no-cache')) return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Nie znaleziono');
}

function create() {
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.writeHead(500); res.end(); } catch (x) { /* ignore */ } }); });
  server.headersTimeout = 15000; server.requestTimeout = 60000; server.keepAliveTimeout = 5000;    // ochrona przed wolnymi połączeniami (slowloris)
  server.maxRequestsPerSocket = 1000;
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    RT.handleUpgrade(req, socket);
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const adm = D.ensureAdmin(A.hashPassword);
  const orphans = D.cleanupOrphans(0); if (orphans) console.log('Usunięto ' + orphans + ' przerwanych partii z poprzedniego uruchomienia');
  const bundled = PLUG.installBundled(); if (bundled.length) console.log('Zainstalowano wtyczki dołączone do portalu: ' + bundled.join(', '));
  const srv = create();
  /* łagodne zamykanie (docker stop / systemd): przestajemy przyjmować połączenia, zamykamy WebSockety, zapisujemy WAL */
  let closing = false;
  const stop = (sig) => {
    if (closing) return; closing = true; console.log(sig + ': zamykanie serwera…');
    srv.close(() => { D.close(); process.exit(0); });
    RT.closeAll(); srv.closeIdleConnections && srv.closeIdleConnections();
    setTimeout(() => { D.close(); process.exit(0); }, 8000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
  srv.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log('Na kartce działa: http://localhost:' + port + '  (panel: /admin/)');
    if (adm) {
      console.log('\n=== Utworzono konto administratora ===\n  login: ' + adm.nick + (adm.generated ? '\n  hasło: ' + adm.password + '\n  (hasło wygenerowane; zmień je po pierwszym logowaniu: Profil → Zmień hasło)' : '\n  hasło: takie, jak w zmiennej ADMIN_PASSWORD (nie jest wypisywane w logach)') + '\n');
    }
  });
}
module.exports = { create };
