// A TCP transport that speaks the exact same mesh frames as Bluetooth.
//
// It exists for two honest reasons: it is the fallback when a machine has no
// Bluetooth adapter (macOS, Windows, a container), and it is how the mesh can
// be demonstrated and tested end to end. The packets, handshake, relay, sync
// and encryption are identical to the BLE transport — only the carrier differs.
const net = require("net");
const dgram = require("dgram");
const EventEmitter = require("events");
const crypto = require("crypto");

const MAX = 8 * 1024 * 1024;
const BEACON = "COMMONSBT1";

class TcpLink {
  constructor(socket, transport) {
    this.id = crypto.randomBytes(6).toString("hex");
    this.transport = transport.name;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onFrame = null;
    this.onClose = null;
    this.closed = false;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX) return this.close();
      if (this.buf.length < 4 + len) return;
      const frame = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onFrame?.(Buffer.from(frame));
    }
  }
  send(buf) {
    if (this.closed) return;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(buf.length, 0);
    try { this.socket.write(Buffer.concat([head, buf])); } catch { this.close(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
    this.onClose?.();
  }
}

class LanTransport extends EventEmitter {
  constructor({ port = 8788, peers = [], discovery = true, name = "lan", host = "0.0.0.0" } = {}) {
    super();
    this.name = name;
    this.port = port;
    this.peers = peers;
    this.discovery = discovery;
    this.host = host;
    this.state = "down";
    this.detail = "";
    this.server = null;
    this.links = new Set();
    this.udp = null;
    this.reconnect = null;
  }

  async start() {
    await new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        socket.setNoDelay(true);
        const link = new TcpLink(socket, this);
        this.links.add(link);
        link.onClose = () => { this.links.delete(link); this.emit("link-down", link); };
        this.emit("link", link);
      });
      this.server.on("error", (err) => { this.detail = err.message; this.emit("error", err); resolve(); });
      this.server.listen(this.port, this.host, () => { this.state = "up"; this.detail = `tcp ${this.port}`; resolve(); });
    });
    for (const peer of this.peers) this.connectTo(peer);
    this.reconnect = setInterval(() => { for (const peer of this.peers) this.connectTo(peer); }, 10000);
    this.reconnect.unref?.();
    if (this.discovery) this.startBeacon();
    return this;
  }

  connectTo(target) {
    const [host, port] = String(target).split(":");
    if (!host) return;
    if ([...this.links].some((l) => l.socket.remoteAddress === host && l.socket.remotePort === Number(port))) return;
    const socket = net.connect({ host, port: Number(port) || this.port, timeout: 4000 });
    socket.setNoDelay(true);
    socket.once("connect", () => {
      socket.setTimeout(0);
      const link = new TcpLink(socket, this);
      this.links.add(link);
      link.onClose = () => { this.links.delete(link); this.emit("link-down", link); };
      this.emit("link", link);
    });
    socket.once("error", () => { try { socket.destroy(); } catch {} });
  }

  // A tiny UDP beacon lets nodes on the same Wi-Fi find each other without a
  // peer list. It carries no identity — just "a Commons node is at this address".
  startBeacon() {
    try {
      this.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.udp.on("error", () => {});
      this.udp.bind(8789, () => {
        try { this.udp.setBroadcast(true); } catch {}
        const hello = Buffer.from(`${BEACON}:${this.port}`);
        const ping = setInterval(() => { try { this.udp.send(hello, 8789, "255.255.255.255"); } catch {} }, 5000);
        ping.unref?.();
      });
      this.udp.on("message", (msg, rinfo) => {
        if (msg.toString("utf8", 0, BEACON.length) !== BEACON) return;
        if (rinfo.address === "127.0.0.1") return;
        this.connectTo(`${rinfo.address}:${msg.toString("utf8").split(":")[1]}`);
      });
    } catch { this.udp = null; }
  }

  async stop() {
    clearInterval(this.reconnect);
    for (const link of this.links) link.close();
    this.links.clear();
    try { this.udp?.close(); } catch {}
    await new Promise((r) => this.server ? this.server.close(() => r()) : r());
    this.state = "down";
  }
}

module.exports = { LanTransport, TcpLink };
