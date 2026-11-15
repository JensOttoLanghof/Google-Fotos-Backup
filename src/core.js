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

/** Zeitpunkt der letzten Sicherung in diesen Zielordner (ISO-Text) oder null. */
export async function readLastBackup(sink) {
  try {
    const text = await sink.readText(INDEX_FILE);
    if (!text) return null;
    const at = JSON.parse(text).lastBackup?.at;
    if (at) return at;
  } catch { /* unten: Dateidatum der Liste nehmen */ }
  // Ältere Sicherungen haben den Zeitpunkt noch nicht vermerkt: Dateidatum der Liste nehmen.
  const modified = await sink.modified(INDEX_FILE).catch(() => null);
  return modified ? modified.toISOString() : null;
}

export function newStats() {
  return { total: 0, done: 0, bytesTotal: 0, bytesDone: 0, copied: 0, skipped: 0, dateWritten: 0,
    dateKept: 0, dateFolderOnly: 0, noDate: 0, outOfRange: 0, noDateSkipped: 0, errors: 0, current: "" };
}

/**
 * @param zips  [{ name, blob }] Takeout-ZIP-Dateien
 * @param files [{ name, blob }] einzelne Fotos/Videos ohne Takeout
 * @param sink  { size, writeBytes, openStream, readText, writeText }
 * @param onProgress (stats) => void
 * @param log   (level: "info"|"warn"|"error", text) => void
 * @param signal AbortSignal
 * @param range  optional { from: "JJJJ-MM-TT"|null, to: "JJJJ-MM-TT"|null } – nur Dateien mit
 *               Aufnahmedatum in diesem Zeitraum (beide Tage eingeschlossen) sichern
 */
export async function runBackup({ zips = [], files = [], sink, onProgress = () => {}, log = () => {}, signal, range }) {
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
        media.push({
          dir, fileName, ext, size: entry.uncompressedSize,
          key: `${entry.signature >>> 0}-${entry.uncompressedSize}`,
          readBytes: () => entry.getData(new Uint8ArrayWriter()),
          pipeTo: (writable) => entry.getData(writable, { signal }),
        });
        stats.bytesTotal += entry.uncompressedSize;
      }
    }
    // Einzelne Fotos/Videos ohne Takeout: Datum kommt aus der Datei selbst oder dem Namen.
    for (const file of files) {
      const fileName = file.name.split(/[\\/]/).pop();
      const ext = extOf(fileName);
      if (IGNORE.has(ext) || ext === "json" || ext === "zip") { log("warn", `${fileName}: kein Foto oder Video, übersprungen.`); continue; }
      media.push({
        dir: null, fileName, ext, size: file.blob.size,
        key: `datei-${fileName}-${file.blob.size}`,
        readBytes: async () => new Uint8Array(await file.blob.arrayBuffer()),
        pipeTo: (writable) => file.blob.stream().pipeTo(writable, { signal }),
      });
      stats.bytesTotal += file.blob.size;
    }
    stats.total = media.length;
    if (!media.length) throw new Error("In der Auswahl wurden keine Fotos oder Videos gefunden.");
    log("info", `${media.length} Fotos und Videos gefunden.`);
    onProgress(stats);

    // Index der bereits gesicherten Dateien (Inhalt -> Zielpfad)
    let index = {}, lastBackup = null;
    try {
      const text = await sink.readText(INDEX_FILE);
      if (text) { const saved = JSON.parse(text); index = saved.files || {}; lastBackup = saved.lastBackup || null; }
    } catch { log("warn", "Die Liste der bereits gesicherten Dateien war nicht lesbar und wird neu aufgebaut."); }
    const known = new Set(Object.values(index));
    const saveIndex = () => sink.writeText(INDEX_FILE, JSON.stringify({ version: 1, lastBackup, files: index }));

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
      stats.bytesDone += item.size;
      if (++sinceSave >= 200) { sinceSave = 0; await saveIndex(); }
    }
    // Zeitpunkt der letzten vollständig durchgelaufenen Sicherung merken
    if (!signal?.aborted) { lastBackup = { at: new Date().toISOString(), copied: stats.copied }; stats.finishedAt = lastBackup.at; }
    await saveIndex();
    stats.current = "";
    onProgress(stats);
    return stats;

    async function handle({ dir, fileName, ext, size: fileSize, key, readBytes, pipeTo }) {
      if (index[key] && (await sink.size(index[key])) != null) { stats.skipped++; return; }

      let jsonDate; // undefined = noch nicht gelesen
      const getJsonDate = async () => {
        if (jsonDate !== undefined) return jsonDate;
        jsonDate = null;
        const side = dir == null ? null : sidecars.find(dir, fileName);
        if (side) {
          try { jsonDate = dateFromJson(JSON.parse(await side.getData(new TextWriter()))); } catch { /* ohne JSON weiter */ }
        }
        return jsonDate;
      };
      const nameDate = dateFromName(fileName);
      const fallback = async () => combine(nameDate, nameDate && nameDate.hasTime ? null : await getJsonDate());
      const safeName = sanitize(fileName);

      if (JPEG.has(ext) && fileSize <= MAX_JPEG_IN_MEMORY) {
        const original = await readBytes();
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
      const path = await freePath(folderFor(date), safeName, fileSize);
      if (!path) { index[key] = lastDuplicate; stats.skipped++; return; }
      const scanner = VIDEO.has(ext) ? new Mp4Scanner() : null;
      const out = await sink.openStream(path);
      let outcome = "folder";
      try {
        await pipeTo(new WritableStream({
          async write(chunk) { scanner?.push(chunk); await out.write(chunk); },
        }));
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
