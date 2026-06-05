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
    case 'connecting': node = infoScreen('Connecting…', `Reaching room ${app.code}.`, true); break;
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

  return shell(
    wordmark(),
    el('h1', { class: 'hero' }, 'Avalon'),
    el('p', { class: 'tagline' },
      'A game of ', el('span', { class: 'accent' }, 'loyalty and betrayal'),
      '. Gather 5–10 players on the same Wi-Fi, each on their own phone, and find the spy among you.'),
    el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.host() }, '> HOST GAME'),
      el('button', { class: 'btn btn-secondary', onclick: () => intents.gotoJoin() }, '▷ JOIN GAME'),
    ),
    el('p', { class: 'fine' }, 'Plays peer-to-peer in your browser. No accounts, no servers.'),
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
    class: 'field field-code', type: 'text', maxlength: '4', placeholder: 'CODE',
    value: app.code || '', autocapitalize: 'characters', autocomplete: 'off',
    'aria-label': 'Room code',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase(); },
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
  ];
  return shell(...children);
}

// The auto-discovered list of open games (or an explanatory fallback).
function discoveryList(app, intents, nameInput) {
  const state = app.discoveryState || 'idle';
  const games = app.discovered || [];

  if (state === 'unsupported') {
    return el('p', { class: 'fine' },
      'Automatic discovery isn’t available on the public signaling server — ',
      'enter the 4-character code the host is showing instead. ',
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
  const isHost = app.me.isHost;
  const players = pub.players;

  const roster = el('ul', { class: 'roster' },
    ...players.map(p => el('li', { class: 'roster-item' },
      el('span', { class: 'dot ' + (p.online ? 'on' : 'off') }),
      el('span', { class: 'roster-name' }, p.name),
      p.isHost ? el('span', { class: 'pill pill-sm' }, 'HOST') : null,
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
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(`${players.length} players in lobby`));
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

  if (app.me.isHost) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: intents.playAgain }, '> PLAY AGAIN'),
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'NEW GAME'),
    ));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the host to start a new round, or leave to go home.'));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.viewStats }, 'STATS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
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
    return el('main', { class: 'tv-shell tv-over' }, head, tvGameOver(pub),
      liveRegion(pub.winner === 'evil' ? 'Evil wins' : 'Good wins'));
  }

  const body = (pub.phase === 'lobby')
    ? el('section', { class: 'tv-body tv-body-lobby' }, tvRoster(pub), tvStatus(app))
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
        proposed.has(p.id) ? el('span', { class: 'tv-tag' }, 'ON QUEST') : null,
        p.online ? null : el('span', { class: 'tv-tag tv-tag-off' }, 'AWAY'),
      ),
    )),
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

// Game-over stage for the TV: winner banner + full role reveal (public now).
function tvGameOver(pub) {
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
    default:         return '';
  }
}
