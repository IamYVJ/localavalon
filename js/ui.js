// ============================================================================
// ui.js — All rendering. Pure view layer: given app state + intent callbacks,
// it builds DOM. It never touches the network or the game engine directly.
//
//   render(root, app, intents)
//     app     : { screen, me, code, pub, priv, error, lobbyToggles, ... }
//     intents : { host, join, setName, toggleRole, startGame, ready, propose,
//                 vote, playCard, assassinate, playAgain, newGame, goHome,
//                 copyCode }
// ============================================================================

import { el, clear } from './util.js';
import { ROLES, ROLE_COUNTS, validateRoleConfig, OPTIONAL_TOGGLES, MIN_PLAYERS, MAX_PLAYERS } from './rules.js';

// Filler roles that automatically occupy the remaining seats (not toggleable).
const FILLER_ROLE_IDS = ['servant', 'minion'];

// The last top-level screen we rendered. The entrance animation (a fade-in from
// opacity 0) should play ONLY when the screen actually changes — replaying it on
// every state push / repaint makes the whole screen flicker. We compare against
// this and add the `screen-enter` class only on a real transition.
let _lastScreen = null;

export function render(root, app, intents) {
  clear(root);
  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'join':       node = joinScreen(app, intents); break;
    case 'howto':      node = howToScreen(app, intents); break;
    case 'connecting': node = infoScreen('Connecting…',
                                          app.code ? `Reaching room ${app.code}.` : 'Setting up your room…', true); break;
    case 'error':      node = errorScreen(app, intents); break;
    case 'hostleft':   node = infoScreen('Host left', 'The host ended the game. Thanks for playing.', false,
                                          el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '> BACK HOME')); break;
    case 'game':       node = gameScreen(app, intents); break;
    case 'spectator':  node = spectatorScreen(app, intents); break;
    case 'stats':      node = statsScreen(app, intents); break;
    default:           node = homeScreen(app, intents);
  }
  // Animate on screen change only — not on every in-screen re-render.
  if (app.screen !== _lastScreen) {
    node.classList.add('screen-enter');
    _lastScreen = app.screen;
  }
  root.appendChild(node);

  // Connection-recovery banner: shown over any screen while the peer link is
  // being re-established (e.g. the host briefly backgrounded their browser).
  if (app.netStatus === 'reconnecting') {
    root.appendChild(el('div', { class: 'reconnect-banner', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'reconnect-dot' }),
      'Reconnecting…',
    ));
  }

  // Floating exit control during active play (any phase past the lobby, before
  // game-over — game-over already has its own buttons). The HOST gets "End game"
  // (ends for everyone); every other PLAYER gets "Leave game" (just themselves).
  // It overlays both the game board and a spectating host's TV view.
  const inActiveGame = app.pub && app.pub.phase !== 'lobby' && app.pub.phase !== 'gameover';
  // "Can control the room" = P2P host OR server-mode owner.
  const canControl = app.me.isHost || app.me.owner;
  if (canControl && inActiveGame) {
    root.appendChild(el('button', {
      class: 'exit-btn',
      title: 'End the game and send everyone back to the lobby',
      onclick: () => intents.requestEndGame(),
    }, '✕ END GAME'));
  } else if (!canControl && !app.me.isSpectator && app.me.id && inActiveGame) {
    root.appendChild(el('button', {
      class: 'exit-btn',
      title: 'Leave the game (you can rejoin with the same name and code)',
      onclick: () => intents.requestLeaveGame(),
    }, '✕ LEAVE GAME'));
  }

  // Floating room-code chip, shown to EVERYONE on the game screen — host and
  // joined players alike. The lobby card only shows the code during the lobby
  // phase, so once play starts nobody (not even the host) has an on-screen
  // reminder otherwise. Pin it bottom-left (top-right is the exit button,
  // bottom-centre the reconnect banner) so anyone can read or share it. Tap to
  // copy. The spectator/TV screen is the one exclusion — it already shows the
  // code in its header (.tv-code, top-right), so a duplicate chip is redundant.
  if (app.code && app.screen === 'game') {
    root.appendChild(el('button', {
      class: 'code-footer', title: 'Room code — tap to copy',
      onclick: () => intents.copyCode && intents.copyCode(),
    },
      el('span', { class: 'code-footer-label' }, 'ROOM'),
      el('span', { class: 'code-footer-value' }, app.code),
    ));
  }

  // Confirmation modals ("are you sure?").
  if (canControl && app.confirmEndGame) {
    root.appendChild(confirmModal({
      title: 'End this game?',
      body: 'This ends the current game for everyone and returns all players to the lobby. '
          + 'The current roles and quest progress will be lost — but everyone stays connected, '
          + 'so you can set up and start a new game right away.',
      confirmLabel: '✕ END GAME',
      onConfirm: () => intents.endGame(),
      onCancel: () => intents.cancelEndGame(),
    }));
  }
  if (!canControl && app.confirmLeaveGame) {
    root.appendChild(confirmModal({
      title: 'Leave the game?',
      body: 'You\'ll return to the home screen. While the game is in progress your seat is held, '
          + 'so you can rejoin from this device — just enter the same name and room code to '
          + 'reclaim your spot and role.',
      confirmLabel: '✕ LEAVE GAME',
      onConfirm: () => intents.leaveGame(),
      onCancel: () => intents.cancelLeaveGame(),
    }));
  }
}

// Generic "are you sure?" overlay. Clicking the backdrop cancels.
function confirmModal({ title, body, confirmLabel, confirmClass = 'btn-danger', onConfirm, onCancel }) {
  const overlay = el('div', {
    class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
  },
    el('div', { class: 'modal' },
      el('h2', { class: 'modal-title' }, title),
      el('p', { class: 'modal-body' }, body),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn ' + confirmClass, onclick: onConfirm }, confirmLabel),
        el('button', { class: 'btn btn-secondary', onclick: onCancel }, 'CANCEL'),
      ),
    ),
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) onCancel(); });
  return overlay;
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------
function wordmark() {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }), 'THE RESISTANCE');
}

function shell(...children) {
  return el('main', { class: 'shell' }, ...children);
}

function liveRegion(text) {
  return el('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' }, text || '');
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function homeScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '16', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name',
    oninput: (e) => intents.setName(e.target.value),
  });

  // When on, the host runs the room but takes NO seat — they never get a role
  // and don't count toward the player total. Instead they watch the single-screen
  // TV view, ideal for running the game from a shared display.
  const hostSpectate = !!app.spectatorMode;
  const spectatorToggle = el('label', { class: 'toggle spectator-toggle' + (hostSpectate ? ' on' : '') },
    el('input', {
      type: 'checkbox', ...(hostSpectate ? { checked: true } : {}),
      onchange: () => intents.toggleSpectatorMode(),
    }),
    el('span', { class: 'toggle-box' }),
    el('span', { class: 'toggle-text' },
      el('span', { class: 'toggle-name' }, 'Host as spectator (TV mode)'),
      el('span', { class: 'toggle-blurb' }, 'Run the game and watch on a shared screen without taking a seat — everyone else joins from their own phone.'),
    ),
  );

  return shell(
    wordmark(),
    el('h1', { class: 'hero' }, 'Avalon'),
    el('p', { class: 'tagline' },
      'A game of ', el('span', { class: 'accent' }, 'loyalty and betrayal'),
      '. Gather 5–10 players on the same Wi-Fi, each on their own phone, and find the spy among you.'),
    el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'toggle-list' }, spectatorToggle),
    el('div', { class: 'btn-row' },
      app.serverUp
        ? el('button', { class: 'btn btn-primary', onclick: () => intents.hostOnServer() },
            hostSpectate ? '▷ HOST ON SERVER (TV)' : '> HOST ON SERVER')
        : null,
      el('button', { class: app.serverUp ? 'btn btn-secondary' : 'btn btn-primary', onclick: () => intents.host() },
        app.serverUp
          ? (hostSpectate ? '▷ HOST AS SPECTATOR (P2P)' : '> HOST (P2P)')
          : (hostSpectate ? '▷ HOST AS SPECTATOR' : '> HOST GAME')),
      el('button', { class: 'btn btn-secondary', onclick: () => intents.gotoJoin() }, '▷ JOIN GAME'),
    ),
    el('button', { class: 'link-btn', onclick: () => intents.gotoHowTo() }, '? How to play'),
    el('p', { class: 'fine' }, app.serverUp
      ? 'Server mode is online for smoother cross-network play. Peer-to-peer also works on the same Wi-Fi.'
      : 'Plays peer-to-peer in your browser. No accounts, no sign-ups.'),
  );
}

