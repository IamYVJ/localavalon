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

  peer.on('open', () => handlers.onOpen && handlers.onOpen(code));

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      connections.set(conn.peer, conn);
      handlers.onConnect && handlers.onConnect(conn.peer, conn);
    });
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(conn.peer, msg);
    });
    const drop = () => {
      if (connections.has(conn.peer)) {
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
    destroy() { try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// CLIENT side
// ---------------------------------------------------------------------------
export function joinHost(code, handlers = {}) {
  const peer = newPeer(null);
  let conn = null;

  peer.on('open', () => {
    conn = peer.connect(peerIdForCode(code), { reliable: true });

    conn.on('open', () => handlers.onOpen && handlers.onOpen(conn));
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(msg);
    });
    conn.on('close', () => handlers.onClose && handlers.onClose());
    conn.on('error', (err) => handlers.onError && handlers.onError(err));
  });

  // A peer-level error firing before the connection opens almost always means
  // the room code is wrong or the broker is unreachable.
  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    destroy() { try { peer.destroy(); } catch (_) {} },
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
