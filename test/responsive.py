#!/usr/bin/env python3
"""Test responsywności (Playwright + Chromium): przechodzi przez kluczowe widoki na wielu rozmiarach ekranu i szuka
poziomego przewijania strony, elementów wystających poza ekran, zbyt małych obszarów dotykowych i błędów JS.
Uruchomienie:  python3 test/responsive.py   (wymaga: pip install playwright && playwright install chromium)
Wynik: tabela naruszeń; kod wyjścia 1, gdy są naruszenia krytyczne (poziomy overflow strony). Zrzuty ekranu: /tmp/nk-shots/."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3700 + int(time.time()) % 90
DATA = tempfile.mkdtemp(prefix='nk-resp-')
env = dict(os.environ, DATA_DIR=DATA, PORT=str(PORT), ADMIN_PASSWORD='AdminTest12345', RATE_REG_MAX='999')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server/index.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
B = 'http://127.0.0.1:%d' % PORT
def api(m, u, b=None, t=None):
    r = urllib.request.Request(B + u, method=m, data=json.dumps(b).encode() if b is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + t} if t else {})})
    return json.load(urllib.request.urlopen(r))
for _ in range(60):
    try: urllib.request.urlopen(B + '/health'); break
    except Exception: time.sleep(0.2)
user = api('POST', '/api/auth/register', {'nick': 'Testowy', 'email': 't@x.pl', 'password': 'haslo1234'})
admin = api('POST', '/api/auth/login', {'login': 'admin', 'password': 'AdminTest12345'})
cats = api('GET', '/api/forum', None, user['token'])['categories']
board = cats[0]['boards'][1]['id']
topic = api('POST', '/api/forum/boards/%d/topics' % board, {'title': 'Bardzo długi tytuł tematu, który powinien się łamać i nie rozpychać ekranu na małych telefonach', 'body': 'Treść [b]pogrubiona[/b] https://example.com/' + 'bardzo-dlugi-adres-bez-spacji-' * 6 + '\n[quote=Ala;1]cytat[/quote]\n[code]kod ' + 'x' * 120 + '[/code]'}, user['token'])['id']

VIEWPORTS = [('320x640', 320, 640), ('360x740', 360, 740), ('390x844', 390, 844), ('430x932', 430, 932), ('740x360 poziomo', 740, 360), ('768x1024', 768, 1024), ('1024x768', 1024, 768), ('1280x800', 1280, 800), ('1440x900', 1440, 900)]
APP = [('lobby', '#/'), ('rankingi', '#/ranking'), ('turnieje', '#/tournaments'), ('forum', '#/forum'), ('dział forum', '#/forum/b/%d' % board), ('temat forum', '#/forum/t/%d' % topic), ('nowy temat', '#/forum/new/%d' % board), ('profil', '#/me'), ('offline: menu', '#/offline')]
ADMIN = [('admin: pulpit', '#/dash'), ('admin: gry', '#/games'), ('admin: użytkownicy', '#/users'), ('admin: ustawienia', '#/settings'), ('admin: forum', '#/forum')]
JS = """() => { const W = innerWidth, out = []; const de = document.documentElement;
  const page = Math.max(de.scrollWidth, document.body.scrollWidth) - W;
  const inScroll = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true; } return false; };
  for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); if (!r.width || st.visibility === 'hidden' || st.display === 'none' || st.position === 'fixed' && r.right <= W) continue;
    if (r.right > W + 1 && !inScroll(el) && el.tagName !== 'svg' && !el.closest('svg')) out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' +' + Math.round(r.right - W)); }
  const small = [...document.querySelectorAll('button,a.btn,.btn,input:not([type=hidden]),select,textarea,[role=button]')].filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width && r.height && s.visibility !== 'hidden' && (r.height < 32 || r.width < 32) && !el.closest('.sr-only'); }).length;
  return { page, out: out.slice(0, 4), small }; }"""
res, errs = [], []
with sync_playwright() as p:
    br = p.chromium.launch(); shots = '/tmp/nk-shots'; os.makedirs(shots, exist_ok=True)
    for vn, w, h in VIEWPORTS:
        for name, url, kind in [(n, u, 'app') for n, u in APP] + [(n, u, 'admin') for n, u in ADMIN] + [('powitalny (bez konta)', '', 'anon')]:
            ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=w < 800, device_scale_factor=1)
            if kind == 'app': ctx.add_init_script("localStorage.setItem('nakartce.token','%s')" % user['token'])
            if kind == 'admin': ctx.add_init_script("for (const k of ['nakartce.admin','nk_admin_token','nakartce.token']) localStorage.setItem(k,'%s')" % admin['token'])
            pg = ctx.new_page(); pg.on('pageerror', lambda e, n=name, v=vn: errs.append((v, n, str(e)[:100])))
            try:
                pg.goto(B + ('/admin/' if kind == 'admin' else '/') + url); pg.wait_for_timeout(900 if kind != 'anon' else 500)
                if name == 'offline: menu':
                    pg.click('text=Kółko i krzyżyk >> nth=0', timeout=2000); pg.wait_for_timeout(500)
                    name = 'offline: partia'
                r = pg.evaluate(JS); res.append((vn, name, r))
                if w in (320, 390) or (w == 1280 and name in ('temat forum', 'admin: forum')): pg.screenshot(path='%s/%s_%s.png' % (shots, vn.split(' ')[0], name.replace(' ', '_').replace(':', '')))
            except Exception as e:
                res.append((vn, name, {'page': 0, 'out': ['BŁĄD: ' + str(e)[:60]], 'small': 0}))
            ctx.close()
    br.close()
srv.terminate()
crit = [(v, n, r) for v, n, r in res if r['page'] > 1]
warn = [(v, n, r) for v, n, r in res if r['page'] <= 1 and r['out']]
print('Widoków×rozmiarów sprawdzono: %d (%d rozmiarów)' % (len(res), len(VIEWPORTS)))
print('Poziome przewijanie strony: %d' % len(crit))
for v, n, r in crit: print('  KRYTYCZNE %-16s %-24s +%dpx  %s' % (v, n, r['page'], ', '.join(r['out'])))
print('Elementy wystające poza ekran (bez przewijania strony): %d' % len(warn))
for v, n, r in warn[:15]: print('  uwaga   %-16s %-24s %s' % (v, n, ', '.join(r['out'])))
sm = {}; [sm.__setitem__(v, max(sm.get(v, 0), r['small'])) for v, n, r in res]
print('Maks. liczba kontrolek < 32 px na widok:', sm)
print('Błędy JS:', errs[:5] or 'brak')
sys.exit(1 if crit else 0)
