// ============================================================================
// index.js — HTTP + WebSocket bootstrap for the Avalon authoritative server.
//
// Endpoints (prefix-agnostic: the Pi's Caddy strips the /avalon path before
// forwarding, so this server sees /health, /rooms and the WS upgrade at /):
//   GET /health  -> { ok, version, rooms }   liveness probe (CORS *)
//   GET /rooms   -> [ { code, hostName, playerCount, phase, joinable } ]  (CORS *)
//   WS  /        -> game traffic (see session.js for the wire protocol)
//
// Hardening:
//   - Origin allowlist on the WS upgrade (ALLOWED_ORIGINS). Browsers always send
//     Origin; header-less connections are allowed only OUTSIDE production so the
//     local test harness works (NODE_ENV=production rejects them). NOTE: a
//     non-browser client can forge Origin, so this is CSRF defence, not authn —
//     the limits below are what actually bound abuse.
//   - WS frame size cap (maxPayload) — game messages are tiny; reject giant frames.
//   - Global connection cap (MAX_CONNS) — the load-bearing DoS guard. Per-IP cap
//     is best-effort only: behind Tailscale Funnel the real client IP isn't
//     exposed and X-Forwarded-For is client-spoofable, so it can't be trusted.
//   - Per-connection message rate limit (token bucket) — floods are dropped, not
//     amplified into a broadcast to every socket in the room.
//   - Room cap (MAX_ROOMS) + one-room-per-connection enforced in session.js.
//
// Install this module's storage shim FIRST so ../js/stats.js works under Node.
// ============================================================================

import './storage.js';

import http from 'node:http';
import { WebSocketServer } from 'ws';

import { RoomManager } from './rooms.js';
import { handleMessage, handleClose } from './session.js';

const PORT = Number(process.env.PORT) || 9000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 30;
const IS_PROD = process.env.NODE_ENV === 'production';
const VERSION = process.env.APP_VERSION || 'dev';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://iamyvj.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD_BYTES) || 64 * 1024; // 64 KiB/frame
const MAX_CONNS = Number(process.env.MAX_CONNS) || 200;                 // global backstop
const MSG_RATE = Number(process.env.MSG_RATE_PER_SEC) || 20;            // sustained msgs/sec/conn
const MSG_BURST = Number(process.env.MSG_BURST) || 40;                  // bucket size

const manager = new RoomManager({ maxRooms: MAX_ROOMS });
const ctx = { manager, maxRooms: MAX_ROOMS };

function originAllowed(origin) {
  // Browsers always send Origin. A header-less upgrade (raw ws client, test
  // harness) is permitted only outside production.
  if (!origin) return !IS_PROD;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && !IS_PROD) return true;
  } catch (_) { /* malformed Origin */ }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP server (health + public lobby list)
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Permissive CORS — both endpoints expose only non-sensitive public info and
  // the static client is served from a different origin (GitHub Pages).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION, rooms: manager.size }));
    return;
  }
  if (url.pathname === '/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manager.publicList()));
    return;
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
const ipCounts = new Map();
let totalConns = 0;

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  // Global cap first — this is the real backstop (per-IP is unreliable behind Funnel).
  if (totalConns >= MAX_CONNS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
  }
  const ip = ipOf(req);
  const n = ipCounts.get(ip) || 0;
  if (n >= MAX_CONNS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    totalConns += 1;
    ipCounts.set(ip, n + 1);
    ws._ip = ip;
    ws._tokens = MSG_BURST;        // per-connection message rate-limit bucket
    ws._lastRefill = Date.now();
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // Per-connection token-bucket rate limit — drop floods rather than amplify
    // them into a broadcast to every socket in the room.
    const now = Date.now();
    ws._tokens = Math.min(MSG_BURST, ws._tokens + ((now - ws._lastRefill) / 1000) * MSG_RATE);
    ws._lastRefill = now;
    if (ws._tokens < 1) return;                  // too fast — drop silently
    ws._tokens -= 1;
    // Never crash the process on a single malformed/hostile message.
    try { handleMessage(ctx, ws, data.toString()); } catch (_) { /* swallow */ }
  });
  ws.on('close', () => {
    totalConns = Math.max(0, totalConns - 1);
    const ip = ws._ip;
    if (ip) {
      const c = (ipCounts.get(ip) || 1) - 1;
      if (c <= 0) ipCounts.delete(ip); else ipCounts.set(ip, c);
    }
    try { handleClose(ctx, ws); } catch (_) { /* swallow */ }
  });
  ws.on('error', () => { /* close handler does the cleanup */ });
});

server.listen(PORT, () => {
  console.log(`[avalon-server] listening on :${PORT} prod=${IS_PROD} origins=${ALLOWED_ORIGINS.join('|')}`);
});

// Periodic idle-room sweep (unref so it never keeps the process alive).
setInterval(() => manager.sweep(), 60 * 1000).unref();
