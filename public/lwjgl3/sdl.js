// SDL 3 (Minecraft 26.x opens its window with SDL instead of GLFW) on a <canvas> and DOM events.
//
// SDL is polled: SDL_PollEvent copies the next queued event into the caller's SDL_Event, so input
// needs no calls back into Java (GLFW delivers it through callbacks). Windows are handles to the
// one canvas, and the GL context created on any of them is the canvas's WebGL 2 context (gl.js),
// drawing into the emulated default framebuffer that SDL_GL_SwapWindow presents. Struct layouts
// follow LWJGL's SDL bindings with 4-byte pointers.
import { ptr, sync, U8, U16, U32, I32, F32, malloc, free, readCString, encodeUtf8, cstring } from './heap.js';
import { outI32, outF32, outPointer } from './core.js';
import { defineLibrary } from './registry.js';

const EV = {
  QUIT: 0x100,
  WINDOW_SHOWN: 0x202, WINDOW_HIDDEN: 0x203, WINDOW_EXPOSED: 0x204, WINDOW_MOVED: 0x205, WINDOW_RESIZED: 0x206,
  WINDOW_PIXEL_SIZE_CHANGED: 0x207, WINDOW_MINIMIZED: 0x209, WINDOW_MAXIMIZED: 0x20a, WINDOW_RESTORED: 0x20b,
  WINDOW_MOUSE_ENTER: 0x20c, WINDOW_MOUSE_LEAVE: 0x20d, WINDOW_FOCUS_GAINED: 0x20e, WINDOW_FOCUS_LOST: 0x20f,
  WINDOW_CLOSE_REQUESTED: 0x210, WINDOW_ENTER_FULLSCREEN: 0x217, WINDOW_LEAVE_FULLSCREEN: 0x218,
  KEY_DOWN: 0x300, KEY_UP: 0x301, TEXT_EDITING: 0x302, TEXT_INPUT: 0x303,
  MOUSE_MOTION: 0x400, MOUSE_BUTTON_DOWN: 0x401, MOUSE_BUTTON_UP: 0x402, MOUSE_WHEEL: 0x403,
};
const FLAG = {
  FULLSCREEN: 0x1, OPENGL: 0x2, HIDDEN: 0x8, RESIZABLE: 0x20, INPUT_FOCUS: 0x200, MOUSE_FOCUS: 0x400,
  HIGH_PIXEL_DENSITY: 0x2000, MOUSE_RELATIVE_MODE: 0x8000,
};
const KMOD = { LSHIFT: 0x1, RSHIFT: 0x2, LCTRL: 0x40, RCTRL: 0x80, LALT: 0x100, RALT: 0x200, LGUI: 0x400, RGUI: 0x800, NUM: 0x1000, CAPS: 0x2000 };
const MOD_OF_CODE = {
  ShiftLeft: KMOD.LSHIFT, ShiftRight: KMOD.RSHIFT, ControlLeft: KMOD.LCTRL, ControlRight: KMOD.RCTRL,
  AltLeft: KMOD.LALT, AltRight: KMOD.RALT, MetaLeft: KMOD.LGUI, MetaRight: KMOD.RGUI,
};
const SCANCODE_MASK = 0x40000000;
const WINDOW_BASE = 0x5100;
const CURSOR_BASE = 0x7100;
const CONTEXT = 0x5f00;
const DISPLAY = 1;
const PIXELFORMAT_XRGB8888 = 0x16161804;
// SDL_GLAttr
const GL_ATTR = { RED: 0, GREEN: 1, BLUE: 2, ALPHA: 3, DOUBLEBUFFER: 5, DEPTH: 6, STENCIL: 7, MAJOR: 17, MINOR: 18, FLAGS: 19, PROFILE: 20 };

// KeyboardEvent.code -> SDL_Scancode (USB HID usage ids)
const SCANCODES = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99, IntlBackslash: 100,
  ContextMenu: 101, NumpadEqual: 103, NumpadComma: 133, IntlRo: 135, KanaMode: 136, IntlYen: 137, Convert: 138,
  NonConvert: 139, Lang1: 144, Lang2: 145,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
for (let i = 0; i < 26; i++) SCANCODES[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 1; i <= 9; i++) SCANCODES[`Digit${i}`] = 29 + i;
SCANCODES.Digit0 = 39;
for (let i = 1; i <= 12; i++) SCANCODES[`F${i}`] = 57 + i;
for (let i = 13; i <= 24; i++) SCANCODES[`F${i}`] = 91 + i;
for (let i = 1; i <= 9; i++) SCANCODES[`Numpad${i}`] = 88 + i;

// US layout keycodes for the scancodes that produce characters; the rest are scancode | mask.
const CHARACTER_KEYS = {
  40: 0x0d, 41: 0x1b, 42: 0x08, 43: 0x09, 44: 0x20, 45: 0x2d, 46: 0x3d, 47: 0x5b, 48: 0x5d, 49: 0x5c, 51: 0x3b,
  52: 0x27, 53: 0x60, 54: 0x2c, 55: 0x2e, 56: 0x2f, 76: 0x7f,
};
for (let i = 0; i < 26; i++) CHARACTER_KEYS[4 + i] = 0x61 + i;
for (let i = 1; i <= 9; i++) CHARACTER_KEYS[29 + i] = 0x30 + i;
CHARACTER_KEYS[39] = 0x30;
const keyForScancode = (scancode) => CHARACTER_KEYS[scancode] ?? (scancode ? (scancode | SCANCODE_MASK) : 0);

