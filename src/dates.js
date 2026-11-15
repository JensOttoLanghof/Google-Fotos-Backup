// Datumslogik: Aufnahmedatum aus Dateiname bzw. Takeout-JSON ableiten.
// Ein "Datum" ist hier lokale Wanduhrzeit: {y, m, d, H, M, S, hasTime}.

export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
  "August", "September", "Oktober", "November", "Dezember"];

const pad = (n, l = 2) => String(n).padStart(l, "0");

function valid(y, m, d, H = 0, M = 0, S = 0) {
  const maxYear = new Date().getFullYear() + 1;
  if (y < 1990 || y > maxYear || m < 1 || m > 12 || d < 1 || H > 23 || M > 59 || S > 59) return false;
  return d <= new Date(y, m, 0).getDate();
}

export function fromJsDate(date) {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(),
    H: date.getHours(), M: date.getMinutes(), S: date.getSeconds(), hasTime: true };
}

export function toJsDate(t) {
  return new Date(t.y, t.m - 1, t.d, t.H, t.M, t.S);
}

/** Datum aus dem Dateinamen lesen (WhatsApp, Kamera, Screenshots ...), sonst null. */
export function dateFromName(name) {
  const n = name.replace(/\.[^.]+$/, "");
  let m;
  // 20240115_123456, 20240115-123456, 20240115123456 (IMG_, VID_, PXL_, Screenshot_ ...)
  m = n.match(/(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})[_\- ]?(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const v = m.slice(1).map(Number);
    if (valid(...v)) return { y: v[0], m: v[1], d: v[2], H: v[3], M: v[4], S: v[5], hasTime: true };
  }
  // 2024-01-15 at 12.34.56 / 2024-01-15-12-34-56 / 2024-01-15 123456
  m = n.match(/(?<!\d)((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})(?:[ _\-.]|at|um)*(\d{2})[.\-:_h]?(\d{2})[.\-:_m]?(\d{2})/);
  if (m) {
    const v = m.slice(1).map(Number);
    if (valid(...v)) return { y: v[0], m: v[1], d: v[2], H: v[3], M: v[4], S: v[5], hasTime: true };
  }
  // Unix-Zeit in Millisekunden (z. B. FB_IMG_1705312345678)
  m = n.match(/(?<!\d)(1\d{12})(?!\d)/);
  if (m) {
    const t = fromJsDate(new Date(Number(m[1])));
    if (valid(t.y, t.m, t.d)) return t;
  }
  // Nur Datum: IMG-20240115-WA0001, 2024-01-15
  m = n.match(/(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/) ||
      n.match(/(?<!\d)((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})(?!\d)/);
  if (m) {
    const v = m.slice(1).map(Number);
    if (valid(...v)) return { y: v[0], m: v[1], d: v[2], H: 12, M: 0, S: 0, hasTime: false };
  }
  return null;
}

/** Zeitstempel aus der Takeout-JSON (Sekunden seit 1970, UTC) in lokale Zeit. */
export function dateFromJson(meta) {
  const ts = Number(meta?.photoTakenTime?.timestamp || meta?.creationTime?.timestamp || 0);
  if (!ts) return null;
  const t = fromJsDate(new Date(ts * 1000));
  return valid(t.y, t.m, t.d) ? t : null;
}

/** "2024:01:15 12:34:56" (EXIF) -> Datum oder null */
export function dateFromExif(str) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(str || ""));
  if (!m) return null;
  const v = m.slice(1).map(Number);
  return valid(...v) ? { y: v[0], m: v[1], d: v[2], H: v[3], M: v[4], S: v[5], hasTime: true } : null;
}

export const toExif = (t) => `${pad(t.y, 4)}:${pad(t.m)}:${pad(t.d)} ${pad(t.H)}:${pad(t.M)}:${pad(t.S)}`;

/**
 * Dateiname und JSON kombinieren. Der Dateiname gewinnt; enthält er nur den
 * Tag (WhatsApp), wird die Uhrzeit aus der JSON übernommen, wenn der Tag passt.
 */
export function combine(nameDate, jsonDate) {
  if (nameDate) {
    if (!nameDate.hasTime && jsonDate && jsonDate.y === nameDate.y && jsonDate.m === nameDate.m && jsonDate.d === nameDate.d) {
      return { date: jsonDate, source: "name" };
    }
    return { date: nameDate, source: "name" };
  }
  if (jsonDate) return { date: jsonDate, source: "json" };
  return { date: null, source: "none" };
}

export function folderFor(t) {
  return t ? `${t.y}/${pad(t.m)} ${MONTHS[t.m - 1]}` : "Ohne Datum";
}
