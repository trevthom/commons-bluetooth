// A simulated Bluetooth radio, for development on a machine without one.
//
// It models what actually constrains the mesh: discovery is asynchronous, each
// link carries one peer, and a characteristic write is small (180 bytes), so a
// frame is chunked and reassembled before the mesh ever sees it. It is not
// Bluetooth — it is a stand-in that lets the full mesh be exercised in one
// process, and the UI says so.
const EventEmitter = require("events");
const crypto = require("crypto");
const { chunkFrame, ChunkAssembler } = require("./chunk");

class MockAir {
  constructor() { this.radios = new Set(); }
  join(radio) { this.radios.add(radio); }
  leave(radio) { this.radios.delete(radio); }
}

class MockLink {
  constructor(name) {
    this.id = "mock-" + crypto.randomBytes(4).toString("hex");
    this.transport = name;
    this.peer = null;
    this.onFrame = null;
    this.onClose = null;
    this.closed = false;
    this.assembler = new ChunkAssembler();
  }
  send(buf) {
    if (this.closed || !this.peer) return;
    // Split into characteristic-sized writes, like a real radio.
    for (const part of chunkFrame(buf)) {
      setImmediate(() => { if (!this.closed && this.peer) this.peer.receive(part); });
    }
  }
  receive(part) { const frame = this.assembler.push(part); if (frame) this.onFrame?.(frame); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    this.peer?._peerClosed();
  }
  _peerClosed() { if (this.closed) return; this.closed = true; setImmediate(() => this.onClose?.()); }
}

class MockBleTransport extends EventEmitter {
  constructor({ name = "ble-mock", air = new MockAir(), autoConnect = true } = {}) {
    super();
    this.name = name;
    this.air = air;
    this.state = "down";
    this.detail = "simulated radio";
    this.links = new Map();
    this.autoConnect = autoConnect;
    this.timer = null;
  }

  async start() {
    this.air.join(this);
    this.state = "up";
    if (this.autoConnect) {
      this.timer = setInterval(() => this.connectNearby(), 700);
      this.timer.unref?.();
    }
    return this;
  }

  connectNearby() {
    for (const other of this.air.radios) {
      if (other === this || this.links.has(other) || other.links.has(this)) continue;
      this.connectTo(other);
    }
  }

  connectTo(other) {
    if (this.links.has(other) || other.links.has(this)) return;
    const a = new MockLink(this.name);
    const b = new MockLink(other.name);
    a.peer = b; b.peer = a;
    this.links.set(other, a);
    other.links.set(this, b);
    this.emit("link", a);
    other.emit("link", b);
  }

  disconnectFrom(other) {
    const link = this.links.get(other);
    if (link) { this.links.delete(other); link.closed = true; link.onClose?.(); }
    const back = other.links.get(this);
    if (back) { other.links.delete(this); back.closed = true; back.onClose?.(); }
  }

  async stop() {
    clearInterval(this.timer);
    this.air.leave(this);
    for (const link of this.links.values()) { link.closed = true; link.onClose?.(); }
    this.links.clear();
    this.state = "down";
  }
}

module.exports = { MockAir, MockBleTransport };
