// Kernablauf: Takeout-ZIPs lesen, Datum bestimmen und schreiben, nach Jahr/Monat ablegen.
// Läuft unverändert im Browser und im Windows-Programm; Dateizugriffe gehen über "sink".
import { ZipReader, BlobReader, Uint8ArrayWriter, TextWriter, configure } from "@zip.js/zip.js";
import { dateFromName, dateFromJson, combine, folderFor, toJsDate } from "./dates.js";
import { processJpeg, Mp4Scanner, parseMoov, moovPatches } from "./media.js";
import { SidecarIndex } from "./sidecar.js";

configure({ useWebWorkers: false });

export const INDEX_FILE = "_sicherung-index.json";
const JPEG = new Set(["jpg", "jpeg"]);
const VIDEO = new Set(["mp4", "mov", "m4v", "3gp", "3g2"]);
const IGNORE = new Set(["json", "html", "htm", "txt", "csv"]);
const TRASH = new Set(["papierkorb", "trash", "bin", "corbeille"]);
const MAX_JPEG_IN_MEMORY = 150 * 1024 * 1024;

const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const sanitize = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "_";

export function newStats() {
  return { total: 0, done: 0, bytesTotal: 0, bytesDone: 0, copied: 0, skipped: 0, dateWritten: 0,
    dateKept: 0, dateFolderOnly: 0, noDate: 0, outOfRange: 0, noDateSkipped: 0, errors: 0, current: "" };
}

/**
 * @param zips  [{ name, blob }]
 * @param sink  { size, writeBytes, openStream, readText, writeText }
 * @param onProgress (stats) => void
 * @param log   (level: "info"|"warn"|"error", text) => void
 * @param signal AbortSignal
 * @param range  optional { from: "JJJJ-MM-TT"|null, to: "JJJJ-MM-TT"|null } – nur Dateien mit
 *               Aufnahmedatum in diesem Zeitraum (beide Tage eingeschlossen) sichern
 */
