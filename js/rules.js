// ============================================================================
// rules.js — Game-rule constants and PURE logic for The Resistance: Avalon.
//
// This module is the single source of truth for every hard rule:
//   - team sizes per player count / quest
//   - Good:Evil split per player count
//   - fail thresholds (incl. the 2-fail Quest 4 rule at 7+ players)
//   - role definitions and night-knowledge rules
//
// Everything here is PURE: no DOM, no networking, no mutation of external
// state. The host's state machine (state.js) calls into these helpers.
// ============================================================================

// ---------------------------------------------------------------------------
// Player-count bounds
// ---------------------------------------------------------------------------
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

// ---------------------------------------------------------------------------
// Good : Evil split, indexed by player count.
//   5 -> 3:2, 6 -> 4:2, 7 -> 4:3, 8 -> 5:3, 9 -> 6:3, 10 -> 6:4
// ---------------------------------------------------------------------------
export const ROLE_COUNTS = {
  5:  { good: 3, evil: 2 },
  6:  { good: 4, evil: 2 },
  7:  { good: 4, evil: 3 },
  8:  { good: 5, evil: 3 },
  9:  { good: 6, evil: 3 },
  10: { good: 6, evil: 4 },
};

// ---------------------------------------------------------------------------
// Quest team sizes. TEAM_SIZES[playerCount] = [Q1, Q2, Q3, Q4, Q5].
// ---------------------------------------------------------------------------
export const TEAM_SIZES = {
  5:  [2, 3, 2, 3, 3],
  6:  [2, 3, 4, 3, 4],
  7:  [2, 3, 3, 4, 4],
  8:  [3, 4, 4, 5, 5],
  9:  [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// Five consecutive rejected proposals in one quest => Evil wins.
export const MAX_REJECTS = 5;

// Quests needed to win the track (first to 3).
export const QUESTS_TO_WIN = 3;

// ---------------------------------------------------------------------------
// Role catalogue. `id` is the stable key used across the wire and in config.
//   team:      'good' | 'evil'
//   optional:  can be toggled in the lobby (Merlin & Assassin are mandatory)
//   unique:    at most one of this role per game
// ---------------------------------------------------------------------------
export const ROLES = {
  merlin:   { id: 'merlin',   name: 'Merlin',                    team: 'good', optional: false, unique: true,
              blurb: 'Sees all Evil (except Mordred). Win quietly — if found, the Assassin can end the game.' },
  percival: { id: 'percival', name: 'Percival',                  team: 'good', optional: true,  unique: true,
              blurb: 'Sees Merlin and Morgana, but not which is which.' },
  servant:  { id: 'servant',  name: 'Loyal Servant of Arthur',   team: 'good', optional: true,  unique: false,
              blurb: 'No special knowledge. Vote and quest wisely.' },
  tristan:  { id: 'tristan',  name: 'Tristan',                   team: 'good', optional: true,  unique: true,
              blurb: 'One of the Lovers — sees Isolde, who is also Good.' },
  isolde:   { id: 'isolde',   name: 'Isolde',                    team: 'good', optional: true,  unique: true,
              blurb: 'One of the Lovers — sees Tristan, who is also Good.' },
  cleric:   { id: 'cleric',   name: 'Cleric',                    team: 'good', optional: true,  unique: true,
              blurb: 'At game start, secretly learns whether the FIRST Quest Leader is Good or Evil.' },
  untrustworthy: { id: 'untrustworthy', name: 'Untrustworthy Servant', team: 'good', optional: true, unique: true,
              blurb: 'Loyal to Arthur — but appears as Evil to Merlin, muddying his vision.' },
  lancelotGood: { id: 'lancelotGood', name: 'Lancelot (Good)',   team: 'good', optional: true,  unique: true,
              blurb: 'A Good knight who is nonetheless permitted to play Fail on quests.' },

  assassin: { id: 'assassin', name: 'Assassin',                  team: 'evil', optional: false, unique: true,
              blurb: 'If Good wins 3 quests, name Merlin to steal victory for Evil.' },
  morgana:  { id: 'morgana',  name: 'Morgana',                   team: 'evil', optional: true,  unique: true,
              blurb: 'Appears as Merlin to Percival.' },
  mordred:  { id: 'mordred',  name: 'Mordred',                   team: 'evil', optional: true,  unique: true,
              blurb: 'Hidden from Merlin.' },
  oberon:   { id: 'oberon',   name: 'Oberon',                    team: 'evil', optional: true,  unique: true,
              blurb: 'Does not know the other Evil, and they do not know Oberon.' },
  lunatic:  { id: 'lunatic',  name: 'Lunatic',                   team: 'evil', optional: true,  unique: true,
              blurb: 'Must play Fail on every quest they join — they cannot help.' },
  brute:    { id: 'brute',    name: 'Brute',                     team: 'evil', optional: true,  unique: true,
              blurb: 'May only play Fail on the first three quests.' },
  minion:   { id: 'minion',   name: 'Minion of Mordred',         team: 'evil', optional: true,  unique: false,
              blurb: 'Knows the other Evil (except Oberon).' },
  lancelotEvil: { id: 'lancelotEvil', name: 'Lancelot (Evil)',   team: 'evil', optional: true,  unique: true,
              blurb: 'An Evil knight who knows the other Evil players.' },
};

// ---------------------------------------------------------------------------
// Optional-role toggles for the lobby. Each toggle maps to one or more roleIds.
// "Lovers" adds Tristan AND Isolde together (they must be paired). Shared by
// the lobby UI (ui.js) and the host config builder (main.js).
// ---------------------------------------------------------------------------
export const OPTIONAL_TOGGLES = [
  { key: 'percival', roleIds: ['percival'],            team: 'good', label: 'Percival',          blurb: ROLES.percival.blurb },
  { key: 'lovers',   roleIds: ['tristan', 'isolde'],   team: 'good', label: 'Tristan & Isolde',  blurb: 'The Lovers — each sees the other, and knows that person is Good.' },
  { key: 'cleric',   roleIds: ['cleric'],              team: 'good', label: 'Cleric',            blurb: ROLES.cleric.blurb },
  { key: 'untrustworthy', roleIds: ['untrustworthy'],  team: 'good', label: 'Untrustworthy Servant', blurb: ROLES.untrustworthy.blurb },
  { key: 'lancelots', roleIds: ['lancelotGood', 'lancelotEvil'], team: 'good', label: 'Lancelots', blurb: 'Adds a Good and an Evil knight — the Good Lancelot is allowed to play Fail cards.' },
  { key: 'morgana',  roleIds: ['morgana'],             team: 'evil', label: 'Morgana',           blurb: ROLES.morgana.blurb },
  { key: 'mordred',  roleIds: ['mordred'],             team: 'evil', label: 'Mordred',           blurb: ROLES.mordred.blurb },
  { key: 'oberon',   roleIds: ['oberon'],              team: 'evil', label: 'Oberon',            blurb: ROLES.oberon.blurb },
  { key: 'lunatic',  roleIds: ['lunatic'],             team: 'evil', label: 'Lunatic',           blurb: ROLES.lunatic.blurb },
  { key: 'brute',    roleIds: ['brute'],               team: 'evil', label: 'Brute',             blurb: ROLES.brute.blurb },
];

// ---------------------------------------------------------------------------
// Required team size for a given player count and quest index (0-based).
// ---------------------------------------------------------------------------
export function teamSize(playerCount, questIndex) {
  const row = TEAM_SIZES[playerCount];
  if (!row) throw new Error(`No team-size row for ${playerCount} players`);
  return row[questIndex];
}

// ---------------------------------------------------------------------------
// Number of Fail cards required to fail a quest.
// Quest 4 (index 3) needs 2 fails when 7+ players; every other quest needs 1.
// ---------------------------------------------------------------------------
export function failThreshold(playerCount, questIndex) {
  if (questIndex === 3 && playerCount >= 7) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Build the default role configuration for a player count: mandatory roles on,
// a sensible set of optional roles, with Loyal Servants / Minions filling the
// remaining seats. Returned as a map of roleId -> count.
// ---------------------------------------------------------------------------
export function defaultRoleConfig(playerCount) {
  const { good, evil } = ROLE_COUNTS[playerCount];
  const cfg = { merlin: 1, assassin: 1 };

  // Suggest Percival/Morgana/Mordred when there is room — a popular setup.
  let goodLeft = good - 1;   // minus Merlin
  let evilLeft = evil - 1;   // minus Assassin

  if (goodLeft >= 1 && evilLeft >= 1) {
    cfg.percival = 1; goodLeft -= 1;
    cfg.morgana = 1;  evilLeft -= 1;
  }
  if (evilLeft >= 1 && playerCount >= 7) {
    cfg.mordred = 1; evilLeft -= 1;
  }

  cfg.servant = goodLeft;
  cfg.minion = evilLeft;
  return cfg;
}

// ---------------------------------------------------------------------------
// Validate a role configuration against a player count.
// Returns { ok, errors:[], good, evil }.
// ---------------------------------------------------------------------------
export function validateRoleConfig(cfg, playerCount) {
  const errors = [];
  const target = ROLE_COUNTS[playerCount];
  if (!target) {
    return { ok: false, errors: [`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}.`], good: 0, evil: 0 };
  }

  let good = 0, evil = 0;
  for (const [id, count] of Object.entries(cfg)) {
    if (!count) continue;
    const role = ROLES[id];
    if (!role) { errors.push(`Unknown role "${id}".`); continue; }
    if (role.unique && count > 1) errors.push(`${role.name} can only appear once.`);
    if (role.team === 'good') good += count; else evil += count;
  }

  if (!cfg.merlin)   errors.push('Merlin is required.');
  if (!cfg.assassin) errors.push('Assassin is required.');
  if (cfg.percival && !cfg.morgana) errors.push('Percival should be paired with Morgana, or he sees no decoy.');
  if (!!cfg.tristan !== !!cfg.isolde) errors.push('Tristan and Isolde must both be in the game.');
  if (!!cfg.lancelotGood !== !!cfg.lancelotEvil) errors.push('Both Lancelots (Good and Evil) must be in the game together.');

  if (good !== target.good) errors.push(`Good must total ${target.good} (currently ${good}).`);
  if (evil !== target.evil) errors.push(`Evil must total ${target.evil} (currently ${evil}).`);

  return { ok: errors.length === 0, errors, good, evil };
}

// ---------------------------------------------------------------------------
// Expand a role config into a flat list of roleIds, then shuffle into seats.
// `rng` lets callers inject determinism in tests; defaults to Math.random.
// ---------------------------------------------------------------------------
export function buildRoleDeck(cfg) {
  const deck = [];
  for (const [id, count] of Object.entries(cfg)) {
    for (let i = 0; i < count; i++) deck.push(id);
  }
  return deck;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Night knowledge. Given the acting player and the full seated roster
// (each player: { id, name, roleId }), return what this player learns.
//
// Returns { team, seesLabel, sees:[{id,name}], note } describing the private
// reveal. Never leak more than the role is entitled to.
// ---------------------------------------------------------------------------
export function computeKnowledge(player, players, opts = {}) {
  const role = ROLES[player.roleId];
  const team = role.team;
  const others = players.filter(p => p.id !== player.id);

  // Helpers
  const evilOf = (p) => !!ROLES[p.roleId] && ROLES[p.roleId].team === 'evil';

  if (player.roleId === 'merlin') {
    // Sees all Evil except Mordred (Oberon IS visible to Merlin). The
    // Untrustworthy Servant is Good but ALSO appears here, as a false positive.
    const sees = others.filter(p =>
        (evilOf(p) && p.roleId !== 'mordred') || p.roleId === 'untrustworthy')
                        .map(p => ({ id: p.id, name: p.name }));
    return { team, seesLabel: 'Evil players (Mordred hidden)', sees,
             note: 'Win quietly — the Assassin is hunting you.' };
  }

  if (player.roleId === 'cleric') {
    // Learns ONLY the loyalty (not the role) of whoever leads the first quest.
    const leader = players.find(p => p.id === opts.firstLeaderId);
    if (!leader) {
      return { team, seesLabel: 'The first Quest Leader\'s loyalty', sees: [],
               note: 'You will learn the first Leader\'s loyalty when the game begins.' };
    }
    const leaderEvil = !!ROLES[leader.roleId] && ROLES[leader.roleId].team === 'evil';
    return { team, seesLabel: `The first Quest Leader is ${leaderEvil ? 'EVIL' : 'GOOD'}`,
             sees: [{ id: leader.id, name: leader.name }],
             note: 'You know only their loyalty — not their role.' };
  }

  if (player.roleId === 'untrustworthy') {
    return { team, seesLabel: 'You appear as EVIL to Merlin', sees: [],
             note: 'You are loyal to Arthur, yet Merlin counts you among the Evil.' };
  }

  if (player.roleId === 'lancelotGood') {
    return { team, seesLabel: 'You may play Fail', sees: [],
             note: 'A Good knight — but you are permitted to sabotage quests.' };
  }

  if (player.roleId === 'percival') {
    // Sees Merlin + Morgana, unlabeled.
    const sees = others.filter(p => p.roleId === 'merlin' || p.roleId === 'morgana')
                        .map(p => ({ id: p.id, name: p.name }));
    return { team, seesLabel: 'Merlin & Morgana (you cannot tell which is which)', sees,
             note: 'One of these is the real Merlin.' };
  }

  if (player.roleId === 'tristan' || player.roleId === 'isolde') {
    // The Lovers see each other and know the other is Good.
    const partner = player.roleId === 'tristan' ? 'isolde' : 'tristan';
    const sees = others.filter(p => p.roleId === partner)
                       .map(p => ({ id: p.id, name: p.name }));
    return { team, seesLabel: 'Your beloved — the other Lover (Good)', sees,
             note: 'You two can trust each other completely.' };
  }

  if (team === 'evil' && player.roleId !== 'oberon') {
    // Evil (not Oberon) see each other, excluding Oberon from the visible set.
    const sees = others.filter(p => evilOf(p) && p.roleId !== 'oberon')
                        .map(p => ({ id: p.id, name: p.name }));
    return { team, seesLabel: 'Your fellow Evil', sees,
             note: 'Fail quests without being obvious.' };
  }

  if (player.roleId === 'oberon') {
    return { team, seesLabel: 'You work alone', sees: [],
             note: 'You do not know the other Evil, nor they you.' };
  }

  // Loyal Servant of Arthur and any other plain Good role.
  return { team, seesLabel: 'No special knowledge', sees: [],
           note: 'Trust carefully.' };
}