// ---------------------------------------------------------------------------
// JOIN
// ---------------------------------------------------------------------------
function joinScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '16', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name',
    oninput: (e) => intents.setName(e.target.value),
  });
  const codeInput = el('input', {
    class: 'field field-code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
    maxlength: '4', placeholder: '1234',
    value: app.code || '', autocomplete: 'off',
    'aria-label': 'Room code',
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '').slice(0, 4);
      e.target.value = v;
      intents.setCode(v);
    },
  });

  const spectate = !!app.spectatorMode;

  // Watch-only spectator toggle. A spectator sees only public game info (never
  // roles) on a single TV-optimised screen — ideal for a shared display.
  const spectatorToggle = el('label', { class: 'toggle spectator-toggle' + (spectate ? ' on' : '') },
    el('input', {
      type: 'checkbox', ...(spectate ? { checked: true } : {}),
      onchange: () => intents.toggleSpectatorMode(),
    }),
    el('span', { class: 'toggle-box' }),
    el('span', { class: 'toggle-text' },
      el('span', { class: 'toggle-name' }, 'Watch as spectator (TV mode)'),
      el('span', { class: 'toggle-blurb' }, 'A single-screen public view for a shared display — no roles, no controls. You can watch a game that\'s already in progress.'),
    ),
  );

  const children = [
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, spectate ? 'Watch a game' : 'Join a game'),
    el('p', { class: 'tagline' }, 'Pick a game on your ', el('span', { class: 'accent' }, 'Wi-Fi'), ' — or enter a code.'),
    spectate ? null : el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'toggle-list' }, spectatorToggle),
    el('div', { class: 'section-label' }, 'GAMES ON THIS NETWORK'),
    discoveryList(app, intents, nameInput),
    el('div', { class: 'section-label' }, 'OR ENTER A CODE'),
    el('div', { class: 'field-group' }, codeInput),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        onclick: () => (spectate ? intents.spectate(codeInput.value, nameInput.value)
                                 : intents.join(codeInput.value, nameInput.value)),
      }, spectate ? '▷ WATCH' : '> CONNECT'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK'),
    ),
    el('button', { class: 'link-btn', onclick: () => intents.gotoHowTo() }, '? How to play'),
  ];
  return shell(...children);
}

// ---------------------------------------------------------------------------
// HOW TO PLAY
// ---------------------------------------------------------------------------
function howToScreen(app, intents) {
  // A self-contained rules primer. Pure static content — no game state needed.
  const step = (n, title, ...body) =>
    el('li', { class: 'howto-step' },
      el('span', { class: 'howto-step-num' }, String(n)),
      el('div', { class: 'howto-step-body' },
        el('h3', { class: 'howto-step-title' }, title),
        ...body));

  const role = (name, team, desc) =>
    el('li', { class: 'howto-role howto-role-' + team },
      el('span', { class: 'howto-role-name' }, name),
      el('span', { class: 'howto-role-desc' }, desc));

  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'How to play'),
    el('p', { class: 'tagline' },
      'Avalon is a game of ', el('span', { class: 'accent' }, 'hidden roles'),
      ' for 5–10 players. Everyone is secretly ', el('span', { class: 'good' }, 'Good'),
      ' or ', el('span', { class: 'evil' }, 'Evil'), '.'),

    el('section', { class: 'howto-section' },
      el('div', { class: 'section-label' }, 'THE GOAL'),
      el('p', { class: 'howto-text' },
        'Good wins by succeeding ', el('strong', {}, '3 of 5 Quests'),
        '. Evil wins by failing 3 Quests — or, at the very end, by ',
        el('strong', {}, 'assassinating Merlin'), '. Evil knows who each other are; '
        + 'Good must work it out from how people vote and play.'),
    ),

    el('section', { class: 'howto-section' },
      el('div', { class: 'section-label' }, 'A ROUND, STEP BY STEP'),
      el('ol', { class: 'howto-steps' },
        step(1, 'A leader proposes a team',
          el('p', { class: 'howto-text' },
            'The leader picks players to go on the Quest. The number needed is set by the '
            + 'board for the current round and player count.')),
        step(2, 'Everyone votes on the team',
          el('p', { class: 'howto-text' },
            'All players simultaneously Approve or Reject the proposed team. A majority '
            + 'Approve sends it on the Quest; otherwise leadership passes to the next player '
            + 'and a new team is proposed. ',
            el('strong', {}, 'Five rejected proposals in one round = Evil wins that Quest.'))),
        step(3, 'The team goes on the Quest',
          el('p', { class: 'howto-text' },
            'Only the chosen team members secretly play a card: ',
            el('span', { class: 'good' }, 'Success'), ' or ', el('span', { class: 'evil' }, 'Fail'),
            '. Good players must play Success. Evil players may play either. ',
            'Cards are shuffled, so you see the count but not who played what.')),
        step(4, 'Resolve the Quest',
          el('p', { class: 'howto-text' },
            'One Fail card usually fails the Quest. (With 7+ players, the 4th Quest needs '
            + 'two Fails.) Then the next round begins with a new leader.')),
      ),
    ),

    el('section', { class: 'howto-section' },
      el('div', { class: 'section-label' }, 'WINNING'),
      el('p', { class: 'howto-text' },
        'First side to ', el('strong', {}, '3 Quests'), ' wins the board. But if Good reaches 3, '
        + 'Evil gets one last chance: the ', el('span', { class: 'evil' }, 'Assassin'),
        ' names the player they think is ', el('span', { class: 'good' }, 'Merlin'),
        '. Guess right and Evil steals the win.'),
    ),

    el('section', { class: 'howto-section' },
      el('div', { class: 'section-label' }, 'SPECIAL ROLES'),
      el('ul', { class: 'howto-roles' },
        role('Merlin', 'good', 'Knows who the Evil players are — but must stay hidden, or the Assassin will find them.'),
        role('Percival', 'good', 'Sees Merlin (and Morgana) but can\'t tell which is which.'),
        role('Loyal Servant', 'good', 'No special knowledge — just vote and play wisely.'),
        role('Assassin', 'evil', 'At the end, picks who to assassinate. Killing Merlin wins the game for Evil.'),
        role('Morgana', 'evil', 'Appears to Percival as Merlin, sowing doubt.'),
        role('Mordred', 'evil', 'Hidden from Merlin — Good\'s seer never sees them.'),
        role('Oberon', 'evil', 'Evil, but unknown to the other Evil players (and they\'re unknown to Oberon).'),
        role('Minion of Mordred', 'evil', 'Plain Evil — knows the other Evil players.'),
      ),
      el('p', { class: 'fine' }, 'The host picks which roles are in play before each game. '
        + 'Some setups add advanced roles (Cleric, Lancelot, Lunatic and more) — when you have one, '
        + 'your private role card explains exactly what it does.'),
    ),

    el('section', { class: 'howto-section' },
      el('div', { class: 'section-label' }, 'TIPS'),
      el('ul', { class: 'howto-tips' },
        el('li', {}, 'Watch who proposes and approves teams — patterns reveal sides.'),
        el('li', {}, 'A surprise Fail tells you an Evil player was on that team.'),
        el('li', {}, 'If you\'re Merlin, hint carefully — being too obviously informed gets you assassinated.'),
        el('li', {}, 'Talk! The real game happens in the discussion between rounds.'),
      ),
    ),

    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.backFromHowTo() }, '‹ BACK'),
    ),
  );
}

// The auto-discovered list of open games (or an explanatory fallback).
function discoveryList(app, intents, nameInput) {
  const state = app.discoveryState || 'idle';
  const games = app.discovered || [];

  if (state === 'unsupported') {
    return el('p', { class: 'fine' },
      'Automatic discovery isn’t available on the public signaling server — ',
      'enter the 4-digit code the host is showing instead. ',
      '(Self-host a PeerServer on your LAN to enable the live list.)');
  }

  if (state === 'searching' && games.length === 0) {
    return el('div', { class: 'discovery-status' },
      el('div', { class: 'spinner spinner-sm' }),
      el('span', { class: 'fine' }, 'Looking for open games…'),
    );
  }

  if (games.length === 0) {
    return el('p', { class: 'fine' },
      'No open games found yet. Make sure you’re on the same Wi-Fi as the host, or enter a code below.');
  }

  const spectate = !!app.spectatorMode;

  return el('ul', { class: 'game-list' },
    ...games.map(g => {
      // Spectators may watch ANY game (lobby or in-progress); players can only
      // enter a game still in its lobby.
      const actionable = spectate ? true : g.joinable;
      const act = () => actionable && (spectate
        ? intents.spectate(g.code, nameInput.value)
        : intents.join(g.code, nameInput.value));
      return el('li', {},
        el('button', {
          class: 'game-row' + (actionable ? '' : ' game-row-busy'),
          disabled: actionable ? false : true,
          onclick: act,
        },
          el('span', { class: 'game-code' }, g.code),
          el('span', { class: 'game-meta' },
            el('span', { class: 'game-host' }, (g.hostName || 'Host') + '’s game'),
            el('span', { class: 'game-sub' },
              g.joinable
                ? `${g.playerCount} ${g.playerCount === 1 ? 'player' : 'players'} in lobby`
                : (spectate ? 'In progress — watch live' : 'In progress — can’t join')),
          ),
          el('span', { class: 'game-go' }, actionable ? '▷' : '🔒'),
        ),
      );
    }),
  );
}

