import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piexif from "piexifjs";
import { runBackup } from "../src/core.js";
import { createFsSink } from "../src/sink-fs.js";
import { dateFromName, toJsDate } from "../src/dates.js";
import { parseMoov, Mp4Scanner } from "../src/media.js";
import { SidecarIndex } from "../src/sidecar.js";
import { makeZip, sampleFiles, ts } from "./fixtures.js";

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
