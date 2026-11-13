# Commons-Bluetooth

The Commons community chat, with the server taken out of the middle.

In Commons every community lives in one Node process and every member talks to
it over HTTP. Here each **device** runs a node, each node has its own key, and
members exchange signed events **directly over a Bluetooth LE mesh**. No
internet, no accounts, no central database. Two phones in the same room can hold
a conversation with both radios in airplane mode.

The interface is the Commons interface: General chat, Forum, replies, threads,
pins, reactions, polls, pictures, anonymity, usernames, invites, moderation, and
the 30-day expiry. The only thing redesigned is how parties communicate.

## What changed

| | Commons | Commons-Bluetooth |
| --- | --- | --- |
| Where state lives | one server's `data.json` | every member's device |
| Who decides the author | the server, from your session | your Ed25519 signature |
| How writes travel | HTTP POST to the server | events flooded over the mesh |
| How reads work | `GET /api/mget` from the server | the local log, filled by sync |
| Accounts | a server-issued login key | a key pair created on the device |
| Invites | a code the server recognises | a code carrying the group secret |
| Offline | nothing works | everything works; messages are stored and handed over |

## Quick start

```bash
npm install            # optional deps: dbus-next (Bluetooth), esbuild (rebuild the UI)
node server.js                       # Bluetooth if the machine has it, else LAN
node server.js --transport ble        # require Bluetooth LE (Linux + BlueZ)
node server.js --transport lan        # TCP carrier, same packets
node server.js --transport ble-mock   # a simulated radio, for development
```

Open <http://127.0.0.1:8080>, create an identity, create a community. The ◇
antenna button in the header shows what the radio is doing and who is in range.

Two devices:

```bash
# device A
node server.js --name ana --transport lan --lan-port 8788

# device B, same network
node server.js --name bo --transport lan --peer 192.168.1.20:8788
```

Then invite B with the QR code or link from the community's invite sheet.

### Options

```
--name <name>          what nearby peers call this device
--port <port>          port for the local app (default 8080)
--host <host>          interface for the local app (default 127.0.0.1)
--data <dir>           identity + event log (default ./data)
--transport <kind>     ble | lan | ble-mock | all
--peer <host:port>     connect to a LAN node (repeatable)
--lan-port <port>      port the LAN carrier listens on (default 8788)
--no-discovery         do not broadcast the LAN beacon
```

Bluetooth needs Linux, a working adapter, `bluetoothd`, and the optional
`dbus-next` package. If any of that is missing the node says so and falls back to
the LAN carrier. It never pretends Bluetooth is working.

## How a community works offline

1. **Identity.** On first run the node creates an Ed25519 key pair in
   `data/identity.json` (mode 0600). Your 16-character **account key** is derived
   from the public half and is what other members see. The 52-character
   **identity key** is the secret; copy it to sign in as the same person on
   another device. There is no recovery.

2. **Invite.** Creating a community mints a random 32-byte group secret. The
   invite code carries the group id, owner, name and that secret, so a newcomer
   needs nothing but the code — no server has to vouch for them. The QR code is
   just the code.

3. **Events.** Every action becomes an immutable event: a message, an edit, a
   deletion, a reaction, a vote, a pin, a name claim, a ban. Each is signed with
   the author's key and sealed with the group key. Events are ordered by a hybrid
   logical clock, so every device that has seen the same set shows the same
   community.

4. **Mesh.** Events are broadcast to every connected peer with a hop limit of 7,
   deduplicated by packet id. A peer that is **not** a member still forwards the
   sealed packet — it can carry a community across the people in the middle of it
   without reading a word.

5. **Catching up.** On every connection, peers compare a count-and-hash digest per
   community. If they differ, they exchange id lists and fetch exactly the events
   the other side is missing. That is the whole store-and-forward mechanism: a
   message you sent while someone was out of range is waiting for them the next
   time any member is in range.

