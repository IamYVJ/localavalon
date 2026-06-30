// ============================================================================
// main.js — App controller. Wires the network layer, the host's authoritative
// engine, user intents, and the view together.
//
//   HOST  : owns a GameEngine, applies every intent through it, then
//           broadcasts tailored public+private state to each connection.
//   CLIENT: holds the last public+private snapshot received from the host and
//           sends intents over the wire.
// ============================================================================

import { GameEngine } from './state.js';
import { createHost, joinHost, serverTransport, createDiscovery, describePeerError, isRecoverableError, peerIdForCode } from './net.js';
import { render } from './ui.js';
import { SERVER_URL, SERVER_HEALTH } from './config.js';
import { ROLE_COUNTS, ROLES, OPTIONAL_TOGGLES } from './rules.js';
import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
  loadClientId,
} from './util.js';
import { recordGame, getLeaderboard, clearStats } from './stats.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',                 // home | join | connecting | game | spectator | error | hostleft | stats
  mode: 'p2p',                    // 'p2p' (PeerJS) | 'server' (authoritative WS) — Plan 2E
  serverUp: false,                // set by the boot health check; gates "Host on server"
  me: { id: null, name: loadName(), isHost: false, isSpectator: false, owner: false },
  spectatorMode: false,           // Join screen: connect as a watch-only TV spectator
  code: loadCode(),
  pub: null,
  priv: null,
  error: '',
  copied: false,
  selectedTeam: [],               // leader's in-progress team pick
  // Optional-role toggles keyed by OPTIONAL_TOGGLES[].key (see rules.js).
  toggles: { percival: true, lovers: false, morgana: true, mordred: false, oberon: false, lunatic: false, brute: false },
  // Host game options.
  allowReveal: false,
  randomLeaderOrder: false,
  questTimerEnabled: false,       // per-proposal countdown on/off
  questTimerSeconds: 120,         // chosen duration in seconds (60-300)
  localProposalDeadline: null,    // Date.now()-based deadline used to render the countdown
  showPendingVoters: false,       // reveal who still owes a team vote
  _lastProposalKey: null,
  // Local-network game discovery (Join screen).
  discovered: [],            // [{ code, hostName, playerCount, phase, joinable }]
  discoveryState: 'idle',    // idle | searching | ok | unsupported
  // Statistics / leaderboard state.
  statsData: null,           // { summary, leaderboard } from getLeaderboard() — drives the 'stats' screen
  tvStats: null,             // { summary, leaderboard } shown INLINE on the spectator end screen (no screen switch)
  _tvStatsPending: false,    // true while the spectator end screen awaits its stats reply (dedupes the request)
  _gameRecorded: false,      // prevents double-recording the same game
  questNotice: null,         // transient nudge when a player taps a card they can't play
  confirmEndGame: false,     // host-only: "are you sure?" modal before ending the game
  confirmLeaveGame: false,   // non-host: "are you sure?" modal before leaving the game
  netStatus: 'online',       // 'online' | 'reconnecting' — drives the reconnect banner
  _reconnectAttempts: 0,
  _netEverOnline: false,     // true once the peer has opened — gates recoverable-error handling
};

// Host-only runtime.
let engine = null;
let net = null;            // host or client handle
let serverCreated = false; // server mode: first socket open sends createRoom, later opens send join
let voteTimer = null;
let questTimer = null;
let proposalTimer = null;     // host-only: fires when the team-proposal countdown expires

// Drives the visible per-second countdown on every device during the proposal phase.
let countdownInterval = null;

// Client-only: background peer used to discover games on the Join screen.
let discovery = null;
let discoveryTimer = null;

// Client-only: retry loop that revives a dropped connection mid-game.
let clientReconnectTimer = null;

// Client-only: a server-mode join falls back to P2P if the server doesn't accept
// (or reject) us before this fires. Covers a failed/raced boot health check so a
// joiner is never stranded on the P2P-only path for a server-hosted room. Kept
// generous so a slow-but-working Funnel connection isn't abandoned prematurely
// (a premature fallback would itself fail for a server room).
let serverJoinFallbackTimer = null;
const SERVER_JOIN_FALLBACK_MS = 5000;

// ---------------------------------------------------------------------------
// Render wrapper — keeps a little local UI bookkeeping in sync first.
// ---------------------------------------------------------------------------
function draw() {
  // Reset the leader's team selection whenever the proposal context changes.
  if (app.pub && app.pub.phase === 'proposal') {
    const key = `${app.pub.currentQuest}:${app.pub.leaderId}:${app.pub.rejectCount}`;
    if (key !== app._lastProposalKey) {
      app._lastProposalKey = key;
      app.selectedTeam = [];
      // Translate the host's relative span into a local deadline once per
      // proposal, so the countdown stays in sync regardless of clock skew and
      // keeps ticking between (infrequent) state pushes.
      app.localProposalDeadline = (app.pub.proposalRemainingMs != null)
        ? Date.now() + app.pub.proposalRemainingMs
        : null;
    }
  } else {
    app._lastProposalKey = null;
    app.localProposalDeadline = null;
  }
  // The quest-card nudge is transient: clear it whenever we leave the quest phase.
  if (!app.pub || app.pub.phase !== 'quest') app.questNotice = null;
  manageCountdownTicker();
  render(root, app, intents);
}

