// GLFW 3.3 / 3.4 implemented on a <canvas> and DOM input events.
//
// Functions are reached through LWJGL's JNI.invoke* trampolines with addresses from dlsym.
// Input events are queued and delivered to the Java callbacks inside glfwPollEvents, which
// is an async native: CheerpJ suspends the Java thread while the callbacks run.
import { ptr, readCString, cstring, malloc, sync, I32 } from './heap.js';
import { outI32, outF32, outF64, outPointer } from './core.js';
import { defineLibrary, callJava } from './registry.js';

const WINDOW = 0x5000;
const MONITOR = 0x6000;
const CURSOR_BASE = 0x7000;

const G = {
  CURSOR: 0x33001, STICKY_KEYS: 0x33002, STICKY_MOUSE_BUTTONS: 0x33003, LOCK_KEY_MODS: 0x33004, RAW_MOUSE_MOTION: 0x33005,
  CURSOR_NORMAL: 0x34001, CURSOR_HIDDEN: 0x34002, CURSOR_DISABLED: 0x34003,
  FOCUSED: 0x20001, ICONIFIED: 0x20002, RESIZABLE: 0x20003, VISIBLE: 0x20004, DECORATED: 0x20005, MAXIMIZED: 0x20008, HOVERED: 0x2000b,
  CLIENT_API: 0x22001, CONTEXT_VERSION_MAJOR: 0x22002, CONTEXT_VERSION_MINOR: 0x22003, OPENGL_FORWARD_COMPAT: 0x22006,
  OPENGL_PROFILE: 0x22008, OPENGL_CORE_PROFILE: 0x32001, PLATFORM_X11: 0x60004,
  RELEASE: 0, PRESS: 1, REPEAT: 2,
  MOD_SHIFT: 1, MOD_CONTROL: 2, MOD_ALT: 4, MOD_SUPER: 8, MOD_CAPS_LOCK: 0x10, MOD_NUM_LOCK: 0x20,
};

