// Quick correctness harness for the pure rules + host engine. No DOM needed.
// Run: node scripts/test-engine.mjs
import {
  TEAM_SIZES, ROLE_COUNTS, teamSize, failThreshold, validateRoleConfig,
  defaultRoleConfig, computeKnowledge, ROLES,
} from '../js/rules.js';
import { GameEngine, PHASES } from '../js/state.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// --- Rule tables -----------------------------------------------------------
eq(teamSize(5, 0), 2, '5p Q1 size');
eq(teamSize(7, 3), 4, '7p Q4 size');
eq(teamSize(10, 4), 5, '10p Q5 size');
eq(failThreshold(5, 3), 1, '5p Q4 needs 1 fail');
eq(failThreshold(7, 3), 2, '7p Q4 needs 2 fails');
eq(failThreshold(8, 0), 1, '8p Q1 needs 1 fail');

// Default configs validate for every supported count.
for (let n = 5; n <= 10; n++) {
  const v = validateRoleConfig(defaultRoleConfig(n), n);
  ok(v.ok, `default config valid for ${n}p: ${v.errors.join(',')}`);
  eq(v.good, ROLE_COUNTS[n].good, `${n}p good count`);
  eq(v.evil, ROLE_COUNTS[n].evil, `${n}p evil count`);
}

// validateRoleConfig rejects bad combos.
ok(!validateRoleConfig({ assassin: 1 }, 5).ok, 'missing Merlin rejected');
ok(!validateRoleConfig({ merlin: 2, assassin: 1, servant: 1, minion: 1 }, 5).ok, 'duplicate Merlin rejected');

// --- Knowledge -------------------------------------------------------------
{
  const players = [
    { id: 'a', name: 'A', roleId: 'merlin' },
    { id: 'b', name: 'B', roleId: 'assassin' },
    { id: 'c', name: 'C', roleId: 'mordred' },
    { id: 'd', name: 'D', roleId: 'percival' },
    { id: 'e', name: 'E', roleId: 'morgana' },
  ];
  const merlinSees = computeKnowledge(players[0], players).sees.map(s => s.id).sort();
  eq(merlinSees, ['b', 'e'], 'Merlin sees Assassin+Morgana but NOT Mordred');

  const percivalSees = computeKnowledge(players[3], players).sees.map(s => s.id).sort();
  eq(percivalSees, ['a', 'e'], 'Percival sees Merlin+Morgana');

  const assassinSees = computeKnowledge(players[1], players).sees.map(s => s.id).sort();
  eq(assassinSees, ['c', 'e'], 'Assassin (evil) sees fellow evil Mordred+Morgana');
}
{
  // Oberon isolation.
  const players = [
    { id: 'a', name: 'A', roleId: 'assassin' },
    { id: 'b', name: 'B', roleId: 'oberon' },
    { id: 'c', name: 'C', roleId: 'merlin' },
    { id: 'd', name: 'D', roleId: 'servant' },
    { id: 'e', name: 'E', roleId: 'servant' },
  ];
  eq(computeKnowledge(players[1], players).sees, [], 'Oberon sees nobody');
  const assassinSees = computeKnowledge(players[0], players).sees.map(s => s.id);
  ok(!assassinSees.includes('b'), 'Assassin does NOT see Oberon');
  const merlinSees = computeKnowledge(players[2], players).sees.map(s => s.id).sort();
  eq(merlinSees, ['a', 'b'], 'Merlin DOES see Oberon (and Assassin)');
}

// --- Full game: drive a 5-player game to a Good quest win -> assassination --
function seat(engine, names) {
  names.forEach((n, i) => engine.addPlayer('p' + i, n, { isHost: i === 0 }));
}
function approveAll(engine) {
  engine.players.forEach(p => engine.castVote(p.id, true));
  engine.acknowledgeVote();
}
function runQuestAllSuccess(engine) {
  engine.proposal.members.forEach(id => engine.playQuestCard(id, true));
  engine.acknowledgeQuest();
}