function infoScreen(title, body, spinner, ...extra) {
  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, title),
    el('p', { class: 'tagline' }, body),
    spinner ? el('div', { class: 'spinner' }) : null,
    ...extra,
    liveRegion(title),
  );
}

function errorScreen(app, intents) {
  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'Connection problem'),
    el('p', { class: 'error-text', role: 'alert' }, app.error || 'Something went wrong.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK HOME'),
    ),
  );
}

// ---------------------------------------------------------------------------
// GAME (dispatches on phase)
// ---------------------------------------------------------------------------
function gameScreen(app, intents) {
  const pub = app.pub;
  if (!pub) return infoScreen('Loading…', 'Syncing with the host.', true);

  switch (pub.phase) {
    case 'lobby':         return lobbyScreen(app, intents);
    case 'roleReveal':    return roleRevealScreen(app, intents);
    case 'lady':          return ladyScreen(app, intents);
    case 'assassination': return assassinationScreen(app, intents);
    case 'gameover':      return gameOverScreen(app, intents);
    default:              return boardScreen(app, intents); // proposal/vote/quest
  }
}

// ---------------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------------
function lobbyScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost || app.me.owner;   // owner controls the lobby in server mode
  const players = pub.players;

  const roster = el('ul', { class: 'roster' },
    ...players.map(p => el('li', { class: 'roster-item' },
      el('span', { class: 'dot ' + (p.online ? 'on' : 'off') }),
      el('span', { class: 'roster-name' }, p.name),
      p.isHost ? el('span', { class: 'pill pill-sm' }, 'HOST') : null,
      // Host/owner can remove anyone but themselves, lobby-only (this screen is
      // lobby). Native confirm() guards against a fat-fingered tap.
      (isHost && !p.isHost) ? el('button', {
        class: 'roster-kick',
        title: `Remove ${p.name}`,
        'aria-label': `Remove ${p.name}`,
        onclick: () => { if (confirm(`Remove ${p.name} from the game?`)) intents.kickPlayer(p.id); },
      }, '✕') : null,
    )),
  );

  const children = [
    wordmark(),
    el('div', { class: 'code-card', title: 'Tap to copy', onclick: () => intents.copyCode && intents.copyCode() },
      el('div', { class: 'code-label' }, 'ROOM CODE'),
      el('div', { class: 'code-value' }, app.code || '----'),
      el('div', { class: 'code-hint' }, app.copied ? 'COPIED ✓' : 'TAP TO COPY'),
    ),
    el('div', { class: 'section-label' }, `PLAYERS · ${players.length}/${MAX_PLAYERS}`),
    roster,
  ];

  // Watch-only spectators (server-supplied, online-only) — listed separately so
  // they're clearly not part of the player count / lineup.
  const spectators = pub.spectators || [];
  if (spectators.length) {
    children.push(el('div', { class: 'section-label' }, `SPECTATORS · ${spectators.length}`));
    children.push(el('ul', { class: 'roster' },
      ...spectators.map(s => el('li', { class: 'roster-item' },
        el('span', { class: 'dot on' }),
        el('span', { class: 'roster-name' }, s.name),
        el('span', { class: 'pill pill-sm' }, 'WATCHING'),
      )),
    ));
  }

  if (isHost) {
    children.push(roleConfigEditor(app, intents));
    children.push(gameOptions(app, intents));
    const v = validateRoleConfig(app.pub.config || {}, players.length);
    const canStart = players.length >= MIN_PLAYERS && players.length <= MAX_PLAYERS && v.ok;
    if (!canStart) {
      children.push(el('p', { class: 'fine' },
        players.length < MIN_PLAYERS
          ? `Need at least ${MIN_PLAYERS} players to start.`
          : (v.errors[0] || '')));
    } else if (v.warnings && v.warnings.length) {
      // Non-blocking advice: the host can still start with this lineup.
      children.push(el('p', { class: 'fine warn' }, '⚠ ' + v.warnings[0]));
    }
    children.push(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary' + (canStart ? '' : ' btn-disabled'),
        disabled: canStart ? false : true,
        onclick: () => canStart && intents.startGame(),
      }, '> START GAME'),
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE'),
    ));
  } else {
    children.push(el('p', { class: 'tagline' }, 'Waiting for the host to ', el('span', { class: 'accent' }, 'start the game'), '…'));
    children.push(el('div', { class: 'spinner' }));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.requestLeaveGame }, 'LEAVE')));
  }

  return shell(...children, liveRegion(
    `${players.length} players in lobby` + (spectators.length ? `, ${spectators.length} watching` : '')));
}

function roleConfigEditor(app, intents) {
  const count = app.pub.players.length;
  const cfg = app.pub.config || {};
  const target = ROLE_COUNTS[count];
  const v = validateRoleConfig(cfg, count);

  const toggles = el('div', { class: 'toggle-list' },
    ...OPTIONAL_TOGGLES.map(def => {
      const on = !!(app.toggles && app.toggles[def.key]);
      return el('label', { class: 'toggle' + (on ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(on ? { checked: true } : {}),
          onchange: () => intents.toggleRole(def.key),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, def.label),
          el('span', { class: 'toggle-blurb' }, def.blurb),
        ),
        el('span', { class: 'pill pill-sm ' + (def.team === 'evil' ? 'pill-evil' : 'pill-good') },
          def.team === 'evil' ? 'EVIL' : 'GOOD'),
      );
    }),
  );

  // Read-only lineup: the filler roles and how many seats they take.
  const fillers = el('div', { class: 'toggle-list' },
    ...FILLER_ROLE_IDS.map(id => {
      const role = ROLES[id];
      const n = cfg[id] || 0;
      return el('div', { class: 'filler-row' },
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, role.name),
          el('span', { class: 'toggle-blurb' }, role.blurb),
        ),
        el('span', { class: 'pill pill-sm ' + (role.team === 'evil' ? 'pill-evil' : 'pill-good') },
          role.team === 'evil' ? 'EVIL' : 'GOOD'),
        el('span', { class: 'filler-count' }, '×' + n),
      );
    }),
  );

  const counts = target
    ? el('div', { class: 'count-row' },
        el('span', { class: 'pill pill-good' }, `GOOD ${v.good}/${target.good}`),
        el('span', { class: 'pill pill-evil' }, `EVIL ${v.evil}/${target.evil}`),
      )
    : el('p', { class: 'fine' }, `Need ${MIN_PLAYERS}-${MAX_PLAYERS} players.`);

  return el('section', { class: 'config' },
    el('div', { class: 'section-label' }, 'OPTIONAL ROLES'),
    el('p', { class: 'fine' }, 'Merlin & Assassin are always in.'),
    toggles,
    el('div', { class: 'section-label' }, 'FILLS REMAINING SEATS'),
    fillers,
    counts,
  );
}

// Host-only game options (non-role settings).
function gameOptions(app, intents) {
  const revealOn = !!app.allowReveal;
  const randomOn = !!app.randomLeaderOrder;
  const timerOn = !!app.questTimerEnabled;
  const pendingOn = !!app.showPendingVoters;
  const ladyOn = !!app.ladyEnabled;
  const timerMin = Math.round((app.questTimerSeconds || 120) / 60);

  // Minute picker (1-5), shown only when the proposal timer is enabled.
  const minutePicker = timerOn
    ? el('div', { class: 'timer-picker' },
        el('span', { class: 'timer-picker-label' }, 'MINUTES PER PROPOSAL'),
        el('div', { class: 'timer-picker-row' },
          ...[1, 2, 3, 4, 5].map(m => el('button', {
            type: 'button',
            class: 'timer-chip' + (m === timerMin ? ' sel' : ''),
            onclick: () => intents.setQuestTimerMinutes(m),
          }, String(m))),
        ),
      )
    : null;

  return el('section', { class: 'config' },
    el('div', { class: 'section-label' }, 'GAME OPTIONS'),
    el('div', { class: 'toggle-list' },
      el('label', { class: 'toggle' + (revealOn ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(revealOn ? { checked: true } : {}),
          onchange: () => intents.toggleReveal(),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, 'Re-check role anytime'),
          el('span', { class: 'toggle-blurb' }, 'Players can privately peek at their own role throughout the game.'),
        ),
      ),
      el('label', { class: 'toggle' + (randomOn ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(randomOn ? { checked: true } : {}),
          onchange: () => intents.toggleRandomLeader(),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, 'Random leader order'),
          el('span', { class: 'toggle-blurb' }, 'Shuffle the leader rotation each game instead of going around the table in order.'),
        ),
      ),
      el('label', { class: 'toggle' + (timerOn ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(timerOn ? { checked: true } : {}),
          onchange: () => intents.toggleQuestTimer(),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, 'Proposal timer'),
          el('span', { class: 'toggle-blurb' }, 'Give the leader a countdown to pick each quest team. Time-out passes leadership to the next player (no penalty).'),
        ),
      ),
      el('label', { class: 'toggle' + (pendingOn ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(pendingOn ? { checked: true } : {}),
          onchange: () => intents.toggleShowPendingVoters(),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, 'Show pending voters'),
          el('span', { class: 'toggle-blurb' }, 'During the team vote, show everyone which players still haven\'t voted — no hint at how they voted.'),
        ),
      ),
      el('label', { class: 'toggle' + (ladyOn ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(ladyOn ? { checked: true } : {}),
          onchange: () => intents.toggleLady(),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, 'Lady of the Lake'),
          el('span', { class: 'toggle-blurb' }, 'After quests 2, 3 and 4, the token holder privately learns one player\'s true loyalty, then passes the token to them. Best with 7+ players.'),
        ),
      ),
    ),
    minutePicker,
  );
}

