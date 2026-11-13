// This device's identity: one Ed25519 key, created on first run and kept in
// identity.json (mode 0600). There is no account server — the key *is* the
// account. `key` (16 characters, the Commons format) is what other members see;
// `exportKey()` is the 52-character secret you can carry to another device.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./crypto");

class Identity {
  constructor(seed) {
    this.seed = seed;
    const k = C.ed25519FromSeed(seed);
    this.priv = k.priv;
    this.pubB64 = k.pubB64;
    this.pubRaw = k.pubRaw;
    // 8 bytes of the key hash is plenty to address a peer on a mesh hop.
    this.peerId = C.sha256(this.pubRaw).subarray(0, 8).toString("hex");
    // The public, shareable account key — 16 characters, Commons' alphabet.
    this.key = C.b32(C.sha256(this.pubRaw).subarray(0, 10), 16);
  }

  static create() { return new Identity(crypto.randomBytes(32)); }

  static fromSeed(seed) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("seed must be 32 bytes");
    return new Identity(seed);
  }

  // The exportable secret: base32 of the seed, 52 characters.
  exportKey() { return C.b32(this.seed); }

  static fromExport(str) {
    const seed = C.unb32(str);
    if (seed.length !== 32) throw new Error("not an identity key");
    return new Identity(seed);
  }

  sign(data) { return C.sign(this.priv, data); }
  verify(data, sig) { return C.verify(this.pubB64, data, sig); }

  // Load (or create) the identity file. A file that cannot be parsed is moved
  // aside rather than overwritten — an identity is the only way back in.
  static load(dir) {
    const file = path.join(dir, "identity.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = Identity.fromExport(raw.exportKey || C.b32(Buffer.from(raw.seed, "base64")));
      if (raw.createdAt) id.createdAt = raw.createdAt;
      return id;
    } catch (err) {
      if (err.code !== "ENOENT") {
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
        console.error(`[commons-bt] could not read ${file}: ${err.message} — a new identity was created`);
      }
    }
    const id = Identity.create();
    id.createdAt = Date.now();
    id.save(dir);
    return id;
  }

  save(dir) {
    const file = path.join(dir, "identity.json");
    const body = JSON.stringify({ exportKey: this.exportKey(), createdAt: this.createdAt || Date.now() }, null, 2);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  // Replace this device's identity with an imported seed.
  static replace(dir, seed) {
    const id = Identity.fromSeed(seed);
    id.createdAt = Date.now();
    id.save(dir);
    return id;
  }
}

module.exports = Identity;
