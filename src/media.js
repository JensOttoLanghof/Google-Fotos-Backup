// Aufnahmedatum in JPEG (EXIF) und MP4/MOV (Filmkopf) lesen und schreiben.
import piexif from "piexifjs";
import { dateFromExif, toExif } from "./dates.js";

const TAG_DATETIME = 306, TAG_ORIGINAL = 36867, TAG_DIGITIZED = 36868;

function toBinary(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}
function fromBinary(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

export const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

/**
 * Liest das EXIF-Aufnahmedatum. Ist keins vorhanden und `fallback` gesetzt,
 * wird es hineingeschrieben.
 * Ergebnis: { existing, bytes, written, failed }
 */
export function processJpeg(bytes, getFallback) {
  if (!isJpeg(bytes)) return { existing: null, bytes, written: false, failed: false, notJpeg: true };
  const bin = toBinary(bytes);
  let exif = null;
  try { exif = piexif.load(bin); } catch { exif = null; }
  const existing = exif && (dateFromExif(exif.Exif?.[TAG_ORIGINAL]) || dateFromExif(exif.Exif?.[TAG_DIGITIZED]));
  if (existing) return { existing, bytes, written: false, failed: false };
  const fallback = getFallback();
  if (!fallback) return { existing: null, bytes, written: false, failed: false };
  const stamp = toExif(fallback);
  const attempt = (obj) => {
    obj["0th"] = obj["0th"] || {}; obj.Exif = obj.Exif || {};
    obj["0th"][TAG_DATETIME] = stamp;
    obj.Exif[TAG_ORIGINAL] = stamp;
    obj.Exif[TAG_DIGITIZED] = stamp;
    return fromBinary(piexif.insert(piexif.dump(obj), bin));
  };
  try {
    return { existing: null, bytes: attempt(exif || {}), written: true, failed: false };
  } catch {
    // Vorhandene EXIF-Daten sind beschädigt; nur wenn gar keine da waren, neu anlegen.
    const hadData = exif && Object.values(exif).some((v) => v && typeof v === "object" && Object.keys(v).length);
    if (!hadData) {
      try { return { existing: null, bytes: attempt({}), written: true, failed: false }; } catch { /* unten */ }
    }
    return { existing: null, bytes, written: false, failed: true };
  }
}

// ---------- PNG ----------

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export const isPng = (b) => b.length > 33 && PNG_SIG.every((x, i) => b[i] === x);

/**
 * Schreibt das Datum in eine PNG-Datei, falls sie noch keins enthält:
 * als Textfeld "Creation Time" (liest der Windows-Explorer als Aufnahmedatum)
 * und als EXIF-Block (lesen u. a. Google Fotos und andere Programme).
 * Ergebnis: { bytes, written }
 */
export function processPng(bytes, date) {
  if (!date || !isPng(bytes)) return { bytes, written: false };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const KEY = "Creation Time";
  let p = 8, first = true;
  while (p + 12 <= bytes.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (first && (type !== "IHDR" || len !== 13)) return { bytes, written: false };
    first = false;
    if (type === "eXIf") return { bytes, written: false };
    if ((type === "tEXt" || type === "iTXt") && len > KEY.length &&
        String.fromCharCode(...bytes.subarray(p + 8, p + 8 + KEY.length + 1)) === KEY + "\0") return { bytes, written: false };
    p += 12 + len;
  }
  if (first) return { bytes, written: false };
  const stamp = toExif(date);
  const text = pngChunk("tEXt", fromBinary(KEY + "\0" + stamp));
  let exif = new Uint8Array(0);
  try {
    const dump = piexif.dump({ "0th": { [TAG_DATETIME]: stamp }, Exif: { [TAG_ORIGINAL]: stamp, [TAG_DIGITIZED]: stamp } });
    exif = pngChunk("eXIf", fromBinary(dump.slice(6))); // ohne den JPEG-Vorspann "Exif\0\0"
  } catch { /* dann nur das Textfeld */ }
  const at = 33; // direkt hinter dem IHDR-Block
  const out = new Uint8Array(bytes.length + text.length + exif.length);
  out.set(bytes.subarray(0, at));
  out.set(exif, at);
  out.set(text, at + exif.length);
  out.set(bytes.subarray(at), at + exif.length + text.length);
  return { bytes: out, written: true };
}

// ---------- MP4 / MOV ----------

const EPOCH_1904 = 2082844800;
const MAX_MOOV = 64 * 1024 * 1024;
const KNOWN_FIRST = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "styp"]);

