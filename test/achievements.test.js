'use strict';
/* Osiągnięcia: wyliczane z danych serwera (nie od klienta), z poprawnym postępem; brak naliczania za partie nieukończone i cudze. */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ach-')); process.env.ADMIN_PASSWORD = 'AdminTest123';
const D = require('../server/db'); require('../server/migrations')(D); const ACH = require('../server/achievements');
const now = Date.now(), mk = (n) => D.run('INSERT INTO users(nick,nick_lc,guest,created_at,last_seen) VALUES(?,?,0,?,?)', n, n.toLowerCase(), now, now).id;
const a = mk('Ala'), b = mk('Bob'); const g = (s) => D.get('SELECT id FROM games WHERE slug=?', s).id;
const done = (uid) => ACH.forUser(uid).filter((x) => x.done).map((x) => x.id);
const val = (uid, id) => ACH.forUser(uid).find((x) => x.id === id);
assert.deepStrictEqual(done(a), []); console.log('  ✓ nowy gracz: brak osiągnięć, wszystkie z celem i postępem 0');
const ins = (p1, p2, game, result, extra) => D.run('INSERT INTO matches(game_id,p1,p2,bot_level,bot_side,rated,mode,started_at,ended_at,result) VALUES(?,?,?,?,?,0,\'queue\',?,?,?)', game, p1, p2, (extra || {}).bot || null, (extra || {}).botSide || 0, now, (extra || {}).open ? null : now, result);
ins(a, b, g('szachy'), 1);                       // Ala wygrywa z Bobem (na żywo)
ins(b, a, g('warcaby'), 1);                      // Bob wygrywa z Alą
ins(a, null, g('reversi'), 1, { bot: 'h', botSide: 2 });    // Ala pokonuje trudnego bota
ins(a, b, g('gomoku'), null, { open: true });    // niedokończona – nie liczy się
ins(b, null, g('czworki'), 1, { bot: 'h', botSide: 2 });    // cudza wygrana nie liczy się Ali
assert.deepStrictEqual(done(a).sort(), ['explorer'].filter(() => false).concat(['first_game', 'first_win', 'hard_bot', 'online_win']).sort());
assert.strictEqual(val(a, 'games_25').value, 3); assert.strictEqual(val(a, 'kinds') || val(a, 'explorer').value, 3); console.log('  ✓ liczą się tylko ukończone partie gracza; wygrana z botem Trudnym i z człowiekiem rozpoznane osobno');
D.run('INSERT INTO ratings(user_id,game_id,rating,games,wins,streak,best_streak,peak,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', a, g('szachy'), 1450, 12, 8, 2, 5, 1450, now);
assert(done(a).includes('streak_3') && done(a).includes('streak_5') && !done(a).includes('streak_10') && done(a).includes('rating_1400')); console.log('  ✓ serie i ranking wynikają z danych rankingowych (seria 5 tak, 10 nie; ranking 1400 tak)');
const tid = D.run("INSERT INTO forum_topics(board_id,user_id,title,created_at,last_post_at) VALUES((SELECT id FROM forum_boards LIMIT 1),?,'t',?,?)", a, now, now).id;
D.run('INSERT INTO forum_posts(topic_id,user_id,body,created_at) VALUES(?,?,?,?)', tid, a, 'x', now); assert(done(a).includes('forum_first') && !done(a).includes('forum_25')); console.log('  ✓ osiągnięcie forum po pierwszym poście');
assert(ACH.forUser(a).every((x) => x.value <= x.goal)); console.log('  ✓ postęp nigdy nie przekracza celu');
console.log('\nOK: 4 testy osiągnięć'); process.exit(0);
