'use strict';
/* Wątek obliczający ruchy botów, żeby nie blokować serwera. */
const { parentPort } = require('worker_threads');
const E = require('../shared/engines');

parentPort.on('message', (job) => {
  try {
    const eng = E.make(job.engine, job.params);
    const move = eng.ai(job.state, job.level);
    parentPort.postMessage({ id: job.id, move });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e && e.message || e) });
  }
});