/** Sucht beim Durchstreamen der Datei den "moov"-Block und merkt ihn sich. */
export class Mp4Scanner {
  constructor() {
    this.pos = 0; this.skipUntil = 0; this.hdr = new Uint8Array(16); this.hdrLen = 0;
    this.collect = null; this.finished = false; this.moov = null; this.moovOffset = 0; this.first = true;
  }
  push(chunk) {
    let i = 0;
    while (i < chunk.length && !this.finished) {
      if (this.collect) {
        const c = this.collect, n = Math.min(c.buf.length - c.filled, chunk.length - i);
        c.buf.set(chunk.subarray(i, i + n), c.filled);
        c.filled += n; i += n; this.pos += n;
        if (c.filled === c.buf.length) { this.moov = c.buf; this.moovOffset = c.start; this.finished = true; }
      } else if (this.pos < this.skipUntil) {
        const n = Math.min(this.skipUntil - this.pos, chunk.length - i);
        i += n; this.pos += n;
      } else {
        this.hdr[this.hdrLen++] = chunk[i++]; this.pos++;
        if (this.hdrLen < 8) continue;
        const v = new DataView(this.hdr.buffer);
        let size = v.getUint32(0), need = 8;
        if (size === 1) { need = 16; if (this.hdrLen < 16) continue; size = Number(v.getBigUint64(8)); }
        const type = String.fromCharCode(...this.hdr.subarray(4, 8));
        const start = this.pos - need;
        if ((this.first && !KNOWN_FIRST.has(type)) || size < need) { this.finished = true; break; }
        this.first = false;
        if (type === "moov" && size <= MAX_MOOV) {
          const buf = new Uint8Array(size);
          buf.set(this.hdr.subarray(0, need));
          this.collect = { buf, filled: need, start };
          if (size === need) { this.moov = buf; this.moovOffset = start; this.finished = true; }
        } else {
          this.skipUntil = start + size;
        }
        this.hdrLen = 0;
      }
    }
  }
}

/** Findet die Datumsfelder im moov-Block. Ergebnis: { created: Date|null, fields } */
export function parseMoov(moov) {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const fields = []; let created = null;
  const walk = (from, to) => {
    let p = from;
    while (p + 8 <= to) {
      let size = v.getUint32(p), hl = 8;
      const type = String.fromCharCode(moov[p + 4], moov[p + 5], moov[p + 6], moov[p + 7]);
      if (size === 1) { if (p + 16 > to) return; size = Number(v.getBigUint64(p + 8)); hl = 16; }
      else if (size === 0) size = to - p;
      if (size < hl || p + size > to) return;
      if (type === "moov" || type === "trak" || type === "mdia") walk(p + hl, p + size);
      else if (type === "mvhd" || type === "tkhd" || type === "mdhd") {
        const version = moov[p + hl], at = p + hl + 4;
        if (at + (version === 1 ? 16 : 8) <= p + size) {
          fields.push({ at, version });
          if (type === "mvhd") {
            const secs = version === 1 ? Number(v.getBigUint64(at)) : v.getUint32(at);
            const unix = secs - EPOCH_1904;
            // gültig: zwischen 1990 und übermorgen
            if (unix > 631152000 && unix < Date.now() / 1000 + 172800) created = new Date(unix * 1000);
          }
        }
      }
      p += size;
    }
  };
  walk(0, moov.length);
  return { created, fields };
}

/** Erzeugt die Schreibvorgänge, die das Datum in allen Datumsfeldern setzen. */
export function moovPatches(fields, moovOffset, jsDate) {
  const secs = Math.floor(jsDate.getTime() / 1000) + EPOCH_1904;
  return fields.map(({ at, version }) => {
    const bytes = new Uint8Array(version === 1 ? 16 : 8), v = new DataView(bytes.buffer);
    if (version === 1) { v.setBigUint64(0, BigInt(secs)); v.setBigUint64(8, BigInt(secs)); }
    else { v.setUint32(0, secs); v.setUint32(4, secs); }
    return { pos: moovOffset + at, bytes };
  });
}
