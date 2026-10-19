// LWJGL 3 for the browser: JavaScript implementations of LWJGL's native libraries
// (core, GLFW or SDL 3, OpenGL -> WebGL 2, stb_image, shaderc/SPIRV-Cross), registered as CheerpJ
// natives.
import { installMemoryCapture, bindHeap, addBlock, setBlockProvider, ptr } from './heap.js';
import { coreNatives, jniName } from './core.js';
import { createGL } from './gl.js';
import { createGLFW } from './glfw.js';
import { createSDL } from './sdl.js';
import { defineShaderTools, shaderNatives } from './spirv.js';
import { stbNatives } from './stb.js';
import { defineOpenAL } from './openal.js';
import { LWJGL_NATIVES } from './generated/natives.js';
import { functionName, defineLibrary } from './registry.js';

export { installMemoryCapture };
export { legacyLwjglFix } from './legacy.js';

export function createLwjglBackend({ canvas, getRenderSize, onFullscreen, onTitle, debug = false, traceNatives = false, renderSlice = 16, lwjglVersion = 3.3 }) {
  const gl = createGL({ debug });
  const glfw = createGLFW({ gl, canvas, getRenderSize, onFullscreen, onTitle });
  const sdl = createSDL({ gl, canvas, getRenderSize, onFullscreen, onTitle });
  defineOpenAL();
  defineShaderTools();
  // 26.x load FreeType at startup, but only TrueType fonts from resource packs use it.
  defineLibrary('freetype', { aliases: ['libfreetype.so', 'libfreetype.so.6'], impls: {}, lenient: true });
  // 1.13 - 1.21 open their window with GLFW, 26.x with SDL 3.
  const display = () => (sdl.isCreated() ? sdl : glfw);

  // One lookup only: CheerpJ refuses a second call into Java while one is running.
  let bridge = null;
  const bridgeClass = (lib) => (bridge ??= lib.webmc.lwjgl.Bridge);

  const natives = {};
  // Every LWJGL native gets an entry, so a missing implementation produces a clear message.
  const warned = new Set();
  for (const [className, methods] of Object.entries(LWJGL_NATIVES)) {
    for (const method of methods) {
      natives[jniName(className, method)] = () => {
        const key = `${className}.${method}`;
        if (!warned.has(key)) {
          warned.add(key);
          console.warn(`[lwjgl-web] native not implemented: ${key.replace(/\//g, '.')}`);
        }
        return 0;
      };
    }
  }
  Object.assign(natives, coreNatives({ bridgeClass, lwjglVersion }), gl.natives(), stbNatives(), shaderNatives());

  // webmc.lwjgl.Bridge.init: identifies the heap and hands over the first memory block.
  natives.Java_webmc_lwjgl_Bridge_init = (lib, arena, size, magic0, magic1) => {
    if (!bindHeap(ptr(arena), magic0, magic1)) return 0;
    addBlock(ptr(arena) + 16, size - 16);
    return 1;
  };
  // More memory comes from Bridge's "webmc-native-heap" thread, which waits in
  // waitForBlockRequest; JavaScript never has to call into Java for it.
  const requests = [];
  let providerWaiting = null;
  natives.Java_webmc_lwjgl_Bridge_waitForBlockRequest = () => new Promise((resolve) => {
    if (requests.length) resolve(requests[0].size);
    else providerWaiting = resolve;
  });
  natives.Java_webmc_lwjgl_Bridge_blockAllocated = (lib, address) => {
    const request = requests.shift();
    if (request) request.resolve(ptr(address));
  };
  setBlockProvider((bytes) => new Promise((resolve) => {
    requests.push({ size: bytes, resolve });
    if (providerWaiting && requests.length === 1) {
      const wake = providerWaiting;
      providerWaiting = null;
      wake(bytes);
    }
  }));
  // webmc.jdk.Sched (cooperative time slicing): background threads suspend until the browser has
  // had a turn while the render thread waits for it, so animation frames and timers can fire.
  const channel = new MessageChannel();
  const turns = [];
  channel.port1.onmessage = () => { for (const resolve of turns.splice(0)) resolve(); };
  natives.Java_webmc_jdk_Sched_renderState = () => display().renderState();
  natives.Java_webmc_jdk_Sched_breathe = () => new Promise((resolve) => {
    turns.push(resolve);
    if (turns.length === 1) channel.port2.postMessage(0);
  });
  // Background threads step aside while the render thread works on a frame, but only for
  // renderSlice ms at a time: then they run one slice, which keeps the integrated server at
  // roughly a fifth of the time even while frames are slow (and covers the render thread
  // waiting for one of them: a lock, a future).
  natives.Java_webmc_jdk_Sched_awaitRender = () => display().untilRenderWaits(renderSlice);
  // Java 17: CheerpJ cannot load JNI libraries itself; the stub library files are accepted here
  // and the natives above are already registered.
  natives.Java_jdk_internal_loader_NativeLibraries_load = () => true;

  // Troubleshooting (?nativetrace=1): logs native calls, all of the first few thousand and then a
  // sample, to find where startup stops.
  if (traceNatives) {
    let calls = 0;
    for (const [name, impl] of Object.entries(natives)) {
      natives[name] = function traced(...args) {
        calls++;
        if (calls < 3000 || calls % 5000 === 0) {
          // JNI.invoke*/call*: the function pointer is the last argument.
          const target = name.includes('_system_JNI_') ? ` -> ${functionName(args[args.length - 1])}` : '';
          console.log(`[lwjgl-web] native #${calls} ${name.replace(/^Java_org_lwjgl_/, '')}${target}`);
        }
        return impl.apply(this, args);
      };
    }
  }

  return {
    natives, gl, glfw, sdl,
    /** The window system the game uses (resize, frame statistics). */
    get display() { return display(); },
  };
}
