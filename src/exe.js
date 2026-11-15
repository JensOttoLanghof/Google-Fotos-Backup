// Windows-Programm: startet eine lokale Seite (nur auf diesem PC erreichbar)
// und erledigt die Dateiarbeit selbst. Mit --zips/--ziel auch ohne Oberfläche.
import fs from "node:fs";
import crypto from "node:crypto";
import page from "./generated-page.js";
import { runBackup, newStats } from "./core.js";
import { createFsSink } from "./sink-fs.js";

// Pfade in Takeout-ZIPs und einzelne Fotos/Videos aufteilen.
function inputs(paths) {
  const zips = [], files = [];
  for (const p of paths) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`Datei nicht gefunden: ${p}`);
    (/\.zip$/i.test(p) ? zips : files).push({ name: p.split(/[\\/]/).pop(), blob: Bun.file(p) });
  }
  return { zips, files };
}
function checkTarget(dir) {
  if (!dir) throw new Error("Kein Zielordner angegeben.");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Zielordner nicht gefunden: ${dir}`);
  return dir;
}

// ---------- ohne Oberfläche ----------
const args = process.argv.slice(2);
if (args.includes("--zips") || args.includes("--dateien") || args.includes("--ziel")) {
  const zips = [], rest = [...args]; let target = null; const range = { from: null, to: null };
  while (rest.length) {
    const a = rest.shift();
    if (a === "--ziel") target = rest.shift();
    else if (a === "--von") range.from = rest.shift();
    else if (a === "--bis") range.to = rest.shift();
    else if (a !== "--zips" && a !== "--dateien") zips.push(a);
  }
  try {
    const stats = await runBackup({
      ...inputs(zips), sink: createFsSink(checkTarget(target)), range,
      log: (level, text) => console.log(level === "info" ? text : `[${level}] ${text}`),
    });
    console.log(JSON.stringify(stats));
    process.exit(stats.errors ? 1 : 0);
  } catch (e) { console.error("Fehler: " + e.message); process.exit(2); }
}

// ---------- mit Oberfläche im Browser ----------
const token = crypto.randomBytes(24).toString("hex");
const html = page.replace("window.__LOCAL_TOKEN__=null", () => `window.__LOCAL_TOKEN__=${JSON.stringify(token)}`);
const job = { running: false, finished: false, aborted: false, error: null, stats: newStats(), log: [], abort: null };
let lastSeen = Date.now(), seen = false;

async function pick(kind) {
  if (process.platform !== "win32") throw new Error("Auswahlfenster gibt es nur unter Windows.");
  const common = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; Opacity=0}; $f.Show(); $f.Activate();";
  const script = kind === "zips"
    ? `${common} $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$true; $d.Title='Takeout-ZIP-Dateien oder einzelne Fotos und Videos auswählen'; $d.Filter='Takeout-ZIP, Fotos und Videos|*.zip;*.jpg;*.jpeg;*.png;*.gif;*.webp;*.heic;*.mp4;*.mov;*.m4v;*.3gp|Alle Dateien (*.*)|*.*'; if ($d.ShowDialog($f) -eq 'OK') { $d.FileNames -join [char]10 }`
    : `${common} $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Zielordner für die Fotos auswählen'; if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath }`;
  const proc = Bun.spawn(["powershell", "-NoProfile", "-STA", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error((await new Response(proc.stderr).text()).slice(0, 300) || "PowerShell-Fehler");
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function start({ zips, target, range }) {
  if (job.running) throw new Error("Es läuft bereits eine Sicherung.");
  const input = inputs(zips || []);
  const sink = createFsSink(checkTarget(target));
  Object.assign(job, { running: true, finished: false, aborted: false, error: null, stats: newStats(), log: [], abort: new AbortController() });
  runBackup({
    ...input, sink, range, signal: job.abort.signal,
    log: (level, text) => job.log.push({ level, text }),
    onProgress: (s) => { job.stats = { ...s }; },
  }).then((s) => { job.stats = { ...s }; job.aborted = job.abort.signal.aborted; })
    .catch((e) => { job.error = e.message || String(e); })
    .finally(() => { job.running = false; job.finished = true; });
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("", { status: 403 });
    if (url.pathname === "/") {
      if (url.searchParams.get("t") !== token) return new Response("Bitte das Programm neu starten.", { status: 403 });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.headers.get("x-token") !== token) return new Response("", { status: 403 });
    lastSeen = Date.now(); seen = true;
    try {
      if (url.pathname === "/api/status") {
        const from = Number(url.searchParams.get("from")) || 0;
        return json({ running: job.running, finished: job.finished, aborted: job.aborted, error: job.error, stats: job.stats, log: job.log.slice(from, from + 200) });
      }
      const body = req.method === "POST" ? await req.json() : {};
      if (url.pathname === "/api/pick") return json({ paths: await pick(body.kind) });
      if (url.pathname === "/api/start") { start(body); return json({ ok: true }); }
      if (url.pathname === "/api/cancel") { job.abort?.abort(); return json({ ok: true }); }
      return new Response("", { status: 404 });
    } catch (e) { return new Response(e.message || String(e), { status: 400 }); }
  },
});

const address = `http://127.0.0.1:${server.port}/?t=${token}`;
console.log("Google Fotos sichern");
console.log("====================");
console.log("Die Bedienung öffnet sich jetzt im Browser. Falls nicht, diese Adresse öffnen:");
console.log(address);
console.log("\nDieses Fenster offen lassen, solange gesichert wird. Zum Beenden einfach schließen.");
if (process.platform === "win32" && !process.env.FOTOS_BACKUP_NO_BROWSER) Bun.spawn(["cmd", "/c", "start", "", address]);

// Beenden, wenn die Seite seit 10 Minuten geschlossen ist und nichts läuft.
setInterval(() => { if (seen && !job.running && Date.now() - lastSeen > 10 * 60 * 1000) process.exit(0); }, 30000);
