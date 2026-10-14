#!/usr/bin/env node
'use strict';
/* Przygotowuje katalog www/ dla aplikacji Android (Capacitor):
   kopiuje public/ i shared/ oraz ustawia adres Twojego serwera w config.js.
   Użycie:  NK_SERVER=https://twoja-domena.pl node tools/prepare_www.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const server = (process.env.NK_SERVER || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^\s/]+/.test(server)) {
  console.error('Brak adresu serwera. Ustaw zmienną NK_SERVER, np.\n  NK_SERVER=https://nakartce.pl npm run cap:sync');
  process.exit(1);
}
if (server.startsWith('http://')) console.warn('UWAGA: adres http:// (bez szyfrowania) zadziała tylko po włączeniu "cleartext" – na produkcji użyj https://');
fs.rmSync(out, { recursive: true, force: true });
const skip = new Set(['admin', 'sw.js']);   // panel admina i service worker nie wchodzą do aplikacji
function copy(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (src === path.join(root, 'public') && skip.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); } else fs.copyFileSync(s, d);
  }
}
fs.mkdirSync(out, { recursive: true });
copy(path.join(root, 'public'), out);
fs.mkdirSync(path.join(out, 'shared'), { recursive: true });
copy(path.join(root, 'shared'), path.join(out, 'shared'));
const ws = server.replace(/^http/, 'ws');
fs.writeFileSync(path.join(out, 'config.js'), `window.NK_CONFIG = ${JSON.stringify({ apiBase: server, wsBase: ws })};\n`);
console.log('Gotowe: www/  (serwer: ' + server + ')');
