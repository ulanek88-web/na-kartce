'use strict';
/* Minimalny zapis archiwum ZIP (deflate) bez zewnętrznych bibliotek – do pełnej kopii zapasowej. Zapis do pliku (bez trzymania całości w RAM). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dosTime = (d) => ({ t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

/** Zbiera pliki katalogu rekurencyjnie jako { name (z prefiksem), file }. Pomija dowiązania symboliczne. */
function walk(dir, prefix, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const en of ents) {
    const full = path.join(dir, en.name);
    if (en.isSymbolicLink()) continue;
    if (en.isDirectory()) walk(full, prefix + en.name + '/', out);
    else if (en.isFile()) out.push({ name: prefix + en.name, file: full });
  }
  return out;
}

/** entries: [{ name, file } | { name, data: Buffer }] -> zapisuje ZIP do `target`. */
function writeZip(target, entries) {
  const fd = fs.openSync(target, 'w', 0o600);
  let pos = 0; const central = [];
  const w = (b) => { fs.writeSync(fd, b); pos += b.length; };
  try {
    for (const e of entries) {
      const raw = e.data || fs.readFileSync(e.file), name = Buffer.from(e.name, 'utf8');
      const comp = zlib.deflateRawSync(raw), useDeflate = comp.length < raw.length, body = useDeflate ? comp : raw;
      const crc = zlib.crc32(raw) >>> 0, { t, d } = dosTime(e.file ? fs.statSync(e.file).mtime : new Date());
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDeflate ? 8 : 0, 8);
      h.writeUInt16LE(t, 10); h.writeUInt16LE(d, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
      h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
      const off = pos; w(h); w(name); w(body);
      central.push({ name, crc, csize: body.length, size: raw.length, method: useDeflate ? 8 : 0, t, d, off });
    }
    const cdStart = pos;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.t, 12); h.writeUInt16LE(c.d, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.off, 42);
      w(h); w(c.name);
    }
    const cdSize = pos - cdStart;
    if (pos > 0xfffffff0 || central.length > 0xffff) throw new Error('Kopia zapasowa przekracza limit 4 GB formatu ZIP');
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10); e.writeUInt32LE(cdSize, 12); e.writeUInt32LE(cdStart, 16);
    w(e);
  } finally { fs.closeSync(fd); }
  return pos;
}
module.exports = { writeZip, walk };
