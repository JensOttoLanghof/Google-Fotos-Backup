// Zuordnung Mediendatei -> Takeout-JSON (gleicher Ordner, ggf. in anderem ZIP-Teil).

const EDITED = /-(bearbeitet|edited|modifié|editado|bewerkt|modificato)(?=(\(\d+\))?\.[^.]+$)/i;

export class SidecarIndex {
  constructor() { this.byDir = new Map(); }

  add(dir, fileName, entry) {
    if (!this.byDir.has(dir)) this.byDir.set(dir, []);
    this.byDir.get(dir).push({ stem: fileName.slice(0, -5), entry });
  }

  find(dir, name) {
    const list = this.byDir.get(dir);
    if (!list) return null;
    const direct = this.#match(list, name);
    if (direct) return direct;
    if (EDITED.test(name)) {
      const original = this.#match(list, name.replace(EDITED, ""));
      if (original) return original;
    }
    // Live-Foto-Video o. Ä.: gleiche Basis, andere Endung
    const base = name.replace(/\.[^.]+$/, "") + ".";
    const sibling = list.find((j) => j.stem.startsWith(base));
    return sibling ? sibling.entry : null;
  }

  #match(list, name) {
    const variants = [[name, ""]];
    const m = name.match(/^(.*)(\(\d+\))(\.[^.]+)$/);
    if (m) variants.push([m[1] + m[3], m[2]]); // IMG(1).jpg <-> IMG.jpg(1).json
    for (const [n, counter] of variants) {
      const full = n + ".supplemental-metadata";
      const minLen = Math.min(n.length, 46);
      let best = null;
      for (const j of list) {
        let stem = j.stem;
        if (counter) {
          if (!stem.endsWith(counter)) continue;
          stem = stem.slice(0, -counter.length);
        }
        if (stem.length >= minLen && full.startsWith(stem) && (!best || stem.length > best.len)) best = { len: stem.length, entry: j.entry };
      }
      if (best) return best.entry;
    }
    return null;
  }
}
