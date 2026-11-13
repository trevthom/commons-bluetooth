// Commons-Bluetooth — cryptography.
//
// Three separate things are protected here:
//   * authorship   — every event is signed with the author's Ed25519 key, so a
//                    relay can never forge or alter what a peer wrote.
//   * each link    — two peers do an X25519 handshake and encrypt every frame
//                    with AES-256-GCM, so a radio observer cannot read traffic
//                    that passes over one hop.
//   * each group   — event payloads are sealed with a group key derived from the
//                    invite secret, so a node that relays a community's traffic
//                    without being a member carries only ciphertext.
const crypto = require("crypto");

// The Commons key alphabet: no I, O, 0 or 1, so a key read aloud survives.
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const sha256hex = (b) => sha256(b).toString("hex");

// --- base32 -----------------------------------------------------------------
function b32(buf, chars) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) {
    val = ((val << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return chars ? out.slice(0, chars) : out;
}
function unb32(str) {
  const clean = String(str || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = ((val << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");

// --- deterministic serialisation -------------------------------------------
// Every signature and event id is computed over this: object keys sorted, no
// whitespace. Two peers that build the same object therefore get the same bytes.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

// --- Ed25519 identity keys --------------------------------------------------
// PKCS#8 DER prefix for an Ed25519 private key followed by its 32-byte seed.
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519FromSeed(seed) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  const pubB64 = crypto.createPublicKey(priv).export({ format: "jwk" }).x;
  return { priv, pubB64, pubRaw: unb64u(pubB64) };
}
const ed25519Pub = (pubB64) =>
  crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: String(pubB64) }, format: "jwk" });

function sign(priv, data) { return crypto.sign(null, Buffer.from(data), priv); }
function verify(pubB64, data, sig) {
  try { return crypto.verify(null, Buffer.from(data), ed25519Pub(pubB64), Buffer.from(sig)); }
  catch { return false; }
}

// --- X25519 link keys -------------------------------------------------------
function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return { priv: privateKey, pubB64: publicKey.export({ format: "jwk" }).x };
}
function x25519Shared(priv, peerPubB64) {
  const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: String(peerPubB64) }, format: "jwk" });
  return crypto.diffieHellman({ privateKey: priv, publicKey });
}

// --- key derivation / symmetric encryption ---------------------------------
const hkdf = (ikm, salt, info, len = 32) =>
  Buffer.from(crypto.hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt || Buffer.alloc(0)), Buffer.from(info), len));

// Encrypt with AES-256-GCM. `aad` is authenticated but not stored.
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function open(key, iv, ct, tag, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag));
  return Buffer.concat([d.update(Buffer.from(ct)), d.final()]);
}

// The key a group's traffic is sealed with. Both sides know the invite secret,
// so both derive the same key without ever sending it.
const groupKey = (secret, gid) => hkdf(unb64u(secret), Buffer.from(String(gid)), "commons-bluetooth/group/v1", 32);

// The key one radio link uses. Mixing both handshake nonces in the salt means
// a replayed HELLO cannot reproduce an old session.
function linkKey(shared, nonceA, nonceB) {
  const [a, b] = [nonceA, nonceB].sort(Buffer.compare);
  return hkdf(shared, Buffer.concat([a, b]), "commons-bluetooth/link/v1", 32);
}

module.exports = {
  B32, b32, unb32, b64u, unb64u,
  sha256, sha256hex, canonical,
  ed25519FromSeed, ed25519Pub, sign, verify,
  x25519Pair, x25519Shared,
  hkdf, seal, open, groupKey, linkKey,
};
