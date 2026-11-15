// Erzeugt ein kleines, künstliches Takeout-ZIP für Tests.
import { ZipWriter, BlobWriter, Uint8ArrayReader, TextReader } from "@zip.js/zip.js";

export const TINY_JPEG = Uint8Array.from(atob(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));

function box(type, ...parts) {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of a) { o.set(p, i); i += p.length; } return o; };

/** Mini-MP4; secs1904 = Erstellzeit im Filmkopf (0 = fehlt). moovLast: moov hinter mdat. */
export function tinyMp4({ secs1904 = 0, moovLast = false, payload = 5000 } = {}) {
  const hd = (extra) => { const b = new Uint8Array(12 + extra); const v = new DataView(b.buffer); v.setUint32(4, secs1904); v.setUint32(8, secs1904); return b; };
  const moov = box("moov", box("mvhd", hd(88)), box("trak", box("tkhd", hd(72)), box("mdia", box("mdhd", hd(12)))));
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isom"));
  const mdat = box("mdat", new Uint8Array(payload).fill(7));
  return moovLast ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
}

export const ts = (y, m, d, H = 0, M = 0, S = 0) => Math.floor(new Date(y, m - 1, d, H, M, S).getTime() / 1000);
const meta = (title, t) => JSON.stringify({ title, photoTakenTime: { timestamp: String(t) }, creationTime: { timestamp: String(t + 999999) } });

/** files: [{ path, bytes | text }] */
export async function makeZip(files) {
  const w = new ZipWriter(new BlobWriter("application/zip"));
  for (const f of files) await w.add(f.path, f.text != null ? new TextReader(f.text) : new Uint8ArrayReader(f.bytes));
  return w.close();
}

export function sampleFiles() {
  const P = "Takeout/Google Fotos/Fotos von 2024/";
  const A = "Takeout/Google Fotos/Urlaub/";
  const jpegB = concat(TINY_JPEG, new Uint8Array([0])); // anderer Inhalt, gleicher Name möglich
  return [
    { path: P + "IMG-20240115-WA0001.jpg", bytes: TINY_JPEG },
    { path: P + "IMG-20240115-WA0001.jpg.supplemental-metadata.json", text: meta("IMG-20240115-WA0001.jpg", ts(2024, 1, 15, 18, 30, 5)) },
    { path: A + "IMG-20240115-WA0001.jpg", bytes: TINY_JPEG }, // Album-Duplikat
    { path: P + "DSC0001.jpg", bytes: jpegB },
    { path: P + "DSC0001.jpg.json", text: meta("DSC0001.jpg", ts(2024, 3, 2, 9, 0, 0)) },
    { path: P + "DSC0001(1).jpg", bytes: concat(jpegB, new Uint8Array([1])) },
    { path: P + "DSC0001.jpg(1).json", text: meta("DSC0001.jpg", ts(2024, 4, 2, 9, 0, 0)) },
    { path: P + "VID-20240210-WA0007.mp4", bytes: tinyMp4() },
    { path: P + "VID-20240210-WA0007.mp4.supplemental-metadata.json", text: meta("VID-20240210-WA0007.mp4", ts(2024, 2, 11, 3, 0, 0)) },
    { path: P + "film.mov", bytes: tinyMp4({ moovLast: true, payload: 300000 }) },
    { path: P + "film.mov.supplemental-metadata.json", text: meta("film.mov", ts(2024, 5, 20, 14, 0, 0)) },
    { path: P + "kamera.mp4", bytes: tinyMp4({ secs1904: ts(2024, 6, 1, 10, 0, 0) + 2082844800, payload: 100 }) },
    { path: P + "kamera.mp4.supplemental-metadata.json", text: meta("kamera.mp4", ts(2024, 6, 1, 10, 0, 0)) },
    { path: P + "Screenshot_20240707-101112.png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
    { path: P + "ohne.gif", bytes: new Uint8Array([71, 73, 70, 9]) },
    { path: P + "metadata.json", text: "{}" },
    { path: "Takeout/archive_browser.html", text: "<html></html>" },
    { path: "Takeout/Google Fotos/Papierkorb/weg.jpg", bytes: TINY_JPEG },
  ];
}
