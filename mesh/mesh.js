// The mesh: peers, handshakes, relay, sync, store-and-forward.
//
// Everything a peer says to another peer is a signed event. Events are sealed
// with the community's key and broadcast to every link; a node that is not a
// member still forwards them (it cannot read them), and a node that was out of
// range catches up from the first peer it meets by comparing digests.
//
// This is the part of Commons that replaced the HTTP server.
const EventEmitter = require("events");
const crypto = require("crypto");
const C = require("./crypto");
const P = require("./protocol");
const { HLC, makeEvent, verifyEvent } = require("./events");

const TTL = 7;                 // hops an event may travel
const MAX_FRAME = 512 * 1024;  // refuse absurd reassembled frames
const MAX_BLOB = 4 * 1024 * 1024;
const SEEN_TTL = 10 * 60 * 1000;
// Membership events are small and are what make a newcomer a member in
// everyone's eyes, so they are the one thing a peer re-sends on a join.
const MEMBERSHIP = new Set(["group", "join", "name", "admin", "remove", "ban", "destroy", "rotate"]);
const SYNC_EVERY = 25000;
const IDS_PER_MSG = 2000;

class Mesh extends EventEmitter {
  constructor({ identity, store, log = console, deviceName = "commons-bt" }) {
    super();
    this.identity = identity;
    this.store = store;
    this.log = log;
    this.deviceName = deviceName;
    this.clock = new HLC(identity.key);
    this.links = new Set();
    this.transports = new Set();
    this.seen = new Map();
    this.reasm = new P.Reassembler();
    this.blobWaiters = new Map();
    // A node that is not a member still carries a community's sealed traffic.
    // Like bitchat's courier, it holds the most recent packets for a short
    // while, so a message that arrives just before the far side connects is
    // not lost. It can never read them.
    this.relayCache = new Map();
    this.syncTimer = null;
    this.closed = false;
  }

  dbg(...args) { if (process.env.CBT_DEBUG) this.log.info("[mesh]", ...args); }

  attach(transport) {
    this.transports.add(transport);
    transport.on("link", (link) => this.onLink(transport, link));
    transport.on("error", (err) => this.log.warn?.(`[mesh] ${transport.name}: ${err.message}`));
    return transport;
  }

  start() {
    this.syncTimer = setInterval(() => {
      for (const link of this.links) if (link.up) this.sendSum(link);
      this.pruneSeen();
    }, SYNC_EVERY);
    this.syncTimer.unref?.();
  }

  async close() {
    this.closed = true;
    clearInterval(this.syncTimer);
    for (const link of [...this.links]) { try { link.raw.close(); } catch {} }
    for (const t of this.transports) { try { await t.stop(); } catch {} }
    this.links.clear();
  }

  // --- link lifecycle --------------------------------------------------------
  onLink(transport, raw) {
    const link = {
      raw, transport: transport.name || "link", id: raw.id,
      peerId: null, peerKey: null, peerName: null, peerPub: null, groups: [],
      eph: null, nonce: null, key: null, counter: 0, recv: -1, up: false, timer: null,
    };
    this.links.add(link);
    this.dbg(`link ${link.id} open (${transport.name})`);
    raw.onFrame = (buf) => this.onFrame(link, buf);
    raw.onClose = () => this.onDown(link);
    this.sendHello(link);
    link.timer = setTimeout(() => { if (!link.up) this.drop(link, "handshake timeout"); }, 20000);
    link.timer.unref?.();
    return link;
  }

  onDown(link) {
    if (!link) return;
    clearTimeout(link.timer);
    const was = link.up;
    this.links.delete(link);
    if (was) this.emit("peer-down", this.peerInfo(link));
    this.emit("peers", this.peers());
  }

  drop(link, why) {
    try { link.raw.close(); } catch {}
    this.onDown(link);
    if (this.links.size === 0) this.log.info?.(`[mesh] link closed (${why})`);
  }

