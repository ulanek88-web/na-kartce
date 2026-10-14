'use strict';
/* Turnieje: drabinka pucharowa (eliminacja), zapisy, start o wyznaczonej porze, wynik z partii. */
const D = require('./db');
const G = require('./game');
const RT = require('./realtime');

const ready = new Map(); // tm id -> Set(uid)

function seedOrder(size) {
  let o = [1, 2];
  while (o.length < size) {
    const n = o.length * 2 + 1;
    o = o.flatMap((s) => [s, n - s]);
  }
  return o;
}
const pow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };
const nick = (uid) => { if (!uid) return null; const u = D.get('SELECT nick FROM users WHERE id=?', uid); return u ? u.nick : null; };

function start(tid) {
  const t = D.get('SELECT * FROM tournaments WHERE id=?', tid);
  if (!t || t.status !== 'open') return false;
  const players = D.all('SELECT user_id FROM tournament_players WHERE tid=?', tid).map((p) => p.user_id);
  if (players.length < 2) { D.run("UPDATE tournaments SET status='cancelled' WHERE id=?", tid); players.forEach((u) => RT.notify(u, 'Turniej „' + t.name + '” odwołany: za mało graczy', '#/tournament/' + tid)); return false; }
  const ranked = players.map((uid) => ({ uid, r: G.ratingValue(uid, t.game_id) })).sort((a, b) => b.r - a.r);
  ranked.forEach((p, i) => D.run('UPDATE tournament_players SET seed=? WHERE tid=? AND user_id=?', i + 1, tid, p.uid));
  const size = pow2(ranked.length), order = seedOrder(size), rounds = Math.log2(size);
  D.tx(() => {
    for (let r = 1; r <= rounds; r++) {
      const cnt = size / Math.pow(2, r);
      for (let s = 0; s < cnt; s++) {
        let p1 = null, p2 = null, bye = 0, winner = null, status = 'waiting';
        if (r === 1) {
          p1 = (ranked[order[2 * s] - 1] || {}).uid || null;
          p2 = (ranked[order[2 * s + 1] - 1] || {}).uid || null;
          if (p1 && p2) status = 'ready';
          else { bye = 1; winner = p1 || p2; status = 'done'; }
        }
        D.run('INSERT INTO tournament_matches(tid,round,slot,p1,p2,winner,status,bye) VALUES(?,?,?,?,?,?,?,?)', tid, r, s, p1, p2, winner, status, bye);
      }
    }
    D.run("UPDATE tournaments SET status='running' WHERE id=?", tid);
  });
  propagate(tid);
  players.forEach((u) => RT.notify(u, 'Turniej „' + t.name + '” wystartował. Sprawdź swój mecz.', '#/tournament/' + tid));
  return true;
}

function propagate(tid) {
  const t = D.get('SELECT * FROM tournaments WHERE id=?', tid);
  const last = D.get('SELECT MAX(round) AS r FROM tournament_matches WHERE tid=?', tid).r;
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of D.all("SELECT * FROM tournament_matches WHERE tid=? AND status='done' AND winner IS NOT NULL AND round<?", tid, last)) {
      const next = D.get('SELECT * FROM tournament_matches WHERE tid=? AND round=? AND slot=?', tid, m.round + 1, m.slot >> 1);
      const col = m.slot % 2 === 0 ? 'p1' : 'p2';
      if (next[col] !== m.winner) {
        D.run('UPDATE tournament_matches SET ' + col + '=? WHERE id=?', m.winner, next.id);
        changed = true;
      }
      const n2 = D.get('SELECT * FROM tournament_matches WHERE id=?', next.id);
      if (n2.status === 'waiting' && n2.p1 && n2.p2) {
        D.run("UPDATE tournament_matches SET status='ready' WHERE id=?", n2.id);
        [n2.p1, n2.p2].forEach((u) => RT.notify(u, 'Twój mecz w turnieju „' + t.name + '” jest gotowy.', '#/tournament/' + tid));
        changed = true;
      }
    }
  }
  const fin = D.get('SELECT * FROM tournament_matches WHERE tid=? AND round=?', tid, last);
  if (fin && fin.status === 'done' && fin.winner && t.status === 'running') {
    D.run("UPDATE tournaments SET status='finished',winner_id=? WHERE id=?", fin.winner, tid);
    D.all('SELECT user_id FROM tournament_players WHERE tid=?', tid).forEach((p) => RT.notify(p.user_id, 'Turniej „' + t.name + '” zakończony. Zwycięzca: ' + nick(fin.winner), '#/tournament/' + tid));
  }
}