const KEY_NAMES = {
  0x0d: 'Return', 0x1b: 'Escape', 0x08: 'Backspace', 0x09: 'Tab', 0x20: 'Space', 0x7f: 'Delete',
  57: 'CapsLock', 70: 'PrintScreen', 71: 'ScrollLock', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'PageUp', 77: 'End',
  78: 'PageDown', 79: 'Right', 80: 'Left', 81: 'Down', 82: 'Up', 83: 'Numlock', 84: 'Keypad /', 85: 'Keypad *',
  86: 'Keypad -', 87: 'Keypad +', 88: 'Keypad Enter', 98: 'Keypad 0', 99: 'Keypad .', 101: 'Menu', 103: 'Keypad =',
  224: 'Left Ctrl', 225: 'Left Shift', 226: 'Left Alt', 227: 'Left GUI', 228: 'Right Ctrl', 229: 'Right Shift',
  230: 'Right Alt', 231: 'Right GUI',
};
for (let i = 1; i <= 9; i++) KEY_NAMES[88 + i] = `Keypad ${i}`;
for (let i = 1; i <= 12; i++) KEY_NAMES[57 + i] = `F${i}`;
for (let i = 13; i <= 24; i++) KEY_NAMES[91 + i] = `F${i}`;
function keyName(key) {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  if (key & SCANCODE_MASK) return KEY_NAMES[key & ~SCANCODE_MASK] ?? '';
  return key > 0x20 ? String.fromCodePoint(key).toUpperCase() : '';
}

// SDL_SystemCursor -> CSS
const CURSORS = ['default', 'text', 'wait', 'crosshair', 'progress', 'nwse-resize', 'nesw-resize', 'ew-resize', 'ns-resize', 'move', 'not-allowed', 'pointer'];