// ---------------------------------------------------------------------------
// ROLE REVEAL — hold-to-reveal card
// ---------------------------------------------------------------------------
// Build the hold-to-reveal role card from a private state slice. Shared by the
// role-reveal phase and the optional mid-game "peek" affordance.
function buildRoleCard(priv) {
  const role = priv && priv.role;

  const front = el('div', { class: 'flip-front' },
    el('div', { class: 'card-eyebrow' }, 'YOUR ROLE'),
    el('div', { class: 'card-tap' }, 'HOLD TO REVEAL'),
    el('div', { class: 'fine' }, 'Keep your screen private.'),
  );

  let backChildren = [el('div', { class: 'card-eyebrow' }, 'YOUR ROLE')];
  if (role) {
    backChildren.push(el('div', { class: 'role-name ' + role.team }, role.name));
    backChildren.push(el('div', { class: 'pill ' + (role.team === 'evil' ? 'pill-evil' : 'pill-good') },
      role.team === 'evil' ? 'EVIL' : 'GOOD'));
    backChildren.push(el('p', { class: 'role-blurb' }, role.blurb));
    const k = priv.knowledge;
    if (k) {
      backChildren.push(el('div', { class: 'know' },
        el('div', { class: 'know-label' }, k.seesLabel),
        k.sees && k.sees.length
          ? el('div', { class: 'know-list' }, ...k.sees.map(s => el('span', { class: 'pill pill-name' }, s.name)))
          : el('div', { class: 'fine' }, k.note),
      ));
    }
  }
  const back = el('div', { class: 'flip-back' }, ...backChildren);

  const card = el('div', { class: 'flip-card', tabindex: '0', 'aria-label': 'Hold to reveal your role' }, front, back);
  // Hold-to-reveal: only show while pressed/held.
  const reveal = () => card.classList.add('revealed');
  const hide = () => card.classList.remove('revealed');
  card.addEventListener('mousedown', reveal);
  card.addEventListener('touchstart', (e) => { e.preventDefault(); reveal(); }, { passive: false });
  card.addEventListener('mouseup', hide);
  card.addEventListener('mouseleave', hide);
  card.addEventListener('touchend', hide);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') reveal(); });
  card.addEventListener('keyup', hide);
  return card;
}

// Optional mid-game role re-check, gated by the host's allowReveal option.
function rolePeek(app) {
  if (!app.pub || !app.pub.allowReveal) return null;
  if (!app.priv || !app.priv.role) return null;
  return el('details', { class: 'role-peek' },
    el('summary', { class: 'role-peek-summary' }, 'Peek at your role'),
    el('p', { class: 'fine' }, 'Hold the card to reveal. Keep your screen private.'),
    buildRoleCard(app.priv),
  );
}

function roleRevealScreen(app, intents) {
  const priv = app.priv;
  const pub = app.pub;

  const card = buildRoleCard(priv);
  const ready = priv && priv.ready;
  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'Role reveal'),
    el('p', { class: 'tagline' }, 'Look in private, then ready up.'),
    card,
    el('div', { class: 'section-label' }, `READY · ${pub.readyCount}/${pub.playerCount}`),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn ' + (ready ? 'btn-secondary btn-disabled' : 'btn-primary'),
        disabled: ready ? true : false,
        onclick: () => !ready && intents.ready(),
      }, ready ? 'READY ✓ — WAITING' : '> READY'),
    ),
    liveRegion('Role revealed'),
  );
}

// ---------------------------------------------------------------------------
// BOARD (proposal / vote / quest) — shared board + context panel
// ---------------------------------------------------------------------------
function boardScreen(app, intents) {
  const pub = app.pub;
  return shell(
    boardHeader(pub),
    // The quest progress row stays pinned to the top so it's always visible,
    // even after scrolling past the roster on smaller screens.
    el('div', { class: 'quest-track-sticky' }, questTrack(pub)),
    voteTrack(pub),
    rosterBoard(pub, app),
    contextPanel(app, intents),
    rolePeek(app),
    liveRegion(phaseAnnouncement(pub)),
  );
}

function boardHeader(pub) {
  const leader = pub.players.find(p => p.id === pub.leaderId);
  return el('header', { class: 'board-head' },
    el('div', { class: 'section-label' }, `QUEST ${pub.currentQuest + 1} OF 5`),
    el('div', { class: 'lead-line' },
      'Leader: ', el('span', { class: 'accent' }, leader ? leader.name : '—'),
    ),
  );
}

function questTrack(pub) {
  const sizes = pub.questSizes || [];
  const nodes = sizes.map((sz, i) => {
    const res = pub.questResults[i];
    let cls = 'quest-node';
    if (res === 'success') cls += ' success';
    else if (res === 'fail') cls += ' fail';
    else if (i === pub.currentQuest) cls += ' current';
    const twoFail = (i === 3 && pub.playerCount >= 7);
    return el('div', { class: cls },
      el('div', { class: 'quest-size' }, String(sz)),
      el('div', { class: 'quest-num' }, `Q${i + 1}`),
      twoFail ? el('div', { class: 'quest-flag', title: 'Needs 2 fails' }, '2✗') : null,
    );
  });
  return el('div', { class: 'quest-track' }, ...nodes);
}

function voteTrack(pub) {
  const dots = [];
  for (let i = 0; i < pub.maxRejects; i++) {
    dots.push(el('span', { class: 'vote-dot' + (i < pub.rejectCount ? ' filled' : '') }));
  }
  return el('div', { class: 'vote-track' },
    el('span', { class: 'vt-label' }, 'REJECTS'),
    el('span', { class: 'vt-dots' }, ...dots),
    el('span', { class: 'vt-warn' }, 'EVIL WINS AT 5'),
  );
}

function rosterBoard(pub, app) {
  const proposed = new Set(pub.proposal ? pub.proposal.members : []);
  return el('ul', { class: 'roster roster-board' },
    ...pub.players.map(p => {
      const me = p.id === app.me.id;
      return el('li', { class: 'roster-item' + (proposed.has(p.id) ? ' on-team' : '') },
        el('span', { class: 'dot ' + (p.online ? 'on' : 'off') }),
        el('span', { class: 'roster-name' }, p.name + (me ? ' (you)' : '')),
        p.isLeader ? el('span', { class: 'pill pill-sm pill-lead' }, 'LEADER') : null,
        pub.ladyHolderId === p.id ? el('span', { class: 'pill pill-sm pill-lady' }, 'LADY') : null,
        proposed.has(p.id) ? el('span', { class: 'pill pill-sm' }, 'ON QUEST') : null,
      );
    }),
  );
}

function contextPanel(app, intents) {
  const pub = app.pub;
  switch (pub.phase) {
    case 'proposal': return proposalPanel(app, intents);
    case 'vote':     return votePanel(app, intents);
    case 'quest':    return questPanel(app, intents);
    default:         return el('div');
  }
}

// --- Proposal --------------------------------------------------------------
function proposalPanel(app, intents) {
  const pub = app.pub;
  const isLeader = pub.leaderId === app.me.id;
  const need = pub.requiredTeamSize;

  if (!isLeader) {
    const leader = pub.players.find(p => p.id === pub.leaderId);
    return panel('TEAM PROPOSAL',
      proposalCountdown(app),
      el('p', { class: 'tagline' }, 'Waiting for ',
        el('span', { class: 'accent' }, leader ? leader.name : 'the leader'),
        ` to propose a team of ${need}.`),
      el('div', { class: 'spinner' }),
    );
  }

  // Leader: selectable chips.
  const selected = new Set(app.selectedTeam || []);
  const chips = el('div', { class: 'chip-grid' },
    ...pub.players.map(p => el('button', {
      class: 'chip' + (selected.has(p.id) ? ' sel' : ''),
      onclick: () => intents.toggleTeamPick(p.id),
    }, p.name)),
  );
  const ready = selected.size === need;
  return panel(`PROPOSE A TEAM OF ${need}`,
    proposalCountdown(app),
    el('p', { class: 'fine' }, `Selected ${selected.size}/${need}.`),
    chips,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn ' + (ready ? 'btn-primary' : 'btn-primary btn-disabled'),
        disabled: ready ? false : true,
        onclick: () => ready && intents.propose([...selected]),
      }, '> CONFIRM TEAM'),
    ),
  );
}

