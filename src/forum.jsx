// The Forum tab — posts, replies and their edit sheets — plus the invite and
// member-admin sheets, which belong to the community rather than the room.
import * as React from "react";
import {
  S, ACCENT, MUTED, Modal, Stamp, copyText, api, postPrefix, postCreate, postEdit, postEditReply,
  postDelete, postReply, postDeleteReply, QRCodeView,
} from "./core.jsx";
import { useItems, Composer } from "./media.jsx";
import { senderLabel } from "./chat.jsx";

const { useState, useCallback } = React;
const { MapPin, Plus, Pencil, Trash2, EyeOff, Eye, UserMinus, Crown, Ban, Link2, Copy, Check, QrCode } = lucide;

function Forum({ session, group, me, isAdmin, mutes }) {
  const prefix = postPrefix(group.id);
  const [items, reload, mutate] = useItems(prefix, 3000);
  const [composing, setComposing] = useState(false);
  const [shown, setShown] = useState(40);
  // Show local edits immediately; the reload that follows reconciles them.
  const addLocal = useCallback((p) => mutate((cur) => (cur.some((x) => x._key === p._key) ? null : [...cur, p].sort((a, b) => a.ts - b.ts))), [mutate]);
  const replaceLocal = useCallback((key, p) => mutate((cur) => { const i = cur.findIndex((x) => x._key === key); if (i < 0) return null; const next = cur.slice(); next[i] = p; return next; }), [mutate]);
  const dropLocal = useCallback((key) => mutate((cur) => { const next = cur.filter((p) => p._key !== key); return next.length === cur.length ? null : next; }), [mutate]);
  const post = async (title, body, anon) => {
    const r = await postCreate(session, group.id, title, body, anon);
    if (r && r.ok && r.post) addLocal({ ...r.post, _key: r.key });
    reload();
  };
  const del = async (p) => { const r = await postDelete(session, group.id, p._key); if (r && r.ok) dropLocal(p._key); reload(); };
  // Edits keep the post's place, author and anonymity; the server stamps
  // `editedAt`, which every client shows as "edited" beside the time.
  const edit = async (p, title, body) => {
    const r = await postEdit(session, group.id, p._key, title, body);
    if (r && r.ok && r.post) replaceLocal(p._key, { ...r.post, _key: p._key });
    reload();
    return !!(r && r.ok);
  };
  const editReply = async (p, rid, text) => {
    const r = await postEditReply(session, group.id, p._key, rid, text);
    if (r && r.ok && r.post) replaceLocal(p._key, { ...r.post, _key: p._key });
    reload();
    return !!(r && r.ok);
  };
  const addReply = async (p, text, anon) => {
    const r = await postReply(session, group.id, p._key, text, anon);
    if (r && r.ok && r.post) replaceLocal(p._key, { ...r.post, _key: p._key });
    reload();
  };
  const delReply = async (p, rid) => {
    const r = await postDeleteReply(session, group.id, p._key, rid);
    if (r && r.ok && r.post) replaceLocal(p._key, { ...r.post, _key: p._key });
    reload();
  };
  // A muted member's posts never reach the forum for the person who muted them.
  const mutedSet = new Set(mutes || []);
  const sorted = items.filter((p) => !mutedSet.has(p.author)).sort((a, b) => b.ts - a.ts);
  // Newest posts first, and only the newest page is mounted for a long forum.
  const visible = sorted.slice(0, shown);
  return <div style={S.chatArea}>
    <div style={S.feed}>
      {sorted.length === 0 && <div style={S.empty}><MapPin size={28} style={{ opacity: .5 }} /><p style={S.muted}>No posts yet. Share something with the forum.</p></div>}
      {visible.map((p) => <PostCard key={p.id} post={p} session={session} me={me} isAdmin={isAdmin} onDelete={() => del(p)} onEdit={(t, b) => edit(p, t, b)} onEditReply={(rid, t) => editReply(p, rid, t)} onReply={(t, a) => addReply(p, t, a)} onDeleteReply={(rid) => delReply(p, rid)} />)}
      {visible.length < sorted.length && <button data-role="show-earlier" style={S.showEarlier} onClick={() => setShown(shown + 40)}>Show older posts ({sorted.length - visible.length})</button>}
    </div>
    <div style={S.composer}><button style={S.primary} onClick={() => setComposing(true)}><Plus size={18} /> New post</button></div>
    {composing && <PostComposer me={me} onClose={() => setComposing(false)} onPost={(t, b, a) => { post(t, b, a); setComposing(false); }} />}
  </div>;
}

