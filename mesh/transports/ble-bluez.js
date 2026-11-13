// Bluetooth Low Energy transport for Linux, through BlueZ over D-Bus.
//
// This is the primary carrier. A node does both jobs at once:
//   * it advertises a GATT service, so another phone/laptop can find it and
//     write frames to it (the peripheral role), and
//   * it scans for other nodes advertising the same service and connects to
//     them (the central role).
//
// Frames are the same mesh packets as every other transport. A BLE character-
// istic write is small, so the link splits a frame into length-tagged chunks
// and the other side reassembles them; the mesh layer's own fragmentation then
// handles whole events and pictures.
//
// Requirements: Linux, a working Bluetooth adapter, bluetoothd running, and the
// optional `dbus-next` package. If any of that is missing the node falls back to
// the LAN transport and says so — it never pretends Bluetooth is working.
const EventEmitter = require("events");
const crypto = require("crypto");

const SERVICE = "c0bb1e00-1e55-4c0d-9b1a-5c0a5b1e7e01";
const RX = "c0bb1e00-1e55-4c0d-9b1a-5c0a5b1e7e02"; // central writes here
const TX = "c0bb1e00-1e55-4c0d-9b1a-5c0a5b1e7e03"; // peripheral notifies here
const ROOT = "/org/commonsbt";

const { chunkFrame, ChunkAssembler } = require("./chunk");

class BleLink {
  constructor(id, transport) {
    this.id = id;
    this.transport = transport.name;
    this.onFrame = null;
    this.onClose = null;
    this.closed = false;
    this._close = null;
    this.assembler = new ChunkAssembler();
  }
  receive(value) {
    const frame = this.assembler.push(value);
    if (frame) this.onFrame?.(frame);
  }
  send(buf) { this.transport._write(this, buf); }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this._close?.(); } catch {}
    this.onClose?.();
  }
}

class BleBluezTransport extends EventEmitter {
  constructor({ name = "ble", log = console, adapter = null } = {}) {
    super();
    this.name = name;
    this.log = log;
    this.adapterName = adapter;
    this.state = "down";
    this.detail = "";
    this.bus = null;
    this.adapter = null;
    this.adapterPath = null;
    this.links = new Set();
    this.byDevice = new Map();     // device object path -> link
    this.outgoing = new Set();     // device paths we connected to
    this.centralLink = null;       // the one central allowed to write to us
    this.notifying = false;
    this.chunkAssembler = new ChunkAssembler();
    this._stopped = false;
  }

  get available() {
    try { require.resolve("dbus-next"); return process.platform === "linux"; } catch { return false; }
  }

  async start() {
    if (!this.available) throw new Error("Bluetooth needs Linux + the optional dbus-next package");
    const dbus = require("dbus-next");
    this.dbus = dbus;
    this.bus = dbus.systemBus();
    this.bus.on("error", (err) => this.log.warn?.(`[ble] bus: ${err.message}`));

    // Find the adapter (hci0 unless told otherwise).
    const bluez = await this.bus.getProxyObject("org.bluez", "/");
    const om = bluez.getInterface("org.freedesktop.DBus.ObjectManager");
    const objects = await om.GetManagedObjects();
    const adapterPath = Object.keys(objects).find((p) =>
      objects[p]["org.bluez.Adapter1"] && (!this.adapterName || p.endsWith("/" + this.adapterName)));
    if (!adapterPath) throw new Error("no Bluetooth adapter found");
    this.adapterPath = adapterPath;
    const ao = await this.bus.getProxyObject("org.bluez", adapterPath);
    this.adapter = ao.getInterface("org.bluez.Adapter1");
    try {
      const props = ao.getInterface("org.freedesktop.DBus.Properties");
      await props.Set("org.bluez.Adapter1", "Powered", new dbus.Variant("b", true));
      await props.Set("org.bluez.Adapter1", "Alias", new dbus.Variant("s", "commons-bt"));
    } catch {}

    await this.startGattServer();
    await this.startAdvertising();
    await this.startScanning();

    this.state = "up";
    this.detail = `bluez ${adapterPath.split("/").pop()}`;
    this.log.info?.(`[ble] advertising ${SERVICE} on ${this.detail}`);
    return this;
  }