// Live countdown shown to everyone during the proposal phase when the host
// enabled the proposal timer. Computed from a local deadline so it stays smooth
// between state pushes; main.js drives a 1s repaint while this is on screen.
function proposalCountdown(app) {
  if (app.localProposalDeadline == null) return null;
  const remMs = Math.max(0, app.localProposalDeadline - Date.now());
  const totalSec = Math.ceil(remMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const label = `${m}:${String(s).padStart(2, '0')}`;
  const urgent = totalSec <= 30;
  return el('div', { class: 'proposal-timer' + (urgent ? ' urgent' : '') },
    el('span', { class: 'timer-eyebrow' }, 'TIME LEFT'),
    el('span', { class: 'timer-clock' }, label),
  );
}

// --- Vote ------------------------------------------------------------------
function votePanel(app, intents) {
  const pub = app.pub;

  // Reveal beat: show everyone's vote + outcome.
  if (pub.revealedVotes && pub.voteResolved) {
    const rows = el('ul', { class: 'vote-reveal' },
      ...pub.revealedVotes.map(v => el('li', {},
        el('span', { class: 'roster-name' }, v.name),
        el('span', { class: 'pill pill-sm ' + (v.vote ? 'pill-good' : 'pill-evil') },
          v.vote === null ? '—' : (v.vote ? 'APPROVE' : 'REJECT')),
      )),
    );
    return panel(pub.lastVoteApproved ? 'TEAM APPROVED' : 'TEAM REJECTED', rows);
  }

  const hasVoted = app.priv && app.priv.hasVoted;
  const currentVote = app.priv ? app.priv.currentVote : null;
  const team = pub.proposal ? pub.proposal.members : [];
  const teamNames = pub.players.filter(p => team.includes(p.id)).map(p => p.name);
  const progress = pub.voteProgress || [];
  const votedCount = progress.filter(x => x.voted).length;

  const approveSelected = hasVoted && currentVote === true;
  const rejectSelected = hasVoted && currentVote === false;

  const header = panel('VOTE ON THE TEAM',
    el('p', { class: 'tagline' }, 'Proposed: ',
      el('span', { class: 'accent' }, teamNames.join(', ') || '—')),
  );

  if (hasVoted) {
    header.appendChild(el('p', { class: 'fine' }, `${votedCount}/${progress.length} votes in… You can change your mind.`));
  }

  // Host option: surface WHO still owes a vote (never how anyone voted).
  if (pub.showPendingVoters) {
    const pending = pendingVotersBlock(pub);
    if (pending) header.appendChild(pending);
  }

  header.appendChild(el('div', { class: 'btn-row' },
    el('button', {
      class: 'btn btn-primary' + (approveSelected ? ' btn-selected' : ''),
      onclick: () => intents.vote(true),
    }, '✓ APPROVE'),
    el('button', {
      class: 'btn btn-secondary' + (rejectSelected ? ' btn-selected' : ''),
      onclick: () => intents.vote(false),
    }, '✗ REJECT'),
  ));
  return header;
}

// Names of online players who still owe a vote (host "Show pending voters"
// option). Reveals only WHO is outstanding, never which way anyone voted.
function pendingVotersBlock(pub) {
  const progress = pub.voteProgress || [];
  const nameById = new Map(pub.players.map(p => [p.id, p.name]));
  const pending = progress.filter(x => !x.voted).map(x => nameById.get(x.id) || '—');
  if (pending.length === 0) {
    return el('p', { class: 'fine pending-done' }, 'All votes in — revealing…');
  }
  return el('div', { class: 'pending-voters' },
    el('span', { class: 'pending-label' }, `WAITING ON ${pending.length}`),
    el('div', { class: 'pending-names' },
      ...pending.map(n => el('span', { class: 'pending-chip' }, n)),
    ),
  );
}

// --- Quest -----------------------------------------------------------------
function questPanel(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};

  if (pub.questResolved) {
    const ok = pub.lastQuestResult === 'success';
    return panel(ok ? 'QUEST SUCCEEDED' : 'QUEST FAILED',
      el('p', { class: 'big-stat ' + (ok ? 'good' : 'evil') },
        `${pub.lastQuestFails} fail${pub.lastQuestFails === 1 ? '' : 's'}`),
      el('p', { class: 'fine' }, 'Tallying the next round…'),
    );
  }

  const progress = pub.questProgress || [];
  const playedCount = progress.filter(x => x.played).length;

  if (!priv.onQuest) {
    return panel('QUEST UNDERWAY',
      el('p', { class: 'tagline' }, 'The team is deciding the quest\'s fate.'),
      el('p', { class: 'fine' }, `${playedCount}/${progress.length} cards played…`),
      el('div', { class: 'spinner' }),
    );
  }

  if (priv.hasPlayedCard) {
    return panel('CARD PLAYED',
      el('p', { class: 'fine' }, `Waiting for the rest… ${playedCount}/${progress.length} in.`),
      el('div', { class: 'spinner' }),
    );
  }

  // Everyone sees the SAME two options (Success + Fail) so a glance at another
  // player's screen never reveals their allegiance. The engine still enforces
  // the real rules — tapping a card you're not allowed to play shows a private
  // nudge instead of submitting anything.
  const successAllowed = !priv.mustFail;            // only the Lunatic can't succeed
  const failAllowed = priv.mayFail || priv.mustFail; // evil (and the compelled Lunatic)

  const notice = app.questNotice
    ? el('p', { class: 'error-text', role: 'alert' },
        app.questNotice === 'fail'
          ? 'You cannot play Fail on this quest.'
          : 'You cannot play Success on this quest.')
    : null;

  return panel('PLAY YOUR QUEST CARD',
    el('p', { class: 'fine' }, 'Play your card to decide the quest\'s fate.'),
    notice,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        onclick: successAllowed ? () => intents.playCard(true) : () => intents.questBlocked('success'),
      }, '✓ SUCCESS'),
      el('button', {
        class: 'btn btn-secondary btn-fail',
        onclick: failAllowed ? () => intents.playCard(false) : () => intents.questBlocked('fail'),
      }, '✗ FAIL'),
    ),
  );
}

// ---------------------------------------------------------------------------
// LADY OF THE LAKE — the token holder privately inspects one player's loyalty,
// then the token passes to that player. Only the holder ever sees the result.
// ---------------------------------------------------------------------------
function ladyScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};
  const holder = pub.players.find(p => p.id === pub.ladyHolderId);
  const canControl = app.me.isHost || app.me.owner;

  // (a) Holder has looked — show the private loyalty result, then continue.
  if (priv.isLady && priv.ladyResult) {
    const evil = priv.ladyResult.team === 'evil';
    return shell(
      wordmark(),
      el('h1', { class: 'hero hero-sm' }, 'Lady of the Lake'),
      el('p', { class: 'tagline' }, 'You looked into the loyalty of ',
        el('span', { class: 'accent' }, priv.ladyResult.targetName), '.'),
      el('div', { class: 'lady-result' },
        el('div', { class: 'lady-result-name' }, priv.ladyResult.targetName),
        el('div', { class: 'pill ' + (evil ? 'pill-evil' : 'pill-good') }, evil ? 'EVIL' : 'GOOD'),
      ),
      el('p', { class: 'fine' }, 'Only you can see this. The token now passes to them.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: () => intents.ladyContinue() }, '> CONTINUE'),
      ),
      liveRegion('Loyalty revealed'),
    );
  }

  // (b) Holder is choosing whom to inspect.
  if (priv.isLady) {
    const chips = el('div', { class: 'chip-grid' },
      ...(priv.ladyTargets || []).map(t => el('button', {
        class: 'chip',
        onclick: () => { if (confirm(`Inspect ${t.name}'s loyalty?`)) intents.ladyInspect(t.id); },
      }, t.name)),
    );
    return shell(
      wordmark(),
      el('h1', { class: 'hero hero-sm' }, 'Lady of the Lake'),
      el('p', { class: 'tagline' }, 'You hold the Lady. Choose a player to ',
        el('span', { class: 'accent' }, 'inspect their loyalty'), ' — privately, for your eyes only.'),
      chips,
      rolePeek(app),
      liveRegion('You hold the Lady of the Lake'),
    );
  }

  // (c) Everyone else waits. A controlling host who isn't the holder can skip
  // (e.g. the holder went AWOL) so a stalled inspection can't freeze the game.
  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'Lady of the Lake'),
    el('p', { class: 'tagline' },
      el('span', { class: 'accent' }, holder ? holder.name : 'A player'),
      pub.ladyResolved ? ' has looked into someone\'s loyalty.' : ' is inspecting someone\'s loyalty…'),
    el('div', { class: 'spinner' }),
    canControl ? el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: () => intents.ladySkip() }, 'SKIP (HOST)'),
    ) : null,
    rolePeek(app),
    liveRegion('Lady of the Lake in progress'),
  );
}