  helloPayload() {
    const eph = C.x25519Pair();
    const nonce = crypto.randomBytes(16);
    this._hello = { eph, nonce };
    const payload = {
      v: 1,
      peer: this.identity.peerId,
      key: this.identity.key,
      pub: this.identity.pubB64,
      eph: eph.pubB64,
      nonce: C.b64u(nonce),
      groups: this.store.groupIds(),
      name: this.deviceName,
      ts: Date.now(),
    };
    payload.sig = C.b64u(this.identity.sign(C.canonical(payload)));
    return payload;
  }

  sendHello(link) {
    const payload = this.helloPayload();
    // Every link gets a fresh ephemeral key; `eph.priv` is the KeyObject, the
    // pair itself is not a key.
    link.eph = this._hello.eph.priv;
    link.nonce = this._hello.nonce;
    this.send(link, P.T.HELLO, Buffer.from(JSON.stringify(payload)), 1);
  }

  onHello(link, pkt) {
    if (link.up) return;
    let h;
    try { h = JSON.parse(pkt.payload.toString("utf8")); } catch { return this.drop(link, "bad hello"); }
    if (!h || h.v !== 1 || typeof h.pub !== "string" || typeof h.eph !== "string") return this.drop(link, "bad hello");
    // The HELLO proves, with the identity key itself, that the peer owns the
    // account key it claims. Without this a relay could impersonate anyone.
    const { sig, ...rest } = h;
    if (!C.verify(h.pub, C.canonical(rest), C.unb64u(sig))) return this.drop(link, "bad hello signature");
    if (C.b32(C.sha256(C.unb64u(h.pub)).subarray(0, 10), 16) !== h.key) return this.drop(link, "key mismatch");

    link.peerId = String(h.peer || "");
    link.peerKey = String(h.key || "");
    link.peerName = String(h.name || "peer").slice(0, 40);
    link.peerPub = h.pub;
    link.groups = Array.isArray(h.groups) ? h.groups.filter((g) => /^[0-9a-f]{16}$/.test(g)) : [];

    try {
      const shared = C.x25519Shared(link.eph, h.eph);
      link.key = C.linkKey(shared, link.nonce, C.unb64u(h.nonce));
    } catch { return this.drop(link, "handshake failed"); }
    link.up = true;
    clearTimeout(link.timer);
    this.log.info?.(`[mesh] ${link.transport} link up with ${link.peerKey} (${link.peerName})`);
    this.emit("peer", this.peerInfo(link));
    this.emit("peers", this.peers());

    // Catch up on every community we share, and hand over anything we were
    // carrying as a relay.
    this.sendSum(link);
    this.replayRelay(link);
    this.announceMembership();
  }

  // --- frames ---------------------------------------------------------------
  onFrame(link, buf) {
    if (this.closed) return;
    let pkt = P.decode(buf);
    if (!pkt) return;
    if (pkt.type === P.T.FRAG) {
      const full = this.reasm.push(pkt);
      if (!full) return;
      pkt = P.decode(full);
      if (!pkt) return;
    }
    if (pkt.type === P.T.HELLO) return this.onHello(link, pkt);
    this.dbg(`frame ${P.NAME[pkt.type] || pkt.type} from ${pkt.senderId.slice(0, 6)} ttl=${pkt.ttl}`);

    // A packet id already seen is a loop or a duplicate: never apply or relay it.
    if (this.seenPacket(pkt.packetId)) return;

    if (pkt.type === P.T.PING) return this.send(link, P.T.PONG, Buffer.alloc(0), 1);
    if (pkt.type === P.T.PONG) return;

    if (pkt.type === P.T.ENC_EVENT) {
      // Relay even when we are not a member: this is what carries a community
      // around the people in the middle of it, exactly like a mesh should.
      this.relay(link, pkt);
      return this.onEvent(pkt);
    }
    if (pkt.type === P.T.ENC) return this.onEnc(link, pkt);
  }

