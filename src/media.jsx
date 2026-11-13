// Pictures, read marks, mutes, the emoji palette and the message composer.
// Everything that deals with what the viewer types or sees lives here; the room
// that arranges it is in chat.jsx.
import * as React from "react";
import { S, MUTED, ACCENT, roomCache, sigOf, syncRoom } from "./core.jsx";

const { useState, useEffect, useCallback, useRef } = React;
const { X, Plus, Eye, EyeOff, Send, Check, Smile, ImagePlus, BarChart3 } = lucide;

function useItems(prefix, ms = 2500) {
  const [items, setItems] = useState(() => roomCache.get(prefix) || []);
  const [ready, setReady] = useState(() => roomCache.has(prefix));
  const sigRef = useRef(sigOf(roomCache.get(prefix)));
  const apply = useCallback((list) => {
    const sig = sigOf(list);
    if (sig !== sigRef.current) { sigRef.current = sig; setItems(list); }
  }, []);
  const reload = useCallback(async () => { apply(await syncRoom(prefix, true)); }, [prefix, apply]);
  const poll = useCallback(async () => {
    apply(await syncRoom(prefix));
    setReady(true);
  }, [prefix, apply]);
  useEffect(() => {
    poll();
    const t = setInterval(poll, ms);
    // Catch up immediately when the app comes back to the foreground.
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [poll, ms]);
  // A local edit (optimistic send/delete) that the next reload reconciles.
  const mutate = useCallback((fn) => {
    const next = fn(roomCache.get(prefix) || []);
    if (!next) return;
    roomCache.set(prefix, next);
    sigRef.current = sigOf(next);
    setItems(next);
  }, [prefix]);
  return [items, reload, mutate, ready];
}

// One-line preview text for reply chains (Telegram-style).
const excerptOf = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 90);
// The one-line stand-in for a message: its text, or "📷 Photo" for a picture
// sent without a caption.
const msgExcerpt = (m) => (m && m.poll ? "📊 " + excerptOf(m.text) : m && m.text ? excerptOf(m.text) : m && m.image ? "📷 Photo" : "");

// ---------- pictures ----------
// A picture is uploaded the moment it is picked or pasted, while the sender
// still types a caption, so pressing send only has to attach it. Photos are
// shrunk to at most 1600px and re-encoded as JPEG (which also drops their
// EXIF data, such as GPS location); a GIF is sent as it is, so it keeps moving.
const IMAGE_MAX_SIDE = 1600, IMAGE_MAX_BYTES = 8e6;
const imageUrl = (img) => `/api/image/${img.id}.${img.ext}`;
// Decode off the main thread where the browser can (createImageBitmap honours
// the photo's rotation), else through an <img>.
async function decodeImage(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {} }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => { const i = new window.Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}
const isHeic = (file) => /heic|heif/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
async function prepareImage(file) {
  let src;
  try { src = await decodeImage(file); }
  catch { throw new Error(isHeic(file) ? "heic" : "unreadable"); }
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  if (/gif/i.test(file.type || "")) {
    if (src.close) src.close();
    if (file.size > IMAGE_MAX_BYTES) throw new Error("image-too-large");
    return { blob: file, w: sw, h: sh };
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // transparent PNGs get a white page, not black
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("unreadable"))), "image/jpeg", 0.8));
  return { blob, w, h };
}
const IMAGE_ERRORS = {
  heic: "This browser can't open HEIC photos. Share the photo as a JPEG instead.",
  "image-too-large": "That picture is too large (8 MB at most).",
  "bad-image": "That file isn't a picture that can be sent.",
  unreadable: "That picture couldn't be opened.",
};
const imageError = (code) => IMAGE_ERRORS[code] || "Could not send the picture. Tap send to try again.";
// The first picture in a paste, drop or keyboard insert, if there is one.
const imageFrom = (dt) => {
  if (!dt) return null;
  for (const f of dt.files || []) if (/^image\//.test(f.type)) return f;
  for (const it of dt.items || []) if (it.kind === "file" && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) return f; }
  return null;
};

