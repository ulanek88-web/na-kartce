'use strict';
/* Minimalny serwer WebSocket (RFC 6455) bez zewnętrznych zależności. */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;      // maks. rozmiar jednej ramki ORAZ całej wiadomości złożonej z fragmentów

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    this.closed = false;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.setNoDelay(true);
  }
  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      if (this.closed) return;
      if (b[0] & 0x70) return this.close(1002);                       // bity RSV bez negocjowanego rozszerzenia = błąd protokołu
      if ((op > 0x2 && op < 0x8) || op > 0xA) return this.close(1002);  // nieznany opcode
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (op >= 0x8 && (!fin || len > 125)) return this.close(1002);   // ramki kontrolne: bez fragmentacji i do 125 B
      if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) this.frag = { op, parts: [] };
        if (!this.frag) return this.close(1002);
        this.frag.size = (this.frag.size || 0) + payload.length;
        if (this.frag.size > MAX_PAYLOAD) return this.close(1009);       // wiadomość z wielu fragmentów nie może obejść limitu (ochrona pamięci)
        this.frag.parts.push(payload);
        if (fin) {
          const data = Buffer.concat(this.frag.parts);
          const isText = this.frag.op === 0x1;
          this.frag = null;
          if (isText) this.emit('message', data.toString('utf8'));
        }
      }
    }
  }
  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(str) { this._frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { this.alive = false; this._frame(0x9, Buffer.alloc(0)); }
  close(code) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code || 1000);
    try { this._frame(0x8, p); this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* ignore */ } }, 500).unref();
    this._closed();
  }
}

function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WSConn(socket);
}

module.exports = { upgrade, WSConn };
