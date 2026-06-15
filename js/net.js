// ============================================================================
// net.js — WebRTC peer-to-peer networking (PeerJS), star topology.
//
// Architecture: HOST-AUTHORITATIVE STAR.
//   - The host creates a Peer whose ID is derived from the room code, so a
//     joiner can reconstruct the host's Peer ID from the code alone — no
//     discovery service required.
//   - Every joiner opens a single DataConnection to the host. Joiners never
//     talk to each other. The host validates intents and broadcasts state.
//
// ----------------------------------------------------------------------------
// SIGNALING / OFFLINE NOTE (read this):
//   PeerJS needs a "broker" (signaling server) ONCE to perform the WebRTC
//   handshake. After the connection is established, game traffic is direct
//   peer-to-peer over the LAN. The default broker below is PeerJS's free
//   public cloud, which requires the internet to be reachable for that initial
//   handshake — even though the cached PWA shell loads offline.
//
//   FOR FULLY-OFFLINE LAN PLAY: run your own PeerServer on the LAN, e.g.
//       npx peer --port 9000 --key peerjs --path /myapp
//   then point BROKER_CONFIG at it:
//       export const BROKER_CONFIG = {
//         host: '192.168.1.50', port: 9000, path: '/myapp', key: 'peerjs',
//         secure: false,
//       };
//   Every device must use the SAME broker config to find each other.
// ============================================================================

// Set to null to use PeerJS's default public cloud broker. Replace with an
// object (see note above) to self-host signaling for offline LAN play.
export const BROKER_CONFIG = null;

// Peer IDs are namespaced so room codes don't collide with other PeerJS apps
// sharing the public broker.
export const PEER_PREFIX = 'localavalon-v1-';

export function peerIdForCode(code) {
  return PEER_PREFIX + code.toUpperCase();
}

export function codeFromPeerId(id) {
  return id.startsWith(PEER_PREFIX) ? id.slice(PEER_PREFIX.length) : null;
}