function onReady(uid, tmId, err) {
  const tm = D.get('SELECT * FROM tournament_matches WHERE id=?', tmId);
  if (!tm || (tm.p1 !== uid && tm.p2 !== uid)) return err('To nie jest Twój mecz');
  if (tm.status !== 'ready') return err('Ten mecz nie jest teraz dostępny');
  if (RT.activeFor(uid)) return err('Masz już trwającą partię');
  const t = D.get('SELECT * FROM tournaments WHERE id=?', tm.tid);
  const set = ready.get(tmId) || new Set();
  set.add(uid); ready.set(tmId, set);
  const opp = tm.p1 === uid ? tm.p2 : tm.p1;
  if (!set.has(opp)) {
    RT.notify(opp, nick(uid) + ' czeka na Ciebie w turnieju „' + t.name + '”. Wejdź i naciśnij „Graj”.', '#/tournament/' + tm.tid);
    RT.toUser(uid, { t: 'notice', msg: 'Czekamy na rywala. Gdy naciśnie „Graj”, partia ruszy.' });
    return;
  }
  if (RT.activeFor(opp)) return err('Rywal gra teraz inną partię');
  const game = G.gameById(t.game_id), a = RT.humanInfo(tm.p1, game.id), b = RT.humanInfo(tm.p2, game.id), flip = Math.random() < 0.5;
  const m = RT.startMatch({ game, p1: flip ? a : b, p2: flip ? b : a, rated: false, mode: 'tournament', tmId });
  D.run("UPDATE tournament_matches SET status='playing',match_id=? WHERE id=?", m.id, tmId);
  ready.delete(tmId);
}

function setWinner(tmId, uid) {
  const tm = D.get('SELECT * FROM tournament_matches WHERE id=?', tmId);
  if (!tm || tm.status === 'done' || (uid !== tm.p1 && uid !== tm.p2)) return false;
  D.run("UPDATE tournament_matches SET status='done',winner=? WHERE id=?", uid, tmId);
  ready.delete(tmId);
  propagate(tm.tid);
  return true;
}

function onMatchEnd(m) {
  if (!m.tmId) return;
  const tm = D.get('SELECT * FROM tournament_matches WHERE id=?', m.tmId);
  if (!tm || tm.status === 'done') return;
  const w = m.result.winner;
  if (w === 0) {
    D.run("UPDATE tournament_matches SET status='ready',match_id=NULL WHERE id=?", tm.id);
    [tm.p1, tm.p2].forEach((u) => RT.notify(u, 'Remis w turnieju. Zagrajcie dogrywkę (naciśnij „Graj”).', '#/tournament/' + tm.tid));
    return;
  }
  const uid = m.players[w - 1].uid;
  setWinner(tm.id, uid);
}

function detail(tid, meId) {
  const t = D.get('SELECT * FROM tournaments WHERE id=?', tid);
  if (!t) return null;
  const g = G.gameById(t.game_id);
  const players = D.all('SELECT tp.user_id,tp.seed,u.nick,u.hue FROM tournament_players tp JOIN users u ON u.id=tp.user_id WHERE tp.tid=? ORDER BY COALESCE(tp.seed,9999), tp.joined_at', tid);
  const tms = D.all('SELECT * FROM tournament_matches WHERE tid=? ORDER BY round,slot', tid).map((m) => ({
    id: m.id, round: m.round, slot: m.slot, p1: m.p1, p2: m.p2, n1: nick(m.p1), n2: nick(m.p2), winner: m.winner, status: m.status, bye: !!m.bye, matchId: m.match_id,
    ready: Array.from(ready.get(m.id) || [])
  }));
  const rounds = tms.length ? Math.max(...tms.map((m) => m.round)) : 0;
  return {
    id: t.id, name: t.name, game: { slug: g.slug, name: g.name, icon: g.icon, hue: g.hue }, startAt: t.start_at, maxPlayers: t.max_players,
    format: t.format, prize: t.prize, sponsor: t.sponsor, description: t.description, status: t.status,
    winner: t.winner_id ? { id: t.winner_id, nick: nick(t.winner_id) } : null, players: players.map((p) => ({ id: p.user_id, nick: p.nick, hue: p.hue, seed: p.seed })),
    joined: !!(meId && players.some((p) => p.user_id === meId)), matches: tms, rounds
  };
}

setInterval(() => {
  for (const t of D.all("SELECT id FROM tournaments WHERE status='open' AND start_at<=?", D.now())) { try { start(t.id); } catch (e) { console.error('tournament start', e); } }
}, 15000).unref();
RT.setHooks({ tmReady: onReady, matchEnd: onMatchEnd });

module.exports = { start, detail, setWinner, propagate };
