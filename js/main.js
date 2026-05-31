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
import { createHost, joinHost, createDiscovery, describePeerError, peerIdForCode } from './net.js';
import { render } from './ui.js';
import { ROLE_COUNTS, ROLES, OPTIONAL_TOGGLES } from './rules.js';
import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';
import { recordGame, getLeaderboard, clearStats } from './stats.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',                 // home | join | connecting | game | error | hostleft | stats
  me: { id: null, name: loadName(), isHost: false },
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
  _lastProposalKey: null,
  // Local-network game discovery (Join screen).
  discovered: [],            // [{ code, hostName, playerCount, phase, joinable }]
  discoveryState: 'idle',    // idle | searching | ok | unsupported
  // Statistics / leaderboard state.
  statsData: null,           // { summary, leaderboard } from getLeaderboard()
  _gameRecorded: false,      // prevents double-recording the same game
};

// Host-only runtime.
let engine = null;
let net = null;            // host or client handle
let voteTimer = null;
let questTimer = null;

// Client-only: background peer used to discover games on the Join screen.
let discovery = null;
let discoveryTimer = null;

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
    }
  } else {
    app._lastProposalKey = null;
  }
  render(root, app, intents);
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

// ---------------------------------------------------------------------------
// HOST: push state. Renders the host's own view and sends each client the
// public state plus ONLY that player's private slice.
// ---------------------------------------------------------------------------
function hostSync() {
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
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
      const r = engine.addPlayer(playerId, msg.name, { isHost: false });
      if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
      net.sendTo(playerId, { type: 'welcome', playerId });
      if (engine.phase === 'lobby') rebuildConfig();
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
    onDisconnect: (connId) => {
      engine.markOffline(connId);
      if (engine.phase === 'lobby') rebuildConfig();
      hostSync();
    },
    onError: (err) => {
      app.screen = 'error';
      app.error = describePeerError(err);
      draw();
    },
  };
}

function startHosting() {
  const name = (app.me.name || '').trim();
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  const code = generateRoomCode();
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.error = '';

  engine = new GameEngine();
  engine.addPlayer(app.me.id, name, { isHost: true });
  engine.setAllowReveal(app.allowReveal);
  engine.setRandomLeaderOrder(app.randomLeaderOrder);
  rebuildConfig();

  saveSession({ mode: 'host', code, name });
  net = createHost(code, hostHandlers());

  // Land in the lobby immediately so the host sees the code while the broker
  // finishes opening the peer.
  app.screen = 'game';
  hostSync();
}

// Rehydrate an in-progress game after a HOST reload, re-using the same code.
function resumeHosting(code, snapshot, name) {
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.me.name = name || app.me.name;
  app.error = '';

  engine = new GameEngine();
  engine.restore(snapshot);
  // Make sure the host's own seat points at this (deterministic) peer id.
  engine.hostId = app.me.id;
  const hostPlayer = engine.getPlayer(app.me.id);
  if (hostPlayer) hostPlayer.online = true;
  app.allowReveal = !!engine.allowReveal;
  app.randomLeaderOrder = !!engine.randomLeaderOrder;
  // Mirror the restored role config back into the lobby toggles so the editor
  // stays consistent if the game was reloaded while still in the lobby.
  const cfg = engine.config || {};
  for (const def of OPTIONAL_TOGGLES) {
    app.toggles[def.key] = def.roleIds.every(rid => (cfg[rid] || 0) > 0);
  }

  saveSession({ mode: 'host', code, name: app.me.name });
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// ---------------------------------------------------------------------------
// Join an existing game.
// ---------------------------------------------------------------------------
function startJoining(rawCode, rawName) {
  const name = (rawName || '').trim();
  const code = normalizeCode(rawCode);
  if (!name) { app.error = 'Enter your name.'; app.screen = 'join'; draw(); return; }
  if (code.length !== 4) { app.error = 'Enter the full 4-character code.'; app.screen = 'join'; draw(); return; }

  stopDiscovery();
  app.me.name = name; saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.error = '';
  app.screen = 'connecting';
  saveSession({ mode: 'join', code, name });
  draw();

  net = joinHost(code, {
    onOpen: () => net.send({ type: 'join', name }),
    onData: (msg) => {
      switch (msg.type) {
        case 'welcome':  app.me.id = msg.playerId; break;
        case 'state':    app.pub = msg.pub; app.priv = msg.priv; if (app.screen !== 'stats') app.screen = 'game'; draw(); break;
        case 'statsData': app.statsData = msg.data; app.screen = 'stats'; draw(); break;
        case 'rejected': clearSession(); teardownNet(); app.screen = 'join'; app.error = msg.message; startDiscovery(); draw(); break;
        case 'error':    app.error = msg.message; draw(); break;
        default: break;
      }
    },
    onClose: () => {
      // Host went away. If we were in a game, say so; otherwise it's a failed join.
      if (app.screen === 'game') { app.screen = 'hostleft'; }
      else { app.screen = 'error'; app.error = 'The host closed the connection.'; }
      draw();
    },
    onError: (err) => {
      if (!net || !net.isOpen()) {
        app.screen = 'error';
        app.error = describePeerError(err);
        draw();
      }
    },
  });
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
  if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }
  if (questTimer) { clearTimeout(questTimer); questTimer = null; }
}

// ---------------------------------------------------------------------------
// Intents handed to the view. Host intents go straight through the engine;
// client intents go over the wire.
// ---------------------------------------------------------------------------
function sendIntent(msg) {
  if (app.me.isHost) handleIntent(app.me.id, msg);
  else if (net) net.send(msg);
}

const intents = {
  setName: (n) => { app.me.name = n; saveName(n); },
  gotoJoin: () => { app.screen = 'join'; app.error = ''; startDiscovery(); draw(); },
  goHome: () => {
    teardownNet();
    stopDiscovery();
    clearSession();
    engine = null;
    app.screen = 'home';
    app.pub = null; app.priv = null; app.error = '';
    app.me.isHost = false; app.me.id = null;
    draw();
  },

  host: () => startHosting(),
  join: (code, name) => startJoining(code, name),

  copyCode: async () => {
    if (!app.code) return;
    const ok = await copyText(app.code);
    app.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.copied = false; draw(); }, 1500);
  },

  // Host-only lobby controls
  toggleRole: (id) => {
    app.toggles[id] = !app.toggles[id];
    rebuildConfig();
    hostSync();
  },
  toggleReveal: () => {
    if (!app.me.isHost || !engine) return;
    app.allowReveal = !app.allowReveal;
    engine.setAllowReveal(app.allowReveal);
    hostSync();
  },
  toggleRandomLeader: () => {
    if (!app.me.isHost || !engine) return;
    app.randomLeaderOrder = !app.randomLeaderOrder;
    engine.setRandomLeaderOrder(app.randomLeaderOrder);
    hostSync();
  },
  startGame: () => {
    if (!app.me.isHost) return;
    const r = engine.startGame();
    if (!r.ok) { app.error = r.error; draw(); return; }
    hostSync();
  },
  playAgain: () => {
    if (!app.me.isHost) return;
    app._gameRecorded = false;
    engine.playAgain();
    rebuildConfig();
    hostSync();
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
    app.screen = 'game';
    app.statsData = null;
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
  playCard: (success) => sendIntent({ type: 'card', success }),
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
    resumeHosting(s.code, snapshot, s.name);
    return true;
  }
  if (s.mode === 'join' && s.name) {
    // Reconnect to the host; the engine reclaims our seat (and role) by name.
    startJoining(s.code, s.name);
    return true;
  }
  return false;
}

if (!resumeSession()) draw();

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
