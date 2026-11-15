// Funktionstest für die fertige .exe (läuft in der Build-Pipeline unter Windows):
//   bun scripts/smoke.js make <ordner>   -> legt <ordner>/takeout.zip an
//   bun scripts/smoke.js check <ordner>  -> prüft das Ergebnis in <ordner>/ziel
import fs from "node:fs";
import path from "node:path";
import { makeZip, sampleFiles, ts } from "../test/fixtures.js";

const [mode, dir] = process.argv.slice(2);
if (mode === "make") {
  fs.mkdirSync(path.join(dir, "ziel"), { recursive: true });
  fs.writeFileSync(path.join(dir, "takeout.zip"), new Uint8Array(await (await makeZip(sampleFiles())).arrayBuffer()));
} else {
  const expect = {
    "2024/01 Januar/IMG-20240115-WA0001.jpg": ts(2024, 1, 15, 18, 30, 5),
    "2024/02 Februar/VID-20240210-WA0007.mp4": ts(2024, 2, 10, 12),
    "2024/03 März/DSC0001.jpg": ts(2024, 3, 2, 9),
    "2024/07 Juli/Screenshot_20240707-101112.png": ts(2024, 7, 7, 10, 11, 12),
  };
  for (const [rel, t] of Object.entries(expect)) {
    const st = fs.statSync(path.join(dir, "ziel", rel));
    if (Math.abs(st.mtime.getTime() / 1000 - t) > 2) throw new Error(`Falsches Dateidatum: ${rel} ${st.mtime.toISOString()}`);
  }
  console.log("Funktionstest bestanden.");
}
