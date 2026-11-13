// The local node API.
//
// The browser talks to the node running on the same device, over loopback. That
// is not how parties communicate — it is the app talking to its own radio. The
// endpoints keep the shapes the Commons UI already uses, so the interface stays
// the interface; what is underneath is now a replicated event log instead of a
// server database.
const crypto = require("crypto");
const C = require("./crypto");
const { clean } = require("./state");
const { parseInvite, inviteProof } = require("./invite");
const { IMAGE_TYPES } = require("./store");
const Identity = require("./identity");

const MAX_BODY = 1e6;
const MAX_IMAGE = 4e6;
const DAY = 86400000;

const sendJSON = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const label = (key) => "user-" + String(key || "").slice(0, 4);

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve) => {
    let d = ""; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => { d += c; if (d.length > max) finish({}); });
    req.on("end", () => { try { finish(JSON.parse(d || "{}")); } catch { finish({}); } });
    req.on("error", () => finish({}));
  });
}
function readRaw(req, max) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => { if (done) return; n += c.length; if (n > max) { finish(null); req.resume(); } else chunks.push(c); });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", () => finish(null));
  });
}

const sessionId = (identity) => C.sha256hex("session|" + identity.key).slice(0, 16);
const msgKey = (gid, ev) => `msg:${gid}:general:${ev.ts}:${ev.id.slice(0, 8)}`;

