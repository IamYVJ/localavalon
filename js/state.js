// ============================================================================
// state.js — Host-authoritative game engine for Avalon.
//
// ONLY the host runs this. It owns the entire authoritative state, validates
// every client intent, mutates state, and produces:
//   - publicState():        broadcast to everyone (never contains secret roles
//                           until game over)
//   - privateStateFor(id):  the slice ONE player is entitled to see
//
// Pure rule logic lives in rules.js; this file is the state machine + guards.
// ============================================================================

import {
  ROLES, TEAM_SIZES, MIN_PLAYERS, MAX_PLAYERS, MAX_REJECTS, QUESTS_TO_WIN,
  teamSize, failThreshold, validateRoleConfig, buildRoleDeck, shuffle,
  computeKnowledge, defaultRoleConfig,
} from './rules.js';

export const PHASES = {
  LOBBY: 'lobby',
  ROLE_REVEAL: 'roleReveal',
  PROPOSAL: 'proposal',
  VOTE: 'vote',
  QUEST: 'quest',
  ASSASSINATION: 'assassination',
  GAMEOVER: 'gameover',
};

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;
    this.players = [];          // seat-ordered: { id, name, online, roleId, ready }
    this.hostId = null;
    this.config = null;         // role config map { roleId: count }
    this.allowReveal = false;   // host option: let players re-check their role mid-game
    this.leaderIndex = 0;
    this.questIndex = 0;        // 0-based current quest
    this.questResults = [null, null, null, null, null]; // 'success' | 'fail' | null
    this.rejectCount = 0;
    this.proposal = null;       // { leaderId, members:[ids] }
    this.votes = {};            // playerId -> bool (approve)
    this.revealedVotes = null;  // frozen snapshot once everyone has voted
    this.questCards = {};       // playerId -> bool (success)
    this.lastQuestFails = null; // fail count of the most recent quest
    this.assassinTargetId = null;
    this.winner = null;         // 'good' | 'evil'
    this.winReason = null;
  }

  // -------------------------------------------------------------------------
  // Roster management
  // -------------------------------------------------------------------------

  /** Seat a player, or let them reclaim their seat on reconnect (same name). */
  addPlayer(id, name, { isHost = false } = {}) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, error: 'Name required.' };

    // Reconnect: a known name that is currently offline reclaims its seat+role.
    const existing = this.players.find(
      p => p.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      if (existing.online) {
        return { ok: false, error: `The name "${trimmed}" is already taken.` };
      }
      const oldId = existing.id;
      existing.online = true;
      existing.id = id; // new connection id reclaims the seat
      if (oldId !== id) this._remapPlayerId(oldId, id); // fix mid-game id-keyed state
      if (isHost) this.hostId = id;
      return { ok: true, player: existing, reconnected: true };
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'Game already started — cannot join.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: 'Game is full (10 players max).' };
    }

    const player = { id, name: trimmed, online: true, roleId: null, ready: false };
    this.players.push(player);
    if (isHost) this.hostId = id;
    return { ok: true, player };
  }

  /**
   * A reconnecting player gets a brand-new PeerJS connection id, so every place
   * that keys state by player id (votes, quest cards, proposals, leadership,
   * assassination) must be migrated from the old id to the new one — otherwise
   * a mid-game reload would orphan that player's vote/card and stall the round.
   */
  _remapPlayerId(oldId, newId) {
    if (oldId === newId) return;
    if (this.hostId === oldId) this.hostId = newId;
    if (this.assassinTargetId === oldId) this.assassinTargetId = newId;
    if (oldId in this.votes) { this.votes[newId] = this.votes[oldId]; delete this.votes[oldId]; }
    if (oldId in this.questCards) { this.questCards[newId] = this.questCards[oldId]; delete this.questCards[oldId]; }
    if (this.proposal) {
      if (this.proposal.leaderId === oldId) this.proposal.leaderId = newId;
      if (Array.isArray(this.proposal.members)) {
        this.proposal.members = this.proposal.members.map(m => (m === oldId ? newId : m));
      }
    }
    if (Array.isArray(this.revealedVotes)) {
      for (const r of this.revealedVotes) if (r.id === oldId) r.id = newId;
    }
  }

  markOffline(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    p.online = false;
    // In the lobby, drop the seat entirely so the roster stays clean.
    if (this.phase === PHASES.LOBBY) {
      this.players = this.players.filter(x => x.id !== id);
    }
  }

  getPlayer(id) { return this.players.find(p => p.id === id); }
  get count() { return this.players.length; }
  get leader() { return this.players[this.leaderIndex] || null; }

  // -------------------------------------------------------------------------
  // Lobby / config
  // -------------------------------------------------------------------------

  setConfig(cfg) { this.config = cfg; }

  /** Host toggle: when true, players may re-view their own role any time. */
  setAllowReveal(v) { this.allowReveal = !!v; }

  /** Convenience used by the UI when player count changes in the lobby. */
  ensureConfig() {
    if (!this.config && ROLE_COUNTS_OK(this.count)) {
      this.config = defaultRoleConfig(this.count);
    }
  }

  startGame() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Already started.' };
    if (this.count < MIN_PLAYERS || this.count > MAX_PLAYERS) {
      return { ok: false, error: `Need ${MIN_PLAYERS}-${MAX_PLAYERS} players.` };
    }
    const v = validateRoleConfig(this.config || {}, this.count);
    if (!v.ok) return { ok: false, error: v.errors.join(' ') };

    // Deal roles to seats.
    const deck = shuffle(buildRoleDeck(this.config));
    this.players.forEach((p, i) => { p.roleId = deck[i]; p.ready = false; });

    this.phase = PHASES.ROLE_REVEAL;
    return { ok: true };
  }

  setReady(id) {
    const p = this.getPlayer(id);
    if (!p || this.phase !== PHASES.ROLE_REVEAL) return;
    p.ready = true;
    if (this.players.every(x => x.ready)) this._beginProposal();
  }

  // -------------------------------------------------------------------------
  // Round flow
  // -------------------------------------------------------------------------

  _beginProposal() {
    this.phase = PHASES.PROPOSAL;
    this.proposal = null;
    this.votes = {};
    this.revealedVotes = null;
    this.questCards = {};
  }

  /** Advance leadership clockwise to the next ONLINE seat. */
  _advanceLeader() {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.leaderIndex + step) % n;
      if (this.players[idx].online) { this.leaderIndex = idx; return; }
    }
    this.leaderIndex = (this.leaderIndex + 1) % n; // fallback (all offline)
  }

  proposeTeam(leaderId, members) {
    if (this.phase !== PHASES.PROPOSAL) return { ok: false, error: 'Not the proposal phase.' };
    if (!this.leader || this.leader.id !== leaderId) {
      return { ok: false, error: 'Only the current Leader may propose.' };
    }
    const need = teamSize(this.count, this.questIndex);
    const unique = [...new Set(members)];
    if (unique.length !== need) {
      return { ok: false, error: `Team must have exactly ${need} players.` };
    }
    if (!unique.every(mid => this.getPlayer(mid))) {
      return { ok: false, error: 'Team includes an unknown player.' };
    }
    this.proposal = { leaderId, members: unique };
    this.phase = PHASES.VOTE;
    this.votes = {};
    this.revealedVotes = null;
    return { ok: true };
  }

  castVote(id, approve) {
    if (this.phase !== PHASES.VOTE) return { ok: false, error: 'Not voting now.' };
    const p = this.getPlayer(id);
    if (!p) return { ok: false, error: 'Unknown player.' };
    if (id in this.votes) return { ok: false, error: 'You already voted.' };
    this.votes[id] = !!approve;
    this._resolveVotesIfComplete();
    return { ok: true };
  }

  /** Everyone ONLINE must have voted before we reveal. */
  _resolveVotesIfComplete() {
    const onlineIds = this.players.filter(p => p.online).map(p => p.id);
    if (!onlineIds.every(id => id in this.votes)) return;

    // Freeze the per-player tally for public reveal.
    this.revealedVotes = this.players.map(p => ({
      id: p.id, name: p.name, vote: this.votes[p.id] === undefined ? null : this.votes[p.id],
    }));

    // Strict majority of SEATED players approves.
    const approves = Object.values(this.votes).filter(v => v).length;
    const approved = approves * 2 > this.players.length;

    this._lastVoteApproved = approved;
    // The reveal lingers on screen; UI calls acknowledgeVote() to continue.
    this._voteResolved = true;
  }

  /** Called after the public vote reveal has been shown. */
  acknowledgeVote() {
    if (this.phase !== PHASES.VOTE || !this._voteResolved) return;
    this._voteResolved = false;

    if (this._lastVoteApproved) {
      this.rejectCount = 0;
      this.phase = PHASES.QUEST;
      this.questCards = {};
    } else {
      this.rejectCount += 1;
      if (this.rejectCount >= MAX_REJECTS) {
        return this._endGame('evil', `${MAX_REJECTS} proposals rejected in one quest.`);
      }
      this._advanceLeader();
      this._beginProposal();
    }
  }

  playQuestCard(id, success) {
    if (this.phase !== PHASES.QUEST) return { ok: false, error: 'No quest in progress.' };
    if (!this.proposal.members.includes(id)) {
      return { ok: false, error: 'You are not on this quest.' };
    }
    if (id in this.questCards) return { ok: false, error: 'You already played a card.' };

    const player = this.getPlayer(id);
    // Good players may only play Success. Enforce server-side too.
    if (ROLES[player.roleId].team === 'good' && success === false) {
      return { ok: false, error: 'Good players must play Success.' };
    }
    // Lunatic must always Fail; Brute may only Fail on quests 1-3.
    if (player.roleId === 'lunatic' && success === true) {
      return { ok: false, error: 'The Lunatic must play Fail.' };
    }
    if (player.roleId === 'brute' && success === false && this.questIndex >= 3) {
      return { ok: false, error: 'The Brute can only fail quests 1-3.' };
    }
    this.questCards[id] = !!success;
    this._resolveQuestIfComplete();
    return { ok: true };
  }

  _resolveQuestIfComplete() {
    const members = this.proposal.members;
    if (!members.every(id => id in this.questCards)) return;

    const fails = members.filter(id => this.questCards[id] === false).length;
    const threshold = failThreshold(this.count, this.questIndex);
    const failed = fails >= threshold;

    // Record the result and HOLD on a reveal beat. The host calls
    // acknowledgeQuest() (after a delay) to score it and advance.
    this.questResults[this.questIndex] = failed ? 'fail' : 'success';
    this.lastQuestFails = fails;
    this._questResolved = true;
  }

  /** Called after the public quest reveal has been shown. */
  acknowledgeQuest() {
    if (this.phase !== PHASES.QUEST || !this._questResolved) return;
    this._questResolved = false;

    const successCount = this.questResults.filter(r => r === 'success').length;
    const failCount = this.questResults.filter(r => r === 'fail').length;

    if (failCount >= QUESTS_TO_WIN) {
      return this._endGame('evil', `${QUESTS_TO_WIN} quests failed.`);
    }
    if (successCount >= QUESTS_TO_WIN) {
      // Good completed the track — Assassin gets a shot at Merlin.
      const hasAssassin = this.players.some(p => p.roleId === 'assassin');
      if (hasAssassin) { this.phase = PHASES.ASSASSINATION; return; }
      return this._endGame('good', `${QUESTS_TO_WIN} quests succeeded.`);
    }

    // Continue to the next quest.
    this.questIndex += 1;
    this._advanceLeader();
    this._beginProposal();
  }

  assassinate(actorId, targetId) {
    if (this.phase !== PHASES.ASSASSINATION) return { ok: false, error: 'Not the assassination phase.' };
    const actor = this.getPlayer(actorId);
    if (!actor || actor.roleId !== 'assassin') {
      return { ok: false, error: 'Only the Assassin may strike.' };
    }
    const target = this.getPlayer(targetId);
    if (!target) return { ok: false, error: 'Unknown target.' };

    this.assassinTargetId = targetId;
    if (target.roleId === 'merlin') {
      this._endGame('evil', `The Assassin found Merlin (${target.name}).`);
    } else {
      this._endGame('good', `The Assassin missed — ${target.name} was not Merlin.`);
    }
    return { ok: true };
  }

  _endGame(winner, reason) {
    this.winner = winner;
    this.winReason = reason;
    this.phase = PHASES.GAMEOVER;
  }

  /** Re-lobby keeping the same players and role config. */
  playAgain() {
    const players = this.players.map(p => ({ ...p, roleId: null, ready: false }));
    const config = this.config;
    const hostId = this.hostId;
    const allowReveal = this.allowReveal;
    this.reset();
    this.players = players;
    this.config = config;
    this.hostId = hostId;
    this.allowReveal = allowReveal;
  }

  // -------------------------------------------------------------------------
  // Snapshot / restore — lets a HOST reload rehydrate the in-progress game.
  // -------------------------------------------------------------------------

  serialize() {
    return JSON.parse(JSON.stringify({
      phase: this.phase,
      players: this.players,
      hostId: this.hostId,
      config: this.config,
      allowReveal: this.allowReveal,
      leaderIndex: this.leaderIndex,
      questIndex: this.questIndex,
      questResults: this.questResults,
      rejectCount: this.rejectCount,
      proposal: this.proposal,
      votes: this.votes,
      revealedVotes: this.revealedVotes,
      questCards: this.questCards,
      lastQuestFails: this.lastQuestFails,
      assassinTargetId: this.assassinTargetId,
      winner: this.winner,
      winReason: this.winReason,
      _voteResolved: !!this._voteResolved,
      _lastVoteApproved: this._lastVoteApproved ?? null,
      _questResolved: !!this._questResolved,
    }));
  }

  restore(s) {
    if (!s) return;
    this.reset();
    Object.assign(this, {
      phase: s.phase ?? PHASES.LOBBY,
      players: Array.isArray(s.players) ? s.players : [],
      hostId: s.hostId ?? null,
      config: s.config ?? null,
      allowReveal: !!s.allowReveal,
      leaderIndex: s.leaderIndex ?? 0,
      questIndex: s.questIndex ?? 0,
      questResults: s.questResults ?? [null, null, null, null, null],
      rejectCount: s.rejectCount ?? 0,
      proposal: s.proposal ?? null,
      votes: s.votes ?? {},
      revealedVotes: s.revealedVotes ?? null,
      questCards: s.questCards ?? {},
      lastQuestFails: s.lastQuestFails ?? null,
      assassinTargetId: s.assassinTargetId ?? null,
      winner: s.winner ?? null,
      winReason: s.winReason ?? null,
      _voteResolved: !!s._voteResolved,
      _lastVoteApproved: s._lastVoteApproved ?? null,
      _questResolved: !!s._questResolved,
    });
    // Everyone is offline until their connection re-establishes after reload.
    this.players.forEach(p => { p.online = (p.id === this.hostId); });
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  publicState() {
    const need = (this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAMEOVER)
      ? teamSize(this.count, this.questIndex) : null;

    const state = {
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map((p, i) => ({
        id: p.id, name: p.name, online: p.online,
        isLeader: i === this.leaderIndex && this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAMEOVER,
        isHost: p.id === this.hostId,
      })),
      questResults: this.questResults,
      questSizes: this.count >= MIN_PLAYERS ? TEAM_SIZES[this.count] : null,
      currentQuest: this.questIndex,
      requiredTeamSize: need,
      failThreshold: (need !== null) ? failThreshold(this.count, this.questIndex) : null,
      rejectCount: this.rejectCount,
      maxRejects: MAX_REJECTS,
      leaderId: this.leader ? this.leader.id : null,
      proposal: this.proposal ? { leaderId: this.proposal.leaderId, members: this.proposal.members } : null,
      // Live vote progress (who has voted, not how) until the reveal.
      voteProgress: this.phase === PHASES.VOTE
        ? this.players.filter(p => p.online).map(p => ({ id: p.id, voted: p.id in this.votes }))
        : null,
      revealedVotes: this.revealedVotes,
      voteResolved: !!this._voteResolved,
      lastVoteApproved: this._voteResolved ? this._lastVoteApproved : null,
      questProgress: this.phase === PHASES.QUEST && this.proposal
        ? this.proposal.members.map(id => ({ id, played: id in this.questCards }))
        : null,
      questResolved: !!this._questResolved,
      lastQuestFails: this.lastQuestFails,
      lastQuestResult: (this._questResolved) ? this.questResults[this.questIndex] : null,
      config: this.config,
      allowReveal: this.allowReveal,
      readyCount: this.players.filter(p => p.ready).length,
      playerCount: this.players.length,
    };

    if (this.phase === PHASES.GAMEOVER) {
      state.winner = this.winner;
      state.winReason = this.winReason;
      state.assassinTargetId = this.assassinTargetId;
      // Full reveal once the game is over.
      state.reveal = this.players.map(p => ({
        id: p.id, name: p.name, roleId: p.roleId,
        roleName: ROLES[p.roleId] ? ROLES[p.roleId].name : '—',
        team: ROLES[p.roleId] ? ROLES[p.roleId].team : null,
      }));
    }
    return state;
  }

  privateStateFor(id) {
    const p = this.getPlayer(id);
    if (!p) return null;
    const priv = { playerId: id, name: p.name, ready: p.ready };

    if (p.roleId) {
      const role = ROLES[p.roleId];
      priv.role = { id: role.id, name: role.name, team: role.team, blurb: role.blurb };
      priv.knowledge = computeKnowledge(
        { id: p.id, name: p.name, roleId: p.roleId },
        this.players.map(x => ({ id: x.id, name: x.name, roleId: x.roleId }))
      );
    }

    // Phase-specific private affordances.
    if (this.phase === PHASES.VOTE) {
      priv.hasVoted = id in this.votes;
    }
    if (this.phase === PHASES.QUEST && this.proposal) {
      priv.onQuest = this.proposal.members.includes(id);
      priv.hasPlayedCard = id in this.questCards;
      const isEvil = p.roleId && ROLES[p.roleId].team === 'evil';
      // Lunatic is compelled to Fail; Brute can't Fail on quests 4-5.
      priv.mustFail = priv.onQuest && p.roleId === 'lunatic';
      let mayFail = priv.onQuest && isEvil;
      if (p.roleId === 'brute' && this.questIndex >= 3) mayFail = false;
      priv.mayFail = mayFail;
    }
    if (this.phase === PHASES.ASSASSINATION && p.roleId === 'assassin') {
      priv.isAssassin = true;
      // Candidates = everyone except the assassin and his known evil teammates.
      const knownEvil = new Set((priv.knowledge?.sees || []).map(s => s.id));
      priv.assassinTargets = this.players
        .filter(x => x.id !== id && !knownEvil.has(x.id))
        .map(x => ({ id: x.id, name: x.name }));
    }
    return priv;
  }
}

// Small guard used by ensureConfig without importing the whole table check.
function ROLE_COUNTS_OK(n) { return n >= MIN_PLAYERS && n <= MAX_PLAYERS; }
