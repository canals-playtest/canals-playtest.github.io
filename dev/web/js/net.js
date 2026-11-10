// Online play over WebRTC, with PeerJS (web/vendor/peerjs.min.js, MIT).
//
// One browser hosts: it holds the game and applies every move. The others
// join by a room code and send their moves to the host, which sends the new
// state back to everyone. Browsers find each other through a signalling
// server (PeerJS's free public one unless the page says otherwise), then talk
// directly, or through PeerJS's relay when their networks don't allow that.
//
// For a private signalling server (e.g. on a LAN with no internet), run
// `npx peer --port 9000` and open the page with ?peer=HOST:9000.

const PREFIX = "canals-table-";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L

let peerLib = null;
/** Load PeerJS once, on first use, so hot-seat play never fetches it. */
export function loadPeer() {
  if (peerLib) return peerLib;
  peerLib = new Promise((resolve, reject) => {
    if (globalThis.Peer) return resolve(globalThis.Peer);
    const s = document.createElement("script");
    s.src = new URL("../vendor/peerjs.min.js", import.meta.url).href;
    s.onload = () => (globalThis.Peer ? resolve(globalThis.Peer) : reject(new Error("PeerJS did not load")));
    s.onerror = () => { peerLib = null; reject(new Error("couldn't load the networking library")); };
    document.head.append(s);
  });
  return peerLib;
}

export function makeCode(n = 5) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => ALPHABET[x % ALPHABET.length]).join("");
}
export const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

/** Signalling server: PeerJS's public one, or ?peer=host[:port][/path] from the page's URL. */
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const opts = { debug: Number(q.get("peerdebug")) || 0 };
  const spec = q.get("peer");
  if (spec) {
    const m = spec.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (m) {
      const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(m[1]);
      Object.assign(opts, { host: m[1], port: Number(m[2]) || (local ? 9000 : 443), path: m[3] || "/",
        secure: q.has("peersecure") ? q.get("peersecure") !== "0" : !local });
    }
  }
  return opts;
}