// KeyboardEvent.code -> GLFW key
const KEYS = {
  Space: 32, Quote: 39, Comma: 44, Minus: 45, Period: 46, Slash: 47,
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  Semicolon: 59, Equal: 61, BracketLeft: 91, Backslash: 92, BracketRight: 93, Backquote: 96, IntlBackslash: 162,
  Escape: 256, Enter: 257, Tab: 258, Backspace: 259, Insert: 260, Delete: 261, ArrowRight: 262, ArrowLeft: 263,
  ArrowDown: 264, ArrowUp: 265, PageUp: 266, PageDown: 267, Home: 268, End: 269, CapsLock: 280, ScrollLock: 281,
  NumLock: 282, PrintScreen: 283, Pause: 284,
  Numpad0: 320, Numpad1: 321, Numpad2: 322, Numpad3: 323, Numpad4: 324, Numpad5: 325, Numpad6: 326, Numpad7: 327,
  Numpad8: 328, Numpad9: 329, NumpadDecimal: 330, NumpadDivide: 331, NumpadMultiply: 332, NumpadSubtract: 333,
  NumpadAdd: 334, NumpadEnter: 335, NumpadEqual: 336, ShiftLeft: 340, ControlLeft: 341, AltLeft: 342, MetaLeft: 343,
  ShiftRight: 344, ControlRight: 345, AltRight: 346, MetaRight: 347, ContextMenu: 348,
};
for (let i = 0; i < 26; i++) KEYS[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
for (let i = 1; i <= 25; i++) KEYS[`F${i}`] = 289 + i;
const SCANCODES = Object.fromEntries(Object.keys(KEYS).map((code, i) => [code, i + 9]));
const KEY_NAMES = new Map(Object.entries(KEYS).map(([code, key]) => [key, code]));

export function createGLFW({ gl, canvas, stage, onFullscreen, onTitle, getRenderSize }) {
  const callbacks = {};
  const keyState = new Map();
  const buttons = new Map();
  const queue = [];
  const hints = new Map();
  const inputModes = new Map([[G.CURSOR, G.CURSOR_NORMAL], [G.RAW_MOUSE_MOTION, 0], [G.STICKY_KEYS, 0], [G.LOCK_KEY_MODS, 0]]);
  let shouldClose = false;
  let cursorX = 0;
  let cursorY = 0;
  let fullscreen = false;
  let swapInterval = 1;
  let timeBase = performance.now();
  let clipboard = '';
  let lastEscape = 0;
  let wantsPointerLock = false;
  let windowCreated = false;
  let focused = document.hasFocus();
  let imeInput = null;
  let lockRequestedByGame = false;
  let waiter = null;
  let errorCallback = 0;
  // Frame timing (for troubleshooting): `resume` is the time from the display frame to the render
  // thread running again (other Java threads hold the CPU meanwhile), `work` the time from then
  // until the next swap.
  const stats = { frames: 0, resume: 0, work: 0, vsync: 0, swapAt: 0, vsyncAt: 0, resumedAt: 0 };
  const noteResumed = () => {
    if (!stats.vsyncAt) return; // only the first poll after a swap
    const now = performance.now();
    stats.resume += now - stats.vsyncAt;
    stats.vsyncAt = 0;
    stats.resumedAt = now;
  };

  const push = (event) => {
    queue.push(event);
    if (waiter) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  };

  // -------------------------------------------------------------------------
  // DOM input -> queued GLFW events
  // -------------------------------------------------------------------------
  const mods = (e) => (e.shiftKey ? G.MOD_SHIFT : 0) | (e.ctrlKey ? G.MOD_CONTROL : 0) | (e.altKey ? G.MOD_ALT : 0)
    | (e.metaKey ? G.MOD_SUPER : 0) | (e.getModifierState?.('CapsLock') ? G.MOD_CAPS_LOCK : 0) | (e.getModifierState?.('NumLock') ? G.MOD_NUM_LOCK : 0);
  // F12 (developer tools) and F11 (the page's fullscreen) stay with the browser; everything
  // else goes to the game.
  const passThrough = (e) => e.code === 'F12' || e.code === 'F11';

  function onKeyDown(e) {
    if (!windowCreated || passThrough(e)) return;
    if (e.isComposing || e.keyCode === 229) return; // input method composing
    const key = KEYS[e.code] ?? -1;
    const isPaste = (e.ctrlKey || e.metaKey) && e.code === 'KeyV';
    if (!isPaste) e.preventDefault();
    if (e.code === 'Escape') lastEscape = performance.now();
    const action = e.repeat ? G.REPEAT : G.PRESS;
    if (key >= 0) keyState.set(key, 1);
    push({ type: 'key', key, scancode: SCANCODES[e.code] ?? 0, action, mods: mods(e) });
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      push({ type: 'char', codepoint: e.key.codePointAt(0), mods: mods(e) });
    }
  }
  function onKeyUp(e) {
    if (!windowCreated || passThrough(e)) return;
    const key = KEYS[e.code] ?? -1;
    e.preventDefault();
    if (key >= 0) keyState.set(key, 0);
    push({ type: 'key', key, scancode: SCANCODES[e.code] ?? 0, action: G.RELEASE, mods: mods(e) });
  }
  function onComposition(e) {
    if (!windowCreated) return;
    for (const ch of e.data || '') push({ type: 'char', codepoint: ch.codePointAt(0), mods: 0 });
    if (imeInput) imeInput.value = '';
  }
  function onPaste(e) {
    clipboard = e.clipboardData?.getData('text') ?? clipboard;
  }
  function toFramebuffer(e) {
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height)];
  }
  function onMouseMove(e) {
    if (!windowCreated) return;
    if (document.pointerLockElement === canvas) {
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      cursorX += e.movementX * scale;
      cursorY += e.movementY * scale;
    } else {
      [cursorX, cursorY] = toFramebuffer(e);
    }
    push({ type: 'cursor', x: cursorX, y: cursorY });
  }
  const buttonOf = (b) => (b === 0 ? 0 : b === 2 ? 1 : b === 1 ? 2 : b);
  function onMouseDown(e) {
    if (!windowCreated) return;
    e.preventDefault();
    imeInput?.focus({ preventScroll: true });
    if (wantsPointerLock && document.pointerLockElement !== canvas) requestLock();
    const button = buttonOf(e.button);
    buttons.set(button, 1);
    push({ type: 'button', button, action: G.PRESS, mods: mods(e) });
  }
  function onMouseUp(e) {
    if (!windowCreated) return;
    const button = buttonOf(e.button);
    if (!buttons.get(button)) return;
    buttons.set(button, 0);
    push({ type: 'button', button, action: G.RELEASE, mods: mods(e) });
  }
  function onWheel(e) {
    if (!windowCreated) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
    push({ type: 'scroll', x: -e.deltaX * unit, y: -e.deltaY * unit });
  }
  function onFocus(value) {
    focused = value;
    if (!value) {
      for (const [key, state] of keyState) if (state) push({ type: 'key', key, scancode: 0, action: G.RELEASE, mods: 0 });
      keyState.clear();
    }
    push({ type: 'focus', focused: value });
  }
  function requestLock() {
    try {
      const result = canvas.requestPointerLock?.();
      if (result && result.catch) result.catch(() => {});
    } catch {
      // Needs a user gesture; retried on the next click.
    }
  }
  function onPointerLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (!locked && wantsPointerLock && lockRequestedByGame) {
      // The browser released the pointer (usually Esc). Tell the game, which opens its menu.
      if (performance.now() - lastEscape > 150) {
        push({ type: 'key', key: 256, scancode: SCANCODES.Escape, action: G.PRESS, mods: 0 });
        push({ type: 'key', key: 256, scancode: SCANCODES.Escape, action: G.RELEASE, mods: 0 });
      }
    }
  }

  function installInput() {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('compositionend', onComposition, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('mousemove', onMouseMove, true);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp, true);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mouseenter', () => push({ type: 'enter', entered: true }));
    canvas.addEventListener('mouseleave', () => push({ type: 'enter', entered: false }));
    window.addEventListener('focus', () => onFocus(true));
    window.addEventListener('blur', () => onFocus(false));
    document.addEventListener('pointerlockchange', onPointerLockChange);
    imeInput = document.createElement('textarea');
    imeInput.className = 'ime-input';
    imeInput.setAttribute('aria-hidden', 'true');
    imeInput.spellcheck = false;
    document.body.appendChild(imeInput);
    imeInput.focus({ preventScroll: true });
  }

  /** Called by the page when the render size changes. */
  function resize(width, height) {
    canvas.width = width;
    canvas.height = height;
    gl.resizeBackbuffer(width, height);
    push({ type: 'size', width, height });
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------
  async function dispatch(e) {
    const W = WINDOW;
    switch (e.type) {
      case 'key': return callbacks.key && callJava(callbacks.key, W, e.key, e.scancode, e.action, e.mods);
      case 'char':
        if (callbacks.char) await callJava(callbacks.char, W, e.codepoint);
        if (callbacks.charMods) await callJava(callbacks.charMods, W, e.codepoint, e.mods);
        return undefined;
      case 'cursor': return callbacks.cursorPos && callJava(callbacks.cursorPos, W, e.x, e.y);
      case 'button': return callbacks.mouseButton && callJava(callbacks.mouseButton, W, e.button, e.action, e.mods);
      case 'scroll': return callbacks.scroll && callJava(callbacks.scroll, W, e.x, e.y);
      case 'enter': return callbacks.cursorEnter && callJava(callbacks.cursorEnter, W, e.entered);
      case 'focus': return callbacks.focus && callJava(callbacks.focus, W, e.focused);
      case 'size':
        if (callbacks.framebufferSize) await callJava(callbacks.framebufferSize, W, e.width, e.height);
        if (callbacks.windowSize) await callJava(callbacks.windowSize, W, e.width, e.height);
        return undefined;
      default: return undefined;
    }
  }
  function pollEvents() {
    if (!queue.length) return undefined;
    return (async () => {
      // Coalesce cursor moves: only the latest position matters.
      const events = queue.splice(0);
      let lastCursor = -1;
      events.forEach((e, i) => { if (e.type === 'cursor') lastCursor = i; });
      for (let i = 0; i < events.length; i++) {
        if (events[i].type === 'cursor' && i !== lastCursor) continue;
        await dispatch(events[i]);
      }
    })();
  }
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  // While the render thread waits for the browser (an animation frame, a timer), the other Java
  // threads must let the browser run; webmc.jdk.Sched asks through renderWaiting().
  let waitingForBrowser = 0;
  const renderWaiters = [];
  const waitForBrowser = (promise) => {
    waitingForBrowser++;
    for (const resolve of renderWaiters.splice(0)) resolve();
    return promise.finally(() => { waitingForBrowser--; });
  };
  /** Resolves when the render thread next waits for the browser, or after timeoutMs. */
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

  const setCallback = (slot) => (window, cb) => {
    const previous = callbacks[slot] || 0;
    callbacks[slot] = ptr(cb);
    return previous;
  };

  // -------------------------------------------------------------------------
  // Monitors and video modes (structs live in the heap)
  // -------------------------------------------------------------------------
  let videoMode = 0;
  let monitorArray = 0;
  function currentVideoMode() {
    if (!videoMode) videoMode = malloc(24);
    sync();
    const base = videoMode >> 2;
    I32[base] = Math.round(screen.width * devicePixelRatio);
    I32[base + 1] = Math.round(screen.height * devicePixelRatio);
    I32[base + 2] = 8;
    I32[base + 3] = 8;
    I32[base + 4] = 8;
    I32[base + 5] = 60;
    return videoMode;
  }

  // -------------------------------------------------------------------------
  // The GLFW API
  // -------------------------------------------------------------------------
  const api = {
    glfwInit: () => 1,
    glfwTerminate: () => undefined,
    glfwInitHint: () => undefined,
    glfwInitAllocator: () => undefined,
    glfwInitVulkanLoader: () => undefined,
    glfwGetVersion: (major, minor, rev) => { outI32(major, 3); outI32(minor, 3); outI32(rev, 8); },
    glfwGetVersionString: () => cstring('3.3.8 WebGL2 (browser)'),
    glfwGetError: (description) => { outPointer(description, 0); return 0; },
    glfwSetErrorCallback: (cb) => { const p = errorCallback; errorCallback = ptr(cb); return p; },
    glfwGetPlatform: () => G.PLATFORM_X11,
    glfwPlatformSupported: (p) => (p === G.PLATFORM_X11 ? 1 : 0),

    glfwGetMonitors: (count) => {
      if (!monitorArray) { monitorArray = malloc(8); sync(); I32[monitorArray >> 2] = MONITOR; }
      outI32(count, 1);
      return monitorArray;
    },
    glfwGetPrimaryMonitor: () => MONITOR,
    glfwGetMonitorPos: (m, x, y) => { outI32(x, 0); outI32(y, 0); },
    glfwGetMonitorWorkarea: (m, x, y, w, h) => { outI32(x, 0); outI32(y, 0); outI32(w, screen.width); outI32(h, screen.height); },
    glfwGetMonitorPhysicalSize: (m, w, h) => { outI32(w, 530); outI32(h, 300); },
    glfwGetMonitorContentScale: (m, x, y) => { outF32(x, 1); outF32(y, 1); },
    glfwGetMonitorName: () => cstring('Browser'),
    glfwSetMonitorUserPointer: () => undefined,
    glfwGetMonitorUserPointer: () => 0,
    glfwSetMonitorCallback: setCallback('monitor'),
    glfwGetVideoModes: (m, count) => { outI32(count, 1); return currentVideoMode(); },
    glfwGetVideoMode: () => currentVideoMode(),
    glfwSetGamma: () => undefined,
    glfwGetGammaRamp: () => 0,
    glfwSetGammaRamp: () => undefined,

    glfwDefaultWindowHints: () => hints.clear(),
    glfwWindowHint: (hint, value) => hints.set(hint, value),
    glfwWindowHintString: () => undefined,
    glfwCreateWindow: (width, height, title) => {
      const core = hints.get(G.OPENGL_PROFILE) === G.OPENGL_CORE_PROFILE;
      const size = getRenderSize();
      canvas.width = size.width;
      canvas.height = size.height;
      gl.attach(canvas, { profile: core ? 'core' : 'compat' });
      gl.setProfile(core ? 'core' : 'compat', [3, 3]);
      onTitle?.(readCString(title) || 'Minecraft');
      windowCreated = true;
      installInput();
      return WINDOW;
    },
    glfwDestroyWindow: () => { windowCreated = false; },
    glfwWindowShouldClose: () => (shouldClose ? 1 : 0),
    glfwSetWindowShouldClose: (w, value) => { shouldClose = !!value; },
    glfwSetWindowTitle: (w, title) => onTitle?.(readCString(title)),
    glfwGetWindowTitle: () => cstring(document.title),
    glfwSetWindowIcon: () => undefined,
    glfwGetWindowPos: (w, x, y) => { outI32(x, 0); outI32(y, 0); },
    glfwSetWindowPos: () => undefined,
    glfwGetWindowSize: (w, width, height) => { outI32(width, canvas.width); outI32(height, canvas.height); },
    glfwSetWindowSizeLimits: () => undefined,
    glfwSetWindowAspectRatio: () => undefined,
    glfwSetWindowSize: () => undefined,
    glfwGetFramebufferSize: (w, width, height) => { outI32(width, canvas.width); outI32(height, canvas.height); },
    glfwGetWindowFrameSize: (w, l, t, r, b) => { outI32(l, 0); outI32(t, 0); outI32(r, 0); outI32(b, 0); },
    glfwGetWindowContentScale: (w, x, y) => { outF32(x, 1); outF32(y, 1); },
    glfwGetWindowOpacity: () => 1,
    glfwSetWindowOpacity: () => undefined,
    glfwIconifyWindow: () => undefined,
    glfwRestoreWindow: () => undefined,
    glfwMaximizeWindow: () => undefined,
    glfwShowWindow: () => undefined,
    glfwHideWindow: () => undefined,
    glfwFocusWindow: () => canvas.focus(),
    glfwRequestWindowAttention: () => undefined,
    glfwGetWindowMonitor: () => (fullscreen ? MONITOR : 0),
    glfwSetWindowMonitor: (w, monitor) => {
      fullscreen = !!ptr(monitor);
      onFullscreen?.(fullscreen);
    },
    glfwGetWindowAttrib: (w, attrib) => {
      switch (attrib) {
        case G.FOCUSED: return focused ? 1 : 0;
        case G.ICONIFIED: return document.hidden ? 1 : 0;
        case G.VISIBLE: case G.RESIZABLE: case G.DECORATED: return 1;
        case G.HOVERED: return 1;
        case G.MAXIMIZED: return 0;
        case G.CLIENT_API: return 0x30001;
        case G.CONTEXT_VERSION_MAJOR: return 3;
        case G.CONTEXT_VERSION_MINOR: return 3;
        case G.OPENGL_PROFILE: return hints.get(G.OPENGL_PROFILE) || 0;
        default: return 0;
      }
    },
    glfwSetWindowAttrib: () => undefined,
    glfwSetWindowUserPointer: () => undefined,
    glfwGetWindowUserPointer: () => 0,
    glfwSetWindowPosCallback: setCallback('windowPos'),
    glfwSetWindowSizeCallback: setCallback('windowSize'),
    glfwSetWindowCloseCallback: setCallback('windowClose'),
    glfwSetWindowRefreshCallback: setCallback('windowRefresh'),
    glfwSetWindowFocusCallback: setCallback('focus'),
    glfwSetWindowIconifyCallback: setCallback('iconify'),
    glfwSetWindowMaximizeCallback: setCallback('maximize'),
    glfwSetFramebufferSizeCallback: setCallback('framebufferSize'),
    glfwSetWindowContentScaleCallback: setCallback('contentScale'),

    glfwPollEvents: () => {
      noteResumed();
      return pollEvents();
    },
    glfwWaitEvents: () => (queue.length ? pollEvents() : waitForBrowser(new Promise((resolve) => { waiter = resolve; })).then(pollEvents)),
    glfwWaitEventsTimeout: (timeout) => {
      if (queue.length) return pollEvents();
      return waitForBrowser(new Promise((resolve) => {
        const timer = setTimeout(() => { waiter = null; resolve(); }, Math.max(0, timeout * 1000));
        waiter = () => { clearTimeout(timer); resolve(); };
      })).then(pollEvents);
    },
    glfwPostEmptyEvent: () => { if (waiter) { const w = waiter; waiter = null; w(); } },

    glfwGetInputMode: (w, mode) => inputModes.get(mode) ?? 0,
    glfwSetInputMode: (w, mode, value) => {
      inputModes.set(mode, value);
      if (mode === G.CURSOR) {
        wantsPointerLock = value === G.CURSOR_DISABLED;
        lockRequestedByGame = wantsPointerLock;
        canvas.style.cursor = value === G.CURSOR_NORMAL ? '' : 'none';
        if (wantsPointerLock) requestLock();
        else if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
    },
    glfwRawMouseMotionSupported: () => 1,
    glfwGetKeyName: (key, scancode) => {
      const code = KEY_NAMES.get(key);
      if (!code) return 0;
      if (code.startsWith('Key')) return cstring(code.slice(3).toLowerCase());
      if (code.startsWith('Digit')) return cstring(code.slice(5));
      const symbols = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
      return symbols[code] ? cstring(symbols[code]) : 0;
    },
    glfwGetKeyScancode: (key) => SCANCODES[KEY_NAMES.get(key)] ?? -1,
    glfwGetKey: (w, key) => keyState.get(key) || 0,
    glfwGetMouseButton: (w, button) => buttons.get(button) || 0,
    glfwGetCursorPos: (w, x, y) => { outF64(x, cursorX); outF64(y, cursorY); },
    glfwSetCursorPos: (w, x, y) => { cursorX = x; cursorY = y; },
    glfwCreateCursor: () => CURSOR_BASE,
    glfwCreateStandardCursor: (shape) => CURSOR_BASE + (shape & 0xff),
    glfwDestroyCursor: () => undefined,
    glfwSetCursor: (w, cursor) => {
      const shape = ptr(cursor) - CURSOR_BASE;
      const css = { 1: 'default', 2: 'text', 3: 'crosshair', 4: 'pointer', 5: 'ew-resize', 6: 'ns-resize' }[shape] || '';
      if (inputModes.get(G.CURSOR) === G.CURSOR_NORMAL) canvas.style.cursor = css;
    },
    glfwSetKeyCallback: setCallback('key'),
    glfwSetCharCallback: setCallback('char'),
    glfwSetCharModsCallback: setCallback('charMods'),
    glfwSetMouseButtonCallback: setCallback('mouseButton'),
    glfwSetCursorPosCallback: setCallback('cursorPos'),
    glfwSetCursorEnterCallback: setCallback('cursorEnter'),
    glfwSetScrollCallback: setCallback('scroll'),
    glfwSetDropCallback: setCallback('drop'),

    glfwJoystickPresent: () => 0,
    glfwGetJoystickAxes: (jid, count) => { outI32(count, 0); return 0; },
    glfwGetJoystickButtons: (jid, count) => { outI32(count, 0); return 0; },
    glfwGetJoystickHats: (jid, count) => { outI32(count, 0); return 0; },
    glfwGetJoystickName: () => 0,
    glfwGetJoystickGUID: () => 0,
    glfwJoystickIsGamepad: () => 0,
    glfwSetJoystickCallback: setCallback('joystick'),
    glfwUpdateGamepadMappings: () => 1,
    glfwGetGamepadName: () => 0,
    glfwGetGamepadState: () => 0,

    glfwSetClipboardString: (w, text) => {
      clipboard = readCString(text) ?? '';
      navigator.clipboard?.writeText(clipboard).catch(() => {});
    },
    glfwGetClipboardString: () => cstring(clipboard),

    glfwGetTime: () => (performance.now() - timeBase) / 1000,
    glfwSetTime: (t) => { timeBase = performance.now() - t * 1000; },
    glfwGetTimerValue: () => Math.round(performance.now() * 1000),
    glfwGetTimerFrequency: () => 1000000,

    glfwMakeContextCurrent: () => undefined,
    glfwGetCurrentContext: () => (windowCreated ? WINDOW : 0),
    glfwSwapBuffers: () => {
      gl.present();
      const now = performance.now();
      stats.frames++;
      if (stats.resumedAt) stats.work += now - stats.resumedAt;
      stats.resumedAt = 0;
      // The other game threads (integrated server, chunk builders) mostly run while the render
      // thread waits here (see webmc.jdk.Sched).
      return waitForBrowser(nextFrame()).then(() => {
        stats.vsyncAt = performance.now();
        stats.vsync += stats.vsyncAt - now;
      });
    },
    glfwSwapInterval: (interval) => { swapInterval = interval; },
    glfwExtensionSupported: (ext) => (gl.S.extensions.includes(readCString(ext)) ? 1 : 0),
    glfwGetProcAddress: (procName) => gl.getProcAddress(readCString(procName)),

    glfwVulkanSupported: () => 0,
    glfwGetRequiredInstanceExtensions: (count) => { outI32(count, 0); return 0; },
    glfwGetInstanceProcAddress: () => 0,
    glfwGetPhysicalDevicePresentationSupport: () => 0,
    glfwCreateWindowSurface: () => -7,
  };
  void swapInterval;

  // LWJGL 3.1 - 3.2 on a 32-bit JVM ask for glfw32 (CheerpJ's Java 8 maps it to glfw32.js).
  defineLibrary('glfw', { aliases: ['libglfw.so', 'libglfw.so.3', 'glfw3', 'glfw32'], impls: api, lenient: true });

  return {
    api, resize, push, stats, isCreated: () => windowCreated, setImeInput: (el) => { imeInput = el; },
    /** 0: no window yet, 1: the render thread waits for the browser, 2: it is working on a frame. */
    renderState: () => (!windowCreated ? 0 : waitingForBrowser > 0 ? 1 : 2),
    untilRenderWaits,
  };
}
