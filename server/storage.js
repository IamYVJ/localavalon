// ============================================================================
// storage.js — In-memory localStorage shim.
//
// The browser stats module (../js/stats.js) reads/writes window.localStorage.
// Importing it under Node would throw, so we install a tiny in-memory shim on
// globalThis BEFORE stats.js is ever called. Importing this module for its side
// effect (no exports) is enough.
//
// NOTE: stats live only for the container's lifetime — they RESET on restart.
// That's acceptable for an MVP leaderboard. To make them durable, swap this for
// a file-backed implementation writing to a mounted volume, or a small DB.
// ============================================================================

const mem = new Map();

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem(key) {
      const k = String(key);
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(key, value) { mem.set(String(key), String(value)); },
    removeItem(key) { mem.delete(String(key)); },
    clear() { mem.clear(); },
  };
}
