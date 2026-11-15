import { runBackup } from "../src/core.js";
import { createBrowserSink } from "./sink-browser.js";

const $ = (id) => document.getElementById(id);
const token = window.__LOCAL_TOKEN__; // gesetzt, wenn die Seite vom Windows-Programm kommt
const local = !!token;
const nf = new Intl.NumberFormat("de-DE");
const gb = (b) => (b >= 1e9 ? (b / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " GB" : Math.round(b / 1e6) + " MB");

const state = { zips: [], dir: null, running: false, logCount: 0 };
let abort = null;

const api = async (path, body) => {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
};

function refresh() {
  $("zipList").replaceChildren(...state.zips.map((z) => li(local ? z : `${z.name} (${gb(z.size)})`)));
  $("dirList").replaceChildren(...(state.dir ? [li(local ? state.dir : state.dir.name)] : []));
  $("step1").classList.toggle("done", state.zips.length > 0);
  $("step2").classList.toggle("done", !!state.dir);
  $("start").disabled = state.running || !state.zips.length || !state.dir;
  for (const id of ["pickZips", "pickDir", "zipPath", "dirPath"]) $(id).disabled = state.running;
  $("cancel").hidden = !state.running;
}
const li = (text, cls) => { const e = document.createElement("li"); e.textContent = text; if (cls) e.className = cls; return e; };

function addLog(level, text) {
  const log = $("log");
  log.append(li(text, level));
  while (log.children.length > 500) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function showProgress(s) {
  $("progress").hidden = false;
  const pct = s.bytesTotal ? Math.min(100, (s.bytesDone / s.bytesTotal) * 100) : 0;
  $("barFill").style.width = pct.toFixed(1) + "%";
  $("progressText").textContent = s.total
    ? `${nf.format(s.done)} von ${nf.format(s.total)} Dateien · ${gb(s.bytesDone)} von ${gb(s.bytesTotal)}${s.current ? " · " + s.current : ""}`
    : "ZIP-Dateien werden gelesen …";
}

function showResult(s, error, aborted) {
  const box = document.createElement("div");
  if (error) {
    box.className = "notice err";
    box.innerHTML = "<strong>Die Sicherung wurde mit einem Fehler beendet.</strong><p></p>";
    box.querySelector("p").textContent = error;
  } else {
    const problems = s.errors > 0;
    box.className = "notice " + (problems || aborted ? "" : "ok");
    const rows = [
      [s.copied, "neu gesichert"],
      [s.skipped, "übersprungen, weil schon gesichert"],
      [s.dateWritten, "Aufnahmedatum in die Datei geschrieben"],
      [s.dateKept, "hatten bereits ein Aufnahmedatum"],
      [s.dateFolderOnly, local ? "Datum nur über Ordner und Dateidatum (Format ohne Datumsfeld)" : "Datum nur über den Ordner (Format ohne Datumsfeld)"],
      [s.noDate, "ohne erkennbares Datum (Ordner „Ohne Datum“)"],
      [s.errors, "Fehler – diese Dateien wurden NICHT gesichert"],
    ].filter(([n], i) => n > 0 || i === 0);
    const title = aborted ? "Abgebrochen." : problems ? "Fertig, aber nicht alle Dateien konnten gesichert werden." : "Fertig – alles gesichert.";
    box.innerHTML = `<strong>${title}</strong><table class="sum">${rows.map(([n, t]) => `<tr><td>${nf.format(n)}</td><td>${t}</td></tr>`).join("")}</table>`;
    if (problems) box.insertAdjacentHTML("beforeend", "<p>Die betroffenen Dateien stehen unten in Rot. Einfach noch einmal starten – bereits gesicherte Dateien werden übersprungen.</p>");
  }
  $("result").replaceChildren(box);
}

function begin() {
  state.running = true; state.logCount = 0;
  $("result").replaceChildren(); $("log").replaceChildren();
  showProgress({ total: 0, bytesTotal: 0, bytesDone: 0 });
  refresh();
}
function end() { state.running = false; refresh(); }

window.addEventListener("beforeunload", (e) => { if (state.running) e.preventDefault(); });

// ---------- Variante Browser ----------
function setupBrowser() {
  if (!("showDirectoryPicker" in window)) {
    $("unsupported").hidden = false;
    for (const id of ["step1", "step2", "step3"]) $(id).hidden = true;
    return;
  }
  $("webHint").hidden = false;
  $("drop").hidden = false;
  const addFiles = (files) => {
    for (const f of files) {
      if (!/\.zip$/i.test(f.name)) { alert(`„${f.name}“ ist keine ZIP-Datei. Bitte beim Export den Dateityp .zip wählen.`); continue; }
      if (!state.zips.some((z) => z.name === f.name && z.size === f.size)) state.zips.push(f);
    }
    refresh();
  };
  $("pickZips").onclick = () => $("zipInput").click();
  $("zipInput").onchange = (e) => { state.zips = []; addFiles(e.target.files); };
  const drop = $("drop");
  document.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  document.addEventListener("dragleave", () => drop.classList.remove("over"));
  document.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (!state.running) addFiles(e.dataTransfer.files); });
  $("pickDir").onclick = async () => {
    try { state.dir = await window.showDirectoryPicker({ mode: "readwrite", id: "fotos-backup" }); refresh(); }
    catch (e) { if (e.name !== "AbortError") alert("Der Ordner konnte nicht geöffnet werden: " + e.message); }
  };
  $("start").onclick = async () => {
    begin();
    abort = new AbortController();
    let lock = null;
    try { lock = await navigator.wakeLock?.request("screen"); } catch { /* nicht schlimm */ }
    let last = 0, stats = null;
    try {
      stats = await runBackup({
        zips: state.zips.map((f) => ({ name: f.name, blob: f })),
        sink: createBrowserSink(state.dir),
        signal: abort.signal,
        log: addLog,
        onProgress: (s) => { const now = Date.now(); if (now - last > 150) { last = now; showProgress(s); } },
      });
      showProgress(stats);
      showResult(stats, null, abort.signal.aborted);
    } catch (e) {
      showResult(null, e.message || String(e));
    } finally {
      lock?.release().catch(() => {});
      end();
    }
  };
  $("cancel").onclick = () => abort?.abort();
}

