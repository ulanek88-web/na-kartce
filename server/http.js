'use strict';
/* Mały router HTTP + serwowanie plików statycznych (bez Expressa). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { chunks.length = 0; req.removeAllListeners('data'); req.resume(); reject(new HttpError(413, 'Zbyt duże żądanie')); return; }   // porzucamy resztę ładunku bez buforowania; gniazdo zamykamy po wysłaniu odpowiedzi
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

const gzCache = new Map();
function serveFile(req, res, file, cacheControl) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': cacheControl || 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  const compressible = /^(text\/|application\/(json|javascript|manifest))/.test(type) || ext === '.svg';
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 800) {
    let ent = gzCache.get(file);
    if (!ent || ent.etag !== etag) { ent = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gzCache.set(file, ent); }
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(ent.buf);
    return true;
  }
  res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root + path.sep) || p === root ? p : null;
}

/** Adres klienta. Nagłówka X-Forwarded-For NIE wolno ufać bez reverse proxy (każdy może go podrobić i ominąć limity prób).
 *  TRUST_PROXY=N (liczba zaufanych proxy przed aplikacją, zwykle 1) – wtedy bierzemy wpis dopisany przez ostatnie zaufane proxy. */
function clientIp(req) {
  const hops = parseInt(process.env.TRUST_PROXY, 10) || 0;
  if (hops > 0) {
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - hops)].slice(0, 64);
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}
/** Czy nagłówek Origin pochodzi z dozwolonego źródła (ta sama domena, ALLOWED_ORIGINS, localhost, aplikacja Capacitor). Brak Origin = klient spoza przeglądarki. */
function originAllowed(req) {
  const org = req.headers.origin;
  if (!org) return true;
  try { if (new URL(org).host === req.headers.host) return true; } catch (e) { return false; }
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return allow.includes(org) || /^(https?:\/\/localhost|capacitor:\/\/localhost)(:\d+)?$/.test(org);
}

module.exports = { clientIp, originAllowed, Router, HttpError, readBody, sendJSON, serveFile, safeJoin, MIME };
