'use strict';
/* Osiągnięcia: wyliczane na bieżąco z istniejących danych (partie, rankingi, forum) – bez nowych tabel i bez możliwości „nabijania” przez klienta.
 * Każde ma cel liczbowy, więc interfejs pokazuje postęp („7/10”), a nie tylko odznakę. Bez losowości, bez zakładów, bez presji czasu. */
const D = require('./db');

const DEFS = [
  ['first_game', '🎯', 'Pierwsza partia', 'Zagraj i dokończ pierwszą partię', 'games', 1],
  ['games_25', '🎲', 'Stały gracz', 'Dokończ 25 partii', 'games', 25],
  ['games_100', '🏅', 'Weteran kartki', 'Dokończ 100 partii', 'games', 100],
  ['first_win', '🥇', 'Pierwsze zwycięstwo', 'Wygraj partię', 'wins', 1],
  ['wins_10', '🔥', 'Dziesięć wygranych', 'Wygraj 10 partii', 'wins', 10],
  ['wins_50', '👑', 'Pięćdziesiąt wygranych', 'Wygraj 50 partii', 'wins', 50],
  ['online_win', '🌐', 'Pojedynek na żywo', 'Wygraj z prawdziwym graczem', 'pvpWins', 1],
  ['hard_bot', '🤖', 'Pogromca Hektora', 'Pokonaj bota na poziomie Trudnym', 'hardWins', 1],
  ['streak_3', '⚡', 'Seria 3', 'Wygraj 3 partie rankingowe z rzędu', 'streak', 3],
  ['streak_5', '⚡', 'Seria 5', 'Wygraj 5 partii rankingowych z rzędu', 'streak', 5],
  ['streak_10', '🚀', 'Seria 10', 'Wygraj 10 partii rankingowych z rzędu', 'streak', 10],
  ['explorer', '🧭', 'Odkrywca', 'Zagraj w 5 różnych gier', 'kinds', 5],
  ['rating_1400', '📈', 'Ranking 1400', 'Osiągnij 1400 punktów w dowolnej grze', 'peak', 1400],
  ['forum_first', '💬', 'Głos w dyskusji', 'Napisz pierwszy post na forum', 'posts', 1],
  ['forum_25', '📝', 'Aktywny forumowicz', 'Napisz 25 postów na forum', 'posts', 25]
];

function stats(uid) {
  const me = '(p1=? OR p2=?) AND ended_at IS NOT NULL AND result IS NOT NULL';
  const won = '((p1=? AND result=1) OR (p2=? AND result=2))';
  const n = (sql, ...a) => D.get(sql, ...a).n;
  return {
    games: n(`SELECT COUNT(*) AS n FROM matches WHERE ${me}`, uid, uid),
    wins: n(`SELECT COUNT(*) AS n FROM matches WHERE ${me} AND ${won}`, uid, uid, uid, uid),
    pvpWins: n(`SELECT COUNT(*) AS n FROM matches WHERE ${me} AND bot_side=0 AND p1 IS NOT NULL AND p2 IS NOT NULL AND p1<>p2 AND ${won}`, uid, uid, uid, uid),
    hardWins: n(`SELECT COUNT(*) AS n FROM matches WHERE ${me} AND bot_level='h' AND ${won}`, uid, uid, uid, uid),
    kinds: n(`SELECT COUNT(DISTINCT game_id) AS n FROM matches WHERE ${me}`, uid, uid),
    streak: D.get('SELECT COALESCE(MAX(best_streak),0) AS n FROM ratings WHERE user_id=?', uid).n,
    peak: D.get('SELECT COALESCE(MAX(peak),0) AS n FROM ratings WHERE user_id=?', uid).n,
    posts: n('SELECT COUNT(*) AS n FROM forum_posts WHERE user_id=?', uid)
  };
}
/** Lista osiągnięć użytkownika: { id, icon, name, desc, goal, value (przycięte do celu), done } */
function forUser(uid) {
  const s = stats(uid);
  return DEFS.map(([id, icon, name, desc, key, goal]) => ({ id, icon, name, desc, goal, value: Math.min(goal, s[key] || 0), done: (s[key] || 0) >= goal }));
}
module.exports = { forUser, DEFS };
