// A frame is carried over a GATT characteristic in small writes. Each write
// carries the total length, the offset and its bytes, so the other side can
// rebuild the frame and notice a gap instead of decrypting garbage.
const CHUNK = 180; // payload bytes per write (safe for MTU 185 and up)

function chunkFrame(buf) {
  const out = [];
  for (let off = 0; off < buf.length; off += CHUNK) {
    const part = buf.subarray(off, off + CHUNK);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(buf.length, 0);
    head.writeUInt16BE(off, 2);
    out.push(Buffer.concat([head, part]));
  }
  return out;
}

class ChunkAssembler {
  constructor() { this.buf = null; this.got = 0; }
  push(value) {
    if (!Buffer.isBuffer(value) || value.length < 4) return null;
    const total = value.readUInt16BE(0);
    const off = value.readUInt16BE(2);
    if (total > 65535 || off + value.length - 4 > total) return null;
    if (off === 0) { this.buf = Buffer.alloc(total); this.got = 0; }
    if (!this.buf || this.buf.length !== total) return null;
    value.copy(this.buf, off, 4);
    this.got += value.length - 4;
    if (this.got < total) return null;
    const frame = this.buf;
    this.buf = null; this.got = 0;
    return frame;
  }
}

module.exports = { CHUNK, chunkFrame, ChunkAssembler };
