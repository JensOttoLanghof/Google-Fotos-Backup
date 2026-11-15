// Dateizugriff für das Windows-Programm (setzt zusätzlich das Dateidatum).
import fs from "node:fs/promises";
import path from "node:path";

export function createFsSink(root) {
  const abs = (rel) => path.join(root, ...rel.split("/"));
  const madeDirs = new Set();
  const ensureDir = async (file) => {
    const dir = path.dirname(file);
    if (!madeDirs.has(dir)) { await fs.mkdir(dir, { recursive: true }); madeDirs.add(dir); }
  };
  const finish = async (tmp, file, date) => {
    if (date) await fs.utimes(tmp, date, date);
    await fs.rename(tmp, file);
  };
  return {
    async size(rel) {
      try { return (await fs.stat(abs(rel))).size; } catch { return null; }
    },
    async writeBytes(rel, bytes, date) {
      const file = abs(rel), tmp = file + ".teil";
      await ensureDir(file);
      await fs.writeFile(tmp, bytes);
      await finish(tmp, file, date);
    },
    async openStream(rel) {
      const file = abs(rel), tmp = file + ".teil";
      await ensureDir(file);
      const fh = await fs.open(tmp, "w");
      return {
        write: async (chunk) => { await fh.write(chunk); },
        patch: async (pos, bytes) => { await fh.write(bytes, 0, bytes.length, pos); },
        close: async (date) => { await fh.close(); await finish(tmp, file, date); },
        abort: async () => { await fh.close().catch(() => {}); await fs.rm(tmp, { force: true }); },
      };
    },
    async readText(rel) {
      try { return await fs.readFile(abs(rel), "utf8"); } catch { return null; }
    },
    async writeText(rel, text) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(abs(rel) + ".teil", text);
      await fs.rename(abs(rel) + ".teil", abs(rel));
    },
  };
}
