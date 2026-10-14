/* Na kartce — SDK dla gier-pluginów (ładowane w <iframe sandbox>).
 *
 *   NaKartce.register({
 *     init(ctx)  { ctx.config, ctx.user }   // jednorazowo, po załadowaniu
 *     render()   { }                         // narysuj / odśwież interfejs
 *     start()    { }                         // rozpocznij grę
 *     reset()    { }                         // zacznij od nowa
 *     destroy()  { }                         // sprzątanie przed zamknięciem
 *   });
 *   NaKartce.emit('state', 'started' | 'over');   // zdarzenia stanu gry
 *   NaKartce.emit('score', 120);                  // wynik
 * Konfiguracja zdalna (ctx.config) pochodzi z panelu administratora i może się zmieniać bez restartu serwera;
 * zmiany dociera przez opcjonalną metodę onConfig(config). */
(function () {
  'use strict';
  var game = null, ctx = { config: {}, user: {} };
  function call(n, a) { try { if (game && typeof game[n] === 'function') game[n](a); } catch (e) { console.error('[plugin]', n, e); } }
  window.addEventListener('message', function (e) {
    var m = e.data; if (e.source !== window.parent || !m || m.nk !== 'cmd') return;
    if (m.cmd === 'init') { ctx = { config: m.config || {}, user: m.user || {} }; call('init', ctx); call('render'); }
    else if (m.cmd === 'config') { ctx.config = m.config || {}; call('onConfig', ctx.config); call('render'); }
    else call(m.cmd);
  });
  window.NaKartce = {
    register: function (g) { game = g; window.parent.postMessage({ nk: 'ready' }, '*'); },
    emit: function (type, payload) { window.parent.postMessage({ nk: 'event', type: type, payload: payload }, '*'); }
  };
})();
