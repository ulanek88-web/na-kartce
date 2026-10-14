/* Panel administratora — moduły dodatkowe: Układ gier (drag & drop), Pluginy gier, Ogłoszenia, Konfiguracja zdalna. */
export function init({ NAV, VIEWS, api, esc, toast, fmt, getToken }) {
  const at = (key) => NAV.findIndex((n) => n[0] === key);
  NAV.splice(at('games') + 1, 0, ['layout', 'Układ gier', 1], ['plugins', 'Pluginy', 1]);
  NAV.splice(at('content') + 1, 0, ['announce', 'Ogłoszenia', 'announce'], ['censor', 'Cenzura', 'censor'], ['superadmin', 'Konta i kopia', 1]);
  VIEWS.layout = vLayout; VIEWS.plugins = vPlugins; VIEWS.announce = vAnnounce; VIEWS.censor = vCensor; VIEWS.superadmin = vSuper;

  /* ---------- CENZURA: własne słowa filtra czatu (Moderator i Super Admin) ---------- */
  async function vCensor(v) {
    const draw = async () => {
      const list = await api('GET', '/api/admin/censor');
      v.innerHTML = `<h2>Cenzura czatu</h2><p class="muted small">Wbudowany słownik polskich wulgaryzmów działa zawsze. Tu dodajesz własne słowa (rdzenie, np. „brzydal”) – serwer odrzuca wiadomości z nimi i ich odmianami, bez restartu.</p>
        <form class="card row" id="cw" style="gap:8px"><input class="grow" name="word" placeholder="nowe słowo" maxlength="30" required><button class="btn pri" type="submit">Dodaj</button></form>
        <div class="card list" style="margin-top:10px">${list.length ? list.map((w) => `<div class="item"><b class="grow">${esc(w.word)}</b><button class="btn sm bad" data-w="${esc(w.word)}">Usuń</button></div>`).join('') : '<p class="muted" style="padding:12px">Brak własnych słów.</p>'}</div>`;
      v.querySelector('#cw').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/admin/censor', { word: e.target.word.value }); draw(); } catch (x) { toast(x.message); } };
      v.querySelectorAll('[data-w]').forEach((b) => { b.onclick = async () => { await api('DELETE', '/api/admin/censor/' + encodeURIComponent(b.dataset.w)); draw(); }; });
    };
    await draw();
  }

  /* ---------- SUPER ADMIN: konta personelu + pełna kopia zapasowa ---------- */
  async function vSuper(v) {
    const draw = async () => {
      const staff = await api('GET', '/api/admin/accounts');
      const RN = { admin: 'Super Admin', mod: 'Moderator' };
      v.innerHTML = `<h2>Konta i kopia zapasowa</h2>
        <section class="card stack"><b>Kopia zapasowa</b><span class="muted small">Jeden plik ZIP: baza SQLite (użytkownicy, rankingi, turnieje, powiadomienia), wgrane pliki (banery, obrazy, awatary) i zainstalowane wtyczki. Plik zawiera dane osobowe i klucz sesji – przechowuj go bezpiecznie.</span>
        <button class="btn pri" id="bk">Pobierz pełną kopię zapasową (.zip)</button></section>
        <h3 style="margin-top:16px">Personel</h3>
        <div class="card list">${staff.map((u) => `<div class="item"><div class="grow"><b>${esc(u.nick)}</b> <span class="tag acc">${RN[u.role] || u.role}</span>${u.banned ? ' <span class="tag">zablokowane</span>' : ''}<small>${esc(u.email || '')} · ostatnio ${fmt(u.lastSeen)}</small></div></div>`).join('')}</div>
        <form class="card stack" id="nacc" style="margin-top:10px"><b>Nowe konto administracyjne</b>
          <div class="cols"><label class="fld"><span>Nick</span><input name="nick" maxlength="16" required></label><label class="fld"><span>E-mail</span><input name="email" type="email" required></label></div>
          <div class="cols"><label class="fld"><span>Hasło (min. 8 znaków)</span><input name="password" type="text" minlength="8" autocomplete="off" required></label>
          <label class="fld"><span>Rola</span><select name="role"><option value="mod">Moderator / Młodszy Admin</option><option value="admin">Super Admin</option></select></label></div>
          <p class="hint">Moderator: statystyki, reklamy (bez własnego kodu), ogłoszenia, cenzura, zgłoszenia i kary dla graczy. Bez dostępu do gier, wtyczek, ustawień, usuwania kont, ról i kopii zapasowej.</p>
          <p class="err" id="naerr"></p><button class="btn pri" type="submit">Utwórz konto</button></form>`;
      v.querySelector('#bk').onclick = async (e) => {
        const b = e.target; b.disabled = true; b.textContent = 'Przygotowuję kopię…';
        try {
          const r = await fetch('/api/admin/backup', { headers: { Authorization: 'Bearer ' + getToken() } });
          if (!r.ok) { let m = 'Błąd ' + r.status; try { m = (await r.json()).error || m; } catch (x) { /* brak JSON */ } throw new Error(m); }
          const blob = await r.blob(), a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'nakartce-backup.zip';
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          toast('Kopia zapasowa pobrana');
        } catch (x) { toast(x.message); } finally { b.disabled = false; b.textContent = 'Pobierz pełną kopię zapasową (.zip)'; }
      };
      v.querySelector('#nacc').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try { await api('POST', '/api/admin/accounts', { nick: f.nick.value, email: f.email.value, password: f.password.value, role: f.role.value }); toast('Konto utworzone'); draw(); }
        catch (x) { v.querySelector('#naerr').textContent = x.message; }
      };
    };
    await draw();
  }

  /* ---------- UKŁAD GIER: przeciągnij, aby zmienić kolejność; przełącznik = widoczność ---------- */
  async function vLayout(v) {
    let items = await api('GET', '/api/admin/layout');
    const draw = () => {
      v.innerHTML = `<h2>Układ gier</h2><p class="muted small">Przeciągnij za uchwyt ⠿ (albo użyj strzałek na telefonie). Wyłączone gry znikają ze strony głównej i aplikacji. ⚙ = konfiguracja zdalna (JSON), działa bez restartu.</p>
      <div id="ll" class="stack">${items.map((g, i) => `<div class="card row lrow" draggable="true" data-i="${i}" style="gap:8px;align-items:center">
        <span style="cursor:grab;font-size:20px">⠿</span><span style="font-size:20px">${esc(g.icon)}</span>
        <b class="grow">${esc(g.name)} ${g.plugin ? '<span class="tag">plugin</span>' : ''}</b>
        <button class="btn sm" data-up="${i}" aria-label="W górę">▲</button><button class="btn sm" data-dn="${i}" aria-label="W dół">▼</button>
        <button class="btn sm" data-cfg="${i}" aria-label="Konfiguracja">⚙</button>
        <label class="small"><input type="checkbox" data-vis="${i}" ${g.visible ? 'checked' : ''}> widoczna</label></div>`).join('')}</div>
      <button class="btn pri" id="saveL" style="margin-top:12px">Zapisz układ</button>`;
      let from = null;
      v.querySelectorAll('.lrow').forEach((el) => {
        el.ondragstart = () => { from = +el.dataset.i; el.style.opacity = .4; };
        el.ondragend = () => { el.style.opacity = 1; };
        el.ondragover = (e) => e.preventDefault();
        el.ondrop = (e) => { e.preventDefault(); const to = +el.dataset.i; if (from === null || from === to) return; items.splice(to, 0, items.splice(from, 1)[0]); draw(); };
      });
      v.onclick = async (e) => {
        const t = e.target, mv = (a, b) => { if (b < 0 || b >= items.length) return; items.splice(b, 0, items.splice(a, 1)[0]); draw(); };
        if (t.dataset.up) mv(+t.dataset.up, +t.dataset.up - 1);
        else if (t.dataset.dn) mv(+t.dataset.dn, +t.dataset.dn + 1);
        else if (t.dataset.vis) items[+t.dataset.vis].visible = t.checked;
        else if (t.dataset.cfg) {
          const g = items[+t.dataset.cfg], txt = prompt('Konfiguracja zdalna gry „' + g.name + '” (JSON), np. {"turnTimeSec":30,"winPoints":3}', g.config);
          if (txt === null) return;
          try { await api('PUT', '/api/admin/layout/' + g.id + '/config', { config: JSON.parse(txt) }); g.config = txt; toast('Zapisano – gracze dostaną zmianę bez restartu'); } catch (x) { toast('Błąd: ' + x.message); }
        } else if (t.id === 'saveL') { await api('PUT', '/api/admin/layout', { items: items.map((g) => ({ id: g.id, visible: g.visible })) }); toast('Układ zapisany'); }
      };
    };
    draw();
  }

  /* ---------- PLUGINY: wgrywanie ZIP albo kod ---------- */
  async function vPlugins(v) {
    const list = await api('GET', '/api/admin/plugins');
    v.innerHTML = `<h2>Pluginy gier</h2>
      <p class="muted small">Gra = paczka z <code>manifest.json</code> + <code>index.html</code>. Interfejs: <code>NaKartce.register({init, render, start, reset, destroy})</code> z <code>/plugin-sdk.js</code>. Plugin działa w izolowanym iframe, bez dostępu do sieci i sesji. Nowa gra jest ukryta – włącz ją w „Układ gier”.</p>
      <div class="card stack"><b>Wgraj archiwum ZIP</b><input type="file" id="pz" accept=".zip"><button class="btn pri" id="pzb">Wgraj</button></div>
      <div class="card stack" style="margin-top:12px"><b>Albo wklej kod</b>
        <textarea id="pm" style="min-height:110px;font-family:monospace">{"slug":"moja-gra","name":"Moja gra","icon":"🎲","hue":200,"version":"1.0.0","description":"Opis"}</textarea>
        <textarea id="ph" placeholder="HTML (dodaj &lt;script src=&quot;/plugin-sdk.js&quot;&gt;)" style="min-height:110px;font-family:monospace"></textarea>
        <textarea id="pj" placeholder="JavaScript (opcjonalnie)" style="min-height:80px;font-family:monospace"></textarea>
        <textarea id="pc" placeholder="CSS (opcjonalnie)" style="min-height:60px;font-family:monospace"></textarea>
        <button class="btn pri" id="pcb">Zainstaluj z kodu</button></div>
      <h3>Zainstalowane</h3>${list.map((g) => `<div class="card row"><span>${esc(g.icon)}</span><b class="grow">${esc(g.name)} <small class="muted">v${esc(g.plugin_version || '')} · ${esc(g.status)}</small></b><button class="btn sm bad" data-del="${esc(g.slug)}">Usuń</button></div>`).join('') || '<p class="muted">Brak pluginów.</p>'}`;
    const done = (r) => { toast('Zainstalowano: ' + r.name); vPlugins(v); };
    const fail = (e) => toast('Błąd: ' + e.message);
    v.querySelector('#pzb').onclick = () => {
      const f = v.querySelector('#pz').files[0]; if (!f) return toast('Wybierz plik ZIP');
      const rd = new FileReader(); rd.onload = () => api('POST', '/api/admin/plugins', { zip: String(rd.result).split(',')[1] }).then(done, fail); rd.readAsDataURL(f);
    };
    v.querySelector('#pcb').onclick = () => api('POST', '/api/admin/plugins', { manifest: v.querySelector('#pm').value, html: v.querySelector('#ph').value, js: v.querySelector('#pj').value, css: v.querySelector('#pc').value }).then(done, fail);
    v.onclick = async (e) => { const s = e.target.dataset.del; if (s && confirm('Usunąć plugin ' + s + '?')) { await api('DELETE', '/api/admin/plugins/' + s); vPlugins(v); } };
  }

  /* ---------- OGŁOSZENIA ---------- */
  async function vAnnounce(v) {
    const list = await api('GET', '/api/admin/announcements');
    v.innerHTML = `<h2>Ogłoszenia</h2><form id="af" class="card stack">
      <input name="title" placeholder="Tytuł (np. Przerwa techniczna)" maxlength="120" required><textarea name="body" placeholder="Treść" maxlength="1000"></textarea>
      <div class="cols"><label class="fld"><span>Forma</span><select name="style"><option value="bar">Pasek u góry</option><option value="popup">Pop-up</option></select></label>
      <label class="fld"><span>Rodzaj</span><select name="level"><option value="info">Informacja</option><option value="warn">Ostrzeżenie</option><option value="good">Nowość</option></select></label></div>
      <div class="cols"><label class="fld"><span>Od</span><input type="datetime-local" name="start"></label><label class="fld"><span>Do</span><input type="datetime-local" name="end"></label></div>
      <button class="btn pri">Opublikuj</button></form>
      ${list.map((a) => `<div class="card row"><div class="grow"><b>${esc(a.title)}</b> <span class="tag">${a.style === 'popup' ? 'pop-up' : 'pasek'}</span> ${a.active ? '<span class="tag good">aktywne</span>' : '<span class="tag">wyłączone</span>'}<br><small>${esc(a.body)}</small></div>
      <button class="btn sm" data-tg="${a.id}" data-on="${a.active ? 1 : 0}">${a.active ? 'Wyłącz' : 'Włącz'}</button><button class="btn sm bad" data-del="${a.id}">Usuń</button></div>`).join('')}`;
    v.querySelector('#af').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); await api('POST', '/api/admin/announcements', Object.fromEntries(f)); toast('Opublikowano'); vAnnounce(v); };
    v.onclick = async (e) => {
      const t = e.target;
      if (t.dataset.del) { await api('DELETE', '/api/admin/announcements/' + t.dataset.del); vAnnounce(v); }
      else if (t.dataset.tg) { const a = list.find((x) => x.id === +t.dataset.tg); await api('PUT', '/api/admin/announcements/' + a.id, Object.assign({}, a, { active: !a.active, start: a.start || '', end: a.end || '' })); vAnnounce(v); }
    };
  }
}
