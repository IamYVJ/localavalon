// ============================================================================
// stats.js — Persistent leaderboard / statistics system.
//
// All data is scoped by room code and stored in localStorage. The host browser
// is authoritative — only the host records games.
//
// Data structure (versioned for future migrations):
//   {
//     version: 1,
//     roomCode: "ABCD",
//     gamesPlayed: 15,
//     games: [ { timestamp, winner, players: [{name, roleId, team}] } ],
//     players: {
//       "PlayerName": {
//         gamesPlayed, wins, good, evil, goodWins, evilWins,
//         roles: { merlin: { played: 0, wins: 0 }, ... }
//       }
//     }
//   }
// ============================================================================

const STORAGE_PREFIX = 'localavalon.stats.';
const CURRENT_VERSION = 1;

// All trackable role IDs.
const ALL_ROLES = [
  'merlin', 'percival', 'servant', 'tristan', 'isolde',
  'assassin', 'morgana', 'mordred', 'oberon', 'lunatic', 'brute', 'minion',
];

function storageKey(roomCode) {
  return STORAGE_PREFIX + roomCode.toUpperCase();
}

function emptyPlayerStats() {
  const roles = {};
  for (const rid of ALL_ROLES) {
    roles[rid] = { played: 0, wins: 0 };
  }
  return {
    gamesPlayed: 0,
    wins: 0,
    good: 0,
    evil: 0,
    goodWins: 0,
    evilWins: 0,
    roles,
  };
}

function emptyStats(roomCode) {
  return {
    version: CURRENT_VERSION,
    roomCode: roomCode.toUpperCase(),
    gamesPlayed: 0,
    games: [],
    players: {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load stats for a room from localStorage. Returns a valid stats object
 * (empty if none exists or data is corrupt).
 */
export function loadStats(roomCode) {
  if (!roomCode) return emptyStats('');
  const key = storageKey(roomCode);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return emptyStats(roomCode);
    const data = JSON.parse(raw);
    if (!data || data.version !== CURRENT_VERSION) return emptyStats(roomCode);
    return data;
  } catch (_) {
    return emptyStats(roomCode);
  }
}

/**
 * Save stats object to localStorage.
 */
export function saveStats(roomCode, stats) {
  if (!roomCode) return;
  const key = storageKey(roomCode);
  try {
    localStorage.setItem(key, JSON.stringify(stats));
  } catch (_) { /* quota exceeded or private browsing */ }
}

/**
 * Record a completed game. Called once per game-end by the host.
 *
 * @param {string} roomCode - The room identifier
 * @param {object} gameResult - { winner: 'good'|'evil', players: [{name, roleId, team}] }
 * @returns {object} Updated stats
 */
export function recordGame(roomCode, gameResult) {
  if (!roomCode || !gameResult || !gameResult.winner || !gameResult.players) {
    return loadStats(roomCode);
  }

  const stats = loadStats(roomCode);
  stats.gamesPlayed += 1;

  // Archive the game record.
  stats.games.push({
    timestamp: Date.now(),
    winner: gameResult.winner,
    players: gameResult.players.map(p => ({
      name: p.name, roleId: p.roleId, team: p.team,
    })),
  });

  // Update per-player cumulative stats.
  for (const p of gameResult.players) {
    if (!stats.players[p.name]) {
      stats.players[p.name] = emptyPlayerStats();
    }
    const ps = stats.players[p.name];
    ps.gamesPlayed += 1;

    const won = (p.team === gameResult.winner);
    if (won) ps.wins += 1;

    if (p.team === 'good') {
      ps.good += 1;
      if (won) ps.goodWins += 1;
    } else {
      ps.evil += 1;
      if (won) ps.evilWins += 1;
    }

    if (p.roleId && ps.roles[p.roleId]) {
      ps.roles[p.roleId].played += 1;
      if (won) ps.roles[p.roleId].wins += 1;
    }
  }

  saveStats(roomCode, stats);
  return stats;
}

/**
 * Clear all stats for a room code.
 */
export function clearStats(roomCode) {
  if (!roomCode) return;
  const key = storageKey(roomCode);
  try { localStorage.removeItem(key); } catch (_) {}
}

/**
 * Get a sorted leaderboard array for display.
 * Returns { summary, leaderboard } where leaderboard is sorted by wins desc.
 */
export function getLeaderboard(roomCode) {
  const stats = loadStats(roomCode);

  const goodWins = stats.games.filter(g => g.winner === 'good').length;
  const evilWins = stats.games.filter(g => g.winner === 'evil').length;

  const summary = {
    gamesPlayed: stats.gamesPlayed,
    goodWins,
    evilWins,
  };

  const leaderboard = Object.entries(stats.players)
    .map(([name, ps]) => ({
      name,
      gamesPlayed: ps.gamesPlayed,
      wins: ps.wins,
      winPct: ps.gamesPlayed > 0 ? Math.round((ps.wins / ps.gamesPlayed) * 100) : 0,
      good: ps.good,
      evil: ps.evil,
      goodWins: ps.goodWins,
      evilWins: ps.evilWins,
      goodWinPct: ps.good > 0 ? Math.round((ps.goodWins / ps.good) * 100) : 0,
      evilWinPct: ps.evil > 0 ? Math.round((ps.evilWins / ps.evil) * 100) : 0,
      roles: ps.roles,
    }))
    .sort((a, b) => b.wins - a.wins || b.winPct - a.winPct || a.name.localeCompare(b.name));

  return { summary, leaderboard };
}
