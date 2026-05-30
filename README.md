# Avalon — The Resistance

A complete, **static** web implementation of the social-deduction game
*The Resistance: Avalon*. One player hosts from their own browser tab; everyone
else joins with a 4-character code. All game logic and authoritative state live
in the host's tab — **no backend, no accounts**. Built to run on a shared Wi-Fi
network and installable as a PWA that works offline (app shell).

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
  ui.js                 rendering (pure view layer)
  util.js               helpers (room code, clipboard, persistence, DOM)
  main.js               controller wiring net + engine + UI together
icons/                  app icons (svg + generated png)
scripts/gen-icons.js    regenerates the PNG icons (node, no deps)
```

## Run locally

No build step required — it's plain static files. Serve the folder over HTTP
(service workers and ES modules don't work from `file://`):

```bash
# Option A — Node
npx serve .

# Option B — Python
python3 -m http.server 8000
```

Then open the printed URL (e.g. `http://localhost:8000`). To test multiplayer
on your LAN, have other devices visit `http://<your-computer-ip>:8000`.

> Note: some browsers require a **secure context** (HTTPS or `localhost`) for
> clipboard and service worker. `localhost` counts as secure; for other devices
> on the LAN, use the host's IP — the game still works, with a clipboard
> fallback.

## Deploy to GitHub Pages

This repo serves from the root, so:

1. Push to GitHub (`main` branch).
2. Repo **Settings → Pages → Build and deployment**: *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
3. Your site appears at `https://<user>.github.io/localavalon/`.

All asset paths, the service worker scope, and the manifest `start_url` are
**relative**, so it works correctly under the `/localavalon/` subpath.

(If you prefer a `/docs` folder deploy, move the files into `docs/` and pick
that folder in the Pages settings — paths stay relative.)

## Game rules implemented

- 5–10 players; Good:Evil splits 3:2 / 4:2 / 4:3 / 5:3 / 6:3 / 6:4.
- Roles: Merlin & Assassin (always), plus optional Percival, Morgana, Mordred,
  Oberon; Loyal Servants and Minions fill remaining seats.
- Night knowledge computed per device: Evil see each other (except Oberon),
  Merlin sees Evil except Mordred, Percival sees Merlin + Morgana unlabeled.
- Quest team sizes per round and the **2-fail rule** on Quest 4 at 7+ players.
- Team proposal → simultaneous hidden vote → reveal → quest cards (Good must
  play Success) → reveal fail count only.
- Evil wins on 3 failed quests or 5 rejected proposals in one round.
- Good completing 3 quests triggers the **Assassination** phase.
- Full role reveal on game over; Play Again keeps the same players.

## Regenerating icons

```bash
node scripts/gen-icons.js
```

## Note on this code

This is AI-assisted code. Read and test it before relying on it — verify the
game-rule logic in `js/rules.js` / `js/state.js` against your group's preferred
ruleset, and confirm P2P connectivity on your actual network.
