'use strict';
/* Pula botów: kolejka ograniczona, brak blokowania pętli zdarzeń, ruchy zawsze legalne, odporność na zalew zadań i awarię workera. */
process.env.AI_WORKERS = '1'; process.env.AI_MAX_QUEUE = '20';
const assert = require('assert'), AI = require('../server/ai'), E = require('../shared/engines');
const eng = E.make('chess', {}), s0 = eng.init();
(async () => {
  let maxLag = 0, last = Date.now();
  const lag = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 20); last = n; }, 20);
  const { performance } = require('perf_hooks'), elu0 = performance.eventLoopUtilization(), t0 = Date.now();
  const jobs = []; for (let i = 0; i < 120; i++) jobs.push(AI.move('chess', {}, s0, 'm'));
  const res = await Promise.all(jobs);
  clearInterval(lag);
  assert(res.every((m) => m && eng.legal(s0).some((x) => eng.mkey(x) === eng.mkey(m))), 'każdy wynik musi być legalnym ruchem');
  assert(AI.stats.fallback > 0 && AI.queueLength() === 0); console.log('  ✓ 120 zadań naraz przy kolejce 20: wszystkie legalne, ' + AI.stats.fallback + ' obsłużonych tanim ruchem, kolejka opróżniona (' + (Date.now() - t0) + ' ms)');
  const elu = performance.eventLoopUtilization(elu0).utilization;       // udział czasu, w którym główny wątek był zajęty (ciężkie AI w głównym wątku dawałoby ≈1.0)
  assert(elu < 0.5 && maxLag < 1500, 'główny wątek zajęty: ELU=' + elu.toFixed(2) + ', opóźnienie ' + maxLag + ' ms'); console.log('  ✓ obliczenia AI nie blokują głównego wątku (obciążenie pętli zdarzeń ' + Math.round(elu * 100) + '%, maks. opóźnienie ' + maxLag + ' ms)');
  const bad = await AI.move('nieistniejacy', {}, s0, 'm'); assert(bad === null); const ok2 = await AI.move('chess', {}, s0, 'e'); assert(ok2); console.log('  ✓ błędne zadanie nie psuje puli (kolejne działa)');
  console.log('\nOK: 3 testy puli botów'); process.exit(0);
})().catch((e) => { console.error('BŁĄD TESTU:', e); process.exit(1); });
