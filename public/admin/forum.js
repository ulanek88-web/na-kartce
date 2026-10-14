/* Panel administratora — zakładka „Forum” (Super Admin): kategorie, działy, Moderatorzy Forum, sankcje. */
export function init({ NAV, VIEWS, api, esc, toast, fmt, ask, dlg, closeDlg }) {
  const at = NAV.findIndex((n) => n[0] === 'content');
  NAV.splice(at + 1, 0, ['forum', 'Forum', 1]);
  VIEWS.forum = vForum;

  async function vForum(v, ok) {
    const draw = async () => {
      const d = await api('GET', '/api/forum/admin/overview'); if (!ok()) return;
      v.innerHTML = `<div class="head"><h2>Forum</h2><button class="btn sm pri" data-fa="cadd">+ Kategoria</button></div>
        <p class="muted small">${d.stats.topics} tematów · ${d.stats.posts} postów. Kategoria „STREFA GIER” i jej działy są tworzone automatycznie dla każdej aktywnej gry. Odstęp między postami i wyłącznik forum: Ustawienia.</p>
        ${d.categories.map((c) => `<section class="card stack"><div class="row" style="gap:6px"><b class="grow">${esc(c.title)}</b>
          <button class="btn sm" data-fa="mv" data-t="category" data-id="${c.id}" data-d="-1">▲</button><button class="btn sm" data-fa="mv" data-t="category" data-id="${c.id}" data-d="1">▼</button>
          <button class="btn sm" data-fa="cedit" data-id="${c.id}" data-title="${esc(c.title)}">Nazwa</button>${c.title === 'STREFA GIER' && c.system ? '' : `<button class="btn sm bad" data-fa="cdel" data-id="${c.id}">Usuń</button>`}</div>
          <div class="list">${c.boards.map((b) => `<div class="item"><div class="grow"><b>${esc(b.title)}</b> ${b.game ? '<span class="tag">gra</span>' : ''}${b.staffOnly ? ' <span class="tag acc">tylko personel</span>' : ''}${b.hidden ? ' <span class="tag">ukryty</span>' : ''}${b.gameOff ? ' <span class="tag">gra wyłączona</span>' : ''}<small>${esc(b.description)} · ${b.topics} tematów, ${b.posts} postów</small></div>
            <div class="acts"><button class="btn sm" data-fa="mv" data-t="board" data-id="${b.id}" data-d="-1">▲</button><button class="btn sm" data-fa="mv" data-t="board" data-id="${b.id}" data-d="1">▼</button>
            <button class="btn sm" data-fa="bform" data-id="${b.id}" data-c="${c.id}">Edytuj</button>${b.game ? '' : `<button class="btn sm bad" data-fa="bdel" data-id="${b.id}" data-n="${b.topics}">Usuń</button>`}</div></div>`).join('') || '<p class="muted small">Brak działów.</p>'}</div>
          <button class="btn sm" data-fa="bform" data-c="${c.id}">+ Dział</button></section>`).join('')}
        <section class="card stack"><b>Moderatorzy Forum</b><p class="hint">Rozszerzone uprawnienia wyłącznie na forum (edycja/usuwanie postów, zamykanie, przenoszenie i przyklejanie tematów, ostrzeżenia i blokady pisania). Bez dostępu do tego panelu.</p>
          <div class="list">${d.moderators.map((m) => `<div class="item"><b class="grow">${esc(m.nick)}</b><small>od ${fmt(m.since)}</small><button class="btn sm bad" data-fa="modrm" data-id="${m.id}">Odbierz</button></div>`).join('') || '<p class="muted small">Brak – nadaj rolę poniżej.</p>'}</div>
          <form class="row" id="fmodf" style="gap:8px"><input class="grow" name="nick" placeholder="nick użytkownika" maxlength="16" required style="min-height:44px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--surface);font-size:16px"><button class="btn pri" type="submit">Nadaj rolę</button></form></section>
        <section class="card stack"><b>Aktywne blokady pisania (${d.bans.length})</b><div class="list">${d.bans.map((b) => `<div class="item"><div class="grow"><b>${esc(b.nick)}</b><small>${b.until === -1 ? 'bezterminowo' : 'do ' + fmt(b.until)} · ${esc(b.reason || 'bez powodu')} · ${esc(b.mod || '')}</small></div><button class="btn sm" data-fa="unban" data-id="${b.id}">Zdejmij</button></div>`).join('') || '<p class="muted small">Brak.</p>'}</div></section>
        <section class="card stack"><b>Ostatnie ostrzeżenia</b><div class="list">${d.warnings.map((w) => `<div class="item"><div class="grow"><b>${esc(w.nick)}</b><small>${fmt(w.ts)} · ${esc(w.reason)} · ${esc(w.mod || '')}</small></div></div>`).join('') || '<p class="muted small">Brak.</p>'}</div></section>`;
      v.querySelector('#fmodf').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/forum/admin/moderators', { nick: e.target.nick.value }); toast('Nadano rolę Moderatora Forum'); draw(); } catch (x) { toast(x.message); } };
      v.onclick = async (e) => {
        const b = e.target.closest('[data-fa]'); if (!b) return; const id = b.dataset.id, run = async (fn) => { try { await fn(); draw(); } catch (x) { toast(x.message); } };
        switch (b.dataset.fa) {
          case 'cadd': { const t = prompt('Nazwa nowej kategorii:'); if (t) run(() => api('POST', '/api/forum/admin/categories', { title: t })); break; }
          case 'cedit': { const t = prompt('Nazwa kategorii:', b.dataset.title); if (t) run(() => api('PUT', '/api/forum/admin/categories/' + id, { title: t })); break; }
          case 'cdel': if (await ask('Usunąć kategorię?', 'Usuń', true)) run(async () => { try { await api('DELETE', '/api/forum/admin/categories/' + id); } catch (x) { if (x.status === 409 && await ask(x.message, 'Usuń wszystko', true)) await api('DELETE', '/api/forum/admin/categories/' + id + '?force=1'); else throw x; } }); break;
          case 'mv': run(() => api('POST', '/api/forum/admin/reorder', { type: b.dataset.t, id: +id, dir: +b.dataset.d })); break;
          case 'bdel': if (await ask('Usunąć dział' + (+b.dataset.n ? ' wraz z ' + b.dataset.n + ' tematami' : '') + '?', 'Usuń', true)) run(() => api('DELETE', '/api/forum/admin/boards/' + id + '?force=1')); break;
          case 'modrm': run(() => api('DELETE', '/api/forum/admin/moderators/' + id)); break;
          case 'unban': run(() => api('POST', '/api/forum/users/' + id + '/unban', {})); break;
          case 'bform': {
            const ov = await api('GET', '/api/forum/admin/overview'), ex = id && ov.categories.flatMap((c) => c.boards).find((x) => x.id === +id);
            dlg(`<h3>${ex ? 'Edytuj dział' : 'Nowy dział'}</h3><form id="bf" class="stack"><label class="fld"><span>Nazwa</span><input name="title" maxlength="60" required value="${esc(ex ? ex.title : '')}" ${ex && ex.game ? 'disabled' : ''}></label>
              <label class="fld"><span>Opis</span><textarea name="description" maxlength="300" rows="2">${esc(ex ? ex.description : '')}</textarea></label>
              <label class="fld"><span>Kategoria</span><select name="category_id">${ov.categories.map((c) => `<option value="${c.id}" ${c.id === +b.dataset.c ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select></label>
              <label class="chk"><input type="checkbox" name="staffOnly" ${ex && ex.staffOnly ? 'checked' : ''}><span>Tematy zakładają tylko administratorzy i moderatorzy (gracze odpowiadają)</span></label>
              <label class="chk"><input type="checkbox" name="hidden" ${ex && ex.hidden ? 'checked' : ''}><span>Ukryty przed graczami</span></label>
              <div class="cols"><button class="btn" type="button" id="bfx">Anuluj</button><button class="btn pri" type="submit">Zapisz</button></div></form>`);
            document.getElementById('bfx').onclick = closeDlg;
            document.getElementById('bf').onsubmit = async (e2) => {
              e2.preventDefault(); const f = e2.target;
              const body = { title: f.title.value || (ex && ex.title), description: f.description.value, category_id: +f.category_id.value, staffOnly: f.staffOnly.checked, hidden: f.hidden.checked };
              try { await api(ex ? 'PUT' : 'POST', '/api/forum/admin/boards' + (ex ? '/' + id : ''), body); closeDlg(); draw(); } catch (x) { toast(x.message); }
            };
            break;
          }
          default:
        }
      };
    };
    await draw();
  }
}
