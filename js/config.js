// ============================================================================
// config.js — Server-mode endpoints (Plan 2 Phase E).
//
// These point at the Raspberry Pi authoritative server, exposed publicly via
// Tailscale Funnel -> Caddy -> avalon-server (Plan 1). The client health-checks
// SERVER_HEALTH on boot; if it answers, server mode is offered, otherwise the
// app stays PURE PEER-TO-PEER (PeerJS) exactly as before.
//
// To DISABLE server mode entirely, set SERVER_URL = '' (the health check is
// skipped and only the P2P "Host" path is shown).
//
// NOTE on the trailing slash: Caddy routes `/avalon/*` (handle_path strips the
// prefix), so the WS URL MUST keep the trailing slash — `/avalon` with no slash
// would fall through to Caddy's health catch-all instead of the game server.
// ============================================================================

export const SERVER_URL    = 'wss://pi.tail360216.ts.net/avalon/';
export const SERVER_HEALTH = 'https://pi.tail360216.ts.net/avalon/health';