// ---------------------------------------------------------------------------
// ASSASSINATION
// ---------------------------------------------------------------------------
function assassinationScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};

  if (priv.isAssassin) {
    const chips = el('div', { class: 'chip-grid' },
      ...(priv.assassinTargets || []).map(t => el('button', {
        class: 'chip',
        onclick: () => { if (confirm(`Name ${t.name} as Merlin?`)) intents.assassinate(t.id); },
      }, t.name)),
    );
    return shell(
      wordmark(),
      el('h1', { class: 'hero hero-sm evil' }, 'Assassinate'),
      el('p', { class: 'tagline' }, 'Good completed three quests. Name ',
        el('span', { class: 'accent' }, 'Merlin'), ' to seize victory for Evil.'),
      chips,
      rolePeek(app),
      liveRegion('Assassination phase'),
    );
  }

  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'A blade in the dark'),
    el('p', { class: 'tagline' }, 'Good won the quests… but the ',
      el('span', { class: 'accent' }, 'Assassin'), ' is hunting Merlin. Hold your breath.'),
    el('div', { class: 'spinner' }),
    rolePeek(app),
    liveRegion('The Assassin is choosing'),
  );
}

// ---------------------------------------------------------------------------
// GAME OVER
// ---------------------------------------------------------------------------
function gameOverScreen(app, intents) {
  const pub = app.pub;
  const evilWon = pub.winner === 'evil';

  const table = el('table', { class: 'reveal-table' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Player'), el('th', {}, 'Role'), el('th', {}, 'Side'))),
    el('tbody', {}, ...(pub.reveal || []).map(r => el('tr', {},
      el('td', {}, r.name + (r.id === pub.assassinTargetId ? ' 🗡' : '')),
      el('td', {}, r.roleName),
      el('td', {}, el('span', { class: 'pill pill-sm ' + (r.team === 'evil' ? 'pill-evil' : 'pill-good') },
        r.team === 'evil' ? 'EVIL' : 'GOOD')),
    ))),
  );

  const children = [
    wordmark(),
    el('div', { class: 'win-banner ' + (evilWon ? 'evil' : 'good') },
      el('div', { class: 'win-side' }, evilWon ? 'EVIL WINS' : 'GOOD WINS'),
      el('div', { class: 'win-reason' }, pub.winReason || ''),
    ),
    el('div', { class: 'section-label' }, 'ALL ROLES'),
    table,
  ];

  if (app.me.isHost || app.me.owner) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: intents.playAgain }, '> PLAY AGAIN'),
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'NEW GAME'),
    ));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the host to start a new round, or leave to go home.'));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.requestLeaveGame }, 'LEAVE')));
  }

  return shell(...children, liveRegion(evilWon ? 'Evil wins' : 'Good wins'));
}

// ---------------------------------------------------------------------------
// SPECTATOR — a single-screen, TV-optimised PUBLIC view. No scrolling, no
// controls, and never any secret info: a spectator is just another client that
// receives publicState() with priv=null, so it can ONLY ever show what every
// player already sees on the shared board (roster, quest track, rejects, the
// current phase, vote tallies once revealed, and the full reveal at game over).
// Everything is sized to the viewport so a wall display can stay untouched.
// ---------------------------------------------------------------------------
function spectatorScreen(app, intents) {
  const pub = app.pub;
  if (!pub) return infoScreen('Connecting…', `Joining room ${app.code} as a spectator.`, true);

  const head = el('header', { class: 'tv-head' },
    el('div', { class: 'tv-brand' },
      el('span', { class: 'wordmark-dot' }), 'THE RESISTANCE · AVALON'),
    el('div', { class: 'tv-code' },
      el('span', { class: 'tv-code-label' }, 'ROOM'),
      el('span', { class: 'tv-code-value' }, app.code || '----')),
    el('div', { class: 'tv-badge' }, 'SPECTATOR'),
  );

  // Game over: hand the whole stage to the winner banner + full role reveal.
  if (pub.phase === 'gameover') {
    return el('main', { class: 'tv-shell tv-over' }, head, tvGameOver(pub, app.tvStats),
      liveRegion(pub.winner === 'evil' ? 'Evil wins' : 'Good wins'));
  }

  const body = (pub.phase === 'lobby')
    ? el('section', { class: 'tv-body tv-body-lobby' },
        el('div', { class: 'tv-left' }, tvRoster(pub), tvStatus(app)),
        tvRolesLineup(pub),
      )
    : el('section', { class: 'tv-body' },
        el('div', { class: 'tv-left' }, tvQuestTrack(pub), tvRoster(pub)),
        tvStatus(app),
      );

  return el('main', { class: 'tv-shell' },
    head,
    body,
    tvFoot(pub),
    liveRegion(phaseAnnouncement(pub)),
  );
}

// Large quest track for the TV view (Q1–Q5 with team sizes + results).
function tvQuestTrack(pub) {
  const sizes = pub.questSizes || [];
  const nodes = sizes.map((sz, i) => {
    const res = pub.questResults[i];
    let cls = 'tv-quest';
    if (res === 'success') cls += ' success';
    else if (res === 'fail') cls += ' fail';
    else if (i === pub.currentQuest) cls += ' current';
    const twoFail = (i === 3 && pub.playerCount >= 7);
    return el('div', { class: cls },
      el('div', { class: 'tv-quest-num' }, `Q${i + 1}`),
      el('div', { class: 'tv-quest-size' }, String(sz)),
      el('div', { class: 'tv-quest-mark' },
        res === 'success' ? '✓' : res === 'fail' ? '✗' : (twoFail ? '2✗' : '')),
    );
  });
  return el('div', { class: 'tv-quests' }, ...nodes);
}

// Player tiles — names only, plus public markers (leader, on-quest, online).
// NEVER renders a role or team: a spectator screen must reveal nothing secret.
function tvRoster(pub) {
  const proposed = new Set(pub.proposal ? pub.proposal.members : []);
  const n = pub.players.length;
  return el('ul', { class: 'tv-roster', 'data-n': String(n) },
    ...pub.players.map(p => el('li', {
      class: 'tv-player'
        + (p.isLeader ? ' is-leader' : '')
        + (proposed.has(p.id) ? ' on-team' : '')
        + (p.online ? '' : ' off'),
    },
      el('span', { class: 'tv-player-name' }, p.name),
      el('span', { class: 'tv-player-tags' },
        p.isLeader ? el('span', { class: 'tv-tag tv-tag-lead' }, 'LEADER') : null,
        p.id === pub.ladyHolderId ? el('span', { class: 'tv-tag tv-tag-lady' }, 'LADY') : null,
        proposed.has(p.id) ? el('span', { class: 'tv-tag' }, 'ON QUEST') : null,
        p.online ? null : el('span', { class: 'tv-tag tv-tag-off' }, 'AWAY'),
      ),
    )),
  );
}

// Lobby-only roles lineup for the TV: the FULL role catalogue with descriptions,
// split Good/Evil, dimming the ones not in this game's config and marking the
// selected ones (filler roles show their seat count). This is all public info
// (the config is in publicState) — it reveals the menu, never who holds what.
function tvRolesLineup(pub) {
  const cfg = pub.config || {};
  const card = (role) => {
    const n = cfg[role.id] || 0;
    const inPlay = n > 0 || !role.optional; // Merlin/Assassin are always in
    const isFiller = FILLER_ROLE_IDS.includes(role.id);
    const state = isFiller ? `×${n}` : (inPlay ? 'IN' : '—');
    return el('li', {
      class: 'tv-role ' + (role.team === 'evil' ? 'evil' : 'good') + (inPlay ? ' in' : ' out'),
    },
      el('div', { class: 'tv-role-head' },
        el('span', { class: 'tv-role-name' }, role.name),
        el('span', { class: 'tv-role-state' }, state),
      ),
      el('p', { class: 'tv-role-blurb' }, role.blurb),
    );
  };
  const all = Object.values(ROLES);
  const good = all.filter(r => r.team === 'good');
  const evil = all.filter(r => r.team === 'evil');
  return el('div', { class: 'tv-roles' },
    el('div', { class: 'tv-roles-col' },
      el('div', { class: 'tv-roles-head good' }, 'GOOD'),
      el('ul', { class: 'tv-roles-list' }, ...good.map(card)),
    ),
    el('div', { class: 'tv-roles-col' },
      el('div', { class: 'tv-roles-head evil' }, 'EVIL'),
      el('ul', { class: 'tv-roles-list' }, ...evil.map(card)),
    ),
  );
}

// Reject track + a one-line leader/phase caption along the bottom.
function tvFoot(pub) {
  const leader = pub.players.find(p => p.id === pub.leaderId);
  const dots = [];
  for (let i = 0; i < pub.maxRejects; i++) {
    dots.push(el('span', { class: 'tv-reject-dot' + (i < pub.rejectCount ? ' filled' : '') }));
  }
  return el('footer', { class: 'tv-foot' },
    el('div', { class: 'tv-foot-leader' },
      'LEADER ', el('span', { class: 'accent' }, leader ? leader.name : '—')),
    el('div', { class: 'tv-rejects' },
      el('span', { class: 'tv-rejects-label' }, 'REJECTS'),
      el('span', { class: 'tv-rejects-dots' }, ...dots),
      el('span', { class: 'tv-rejects-warn' }, 'EVIL WINS AT 5'),
    ),
  );
}