// Keep a 1s tick running only while a proposal countdown is on screen. We update
// ONLY the clock text in place (not a full re-render) so the timer decrements
// smoothly without tearing down and rebuilding the whole screen every second —
// the former approach made the entire view flicker once per tick.
function manageCountdownTicker() {
  const active = (app.screen === 'game' || app.screen === 'spectator') && app.pub
    && app.pub.phase === 'proposal' && app.localProposalDeadline != null;
  if (active && !countdownInterval) {
    countdownInterval = setInterval(updateCountdownDisplay, 1000);
  } else if (!active && countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// In-place update of the proposal countdown — touches just the clock text and
// the urgent state, leaving the rest of the DOM untouched (no flicker).
function updateCountdownDisplay() {
  if (app.localProposalDeadline == null) return;
  const remMs = Math.max(0, app.localProposalDeadline - Date.now());
  const totalSec = Math.ceil(remMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const label = `${m}:${String(s).padStart(2, '0')}`;
  const urgent = totalSec <= 30;
  // Player board clock (.timer-clock) and spectator clock (.tv-timer-clock).
  document.querySelectorAll('.timer-clock, .tv-timer-clock')
    .forEach((node) => { node.textContent = label; });
  document.querySelectorAll('.proposal-timer')
    .forEach((node) => node.classList.toggle('urgent', urgent));
  document.querySelectorAll('.tv-timer')
    .forEach((node) => node.classList.toggle('urgent', urgent));
}

// ---------------------------------------------------------------------------
// HOST: build role config from optional-role toggles for the current count.
// Loyal Servants / Minions fill the remaining seats automatically.
// ---------------------------------------------------------------------------
function rebuildConfig() {
  const count = engine.count;
  const target = ROLE_COUNTS[count];
  const cfg = { merlin: 1, assassin: 1 };
  let good = 1, evil = 1;
  // Apply each enabled optional toggle (a toggle may add >1 role, e.g. Lovers).
  for (const def of OPTIONAL_TOGGLES) {
    if (!app.toggles[def.key]) continue;
    for (const rid of def.roleIds) {
      cfg[rid] = 1;
      if (ROLES[rid].team === 'good') good += 1; else evil += 1;
    }
  }
  if (target) {
    cfg.servant = Math.max(0, target.good - good);
    cfg.minion  = Math.max(0, target.evil - evil);
  } else {
    cfg.servant = 0; cfg.minion = 0;
  }
  engine.setConfig(cfg);
}

// Which base screen the host should be on right now. A SPECTATING host watches
// the single-screen TV view during active play, but uses the normal game screen
// for the lobby (role config + start) and game over (reveal + Play Again). A
// playing host always uses 'game'. (Returns null to mean "don't touch", e.g.
// while the host is on the stats screen.)
function hostBaseScreen() {
  if (app.me.isHost && app.me.isSpectator && app.pub
      && app.pub.phase !== 'lobby' && app.pub.phase !== 'gameover') {
    return 'spectator';
  }
  return 'game';
}

// ---------------------------------------------------------------------------
// HOST: push state. Renders the host's own view and sends each client the
// public state plus ONLY that player's private slice.
// ---------------------------------------------------------------------------
function hostSync() {
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
  // Keep the host on the right screen as phases change. Only ever flip between
  // the two host-play screens — never yank them off stats/error/etc.
  if (app.me.isHost && (app.screen === 'game' || app.screen === 'spectator')) {
    app.screen = hostBaseScreen();
  }
  // Persist the authoritative state so a host reload can rehydrate the game.
  saveEngineSnapshot(engine.serialize());

  // Record statistics exactly once when the game ends.
  if (engine.phase === 'gameover' && engine.winner && !app._gameRecorded) {
    app._gameRecorded = true;
    const gameResult = {
      winner: engine.winner,
      players: engine.players.map(p => ({
        name: p.name,
        roleId: p.roleId,
        team: ROLES[p.roleId] ? ROLES[p.roleId].team : null,
      })),
    };
    recordGame(app.code, gameResult);
  }

  draw();

  for (const connId of net.connections.keys()) {
    net.sendTo(connId, {
      type: 'state',
      pub: app.pub,
      priv: engine.privateStateFor(connId),
    });
  }
  scheduleAdvances();
}

// Auto-advance the vote and quest reveal beats after a short display delay.
function scheduleAdvances() {
  // The proposal countdown only lives during the proposal phase — drop any
  // pending timer the moment we leave it (team confirmed, reject, game over…).
  if (app.pub.phase !== 'proposal' && proposalTimer) {
    clearTimeout(proposalTimer); proposalTimer = null;
  }
  if (app.pub.phase === 'proposal' && app.pub.proposalRemainingMs != null && !proposalTimer) {
    proposalTimer = setTimeout(() => {
      proposalTimer = null;
      engine.proposalTimedOut();
      hostSync();
    }, app.pub.proposalRemainingMs);
  }
  if (app.pub.phase === 'vote' && app.pub.voteResolved && !voteTimer) {
    voteTimer = setTimeout(() => {
      voteTimer = null;
      engine.acknowledgeVote();
      hostSync();
    }, 4500);
  }
  if (app.pub.phase === 'quest' && app.pub.questResolved && !questTimer) {
    questTimer = setTimeout(() => {
      questTimer = null;
      engine.acknowledgeQuest();
      hostSync();
    }, 4500);
  }
}

// A lightweight summary a joiner can read BEFORE committing to the game, so
// the Join screen can list open games with a name + player count.
function lobbyInfo() {
  const phase = engine ? engine.phase : 'lobby';
  return {
    hostName: (app.me.name || 'Host').trim(),
    playerCount: engine ? engine.count : 0,
    phase,
    joinable: phase === 'lobby' && (engine ? engine.count : 0) < 10,
  };
}

// ---------------------------------------------------------------------------
// HOST: apply one player's intent through the engine (validation lives there).
// Used both for remote clients and for the host's own button presses.
// ---------------------------------------------------------------------------
function handleIntent(playerId, msg) {
  switch (msg.type) {
    case 'lobbyQuery':
      net.sendTo(playerId, { type: 'lobbyInfo', info: lobbyInfo() });
      break;
    case 'join': {
      const r = engine.addPlayer(playerId, msg.name, { isHost: false, clientId: msg.clientId });
      if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
      net.sendTo(playerId, { type: 'welcome', playerId });
      if (engine.phase === 'lobby') rebuildConfig();
      hostSync();
      break;
    }
    case 'spectate': {
      // A spectator watches only the PUBLIC state — never a seat, a role, or any
      // private slice. We deliberately do NOT call engine.addPlayer, so they
      // don't count toward the player total and never receive secret info.
      // privateStateFor(connId) returns null for this unseated id. We DO record
      // them as a watch-only spectator so the lobby can list who's watching;
      // hostSync() then broadcasts the refreshed public state to everyone.
      engine.addSpectator(playerId, msg.name, { clientId: msg.clientId });
      net.sendTo(playerId, { type: 'welcome', playerId, spectator: true });
      hostSync();
      break;
    }
    case 'ready':   engine.setReady(playerId); hostSync(); break;
    case 'propose': {
      const r = engine.proposeTeam(playerId, msg.members);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'vote':    engine.castVote(playerId, msg.approve); hostSync(); break;
    case 'card': {
      const r = engine.playQuestCard(playerId, msg.success);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'assassinate': engine.assassinate(playerId, msg.targetId); hostSync(); break;
    case 'requestStats':
      net.sendTo(playerId, { type: 'statsData', data: getLeaderboard(app.code) });
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Start hosting.
// ---------------------------------------------------------------------------
function hostHandlers() {
  return {
    // Advertise lobby info immediately so discovery probes (and joiners) can
    // show the host's name + player count before anyone commits to joining.
    onConnect: (connId) => { net.sendTo(connId, { type: 'lobbyInfo', info: lobbyInfo() }); },
    onData:    (connId, msg) => handleIntent(connId, msg),
    onNetStatus: (status) => {
      app.netStatus = status;
      if (status === 'online') app._netEverOnline = true;
      draw();
    },
    onDisconnect: (connId) => {
      engine.markOffline(connId);
      if (engine.phase === 'lobby') rebuildConfig();
      hostSync();
    },
    onError: (err) => {
      // A transient broker hiccup while a game is live: stay put, show the
      // reconnect banner, and let the auto-reconnect bring the link back. Only
      // once we've connected at least once — a cold-start failure (no internet)
      // should still surface as a clear error rather than an endless banner.
      if (engine && app._netEverOnline && isRecoverableError(err)) {
        app.netStatus = 'reconnecting';
        try { net && net.reconnect(); } catch (_) {}
        draw();
        return;
      }
      app.screen = 'error';
      app.error = describePeerError(err);
      draw();
    },
  };
}

function startHosting() {
  const asSpectator = !!app.spectatorMode;
  // A spectating host still labels the room (discovery + session); fall back to a
  // generic name so they're never blocked just for not typing one.
  const name = (app.me.name || '').trim() || (asSpectator ? 'Host' : '');
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  const code = generateRoomCode();
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.name = name;
  app.me.isHost = true;
  app.me.isSpectator = asSpectator;
  app.error = '';

  engine = new GameEngine();
  if (asSpectator) {
    // Host-spectator owns the room but takes NO seat: never dealt a role, never
    // counts toward the player total, never receives a private slice. hostId
    // still points at us so host-detection and lobby info work.
    engine.hostId = app.me.id;
  } else {
    engine.addPlayer(app.me.id, name, { isHost: true });
  }
  engine.setAllowReveal(app.allowReveal);
  engine.setRandomLeaderOrder(app.randomLeaderOrder);
  engine.setQuestTimer(app.questTimerEnabled, app.questTimerSeconds);
  engine.setShowPendingVoters(app.showPendingVoters);
  rebuildConfig();

  saveSession({ mode: 'host', code, name, spectator: asSpectator });
  net = createHost(code, hostHandlers());

  // Land in the lobby immediately so the host sees the code while the broker
  // finishes opening the peer. hostSync() routes a spectating host to the TV
  // view once play begins.
  app.screen = 'game';
  hostSync();
}

// Rehydrate an in-progress game after a HOST reload, re-using the same code.
function resumeHosting(code, snapshot, name, asSpectator = false) {
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.me.isSpectator = asSpectator;
  app.me.name = name || app.me.name;
  app.error = '';

  engine = new GameEngine();
  engine.restore(snapshot);
  // Make sure host-detection points at this (deterministic) peer id. A playing
  // host also re-marks their own seat online; a spectating host has no seat.
  engine.hostId = app.me.id;
  const hostPlayer = engine.getPlayer(app.me.id);
  if (hostPlayer) hostPlayer.online = true;
  app.allowReveal = !!engine.allowReveal;
  app.randomLeaderOrder = !!engine.randomLeaderOrder;
  app.questTimerEnabled = !!engine.questTimerEnabled;
  app.questTimerSeconds = engine.questTimerSeconds;
  app.showPendingVoters = !!engine.showPendingVoters;
  // If we reload on the game-over screen, the game was already recorded before
  // the reload — don't let the resume re-record (and inflate) the same result.
  if (engine.phase === 'gameover') app._gameRecorded = true;
  // Mirror the restored role config back into the lobby toggles so the editor
  // stays consistent if the game was reloaded while still in the lobby.
  const cfg = engine.config || {};
  for (const def of OPTIONAL_TOGGLES) {
    app.toggles[def.key] = def.roleIds.every(rid => (cfg[rid] || 0) > 0);
  }

  saveSession({ mode: 'host', code, name: app.me.name, spectator: asSpectator });
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// ---------------------------------------------------------------------------
// Host on the authoritative server (Plan 2E). The creator is the room OWNER but
// is a CLIENT of the server — there is NO local engine. Everyone (the owner
// included) uses the shared client receive/render path; owner controls go over
// the wire (the server enforces them).
// ---------------------------------------------------------------------------
function hostOnServer() {
  const asSpectator = !!app.spectatorMode;
  const name = (app.me.name || '').trim() || (asSpectator ? 'Host' : '');
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  app.mode = 'server';
  app.me.name = name; if (name) saveName(name);
  app.me.isHost = false; app.me.owner = false; app.me.isSpectator = asSpectator;
  app.me.id = null; app.pub = null; app.priv = null;
  app.error = '';
  serverCreated = false;
  // We're creating a BRAND-NEW room — we don't have its code yet (the server
  // assigns it and sends it back in `welcome`). Drop any leftover code from a
  // previous game/session so the "Connecting…" screen doesn't flash the old
  // room code while we wait for the server to mint the new one.
  app.code = '';
  clearSession();                  // server mode is not auto-resumed across reloads (v1)
  app.screen = 'connecting';
  draw();

  net = serverTransport(SERVER_URL, {
    onNetStatus: (status) => { app.netStatus = status; draw(); },
    onOpen: () => {
      const clientId = loadClientId();
      if (!serverCreated) {
        serverCreated = true;
        net.send({ type: 'createRoom', name, clientId, asSpectator });
      } else {
        // Reconnect → reclaim ownership of the same room via clientId.
        net.send({ type: 'join', code: app.code, name, clientId });
      }
    },
    onData: (msg) => clientOnData(msg, asSpectator),
    onClose: () => clientOnClose(),
    onError: (err) => clientOnError(err),
  });
}

// ---------------------------------------------------------------------------
// Join an existing game. Server-first when the Pi is reachable; otherwise (or if
// the room isn't on the server) the original PeerJS P2P path.
// ---------------------------------------------------------------------------
function startJoining(rawCode, rawName, asSpectator = false) {
  const name = (rawName || '').trim();
  const code = normalizeCode(rawCode);
  // Spectators don't need a name (they never get a seat) — default one for the
  // host's logs. Players still must enter a name to claim their seat.
  const effectiveName = asSpectator ? (name || 'Spectator') : name;
  if (!asSpectator && !name) { app.error = 'Enter your name.'; app.screen = 'join'; draw(); return; }
  if (code.length !== 4) { app.error = 'Enter the full 4-digit code.'; app.screen = 'join'; draw(); return; }

  stopDiscovery();
  app.me.name = name; if (name) saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.me.owner = false;
  app.me.isSpectator = asSpectator;
  app.error = '';
  app.screen = 'connecting';
  draw();

  // Always try the server first when one is configured — it has its own P2P
  // fallback (see joinViaServer). We must NOT gate this on the racy one-shot
  // `serverUp` health flag: a joiner whose boot health check timed out (slow
  // network / Funnel cold start) would otherwise go straight to P2P and could
  // never reach a server-hosted room, surfacing as "No game found with that code".
  if (SERVER_URL) joinViaServer(code, name, effectiveName, asSpectator);
  else joinViaP2P(code, name, effectiveName, asSpectator);
}

// PeerJS peer-to-peer join — the original transport, behaviour unchanged.
function joinViaP2P(code, name, effectiveName, asSpectator) {
  app.mode = 'p2p';
  saveSession({ mode: asSpectator ? 'spectate' : 'join', code, name: effectiveName });
  net = joinHost(code, {
    onOpen: () => net.send(asSpectator
      ? { type: 'spectate', name: effectiveName, clientId: loadClientId() }
      : { type: 'join', name, clientId: loadClientId() }),
    onNetStatus: (status) => { app.netStatus = status; draw(); },
    onData: (msg) => clientOnData(msg, asSpectator),
    onClose: () => clientOnClose(),
    onError: (err) => clientOnError(err),
  });
}

// Authoritative WebSocket-server join. Falls back to a P2P join of the SAME code
// when the server doesn't have that room OR is unreachable for this client, so
// server and P2P codes can coexist and a flaky/raced health check can't strand a
// joiner. `committed` flips once the server actually responds (so later events
// route normally); `fellBack` flips once we've switched to P2P (so stale events
// from the abandoned server socket are ignored).
function joinViaServer(code, name, effectiveName, asSpectator) {
  app.mode = 'server';
  clearSession();                  // server mode is not auto-resumed across reloads (v1)
  let committed = false;
  let fellBack = false;

  const clearFallbackTimer = () => {
    if (serverJoinFallbackTimer) { clearTimeout(serverJoinFallbackTimer); serverJoinFallbackTimer = null; }
  };
  const fallback = () => {
    if (committed || fellBack) return;
    fellBack = true;
    clearFallbackTimer();
    teardownNet();
    joinViaP2P(code, name, effectiveName, asSpectator);
  };

  clearFallbackTimer();
  serverJoinFallbackTimer = setTimeout(fallback, SERVER_JOIN_FALLBACK_MS);

  net = serverTransport(SERVER_URL, {
    onNetStatus: (status) => { app.netStatus = status; draw(); },
    onOpen: () => net.send(asSpectator
      ? { type: 'spectate', code, name: effectiveName, clientId: loadClientId() }
      : { type: 'join', code, name, clientId: loadClientId() }),
    onData: (msg) => {
      if (fellBack) return;        // stale frame from the socket we're abandoning
      if (!committed) {
        // Room not on the server → fall back to a P2P join of the same code.
        if (msg.type === 'rejected' && /no game found/i.test(msg.message || '')) { fallback(); return; }
        // Any other response means the server is reachable and handling us.
        committed = true;
        clearFallbackTimer();
      }
      clientOnData(msg, asSpectator);
    },
    // Before the server responds, a close/error means it's unreachable → P2P.
    // After it has, hand off to the normal mid-game reconnect/error handling.
    onClose: () => { if (fellBack) return; if (committed) clientOnClose(); else fallback(); },
    onError: (err) => { if (fellBack) return; if (committed) clientOnError(err); else fallback(); },
  });
}

// Shared client receive handler. The server speaks the same wire protocol as the
// P2P host, so both transports route here.
function clientOnData(msg, asSpectator) {
  stopClientReconnect();             // any message means the link is live
  switch (msg.type) {
    case 'welcome':
      app.me.id = msg.playerId;
      app.me.isSpectator = !!msg.spectator;
      app.me.owner = !!msg.owner;    // server-mode room owner (P2P never sets this)
      if (msg.code) { app.code = msg.code; saveCode(msg.code); }
      break;
    case 'state': {
      app.pub = msg.pub; app.priv = asSpectator ? null : msg.priv;
      if (app.me.owner && asSpectator) {
        // A spectating owner uses the control screen for lobby/gameover and the
        // TV view during play (mirrors the P2P spectating-host routing).
        app.screen = (app.pub.phase !== 'lobby' && app.pub.phase !== 'gameover') ? 'spectator' : 'game';
      } else if (asSpectator) {
        app.screen = 'spectator';
      } else if (app.screen !== 'stats') {
        app.screen = 'game';
      }
      // Spectator end screen: a PURE spectator (watch-only, not the owner) pulls the
      // room leaderboard ONCE at game over so standings can render under the reveal —
      // without the statsData handler's usual hop to the dedicated 'stats' screen.
      // Cleared whenever we leave game over so the next game refetches fresh numbers.
      const pureSpectator = asSpectator && !app.me.owner;
      if (pureSpectator && app.pub.phase === 'gameover') {
        if (!app.tvStats && !app._tvStatsPending && net) {
          app._tvStatsPending = true;
          net.send({ type: 'requestStats' });
        }
      } else if (app.tvStats || app._tvStatsPending) {
        app.tvStats = null;
        app._tvStatsPending = false;
      }
      draw();
      break;
    }
    case 'statsData':
      // A pure spectator only ever requests stats for the inline end-screen standings,
      // so keep them on the TV view. Everyone else (players, the server-mode owner)
      // gets the full dedicated 'stats' screen as before.
      if (asSpectator && !app.me.owner) {
        app._tvStatsPending = false;
        app.tvStats = msg.data;
        draw();
      } else {
        app.statsData = msg.data; app.screen = 'stats'; draw();
      }
      break;
    case 'rejected': clearSession(); teardownNet(); app.screen = 'join'; app.error = msg.message; startDiscovery(); draw(); break;
    case 'error':    app.error = msg.message; draw(); break;
    default: break;
  }
}

function clientOnClose() {
  if (!net) return;                  // we tore the connection down ourselves
  // The link dropped. If a game was live, the peer/server may be briefly away
  // (locked phone, tab switch, funnel hiccup) — retry before giving up.
  if (app.pub) { startClientReconnect(); }
  else { app.screen = 'error'; app.error = 'The connection was closed.'; draw(); }
}

function clientOnError(err) {
  if (!net) return;                  // torn down deliberately
  // Mid-game: assume a brief outage and keep retrying until the attempt cap,
  // rather than dropping straight to a fatal error screen.
  if (app.pub && app.screen !== 'hostleft') { startClientReconnect(); return; }
  if (!net.isOpen()) {
    app.screen = 'error';
    app.error = describePeerError(err);
    draw();
  }
}

// ---------------------------------------------------------------------------
// Discovery lifecycle (Join screen). Polls the broker for game codes, then
// probes each for its lobby info. Falls back gracefully when the broker has
// peer discovery disabled (the public cloud broker does).
// ---------------------------------------------------------------------------
function startDiscovery() {
  stopDiscovery();
  app.discovered = [];
  app.discoveryState = 'searching';
  discovery = createDiscovery();

  const tick = () => {
    if (!discovery) return;
    discovery.list((codes) => {
      if (!discovery) return;
      if (codes === null) {
        // Broker doesn't support discovery — stop and let the user type a code.
        app.discoveryState = 'unsupported';
        draw();
        return;
      }
      app.discoveryState = 'ok';
      // Don't probe our own game if we're somehow hosting; otherwise probe all.
      const targets = codes.filter((c) => c && c !== app.code);
      if (targets.length === 0) {
        app.discovered = [];
        draw();
        discoveryTimer = setTimeout(tick, 3500);
        return;
      }
      const found = [];
      let pending = targets.length;
      const settle = () => {
        if (--pending > 0) return;
        app.discovered = found.sort((a, b) => a.code.localeCompare(b.code));
        draw();
        discoveryTimer = setTimeout(tick, 3500);
      };
      targets.forEach((code) => {
        discovery.probe(code, (info) => {
          if (info) found.push({ code, ...info });
          settle();
        });
      });
    });
  };
  tick();
}

function stopDiscovery() {
  if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null; }
  if (discovery) { try { discovery.destroy(); } catch (_) {} discovery = null; }
  app.discoveryState = 'idle';
  app.discovered = [];
}

function teardownNet() {
  try { if (net) net.destroy(); } catch (_) {}
  net = null;
  stopClientReconnect();
  if (serverJoinFallbackTimer) { clearTimeout(serverJoinFallbackTimer); serverJoinFallbackTimer = null; }
  if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }
  if (questTimer) { clearTimeout(questTimer); questTimer = null; }
  if (proposalTimer) { clearTimeout(proposalTimer); proposalTimer = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

// ---------------------------------------------------------------------------
// Connection recovery. The host's broker socket dies whenever the device sleeps
// or the tab is backgrounded; net.js auto-reconnects it. A CLIENT additionally
// needs to re-open its data channel and re-join (the engine reclaims the seat by
// name). We retry on a backoff and only declare the host gone after persistent
// failure, so a host briefly leaving the screen no longer kills the game.
// ---------------------------------------------------------------------------
const RECONNECT_INTERVAL_MS = 3000;
const RECONNECT_MAX_ATTEMPTS = 12;   // ~36s before we give up

function startClientReconnect() {
  if (app.screen === 'hostleft') return;  // already gave up; wait for user action
  app.netStatus = 'reconnecting';
  if (clientReconnectTimer) return;   // a loop is already running
  app._reconnectAttempts = 0;
  const tick = () => {
    clientReconnectTimer = null;
    if (!net || app.me.isHost) { app.netStatus = 'online'; return; }
    if (net.isOpen()) { stopClientReconnect(); draw(); return; }
    if (app._reconnectAttempts++ >= RECONNECT_MAX_ATTEMPTS) {
      stopClientReconnect();
      app.screen = 'hostleft';
      draw();
      return;
    }
    try { net.reconnect && net.reconnect(); } catch (_) {}
    draw();
    clientReconnectTimer = setTimeout(tick, RECONNECT_INTERVAL_MS);
  };
  tick();
}

function stopClientReconnect() {
  if (clientReconnectTimer) { clearTimeout(clientReconnectTimer); clientReconnectTimer = null; }
  app._reconnectAttempts = 0;
  app.netStatus = 'online';
}

// Nudge the live connection back to life when we return to the foreground or the
// network comes back — covers the common "host locked their phone" case.
function wakeConnection() {
  if (!net) return;
  try { net.reconnect && net.reconnect(); } catch (_) {}
  if (!app.me.isHost && app.pub && !net.isOpen()) startClientReconnect();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wakeConnection();
});
window.addEventListener('online', wakeConnection);

// ---------------------------------------------------------------------------
// Intents handed to the view. Host intents go straight through the engine;
// client intents go over the wire.
// ---------------------------------------------------------------------------
function sendIntent(msg) {
  if (app.mode === 'server') { if (net) net.send(msg); return; }   // owner & players send over the wire
  if (app.me.isHost) handleIntent(app.me.id, msg);                 // P2P host: straight through the local engine
  else if (net) net.send(msg);                                     // P2P client
}

// Server mode: push the owner's full lobby config in one message. The server
// applies it and broadcasts the recomputed role config back in `state`.
function sendServerLobbyConfig() {
  if (!net) return;
  net.send({
    type: 'lobbyConfig',
    toggles: app.toggles,
    allowReveal: app.allowReveal,
    randomLeaderOrder: app.randomLeaderOrder,
    questTimerEnabled: app.questTimerEnabled,
    questTimerSeconds: app.questTimerSeconds,
    showPendingVoters: app.showPendingVoters,
  });
}

const intents = {
  setName: (n) => { app.me.name = n; saveName(n); },
  // Keep the join-screen code field in sync with app state as the user types, so
  // a re-render (e.g. discovery resolving) rebuilds the input with the CURRENT
  // value instead of reverting it to the last-saved code. No draw() — the DOM
  // value is already set by the field's own handler; this just prevents clobber.
  setCode: (c) => { app.code = (c || '').replace(/\D/g, '').slice(0, 4); },
  gotoJoin: () => { app.screen = 'join'; app.error = ''; startDiscovery(); draw(); },
  // How-to-play: remember where we came from so the back button returns there
  // (the link lives on both the home and join screens).
  gotoHowTo: () => { app._howToFrom = app.screen; app.screen = 'howto'; draw(); },
  backFromHowTo: () => { app.screen = app._howToFrom || 'home'; draw(); },
  goHome: () => {
    teardownNet();
    stopDiscovery();
    clearSession();
    engine = null;
    app.mode = 'p2p';
    serverCreated = false;
    app.screen = 'home';
    app.pub = null; app.priv = null; app.error = '';
    app.me.isHost = false; app.me.id = null; app.me.isSpectator = false; app.me.owner = false;
    app.spectatorMode = false;
    app.confirmEndGame = false;
    app.confirmLeaveGame = false;
    app.netStatus = 'online'; app._netEverOnline = false;
    draw();
  },
  // Join screen: flip between joining as a player and watching as a spectator.
  toggleSpectatorMode: () => { app.spectatorMode = !app.spectatorMode; app.error = ''; draw(); },

  host: () => startHosting(),
  hostOnServer: () => hostOnServer(),
  join: (code, name) => startJoining(code, name),
  spectate: (code, name) => startJoining(code, name, true),

  copyCode: async () => {
    if (!app.code) return;
    const ok = await copyText(app.code);
    app.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.copied = false; draw(); }, 1500);
  },

  // Host-only lobby controls
  toggleRole: (id) => {
    if (app.mode === 'server') { if (!app.me.owner) return; app.toggles[id] = !app.toggles[id]; sendServerLobbyConfig(); draw(); return; }
    app.toggles[id] = !app.toggles[id];
    rebuildConfig();
    hostSync();
  },
  toggleReveal: () => {
    if (app.mode === 'server') { if (!app.me.owner) return; app.allowReveal = !app.allowReveal; sendServerLobbyConfig(); draw(); return; }
    if (!app.me.isHost || !engine) return;
    app.allowReveal = !app.allowReveal;
    engine.setAllowReveal(app.allowReveal);
    hostSync();
  },
  toggleRandomLeader: () => {
    if (app.mode === 'server') { if (!app.me.owner) return; app.randomLeaderOrder = !app.randomLeaderOrder; sendServerLobbyConfig(); draw(); return; }
    if (!app.me.isHost || !engine) return;
    app.randomLeaderOrder = !app.randomLeaderOrder;
    engine.setRandomLeaderOrder(app.randomLeaderOrder);
    hostSync();
  },
  toggleQuestTimer: () => {
    if (app.mode === 'server') { if (!app.me.owner) return; app.questTimerEnabled = !app.questTimerEnabled; sendServerLobbyConfig(); draw(); return; }
    if (!app.me.isHost || !engine) return;
    app.questTimerEnabled = !app.questTimerEnabled;
    engine.setQuestTimer(app.questTimerEnabled, app.questTimerSeconds);
    hostSync();
  },
  setQuestTimerMinutes: (min) => {
    const seconds = Math.min(300, Math.max(60, Math.round(min * 60)));
    if (app.mode === 'server') { if (!app.me.owner) return; app.questTimerSeconds = seconds; sendServerLobbyConfig(); draw(); return; }
    if (!app.me.isHost || !engine) return;
    app.questTimerSeconds = seconds;
    engine.setQuestTimer(app.questTimerEnabled, seconds);
    hostSync();
  },
  toggleShowPendingVoters: () => {
    if (app.mode === 'server') { if (!app.me.owner) return; app.showPendingVoters = !app.showPendingVoters; sendServerLobbyConfig(); draw(); return; }
    if (!app.me.isHost || !engine) return;
    app.showPendingVoters = !app.showPendingVoters;
    engine.setShowPendingVoters(app.showPendingVoters);
    hostSync();
  },
  startGame: () => {
    if (app.mode === 'server') { if (app.me.owner) sendIntent({ type: 'startGame' }); return; }
    if (!app.me.isHost) return;
    const r = engine.startGame();
    if (!r.ok) { app.error = r.error; draw(); return; }
    hostSync();
  },
  playAgain: () => {
    if (app.mode === 'server') { if (app.me.owner) sendIntent({ type: 'playAgain' }); return; }
    if (!app.me.isHost) return;
    app._gameRecorded = false;
    engine.playAgain();
    rebuildConfig();
    hostSync();
  },

  // Host-only: end the current game at any point and return everyone to the
  // lobby. A two-step action — the first tap opens a confirmation modal, the
  // second (confirm) actually ends the game.
  requestEndGame: () => { if (app.me.isHost || app.me.owner) { app.confirmEndGame = true; draw(); } },
  cancelEndGame:  () => { app.confirmEndGame = false; draw(); },
  endGame: () => {
    app.confirmEndGame = false;
    if (app.mode === 'server') { if (app.me.owner) sendIntent({ type: 'endGame' }); return; }
    if (!app.me.isHost || !engine) return;
    app._gameRecorded = false;
    // Drop any pending reveal/advance timers from the game we're aborting so a
    // late timeout can't mutate the fresh lobby (they no-op on phase mismatch
    // anyway, but clear them to be tidy and stop the countdown ticker).
    if (voteTimer)     { clearTimeout(voteTimer); voteTimer = null; }
    if (questTimer)    { clearTimeout(questTimer); questTimer = null; }
    if (proposalTimer) { clearTimeout(proposalTimer); proposalTimer = null; }
    engine.endGame();   // back to lobby, keeping players + config + options
    rebuildConfig();
    hostSync();         // broadcasts the lobby state, returning every client to the join/lobby view
  },

  // Non-host: leave the game at any point. A two-step action — the first tap
  // opens the confirmation modal, the second leaves. Leaving disconnects and
  // returns home, but the host HOLDS the seat (marks it offline) while the game
  // is in progress, so the player can rejoin from the same device by entering
  // the same name + room code — the engine reclaims their seat and role by name.
  requestLeaveGame: () => { if (!app.me.isHost && !app.me.owner) { app.confirmLeaveGame = true; draw(); } },
  cancelLeaveGame:  () => { app.confirmLeaveGame = false; draw(); },
  leaveGame: () => {
    app.confirmLeaveGame = false;
    intents.goHome();   // tears down the connection (host keeps the seat offline) and goes home
  },

  // Statistics intents
  viewStats: () => {
    if (app.me.isHost) {
      app.statsData = getLeaderboard(app.code);
      app.screen = 'stats';
      draw();
    } else if (net) {
      net.send({ type: 'requestStats' });
    }
  },
  backToGame: () => {
    app.statsData = null;
    // A spectating host returns to the TV view if play is underway, otherwise
    // the normal game screen. Everyone else just goes back to 'game'.
    app.screen = app.me.isHost ? hostBaseScreen() : 'game';
    draw();
  },
  resetStats: () => {
    clearStats(app.code);
    app.statsData = getLeaderboard(app.code);
    draw();
  },

  // Per-player game intents
  ready: () => sendIntent({ type: 'ready' }),
  toggleTeamPick: (pid) => {
    const i = app.selectedTeam.indexOf(pid);
    const need = app.pub ? app.pub.requiredTeamSize : 0;
    if (i >= 0) app.selectedTeam.splice(i, 1);
    else if (app.selectedTeam.length < need) app.selectedTeam.push(pid);
    draw();
  },
  propose: (members) => sendIntent({ type: 'propose', members }),
  vote: (approve) => sendIntent({ type: 'vote', approve }),
  playCard: (success) => { app.questNotice = null; sendIntent({ type: 'card', success }); },
  // Player tapped a quest card they aren't allowed to play — nudge, don't submit.
  questBlocked: (kind) => { app.questNotice = kind; draw(); },
  assassinate: (targetId) => sendIntent({ type: 'assassinate', targetId }),
};

// ---------------------------------------------------------------------------
// Boot — resume the previous session if there is one, so a reload or a rejoin
// from the same link drops you back into the same game.
// ---------------------------------------------------------------------------
function resumeSession() {
  const s = loadSession();
  if (!s || !s.code) return false;

  if (s.mode === 'host') {
    const snapshot = loadEngineSnapshot();
    if (!snapshot) return false;          // nothing to rehydrate → start fresh
    resumeHosting(s.code, snapshot, s.name, !!s.spectator);
    return true;
  }
  if (s.mode === 'join' && s.name) {
    // Reconnect to the host; the engine reclaims our seat (and role) by name.
    startJoining(s.code, s.name);
    return true;
  }
  if (s.mode === 'spectate') {
    // Re-attach as a watch-only spectator (no seat to reclaim).
    startJoining(s.code, s.name, true);
    return true;
  }
  return false;
}

if (!resumeSession()) draw();

// Probe the authoritative server so the home screen can offer "Host on server".
// Purely additive: if it's unreachable the app stays exactly as it is (P2P only).
async function checkServer() {
  if (!SERVER_URL || !SERVER_HEALTH) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(SERVER_HEALTH, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    app.serverUp = !!(res && res.ok);
  } catch (_) { app.serverUp = false; }
  if (app.serverUp && app.screen === 'home') draw();   // reveal the button if still on home
}
checkServer();

// Service worker (relative path so it works under a GitHub Pages subpath).
// Goal: never serve a stale build, but only ever auto-reload when there is an
// actual new version — not on every load.
if ('serviceWorker' in navigator) {
  // If a worker already controls this page at load, a later controller change
  // means a NEW version just activated — reload ONCE to pick it up. On the very
  // first visit there is no prior controller, so initial activation does NOT
  // reload (avoids a needless refresh).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    // updateViaCache:'none' forces the browser to fetch sw.js fresh (not from
    // the HTTP cache) so new deploys are detected promptly; reg.update() kicks
    // off that check immediately on load.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => { reg.update().catch(() => {}); })
      .catch(() => { /* offline shell is optional */ });
  });
}
