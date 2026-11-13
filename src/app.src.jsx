import * as React from "react";
import QRCodeLib from "qrcode";

const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
const {
  Users, MapPin, Shield, Send, Eye, EyeOff, Link2, QrCode, Search,
  X, Trash2, UserMinus, Crown, LogIn, Plus, Copy, Check, MessageSquare, ChevronLeft, Ban, Key, LogOut,
  MoreVertical, CornerUpLeft, Bell, BellOff, Smile, Pin, PinOff, ChevronDown, Settings, Pencil, ImagePlus, BarChart3
} = lucide;

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
// Every call resolves to a value or null — a dropped connection or a non-JSON
// error page must never leave a button stuck in its "busy" state.
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

// ============================================================
function CommunityChat() {
  // The stored session picks the first screen, so a returning user (including
  // an installed PWA that was closed) never sees a loading or login flash.
  const [session, setSession] = useState(loadSession);
  const [view, setView] = useState(() => (session ? "home" : "login")); // login | home | app
  const [group, setGroup] = useState(null);
  const [tab, setTab] = useState("general");
  const [pendingInvite, setPendingInvite] = useState(null);
  const [kicked, setKicked] = useState(false);

  const setSess = (s) => { if (s) { saveSession(s); } else { clearSession(); } setSession(s); };

  useEffect(() => {
    const m = (window.location.hash || "").match(/join=([A-Za-z0-9_-]+)/);
    if (m) setPendingInvite(m[1]);
  }, []);

  // poll: if our session was invalidated (the account signed in elsewhere),
  // follow the newer session another tab of this browser saved, else log out.
  useEffect(() => {
    if (!session) return;
    let stop = false;
    const check = async () => {
      const r = await api.get(`/api/account/session?key=${encodeURIComponent(session.key)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      if (stop || !r || r.valid !== false) return;
      const stored = loadSession();
      if (stored && stored.key === session.key && stored.sessionId !== session.sessionId) return setSess(stored);
      setKicked(true); setSess(null); setGroup(null); setView("login");
    };
    const t = setInterval(check, 4000); check();
    return () => { stop = true; clearInterval(t); };
  }, [session]);

  // The session is shared across tabs, so logging out in one logs the rest out.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === SK && !loadSession()) { setSess(null); setGroup(null); setView("login"); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      {view === "login" && <Login kicked={kicked} clearKicked={() => setKicked(false)} onAuthed={(s) => { setSess(s); setView("home"); }} />}
      {view === "home" && session && <Home session={session} pendingInvite={pendingInvite} clearInvite={() => setPendingInvite(null)} onOpen={(g) => { setGroup(g); setTab("general"); setView("app"); }} onLogout={() => { setSess(null); setView("login"); }} />}
      {view === "app" && group && session && <GroupApp session={session} group={group} setGroup={setGroup} tab={tab} setTab={setTab} onLeave={() => { setGroup(null); setView("home"); }} onLogout={() => { setSess(null); setGroup(null); setView("login"); }} />}
    </div>
  );
}

// ---------- login ----------
function Login({ onAuthed, kicked, clearKicked }) {
  const [mode, setMode] = useState("choose"); // choose | haveKey | created
  const [keyInput, setKeyInput] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [createdSession, setCreatedSession] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true); setErr("");
    const r = await api.post("/api/account/create", {});
    setBusy(false);
    if (r && r.key) { setCreatedKey(r.identityKey || r.key); setCreatedSession({ key: r.key, sessionId: r.sessionId, identityKey: r.identityKey || r.key }); setMode("created"); }
    else setErr("Could not create account.");
  };
  const login = async () => {
    if (!keyInput.trim() || busy) return;
    setBusy(true); setErr("");
    const key = keyInput.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const r = await api.post("/api/account/login", { key });
    setBusy(false);
    if (r && r.ok) onAuthed({ key: r.key || key, sessionId: r.sessionId, identityKey: r.identityKey || key });
    else setErr("That identity key isn't valid.");
  };

  return (
    <div style={S.center}>
      <div style={S.card} className="reveal">
        <div style={S.brand}>◇ Commons-Bluetooth</div>
        <p style={S.sub}>A community that travels with you.</p>
        {kicked && <div style={S.warn}>You were logged out because your account signed in on another device.</div>}

        {mode === "choose" && (
          <>
            <button style={{ ...S.primary, marginTop: 8 }} disabled={busy} onClick={create}><Key size={18} /> Create a new account</button>
            <button style={{ ...S.secondaryFull, marginTop: 10 }} onClick={() => { setMode("haveKey"); clearKicked(); }}><LogIn size={18} /> I have a login key</button>
            {err && <div style={S.error}>{err}</div>}
          </>
        )}

        {mode === "haveKey" && (
          <>
            <label style={S.label}>Identity key</label>
            <input style={{ ...S.input, fontFamily: "monospace", letterSpacing: 1 }} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={onEnter(login)} placeholder="your identity key" />
            {err && <div style={S.error}>{err}</div>}
            <button style={{ ...S.primary, marginTop: 14, opacity: keyInput.trim() ? 1 : .5 }} disabled={!keyInput.trim() || busy} onClick={login}>{busy ? "Checking…" : "Log in"}</button>
            <button style={S.ghost} onClick={() => { setMode("choose"); setErr(""); }}>Back</button>
          </>
        )}

        {mode === "created" && (
          <>
            <div style={S.warn}>Save this identity key. It lives only on <b>this device</b>; copy it here if you want to sign in as the same person somewhere else. We can't recover it.</div>
            <div style={S.keyBox}>
              <span style={{ fontFamily: "monospace", fontSize: 16, letterSpacing: 1, flex: 1, wordBreak: "break-all" }}>{createdKey.replace(/(.{4})/g, "$1 ").trim()}</span>
              <button style={S.iconBtn} onClick={async () => { await copyText(createdKey); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={16} color="#2dd4bf" /> : <Copy size={16} />}</button>
            </div>
            <button style={{ ...S.primary, marginTop: 14 }} onClick={() => onAuthed(createdSession)}>I saved it — continue</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- home ----------
function Home({ session, pendingInvite, clearInvite, onOpen, onLogout }) {
  const [groups, setGroups] = useState([]);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [newName, setNewName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [inbox, setInbox] = useState({}); // gid -> { unread, preview }
  const groupsSig = useRef("");
  const inboxSig = useRef("");

  const refresh = useCallback(async () => {
    const all = await slistValues("group:");
    const gs = all.filter((g) => g && g.members && g.members[session.key] && !(g.banned || []).includes(session.key));
    gs.sort((a, b) => b.createdAt - a.createdAt);
    // Skip the state write (and the re-render) while nothing has changed.
    const gsig = JSON.stringify(gs);
    if (gsig !== groupsSig.current) { groupsSig.current = gsig; setGroups(gs); }
    // Telegram-style inbox: how many messages are waiting and the newest one.
    // Reading each room goes through the shared cache, so this poll is also
    // what makes opening a room instant — its history is already in memory.
    const next = {};
    await Promise.all(gs.map(async (g) => {
      const msgs = await syncRoom(msgPrefix(g.id));
      const member = g.members[session.key];
      const seen = getSeen(g.id, session.key) || (member && member.joinedAt) || 0;
      const unread = msgs.filter((m) => !m.system && m.author !== session.key && m.ts > seen).length;
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      next[g.id] = { unread, preview: last ? previewOf(last, session.key) : "" };
    }));
    const isig = JSON.stringify(next);
    if (isig !== inboxSig.current) { inboxSig.current = isig; setInbox(next); }
  }, [session.key]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { if (pendingInvite) setJoining(true); }, [pendingInvite]);

  // Groups are created server-side so a client can't hand itself ownership.
  const createGroup = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await api.post("/api/group/create", { key: session.key, sessionId: session.sessionId, name });
    if (!r || !r.ok) return;
    setCreating(false); setNewName(""); refresh(); onOpen(r.group);
  };

  return (
    <div style={S.screen}>
      <div style={S.appHeader}>
        <div style={{ flex: 1, fontWeight: 700, fontSize: 18 }}>Your communities</div>
        <button data-role="nearby" style={S.iconBtn} title="Nearby devices" onClick={() => setNearbyOpen(true)}><Antenna size={19} /></button>
        <button style={S.iconBtn} title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
      </div>
      <div style={S.scroll}>
        {groups.length === 0 && <div style={S.empty} className="reveal"><Users size={34} style={{ opacity: .5 }} /><p>No communities yet.</p><p style={S.muted}>Create one or join with an invite.</p></div>}
        {groups.map((g) => {
          const info = inbox[g.id] || {};
          return (
            <button key={g.id} data-role="group-card" style={S.groupCard} className="reveal" onClick={() => onOpen(g)}>
              <div style={S.groupAvatar}>{g.name.slice(0, 1).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
                <div style={{ ...S.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {info.preview || "No messages yet"}
                </div>
              </div>
              {info.unread > 0 && <span data-role="unread-badge" style={S.badge}>{info.unread > 99 ? "99+" : info.unread}</span>}
            </button>
          );
        })}
      </div>
      <div style={S.bottomBar}>
        <button style={S.secondary} onClick={() => setJoining(true)}><LogIn size={18} /> Join</button>
        <button style={S.primary} onClick={() => setCreating(true)}><Plus size={18} /> Create</button>
      </div>

      {creating && <Modal onClose={() => setCreating(false)} title="Create community">
        <label style={S.label}>Community name</label>
        <input style={S.input} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onEnter(createGroup)} placeholder="Oak Street Neighbors" maxLength={40} />
        <button style={{ ...S.primary, marginTop: 16, opacity: newName.trim() ? 1 : .5 }} disabled={!newName.trim()} onClick={createGroup}>Create</button>
      </Modal>}
      {settingsOpen && <SettingsModal session={session} actions={[]} onClose={() => setSettingsOpen(false)} onLogout={onLogout} />}
      {nearbyOpen && <NearbyModal onClose={() => setNearbyOpen(false)} />}
      {joining && <JoinModal session={session} prefill={pendingInvite} onClose={() => { setJoining(false); clearInvite(); }} onJoined={(g) => { setJoining(false); clearInvite(); refresh(); onOpen(g); }} />}
    </div>
  );
}

function JoinModal({ session, prefill, onClose, onJoined }) {
  const [code, setCode] = useState(prefill || "");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const doJoin = async () => {
    const raw = code.trim();
    if (!raw || busy) return;
    setBusy(true); setErr("");
    const r = await api.post("/api/group/join", { key: session.key, sessionId: session.sessionId, code: raw });
    setBusy(false);
    if (r && r.ok) return onJoined(r.group);
    if (r && r.error === "banned") return setErr("You've been removed from this community and can't rejoin.");
    if (r && r.error === "not-found") return setErr("No community found for that code.");
    setErr("Could not join.");
  };
  return <Modal onClose={onClose} title="Join community">
    <label style={S.label}>Invite code or link</label>
    <input style={S.input} value={code} onChange={(e) => { const v = e.target.value; const m = v.match(/join=([A-Za-z0-9_-]+)/); setCode(m ? m[1] : v); }} onKeyDown={onEnter(doJoin)} placeholder="paste invite link or code" />
    {err && <div style={S.error}>{err}</div>}
    <button style={{ ...S.primary, marginTop: 16, opacity: code.trim() ? 1 : .5 }} disabled={!code.trim() || busy} onClick={doJoin}>{busy ? "Joining…" : "Join community"}</button>
  </Modal>;
}

// ---------- group app ----------
function GroupApp({ session, group, setGroup, tab, setTab, onLeave, onLogout }) {
  const [showInvite, setShowInvite] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [changingName, setChangingName] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const me = group.members[session.key];
  const isOwner = group.ownerKey === session.key;
  const isAdmin = isOwner || (group.admins || []).includes(session.key);
  const memberCount = Object.keys(group.members).length;
  const needsName = !me || !me.username;
  const [mutes, toggleMute] = useMutes(group.id, session.key);
  const lastGroup = useRef("");

  const reloadGroup = useCallback(async () => {
    const g = await sget(groupKey(group.id));
    if (!g) return;
    if (!g.members[session.key] || (g.banned || []).includes(session.key)) { onLeave(); return; } // removed/banned elsewhere
    // Only touch state when the document really changed: a fresh object every
    // 3s would re-render the whole room (every bubble) for nothing.
    const sig = JSON.stringify(g);
    if (sig !== lastGroup.current) { lastGroup.current = sig; setGroup(g); }
  }, [group.id, session.key, setGroup, onLeave]);
  useEffect(() => { const t = setInterval(reloadGroup, 3000); return () => clearInterval(t); }, [reloadGroup]);

  if (needsName) return <UsernamePicker session={session} group={group} onSet={(g) => setGroup(g)} onLeave={onLeave} />;

  return (
    <div style={S.screen}>
      {/* Three columns: back + community name + your username on the left, the
          member count in the exact middle (equal side columns), icons right. */}
      <div data-role="group-header" style={S.groupHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <button style={S.iconBtn} title="Back to your communities" onClick={onLeave}><ChevronLeft size={20} /></button>
          <div style={{ minWidth: 0, lineHeight: 1.25 }}>
            <div data-role="group-name" style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{group.name}</div>
            <button style={{ ...S.nameBtn, maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }} title="Change your username" onClick={() => setChangingName(true)}>{me.username} ✎{isOwner ? " · owner" : isAdmin ? " · admin" : ""}</button>
          </div>
        </div>
        <button data-role="member-count" style={S.memberCountBtn} title="See members" onClick={() => setShowMembers(true)}>
          <Users size={14} />{memberCount} member{memberCount === 1 ? "" : "s"}
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
          <button data-role="nearby" style={S.iconBtn} title="Nearby devices" onClick={() => setNearbyOpen(true)}><Antenna size={19} /></button>
          <button style={{ ...S.iconBtn, color: searchOpen && tab === "general" ? ACCENT : TEXT }} title="Search messages"
            onClick={() => { if (tab !== "general") { setTab("general"); setSearchOpen(true); } else setSearchOpen((v) => !v); }}><Search size={19} /></button>
          <button style={S.iconBtn} title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
        </div>
      </div>
      <div style={S.tabs}>
        <button style={{ ...S.tab, ...(tab === "general" ? S.tabActive : {}) }} onClick={() => setTab("general")}><MessageSquare size={16} /> General</button>
        <button style={{ ...S.tab, ...(tab === "forum" ? S.tabActive : {}) }} onClick={() => setTab("forum")}><MapPin size={16} /> Forum</button>
      </div>
      {tab === "general"
        ? <GeneralChat session={session} group={group} me={me} isAdmin={isAdmin} mutes={mutes} onToggleMute={toggleMute} onGroupChange={reloadGroup} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />
        : <Forum session={session} group={group} me={me} isAdmin={isAdmin} mutes={mutes} />}
      {settingsOpen && <SettingsModal session={session} onClose={() => setSettingsOpen(false)} onLogout={onLogout} actions={[
        { icon: <QrCode size={18} />, label: "Invite people", onClick: () => setShowInvite(true) },
        ...(isAdmin ? [{ icon: <Shield size={18} />, label: "Manage members", onClick: () => setShowAdmin(true) }] : []),
      ]} />}
      {showMembers && <MembersModal group={group} meKey={session.key} onClose={() => setShowMembers(false)} />}
      {nearbyOpen && <NearbyModal onClose={() => setNearbyOpen(false)} />}
      {showInvite && <InviteModal group={group} session={session} onClose={() => setShowInvite(false)} onChange={reloadGroup} />}
      {showAdmin && isAdmin && <AdminModal session={session} group={group} isOwner={isOwner} onClose={() => setShowAdmin(false)} onChange={reloadGroup} onDeleted={onLeave} />}
      {changingName && <ChangeNameModal session={session} group={group} me={me} onClose={() => setChangingName(false)} onChanged={(g) => { setGroup(g); }} />}
    </div>
  );
}

// ---------- members ----------
// Everyone in the community, opened from the member count in the header: the
// owner first, then admins, then members, each group alphabetical. The sheet
// scrolls when the list is long.
function MembersModal({ group, meKey, onClose }) {
  const admins = group.admins || [];
  const rank = (k) => (k === group.ownerKey ? 0 : admins.includes(k) ? 1 : 2);
  const list = Object.entries(group.members)
    .map(([k, info]) => ({ k, name: (info && info.username) || "(no name yet)", rank: rank(k) }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return <Modal onClose={onClose} title={`Members · ${list.length}`}>
    <div data-role="member-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {list.map((m) => <div key={m.k} data-role="member-row" style={S.memberRow}>
        <div style={S.groupAvatar}>{m.name.slice(0, 1).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {m.name}{m.k === meKey && <span style={{ ...S.muted, fontWeight: 400 }}> (you)</span>}
        </div>
        {m.rank === 0 && <span data-role="role-badge" style={{ ...S.pill, background: "#fbbf2422", color: "#fbbf24", display: "inline-flex", alignItems: "center", gap: 4 }}><Crown size={11} /> OWNER</span>}
        {m.rank === 1 && <span data-role="role-badge" style={{ ...S.pill, background: "#2dd4bf22", color: ACCENT, display: "inline-flex", alignItems: "center", gap: 4 }}><Shield size={11} /> ADMIN</span>}
      </div>)}
    </div>
  </Modal>;
}

// ---------- nearby ----------
// The mesh as this device sees it. An empty list is normal: nobody is in range,
// and everything already received still works offline.
function NearbyModal({ onClose }) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => { const r = await api.get("/api/node/status"); if (!stop && r && r.ok) setSt(r); };
    tick(); const t = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const peers = (st && st.peers) || [];
  const carriers = (st && st.transports) || [];
  const carrierName = (n) => n === "ble" ? "Bluetooth LE" : n === "ble-mock" ? "Simulated Bluetooth" : "Local network";
  return <Modal onClose={onClose} title="Nearby devices">
    <p style={S.muted}>Messages go device to device over Bluetooth. Anything sent while nobody is in range is kept here and handed over the next time a member comes near.</p>
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {carriers.map((t) => <div key={t.name} style={S.memberRow}>
        <Antenna size={16} color={t.state === "up" ? ACCENT : "#f87171"} />
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{carrierName(t.name)}</div><div style={S.muted}>{t.detail || t.state}</div></div>
        <span style={{ ...S.pill, color: t.state === "up" ? ACCENT : "#f87171" }}>{String(t.state).toUpperCase()}</span>
      </div>)}
    </div>
    <label style={{ ...S.label, display: "block", marginTop: 16 }}>In range · {peers.length}</label>
    {!peers.length && <p style={S.muted}>Nobody yet. Keep the app open and another member will appear when they arrive.</p>}
    {peers.map((p) => <div key={p.peerId} style={S.memberRow}>
      <div style={S.groupAvatar}>{(p.name || "?").slice(0, 1).toUpperCase()}</div>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{p.name}</div><div style={S.muted}>{p.key} · {p.transport} · {p.groups.length} shared</div></div>
    </div>)}
    {st && <p style={{ ...S.muted, marginTop: 14 }}>This device: <b>{st.name}</b> · {st.peerId}</p>}
  </Modal>;
}

// ---------- settings ----------
// Opened from the gear at the top right of a screen. `actions` are rows that
// open another sheet (inside a community: invite, manage members); the login
// key and Log out are always there. The key starts hidden, since anyone who
// sees it can take over the account.
function SettingsModal({ session, actions, onClose, onLogout }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const keyText = session.identityKey || session.key;
  const copy = async () => { await copyText(keyText); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return <Modal onClose={onClose} title="Settings">
    {actions.length > 0 && <div style={S.settingsGroup}>
      {actions.map((a) => <button key={a.label} style={S.settingsRow} onClick={() => { onClose(); a.onClick(); }}>{a.icon}<span>{a.label}</span></button>)}
    </div>}
    <label style={S.label}>Identity key</label>
    <div data-role="login-key" style={{ ...S.keyBox, marginTop: 0, padding: "8px 8px 8px 14px" }}>
      <span data-role="login-key-text" style={{ fontFamily: "monospace", fontSize: 15, letterSpacing: 1, flex: 1, wordBreak: "break-all" }}>{shown ? keyText.replace(/(.{4})/g, "$1 ").trim() : "•••• •••• •••• •••• ••••"}</span>
      <button style={S.iconBtn} title={shown ? "Hide identity key" : "Show identity key"} onClick={() => setShown((v) => !v)}>{shown ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      <button style={S.iconBtn} title="Copy identity key" onClick={copy}>{copied ? <Check size={16} color={ACCENT} /> : <Copy size={16} />}</button>
    </div>
    <p style={{ ...S.muted, marginTop: 6 }}>This key is this device's identity. It never leaves the device unless you copy it, and no one can recover it for you.</p>
    <button style={{ ...S.settingsRow, ...S.settingsLogout }} onClick={() => { onClose(); onLogout(); }}><LogOut size={18} /><span>Log out</span></button>
  </Modal>;
}

// ---------- username picker / change ----------
function UsernamePicker({ session, group, onSet, onLeave }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr("");
    const r = await api.post("/api/group/claimname", { key: session.key, sessionId: session.sessionId, gid: group.id, username: name.trim() });
    setBusy(false);
    if (r && r.ok) return onSet(r.group);
    if (r && r.error === "taken") return setErr("That username is unavailable in this community.");
    if (r && r.error === "invalid") return setErr("Pick a name up to 24 characters.");
    setErr("Could not set username.");
  };
  return <div style={S.center}>
    <div style={S.card} className="reveal">
      <div style={S.brand}>Pick your name</div>
      <p style={S.sub}>Choose a username for <b>{group.name}</b>. Once taken, it's reserved for you and no one else can use it.</p>
      <label style={S.label}>Username</label>
      <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter(submit)} placeholder="e.g. jordan_m" maxLength={24} />
      {err && <div style={S.error}>{err}</div>}
      <button style={{ ...S.primary, marginTop: 14, opacity: name.trim() ? 1 : .5 }} disabled={!name.trim() || busy} onClick={submit}>{busy ? "Checking…" : "Join community"}</button>
      <button style={S.ghost} onClick={onLeave}>Back</button>
    </div>
  </div>;
}

// ---------- change name (60-day cooldown, system message on success) ----------
function ChangeNameModal({ session, group, me, onClose, onChanged }) {
  const [name, setName] = useState(me.username || "");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr("");
    // The rename notice is written server-side, so it can't be forged or skipped.
    const r = await api.post("/api/group/claimname", { key: session.key, sessionId: session.sessionId, gid: group.id, username: name.trim() });
    setBusy(false);
    if (r && r.ok) { onChanged(r.group); onClose(); return; }
    if (r && r.error === "taken") return setErr("That username is unavailable in this community.");
    if (r && r.error === "cooldown") return setErr(`You can change your name again in ${r.daysLeft} day(s).`);
    if (r && r.error === "invalid") return setErr("Pick a name up to 24 characters.");
    setErr("Could not change name.");
  };
  return <Modal onClose={onClose} title="Change username">
    <p style={S.muted}>You can change your name once every 60 days. Everyone will see a note that your name changed. Your old name stays reserved to you.</p>
    <label style={{ ...S.label, marginTop: 12 }}>New username</label>
    <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter(submit)} maxLength={24} />
    {err && <div style={S.error}>{err}</div>}
    <button style={{ ...S.primary, marginTop: 14, opacity: name.trim() ? 1 : .5 }} disabled={!name.trim() || busy} onClick={submit}>{busy ? "Saving…" : "Save"}</button>
  </Modal>;
}
