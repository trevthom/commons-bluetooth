#!/usr/bin/env node
// Commons-Bluetooth — start a node and serve the app on this device.
//
// The HTTP server here is local plumbing: the browser loads the app from it and
// the app asks its own node for state. Nothing is served to the network by
// default and there is no shared backend — communities travel over Bluetooth.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Node } = require("./mesh/node");

const PUBLIC = path.join(__dirname, "public");

function parseArgs(argv) {
  const out = { peers: [], transport: null, port: 8080, host: "127.0.0.1", data: null, name: null, lanPort: 8788, discovery: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--port") out.port = Number(next()) || out.port;
    else if (a === "--host") out.host = next() || out.host;
    else if (a === "--data") out.data = next();
    else if (a === "--name") out.name = next();
    else if (a === "--transport") out.transport = next();
    else if (a === "--peer") out.peers.push(next());
    else if (a === "--lan-port") out.lanPort = Number(next()) || out.lanPort;
    else if (a === "--no-discovery") out.discovery = false;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const HELP = `
Commons-Bluetooth

  node server.js [options]

  --name <name>          what nearby peers call this device
  --port <port>          port for the local app (default 8080)
  --host <host>          interface for the local app (default 127.0.0.1)
  --data <dir>           where this node keeps its identity and event log
  --transport <kind>     ble | lan | ble-mock | all   (default: ble, else lan)
  --peer <host:port>     connect to a LAN node (repeatable)
  --lan-port <port>      port the LAN transport listens on (default 8788)
  --no-discovery         do not broadcast the LAN beacon

  Bluetooth needs Linux, a working adapter, bluetoothd, and dbus-next.
  Without them the node falls back to the LAN transport and says so.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);

  const dataDir = args.data || path.join(__dirname, "data");
  const name = args.name || "commons-bt";
  const node = new Node({ dir: dataDir, name });

  const log = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };

  // --- pick transports -------------------------------------------------------
  const transports = [];
  const wanted = args.transport || (process.platform === "linux" ? "ble" : "lan");
  const wantBle = wanted === "ble" || wanted === "all";
  const wantLan = wanted === "lan" || wanted === "all";
  const wantMock = wanted === "ble-mock" || wanted === "mock";
  if (!wantBle && !wantLan && !wantMock) {
    console.warn(`[commons-bt] unknown transport \"${wanted}\"; using the LAN transport.`);
  }

  if (wantBle) {
    const { BleBluezTransport } = require("./mesh/transports/ble-bluez");
    const ble = new BleBluezTransport({ log });
    if (!ble.available) {
      console.warn("[commons-bt] Bluetooth is not available here (Linux + dbus-next required); using the LAN transport instead.");
    } else {
      try {
        node.attach(ble);
        await ble.start();
        transports.push(ble);
        console.log(`[commons-bt] Bluetooth LE is up on ${ble.detail} (service ${require("./mesh/transports/ble-bluez").SERVICE})`);
      } catch (err) {
        console.warn(`[commons-bt] Bluetooth could not start: ${err.message}`);
        console.warn("[commons-bt] Is the adapter powered and bluetoothd running? Falling back to the LAN transport.");
      }
    }
  }

  if (wantMock) {
    const { MockAir, MockBleTransport } = require("./mesh/transports/ble-mock");
    const mock = new MockBleTransport({ air: new MockAir(), name: "ble-mock", log });
    node.attach(mock);
    await mock.start();
    transports.push(mock);
    console.log("[commons-bt] simulated Bluetooth radio up (development only — see the Nearby panel)");
  }

  if (wantLan) {
    const { LanTransport } = require("./mesh/transports/lan");
    const lan = new LanTransport({ port: args.lanPort, peers: args.peers, discovery: args.discovery, log });
    node.attach(lan);
    await lan.start();
    transports.push(lan);
    console.log(`[commons-bt] LAN transport listening on ${args.lanPort}${args.peers.length ? ` (peers: ${args.peers.join(", ")})` : ""}`);
  }

  // --- local app -------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); return res.end(); }
    try {
      const handled = await node.api(req, res, url);
      if (handled !== false) return;
    } catch (err) {
      console.error("[commons-bt] api error:", err);
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"internal"}'); }
      return;
    }
    serveStatic(req, res, url);
  });

  server.listen(args.port, args.host, () => {
    const id = node.identity;
    console.log("");
    console.log("  Commons-Bluetooth");
    console.log(`    App on this device:  http://${args.host === "0.0.0.0" ? "localhost" : args.host}:${args.port}`);
    console.log(`    Account key:         ${id.key.replace(/(.{4})/g, "$1 ").trim()}`);
    console.log(`    Peer id:             ${id.peerId}`);
    console.log(`    Data:                ${dataDir}`);
    console.log(`    Transport:           ${transports.map((t) => t.name).join(", ") || "none"}`);
    console.log("");
    if (transports.length === 0) console.log("  No transport started: this node is offline until one is available.\n");
  });

  const shutdown = async () => {
    console.log("\n[commons-bt] shutting down");
    node.store.flush();
    await node.mesh.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function serveStatic(req, res, url) {
  let file = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const full = path.join(PUBLIC, file);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, buf) => {
    if (err) {
      const ext = path.extname(full);
      if (ext && ext !== ".html") { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
      return fs.readFile(path.join(PUBLIC, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
        res.end(html);
      });
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
