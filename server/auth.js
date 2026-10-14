'use strict';
const crypto = require('crypto');
const D = require('./db');
const { HttpError } = require('./http');

const SECRET = D.secret();
const b64 = (b) => Buffer.from(b).toString('base64url');

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* Wersje asynchroniczne (scrypt w puli wątków libuv) – nie blokują pętli zdarzeń przy wielu logowaniach naraz. */
const scryptAsync = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPasswordAsync(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scryptAsync(pw, salt)).toString('hex') };
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'), DUMMY_HASH = crypto.randomBytes(64).toString('hex');
/** Zawsze wykonuje pełne haszowanie (także dla nieistniejącego konta) – brak różnicy czasu ujawniającej, czy login istnieje. */
async function verifyPasswordAsync(pw, salt, hash) {
  const real = !!(salt && hash);
  const k = Buffer.from((await scryptAsync(String(pw).slice(0, 1024), real ? salt : DUMMY_SALT)).toString('hex'));
  const b = Buffer.from(real ? hash : DUMMY_HASH);
  return real && k.length === b.length && crypto.timingSafeEqual(k, b);
}
/** Wylogowuje wszystkie urządzenia: podbicie wersji sesji unieważnia każdy wcześniej wydany token. */
function revokeSessions(uid) { D.run('UPDATE users SET token_version=token_version+1 WHERE id=?', uid); }
const PASSWORD_MAX = 200;
function sign(uid, days, ver) {
  const payload = b64(JSON.stringify({ u: uid, e: Date.now() + days * 86400000, v: ver || 0 }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function parse(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.e > Date.now() ? { uid: p.u, v: p.v || 0 } : null;
  } catch (e) { return null; }
}
const verify = (token) => { const p = parse(token); return p ? p.uid : null; };
/* token niesie wersję sesji użytkownika (users.token_version) – podbicie jej wylogowuje wszystkie urządzenia */
function issue(user) { return sign(user.id, user.guest ? 365 : 60, user.token_version || 0); }

function banState(u) {
  if (u.banned_until === -1) return { banned: true, until: -1, reason: u.ban_reason || '' };
  if (u.banned_until > Date.now()) return { banned: true, until: u.banned_until, reason: u.ban_reason || '' };
  return { banned: false };
}
function userFromToken(token) {
  const t = parse(token);
  if (!t) return null;
  const u = D.get('SELECT * FROM users WHERE id=?', t.uid);
  if (!u || u.deleted_at || (u.token_version || 0) !== t.v) return null;
  return u;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function requireUser(req) {
  const u = userFromToken(bearer(req));
  if (!u) throw new HttpError(401, 'Zaloguj się lub zagraj jako gość');
  const b = banState(u);
  if (b.banned) throw new HttpError(403, 'Konto zablokowane' + (b.reason ? ': ' + b.reason : ''));
  const now = Date.now();
  if (now - u.last_seen > 120000) { D.run('UPDATE users SET last_seen=? WHERE id=?', now, u.id); u.last_seen = now; }
  return u;
}
function optionalUser(req) {
  const u = userFromToken(bearer(req));
  if (!u || banState(u).banned) return null;
  return u;
}
const ROLE_LEVEL = { user: 0, mod: 1, admin: 2 };
function requireRole(req, role) {
  const u = requireUser(req);
  if ((ROLE_LEVEL[u.role] || 0) < ROLE_LEVEL[role]) throw new HttpError(403, 'Brak uprawnień');
  return u;
}

/* RBAC wzorowany na WordPressie: rola -> zestaw uprawnień (capabilities).
   admin = Super Admin (wszystko), mod = Moderator / Młodszy Admin (tylko bezpieczne sekcje). */
const CAPS = {
  admin: ['*'],
  mod: ['stats', 'ads', 'announce', 'censor', 'reports', 'users.moderate']
};
const can = (role, cap) => { const c = CAPS[role]; return !!c && (c.includes('*') || c.includes(cap)); };
function requireCap(req, cap) {
  const u = requireUser(req);
  if (!can(u.role, cap)) throw new HttpError(403, 'Brak uprawnień do tej sekcji');
  return u;
}

/* proste ograniczanie liczby żądań (na IP) */
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (h.length >= max) throw new HttpError(429, 'Za dużo prób. Spróbuj za chwilę.');
  h.push(now);
  hits.set(key, h);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 300000).unref();

/* licznik NIEUDANYCH prób (np. logowania) na klucz – blokuje zgadywanie hasła do jednego konta z wielu adresów IP */
const fails = new Map();
function failCheck(key, max, windowMs) {
  const now = Date.now(), h = (fails.get(key) || []).filter((t) => now - t < windowMs);
  fails.set(key, h);
  if (h.length >= max) throw new HttpError(429, 'Zbyt wiele nieudanych prób. Spróbuj ponownie za kilkanaście minut.');
}
const failHit = (key) => { const h = fails.get(key) || []; h.push(Date.now()); fails.set(key, h); };
const failClear = (key) => fails.delete(key);
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (!v.some((t) => now - t < 3600000)) fails.delete(k); }, 300000).unref();

const NICK_RE = /^[A-Za-z0-9ĄąĆćĘęŁłŃńÓóŚśŹźŻż._-]{3,16}$/;
const RESERVED = ['nakartce', 'admin', 'administrator', 'nakartce', 'moderator', 'system', 'bot'];
function validNick(nick) { return typeof nick === 'string' && NICK_RE.test(nick); }

module.exports = { hashPasswordAsync, verifyPasswordAsync, revokeSessions, PASSWORD_MAX, failCheck, failHit, failClear, hashPassword, verifyPassword, sign, verify, issue, banState, userFromToken, requireUser, optionalUser, requireRole, requireCap, can, CAPS, rateLimit, validNick, RESERVED, bearer };
