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

// --- New roles: Lovers, Lunatic, Brute -------------------------------------
{
  // Lovers knowledge: Tristan <-> Isolde, both Good.
  const players = [
    { id: 'a', name: 'A', roleId: 'tristan' },
    { id: 'b', name: 'B', roleId: 'isolde' },
    { id: 'c', name: 'C', roleId: 'merlin' },
    { id: 'd', name: 'D', roleId: 'assassin' },
    { id: 'e', name: 'E', roleId: 'servant' },
  ];
  eq(computeKnowledge(players[0], players).sees.map(s => s.id), ['b'], 'Tristan sees Isolde');
  eq(computeKnowledge(players[1], players).sees.map(s => s.id), ['a'], 'Isolde sees Tristan');
  // Merlin should NOT see the Lovers (they are Good).
  const merlinSees = computeKnowledge(players[2], players).sees.map(s => s.id);
  ok(!merlinSees.includes('a') && !merlinSees.includes('b'), 'Merlin does not see the Lovers');
}

// validateRoleConfig: Lovers must be paired.
ok(!validateRoleConfig({ merlin: 1, assassin: 1, tristan: 1, servant: 1, minion: 1 }, 5).ok, 'Tristan without Isolde rejected');
ok(validateRoleConfig({ merlin: 1, assassin: 1, tristan: 1, isolde: 1, servant: 1, minion: 2 }, 7).ok, 'Lovers config valid for 7p');
ok(validateRoleConfig({ merlin: 1, assassin: 1, lunatic: 1, brute: 1, servant: 3 }, 7).ok, 'Lunatic+Brute config valid for 7p');

{
  // Lunatic must Fail; Brute may only Fail on quests 1-3.
  const e = new GameEngine();
  seat(e, ['A', 'B', 'C', 'D', 'E']);
  e.phase = PHASES.QUEST;
  e.players[0].roleId = 'lunatic';
  e.players[1].roleId = 'brute';
  e.players[2].roleId = 'servant';
  e.players[3].roleId = 'merlin';
  e.players[4].roleId = 'assassin';
  e.questIndex = 0;
  e.proposal = { leaderId: 'p0', members: ['p0', 'p1'] };
  e.questCards = {};
  ok(!e.playQuestCard('p0', true).ok, 'Lunatic cannot play Success');
  ok(e.playQuestCard('p0', false).ok, 'Lunatic plays Fail');
  ok(e.playQuestCard('p1', false).ok, 'Brute may Fail on quest 1');

  // Brute on quest 4 (index 3) must Succeed.
  const e2 = new GameEngine();
  seat(e2, ['A', 'B', 'C', 'D', 'E']);
  e2.phase = PHASES.QUEST;
  e2.players[1].roleId = 'brute';
  e2.questIndex = 3;
  e2.proposal = { leaderId: 'p0', members: ['p1'] };
  e2.questCards = {};
  ok(!e2.playQuestCard('p1', false).ok, 'Brute cannot Fail on quest 4');
  ok(e2.playQuestCard('p1', true).ok, 'Brute may Succeed on quest 4');

  // Private flags reflect the constraints.
  const e3 = new GameEngine();
  seat(e3, ['A', 'B', 'C', 'D', 'E']);
  e3.phase = PHASES.QUEST;
  e3.players[0].roleId = 'lunatic';
  e3.players[1].roleId = 'brute';
  e3.players[2].roleId = 'servant';
  e3.players[3].roleId = 'merlin';
  e3.players[4].roleId = 'assassin';
  e3.questIndex = 3;
  e3.proposal = { leaderId: 'p0', members: ['p0', 'p1'] };
  e3.questCards = {};
  eq(e3.privateStateFor('p0').mustFail, true, 'Lunatic mustFail flag set');
  eq(e3.privateStateFor('p1').mayFail, false, 'Brute mayFail false on quest 4');
}