// The central status panel: a big, glanceable summary of the current beat.
function tvStatus(app) {
  const pub = app.pub;
  switch (pub.phase) {
    case 'lobby': {
      return tvPanel('IN THE LOBBY',
        el('p', { class: 'tv-lead' }, `${pub.playerCount} ${pub.playerCount === 1 ? 'player' : 'players'} joined`),
        el('p', { class: 'tv-sub' }, 'Waiting for the host to start the game…'),
      );
    }
    case 'roleReveal': {
      return tvPanel('ROLES DEALT',
        el('p', { class: 'tv-lead' }, `${pub.readyCount}/${pub.playerCount} ready`),
        el('p', { class: 'tv-sub' }, 'Players are reviewing their secret roles in private.'),
      );
    }
    case 'proposal': {
      const leader = pub.players.find(p => p.id === pub.leaderId);
      return tvPanel(`QUEST ${pub.currentQuest + 1} · PROPOSAL`,
        el('p', { class: 'tv-lead' },
          el('span', { class: 'accent' }, leader ? leader.name : 'The leader'),
          ' is choosing a team'),
        el('p', { class: 'tv-sub' }, `Team needs ${pub.requiredTeamSize} player${pub.requiredTeamSize === 1 ? '' : 's'}.`),
        tvCountdown(app),
      );
    }
    case 'vote': {
      // Reveal beat: show the outcome + each player's open vote (public once in).
      if (pub.revealedVotes && pub.voteResolved) {
        const approves = pub.revealedVotes.filter(v => v.vote === true).length;
        const rejects = pub.revealedVotes.filter(v => v.vote === false).length;
        return tvPanel(pub.lastVoteApproved ? 'TEAM APPROVED' : 'TEAM REJECTED',
          el('div', { class: 'tv-tally' },
            el('span', { class: 'tv-tally-cell good' }, `✓ ${approves}`),
            el('span', { class: 'tv-tally-cell evil' }, `✗ ${rejects}`),
          ),
          el('ul', { class: 'tv-votes' },
            ...pub.revealedVotes.map(v => el('li', {
              class: 'tv-vote ' + (v.vote === true ? 'yes' : v.vote === false ? 'no' : 'na'),
            }, el('span', { class: 'tv-vote-name' }, v.name),
               el('span', { class: 'tv-vote-mark' }, v.vote === null ? '—' : (v.vote ? '✓' : '✗')))),
          ),
        );
      }
      const team = pub.proposal ? pub.proposal.members : [];
      const teamNames = pub.players.filter(p => team.includes(p.id)).map(p => p.name);
      const progress = pub.voteProgress || [];
      const votedCount = progress.filter(x => x.voted).length;
      const children = [
        el('p', { class: 'tv-lead' }, 'Proposed: ',
          el('span', { class: 'accent' }, teamNames.join(', ') || '—')),
        el('p', { class: 'tv-sub' }, `${votedCount}/${progress.length} votes in…`),
      ];
      // Host option: surface WHO still owes a vote (never how anyone voted).
      if (pub.showPendingVoters) {
        const pending = pendingVotersBlock(pub);
        if (pending) children.push(pending);
      }
      return tvPanel(`QUEST ${pub.currentQuest + 1} · VOTE`, ...children);
    }
    case 'quest': {
      if (pub.questResolved) {
        const ok = pub.lastQuestResult === 'success';
        return tvPanel(ok ? `QUEST ${pub.currentQuest + 1} SUCCEEDED` : `QUEST ${pub.currentQuest + 1} FAILED`,
          el('p', { class: 'tv-bigstat ' + (ok ? 'good' : 'evil') },
            `${pub.lastQuestFails} fail${pub.lastQuestFails === 1 ? '' : 's'}`),
          el('p', { class: 'tv-sub' }, 'Tallying the next round…'),
        );
      }
      const progress = pub.questProgress || [];
      const played = progress.filter(x => x.played).length;
      return tvPanel(`QUEST ${pub.currentQuest + 1} · UNDERWAY`,
        el('p', { class: 'tv-lead' }, 'The team is deciding the quest\'s fate'),
        el('p', { class: 'tv-sub' }, `${played}/${progress.length} cards played…`),
      );
    }
    case 'lady': {
      const holder = pub.players.find(p => p.id === pub.ladyHolderId);
      return tvPanel('LADY OF THE LAKE',
        el('p', { class: 'tv-lead' },
          el('span', { class: 'accent' }, holder ? holder.name : 'A player'),
          pub.ladyResolved ? ' has looked' : ' holds the Lady'),
        el('p', { class: 'tv-sub' }, pub.ladyResolved
          ? 'The loyalty is known only to them. Passing the token…'
          : 'Privately inspecting another player\'s loyalty…'),
      );
    }
    case 'assassination': {
      return tvPanel('THE ASSASSIN STRIKES',
        el('p', { class: 'tv-lead evil' }, 'Good completed three quests'),
        el('p', { class: 'tv-sub' }, 'The Assassin is hunting Merlin. Hold your breath…'),
      );
    }
    default:
      return tvPanel('', el('div', { class: 'spinner' }));
  }
}

// Game-over stage for the TV: winner banner + full role reveal (public now) +
// the room's per-player standings (once the stats reply lands — see tvEndStats).
function tvGameOver(pub, stats) {
  const evilWon = pub.winner === 'evil';
  const cards = (pub.reveal || []).map(r => el('div', { class: 'tv-reveal-card ' + (r.team === 'evil' ? 'evil' : 'good') },
    el('span', { class: 'tv-reveal-name' }, r.name + (r.id === pub.assassinTargetId ? ' 🗡' : '')),
    el('span', { class: 'tv-reveal-role' }, r.roleName),
    el('span', { class: 'tv-tag ' + (r.team === 'evil' ? 'tv-tag-evil' : 'tv-tag-good') },
      r.team === 'evil' ? 'EVIL' : 'GOOD'),
  ));
  return el('section', { class: 'tv-body tv-body-over' },
    el('div', { class: 'tv-win ' + (evilWon ? 'evil' : 'good') },
      el('div', { class: 'tv-win-side' }, evilWon ? 'EVIL WINS' : 'GOOD WINS'),
      el('div', { class: 'tv-win-reason' }, pub.winReason || ''),
    ),
    el('div', { class: 'tv-reveal-grid', 'data-n': String((pub.reveal || []).length) }, ...cards),
    tvEndStats(stats),
  );
}