function PostCard({ post, session, me, isAdmin, onDelete, onEdit, onEditReply, onReply, onDeleteReply }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // "post" | a reply id
  const mine = post.author === session.key;
  const replies = post.replies || [];
  return <div style={S.post} className="reveal">
    <div style={S.bubbleHead}>
      <span style={{ color: post.anon ? "#2dd4bf" : "#7dd3fc", fontWeight: 600 }}>{post.anon && <EyeOff size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}{senderLabel(post)}</span>
      {mine && <button data-role="post-edit" style={{ ...S.miniDel, marginLeft: "auto" }} title="Edit post" onClick={() => setEditing("post")}><Pencil size={12} /></button>}
      {(isAdmin || mine) && <button data-role="post-delete" style={{ ...S.miniDel, ...(mine ? { marginLeft: 0 } : {}) }} title="Delete post" onClick={onDelete}><Trash2 size={12} /></button>}
    </div>
    {post.title && <div style={S.postTitle}>{post.title}</div>}
    <div style={{ ...S.msgText, color: "#cdd9e1" }}>{post.text}</div>
    <Stamp m={post} />
    <button style={S.replyToggle} onClick={() => setOpen((o) => !o)}>{replies.length} repl{replies.length === 1 ? "y" : "ies"} {open ? "▴" : "▾"}</button>
    {open && <div style={S.replyZone}>
      {replies.map((r) => { const rmine = r.author === session.key; return <div key={r.id} style={S.reply}>
        <div style={S.bubbleHead}>
          <span style={{ color: r.anon ? "#2dd4bf" : "#7dd3fc", fontWeight: 600, fontSize: 12 }}>{r.anon && <EyeOff size={10} style={{ verticalAlign: -1, marginRight: 3 }} />}{senderLabel(r)}</span>
          {rmine && <button data-role="reply-edit" style={{ ...S.miniDel, marginLeft: "auto" }} title="Edit reply" onClick={() => setEditing(r.id)}><Pencil size={11} /></button>}
          {(isAdmin || rmine) && <button style={{ ...S.miniDel, ...(rmine ? { marginLeft: 0 } : {}) }} title="Delete reply" onClick={() => onDeleteReply(r.id)}><Trash2 size={11} /></button>}
        </div>
        <div style={{ ...S.msgText, fontSize: 14 }}>{r.text}</div>
        <Stamp m={r} />
      </div>; })}
      <Composer me={me} onSend={(t, a) => onReply(t, a)} placeholder="Add a reply…" />
    </div>}
    {editing === "post" && <EditPostModal post={post} onClose={() => setEditing(null)} onSave={onEdit} />}
    {editing && editing !== "post" && (() => { const r = replies.find((x) => x.id === editing); return r ? <EditPostModal reply={r} onClose={() => setEditing(null)} onSave={(_t, text) => onEditReply(r.id, text)} /> : null; })()}
  </div>;
}

// The sheet for changing one of your forum posts (title and text) or replies
// (text). The name or anonymity it was posted with stays as it was.
function EditPostModal({ post, reply, onClose, onSave }) {
  const item = post || reply;
  const [title, setTitle] = useState(post ? post.title || "" : "");
  const [body, setBody] = useState(item.text || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true); setErr("");
    const ok = await onSave(title.trim(), body.trim());
    setBusy(false);
    if (ok) onClose(); else setErr("Could not save the change. Try again.");
  };
  return <Modal onClose={onClose} title={post ? "Edit forum post" : "Edit reply"}>
    {post && <>
      <label style={S.label}>Title (optional)</label>
      <input data-role="edit-title" style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
    </>}
    <label style={{ ...S.label, marginTop: post ? 10 : 0 }}>{post ? "What's happening?" : "Reply"}</label>
    <textarea data-role="edit-body" style={{ ...S.input, minHeight: 90, resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)} />
    <p style={{ ...S.muted, marginTop: 8 }}>{item.anon ? "Posted anonymously — it stays anonymous." : "Posted as " + (item.authorName || "you") + "."}</p>
    {err && <div style={S.error}>{err}</div>}
    <button data-role="edit-save" style={{ ...S.primary, marginTop: 12, opacity: body.trim() ? 1 : .5 }} disabled={!body.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
  </Modal>;
}