// A picture inside a message. It keeps its shape (up to a height limit) while
// it loads, so the feed does not jump; a tap opens it full screen.
function MsgImage({ img, onOpen, maxW = 260 }) {
  const w = Math.min(maxW, img.w || maxW);
  const h = Math.min(320, Math.round(w * (img.h || 1) / (img.w || 1)));
  return <button data-role="msg-image" title="Open picture" style={S.msgImageBtn} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
    <img src={imageUrl(img)} alt="Picture" loading="lazy" style={{ ...S.msgImage, width: w, height: h }} />
  </button>;
}
// Full-screen view of one picture. A tap anywhere, the X or Escape closes it.
function Lightbox({ m, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div data-role="lightbox" style={S.lightbox} onClick={onClose}>
    <button style={S.lightboxClose} title="Close picture" onClick={onClose}><X size={22} /></button>
    <img src={imageUrl(m.image)} alt="Picture" style={S.lightboxImg} />
    {m.text && <div style={S.lightboxCaption}>{m.text}</div>}
  </div>;
}

// Read marks are per viewer, per community, and live only in this browser — the
// same trade-off as mutes. A missing mark falls back to when the viewer joined,
// so history from before they arrived is never counted as unread.
const seenKey = (gid, meKey) => `cc_seen:${gid}:${meKey}`;
const getSeen = (gid, meKey) => { try { return Number(localStorage.getItem(seenKey(gid, meKey))) || 0; } catch { return 0; } };
const markSeen = (gid, meKey, ts) => { try { localStorage.setItem(seenKey(gid, meKey), String(ts)); } catch {} };

// Mutes are per viewer, per community, and live only in this browser.
function useMutes(gid, meKey) {
  const key = `cc_mutes:${gid}:${meKey}`;
  const [mutes, setMutes] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(mutes)); } catch {} }, [key, mutes]);
  const toggle = useCallback((authorKey) => setMutes((prev) => prev.includes(authorKey) ? prev.filter((k) => k !== authorKey) : [...prev, authorKey]), []);
  return [mutes, toggle];
}

// A small built-in emoji palette — emoji are just text, so they travel through
// the same authenticated send path as any other message.
const EMOJI = ["😀","😄","😂","🥹","😊","😍","😎","🤔","😅","😉","🙃","😴","😢","😭","😡","🤯","👍","👎","👏","🙌","🙏","💪","🤝","👋","✌️","🤞","❤️","🧡","💚","💙","🔥","✨","🎉","🎂","☕","🍕","⚽","🎮","🎵","📷","✅","❌","⚠️","🎯","💡","🚀","🌧️","🌞"];

// Reaction palette: the first five are the quick bar above a message's menu and
// the ▼ in the sixth slot expands the rest. The server accepts exactly this set
// (keep the two lists in sync — the client renders, the server validates).
const REACTIONS = ["👍","👎","❤️","🔥","💯","😂","😬","🤡","🤨","🤔","👀","🫡","🫠","😍","🤯","😡","🥴","🤝","💪"];
const QUICK_REACTIONS = REACTIONS.slice(0, 5);
const MORE_REACTIONS = REACTIONS.slice(5);