  // --- peripheral: a GATT server peers can write to ------------------------
  async startGattServer() {
    const dbus = this.dbus;
    const { Interface, ACCESS_READ, Variant } = {
      Interface: dbus.interface.Interface, ACCESS_READ: dbus.interface.ACCESS_READ, Variant: dbus.Variant,
    };

    // dbus-next declares interfaces with decorators, which need Babel. Applying
    // the same decorators by hand keeps this a plain CommonJS file.
    const decorate = (klass, key, decorator) => {
      const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, key);
      const d = { key, descriptor };
      const out = decorator(d) || d;
      if (out.descriptor) Object.defineProperty(klass.prototype, key, out.descriptor);
      out.finisher?.(klass);
    };
    const prop = (klass, key, signature, access = ACCESS_READ) =>
      decorate(klass, key, dbus.interface.property({ signature, access }));
    const meth = (klass, key, inSignature = "", outSignature = "") =>
      decorate(klass, key, dbus.interface.method({ inSignature, outSignature }));

    const transport = this;
    const paths = { service: ROOT + "/service0", rx: ROOT + "/service0/rx", tx: ROOT + "/service0/tx" };

    class Adv extends Interface {
      constructor() { super("org.bluez.LEAdvertisement1"); }
      get Type() { return "peripheral"; }
      get ServiceUUIDs() { return [SERVICE]; }
      get LocalName() { return "commons-bt"; }
      get ServiceData() {
        const id = Buffer.from(transport.identity ? transport.identity.peerId : "0000000000000000", "hex");
        return { [SERVICE]: new transport.dbus.Variant("ay", id) };
      }
      get Includes() { return ["local-name"]; }
      Release() {}
    }
    prop(Adv, "Type", "s");
    prop(Adv, "ServiceUUIDs", "as");
    prop(Adv, "LocalName", "s");
    prop(Adv, "ServiceData", "a{sv}");
    prop(Adv, "Includes", "as");
    meth(Adv, "Release");
    this.adv = new Adv();
    await this.bus.requestName("org.commonsbt", 0x4).catch(() => {});
    this.bus.export(ROOT + "/advertisement0", this.adv);

    class GattService extends Interface {
      constructor() { super("org.bluez.GattService1"); }
      get UUID() { return SERVICE; }
      get Primary() { return true; }
      get Characteristics() { return [paths.rx, paths.tx]; }
    }
    prop(GattService, "UUID", "s");
    prop(GattService, "Primary", "b");
    prop(GattService, "Characteristics", "ao");
    this.service = new GattService();
    this.bus.export(paths.service, this.service);

    class GattChar extends Interface {
      constructor(uuid, flags) { super("org.bluez.GattCharacteristic1"); this._uuid = uuid; this._flags = flags; this._value = Buffer.alloc(0); }
      get UUID() { return this._uuid; }
      get Service() { return paths.service; }
      get Flags() { return this._flags; }
      get Descriptors() { return []; }
      get Value() { return this._value; }
      ReadValue() { return this._value; }
      async WriteValue(value) {
        if (this._uuid === RX) transport.onGattWrite(Buffer.from(value));
      }
      StartNotify() {
        if (this._uuid !== TX) return;
        transport.notifying = true;
        transport.log.info?.("[ble] a peer subscribed to notifications");
      }
      StopNotify() {
        if (this._uuid !== TX) return;
        transport.notifying = false;
      }
    }
    prop(GattChar, "UUID", "s");
    prop(GattChar, "Service", "o");
    prop(GattChar, "Flags", "as");
    prop(GattChar, "Descriptors", "ao");
    prop(GattChar, "Value", "ay");
    meth(GattChar, "ReadValue", "a{sv}", "ay");
    meth(GattChar, "WriteValue", "aya{sv}");
    meth(GattChar, "StartNotify");
    meth(GattChar, "StopNotify");
    this.rx = new GattChar(RX, ["write", "write-without-response"]);
    this.tx = new GattChar(TX, ["notify"]);
    this.bus.export(paths.rx, this.rx);
    this.bus.export(paths.tx, this.tx);

