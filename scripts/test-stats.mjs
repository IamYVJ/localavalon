// Correctness harness for the persistent stats/leaderboard system.
// stats.js talks to localStorage, so we shim a minimal in-memory version
// (functions read it lazily at call time, so setting it now is enough).
// Run: node scripts/test-stats.mjs
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
})();

const { recordGame, getLeaderboard, clearStats, loadStats } = await import('../js/stats.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const ROOM = 'TEST';
clearStats(ROOM);

// --- Empty state -----------------------------------------------------------
{
  const lb = getLeaderboard(ROOM);
  eq(lb.summary, { gamesPlayed: 0, goodWins: 0, evilWins: 0 }, 'empty room summary');
  eq(lb.leaderboard, [], 'empty leaderboard');
}

// --- Record a Good win -----------------------------------------------------
// Aria=Merlin(good, won), Bran=Assassin(evil, lost), Cora=Servant(good, won).
recordGame(ROOM, {
  winner: 'good',
  players: [
    { name: 'Aria', roleId: 'merlin', team: 'good' },
    { name: 'Bran', roleId: 'assassin', team: 'evil' },
    { name: 'Cora', roleId: 'servant', team: 'good' },
  ],
});
{
  const { summary, leaderboard } = getLeaderboard(ROOM);
  eq(summary, { gamesPlayed: 1, goodWins: 1, evilWins: 0 }, 'summary after 1 good win');
  const aria = leaderboard.find(p => p.name === 'Aria');
  eq([aria.gamesPlayed, aria.wins, aria.winPct], [1, 1, 100], 'Aria 1GP/1W/100%');
  eq([aria.good, aria.goodWins, aria.goodWinPct], [1, 1, 100], 'Aria good split');
  eq(aria.roles.merlin, { played: 1, wins: 1 }, 'Aria Merlin role tracked');
  const bran = leaderboard.find(p => p.name === 'Bran');
  eq([bran.wins, bran.winPct, bran.evil, bran.evilWins], [0, 0, 1, 0], 'Bran lost as evil');
}

// --- Record an Evil win (same players, swapped fortunes) -------------------
recordGame(ROOM, {
  winner: 'evil',
  players: [
    { name: 'Aria', roleId: 'percival', team: 'good' },
    { name: 'Bran', roleId: 'mordred', team: 'evil' },
    { name: 'Cora', roleId: 'minion', team: 'evil' },
  ],
});
{
  const { summary, leaderboard } = getLeaderboard(ROOM);
  eq(summary, { gamesPlayed: 2, goodWins: 1, evilWins: 1 }, 'summary after good+evil');
  const aria = leaderboard.find(p => p.name === 'Aria');
  eq([aria.gamesPlayed, aria.wins, aria.winPct], [2, 1, 50], 'Aria 2GP/1W/50%');
  eq([aria.good, aria.goodWins], [2, 1], 'Aria played good twice, won once');
  eq(aria.roles.percival, { played: 1, wins: 0 }, 'Aria Percival played, not won');
  const bran = leaderboard.find(p => p.name === 'Bran');
  eq([bran.wins, bran.evil, bran.evilWins, bran.evilWinPct], [1, 2, 1, 50], 'Bran evil 1/2 = 50%');
  // Cora switched teams between games (1 good + 1 evil) and was on the winning
  // side BOTH times — so 2 wins across 2 games.
  const cora = leaderboard.find(p => p.name === 'Cora');
  eq([cora.good, cora.evil, cora.wins], [1, 1, 2], 'Cora one game each side, won both');
}

// --- Leaderboard ordering: most wins first --------------------------------
recordGame(ROOM, {
  winner: 'evil',
  players: [
    { name: 'Bran', roleId: 'assassin', team: 'evil' },
    { name: 'Aria', roleId: 'servant', team: 'good' },
  ],
});
{
  const { leaderboard } = getLeaderboard(ROOM);
  // Bran and Cora both sit on 2 wins; the tie-break is winPct, so Cora
  // (2W/2GP = 100%) edges out Bran (2W/3GP = 67%).
  eq(leaderboard[0].name, 'Cora', 'wins-then-winPct sorts Cora first');
  ok(leaderboard[0].wins >= leaderboard[1].wins, 'leaderboard is wins-descending');
  ok(leaderboard[0].winPct >= leaderboard[1].winPct, 'ties broken by win% descending');
}

// --- Bad input is ignored, not thrown -------------------------------------
{
  const before = getLeaderboard(ROOM).summary.gamesPlayed;
  recordGame(ROOM, null);
  recordGame(ROOM, { winner: 'good' });           // missing players
  recordGame(ROOM, { players: [] });               // missing winner
  const after = getLeaderboard(ROOM).summary.gamesPlayed;
  eq(after, before, 'malformed game results are ignored');
}

// --- clearStats wipes the room --------------------------------------------
clearStats(ROOM);
eq(getLeaderboard(ROOM).summary.gamesPlayed, 0, 'clearStats resets the room');

// --- Corrupt/legacy data falls back to empty ------------------------------
{
  localStorage.setItem('localavalon.stats.TEST', '{not valid json');
  eq(loadStats(ROOM).gamesPlayed, 0, 'corrupt JSON falls back to empty stats');
  localStorage.setItem('localavalon.stats.TEST', JSON.stringify({ version: 99 }));
  eq(loadStats(ROOM).gamesPlayed, 0, 'unknown version falls back to empty stats');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
