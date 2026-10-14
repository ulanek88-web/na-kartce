'use strict';
/* Awaryjny reset hasła konta (domyślnie „admin”): nowe hasło z zmiennej NEW_PASSWORD, unieważnia wszystkie sesje konta.
 * Docker:  sudo docker compose -f docker-compose.prod.yml exec -e NEW_PASSWORD='nowe-haslo' nakartce node server/reset-admin.js [login]
 * Bez Dockera:  NEW_PASSWORD='nowe-haslo' node server/reset-admin.js [login] */
const D = require('./db'), A = require('./auth');
const login = String(process.argv[2] || process.env.ADMIN_NICK || 'admin').toLowerCase();
const pw = process.env.NEW_PASSWORD || '';
if (pw.length < 10 || pw.length > A.PASSWORD_MAX) { console.error('Ustaw zmienną NEW_PASSWORD (10–' + A.PASSWORD_MAX + ' znaków).'); process.exit(1); }
const u = D.get('SELECT id,nick,role FROM users WHERE guest=0 AND nick_lc=?', login);
if (!u) { console.error('Nie ma konta o loginie „' + login + '”.'); process.exit(1); }
const h = A.hashPassword(pw);
D.run('UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?', h.hash, h.salt, u.id);
A.revokeSessions(u.id);
console.log('Hasło konta „' + u.nick + '” (rola: ' + u.role + ') zostało zmienione, a stare sesje unieważnione.');
D.close();
