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
import { createHost, joinHost, describePeerError, peerIdForCode } from './net.js';
import { render } from './ui.js';
import { ROLE_COUNTS } from './rules.js';
import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode,
} from './util.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',                 // home | join | connecting | game | error | hostleft
  me: { id: null, name: loadName(), isHost: false },
  code: loadCode(),
  pub: null,
  priv: null,
  error: '',
  copied: false,
  selectedTeam: [],               // leader's in-progress team pick
  toggles: { percival: true, morgana: true, mordred: false, oberon: false },
  _lastProposalKey: null,
};

// Host-only runtime.
let engine = null;
let net = null;            // host or client handle
let voteTimer = null;
let questTimer = null;

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
  if (app.toggles.percival) { cfg.percival = 1; good += 1; }
  if (app.toggles.morgana)  { cfg.morgana = 1;  evil += 1; }
  if (app.toggles.mordred)  { cfg.mordred = 1;  evil += 1; }
  if (app.toggles.oberon)   { cfg.oberon = 1;   evil += 1; }
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

// ---------------------------------------------------------------------------
// HOST: apply one player's intent through the engine (validation lives there).
// Used both for remote clients and for the host's own button presses.
// ---------------------------------------------------------------------------
function handleIntent(playerId, msg) {
  switch (msg.type) {
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
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Start hosting.
// ---------------------------------------------------------------------------
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
  rebuildConfig();

  net = createHost(code, {
    onConnect: () => {},                       // wait for the player's 'join'
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
  });

  // Land in the lobby immediately so the host sees the code while the broker
  // finishes opening the peer.
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

  app.me.name = name; saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.error = '';
  app.screen = 'connecting';
  draw();

  net = joinHost(code, {
    onOpen: () => net.send({ type: 'join', name }),
    onData: (msg) => {
      switch (msg.type) {
        case 'welcome':  app.me.id = msg.playerId; break;
        case 'state':    app.pub = msg.pub; app.priv = msg.priv; app.screen = 'game'; draw(); break;
        case 'rejected': teardownNet(); app.screen = 'join'; app.error = msg.message; draw(); break;
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
  gotoJoin: () => { app.screen = 'join'; app.error = ''; draw(); },
  goHome: () => {
    teardownNet();
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
  startGame: () => {
    if (!app.me.isHost) return;
    const r = engine.startGame();
    if (!r.ok) { app.error = r.error; draw(); return; }
    hostSync();
  },
  playAgain: () => {
    if (!app.me.isHost) return;
    engine.playAgain();
    rebuildConfig();
    hostSync();
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
// Boot
// ---------------------------------------------------------------------------
draw();

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
