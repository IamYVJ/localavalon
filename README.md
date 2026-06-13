# Avalon — The Resistance

A complete, **static** web implementation of the social-deduction game
*The Resistance: Avalon*. One player hosts from their own browser tab; everyone
else joins with a 4-character code. All game logic and authoritative state live
in the host's tab — **no backend, no accounts**. Built to run on a shared Wi-Fi
network and installable as a PWA that works offline (app shell).

Extras beyond the base game: a **spectator / TV mode** (a watch-only, single
screen public view that never sees secret roles — ideal for a shared display),
an optional per-proposal **countdown timer**, a host **"show pending voters"**
option, and a persistent per-room **stats leaderboard**.

## How it works

- **Networking:** WebRTC peer-to-peer via [PeerJS](https://peerjs.com/). Star
  topology, **host-authoritative**: the host owns all state, validates every
  intent, and broadcasts each player only the information they're entitled to
  see (your secret role never reaches another player's device).
- **Room codes:** the friendly 4-char code maps directly to the host's Peer ID
  (`localavalon-v1-<CODE>`), so joiners reconstruct it from the code — no
  discovery service needed.
- **Signaling caveat:** PeerJS needs to reach a signaling *broker* once to set
  up the WebRTC handshake; after that, game traffic is direct P2P on the LAN.
  The default broker is PeerJS's public cloud (needs internet for that initial
  handshake). To play **fully offline on a LAN**, run your own broker and point
  the app at it — see [`js/net.js`](js/net.js) (`BROKER_CONFIG`).

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers SW)
manifest.webmanifest    PWA manifest (relative paths)
sw.js                   service worker — precaches the shell, cache-first
css/styles.css          dark/mint minimalist theme
js/
  rules.js              ← ALL game-rule constants (team sizes, role counts,
                          fail thresholds) + pure logic. Start here.
  state.js              host-authoritative game engine / state machine
  net.js                PeerJS networking (BROKER_CONFIG lives at the top)
  ui.js                 rendering (pure view layer, incl. spectator/TV screen)
  util.js               helpers (room code, clipboard, persistence, DOM)
  stats.js              persistent per-room leaderboard (localStorage)
  main.js               controller wiring net + engine + UI together
icons/                  app icons (svg + generated png)
scripts/gen-icons.js    regenerates the PNG icons (node, no deps)
scripts/test-engine.mjs engine + rules correctness tests (node, no deps)
scripts/test-stats.mjs  leaderboard/stats correctness tests (node, no deps)
```

## Tests

Pure logic (engine, rules, stats) has a dependency-free node harness:

```bash
node scripts/test-engine.mjs
node scripts/test-stats.mjs
```

## Game rules implemented

- 5–10 players; Good:Evil splits 3:2 / 4:2 / 4:3 / 5:3 / 6:3 / 6:4.
- Roles: Merlin & Assassin (always). Optional **Good** roles — **Percival**, the
  **Lovers** (Tristan & Isolde, who see each other), the **Cleric** (learns
  whether the first Quest Leader is Good or Evil), and the **Untrustworthy
  Servant** (Good, but appears Evil to Merlin). Optional **Evil** roles —
  **Morgana**, **Mordred**, **Oberon**, **Lunatic** (must Fail every quest), and
  **Brute** (may only Fail quests 1–3). The **Lancelots** toggle adds a paired
  Good + Evil knight, where the Good Lancelot is allowed to play Fail. Loyal
  Servants and Minions fill the remaining seats.
- Night knowledge computed per device: Evil see each other (except Oberon),
  Merlin sees Evil except Mordred, Percival sees Merlin + Morgana unlabeled.
- Quest team sizes per round and the **2-fail rule** on Quest 4 at 7+ players.
- Team proposal → simultaneous hidden vote → reveal → quest cards (Good must
  play Success) → reveal fail count only.
- Evil wins on 3 failed quests or 5 rejected proposals in one round.
- Good completing 3 quests triggers the **Assassination** phase.
- Full role reveal on game over; Play Again keeps the same players.

## Host options & extras

- **Spectator / TV mode** — join as a watch-only spectator: a single-screen,
  no-scroll public view (quest track, roster, vote tallies, phase status, and
  the end-game reveal) that **never receives secret roles**. Designed for a
  shared TV that stays on while everyone plays. Spectators can attach to a game
  already in progress and don't count toward the player total.
- **Proposal timer** — optional per-proposal countdown (1–5 minutes) shown in
  sync to everyone; on time-out leadership passes to the next player with **no
  penalty** (it never counts against the reject track).
- **Show pending voters** — during the team vote, reveals *which* players still
  owe a vote (never how anyone voted; chips are deliberately team-neutral).
- **Re-check role** and **random leader order** toggles.
- **Stats leaderboard** — per-room, stored in the host's browser: games played,
  good/evil win rates, and per-player role records.

## Regenerating icons

```bash
node scripts/gen-icons.js
```

## Note on this code

This is AI-assisted code. Read and test it before relying on it — verify the
game-rule logic in `js/rules.js` / `js/state.js` against your group's preferred
ruleset, and confirm P2P connectivity on your actual network.
