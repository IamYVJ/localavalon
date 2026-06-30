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
  computeKnowledge, describeRole, defaultRoleConfig,
} from './rules.js';

export const PHASES = {
  LOBBY: 'lobby',
  ROLE_REVEAL: 'roleReveal',
  PROPOSAL: 'proposal',
  VOTE: 'vote',
  QUEST: 'quest',
  LADY: 'lady',                 // Lady of the Lake: a loyalty inspection between quests
  ASSASSINATION: 'assassination',
  GAMEOVER: 'gameover',
};

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;
    this.players = [];          // seat-ordered: { id, name, online, roleId, ready }
    this.spectators = [];       // watch-only, no seat/role/vote: { id, name, online, clientId }
    this.hostId = null;
    this.config = null;         // role config map { roleId: count }
    this.allowReveal = false;   // host option: let players re-check their role mid-game
    this.randomLeaderOrder = false; // host option: shuffle leader traversal order each game
    this.questTimerEnabled = false; // host option: countdown for each team-proposal round
    this.questTimerSeconds = 120;   // chosen duration, clamped to 60-300 (1-5 minutes)
    this.proposalDeadline = null;   // absolute host-clock ms when the current proposal expires
    this.showPendingVoters = false; // host option: reveal who still owes a vote during the team vote
    this.ladyEnabled = false;   // host option: Lady of the Lake loyalty inspection between quests
    this.ladyHolderId = null;   // id of the player currently holding the Lady token
    this.ladyHistory = [];      // ids who have ever held the token (can't be inspected again)
    this.ladyResult = null;     // { holderId, targetId, team } — SECRET, only the holder may see it
    this.leaderIndex = 0;
    this.leaderOrder = null;    // null = sequential; array of seat indices = shuffled order
    this.leaderOrderPos = 0;    // current position within leaderOrder
    this.firstLeaderId = null;  // id of the first Quest Leader (the Cleric learns their loyalty)
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

  /**
   * Seat a player, or let them reclaim their seat on reconnect.
   *
   * Reclaim precedence:
   *   1. Stable clientId (same device) — reclaims even if the seat still shows
   *      ONLINE. This is essential: mobile WebRTC is slow/unreliable at noticing
   *      a dropped channel, so a reconnecting player often arrives while the host
   *      still thinks their old connection is live. Keying off the device id
   *      (not the stale online flag) is what makes rejoin actually work and
   *      keeps a game from stalling on a "present" player who's really gone.
   *   2. Name match (only when that seat is OFFLINE) — fallback for clients with
   *      no stored clientId, or a same-name rejoin from a different device.
   */
  addPlayer(id, name, { isHost = false, clientId = null } = {}) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, error: 'Name required.' };

    // (1) Same device reconnecting — match by clientId regardless of online.
    let existing = clientId
      ? this.players.find(p => p.clientId && p.clientId === clientId)
      : null;

    // (2) Fall back to name match, but only reclaim an OFFLINE seat — an online
    // seat with this name belongs to a different, currently-connected device.
    if (!existing) {
      const byName = this.players.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
      if (byName) {
        if (byName.online) {
          return { ok: false, error: `The name "${trimmed}" is already taken.` };
        }
        existing = byName;
      }
    }

    if (existing) {
      const oldId = existing.id;
      existing.online = true;
      existing.id = id;                       // new connection id reclaims the seat
      if (clientId) existing.clientId = clientId; // remember/refresh the device id
      if (trimmed) existing.name = trimmed;   // honour a (re)typed display name
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

    const player = { id, name: trimmed, online: true, roleId: null, ready: false, clientId: clientId || null };
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
    if (this.ladyHolderId === oldId) this.ladyHolderId = newId;
    if (Array.isArray(this.ladyHistory)) {
      this.ladyHistory = this.ladyHistory.map(h => (h === oldId ? newId : h));
    }
    if (this.ladyResult) {
      if (this.ladyResult.holderId === oldId) this.ladyResult.holderId = newId;
      if (this.ladyResult.targetId === oldId) this.ladyResult.targetId = newId;
    }
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

  /**
   * Register a watch-only spectator (no seat, role, vote, or ready state).
   * Unlike players, spectators may arrive in any phase and have no name-
   * uniqueness rule. Dedupe on reconnect by stable clientId first, then by
   * connection id, so a spectator who drops and returns flips back to online
   * instead of stacking duplicate entries.
   */
  addSpectator(id, name, { clientId = null } = {}) {
    const trimmed = (name || '').trim() || 'Spectator';
    let existing = clientId
      ? this.spectators.find(s => s.clientId && s.clientId === clientId)
      : null;
    if (!existing) existing = this.spectators.find(s => s.id === id);
    if (existing) {
      existing.online = true;
      existing.id = id;
      if (clientId) existing.clientId = clientId;
      existing.name = trimmed;
      return { ok: true, spectator: existing, reconnected: true };
    }
    const spectator = { id, name: trimmed, online: true, clientId: clientId || null };
    this.spectators.push(spectator);
    return { ok: true, spectator };
  }

  markOffline(id) {
    const p = this.players.find(x => x.id === id);
    if (p) {
      p.online = false;
      // In the lobby, drop the seat entirely so the roster stays clean.
      if (this.phase === PHASES.LOBBY) {
        this.players = this.players.filter(x => x.id !== id);
      }
      return;
    }
    // Spectators aren't seated: just flag offline (publicState hides offline
    // spectators) and keep the record so a reconnect dedupes by clientId.
    const s = this.spectators.find(x => x.id === id);
    if (s) s.online = false;
  }

  /**
   * Host-initiated removal of a player. LOBBY-ONLY by design: kicking mid-game
   * would change the player count — and therefore the role deal, vote maths, and
   * quest team sizes — so it is refused once play has started. The host cannot
   * remove themselves. Transports notify the kicked client separately.
   */
  kickPlayer(byId, targetId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Players can only be removed in the lobby.' };
    if (byId !== this.hostId) return { ok: false, error: 'Only the host may remove players.' };
    if (targetId === this.hostId) return { ok: false, error: 'The host cannot be removed.' };
    const before = this.players.length;
    this.players = this.players.filter(p => p.id !== targetId);
    if (this.players.length === before) return { ok: false, error: 'No such player.' };
    return { ok: true };
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

  /** Host toggle: when true, leader order is shuffled each game instead of sequential. */
  setRandomLeaderOrder(v) { this.randomLeaderOrder = !!v; }

  /**
   * Host toggle: a countdown for each team-proposal round. `seconds` is clamped
   * to the 60-300 (1-5 minute) range. When enabled, every proposal phase starts
   * a fresh deadline; if the leader doesn't confirm in time the host advances
   * leadership (see proposalTimedOut).
   */
  setQuestTimer(enabled, seconds) {
    this.questTimerEnabled = !!enabled;
    if (typeof seconds === 'number' && isFinite(seconds)) {
      this.questTimerSeconds = Math.min(300, Math.max(60, Math.round(seconds)));
    }
  }

  /** Host toggle: surface the names of players who still owe a team vote. */
  setShowPendingVoters(v) { this.showPendingVoters = !!v; }

  /**
   * Host toggle: Lady of the Lake. When enabled, after quests 2, 3, and 4 the
   * current token holder privately inspects one player's loyalty (good/evil),
   * then passes the token to that player. Best with 7+ players.
   */
  setLadyEnabled(v) { this.ladyEnabled = !!v; }

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

    // Generate leader traversal order (shuffled or sequential).
    if (this.randomLeaderOrder) {
      const indices = this.players.map((_, i) => i);
      this.leaderOrder = shuffle(indices);
      this.leaderOrderPos = 0;
      this.leaderIndex = this.leaderOrder[0];
    } else {
      this.leaderOrder = null;
      this.leaderOrderPos = 0;
      this.leaderIndex = 0;
    }

    // Snapshot who leads the first quest — the Cleric's reveal depends on it,
    // so it must stay fixed even after leadership rotates.
    this.firstLeaderId = this.players[this.leaderIndex] ? this.players[this.leaderIndex].id : null;

    // Lady of the Lake traditionally starts to the RIGHT of the first leader
    // (the player just before them in seat order), so the token travels back
    // toward the early leaders. Seed the history with that holder.
    if (this.ladyEnabled) {
      const n = this.players.length;
      const startIdx = (this.leaderIndex - 1 + n) % n;
      this.ladyHolderId = this.players[startIdx] ? this.players[startIdx].id : null;
      this.ladyHistory = this.ladyHolderId ? [this.ladyHolderId] : [];
    } else {
      this.ladyHolderId = null;
      this.ladyHistory = [];
    }

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
    // Arm the per-proposal countdown (if the host enabled it).
    this.proposalDeadline = this.questTimerEnabled
      ? Date.now() + this.questTimerSeconds * 1000
      : null;
  }

  /**
   * Host-only: the proposal timer elapsed before the leader confirmed a team.
   * Pass leadership to the next player and start a fresh proposal. This is
   * deliberately NON-punitive — it does not count against the reject track, so
   * a slow leader can't accidentally hand evil the game.
   */
  proposalTimedOut() {
    if (this.phase !== PHASES.PROPOSAL) return { ok: false };
    this._advanceLeader();
    this._beginProposal();
    return { ok: true };
  }

  /** Advance leadership to the next player (sequential or shuffled order). */
  _advanceLeader() {
    const n = this.players.length;

    if (this.leaderOrder) {
      // Shuffled order: walk through the permutation, skipping offline players.
      const len = this.leaderOrder.length;
      for (let step = 1; step <= len; step++) {
        const pos = (this.leaderOrderPos + step) % len;
        const idx = this.leaderOrder[pos];
        if (this.players[idx] && this.players[idx].online) {
          this.leaderOrderPos = pos;
          this.leaderIndex = idx;
          return;
        }
      }
      // Fallback (all offline): just advance position.
      this.leaderOrderPos = (this.leaderOrderPos + 1) % len;
      this.leaderIndex = this.leaderOrder[this.leaderOrderPos];
    } else {
      // Sequential (clockwise): skip offline players.
      for (let step = 1; step <= n; step++) {
        const idx = (this.leaderIndex + step) % n;
        if (this.players[idx].online) { this.leaderIndex = idx; return; }
      }
      this.leaderIndex = (this.leaderIndex + 1) % n;
    }
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
    this.proposalDeadline = null; // team locked in — stop the countdown
    return { ok: true };
  }

  castVote(id, approve) {
    if (this.phase !== PHASES.VOTE) return { ok: false, error: 'Not voting now.' };
    const p = this.getPlayer(id);
    if (!p) return { ok: false, error: 'Unknown player.' };
    // Once all votes are in and revealed, no more changes allowed.
    if (this._voteResolved) return { ok: false, error: 'Voting is closed.' };
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
    // Good players may only play Success — except the Good Lancelot, who is
    // explicitly permitted to sabotage. Enforce server-side too.
    if (ROLES[player.roleId].team === 'good' && success === false && player.roleId !== 'lancelotGood') {
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

    // Continue — but first run Lady of the Lake if it's due (after quests 2-4).
    if (this._shouldRunLady()) {
      this.phase = PHASES.LADY;
      this.ladyResult = null;
      this._ladyResolved = false;
      return;
    }
    this._beginNextQuest();
  }

  /** Advance the quest counter, rotate leadership, and open a fresh proposal. */
  _beginNextQuest() {
    this.questIndex += 1;
    this._advanceLeader();
    this._beginProposal();
  }

  // -------------------------------------------------------------------------
  // Lady of the Lake — a between-quests loyalty inspection
  // -------------------------------------------------------------------------

  /**
   * True when the Lady should trigger now. The inspection happens AFTER quests
   * 2, 3, and 4 resolve — i.e. when questIndex is 1, 2, or 3 (0-based) and we're
   * about to move on. Requires the option on, a live holder, and at least one
   * eligible (never-held) player other than the holder to inspect.
   */
  _shouldRunLady() {
    if (!this.ladyEnabled || !this.ladyHolderId) return false;
    if (this.questIndex < 1 || this.questIndex > 3) return false;
    return this.players.some(p => p.id !== this.ladyHolderId && !this.ladyHistory.includes(p.id));
  }

  /**
   * The token holder inspects a target's true loyalty. The result is recorded
   * privately (only the holder ever sees the team) and the phase holds on a
   * reveal beat until acknowledgeLady() passes the token on.
   */
  useLady(holderId, targetId) {
    if (this.phase !== PHASES.LADY) return { ok: false, error: 'Not the Lady phase.' };
    if (this._ladyResolved) return { ok: false, error: 'You have already looked.' };
    if (holderId !== this.ladyHolderId) return { ok: false, error: 'Only the Lady holder may inspect.' };
    if (targetId === holderId) return { ok: false, error: 'You cannot inspect yourself.' };
    if (this.ladyHistory.includes(targetId)) {
      return { ok: false, error: 'That player has already held the Lady.' };
    }
    const target = this.getPlayer(targetId);
    if (!target) return { ok: false, error: 'Unknown target.' };

    this.ladyResult = { holderId, targetId, team: ROLES[target.roleId].team };
    this._ladyResolved = true;
    return { ok: true };
  }

  /**
   * After the holder has seen the loyalty result, pass the token to the
   * inspected player and continue to the next quest.
   */
  acknowledgeLady(holderId) {
    if (this.phase !== PHASES.LADY || !this._ladyResolved) return { ok: false };
    if (holderId !== this.ladyHolderId) return { ok: false };
    this._passLadyToken();
    this._beginNextQuest();
    return { ok: true };
  }

  /**
   * Host escape hatch: skip the inspection (e.g. the holder went AWOL). If the
   * holder had already looked, still pass the token to that target; otherwise
   * the token stays put and the game simply moves on.
   */
  skipLady(byId) {
    if (this.phase !== PHASES.LADY) return { ok: false };
    if (byId !== this.hostId) return { ok: false, error: 'Only the host may skip.' };
    if (this._ladyResolved && this.ladyResult) this._passLadyToken();
    else { this.ladyResult = null; this._ladyResolved = false; }
    this._beginNextQuest();
    return { ok: true };
  }

  /** Move the token to the inspected player and clear the pending result. */
  _passLadyToken() {
    if (this.ladyResult && this.ladyResult.targetId) {
      this.ladyHolderId = this.ladyResult.targetId;
      if (!this.ladyHistory.includes(this.ladyHolderId)) this.ladyHistory.push(this.ladyHolderId);
    }
    this.ladyResult = null;
    this._ladyResolved = false;
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

  /**
   * Host-only: abort the current game at any phase and return everyone to the
   * lobby, keeping the seated players, role config, and game options intact so
   * a new game can be set up immediately. Mechanically identical to playAgain()
   * (which is the gameover path) — kept as a named method for clarity at the
   * call site and so it can diverge later if needed.
   */
  endGame() { this.playAgain(); }

  /** Re-lobby keeping the same players and role config. */
  playAgain() {
    const players = this.players.map(p => ({ ...p, roleId: null, ready: false }));
    const config = this.config;
    const hostId = this.hostId;
    const allowReveal = this.allowReveal;
    const randomLeaderOrder = this.randomLeaderOrder;
    const questTimerEnabled = this.questTimerEnabled;
    const questTimerSeconds = this.questTimerSeconds;
    const showPendingVoters = this.showPendingVoters;
    const ladyEnabled = this.ladyEnabled;
    this.reset();
    this.players = players;
    this.config = config;
    this.hostId = hostId;
    this.allowReveal = allowReveal;
    this.randomLeaderOrder = randomLeaderOrder;
    this.questTimerEnabled = questTimerEnabled;
    this.questTimerSeconds = questTimerSeconds;
    this.showPendingVoters = showPendingVoters;
    this.ladyEnabled = ladyEnabled;
  }

  // -------------------------------------------------------------------------
  // Snapshot / restore — lets a HOST reload rehydrate the in-progress game.
  // -------------------------------------------------------------------------

  serialize() {
    return JSON.parse(JSON.stringify({
      phase: this.phase,
      players: this.players,
      spectators: this.spectators,
      hostId: this.hostId,
      config: this.config,
      allowReveal: this.allowReveal,
      randomLeaderOrder: this.randomLeaderOrder,
      questTimerEnabled: this.questTimerEnabled,
      questTimerSeconds: this.questTimerSeconds,
      proposalDeadline: this.proposalDeadline,
      showPendingVoters: this.showPendingVoters,
      ladyEnabled: this.ladyEnabled,
      ladyHolderId: this.ladyHolderId,
      ladyHistory: this.ladyHistory,
      ladyResult: this.ladyResult,
      _ladyResolved: !!this._ladyResolved,
      leaderIndex: this.leaderIndex,
      leaderOrder: this.leaderOrder,
      leaderOrderPos: this.leaderOrderPos,
      firstLeaderId: this.firstLeaderId,
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
      spectators: Array.isArray(s.spectators) ? s.spectators : [],
      hostId: s.hostId ?? null,
      config: s.config ?? null,
      allowReveal: !!s.allowReveal,
      randomLeaderOrder: !!s.randomLeaderOrder,
      questTimerEnabled: !!s.questTimerEnabled,
      questTimerSeconds: s.questTimerSeconds ?? 120,
      proposalDeadline: s.proposalDeadline ?? null,
      showPendingVoters: !!s.showPendingVoters,
      ladyEnabled: !!s.ladyEnabled,
      ladyHolderId: s.ladyHolderId ?? null,
      ladyHistory: Array.isArray(s.ladyHistory) ? s.ladyHistory : [],
      ladyResult: s.ladyResult ?? null,
      _ladyResolved: !!s._ladyResolved,
      leaderIndex: s.leaderIndex ?? 0,
      leaderOrder: s.leaderOrder ?? null,
      leaderOrderPos: s.leaderOrderPos ?? 0,
      firstLeaderId: s.firstLeaderId ?? null,
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
    // Spectators have no host seat, so they're all offline until they reconnect
    // (publicState hides offline spectators; a reconnect dedupes by clientId).
    this.spectators.forEach(s => { s.online = false; });
    // A host reload landing mid-proposal would otherwise restore a deadline that
    // may already be in the past (firing the timeout instantly). Give the leader
    // a fresh window instead.
    if (this.phase === PHASES.PROPOSAL && this.questTimerEnabled) {
      this.proposalDeadline = Date.now() + this.questTimerSeconds * 1000;
    }
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
        // The round-1 leader is chosen before role reveal, but we must not
        // surface it (here or via leaderId below) until everyone has finished
        // viewing their secret role and readied up — otherwise the TV/spectator
        // screen would name the first leader while players are still in private
        // role reveal. The Cleric's "first leader loyalty" hint is unaffected:
        // it reads this.firstLeaderId directly (see privateStateFor), not this.
        isLeader: i === this.leaderIndex && this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAMEOVER && this.phase !== PHASES.ROLE_REVEAL,
        isHost: p.id === this.hostId,
      })),
      questResults: this.questResults,
      questSizes: this.count >= MIN_PLAYERS ? TEAM_SIZES[this.count] : null,
      currentQuest: this.questIndex,
      requiredTeamSize: need,
      failThreshold: (need !== null) ? failThreshold(this.count, this.questIndex) : null,
      rejectCount: this.rejectCount,
      maxRejects: MAX_REJECTS,
      leaderId: (this.leader && this.phase !== PHASES.ROLE_REVEAL) ? this.leader.id : null,
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
      questTimerEnabled: this.questTimerEnabled,
      questTimerSeconds: this.questTimerSeconds,
      // Remaining time on the current proposal, as a relative span so clients
      // can render a synced countdown without depending on host clock alignment.
      proposalRemainingMs: (this.phase === PHASES.PROPOSAL && this.proposalDeadline != null)
        ? Math.max(0, this.proposalDeadline - Date.now())
        : null,
      showPendingVoters: this.showPendingVoters,
      // Lady of the Lake: who holds the token and whether they've looked yet.
      // The loyalty RESULT (team) is never public — it lives only in the
      // holder's private slice (see privateStateFor).
      ladyEnabled: this.ladyEnabled,
      ladyHolderId: this.ladyEnabled ? this.ladyHolderId : null,
      ladyResolved: this.phase === PHASES.LADY ? !!this._ladyResolved : false,
      readyCount: this.players.filter(p => p.ready).length,
      playerCount: this.players.length,
      // Watch-only spectators (online only) for the lobby screen. No role or
      // seat data — just enough to list who is watching.
      spectators: this.spectators.filter(s => s.online).map(s => ({ id: s.id, name: s.name })),
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
      const roster = this.players.map(x => ({ id: x.id, name: x.name, roleId: x.roleId }));
      // Blurb is lineup-aware (describeRole), so the reveal card never claims a
      // relationship to a role that isn't in this game (e.g. Morgana "appears as
      // Merlin to Percival" with no Percival), and stays consistent with the
      // dynamic knowledge line below it.
      priv.role = { id: role.id, name: role.name, team: role.team, blurb: describeRole(p.roleId, roster) };
      priv.knowledge = computeKnowledge(
        { id: p.id, name: p.name, roleId: p.roleId },
        roster,
        { firstLeaderId: this.firstLeaderId }
      );
    }

    // Phase-specific private affordances.
    if (this.phase === PHASES.VOTE) {
      priv.hasVoted = id in this.votes;
      priv.currentVote = (id in this.votes) ? this.votes[id] : null;
    }
    if (this.phase === PHASES.QUEST && this.proposal) {
      priv.onQuest = this.proposal.members.includes(id);
      priv.hasPlayedCard = id in this.questCards;
      const isEvil = p.roleId && ROLES[p.roleId].team === 'evil';
      // Lunatic is compelled to Fail; Brute can't Fail on quests 4-5; the Good
      // Lancelot is a Good player who is nonetheless allowed to Fail.
      priv.mustFail = priv.onQuest && p.roleId === 'lunatic';
      let mayFail = priv.onQuest && (isEvil || p.roleId === 'lancelotGood');
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
    // Lady of the Lake: only the current holder gets the inspection affordance,
    // and only the holder ever learns the loyalty they uncovered.
    if (this.phase === PHASES.LADY && id === this.ladyHolderId) {
      priv.isLady = true;
      if (this._ladyResolved && this.ladyResult) {
        const t = this.getPlayer(this.ladyResult.targetId);
        priv.ladyResult = {
          targetId: this.ladyResult.targetId,
          targetName: t ? t.name : '—',
          team: this.ladyResult.team,
        };
      } else {
        priv.ladyTargets = this.players
          .filter(x => x.id !== id && !this.ladyHistory.includes(x.id))
          .map(x => ({ id: x.id, name: x.name }));
      }
    }
    return priv;
  }
}

// Small guard used by ensureConfig without importing the whole table check.
function ROLE_COUNTS_OK(n) { return n >= MIN_PLAYERS && n <= MAX_PLAYERS; }
