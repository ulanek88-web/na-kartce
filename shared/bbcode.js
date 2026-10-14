/*
 * Na kartce — BBCode forum (współdzielone przez serwer i przeglądarkę).
 *
 * Obsługiwane znaczniki (biała lista, wszystko inne jest zwykłym tekstem):
 *   [b] [i] [u] [s]            pogrubienie, pochylenie, podkreślenie, przekreślenie
 *   [url]https://…[/url]       link;   [url=https://…]tekst[/url]   (także wewnętrzne: [url=#/forum/t/5]…[/url])
 *   [img]https://…[/img]       obrazek (tylko https)
 *   [quote]…[/quote]           cytat;  [quote=nick;123]…[/quote]    (123 = numer cytowanego posta)
 *   [code]…[/code]             kod (bez formatowania)
 *   [list][*]a[*]b[/list]      lista punktowana; [list=1] – numerowana
 *
 * Bezpieczeństwo: cały tekst jest escapowany, adresy przechodzą ścisłą walidację (http/https, brak cudzysłowów
 * i znaków sterujących), nie ma żadnych atrybutów poza generowanymi tutaj. Wynik render() można wstawić przez innerHTML.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NKBBCode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TAG_RE = /\[(\/?)(b|i|u|s|url|img|quote|code|list|\*)(?:=([^\]\n]{0,300}))?\]/gi;
  const SIMPLE = { b: 'strong', i: 'em', u: 'u', s: 's' };
  const MAX_DEPTH = 8;
  const URL_OK = /^(?:https?:\/\/[^\s"'<>\\\u0000-\u001f]{1,1800}|#\/[A-Za-z0-9\/_.~%-]{1,200})$/i;
  const IMG_OK = /^https:\/\/[^\s"'<>\\\u0000-\u001f]{1,1800}$/i;

  /* ---------- parser -> drzewo ---------- */
  function parse(src) {
    src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    const rootNode = { type: 'root', children: [] }, stack = [rootNode], lower = src.toLowerCase();
    const top = () => stack[stack.length - 1];
    const text = (t) => { if (t) top().children.push({ type: 'text', text: t }); };
    const re = new RegExp(TAG_RE.source, 'gi');
    let last = 0, m;
    while ((m = re.exec(src))) {
      text(src.slice(last, m.index));
      last = re.lastIndex;
      const raw = m[0], closing = m[1] === '/', name = m[2].toLowerCase(), arg = m[3];
      /* znaczniki „dosłowne”: zawartość do zamykającego tagu nie jest parsowana */
      if (!closing && (name === 'code' || name === 'img' || (name === 'url' && arg == null))) {
        const end = lower.indexOf('[/' + name + ']', last);
        if (end < 0) { text(raw); continue; }
        top().children.push({ type: name, text: src.slice(last, end).replace(/^\n/, '') });
        last = re.lastIndex = end + name.length + 3;
        continue;
      }
      if (name === '*') {
        if (closing) { text(raw); continue; }
        let i = stack.length - 1; while (i > 0 && stack[i].type !== 'list') i--;
        if (i === 0) { text(raw); continue; }
        stack.length = i + 1;
        const li = { type: 'li', children: [] }; stack[i].children.push(li); stack.push(li);
        continue;
      }
      if (!closing) {
        if (stack.length > MAX_DEPTH) { text(raw); continue; }
        if (name === 'url' && stack.some((n) => n.type === 'url')) { text(raw); continue; }
        const node = { type: name, arg, children: [] }; top().children.push(node); stack.push(node);
        continue;
      }
      let i = stack.length - 1; while (i > 0 && stack[i].type !== name) i--;
      if (i === 0) { text(raw); continue; }       // zamknięcie bez otwarcia – zwykły tekst
      stack.length = i;
    }
    text(src.slice(last));
    return rootNode;
  }

  /* ---------- render -> HTML ---------- */
  const nl = (t) => esc(t).replace(/\n/g, '<br>');
  function html(node) {
    switch (node.type) {
      case 'text': return nl(node.text);
      case 'b': case 'i': case 'u': case 's': { const t = SIMPLE[node.type]; return `<${t}>${kids(node)}</${t}>`; }
      case 'code': return `<pre class="bb-code"><code>${esc(node.text)}</code></pre>`;
      case 'img': { const u = node.text.trim(); return IMG_OK.test(u) ? `<img class="bb-img" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : nl('[img]' + node.text + '[/img]'); }
      case 'url': {
        const href = (node.arg != null ? node.arg : node.text || '').trim();
        if (!URL_OK.test(href)) return node.arg != null ? kids(node) : nl(node.text || '');
        const label = node.arg != null ? kids(node) : esc(href);
        const ext = !href.startsWith('#');
        return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="nofollow noopener noreferrer ugc"' : ''}>${label}</a>`;
      }
      case 'quote': {
        let who = '', pid = 0;
        if (node.arg) { const [n, p] = node.arg.split(';'); who = n.trim().slice(0, 40); pid = /^\d{1,9}$/.test((p || '').trim()) ? +p : 0; }
        const head = who ? `<cite>${pid ? `<a href="#/forum/p/${pid}">` : ''}${esc(who)} napisał(a):${pid ? '</a>' : ''}</cite>` : '';
        return `<blockquote class="bb-quote">${head}${kids(node)}</blockquote>`;
      }
      case 'list': {
        const tag = (node.arg || '').trim() === '1' ? 'ol' : 'ul';
        const items = node.children.map((c) => (c.type === 'li' ? `<li>${kids(c)}</li>` : (c.type === 'text' && !c.text.trim() ? '' : `<li>${html(c)}</li>`))).join('');
        return `<${tag} class="bb-list">${items}</${tag}>`;
      }
      case 'li': return `<li>${kids(node)}</li>`;
      default: return kids(node);
    }
  }
  const kids = (n) => n.children.map(html).join('');
  const render = (src) => kids(parse(src));

  /* ---------- zwykły tekst (podglądy, powiadomienia) ---------- */
  function plainNode(n) {
    switch (n.type) {
      case 'text': return n.text;
      case 'code': return n.text;
      case 'img': return '[obraz]';
      case 'quote': return '';
      case 'url': return n.arg != null ? n.children.map(plainNode).join('') : (n.text || '');
      case 'li': return '• ' + n.children.map(plainNode).join('') + '\n';
      default: return (n.children || []).map(plainNode).join('');
    }
  }
  const strip = (src, max) => { const t = plainNode(parse(src)).replace(/\s+/g, ' ').trim(); return max && t.length > max ? t.slice(0, max - 1) + '…' : t; };

  /* ---------- liczniki do reguł antyspamowych ---------- */
  function count(src) {
    src = String(src == null ? '' : src);
    return { links: (src.match(/https?:\/\//gi) || []).length, images: (src.match(/\[img\]/gi) || []).length };
  }

  return { render, strip, count, parse, esc };
});
