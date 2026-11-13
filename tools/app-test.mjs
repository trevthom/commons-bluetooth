// End-to-end test of the local node API and two nodes talking over the LAN
// carrier. The LAN transport moves the exact same packets as Bluetooth, so this
// exercises the real handshake, relay, sync and store-and-forward paths.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const fail = (n, d) => { failures++; console.log(`  FAIL ${n}${d ? "\n       " + d : ""}`); };
const is = (c, n, d) => (c ? ok(n) : fail(n, d));
async function until(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(60); }
  throw new Error("timed out waiting for " + label);
}

const procs = [];
// Always take the nodes down, including when an assertion throws.
process.on("exit", () => { for (const p of procs) { try { p.kill("SIGTERM"); } catch {} } });
function startNode({ port, lan, peers = [], name }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbt-app-"));
  const args = [path.join(root, "server.js"), "--port", String(port), "--lan-port", String(lan), "--host", "127.0.0.1", "--data", dir, "--name", name, "--transport", "lan", "--no-discovery"];
  for (const p of peers) args.push("--peer", p);
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  procs.push(proc);
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  return { proc, dir, log: () => out, base: `http://127.0.0.1:${port}` };
}

const j = async (base, p, body, method = "POST") => {
  const r = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, raw: text }; }
};
const get = (base, p) => j(base, p, null, "GET");

async function waitUp(base) {
  try { const r = await get(base, "/api/node/status"); return r && r.ok; } catch { return false; }
}

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const A = startNode({ port: 9311, lan: 9401, name: "ana-laptop" });
await until(() => waitUp(A.base), "node A to start");
console.log("\nthe local node API");
is((await get(A.base, "/")).status === 200, "the app shell is served");

const acc = await j(A.base, "/api/account/create", {});
is(!!acc.key && !!acc.identityKey && !!acc.sessionId, "an identity is created");
is(acc.key !== acc.identityKey, "the shareable account key is not the secret");
is(acc.identityKey.replace(/[^A-Z2-9]/g, "").length === 52, "the identity key is exportable (52 characters)");
const KEY = acc.key, SID = acc.sessionId, IDKEY = acc.identityKey;

const again = await j(A.base, "/api/account/create", {});
is(again.key === KEY && again.existing === true, "creating again keeps the same device identity");

is((await j(A.base, "/api/account/login", { key: "NOPE" })).ok === false, "a bad identity key is refused");
const relog = await j(A.base, "/api/account/login", { key: IDKEY });
is(relog.ok && relog.key === KEY, "the exported key signs back in");
is((await get(A.base, `/api/account/session?key=${KEY}&sessionId=${SID}`)).valid === true, "the session is valid");
is((await get(A.base, `/api/account/session?key=OTHER&sessionId=${SID}`)).valid === false, "another key is not");

const created = await j(A.base, "/api/group/create", { key: KEY, sessionId: SID, name: "Oak Street" });
is(created.ok && created.group.name === "Oak Street", "a community is created");
const GID = created.group.id;
const named = await j(A.base, "/api/group/claimname", { key: KEY, sessionId: SID, gid: GID, username: "ana" });
is(named.ok && named.group.members[KEY].username === "ana", "a username is claimed");

const sent = await j(A.base, "/api/message/send", { key: KEY, sessionId: SID, gid: GID, text: "hello offline", anon: false });
is(sent.ok && sent.message.text === "hello offline" && sent.message.author === KEY, "a message is sent");
const MKEY = sent.key;

const reacted = await j(A.base, "/api/message/react", { key: KEY, sessionId: SID, gid: GID, msgKey: MKEY, emoji: "🔥" });
is(reacted.ok && reacted.message.reactions["🔥"].includes(KEY), "a reaction is applied");
const edited = await j(A.base, "/api/message/edit", { key: KEY, sessionId: SID, gid: GID, msgKey: MKEY, text: "hello, edited" });
is(edited.ok && edited.message.editedAt, "the author can edit");

const poll = await j(A.base, "/api/poll/create", { key: KEY, sessionId: SID, gid: GID, question: "Tea?", options: ["yes", "no"], multi: false });
is(poll.ok && poll.message.poll.options.length === 2, "a poll is created");
const voted = await j(A.base, "/api/poll/vote", { key: KEY, sessionId: SID, gid: GID, msgKey: poll.key, optionId: "1" });
is(voted.ok && voted.message.poll.votes["1"].length === 1, "a vote is counted");

const post = await j(A.base, "/api/post/create", { key: KEY, sessionId: SID, gid: GID, title: "Meeting", text: "Thursday", anon: false });
is(post.ok && post.post.replies.length === 0, "a forum post is created");
const reply = await j(A.base, "/api/post/reply", { key: KEY, sessionId: SID, gid: GID, postKey: post.key, text: "I'll come", anon: false });
is(reply.ok && reply.post.replies.length === 1, "a forum reply is added");
const pEdit = await j(A.base, "/api/post/edit", { key: KEY, sessionId: SID, gid: GID, postKey: post.key, title: "Meeting", text: "Thursday 7pm" });
is(pEdit.ok && pEdit.post.editedAt, "a forum post is edited");