  relay(from, pkt) {
    if (pkt.ttl <= 1) return;
    const out = Buffer.from(pkt.raw);
    out[3] = pkt.ttl - 1;            // only the TTL changes: the packet id stays
    for (const link of this.links) if (link !== from && link.up) this.sendFrames(link, out);
  }

  seenPacket(id) {
    if (this.seen.has(id)) return true;
    this.seen.set(id, Date.now());
    return false;
  }
  pruneSeen() {
    const cutoff = Date.now() - SEEN_TTL;
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    while (this.seen.size > 8192) this.seen.delete(this.seen.keys().next().value);
  }

  // --- encrypted, link-local traffic ---------------------------------------
  // Both ends must build the same AAD, and it must depend on nothing that
  // changes in flight. The packet's own header supplies the sender id, so a
  // receiver uses the header it got rather than its own identity.
  aad(type, senderIdBytes) {
    return Buffer.concat([Buffer.from([type]), senderIdBytes]);
  }

  sendEnc(link, kind, data) {
    if (!link.up || !link.key) return;
    const plain = Buffer.from(JSON.stringify({ k: kind, d: data }));
    const { iv, ct, tag } = C.seal(link.key, plain, this.aad(P.T.ENC, Buffer.from(this.identity.peerId, "hex")));
    const body = Buffer.alloc(4 + 12 + 16 + ct.length);
    body.writeUInt32BE(link.counter++ >>> 0, 0);
    iv.copy(body, 4);
    tag.copy(body, 16);
    ct.copy(body, 32);
    this.send(link, P.T.ENC, body, 1);
  }

  onEnc(link, pkt) {
    if (!link.up || !link.key) return;
    const b = pkt.payload;
    if (b.length < 32) return;
    const counter = b.readUInt32BE(0);
    if (counter <= link.recv) return this.drop(link, "replayed frame");
    link.recv = counter;
    let msg;
    try {
      msg = JSON.parse(C.open(link.key, b.subarray(4, 16), b.subarray(32), b.subarray(16, 32), this.aad(pkt.type, pkt.raw.subarray(6, 14))).toString("utf8"));
    } catch (err) { return this.drop(link, `undecryptable frame (${err.message})`); }
    if (!msg || typeof msg.k !== "string") return;
    this.onMessage(link, msg.k, msg.d);
  }

  onMessage(link, kind, d) {
    switch (kind) {
      case "sum": return this.onSum(link, d);
      // The peer told us what it holds; ask for everything of theirs we lack.
      case "ids": {
        const have = new Set(this.store.eventIds(d.g));
        const missing = (d.ids || []).filter((id) => !have.has(id)).slice(0, IDS_PER_MSG);
        if (missing.length) this.sendEnc(link, "get", { g: d.g, ids: missing });
        return;
      }
      case "get": {
        if (!this.store.hasGroup(d.g)) return;
        const byId = new Map(this.store.events(d.g).map((e) => [e.id, e]));
        const evs = (d.ids || []).map((id) => byId.get(id)).filter(Boolean).slice(0, IDS_PER_MSG);
        if (evs.length) this.sendEnc(link, "events", { g: d.g, evs });
        return;
      }
      case "events": {
        if (!this.store.hasGroup(d.g)) return;
        let added = 0;
        for (const ev of d.evs || []) {
          if (!verifyEvent(ev) || ev.gid !== d.g) continue;
          this.clock.observe(ev.hlc);
          if (this.store.addEvent(ev)) added++;
        }
        if (added) { this.log.info?.(`[mesh] ${added} new event(s) from ${link.peerKey}`); this.emit("sync", d.g, added); }
        return;
      }
      case "blob_req": {
        const blob = this.store.readBlob(String(d.id || ""));
        if (blob && blob.buf.length <= MAX_BLOB) {
          this.sendEnc(link, "blob_res", { id: d.id, ext: blob.ext, b64: blob.buf.toString("base64") });
        } else this.sendEnc(link, "blob_miss", { id: d.id });
        return;
      }
      case "blob_res": {
        const buf = Buffer.from(String(d.b64 || ""), "base64");
        if (this.store.writeBlob(String(d.id || ""), String(d.ext || ""), buf)) this.resolveBlob(d.id);
        return;
      }
      case "blob_miss": return this.resolveBlob(d.id, true);
      case "ping": return this.sendEnc(link, "pong", {});
      default: return;
    }
  }

