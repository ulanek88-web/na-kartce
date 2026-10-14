/* Przykład implementacji interfejsu gry: init / render / start / reset / destroy */
let cfg = {}, score = 0, left = 0, tm = null;
const $ = (id) => document.getElementById(id);
NaKartce.register({
  init(ctx) { cfg = ctx.config; $('b').onclick = () => { if (left > 0) { score++; NaKartce.emit('score', score); this.render(); } }; },
  onConfig(c) { cfg = c; },
  render() { $('t').textContent = left > 0 ? `Czas: ${left}s · Wynik: ${score}` : `Koniec! Wynik: ${score}`; },
  start() { score = 0; left = cfg.roundSec || 10; NaKartce.emit('state', 'started'); clearInterval(tm); tm = setInterval(() => { left--; this.render(); if (left <= 0) { clearInterval(tm); NaKartce.emit('state', 'over'); } }, 1000); this.render(); },
  reset() { clearInterval(tm); score = 0; left = 0; this.render(); },
  destroy() { clearInterval(tm); }
});
