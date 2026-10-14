'use strict';
/* Testy BBCode forum: formatowanie + odporność na XSS. */
const assert = require('assert');
const B = require('../shared/bbcode');
let n = 0; const ok = (name) => { n++; console.log('  ✓ ' + name); };
console.log('BBCode');

assert.strictEqual(B.render('[b]a[/b] [i]b[/i] [u]c[/u] [s]d[/s]'), '<strong>a</strong> <em>b</em> <u>c</u> <s>d</s>'); ok('pogrubienie, pochylenie, podkreślenie, przekreślenie');
assert.strictEqual(B.render('a\nb'), 'a<br>b'); ok('nowe linie');
assert(/<ul class="bb-list"><li>a<\/li><li>b<\/li><\/ul>/.test(B.render('[list]\n[*]a\n[*]b\n[/list]').replace(/<br>/g, ''))); ok('lista punktowana');
assert(/<ol/.test(B.render('[list=1][*]a[/list]'))); ok('lista numerowana');
assert(/<a href="https:\/\/example.com\/x\?a=1&amp;b=2" target="_blank" rel="nofollow noopener noreferrer ugc">https:\/\/example.com\/x\?a=1&amp;b=2<\/a>/.test(B.render('[url]https://example.com/x?a=1&b=2[/url]'))); ok('link [url]');
assert(/<a href="https:\/\/e.pl"[^>]*><strong>klik<\/strong><\/a>/.test(B.render('[url=https://e.pl][b]klik[/b][/url]'))); ok('link z opisem i zagnieżdżonym formatowaniem');
assert(/<a href="#\/forum\/t\/5">temat<\/a>/.test(B.render('[url=#/forum/t/5]temat[/url]'))); ok('link wewnętrzny do tematu');
assert(/<img class="bb-img" src="https:\/\/e.pl\/a.png"/.test(B.render('[img]https://e.pl/a.png[/img]'))); ok('obrazek https');
assert(/<blockquote class="bb-quote"><cite><a href="#\/forum\/p\/12">Ala napisał\(a\):<\/a><\/cite>treść<\/blockquote>/.test(B.render('[quote=Ala;12]treść[/quote]'))); ok('cytat z autorem i odnośnikiem do posta');
assert.strictEqual(B.render('[code][b]x[/b] <i>[/code]'), '<pre class="bb-code"><code>[b]x[/b] &lt;i&gt;</code></pre>'); ok('kod: bez formatowania, z escapowaniem');

/* XSS */
const evil = [
  '<script>alert(1)</script>', '[url=javascript:alert(1)]x[/url]', '[url]javascript:alert(1)[/url]', '[url=data:text/html;base64,AAAA]x[/url]',
  '[img]javascript:alert(1)[/img]', '[img]http://insecure/a.png[/img]', '[img]https://x/a.png" onerror="alert(1)[/img]', '[url=https://a.pl" onmouseover="alert(1)]x[/url]',
  '[quote=<img src=x onerror=alert(1)>]a[/quote]', '[b onclick=alert(1)]x[/b]', '[url=https://a.pl\'onfocus=\'alert(1)]x[/url]', '[code]</pre><script>alert(1)</script>[/code]',
  '[url=//evil.com]x[/url]', '[url=vbscript:x]x[/url]', '[img]https://x/a.png\n" onerror="x[/img]'
];
for (const e of evil) {
  const h = B.render(e);
  assert(!/<script/i.test(h), 'script: ' + e);
  /* każdy wygenerowany tag może mieć wyłącznie atrybuty z białej listy (w cudzysłowach, bez < > w wartościach) */
  for (const tag of h.match(/<[a-z][^>]*>/gi) || []) {
    const rest = tag.replace(/\s(?:class|src|href|rel|target|alt|loading|referrerpolicy)="[^"<>]*"/g, '');
    assert(/^<[a-z0-9]+\s?\/?>$/i.test(rest), 'atrybut spoza białej listy: ' + tag + ' <= ' + e);
  }
  assert(!/href="(javascript|data|vbscript|\/\/)/i.test(h), 'href: ' + e);
  assert(!/<img[^>]*src="(?!https:\/\/)/i.test(h), 'img: ' + e);
}
ok('payloady XSS (script, javascript:, data:, onerror, cudzysłowy w atrybutach) są neutralizowane');

/* odporność parsera */
assert.doesNotThrow(() => B.render('[b][i][u][s][url][quote][list][*][/b]'.repeat(500))); ok('niedomknięte i zagnieżdżone znaczniki nie wywracają parsera');
assert.strictEqual(B.render('[/b] x [/quote]'), '[/b] x [/quote]'); ok('zamknięcie bez otwarcia to zwykły tekst');
let deep = ''; for (let i = 0; i < 40; i++) deep += '[quote]'; assert.doesNotThrow(() => B.render(deep + 'x')); ok('limit głębokości zagnieżdżeń');
assert.strictEqual(B.strip('[quote=A;1]cytat[/quote]Cześć [b]świecie[/b] [url=https://e.pl]link[/url] [img]https://e.pl/a.png[/img]'), 'Cześć świecie link [obraz]'); ok('strip(): zwykły tekst bez cytatów');
assert.deepStrictEqual(B.count('[url]https://a.pl[/url] https://b.pl [img]https://c.pl/x.png[/img]'), { links: 3, images: 1 }); ok('count(): liczba linków i obrazków (anty-spam)');
console.log('\nOK: ' + n + ' testów BBCode');
