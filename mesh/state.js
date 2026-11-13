// The reducer. Given a group's events in HLC order, produce the exact documents
// the UI reads (`group:<gid>`, `msg:<gid>:general:…`, `post:<gid>:…`), applying
// the same rules the Commons server used to enforce — author-only edits,
// admin-only pins, owner-only bans, first-claim usernames, 60-day rename
// cooldown, one reaction per member. The difference is that every peer runs
// this same function, so the rules hold without a server.
const DAY = 86400000;

const REACTIONS = ["👍", "👎", "❤️", "🔥", "💯", "😂", "😬", "🤡", "🤨", "🤔", "👀", "🫡", "🫠", "😍", "🤯", "😡", "🥴", "🤝", "💪"];

// Kinds that carry conversation and therefore age out after 30 days. Group
// membership and moderation events are kept, so a community never loses its
// own history of who is in it.
const CONTENT_KINDS = new Set([
  "msg", "edit", "delete", "react", "vote", "pin", "unpin",
  "post", "post_edit", "post_delete", "post_reply", "post_edit_reply", "post_delete_reply",
]);

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max);
const msgKeyOf = (gid, ev) => `msg:${gid}:general:${ev.ts}:${ev.id.slice(0, 8)}`;
const postKeyOf = (gid, ev) => `post:${gid}:${ev.ts}:${ev.id.slice(0, 8)}`;

const blankGroup = (id, ownerKey, name, createdAt) => ({
  id, name, createdAt, ownerKey,
  admins: [], members: {}, usernames: {}, banned: [], pins: [],
  inviteNonce: null, inviteOnceUsed: false,
});

function validPoll(p) {
  if (!p || !Array.isArray(p.options)) return false;
  const names = p.options.map((o) => clean(o.text, 80)).filter(Boolean);
  if (names.length < 2 || names.length > 10) return false;
  const lower = names.map((t) => t.toLowerCase());
  return new Set(lower).size === lower.length;
}

