// ============================================================================
// util.js — Small helpers shared across modules. No game logic here.
// ============================================================================

// Numeric-only codes for now: a 4-digit room code is the simplest thing to
// read aloud and type on a phone keypad.
const CODE_ALPHABET = '0123456789';
const CODE_LENGTH = 4;

export function generateRoomCode() {
  let code = '';
  const arr = new Uint32Array(CODE_LENGTH);
  (crypto || window.crypto).getRandomValues(arr);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise user-typed codes: keep digits only, capped at the code length. */
export function normalizeCode(raw) {
  return (raw || '')
    .replace(/\D/g, '')
    .slice(0, CODE_LENGTH);
}

// --- Clipboard ------------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// --- Lightweight persistence (display name + last room code) ---------------
const NAME_KEY = 'localavalon.name';
const CODE_KEY = 'localavalon.lastCode';

export function loadName()  { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }
export function loadCode()  { try { return localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
export function saveCode(c) { try { localStorage.setItem(CODE_KEY, c); } catch (_) {} }

// --- Stable per-device client id ------------------------------------------
// A persistent, anonymous identifier for THIS device/browser, generated once
// and reused forever. It is sent with the join message so the host can reclaim
// a seat for a reconnecting player even when their old connection still looks
// "online" (mobile WebRTC is slow to detect a dropped channel). This is what
// makes "rejoin with the same name, device, and code" reliable. It is never
// shown in the UI and never broadcast to other players.
const CLIENT_KEY = 'localavalon.clientId';
export function loadClientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'c-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch (_) {
    // Storage unavailable (private mode): a per-session id still helps within
    // this page's lifetime, though it won't survive a full reload.
    return 'c-' + Math.random().toString(36).slice(2);
  }
}

// --- Session resume (reload / rejoin returns to the same game) -------------
// We remember whether this device was hosting or joining, the room code, and
// the player name, plus (for a host) a snapshot of the authoritative engine so
// a host reload can rehydrate the in-progress game. Stale sessions expire so a
// reload days later doesn't try to rejoin a long-dead game.
const SESSION_KEY = 'localavalon.session';
const ENGINE_KEY  = 'localavalon.engine';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
}
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.ts || (Date.now() - s.ts) > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch (_) { return null; }
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ENGINE_KEY); } catch (_) {}
}

export function saveEngineSnapshot(snap) {
  try { localStorage.setItem(ENGINE_KEY, JSON.stringify({ snap, ts: Date.now() })); } catch (_) {}
}
export function loadEngineSnapshot() {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ts || (Date.now() - o.ts) > SESSION_TTL_MS) return null;
    return o.snap;
  } catch (_) { return null; }
}

// --- DOM helpers -----------------------------------------------------------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
