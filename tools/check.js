'use strict';
/* Kontrola składni wszystkich plików JS (serwer, klient, panel, testy, narzędzia) + proste skanowanie sekretów. Kod wyjścia 1 przy błędzie. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), skip = new Set(['node_modules', '.git', 'data', 'www', 'android']);
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (skip.has(e.name)) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|mjs)$/.test(e.name)) files.push(f); } })(root);
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8'), esm = /^\s*(import|export)\s/m.test(src) && !/require\(/.test(src.split('\n').slice(0, 20).join('\n'));
  const r = spawnSync(process.execPath, ['--check', ...(esm ? ['--input-type=module'] : []), ...(esm ? [] : [f])], { input: esm ? src : undefined, encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error('✗ ' + path.relative(root, f) + '\n' + r.stderr.split('\n').slice(0, 4).join('\n')); }
}
const SECRET = [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9]{32,}/];
for (const f of files.concat(['.env.example', 'Dockerfile', 'docker-compose.yml'].map((x) => path.join(root, x)).filter(fs.existsSync))) { const s = fs.readFileSync(f, 'utf8'); for (const re of SECRET) if (re.test(s)) { bad++; console.error('✗ możliwy sekret w ' + path.relative(root, f)); } }
if (fs.existsSync(path.join(root, 'data')) && /^\/?data/m.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')) === false) { bad++; console.error('✗ data/ nie jest w .gitignore'); }
console.log(bad ? 'NIEPOWODZENIE: ' + bad : 'OK: składnia ' + files.length + ' plików JS i skan sekretów – bez uwag'); process.exit(bad ? 1 : 0);