  // --- sync ----------------------------------------------------------------
  // The digest is offered for every community we hold, not only the ones the
  // peer advertised at handshake time: a peer may have joined since, and its
  // own request is what makes this cheap.
  sendSum(link) {
    if (!link.up) return;
    const groups = this.store.groupIds().map((g) => { const d = this.store.digest(g); return { g, n: d.n, h: d.h }; });
    this.sendEnc(link, "sum", { groups });
  }

  // Ask every peer to compare notes (used right after joining a community).
  requestSync() {
    for (const link of this.links) if (link.up) this.sendSum(link);
  }

  onSum(link, d) {
    for (const entry of d.groups || []) {
      const g = String(entry.g || "");
      if (!this.store.hasGroup(g)) continue;
      const mine = this.store.digest(g);
      // Digests differ: offer our id list so the peer can pull what it lacks.
      if (mine.n !== entry.n || mine.h !== entry.h) this.sendEnc(link, "ids", { g, ids: this.store.eventIds(g).slice(0, IDS_PER_MSG) });
    }
  }

  // --- events --------------------------------------------------------------
  publish(gid, kind, body) {
    if (!this.store.hasGroup(gid)) return null;
    const ev = makeEvent(this.identity, this.clock, gid, kind, body);
    if (!this.store.addEvent(ev)) return null;
    this.broadcast(gid, ev);
    this.emit("event", gid, ev);
    return ev;
  }

  envelope(gid, ev) {
    const meta = this.store.groupMeta(gid);
    if (!meta) return null;
    const key = C.groupKey(meta.secret, gid);
    const { iv, ct, tag } = C.seal(key, Buffer.from(JSON.stringify(ev)), Buffer.from(gid));
    return Buffer.from(JSON.stringify({ g: gid, n: C.b64u(iv), c: C.b64u(ct), t: C.b64u(tag) }));
  }

  broadcast(gid, ev) {
    const payload = this.envelope(gid, ev);
    if (!payload) return;
    const frame = P.encode({ type: P.T.ENC_EVENT, ttl: TTL, senderId: this.identity.peerId, payload });
    for (const link of this.links) if (link.up) this.sendFrames(link, frame);
  }