function newPeer(id) {
  // window.Peer comes from the PeerJS CDN <script> tag in index.html.
  const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

// ---------------------------------------------------------------------------
// HOST side
// ---------------------------------------------------------------------------
export function createHost(code, handlers = {}) {
  const peer = newPeer(peerIdForCode(code));
  const connections = new Map(); // connId -> DataConnection

  peer.on('open', () => {
    handlers.onNetStatus && handlers.onNetStatus('online');
    handlers.onOpen && handlers.onOpen(code);
  });

  // The broker socket dropped (very common when a phone locks or the tab is
  // backgrounded). PeerJS does NOT auto-reconnect, so we must — reusing the
  // SAME room-code id keeps existing joiners reachable and lets new ones in.
  peer.on('disconnected', () => {
    handlers.onNetStatus && handlers.onNetStatus('reconnecting');
    if (!peer.destroyed) { try { peer.reconnect(); } catch (_) {} }
  });

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      // A reconnecting peer keeps its id but opens a NEW DataConnection. Adopt
      // the new one FIRST (overwrite the map), then retire any prior connection
      // for the same id. The drop() guard below keys off the CURRENT map entry,
      // so the old connection's late close/error can no longer evict the fresh
      // one (which previously dropped a player the instant they rejoined).
      const prev = connections.get(conn.peer);
      connections.set(conn.peer, conn);
      if (prev && prev !== conn) { try { prev.close(); } catch (_) {} }
      handlers.onConnect && handlers.onConnect(conn.peer, conn);
    });
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(conn.peer, msg);
    });
    const drop = () => {
      // Only treat this as a real disconnect if THIS connection is still the
      // current one for the peer. A stale handler from a replaced connection
      // must not evict the live one (which would drop a just-rejoined player).
      if (connections.get(conn.peer) === conn) {
        connections.delete(conn.peer);
        handlers.onDisconnect && handlers.onDisconnect(conn.peer);
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    connections,
    sendTo(connId, msg) {
      const conn = connections.get(connId);
      if (conn && conn.open) trySend(conn, msg);
    },
    broadcast(msg) {
      for (const conn of connections.values()) {
        if (conn.open) trySend(conn, msg);
      }
    },
    // Re-establish the broker socket after a background/sleep, reusing the id.
    reconnect() {
      if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (_) {} }
    },
    destroy() { try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// CLIENT side
// ---------------------------------------------------------------------------
export function joinHost(code, handlers = {}) {
  const peer = newPeer(null);
  let conn = null;

  // (Re)open the single data connection to the host. Safe to call repeatedly —
  // a reconnecting client re-runs this, and the host reclaims its seat by name.
  const openConn = () => {
    conn = peer.connect(peerIdForCode(code), { reliable: true });

    conn.on('open', () => handlers.onOpen && handlers.onOpen(conn));
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(msg);
    });
    conn.on('close', () => handlers.onClose && handlers.onClose());
    conn.on('error', (err) => handlers.onError && handlers.onError(err));
  };

  peer.on('open', () => {
    handlers.onNetStatus && handlers.onNetStatus('online');
    openConn();
  });

  // Broker socket dropped (background/sleep). Reconnect with the same peer —
  // its 'open' will fire again and re-open the data connection automatically.
  peer.on('disconnected', () => {
    handlers.onNetStatus && handlers.onNetStatus('reconnecting');
    if (!peer.destroyed) { try { peer.reconnect(); } catch (_) {} }
  });

  // A peer-level error firing before the connection opens almost always means
  // the room code is wrong or the broker is unreachable.
  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    // Recover after a background/sleep: revive the broker socket if it dropped,
    // otherwise just re-open the data channel if the host went away and returned.
    reconnect() {
      if (peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (_) {} return; }
      if (!conn || !conn.open) openConn();
    },
    destroy() { try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// SERVER side — authoritative WebSocket server transport (Plan 2E).
//
// Mirrors joinHost()'s handle + handler shape so main.js can drive either
// transport through the same client code path. The server speaks the SAME JSON
// wire protocol the P2P host does (welcome/state/lobbyInfo/statsData/rejected/
// error), so the receive handler is shared. Reconnect just re-opens the socket;
// main.js re-sends the join/createRoom hello in onOpen.
// ---------------------------------------------------------------------------
export function serverTransport(url, handlers = {}) {
  let ws = null;
  let closedByUs = false;

  const open = () => {
    ws = new window.WebSocket(url);
    ws.addEventListener('open', () => {
      handlers.onNetStatus && handlers.onNetStatus('online');
      handlers.onOpen && handlers.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      const msg = safeParse(ev.data);
      if (msg) handlers.onData && handlers.onData(msg);
    });
    ws.addEventListener('close', () => { if (!closedByUs) handlers.onClose && handlers.onClose(); });
    ws.addEventListener('error', (e) => handlers.onError && handlers.onError(e));
  };
  open();

  return {
    send(msg) { if (ws && ws.readyState === window.WebSocket.OPEN) trySend(ws, msg); },
    isOpen() { return !!(ws && ws.readyState === window.WebSocket.OPEN); },
    // Revive a dropped socket; onOpen (in main.js) replays the join hello so the
    // server reclaims the seat/ownership by clientId.
    reconnect() {
      if (closedByUs) return;
      const st = ws ? ws.readyState : window.WebSocket.CLOSED;
      if (st === window.WebSocket.CLOSED || st === window.WebSocket.CLOSING) open();
    },
    destroy() { closedByUs = true; try { ws && ws.close(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// DISCOVERY side — find games on the broker without typing a code.
//
//   IMPORTANT: peer.listAllPeers() only returns data when the signaling broker
//   is configured with `allow_discovery: true`. PeerJS's PUBLIC cloud broker
//   has this DISABLED, so list() will report `null` (unsupported) there. Run a
//   self-hosted PeerServer on the LAN (see BROKER_CONFIG note) to enable it.
//
//   list(cb)        -> cb(codes|null)  codes = array of room codes, null = the
//                      broker doesn't support discovery (fall back to a code).
//   probe(code, cb) -> cb(info|null)   briefly connects to a host to fetch its
//                      lobby info { hostName, playerCount, phase, joinable }.
// ---------------------------------------------------------------------------
export function createDiscovery() {
  const peer = newPeer(null);
  let ready = false;
  let dead = false;
  const queue = [];

  peer.on('open', () => {
    ready = true;
    while (queue.length) queue.shift()();
  });
  peer.on('error', () => { /* swallow; surfaces as a list/probe timeout */ });

  const whenReady = (fn) => { if (dead) return; if (ready) fn(); else queue.push(fn); };

  return {
    peer,
    list(cb) {
      whenReady(() => {
        let done = false;
        const finish = (codes) => { if (!done) { done = true; cb(codes); } };
        // No callback within the window ⇒ broker has discovery disabled.
        const timer = setTimeout(() => finish(null), 3500);
        try {
          peer.listAllPeers((all) => {
            clearTimeout(timer);
            const codes = (all || []).map(codeFromPeerId).filter(Boolean);
            finish(codes);
          });
        } catch (_) {
          clearTimeout(timer);
          finish(null);
        }
      });
    },
    probe(code, cb) {
      whenReady(() => {
        let done = false;
        let conn = null;
        const finish = (info) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { if (conn) conn.close(); } catch (_) {}
          cb(info);
        };
        const timer = setTimeout(() => finish(null), 4000);
        try {
          conn = peer.connect(peerIdForCode(code), { reliable: true });
          conn.on('open', () => trySend(conn, { type: 'lobbyQuery' }));
          conn.on('data', (raw) => {
            const msg = safeParse(raw);
            if (msg && msg.type === 'lobbyInfo') finish(msg.info);
          });
          conn.on('error', () => finish(null));
          conn.on('close', () => finish(null));
        } catch (_) {
          finish(null);
        }
      });
    },
    destroy() { dead = true; try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// Wire helpers — JSON over the DataConnection. Guard against malformed input.
// ---------------------------------------------------------------------------
function trySend(conn, msg) {
  try { conn.send(JSON.stringify(msg)); } catch (_) { /* connection torn down */ }
}

function safeParse(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Human-readable mapping for the common PeerJS error types, surfaced in the UI.
// ---------------------------------------------------------------------------
// True for transient connection errors we can recover from by reconnecting,
// rather than fatal ones (bad code, incompatible browser, taken id).
export function isRecoverableError(err) {
  const t = err && err.type;
  return t === 'network' || t === 'server-error'
      || t === 'socket-error' || t === 'socket-closed' || t === 'disconnected';
}

export function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable':
      return 'No game found with that code. Check the code and that the host is still hosting.';
    case 'unavailable-id':
      return 'That room code is already in use. Try hosting again for a new code.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Couldn't reach the connection server — check your internet / Wi-Fi.";
    case 'browser-incompatible':
      return 'This browser does not support the WebRTC features required.';
    default:
      return 'Connection problem: ' + (err && err.message ? err.message : 'unknown error') + '.';
  }
}
