import { loadSettings } from './settings.js';
import { launchOptions, mergeOptions } from './options.js';
import { JAVA8_PRELOAD } from './preload.js';
import { installInputScaling, setInputScale } from './input-scale.js';
import { installKeyBridge, keyBridgeNatives, onWithheldKey, setKeyBridgeActive } from './key-bridge.js';
import { fixDirectoryRenames, keepOpenFilesSaved } from './fs-fixes.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const versionId = params.get('v');
const settings = loadSettings();

// Small Java entry point (java/src/webmc/Launcher.java) placed in front of the game's main class.
const BOOTSTRAP_JAR = '/app/webmc-launcher.jar';
const BOOTSTRAP_MAIN = 'webmc.Launcher';

const LOG_LIMIT = params.get('debug') === '1' ? 50_000 : 500;
const logLines = [];
let running = false;

// Exposed for troubleshooting from the browser devtools.
window.webmc = { logs: logLines };

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(title, detail = '') {
  $('status').textContent = title;
  $('detail').textContent = detail;
}

function setProgress(fraction, text) {
  $('progress').hidden = fraction === null;
  if (fraction !== null) $('progress-bar').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  $('progress-text').textContent = text || '';
}

function showOverlay(show) {
  $('overlay').hidden = !show;
}

function fail(title, message) {
  running = false;
  setKeyBridgeActive(false);
  document.exitPointerLock?.();
  showOverlay(true);
  setStatus(title, message);
  setProgress(null);
  $('overlay-actions').hidden = false;
  $('overlay-log').hidden = logLines.length === 0;
  $('overlay-log-text').textContent = logLines.join('\n');
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

function formatBytes(bytes) {
  return `${((bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}

// With no #console element in the page, CheerpJ sends Java stdout/stderr to console.log.
// Keep a bounded copy for the in-page console instead of letting a DOM node grow forever.
function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a))).join(' ');
      for (const line of text.split('\n')) {
        if (line) logLines.push(line);
      }
      if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
      if (!$('java-console').hidden) renderConsole();
    };
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let renderQueued = false;
function renderConsole() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const pre = $('java-console-text');
    pre.textContent = logLines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  });
}

function toggleConsole() {
  $('java-console').hidden = !$('java-console').hidden;
  if (!$('java-console').hidden) renderConsole();
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`無法載入 ${src}`));
    document.head.appendChild(script);
  });
}

/** Asks the server to fetch every game file from Mojang (SHA-1 verified), with live progress. */
function prepareFiles(query) {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/versions/${encodeURIComponent(versionId)}/prepare${query}`);
    source.addEventListener('progress', (event) => {
      const p = JSON.parse(event.data);
      setProgress(p.total ? p.downloaded / p.total : 0, `${p.filesDone} / ${p.filesTotal} 個檔案 · ${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`);
    });
    source.addEventListener('done', (event) => {
      source.close();
      resolve(JSON.parse(event.data));
    });
    source.addEventListener('fail', (event) => {
      source.close();
      reject(new Error(JSON.parse(event.data).message));
    });
    source.onerror = () => {
      source.close();
      reject(new Error('與伺服器的連線中斷'));
    };
  });
}

// ---------------------------------------------------------------------------
// CheerpJ virtual filesystem (/files is persistent IndexedDB storage).
// cheerpOS* are CheerpJ's low-level file APIs, also used by leaningtech/browsercraft.
// ---------------------------------------------------------------------------
function createVirtualDir(path) {
  return new Promise((resolve) => cheerpOSCreateDir(path, new CheerpJFileData(), 0o755, () => resolve()));
}

async function readVirtualFile(path) {
  try {
    const blob = await cjFileBlob(path);
    return blob ? await blob.text() : null;
  } catch {
    return null;
  }
}

function listVirtualDir(path) {
  return new Promise((resolve) => {
    const names = [];
    try {
      cheerpOSListFiles(path, names, () => resolve(names));
    } catch {
      resolve([]);
    }
  });
}

