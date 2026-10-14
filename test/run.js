#!/usr/bin/env node
'use strict';
/* Uruchamiacz testów: pliki *.test.js startują równolegle (każdy ma własną tymczasową bazę i port), z limitem czasu na plik.
 * Zawieszony test jest zabijany i zgłaszany z ostatnim fragmentem wyjścia – zamiast po cichu przekraczać limit całego zestawu.
 * Użycie: node test/run.js [filtr]   (np. node test/run.js security)   Zmienna TEST_TIMEOUT_S – limit na plik (domyślnie 180 s). */
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const filter = process.argv[2] || '', limit = (Number(process.env.TEST_TIMEOUT_S) || 180) * 1000;
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
const t0 = Date.now(); let failed = 0;
const run = (f) => new Promise((resolve) => {
  const start = Date.now(), p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, f)], { cwd: path.join(__dirname, '..') });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { out += '\n[run.js] PRZEKROCZONO LIMIT CZASU ' + limit / 1000 + ' s – test zabity\n'; p.kill('SIGKILL'); }, limit);
  p.on('close', (code, sig) => { clearTimeout(timer); resolve({ f, code, sig, out, ms: Date.now() - start }); });
});
(async () => {
  const results = await Promise.all(files.map(run));
  for (const r of results) {
    const summary = (r.out.split('\n').filter((l) => /^OK:/.test(l)).pop() || '').trim();
    const bad = r.code !== 0;
    console.log((bad ? '✗ ' : '✓ ') + r.f.padEnd(28) + String(Math.round(r.ms / 100) / 10).padStart(6) + ' s  ' + (bad ? 'BŁĄD (kod ' + r.code + (r.sig ? ', ' + r.sig : '') + ')' : summary));
    if (bad) { failed++; console.log(r.out.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(-25).join('\n')); }
  }
  console.log('\n' + (failed ? 'NIEPOWODZENIE: ' + failed + ' z ' + files.length + ' plików' : 'WSZYSTKIE ' + files.length + ' plików testowych zakończone powodzeniem') + ' (' + Math.round((Date.now() - t0) / 100) / 10 + ' s łącznie)');
  process.exit(failed ? 1 : 0);
})();
