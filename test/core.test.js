import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piexif from "piexifjs";
import { runBackup, readLastBackup } from "../src/core.js";
import { createFsSink } from "../src/sink-fs.js";
import { dateFromName, toJsDate } from "../src/dates.js";
import { parseMoov, Mp4Scanner } from "../src/media.js";
import { SidecarIndex } from "../src/sidecar.js";
import { makeZip, sampleFiles, ts, TINY_JPEG, tinyMp4 } from "./fixtures.js";

const exifDate = (file) => piexif.load(fs.readFileSync(file).toString("latin1")).Exif[36867];
const mvhd = (file) => {
  const s = new Mp4Scanner(); s.push(new Uint8Array(fs.readFileSync(file)));
  return parseMoov(s.moov).created;
};
const list = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => f.replaceAll("\\", "/")).sort();

test("Datum aus Dateinamen", () => {
  expect(dateFromName("IMG-20240115-WA0001.jpg")).toMatchObject({ y: 2024, m: 1, d: 15, hasTime: false });
  expect(dateFromName("IMG_20231224_183000.jpg")).toMatchObject({ y: 2023, m: 12, d: 24, H: 18, M: 30, S: 0 });
  // Pixel-Namen sind Weltzeit: 31.01. 23:30 UTC ist in Deutschland schon der 01.02. 00:30
  expect(toJsDate(dateFromName("PXL_20250131_233000123.mp4")).getTime()).toBe(Date.UTC(2025, 0, 31, 23, 30, 0));
  expect(dateFromName("WhatsApp Image 2021-03-04 at 17.05.09.jpeg")).toMatchObject({ y: 2021, m: 3, d: 4, H: 17, M: 5, S: 9 });
  expect(dateFromName("Screenshot_20240707-101112.png")).toMatchObject({ y: 2024, m: 7, d: 7, H: 10 });
  expect(dateFromName("IMG_1234.jpg")).toBeNull();
  expect(dateFromName("DSC00012345.jpg")).toBeNull();
  expect(dateFromName("20241345_000000.jpg")).toBeNull();
});

test("JSON-Zuordnung, auch gekürzte Namen und Bearbeitungen", () => {
  const s = new SidecarIndex();
  const long = "ein_sehr_langer_dateiname_der_abgeschnitten_wird_0001.jpg";
  s.add("d", "a.jpg.supplemental-metadata.json", 1);
  s.add("d", "a.jpg.supplemental-metadata(1).json", 2);
  s.add("d", (long + ".supplemental-metadata").slice(0, 46) + ".json", 3);
  s.add("d", "b.jpg.suppl.json", 4);
  s.add("d", "c.HEIC.json", 5);
  expect(s.find("d", "a.jpg")).toBe(1);
  expect(s.find("d", "a(1).jpg")).toBe(2);
  expect(s.find("d", long)).toBe(3);
  expect(s.find("d", "b-bearbeitet.jpg")).toBe(4);
  expect(s.find("d", "c.MP4")).toBe(5);
  expect(s.find("d", "x.jpg")).toBeNull();
});

test("kompletter Durchlauf inkl. Wiederholung", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfb-"));
  const zip = await makeZip(sampleFiles());
  const logs = [];
  const run = () => runBackup({ zips: [{ name: "takeout.zip", blob: zip }], sink: createFsSink(tmp), log: (l, t) => logs.push(`${l}: ${t}`) });
  const stats = await run();
  expect(list(tmp)).toEqual([
    "2024/01 Januar/IMG-20240115-WA0001.jpg",
    "2024/02 Februar/VID-20240210-WA0007.mp4",
    "2024/03 März/DSC0001.jpg",
    "2024/04 April/DSC0001(1).jpg",
    "2024/05 Mai/film.mov",
    "2024/06 Juni/kamera.mp4",
    "2024/07 Juli/Screenshot_20240707-101112.png",
    "Ohne Datum/ohne.gif",
    "_sicherung-index.json",
  ]);
  expect(stats).toMatchObject({ total: 9, copied: 8, skipped: 1, errors: 0, noDate: 1 });
  // WhatsApp-Bild: Tag aus dem Namen, Uhrzeit aus der JSON
  expect(exifDate(path.join(tmp, "2024/01 Januar/IMG-20240115-WA0001.jpg"))).toBe("2024:01:15 18:30:05");
  expect(exifDate(path.join(tmp, "2024/03 März/DSC0001.jpg"))).toBe("2024:03:02 09:00:00");
  // WhatsApp-Video: Name gewinnt gegen JSON (11.02.), Uhrzeit 12:00
  expect(mvhd(path.join(tmp, "2024/02 Februar/VID-20240210-WA0007.mp4")).getTime()).toBe(ts(2024, 2, 10, 12) * 1000);
  expect(mvhd(path.join(tmp, "2024/05 Mai/film.mov")).getTime()).toBe(ts(2024, 5, 20, 14) * 1000);
  expect(fs.statSync(path.join(tmp, "2024/05 Mai/film.mov")).size).toBe(sampleFiles().find((f) => f.path.endsWith("film.mov")).bytes.length);
  // Dateidatum
  expect(fs.statSync(path.join(tmp, "2024/07 Juli/Screenshot_20240707-101112.png")).mtime.getTime()).toBe(ts(2024, 7, 7, 10, 11, 12) * 1000);
  expect(fs.statSync(path.join(tmp, "2024/01 Januar/IMG-20240115-WA0001.jpg")).mtime.getTime()).toBe(ts(2024, 1, 15, 18, 30, 5) * 1000);

  // zweiter Lauf: nichts Neues
  const again = await run();
  expect(again).toMatchObject({ copied: 0, skipped: 9, errors: 0 });
  // Index verloren: unveränderte Dateien werden an der Größe erkannt, geänderte doppelt abgelegt
  fs.rmSync(path.join(tmp, "_sicherung-index.json"));
  const third = await run();
  expect(third.errors).toBe(0);
  fs.rmSync(tmp, { recursive: true });
});