// ---------- Variante Windows-Programm ----------
function setupLocal() {
  $("manualZips").hidden = false; $("manualDir").hidden = false;
  const pick = async (kind) => {
    try { return (await api("/api/pick", { kind })).paths; }
    catch (e) { alert("Das Auswahlfenster konnte nicht geöffnet werden. Bitte den Pfad von Hand eingeben.\n\n" + e.message); return []; }
  };
  $("pickZips").onclick = async () => { const p = await pick("zips"); if (p.length) { state.zips = p; refresh(); } };
  $("pickDir").onclick = async () => { const p = await pick("dir"); if (p.length) { state.dir = p[0]; refresh(); } };
  $("zipPath").onchange = (e) => { state.zips = e.target.value.split(";").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean); refresh(); };
  $("dirPath").onchange = (e) => { state.dir = e.target.value.trim().replace(/^"|"$/g, "") || null; refresh(); };
  $("start").onclick = async () => {
    begin();
    try { await api("/api/start", { zips: state.zips, target: state.dir }); }
    catch (e) { showResult(null, e.message); end(); }
  };
  $("cancel").onclick = () => api("/api/cancel", {}).catch(() => {});
  const poll = async () => {
    try {
      const st = await api("/api/status?from=" + state.logCount);
      for (const l of st.log) addLog(l.level, l.text);
      state.logCount += st.log.length;
      if (st.running && !state.running) begin();
      if (st.running || st.finished) showProgress(st.stats);
      if (state.running && !st.running && st.finished) { showResult(st.stats, st.error, st.aborted); end(); }
    } catch { /* Programm evtl. beendet */ }
    setTimeout(poll, 700);
  };
  poll();
}

local ? setupLocal() : setupBrowser();
refresh();
