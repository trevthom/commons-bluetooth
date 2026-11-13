// Events: the only thing peers exchange. An event is an immutable, signed
// statement ("Ana said this", "this message was pinned"). State is whatever you
// get by replaying them in HLC order, so any two devices that received the same
// events show the same community — no server decides the truth.
const C = require("./crypto");

// A hybrid logical clock. Ordering events by wall time alone lets a peer with a
// wrong clock rewrite history; the counter and key make the order total.
class HLC {
  constructor(key) { this.key = key; this.last = 0; this.count = 0; }
  next() {
    const wall = Date.now();
    if (wall > this.last) { this.last = wall; this.count = 0; } else this.count++;
    return HLC.format(this.last, this.count, this.key);
  }
  observe(hlc) {
    const parts = String(hlc || "").split(".");
    const l = Number(parts[0]) || 0;
    const c = parseInt(parts[1], 36) || 0;
    if (l > this.last) { this.last = l; this.count = c; }
    else if (l === this.last && c > this.count) this.count = c;
  }
  static format(last, count, key) {
    return `${String(last).padStart(14, "0")}.${Math.max(0, count).toString(36).padStart(4, "0").slice(-4)}.${key}`;
  }
}

function signedBody(ev) {
  return C.canonical({ v: ev.v, gid: ev.gid, kind: ev.kind, pub: ev.pub, key: ev.key, ts: ev.ts, hlc: ev.hlc, body: ev.body, id: ev.id });
}
const eventId = (ev) =>
  C.sha256hex(C.canonical({ v: ev.v, gid: ev.gid, kind: ev.kind, pub: ev.pub, key: ev.key, ts: ev.ts, hlc: ev.hlc, body: ev.body }));

// Build and sign a new event. Nothing leaves this function until it is signed.
function makeEvent(identity, clock, gid, kind, body = {}) {
  const ev = {
    v: 1,
    gid,
    kind,
    pub: identity.pubB64,
    key: identity.key,
    ts: Date.now(),
    hlc: clock.next(),
    body: body || {},
  };
  ev.id = eventId(ev);
  ev.sig = C.b64u(identity.sign(signedBody(ev)));
  return ev;
}

// Every event is checked on arrival, wherever it came from: a relay cannot
// change a single character without the id and the signature disagreeing.
function verifyEvent(ev) {
  if (!ev || ev.v !== 1) return false;
  if (typeof ev.gid !== "string" || !/^[0-9a-f]{16}$/.test(ev.gid)) return false;
  if (typeof ev.id !== "string" || !/^[0-9a-f]{64}$/.test(ev.id)) return false;
  if (typeof ev.pub !== "string" || typeof ev.key !== "string") return false;
  if (typeof ev.ts !== "number" || typeof ev.hlc !== "string" || typeof ev.kind !== "string") return false;
  if (!ev.body || typeof ev.body !== "object") return false;
  if (ev.id !== eventId(ev)) return false;
  if (C.b32(C.sha256(C.unb64u(ev.pub)).subarray(0, 10), 16) !== ev.key) return false;
  try { return C.verify(ev.pub, signedBody(ev), C.unb64u(ev.sig)); } catch { return false; }
}

module.exports = { HLC, makeEvent, verifyEvent, eventId, signedBody };