// The message box grows with its text up to six lines, then scrolls (the text
// itself is not limited). Enter sends; Shift+Enter starts a new line.
// `editing` loads one of the viewer's messages into the box; sending then
// saves the edit, and the anonymity toggle is locked, since an edit keeps it.
//
// The box is a contenteditable element, not a <textarea>: phone keyboards
// (Gboard on Android) offer their GIF and sticker buttons only to rich edit
// fields. Only plain text ever goes in — pastes and drops are inserted as
// text — and a picture arriving by paste, drop or keyboard is attached instead.
//
// With `uploadImage` (file -> Promise<{ ok, imageId, error }>), a picture
// button attaches one photo or GIF, uploaded at once while the sender types
// a caption. `onSend` receives (text, anon, imageId) and, for a picture,
// resolves to true, or to the server's error code.
const readBox = (el) => {
  if (!el) return "";
  const t = typeof el.innerText === "string" ? el.innerText : el.textContent;
  return (t || "").replace(/\u00a0/g, " ").replace(/\n$/, "");
};
function Composer({ me, onSend, placeholder, editing, uploadImage, onPoll }) {
  const [text, setText] = useState("");
  const [anonOverride, setAnonOverride] = useState(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // The + button at the left opens a vertical list of what else a message can
  // carry (anonymity, emoji, a picture, a poll); tapping + again folds it.
  const [menuOpen, setMenuOpen] = useState(false);
  const [attach, setAttach] = useState(null); // { file, previewUrl, promise, done }
  const [attachErr, setAttachErr] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const attachRef = useRef(null);
  const wasEditing = useRef(false);
  const anon = !!anonOverride;
  const allowImage = !!uploadImage;

  const setBox = (t) => {
    const el = inputRef.current; if (!el) return;
    el.textContent = t; setText(t);
    if (document.activeElement === el && t) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  };
  // Insert plain text at the caret (falls back to appending).
  const insertText = (t) => {
    const el = inputRef.current; if (!el) return;
    el.focus();
    let done = false;
    try { done = document.execCommand("insertText", false, t); } catch {}
    if (!done) el.textContent = readBox(el) + t;
    sync();
  };
  const sync = () => {
    const el = inputRef.current; if (!el) return;
    // A keyboard that inserts its GIF as an <img> (instead of a paste) still
    // ends up as an attachment, never as markup in the message.
    for (const img of el.querySelectorAll("img")) {
      const src = img.getAttribute("src"); img.remove();
      if (src && allowImage) fetch(src).then((r) => r.blob()).then((b) => startAttach(new File([b], "keyboard." + ((b.type.split("/")[1]) || "gif"), { type: b.type || "image/gif" }))).catch(() => {});
    }
    const t = readBox(el);
    if (!t.trim() && el.innerHTML && !el.textContent) el.innerHTML = ""; // a lone <br> left by deleting
    setText(t);
  };

  const dropAttach = () => {
    const a = attachRef.current;
    if (a && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    attachRef.current = null; setAttach(null); setAttachErr("");
  };
  const upload = (job) => {
    job.done = null;
    job.promise = uploadImage(job.file).then((r) => {
      job.done = r || { ok: false };
      if (attachRef.current === job && !job.done.ok) setAttachErr(imageError(job.done.error));
      return job.done;
    });
  };
  const startAttach = (file) => {
    if (!allowImage || !file) return;
    dropAttach();
    let previewUrl = "";
    try { previewUrl = URL.createObjectURL(file); } catch {}
    const job = { file, previewUrl };
    attachRef.current = job;
    upload(job);
    setAttach(job); setAttachErr("");
    if (inputRef.current) inputRef.current.focus();
  };

  const send = async () => {
    // Read the box itself: a keyboard can commit text and Enter in one go,
    // before React has seen the input event.
    const caption = readBox(inputRef.current).trim();
    if (attach && !editing) {
      if (sending) return;
      const job = attach;
      setSending(true); setEmojiOpen(false); setMenuOpen(false); setAttachErr("");
      if (job.done && !job.done.ok) upload(job); // a failed upload retries on send
      let r = await job.promise;
      let res = r && r.ok ? await onSend(caption, anon, r.imageId) : (r && r.error) || false;
      if (res === "image-expired") { upload(job); r = await job.promise; res = r && r.ok ? await onSend(caption, anon, r.imageId) : (r && r.error) || false; }
      setSending(false);
      if (attachRef.current !== job) return;
      if (res !== true) { setAttachErr(imageError(res)); return; }
      dropAttach(); setBox("");
      return;
    }
    // An edit may empty a picture's caption, but never a text message.
    if (!caption && !(editing && editing.image)) return;
    onSend(caption, anon); setBox(""); setEmojiOpen(false); setMenuOpen(false);
  };
  const pickImage = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // picking the same file again must still fire
    startAttach(file);
  };
  const onPaste = (e) => {
    const dt = e.clipboardData; if (!dt) return;
    e.preventDefault();
    const file = imageFrom(dt);
    if (file) { if (!editing) startAttach(file); return; }
    const t = dt.getData("text/plain"); if (t) insertText(t);
  };
  const onDrop = (e) => {
    const dt = e.dataTransfer; if (!dt) return;
    e.preventDefault();
    const file = imageFrom(dt);
    if (file) { if (!editing) startAttach(file); return; }
    const t = dt.getData("text/plain"); if (t) insertText(t);
  };
  // Keyboards can also hand a picture over as an input event (no paste event).
  useEffect(() => {
    const el = inputRef.current; if (!el) return;
    const onBefore = (e) => {
      const file = imageFrom(e.dataTransfer);
      if (file) { e.preventDefault(); if (!editing) startAttach(file); }
    };
    el.addEventListener("beforeinput", onBefore);
    return () => el.removeEventListener("beforeinput", onBefore);
  });
  useEffect(() => () => { const a = attachRef.current; if (a && a.previewUrl) URL.revokeObjectURL(a.previewUrl); }, []);

  const editKey = editing ? editing._key : null;
  useEffect(() => {
    if (editKey) { setEmojiOpen(false); if (inputRef.current) inputRef.current.focus(); setBox(editing.text || ""); }
    else if (wasEditing.current) setBox("");
    wasEditing.current = !!editKey;
  }, [editKey]);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = () => setEmojiOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [emojiOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);
  return <>{attach && !editing && <div data-role="attach-bar" style={S.attachBar}>
    <img src={attach.previewUrl} alt="Picture to send" style={S.attachThumb} />
    <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: attachErr ? "#f87171" : MUTED }}>{attachErr || (sending ? "Sending…" : "")}</div>
    {!sending && <button style={S.iconBtn} title="Remove picture" onClick={dropAttach}><X size={16} /></button>}
  </div>}
  <div style={S.composer}>
    {emojiOpen && <div data-role="emoji-panel" style={S.emojiPanel} onClick={(e) => e.stopPropagation()}>
      {EMOJI.map((e) => <button key={e} style={S.emojiBtn} onMouseDown={(ev) => ev.preventDefault()} onClick={() => insertText(e)}>{e}</button>)}
    </div>}
    {allowImage && <input ref={fileRef} type="file" accept="image/*" data-role="image-input" style={{ display: "none" }} onChange={pickImage} />}
    {menuOpen && <div data-role="composer-menu" style={S.composerMenu} onClick={(e) => e.stopPropagation()}>
      {/* Rows keep the box focused (mouse-down is cancelled), so the phone
          keyboard stays up. Anonymity stays open to show its new state. */}
      <button data-role="composer-menu-item" style={{ ...S.menuItem, ...(editing ? { opacity: .4, cursor: "default" } : {}) }} disabled={!!editing} onMouseDown={(ev) => ev.preventDefault()}
        title={editing ? "An edit keeps the message's name" : anon ? "Sending anonymously" : "Sending as " + me.username} onClick={() => setAnonOverride(!anon)}>
        {anon ? <EyeOff size={18} color={ACCENT} /> : <Eye size={18} />}<span style={{ flex: 1 }}>Anonymous</span>
        <span style={{ ...S.pill, background: anon ? "#2dd4bf22" : "#ffffff14", color: anon ? ACCENT : "#9fb0bd" }}>{anon ? "ON" : "OFF"}</span>
      </button>
      <button data-role="composer-menu-item" style={S.menuItem} title="Emoji" onMouseDown={(ev) => ev.preventDefault()} onClick={() => { setMenuOpen(false); setEmojiOpen(true); }}><Smile size={18} /><span>Emoji</span></button>
      {allowImage && !editing && <button data-role="composer-menu-item" style={S.menuItem} title="Send a picture" onMouseDown={(ev) => ev.preventDefault()} onClick={() => { setMenuOpen(false); fileRef.current && fileRef.current.click(); }}><ImagePlus size={18} /><span>Picture</span></button>}
      {onPoll && !editing && <button data-role="composer-menu-item" style={S.menuItem} title="Create a poll" onMouseDown={(ev) => ev.preventDefault()} onClick={() => { setMenuOpen(false); onPoll(); }}><BarChart3 size={18} /><span>Poll</span></button>}
    </div>}
    <button data-role="composer-plus" data-open={menuOpen ? "1" : "0"} style={{ ...S.composerPlus, ...(anon && !editing ? { borderColor: ACCENT, color: ACCENT } : {}) }}
      title={menuOpen ? "Close options" : "More options"} onMouseDown={(ev) => ev.preventDefault()} onClick={(e) => { e.stopPropagation(); setEmojiOpen(false); setMenuOpen((v) => !v); }}>
      <Plus size={20} style={{ transform: menuOpen ? "rotate(45deg)" : "none", transition: "transform .15s ease" }} />
      {anon && !editing && <span data-role="anon-badge" style={S.anonBadge}><EyeOff size={9} /></span>}
    </button>
    <div ref={inputRef} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={placeholder}
      data-role="composer-input" data-placeholder={placeholder} data-empty={text ? "0" : "1"} style={S.composerInput}
      onInput={sync} onPaste={onPaste} onDrop={onDrop}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || (e.nativeEvent && e.nativeEvent.isComposing)) return;
        e.preventDefault();
        if (!e.shiftKey) return send();
        let done = false;
        try { done = document.execCommand("insertLineBreak"); } catch {}
        if (!done) insertText("\n");
        sync();
      }} />
    <button style={S.sendBtn} title={editing ? "Save edit" : "Send"} onMouseDown={(ev) => ev.preventDefault()} onClick={send}>{editing ? <Check size={18} /> : <Send size={17} />}</button>
  </div></>;
}

export {
  useItems, excerptOf, msgExcerpt, IMAGE_MAX_SIDE, IMAGE_MAX_BYTES, imageUrl, decodeImage, isHeic, prepareImage,
  IMAGE_ERRORS, imageError, imageFrom, MsgImage, Lightbox, seenKey, getSeen, markSeen, useMutes,
  EMOJI, REACTIONS, QUICK_REACTIONS, MORE_REACTIONS, readBox, Composer,
};