// Per-player standings beneath the reveal on the TV end screen. Shows the room's
// running leaderboard: the FULL column set (games / wins / win% + Good/Evil split
// and each player's most-played role) when there are few enough players to fit,
// otherwise a COMPACT cumulative view (games / wins / win%). Rows are capped at
// the top 10 by wins and the block is overflow-clipped, so the no-scroll TV layout
// never breaks. Renders nothing until the stats reply lands (or if no games are on
// record yet — e.g. server stats reset on restart).
function tvEndStats(stats) {
  if (!stats || !stats.leaderboard || stats.leaderboard.length === 0) return null;
  const summary = stats.summary || { gamesPlayed: 0, goodWins: 0, evilWins: 0 };
  const lb = stats.leaderboard.slice(0, 10);   // top-10 by wins; bounds height on a TV
  const full = lb.length <= 8;                 // space heuristic: full detail for typical games

  // A player's most-played role, e.g. "Merlin ×3 · 67%" — a light touch of the
  // per-role breakdown without a full sub-table (full mode only).
  const topRole = (roles) => {
    let best = null;
    for (const [rid, r] of Object.entries(roles || {})) {
      if (r.played > 0 && (!best || r.played > best.played)) best = { rid, played: r.played, wins: r.wins };
    }
    if (!best) return null;
    const def = ROLES[best.rid];
    const pct = best.played > 0 ? Math.round((best.wins / best.played) * 100) : 0;
    return `${def ? def.name : best.rid} ×${best.played} · ${pct}%`;
  };

  const head = () => full
    ? el('tr', {},
        el('th', { class: 'tv-lb-rank' }, '#'), el('th', { class: 'tv-lb-name' }, 'Player'),
        el('th', {}, 'GP'), el('th', {}, 'W'), el('th', {}, 'Win%'),
        el('th', {}, 'Good'), el('th', {}, 'Evil'), el('th', {}, 'GW'), el('th', {}, 'EW'))
    : el('tr', {},
        el('th', { class: 'tv-lb-rank' }, '#'), el('th', { class: 'tv-lb-name' }, 'Player'),
        el('th', {}, 'GP'), el('th', {}, 'W'), el('th', {}, 'Win%'));

  // One standings table for a slice of the board. `start` is the 0-based index of
  // the slice's first player so ranks stay continuous when compact mode splits the
  // board into side-by-side columns.
  const table = (slice, start) => {
    const rows = slice.map((p, j) => {
      const i = start + j;
      const roleStr = full ? topRole(p.roles) : null;
      const nameCell = el('td', { class: 'tv-lb-name' },
        el('span', { class: 'tv-lb-pname' }, p.name),
        roleStr ? el('span', { class: 'tv-lb-role' }, roleStr) : null,
      );
      const common = [
        el('td', { class: 'tv-lb-rank' }, String(i + 1)),
        nameCell,
        el('td', {}, String(p.gamesPlayed)),
        el('td', {}, String(p.wins)),
        el('td', {}, p.winPct + '%'),
      ];
      const extra = full ? [
        el('td', {}, String(p.good)),
        el('td', {}, String(p.evil)),
        el('td', {}, String(p.goodWins)),
        el('td', {}, String(p.evilWins)),
      ] : [];
      return el('tr', { class: i === 0 ? 'tv-lb-top' : '' }, ...common, ...extra);
    });
    return el('table', { class: 'tv-lb' }, el('thead', {}, head()), el('tbody', {}, ...rows));
  };

  // Full → a single table. Compact (many players) → two columns side by side so
  // the whole roster fits the no-scroll viewport (a 10-row table can't coexist
  // with a full 10-player reveal otherwise).
  let board;
  if (full) {
    board = table(lb, 0);
  } else {
    const half = Math.ceil(lb.length / 2);
    board = el('div', { class: 'tv-lb-cols' }, table(lb.slice(0, half), 0), table(lb.slice(half), half));
  }

  return el('section', { class: 'tv-endstats ' + (full ? 'full' : 'compact') },
    el('div', { class: 'tv-endstats-head' },
      el('span', { class: 'tv-endstats-label' }, 'STANDINGS'),
      el('span', { class: 'tv-endstats-sub' },
        `${summary.gamesPlayed} game${summary.gamesPlayed === 1 ? '' : 's'} · `,
        el('span', { class: 'good' }, `Good ${summary.goodWins}`), ' · ',
        el('span', { class: 'evil' }, `Evil ${summary.evilWins}`),
      ),
    ),
    el('div', { class: 'tv-endstats-wrap' }, board),
  );
}

// Spectator countdown — reuses the local proposal deadline that main.js keeps
// in sync (it drives a 1s repaint while the spectator screen is on, too).
function tvCountdown(app) {
  if (app.localProposalDeadline == null) return null;
  const remMs = Math.max(0, app.localProposalDeadline - Date.now());
  const totalSec = Math.ceil(remMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const urgent = totalSec <= 30;
  return el('div', { class: 'tv-timer' + (urgent ? ' urgent' : '') },
    el('span', { class: 'timer-eyebrow' }, 'TIME LEFT'),
    el('span', { class: 'tv-timer-clock' }, `${m}:${String(s).padStart(2, '0')}`),
  );
}

function tvPanel(label, ...children) {
  return el('section', { class: 'tv-status' },
    label ? el('div', { class: 'tv-status-label' }, label) : null,
    ...children,
  );
}

// ---------------------------------------------------------------------------
// STATISTICS / LEADERBOARD
// ---------------------------------------------------------------------------
function statsScreen(app, intents) {
  const data = app.statsData;
  if (!data) {
    return shell(
      wordmark(),
      el('h1', { class: 'hero hero-sm' }, 'Statistics'),
      el('p', { class: 'tagline' }, 'No data available.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: intents.backToGame }, '‹ BACK TO GAME')),
    );
  }

  const { summary, leaderboard } = data;

  const children = [
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'Leaderboard'),
    el('p', { class: 'tagline' }, 'Room ', el('span', { class: 'accent' }, app.code || '—')),
    roomSummaryBlock(summary),
    leaderboardTable(leaderboard),
    playerDetails(leaderboard),
  ];

  const actionBtns = [el('button', { class: 'btn btn-primary', onclick: intents.backToGame }, '‹ BACK TO GAME')];
  if (app.me.isHost) {
    actionBtns.push(el('button', { class: 'btn btn-danger', onclick: () => {
      if (confirm('Reset all statistics for this room? This cannot be undone.')) {
        intents.resetStats();
      }
    }}, 'RESET STATISTICS'));
  }
  children.push(el('div', { class: 'btn-row stats-actions' }, ...actionBtns));

  return shell(...children);
}

function roomSummaryBlock(summary) {
  return el('section', { class: 'stats-summary' },
    el('div', { class: 'section-label' }, 'ROOM SUMMARY'),
    el('div', { class: 'stats-grid' },
      statCard('Games Played', summary.gamesPlayed),
      statCard('Good Wins', summary.goodWins, 'good'),
      statCard('Evil Wins', summary.evilWins, 'evil'),
    ),
  );
}

function statCard(label, value, team) {
  const cls = 'stat-card' + (team ? ` stat-${team}` : '');
  return el('div', { class: cls },
    el('div', { class: 'stat-value' }, String(value)),
    el('div', { class: 'stat-label' }, label),
  );
}

function leaderboardTable(leaderboard) {
  if (leaderboard.length === 0) {
    return el('p', { class: 'fine' }, 'No games recorded yet.');
  }

  const header = el('tr', {},
    el('th', {}, 'Player'),
    el('th', {}, 'GP'),
    el('th', {}, 'W'),
    el('th', {}, 'W%'),
    el('th', { class: 'hide-sm' }, 'Good'),
    el('th', { class: 'hide-sm' }, 'Evil'),
    el('th', { class: 'hide-sm' }, 'GW'),
    el('th', { class: 'hide-sm' }, 'EW'),
  );

  const rows = leaderboard.map((p, i) => el('tr', { class: i === 0 ? 'top-player' : '' },
    el('td', { class: 'lb-name' }, p.name),
    el('td', {}, String(p.gamesPlayed)),
    el('td', {}, String(p.wins)),
    el('td', {}, p.winPct + '%'),
    el('td', { class: 'hide-sm' }, String(p.good)),
    el('td', { class: 'hide-sm' }, String(p.evil)),
    el('td', { class: 'hide-sm' }, String(p.goodWins)),
    el('td', { class: 'hide-sm' }, String(p.evilWins)),
  ));

  return el('section', { class: 'stats-leaderboard' },
    el('div', { class: 'section-label' }, 'PLAYER LEADERBOARD'),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'lb-table' },
        el('thead', {}, header),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

function playerDetails(leaderboard) {
  if (leaderboard.length === 0) return null;

  const sections = leaderboard.map(p => {
    const roleRows = Object.entries(p.roles)
      .filter(([_, r]) => r.played > 0)
      .sort((a, b) => b[1].played - a[1].played)
      .map(([rid, r]) => {
        const roleDef = ROLES[rid];
        const rName = roleDef ? roleDef.name : rid;
        const rTeam = roleDef ? roleDef.team : '?';
        const winRate = r.played > 0 ? Math.round((r.wins / r.played) * 100) : 0;
        return el('tr', {},
          el('td', {},
            el('span', { class: 'role-tag ' + rTeam }, rName),
          ),
          el('td', {}, String(r.played)),
          el('td', {}, String(r.wins)),
          el('td', {}, winRate + '%'),
        );
      });

    if (roleRows.length === 0) return null;

    return el('details', { class: 'player-detail' },
      el('summary', { class: 'player-detail-summary' },
        el('span', { class: 'pd-name' }, p.name),
        el('span', { class: 'pd-meta' },
          `${p.wins}W / ${p.gamesPlayed}GP · `,
          `Good ${p.goodWinPct}% · Evil ${p.evilWinPct}%`,
        ),
      ),
      el('table', { class: 'role-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Role'),
          el('th', {}, 'Played'),
          el('th', {}, 'Wins'),
          el('th', {}, 'Win%'),
        )),
        el('tbody', {}, ...roleRows),
      ),
    );
  }).filter(Boolean);

  return el('section', { class: 'stats-details' },
    el('div', { class: 'section-label' }, 'PLAYER DETAILS'),
    ...sections,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function panel(label, ...children) {
  return el('section', { class: 'panel' },
    el('div', { class: 'section-label' }, label),
    ...children,
  );
}

function phaseAnnouncement(pub) {
  switch (pub.phase) {
    case 'proposal': return `Quest ${pub.currentQuest + 1}: leader is proposing a team.`;
    case 'vote':     return pub.voteResolved
      ? (pub.lastVoteApproved ? 'Team approved.' : 'Team rejected.')
      : 'Vote on the proposed team.';
    case 'quest':    return pub.questResolved
      ? `Quest ${pub.currentQuest + 1} ${pub.lastQuestResult}.`
      : 'Quest underway.';
    case 'lady':     return pub.ladyResolved
      ? 'Lady of the Lake: a loyalty has been revealed to the holder.'
      : 'Lady of the Lake: a player is inspecting loyalty.';
    default:         return '';
  }
}
