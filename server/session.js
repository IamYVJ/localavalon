// ============================================================================
// session.js — Per-connection message dispatch.
//
// Maps incoming wire messages to engine calls, mirroring main.js handleIntent()
// for player intents and ADDING owner-control intents that the P2P design never
// needed (in P2P the host called the engine directly; here the owner client must
// send those over the wire).
//
// Connection identity is stashed on the ws object:
//   ws._id        playerId assigned by the server (engine seat key)
//   ws._clientId  stable per-device id sent by the client (reconnect/owner match)
//   ws._code      room code this socket is attached to
//   ws._spectator true for watch-only connections (never a seat / private slice)
//
// ---------------------------------------------------------------------------
// WIRE PROTOCOL (server mode)
// ---------------------------------------------------------------------------
// client -> server:
//   createRoom { name, clientId, asSpectator? }      owner creates a room
//   join       { code, name, clientId }              seat / reclaim a seat
//   spectate   { code, name?, clientId? }            watch only
//   lobbyQuery { code }                              fetch lobby info
//   lobbyConfig{ toggles, allowReveal, randomLeaderOrder,
//                questTimerEnabled, questTimerSeconds, showPendingVoters }  (owner, lobby)
//   startGame  {}                                    (owner)
//   playAgain  {}                                    (owner)
//   endGame    {}                                    (owner)
//   ready / propose{members} / vote{approve} / card{success} /
//   assassinate{targetId} / requestStats             player intents
//
// server -> client:
//   welcome   { playerId, code, owner?, spectator? }
//   state     { pub, priv }
//   lobbyInfo { info|null }
//   statsData { data }
//   rejected  { message }   (fatal for this attempt — bad code/name/full)
//   error     { message }   (non-fatal — illegal move)
// ============================================================================

import { randomUUID } from 'node:crypto';

import { getLeaderboard } from '../js/stats.js';
import {
  rebuildConfig, broadcastState, scheduleAdvances, sync, clearRoomTimers, send,
} from './rooms.js';

function safeParse(raw) {
  try { const m = JSON.parse(raw); return (m && typeof m === 'object') ? m : null; }
  catch (_) { return null; }
}

