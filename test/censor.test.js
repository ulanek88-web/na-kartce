'use strict';
/* Cenzura: wykrywa obejścia (leet, separatory, powtórzenia, maskowanie), nie blokuje zwykłych wypowiedzi, nie jest podatna na ReDoS. */
const assert = require('assert'), C = require('../server/censor');
const bad = ['kurwa', 'KURWA!', 'k.u.r.w.a', 'k u r w a', 'kuuurwa', 'k*rwa', 'ch0j', 'chuj ci w dupę', 'spierdalaj', 'p1zda', 'jebany', 'zjeb', 'sukinsyn', 'f u c k', 'shit', 'szmata', 'dziwa', 'ty cwelu', 'Pierdolę to'];
const good = ['dziwaczny', 'dziwak', 'dziwadło', 'Dziwactwo', 'shiitake', 'kurczak', 'skurcz', 'kurort', 'kurz', 'Hubert', 'dupleks', 'duperele', 'Dupont', 'suka', 'psycholog', 'Grzegorz Brzęczyszczykiewicz', 'pierwszy', 'Jebel Ali', 'bitcoin', 'Kutaisi', 'Assassin', 'Cipolla', 'pizza', 'pizzeria', 'dziękuję za grę', 'Świetna partia, gratuluję!', 'szach i mat', 'remis?', 'Zaczynamy jeszcze raz', 'Kółko i krzyżyk 5x5', 'a b c d e f g', 'ala ma kota', 'https://example.com/szachy?x=1'];
for (const w of bad) assert(C.isProfane(w), 'powinno być zablokowane: ' + w);
for (const w of good) assert(!C.isProfane(w), 'fałszywy alarm: ' + w);
console.log('  ✓ ' + bad.length + ' wulgaryzmów i obejść wykrytych, ' + good.length + ' zwykłych wypowiedzi przepuszczonych');
const t0 = Date.now(); for (const x of ['a '.repeat(5000), 'a.'.repeat(5000), ('a ').repeat(3000) + '-'.repeat(3000), '*'.repeat(10000), '0'.repeat(10000), 'k '.repeat(4000)]) C.isProfane(x);
assert(Date.now() - t0 < 500, 'ReDoS? ' + (Date.now() - t0)); console.log('  ✓ długie, specjalnie spreparowane teksty (10 000 znaków) przetwarzane w ' + (Date.now() - t0) + ' ms');
console.log('\nOK: 2 testy cenzury');