function createApi(node) {
  const pending = new Map(); // imageId -> { gid, image, at }

  return async function handleApi(req, res, url) {
    const p = url.pathname;
    const id = node.identity;
    const store = node.store;
    const mesh = node.mesh;

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // Only a page served by this node may drive it. Comparing Origin to Host
    // blocks a random website from posting to the local port, while still
    // allowing 127.0.0.1, localhost, a LAN address or a hosted preview.
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch {}
      if (!originHost || originHost !== req.headers.host) return sendJSON(res, 403, { error: "forbidden-origin" });
    }

    const authed = (body) => body && body.key && body.key === id.key;

    // ===== identity ==========================================================
    if (p === "/api/account/create" && req.method === "POST") {
      const existed = !node.freshIdentity;
      node.freshIdentity = false;
      return sendJSON(res, 200, {
        key: id.key, identityKey: id.exportKey(), sessionId: sessionId(id), existing: existed,
        peerId: id.peerId,
      });
    }
    if (p === "/api/account/login" && req.method === "POST") {
      const body = await readBody(req);
      const raw = String(body.key || "").replace(/[^A-Za-z0-9]/g, "");
      let next;
      try { next = Identity.fromExport(raw); } catch { return sendJSON(res, 200, { ok: false, error: "invalid-key" }); }
      if (next.key === id.key) {
        return sendJSON(res, 200, { ok: true, key: id.key, identityKey: id.exportKey(), sessionId: sessionId(id) });
      }
      // Importing a key replaces this device's identity; the old one stops
      // being able to write, while everything it already signed stays valid.
      node.setIdentity(next);
      return sendJSON(res, 200, { ok: true, key: next.key, identityKey: next.exportKey(), sessionId: sessionId(next) });
    }
    if (p === "/api/account/session") {
      const key = String(url.searchParams.get("key") || "");
      return sendJSON(res, 200, { valid: key === id.key });
    }

    // ===== node status (what the Bluetooth panel shows) ======================
    if (p === "/api/node/status") {
      const st = mesh.status();
      return sendJSON(res, 200, {
        ok: true,
        name: node.name,
        key: id.key,
        peerId: id.peerId,
        identityKey: id.exportKey(),
        memberships: store.groupIds().length,
        ...st,
      });
    }

    // ===== groups ============================================================
    if (p === "/api/group/create" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const name = clean(body.name, 40);
      if (!name) return sendJSON(res, 200, { ok: false, error: "invalid-name" });
      const gid = crypto.randomBytes(8).toString("hex");
      const secret = C.b64u(crypto.randomBytes(32));
      store.addGroup({ gid, secret, name, ownerKey: id.key, createdAt: Date.now() });
      mesh.publish(gid, "group", { name });
      mesh.publish(gid, "join", { name: null, invite: inviteProof(secret, gid) });
      mesh.requestSync();
      return sendJSON(res, 200, { ok: true, group: store.get(`group:${gid}`) });
    }

    if (p === "/api/group/join" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const inv = parseInvite(body.code);
      if (!inv) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (store.hasGroup(inv.gid)) return sendJSON(res, 200, { ok: true, group: store.get(`group:${inv.gid}`) });
      store.addGroup({ gid: inv.gid, secret: inv.secret, name: inv.name, ownerKey: inv.ownerKey, createdAt: Date.now() });
      mesh.publish(inv.gid, "join", { name: null, invite: inviteProof(inv.secret, inv.gid), once: inv.once });
      mesh.requestSync();
      const g = store.get(`group:${inv.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if ((g.banned || []).includes(id.key)) { store.dropGroup(inv.gid); return sendJSON(res, 200, { ok: false, error: "banned" }); }
      return sendJSON(res, 200, { ok: true, group: g });
    }

    // Any member can mint the one-time invite; a new one replaces the old.
    if (p === "/api/group/invite" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (!g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      mesh.publish(g.id, "rotate", { nonce: crypto.randomBytes(9).toString("hex") });
      const next = store.get(`group:${g.id}`);
      return sendJSON(res, 200, { ok: true, code: next.inviteOnce, group: next });
    }

    if (p === "/api/group/claimname" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const username = clean(body.username, 24);
      if (!username) return sendJSON(res, 200, { ok: false, error: "invalid" });
      const lc = username.toLowerCase();
      if (g.usernames[lc] && g.usernames[lc] !== id.key) return sendJSON(res, 200, { ok: false, error: "taken" });
      const mem = g.members[id.key];
      const first = !mem.username;
      if (!first && lc !== mem.username.toLowerCase()) {
        const since = Date.now() - (mem.lastNameChange || 0);
        if (since < 60 * DAY) return sendJSON(res, 200, { ok: false, error: "cooldown", daysLeft: Math.ceil((60 * DAY - since) / DAY) });
      }
      mesh.publish(g.id, "name", { username });
      const next = store.get(`group:${g.id}`);
      return sendJSON(res, 200, { ok: true, group: next, changedFrom: first ? null : mem.username });
    }

    if (p === "/api/group/remove" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (!(g.ownerKey === id.key || (g.admins || []).includes(id.key))) return sendJSON(res, 200, { ok: false, error: "not-admin" });
      if (body.targetKey === g.ownerKey) return sendJSON(res, 200, { ok: false, error: "cant-remove-owner" });
      mesh.publish(g.id, "remove", { target: String(body.targetKey || "") });
      return sendJSON(res, 200, { ok: true, group: store.get(`group:${g.id}`) });
    }

    if (p === "/api/group/toggleadmin" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (g.ownerKey !== id.key) return sendJSON(res, 200, { ok: false, error: "not-owner" });
      if (body.targetKey === g.ownerKey) return sendJSON(res, 200, { ok: false, error: "cant-change-owner" });
      if (!g.members[body.targetKey]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      mesh.publish(g.id, "admin", { target: String(body.targetKey) });
      return sendJSON(res, 200, { ok: true, group: store.get(`group:${g.id}`) });
    }

    if (p === "/api/group/ban" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (g.ownerKey !== id.key) return sendJSON(res, 200, { ok: false, error: "not-owner" });
      if (body.targetKey === g.ownerKey) return sendJSON(res, 200, { ok: false, error: "cant-ban-owner" });
      mesh.publish(g.id, "ban", { target: String(body.targetKey) });
      return sendJSON(res, 200, { ok: true, group: store.get(`group:${g.id}`) });
    }

    if (p === "/api/group/delete" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (g.ownerKey !== id.key) return sendJSON(res, 200, { ok: false, error: "not-owner" });
      mesh.publish(g.id, "destroy", {});
      store.dropGroup(g.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ===== general chat ======================================================
    if (p === "/api/message/send" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const text = clean(body.text, 4000);
      let image = null;
      if (body.imageId) {
        const up = pending.get(String(body.imageId));
        if (!up || up.gid !== g.id) return sendJSON(res, 200, { ok: false, error: "image-expired" });
        pending.delete(String(body.imageId));
        image = up.image;
      }
      if (!text && !image) return sendJSON(res, 200, { ok: false, error: "empty" });
      const ev = mesh.publish(g.id, "msg", {
        text, anon: !!body.anon, image,
        replyTo: body.replyTo && body.replyTo.key ? { key: String(body.replyTo.key) } : null,
      });
      if (!ev) return sendJSON(res, 200, { ok: false, error: "failed" });
      const key = msgKey(g.id, ev);
      return sendJSON(res, 200, { ok: true, key, message: store.get(key) });
    }

    if (p === "/api/poll/create" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const question = clean(body.question, 200);
      const texts = (Array.isArray(body.options) ? body.options : []).map((o) => clean(o, 80)).filter(Boolean);
      if (!question) return sendJSON(res, 200, { ok: false, error: "empty" });
      if (texts.length < 2) return sendJSON(res, 200, { ok: false, error: "too-few-options" });
      if (texts.length > 10) return sendJSON(res, 200, { ok: false, error: "too-many-options" });
      const lower = texts.map((t) => t.toLowerCase());
      if (new Set(lower).size !== lower.length) return sendJSON(res, 200, { ok: false, error: "duplicate-options" });
      const ev = mesh.publish(g.id, "msg", {
        text: question, anon: false,
        poll: { options: texts.map((text) => ({ text })), multi: !!body.multi },
        replyTo: body.replyTo && body.replyTo.key ? { key: String(body.replyTo.key) } : null,
      });
      if (!ev) return sendJSON(res, 200, { ok: false, error: "failed" });
      const key = msgKey(g.id, ev);
      return sendJSON(res, 200, { ok: true, key, message: store.get(key) });
    }

    if (p === "/api/message/delete" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const m = store.get(String(body.msgKey || ""));
      if (!m || m.system) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (m.author !== id.key && !(g.ownerKey === id.key || g.admins.includes(id.key))) return sendJSON(res, 200, { ok: false, error: "not-allowed" });
      mesh.publish(g.id, "delete", { target: String(body.msgKey) });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === "/api/message/edit" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.msgKey || "");
      const m = store.get(key);
      if (!m || m.system) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (m.author !== id.key) return sendJSON(res, 200, { ok: false, error: "forbidden" });
      if (m.poll) return sendJSON(res, 200, { ok: false, error: "not-editable" });
      const text = clean(body.text, 4000);
      if (!text && !m.image) return sendJSON(res, 200, { ok: false, error: "empty" });
      if (text !== m.text) mesh.publish(g.id, "edit", { target: key, text });
      return sendJSON(res, 200, { ok: true, key, message: store.get(key) });
    }

    if (p === "/api/message/react" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.msgKey || "");
      const m = store.get(key);
      if (!m || m.system) return sendJSON(res, 200, { ok: false, error: "not-found" });
      mesh.publish(g.id, "react", { target: key, emoji: String(body.emoji || "") });
      return sendJSON(res, 200, { ok: true, key, message: store.get(key) });
    }

    if (p === "/api/poll/vote" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.msgKey || "");
      const m = store.get(key);
      if (!m || !m.poll || !m.poll.options.some((o) => o.id === String(body.optionId))) return sendJSON(res, 200, { ok: false, error: "not-found" });
      mesh.publish(g.id, "vote", { target: key, optionId: String(body.optionId) });
      return sendJSON(res, 200, { ok: true, key, message: store.get(key) });
    }

    if (p === "/api/message/search" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const q = clean(body.q, 200);
      if (!q) return sendJSON(res, 200, { ok: true, results: [], total: 0 });
      const needle = q.toLowerCase();
      const prefix = `msg:${g.id}:general:`;
      const results = [];
      for (const k of store.list(prefix)) {
        const m = store.get(k);
        if (!m || m.system || !String(m.text || "").toLowerCase().includes(needle)) continue;
        results.push({ key: k, id: m.id, ts: m.ts, author: m.author, anon: !!m.anon, authorName: m.authorName, text: m.text });
      }
      results.sort((a, b) => b.ts - a.ts);
      return sendJSON(res, 200, { ok: true, results: results.slice(0, 200), total: results.length });
    }

    // ===== forum =============================================================
    if (p === "/api/post/create" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const text = clean(body.text, 4000);
      if (!text) return sendJSON(res, 200, { ok: false, error: "empty" });
      const ev = mesh.publish(g.id, "post", { title: clean(body.title, 80), text, anon: !!body.anon });
      const key = `post:${g.id}:${ev.ts}:${ev.id.slice(0, 8)}`;
      return sendJSON(res, 200, { ok: true, key, post: store.get(key) });
    }
    if (p === "/api/post/edit" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.postKey || "");
      const po = store.get(key);
      if (!po) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (po.author !== id.key) return sendJSON(res, 200, { ok: false, error: "forbidden" });
      const text = clean(body.text, 4000);
      if (!text) return sendJSON(res, 200, { ok: false, error: "empty" });
      mesh.publish(g.id, "post_edit", { target: key, title: clean(body.title, 80), text });
      return sendJSON(res, 200, { ok: true, key, post: store.get(key) });
    }
    if (p === "/api/post/editReply" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.postKey || "");
      const po = store.get(key);
      const reply = po && (po.replies || []).find((r) => r.id === String(body.replyId));
      if (!reply) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (reply.author !== id.key) return sendJSON(res, 200, { ok: false, error: "forbidden" });
      const text = clean(body.text, 4000);
      if (!text) return sendJSON(res, 200, { ok: false, error: "empty" });
      mesh.publish(g.id, "post_edit_reply", { target: key, replyId: reply.id, text });
      return sendJSON(res, 200, { ok: true, key, post: store.get(key) });
    }
    if (p === "/api/post/delete" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.postKey || "");
      const po = store.get(key);
      if (!po) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (po.author !== id.key && !(g.ownerKey === id.key || g.admins.includes(id.key))) return sendJSON(res, 200, { ok: false, error: "not-allowed" });
      mesh.publish(g.id, "post_delete", { target: key });
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/post/reply" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.postKey || "");
      if (!store.get(key)) return sendJSON(res, 200, { ok: false, error: "not-found" });
      const text = clean(body.text, 4000);
      if (!text) return sendJSON(res, 200, { ok: false, error: "empty" });
      mesh.publish(g.id, "post_reply", { target: key, text, anon: !!body.anon });
      return sendJSON(res, 200, { ok: true, post: store.get(key) });
    }
    if (p === "/api/post/deleteReply" && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const key = String(body.postKey || "");
      const po = store.get(key);
      const reply = po && (po.replies || []).find((r) => r.id === String(body.replyId));
      if (!reply) return sendJSON(res, 200, { ok: false, error: "not-found" });
      if (reply.author !== id.key && !(g.ownerKey === id.key || g.admins.includes(id.key))) return sendJSON(res, 200, { ok: false, error: "not-allowed" });
      mesh.publish(g.id, "post_delete_reply", { target: key, replyId: reply.id });
      return sendJSON(res, 200, { ok: true, post: store.get(key) });
    }

    // ===== pins ==============================================================
    if ((p === "/api/group/pin" || p === "/api/group/unpin") && req.method === "POST") {
      const body = await readBody(req);
      if (!authed(body)) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${body.gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      if (!(g.ownerKey === id.key || g.admins.includes(id.key))) return sendJSON(res, 200, { ok: false, error: "not-admin" });
      const key = String(body.msgKey || "");
      if (p === "/api/group/pin" && !store.get(key)) return sendJSON(res, 200, { ok: false, error: "not-found" });
      mesh.publish(g.id, p === "/api/group/pin" ? "pin" : "unpin", { target: key });
      return sendJSON(res, 200, { ok: true, group: store.get(`group:${g.id}`) });
    }

    // ===== reads =============================================================
    if (p === "/api/get") {
      const key = url.searchParams.get("key");
      if (!key || key.startsWith("account:")) return sendJSON(res, 403, { error: "forbidden" });
      const value = store.get(key);
      return sendJSON(res, 200, value === undefined ? null : { key, value });
    }
    if (p === "/api/mget") {
      const prefix = url.searchParams.get("prefix") || "";
      const since = Number(url.searchParams.get("since")) || 0;
      return sendJSON(res, 200, { prefix, items: store.mget(prefix, since) });
    }
    if (p === "/api/list") {
      const prefix = url.searchParams.get("prefix") || "";
      return sendJSON(res, 200, { keys: store.list(prefix), prefix });
    }

    // ===== pictures ==========================================================
    if (p === "/api/image/upload" && req.method === "POST") {
      const key = String(req.headers["x-commons-key"] || "");
      const gid = String(req.headers["x-commons-group"] || "");
      if (key !== id.key) return sendJSON(res, 200, { ok: false, error: "auth" });
      const g = store.get(`group:${gid}`);
      if (!g || !g.members[id.key]) return sendJSON(res, 200, { ok: false, error: "not-member" });
      const buf = await readRaw(req, MAX_IMAGE);
      if (!buf) return sendJSON(res, 200, { ok: false, error: "image-too-large" });
      const saved = store.saveBlob(buf, url.searchParams.get("w"), url.searchParams.get("h"));
      if (saved.error) return sendJSON(res, 200, { ok: false, error: saved.error });
      pending.set(saved.image.id, { gid, image: saved.image, at: Date.now() });
      return sendJSON(res, 200, { ok: true, imageId: saved.image.id, image: saved.image });
    }

    const im = /^\/api\/image\/([0-9a-f]{24})\.(jpg|png|webp|gif)$/.exec(p);
    if (im && req.method === "GET") {
      let blob = store.readBlob(im[1]);
      if (!blob) { await mesh.requestBlob(im[1]); blob = store.readBlob(im[1]); }
      if (!blob) return sendJSON(res, 404, { error: "not-found" });
      res.writeHead(200, { "Content-Type": IMAGE_TYPES[blob.ext], "Cache-Control": "private, max-age=2592000, immutable", "X-Content-Type-Options": "nosniff" });
      return res.end(blob.buf);
    }

    if (p.startsWith("/api/")) return sendJSON(res, 404, { error: "not-found" });
    return false;
  };
}

module.exports = { createApi, label };