// Normalise codes the same way the client does (digits only, length 4).
function normCode(c) {
  return (c == null ? '' : String(c)).replace(/\D/g, '').slice(0, 4);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function handleMessage(ctx, ws, raw) {
  const msg = safeParse(raw);
  if (!msg || typeof msg.type !== 'string') return;

  // Pre-room messages (no room attached yet).
  switch (msg.type) {
    case 'createRoom': return onCreateRoom(ctx, ws, msg);
    case 'join':       return onJoin(ctx, ws, msg);
    case 'spectate':   return onSpectate(ctx, ws, msg);
    case 'lobbyQuery': return onLobbyQuery(ctx, ws, msg);
    default: break;
  }

  // Everything else requires an attached room.
  const room = ws._code ? ctx.manager.get(ws._code) : null;
  if (!room) { send(ws, { type: 'error', message: 'Not in a room.' }); return; }
  room.lastActive = Date.now();

  const e = room.engine;
  const isOwner = !!(ws._clientId && ws._clientId === room.ownerClientId)
               || (room.ownerId != null && ws._id === room.ownerId);

  switch (msg.type) {
    // ---- owner controls -------------------------------------------------
    case 'lobbyConfig':
      if (isOwner && e.phase === 'lobby') { applyLobbyConfig(room, msg); rebuildConfig(room); sync(room); }
      break;
    case 'startGame':
      if (isOwner) {
        const r = e.startGame();
        if (!r.ok) send(ws, { type: 'error', message: r.error });
        else sync(room);
      }
      break;
    case 'playAgain':
      if (isOwner) { e.playAgain(); rebuildConfig(room); sync(room); }
      break;
    case 'endGame':
      if (isOwner) { clearRoomTimers(room); e.endGame(); rebuildConfig(room); sync(room); }
      break;

    // ---- player intents (identical semantics to main.js handleIntent) ----
    case 'ready':
      e.setReady(ws._id); sync(room); break;
    case 'propose': {
      const r = e.proposeTeam(ws._id, Array.isArray(msg.members) ? msg.members : []);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'vote':
      e.castVote(ws._id, !!msg.approve); sync(room); break;
    case 'card': {
      const r = e.playQuestCard(ws._id, !!msg.success);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'assassinate':
      e.assassinate(ws._id, msg.targetId); sync(room); break;
    case 'requestStats':
      send(ws, { type: 'statsData', data: getLeaderboard(room.code) }); break;

    default: break;
  }
}

// ---------------------------------------------------------------------------
// Owner lobby config
// ---------------------------------------------------------------------------
function applyLobbyConfig(room, msg) {
  const e = room.engine;
  if (msg.toggles && typeof msg.toggles === 'object') {
    for (const k of Object.keys(room.toggles)) {
      if (k in msg.toggles) room.toggles[k] = !!msg.toggles[k];
    }
  }
  if ('allowReveal' in msg) e.setAllowReveal(!!msg.allowReveal);
  if ('randomLeaderOrder' in msg) e.setRandomLeaderOrder(!!msg.randomLeaderOrder);
  if ('showPendingVoters' in msg) e.setShowPendingVoters(!!msg.showPendingVoters);
  if ('questTimerEnabled' in msg || 'questTimerSeconds' in msg) {
    const enabled = ('questTimerEnabled' in msg) ? !!msg.questTimerEnabled : e.questTimerEnabled;
    const seconds = (typeof msg.questTimerSeconds === 'number') ? msg.questTimerSeconds : e.questTimerSeconds;
    e.setQuestTimer(enabled, seconds);
  }
}

// ---------------------------------------------------------------------------
// Room entry handlers
// ---------------------------------------------------------------------------
function onCreateRoom(ctx, ws, msg) {
  const name = (msg.name || '').trim();
  if (!name) { send(ws, { type: 'rejected', message: 'Enter a name first.' }); return; }
  if (ctx.manager.size >= ctx.maxRooms) {
    send(ws, { type: 'rejected', message: 'Server is at capacity — try again shortly.' });
    return;
  }

  const asSpectator = !!msg.asSpectator;
  const room = ctx.manager.create(name);
  const id = randomUUID();

  ws._id = id;
  ws._clientId = msg.clientId || null;
  ws._code = room.code;
  ws._spectator = asSpectator;

  room.ownerClientId = ws._clientId;
  room.ownerId = id;
  room.conns.set(id, ws);

  if (asSpectator) {
    // Spectating owner: owns the room but takes no seat (never dealt a role).
    room.engine.hostId = id;
  } else {
    room.engine.addPlayer(id, name, { isHost: true, clientId: ws._clientId });
  }
  rebuildConfig(room);

  send(ws, { type: 'welcome', playerId: id, code: room.code, owner: true, spectator: asSpectator });
  sync(room);
}

function onJoin(ctx, ws, msg) {
  const code = normCode(msg.code);
  const room = ctx.manager.get(code);
  if (!room) {
    send(ws, { type: 'rejected', message: 'No game found with that code. Check the code and that the host is still hosting.' });
    return;
  }

  const name = (msg.name || '').trim();
  const clientId = msg.clientId || null;
  const e = room.engine;

  // Identify the seat this join will reclaim (if any), so we can retire its old
  // socket after the engine remaps the id (mirrors the host's connection-map
  // race fix in net.js: adopt the new socket first, then close the stale one).
  const prior = clientId
    ? e.players.find(p => p.clientId === clientId)
    : e.players.find(p => p.name.toLowerCase() === name.toLowerCase() && !p.online);
  const oldId = prior ? prior.id : null;

  const id = randomUUID();
  const r = e.addPlayer(id, name, { isHost: false, clientId });
  if (!r.ok) { send(ws, { type: 'rejected', message: r.error }); return; }

  ws._id = r.player.id;   // engine reclaim sets player.id === id
  ws._clientId = clientId;
  ws._code = code;
  ws._spectator = false;
  room.conns.set(ws._id, ws);

  if (oldId && oldId !== ws._id) {
    const oldWs = room.conns.get(oldId);
    room.conns.delete(oldId);
    if (oldWs && oldWs !== ws) { try { oldWs.close(); } catch (_) {} }
  }

  // Restore ownership/host across an owner reconnect.
  const owner = !!(clientId && clientId === room.ownerClientId);
  if (owner) { room.ownerId = ws._id; e.hostId = ws._id; }

  if (e.phase === 'lobby') rebuildConfig(room);

  send(ws, { type: 'welcome', playerId: ws._id, code, owner });
  sync(room);
}

function onSpectate(ctx, ws, msg) {
  const code = normCode(msg.code);
  const room = ctx.manager.get(code);
  if (!room) { send(ws, { type: 'rejected', message: 'No game found with that code.' }); return; }

  const id = randomUUID();
  ws._id = id;
  ws._clientId = msg.clientId || null;
  ws._code = code;
  ws._spectator = true;
  room.conns.set(id, ws);

  const owner = !!(ws._clientId && ws._clientId === room.ownerClientId);
  if (owner) { room.ownerId = id; room.engine.hostId = id; }

  send(ws, { type: 'welcome', playerId: id, code, spectator: true, owner });
  send(ws, { type: 'state', pub: room.engine.publicState(), priv: null });
  // Refresh everyone else only if ownership/host changed (isHost flags).
  if (owner) sync(room);
}

function onLobbyQuery(ctx, ws, msg) {
  const room = ctx.manager.get(normCode(msg.code));
  if (!room) { send(ws, { type: 'lobbyInfo', info: null }); return; }
  const e = room.engine;
  send(ws, {
    type: 'lobbyInfo',
    info: {
      hostName: room.ownerName,
      playerCount: e.count,
      phase: e.phase,
      joinable: e.phase === 'lobby' && e.count < 10,
    },
  });
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------
export function handleClose(ctx, ws) {
  if (!ws._code || !ws._id) return;
  const room = ctx.manager.get(ws._code);
  if (!room) return;

  // Only treat this as a real disconnect if THIS socket is still the current one
  // for the seat — a stale handler from a replaced (reconnected) socket must not
  // evict the live one.
  if (room.conns.get(ws._id) !== ws) return;
  room.conns.delete(ws._id);

  if (!ws._spectator) {
    room.engine.markOffline(ws._id);
    if (room.engine.phase === 'lobby') rebuildConfig(room);
  }
  sync(room);
}