// --- Session resume: serialize/restore round-trip --------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });
  e.setAllowReveal(true);
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  // Get into a mid-quest state with one vote/card recorded.
  e.proposeTeam(e.leader.id, e.players.slice(0, 2).map(p => p.id));
  e.castVote('p0', true);

  const snap = e.serialize();
  const r = new GameEngine();
  r.restore(snap);
  eq(r.phase, e.phase, 'restore keeps phase');
  eq(r.allowReveal, true, 'restore keeps allowReveal');
  eq(r.players.map(p => p.roleId), e.players.map(p => p.roleId), 'restore keeps dealt roles');
  eq(r.votes, e.votes, 'restore keeps recorded votes');
  eq(r.proposal, e.proposal, 'restore keeps the proposal');
  ok(r.players.find(p => p.id === r.hostId).online, 'host is online after restore');
  ok(r.players.filter(p => p.id !== r.hostId).every(p => !p.online), 'non-hosts offline after restore');
}

// --- Reconnect-by-name remaps mid-game id-keyed state ----------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, servant: 2, minion: 1 });
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  e.proposeTeam(e.leader.id, ['p0', 'p1']);
  e.castVote('p1', true);
  ok('p1' in e.votes, 'vote recorded under old id');

  // p1 drops and reconnects with a brand-new connection id, same name 'B'.
  e.markOffline('p1');
  const rc = e.addPlayer('newconn-xyz', 'B', { isHost: false });
  ok(rc.ok && rc.reconnected, 'reconnect by name succeeds mid-game');
  ok(!('p1' in e.votes) && e.votes['newconn-xyz'] === true, 'vote remapped to new id');
  ok(e.proposal.members.includes('newconn-xyz') && !e.proposal.members.includes('p1'),
     'proposal members remapped to new id');
  eq(e.privateStateFor('newconn-xyz').hasVoted, true, 'reconnected player still counted as voted');
}

// --- Cleric: learns the first Quest Leader's loyalty ----------------------
{
  const players = [
    { id: 'a', name: 'A', roleId: 'cleric' },
    { id: 'b', name: 'B', roleId: 'assassin' },
    { id: 'c', name: 'C', roleId: 'merlin' },
    { id: 'd', name: 'D', roleId: 'servant' },
    { id: 'e', name: 'E', roleId: 'servant' },
  ];
  // First leader is the Assassin (evil).
  const evilLeader = computeKnowledge(players[0], players, { firstLeaderId: 'b' });
  eq(evilLeader.sees.map(s => s.id), ['b'], 'Cleric sees the first leader');
  ok(/EVIL/.test(evilLeader.seesLabel), 'Cleric told first leader is EVIL');
  // First leader is a Servant (good).
  const goodLeader = computeKnowledge(players[0], players, { firstLeaderId: 'd' });
  ok(/GOOD/.test(goodLeader.seesLabel), 'Cleric told first leader is GOOD');
  // No leader info yet -> graceful fallback, no leak.
  eq(computeKnowledge(players[0], players).sees, [], 'Cleric without leader info sees nobody');

  // End-to-end: startGame fixes firstLeaderId and the Cleric's reveal matches.
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, cleric: 1, servant: 1, minion: 1 });
  ok(e.startGame().ok, 'startGame with Cleric ok');
  ok(e.firstLeaderId === e.players[e.leaderIndex].id, 'firstLeaderId captured at start');
  const cleric = e.players.find(p => p.roleId === 'cleric');
  const leaderRole = ROLES[e.getPlayer(e.firstLeaderId).roleId].team;
  const reveal = e.privateStateFor(cleric.id).knowledge;
  ok(reveal.seesLabel.includes(leaderRole === 'evil' ? 'EVIL' : 'GOOD'),
     'Cleric private reveal matches first leader loyalty');
  // firstLeaderId survives serialize/restore.
  const r = new GameEngine(); r.restore(e.serialize());
  eq(r.firstLeaderId, e.firstLeaderId, 'firstLeaderId survives restore');
}

