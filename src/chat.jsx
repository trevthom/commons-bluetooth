// The General room: the message feed, bubbles, polls, reactions and threads.
import * as React from "react";
import {
  S, ACCENT, MUTED, SENDER, Modal, Stamp, fmtStamp, messageSend, messageDelete, messageEdit,
  messageReact, messageSearch, pollCreate, pollVote, setPin, imageUpload, msgPrefix, anonName,
} from "./core.jsx";
import {
  useItems, msgExcerpt, MsgImage, Lightbox, getSeen, markSeen, prepareImage, Composer,
  QUICK_REACTIONS, MORE_REACTIONS,
} from "./media.jsx";

const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
const {
  Search, X, Pin, BellOff, MoreVertical, ChevronDown, Pencil, CornerUpLeft, EyeOff, Check, BarChart3,
  MessageSquare, PinOff, Bell, Trash2,
} = lucide;

const senderLabel = (m) => m.system ? null : (m.anon ? anonName(m.author, m.gid, m.ts) : m.authorName);
// Telegram-style "who: what" line for a community card's newest message.
const previewOf = (m, meKey) => m.system ? m.text : `${m.author === meKey ? "You" : (senderLabel(m) || "member")}: ${msgExcerpt(m)}`;
// A long room mounts only the tail of its history; the rest stays one tap away.
// Threads, reply previews and search still resolve against the full list.
const WINDOW = 150;

