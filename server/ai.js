'use strict';
/* Pula wątków liczących ruchy botów (poza głównym wątkiem serwera).
 * - każdy worker liczy jedno zadanie naraz; reszta czeka w kolejce o ograniczonej długości (MAX_QUEUE),
 * - zadanie ma limit czasu (JOB_MS); zawieszony worker jest zabijany i uruchamiany od nowa,
 * - gdy kolejka jest pełna albo worker zawiedzie, zwracamy tani ruch losowy (nigdy nie liczymy ciężkiego AI w głównym wątku). */
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const E = require('../shared/engines');

const SIZE = Math.max(1, Math.min(4, Number(process.env.AI_WORKERS) || Math.floor(os.cpus().length / 2) || 1));
const MAX_QUEUE = Number(process.env.AI_MAX_QUEUE) || 200, JOB_MS = 9000;
const workers = [], queue = [];
let seq = 0;
const stats = { done: 0, fallback: 0, restarts: 0, maxQueue: 0 };

function randomMove(engineId, params, state) {
  try { const eng = E.make(engineId, params), L = eng.legal(state); return L.length ? L[Math.floor(Math.random() * L.length)] : null; } catch (e) { return null; }
}
function spawn(i) {
  const w = new Worker(path.join(__dirname, 'aiWorker.js'));
  w.job = null;
  w.on('message', (m) => {
    const j = w.job; if (!j || j.id !== m.id) return;
    clearTimeout(j.timer); w.job = null; stats.done++;
    if (m.error) { stats.fallback++; j.resolve(randomMove(j.engine, j.params, j.state)); } else j.resolve(m.move);
    pump();
  });
  w.on('error', () => { /* zdarzenie 'exit' zrestartuje worker */ });
  w.on('exit', () => {
    w.exited = true;
    const j = w.job; w.job = null;
    if (j) { clearTimeout(j.timer); stats.fallback++; j.resolve(randomMove(j.engine, j.params, j.state)); }
    stats.restarts++;
    setTimeout(() => { workers[i] = spawn(i); pump(); }, 500).unref();
  });
  w.unref();
  return w;
}
for (let i = 0; i < SIZE; i++) workers.push(spawn(i));

function pump() {
  for (const w of workers) {
    if (!queue.length) return;
    if (w.job || !w.threadId || w.exited) continue;
    const j = queue.shift();
    w.job = j;
    j.timer = setTimeout(() => { stats.fallback++; try { w.terminate(); } catch (e) { /* exit obsłuży resztę */ } }, JOB_MS);
    try { w.postMessage({ id: j.id, engine: j.engine, params: j.params, state: j.state, level: j.level }); } catch (e) { clearTimeout(j.timer); w.job = null; stats.fallback++; j.resolve(randomMove(j.engine, j.params, j.state)); }
  }
}

/** Zwraca ruch bota (Promise). */
function move(engine, params, state, level) {
  return new Promise((resolve) => {
    if (queue.length >= MAX_QUEUE) { stats.fallback++; return resolve(randomMove(engine, params, state)); }
    queue.push({ id: ++seq, engine, params, state, level, resolve });
    stats.maxQueue = Math.max(stats.maxQueue, queue.length);
    pump();
  });
}
module.exports = { move, stats, size: SIZE, queueLength: () => queue.length };