// --- Untrustworthy Servant: Good, but appears Evil to Merlin ---------------
{
  const players = [
    { id: 'a', name: 'A', roleId: 'merlin' },
    { id: 'b', name: 'B', roleId: 'assassin' },
    { id: 'c', name: 'C', roleId: 'untrustworthy' },
    { id: 'd', name: 'D', roleId: 'servant' },
    { id: 'e', name: 'E', roleId: 'servant' },
  ];
  const merlinSees = computeKnowledge(players[0], players).sees.map(s => s.id).sort();
  eq(merlinSees, ['b', 'c'], 'Merlin sees Assassin AND the Untrustworthy Servant');
  eq(ROLES.untrustworthy.team, 'good', 'Untrustworthy Servant is on the Good team');
  // The assassin (evil) does NOT see the Untrustworthy Servant as a teammate.
  ok(!computeKnowledge(players[1], players).sees.map(s => s.id).includes('c'),
     'Evil does not see the Untrustworthy Servant');
}

// --- Lancelots: Good Lancelot may Fail; must be paired ---------------------
{
  ok(!validateRoleConfig({ merlin: 1, assassin: 1, lancelotGood: 1, servant: 1, minion: 1 }, 5).ok,
     'Good Lancelot without Evil Lancelot rejected');
  ok(validateRoleConfig({ merlin: 1, assassin: 1, lancelotGood: 1, lancelotEvil: 1, servant: 2, minion: 1 }, 7).ok,
     'Paired Lancelots config valid for 7p');

  const e = new GameEngine();
  seat(e, ['A', 'B', 'C', 'D', 'E']);
  e.phase = PHASES.QUEST;
  e.players[0].roleId = 'lancelotGood';
  e.players[1].roleId = 'servant';
  e.players[2].roleId = 'merlin';
  e.players[3].roleId = 'lancelotEvil';
  e.players[4].roleId = 'assassin';
  e.questIndex = 0;
  e.proposal = { leaderId: 'p0', members: ['p0', 'p1'] };
  e.questCards = {};
  ok(e.playQuestCard('p0', false).ok, 'Good Lancelot may play Fail');
  ok(!e.playQuestCard('p1', false).ok, 'A plain Good Servant still cannot Fail');
  eq(e.privateStateFor('p0').mayFail, true, 'Good Lancelot mayFail flag set');
}

// --- Proposal timer (host option) -----------------------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });

  // Off by default; clamps the chosen duration to the 1-5 minute window.
  ok(!e.questTimerEnabled, 'timer off by default');
  e.setQuestTimer(true, 30);   eq(e.questTimerSeconds, 60,  'clamps below 1 min up to 60s');
  e.setQuestTimer(true, 600);  eq(e.questTimerSeconds, 300, 'clamps above 5 min down to 300s');
  e.setQuestTimer(true, 180);  eq(e.questTimerSeconds, 180, 'accepts an in-range duration');

  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  eq(e.phase, PHASES.PROPOSAL, 'reached proposal');

  // Entering proposal arms a deadline; publicState exposes a positive remaining span.
  ok(e.proposalDeadline != null, 'proposal arms a deadline when timer enabled');
  const rem = e.publicState().proposalRemainingMs;
  ok(rem != null && rem > 0 && rem <= 180000, `remaining span within bounds (got ${rem})`);

  // Timing out passes leadership WITHOUT touching the reject track.
  const beforeLeader = e.leader.id;
  const beforeRejects = e.rejectCount;
  const t = e.proposalTimedOut();
  ok(t.ok, 'proposalTimedOut applies in proposal phase');
  eq(e.phase, PHASES.PROPOSAL, 'still in proposal after timeout');
  ok(e.leader.id !== beforeLeader, 'timeout advances leadership');
  eq(e.rejectCount, beforeRejects, 'timeout does NOT count as a reject');

  // Confirming a team stops the countdown; remaining span goes null off-phase.
  const need = teamSize(5, e.questIndex);
  e.proposeTeam(e.leader.id, e.players.slice(0, need).map(p => p.id));
  eq(e.proposalDeadline, null, 'confirming a team clears the deadline');
  eq(e.publicState().proposalRemainingMs, null, 'no remaining span outside proposal');

  // proposalTimedOut is a no-op outside the proposal phase.
  ok(!e.proposalTimedOut().ok, 'timeout ignored when not proposing');
}

