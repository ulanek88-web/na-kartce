'use strict';
/* Test obciążeniowy (lokalny, na tymczasowej bazie): rosnąca liczba jednoczesnych graczy.
 * Użycie:  node tools/loadtest.js [etapy=25,100,250,500] [sekundy_na_etap=15]
 * Każdy wirtualny gracz: połączenie WebSocket, gra w kolejce w „kółko i krzyżyk” (losowe ruchy), a co kilka sekund pyta REST API (lobby, gry, ranking).
 * Mierzy: opóźnienie REST (p50/p95/p99), opóźnienie WebSocket (ping→pong), czas od ruchu do aktualizacji partii, błędy, RSS i CPU procesu serwera.
 * UWAGA: generator obciążenia działa na tej samej maszynie co serwer – wyniki są dolnym oszacowaniem i NIE są deklaracją pojemności produkcyjnej. */
const os = require('os'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const stages = (process.argv[2] || '25,100,250,500').split(',').map(Number), secs = Number(process.argv[3]) || 15, PORT = 3900 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-load-')); process.env.DATA_DIR = dir; process.env.ADMIN_PASSWORD = 'LoadTest12345';
const D = require('../server/db'), A = require('../server/auth'); require('../server/migrations')(D);
const MAX = Math.max(...stages), users = [], now = Date.now();
for (let i = 0; i < MAX; i++) {
  const nick = 'lt' + i, id = D.run('INSERT INTO users(nick,nick_lc,email,email_lc,guest,hue,created_at,last_seen) VALUES(?,?,?,?,0,?,?,?)', nick, nick, nick + '@x.pl', nick + '@x.pl', i % 360, now, now).id;
  users.push({ id, token: A.issue(D.get('SELECT * FROM users WHERE id=?', id)) });
}
D.close();
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env: Object.assign({}, process.env, { PORT, MAX_WS: '20000', WS_PER_IP: '20000', AI_WORKERS: '2' }), stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
const cpuTicks = () => { const s = fs.readFileSync('/proc/' + srv.pid + '/stat', 'utf8').split(' '); return Number(s[13]) + Number(s[14]); };
const rssMb = () => { try { return Math.round(Number(fs.readFileSync('/proc/' + srv.pid + '/statm', 'utf8').split(' ')[1]) * 4096 / 1048576); } catch (e) { return 0; } };
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:' + PORT;
const fresh = () => ({ rest: [], restErr: 0, ping: [], mv: [], wsErr: 0, wsClosed: 0, moves: 0, matches: 0, http5xx: 0 });
let M = fresh(); const bots = [];
function startBot(u) {
  const b = { u, ws: null, alive: true, match: null, pingAt: 0, moveAt: 0 };
  const connect = () => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws?token=' + encodeURIComponent(u.token)); b.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'queue', game: 'kolko-krzyzyk', rated: false })); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'pong' && b.pingAt) { M.ping.push(Date.now() - b.pingAt); b.pingAt = 0; }
      else if (m.t === 'error' && !/Pisz|Za dużo/.test(m.msg)) M.wsErr++;
      else if (m.t === 'match') {
        if (b.moveAt) { M.mv.push(Date.now() - b.moveAt); b.moveAt = 0; }
        const x = m.m; if (!b.match || b.match.id !== x.id) M.matches++; b.match = x;
        if (x.status === 'over') { b.match = null; setTimeout(() => { if (b.alive && ws.readyState === 1) ws.send(JSON.stringify({ t: 'queue', game: 'kolko-krzyzyk', rated: false })); }, 500 + Math.random() * 1500); }
        else if (x.turn === x.you) setTimeout(() => {
          if (!b.alive || ws.readyState !== 1 || !b.match) return; const free = []; for (let i = 0; i < 9; i++) if (!x.state.b[i]) free.push(i); if (!free.length) return;
          b.moveAt = Date.now(); M.moves++; ws.send(JSON.stringify({ t: 'move', id: x.id, move: free[Math.floor(Math.random() * free.length)] }));
        }, 150 + Math.random() * 400);
      }
    };
    ws.onclose = () => { M.wsClosed++; if (b.alive) setTimeout(connect, 1000 + Math.random() * 2000); };
    ws.onerror = () => {};
  };
  connect();
  b.timer = setInterval(() => { if (b.ws && b.ws.readyState === 1) { b.pingAt = Date.now(); b.ws.send(JSON.stringify({ t: 'ping' })); } }, 4000 + Math.random() * 2000);
  b.rest = setInterval(async () => {
    const url = ['/api/lobby', '/api/games', '/api/ranking?game=szachy', '/api/forum'][Math.floor(Math.random() * 4)], t0 = Date.now();
    try { const r = await fetch(base + url, { headers: { Authorization: 'Bearer ' + u.token } }); if (r.status >= 500) M.http5xx++; await r.arrayBuffer(); M.rest.push(Date.now() - t0); } catch (e) { M.restErr++; }
  }, 3000 + Math.random() * 3000);
  bots.push(b); return b;
}
(async () => {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) { await sleep(100); } }
  const rows = [];
  console.log('CPU: ' + os.cpus().length + ' rdzeni (' + os.cpus()[0].model.trim() + '), RAM: ' + Math.round(os.totalmem() / 1e9) + ' GB, Node ' + process.version + '\n');
  console.log('graczy | REST p50/p95/p99 ms | WS ping p50/p95/p99 ms | ruch→update p95 ms | partii | błędy REST/WS/5xx/rozłączeń | RSS MB | CPU serwera %');
  for (const n of stages) {
    while (bots.length < n) { startBot(users[bots.length]); if (bots.length % 25 === 0) await sleep(50); }
    await sleep(3000);                                   // rozgrzewka po dołączeniu nowych graczy
    M = fresh(); const c0 = cpuTicks(), t0 = Date.now(); await sleep(secs * 1000);
    const cpu = (cpuTicks() - c0) / 100 / ((Date.now() - t0) / 1000) * 100;
    const row = [n, [pct(M.rest, .5), pct(M.rest, .95), pct(M.rest, .99)].join('/'), [pct(M.ping, .5), pct(M.ping, .95), pct(M.ping, .99)].join('/'), pct(M.mv, .95), M.matches, [M.restErr, M.wsErr, M.http5xx, M.wsClosed].join('/'), rssMb(), cpu.toFixed(0)];
    rows.push(row); console.log(row.join(' | '));
  }
  bots.forEach((b) => { b.alive = false; clearInterval(b.timer); clearInterval(b.rest); try { b.ws.close(); } catch (e) { /* ignore */ } });
  await sleep(1500); console.log('\nRSS po zakończeniu obciążenia: ' + rssMb() + ' MB');
  if (/Error|error|TypeError/.test(srvLog.replace(/ExperimentalWarning/g, ''))) console.log('\nLOG SERWERA (błędy):\n' + srvLog.split('\n').filter((l) => /rror/.test(l)).slice(0, 8).join('\n'));
  srv.kill('SIGTERM'); await sleep(500); process.exit(0);
})();
