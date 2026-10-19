// Keyboard input for the game.
//
// CheerpJ's X11 server only forwards printable Latin-1 characters (without modifier state)
// and Escape, so Shift/Ctrl/Alt, F1-F12, arrows, Enter, Backspace and uppercase or non-Latin
// text never reach LWJGL correctly. While the game runs, every key press is captured here
// instead and handed to webmc.KeyBridge (Java), which injects it into LWJGL's keyboard
// queue. Text from input methods (e.g. Chinese/Japanese IME) is delivered the same way.

// KeyboardEvent.code -> LWJGL 2 Keyboard.KEY_* (DirectInput scan codes)
const LWJGL_KEYS = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10,
  Digit0: 11, Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81,
  Numpad0: 82, NumpadDecimal: 83, F12: 88, NumpadEqual: 141, NumpadEnter: 156, ControlRight: 157,
  NumpadDivide: 181, PrintScreen: 183, AltRight: 184, Pause: 197, Home: 199, ArrowUp: 200, PageUp: 201,
  ArrowLeft: 203, ArrowRight: 205, End: 207, ArrowDown: 208, PageDown: 209, Insert: 210, Delete: 211,
  MetaLeft: 219, MetaRight: 220, ContextMenu: 221,
};

// Characters LWJGL reports for non-printing keys.
const KEY_CHARS = { Enter: 13, NumpadEnter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 };

// Keys the browser keeps for itself: F11 is mapped to page fullscreen, F12 opens devtools.
const PASS_THROUGH = new Set(['F11', 'F12']);
// Keys withheld from the game: F2 screenshots read back the frame buffer, which the
// WebGL-based GL driver cannot do (it stops the client).
const WITHHELD = new Set(['F2']);

const queue = [];
const pressed = new Set();
let waiter = null;
let active = false;
let imeInput = null;
let onWithheld = null;

function push(key, down, character = 0, repeat = false) {
  const event = (key & 0xff) | (down ? 0x100 : 0) | (repeat ? 0x200 : 0) | ((character & 0xffff) << 16);
  if (waiter) {
    const resolve = waiter;
    waiter = null;
    resolve(event);
  } else {
    queue.push(event);
    if (queue.length > 1024) queue.shift();
  }
}

function characterFor(event) {
  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    // Ctrl+letter gives the control character, which Minecraft's text fields use for
    // select-all/copy/paste/cut.
    if (event.ctrlKey && !event.altKey && /[a-z]/i.test(event.key)) return code & 0x1f;
    return code;
  }
  return KEY_CHARS[event.key] || KEY_CHARS[event.code] || 0;
}

function onKeyDown(event) {
  if (!active || PASS_THROUGH.has(event.code)) return;
  // Input method composing: let the browser handle it, the text arrives on compositionend.
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (WITHHELD.has(event.code)) {
    if (!event.repeat) onWithheld?.(event.code);
    return;
  }
  const key = LWJGL_KEYS[event.code] || 0;
  const character = characterFor(event);
  if (!key && !character) return;
  if (key) pressed.add(key);
  push(key, true, character, event.repeat);
}

function onKeyUp(event) {
  if (!active || PASS_THROUGH.has(event.code)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const key = LWJGL_KEYS[event.code];
  if (key && pressed.delete(key)) push(key, false);
}

function onCompositionEnd(event) {
  if (!active) return;
  event.stopImmediatePropagation();
  for (const ch of event.data || '') {
    const code = ch.codePointAt(0);
    if (code > 0xffff) continue; // LWJGL 2 characters are single UTF-16 units.
    push(0, true, code);
    push(0, false);
  }
  if (imeInput) imeInput.value = '';
}

function releaseAll() {
  for (const key of pressed) push(key, false);
  pressed.clear();
}

/**
 * Starts listening (capture phase, before CheerpJ's own handlers). A hidden text field
 * keeps keyboard focus while playing so that input methods can compose text.
 */
export function installKeyBridge(stage) {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('compositionend', onCompositionEnd, true);
  window.addEventListener('blur', releaseAll);

  imeInput = document.createElement('textarea');
  imeInput.className = 'ime-input';
  imeInput.setAttribute('aria-hidden', 'true');
  imeInput.setAttribute('autocomplete', 'off');
  imeInput.setAttribute('autocapitalize', 'off');
  imeInput.spellcheck = false;
  document.body.appendChild(imeInput);
  stage.addEventListener('pointerdown', () => {
    if (active) setTimeout(() => imeInput.focus({ preventScroll: true }), 0);
  }, true);
}

/** Called with the KeyboardEvent.code of keys that are not passed to the game. */
export function onWithheldKey(callback) {
  onWithheld = callback;
}

export function setKeyBridgeActive(value) {
  active = value;
  if (!value) releaseAll();
  else imeInput?.focus({ preventScroll: true });
}

/** CheerpJ native implementations, passed to cheerpjInit({ natives }). */
export const keyBridgeNatives = {
  Java_webmc_KeyBridge_nextEvent() {
    return new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else waiter = resolve;
    });
  },
};