const pin = await j(A.base, "/api/group/pin", { key: KEY, sessionId: SID, gid: GID, msgKey: MKEY });
is(pin.ok && pin.group.pins.length === 1, "the owner can pin");

const mine = await get(A.base, `/api/mget?prefix=${encodeURIComponent("msg:" + GID + ":")}`);
is(mine.items.length >= 2, "a batch read returns the room");
const search = await j(A.base, "/api/message/search", { key: KEY, sessionId: SID, gid: GID, q: "edited" });
is(search.ok && search.results.length === 1, "search runs over the whole log");
const groupDoc = await get(A.base, `/api/get?key=${encodeURIComponent("group:" + GID)}`);
is(groupDoc && groupDoc.value.invite.startsWith("cb1"), "the group carries a derived invite");
is(!JSON.stringify(groupDoc.value).includes("secret"), "the group secret never reaches the client");

const upload = await fetch(`${A.base}/api/image/upload?w=1&h=1`, { method: "POST", body: PNG, headers: { "X-Commons-Key": KEY, "X-Commons-Session": SID, "X-Commons-Group": GID } }).then((r) => r.json());
is(upload.ok && upload.image.ext === "png", "a picture is accepted by its magic number");
const withPic = await j(A.base, "/api/message/send", { key: KEY, sessionId: SID, gid: GID, text: "", anon: false, imageId: upload.imageId });
is(withPic.ok && withPic.message.image.id === upload.image.id, "a message can carry the picture");
const img = await fetch(`${A.base}/api/image/${upload.image.id}.png`);
is(img.status === 200 && img.headers.get("content-type") === "image/png", "the picture is served");

const status = await get(A.base, "/api/node/status");
is(status.ok && Array.isArray(status.peers) && status.transports.length === 1, "node status reports its radio");
is(status.peers.length === 0, "no peers yet");

const badAuth = await j(A.base, "/api/message/send", { key: "WRONG", sessionId: SID, gid: GID, text: "nope" });
is(badAuth.ok === false && badAuth.error === "auth", "a write with the wrong key is refused");

// --------------------------------------------------------------------------
console.log("\ntwo devices over the LAN carrier (same packets as Bluetooth)");
const B = startNode({ port: 9312, lan: 9402, name: "bo-phone", peers: ["127.0.0.1:9401"] });
await until(() => waitUp(B.base), "node B to start");
const bacc = await j(B.base, "/api/account/create", {});
const BKEY = bacc.key, BSID = bacc.sessionId;

const joined = await j(B.base, "/api/group/join", { key: BKEY, sessionId: BSID, code: groupDoc.value.invite });
is(joined.ok && joined.group.name === "Oak Street", "B joins from the invite code alone");
const bname = await j(B.base, "/api/group/claimname", { key: BKEY, sessionId: BSID, gid: GID, username: "bo" });
is(bname.ok, "B claims a username");

await until(async () => (await get(A.base, "/api/node/status")).peers.length === 1, "the two nodes to link");
is(true, "A sees B over the LAN carrier");

await until(async () => {
  const r = await get(A.base, `/api/get?key=${encodeURIComponent("group:" + GID)}`);
  return r && r.value.members[BKEY];
}, "A to learn B is a member");
is(true, "membership converged without a server");

const bMsg = await j(B.base, "/api/message/send", { key: BKEY, sessionId: BSID, gid: GID, text: "from the other device", anon: false });
is(bMsg.ok, "B sends a message");
await until(async () => {
  const r = await get(A.base, `/api/mget?prefix=${encodeURIComponent("msg:" + GID + ":")}`);
  return r.items.some(([, v]) => v.text === "from the other device");
}, "A to receive B's message");
is(true, "the message crossed between the two nodes");

await until(async () => {
  const r = await get(B.base, `/api/mget?prefix=${encodeURIComponent("msg:" + GID + ":")}`);
  return r.items.some(([, v]) => v.text === "hello, edited");
}, "B to receive the history");
is(true, "a new member receives the community's history");

const bReacts = await j(B.base, "/api/message/react", { key: BKEY, sessionId: BSID, gid: GID, msgKey: MKEY, emoji: "👍" });
is(bReacts.ok, "B reacts");
await until(async () => {
  const r = await get(A.base, `/api/get?key=${encodeURIComponent(MKEY)}`);
  return r && r.value.reactions && r.value.reactions["👍"] && r.value.reactions["👍"].includes(BKEY);
}, "A to see B's reaction");
is(true, "a reaction crosses devices");

const banned = await j(A.base, "/api/group/ban", { key: KEY, sessionId: SID, gid: GID, targetKey: BKEY });
is(banned.ok && banned.group.banned.includes(BKEY), "the owner bans B");

await sleep(300);
const afterBan = await j(B.base, "/api/message/send", { key: BKEY, sessionId: BSID, gid: GID, text: "still here" });
is(afterBan.ok === false, "a banned device cannot post");

for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
await sleep(300);

console.log(failures ? `\n${failures} app test(s) failed\n` : "\nall app tests passed\n");
if (failures) {
  console.log("--- node A log ---\n" + A.log().slice(-3000));
  console.log("--- node B log ---\n" + B.log().slice(-3000));
}
process.exit(failures ? 1 : 0);