  // Keep a recently relayed packet so a peer that connects a moment later still
  // gets it. Bounded by count and age; nothing is ever decrypted.
  cacheRelay(pkt, gid) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, e] of this.relayCache) if (e.at < cutoff) this.relayCache.delete(id);
    while (this.relayCache.size >= 200) this.relayCache.delete(this.relayCache.keys().next().value);
    this.relayCache.set(pkt.packetId, { frame: Buffer.from(pkt.raw), gid, at: Date.now() });
  }
  replayRelay(link) {
    for (const e of this.relayCache.values()) {
      const out = Buffer.from(e.frame);
      out[3] = TTL - 1;
      this.sendFrames(link, out);
    }
  }

  onEvent(pkt) {
    let env;
    try { env = JSON.parse(pkt.payload.toString("utf8")); } catch { return; }
    const gid = String(env.g || "");
    const meta = this.store.groupMeta(gid);
    this.dbg(`event for ${gid.slice(0, 6)} member=${!!meta}`);
    if (!meta) { this.cacheRelay(pkt, gid); return; }   // relayed only — we cannot read it
    let ev;
    try {
      const key = C.groupKey(meta.secret, gid);
      ev = JSON.parse(C.open(key, C.unb64u(env.n), C.unb64u(env.c), C.unb64u(env.t), Buffer.from(gid)).toString("utf8"));
    } catch (err) { this.dbg("event could not be opened:", err.message); return; }
    if (!verifyEvent(ev) || ev.gid !== gid) { this.dbg("event rejected: bad signature or wrong group"); return; }
    this.clock.observe(ev.hlc);
    if (!this.store.addEvent(ev)) { this.dbg("event not stored (duplicate, expired, or unknown group)"); return; }
    // A member we had never heard of just appeared. Hand over the small
    // membership history so they are a member in our copy too — otherwise our
    // messages would look like they came from a stranger.
    if (ev.kind === "join" && ev.key !== this.identity.key) this.welcome(gid);
    this.emit("event", gid, ev);
    if (ev.body && ev.body.image && ev.body.image.id && !this.store.hasBlob(ev.body.image.id)) {
      this.requestBlob(ev.body.image.id).catch(() => {});
    }
  }

  // Membership is the one part of a community that must reach a peer even
  // through a relay, because without it a member's messages look like a
  // stranger's. It is small, and duplicates are dropped by packet id.
  announceMembership() {
    this.announced = this.announced || new Map();
    for (const gid of this.store.groupIds()) {
      const last = this.announced.get(gid) || 0;
      if (Date.now() - last < 10000) continue;
      this.announced.set(gid, Date.now());
      for (const e of this.store.events(gid)) if (MEMBERSHIP.has(e.kind)) this.broadcast(gid, e);
    }
  }

  welcome(gid) {
    this.welcomed = this.welcomed || new Map();
    const last = this.welcomed.get(gid) || 0;
    if (Date.now() - last < 30000) return;
    this.welcomed.set(gid, Date.now());
    const hist = this.store.events(gid).filter((e) => MEMBERSHIP.has(e.kind));
    for (const e of hist) this.broadcast(gid, e);
  }

  // --- pictures -------------------------------------------------------------
  requestBlob(id, timeout = 4000) {
    if (this.store.hasBlob(id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.blobWaiters.get(id) || [];
      waiters.push(resolve);
      this.blobWaiters.set(id, waiters);
      if (waiters.length === 1) {
        for (const link of this.links) if (link.up) this.sendEnc(link, "blob_req", { id });
        setTimeout(() => this.resolveBlob(id, true), timeout).unref?.();
      }
    });
  }
  resolveBlob(id, ok = false) {
    const waiters = this.blobWaiters.get(id);
    if (!waiters) return;
    this.blobWaiters.delete(id);
    for (const w of waiters) w(ok || this.store.hasBlob(id));
  }

  // --- sending -------------------------------------------------------------
  send(link, type, payload, ttl = 1) {
    if (!link || !link.raw) return;
    const frame = P.encode({ type, ttl, senderId: this.identity.peerId, payload });
    this.sendFrames(link, frame);
  }

  sendFrames(link, frame) {
    try {
      if (frame.length <= 900) link.raw.send(frame);
      else for (const f of P.fragment(frame, this.identity.peerId)) link.raw.send(f);
    } catch (err) {
      this.log.warn?.(`[mesh] send failed: ${err.message}`);
      this.drop(link, "send failed");
    }
  }

  // --- introspection for the UI --------------------------------------------
  peerInfo(link) {
    return {
      peerId: link.peerId,
      key: link.peerKey,
      name: link.peerName,
      transport: link.transport,
      direct: true,
      groups: this.store.groupIds().filter((g) => link.groups.includes(g)),
    };
  }
  peers() {
    return [...this.links].filter((l) => l.up).map((l) => this.peerInfo(l));
  }
  status() {
    return {
      peerId: this.identity.peerId,
      key: this.identity.key,
      peers: this.peers(),
      transports: [...this.transports].map((t) => ({ name: t.name, state: t.state || "up", detail: t.detail || "" })),
    };
  }
}

module.exports = Mesh;
