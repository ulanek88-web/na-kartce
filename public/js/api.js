/* Warstwa komunikacji: REST + WebSocket z automatycznym ponawianiem. */
const cfg = window.NK_CONFIG || {};
export const API_BASE = (cfg.apiBase || '').replace(/\/$/, '');
const WS_BASE = (cfg.wsBase || '').replace(/\/$/, '') || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
export const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

export const store = {
  get(k) { try { return localStorage.getItem('nakartce.' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('nakartce.' + k, v); } catch (e) { /* tryb prywatny */ } },
  del(k) { try { localStorage.removeItem('nakartce.' + k); } catch (e) { /* ignore */ } }
};
let token = store.get('token');
export const getToken = () => token;
export function setToken(t) { token = t; if (t) store.set('token', t); else store.del('token'); }
export const assetUrl = (u) => (!u ? '' : /^https?:/.test(u) ? u : API_BASE + u);

export async function api(method, url, body, opts) {
  let r;
  try {
    r = await fetch(API_BASE + url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout((opts && opts.timeout) || 20000) : undefined
    });
  } catch (e) { const err = new Error('Brak połączenia z serwerem'); err.network = true; throw err; }
  let data = null;
  try { data = await r.json(); } catch (e) { /* pusta odpowiedź */ }
  if (!r.ok) { const err = new Error((data && data.error) || 'Błąd ' + r.status); err.status = r.status; throw err; }
  return data;
}
export const get = (u, timeout) => api('GET', u, undefined, timeout ? { timeout } : undefined);
export const post = (u, b) => api('POST', u, b || {});
export const del = (u) => api('DELETE', u);

/* WebSocket z reconnectem; zdarzenia: open, close, <typ wiadomości> */
export class Socket {
  constructor() { this.h = {}; this.ws = null; this.retry = 0; this.closed = false; this.ready = false; }
  on(t, fn) { (this.h[t] = this.h[t] || []).push(fn); return this; }
  off(t, fn) { this.h[t] = (this.h[t] || []).filter((f) => f !== fn); }
  emit(t, d) { (this.h[t] || []).slice().forEach((f) => { try { f(d); } catch (e) { console.error(e); } }); }
  connect() {
    if (!token) return;
    this.closed = false;
    clearTimeout(this.rt);
    try { this.ws = new WebSocket(WS_BASE + '/ws?token=' + encodeURIComponent(token)); } catch (e) { return this.later(); }
    const ws = this.ws;
    ws.onopen = () => {
      this.retry = 0; this.ready = true; this.emit('open');
      clearInterval(this.pi);
      this.pi = setInterval(() => this.send({ t: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.emit(m.t, m); this.emit('*', m); };
    ws.onclose = () => { clearInterval(this.pi); this.ready = false; this.emit('close'); if (!this.closed) this.later(); };
    ws.onerror = () => { /* onclose obsłuży */ };
  }
  later() { clearTimeout(this.rt); const d = Math.min(8000, 600 * Math.pow(1.7, this.retry++)); this.rt = setTimeout(() => this.connect(), d); }
  send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  close() { this.closed = true; clearTimeout(this.rt); clearInterval(this.pi); this.ready = false; if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) { /* ignore */ } } }
}