/** Keep `?peer=` (and friends) on links we hand out, so guests use the same server. */
export function shareLink(code) {
  const q = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const k of ["peer", "peersecure"]) if (q.has(k)) keep.set(k, q.get(k));
  const qs = keep.toString();
  return `${location.origin}${location.pathname}${qs ? `?${qs}` : ""}#join=${code}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Heartbeat: WebRTC can take a long time to notice a closed tab or a dead
// network, so both ends ping, and treat silence as a lost connection.
const PING_MS = 4000, LOST_MS = 13000;

/**
 * Open a table under `code`. Handlers: onConnect(conn), onMessage(conn, msg),
 * onDisconnect(conn), onStatus(text). Resolves once the code is registered.
 * If the code is still held (say, by this same table before a reload), it
 * retries for a little while before giving up.
 */
export async function hostTable(code, handlers) {
  const Peer = await loadPeer();
  let peer = null, closed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      peer = await new Promise((resolve, reject) => {
        const p = new Peer(PREFIX + code, peerOptions());
        p.once("open", () => resolve(p));
        p.once("error", (err) => { p.destroy(); reject(err); });
      });
      break;
    } catch (err) {
      if (err.type === "unavailable-id" && attempt < 8) { handlers.onStatus?.("That table code is still held; retrying…"); await wait(2500); continue; }
      throw friendly(err);
    }
  }
  const conns = new Set(), heard = new Map();
  peer.on("connection", (conn) => {
    const gone = () => { heard.delete(conn); if (conns.delete(conn)) { conn.close(); handlers.onDisconnect?.(conn); } };
    conn.on("open", () => { conns.add(conn); heard.set(conn, Date.now()); handlers.onConnect?.(conn); });
    conn.on("data", (msg) => {
      heard.set(conn, Date.now());
      if (msg?.t === "pong") return;
      if (msg?.t === "leaving") return gone();
      handlers.onMessage?.(conn, msg);
    });
    conn.on("close", gone);
    conn.on("error", gone);
  });
  const beat = setInterval(() => {
    const now = Date.now();
    for (const c of [...conns]) {
      if (now - (heard.get(c) || 0) > LOST_MS) { heard.delete(c); conns.delete(c); c.close(); handlers.onDisconnect?.(c); }
      else if (c.open) c.send({ t: "ping" });
    }
  }, PING_MS);
  // Losing the signalling server doesn't drop open connections; reconnect so new players can still join.
  peer.on("disconnected", () => { if (!closed) { handlers.onStatus?.("Lost the signalling server; reconnecting…"); setTimeout(() => !closed && !peer.destroyed && peer.reconnect(), 2000); } });
  peer.on("open", () => handlers.onStatus?.(""));
  peer.on("error", (err) => { if (!["peer-unavailable"].includes(err.type)) handlers.onStatus?.(friendly(err).message); });
  return {
    code,
    send(conn, msg) { if (conn.open) conn.send(msg); },
    broadcast(fn) { for (const c of conns) if (c.open) { const m = fn(c); if (m) c.send(m); } },
    connections: () => [...conns],
    close() { closed = true; clearInterval(beat); for (const c of conns) c.close(); peer.destroy(); },
  };
}

/**
 * Join the table `code`. Handlers: onOpen(), onMessage(msg), onClose(), onStatus(text).
 * Reconnects on its own until close() is called.
 */
export async function joinTable(code, handlers) {
  const Peer = await loadPeer();
  let peer = null, conn = null, closed = false, timer = null, heard = 0;
  const status = (t) => handlers.onStatus?.(t);
  const retry = (why) => {
    if (closed || timer) return;
    status(why);
    timer = setTimeout(() => { timer = null; connect(); }, 3000);
  };
  function connect() {
    if (closed) return;
    if (!peer || peer.destroyed) {
      peer = new Peer(peerOptions());
      peer.on("open", () => dial());
      peer.on("disconnected", () => { if (!closed && !peer.destroyed) setTimeout(() => !closed && !peer.destroyed && peer.reconnect(), 2000); });
      peer.on("error", (err) => {
        if (err.type === "peer-unavailable") retry(`No table ${code} is open right now. Trying again…`);
        else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) { peer.destroy(); retry(friendly(err).message + " Trying again…"); }
        else status(friendly(err).message);
      });
    } else if (peer.disconnected) {
      peer.reconnect();
    } else dial();
  }
  function dial() {
    if (closed) return;
    conn?.close();
    conn = peer.connect(PREFIX + code, { reliable: true });
    const c = conn;
    c.on("open", () => { heard = Date.now(); status(""); handlers.onOpen?.(); });
    c.on("data", (msg) => {
      heard = Date.now();
      if (msg?.t === "ping") { c.send({ t: "pong" }); return; }
      handlers.onMessage?.(msg);
    });
    // Only the current connection counts: an old one closing doesn't drop the new.
    const lost = () => { if (!closed && c === conn) { conn = null; c.close(); handlers.onClose?.(); retry("Lost the connection to the host. Reconnecting…"); } };
    c.on("close", lost);
    c.on("error", lost);
    c._lost = lost;
  }
  // The host pings every few seconds; silence means it's gone.
  const watch = setInterval(() => { if (conn?.open && Date.now() - heard > LOST_MS) conn._lost?.(); }, PING_MS);
  // Closing the tab: tell the host at once rather than letting it wait.
  const bye = () => { try { if (conn?.open) conn.send({ t: "leaving" }); } catch { /* closing anyway */ } };
  addEventListener("pagehide", bye);
  connect();
  return {
    send(msg) { if (conn?.open) { conn.send(msg); return true; } return false; },
    get open() { return !!conn?.open; },
    close() { bye(); closed = true; clearTimeout(timer); clearInterval(watch); removeEventListener("pagehide", bye); setTimeout(() => { conn?.close(); peer?.destroy(); }, 100); },
  };
}

function friendly(err) {
  const why = {
    "browser-incompatible": "This browser can't make peer-to-peer connections.",
    "unavailable-id": "That table code is in use. Try another.",
    "network": "Couldn't reach the signalling server.",
    "server-error": "The signalling server had a problem.",
    "socket-error": "Lost the signalling server.",
    "socket-closed": "Lost the signalling server.",
    "ssl-unavailable": "The signalling server needs a secure connection.",
  }[err?.type];
  return new Error(why || String(err?.message || err));
}