export function createSDL({ gl, canvas, getRenderSize, onFullscreen, onTitle }) {
  const windows = new Map(); // id -> { flags, title }
  let nextWindowId = 1;
  let mainWindow = 0; // id of the visible game window
  let contextCreated = false;
  const queue = [];
  const glAttributes = new Map([[GL_ATTR.RED, 8], [GL_ATTR.GREEN, 8], [GL_ATTR.BLUE, 8], [GL_ATTR.ALPHA, 8], [GL_ATTR.DOUBLEBUFFER, 1],
    [GL_ATTR.DEPTH, 24], [GL_ATTR.STENCIL, 8], [GL_ATTR.MAJOR, 3], [GL_ATTR.MINOR, 3], [GL_ATTR.PROFILE, 1], [GL_ATTR.FLAGS, 0]]);
  let keyboardState = 0;
  let modState = 0;
  let buttonMask = 0;
  let cursorX = 0;
  let cursorY = 0;
  let relativeMode = false;
  let lockRequested = false;
  let lastEscape = 0;
  let textInput = false;
  let composing = false;
  let fullscreen = false;
  let focused = document.hasFocus();
  let clipboard = '';
  let imeInput = null;
  let inputInstalled = false;
  let lastError = 0;
  const eventStrings = [];
  const t0 = performance.now();
  const nowNs = () => Math.round((performance.now() - t0) * 1e6);
  // Frame timing (see glfw.js): `resume` is the time from the display frame until the render
  // thread runs again, `work` the time from then until the next swap.
  const stats = { frames: 0, resume: 0, work: 0, vsync: 0, swapAt: 0, vsyncAt: 0, resumedAt: 0 };
  const noteResumed = () => {
    if (!stats.vsyncAt) return;
    const now = performance.now();
    stats.resume += now - stats.vsyncAt;
    stats.vsyncAt = 0;
    stats.resumedAt = now;
  };

  const handleOf = (id) => (id ? WINDOW_BASE + id : 0);
  const idOf = (handle) => {
    const id = ptr(handle) - WINDOW_BASE;
    return windows.has(id) ? id : 0;
  };
  const push = (event) => queue.push({ windowID: mainWindow, ...event, timestamp: nowNs() });

  // -------------------------------------------------------------------------
  // DOM input -> queued SDL events
  // -------------------------------------------------------------------------
  const passThrough = (e) => e.code === 'F12' || e.code === 'F11';
  const toPixels = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height)];
  };
  function setKeyState(scancode, down) {
    if (!keyboardState || !scancode || scancode >= 512) return;
    sync();
    U8[keyboardState + scancode] = down ? 1 : 0;
  }
  function updateLocks(e) {
    modState &= ~(KMOD.CAPS | KMOD.NUM);
    if (e.getModifierState?.('CapsLock')) modState |= KMOD.CAPS;
    if (e.getModifierState?.('NumLock')) modState |= KMOD.NUM;
  }
  function onKeyDown(e) {
    if (!mainWindow || passThrough(e)) return;
    if (e.isComposing || e.keyCode === 229) return; // the input method has it
    const scancode = SCANCODES[e.code] ?? 0;
    const isPaste = (e.ctrlKey || e.metaKey) && e.code === 'KeyV';
    if (!isPaste) e.preventDefault();
    if (e.code === 'Escape') lastEscape = performance.now();
    modState |= MOD_OF_CODE[e.code] || 0;
    updateLocks(e);
    setKeyState(scancode, true);
    push({ type: EV.KEY_DOWN, scancode, key: keyForScancode(scancode), mod: modState, repeat: e.repeat ? 1 : 0, down: 1 });
    if (textInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey) push({ type: EV.TEXT_INPUT, text: e.key });
  }
  function onKeyUp(e) {
    if (!mainWindow || passThrough(e)) return;
    const scancode = SCANCODES[e.code] ?? 0;
    e.preventDefault();
    modState &= ~(MOD_OF_CODE[e.code] || 0);
    updateLocks(e);
    setKeyState(scancode, false);
    push({ type: EV.KEY_UP, scancode, key: keyForScancode(scancode), mod: modState, repeat: 0, down: 0 });
  }
  function onCompositionUpdate(e) {
    if (!mainWindow || !textInput) return;
    composing = true;
    const text = e.data || '';
    push({ type: EV.TEXT_EDITING, text, start: text.length, length: 0 });
  }
  function onCompositionEnd(e) {
    if (!mainWindow) return;
    composing = false;
    if (textInput) {
      push({ type: EV.TEXT_EDITING, text: '', start: 0, length: 0 });
      if (e.data) push({ type: EV.TEXT_INPUT, text: e.data });
    }
    if (imeInput) imeInput.value = '';
  }
  function onPaste(e) {
    clipboard = e.clipboardData?.getData('text') ?? clipboard;
  }
  function onMouseMove(e) {
    if (!mainWindow) return;
    let xrel;
    let yrel;
    if (document.pointerLockElement === canvas) {
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      xrel = e.movementX * scale;
      yrel = e.movementY * scale;
      cursorX = Math.min(Math.max(cursorX + xrel, 0), canvas.width);
      cursorY = Math.min(Math.max(cursorY + yrel, 0), canvas.height);
    } else {
      const [x, y] = toPixels(e);
      xrel = x - cursorX;
      yrel = y - cursorY;
      cursorX = x;
      cursorY = y;
    }
    // Consecutive motion events merge (the game sums the relative motion).
    const last = queue[queue.length - 1];
    if (last && last.type === EV.MOUSE_MOTION) {
      last.x = cursorX;
      last.y = cursorY;
      last.xrel += xrel;
      last.yrel += yrel;
      last.state = buttonMask;
      return;
    }
    push({ type: EV.MOUSE_MOTION, state: buttonMask, x: cursorX, y: cursorY, xrel, yrel });
  }
  const buttonOf = (b) => (b === 0 ? 1 : b === 1 ? 2 : b === 2 ? 3 : b + 1);
  function onMouseDown(e) {
    if (!mainWindow) return;
    e.preventDefault();
    imeInput?.focus({ preventScroll: true });
    if (relativeMode && document.pointerLockElement !== canvas) requestLock();
    const button = buttonOf(e.button);
    buttonMask |= 1 << (button - 1);
    if (document.pointerLockElement !== canvas) [cursorX, cursorY] = toPixels(e);
    push({ type: EV.MOUSE_BUTTON_DOWN, button, down: 1, clicks: Math.max(1, e.detail || 1), x: cursorX, y: cursorY });
  }
  function onMouseUp(e) {
    if (!mainWindow) return;
    const button = buttonOf(e.button);
    if (!(buttonMask & (1 << (button - 1)))) return;
    buttonMask &= ~(1 << (button - 1));
    push({ type: EV.MOUSE_BUTTON_UP, button, down: 0, clicks: 1, x: cursorX, y: cursorY });
  }
  function onWheel(e) {
    if (!mainWindow) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
    push({ type: EV.MOUSE_WHEEL, x: -e.deltaX * unit, y: -e.deltaY * unit, mouseX: cursorX, mouseY: cursorY });
  }
  function onFocus(value) {
    focused = value;
    if (!value) {
      // Keys held while the page loses focus would otherwise stay down.
      sync();
      for (let s = 1; keyboardState && s < 512; s++) {
        if (U8[keyboardState + s]) push({ type: EV.KEY_UP, scancode: s, key: keyForScancode(s), mod: 0, repeat: 0, down: 0 });
      }
      if (keyboardState) U8.fill(0, keyboardState, keyboardState + 512);
      modState &= KMOD.CAPS | KMOD.NUM;
    }
    push({ type: value ? EV.WINDOW_FOCUS_GAINED : EV.WINDOW_FOCUS_LOST, data1: 0, data2: 0 });
  }
  function requestLock() {
    try {
      const result = canvas.requestPointerLock?.({ unadjustedMovement: true });
      if (result && result.catch) result.catch(() => canvas.requestPointerLock?.()?.catch?.(() => {}));
    } catch {
      // Needs a user gesture; retried on the next click.
    }
  }
  function onPointerLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (!locked && relativeMode && lockRequested && performance.now() - lastEscape > 150) {
      // The browser released the pointer (Esc). Tell the game, which opens its menu.
      push({ type: EV.KEY_DOWN, scancode: 41, key: 0x1b, mod: modState, repeat: 0, down: 1 });
      push({ type: EV.KEY_UP, scancode: 41, key: 0x1b, mod: modState, repeat: 0, down: 0 });
    }
  }

  function installInput() {
    if (inputInstalled) return;
    inputInstalled = true;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('compositionupdate', onCompositionUpdate, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('mousemove', onMouseMove, true);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp, true);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mouseenter', () => push({ type: EV.WINDOW_MOUSE_ENTER, data1: 0, data2: 0 }));
    canvas.addEventListener('mouseleave', () => push({ type: EV.WINDOW_MOUSE_LEAVE, data1: 0, data2: 0 }));
    window.addEventListener('focus', () => onFocus(true));
    window.addEventListener('blur', () => onFocus(false));
    document.addEventListener('pointerlockchange', onPointerLockChange);
    imeInput = document.querySelector('.ime-input');
    if (!imeInput) {
      imeInput = document.createElement('textarea');
      imeInput.className = 'ime-input';
      imeInput.setAttribute('aria-hidden', 'true');
      imeInput.spellcheck = false;
      document.body.appendChild(imeInput);
    }
    imeInput.focus({ preventScroll: true });
  }

  /** Called by the page when the render size changes. */
  function resize(width, height) {
    canvas.width = width;
    canvas.height = height;
    if (contextCreated) gl.resizeBackbuffer(width, height);
    if (!mainWindow) return;
    push({ type: EV.WINDOW_RESIZED, data1: width, data2: height });
    push({ type: EV.WINDOW_PIXEL_SIZE_CHANGED, data1: width, data2: height });
  }

  // -------------------------------------------------------------------------
  // SDL_Event (a 128-byte union) in the heap
  // -------------------------------------------------------------------------
  function heapString(text) {
    const bytes = encodeUtf8(text);
    const address = malloc(bytes.length + 1);
    sync();
    U8.set(bytes, address);
    U8[address + bytes.length] = 0;
    eventStrings.push(address);
    return address;
  }
  function writeEvent(address, e) {
    sync();
    U8.fill(0, address, address + 128);
    const w = address >> 2;
    U32[w] = e.type;
    U32[w + 2] = e.timestamp % 0x100000000;
    U32[w + 3] = Math.floor(e.timestamp / 0x100000000);
    U32[w + 4] = e.windowID; // windowID (displayID for display events)
    switch (e.type) {
      case EV.KEY_DOWN:
      case EV.KEY_UP:
        U32[w + 6] = e.scancode;
        U32[w + 7] = e.key;
        U16[(address + 32) >> 1] = e.mod;
        U8[address + 36] = e.down;
        U8[address + 37] = e.repeat;
        break;
      case EV.TEXT_INPUT:
        U32[w + 5] = heapString(e.text);
        break;
      case EV.TEXT_EDITING:
        U32[w + 5] = heapString(e.text);
        I32[w + 6] = e.start;
        I32[w + 7] = e.length;
        break;
      case EV.MOUSE_MOTION:
        U32[w + 6] = e.state;
        F32[w + 7] = e.x;
        F32[w + 8] = e.y;
        F32[w + 9] = e.xrel;
        F32[w + 10] = e.yrel;
        break;
      case EV.MOUSE_BUTTON_DOWN:
      case EV.MOUSE_BUTTON_UP:
        U8[address + 24] = e.button;
        U8[address + 25] = e.down;
        U8[address + 26] = e.clicks;
        F32[w + 7] = e.x;
        F32[w + 8] = e.y;
        break;
      case EV.MOUSE_WHEEL:
        F32[w + 6] = e.x;
        F32[w + 7] = e.y;
        U32[w + 8] = 0; // SDL_MOUSEWHEEL_NORMAL
        F32[w + 9] = e.mouseX;
        F32[w + 10] = e.mouseY;
        I32[w + 11] = Math.trunc(e.x);
        I32[w + 12] = Math.trunc(e.y);
        break;
      default: // window and display events
        I32[w + 5] = e.data1 ?? 0;
        I32[w + 6] = e.data2 ?? 0;
    }
  }
  const windowEvent = (type) => (type >= 0x202 && type <= 0x21a) || (type >= 0x300 && type <= 0x303) || (type >= 0x400 && type <= 0x403);

  // -------------------------------------------------------------------------
  // Frame pacing: see glfw.js (the same scheduling contract with webmc.jdk.Sched)
  // -------------------------------------------------------------------------
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  let waitingForBrowser = 0;
  const renderWaiters = [];
  const waitForBrowser = (promise) => {
    waitingForBrowser++;
    for (const resolve of renderWaiters.splice(0)) resolve();
    return promise.finally(() => { waitingForBrowser--; });
  };
  const untilRenderWaits = (timeoutMs) => new Promise((resolve) => {
    if (waitingForBrowser > 0) { resolve(); return; }
    renderWaiters.push(resolve);
    setTimeout(() => {
      const i = renderWaiters.indexOf(resolve);
      if (i >= 0) {
        renderWaiters.splice(i, 1);
        resolve();
      }
    }, timeoutMs);
  });

  // -------------------------------------------------------------------------
  // Display data
  // -------------------------------------------------------------------------
  let displayMode = 0;
  let pixelFormat = 0;
  const screenSize = () => [Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)];
  function writeDisplayMode(address) {
    const [w, h] = screenSize();
    sync();
    const p = ptr(address) >> 2;
    U32[p] = DISPLAY;
    U32[p + 1] = PIXELFORMAT_XRGB8888;
    I32[p + 2] = w;
    I32[p + 3] = h;
    F32[p + 4] = 1;
    F32[p + 5] = 60;
    I32[p + 6] = 60;
    I32[p + 7] = 1;
    U32[p + 8] = 0;
  }
  const currentDisplayMode = () => {
    if (!displayMode) displayMode = malloc(36);
    writeDisplayMode(displayMode);
    return displayMode;
  };
  function pixelFormatDetails() {
    if (!pixelFormat) {
      pixelFormat = malloc(32);
      sync();
      U8.fill(0, pixelFormat, pixelFormat + 32);
      const p = pixelFormat >> 2;
      U32[p] = PIXELFORMAT_XRGB8888;
      U8[pixelFormat + 4] = 32; // bits per pixel
      U8[pixelFormat + 5] = 4;
      U32[p + 2] = 0x00ff0000;
      U32[p + 3] = 0x0000ff00;
      U32[p + 4] = 0x000000ff;
      U8.set([8, 8, 8, 0, 16, 8, 0, 0], pixelFormat + 24); // R/G/B/A bits, then shifts
    }
    return pixelFormat;
  }
  const fail = (message) => {
    lastError = cstring(message);
    return 0;
  };
  const windowFlags = (id) => {
    const w = windows.get(id);
    if (!w) return 0;
    let flags = w.flags & ~FLAG.HIDDEN;
    if (w.flags & FLAG.HIDDEN) flags |= FLAG.HIDDEN;
    if (id === mainWindow) {
      if (fullscreen) flags |= FLAG.FULLSCREEN;
      if (focused) flags |= FLAG.INPUT_FOCUS | FLAG.MOUSE_FOCUS;
      if (relativeMode) flags |= FLAG.MOUSE_RELATIVE_MODE;
    }
    return flags;
  };
  function setFullscreen(on) {
    if (fullscreen === on) return;
    fullscreen = on;
    onFullscreen?.(on);
    push({ type: on ? EV.WINDOW_ENTER_FULLSCREEN : EV.WINDOW_LEAVE_FULLSCREEN, data1: 0, data2: 0 });
  }

  // -------------------------------------------------------------------------
  // The SDL API
  // -------------------------------------------------------------------------
  const ok = () => 1;
  const api = {
    SDL_Init: ok,
    SDL_InitSubSystem: ok,
    SDL_Quit: () => undefined,
    SDL_QuitSubSystem: () => undefined,
    SDL_WasInit: (flags) => flags,
    SDL_SetHint: ok,
    SDL_SetHintWithPriority: ok,
    SDL_GetHint: () => 0,
    SDL_SetAppMetadata: ok,
    SDL_SetAppMetadataProperty: ok,
    SDL_GetError: () => lastError || cstring(''),
    SDL_ClearError: () => { lastError = 0; return 1; },
    SDL_SetLogOutputFunction: () => undefined,
    SDL_SetLogPriorities: () => undefined,
    SDL_SetLogPriority: () => undefined,
    SDL_GetPlatform: () => cstring('Linux'),
    SDL_GetVersion: () => 3002024, // 3.2.24
    SDL_GetRevision: () => cstring('WebGL2 (browser)'),
    SDL_free: (p) => free(p),
    SDL_malloc: (size) => malloc(Number(size)),
    SDL_OpenURL: (url) => {
      const href = readCString(url);
      if (href && /^https?:/.test(href)) window.open(href, '_blank', 'noopener');
      return 1;
    },
    SDL_GetTicks: () => Math.round(performance.now() - t0),
    SDL_GetTicksNS: () => nowNs(),
    SDL_GetPerformanceCounter: () => nowNs(),
    SDL_GetPerformanceFrequency: () => 1e9,
    SDL_Delay: () => undefined,

    // Video and windows
    SDL_GetNumVideoDrivers: () => 1,
    SDL_GetVideoDriver: () => cstring('browser'),
    SDL_GetCurrentVideoDriver: () => cstring('browser'),
    SDL_GetSystemTheme: () => 0,
    SDL_GetPrimaryDisplay: () => DISPLAY,
    SDL_GetDisplays: (count) => {
      outI32(count, 1);
      const list = malloc(8);
      sync();
      U32[list >> 2] = DISPLAY;
      U32[(list >> 2) + 1] = 0;
      return list;
    },
    SDL_GetDisplayName: () => cstring('Browser'),
    SDL_GetDisplayBounds: (id, rect) => {
      const [w, h] = screenSize();
      sync();
      const p = ptr(rect) >> 2;
      I32[p] = 0;
      I32[p + 1] = 0;
      I32[p + 2] = w;
      I32[p + 3] = h;
      return 1;
    },
    SDL_GetDisplayUsableBounds: (id, rect) => api.SDL_GetDisplayBounds(id, rect),
    SDL_GetDisplayContentScale: () => 1,
    SDL_GetDesktopDisplayMode: () => currentDisplayMode(),
    SDL_GetCurrentDisplayMode: () => currentDisplayMode(),
    SDL_GetFullscreenDisplayModes: (id, count) => {
      outI32(count, 1);
      const list = malloc(8 + 36);
      writeDisplayMode(list + 8);
      sync();
      U32[list >> 2] = list + 8;
      U32[(list >> 2) + 1] = 0;
      return list;
    },
    SDL_GetClosestFullscreenDisplayMode: (id, w, h, refresh, highDensity, closest) => {
      writeDisplayMode(closest);
      return 1;
    },
    SDL_GetDisplayForWindow: () => DISPLAY,
    SDL_GetDisplayForPoint: () => DISPLAY,
    SDL_GetWindowFullscreenMode: () => 0, // borderless "desktop" fullscreen
    SDL_SetWindowFullscreenMode: ok,
    SDL_GetPixelFormatDetails: () => pixelFormatDetails(),
    SDL_GetPixelFormatName: () => cstring('SDL_PIXELFORMAT_XRGB8888'),

    SDL_CreateWindow: (title, w, h, flags) => {
      const id = nextWindowId++;
      const f = Number(BigInt.asUintN(64, BigInt(flags)) & 0xffffffffn);
      windows.set(id, { flags: f, title: readCString(title) || 'Minecraft' });
      if (!(f & FLAG.HIDDEN)) {
        // The game window: the canvas, sized by the page.
        mainWindow = id;
        const size = getRenderSize();
        if (canvas.width !== size.width || canvas.height !== size.height) {
          canvas.width = size.width;
          canvas.height = size.height;
          if (contextCreated) gl.resizeBackbuffer(size.width, size.height);
        }
        onTitle?.(windows.get(id).title);
        installInput();
      }
      return handleOf(id);
    },
    SDL_DestroyWindow: (handle) => {
      const id = idOf(handle);
      windows.delete(id);
      if (id === mainWindow) mainWindow = 0;
    },
    SDL_GetWindowID: (handle) => idOf(handle),
    SDL_GetWindowFromID: (id) => handleOf(windows.has(id) ? id : 0),
    SDL_GetWindowFlags: (handle) => windowFlags(idOf(handle)),
    SDL_SetWindowTitle: (handle, title) => {
      const id = idOf(handle);
      if (windows.has(id)) windows.get(id).title = readCString(title) || '';
      if (id === mainWindow) onTitle?.(readCString(title));
      return 1;
    },
    SDL_GetWindowTitle: (handle) => cstring(windows.get(idOf(handle))?.title || ''),
    SDL_SetWindowIcon: ok,
    SDL_SetWindowPosition: ok,
    SDL_GetWindowPosition: (handle, x, y) => { outI32(x, 0); outI32(y, 0); return 1; },
    SDL_SetWindowSize: ok,
    SDL_GetWindowSize: (handle, w, h) => { outI32(w, canvas.width); outI32(h, canvas.height); return 1; },
    SDL_GetWindowSizeInPixels: (handle, w, h) => { outI32(w, canvas.width); outI32(h, canvas.height); return 1; },
    SDL_GetWindowPixelDensity: () => 1,
    SDL_GetWindowDisplayScale: () => 1,
    SDL_SetWindowMinimumSize: ok,
    SDL_SetWindowMaximumSize: ok,
    SDL_SetWindowBordered: ok,
    SDL_SetWindowResizable: ok,
    SDL_SetWindowMouseGrab: ok,
    SDL_SetWindowKeyboardGrab: ok,
    SDL_ShowWindow: ok,
    SDL_HideWindow: ok,
    SDL_RaiseWindow: () => { canvas.focus?.(); return 1; },
    SDL_MaximizeWindow: ok,
    SDL_MinimizeWindow: ok,
    SDL_RestoreWindow: ok,
    SDL_SyncWindow: ok,
    SDL_FlashWindow: ok,
    SDL_SetWindowFullscreen: (handle, on) => {
      if (idOf(handle) === mainWindow) setFullscreen(!!on);
      return 1;
    },

    // OpenGL
    SDL_GL_LoadLibrary: ok,
    SDL_GL_UnloadLibrary: () => undefined,
    SDL_GL_GetProcAddress: (name) => gl.getProcAddress(readCString(name)),
    SDL_GL_ExtensionSupported: (ext) => (gl.S.extensions.includes(readCString(ext)) ? 1 : 0),
    SDL_GL_ResetAttributes: () => undefined,
    SDL_GL_SetAttribute: (attr, value) => { glAttributes.set(attr, value); return 1; },
    SDL_GL_GetAttribute: (attr, value) => {
      const fixed = { [GL_ATTR.MAJOR]: 3, [GL_ATTR.MINOR]: 3 };
      outI32(value, fixed[attr] ?? glAttributes.get(attr) ?? 0);
      return 1;
    },
    SDL_GL_CreateContext: (handle) => {
      if (!idOf(handle)) return fail('invalid window');
      if (!contextCreated) {
        const size = getRenderSize();
        canvas.width = size.width;
        canvas.height = size.height;
        gl.attach(canvas, { profile: 'core' });
        gl.setProfile('core', [3, 3]);
        contextCreated = true;
      }
      return CONTEXT;
    },
    SDL_GL_MakeCurrent: ok,
    SDL_GL_GetCurrentWindow: () => handleOf(mainWindow),
    SDL_GL_GetCurrentContext: () => (contextCreated ? CONTEXT : 0),
    SDL_GL_DestroyContext: ok,
    SDL_GL_SetSwapInterval: ok,
    SDL_GL_GetSwapInterval: (interval) => { outI32(interval, 1); return 1; },
    SDL_GL_SwapWindow: (handle) => {
      if (idOf(handle) !== mainWindow) return 1;
      gl.present();
      const now = performance.now();
      stats.frames++;
      if (stats.resumedAt) stats.work += now - stats.resumedAt;
      stats.resumedAt = 0;
      // The other game threads mostly run while the render thread waits here (webmc.jdk.Sched).
      return waitForBrowser(nextFrame()).then(() => {
        stats.vsyncAt = performance.now();
        stats.vsync += stats.vsyncAt - now;
        return 1;
      });
    },
    SDL_Vulkan_LoadLibrary: () => fail('Vulkan is not available in the browser'),
    SDL_Vulkan_UnloadLibrary: () => undefined,
    SDL_Vulkan_GetVkGetInstanceProcAddr: () => 0,
    SDL_Vulkan_GetInstanceExtensions: (count) => { outI32(count, 0); return 0; },
    SDL_Vulkan_CreateSurface: () => fail('Vulkan is not available in the browser'),
    SDL_Vulkan_GetPresentationSupport: () => 0,

    // Events
    SDL_PumpEvents: () => { noteResumed(); },
    SDL_PollEvent: (event) => {
      noteResumed();
      for (const address of eventStrings.splice(0)) free(address);
      if (!queue.length) return 0;
      if (!ptr(event)) return 1;
      writeEvent(ptr(event), queue.shift());
      return 1;
    },
    SDL_HasEvent: (type) => (queue.some((e) => e.type === type) ? 1 : 0),
    SDL_HasEvents: (min, max) => (queue.some((e) => e.type >= min && e.type <= max) ? 1 : 0),
    SDL_FlushEvent: (type) => {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === type) queue.splice(i, 1);
    },
    SDL_FlushEvents: (min, max) => {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type >= min && queue[i].type <= max) queue.splice(i, 1);
    },
    SDL_GetWindowFromEvent: (event) => {
      sync();
      const p = ptr(event) >> 2;
      return windowEvent(U32[p]) ? handleOf(windows.has(U32[p + 4]) ? U32[p + 4] : 0) : 0;
    },
    SDL_PushEvent: ok,

    // Keyboard and text input
    SDL_GetKeyboardState: (numkeys) => {
      if (!keyboardState) {
        keyboardState = malloc(512);
        sync();
        U8.fill(0, keyboardState, keyboardState + 512);
      }
      outI32(numkeys, 512);
      return keyboardState;
    },
    SDL_GetModState: () => modState,
    SDL_SetModState: (mod) => { modState = mod; },
    SDL_GetKeyFromScancode: (scancode) => keyForScancode(scancode),
    SDL_GetScancodeFromKey: (key, mod) => {
      outI32(mod, 0);
      if (key & SCANCODE_MASK) return key & ~SCANCODE_MASK;
      for (const [scancode, k] of Object.entries(CHARACTER_KEYS)) if (k === key) return Number(scancode);
      return 0;
    },
    SDL_GetKeyName: (key) => cstring(keyName(key)),
    SDL_GetScancodeName: (scancode) => cstring(keyName(keyForScancode(scancode))),
    SDL_StartTextInput: () => {
      textInput = true;
      imeInput?.focus({ preventScroll: true });
      return 1;
    },
    SDL_StartTextInputWithProperties: () => api.SDL_StartTextInput(),
    SDL_StopTextInput: () => {
      textInput = false;
      if (composing && imeInput) imeInput.value = '';
      return 1;
    },
    SDL_TextInputActive: () => (textInput ? 1 : 0),
    SDL_ClearComposition: () => {
      if (imeInput) imeInput.value = '';
      return 1;
    },
    // Puts the hidden text field where the game's text cursor is, so the input method's
    // candidate window opens next to it.
    SDL_SetTextInputArea: (handle, rect, cursor) => {
      if (!imeInput || !ptr(rect)) return 1;
      sync();
      const p = ptr(rect) >> 2;
      const bounds = canvas.getBoundingClientRect();
      const scale = bounds.width / canvas.width;
      imeInput.style.left = `${bounds.left + (I32[p] + cursor) * scale}px`;
      imeInput.style.top = `${bounds.top + (I32[p + 1] + I32[p + 3]) * scale}px`;
      return 1;
    },
    SDL_HasScreenKeyboardSupport: () => 0,

    // Mouse
    SDL_GetMouseState: (x, y) => { outF32(x, cursorX); outF32(y, cursorY); return buttonMask; },
    SDL_GetGlobalMouseState: (x, y) => { outF32(x, cursorX); outF32(y, cursorY); return buttonMask; },
    SDL_GetRelativeMouseState: (x, y) => { outF32(x, 0); outF32(y, 0); return buttonMask; },
    SDL_WarpMouseInWindow: (handle, x, y) => {
      cursorX = x;
      cursorY = y;
      push({ type: EV.MOUSE_MOTION, state: buttonMask, x, y, xrel: 0, yrel: 0 });
    },
    SDL_SetWindowRelativeMouseMode: (handle, enabled) => {
      relativeMode = !!enabled;
      lockRequested = relativeMode;
      canvas.style.cursor = relativeMode ? 'none' : '';
      if (relativeMode) requestLock();
      else if (document.pointerLockElement === canvas) document.exitPointerLock();
      return 1;
    },
    SDL_GetWindowRelativeMouseMode: () => (relativeMode ? 1 : 0),
    SDL_CreateSystemCursor: (id) => CURSOR_BASE + id,
    SDL_CreateCursor: () => CURSOR_BASE,
    SDL_CreateColorCursor: () => CURSOR_BASE,
    SDL_GetDefaultCursor: () => CURSOR_BASE,
    SDL_GetCursor: () => CURSOR_BASE,
    SDL_SetCursor: (cursor) => {
      if (!relativeMode) canvas.style.cursor = CURSORS[ptr(cursor) - CURSOR_BASE] || '';
      return 1;
    },
    SDL_DestroyCursor: () => undefined,
    SDL_ShowCursor: ok,
    SDL_HideCursor: ok,
    SDL_CursorVisible: () => 1,

    // Clipboard
    SDL_SetClipboardText: (text) => {
      clipboard = readCString(text) ?? '';
      navigator.clipboard?.writeText(clipboard).catch(() => {});
      return 1;
    },
    SDL_GetClipboardText: () => {
      // The caller frees the copy with SDL_free.
      const bytes = encodeUtf8(clipboard);
      const address = malloc(bytes.length + 1);
      sync();
      U8.set(bytes, address);
      U8[address + bytes.length] = 0;
      return address;
    },
    SDL_HasClipboardText: () => (clipboard ? 1 : 0),

    // Surfaces (window icons)
    SDL_CreateSurfaceFrom: (w, h, format, pixels, pitch) => {
      const s = malloc(32);
      sync();
      const p = s >> 2;
      U32[p] = 0;
      U32[p + 1] = format >>> 0;
      I32[p + 2] = w;
      I32[p + 3] = h;
      I32[p + 4] = pitch;
      U32[p + 5] = ptr(pixels);
      I32[p + 6] = 1;
      U32[p + 7] = 0;
      return s;
    },
    SDL_AddSurfaceAlternateImage: ok,
    SDL_DestroySurface: (s) => free(s),

    // Message boxes: the page shows errors itself; the game continues as if one was dismissed.
    SDL_ShowSimpleMessageBox: (flags, title, message) => {
      console.error(`[sdl] ${readCString(title)}: ${readCString(message)}`);
      return 1;
    },
    SDL_ShowMessageBox: (data, buttonId) => {
      sync();
      const p = ptr(data) >> 2;
      console.error(`[sdl] ${readCString(U32[p + 2])}: ${readCString(U32[p + 3])}`);
      const buttons = U32[p + 5];
      outI32(buttonId, I32[p + 4] > 0 && buttons ? I32[(buttons >> 2) + 1] : -1);
      return 1;
    },

    // Gamepads and joysticks: none
    SDL_GetGamepads: (count) => { outI32(count, 0); return 0; },
    SDL_GetJoysticks: (count) => { outI32(count, 0); return 0; },
    SDL_HasGamepad: () => 0,
    SDL_HasJoystick: () => 0,
  };

  // LWJGL loads the library as libSDL3.so (Platform.mapLibraryNameBundled("SDL3")).
  defineLibrary('SDL3', { aliases: ['libSDL3.so', 'libSDL3.so.0', 'SDL3'], impls: api, lenient: true });

  return {
    api, resize, push, stats,
    isCreated: () => mainWindow !== 0,
    /** 0: no window yet, 1: the render thread waits for the browser, 2: it is working on a frame. */
    renderState: () => (!mainWindow ? 0 : waitingForBrowser > 0 ? 1 : 2),
    untilRenderWaits,
  };
}
