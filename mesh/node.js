// One node = one device's identity + its copy of the event log + its radio.
const fs = require("fs");
const path = require("path");
const Identity = require("./identity");
const { Store } = require("./store");
const Mesh = require("./mesh");
const { createApi } = require("./api");

class Node {
  constructor({ dir, name = "commons-bt", log = console }) {
    this.dir = dir;
    this.name = name;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this.freshIdentity = !fs.existsSync(path.join(dir, "identity.json"));
    this._identity = Identity.load(dir);
    this.store = new Store(dir);
    this.mesh = new Mesh({ identity: this._identity, store: this.store, log, deviceName: name });
    this.api = createApi(this);
    this.mesh.start();
  }

  get identity() { return this._identity; }

  setIdentity(next) {
    this._identity = next;
    next.save(this.dir);
    // The mesh signs and handshakes as this key, so every existing link has to
    // start over — a peer must not keep talking to the old identity.
    this.mesh.identity = next;
    this.mesh.clock.key = next.key;
    for (const link of [...this.mesh.links]) this.mesh.drop(link, "identity changed");
    this.mesh.emit("peers", []);
  }

  attach(transport) {
    if (transport.setIdentity) transport.setIdentity(this.identity);
    return this.mesh.attach(transport);
  }

  async close() {
    this.store.flush();
    await this.mesh.close();
  }
}

module.exports = { Node };
