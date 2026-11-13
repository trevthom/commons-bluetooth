// The wire format.
//
// A packet is a 30-byte header and a payload. Packets larger than one BLE
// write are split into FRAG packets and reassembled on the other side, so the
// mesh layer above never has to think about the radio's MTU.
//
//   0     magic 0xCB
//   1     version
//   2     type
//   3     ttl        (mesh hops remaining; a relay decrements only this byte)
//   4..5  payload length (little endian)
//   6..13 sender peer id (8 bytes)
//   14..29 packet id (16 bytes, sha256 of type||payload)
//   30..  payload
const crypto = require("crypto");

const MAGIC = 0xcb;
const VERSION = 1;
const HEADER = 30;
const MAX_PAYLOAD = 256 * 1024; // a logical frame may not exceed this
const FRAG_CHUNK = 700;         // bytes of a logical frame per FRAG packet

const T = {
  HELLO: 1,      // unencrypted X25519 handshake
  ENC: 2,        // encrypted, link-local (sync, blobs, pings)
  ENC_EVENT: 3,  // encrypted event, mesh-relayed with a TTL
  FRAG: 4,       // one chunk of a larger packet
  PING: 5,
  PONG: 6,
};
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

const packetId = (type, payload) =>
  crypto.createHash("sha256").update(Buffer.concat([Buffer.from([type]), payload])).digest().subarray(0, 16);

function encode({ type, ttl = 7, senderId, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  if (body.length > MAX_PAYLOAD) throw new Error("packet too large");
  const id = packetId(type, body);
  const h = Buffer.alloc(HEADER);
  h[0] = MAGIC; h[1] = VERSION; h[2] = type; h[3] = ttl & 0xff;
  h.writeUInt16LE(body.length, 4);
  Buffer.from(senderId, "hex").copy(h, 6, 0, 8);
  id.copy(h, 14);
  return Buffer.concat([h, body]);
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER) return null;
  if (buf[0] !== MAGIC || buf[1] !== VERSION) return null;
  const type = buf[2], ttl = buf[3], len = buf.readUInt16LE(4);
  if (len > MAX_PAYLOAD || buf.length < HEADER + len) return null;
  const payload = buf.subarray(HEADER, HEADER + len);
  const id = buf.subarray(14, 30);
  // A packet id that does not match its payload is a corrupted or crafted frame.
  if (!packetId(type, payload).equals(id)) return null;
  return { type, ttl, senderId: buf.subarray(6, 14).toString("hex"), packetId: id.toString("hex"), payload, raw: buf };
}

// Split an already-encoded packet into FRAG packets.
function fragment(frame, senderId, ttl = 1) {
  const total = Math.max(1, Math.ceil(frame.length / FRAG_CHUNK));
  const out = [];
  const fid = crypto.randomBytes(8);
  for (let i = 0; i < total; i++) {
    const data = frame.subarray(i * FRAG_CHUNK, (i + 1) * FRAG_CHUNK);
    const head = Buffer.alloc(12);
    fid.copy(head, 0);
    head.writeUInt16LE(i, 8);
    head.writeUInt16LE(total, 10);
    out.push(encode({ type: T.FRAG, ttl, senderId, payload: Buffer.concat([head, data]) }));
  }
  return out;
}

// Reassembles FRAG packets per sender. Bounded: a peer cannot make us hold an
// unbounded number of half-received frames.
class Reassembler {
  constructor({ ttl = 30000, max = 64 } = {}) {
    this.parts = new Map();
    this.ttl = ttl;
    this.max = max;
  }

  // Returns the complete packet buffer, or null while more chunks are needed.
  push(pkt) {
    const p = pkt.payload;
    if (p.length < 12) return null;
    const fid = p.subarray(0, 8).toString("hex");
    const idx = p.readUInt16LE(8);
    const total = p.readUInt16LE(10);
    if (total < 1 || total > 512 || idx >= total) return null;
    const key = pkt.senderId + ":" + fid;
    let entry = this.parts.get(key);
    if (!entry) {
      if (this.parts.size >= this.max) this.prune(true);
      entry = { total, chunks: new Array(total), got: 0, at: Date.now() };
      this.parts.set(key, entry);
    }
    if (entry.total !== total || entry.chunks[idx]) return null;
    entry.chunks[idx] = Buffer.from(p.subarray(12));
    entry.got++;
    if (entry.got < entry.total) return null;
    this.parts.delete(key);
    return Buffer.concat(entry.chunks);
  }

  prune(force = false) {
    const now = Date.now();
    for (const [k, v] of this.parts) {
      if (force || now - v.at > this.ttl) { this.parts.delete(k); if (force) return; }
    }
  }
}

module.exports = { MAGIC, VERSION, HEADER, T, NAME, MAX_PAYLOAD, FRAG_CHUNK, encode, decode, fragment, Reassembler, packetId };
