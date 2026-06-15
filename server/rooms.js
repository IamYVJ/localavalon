// ============================================================================
// rooms.js — In-memory room manager + per-room authoritative loop.
//
// Each Room owns ONE GameEngine (the exact same engine the browser host runs,
// imported from ../js/). The server is authoritative: it validates intents
// through the engine, broadcasts tailored public+private state to every socket,
// and runs the reveal/countdown timers that the browser host used to run in
// main.js (scheduleAdvances).
//
// Rooms are in-memory: codes are reused once a room is GC'd, and stats reset on
// restart (see storage.js). No persistence by design for the MVP.
// ============================================================================

import { randomInt } from 'node:crypto';

import { GameEngine } from '../js/state.js';
import { ROLES, ROLE_COUNTS, OPTIONAL_TOGGLES } from '../js/rules.js';
import { recordGame } from '../js/stats.js';

// Matches the browser host's vote/quest reveal beat (main.js scheduleAdvances).
// Overridable via env so the headless test harness can fast-forward to 0.
const REVEAL_DELAY_MS = Number.isFinite(Number(process.env.REVEAL_DELAY_MS))
  ? Number(process.env.REVEAL_DELAY_MS)
  : 4500;
// A room with no open sockets is collected after this idle window.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 30 * 60 * 1000;

// Default lobby role toggles — mirror app.toggles in main.js so a freshly
// created server room offers the same suggested setup as a local game.
const DEFAULT_TOGGLES = {
  percival: true, lovers: false, morgana: true,
  mordred: false, oberon: false, lunatic: false, brute: false,
};

const WS_OPEN = 1; // ws readyState for an open socket

function send(ws, msg) {
  try { if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg)); } catch (_) { /* socket gone */ }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
export class Room {
  constructor(code, ownerName) {
    this.code = code;
    this.ownerName = ownerName;
    this.ownerClientId = null;   // stable device id of the owner (survives reconnect)
    this.ownerId = null;         // current playerId of the owner connection
    this.engine = new GameEngine();
    this.conns = new Map();      // playerId -> ws
    this.toggles = { ...DEFAULT_TOGGLES };
    this.timers = { vote: null, quest: null, proposal: null };
    this._recorded = false;      // ensures a finished game is recorded exactly once
    this.lastActive = Date.now();
  }

  hasOpenConns() {
    for (const ws of this.conns.values()) if (ws.readyState === WS_OPEN) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// RoomManager
// ---------------------------------------------------------------------------
export class RoomManager {
  constructor({ maxRooms = 50 } = {}) {
    this.rooms = new Map();      // CODE -> Room
    this.maxRooms = maxRooms;
  }

  get size() { return this.rooms.size; }

  get(code) {
    if (code == null) return null;
    return this.rooms.get(String(code).toUpperCase()) || null;
  }

  create(ownerName) {
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = new Room(code, ownerName);
    this.rooms.set(code, room);
    return room;
  }

  delete(code) {
    const room = this.get(code);
    if (room) { clearRoomTimers(room); this.rooms.delete(room.code); }
  }

  // Light public lobby list (mirrors the P2P discovery feature).
  publicList() {
    const out = [];
    for (const room of this.rooms.values()) {
      const e = room.engine;
      out.push({
        code: room.code,
        hostName: room.ownerName,
        playerCount: e.count,
        phase: e.phase,
        joinable: e.phase === 'lobby' && e.count < 10,
      });
    }
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }

  // GC rooms whose sockets have all gone and that have been idle past the TTL.
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (!room.hasOpenConns() && (now - room.lastActive) > ROOM_TTL_MS) {
        this.delete(room.code);
      }
    }
  }
}

// 4-digit numeric code, leading zeros allowed — matches js/util.js generateRoomCode.
function genCode() {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Authoritative loop helpers (operate on a Room)
// ---------------------------------------------------------------------------

// Rebuild the role config from the room's lobby toggles for the current player
// count. Loyal Servants / Minions fill the remaining seats. Mirrors the browser
// host's rebuildConfig() in main.js so server games deal identical setups.
export function rebuildConfig(room) {
  const e = room.engine;
  const count = e.count;
  const target = ROLE_COUNTS[count];
  const cfg = { merlin: 1, assassin: 1 };
  let good = 1, evil = 1;
  for (const def of OPTIONAL_TOGGLES) {
    if (!room.toggles[def.key]) continue;
    for (const rid of def.roleIds) {
      cfg[rid] = 1;
      if (ROLES[rid].team === 'good') good += 1; else evil += 1;
    }
  }
  if (target) {
    cfg.servant = Math.max(0, target.good - good);
    cfg.minion = Math.max(0, target.evil - evil);
  } else {
    cfg.servant = 0; cfg.minion = 0;
  }
  e.setConfig(cfg);
}

// Send every connection the public state plus ONLY its own private slice.
// Spectators (no seat) get priv: null — privateStateFor also returns null for an
// unseated id, but we gate on the flag for clarity and safety.
export function broadcastState(room) {
  const e = room.engine;
  const pub = e.publicState();
  for (const [playerId, ws] of room.conns) {
    if (ws.readyState !== WS_OPEN) continue;
    const priv = ws._spectator ? null : e.privateStateFor(playerId);
    send(ws, { type: 'state', pub, priv });
  }
}

export function clearRoomTimers(room) {
  for (const k of ['vote', 'quest', 'proposal']) {
    if (room.timers[k]) { clearTimeout(room.timers[k]); room.timers[k] = null; }
  }
}

// Auto-advance the vote/quest reveal beats and the proposal countdown, exactly
// as the browser host did in main.js scheduleAdvances(). Without this the game
// would stall on a vote/quest reveal.
export function scheduleAdvances(room) {
  const e = room.engine;
  const pub = e.publicState();

  if (pub.phase !== 'proposal' && room.timers.proposal) {
    clearTimeout(room.timers.proposal); room.timers.proposal = null;
  }
  if (pub.phase === 'proposal' && pub.proposalRemainingMs != null && !room.timers.proposal) {
    room.timers.proposal = setTimeout(() => {
      room.timers.proposal = null;
      e.proposalTimedOut();
      sync(room);
    }, pub.proposalRemainingMs);
  }
  if (pub.phase === 'vote' && pub.voteResolved && !room.timers.vote) {
    room.timers.vote = setTimeout(() => {
      room.timers.vote = null;
      e.acknowledgeVote();
      sync(room);
    }, REVEAL_DELAY_MS);
  }
  if (pub.phase === 'quest' && pub.questResolved && !room.timers.quest) {
    room.timers.quest = setTimeout(() => {
      room.timers.quest = null;
      e.acknowledgeQuest();
      sync(room);
    }, REVEAL_DELAY_MS);
  }
}

// The server analogue of the browser host's hostSync(): record stats once on
// game over, broadcast tailored state, then (re)arm the advance timers.
export function sync(room) {
  room.lastActive = Date.now();
  const e = room.engine;

  if (e.phase === 'gameover' && e.winner && !room._recorded) {
    room._recorded = true;
    recordGame(room.code, {
      winner: e.winner,
      players: e.players.map(p => ({
        name: p.name,
        roleId: p.roleId,
        team: ROLES[p.roleId] ? ROLES[p.roleId].team : null,
      })),
    });
  }
  // Allow the next game (after playAgain/endGame) to record again.
  if (e.phase !== 'gameover') room._recorded = false;

  broadcastState(room);
  scheduleAdvances(room);
}

export { send };
