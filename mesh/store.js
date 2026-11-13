// The local store: a signed event log plus the invite metadata that must never
// be replicated. Everything the UI reads is *derived* from the log, which is
// why two devices that have seen the same events show the same community.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { materialize, CONTENT_KINDS } = require("./state");
const { inviteCode } = require("./invite");

const MESSAGE_TTL = 30 * 86400000;

const IMAGE_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "gif";
  return null;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "data.json");
    this.imageDir = path.join(dir, "images");
    try { fs.mkdirSync(this.imageDir, { recursive: true }); } catch {}
    this.groups = {};   // gid -> { secret, name, ownerKey, createdAt, joinedAt }
    this.byGroup = {};   // gid -> [event]
    this.meta = {};
    this.dirty = new Set();
    this.kv = null;
    this.sorted = {};   // gid -> sorted event list
    this.mat = {};      // gid -> { group, kv }
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
      this.groups = raw.groups || {};
      this.byGroup = raw.events || {};
      this.meta = raw.meta || {};
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[commons-bt] could not read ${this.file}: ${err.message}`);
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      }
    }
    this.dirty = new Set(Object.keys(this.groups));
  }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeNow(), 100);
  }
  writeNow() {
    this.saveTimer = null;
    const tmp = this.file + ".tmp";
    const body = JSON.stringify({ version: 1, groups: this.groups, events: this.byGroup, meta: this.meta });
    fs.writeFile(tmp, body, (err) => {
      if (err) return console.error("[commons-bt] save failed:", err.message);
      fs.rename(tmp, this.file, (e) => { if (e) console.error("[commons-bt] save rename failed:", e.message); });
    });
  }
  flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, groups: this.groups, events: this.byGroup, meta: this.meta }));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {}
  }

  // --- groups ---------------------------------------------------------------
  addGroup(meta) {
    if (this.groups[meta.gid]) return this.groups[meta.gid];
    this.groups[meta.gid] = { ...meta, joinedAt: Date.now() };
    this.dirty.add(meta.gid);
    this.persist();
    return this.groups[meta.gid];
  }
  groupMeta(gid) { return this.groups[gid] || null; }
  dropGroup(gid) {
    delete this.groups[gid];
    delete this.byGroup[gid];
    delete this.sorted[gid];
    delete this.mat[gid];
    this.dirty.delete(gid);
    this.kv = null;
    this.persist();
  }
  groupIds() { return Object.keys(this.groups); }
  hasGroup(gid) { return !!this.groups[gid]; }

  // --- events ---------------------------------------------------------------
  addEvent(ev) {
    const gid = ev && ev.gid;
    if (!gid || !this.groups[gid]) return false;
    if (!Array.isArray(this.byGroup[gid])) this.byGroup[gid] = [];
    const list = this.byGroup[gid];
    // Content older than the retention window is refused rather than stored:
    // every peer applies the same rule, so the result still converges.
    if (CONTENT_KINDS.has(ev.kind) && ev.ts < Date.now() - MESSAGE_TTL) return false;
    if (this.meta.index && this.meta.index[gid + ":" + ev.id]) return false;
    if (list.some((e) => e.id === ev.id)) return false;
    list.push(ev);
    this.sorted[gid] = null;
    this.mat[gid] = null;
    this.dirty.add(gid);
    this.kv = null;
    this.persist();
    return true;
  }
  events(gid) {
    if (!this.sorted[gid]) this.sorted[gid] = [...(this.byGroup[gid] || [])].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    return this.sorted[gid];
  }
  eventIds(gid) { return (this.byGroup[gid] || []).map((e) => e.id); }

  // Digest used to spot a peer whose history differs from ours.
  digest(gid) {
    const list = this.byGroup[gid] || [];
    let h = 0n;
    for (const e of list) h ^= BigInt("0x" + e.id.slice(0, 16));
    return { n: list.length, h: h.toString(16) };
  }

  // --- derived state --------------------------------------------------------
  materialized(gid) {
    if (!this.mat[gid]) {
      const meta = this.groups[gid];
      if (!meta) return { group: null, kv: {} };
      const m = materialize(gid, this.events(gid), meta);
      if (m.group) {
        // The invite strings are derived, never stored: every member computes
        // the same code from the same secret, so there is nothing to sync.
        m.group.invite = inviteCode(meta.secret, gid, m.group.ownerKey, m.group.name, null);
        m.group.inviteOnce = m.group.inviteNonce && !m.group.inviteOnceUsed
          ? inviteCode(meta.secret, gid, m.group.ownerKey, m.group.name, m.group.inviteNonce)
          : null;
        delete m.group.inviteNonce;
        delete m.group.inviteOnceUsed;
      }
      this.mat[gid] = m;
    }
    return this.mat[gid];
  }
  // The whole readable key/value space, as the UI's /api/get|mget|list expect.
  allKV() {
    if (this.kv) return this.kv;
    const kv = {};
    for (const gid of Object.keys(this.groups)) {
      const m = this.materialized(gid);
      if (!m.group) continue;
      kv[`group:${gid}`] = m.group;
      Object.assign(kv, m.kv);
    }
    this.kv = kv;
    return kv;
  }
  get(key) { return this.allKV()[key]; }
  list(prefix = "") { return Object.keys(this.allKV()).filter((k) => k.startsWith(prefix)); }
  mget(prefix = "", since = 0) {
    const items = [];
    for (const [k, v] of Object.entries(this.allKV())) {
      if (!k.startsWith(prefix)) continue;
      if (since && v) {
        const t = Math.max(typeof v.ts === "number" ? v.ts : 0, typeof v.updatedAt === "number" ? v.updatedAt : 0);
        if (t > 0 && t <= since) continue;
      }
      items.push([k, v]);
    }
    return items;
  }

  // --- pictures -------------------------------------------------------------
  saveBlob(buf, w, h) {
    if (!buf || !buf.length) return { error: "empty" };
    if (buf.length > 4 * 1024 * 1024) return { error: "image-too-large" };
    const ext = sniffImage(buf);
    if (!ext) return { error: "bad-image" };
    const id = crypto.randomBytes(12).toString("hex");
    const image = {
      id, ext,
      w: Math.max(1, Math.min(10000, Math.round(Number(w) || 0))) || 1,
      h: Math.max(1, Math.min(10000, Math.round(Number(h) || 0))) || 1,
    };
    fs.writeFileSync(this.blobPath(image), buf);
    return { image };
  }
  blobPath(image) { return path.join(this.imageDir, `${image.id}.${image.ext}`); }
  hasBlob(id) { return !!this.findBlob(id); }
  findBlob(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id || ""))) return null;
    for (const ext of Object.keys(IMAGE_TYPES)) {
      const p = path.join(this.imageDir, `${id}.${ext}`);
      if (fs.existsSync(p)) return { path: p, ext };
    }
    return null;
  }
  readBlob(id) {
    const f = this.findBlob(id);
    if (!f) return null;
    try { return { ext: f.ext, buf: fs.readFileSync(f.path) }; } catch { return null; }
  }
  writeBlob(id, ext, buf) {
    if (!/^[0-9a-f]{24}$/.test(String(id || "")) || !IMAGE_TYPES[ext]) return false;
    if (buf.length > 4 * 1024 * 1024) return false;
    try { fs.writeFileSync(path.join(this.imageDir, `${id}.${ext}`), buf); return true; } catch { return false; }
  }

  // --- retention ------------------------------------------------------------
  sweep() {
    const cutoff = Date.now() - MESSAGE_TTL;
    let n = 0;
    for (const gid of Object.keys(this.byGroup)) {
      const before = this.byGroup[gid].length;
      this.byGroup[gid] = this.byGroup[gid].filter((e) => !(CONTENT_KINDS.has(e.kind) && e.ts < cutoff));
      n += before - this.byGroup[gid].length;
      if (before !== this.byGroup[gid].length) {
        this.sorted[gid] = null; this.mat[gid] = null; this.dirty.add(gid); this.kv = null;
      }
    }
    if (n) { this.persist(); console.log(`[commons-bt] dropped ${n} item(s) past the 30-day window`); }
    // Pictures no message refers to any more.
    const used = new Set();
    for (const v of Object.values(this.allKV())) if (v && v.image && v.image.id) used.add(v.image.id);
    let files = [];
    try { files = fs.readdirSync(this.imageDir); } catch {}
    for (const f of files) {
      const id = f.split(".")[0];
      if (used.has(id)) continue;
      try { if (fs.statSync(path.join(this.imageDir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(this.imageDir, f)); } catch {}
    }
  }
}

module.exports = { Store, IMAGE_TYPES, sniffImage };
