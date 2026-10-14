'use strict';
/* Cenzura czatu (po stronie serwera). Wiadomość z niedozwolonym słowem jest w całości odrzucana.
 * Wykrywa: odmiany (dopasowanie rdzeni), polskie znaki, powtórzone litery (kurwaaa), separatory (k.u.r.w.a, k u r w a),
 * leet-speak (ch0j, k0rwa, 5zmata, @) i maskowanie gwiazdką (d*pa, k*rwa, ch*j).
 * Własne słowa dodasz zmienną środowiskową CENSOR_EXTRA="slowo1,slowo2" (rdzenie, małe litery, bez polskich znaków). */
const STEMS = [
  'kurw', 'kurew', 'skurwy', 'chuj', 'huj', 'chuw', 'dupa', 'dupe', 'dupie', 'dupci', 'dupsk', 'pierdol', 'pierdal', 'pierdziel', 'pierdn',
  'jeb', 'jebn', 'szmata', 'szmaty', 'szmate', 'szmacie', 'cwel', 'pizd', 'kutas', 'kutafon', 'ciota', 'dziwk', 'sukinsyn', 'fuck', 'shit', 'bitch', 'zjeb', 'pojeb'
].concat((process.env.CENSOR_EXTRA || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
/* słowa dodane w panelu (tabela censor_words) – ładowane przy starcie i po każdej zmianie, bez restartu */
let dynamic = [];
const norm = (w) => String(w || '').toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => PL[c]).replace(/[^a-z]/g, '');
function setWords(list) { dynamic = (list || []).map(norm).filter((w) => w.length >= 3); }
const EXACT = ['dziwa'];                          // rdzenie zbyt krótkie, by szukać ich wewnątrz słów („dziwaczny”, „dziwak”) – tylko całe słowo
const ALLOW = ['duperel', 'jebel', 'shitake'];                   // niewinne słowa zawierające rdzeń (np. „duperele”)
const PL = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
const LEET = { 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '€': 'e', '§': 's' };

function variants(text) {
  let s = String(text).toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => PL[c]).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  const out = [];
  for (const zero of ['o', 'u']) {                       // ch0j -> choj / chuj
    let t = s.replace(/[134578@$!€§]/g, (c) => LEET[c]).replace(/0/g, zero);
    // „k.u.r.w.a”, „k u r w a”, „k-u-r-w-a”: sklejamy ciąg pojedynczych liter rozdzielonych separatorami
    t = t.replace(/(?:^|[^a-z*])((?:[a-z*][\s._\-,|/\\]+){2,}[a-z*])(?![a-z*])/g, (m, run) => m.replace(run, run.replace(/[\s._\-,|/\\]+/g, '')));
    out.push(t);
    out.push(t.replace(/(?<=[a-z*])[._\-,|/\\]+(?=[a-z*])/g, ''));   // „ch.u.j”, „k-u-rwa”: separatory wewnątrz słowa
  }
  return out;
}
const dedupe = (w) => w.replace(/(.)\1+/g, '$1');
function hasStem(token, stem) {
  if (token.includes(stem)) return true;
  if (token.includes('*') || token.includes('?')) {      // maskowanie: * / ? = dowolna litera
    for (let i = 0; i + stem.length <= token.length; i++) {
      let ok = true;
      for (let j = 0; j < stem.length && ok; j++) { const c = token[i + j]; if (c !== stem[j] && c !== '*' && c !== '?') ok = false; }
      if (ok) return true;
    }
  }
  return false;
}
/** @returns {boolean} true jeśli tekst zawiera niedozwolone słowo */
function isProfane(text) {
  for (const v of variants(text)) {
    for (const raw of v.split(/[^a-z*?]+/)) {
      if (raw.length < 3) continue;
      const tok = dedupe(raw);
      if (EXACT.includes(tok) || EXACT.includes(raw)) return true;
      if (ALLOW.some((a) => tok.includes(a))) continue;
      for (const st of STEMS.concat(dynamic)) if (hasStem(tok, st) || hasStem(raw, st)) return true;
    }
  }
  return false;
}
module.exports = { isProfane, setWords, normWord: norm };