// --- Proposal timer survives serialize/restore ----------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });
  e.setQuestTimer(true, 240);
  e.startGame();
  e.players.forEach(p => e.setReady(p.id));

  const e2 = new GameEngine();
  e2.restore(e.serialize());
  ok(e2.questTimerEnabled, 'timer-enabled flag round-trips');
  eq(e2.questTimerSeconds, 240, 'timer duration round-trips');
  // A reload mid-proposal refreshes the deadline rather than restoring a stale one.
  ok(e2.proposalDeadline != null && e2.proposalDeadline > Date.now(), 'restore refreshes a live proposal deadline');

  // playAgain keeps the host's timer preference.
  e.playAgain();
  ok(e.questTimerEnabled && e.questTimerSeconds === 240, 'playAgain preserves timer settings');
}

// --- Show-pending-voters option -------------------------------------------
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });

  ok(!e.showPendingVoters, 'pending-voters off by default');
  eq(e.publicState().showPendingVoters, false, 'flag exposed in publicState (off)');
  e.setShowPendingVoters(true);
  eq(e.publicState().showPendingVoters, true, 'flag exposed in publicState (on)');

  e.startGame();
  e.players.forEach(p => e.setReady(p.id));
  e.proposeTeam(e.leader.id, e.players.slice(0, teamSize(5, 0)).map(p => p.id));
  eq(e.phase, PHASES.VOTE, 'reached vote phase');

  // Two of five have voted: voteProgress marks exactly those, names resolvable.
  e.castVote('p0', true);
  e.castVote('p1', false);
  const prog = e.publicState().voteProgress;
  eq(prog.filter(x => x.voted).length, 2, 'voteProgress reflects 2 votes cast');
  eq(prog.filter(x => !x.voted).map(x => x.id).sort(), ['p2', 'p3', 'p4'], 'pending ids are the non-voters');

  // Round-trips through serialize/restore and survives playAgain.
  const e2 = new GameEngine();
  e2.restore(e.serialize());
  ok(e2.showPendingVoters, 'pending-voters flag round-trips');
  e2.playAgain();
  ok(e2.showPendingVoters, 'playAgain preserves pending-voters flag');
}

// --- Spectator privacy contract --------------------------------------------
// A spectator is never seated (no addPlayer), so the host derives their state
// from publicState() + privateStateFor(theirConnId). This locks in the two
// guarantees the spectator view relies on: an unseated id gets NO private slice,
// and mid-game publicState() never leaks roles/teams.
{
  const e = new GameEngine();
  seat(e, ['Host', 'B', 'C', 'D', 'E']);
  e.setConfig({ merlin: 1, assassin: 1, percival: 1, morgana: 1, servant: 1 });
  e.startGame();

  eq(e.privateStateFor('spectator-conn'), null, 'unseated id gets null private state');
  e.markOffline('spectator-conn'); // must be a harmless no-op for a non-player
  eq(e.count, 5, 'spectator id never affects player count');

  const pubReveal = e.publicState();
  ok(pubReveal.players.every(p => !('roleId' in p) && !('team' in p) && !('role' in p)),
    'mid-game publicState exposes no roles/teams (safe for spectators)');
  eq(pubReveal.reveal, undefined, 'no full reveal before game over');

  // After game over the reveal becomes public — spectators may then see roles.
  e.players.forEach(p => e.setReady(p.id));
  for (let q = 0; q < 3; q++) {
    const need = teamSize(5, e.questIndex);
    e.proposeTeam(e.leader.id, e.players.slice(0, need).map(p => p.id));
    approveAll(e);
    runQuestAllSuccess(e);
  }
  // Good completed 3 quests → assassination; a wrong guess ends the game.
  const wrong = e.players.find(p => p.roleId !== 'merlin' && ROLES[p.roleId].team === 'good');
  e.assassinate(e.players.find(p => p.roleId === 'assassin').id, wrong.id);
  eq(e.phase, PHASES.GAMEOVER, 'game reached game over');
  ok(Array.isArray(e.publicState().reveal), 'full reveal present at game over');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
