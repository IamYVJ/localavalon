// ============================================================================
// test-server.mjs — Headless integration test for the authoritative server.
//
// Drives server/session.js + server/rooms.js with STUB WebSocket objects (no
// `ws` dependency, no network, no open ports) and plays a full 5-player game:
//   create room -> join -> lobby config -> start -> ready -> 3 quests ->
//   assassination -> game over -> stats -> spectate -> play again -> disconnect.
//
// Run with the reveal timers fast-forwarded to 0ms:
//   REVEAL_DELAY_MS=0 node scripts/test-server.mjs
// ============================================================================

import '../server/storage.js';                       // install localStorage shim first
import { RoomManager } from '../server/rooms.js';
import { handleMessage, handleClose } from '../server/session.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// Let any setTimeout(…, 0) reveal-advance callbacks run.
const tick = () => new Promise((r) => setTimeout(r, 5));

class FakeWS {
  constructor(label) { this.label = label; this.readyState = 1; this.sent = []; this.byType = {}; this.state = null; }
  send(str) {
    const m = JSON.parse(str);
    this.sent.push(m);
    this.byType[m.type] = m;
    if (m.type === 'state') this.state = m;
  }
  close() { this.readyState = 3; }
}

const ctx = { manager: new RoomManager({ maxRooms: 50 }), maxRooms: 50 };
const send = (ws, obj) => handleMessage(ctx, ws, JSON.stringify(obj));

async function main() {
  if (Number(process.env.REVEAL_DELAY_MS) !== 0) {
    console.warn('NOTE: run with REVEAL_DELAY_MS=0 for a fast test (reveal beats default to 4.5s).');
  }

  // --- create room ---------------------------------------------------------
  const owner = new FakeWS('owner');
  send(owner, { type: 'createRoom', name: 'Olivia', clientId: 'c-owner' });
  const code = owner.byType.welcome && owner.byType.welcome.code;
  ok(!!code && /^\d{4}$/.test(code), 'createRoom returns a 4-digit code');
  ok(owner.byType.welcome.owner === true, 'creator is flagged owner');
  ok(!!owner.state, 'owner receives initial state');

  const room = ctx.manager.get(code);
  const e = room.engine;
  const wsById = new Map([[owner.byType.welcome.playerId, owner]]);

  // --- unknown code is rejected -------------------------------------------
  const stranger = new FakeWS('stranger');
  send(stranger, { type: 'join', code: code === '0000' ? '1111' : '0000', name: 'Nobody', clientId: 'c-x' });
  ok(stranger.byType.rejected && /No game found/.test(stranger.byType.rejected.message), 'join with unknown code is rejected');

  // --- lobby query --------------------------------------------------------
  const probe = new FakeWS('probe');
  send(probe, { type: 'lobbyQuery', code });
  ok(probe.byType.lobbyInfo && probe.byType.lobbyInfo.info && probe.byType.lobbyInfo.info.hostName === 'Olivia', 'lobbyQuery returns host name');

  // --- four players join --------------------------------------------------
  const names = ['Ben', 'Cara', 'Dan', 'Eve'];
  names.forEach((nm, i) => {
    const ws = new FakeWS(nm);
    send(ws, { type: 'join', code, name: nm, clientId: 'c-' + i });
    ok(ws.byType.welcome && ws.byType.welcome.owner === false, `${nm} joins (not owner)`);
    wsById.set(ws.byType.welcome.playerId, ws);
  });
  eq(e.count, 5, 'five seated players');

  // --- owner gating: non-owner cannot start -------------------------------
  const joiner = [...wsById.values()].find((w) => w !== owner);
  send(joiner, { type: 'startGame' });
  eq(e.phase, 'lobby', 'non-owner startGame is ignored');

  // --- configure + start ---------------------------------------------------
  send(owner, { type: 'lobbyConfig', toggles: { percival: true, morgana: true, lovers: false, mordred: false, oberon: false, lunatic: false, brute: false }, allowReveal: false });
  send(owner, { type: 'startGame' });
  eq(e.phase, 'roleReveal', 'owner starts the game');
  ok(owner.state.pub.reveal === undefined, 'no role reveal in public state during play');
  let allHaveRole = true;
  for (const ws of wsById.values()) if (!ws.state || !ws.state.priv || !ws.state.priv.role) allHaveRole = false;
  ok(allHaveRole, 'every player receives a private role on reveal');

  // --- everyone ready ------------------------------------------------------
  for (const ws of wsById.values()) send(ws, { type: 'ready' });
  await tick();
  eq(e.phase, 'proposal', 'all-ready advances to proposal');

  // --- run quests until assassination -------------------------------------
  let guard = 0;
  while (e.phase !== 'assassination' && e.phase !== 'gameover' && guard++ < 12) {
    eq(e.phase, 'proposal', 'in proposal phase');
    const need = e.publicState().requiredTeamSize;
    const members = e.players.slice(0, need).map((p) => p.id);
    send(wsById.get(e.leader.id), { type: 'propose', members });
    eq(e.phase, 'vote', 'propose advances to vote');
    for (const ws of wsById.values()) send(ws, { type: 'vote', approve: true });
    await tick();
    eq(e.phase, 'quest', 'approved vote advances to quest');
    for (const id of e.proposal.members) send(wsById.get(id), { type: 'card', success: true });
    await tick();
  }
  eq(e.phase, 'assassination', 'good completes 3 quests -> assassination');

  // --- assassin misses -> good wins ---------------------------------------
  const assassin = e.players.find((p) => p.roleId === 'assassin');
  const target = e.players.find((p) => p.roleId !== 'assassin' && p.roleId !== 'merlin');
  send(wsById.get(assassin.id), { type: 'assassinate', targetId: target.id });
  eq(e.phase, 'gameover', 'assassination ends the game');
  eq(e.winner, 'good', 'assassin missed -> good wins');
  ok(owner.state.pub.reveal && owner.state.pub.reveal.length === 5, 'full role reveal at game over');

  // --- stats recorded exactly once ----------------------------------------
  send(owner, { type: 'requestStats' });
  ok(owner.byType.statsData && owner.byType.statsData.data.summary.gamesPlayed === 1, 'game recorded in stats exactly once');

  // --- spectator: public state only, never a private slice ----------------
  const spec = new FakeWS('spec');
  send(spec, { type: 'spectate', code, name: 'Watcher' });
  ok(spec.byType.welcome && spec.byType.welcome.spectator === true, 'spectator welcomed');
  ok(spec.state && spec.state.priv === null, 'spectator receives no private slice');

  // --- play again returns to lobby ----------------------------------------
  send(owner, { type: 'playAgain' });
  eq(e.phase, 'lobby', 'owner playAgain returns to lobby');

  // --- leaving the lobby frees the seat -----------------------------------
  const before = e.count;
  handleClose(ctx, joiner);
  eq(e.count, before - 1, 'leaving the lobby frees the seat');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
