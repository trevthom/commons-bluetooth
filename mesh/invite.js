// Invites are the capability that gets you into a community. Offline there is
// no server to ask, so the code itself has to carry everything a new member
// needs: the group id, who owns it, its name, and the group secret its traffic
// is sealed with. It is long, which is exactly why the app shows a QR code.
const C = require("./crypto");

// "cb1…" is reusable, "cb2…" is the one-time variant. The alphabet stays inside
// [A-Za-z0-9_-] so it survives a URL fragment, a QR code and a paste.
function inviteCode(secret, gid, ownerKey, name, once) {
  const body = [gid, ownerKey, encodeURIComponent(String(name || "")), secret, once || ""].join("|");
  return (once ? "cb2" : "cb1") + C.b64u(Buffer.from(body, "utf8"));
}

function parseInvite(code) {
  const m = /^cb([12])([A-Za-z0-9_-]+)$/.exec(String(code || "").trim());
  if (!m) return null;
  let parts;
  try { parts = C.unb64u(m[2]).toString("utf8").split("|"); } catch { return null; }
  const [gid, ownerKey, name, secret, once] = parts;
  if (!/^[0-9a-f]{16}$/.test(String(gid || ""))) return null;
  if (!/^[A-Z2-9]{16}$/.test(String(ownerKey || ""))) return null;
  if (!secret) return null;
  return { gid, ownerKey, name: decodeURIComponent(name || ""), secret, once: once || null, oneTime: m[1] === "2" };
}

// Proof that the joining peer actually held an invite. It is not a secret (only
// members can read the event anyway) — it just stops a stranger who has seen a
// group id from adding themselves.
const inviteProof = (secret, gid) => C.sha256hex(String(secret) + "|" + String(gid)).slice(0, 16);

module.exports = { inviteCode, parseInvite, inviteProof };