function writeVirtualFile(path, data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Promise((resolve, reject) => {
    const fds = [];
    cheerpOSOpen(fds, path, 'w', (fd) => {
      if (fd < 0) return reject(new Error(`無法寫入 ${path}`));
      cheerpOSWrite(fds, fd, bytes, 0, bytes.length, () => cheerpOSClose(fds, fd, resolve));
    });
  });
}

async function applyLaunchOptions(plan) {
  const values = launchOptions(settings.preset, plan);
  const file = `${plan.gameDir}/options.txt`;
  try {
    await createVirtualDir(plan.gameDir);
    const current = await readVirtualFile(file);
    await writeVirtualFile(file, mergeOptions(current, values));
  } catch (error) {
    console.warn('[launcher] Could not update options.txt:', error.message);
  }
}

// Minecraft 1.9+ saves a world icon by reading back the frame buffer (glReadPixels) a few
// seconds after a world loads. The WebGL-based GL driver cannot read pixels and that path
// stops the client, so every save folder gets a placeholder icon.png before then.
// (Polling the filesystem from a Java thread instead freezes CheerpJ, so it is done here.)
async function keepWorldIcons(gameDir) {
  const saves = `${gameDir}/saves`;
  const icon = new Uint8Array(await (await fetch('/img/world-icon.png')).arrayBuffer());
  const done = new Set();
  for (;;) {
    for (const world of await listVirtualDir(saves)) {
      if (done.has(world)) continue;
      const names = await listVirtualDir(`${saves}/${world}`);
      if (!names.includes('level.dat')) continue;
      if (!names.includes('icon.png')) await writeVirtualFile(`${saves}/${world}/icon.png`, icon);
      done.add(world);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------------------------------------------------------------------------
// Display: the game renders at a reduced resolution and is scaled up with CSS,
// which is the single biggest frame-rate win for a browser JVM.
// ---------------------------------------------------------------------------
// LWJGL 2 clients are hosted in an AWT frame (see webmc.Launcher) and CheerpJ's AWT screen is
// a fixed 1024x768, so their render size must fit inside it; CSS scales it up to the page.
// LWJGL 3 clients draw into their own canvas and have no such limit.
const AWT_SCREEN = { width: 1024, height: 768 };

function computeRenderSize({ awt = true } = {}) {
  const stage = $('stage');
  const scale = Math.min(1, Math.max(0.25, Number(settings.renderScale) || 1));
  const width = Math.max(320, Math.round(stage.clientWidth * scale));
  const height = Math.max(240, Math.round(stage.clientHeight * scale));
  const k = awt ? Math.min(1, AWT_SCREEN.width / width, AWT_SCREEN.height / height) : 1;
  return { width: Math.floor(width * k), height: Math.floor(height * k) };
}

function fitViewport(size) {
  const stage = $('stage');
  const viewport = $('viewport');
  viewport.style.width = `${size.width}px`;
  viewport.style.height = `${size.height}px`;
  const k = Math.min(stage.clientWidth / size.width, stage.clientHeight / size.height);
  viewport.style.transform = `translate(-50%, -50%) scale(${k})`;
  setInputScale(viewport, k);
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// Java system properties shared by every launch mode.
function commonProperties(prepared) {
  return [
    'user.home=/files',
    'log4j.configurationFile=/app/log4j2.xml',
    'log4j2.formatMsgNoLookups=true',
    'org.lwjgl.util.NoChecks=true',
    'java.nio.channels.spi.SelectorProvider=webmc.NullSelectorProvider',
    // 1.8+ allocates tens of MB of direct buffers for chunk geometry; allow up to the heap size.
    'sun.nio.MaxDirectMemorySize=-1',
    // CheerpJ's Unsafe.getShort/putShort do nothing on byte[], which breaks the JDK's byte-array
    // views (VarHandle, heap ByteBuffer) at 2-byte aligned offsets. Netty 4.2 (26.x) reads and
    // writes packets through those views; without them it uses single bytes.
    'io.netty.varHandle.enabled=false',
    `webmc.npePatch=${(prepared.npePatchClasses || []).join(',')}`,
    // Troubleshooting: ?threaddump=30 prints every Java thread's stack every 30 seconds;
    // ?profile=1 samples each game thread's stack and prints the busiest methods every 20 s.
    `webmc.threadDump=${Number(params.get('threaddump')) || 0}`,
    `webmc.profile=${params.get('profile') === '1'}`,
  ];
}

// 1.6 - 1.12.2 and older: browsercraft's WebAssembly LWJGL 2 on CheerpJ's X11 display.
function configureLwjgl2(plan, init, size) {
  installInputScaling();
  installKeyBridge($('stage'));
  onWithheldKey((code) => {
    if (code === 'F2') toast('網頁版無法使用 F2 遊戲截圖（瀏覽器無法讀回畫面）。可改用系統截圖工具。');
  });
  init.enableX11 = true;
  init.javaProperties.push(
    'java.library.path=/app/lwjgl/libraries/',
    `webmc.applet=${plan.mode === 'applet' ? 'auto' : ''}`,
    `webmc.parentDisplay=${plan.mode !== 'applet'}`,
    `webmc.width=${size.width}`,
    `webmc.height=${size.height}`,
    'webmc.keyBridge=true',
  );
  init.libraries = { 'libGL.so.1': '/app/lwjgl/libraries/gl4es.wasm' };
  init.natives = keyBridgeNatives;
  return {
    show() {
      fitViewport(size);
      window.addEventListener('resize', () => fitViewport(size));
      cheerpjCreateDisplay(size.width, size.height, $('viewport'));
      setKeyBridgeActive(true);
    },
  };
}

// Ambient block animation samples per client tick, by quality preset (100 = vanilla).
const AMBIENT_PERCENT = { smooth: 25, balanced: 50, quality: 100 };
// Natural spawning caps by quality preset (100 = vanilla). Vanilla's caps assume mobs spread over
// 17x17 chunks; these keep that density within the preset's simulation distance (5, 6, 8).
const MOB_CAP_PERCENT = { smooth: 40, balanced: 60, quality: 100 };

// 1.13+: Mojang's own LWJGL 3 jars, with their native libraries implemented in JavaScript
// (public/lwjgl3: GLFW or SDL 3 on this canvas, OpenGL on WebGL 2).
function configureLwjgl3(lwjgl3, plan, init, initialSize) {
  let size = initialSize;
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  $('viewport').appendChild(canvas);
  const backend = lwjgl3.createLwjglBackend({
    canvas,
    getRenderSize: () => size,
    onTitle: (title) => { document.title = `${title} — 網頁版`; },
    // The game's own fullscreen option maps to the page's fullscreen.
    onFullscreen: (on) => {
      if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen();
    },
    debug: params.get('gldebug') === '1',
    traceNatives: params.get('nativetrace') === '1',
    ...(params.has('renderslice') ? { renderSlice: Number(params.get('renderslice')) } : {}),
    // e.g. lwjgl-3.4.3.jar -> 3.4
    lwjglVersion: Number(/\/lwjgl-(\d+\.\d+)\.\d+\.jar$/.exec(plan.systemClasspath.find((p) => /\/lwjgl-\d/.test(p)) || '')?.[1] || 3.3),
  });
  window.webmc.lwjgl3 = backend;
  init.enableX11 = false;
  init.natives = backend.natives;
  init.javaProperties.push(
    'java.library.path=/app/lwjgl3/libs/',
    'org.lwjgl.system.allocator=webmc.lwjgl.HeapAllocator',
    'webmc.lwjgl3=true',
    // The game is loaded by webmc.GameClassLoader (not the JVM classpath), which adapts classes
    // in memory: Java 21 builds are downgraded to the runtime's Java 17. LWJGL stays on the
    // JVM classpath (see systemClasspath in server/mojang.js).
    `webmc.gameClasspath=${plan.classpath.filter((p) => !plan.systemClasspath.includes(p)).join(':')}`,
    `webmc.downgrade=${!!plan.downgrade}`,
    // All Java threads take turns on the browser's main thread, so every extra background
    // worker (1.18+ sizes the pool from the CPU count) takes time away from the render thread.
    `max.bg.threads=${Number(params.get('bgthreads')) || 1}`,
    // Share of the ambient block animations (torch flames, drips...) sampled per client tick.
    `webmc.ambientPercent=${params.has('ambient') ? Number(params.get('ambient')) : AMBIENT_PERCENT[settings.preset] ?? 100}`,
    `webmc.mobCapPercent=${params.has('mobcap') ? Number(params.get('mobcap')) : MOB_CAP_PERCENT[settings.preset] ?? 100}`,
    // Client ticks per frame when the game falls behind (vanilla: up to 10). One keeps frames
    // short; the game runs slower instead.
    `webmc.catchUpTicks=${Number(params.get('catchup')) || 1}`,
    // The game's background executor as a plain queue instead of a ForkJoinPool (whose
    // work-stealing stops the browser JVM while 26.x prepares a new world).
    `webmc.workerPool=${params.has('workerpool') ? params.get('workerpool') === '1' : plan.windowSystem === 'sdl'}`,
    // Local variable and line number tables only serve debuggers (CheerpJ's stack traces show no
    // line numbers anyway). Dropping them keeps the browser JVM's class heap (256 MiB at most)
    // from filling up (?debuginfo=keep|lines|none).
    `webmc.debugInfo=${params.get('debuginfo') || 'none'}`,
  );
  if (params.get('lwjgldebug') === '1') init.javaProperties.push('org.lwjgl.util.Debug=true', 'org.lwjgl.util.DebugLoader=true');
  if (params.get('classtrace') === '1') init.javaProperties.push('webmc.traceClasses=true');
  // ?gamestate=1 (26.x): prints loaded chunks, terrain sections and the player position every 10 s.
  if (params.get('gamestate') === '1') init.javaProperties.push('webmc.gameState=true');
  // Troubleshooting: ?slice=<ms> sets how long other threads run before giving way to the render
  // thread (webmc.jdk.Sched; default 4).
  if (params.has('slice')) init.javaProperties.push(`webmc.sliceMillis=${Number(params.get('slice')) || 4}`);
  // ?noslices=a/,b/ (experiment): classes under these packages get no yield points.
  if (params.has('noslices')) init.javaProperties.push(`webmc.timeSlicesSkip=${params.get('noslices')}`);
  return {
    show() {
      fitViewport(size);
      // The page follows the window at once; the game gets the new size when resizing settles.
      let timer;
      window.addEventListener('resize', () => {
        fitViewport(size);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const next = computeRenderSize({ awt: false });
          if (next.width === size.width && next.height === size.height) return;
          size = next;
          fitViewport(size);
          if (backend.display.isCreated()) backend.display.resize(size.width, size.height);
        }, 200);
      });
    },
  };
}

async function main() {
  captureConsole();
  $('restart').addEventListener('click', () => location.reload());
  $('hud-log').addEventListener('click', toggleConsole);
  $('java-console-close').addEventListener('click', toggleConsole);
  $('hud-fullscreen').addEventListener('click', toggleFullscreen);
  // F11 toggles browser fullscreen; LWJGL's own fullscreen mode has no meaning in a page.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'F11' && !event.repeat) toggleFullscreen();
  }, true);

  if (!versionId) return fail('沒有指定遊戲版本', '請從啟動器選擇要遊玩的版本。');
  document.title = `Minecraft ${versionId} — 網頁版`;

  try {
    setStatus('確認帳號…');
    const me = await fetchJson('/api/me');
    const offline = !me.signedIn && me.devOffline;
    if (!offline && !(me.signedIn && me.owned)) {
      return fail('需要登入', '請先在啟動器使用擁有 Minecraft: Java 版的 Microsoft 帳號登入。');
    }
    const query = offline ? `?name=${encodeURIComponent(settings.offlineName || 'Player')}` : '';

    setStatus(`讀取 ${versionId} 版本資訊…`, '來源：Mojang 官方版本清單 (piston-meta.mojang.com)');
    const plan = await fetchJson(`/api/versions/${encodeURIComponent(versionId)}/plan${query}`);
    if (plan.problems.length) return fail('這個版本無法在瀏覽器中執行', plan.problems.join('\n'));

    setStatus('下載遊戲檔案…', '由 Mojang 官方伺服器下載並以 SHA-1 驗證');
    setProgress(0, '');
    const prepared = await prepareFiles(query);

    setStatus('啟動 Java 虛擬機器…', 'CheerpJ（WebAssembly JVM）首次啟動需要下載執行環境');
    setProgress(0, '');
    const lwjgl3 = plan.mode === 'lwjgl3' ? await import('../lwjgl3/index.js') : null;
    // The LWJGL 3 natives work on the JVM's native heap, a WebAssembly memory that is only
    // reachable by observing its creation, so this must run before the runtime loads.
    // ?cjheap=<MiB> (experimental) lets CheerpJ's class heap grow past its usual 256 MiB.
    lwjgl3?.installMemoryCapture({ runtimeHeapPages: Math.min(16383, Math.round(Number(params.get('cjheap')) * 16) || 0) });
    await loadScript(`https://cjrtnc.leaningtech.com/${me.cheerpj.version}/loader.js`);
    const size = computeRenderSize({ awt: !lwjgl3 });
    const init = {
      version: plan.javaVersion,
      status: 'none',
      javaProperties: commonProperties(prepared),
      preloadProgress: (done, total) => setProgress(total ? done / total : 0, `執行環境 ${done} / ${total}`),
    };
    const display = lwjgl3 ? configureLwjgl3(lwjgl3, plan, init, size) : configureLwjgl2(plan, init, size);
    if (plan.javaVersion === 8) init.preloadResources = JAVA8_PRELOAD;
    if (params.get('debug') === '1') init.enableDebug = true;
    if (me.cheerpj.licenseKey) init.licenseKey = me.cheerpj.licenseKey;
    await cheerpjInit(init);
    if (!fixDirectoryRenames()) console.warn('[launcher] CheerpJ directory rename fix not installed');
    keepOpenFilesSaved();

    await applyLaunchOptions(plan);
    display.show();

    const args = [...plan.args];
    if (plan.supportsWindowArgs) args.push('--width', String(size.width), '--height', String(size.height));

    setStatus(`啟動 Minecraft ${plan.id}…`, `玩家：${plan.player.name}`);
    setProgress(null);
    showOverlay(false);
    $('hud').hidden = false;
    $('hud-version').textContent = `${plan.id} · ${plan.player.name}${plan.player.kind === 'offline' ? '（開發離線模式）' : ''}`;
    running = true;
    if (plan.mode === 'modern') {
      keepWorldIcons(plan.gameDir).catch((error) => console.warn('[launcher] world icon keeper stopped:', error));
    }

    // LWJGL 3.1 - 3.2 (1.13 - 1.16.5): classes adapted in memory go first (see lwjgl3/legacy.js).
    const fixes = [];
    const legacyLwjgl = lwjgl3 && plan.systemClasspath.find((p) => /\/lwjgl-3\.[12]\.\d+\.jar$/.test(p));
    if (legacyLwjgl) {
      const jar = await lwjgl3.legacyLwjglFix(legacyLwjgl.replace(/^\/app/, ''));
      if (jar) {
        cheerpOSAddStringFile('/str/webmc-lwjgl-fix.jar', jar);
        fixes.push('/str/webmc-lwjgl-fix.jar');
      }
    }
    const classpath = [BOOTSTRAP_JAR, ...fixes, ...(lwjgl3 ? plan.systemClasspath : plan.classpath)].join(':');
    const exitCode = await cheerpjRunMain(BOOTSTRAP_MAIN, classpath, plan.mainClass, ...args);
    fail(exitCode === 0 ? '遊戲已結束' : `遊戲結束（代碼 ${exitCode}）`, '世界存檔保存在此瀏覽器中，下次啟動會繼續。');
  } catch (error) {
    console.error(error);
    fail('啟動失敗', error.message);
  }
}

window.addEventListener('beforeunload', (event) => {
  if (!running) return;
  event.preventDefault();
  event.returnValue = '';
});

main();