6. **Moderation.** With no server, the rules are the reducer. Every member replays
   the same events in the same order and applies the same checks: only the author
   may edit, only admins may pin or delete someone else's message, only the owner
   may ban, usernames are first-claim with a 60-day rename cooldown, and one
   reaction and one poll vote per member. A ban event signed by the owner removes
   that member everywhere.

## Pictures

A picture is uploaded to the local node, referenced by id in a message, and
fetched from a peer over the mesh when someone first opens it. Files are stored
under `data/images/`; only real JPEG/PNG/WebP/GIF bytes are accepted (checked by
magic number, never by the claimed type). The cap is 4 MB.

## Privacy and threat model

- **Authorship is cryptographic.** Every event carries the author's public key and
  a signature over the event id, kind, timestamp, clock and body. A relay cannot
  alter, forge or replay an event without the id and signature disagreeing.
- **Each radio link is encrypted.** Peers do an X25519 handshake and encrypt every
  frame with AES-256-GCM; the handshake itself is signed with the identity key, so
  a relay cannot impersonate a peer.
- **Community traffic is sealed with the group key.** A non-member relay carries
  ciphertext only. Removing a member does **not** rotate that key, so a former
  member who kept their copy of the secret could still read traffic they receive.
  Treat the invite as the secret it is.
- **What a nearby radio can see.** The advertisement carries the peer id (8 bytes
  derived from your public key) and the service UUID. Your account key is visible
  to the peers you connect to. Message contents are not.
- **Retention is local.** Every node drops conversation events older than 30 days
  and applies the same rule to events arriving from others, so all nodes agree.
  Nothing is deleted from a device you no longer control.

## Limits (honest list)

- **The Bluetooth backend is only implemented for Linux/BlueZ.** It was written
  against the BlueZ D-Bus API and exercised through a simulated radio; it has not
  been run against real Bluetooth hardware in this repository. Test it on your
  device before relying on it. macOS and Windows use the LAN carrier.
- **The peripheral role serves one central at a time.** BlueZ does not tell a GATT
  server which device wrote to a characteristic, so a node accepts one inbound
  central and ignores extra ones.
- **A phone cannot run a node by itself.** The node is a Node.js process; the PWA
  is the interface to the node on that device. Running this on a phone would need
  a native shell.
- **One-time invites are best effort.** Offline, "used once" can only mean "every
  member I sync with saw it used".
- **Group keys do not rotate.** See above.
- **A relay keeps sealed packets for 10 minutes** (up to 200) so a peer that
  arrives just after a message still gets it.
- **No large-community tuning.** Digests and sync are full-id-list exchanges;
  fine for dozens of members and a few thousand events, not for thousands.

## Develop

The UI is plain React (from npm, bundled by esbuild) split by concern:

```
src/entry.jsx       bundle entry; mounts the app
src/app.src.jsx     the screens: sign-in, community list, community shell, sheets
src/chat.jsx        the General room: feed, bubbles, polls, reactions, threads
src/forum.jsx       the Forum tab, invites and member admin
src/media.jsx       pictures, read marks, mutes, emoji, the composer
src/core.jsx        node API, identity/session, anonymous names, QR, theme
public/app.js       generated by `npm run build`; never edit by hand
mesh/               the node: identity, crypto, protocol, event log, reducer, mesh
mesh/transports/    ble-bluez (primary), lan, loopback, ble-mock
tools/              tests
data/               identity, event log and pictures (gitignored)
```

```bash
npm run build     # regenerate public/app.js from src/*.jsx
npm test          # mesh + app suites
npm start
```

`CBT_DEBUG=1` prints link handshakes, frames and sync decisions.

## Tests

```
node tools/mesh-test.mjs     # crypto, wire format, convergence, relay, moderation
tools/app-test.mjs      # the local API and two nodes over the LAN carrier
node tools/run-all.mjs       # both
```

They exit non-zero on failure. See **HANDOFF.md** for the protocol, the data
model and the invariants to keep when changing anything.
