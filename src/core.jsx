// Everything the screens share: the calls into the local node, the identity
// key and session, the anonymous names, and the theme.
//
// The node exposes the same /api surface the old Commons server did, so the UI
// below it is untouched by the move to the mesh. A dropped connection or a
// non-JSON error page resolves to null rather than leaving a button stuck.
import * as React from "react";
import QRCodeLib from "qrcode";

const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
const { X } = lucide;

// The bundled lucide shim has no radio icon, so the nearby panel draws one.
// It is an inline SVG: no network fetch, which matters for an offline app.
const Antenna = ({ size = 18, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.9 19.1a10 10 0 0 1 0-14.2" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    <path d="M7.8 16.2a6 6 0 0 1 0-8.4" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
    <circle cx="12" cy="12" r="1.6" fill={color} stroke="none" />
  </svg>
);

// ---------- API ----------
const api = {
  async post(path, body) { try { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); return await r.json(); } catch { return null; } },
  async get(path) { try { const r = await fetch(path); return await r.json(); } catch { return null; } },
};
const sget = async (k) => { const j = await api.get("/api/get?key=" + encodeURIComponent(k)); return j ? j.value : null; };
const slist = async (prefix) => { const j = await api.get("/api/list?prefix=" + encodeURIComponent(prefix)); return j ? j.keys : []; };
// ---------- authenticated content calls ----------
// The server derives the author from { key, sessionId } and ignores anything
// else we send, so a client can neither forge nor delete somebody else's post.
const auth = (s, extra) => ({ key: s.key, sessionId: s.sessionId, ...extra });
// `imageId` claims a picture uploaded earlier with imageUpload, or is null.
const messageSend = (s, gid, text, anon, replyTo, imageId) => api.post("/api/message/send", auth(s, { gid, text, anon, replyTo, ...(imageId ? { imageId } : {}) }));
// Upload a prepared picture ({ blob, w, h }) as raw bytes; the credentials ride
// in headers so they never land in a URL.
const imageUpload = async (s, gid, prep) => {
  try {
    const r = await fetch(`/api/image/upload?w=${prep.w}&h=${prep.h}`, { method: "POST", body: prep.blob, headers: {
      "Content-Type": prep.blob.type || "application/octet-stream", "X-Commons-Key": s.key, "X-Commons-Session": s.sessionId, "X-Commons-Group": gid } });
    return await r.json();
  } catch { return null; }
};
const messageDelete = (s, gid, msgKey) => api.post("/api/message/delete", auth(s, { gid, msgKey }));
const messageEdit = (s, gid, msgKey, text) => api.post("/api/message/edit", auth(s, { gid, msgKey, text }));
const pollCreate = (s, gid, question, options, multi, replyTo) => api.post("/api/poll/create", auth(s, { gid, question, options, multi, replyTo }));
const pollVote = (s, gid, msgKey, optionId) => api.post("/api/poll/vote", auth(s, { gid, msgKey, optionId }));
const messageReact = (s, gid, msgKey, emoji) => api.post("/api/message/react", auth(s, { gid, msgKey, emoji }));
const messageSearch = (s, gid, q) => api.post("/api/message/search", auth(s, { gid, q }));
const postCreate = (s, gid, title, text, anon) => api.post("/api/post/create", auth(s, { gid, title, text, anon }));
const postEdit = (s, gid, postKey, title, text) => api.post("/api/post/edit", auth(s, { gid, postKey, title, text }));
const postEditReply = (s, gid, postKey, replyId, text) => api.post("/api/post/editReply", auth(s, { gid, postKey, replyId, text }));
const postDelete = (s, gid, postKey) => api.post("/api/post/delete", auth(s, { gid, postKey }));
const postReply = (s, gid, postKey, text, anon) => api.post("/api/post/reply", auth(s, { gid, postKey, text, anon }));
const postDeleteReply = (s, gid, postKey, replyId) => api.post("/api/post/deleteReply", auth(s, { gid, postKey, replyId }));
const setPin = (s, gid, msgKey, on) => api.post(on ? "/api/group/pin" : "/api/group/unpin", auth(s, { gid, msgKey }));
// Batch read: fetch every value under a prefix in a single request. Passing
// `since` (the newest timestamp we already hold) fetches only what is newer —
// the polling path, which normally transfers nothing instead of the history.
const slistValues = async (prefix, since) => {
  const j = await api.get("/api/mget?prefix=" + encodeURIComponent(prefix) + (since ? "&since=" + since : ""));
  if (!j || !j.items) return [];
  return j.items.map(([k, v]) => ({ ...v, _key: k }));
};

