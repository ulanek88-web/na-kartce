/* 67 nocy apokalipsy — wersja webowa (plugin portalu „Na kartce”).
 * Port prototypu Roblox (GameConfig / ResourceService / BaseService / DayNightService) na Canvas 2D:
 * 4 typy baz, drewno i złom, ulepszanie rdzenia (poziomy 1–4), cykl dzień/noc, numerowanie nocy, najazdy zombie. */
(function () {
  'use strict';
  const W = 800, H = 700, CX = W / 2, CY = H / 2;
  const $ = (id) => document.getElementById(id);

  /* ---------- konfiguracja (ta sama struktura co GameConfig.lua; 67 nocy x 215 s (130 s dzień + 85 s noc) ≈ 4 godziny) ---------- */
  const DEF = { dayLengthSec: 130, nightLengthSec: 85, maxNight: 67, resourceRespawnSec: 45, difficulty: 1 };
  const LIM = { dayLengthSec: [10, 600], nightLengthSec: [10, 600], maxNight: [1, 200], resourceRespawnSec: [5, 300], difficulty: [0.3, 3] };
  const AMOUNTS = { wood: [2, 5], scrap: [1, 4] };
  const MAX_LVL = 4;
  const BASES = {
    garage:    { name: 'Garaż',                     color: '#73787d', costs: { 2: [20, 10], 3: [45, 35], 4: [80, 75] } },
    subway:    { name: 'Wejście do metra',          color: '#465f73', costs: { 2: [15, 20], 3: [35, 45], 4: [60, 90] } },
    warehouse: { name: 'Magazyn',                   color: '#91734b', costs: { 2: [25, 10], 3: [55, 30], 4: [90, 65] } },
    apartment: { name: 'Ufortyfikowane mieszkanie', color: '#5f7d55', costs: { 2: [30, 5],  3: [60, 25], 4: [100, 55] } }
  };
  const REPAIR = { wood: 8, scrap: 4, frac: 0.3 };

  let cfg = Object.assign({}, DEF);
  function mergeCfg(c) {
    const o = Object.assign({}, DEF);
    c = c && typeof c === 'object' ? c : {};
    for (const k in DEF) { const v = Number(c[k]); if (c[k] != null && isFinite(v)) o[k] = Math.min(LIM[k][1], Math.max(LIM[k][0], v)); }
    o.maxNight = Math.round(o.maxNight);
    return o;
  }

  /* ---------- stan ---------- */
  let S = null, raf = 0, last = 0, hudT = 0, running = false, userNick = '';
  const keys = {}; let joy = null, atkHeld = false;
  const cv = $('cv'), ctx = cv.getContext('2d');
  const dark = document.createElement('canvas'), dctx = dark.getContext('2d');
  let view = { s: 1, ox: 0, oy: 0, dpr: 1, cw: 0, ch: 0 };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rint = (a, b) => Math.floor(rnd(a, b + 1));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const coreMax = (lvl) => 120 + 80 * (lvl - 1);
  const dayLen = () => cfg.dayLengthSec, nightLen = () => cfg.nightLengthSec;

  function fresh() {
    return {
      phase: 'pick', night: 1, t: 0, wood: 0, scrap: 0, lvl: 1, base: null, coreHp: coreMax(1),
      p: { x: CX, y: CY + 70, hp: 100, dead: false, respawn: 0, atkCd: 0, lastHit: -9, swing: 0, fx: 0, fy: 1 },
      nodes: [], ruins: [], zombies: [], fx: [], spawnTotal: 0, spawned: 0, spawnT: 0, turretCd: 1,
      kills: 0, survived: 0, clock: 0, won: false
    };
  }

  function buildWorld() {
    const n = [];
    const place = (type, count) => {
      let guard = 0;
      while (count > 0 && guard++ < 500) {
        const a = rnd(0, Math.PI * 2), r = rnd(110, 320), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r * 0.95;
        if (x < 30 || x > W - 30 || y < 30 || y > H - 30) continue;
        if (n.some((q) => Math.hypot(q.x - x, q.y - y) < 46)) continue;
        n.push({ type, x, y, active: true, respawn: 0 }); count--;
      }
    };
    place('wood', 9); place('scrap', 9);
    S.nodes = n;
    for (let i = 0; i < 14; i++) {
      const w = rnd(30, 70), h = rnd(24, 55), x = rnd(10, W - w - 10), y = rnd(10, H - h - 10);
      if (Math.hypot(x + w / 2 - CX, y + h / 2 - CY) < 110) continue;
      S.ruins.push({ x, y, w, h, c: 28 + rint(0, 14) });
    }
  }

  /* ---------- przebieg gry ---------- */
  function newRun() {
    S = fresh(); buildWorld();
    $('ovEnd').classList.remove('show'); $('ovBase').classList.add('show');
    $('ovMax').textContent = cfg.maxNight; $('hMax').textContent = cfg.maxNight;
    hud(true);
  }
  function chooseBase(key) {
    if (!S || S.phase !== 'pick') return;
    S.base = key; S.phase = 'day'; S.t = 0;
    $('ovBase').classList.remove('show');
    float(CX, CY - 60, BASES[key].name, '#fff');
    NaKartce.emit('state', 'started'); emitScore(); hud(true);
  }
  const emitScore = () => NaKartce.emit('score', S.survived * 100 + S.kills);

  function float(x, y, text, color) { S.fx.push({ k: 'txt', x, y, text, color: color || '#fff', t: 0, life: 1.2 }); }

  function startNight() {
    S.phase = 'night'; S.t = 0;
    S.spawnTotal = Math.min(80, Math.round((4 + S.night * 1.4) * cfg.difficulty));
    S.spawned = 0; S.spawnT = 1;
    float(CX, CY - 80, 'Noc ' + S.night + ' — zombie nadchodzą!', '#ff9a8a');
  }
  function dawn() {
    S.zombies.length = 0;
    S.survived = S.night; emitScore();
    if (S.night >= cfg.maxNight) return finish(true);
    S.night++; S.phase = 'day'; S.t = 0;
    S.coreHp = Math.min(coreMax(S.lvl), S.coreHp + coreMax(S.lvl) * 0.3);
    float(CX, CY - 80, 'Świt! Przetrwano noc ' + S.survived, '#ffe08a');
  }
  function finish(won) {
    S.phase = 'over'; S.won = won;
    $('endTitle').textContent = won ? '🏆 Przetrwałeś wszystkie ' + cfg.maxNight + ' nocy!' : '☠ Rdzeń bazy został zniszczony';
    $('endText').textContent = (won ? 'Miasto jest bezpieczne. ' : '') + 'Przetrwane noce: ' + S.survived + ' · zabite zombie: ' + S.kills + ' · poziom bazy: ' + S.lvl + '/' + MAX_LVL + ' · wynik: ' + (S.survived * 100 + S.kills);
    $('ovEnd').classList.add('show');
    NaKartce.emit('score', S.survived * 100 + S.kills); NaKartce.emit('state', 'over');
  }

  function spawnZombie() {
    const side = rint(0, 3); let x, y;
    if (side === 0) { x = rnd(0, W); y = -12; } else if (side === 1) { x = W + 12; y = rnd(0, H); } else if (side === 2) { x = rnd(0, W); y = H + 12; } else { x = -12; y = rnd(0, H); }
    const n = S.night, hp = 3 + n * 0.45;
    S.zombies.push({ x, y, hp, max: hp, speed: (34 + Math.min(n, 40) * 0.9) * rnd(0.8, 1.2), dmg: 6 * (1 + n * 0.02) * cfg.difficulty, hit: 0 });
  }

  function upgradeCost() { return S.lvl < MAX_LVL ? BASES[S.base].costs[S.lvl + 1] : null; }
  const nearCore = () => !S.p.dead && Math.hypot(S.p.x - CX, S.p.y - CY) < 95;
  function canUpgrade() { const c = S && S.base && upgradeCost(); return !!(c && nearCore() && S.wood >= c[0] && S.scrap >= c[1] && (S.phase === 'day' || S.phase === 'night')); }
  function canRepair() { return !!(S && S.base && nearCore() && S.coreHp < coreMax(S.lvl) - 0.5 && S.wood >= REPAIR.wood && S.scrap >= REPAIR.scrap && (S.phase === 'day' || S.phase === 'night')); }
  function upgrade() {
    if (!canUpgrade()) return;
    const c = upgradeCost(); S.wood -= c[0]; S.scrap -= c[1];
    const frac = S.coreHp / coreMax(S.lvl); S.lvl++; S.coreHp = coreMax(S.lvl) * Math.max(frac, 0.5);
    float(CX, CY - 50, 'Rdzeń: poziom ' + S.lvl, '#8ee7a1'); hud(true);
  }
  function repair() {
    if (!canRepair()) return;
    S.wood -= REPAIR.wood; S.scrap -= REPAIR.scrap;
    S.coreHp = Math.min(coreMax(S.lvl), S.coreHp + coreMax(S.lvl) * REPAIR.frac);
    float(CX, CY - 50, 'Naprawiono', '#8ee7a1'); hud(true);
  }
  function skipDay() { if (S && S.phase === 'day') S.t = dayLen(); }
  function attack() {
    const p = S.p; if (!S || (S.phase !== 'day' && S.phase !== 'night') || p.dead || p.atkCd > 0) return;
    p.atkCd = 0.4; p.swing = 0.15;
    for (const z of S.zombies) {
      const d = dist(p, z);
      if (d < 54) { z.hp -= 3; z.hit = 0.12; const k = 14 / (d || 1); z.x += (z.x - p.x) * k * 0.02 * 10; z.y += (z.y - p.y) * k * 0.02 * 10; }
    }
  }

  /* ---------- aktualizacja ---------- */
  function update(dt) {
    S.clock += dt;
    for (const f of S.fx) f.t += dt;
    S.fx = S.fx.filter((f) => f.t < f.life);
    if (S.phase !== 'day' && S.phase !== 'night') return;
    const p = S.p;

    // ruch gracza
    let mx = 0, my = 0;
    if (keys.ArrowLeft || keys.a) mx -= 1; if (keys.ArrowRight || keys.d) mx += 1;
    if (keys.ArrowUp || keys.w) my -= 1; if (keys.ArrowDown || keys.s) my += 1;
    if (joy) { const dx = joy.x - joy.ox, dy = joy.y - joy.oy, l = Math.hypot(dx, dy); if (l > 8) { const m = Math.min(1, l / 50); mx = dx / l * m; my = dy / l * m; } }
    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    if (p.dead) { p.respawn -= dt; if (p.respawn <= 0) { p.dead = false; p.hp = 100; p.x = CX; p.y = CY + 70; } }
    else {
      p.x = Math.min(W - 12, Math.max(12, p.x + mx * 150 * dt)); p.y = Math.min(H - 12, Math.max(12, p.y + my * 150 * dt));
      if (ml > 0.1) { p.fx = mx / (ml || 1); p.fy = my / (ml || 1); }
      p.atkCd = Math.max(0, p.atkCd - dt); p.swing = Math.max(0, p.swing - dt);
      if (atkHeld || keys[' ']) attack();
      if (S.clock - p.lastHit > 3 && p.hp < 100) p.hp = Math.min(100, p.hp + 6 * dt);
    }

    // zasoby
    for (const n of S.nodes) {
      if (!n.active) { n.respawn -= dt; if (n.respawn <= 0) n.active = true; continue; }
      if (!p.dead && Math.hypot(p.x - n.x, p.y - n.y) < 24) {
        const a = AMOUNTS[n.type], v = rint(a[0], a[1]);
        if (n.type === 'wood') { S.wood += v; float(n.x, n.y - 14, '+' + v + ' 🪵', '#e3b57a'); } else { S.scrap += v; float(n.x, n.y - 14, '+' + v + ' ⚙️', '#c4cbd6'); }
        n.active = false; n.respawn = cfg.resourceRespawnSec;
      }
    }

    // cykl dnia i nocy
    S.t += dt;
    if (S.phase === 'day' && S.t >= dayLen()) startNight();
    else if (S.phase === 'night') {
      if (S.spawned < S.spawnTotal) {
        S.spawnT -= dt;
        if (S.spawnT <= 0) { spawnZombie(); S.spawned++; S.spawnT = Math.max(0.15, nightLen() * 0.75 / S.spawnTotal); }
      }
      if (S.t >= nightLen()) { dawn(); return; }
    }

    // wieżyczka rdzenia (od poziomu 2)
    if (S.lvl >= 2 && S.zombies.length) {
      S.turretCd -= dt;
      if (S.turretCd <= 0) {
        let best = null, bd = 175; for (const z of S.zombies) { const d = Math.hypot(z.x - CX, z.y - CY); if (d < bd) { bd = d; best = z; } }
        if (best) { best.hp -= 1 + S.lvl * 0.5; best.hit = 0.1; S.fx.push({ k: 'ray', x1: CX, y1: CY - 10, x2: best.x, y2: best.y, t: 0, life: 0.12 }); S.turretCd = 1.5 - 0.25 * (S.lvl - 2); } else S.turretCd = 0.2;
      }
    }

    // zombie
    const core = { x: CX, y: CY }, reach = 34 + 11 + 3;
    for (const z of S.zombies) {
      z.hit = Math.max(0, z.hit - dt);
      const chase = !p.dead && dist(z, p) < 130, tg = chase ? p : core;
      const d = dist(z, tg) || 1;
      if (!chase && d <= reach) { S.coreHp -= z.dmg * dt; continue; }
      if (chase && d < 20) { p.hp -= 10 * (1 + S.night * 0.02) * cfg.difficulty * dt; p.lastHit = S.clock; continue; }
      z.x += (tg.x - z.x) / d * z.speed * dt; z.y += (tg.y - z.y) / d * z.speed * dt;
    }
    const before = S.zombies.length;
    S.zombies = S.zombies.filter((z) => z.hp > 0);
    const killed = before - S.zombies.length;
    if (killed) { S.kills += killed; emitScore(); }

    if (!p.dead && p.hp <= 0) {
      p.dead = true; p.respawn = 4; p.hp = 0;
      S.wood = Math.floor(S.wood * 0.75); S.scrap = Math.floor(S.scrap * 0.75);
      float(p.x, p.y - 16, 'Zginąłeś (−25% surowców)', '#ff8a8a');
    }
    if (S.coreHp <= 0) { S.coreHp = 0; finish(false); }
  }

  /* ---------- rysowanie ---------- */
  function resize() {
    const st = $('stage'), r = st.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    view.dpr = dpr; view.cw = r.width; view.ch = r.height;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    dark.width = cv.width; dark.height = cv.height;
    view.s = Math.min(r.width / W, r.height / H); view.ox = (r.width - W * view.s) / 2; view.oy = (r.height - H * view.s) / 2;
    draw();
  }
  const toWorld = (cx, cy) => ({ x: (cx - view.ox) / view.s, y: (cy - view.oy) / view.s });

  function drawBase(b, lvl) {
    const c = ctx, w = 56 + lvl * 8, h = 44 + lvl * 6, x = CX - w / 2, y = CY - h / 2;
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(x + 4, y + 6, w, h);
    c.fillStyle = BASES[b].color; c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 2; c.strokeRect(x, y, w, h);
    c.fillStyle = 'rgba(0,0,0,.4)';
    if (b === 'garage') { c.fillRect(CX - w * 0.3, CY - h * 0.05, w * 0.6, h * 0.45); c.fillStyle = 'rgba(255,255,255,.15)'; for (let i = 0; i < 4; i++) c.fillRect(CX - w * 0.3, CY + i * 8, w * 0.6, 2); }
    else if (b === 'subway') { c.fillRect(CX - 14, CY - 6, 28, h / 2 + 2); c.fillStyle = '#ffd24a'; c.font = 'bold 14px system-ui'; c.textAlign = 'center'; c.fillText('M', CX, CY - 10); }
    else if (b === 'warehouse') { c.fillRect(x, y, w, 8); c.fillStyle = 'rgba(255,255,255,.18)'; for (let i = 1; i < 5; i++) c.fillRect(x + (w / 5) * i, y + 8, 2, h - 8); }
    else { c.fillStyle = 'rgba(255,230,140,.7)'; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) c.fillRect(x + 8 + i * (w - 24) / 2.2, y + 8 + j * 16, 9, 8); }
    c.fillStyle = '#fff'; c.font = 'bold 11px system-ui'; c.textAlign = 'center'; c.fillText('Lv ' + lvl, CX, y + h + 14);
  }

  function draw() {
    if (!S) return;
    const c = ctx, night = S.phase === 'night';
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.fillStyle = '#0b0d11'; c.fillRect(0, 0, view.cw, view.ch);
    c.setTransform(view.dpr * view.s, 0, 0, view.dpr * view.s, view.dpr * view.ox, view.dpr * view.oy);
    c.save(); c.beginPath(); c.rect(0, 0, W, H); c.clip();
    // podłoże i ulice
    c.fillStyle = '#39413a'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#2d3036'; c.fillRect(0, CY - 26, W, 52); c.fillRect(CX - 26, 0, 52, H);
    c.strokeStyle = 'rgba(230,200,90,.35)'; c.setLineDash([16, 14]); c.lineWidth = 2;
    c.beginPath(); c.moveTo(0, CY); c.lineTo(W, CY); c.moveTo(CX, 0); c.lineTo(CX, H); c.stroke(); c.setLineDash([]);
    for (const r of S.ruins) { c.fillStyle = 'rgb(' + r.c + ',' + (r.c + 3) + ',' + (r.c + 8) + ')'; c.fillRect(r.x, r.y, r.w, r.h); c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1; c.strokeRect(r.x, r.y, r.w, r.h); }
    // zasoby
    for (const n of S.nodes) {
      if (!n.active) { c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.arc(n.x, n.y + 4, 6, 0, 7); c.fill(); continue; }
      if (n.type === 'wood') { c.fillStyle = '#6b4a2b'; c.fillRect(n.x - 3, n.y - 2, 6, 12); c.fillStyle = '#3f7a46'; c.beginPath(); c.moveTo(n.x, n.y - 20); c.lineTo(n.x + 13, n.y + 2); c.lineTo(n.x - 13, n.y + 2); c.fill(); }
      else { c.fillStyle = '#8c94a3'; c.beginPath(); c.moveTo(n.x - 14, n.y + 9); c.lineTo(n.x - 7, n.y - 7); c.lineTo(n.x + 3, n.y - 1); c.lineTo(n.x + 10, n.y - 9); c.lineTo(n.x + 15, n.y + 9); c.fill(); c.fillStyle = '#c9a15a'; c.fillRect(n.x - 3, n.y + 1, 6, 4); }
    }
    // baza
    if (S.base) {
      drawBase(S.base, S.lvl);
      if (S.lvl >= 2) { c.strokeStyle = 'rgba(255,200,120,.12)'; c.lineWidth = 1; c.beginPath(); c.arc(CX, CY, 175, 0, 7); c.stroke(); }
      if (nearCore()) { c.strokeStyle = 'rgba(140,231,161,.45)'; c.setLineDash([5, 5]); c.beginPath(); c.arc(CX, CY, 95, 0, 7); c.stroke(); c.setLineDash([]); }
    }
    // zombie
    for (const z of S.zombies) {
      c.fillStyle = z.hit > 0 ? '#e8f5c8' : '#5f9a52'; c.beginPath(); c.arc(z.x, z.y, 11, 0, 7); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = '#c0392b'; c.fillRect(z.x - 6, z.y - 4, 3, 3); c.fillRect(z.x + 3, z.y - 4, 3, 3);
      if (z.hp < z.max) { c.fillStyle = '#000'; c.fillRect(z.x - 11, z.y - 19, 22, 4); c.fillStyle = '#e5484d'; c.fillRect(z.x - 11, z.y - 19, 22 * Math.max(0, z.hp / z.max), 4); }
    }
    // gracz
    const p = S.p;
    if (S.base) {
      if (p.dead) { c.fillStyle = 'rgba(255,255,255,.4)'; c.font = '20px system-ui'; c.textAlign = 'center'; c.fillText('✖', CX, CY + 76); c.font = '12px system-ui'; c.fillText(Math.ceil(p.respawn) + 's', CX, CY + 92); }
      else {
        if (p.swing > 0) { c.strokeStyle = 'rgba(255,255,255,' + (p.swing / 0.15) + ')'; c.lineWidth = 3; c.beginPath(); c.arc(p.x, p.y, 40, Math.atan2(p.fy, p.fx) - 0.9, Math.atan2(p.fy, p.fx) + 0.9); c.stroke(); }
        c.fillStyle = '#4aa3ff'; c.beginPath(); c.arc(p.x, p.y, 12, 0, 7); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
        c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x + p.fx * 7, p.y + p.fy * 7, 3, 0, 7); c.fill();
      }
    }
    // efekty
    for (const f of S.fx) {
      const a = 1 - f.t / f.life;
      if (f.k === 'txt') { c.globalAlpha = Math.min(1, a * 1.6); c.fillStyle = f.color; c.font = 'bold 14px system-ui'; c.textAlign = 'center'; c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 3; c.strokeText(f.text, f.x, f.y - f.t * 26); c.fillText(f.text, f.x, f.y - f.t * 26); c.globalAlpha = 1; }
      else if (f.k === 'ray') { c.globalAlpha = a; c.strokeStyle = '#ffd36b'; c.lineWidth = 2; c.beginPath(); c.moveTo(f.x1, f.y1); c.lineTo(f.x2, f.y2); c.stroke(); c.globalAlpha = 1; }
    }
    c.restore();
    // noc: ciemna nakładka z „światłem” wokół gracza i bazy
    if (night || S.phase === 'over') {
      const k = night ? Math.min(1, S.t / 3) : 0.6, d = dctx;
      d.setTransform(1, 0, 0, 1, 0, 0); d.globalCompositeOperation = 'source-over'; d.clearRect(0, 0, dark.width, dark.height);
      d.fillStyle = 'rgba(4,6,22,' + (0.72 * k) + ')'; d.fillRect(0, 0, dark.width, dark.height);
      d.globalCompositeOperation = 'destination-out';
      const light = (x, y, r) => { const X = (view.ox + x * view.s) * view.dpr, Y = (view.oy + y * view.s) * view.dpr, R = r * view.s * view.dpr, g = d.createRadialGradient(X, Y, R * 0.15, X, Y, R); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); d.fillStyle = g; d.beginPath(); d.arc(X, Y, R, 0, 7); d.fill(); };
      if (S.base) { light(CX, CY, 150); if (!S.p.dead) light(S.p.x, S.p.y, 120); }
      d.globalCompositeOperation = 'source-over';
      c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(dark, 0, 0);
    }
    // joystick
    if (joy) {
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.beginPath(); c.arc(joy.ox, joy.oy, 50, 0, 7); c.stroke();
      const dx = joy.x - joy.ox, dy = joy.y - joy.oy, l = Math.min(50, Math.hypot(dx, dy)), a = Math.atan2(dy, dx);
      c.fillStyle = 'rgba(255,255,255,.45)'; c.beginPath(); c.arc(joy.ox + Math.cos(a) * l, joy.oy + Math.sin(a) * l, 20, 0, 7); c.fill();
    }
  }

  /* ---------- interfejs ---------- */
  const cache = {};
  function setText(id, v) { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } }
  function hud(force) {
    if (!S) return;
    const day = S.phase !== 'night', left = Math.max(0, Math.ceil((day ? dayLen() : nightLen()) - S.t));
    const ph = $('phase'); const label = S.phase === 'night' ? 'NOC' : 'DZIEŃ'; if (cache.ph !== label) { cache.ph = label; ph.textContent = label; ph.className = S.phase === 'night' ? 'night' : ''; }
    setText('hNight', String(S.night)); setText('hMax', String(cfg.maxNight));
    setText('hTime', S.phase === 'pick' || S.phase === 'over' ? '–' : left + 's' + (S.phase === 'night' ? ' · zombie: ' + (S.zombies.length + S.spawnTotal - S.spawned) : ''));
    setText('hWood', String(S.wood)); setText('hScrap', String(S.scrap)); setText('hLvl', String(S.lvl));
    $('coreBar').style.width = (100 * S.coreHp / coreMax(S.lvl)) + '%';
    $('coreBar').style.background = S.coreHp / coreMax(S.lvl) < 0.3 ? 'var(--bad)' : 'var(--good)';
    $('hpBar').style.width = Math.max(0, S.p.hp) + '%';
    const cost = S.base && upgradeCost(), bu = $('bUp'), br = $('bRep'), bs = $('bSkip');
    bu.disabled = !canUpgrade(); br.disabled = !canRepair(); bs.disabled = S.phase !== 'day';
    const ut = cost ? '🪵' + cost[0] + ' ⚙️' + cost[1] : 'maksymalny poziom';
    if (cache.ut !== ut) { cache.ut = ut; bu.innerHTML = '⬆ Ulepsz <small>' + ut + '</small>'; }
    const rt = '🪵' + REPAIR.wood + ' ⚙️' + REPAIR.scrap; if (cache.rt !== rt) { cache.rt = rt; br.innerHTML = '🔧 Napraw <small>' + rt + '</small>'; }
    let hint = '';
    if (S.phase === 'day') hint = S.nodes.some((n) => n.active) ? 'Zbieraj drewno i złom — wejdź na surowiec. Wróć do bazy przed nocą.' : 'Surowce się odnawiają…';
    else if (S.phase === 'night') hint = 'Broń rdzenia! Atakuj zombie (spacja / ⚔).';
    if (S.base && cost && !nearCore() && S.phase === 'day') hint = 'Podejdź do rdzenia, aby ulepszyć lub naprawić bazę.';
    if (userNick && S.phase === 'day' && S.night === 1 && S.t < 6) hint = 'Powodzenia, ' + userNick + '! ' + hint;
    setText('hint', hint);
  }

  function loop(ts) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (ts - (last || ts)) / 1000); last = ts;
    if (S) { update(dt); draw(); if ((hudT += dt) > 0.1) { hudT = 0; hud(); } }
  }
  function run() { if (!running) { running = true; last = 0; raf = requestAnimationFrame(loop); } }

  /* ---------- sterowanie ---------- */
  const GAMEKEYS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', ' '];
  function onKey(e, down) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const kk = k.toLowerCase();
    if (GAMEKEYS.includes(kk)) { keys[k.length > 1 ? e.key : kk] = down; e.preventDefault(); }
    if (down && S) { if (kk === 'e') upgrade(); else if (kk === 'r') repair(); else if (kk === 'n') skipDay(); }
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; joy = null; atkHeld = false; });
  window.addEventListener('resize', resize);
  cv.addEventListener('pointerdown', (e) => { if (joy) return; const r = cv.getBoundingClientRect(); joy = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, x: e.clientX - r.left, y: e.clientY - r.top }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => { if (joy && joy.id === e.pointerId) { const r = cv.getBoundingClientRect(); joy.x = e.clientX - r.left; joy.y = e.clientY - r.top; } });
  const endJoy = (e) => { if (joy && joy.id === e.pointerId) joy = null; };
  cv.addEventListener('pointerup', endJoy); cv.addEventListener('pointercancel', endJoy);
  const bind = (id, fn) => $(id).addEventListener('click', () => { if (S) { fn(); hud(true); } });
  bind('bUp', upgrade); bind('bRep', repair); bind('bSkip', skipDay);
  const ba = $('bAtk');
  ba.addEventListener('pointerdown', (e) => { e.preventDefault(); atkHeld = true; if (S) attack(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => ba.addEventListener(ev, () => { atkHeld = false; }));
  $('again').addEventListener('click', () => { newRun(); });

  (function buildPicker() {
    const box = $('baseList');
    Object.keys(BASES).forEach((key) => {
      const b = BASES[key]; let w = 0, s = 0; for (const l in b.costs) { w += b.costs[l][0]; s += b.costs[l][1]; }
      const el = document.createElement('button'); el.className = 'base';
      el.innerHTML = '<i class="sw" style="background:' + b.color + '"></i><b>' + b.name + '</b><span>Do poz. 4: 🪵' + w + ' ⚙️' + s + '</span>';
      el.addEventListener('click', () => chooseBase(key)); box.appendChild(el);
    });
  })();

  /* ---------- interfejs gry-pluginu (SDK portalu) ---------- */
  NaKartce.register({
    init(c) { cfg = mergeCfg(c.config); userNick = (c.user && c.user.nick) || ''; resize(); newRun(); run(); },
    onConfig(c) { cfg = mergeCfg(c); $('ovMax').textContent = cfg.maxNight; },
    render() { resize(); hud(true); },
    start() { newRun(); run(); },
    reset() { newRun(); },
    destroy() { running = false; cancelAnimationFrame(raf); }
  });
})();
