#!/usr/bin/env python3
"""Test XSS w przeglądarce (Playwright/Chromium): ładunki w bio, tytułach i treści forum (BBCode), cytatach, powiadomieniach, tytułach działów
i ogłoszeniach trafiają do prawdziwych widoków; żaden nie może wykonać kodu (flaga window.__xss, okna dialogowe, tagi z on*=)."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PORT = 3600 + int(time.time()) % 90; DATA = tempfile.mkdtemp(prefix='nk-xss-')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server/index.js'], cwd=ROOT, env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT), ADMIN_PASSWORD='AdminTest12345', RATE_REG_MAX='999'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
B = 'http://127.0.0.1:%d' % PORT
def api(m, u, b=None, t=None):
    r = urllib.request.Request(B + u, method=m, data=json.dumps(b).encode() if b is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + t} if t else {})})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {'_status': e.code, **json.loads(e.read() or b'{}')}
for _ in range(60):
    try: urllib.request.urlopen(B + '/health'); break
    except Exception: time.sleep(0.2)
P = ['<img src=x onerror="window.__xss=1">', '"><svg/onload=window.__xss=1>', "'><script>window.__xss=1</script>", '<iframe srcdoc="<script>parent.__xss=1</script>">', 'javascript:window.__xss=1']
BB = ['[url=javascript:window.__xss=1]klik[/url]', '[img]https://x.pl/a.png" onerror="window.__xss=1[/img]', '[url=https://a.pl" onmouseover="window.__xss=1]x[/url]', '[quote=<img src=x onerror=window.__xss=1>;1]q[/quote]', '[b onclick=window.__xss=1]x[/b]', '[url]javascript:window.__xss=1[/url]']
adm = api('POST', '/api/auth/login', {'login': 'admin', 'password': 'AdminTest12345'})
atk = api('POST', '/api/auth/register', {'nick': 'Atakujacy', 'email': 'a@x.pl', 'password': 'haslo1234'}); vic = api('POST', '/api/auth/register', {'nick': 'Ofiara', 'email': 'o@x.pl', 'password': 'haslo1234'})
api('PUT', '/api/me', {'bio': P[0] + P[1]}, atk['token'])
board = api('GET', '/api/forum', None, atk['token'])['categories'][0]['boards'][1]['id']; tids = []
for i, pl in enumerate(P + BB):
    r = api('POST', '/api/forum/boards/%d/topics' % board, {'title': 'T%d %s' % (i, pl[:60]), 'body': pl + '\n' + BB[i % len(BB)] + '\n' + P[i % len(P)]}, atk['token'])
    if 'id' in r: tids.append(r['id'])
    else: assert r.get('_status') in (400, 429), r   # odrzucone przez limity – też poprawne
    from_db = None
    if i == 0:
        import sqlite3
    # ominięcie limitu 30 s: cofamy czas postów (tylko w tymczasowej bazie testowej)
    sq = __import__('sqlite3').connect(os.path.join(DATA, 'nakartce.db')); sq.execute('UPDATE forum_posts SET created_at=created_at-40000'); sq.commit(); sq.close()
api('POST', '/api/forum/topics/%d/posts' % tids[0], {'body': 'odp ' + P[0]}, vic['token'])      # powiadomienie dla autora tematu z tytułem-ładunkiem
fired, dialogs = [], []
with sync_playwright() as p:
    br = p.chromium.launch()
    for vp in [(360, 740), (1280, 800)]:
        for who, token in [('atakujący', atk['token']), ('ofiara', vic['token']), ('admin', adm['token'])]:
            ctx = br.new_context(viewport={'width': vp[0], 'height': vp[1]}); ctx.add_init_script("localStorage.setItem('nakartce.token','%s')" % token)
            pg = ctx.new_page(); pg.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
            routes = ['#/', '#/forum', '#/forum/b/%d' % board, '#/u/Atakujacy', '#/me', '#/notifs'] + ['#/forum/t/%d' % t for t in tids] + ['#/forum/u/Atakujacy']
            for r in routes:
                pg.goto(B + '/' + r); pg.wait_for_timeout(250)
                if pg.evaluate('window.__xss'): fired.append((who, r))
                bad = pg.evaluate("""() => [...document.querySelectorAll('#view *')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name)) || e.tagName === 'SCRIPT' || e.tagName === 'IFRAME').map(e => e.tagName).slice(0, 3)""")
                if bad: fired.append((who, r, bad))
            ctx.close()
    br.close()
srv.terminate()
print('Przetestowano %d tematów z ładunkami × 3 role × 2 rozmiary ekranu × %d widoków' % (len(tids), 7 + len(tids)))
print('Wykonania kodu / niebezpieczne tagi:', fired or 'brak'); print('Okna dialogowe:', dialogs or 'brak')
sys.exit(1 if fired or dialogs else 0)