// ---------- shared room cache ----------
// One in-memory copy of each room's history, shared by the community list
// (previews + unread counts) and the room itself. Opening a room therefore
// paints instantly from what the list already polled; polls then ask the
// server only for messages newer than the newest one held, and a full refresh
// runs occasionally (and after every mutation) so deletions and edits land.
const roomCache = new Map();   // prefix -> sorted items
const roomFullAt = new Map();  // prefix -> when the cache was last fully fetched
const ROOM_FULL_MS = 20000;
// Cheap identity of a list: its shape plus a hash of edit times, so a poll that
// changed nothing — not even a reaction — must not re-render the room.
const sigOf = (list) => {
  if (!list || !list.length) return "0";
  let edits = 0;
  for (const m of list) edits = (edits * 31 + (m.updatedAt || 0)) % 0x7fffffff;
  return list.length + ":" + list[0]._key + ":" + list[list.length - 1]._key + ":" + edits;
};
const mergeItems = (base, delta) => {
  const byKey = new Map(base.map((m) => [m._key, m]));
  for (const m of delta) byKey.set(m._key, m);
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
};
// The newest thing we know about a room: the newest message or a later edit
// (reactions bump `updatedAt`), whichever is later — the delta cursor.
const roomCursor = (list) => list.reduce((mx, m) => Math.max(mx, m.ts || 0, m.updatedAt || 0), 0);
async function syncRoom(prefix, forceFull) {
  const cached = roomCache.get(prefix) || [];
  const full = forceFull || !cached.length || Date.now() - (roomFullAt.get(prefix) || 0) > ROOM_FULL_MS;
  const fetched = await slistValues(prefix, full ? 0 : roomCursor(cached));
  const next = (full ? fetched : mergeItems(cached, fetched)).sort((a, b) => a.ts - b.ts);
  roomCache.set(prefix, next);
  if (full) roomFullAt.set(prefix, Date.now());
  return next;
}

// ---------- session storage ----------
// The session lives in localStorage so an installed PWA (or a closed tab)
// opens straight back into the same account, and every tab shares one session.
// Only "Log out" clears it — or the session poll, when the account signs in
// somewhere else and the server rotates the session id.
const SK = "cc_session_v2";
const readSession = (store) => { try { return JSON.parse(store.getItem(SK)) || null; } catch { return null; } };
const loadSession = () => {
  try {
    const local = readSession(localStorage);
    if (local) return local;
    // Migrate a tab-scoped session left behind by an older build.
    const tab = readSession(sessionStorage);
    if (tab) { localStorage.setItem(SK, JSON.stringify(tab)); sessionStorage.removeItem(SK); return tab; }
  } catch {}
  return null;
};
const saveSession = (s) => {
  const v = JSON.stringify(s);
  try { localStorage.setItem(SK, v); } catch { try { sessionStorage.setItem(SK, v); } catch {} }
};
const clearSession = () => { try { localStorage.removeItem(SK); } catch {} try { sessionStorage.removeItem(SK); } catch {} };

const uid = () => Math.random().toString(36).slice(2, 10);
// clipboard with fallback for non-HTTPS origins (http://192.168.x.x etc.)
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch { return false; }
}
const now = () => Date.now();
const groupKey = (id) => `group:${id}`;
const msgPrefix = (g) => `msg:${g}:general:`;
const postPrefix = (g) => `post:${g}:`;
// Enter should fire a screen's primary button, the way submitting a form does.
const onEnter = (fn) => (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } };

const ANON_NAMES = ["Maple", "Cedar", "Willow", "Birch", "Aspen", "Sage", "Fern", "Heron", "Otter", "Robin", "Wren", "Lark"];
// An anonymous name lasts one day (Eastern time): within a community the same
// person reads as the same "Anon …" all day, and as a different one the next.
const anonDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const anonName = (author, gid, ts) => anonLabel((author || "x") + (gid || "") + anonDayFmt.format(new Date(ts || 0)));
const anonLabel = (seed) => { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "Anon " + ANON_NAMES[h % ANON_NAMES.length] + " " + (h % 90 + 10); };