function GeneralChat({ session, group, me, isAdmin, mutes, onToggleMute, onGroupChange, searchOpen, onCloseSearch }) {
  const prefix = msgPrefix(group.id);
  const [items, reload, mutate, ready] = useItems(prefix);
  const [shown, setShown] = useState(WINDOW);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [lightbox, setLightbox] = useState(null); // the message whose picture is open
  const [pollOpen, setPollOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const [revealed, setRevealed] = useState(() => new Set());
  const [pinIdx, setPinIdx] = useState(0);
  const [highlight, setHighlight] = useState(null);
  const [jumpTo, setJumpTo] = useState(null);
  const [anchor, setAnchor] = useState(null); // the first unseen message this visit opened on
  const [atBottom, setAtBottom] = useState(true);
  const [menuUp, setMenuUp] = useState(false);
  const endRef = useRef(null);
  const feedRef = useRef(null);
  const openedRef = useRef(false);
  // The scroll handler and the effects below agree through this ref: refs
  // update synchronously, so a layout effect that lands on an anchor cannot be
  // overruled by the mark-as-seen effect running in the same commit.
  const atBottomRef = useRef(true);
  // Freeze the read mark for the visit: the room opens on the first message the
  // viewer hasn't seen, and only then does the mark narrow to the newest one.
  const [openSeen] = useState(() => getSeen(group.id, session.key) || (me && me.joinedAt) || 0);
  const jumpToBottom = () => { setAnchor(null); atBottomRef.current = true; setAtBottom(true); endRef.current && endRef.current.scrollIntoView({ behavior: "smooth" }); };
  // Opening the room lands on the first unseen message (Telegram-style), so the
  // reader can scroll down through what they missed. A room with nothing unseen
  // (coming back from the Forum, or reopening a room that was read) lands on the
  // newest message instantly, with no animation and no flash of the top.
  useLayoutEffect(() => {
    if (!items.length) return;
    if (!openedRef.current) {
      openedRef.current = true;
      const firstUnseen = items.find((m) => !m.system && m.author !== session.key && m.ts > openSeen);
      if (firstUnseen) {
        const el = document.getElementById("msg-" + firstUnseen.id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        flash(firstUnseen.id);
        setAnchor(firstUnseen.id);
        atBottomRef.current = false;
        setAtBottom(false);
        return;
      }
      const feed = feedRef.current;
      if (feed) feed.scrollTop = feed.scrollHeight;
      return;
    }
    if (atBottomRef.current) endRef.current && endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);
  // Watching the newest message is what marks it read: while the reader is at
  // the bottom the mark follows the newest message, which is what clears the
  // scroll-down arrow, the anchor and the community-list unread badge.
  useEffect(() => {
    if (!items.length || !atBottomRef.current) return;
    const newest = items[items.length - 1];
    if (newest && newest.ts > (getSeen(group.id, session.key) || 0)) markSeen(group.id, session.key, newest.ts);
    setAnchor(null);
  }, [items.length, atBottom]);
  const onFeedScroll = () => {
    const el = feedRef.current; if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setAnchor(null); // the newest is in view: forget the anchor
  };
  // The arrow only offers what the reader has not looked at yet.
  const showDown = !atBottom;
  // A click anywhere outside an open message menu dismisses it.
  useEffect(() => {
    const close = () => setMenuFor(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  // A reveal only bypasses the mute that was active when the reader tapped it.
  // Without this, unmuting and muting the same person again leaves a stale
  // reveal behind, so the re-muted messages (and their reply previews) still
  // look visible — the whole point of muting stops working.
  const muteStamp = (mutes || []).join("|");
  useEffect(() => { setRevealed(new Set()); }, [muteStamp]);

  const pins = group.pins || [];
  useEffect(() => { setPinIdx(0); }, [pins.length]);
  // Closing the search bar also clears the search.
  useEffect(() => { if (!searchOpen) setQuery(""); }, [searchOpen]);
  const trimmed = query.trim();
  // Search is executed by the server over the group's entire history, so it is
  // not limited to (or dependent on) what this client has loaded.
  useEffect(() => {
    if (!trimmed) { setResults(null); return; }
    let dead = false;
    const t = setTimeout(async () => {
      const r = await messageSearch(session, group.id, trimmed);
      if (!dead) setResults(r && r.ok ? r.results : []);
    }, 150);
    return () => { dead = true; clearTimeout(t); };
  }, [trimmed, session.key, session.sessionId, group.id]);

  const flash = (id) => { setHighlight(id); setTimeout(() => setHighlight(null), 1800); };
  const scrollToId = (id) => { const el = document.getElementById("msg-" + id); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); flash(id); } };
  // After a search result is picked the query clears; scroll once the list is back.
  useEffect(() => {
    if (!jumpTo) return;
    scrollToId(jumpTo);
    setJumpTo(null);
  }, [jumpTo, items.length]);
  const cyclePin = () => {
    if (!pins.length) return;
    const next = pins.length > 1 ? (pinIdx + 1) % pins.length : pinIdx;
    setPinIdx(next);
    scrollToId(pins[next].id);
  };

  const mutedSet = new Set(mutes || []);
  const byKey = new Map(items.map((m) => [m._key, m]));
  const references = new Set(items.filter((m) => m.replyTo && m.replyTo.key).map((m) => m.replyTo.key));
  const reveal = (k) => setRevealed((prev) => { const n = new Set(prev); n.add(k); return n; });
  // Walk up the reply chain to the message that started the thread.
  const rootOf = (m) => { let cur = m; const seen = new Set(); while (cur && cur.replyTo && cur.replyTo.key) { const up = byKey.get(cur.replyTo.key); if (!up || seen.has(cur._key)) break; seen.add(cur._key); cur = up; } return cur; };
  // Every message that replies to `key`, directly or transitively.
  const descendants = (key) => { const out = []; const seen = new Set([key]); let frontier = [key]; while (frontier.length) { const next = []; for (const fk of frontier) for (const m of items) { if (m.replyTo && m.replyTo.key === fk && !seen.has(m._key)) { seen.add(m._key); out.push(m); next.push(m._key); } } frontier = next; } return out; };

  // Show local edits immediately; the reload that follows reconciles them.
  const addLocal = useCallback((m) => mutate((cur) => (cur.some((x) => x._key === m._key) ? null : [...cur, m].sort((a, b) => a.ts - b.ts))), [mutate]);
  const dropLocal = useCallback((key) => mutate((cur) => { const next = cur.filter((m) => m._key !== key); return next.length === cur.length ? null : next; }), [mutate]);
  const replaceLocal = useCallback((key, item) => mutate((cur) => { const i = cur.findIndex((m) => m._key === key); if (i < 0) return null; const next = cur.slice(); next[i] = item; return next; }), [mutate]);
  // A reaction toggles for the viewer immediately; the delta polls carry it to
  // everyone else (the server bumps the message's `updatedAt`).
  const react = async (m, emoji) => {
    const r = await messageReact(session, group.id, m._key, emoji);
    if (r && r.ok && r.message) replaceLocal(m._key, { ...r.message, _key: m._key });
  };
  // Resolves to true, or to the server's error code (the composer retries an
  // expired picture upload once).
  const postMessage = async (text, anon, parent, imageId) => {
    const r = await messageSend(session, group.id, text, anon, parent ? { key: parent._key } : null, imageId);
    if (r && r.ok && r.message) addLocal({ ...r.message, _key: r.key });
    reload();
    return r && r.ok ? true : (r && r.error) || false;
  };
  const vote = async (m, optionId) => {
    const r = await pollVote(session, group.id, m._key, optionId);
    if (r && r.ok && r.message) replaceLocal(m._key, { ...r.message, _key: m._key });
  };
  const createPoll = async (question, options, multi) => {
    const parent = replyTo;
    const r = await pollCreate(session, group.id, question, options, multi, parent ? { key: parent._key } : null);
    if (r && r.ok && r.message) { addLocal({ ...r.message, _key: r.key }); setReplyTo(null); reload(); return true; }
    return (r && r.error) || false;
  };
  const uploadImage = useCallback(async (file) => {
    let prep;
    try { prep = await prepareImage(file); } catch (e) { return { ok: false, error: e.message }; }
    return (await imageUpload(session, group.id, prep)) || { ok: false, error: "network" };
  }, [session.key, session.sessionId, group.id]);
  // An edit changes the text in place; the server stamps `editedAt`, which
  // every client shows as "edited" beside the time.
  const saveEdit = async (m, text) => {
    setEditing(null);
    if (text === m.text) return;
    const r = await messageEdit(session, group.id, m._key, text);
    if (r && r.ok && r.message) replaceLocal(m._key, { ...r.message, _key: m._key });
  };
  const send = (text, anon, image) => {
    if (editing) return saveEdit(editing, text);
    // A picture's reply target stays until it really sends, so a failed
    // upload can be retried as the same reply.
    const parent = replyTo;
    if (!image) { setReplyTo(null); return postMessage(text, anon, parent); }
    return postMessage(text, anon, parent, image).then((res) => { if (res === true) setReplyTo(null); return res; });
  };
  // Replying and editing share the banner over the composer, so one cancels the other.
  const startReply = (m) => { setEditing(null); setReplyTo(m); };
  const startEdit = (m) => { setReplyTo(null); setEditing(m); };
  const del = async (m) => { const r = await messageDelete(session, group.id, m._key); if (r && r.ok) dropLocal(m._key); reload(); };
  const togglePin = async (m) => {
    await setPin(session, group.id, m._key, !pins.some((p) => p.key === m._key));
    if (onGroupChange) onGroupChange();
  };
  const openThread = (m) => setThreadRoot(rootOf(m));
  // Open the ⋮ menu, flipping it above the bubble when there is not enough room
  // below: the newest message sits against the composer, and a downward menu
  // would be cut off by the feed's edge.
  const toggleMenu = (m, e) => {
    e.stopPropagation();
    if (menuFor === m.id) { setMenuFor(null); return; }
    const bubble = e.currentTarget.parentElement && e.currentTarget.parentElement.parentElement;
    const feed = feedRef.current;
    let up = false;
    if (bubble && feed) {
      const br = bubble.getBoundingClientRect(), fr = feed.getBoundingClientRect();
      // Flip only when the menu (reaction bar, items and the expanded palette)
      // does not fit below and there is more room above, so a message near the
      // top never pushes its reaction bar under the search bar.
      const below = fr.bottom - br.bottom, above = br.top - fr.top;
      up = below < 370 && above > below;
    }
    setMenuUp(up);
    setMenuFor(m.id);
  };
  const pinText = (pin) => { const m = byKey.get(pin.key); return m ? `${senderLabel(m)}: ${msgExcerpt(m)}` : "Deleted message"; };
  // Render only the newest slice of a long room; the window always stretches
  // to include the first unseen message, so opening still lands on it.
  const unseenIdx = items.findIndex((m) => !m.system && m.author !== session.key && m.ts > openSeen);
  const shownCount = Math.max(shown, unseenIdx >= 0 ? items.length - unseenIdx + 20 : 0);
  const visible = items.length > shownCount ? items.slice(items.length - shownCount) : items;
  return <div style={S.chatArea}>
    {searchOpen && <div data-role="search-bar" style={S.searchBar}>
      <Search size={16} style={{ color: "#7b8a96", flexShrink: 0 }} />
      <input autoFocus style={S.searchInput} value={query} placeholder="Search all messages" onChange={(e) => setQuery(e.target.value)} />
      <button style={S.iconBtn} title="Close search" onClick={onCloseSearch}><X size={16} /></button>
    </div>}
    {!trimmed && pins.length > 0 && <button data-role="pin-bar" style={S.pinBar} onClick={cyclePin} title={pins.length > 1 ? "Pinned messages — tap for the next" : "Pinned message"}>
      <Pin size={15} style={{ color: ACCENT, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        <div style={S.pinBarLabel}>Pinned message{pins.length > 1 ? ` ${pinIdx + 1}/${pins.length}` : ""}</div>
        <div style={S.pinBarText}>{pinText(pins[pinIdx] || pins[0])}</div>
      </div>
    </button>}
    <div style={S.feedWrap}>
    {trimmed ? <div style={S.messages}>
      <div style={{ ...S.muted, padding: "2px 4px" }}>{results === null ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"} across the whole history`}</div>
      {results && results.map((r) => <button key={r.key} style={S.result} onClick={() => { setResults(null); setQuery(""); setJumpTo(r.id); }}>
        <span style={{ color: SENDER, fontWeight: 600, fontSize: 13 }}>{r.anon ? anonName(r.author, group.id, r.ts) : (r.authorName || "member")}</span>
        <div style={S.resultText}>{r.text}</div>
        <div data-role="msg-stamp" style={S.stamp}>{fmtStamp(r.ts)}</div>
      </button>)}
      {results && results.length === 0 && <div style={S.empty}><p style={S.muted}>No messages match “{trimmed}”.</p></div>}
    </div> : <div ref={feedRef} onScroll={onFeedScroll} data-role="feed" data-unread-anchor={anchor || undefined} style={S.messages}>
      {items.length === 0 && <div style={S.empty}><p style={S.muted}>{ready ? "Be the first to say hello 👋" : "Loading messages…"}</p></div>}
      {visible.length < items.length && <button data-role="show-earlier" style={S.showEarlier} onClick={() => setShown(shownCount + WINDOW)}>Show earlier messages</button>}
      {visible.map((m) => {
        if (m.system) return <div key={m.id} id={"msg-" + m.id} style={S.systemMsg} className="reveal">{m.text}</div>;
        const mine = m.author === session.key;
        const isMuted = mutedSet.has(m.author);
        const inChain = references.has(m._key) || !!m.replyTo;
        const pinned = pins.some((p) => p.key === m._key);
        // A muted author's messages leave the room — unless someone replied to
        // them (or they reply to something), when they stay in the chain as a
        // collapsed placeholder the reader can reveal.
        if (isMuted && !inChain) return null;
        if (isMuted && !revealed.has(m._key)) {
          return <div key={m.id} id={"msg-" + m.id} style={{ ...S.bubbleRow, justifyContent: mine ? "flex-end" : "flex-start" }} className="reveal">
            <div style={{ ...S.bubble, ...(mine ? S.bubbleMine : {}), ...S.mutedBubble, ...(highlight === m.id ? S.bubbleFlash : {}) }}>
              <div style={S.bubbleHead}>
                <span style={{ color: MUTED, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}><BellOff size={11} /> Muted message</span>
                <button style={S.showBtn} title="Show this message" onClick={() => reveal(m._key)}>Show</button>
              </div>
              <div style={{ fontSize: 13, color: MUTED, fontStyle: "italic" }}>Hidden because you muted this user.</div>
              <div data-role="msg-stamp" style={S.stamp}>{fmtStamp(m.ts)}</div>
            </div>
          </div>;
        }
        const root = rootOf(m);
        const hasThread = !!root && descendants(root._key).length > 0;
        return <div key={m.id} id={"msg-" + m.id} style={{ ...S.bubbleRow, justifyContent: mine ? "flex-end" : "flex-start", ...(menuFor === m.id ? S.bubbleRowActive : {}) }} className="reveal">
          <div style={{ ...S.bubble, ...(mine ? S.bubbleMine : {}), ...(highlight === m.id ? S.bubbleFlash : {}) }}>
            <div style={S.bubbleHead}>
              <span style={{ color: SENDER, fontWeight: 600 }}>{m.anon && <EyeOff size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}{senderLabel(m)}</span>
              {pinned && <Pin size={11} style={{ color: ACCENT, flexShrink: 0 }} />}
              <button style={S.miniDel} title="Message options" onClick={(e) => toggleMenu(m, e)}><MoreVertical size={14} /></button>
            </div>
            {menuFor === m.id && <MsgMenu mine={mine} isAdmin={isAdmin} hasThread={hasThread} muted={isMuted} pinned={pinned} menuUp={menuUp}
              canEdit={!m.poll} onClose={() => setMenuFor(null)} onReply={() => startReply(m)} onEdit={() => startEdit(m)} onThread={() => openThread(m)}
              onToggleMute={() => onToggleMute(m.author)} onTogglePin={() => togglePin(m)} onDelete={() => del(m)} onReact={(emoji) => react(m, emoji)} />}
            {m.replyTo && <ReplyPreview replyTo={m.replyTo} byKey={byKey} mutedSet={mutedSet} revealed={revealed} onReveal={reveal} />}
            {m.image && <MsgImage img={m.image} onOpen={() => setLightbox(m)} />}
            {m.poll
              ? <PollCard m={m} meKey={session.key} onVote={(oid) => vote(m, oid)} />
              : m.text && <div style={S.msgText}>{m.text}</div>}
            <Reactions msg={m} meKey={session.key} onToggle={(emoji) => react(m, emoji)} />
            <Stamp m={m} />
          </div>
        </div>;
      })}
      <div ref={endRef} />
    </div>}
    {showDown && <button data-role="scroll-down" title="Jump to the newest messages" style={S.scrollDown} onClick={jumpToBottom}><ChevronDown size={20} /></button>}
    </div>
    {editing && <div data-role="edit-banner" style={S.replyBanner}>
      <Pencil size={14} style={{ flexShrink: 0, color: ACCENT }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.replyBannerName}>Editing message</div>
        <div style={S.replyBannerText}>{msgExcerpt(editing)}</div>
      </div>
      <button style={S.iconBtn} title="Cancel edit" onClick={() => setEditing(null)}><X size={16} /></button>
    </div>}
    {replyTo && <div style={S.replyBanner}>
      <CornerUpLeft size={14} style={{ flexShrink: 0, color: ACCENT }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.replyBannerName}>Replying to {senderLabel(replyTo) || "message"}</div>
        <div style={S.replyBannerText}>{msgExcerpt(replyTo)}</div>
      </div>
      <button style={S.iconBtn} title="Cancel reply" onClick={() => setReplyTo(null)}><X size={16} /></button>
    </div>}
    <Composer me={me} onSend={send} editing={editing} uploadImage={uploadImage} onPoll={() => setPollOpen(true)} placeholder="Message…" />
    {pollOpen && <PollModal onClose={() => setPollOpen(false)} onCreate={createPoll} />}
    {threadRoot && <ThreadModal root={threadRoot} items={items} byKey={byKey} me={me} onClose={() => setThreadRoot(null)} onReply={(t, a, img) => postMessage(t, a, threadRoot, img)} uploadImage={uploadImage} onOpenImage={setLightbox} />}
    {lightbox && lightbox.image && <Lightbox m={lightbox} onClose={() => setLightbox(null)} />}
  </div>;
}

// The per-message menu (opened from the ⋮ button in a bubble's header): a quick
// reaction bar above the items, with a ▼ in the sixth slot that expands the
// rest of the palette. Each member has one reaction per message: picking
// another replaces it, and picking the same one again removes it.
function MsgMenu({ mine, canEdit, isAdmin, hasThread, muted, pinned, menuUp, onClose, onReply, onEdit, onThread, onToggleMute, onTogglePin, onDelete, onReact }) {
  const [expanded, setExpanded] = useState(false);
  const item = (icon, label, onClick, danger) => (
    <button key={label} style={{ ...S.menuItem, ...(danger ? S.menuItemDanger : {}) }}
      onClick={(e) => { e.stopPropagation(); onClose(); onClick(); }}>{icon}<span>{label}</span></button>
  );
  const emojiBtn = (emoji) => (
    <button key={emoji} data-role="react" title={`React ${emoji}`} style={S.reactBtn}
      onClick={(e) => { e.stopPropagation(); onReact(emoji); }}>{emoji}</button>
  );
  return <div data-role="msg-menu" style={{ ...S.menuWrap, ...(mine ? S.menuMine : S.menuTheirs), ...(menuUp ? S.menuUp : {}) }} onClick={(e) => e.stopPropagation()}>
    <div style={S.reactBar}>
      {QUICK_REACTIONS.map(emojiBtn)}
      <button data-role="react-more" title={expanded ? "Fewer reactions" : "More reactions"} style={S.reactMore}
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
        <ChevronDown size={17} style={{ transform: expanded ? "rotate(180deg)" : "none" }} />
      </button>
    </div>
    {expanded && <div data-role="react-more-panel" style={S.reactMorePanel}>{MORE_REACTIONS.map(emojiBtn)}</div>}
    <div style={S.menu}>
      {item(<CornerUpLeft size={15} />, "Reply", onReply)}
      {mine && canEdit && item(<Pencil size={15} />, "Edit message", onEdit)}
      {hasThread && item(<MessageSquare size={15} />, "View message thread", onThread)}
      {isAdmin && item(pinned ? <PinOff size={15} /> : <Pin size={15} />, pinned ? "Unpin message" : "Pin message", onTogglePin)}
      {!mine && item(muted ? <BellOff size={15} /> : <Bell size={15} />, muted ? "Unmute user" : "Mute user", onToggleMute)}
      {(mine || isAdmin) && item(<Trash2 size={15} />, "Delete message", onDelete, true)}
    </div>
  </div>;
}

// A poll inside a message: the question, then one button per option with a bar
// showing its share of the voters. Tapping an option votes; tapping your own
// choice again takes the vote back (single-answer polls swap to the new one).
function PollCard({ m, meKey, onVote }) {
  const poll = m.poll;
  const votes = poll.votes && typeof poll.votes === "object" ? poll.votes : {};
  const who = (id) => (Array.isArray(votes[id]) ? votes[id] : []);
  const voters = new Set(Object.values(votes).flatMap((v) => (Array.isArray(v) ? v : []))).size;
  return <div data-role="poll" style={S.poll}>
    <div style={S.pollQuestion}><BarChart3 size={14} style={{ flexShrink: 0, marginTop: 3, color: ACCENT }} /><span style={S.msgText}>{m.text}</span></div>
    <div style={S.pollHint}>{poll.multi ? "Choose any number" : "Choose one"}</div>
    {poll.options.map((o) => {
      const n = who(o.id).length, mine = who(o.id).includes(meKey);
      const pct = voters ? Math.round((n / voters) * 100) : 0;
      return <button key={o.id} data-role="poll-option" data-mine={mine ? "1" : "0"} title={mine ? "Take back your vote" : "Vote for this"} style={{ ...S.pollOption, ...(mine ? S.pollOptionMine : {}) }}
        onClick={(e) => { e.stopPropagation(); onVote(o.id); }}>
        <span style={{ ...S.pollBar, width: pct + "%" }} />
        <span style={S.pollMark}>{mine ? <Check size={14} color={ACCENT} /> : null}</span>
        <span style={{ ...S.pollText, ...S.msgText }}>{o.text}</span>
        <span data-role="poll-count" style={S.pollCount}>{n}{voters ? ` · ${pct}%` : ""}</span>
      </button>;
    })}
    <div data-role="poll-total" style={S.pollTotal}>{voters} {voters === 1 ? "voter" : "voters"}</div>
  </div>;
}
// The sheet for writing a poll: a question and 2–10 options.
function PollModal({ onClose, onCreate }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dup = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready = question.trim() && filled.length >= 2 && !dup;
  const setOpt = (i, v) => setOptions((cur) => cur.map((o, j) => (j === i ? v : o)));
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const r = await onCreate(question.trim(), filled, multi);
    setBusy(false);
    if (r === true) onClose(); else setErr("Could not create the poll. Try again.");
  };
  return <Modal onClose={onClose} title="Create a poll">
    <label style={S.label}>Question</label>
    <input data-role="poll-question" style={S.input} value={question} maxLength={200} placeholder="Where should we meet?" onChange={(e) => setQuestion(e.target.value)} />
    <label style={{ ...S.label, marginTop: 12 }}>Options</label>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {options.map((o, i) => <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input data-role="poll-option-input" style={S.input} value={o} maxLength={80} placeholder={`Option ${i + 1}`} onChange={(e) => setOpt(i, e.target.value)} />
        {options.length > 2 && <button style={S.iconBtn} title="Remove option" onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}><X size={16} /></button>}
      </div>)}
    </div>
    {options.length < 10 && <button data-role="poll-add-option" style={{ ...S.ghost, textAlign: "left", color: ACCENT, padding: "8px 2px" }} onClick={() => setOptions((cur) => [...cur, ""])}>+ Add an option</button>}
    {dup && <div style={S.error}>Each option must be different.</div>}
    <button style={{ ...S.toggleRow, marginTop: 8 }} onClick={() => setMulti((v) => !v)}>
      <span style={{ flex: 1, textAlign: "left" }}>Allow more than one answer</span>
      <span style={{ ...S.pill, background: multi ? "#2dd4bf22" : "#ffffff14", color: multi ? ACCENT : "#9fb0bd" }}>{multi ? "ON" : "OFF"}</span>
    </button>
    {err && <div style={S.error}>{err}</div>}
    <button data-role="poll-submit" style={{ ...S.primary, marginTop: 14, opacity: ready ? 1 : .5 }} disabled={!ready || busy} onClick={submit}>{busy ? "Posting…" : "Post poll"}</button>
  </Modal>;
}

// Reaction chips under a message's text; tapping one sets or removes the
// viewer's reaction (the server keeps one per member).
function Reactions({ msg, meKey, onToggle }) {
  const shown = msg.reactions && typeof msg.reactions === "object"
    ? Object.entries(msg.reactions).filter(([, who]) => Array.isArray(who) && who.length)
    : [];
  if (!shown.length) return null;
  return <div style={S.reactionRow}>
    {shown.map(([emoji, who]) => <button key={emoji} data-role="reaction" title={`React ${emoji}`}
      style={{ ...S.reactionChip, ...(who.includes(meKey) ? S.reactionChipMine : {}) }}
      onClick={(e) => { e.stopPropagation(); onToggle(emoji); }}>{emoji}<span style={S.reactionCount}>{who.length}</span></button>)}
  </div>;
}

// Telegram-style "in reply to" preview above a message's text.
function ReplyPreview({ replyTo, byKey, mutedSet, revealed, onReveal }) {
  // The stored reply only carries the parent's key/author, so the name and
  // excerpt always come from the live message (and stay "Deleted" if it's gone).
  const parent = byKey.get(replyTo.key);
  const hiddenMuted = !!parent && mutedSet.has(parent.author) && !revealed.has(replyTo.key);
  return <div data-role="reply-preview" data-muted={hiddenMuted ? "1" : "0"}
    style={{ ...S.replyPreview, ...(hiddenMuted ? S.replyPreviewMuted : {}) }}
    onClick={hiddenMuted ? () => onReveal(replyTo.key) : undefined}
    title={hiddenMuted ? "Show the muted message" : undefined}>
    <CornerUpLeft size={13} style={{ flexShrink: 0, marginTop: 1 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      {!parent
        ? <div style={{ ...S.replyPreviewName, color: MUTED, fontStyle: "italic" }}>Deleted</div>
        : hiddenMuted
          ? <div style={{ ...S.replyPreviewName, color: MUTED }}>Muted — tap to show</div>
          : <div style={S.replyPreviewName}>{senderLabel(parent)}</div>}
      {parent && !hiddenMuted && <div style={S.replyPreviewText}>{msgExcerpt(parent)}</div>}
    </div>
  </div>;
}

// A whole reply chain, opened by "View message thread".
function ThreadModal({ root, items, byKey, me, onClose, onReply, uploadImage, onOpenImage }) {
  const chain = [];
  const seen = new Set([root._key]); let frontier = [root._key];
  while (frontier.length) {
    const next = [];
    for (const fk of frontier) for (const m of items) {
      if (m.replyTo && m.replyTo.key === fk && !seen.has(m._key)) { seen.add(m._key); chain.push(m); next.push(m._key); }
    }
    frontier = next;
  }
  const all = [root, ...chain].sort((a, b) => a.ts - b.ts);
  return <Modal onClose={onClose} title="Message thread">
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
      {all.map((m, i) => <div key={m.id} style={{ ...S.reply, ...(i === 0 ? S.threadRoot : {}) }}>
        <div style={S.bubbleHead}>
          <span style={{ color: SENDER, fontWeight: 600, fontSize: 12 }}>{m.anon && <EyeOff size={10} style={{ verticalAlign: -1, marginRight: 3 }} />}{senderLabel(m)}</span>
          {i === 0 && <span style={{ ...S.pill, background: "#2dd4bf22", color: ACCENT, marginLeft: "auto" }}>ORIGINAL</span>}
        </div>
        {m.replyTo && <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>↩ {(() => { const par = byKey && byKey.get(m.replyTo.key); return par ? senderLabel(par) : "Deleted"; })()}</div>}
        {m.image && <MsgImage img={m.image} maxW={220} onOpen={() => onOpenImage(m)} />}
        {m.text && <div style={{ ...S.msgText, fontSize: 14 }}>{m.poll ? "📊 " : ""}{m.text}</div>}
        <Stamp m={m} />
      </div>)}
    </div>
    <div style={{ marginTop: 10 }}><Composer me={me} onSend={(t, a, img) => onReply(t, a, img)} uploadImage={uploadImage} placeholder="Reply in this thread…" /></div>
  </Modal>;
}

export { senderLabel, previewOf, WINDOW, GeneralChat, MsgMenu, PollCard, PollModal, Reactions, ReplyPreview, ThreadModal };
