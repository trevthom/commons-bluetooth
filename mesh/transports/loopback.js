// An in-process radio. Tests use it to put several nodes on one "air" without
// sockets, Bluetooth hardware or timing luck. Frames are delivered verbatim,
// so the mesh layer is exercised exactly as it is over a real link.
const EventEmitter = require("events");

let seq = 0;

class LoopbackLink {
  constructor(transportName) {
    this.id = `lb-${++seq}`;
    this.transport = transportName;
    this.peer = null;
    this.onFrame = null;
    this.onClose = null;
    this.closed = false;
  }
  send(buf) { if (!this.closed && this.peer) this.peer.deliver(Buffer.from(buf)); }
  deliver(buf) { setImmediate(() => { if (!this.closed) this.onFrame?.(buf); }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    this.peer?._peerClosed();
  }
  _peerClosed() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.onClose?.());
  }
}

class LoopbackHub {
  constructor() { this.transports = new Set(); }
  transport(name = "loopback") {
    const t = new LoopbackTransport(this, name);
    this.transports.add(t);
    return t;
  }
  // Connect every unconnected pair, the way all devices coming into range would.
  meshAll() {
    const list = [...this.transports];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) list[i].connectTo(list[j]);
  }
}

class LoopbackTransport extends EventEmitter {
  constructor(hub, name) {
    super();
    this.hub = hub;
    this.name = name;
    this.state = "up";
    this.detail = "in-process";
    this.links = new Map(); // other transport -> our link
    this.offline = false;
  }

  async start() { return this; }
  async stop() { for (const link of [...this.links.values()]) link.close(); this.links.clear(); }

  connectTo(other) {
    if (other === this || this.offline || other.offline) return null;
    if (this.links.has(other) || other.links.has(this)) return null;
    const a = new LoopbackLink(this.name);
    const b = new LoopbackLink(other.name);
    a.peer = b; b.peer = a;
    this.links.set(other, a);
    other.links.set(this, b);
    this.emit("link", a);
    other.emit("link", b);
    return [a, b];
  }

  disconnectFrom(other) {
    const link = this.links.get(other);
    if (link) link.close();
    this.links.delete(other);
    other.links.delete(this);
  }
}

module.exports = { LoopbackHub, LoopbackTransport };