// ---------- QR ----------
function QRCodeView({ text, size = 200 }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    QRCodeLib.toCanvas(el, text, { width: size, margin: 1, color: { dark: "#0b0f14", light: "#e8eef2" } }).catch(() => setFailed(true));
  }, [text, size]);
  if (failed) return <div style={{ width: size, fontSize: 12, color: "#7b8a96", textAlign: "center" }}>QR unavailable — use the link below.</div>;
  return <canvas ref={ref} width={size} height={size} style={{ borderRadius: 12, display: "block" }} />;
}

// ---------- shared ----------
function Modal({ title, children, onClose }) {
  return <div style={S.modalWrap} onClick={onClose}><div style={S.modal} className="sheet" onClick={(e) => e.stopPropagation()}>
    <div style={S.modalHead}><span style={{ fontWeight: 700 }}>{title}</span><button style={S.iconBtn} onClick={onClose}><X size={18} /></button></div>{children}
  </div></div>;
}
// A message's corner stamp, marked "edited" once its author has changed it.
function Stamp({ m }) {
  return <div data-role="msg-stamp" style={S.stamp}>{m.editedAt && <span data-role="edited" title={"Edited " + fmtStamp(m.editedAt)}>edited · </span>}{fmtStamp(m.ts)}</div>;
}
// Every message — General bubbles, forum posts and replies, thread items and
// search results — carries its date and time in Eastern time, tucked into the
// bottom-right corner (Telegram-style). "EST" is the label the user asked for
// even while the zone is on daylight time.
function fmtStamp(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${date} · ${time} EST`;
}

// The message box grows with its text up to six lines, then scrolls (the text
// itself is not limited). The numbers live here because the box's style below
// is built from them.
const COMPOSER_LINE = 20, COMPOSER_PAD = 9, COMPOSER_ROWS = 6;

const BG = "#0b0f14", PANEL = "#11171f", PANEL2 = "#161e28", LINE = "#1f2a36", TEXT = "#e8eef2", MUTED = "#7b8a96", ACCENT = "#2dd4bf", SENDER = "#9fc3d6";
const S = {
  root: { fontFamily: "'Outfit', system-ui, sans-serif", background: BG, color: TEXT, height: "100vh", maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" },
  screen: { display: "flex", flexDirection: "column", height: "100%" },
  center: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 20 },
  card: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 },
  brand: { fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600, marginBottom: 6 },
  sub: { color: MUTED, fontSize: 14, marginBottom: 18 },
  label: { fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: MUTED, display: "block", marginBottom: 6 },
  input: { width: "100%", background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 12, padding: "12px 14px", fontSize: 15, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  primary: { width: "100%", background: ACCENT, color: "#04201d", border: "none", borderRadius: 12, padding: "13px", fontWeight: 700, fontSize: 15, cursor: "pointer", display: "flex", gap: 8, alignItems: "center", justifyContent: "center" },
  secondary: { flex: 1, background: PANEL2, color: TEXT, border: `1px solid ${LINE}`, borderRadius: 12, padding: "13px", fontWeight: 600, cursor: "pointer", display: "flex", gap: 8, alignItems: "center", justifyContent: "center" },
  secondaryFull: { width: "100%", background: PANEL2, color: TEXT, border: `1px solid ${LINE}`, borderRadius: 12, padding: "13px", fontWeight: 600, cursor: "pointer", display: "flex", gap: 8, alignItems: "center", justifyContent: "center" },
  ghost: { width: "100%", background: "transparent", color: MUTED, border: "none", padding: 10, cursor: "pointer", marginTop: 6 },
  toggleRow: { width: "100%", display: "flex", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 12, padding: "11px 13px", color: TEXT, cursor: "pointer", fontSize: 14 },
  pill: { fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 20 },
  groupHeader: { display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 6, padding: "14px 14px 14px 8px", borderBottom: `1px solid ${LINE}`, background: PANEL },
  memberCountBtn: { display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 20, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" },
  appHeader: { display: "flex", alignItems: "center", gap: 6, padding: "14px", borderBottom: `1px solid ${LINE}`, background: PANEL },
  iconBtn: { background: "transparent", border: "none", color: TEXT, cursor: "pointer", padding: 6, borderRadius: 8, display: "flex" },
  tabs: { display: "flex", borderBottom: `1px solid ${LINE}`, background: PANEL },
  tab: { flex: 1, background: "transparent", border: "none", borderBottom: "2px solid transparent", color: MUTED, padding: "13px", cursor: "pointer", display: "flex", gap: 7, alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 14 },
  tabActive: { color: ACCENT, borderBottomColor: ACCENT },
  scroll: { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 },
  chatArea: { position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  messages: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  searchBar: { display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderBottom: `1px solid ${LINE}`, background: PANEL },
  searchInput: { flex: 1, background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 20, padding: "8px 14px", outline: "none", fontSize: 14, fontFamily: "inherit" },
  feed: { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  bubbleRow: { display: "flex" },
  // A message row is its own stacking context (the `.reveal` animation), which
  // traps the absolutely-positioned menu's z-index. While a menu is open we lift
  // the entire row so the following message can never paint over the menu.
  bubbleRowActive: { position: "relative", zIndex: 40 },
  // Telegram-style: bubbles use most of the width, and there are exactly two
  // message colors — the viewer's own (#123f38) and everybody else's (PANEL2).
  bubble: { position: "relative", maxWidth: "92%", background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 16, borderBottomLeftRadius: 5, padding: "9px 13px", fontSize: 15, lineHeight: 1.4, boxShadow: "0 1px 2px rgba(0,0,0,.35)" },
  bubbleMine: { background: "#123f38", border: "1px solid #1d5a50", borderBottomLeftRadius: 16, borderBottomRightRadius: 5 },
  bubbleHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 3, fontSize: 12 },
  // Keep the writer's line breaks, and wrap long words instead of overflowing.
  msgText: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  stamp: { fontSize: 10, color: MUTED, textAlign: "right", marginTop: 3, letterSpacing: .2 },
  systemMsg: { alignSelf: "center", fontSize: 12, color: MUTED, background: PANEL2, borderRadius: 20, padding: "4px 12px", margin: "2px 0" },
  miniDel: { background: "transparent", border: "none", color: "#6b7a85", cursor: "pointer", padding: 2, display: "flex", marginLeft: "auto" },
  // The wrapper positions the menu (quick reactions + items) and flips it above
  // the bubble near the bottom of the feed, where a downward menu would be
  // clipped by the feed's edge and covered by the composer.
  menuWrap: { position: "absolute", top: 24, zIndex: 30, minWidth: 178, display: "flex", flexDirection: "column", gap: 4 },
  menuUp: { top: "auto", bottom: 24 },
  menu: { background: "#0f1620", border: `1px solid ${LINE}`, borderRadius: 12, padding: 4, boxShadow: "0 12px 32px rgba(0,0,0,.55)" },
  reactBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, background: "#0f1620", border: `1px solid ${LINE}`, borderRadius: 12, padding: "3px 5px", boxShadow: "0 12px 32px rgba(0,0,0,.55)" },
  reactBtn: { background: "transparent", border: "none", cursor: "pointer", fontSize: 19, lineHeight: 1, padding: "3px 4px", borderRadius: 8, fontFamily: "inherit" },
  reactMore: { display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: "3px 4px", borderRadius: 8 },
  reactMorePanel: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1, background: "#0f1620", border: `1px solid ${LINE}`, borderRadius: 12, padding: 4, boxShadow: "0 12px 32px rgba(0,0,0,.55)" },
  reactionRow: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 },
  reactionChip: { display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,.07)", border: `1px solid ${LINE}`, borderRadius: 20, padding: "1px 8px", fontSize: 13, lineHeight: 1.5, cursor: "pointer", fontFamily: "inherit", color: TEXT },
  reactionChipMine: { borderColor: ACCENT, background: "rgba(45,212,191,.15)" },
  reactionCount: { fontSize: 11, color: MUTED, fontWeight: 700 },
  // Anchor the menu to whichever edge the bubble is aligned to, so it always
  // grows inward. A short left-aligned message leaves almost no room to its
  // left, and a right-anchored 178px menu would run off the screen's left edge.
  menuMine: { right: 4 },
  menuTheirs: { left: 4 },
  menuItem: { display: "flex", alignItems: "center", gap: 9, width: "100%", background: "transparent", border: "none", color: TEXT, padding: "9px 10px", borderRadius: 8, cursor: "pointer", fontSize: 14, textAlign: "left", fontFamily: "inherit" },
  menuItemDanger: { color: "#f87171" },
  mutedBubble: { borderStyle: "dashed", opacity: .92 },
  showBtn: { background: "transparent", border: `1px solid ${LINE}`, color: ACCENT, cursor: "pointer", padding: "2px 9px", borderRadius: 20, fontSize: 11, marginLeft: "auto", fontFamily: "inherit" },
  // Translucent so the quote block is derived from whichever of the two
  // message colors it sits on — no third message surface color.
  replyPreview: { display: "flex", gap: 6, alignItems: "flex-start", background: "rgba(255,255,255,.06)", borderLeft: `3px solid ${ACCENT}`, borderRadius: 8, padding: "6px 9px", margin: "2px 0 5px" },
  replyPreviewMuted: { borderLeftColor: MUTED, cursor: "pointer" },
  replyPreviewName: { fontSize: 12, fontWeight: 700, color: ACCENT, lineHeight: 1.25 },
  replyPreviewText: { fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  replyBanner: { display: "flex", gap: 8, alignItems: "center", padding: "9px 14px", background: PANEL, borderTop: `1px solid ${LINE}` },
  replyBannerName: { fontSize: 12, fontWeight: 700, color: ACCENT },
  replyBannerText: { fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  threadRoot: { borderLeft: `3px solid ${ACCENT}` },
  segment: { display: "flex", gap: 4, padding: 4, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 12, marginBottom: 12 },
  segBtn: { flex: 1, background: "transparent", border: "none", color: MUTED, padding: "9px 6px", borderRadius: 9, cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit" },
  segBtnActive: { background: PANEL, color: TEXT },
  // Bottom-aligned, so the icons and send button stay put while the box grows upward.
  composer: { position: "relative", display: "flex", gap: 8, padding: "10px 12px 10px 8px", borderTop: `1px solid ${LINE}`, background: PANEL, alignItems: "flex-end" },
  // A circle at the left of the box, bottom-aligned with it (the row grows upward).
  composerPlus: { position: "relative", flexShrink: 0, width: 36, height: 36, marginBottom: 2, borderRadius: "50%", background: PANEL2, border: `1px solid ${LINE}`, color: "#9fb0bd", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  anonBadge: { position: "absolute", top: -3, right: -3, width: 15, height: 15, borderRadius: "50%", background: ACCENT, color: "#04201d", display: "flex", alignItems: "center", justifyContent: "center" },
  composerMenu: { position: "absolute", left: 8, bottom: "calc(100% + 4px)", zIndex: 40, minWidth: 210, background: "#0f1620", border: `1px solid ${LINE}`, borderRadius: 14, padding: 4, boxShadow: "0 12px 32px rgba(0,0,0,.55)", display: "flex", flexDirection: "column" },
  emojiPanel: { position: "absolute", bottom: "calc(100% + 4px)", left: 8, right: 8, zIndex: 40, display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2, padding: 8, background: "#0f1620", border: `1px solid ${LINE}`, borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,.55)", maxHeight: 200, overflowY: "auto" },
  emojiBtn: { background: "transparent", border: "none", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4, borderRadius: 8, fontFamily: "inherit" },
  pinBar: { display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "8px 14px", background: "#0f1620", border: "none", borderBottom: `1px solid ${LINE}`, color: TEXT, cursor: "pointer", fontFamily: "inherit" },
  pinBarLabel: { fontSize: 10, fontWeight: 700, color: ACCENT, textTransform: "uppercase", letterSpacing: .6 },
  pinBarText: { fontSize: 13, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  result: { display: "flex", flexDirection: "column", gap: 3, width: "100%", textAlign: "left", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "10px 12px", color: TEXT, cursor: "pointer", fontFamily: "inherit" },
  resultText: { fontSize: 14, color: "#cdd9e1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  bubbleFlash: { boxShadow: `0 0 0 2px ${ACCENT}` },
  // contenteditable: it grows with its text, then scrolls past six lines.
  composerInput: { position: "relative", flex: 1, minWidth: 0, display: "block", background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 20, padding: `${COMPOSER_PAD}px 16px`, outline: "none", fontSize: 15, lineHeight: `${COMPOSER_LINE}px`, fontFamily: "inherit", margin: 0,
    minHeight: COMPOSER_LINE + COMPOSER_PAD * 2 + 2, maxHeight: COMPOSER_LINE * COMPOSER_ROWS + COMPOSER_PAD * 2 + 2, overflowY: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "text", WebkitUserSelect: "text", userSelect: "text" },
  sendBtn: { background: ACCENT, color: "#04201d", border: "none", borderRadius: "50%", width: 40, height: 40, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  post: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 16, padding: 14 },
  postTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, margin: "4px 0 6px" },
  replyToggle: { background: "transparent", border: "none", color: ACCENT, cursor: "pointer", fontSize: 13, marginTop: 10, padding: 0 },
  replyZone: { marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 },
  reply: { background: PANEL2, borderRadius: 10, padding: "7px 10px" },
  showEarlier: { alignSelf: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 20, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  bottomBar: { display: "flex", gap: 10, padding: 14, borderTop: `1px solid ${LINE}`, background: PANEL },
  badge: { background: ACCENT, color: "#04201d", fontWeight: 700, fontSize: 12, minWidth: 22, height: 22, padding: "0 7px", borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  poll: { display: "flex", flexDirection: "column", gap: 6, minWidth: 220 },
  pollQuestion: { display: "flex", gap: 6, alignItems: "flex-start", fontWeight: 700, fontSize: 15 },
  pollHint: { fontSize: 11, color: MUTED, marginTop: -2 },
  pollOption: { position: "relative", display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", overflow: "hidden", background: "rgba(255,255,255,.06)", border: `1px solid ${LINE}`, borderRadius: 10, padding: "8px 10px", color: TEXT, cursor: "pointer", fontFamily: "inherit", fontSize: 14 },
  pollOptionMine: { borderColor: ACCENT },
  pollBar: { position: "absolute", left: 0, top: 0, bottom: 0, background: "rgba(45,212,191,.18)", transition: "width .25s ease", pointerEvents: "none" },
  pollMark: { position: "relative", width: 14, height: 14, flexShrink: 0, display: "flex" },
  pollText: { position: "relative", flex: 1, minWidth: 0 },
  pollCount: { position: "relative", fontSize: 12, color: MUTED, fontWeight: 700, flexShrink: 0 },
  pollTotal: { fontSize: 11, color: MUTED },
  msgImageBtn: { display: "block", padding: 0, margin: "2px 0 4px", border: "none", background: "transparent", cursor: "zoom-in", borderRadius: 10, overflow: "hidden", maxWidth: "100%" },
  msgImage: { display: "block", maxWidth: "100%", objectFit: "cover", background: "rgba(255,255,255,.05)", borderRadius: 10 },
  // Fixed, not absolute: it covers the whole window above every sheet.
  lightbox: { position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, gap: 12, cursor: "zoom-out" },
  lightboxImg: { maxWidth: "100%", maxHeight: "calc(100% - 70px)", objectFit: "contain", borderRadius: 6 },
  lightboxClose: { position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,.12)", border: "none", color: TEXT, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  lightboxCaption: { color: TEXT, fontSize: 15, maxWidth: 480, textAlign: "center", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 60, overflowY: "auto" },
  attachBar: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: PANEL, borderTop: `1px solid ${LINE}` },
  attachThumb: { width: 48, height: 48, objectFit: "cover", borderRadius: 8, flexShrink: 0, background: PANEL2, border: `1px solid ${LINE}` },
  feedWrap: { position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  scrollDown: { position: "absolute", right: 14, bottom: 14, zIndex: 35, width: 38, height: 38, borderRadius: "50%", background: PANEL, border: `1px solid ${LINE}`, color: ACCENT, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 18px rgba(0,0,0,.45)" },
  groupCard: { display: "flex", alignItems: "center", gap: 12, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 12, cursor: "pointer", color: TEXT },
  groupAvatar: { width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg,#2dd4bf,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#04201d", flexShrink: 0 },
  empty: { textAlign: "center", padding: "40px 20px", color: MUTED, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  muted: { color: MUTED, fontSize: 13 },
  nameBtn: { background: "transparent", border: "none", color: MUTED, fontSize: 13, cursor: "pointer", padding: 0, textAlign: "left" },
  warn: { background: "#3a2a08", border: "1px solid #7c5e16", color: "#fcd34d", borderRadius: 12, padding: "10px 12px", fontSize: 13, marginBottom: 14, lineHeight: 1.4 },
  keyBox: { display: "flex", alignItems: "center", gap: 8, background: PANEL2, border: `1px solid ${ACCENT}`, borderRadius: 12, padding: "12px 14px", marginTop: 6 },
  modalWrap: { position: "absolute", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 },
  modal: { background: PANEL, borderTop: `1px solid ${LINE}`, borderRadius: "20px 20px 0 0", padding: 20, width: "100%", maxWidth: 480, maxHeight: "85%", overflowY: "auto", boxSizing: "border-box" },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  linkBox: { display: "flex", alignItems: "center", gap: 8, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 12, padding: "10px 12px", marginTop: 6 },
  memberRow: { display: "flex", alignItems: "center", gap: 10, background: PANEL2, borderRadius: 12, padding: 10 },
  miniBtn: { background: "transparent", border: `1px solid ${LINE}`, borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" },
  error: { color: "#f87171", fontSize: 13, marginTop: 8 },
  settingsGroup: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  settingsRow: { display: "flex", alignItems: "center", gap: 10, width: "100%", background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 12, padding: "12px 14px", color: TEXT, cursor: "pointer", fontSize: 15, fontWeight: 600, fontFamily: "inherit", textAlign: "left" },
  settingsLogout: { marginTop: 16, color: "#f87171", background: "#2a1518", borderColor: "#5b2730" },
  dangerZone: { marginTop: 18, paddingTop: 14, borderTop: `1px solid #3a1f24` },
  dangerBtn: { width: "100%", background: "#2a1518", color: "#f87171", border: "1px solid #5b2730", borderRadius: 12, padding: "12px", fontWeight: 700, cursor: "pointer", display: "flex", gap: 8, alignItems: "center", justifyContent: "center" },
};
const CSS = `
* { box-sizing: border-box; }
::-webkit-scrollbar { width: 0; }
.reveal { animation: rise .25s ease both; }
@keyframes rise { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:none;} }
.sheet { animation: slideUp .25s cubic-bezier(.2,.8,.2,1) both; }
@keyframes slideUp { from { transform: translateY(100%);} to { transform: none;} }
.pulse { animation: p 1.2s ease-in-out infinite; color:${ACCENT}; }
@keyframes p { 0%,100%{opacity:.3;} 50%{opacity:1;} }
input::placeholder, textarea::placeholder { color:#54636e; }
[data-role="composer-input"][data-empty="1"]::before { content: attr(data-placeholder); position: absolute; left: 16px; right: 16px; top: ${COMPOSER_PAD}px; color: #54636e; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

export {
  Antenna, api, sget, slist, auth, messageSend, imageUpload, messageDelete, messageEdit, pollCreate, pollVote,
  messageReact, messageSearch, postCreate, postEdit, postEditReply, postDelete, postReply, postDeleteReply, setPin,
  slistValues, roomCache, roomFullAt, ROOM_FULL_MS, sigOf, mergeItems, roomCursor, syncRoom,
  SK, readSession, loadSession, saveSession, clearSession, uid, copyText, now, groupKey, msgPrefix, postPrefix, onEnter,
  ANON_NAMES, anonDayFmt, anonName, anonLabel, QRCodeView, Modal, Stamp, fmtStamp,
  BG, PANEL, PANEL2, LINE, TEXT, MUTED, ACCENT, SENDER, COMPOSER_LINE, COMPOSER_PAD, COMPOSER_ROWS, S, CSS,
};