export async function runBackup({ zips, sink, onProgress = () => {}, log = () => {}, signal, range }) {
  const stats = newStats();
  const dayKey = (str) => (str ? Number(str.replaceAll("-", "")) : null);
  const from = dayKey(range?.from), to = dayKey(range?.to);
  const filtering = from != null || to != null;
  if (from != null && to != null && from > to) throw new Error("Der Zeitraum ist ungültig: „Von“ liegt nach „Bis“.");
  // true = Datei liegt außerhalb des gewählten Zeitraums und wird nicht gesichert
  const excluded = (date, fileName) => {
    if (!filtering) return false;
    if (!date) {
      stats.noDateSkipped++;
      log("warn", `${fileName}: kein Datum erkennbar – wegen der Zeitraum-Auswahl nicht gesichert.`);
      return true;
    }
    const key = date.y * 10000 + date.m * 100 + date.d;
    if ((from != null && key < from) || (to != null && key > to)) { stats.outOfRange++; return true; }
    return false;
  };
  const sidecars = new SidecarIndex();
  const media = [];
  const readers = [];

  try {
    for (const zip of zips) {
      log("info", `Lese Inhaltsverzeichnis von ${zip.name} …`);
      const reader = new ZipReader(new BlobReader(zip.blob));
      readers.push(reader);
      let entries;
      try { entries = await reader.getEntries(); }
      catch (e) { throw new Error(`${zip.name} ist keine lesbare ZIP-Datei (${e.message}). Ist der Download vollständig?`); }
      for (const entry of entries) {
        if (entry.directory) continue;
        const parts = entry.filename.split("/");
        const fileName = parts.pop();
        const dir = parts.join("/");
        const ext = extOf(fileName);
        if (ext === "json") { sidecars.add(dir, fileName, entry); continue; }
        if (IGNORE.has(ext) || !fileName) continue;
        if (TRASH.has((parts[parts.length - 1] || "").toLowerCase())) continue;
        media.push({ entry, dir, fileName, ext });
        stats.bytesTotal += entry.uncompressedSize;
      }
    }
    stats.total = media.length;
    if (!media.length) throw new Error("In den ausgewählten ZIP-Dateien wurden keine Fotos oder Videos gefunden.");
    log("info", `${media.length} Fotos und Videos gefunden.`);
    onProgress(stats);

    // Index der bereits gesicherten Dateien (Inhalt -> Zielpfad)
    let index = {};
    try {
      const text = await sink.readText(INDEX_FILE);
      if (text) index = JSON.parse(text).files || {};
    } catch { log("warn", "Die Liste der bereits gesicherten Dateien war nicht lesbar und wird neu aufgebaut."); }
    const known = new Set(Object.values(index));
    const saveIndex = () => sink.writeText(INDEX_FILE, JSON.stringify({ version: 1, files: index }));

    let consecutiveErrors = 0, sinceSave = 0;
    for (const item of media) {
      if (signal?.aborted) { log("warn", "Abgebrochen. Bereits gesicherte Dateien bleiben erhalten."); break; }
      stats.current = item.fileName;
      onProgress(stats);
      try {
        await handle(item);
        consecutiveErrors = 0;
      } catch (e) {
        stats.errors++;
        log("error", `${item.fileName}: ${e.message || e}`);
        if (++consecutiveErrors >= 15) {
          throw new Error("Zu viele Fehler hintereinander. Ist die Festplatte noch angeschlossen und hat sie genug freien Platz?");
        }
      }
      stats.done++;
      stats.bytesDone += item.entry.uncompressedSize;
      if (++sinceSave >= 200) { sinceSave = 0; await saveIndex(); }
    }
    await saveIndex();
    stats.current = "";
    onProgress(stats);
    return stats;

    async function handle({ entry, dir, fileName, ext }) {
      const key = `${entry.signature >>> 0}-${entry.uncompressedSize}`;
      if (index[key] && (await sink.size(index[key])) != null) { stats.skipped++; return; }

      let jsonDate; // undefined = noch nicht gelesen
      const getJsonDate = async () => {
        if (jsonDate !== undefined) return jsonDate;
        jsonDate = null;
        const side = sidecars.find(dir, fileName);
        if (side) {
          try { jsonDate = dateFromJson(JSON.parse(await side.getData(new TextWriter()))); } catch { /* ohne JSON weiter */ }
        }
        return jsonDate;
      };
      const nameDate = dateFromName(fileName);
      const fallback = async () => combine(nameDate, nameDate && nameDate.hasTime ? null : await getJsonDate());
      const safeName = sanitize(fileName);

      if (JPEG.has(ext) && entry.uncompressedSize <= MAX_JPEG_IN_MEMORY) {
        const original = await entry.getData(new Uint8ArrayWriter());
        const fb = await fallback();
        const res = processJpeg(original, () => fb.date);
        const date = res.existing || fb.date;
        if (excluded(date, fileName)) return;
        const path = await freePath(folderFor(date), safeName, res.bytes.length);
        if (!path) { index[key] = lastDuplicate; stats.skipped++; return; }
        await sink.writeBytes(path, res.bytes, date && toJsDate(date));
        count(date, res.existing ? "kept" : res.written ? "written" : "folder", fileName, res.failed);
        index[key] = path; known.add(path); stats.copied++;
        return;
      }

      const { date } = await fallback();
      if (excluded(date, fileName)) return;
      const path = await freePath(folderFor(date), safeName, entry.uncompressedSize);
      if (!path) { index[key] = lastDuplicate; stats.skipped++; return; }
      const scanner = VIDEO.has(ext) ? new Mp4Scanner() : null;
      const out = await sink.openStream(path);
      let outcome = "folder";
      try {
        await entry.getData(new WritableStream({
          async write(chunk) { scanner?.push(chunk); await out.write(chunk); },
        }), { signal });
        if (scanner?.moov) {
          const { created, fields } = parseMoov(scanner.moov);
          const target = date && toJsDate(date);
          const differs = created && target && nameDate && Math.abs(created - target) > 36 * 3600 * 1000;
          if (target && fields.length && (!created || differs)) {
            for (const p of moovPatches(fields, scanner.moovOffset, target)) await out.patch(p.pos, p.bytes);
            outcome = "written";
          } else if (created) outcome = "kept";
        }
        await out.close(date && toJsDate(date));
      } catch (e) {
        await out.abort().catch(() => {});
        throw e;
      }
      count(date, outcome, fileName, false);
      index[key] = path; known.add(path); stats.copied++;
    }

    function count(date, outcome, fileName, failed) {
      if (!date) { stats.noDate++; log("warn", `${fileName}: kein Datum gefunden, liegt in „Ohne Datum“.`); return; }
      if (outcome === "written") stats.dateWritten++;
      else if (outcome === "kept") stats.dateKept++;
      else stats.dateFolderOnly++;
      if (failed) log("warn", `${fileName}: Datum konnte nicht in die Datei geschrieben werden (nur einsortiert).`);
    }

    // Freien Zielpfad finden. null = identische Datei liegt schon dort (lastDuplicate).
    var lastDuplicate;
    async function freePath(folder, name, expectedSize) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
      for (let n = 1; n < 1000; n++) {
        const candidate = `${folder}/${n === 1 ? name : `${base} (${n})${ext}`}`;
        const size = await sink.size(candidate);
        if (size == null) return candidate;
        if (!known.has(candidate) && size === expectedSize) { lastDuplicate = candidate; known.add(candidate); return null; }
      }
      throw new Error("Kein freier Dateiname gefunden.");
    }
  } finally {
    for (const r of readers) await r.close().catch(() => {});
  }
}