{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });
  const r = e.startGame();
  ok(r.ok, 'startGame ok: ' + (r.error || ''));
  eq(e.phase, PHASES.ROLE_REVEAL, 'phase after start');
  e.players.forEach(p => e.setReady(p.id));
  eq(e.phase, PHASES.PROPOSAL, 'all ready -> proposal');

  // Three successful quests in a row -> assassination (assassin present).
  for (let q = 0; q < 3; q++) {
    const leader = e.leader.id;
    const need = teamSize(5, e.questIndex);
    const members = e.players.slice(0, need).map(p => p.id);
    const pr = e.proposeTeam(leader, members);
    ok(pr.ok, `propose q${q}: ` + (pr.error || ''));
    approveAll(e);
    eq(e.phase, PHASES.QUEST, `q${q} approved -> quest`);
    runQuestAllSuccess(e);
  }
  eq(e.phase, PHASES.ASSASSINATION, '3 successes -> assassination');

  // Assassin guesses wrong -> Good wins.
  const assassin = e.players.find(p => p.roleId === 'assassin');
  const merlin = e.players.find(p => p.roleId === 'merlin');
  const wrong = e.players.find(p => p.roleId !== 'merlin' && ROLES[p.roleId].team === 'good');
  e.assassinate(assassin.id, wrong.id);
  eq(e.winner, 'good', 'wrong assassination -> Good wins');

  // Fresh game, assassin nails Merlin -> Evil wins.
  const e2 = new GameEngine();
  seat(e2, ['Host', 'B', 'C', 'D', 'E']);
  e2.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });
  e2.startGame();
  e2.players.forEach(p => e2.setReady(p.id));
  for (let q = 0; q < 3; q++) {
    const need = teamSize(5, e2.questIndex);
    e2.proposeTeam(e2.leader.id, e2.players.slice(0, need).map(p => p.id));
    approveAll(e2);
    runQuestAllSuccess(e2);
  }
  const a2 = e2.players.find(p => p.roleId === 'assassin');
  const m2 = e2.players.find(p => p.roleId === 'merlin');
  e2.assassinate(a2.id, m2.id);
  eq(e2.winner, 'evil', 'correct assassination -> Evil wins');
}

// --- Evil wins via 3 failed quests ----------------------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, servant: 2, minion: 1 });
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  const evil = e.players.filter(p => ROLES[p.roleId].team === 'evil').map(p => p.id);

  for (let q = 0; q < 3; q++) {
    const need = teamSize(5, e.questIndex);
    // Always include one evil player so the quest can fail.
    const members = [evil[0], ...e.players.map(p => p.id).filter(id => id !== evil[0])].slice(0, need);
    e.proposeTeam(e.leader.id, members);
    approveAll(e);
    e.proposal.members.forEach(id => {
      const isEvil = evil.includes(id);
      e.playQuestCard(id, isEvil ? false : true);
    });
    e.acknowledgeQuest();
  }
  eq(e.winner, 'evil', '3 failed quests -> Evil wins');
}

// --- Evil wins via 5 rejected proposals -----------------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, servant: 2, minion: 1 });
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  for (let i = 0; i < 5; i++) {
    const need = teamSize(5, e.questIndex);
    e.proposeTeam(e.leader.id, e.players.slice(0, need).map(p => p.id));
    e.players.forEach(p => e.castVote(p.id, false)); // everyone rejects
    e.acknowledgeVote();
  }
  eq(e.winner, 'evil', '5 rejects -> Evil wins');
  eq(e.winReason.includes('5'), true, 'reject reason mentions 5');
}

// --- Good cannot play Fail; leader rotates; vote majority -----------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, servant: 2, minion: 1 });
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  const good = e.players.find(p => ROLES[p.roleId].team === 'good');
  e.proposeTeam(e.leader.id, e.players.slice(0, 2).map(p => p.id));
  // tie/minority should reject: 2 approve of 5 is not a majority.
  e.castVote(e.players[0].id, true);
  e.castVote(e.players[1].id, true);
  e.castVote(e.players[2].id, false);
  e.castVote(e.players[3].id, false);
  e.castVote(e.players[4].id, false);
  eq(e.publicState().lastVoteApproved, false, '2/5 approve -> rejected');
  const leaderBefore = e.leaderIndex;
  e.acknowledgeVote();
  eq(e.leaderIndex, (leaderBefore + 1) % 5, 'leader rotates after reject');

  // Good player on a quest cannot fail.
  e.proposeTeam(e.leader.id, e.players.slice(0, 2).map(p => p.id));
  e.players.forEach(p => e.castVote(p.id, true));
  e.acknowledgeVote();
  if (e.proposal.members.includes(good.id)) {
    const res = e.playQuestCard(good.id, false);
    ok(!res.ok, 'Good cannot play Fail');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
