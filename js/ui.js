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
import { ROLES, ROLE_COUNTS, validateRoleConfig, MIN_PLAYERS, MAX_PLAYERS } from './rules.js';

const OPTIONAL_TOGGLES = ['percival', 'morgana', 'mordred', 'oberon'];

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
    default:           node = homeScreen(app, intents);
  }
  root.appendChild(node);
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
  const codeInput = el('input', {
    class: 'field field-code', type: 'text', maxlength: '4', placeholder: 'CODE',
    value: app.code || '', autocapitalize: 'characters', autocomplete: 'off',
    'aria-label': 'Room code',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase(); },
  });
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '16', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name',
    oninput: (e) => intents.setName(e.target.value),
  });

  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'Join a game'),
    el('p', { class: 'tagline' }, 'Enter the ', el('span', { class: 'accent' }, '4-character code'), ' the host is showing.'),
    el('div', { class: 'field-group' }, codeInput, nameInput),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        onclick: () => intents.join(codeInput.value, nameInput.value),
      }, '> CONNECT'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK'),
    ),
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
    const v = validateRoleConfig(app.pub.config || {}, players.length);
    const canStart = players.length >= MIN_PLAYERS && players.length <= MAX_PLAYERS && v.ok;
    if (!canStart) {
      children.push(el('p', { class: 'fine' },
        players.length < MIN_PLAYERS
          ? `Need at least ${MIN_PLAYERS} players to start.`
          : (v.errors[0] || '')));
    }
    children.push(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary' + (canStart ? '' : ' btn-disabled'),
        disabled: canStart ? false : true,
        onclick: () => canStart && intents.startGame(),
      }, '> START GAME'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE'),
    ));
  } else {
    children.push(el('p', { class: 'tagline' }, 'Waiting for the host to ', el('span', { class: 'accent' }, 'start the game'), '…'));
    children.push(el('div', { class: 'spinner' }));
    children.push(el('div', { class: 'btn-row' },
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
    ...OPTIONAL_TOGGLES.map(id => {
      const role = ROLES[id];
      const on = !!cfg[id];
      return el('label', { class: 'toggle' + (on ? ' on' : '') },
        el('input', {
          type: 'checkbox', ...(on ? { checked: true } : {}),
          onchange: () => intents.toggleRole(id),
        }),
        el('span', { class: 'toggle-box' }),
        el('span', { class: 'toggle-text' },
          el('span', { class: 'toggle-name' }, role.name),
          el('span', { class: 'toggle-blurb' }, role.blurb),
        ),
        el('span', { class: 'pill pill-sm ' + (role.team === 'evil' ? 'pill-evil' : 'pill-good') },
          role.team === 'evil' ? 'EVIL' : 'GOOD'),
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
    el('p', { class: 'fine' }, 'Merlin & Assassin are always in. The rest fill with Loyal Servants and Minions.'),
    toggles,
    counts,
  );
}

// ---------------------------------------------------------------------------
// ROLE REVEAL — hold-to-reveal card
// ---------------------------------------------------------------------------
function roleRevealScreen(app, intents) {
  const priv = app.priv;
  const pub = app.pub;
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
    questTrack(pub),
    voteTrack(pub),
    rosterBoard(pub, app),
    contextPanel(app, intents),
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

  const me = pub.players.find(p => p.id === app.me.id);
  const hasVoted = app.priv && app.priv.hasVoted;
  const team = pub.proposal ? pub.proposal.members : [];
  const teamNames = pub.players.filter(p => team.includes(p.id)).map(p => p.name);
  const progress = pub.voteProgress || [];
  const votedCount = progress.filter(x => x.voted).length;

  const header = panel('VOTE ON THE TEAM',
    el('p', { class: 'tagline' }, 'Proposed: ',
      el('span', { class: 'accent' }, teamNames.join(', ') || '—')),
  );

  if (hasVoted) {
    header.appendChild(el('p', { class: 'fine' }, `Vote locked. ${votedCount}/${progress.length} in…`));
    header.appendChild(el('div', { class: 'spinner' }));
    return header;
  }

  header.appendChild(el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn-primary', onclick: () => intents.vote(true) }, '✓ APPROVE'),
    el('button', { class: 'btn btn-secondary', onclick: () => intents.vote(false) }, '✗ REJECT'),
  ));
  return header;
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

  const buttons = [el('button', { class: 'btn btn-primary', onclick: () => intents.playCard(true) }, '✓ SUCCESS')];
  if (priv.mayFail) {
    buttons.push(el('button', { class: 'btn btn-secondary btn-fail', onclick: () => intents.playCard(false) }, '✗ FAIL'));
  }
  return panel('PLAY YOUR QUEST CARD',
    el('p', { class: 'fine' }, priv.mayFail ? 'You may help or sabotage.' : 'Good must play Success.'),
    el('div', { class: 'btn-row' }, ...buttons),
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
      liveRegion('Assassination phase'),
    );
  }

  return shell(
    wordmark(),
    el('h1', { class: 'hero hero-sm' }, 'A blade in the dark'),
    el('p', { class: 'tagline' }, 'Good won the quests… but the ',
      el('span', { class: 'accent' }, 'Assassin'), ' is hunting Merlin. Hold your breath.'),
    el('div', { class: 'spinner' }),
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
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'NEW GAME'),
    ));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the host to start a new round, or leave to go home.'));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(evilWon ? 'Evil wins' : 'Good wins'));
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