function materialize(gid, events, meta) {
  let group = meta
    ? blankGroup(gid, meta.ownerKey, meta.name, meta.createdAt)
    : null;
  const kv = {};
  let deleted = false;

  const member = (k) => !!(group && group.members[k]);
  const isOwner = (k) => !!(group && group.ownerKey === k);
  const isAdmin = (k) => !!(group && (group.ownerKey === k || group.admins.includes(k)));
  const nameOf = (k) => (group && group.members[k] && group.members[k].username) || null;
  const live = (key) => (kv[key] && !kv[key].system ? kv[key] : null);

  function claim(k, rawName, ts) {
    const username = clean(rawName, 24);
    if (!username || !group.members[k]) return;
    const lc = username.toLowerCase();
    const holder = group.usernames[lc];
    if (holder && holder !== k) return;
    const mem = group.members[k];
    const first = !mem.username;
    if (!first) {
      if (lc === mem.username.toLowerCase()) return;
      if (ts - (mem.lastNameChange || 0) < 60 * DAY) return;
    }
    const old = mem.username;
    group.usernames[lc] = k;           // the old reservation is kept on purpose
    mem.username = username;
    if (!first) {
      mem.lastNameChange = ts;
      const id = `s${Math.abs(hashCode(old + username + ts)).toString(36)}`.slice(0, 8);
      kv[`msg:${gid}:general:${ts}:${id}`] = { id, ts, system: true, gid, text: `${old} changed their name to ${username}` };
    }
  }
  function hashCode(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

  for (const ev of events) {
    if (deleted) break;
    const b = ev.body || {};

    switch (ev.kind) {
      case "group": {
        // The first group event creates the community; later ones rename it.
        if (!group) { group = blankGroup(gid, ev.key, clean(b.name, 40), ev.ts); }
        else if (isOwner(ev.key) && clean(b.name, 40)) group.name = clean(b.name, 40);
        break;
      }
      case "join": {
        if (!group || group.banned.includes(ev.key) || group.members[ev.key]) break;
        group.members[ev.key] = { username: null, joinedAt: ev.ts, lastNameChange: 0 };
        if (b.name) claim(ev.key, b.name, ev.ts);
        // A one-time invite is spent by the first join that presents it.
        if (b.once && group.inviteNonce === b.once) group.inviteOnceUsed = true;
        break;
      }
      case "name": {
        if (member(ev.key)) claim(ev.key, b.username, ev.ts);
        break;
      }
      case "admin": {
        if (!group || !isOwner(ev.key)) break;
        const t = String(b.target || "");
        if (!t || t === group.ownerKey || !member(t)) break;
        group.admins = group.admins.includes(t) ? group.admins.filter((k) => k !== t) : [...group.admins, t];
        break;
      }
      case "remove": {
        if (!group || !isAdmin(ev.key)) break;
        const t = String(b.target || "");
        if (!t || t === group.ownerKey) break;
        delete group.members[t];
        group.admins = group.admins.filter((k) => k !== t);
        break;
      }
      case "ban": {
        if (!group || !isOwner(ev.key)) break;
        const t = String(b.target || "");
        if (!t || t === group.ownerKey) break;
        if (!group.banned.includes(t)) group.banned.push(t);
        delete group.members[t];
        group.admins = group.admins.filter((k) => k !== t);
        break;
      }
      case "destroy": {
        if (group && isOwner(ev.key)) deleted = true;
        break;
      }
      case "rotate": {
        if (member(ev.key)) { group.inviteNonce = clean(b.nonce, 64) || null; group.inviteOnceUsed = false; }
        break;
      }

      // --- general chat -----------------------------------------------------
      case "msg": {
        if (!group || !member(ev.key)) break;
        const text = clean(b.text, 4000);
        if (!text && !b.image) break;
        const m = { id: ev.id.slice(0, 8), ts: ev.ts, text, anon: !!b.anon, author: ev.key, authorName: nameOf(ev.key), gid };
        if (b.image && b.image.id && /^[0-9a-f]{24}$/.test(b.image.id) && b.image.ext) m.image = { id: b.image.id, ext: b.image.ext, w: b.image.w | 0, h: b.image.h | 0 };
        if (b.poll && validPoll(b.poll)) {
          const options = b.poll.options.map((o, i) => ({ id: String(i + 1), text: clean(o.text, 80) })).slice(0, 10);
          m.poll = { options, multi: !!b.poll.multi, votes: {} };
        }
        if (b.replyTo) {
          const pk = String(b.replyTo.key || "");
          const par = live(pk);
          if (par && pk.startsWith(`msg:${gid}:general:`)) m.replyTo = { key: pk, id: par.id, ts: par.ts, author: par.author, anon: !!par.anon };
        }
        kv[msgKeyOf(gid, ev)] = m;
        break;
      }
      case "edit": {
        if (!group || !member(ev.key)) break;
        const m = live(String(b.target || ""));
        if (!m || m.author !== ev.key || m.poll) break;
        const text = clean(b.text, 4000);
        if (!text && !m.image) break;
        if (text !== m.text) { m.text = text; m.editedAt = ev.ts; m.updatedAt = ev.ts; }
        break;
      }
      case "delete": {
        if (!group || !member(ev.key)) break;
        const key = String(b.target || "");
        const m = live(key);
        if (!m) break;
        if (m.author !== ev.key && !isAdmin(ev.key)) break;
        delete kv[key];
        break;
      }
      case "react": {
        if (!group || !member(ev.key)) break;
        const m = live(String(b.target || ""));
        const emoji = String(b.emoji || "");
        if (!m || !REACTIONS.includes(emoji)) break;
        m.reactions = m.reactions && typeof m.reactions === "object" ? m.reactions : {};
        const had = Array.isArray(m.reactions[emoji]) && m.reactions[emoji].includes(ev.key);
        for (const [e, who] of Object.entries(m.reactions)) {
          const rest = Array.isArray(who) ? who.filter((k) => k !== ev.key) : [];
          if (rest.length) m.reactions[e] = rest; else delete m.reactions[e];
        }
        if (!had) m.reactions[emoji] = [...(m.reactions[emoji] || []), ev.key];
        if (!Object.keys(m.reactions).length) delete m.reactions;
        m.updatedAt = ev.ts;
        break;
      }
      case "vote": {
        if (!group || !member(ev.key)) break;
        const m = live(String(b.target || ""));
        const optionId = String(b.optionId || "");
        if (!m || !m.poll || !m.poll.options.some((o) => o.id === optionId)) break;
        const votes = (m.poll.votes && typeof m.poll.votes === "object") ? m.poll.votes : {};
        const had = Array.isArray(votes[optionId]) && votes[optionId].includes(ev.key);
        if (!m.poll.multi) {
          for (const [o, who] of Object.entries(votes)) {
            const rest = Array.isArray(who) ? who.filter((k) => k !== ev.key) : [];
            if (rest.length) votes[o] = rest; else delete votes[o];
          }
          if (!had) votes[optionId] = [...(votes[optionId] || []), ev.key];
        } else if (had) {
          votes[optionId] = votes[optionId].filter((k) => k !== ev.key);
          if (!votes[optionId].length) delete votes[optionId];
        } else votes[optionId] = [...(votes[optionId] || []), ev.key];
        m.poll.votes = votes;
        m.updatedAt = ev.ts;
        break;
      }
      case "pin": {
        if (!group || !member(ev.key) || !isAdmin(ev.key)) break;
        const key = String(b.target || "");
        const m = live(key);
        if (!m || group.pins.some((p) => p.key === key)) break;
        group.pins.push({ key, id: m.id, ts: m.ts, author: m.author, anon: !!m.anon, pinnedBy: ev.key, pinnedAt: ev.ts });
        break;
      }
      case "unpin": {
        if (!group || !member(ev.key) || !isAdmin(ev.key)) break;
        group.pins = group.pins.filter((p) => p.key !== String(b.target || ""));
        break;
      }

      // --- forum ------------------------------------------------------------
      case "post": {
        if (!group || !member(ev.key)) break;
        const text = clean(b.text, 4000);
        if (!text) break;
        kv[postKeyOf(gid, ev)] = {
          id: ev.id.slice(0, 8), ts: ev.ts, title: clean(b.title, 80), text, anon: !!b.anon,
          author: ev.key, authorName: nameOf(ev.key), gid, replies: [],
        };
        break;
      }
      case "post_edit": {
        if (!group || !member(ev.key)) break;
        const po = kv[String(b.target || "")];
        if (!po || po.author !== ev.key) break;
        const text = clean(b.text, 4000);
        if (!text) break;
        const title = clean(b.title, 80);
        if (text !== po.text || title !== (po.title || "")) { po.title = title; po.text = text; po.editedAt = ev.ts; po.updatedAt = ev.ts; }
        break;
      }
      case "post_delete": {
        if (!group || !member(ev.key)) break;
        const k = String(b.target || "");
        const po = kv[k];
        if (!po) break;
        if (po.author !== ev.key && !isAdmin(ev.key)) break;
        delete kv[k];
        break;
      }
      case "post_reply": {
        if (!group || !member(ev.key)) break;
        const po = kv[String(b.target || "")];
        const text = clean(b.text, 4000);
        if (!po || !text) break;
        po.replies = [...(po.replies || []), {
          id: ev.id.slice(0, 8), ts: ev.ts, text, anon: !!b.anon,
          author: ev.key, authorName: nameOf(ev.key), gid,
        }];
        po.updatedAt = ev.ts;
        break;
      }
      case "post_edit_reply": {
        if (!group || !member(ev.key)) break;
        const po = kv[String(b.target || "")];
        if (!po) break;
        const reply = (po.replies || []).find((r) => r.id === String(b.replyId || ""));
        const text = clean(b.text, 4000);
        if (!reply || reply.author !== ev.key || !text) break;
        if (text !== reply.text) { reply.text = text; reply.editedAt = ev.ts; po.updatedAt = ev.ts; }
        break;
      }
      case "post_delete_reply": {
        if (!group || !member(ev.key)) break;
        const po = kv[String(b.target || "")];
        if (!po) break;
        const replyId = String(b.replyId || "");
        const reply = (po.replies || []).find((r) => r.id === replyId);
        if (!reply) break;
        if (reply.author !== ev.key && !isAdmin(ev.key)) break;
        po.replies = po.replies.filter((r) => r.id !== replyId);
        po.updatedAt = ev.ts;
        break;
      }
      default: break;
    }
  }

  if (!group || deleted) return { group: null, kv: {} };

  // The owner is always an admin, and the pin list is newest-first and capped.
  group.admins = [group.ownerKey, ...group.admins.filter((k) => k !== group.ownerKey)];
  group.pins = group.pins.sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, 20);
  group.banned = [...new Set(group.banned)];
  return { group, kv };
}

module.exports = { materialize, CONTENT_KINDS, REACTIONS, clean };
