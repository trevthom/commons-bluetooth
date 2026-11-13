// Mesh tests: crypto, wire format, and the behaviour that makes this offline app
// work — convergence, relay through a non-member, catch-up after being away,
// rejection of forged and outsider events, and moderation without a server.
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const { Node } = require("../mesh/node.js");
const { LoopbackHub } = require("../mesh/transports/loopback.js");
const C = require("../mesh/crypto.js");
const P = require("../mesh/protocol.js");
const { inviteProof, parseInvite } = require("../mesh/invite.js");

let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`); };
const is = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));
const eq = (a, b, name) => is(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(30); }
  throw new Error("timed out waiting for " + label);
}

const quiet = { info: () => {}, warn: () => {}, error: console.error };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbt-"));
const nodes = [];
function makeNode(name) {
  const n = new Node({ dir: tmp(), name, log: quiet });
  nodes.push(n);
  return n;
}

// --- helpers that mirror what the local API does --------------------------
function createGroup(node, name) {
  const gid = crypto.randomBytes(8).toString("hex");
  const secret = C.b64u(crypto.randomBytes(32));
  node.store.addGroup({ gid, secret, name, ownerKey: node.identity.key, createdAt: Date.now() });
  node.mesh.publish(gid, "group", { name });
  node.mesh.publish(gid, "join", { name: null, invite: inviteProof(secret, gid) });
  return gid;
}
function joinGroup(node, code) {
  const inv = parseInvite(code);
  node.store.addGroup({ gid: inv.gid, secret: inv.secret, name: inv.name, ownerKey: inv.ownerKey, createdAt: Date.now() });
  node.mesh.publish(inv.gid, "join", { name: null, invite: inviteProof(inv.secret, inv.gid), once: inv.once });
  return inv.gid;
}
const msgs = (node, gid) => node.store.list(`msg:${gid}:general:`).map((k) => node.store.get(k)).filter((m) => m && !m.system);
const texts = (node, gid) => msgs(node, gid).map((m) => m.text).sort();

// ==========================================================================
console.log("\ncrypto and wire format");
{
  const id = C.ed25519FromSeed(crypto.randomBytes(32));
  const id2 = C.ed25519FromSeed(Buffer.from(id.priv.export({ format: "der", type: "pkcs8" }).subarray(-32)));
  is(id.pubB64 === id2.pubB64, "a seed round-trips to the same Ed25519 key");
  const msg = Buffer.from("hello");
  const sig = C.sign(id.priv, msg);
  is(C.verify(id.pubB64, msg, sig), "signature verifies");
  is(!C.verify(id.pubB64, Buffer.from("hell0"), sig), "a changed message fails");

  eq(C.canonical({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}', "canonical JSON sorts keys");

  const key = crypto.randomBytes(32), aad = Buffer.from("gid");
  const sealed = C.seal(key, Buffer.from("secret"), aad);
  is(C.open(key, sealed.iv, sealed.ct, sealed.tag, aad).toString() === "secret", "AES-GCM round-trips");
  let bad = false; try { C.open(key, sealed.iv, sealed.ct, sealed.tag, Buffer.from("other")); } catch { bad = true; }
  is(bad, "AES-GCM rejects a changed AAD");

  const sender = crypto.randomBytes(8).toString("hex");
  const payload = Buffer.from("x".repeat(4000));
  const frame = P.encode({ type: P.T.ENC, ttl: 7, senderId: sender, payload });
  const dec = P.decode(frame);
  is(dec && dec.payload.length === 4000 && dec.ttl === 7, "packet encodes and decodes");
  const frags = P.fragment(frame, sender);
  is(frags.length > 1, "a large frame is fragmented");
  const re = new P.Reassembler();
  let whole = null;
  for (const f of frags) whole = re.push(P.decode(f)) || whole;
  is(whole && whole.equals(frame), "fragments reassemble to the original packet");

  const tampered = Buffer.from(frame); tampered[tampered.length - 1] ^= 0xff;
  is(P.decode(tampered) === null, "a corrupted packet is refused");

  const { HLC } = require("../mesh/events.js");
  const clock = new HLC("AAAA");
  const first = clock.next(), second = clock.next();
  is(first < second, "HLC values increase");
  const other = new HLC("BBBB");
  other.observe(second);
  is(other.next() > second, "an observed clock stays ahead");
}

// ==========================================================================
console.log("\ngroup creation and convergence");
const hub = new LoopbackHub();
const A = makeNode("ana"); const B = makeNode("bo"); const Cc = makeNode("cy");
const tA = A.attach(hub.transport("loopback-A"));
const tB = B.attach(hub.transport("loopback-B"));
const tC = Cc.attach(hub.transport("loopback-C"));

const gid = createGroup(A, "Oak Street");
A.mesh.publish(gid, "name", { username: "ana" });
const invite = A.store.get(`group:${gid}`).invite;
is(!!invite && invite.startsWith("cb1"), "a reusable invite is derived");
joinGroup(B, invite);
B.mesh.publish(gid, "name", { username: "bo" });

tA.connectTo(tB);
await until(() => B.store.get(`group:${gid}`) && B.store.get(`group:${gid}`).members[A.identity.key], "B to see the group");
await until(() => Cc.store.hasGroup(gid) === false, "C to stay out");

const gB = B.store.get(`group:${gid}`);
is(Object.keys(gB.members).length === 2, "B sees both members");
is(gB.members[A.identity.key].username === "ana", "B learns A's username");
is(gB.name === "Oak Street", "B learns the community name");

// ==========================================================================
console.log("\nmessages, reactions, polls, forum");
A.mesh.publish(gid, "msg", { text: "hello mesh", anon: false });
await until(() => texts(B, gid).includes("hello mesh"), "B to receive a message");
const key = A.store.list(`msg:${gid}:general:`)[0];
B.mesh.publish(gid, "react", { target: key, emoji: "🔥" });
await until(() => { const m = A.store.get(key); return m && m.reactions && m.reactions["🔥"]; }, "A to receive a reaction");
is(true, "a reaction crosses the mesh");

A.mesh.publish(gid, "msg", { text: "pick one", anon: false, poll: { options: [{ text: "yes" }, { text: "no" }], multi: false } });
await until(() => msgs(B, gid).some((m) => m.poll), "B to receive a poll");
const pollKey = B.store.list(`msg:${gid}:general:`).find((k) => B.store.get(k).poll);
B.mesh.publish(gid, "vote", { target: pollKey, optionId: "1" });
await until(() => { const p = msgs(A, gid).find((m) => m.poll); return p && p.poll.votes["1"] && p.poll.votes["1"].length === 1; }, "A to receive the vote");
is(true, "a poll vote crosses the mesh");

A.mesh.publish(gid, "post", { title: "Notice", text: "street meeting", anon: false });
await until(() => B.store.list(`post:${gid}:`).length === 1, "B to receive a forum post");
const postKey = B.store.list(`post:${gid}:`)[0];
B.mesh.publish(gid, "post_reply", { target: postKey, text: "I'll be there", anon: false });
await until(() => (A.store.get(postKey).replies || []).length === 1, "A to receive a forum reply");
is(true, "forum posts and replies cross the mesh");

// ==========================================================================
console.log("\nauthority without a server");
{
  const a = A.store.get(key);
  const b = B.store.get(key);
  is(b.author === a.author, "both sides agree on the author");
  const forged = { ...A.store.events(gid)[0] };
  forged.body = { text: "pretend" };
  const { verifyEvent } = require("../mesh/events.js");
  is(!verifyEvent(forged), "an edited event fails verification");
}

// ==========================================================================
console.log("\ncatch-up after being out of range (store and forward)");
tB.disconnectFrom(tA);
await sleep(80);
A.mesh.publish(gid, "msg", { text: "sent while bo was away", anon: false });
await sleep(120);
is(!texts(B, gid).includes("sent while bo was away"), "B does not have the message yet");
tB.connectTo(tA);
await until(() => texts(B, gid).includes("sent while bo was away"), "B to catch up on reconnect");
is(true, "B caught up from A's stored log");

// A brand new member receives the whole history.
Cc.mesh.publish; // (C is still not a member)
joinGroup(Cc, invite);
tC.connectTo(tB);
await until(() => texts(Cc, gid).includes("hello mesh") && texts(Cc, gid).includes("sent while bo was away"), "C to receive the full history");
is(true, "a new member syncs history from a peer, not a server");

// ==========================================================================
console.log("\nrelaying through a non-member");
const hub2 = new LoopbackHub();
const D = makeNode("dev"); const E = makeNode("eve"); const F = makeNode("fay");
const tD = D.attach(hub2.transport("lb-D"));
const tE = E.attach(hub2.transport("lb-E"));
const tF = F.attach(hub2.transport("lb-F"));
const gid2 = createGroup(D, "Relay Room");
D.mesh.publish(gid2, "name", { username: "dee" });
const invite2 = D.store.get(`group:${gid2}`).invite;
joinGroup(E, invite2);
tD.connectTo(tF);   // only through F
tF.connectTo(tE);
await until(() => D.mesh.peers().length === 1 && E.mesh.peers().length === 1 && F.mesh.peers().length === 2, "the relay links to come up");
is(E.store.get(`group:${gid2}`).name === "Relay Room", "E joined from the invite alone");
is(!F.store.hasGroup(gid2), "the relay did not join the community");

D.mesh.publish(gid2, "msg", { text: "through the middle", anon: false });
await until(() => texts(E, gid2).includes("through the middle"), "E to receive a relayed message");
is(true, "a non-member relayed the message without reading it");

// And a message left at the relay while the far side is away is not lost.
tF.disconnectFrom(tE);
await sleep(80);
D.mesh.publish(gid2, "msg", { text: "left at the relay", anon: false });
await sleep(200);
is(!texts(E, gid2).includes("left at the relay"), "E was away for that message");
tF.connectTo(tE);
await until(() => texts(E, gid2).includes("left at the relay"), "the relay to hand it over on reconnect");
is(true, "a non-member held a sealed message for a peer that arrived later");
await sleep(200);
F.store.flush();
const relayPath = path.join(F.dir, "data.json");
const relayFile = fs.existsSync(relayPath) ? fs.readFileSync(relayPath, "utf8") : "";
is(!relayFile.includes("through the middle"), "the relay's stored data contains no plaintext");

// ==========================================================================
console.log("\nforged and outsider events");
{
  const attacker = makeNode("mal");
  const inv = parseInvite(invite2);
  attacker.store.addGroup({ gid: inv.gid, secret: inv.secret, name: inv.name, ownerKey: inv.ownerKey, createdAt: Date.now() });
  const tX = attacker.attach(hub2.transport("lb-X"));
  tX.connectTo(tE);
  await sleep(200);
  const before = texts(E, gid2).length;
  attacker.mesh.publish(gid2, "msg", { text: "I am not a member", anon: false });
  await sleep(300);
  is(texts(E, gid2).length === before, "a message from a non-member is ignored");
}
{
  // Someone who knows the group secret still cannot rewrite an event.
  const ev = D.store.events(gid2).find((e) => e.kind === "msg");
  const copy = JSON.parse(JSON.stringify(ev));
  copy.body.text = "rewritten";
  const { verifyEvent } = require("../mesh/events.js");
  is(!verifyEvent(copy), "a rewritten event is refused even by a member");
}

// ==========================================================================
console.log("\nmoderation without a server");
{
  const G = makeNode("gus"); const H = makeNode("hal");
  const hub3 = new LoopbackHub();
  const tG = G.attach(hub3.transport("lb-G"));
  const tH = H.attach(hub3.transport("lb-H"));
  const gid3 = createGroup(G, "Mod Room");
  const inv3 = G.store.get(`group:${gid3}`).invite;
  joinGroup(H, inv3);
  H.mesh.publish(gid3, "name", { username: "hal" });
  tG.connectTo(tH);
  await until(() => H.store.get(`group:${gid3}`).members[G.identity.key], "H to see the owner");

  H.mesh.publish(gid3, "pin", { target: G.store.list(`msg:${gid3}:general:`)[0] || "nope" });
  G.mesh.publish(gid3, "msg", { text: "keep this", anon: false });
  const mkey = G.store.list(`msg:${gid3}:general:`)[0];
  H.mesh.publish(gid3, "pin", { target: mkey });
  await sleep(250);
  is((G.store.get(`group:${gid3}`).pins || []).length === 0, "a non-admin cannot pin");

  G.mesh.publish(gid3, "pin", { target: mkey });
  await until(() => (H.store.get(`group:${gid3}`).pins || []).length === 1, "H to see the owner's pin");
  is(true, "the owner can pin");

  G.mesh.publish(gid3, "delete", { target: mkey });
  await until(() => !H.store.get(mkey), "H to see the deletion");
  is(true, "the owner can delete anyone's message");

  G.mesh.publish(gid3, "ban", { target: H.identity.key });
  await until(() => (G.store.get(`group:${gid3}`).banned || []).includes(H.identity.key), "the ban to apply");
  await until(() => !H.store.get(`group:${gid3}`) || (H.store.get(`group:${gid3}`).banned || []).includes(H.identity.key), "H to learn they were banned");
  is(true, "a ban replicates to every member");

  H.mesh.publish(gid3, "msg", { text: "let me back in", anon: false });
  await sleep(250);
  is(!texts(G, gid3).includes("let me back in"), "a banned member's messages are ignored");
}

// ==========================================================================
console.log("\nthe simulated Bluetooth carrier (180-byte writes)");
{
  const { MockAir, MockBleTransport } = require("../mesh/transports/ble-mock.js");
  const air = new MockAir();
  const I = makeNode("ivy"); const J = makeNode("jon");
  const tI = I.attach(new MockBleTransport({ air, name: "ble-mock" }));
  const tJ = J.attach(new MockBleTransport({ air, name: "ble-mock" }));
  await tI.start(); await tJ.start();
  await until(() => I.mesh.peers().length === 1 && J.mesh.peers().length === 1, "the simulated radios to pair", 8000);
  const gid4 = createGroup(I, "Ble Room");
  const inv4 = I.store.get(`group:${gid4}`).invite;
  joinGroup(J, inv4);
  I.mesh.publish(gid4, "msg", { text: "y".repeat(2000), anon: false });
  await until(() => texts(J, gid4).length === 1, "J to receive a 2 KB message over 180-byte writes", 10000);
  is(texts(J, gid4)[0].length === 2000, "the chunked frame arrived whole");
}

for (const n of nodes) await n.close();
await sleep(50);

console.log(failures ? `\n${failures} mesh test(s) failed\n` : "\nall mesh tests passed\n");
process.exit(failures ? 1 : 0);