function PostComposer({ me, onClose, onPost }) {
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [anonOverride, setAnonOverride] = useState(null);
  const anon = !!anonOverride;
  return <Modal onClose={onClose} title="New forum post">
    <label style={S.label}>Title (optional)</label>
    <input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lost cat, recommendation, alert…" maxLength={80} />
    <label style={{ ...S.label, marginTop: 10 }}>What's happening?</label>
    <textarea style={{ ...S.input, minHeight: 90, resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)} />
    <button style={{ ...S.toggleRow, marginTop: 12 }} onClick={() => setAnonOverride(!anon)}>{anon ? <EyeOff size={16} /> : <Eye size={16} />}<span style={{ flex: 1, textAlign: "left" }}>{anon ? "Posting anonymously" : "Posting as " + me.username}</span><span style={{ ...S.pill, background: anon ? "#2dd4bf22" : "#ffffff14", color: anon ? "#2dd4bf" : "#9fb0bd" }}>{anon ? "ANON" : "NAMED"}</span></button>
    <button style={{ ...S.primary, marginTop: 14, opacity: body.trim() ? 1 : .5 }} disabled={!body.trim()} onClick={() => onPost(title.trim(), body.trim(), anon)}>Post</button>
  </Modal>;
}

// ---------- invite ----------
function InviteModal({ group, session, onClose, onChange }) {
  const base = `${window.location.origin}${window.location.pathname}`;
  const [mode, setMode] = useState("reusable"); // reusable | once
  const [once, setOnce] = useState(group.inviteOnce || null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = async (which, text) => { await copyText(text); setCopied(which); setTimeout(() => setCopied(""), 1500); };
  const genOnce = async () => {
    setBusy(true);
    const r = await api.post("/api/group/invite", { key: session.key, sessionId: session.sessionId, gid: group.id });
    setBusy(false);
    if (r && r.ok) { setOnce(r.code); if (onChange) onChange(); }
  };
  const reusableLink = `${base}#join=${group.invite}`;
  const onceLink = once ? `${base}#join=${once}` : "";
  const codeBlock = (which, link) => <>
    <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 14px" }}><QRCodeView text={link} size={190} /></div>
    <div style={S.linkBox}>
      <Link2 size={16} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{link}</span>
      <button style={S.iconBtn} title="Copy link" onClick={() => copy(which, link)}>{copied === which ? <Check size={16} color="#2dd4bf" /> : <Copy size={16} />}</button>
    </div>
  </>;
  return <Modal onClose={onClose} title="Invite people">
    <div style={S.segment}>
      <button style={{ ...S.segBtn, ...(mode === "reusable" ? S.segBtnActive : {}) }} onClick={() => setMode("reusable")}>Indefinite link</button>
      <button style={{ ...S.segBtn, ...(mode === "once" ? S.segBtnActive : {}) }} onClick={() => setMode("once")}>One-time link</button>
    </div>
    {mode === "reusable" ? <>
      <p style={{ ...S.muted, textAlign: "center" }}>Anyone with this link can join, as many times as you like.</p>
      {codeBlock("reusable", reusableLink)}
      <p style={{ ...S.muted, textAlign: "center", marginTop: 10 }}>Invite code: <b>{group.invite}</b></p>
    </> : <>
      <p style={{ ...S.muted, textAlign: "center" }}>This link works <b>once</b> — it stops working as soon as one person joins.</p>
      {once ? <>
        {codeBlock("once", onceLink)}
        <p style={{ ...S.muted, textAlign: "center", marginTop: 10 }}>Invite code: <b>{once}</b></p>
      </> : <div style={S.empty}><QrCode size={28} style={{ opacity: .5 }} /><p style={S.muted}>No one-time link yet.</p></div>}
      <button style={{ ...S.secondaryFull, marginTop: 12 }} disabled={busy} onClick={genOnce}>
        <Plus size={16} /> {busy ? "Creating…" : once ? "Generate a new one-time link" : "Create one-time link"}
      </button>
    </>}
  </Modal>;
}

// ---------- admin ----------
function AdminModal({ session, group, isOwner, onClose, onChange, onDeleted }) {
  const members = Object.entries(group.members);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  // owner-only permanent ban
  const banUser = async (targetKey) => {
    await api.post("/api/group/ban", { key: session.key, sessionId: session.sessionId, gid: group.id, targetKey });
    onChange();
  };
  // Both actions are validated server-side; the client can't just rewrite the group doc.
  // admin (non-permanent) remove: just drop membership (can rejoin)
  const removeUser = async (targetKey) => {
    if (targetKey === group.ownerKey) return;
    await api.post("/api/group/remove", { key: session.key, sessionId: session.sessionId, gid: group.id, targetKey });
    onChange();
  };
  const toggleAdmin = async (targetKey) => {
    await api.post("/api/group/toggleadmin", { key: session.key, sessionId: session.sessionId, gid: group.id, targetKey });
    onChange();
  };
  return <Modal onClose={onClose} title="Manage members">
    <p style={S.muted}>Admins can remove members & delete messages. {isOwner ? "As owner, you can permanently ban." : "Only the owner can permanently ban."}</p>
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {members.map(([mKey, info]) => {
        const isAdm = (group.admins || []).includes(mKey);
        const isOwn = mKey === group.ownerKey;
        return <div key={mKey} style={S.memberRow}>
          <div style={S.groupAvatar}>{(info.username || "?").slice(0, 1).toUpperCase()}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{info.username || "(no name yet)"} {mKey === session.key && "(you)"}</div>
            <div style={S.muted}>{isOwn ? "Owner" : isAdm ? "Admin" : "Member"}</div>
          </div>
          {!isOwn && <>
            {isOwner && <button style={S.miniBtn} title="Toggle admin" onClick={() => toggleAdmin(mKey)}><Crown size={14} color={isAdm ? "#fbbf24" : "#6b7a85"} /></button>}
            <button style={S.miniBtn} title="Remove (can rejoin)" onClick={() => removeUser(mKey)}><UserMinus size={14} color="#f59e0b" /></button>
            {isOwner && <button style={S.miniBtn} title="Ban permanently" onClick={() => banUser(mKey)}><Ban size={14} color="#f87171" /></button>}
          </>}
        </div>;
      })}
    </div>
    {isOwner && <div style={S.dangerZone}>
      <div style={{ fontWeight: 700, color: "#f87171", marginBottom: 6 }}>Danger zone</div>
      {!confirmDel
        ? <button style={S.dangerBtn} onClick={() => setConfirmDel(true)}><Trash2 size={15} /> Delete this community</button>
        : <>
            <p style={{ ...S.muted, marginBottom: 8 }}>This permanently deletes <b>{group.name}</b> and all its messages and posts for everyone. This can't be undone.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...S.secondaryFull, flex: 1 }} disabled={busyDel} onClick={() => setConfirmDel(false)}>Cancel</button>
              <button style={{ ...S.dangerBtn, flex: 1 }} disabled={busyDel} onClick={async () => {
                setBusyDel(true);
                const r = await api.post("/api/group/delete", { key: session.key, sessionId: session.sessionId, gid: group.id });
                setBusyDel(false);
                if (r && r.ok) { onClose(); onDeleted(); }
              }}>{busyDel ? "Deleting…" : "Yes, delete forever"}</button>
            </div>
          </>}
    </div>}
  </Modal>;
}

export { Forum, PostCard, EditPostModal, PostComposer, InviteModal, AdminModal };