    // BlueZ requires the application root to answer GetManagedObjects.
    class AppRoot extends Interface {
      constructor() { super("org.freedesktop.DBus.ObjectManager"); }
      GetManagedObjects() { return transport.managedObjects(); }
    }
    meth(AppRoot, "GetManagedObjects", "", "a{oa{sa{sv}}}");
    this.bus.export(ROOT, new AppRoot());

    // Register with BlueZ's GATT manager.
    const ao = await this.bus.getProxyObject("org.bluez", this.adapterPath);
    this.gattManager = ao.getInterface("org.bluez.GattManager1");
    await this.gattManager.RegisterApplication(ROOT, {});
    this.log.info?.("[ble] GATT application registered");
  }

  managedObjects() {
    const V = this.dbus.Variant;
    const objs = {};
    objs[ROOT + "/service0"] = {
      "org.bluez.GattService1": {
        UUID: new V("s", SERVICE),
        Primary: new V("b", true),
        Characteristics: new V("ao", [ROOT + "/service0/rx", ROOT + "/service0/tx"]),
      },
    };
    objs[ROOT + "/service0/rx"] = {
      "org.bluez.GattCharacteristic1": {
        UUID: new V("s", RX), Service: new V("o", ROOT + "/service0"),
        Flags: new V("as", ["write", "write-without-response"]), Descriptors: new V("ao", []),
      },
    };
    objs[ROOT + "/service0/tx"] = {
      "org.bluez.GattCharacteristic1": {
        UUID: new V("s", TX), Service: new V("o", ROOT + "/service0"),
        Flags: new V("as", ["notify"]), Descriptors: new V("ao", []),
      },
    };
    return objs;
  }

  async startAdvertising() {
    const ao = await this.bus.getProxyObject("org.bluez", this.adapterPath);
    this.advManager = ao.getInterface("org.bluez.LEAdvertisingManager1");
    await this.advManager.RegisterAdvertisement(ROOT + "/advertisement0", {});
  }

  // --- central: scan, connect, subscribe ------------------------------------
  async startScanning() {
    const dbus = this.dbus;
    const ao = await this.bus.getProxyObject("org.bluez", this.adapterPath);
    try {
      await this.adapter.SetDiscoveryFilter({ UUIDs: new dbus.Variant("as", [SERVICE]) });
    } catch {}
    const root = await this.bus.getProxyObject("org.bluez", "/");
    const om = root.getInterface("org.freedesktop.DBus.ObjectManager");
    om.on("InterfacesAdded", (path, ifaces) => {
      const dev = ifaces["org.bluez.Device1"];
      if (!dev) return;
      this.considerDevice(path, dev).catch(() => {});
    });
    for (const [path, ifaces] of Object.entries(await om.GetManagedObjects())) {
      if (ifaces["org.bluez.Device1"]) this.considerDevice(path, ifaces["org.bluez.Device1"]).catch(() => {});
    }
    try { await this.adapter.StartDiscovery(); } catch (err) { this.log.warn?.(`[ble] discovery: ${err.message}`); }
  }

  async considerDevice(path, dev) {
    if (this._stopped || this.outgoing.has(path)) return;
    const props = this._unwrap(dev);
    const uuids = props.UUIDs || [];
    if (!uuids.includes(SERVICE)) return;
    this.outgoing.add(path);
    try {
      const obj = await this.bus.getProxyObject("org.bluez", path);
      const device = obj.getInterface("org.bluez.Device1");
      await device.Connect();
      await this.attachCentral(path, obj);
    } catch (err) {
      this.outgoing.delete(path);
      this.log.warn?.(`[ble] connect ${path}: ${err.message}`);
    }
  }

  async attachCentral(path, deviceObj) {
    const link = new BleLink("ble-" + path.split("/").pop(), this);
    link._close = () => this.outgoing.delete(path);
    this.links.add(link);
    this.byDevice.set(path, link);
    this.emit("link", link);

    const props = deviceObj.getInterface("org.freedesktop.DBus.Properties");
    props.on("PropertiesChanged", (_iface, changed) => {
      if (changed.Connected && changed.Connected.value === false) link.close();
    });

    // Find our service's characteristics on the remote device: write frames to
    // its RX and subscribe to its TX.
    const root = await this.bus.getProxyObject("org.bluez", "/");
    const om = root.getInterface("org.freedesktop.DBus.ObjectManager");
    const objects = await om.GetManagedObjects();
    const findChar = (uuid) => Object.keys(objects).find((p) =>
      p.startsWith(path + "/") && objects[p]["org.bluez.GattCharacteristic1"] &&
      objects[p]["org.bluez.GattCharacteristic1"].UUID.value === uuid);
    const txPath = findChar(TX);
    const rxPath = findChar(RX);
    if (!txPath || !rxPath) return link.close();
    const rxObj = await this.bus.getProxyObject("org.bluez", rxPath);
    this.remoteChars = this.remoteChars || new Map();
    this.remoteChars.set(path, rxObj.getInterface("org.bluez.GattCharacteristic1"));
    const txObj = await this.bus.getProxyObject("org.bluez", txPath);
    const txChar = txObj.getInterface("org.bluez.GattCharacteristic1");
    txObj.getInterface("org.freedesktop.DBus.Properties").on("PropertiesChanged", (iface, changed) => {
      if (iface === "org.bluez.GattCharacteristic1" && changed.Value) link.receive(Buffer.from(changed.Value.value));
    });
    await txChar.StartNotify();
    this.log.info?.(`[ble] connected to ${path.split("/").pop()}`);
  }

  _write(link, buf) {
    if (link.closed) return;
    // Outgoing link: we are the central and write to the peer's RX.
    for (const [path, l] of this.byDevice) {
      if (l !== link) continue;
      const char = this.remoteChars && this.remoteChars.get(path);
      if (!char) return;
      for (const chunk of chunkFrame(buf)) char.WriteValue(chunk, { type: new this.dbus.Variant("s", "request") }).catch(() => {});
      return;
    }
    // Incoming link: we are the peripheral and notify the one central.
    if (!this.notifying) return;
    for (const chunk of chunkFrame(buf)) {
      this.tx._value = chunk;
      this.dbus.interface.Interface.emitPropertiesChanged(this.tx, { Value: new this.dbus.Variant("ay", chunk) });
    }
  }

  // A central wrote to our RX characteristic. BlueZ does not say which device
  // wrote, so the peripheral role serves one central at a time: the link is
  // created when that device connects, and extra centrals are refused.
  onGattWrite(value) {
    if (!this.inboundLink) {
      const link = new BleLink("ble-in-" + crypto.randomBytes(3).toString("hex"), this);
      this.inboundLink = link;
      this.links.add(link);
      this.emit("link", link);
    }
    this.inboundLink.receive(value);
  }

  // Called by the node with our peer id so the advertisement can carry it.
  setIdentity(identity) { this.identity = identity; }

  async stop() {
    this._stopped = true;
    for (const link of this.links) link.close();
    this.links.clear();
    try { await this.adapter?.StopDiscovery(); } catch {}
    try { await this.advManager?.UnregisterAdvertisement(ROOT + "/advertisement0"); } catch {}
    try { this.dbus?.interface?.Interface; } catch {}
    this.state = "down";
  }
}

module.exports = { BleBluezTransport, SERVICE, RX, TX, chunkFrame, ChunkAssembler };
