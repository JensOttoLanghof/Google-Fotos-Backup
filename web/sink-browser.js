// Dateizugriff im Browser (File System Access API, Edge/Chrome).
export function createBrowserSink(rootHandle) {
  const dirs = new Map([["", rootHandle]]);
  async function dirFor(parts, create) {
    let key = "", handle = rootHandle;
    for (const part of parts) {
      key += "/" + part;
      let next = dirs.get(key);
      if (!next) {
        next = await handle.getDirectoryHandle(part, { create });
        dirs.set(key, next);
      }
      handle = next;
    }
    return handle;
  }
  async function fileHandle(rel, create) {
    const parts = rel.split("/"), name = parts.pop();
    const dir = await dirFor(parts, create);
    return dir.getFileHandle(name, { create });
  }
  // Abgebrochene Datei wieder entfernen, damit kein leerer Rest liegen bleibt.
  async function discard(rel, writable) {
    await writable.abort().catch(() => {});
    const parts = rel.split("/"), name = parts.pop();
    await (await dirFor(parts, false)).removeEntry(name).catch(() => {});
  }
  return {
    async size(rel) {
      try { return (await (await fileHandle(rel, false)).getFile()).size; }
      catch (e) { if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null; throw e; }
    },
    async writeBytes(rel, bytes) {
      const w = await (await fileHandle(rel, true)).createWritable();
      try { await w.write(bytes); await w.close(); } catch (e) { await discard(rel, w); throw e; }
    },
    async openStream(rel) {
      const w = await (await fileHandle(rel, true)).createWritable();
      return {
        write: (chunk) => w.write(chunk),
        patch: (pos, bytes) => w.write({ type: "write", position: pos, data: bytes }),
        close: () => w.close(),
        abort: () => discard(rel, w),
      };
    },
    async modified(rel) {
      try { return new Date((await (await fileHandle(rel, false)).getFile()).lastModified); } catch { return null; }
    },
    async readText(rel) {
      try { return await (await (await fileHandle(rel, false)).getFile()).text(); }
      catch (e) { if (e.name === "NotFoundError") return null; throw e; }
    },
    async writeText(rel, text) {
      const w = await (await fileHandle(rel, true)).createWritable();
      await w.write(text); await w.close();
    },
  };
}
