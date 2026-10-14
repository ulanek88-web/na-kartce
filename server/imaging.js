'use strict';
/* Obrazy reklamowe: odczyt wymiarów z nagłówka (PNG/JPEG/GIF/WEBP – bez bibliotek), walidacja proporcji slotu
 * i automatyczne przycięcie + przeskalowanie do wymiarów docelowych biblioteką `sharp` (opcjonalna zależność).
 * Bez `sharp` serwer nadal waliduje plik i zapisuje go bez zmian (kontener reklamy skaluje obraz w CSS). */
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* brak sharp – tryb awaryjny */ }

/* docelowe wymiary miejsc reklamowych (px) */
const SLOT_SIZES = {
  top_banner: [728, 90], footer: [728, 90], lobby_banner: [728, 90],
  sidebar: [300, 250], interstitial: [300, 250], after_game: [300, 250], game_tile: [300, 250]
};
const MAX_BYTES = 2 * 1024 * 1024;
const ASPECT_TOLERANCE = 0.03;     // 3% odchyłki proporcji

function dimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const k = buf.toString('latin1', 12, 16);
    if (k === 'VP8X') return { type: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { type: 'webp', w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    if (k === 'VP8 ') return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {      // JPEG: szukamy znacznika SOFn
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Waliduje i przetwarza obraz dla slotu. Zwraca { buf, ext, w, h, resized } albo rzuca Error z code 400/413. */
async function processAdImage(buf, slot) {
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  const size = SLOT_SIZES[slot];
  if (!size) fail(400, 'Nieznane miejsce reklamowe');
  if (buf.length > MAX_BYTES) fail(413, 'Plik może mieć maksymalnie 2 MB');
  const d = dimensions(buf);
  if (!d || !d.w || !d.h) fail(400, 'Nie udało się odczytać obrazu (dozwolone: PNG, JPG, WEBP, GIF)');
  const [tw, th] = size, want = tw / th, got = d.w / d.h;
  if (Math.abs(got - want) / want > ASPECT_TOLERANCE) {
    fail(400, `Nieprawidłowe proporcje obrazu: ${d.w}×${d.h}. Dla tego miejsca wymagane są proporcje ${tw}:${th} (np. ${tw}×${th} lub ${tw * 2}×${th * 2}).`);
  }
  if (!sharp) return { buf, ext: d.type === 'jpeg' ? 'jpg' : d.type, w: d.w, h: d.h, resized: false };
  try {
    const out = await sharp(buf, { limitInputPixels: 40e6 }).rotate().resize(tw, th, { fit: 'cover', position: 'centre' }).webp({ quality: 82 }).toBuffer();
    return { buf: out, ext: 'webp', w: tw, h: th, resized: true };
  } catch (e) { fail(400, 'Plik graficzny jest uszkodzony lub nieobsługiwany'); }
}
module.exports = { processAdImage, dimensions, SLOT_SIZES, MAX_BYTES, hasSharp: () => !!sharp };