test("Zeitraum-Auswahl sichert nur passende Dateien, der Rest bleibt für später", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfb-"));
  const zip = await makeZip(sampleFiles());
  const run = (range) => runBackup({ zips: [{ name: "takeout.zip", blob: zip }], sink: createFsSink(tmp), range });
  const feb = await run({ from: "2024-02-01", to: "2024-03-02" });
  expect(list(tmp)).toEqual(["2024/02 Februar/VID-20240210-WA0007.mp4", "2024/03 März/DSC0001.jpg", "_sicherung-index.json"]);
  expect(feb).toMatchObject({ copied: 2, outOfRange: 6, noDateSkipped: 1, skipped: 0, errors: 0 });
  // danach offenes Ende: ab Juni
  const late = await run({ from: "2024-06-01", to: null });
  expect(late).toMatchObject({ copied: 2, outOfRange: 4, skipped: 2 });
  // ohne Zeitraum kommt der Rest nach
  const all = await run(undefined);
  expect(all).toMatchObject({ copied: 4, skipped: 5, outOfRange: 0 });
  expect(list(tmp).length).toBe(9);
  await expect(run({ from: "2024-05-01", to: "2024-04-01" })).rejects.toThrow("Zeitraum");
  fs.rmSync(tmp, { recursive: true });
});

test("einzelne Dateien ohne ZIP: Datum aus dem Namen", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfb-"));
  const files = [
    { name: "IMG-20230812-WA0005.jpg", blob: new Blob([TINY_JPEG]) },
    { name: "C:\\Bilder\\VID-20230813-WA0001.mp4", blob: new Blob([tinyMp4({ moovLast: true })]) },
    { name: "Screenshot_20230901-080910.png", blob: new Blob([new Uint8Array([137, 80, 78, 71])]) },
    { name: "notiz.txt", blob: new Blob(["x"]) },
  ];
  const run = () => runBackup({ files, sink: createFsSink(tmp) });
  const stats = await run();
  expect(list(tmp)).toEqual([
    "2023/08 August/IMG-20230812-WA0005.jpg", "2023/08 August/VID-20230813-WA0001.mp4",
    "2023/09 September/Screenshot_20230901-080910.png", "_sicherung-index.json"]);
  expect(stats).toMatchObject({ total: 3, copied: 3, dateWritten: 2, dateFolderOnly: 1, errors: 0 }); // Mini-PNG im Test ist kein echtes PNG
  expect(exifDate(path.join(tmp, "2023/08 August/IMG-20230812-WA0005.jpg"))).toBe("2023:08:12 12:00:00");
  expect(mvhd(path.join(tmp, "2023/08 August/VID-20230813-WA0001.mp4")).getTime()).toBe(ts(2023, 8, 13, 12) * 1000);
  expect(fs.statSync(path.join(tmp, "2023/09 September/Screenshot_20230901-080910.png")).mtime.getTime()).toBe(ts(2023, 9, 1, 8, 9, 10) * 1000);
  expect(await run()).toMatchObject({ copied: 0, skipped: 3 });
  fs.rmSync(tmp, { recursive: true });
});

test("letzte Sicherung wird im Zielordner vermerkt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfb-"));
  const sink = createFsSink(tmp);
  expect(await readLastBackup(sink)).toBeNull();
  const before = Date.now();
  const stats = await runBackup({ files: [{ name: "IMG-20230812-WA0005.jpg", blob: new Blob([TINY_JPEG]) }], sink });
  const at = await readLastBackup(sink);
  expect(at).toBe(stats.finishedAt);
  expect(new Date(at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  // abgebrochener Lauf ändert den Vermerk nicht
  const ac = new AbortController(); ac.abort();
  await runBackup({ files: [{ name: "IMG-20230813-WA0001.jpg", blob: new Blob([TINY_JPEG, "x"]) }], sink, signal: ac.signal });
  expect(await readLastBackup(sink)).toBe(at);
  // ältere Liste ohne Vermerk: Dateidatum der Liste
  const file = path.join(tmp, "_sicherung-index.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, files: {} }));
  fs.utimesSync(file, new Date("2026-11-15T12:20:00Z"), new Date("2026-11-15T12:20:00Z"));
  expect(await readLastBackup(sink)).toBe("2026-11-15T12:20:00.000Z");
  fs.rmSync(tmp, { recursive: true });
});

test("PNG bekommt das Datum als Textfeld und EXIF, bleibt gültig und wird nicht doppelt beschrieben", async () => {
  const { processPng } = await import("../src/media.js");
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const res = processPng(png, { y: 2025, m: 2, d: 3, H: 12, M: 45, S: 26 });
  expect(res.written).toBe(true);
  const text = Buffer.from(res.bytes).toString("latin1");
  expect(text).toContain("tEXtCreation Time\0" + "2025:02:03 12:45:26");
  expect(text).toContain("eXIf");
  expect(text.indexOf("eXIf")).toBeLessThan(text.indexOf("IDAT"));
  expect(processPng(res.bytes, { y: 2020, m: 1, d: 1, H: 0, M: 0, S: 0 }).written).toBe(false);
  expect(processPng(new Uint8Array(50), { y: 2020, m: 1, d: 1, H: 0, M: 0, S: 0 }).written).toBe(false);
});
