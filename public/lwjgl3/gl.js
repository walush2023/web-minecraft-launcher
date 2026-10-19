// OpenGL (as used through LWJGL 3) implemented on WebGL 2.
//
// Every GL entry point is a plain function on `GL`. They are exposed twice:
//  * as LWJGL JNI natives (e.g. org.lwjgl.opengl.GL11C.glEnable, GL15C.nglBufferData), and
//  * as function pointers returned by glXGetProcAddress (used by GL.createCapabilities).
// Pointer arguments are addresses in the CheerpJ heap (BigInt) or, for LWJGL's array
// overloads, Java arrays (typed arrays).
import { sync, ptr, U8, U16, I32, U32, F32, malloc, mallocAsync, free, readCString, readUtf8, cstring, writeCStringAt } from './heap.js';
import { definer } from './core.js';
import { translateGLSL, uniformDefaultValues, esIdentifier, BUFFER_TEXTURE_WIDTH } from './glsl.js';
import { installFixedFunction } from './ffp.js';
import { defineFunction, defineLibrary } from './registry.js';
import { LWJGL_NATIVES } from './generated/natives.js';

const GLC = {
  NO_ERROR: 0, TEXTURE_2D: 0x0de1, PROXY_TEXTURE_2D: 0x8064, TEXTURE_WIDTH: 0x1000, TEXTURE_HEIGHT: 0x1001,
  TEXTURE_INTERNAL_FORMAT: 0x1003, FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9,
  RENDERBUFFER: 0x8d41, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00, BACK: 0x0405, FRONT: 0x0404,
  FRONT_AND_BACK: 0x0408, NONE: 0, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, PIXEL_PACK_BUFFER: 0x88eb,
  PIXEL_UNPACK_BUFFER: 0x88ec, UNIFORM_BUFFER: 0x8a11, COPY_READ_BUFFER: 0x8f36, COPY_WRITE_BUFFER: 0x8f37,
  RGBA: 0x1908, RGB: 0x1907, RED: 0x1903, RG: 0x8227, BGRA: 0x80e1, BGR: 0x80e0, ALPHA: 0x1906, LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a, DEPTH_COMPONENT: 0x1902, DEPTH_STENCIL: 0x84f9, R8: 0x8229, RG8: 0x822b,
  RGB8: 0x8051, RGBA8: 0x8058, DEPTH_COMPONENT16: 0x81a5, DEPTH_COMPONENT24: 0x81a6, DEPTH_COMPONENT32: 0x81a7,
  DEPTH_COMPONENT32F: 0x8cac, DEPTH24_STENCIL8: 0x88f0, UNSIGNED_BYTE: 0x1401, BYTE: 0x1400, UNSIGNED_SHORT: 0x1403,
  SHORT: 0x1402, UNSIGNED_INT: 0x1405, INT: 0x1404, FLOAT: 0x1406, HALF_FLOAT: 0x140b, UNSIGNED_INT_24_8: 0x84fa,
  UNSIGNED_INT_8_8_8_8_REV: 0x8367, UNSIGNED_INT_8_8_8_8: 0x8035,
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  INFO_LOG_LENGTH: 0x8b84, SHADER_SOURCE_LENGTH: 0x8b88, VALIDATE_STATUS: 0x8b83, DELETE_STATUS: 0x8b80,
  ATTACHED_SHADERS: 0x8b85, ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89, SHADER_TYPE: 0x8b4f,
  VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, EXTENSIONS: 0x1f03, SHADING_LANGUAGE_VERSION: 0x8b8c,
  MAJOR_VERSION: 0x821b, MINOR_VERSION: 0x821c, NUM_EXTENSIONS: 0x821d, CONTEXT_FLAGS: 0x821e,
  CONTEXT_PROFILE_MASK: 0x9126, MAX_TEXTURE_SIZE: 0x0d33, VIEWPORT: 0x0ba2, TEXTURE_BINDING_2D: 0x8069,
  ACTIVE_TEXTURE: 0x84e0, CURRENT_PROGRAM: 0x8b8d, ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  VERTEX_ARRAY_BINDING: 0x85b5, FRAMEBUFFER_BINDING: 0x8ca6, READ_FRAMEBUFFER_BINDING: 0x8caa, RENDERBUFFER_BINDING: 0x8ca7,
  TEXTURE0: 0x84c0, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  TEXTURE_MAX_ANISOTROPY: 0x84fe, MAX_TEXTURE_MAX_ANISOTROPY: 0x84ff, TEXTURE_LOD_BIAS: 0x8501,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, CLAMP: 0x2900, CLAMP_TO_BORDER: 0x812d,
  CLAMP_TO_EDGE: 0x812f, TEXTURE_BORDER_COLOR: 0x1004, TEXTURE_SWIZZLE_R: 0x8e42, TEXTURE_SWIZZLE_A: 0x8e45,
  TEXTURE_SWIZZLE_RGBA: 0x8e46, DEPTH_TEXTURE_MODE: 0x884b, GENERATE_MIPMAP: 0x8191,
  MAP_READ_BIT: 0x0001, MAP_WRITE_BIT: 0x0002, READ_ONLY: 0x88b8, WRITE_ONLY: 0x88b9, READ_WRITE: 0x88ba,
  BUFFER_SIZE: 0x8764, FRAMEBUFFER_COMPLETE: 0x8cd5, COLOR_LOGIC_OP: 0x0bf2, POLYGON_OFFSET_LINE: 0x2a02,
  DEPTH_CLAMP: 0x864f, LINE_SMOOTH: 0x0b20, MULTISAMPLE: 0x809d, PROGRAM_POINT_SIZE: 0x8642, POINT_SMOOTH: 0x0b10,
  TEXTURE_CUBE_MAP_SEAMLESS: 0x884f, FRAMEBUFFER_SRGB: 0x8db9, PRIMITIVE_RESTART: 0x8f9d, POLYGON_SMOOTH: 0x0b41,
  CONTEXT_CORE_PROFILE_BIT: 1, CONTEXT_COMPATIBILITY_PROFILE_BIT: 2, CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT: 1,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a, CONDITION_SATISFIED: 0x911c, SYNC_STATUS: 0x9114,
  SIGNALED: 0x9119, QUADS: 0x0007, TEXTURE_BUFFER: 0x8c2a,
};

// Capabilities that desktop GL has and WebGL does not: ignored instead of raising errors.
const IGNORED_CAPS = new Set([
  GLC.COLOR_LOGIC_OP, GLC.POLYGON_OFFSET_LINE, GLC.DEPTH_CLAMP, GLC.LINE_SMOOTH, GLC.MULTISAMPLE,
  GLC.PROGRAM_POINT_SIZE, GLC.POINT_SMOOTH, GLC.TEXTURE_CUBE_MAP_SEAMLESS, GLC.FRAMEBUFFER_SRGB,
  GLC.PRIMITIVE_RESTART, GLC.POLYGON_SMOOTH, 0x0de1 /* TEXTURE_2D */, 0x0b50 /* LIGHTING */, 0x0bc0 /* ALPHA_TEST */,
  0x0b60 /* FOG */, 0x0b57 /* COLOR_MATERIAL */, 0x0ba1 /* NORMALIZE */, 0x803a /* RESCALE_NORMAL */,
  0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007 /* LIGHT0-7 */,
]);

export function createGL({ debug = false } = {}) {
  const S = {
    gl: null,
    canvas: null,
    profile: 'core',
    version: [3, 3],
    textures: new Map(),
    textureInfo: new Map(), // WebGLTexture -> { levels: Map(level -> {w, h, ifmt}) }
    buffers: new Map(),
    framebuffers: new Map(),
    renderbuffers: new Map(),
    vertexArrays: new Map(),
    programs: new Map(),
    shaders: new Map(),
    samplers: new Map(),
    syncs: new Map(),
    uniforms: new Map(), // location id -> WebGLUniformLocation
    programUniforms: new Map(), // program name -> Map(name -> location id)
    nextName: 1,
    nextUniform: 1,
    activeUnit: 0,
    boundTextures: [], // per unit: target -> name
    bound: { [GLC.ARRAY_BUFFER]: 0, [GLC.ELEMENT_ARRAY_BUFFER]: 0 },
    colorMask: [true, true, true, true], // as set through glColorMask (see present)
    drawFramebuffer: 0,
    readFramebuffer: 0,
    renderbuffer: 0,
    program: 0,
    vertexArray: 0,
    proxy: { width: 0, height: 0 },
    mapped: new Map(), // buffer name -> { address, offset, length, write }
    backbuffer: null,
    extensions: [],
    anisotropic: null,
    maxAnisotropy: 1,
    renderer: 'WebGL 2',
    warned: new Set(),
    lastError: 0,
    bufferTextures: new Map(), // texture name -> { buffer, ifmt, offset, size, version }
    bufferTextureUnits: new Map(), // unit -> texture name bound to GL_TEXTURE_BUFFER
    bufferVersions: new Map(), // buffer name -> change counter
  };
  const name = () => S.nextName++;
  const warnOnce = (key, message) => {
    if (!S.warned.has(key)) {
      S.warned.add(key);
      console.warn(`[lwjgl-web] ${message}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Context, default framebuffer and presentation
  // ---------------------------------------------------------------------------
  function attach(canvas, { profile = 'core' } = {}) {
    S.canvas = canvas;
    S.profile = profile;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true,
    });
    if (!gl) throw new Error('WebGL 2 is not available in this browser');
    S.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    S.anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
    if (S.anisotropic) S.maxAnisotropy = gl.getParameter(S.anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) S.renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    S.extensions = ['GL_ARB_vertex_array_object', 'GL_ARB_framebuffer_object', 'GL_ARB_vertex_buffer_object',
      'GL_ARB_shader_objects', 'GL_ARB_texture_non_power_of_two', 'GL_ARB_multitexture', 'GL_EXT_blend_func_separate',
      'GL_ARB_copy_buffer', 'GL_ARB_uniform_buffer_object', 'GL_ARB_instanced_arrays', 'GL_ARB_sync'];
    if (S.anisotropic) S.extensions.push('GL_EXT_texture_filter_anisotropic', 'GL_ARB_texture_filter_anisotropic');
    resizeBackbuffer(canvas.width, canvas.height);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return gl;
  }

  // The default framebuffer is emulated by an offscreen one so that the canvas only ever
  // receives complete frames (CheerpJ may yield to the browser in the middle of a frame).
  function resizeBackbuffer(width, height) {
    const gl = S.gl;
    const old = S.backbuffer;
    const fbo = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    S.backbuffer = { fbo, color, depth, width, height };
    if (old) {
      gl.deleteFramebuffer(old.fbo);
      gl.deleteRenderbuffer(old.color);
      gl.deleteRenderbuffer(old.depth);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, S.renderbuffers.get(S.renderbuffer) || null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbOf(S.drawFramebuffer));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbOf(S.readFramebuffer));
  }

  function fbOf(n) {
    return n === 0 ? S.backbuffer.fbo : S.framebuffers.get(n) || null;
  }

  /** Copies the emulated default framebuffer to the canvas. */
  function present() {
    const gl = S.gl;
    const b = S.backbuffer;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    // The game's mask as last set (asking WebGL for COLOR_WRITEMASK waits for the GPU process).
    const mask = S.colorMask;
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, b.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, b.width, b.height, 0, 0, S.canvas.width, S.canvas.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbOf(S.drawFramebuffer));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbOf(S.readFramebuffer));
    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
  }

  // ---------------------------------------------------------------------------
  // Helpers for pointers / arrays
  // ---------------------------------------------------------------------------
  const isView = (v) => ArrayBuffer.isView(v);
  const asBytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  function readInts(src, count) {
    if (isView(src)) return Array.from(src.subarray ? src.subarray(0, count) : src);
    sync();
    const p = ptr(src) >> 2;
    return Array.from(I32.subarray(p, p + count));
  }
  function writeInts(dst, values) {
    if (isView(dst)) {
      for (let i = 0; i < values.length && i < dst.length; i++) dst[i] = values[i];
      return;
    }
    const p = ptr(dst);
    if (!p) return;
    sync();
    for (let i = 0; i < values.length; i++) I32[(p >> 2) + i] = values[i];
  }
  function writeFloats(dst, values) {
    if (isView(dst)) {
      for (let i = 0; i < values.length && i < dst.length; i++) dst[i] = values[i];
      return;
    }
    const p = ptr(dst);
    if (!p) return;
    sync();
    for (let i = 0; i < values.length; i++) F32[(p >> 2) + i] = values[i];
  }
  function floatView(src, count) {
    if (isView(src)) return src instanceof Float32Array ? src.subarray(0, count) : new Float32Array(src.buffer, src.byteOffset, count);
    sync();
    const p = ptr(src) >> 2;
    return F32.subarray(p, p + count);
  }
  function intView(src, count) {
    if (isView(src)) return src instanceof Int32Array ? src.subarray(0, count) : new Int32Array(src.buffer, src.byteOffset, count);
    sync();
    const p = ptr(src) >> 2;
    return I32.subarray(p, p + count);
  }
  /** Bytes at a heap address (or a Java array) for upload. */
  function bytesAt(src, length) {
    if (isView(src)) return asBytes(src).subarray(0, length);
    sync();
    const p = ptr(src);
    return U8.subarray(p, p + length);
  }

  /** Typed view of pixel data matching a GL type, starting at a heap address or Java array. */
  function pixelSource(pixels, type) {
    if (pixels === null || pixels === undefined) return null;
    if (isView(pixels)) {
      const b = pixels;
      switch (type) {
        case GLC.FLOAT: return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
        case GLC.UNSIGNED_SHORT: case GLC.HALF_FLOAT: return new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
        case GLC.UNSIGNED_INT: case GLC.UNSIGNED_INT_24_8: return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
        default: return asBytes(b);
      }
    }
    const p = ptr(pixels);
    if (!p) return null;
    sync();
    switch (type) {
      case GLC.FLOAT: return { view: F32, offset: p >> 2 };
      case GLC.UNSIGNED_SHORT: case GLC.HALF_FLOAT: return { view: U16, offset: p >> 1 };
      case GLC.UNSIGNED_INT: case GLC.UNSIGNED_INT_24_8: return { view: U32, offset: p >> 2 };
      default: return { view: U8, offset: p };
    }
  }

  // Desktop GL formats -> WebGL 2 (internalformat, format, type) triples.
  function textureFormat(internalformat, format, type) {
    let ifmt = internalformat;
    let fmt = format;
    let ty = type;
    if (fmt === GLC.BGRA) fmt = GLC.RGBA;
    if (fmt === GLC.BGR) fmt = GLC.RGB;
    if (ty === GLC.UNSIGNED_INT_8_8_8_8_REV || ty === GLC.UNSIGNED_INT_8_8_8_8) ty = GLC.UNSIGNED_BYTE;
    switch (ifmt) {
      case GLC.RED: case 1: ifmt = GLC.R8; break;
      case GLC.RG: case 2: ifmt = GLC.RG8; break;
      case 3: ifmt = GLC.RGB; break;
      case 4: ifmt = GLC.RGBA; break;
      case GLC.DEPTH_COMPONENT:
      case GLC.DEPTH_COMPONENT32:
        if (ty === GLC.FLOAT) ifmt = GLC.DEPTH_COMPONENT32F;
        else if (ty === GLC.UNSIGNED_SHORT) ifmt = GLC.DEPTH_COMPONENT16;
        else { ifmt = GLC.DEPTH_COMPONENT24; ty = GLC.UNSIGNED_INT; }
        break;
      case GLC.DEPTH_COMPONENT24: ty = GLC.UNSIGNED_INT; break;
      case GLC.DEPTH_COMPONENT32F: ty = GLC.FLOAT; break;
      case GLC.DEPTH_COMPONENT16: if (ty !== GLC.UNSIGNED_SHORT) ty = GLC.UNSIGNED_INT; break;
      case GLC.DEPTH_STENCIL: ifmt = GLC.DEPTH24_STENCIL8; ty = GLC.UNSIGNED_INT_24_8; break;
      default: break;
    }
    if (ifmt === GLC.DEPTH24_STENCIL8) fmt = GLC.DEPTH_STENCIL;
    // Unsized RGBA/RGB textures must be uploaded with exactly that format.
    if (ifmt === GLC.RGBA && fmt !== GLC.RGBA) ifmt = GLC.RGBA8;
    if (ifmt === GLC.RGB && fmt !== GLC.RGB) ifmt = GLC.RGB8;
    return [ifmt, fmt, ty];
  }

  const texTarget = (target) => (target === GLC.PROXY_TEXTURE_2D ? GLC.TEXTURE_2D : target);
  function boundTexture(target) {
    const unit = S.boundTextures[S.activeUnit];
    return unit ? unit[target] || 0 : 0;
  }
  function recordLevel(target, level, width, height, ifmt) {
    const n = boundTexture(target);
    const tex = S.textures.get(n);
    if (!tex) return;
    let info = S.textureInfo.get(tex);
    if (!info) S.textureInfo.set(tex, (info = { levels: new Map() }));
    info.levels.set(level, { width, height, ifmt });
  }

  // Convert pixel rows whose format differs from the texture's (e.g. RED data into RGBA).
  function expandToRGBA(src, width, height, channels) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
      const o = i * 4;
      if (channels === 1) { out[o] = src[j]; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255; }
      else if (channels === 2) { out[o] = src[j]; out[o + 1] = src[j + 1]; out[o + 2] = 0; out[o + 3] = 255; }
      else { out[o] = src[j]; out[o + 1] = src[j + 1]; out[o + 2] = src[j + 2]; out[o + 3] = 255; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // GL entry points
  // ---------------------------------------------------------------------------
  const GL = {};
  const gl = () => S.gl;

  // State
  GL.glEnable = (cap) => (IGNORED_CAPS.has(cap) ? undefined : gl().enable(cap));
  GL.glDisable = (cap) => (IGNORED_CAPS.has(cap) ? undefined : gl().disable(cap));
  GL.glIsEnabled = (cap) => (IGNORED_CAPS.has(cap) ? false : gl().isEnabled(cap));
  GL.glBlendFunc = (s, d) => gl().blendFunc(s, d);
  GL.glBlendFuncSeparate = (a, b, c, d) => gl().blendFuncSeparate(a, b, c, d);
  GL.glBlendEquation = (m) => gl().blendEquation(m);
  GL.glBlendEquationSeparate = (a, b) => gl().blendEquationSeparate(a, b);
  GL.glBlendColor = (r, g, b, a) => gl().blendColor(r, g, b, a);
  GL.glDepthFunc = (f) => gl().depthFunc(f);
  GL.glDepthMask = (m) => gl().depthMask(!!m);
  GL.glDepthRange = (n, f) => gl().depthRange(n, f);
  GL.glDepthRangef = GL.glDepthRange;
  GL.glClearDepth = (d) => gl().clearDepth(d);
  GL.glClearDepthf = GL.glClearDepth;
  GL.glClearColor = (r, g, b, a) => gl().clearColor(r, g, b, a);
  GL.glClearStencil = (s) => gl().clearStencil(s);
  GL.glClear = (mask) => gl().clear(mask & 0x4500);
  GL.glColorMask = (r, g, b, a) => {
    S.colorMask = [!!r, !!g, !!b, !!a];
    gl().colorMask(!!r, !!g, !!b, !!a);
  };
  // Per draw buffer state (GL 3.0); WebGL 2 needs OES_draw_buffers_indexed for buffers past the first.
  const indexed = () => (S.drawBuffersIndexed ??= gl().getExtension('OES_draw_buffers_indexed') || false);
  GL.glColorMaski = (index, r, g, b, a) => {
    if (index === 0) S.colorMask = [!!r, !!g, !!b, !!a];
    if (indexed()) indexed().colorMaskiOES(index, !!r, !!g, !!b, !!a);
    else if (index === 0) gl().colorMask(!!r, !!g, !!b, !!a);
  };
  GL.glEnablei = (cap, index) => {
    if (IGNORED_CAPS.has(cap)) return;
    if (indexed()) indexed().enableiOES(cap, index);
    else if (index === 0) gl().enable(cap);
  };
  GL.glDisablei = (cap, index) => {
    if (IGNORED_CAPS.has(cap)) return;
    if (indexed()) indexed().disableiOES(cap, index);
    else if (index === 0) gl().disable(cap);
  };
  GL.glIsEnabledi = (cap, index) => (IGNORED_CAPS.has(cap) ? false : indexed() ? indexed().isEnablediOES(cap, index) : gl().isEnabled(cap));
  GL.glStencilFunc = (f, r, m) => gl().stencilFunc(f, r, m);
  GL.glStencilFuncSeparate = (face, f, r, m) => gl().stencilFuncSeparate(face, f, r, m);
  GL.glStencilOp = (a, b, c) => gl().stencilOp(a, b, c);
  GL.glStencilOpSeparate = (face, a, b, c) => gl().stencilOpSeparate(face, a, b, c);
  GL.glStencilMask = (m) => gl().stencilMask(m);
  GL.glStencilMaskSeparate = (face, m) => gl().stencilMaskSeparate(face, m);
  GL.glCullFace = (m) => gl().cullFace(m);
  GL.glFrontFace = (m) => gl().frontFace(m);
  GL.glPolygonOffset = (f, u) => gl().polygonOffset(f, u);
  GL.glPolygonMode = () => undefined;
  GL.glLineWidth = (w) => gl().lineWidth(Math.max(1, Math.min(w, 1)));
  GL.glPointSize = () => undefined;
  GL.glScissor = (x, y, w, h) => gl().scissor(x, y, w, h);
  GL.glViewport = (x, y, w, h) => gl().viewport(x, y, w, h);
  GL.glHint = () => undefined;
  GL.glLogicOp = () => warnOnce('logicop', 'glLogicOp is not supported by WebGL; ignored');
  GL.glPixelStorei = (pname, param) => {
    if (pname === 0x0cf0 || pname === 0x0cf1 || pname === 0x0d00 /* swap/lsb/unpack_swap */) return;
    if (pname === 0x0d01 /* PACK_SWAP? */) return;
    gl().pixelStorei(pname, param);
  };
  GL.glPixelStoref = (pname, param) => GL.glPixelStorei(pname, Math.round(param));
  GL.glFinish = () => gl().finish();
  GL.glFlush = () => gl().flush();
  GL.glGetError = () => (debug ? gl().getError() : 0);
  GL.glSampleCoverage = (v, i) => gl().sampleCoverage(v, !!i);

  // Textures
  GL.glGenTextures = (n, out) => {
    if (isView(n)) { // glGenTextures(int[])
      for (let i = 0; i < n.length; i++) { const id = name(); S.textures.set(id, gl().createTexture()); n[i] = id; }
      return;
    }
    if (out === undefined) { // glGenTextures() returning one name
      const id = name();
      S.textures.set(id, gl().createTexture());
      return id;
    }
    const ids = [];
    for (let i = 0; i < n; i++) { const id = name(); S.textures.set(id, gl().createTexture()); ids.push(id); }
    writeInts(out, ids);
  };
  GL.glDeleteTextures = (n, list) => {
    const ids = isView(n) ? Array.from(n) : list === undefined ? [n] : readInts(list, n);
    for (const id of ids) {
      const tex = S.textures.get(id);
      if (tex) { gl().deleteTexture(tex); S.textures.delete(id); S.textureInfo.delete(tex); }
      for (const unit of S.boundTextures) if (unit) for (const t of Object.keys(unit)) if (unit[t] === id) unit[t] = 0;
    }
  };
  GL.glIsTexture = (id) => S.textures.has(id);
  GL.glActiveTexture = (unit) => {
    S.activeUnit = unit - GLC.TEXTURE0;
    gl().activeTexture(unit);
  };
  GL.glBindTexture = (target, id) => {
    if (!S.boundTextures[S.activeUnit]) S.boundTextures[S.activeUnit] = {};
    S.boundTextures[S.activeUnit][target] = id;
    if (target === GLC.TEXTURE_BUFFER) {
      // Emulated with a 2D texture on the same unit (see glTexBuffer).
      if (id) S.bufferTextureUnits.set(S.activeUnit, id);
      else S.bufferTextureUnits.delete(S.activeUnit);
      gl().bindTexture(GLC.TEXTURE_2D, S.textures.get(id) || null);
      return;
    }
    gl().bindTexture(target, S.textures.get(id) || null);
  };

  // Buffer textures (1.21.6+ clouds): WebGL 2 has none, so the buffer's contents are copied into
  // a 2D texture BUFFER_TEXTURE_WIDTH texels wide whenever the buffer has changed; translated
  // shaders address it with webmc_bufferCoord (glsl.js).
  const BUFFER_TEXTURE_FORMATS = {
    0x8229: [GLC.RED, GLC.UNSIGNED_BYTE, 1, Uint8Array], // R8
    0x822e: [GLC.RED, GLC.FLOAT, 4, Float32Array], // R32F
    0x8231: [0x8d94, GLC.BYTE, 1, Int8Array], // R8I
    0x8232: [0x8d94, GLC.UNSIGNED_BYTE, 1, Uint8Array], // R8UI
    0x8233: [0x8d94, GLC.SHORT, 2, Int16Array], // R16I
    0x8234: [0x8d94, GLC.UNSIGNED_SHORT, 2, Uint16Array], // R16UI
    0x8235: [0x8d94, GLC.INT, 4, Int32Array], // R32I
    0x8236: [0x8d94, GLC.UNSIGNED_INT, 4, Uint32Array], // R32UI
    0x822b: [GLC.RG, GLC.UNSIGNED_BYTE, 2, Uint8Array], // RG8
    0x8230: [GLC.RG, GLC.FLOAT, 8, Float32Array], // RG32F
    0x823b: [0x8228, GLC.INT, 8, Int32Array], // RG32I
    0x823c: [0x8228, GLC.UNSIGNED_INT, 8, Uint32Array], // RG32UI
    0x8058: [GLC.RGBA, GLC.UNSIGNED_BYTE, 4, Uint8Array], // RGBA8
    0x8d8e: [0x8d99, GLC.BYTE, 4, Int8Array], // RGBA8I
    0x8d7c: [0x8d99, GLC.UNSIGNED_BYTE, 4, Uint8Array], // RGBA8UI
    0x8814: [GLC.RGBA, GLC.FLOAT, 16, Float32Array], // RGBA32F
    0x8d82: [0x8d99, GLC.INT, 16, Int32Array], // RGBA32I
    0x8d70: [0x8d99, GLC.UNSIGNED_INT, 16, Uint32Array], // RGBA32UI
    0x8815: [GLC.RGB, GLC.FLOAT, 12, Float32Array], // RGB32F
  };
  GL.glTexBufferRange = (target, ifmt, buffer, offset, size) => {
    const id = boundTexture(GLC.TEXTURE_BUFFER);
    if (!id) return;
    S.bufferTextures.set(id, { buffer, ifmt, offset: Number(offset), size: Number(size), version: -1 });
  };
  GL.glTexBuffer = (target, ifmt, buffer) => GL.glTexBufferRange(target, ifmt, buffer, 0, -1);
  const bumpBuffer = (id) => { if (id > 0) S.bufferVersions.set(id, (S.bufferVersions.get(id) || 0) + 1); };
  /** Re-uploads changed buffer textures bound for the next draw. */
  function syncBufferTextures() {
    if (!S.bufferTextureUnits.size) return;
    const g = gl();
    for (const [unit, id] of S.bufferTextureUnits) {
      const t = S.bufferTextures.get(id);
      if (!t) continue;
      const version = S.bufferVersions.get(t.buffer) || 0;
      if (t.version === version) continue;
      t.version = version;
      const format = BUFFER_TEXTURE_FORMATS[t.ifmt];
      if (!format) { warnOnce(`tbo-${t.ifmt}`, `buffer texture format 0x${t.ifmt.toString(16)} is not supported`); continue; }
      const [fmt, type, texelBytes, View] = format;
      const buffer = S.buffers.get(t.buffer);
      if (!buffer) continue;
      const contents = shadowOf(buffer); // the buffer's CPU copy (see shadows)
      const available = contents.length - t.offset;
      const bytes = Math.max(0, t.size >= 0 ? Math.min(t.size, available) : available);
      const texels = Math.floor(bytes / texelBytes);
      const width = Math.max(1, Math.min(BUFFER_TEXTURE_WIDTH, texels));
      const height = Math.max(1, Math.ceil(texels / BUFFER_TEXTURE_WIDTH));
      const data = new Uint8Array(width * height * texelBytes);
      if (texels) data.set(contents.subarray(t.offset, t.offset + texels * texelBytes));
      g.activeTexture(GLC.TEXTURE0 + unit);
      g.texImage2D(GLC.TEXTURE_2D, 0, t.ifmt, width, height, 0, fmt, type, new View(data.buffer));
      g.texParameteri(GLC.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(GLC.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.activeTexture(GLC.TEXTURE0 + S.activeUnit);
    }
  }
  S.syncBufferTextures = syncBufferTextures;
  GL.glTexImage2D = (target, level, internalformat, width, height, border, format, type, pixels) => {
    if (target === GLC.PROXY_TEXTURE_2D) {
      const max = gl().getParameter(gl().MAX_TEXTURE_SIZE);
      S.proxy = width <= max && height <= max ? { width, height } : { width: 0, height: 0 };
      return;
    }
    const [ifmt, fmt, ty] = textureFormat(internalformat, format, type);
    if (S.bound[GLC.PIXEL_UNPACK_BUFFER]) {
      // `pixels` is an offset into the bound pixel unpack buffer.
      gl().texImage2D(target, level, ifmt, width, height, 0, fmt, ty, Number(ptr(pixels)));
      recordLevel(target, level, width, height, ifmt);
      return;
    }
    const src = pixelSource(pixels, ty);
    if (!src) gl().texImage2D(target, level, ifmt, width, height, 0, fmt, ty, null);
    else if (src.view) gl().texImage2D(target, level, ifmt, width, height, 0, fmt, ty, src.view, src.offset);
    else gl().texImage2D(target, level, ifmt, width, height, 0, fmt, ty, src);
    recordLevel(target, level, width, height, ifmt);
  };
  GL.glTexSubImage2D = (target, level, x, y, width, height, format, type, pixels) => {
    const n = boundTexture(target);
    const info = S.textureInfo.get(S.textures.get(n));
    const lvl = info && info.levels.get(level);
    let [, fmt, ty] = textureFormat(lvl ? lvl.ifmt : GLC.RGBA8, format, type);
    if (S.bound[GLC.PIXEL_UNPACK_BUFFER]) {
      // 26.x stages texture data in a buffer: `pixels` is an offset into the bound pixel unpack buffer.
      gl().texSubImage2D(target, level, x, y, width, height, fmt, ty, Number(ptr(pixels)));
      return;
    }
    let src = pixelSource(pixels, ty);
    const targetIsRGBA = lvl && (lvl.ifmt === GLC.RGBA || lvl.ifmt === GLC.RGBA8);
    if (targetIsRGBA && fmt !== GLC.RGBA && ty === GLC.UNSIGNED_BYTE && src) {
      const channels = fmt === GLC.RED ? 1 : fmt === GLC.RG ? 2 : 3;
      const rowLength = gl().getParameter(gl().UNPACK_ROW_LENGTH) || width;
      const skipPixels = gl().getParameter(gl().UNPACK_SKIP_PIXELS);
      const skipRows = gl().getParameter(gl().UNPACK_SKIP_ROWS);
      const base = src.view ? src.offset : 0;
      const view = src.view || src;
      const packed = new Uint8Array(width * height * channels);
      for (let row = 0; row < height; row++) {
        const start = base + ((skipRows + row) * rowLength + skipPixels) * channels;
        packed.set(view.subarray(start, start + width * channels), row * width * channels);
      }
      gl().pixelStorei(gl().UNPACK_ROW_LENGTH, 0);
      gl().pixelStorei(gl().UNPACK_SKIP_PIXELS, 0);
      gl().pixelStorei(gl().UNPACK_SKIP_ROWS, 0);
      gl().texSubImage2D(target, level, x, y, width, height, GLC.RGBA, ty, expandToRGBA(packed, width, height, channels));
      gl().pixelStorei(gl().UNPACK_ROW_LENGTH, rowLength === width ? 0 : rowLength);
      gl().pixelStorei(gl().UNPACK_SKIP_PIXELS, skipPixels);
      gl().pixelStorei(gl().UNPACK_SKIP_ROWS, skipRows);
      return;
    }
    if (!src) return;
    if (src.view) gl().texSubImage2D(target, level, x, y, width, height, fmt, ty, src.view, src.offset);
    else gl().texSubImage2D(target, level, x, y, width, height, fmt, ty, src);
  };
  GL.glTexStorage2D = (target, levels, ifmt, w, h) => {
    gl().texStorage2D(target, levels, ifmt, w, h);
    for (let l = 0; l < levels; l++) recordLevel(target, l, Math.max(1, w >> l), Math.max(1, h >> l), ifmt);
  };
  GL.glCopyTexSubImage2D = (target, level, xo, yo, x, y, w, h) => gl().copyTexSubImage2D(target, level, xo, yo, x, y, w, h);
  GL.glCopyTexImage2D = (target, level, ifmt, x, y, w, h, border) => {
    gl().copyTexImage2D(target, level, ifmt === GLC.RGBA8 ? GLC.RGBA : ifmt, x, y, w, h, 0);
    recordLevel(target, level, w, h, ifmt);
  };
  GL.glGenerateMipmap = (target) => gl().generateMipmap(target);
  const texParam = (target, pname, param) => {
    const g = gl();
    switch (pname) {
      case GLC.TEXTURE_LOD_BIAS: case GLC.TEXTURE_BORDER_COLOR: case GLC.DEPTH_TEXTURE_MODE: case GLC.GENERATE_MIPMAP:
      case GLC.TEXTURE_SWIZZLE_R: case 0x8e43: case 0x8e44: case GLC.TEXTURE_SWIZZLE_A: case GLC.TEXTURE_SWIZZLE_RGBA:
        return;
      case GLC.TEXTURE_MAX_ANISOTROPY:
        if (S.anisotropic) g.texParameterf(target, S.anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(param, S.maxAnisotropy));
        return;
      case GLC.TEXTURE_WRAP_S: case GLC.TEXTURE_WRAP_T: case GLC.TEXTURE_WRAP_R:
        g.texParameteri(target, pname, param === GLC.CLAMP || param === GLC.CLAMP_TO_BORDER ? GLC.CLAMP_TO_EDGE : param);
        return;
      case 0x813a: case 0x813b: // MIN_LOD / MAX_LOD
        g.texParameterf(target, pname, param);
        return;
      default:
        g.texParameteri(target, pname, param);
    }
  };
  GL.glTexParameteri = texParam;
  GL.glTexParameterf = texParam;
  GL.glTexParameteriv = (target, pname, params) => texParam(target, pname, readInts(params, 1)[0]);
  GL.glTexParameterfv = (target, pname, params) => texParam(target, pname, floatView(params, 1)[0]);
  GL.glGetTexParameteriv = (target, pname, out) => writeInts(out, [gl().getTexParameter(target, pname) | 0]);
  GL.glGetTexLevelParameteriv = (target, level, pname, out) => {
    let value = 0;
    if (target === GLC.PROXY_TEXTURE_2D) {
      value = pname === GLC.TEXTURE_WIDTH ? S.proxy.width : pname === GLC.TEXTURE_HEIGHT ? S.proxy.height : 0;
    } else {
      const info = S.textureInfo.get(S.textures.get(boundTexture(texTarget(target))));
      const lvl = info && info.levels.get(level);
      if (lvl) value = pname === GLC.TEXTURE_WIDTH ? lvl.width : pname === GLC.TEXTURE_HEIGHT ? lvl.height : pname === GLC.TEXTURE_INTERNAL_FORMAT ? lvl.ifmt : 0;
    }
    writeInts(out, [value]);
  };
  GL.glGetTexLevelParameteri = (target, level, pname) => {
    const box = new Int32Array(1);
    GL.glGetTexLevelParameteriv(target, level, pname, box);
    return box[0];
  };
  GL.glGetTexImage = (target, level, format, type, pixels) => {
    const g = gl();
    const info = S.textureInfo.get(S.textures.get(boundTexture(target)));
    const lvl = info && info.levels.get(level);
    if (!lvl) return;
    const fbo = g.createFramebuffer();
    g.bindFramebuffer(g.READ_FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.READ_FRAMEBUFFER, g.COLOR_ATTACHMENT0, target, S.textures.get(boundTexture(target)), level);
    readPixelsInto(0, 0, lvl.width, lvl.height, format, type, pixels);
    g.bindFramebuffer(g.READ_FRAMEBUFFER, fbOf(S.readFramebuffer));
    g.deleteFramebuffer(fbo);
  };
  function readPixelsInto(x, y, width, height, format, type, pixels) {
    const g = gl();
    if (S.bound[GLC.PIXEL_PACK_BUFFER]) {
      g.readPixels(x, y, width, height, format === GLC.BGRA ? GLC.RGBA : format, type, Number(ptr(pixels)));
      return;
    }
    const bgra = format === GLC.BGRA;
    const fmt = bgra ? GLC.RGBA : format;
    const ty = type === GLC.UNSIGNED_INT_8_8_8_8_REV ? GLC.UNSIGNED_BYTE : type;
    if (fmt === GLC.RGBA && ty === GLC.UNSIGNED_BYTE) {
      const packRow = g.getParameter(g.PACK_ROW_LENGTH);
      const length = (packRow || width) * height * 4;
      const tmp = new Uint8Array(length);
      g.readPixels(x, y, width, height, fmt, ty, tmp);
      if (bgra) for (let i = 0; i < length; i += 4) { const r = tmp[i]; tmp[i] = tmp[i + 2]; tmp[i + 2] = r; }
      bytesAt(pixels, length).set(tmp);
      return;
    }
    const src = pixelSource(pixels, ty);
    if (src && src.view) g.readPixels(x, y, width, height, fmt, ty, src.view, src.offset);
    else if (src) g.readPixels(x, y, width, height, fmt, ty, src);
  }
  GL.glReadPixels = (x, y, w, h, format, type, pixels) => readPixelsInto(x, y, w, h, format, type, pixels);

  // Buffers
  const genObjects = (map, create) => (n, out) => {
    if (isView(n)) { for (let i = 0; i < n.length; i++) { const id = name(); map.set(id, create()); n[i] = id; } return undefined; }
    if (out === undefined) { const id = name(); map.set(id, create()); return id; }
    const ids = [];
    for (let i = 0; i < n; i++) { const id = name(); map.set(id, create()); ids.push(id); }
    writeInts(out, ids);
    return undefined;
  };
  const deleteObjects = (map, destroy, onDelete) => (n, list) => {
    const ids = isView(n) ? Array.from(n) : list === undefined ? [n] : readInts(list, n);
    for (const id of ids) {
      const object = map.get(id);
      if (object) { destroy(object); map.delete(id); }
      if (onDelete) onDelete(id);
    }
  };
  GL.glGenBuffers = genObjects(S.buffers, () => gl().createBuffer());
  GL.glDeleteBuffers = deleteObjects(S.buffers, (b) => gl().deleteBuffer(b), (id) => {
    for (const t of Object.keys(S.bound)) if (S.bound[t] === id) S.bound[t] = 0;
  });
  GL.glIsBuffer = (id) => S.buffers.has(id);
  // GL_TEXTURE_BUFFER is not a WebGL buffer target: its binding is only tracked, and data calls
  // for it go through COPY_WRITE_BUFFER.
  const useTarget = (target) => {
    if (target !== GLC.TEXTURE_BUFFER) return target;
    gl().bindBuffer(GLC.COPY_WRITE_BUFFER, S.buffers.get(S.bound[GLC.TEXTURE_BUFFER]) || null);
    return GLC.COPY_WRITE_BUFFER;
  };
  const doneTarget = (target) => {
    if (target === GLC.TEXTURE_BUFFER) gl().bindBuffer(GLC.COPY_WRITE_BUFFER, S.buffers.get(S.bound[GLC.COPY_WRITE_BUFFER]) || null);
  };
  // WebGL 2 fixes a buffer's type with its first binding: index (element) data or any other
  // data. Copies between the two types fail, and 26.x fills index buffers from staging buffers
  // with glCopyBufferSubData, so such copies go through the CPU (see glCopyBufferSubData).
  const typedBuffers = new WeakSet();
  const elementBuffers = new WeakSet();
  const noteBufferType = (target, buffer) => {
    if (!buffer || typedBuffers.has(buffer)) return;
    typedBuffers.add(buffer);
    if (target === GLC.ELEMENT_ARRAY_BUFFER) elementBuffers.add(buffer);
  };
  // CPU copies of the buffers whose contents would otherwise be read back from the GPU (which
  // makes the browser wait for all queued GPU work): sources of copies into index buffers and
  // the buffers behind buffer textures. One read back makes the copy; every later write to the
  // buffer updates it as well.
  const shadows = new WeakMap();
  let shadowing = false;
  function shadowOf(buffer) {
    let s = shadows.get(buffer);
    if (!s) {
      const g = gl();
      g.bindBuffer(GLC.COPY_READ_BUFFER, buffer);
      s = new Uint8Array(g.getBufferParameter(GLC.COPY_READ_BUFFER, GLC.BUFFER_SIZE));
      if (s.length) g.getBufferSubData(GLC.COPY_READ_BUFFER, 0, s);
      g.bindBuffer(GLC.COPY_READ_BUFFER, S.buffers.get(S.bound[GLC.COPY_READ_BUFFER]) || null);
      shadows.set(buffer, s);
      shadowing = true;
    }
    return s;
  }
  // The shadowed buffer a write through this target goes to, if any.
  const shadowedAt = (target) => {
    if (!shadowing) return null;
    const buffer = target === GLC.TEXTURE_BUFFER ? S.buffers.get(S.bound[target]) || null : boundBuffer(target);
    return buffer && shadows.has(buffer) ? buffer : null;
  };
  GL.glBindBuffer = (target, id) => {
    S.bound[target] = id;
    if (target !== GLC.TEXTURE_BUFFER) {
      const buffer = S.buffers.get(id) || null;
      noteBufferType(target, buffer);
      gl().bindBuffer(target, buffer);
    }
  };
  GL.glBindBufferBase = (target, index, id) => {
    const buffer = S.buffers.get(id) || null;
    noteBufferType(target, buffer);
    gl().bindBufferBase(target, index, buffer);
  };
  GL.glBindBufferRange = (target, index, id, offset, size) => {
    const buffer = S.buffers.get(id) || null;
    noteBufferType(target, buffer);
    gl().bindBufferRange(target, index, buffer, Number(offset), Number(size));
  };
  GL.glBufferData = (target, size, data, usage) => {
    const t = useTarget(target);
    bumpBuffer(S.bound[target]);
    const shadowed = shadowedAt(target);
    let bytes; // the new contents, when given
    if (isView(size)) gl().bufferData(t, bytes = asBytes(size), data); // glBufferData(target, short[]/int[]/float[] data, usage)
    else {
      const n = Number(size);
      const p = data === undefined ? 0 : ptr(data);
      if (!p && !isView(data)) gl().bufferData(t, n, usage);
      else if (isView(data)) gl().bufferData(t, bytes = asBytes(data).subarray(0, n), usage);
      else { sync(); gl().bufferData(t, bytes = U8.subarray(p, p + n), usage); }
      if (shadowed && !bytes) bytes = new Uint8Array(n);
    }
    if (shadowed) shadows.set(shadowed, Uint8Array.from(bytes));
    doneTarget(target);
  };
  GL.glBufferSubData = (target, offset, size, data) => {
    const t = useTarget(target);
    bumpBuffer(S.bound[target]);
    let bytes;
    if (isView(size)) bytes = asBytes(size);
    else if (isView(data)) bytes = asBytes(data).subarray(0, Number(size));
    else {
      sync();
      bytes = U8.subarray(ptr(data), ptr(data) + Number(size));
    }
    gl().bufferSubData(t, Number(offset), bytes);
    const shadowed = shadowedAt(target);
    if (shadowed) shadows.get(shadowed).set(bytes, Number(offset));
    doneTarget(target);
  };
  GL.glGetBufferSubData = (target, offset, size, data) => {
    const bytes = bytesAt(data, Number(size));
    gl().getBufferSubData(useTarget(target), Number(offset), bytes);
    doneTarget(target);
  };
  // The buffer bound to a target (the element array binding belongs to the vertex array object).
  const boundBuffer = (target) => {
    if (target === GLC.ELEMENT_ARRAY_BUFFER && S.bound[target] === -1) return gl().getParameter(GLC.ELEMENT_ARRAY_BUFFER_BINDING);
    return S.buffers.get(S.bound[target]) || null;
  };
  GL.glCopyBufferSubData = (r, w, ro, wo, size) => {
    bumpBuffer(S.bound[w]);
    const g = gl();
    const readTarget = r === GLC.TEXTURE_BUFFER ? GLC.COPY_READ_BUFFER : r;
    const src = boundBuffer(readTarget);
    const dst = boundBuffer(w);
    const shadowedDst = dst && shadowing && shadows.get(dst);
    if (src && dst && elementBuffers.has(src) !== elementBuffers.has(dst)) {
      // Between index data and other data: upload from the source's CPU copy.
      const bytes = shadowOf(src).subarray(Number(ro), Number(ro) + Number(size));
      g.bindBuffer(GLC.COPY_WRITE_BUFFER, dst);
      g.bufferSubData(GLC.COPY_WRITE_BUFFER, Number(wo), bytes);
      g.bindBuffer(GLC.COPY_WRITE_BUFFER, S.buffers.get(S.bound[GLC.COPY_WRITE_BUFFER]) || null);
      if (shadowedDst) shadowedDst.set(bytes, Number(wo));
      return;
    }
    g.copyBufferSubData(readTarget, useTarget(w), Number(ro), Number(wo), Number(size));
    if (shadowedDst) {
      const from = src && shadows.get(src);
      if (from) shadowedDst.set(from.subarray(Number(ro), Number(ro) + Number(size)), Number(wo));
      else shadows.delete(dst); // made again from the GPU when next needed
    }
    doneTarget(w);
  };
  GL.glGetBufferParameteriv = (target, pname, out) => {
    writeInts(out, [gl().getBufferParameter(useTarget(target), pname) | 0]);
    doneTarget(target);
  };
  GL.glMapBufferRange = (target, offset, length, access) => {
    const id = S.bound[target];
    const len = Number(length);
    const finish = (address) => {
      if (!address) return 0;
      if (access & GLC.MAP_READ_BIT) {
        sync();
        gl().getBufferSubData(useTarget(target), Number(offset), U8, address, len);
        doneTarget(target);
      }
      S.mapped.set(id, { address, offset: Number(offset), length: len, write: !!(access & GLC.MAP_WRITE_BIT) });
      return address;
    };
    const address = malloc(Math.max(1, len));
    // When the JavaScript heap is full, wait for more memory (the native becomes asynchronous).
    return address ? finish(address) : mallocAsync(Math.max(1, len)).then(finish);
  };
  GL.glMapBuffer = (target, access) => {
    const size = gl().getBufferParameter(useTarget(target), GLC.BUFFER_SIZE);
    doneTarget(target);
    const bits = access === GLC.READ_ONLY ? GLC.MAP_READ_BIT : access === GLC.WRITE_ONLY ? GLC.MAP_WRITE_BIT : 3;
    return GL.glMapBufferRange(target, 0, size, bits);
  };
  GL.glUnmapBuffer = (target) => {
    const id = S.bound[target];
    const m = S.mapped.get(id);
    if (!m) return false;
    if (m.write) {
      sync();
      bumpBuffer(id);
      const bytes = U8.subarray(m.address, m.address + m.length);
      gl().bufferSubData(useTarget(target), m.offset, bytes);
      const shadowed = shadowedAt(target);
      if (shadowed) shadows.get(shadowed).set(bytes, m.offset);
      doneTarget(target);
    }
    free(m.address);
    S.mapped.delete(id);
    return true;
  };
  GL.glFlushMappedBufferRange = () => undefined;

  // Vertex arrays
  GL.glGenVertexArrays = genObjects(S.vertexArrays, () => gl().createVertexArray());
  GL.glDeleteVertexArrays = deleteObjects(S.vertexArrays, (v) => gl().deleteVertexArray(v), (id) => {
    if (S.vertexArray === id) S.vertexArray = 0;
    attribPointers.delete(id);
  });
  GL.glIsVertexArray = (id) => S.vertexArrays.has(id);
  GL.glBindVertexArray = (id) => {
    S.vertexArray = id;
    gl().bindVertexArray(S.vertexArrays.get(id) || null);
    S.bound[GLC.ELEMENT_ARRAY_BUFFER] = -1; // unknown after a VAO switch
  };
  GL.glEnableVertexAttribArray = (i) => gl().enableVertexAttribArray(i);
  GL.glDisableVertexAttribArray = (i) => gl().disableVertexAttribArray(i);
  // Attribute pointers per vertex array object, for base-vertex draws (see glDrawElementsBaseVertex).
  const attribPointers = new Map(); // VAO name -> Map(location -> pointer)
  const pointersOfVao = () => {
    let pointers = attribPointers.get(S.vertexArray);
    if (!pointers) attribPointers.set(S.vertexArray, (pointers = new Map()));
    return pointers;
  };
  GL.glVertexAttribPointer = (i, size, type, normalized, stride, pointer) => {
    if (!S.bound[GLC.ARRAY_BUFFER]) warnOnce('client-arrays', 'client-side vertex arrays are not supported yet');
    gl().vertexAttribPointer(i, size, type, !!normalized, stride, Number(pointer));
    const old = pointersOfVao().get(i);
    pointersOfVao().set(i, { integer: false, size, type, normalized: !!normalized, stride, offset: Number(pointer), buffer: S.bound[GLC.ARRAY_BUFFER], divisor: old?.divisor || 0 });
  };
  GL.glVertexAttribIPointer = (i, size, type, stride, pointer) => {
    gl().vertexAttribIPointer(i, size, type, stride, Number(pointer));
    const old = pointersOfVao().get(i);
    pointersOfVao().set(i, { integer: true, size, type, normalized: false, stride, offset: Number(pointer), buffer: S.bound[GLC.ARRAY_BUFFER], divisor: old?.divisor || 0 });
  };
  GL.glVertexAttribDivisor = (i, d) => {
    gl().vertexAttribDivisor(i, d);
    const pointer = pointersOfVao().get(i);
    if (pointer) pointer.divisor = d;
  };
  GL.glVertexAttrib1f = (i, x) => gl().vertexAttrib1f(i, x);
  GL.glVertexAttrib2f = (i, x, y) => gl().vertexAttrib2f(i, x, y);
  GL.glVertexAttrib3f = (i, x, y, z) => gl().vertexAttrib3f(i, x, y, z);
  GL.glVertexAttrib4f = (i, x, y, z, w) => gl().vertexAttrib4f(i, x, y, z, w);
  GL.glVertexAttribI4i = (i, x, y, z, w) => gl().vertexAttribI4i(i, x, y, z, w);

  // Drawing
  GL.glDrawArrays = (mode, first, count) => {
    syncBufferTextures();
    gl().drawArrays(mode, first, count);
  };
  GL.glDrawElements = (mode, count, type, indices) => {
    if (mode === GLC.QUADS) return warnOnce('quads', 'GL_QUADS is not supported yet');
    if (isView(indices) || (!S.bound[GLC.ELEMENT_ARRAY_BUFFER] && Number(ptr(indices)) > 65535)) {
      return warnOnce('client-indices', 'client-side index arrays are not supported yet');
    }
    syncBufferTextures();
    gl().drawElements(mode, count, type, Number(indices));
  };
  GL.glDrawRangeElements = (mode, start, end, count, type, indices) => GL.glDrawElements(mode, count, type, indices);
  GL.glDrawArraysInstanced = (mode, first, count, instances) => { syncBufferTextures(); gl().drawArraysInstanced(mode, first, count, instances); };
  GL.glDrawElementsInstanced = (mode, count, type, indices, instances) => {
    syncBufferTextures();
    gl().drawElementsInstanced(mode, count, type, Number(indices), instances);
  };
  // WebGL 2 has no base vertex: the per-vertex attribute pointers of the bound vertex array
  // are moved by baseVertex vertices for the draw (1.21.6+ batch the GUI this way).
  const ATTRIB_TYPE_BYTES = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140b: 2 };
  const withBaseVertex = (base, draw) => {
    if (!base) return draw();
    const g = gl();
    const pointers = attribPointers.get(S.vertexArray) || new Map();
    const point = (shift) => {
      for (const [i, p] of pointers) {
        if (p.divisor) continue;
        const stride = p.stride || (ATTRIB_TYPE_BYTES[p.type] ? p.size * ATTRIB_TYPE_BYTES[p.type] : 4);
        g.bindBuffer(GLC.ARRAY_BUFFER, S.buffers.get(p.buffer) || null);
        if (p.integer) g.vertexAttribIPointer(i, p.size, p.type, p.stride, p.offset + shift * stride);
        else g.vertexAttribPointer(i, p.size, p.type, p.normalized, p.stride, p.offset + shift * stride);
      }
    };
    point(base);
    try {
      draw();
    } finally {
      point(0);
      g.bindBuffer(GLC.ARRAY_BUFFER, S.buffers.get(S.bound[GLC.ARRAY_BUFFER]) || null);
    }
  };
  GL.glDrawElementsBaseVertex = (mode, count, type, indices, base) => withBaseVertex(base, () => GL.glDrawElements(mode, count, type, indices));
  GL.glDrawRangeElementsBaseVertex = (mode, start, end, count, type, indices, base) => GL.glDrawElementsBaseVertex(mode, count, type, indices, base);
  GL.glDrawElementsInstancedBaseVertex = (mode, count, type, indices, instances, base) => withBaseVertex(base, () => GL.glDrawElementsInstanced(mode, count, type, indices, instances));
  // Multi-draws (26.x batches with them) become one draw each.
  GL.glMultiDrawArrays = (mode, first, count, drawCount) => {
    const firsts = readInts(first, drawCount);
    const counts = readInts(count, drawCount);
    syncBufferTextures();
    for (let i = 0; i < drawCount; i++) if (counts[i] > 0) gl().drawArrays(mode, firsts[i], counts[i]);
  };
  GL.glMultiDrawElements = (mode, count, type, indices, drawCount) => {
    const counts = readInts(count, drawCount);
    const offsets = readInts(indices, drawCount);
    syncBufferTextures();
    for (let i = 0; i < drawCount; i++) if (counts[i] > 0) gl().drawElements(mode, counts[i], type, offsets[i] >>> 0);
  };
  GL.glMultiDrawElementsBaseVertex = (mode, count, type, indices, drawCount, baseVertex) => {
    const counts = readInts(count, drawCount);
    const offsets = readInts(indices, drawCount);
    const bases = readInts(baseVertex, drawCount);
    syncBufferTextures();
    for (let i = 0; i < drawCount; i++) {
      if (counts[i] > 0) withBaseVertex(bases[i], () => gl().drawElements(mode, counts[i], type, offsets[i] >>> 0));
    }
  };

  // Shaders and programs
  GL.glCreateShader = (type) => {
    const id = name();
    const shader = gl().createShader(type);
    S.shaders.set(id, shader);
    shader.webmcType = type;
    return id;
  };
  GL.glDeleteShader = (id) => {
    const shader = S.shaders.get(id);
    if (shader) { gl().deleteShader(shader); S.shaders.delete(id); }
  };
  GL.glIsShader = (id) => S.shaders.has(id);
  GL.glShaderSource = (id, count, strings, lengths) => {
    let source = '';
    if (typeof count === 'string') source = count; // glShaderSource(int, CharSequence) handled in Java normally
    else {
      sync();
      const sp = ptr(strings);
      for (let i = 0; i < count; i++) {
        const sAddr = U32[(sp >> 2) + i];
        const len = lengths && ptr(lengths) ? I32[(ptr(lengths) >> 2) + i] : -1;
        source += len < 0 ? readCString(sAddr) : readUtf8(sAddr, len);
      }
    }
    const shader = S.shaders.get(id);
    shader.webmcSource = source;
    const translated = translateGLSL(source, { stage: shader.webmcType === GLC.VERTEX_SHADER ? 'vertex' : 'fragment' });
    shader.webmcDefaults = translated.uniformDefaults;
    shader.webmcWarnings = translated.warnings;
    gl().shaderSource(shader, translated.code);
  };
  GL.glCompileShader = (id) => {
    const shader = S.shaders.get(id);
    gl().compileShader(shader);
    if (!gl().getShaderParameter(shader, gl().COMPILE_STATUS)) {
      console.warn('[lwjgl-web] shader compile failed:', gl().getShaderInfoLog(shader), shader.webmcWarnings.join('; '), '\n', gl().getShaderSource(shader));
    }
  };
  const shaderLog = (id) => gl().getShaderInfoLog(S.shaders.get(id)) || '';
  GL.glGetShaderiv = (id, pname, out) => {
    const shader = S.shaders.get(id);
    let value = 0;
    if (pname === GLC.INFO_LOG_LENGTH) value = shaderLog(id).length + 1;
    else if (pname === GLC.SHADER_SOURCE_LENGTH) value = (shader.webmcSource || '').length + 1;
    else if (pname === GLC.SHADER_TYPE) value = shader.webmcType;
    else value = Number(gl().getShaderParameter(shader, pname));
    writeInts(out, [value]);
  };
  GL.glGetShaderi = (id, pname) => {
    const box = new Int32Array(1);
    GL.glGetShaderiv(id, pname, box);
    return box[0];
  };
  GL.glGetShaderInfoLog = (id, maxLength, length, infoLog) => {
    const n = writeCStringAt(infoLog, shaderLog(id), maxLength);
    if (length !== undefined) writeInts(length, [n]);
  };
  GL.glCreateProgram = () => {
    const id = name();
    S.programs.set(id, gl().createProgram());
    S.programUniforms.set(id, new Map());
    return id;
  };
  GL.glDeleteProgram = (id) => {
    const program = S.programs.get(id);
    if (program) { gl().deleteProgram(program); S.programs.delete(id); }
  };
  GL.glIsProgram = (id) => S.programs.has(id);
  GL.glAttachShader = (p, s) => {
    const program = S.programs.get(p);
    (program.webmcShaders ??= new Set()).add(S.shaders.get(s));
    gl().attachShader(program, S.shaders.get(s));
  };
  GL.glDetachShader = (p, s) => {
    const program = S.programs.get(p);
    program.webmcShaders?.delete(S.shaders.get(s));
    gl().detachShader(program, S.shaders.get(s));
  };
  GL.glLinkProgram = (id) => {
    const program = S.programs.get(id);
    gl().linkProgram(program);
    S.programUniforms.set(id, new Map());
    if (!gl().getProgramParameter(program, gl().LINK_STATUS)) {
      console.warn('[lwjgl-web] program link failed:', gl().getProgramInfoLog(program));
      return;
    }
    applyUniformDefaults(program);
  };
  // Desktop GLSL may initialize uniforms in the declaration; GLSL ES may not, so the translator
  // removes the initializers and their values are set here, as a desktop driver does at link time.
  function applyUniformDefaults(program) {
    const defaults = [...(program.webmcShaders || [])].flatMap((shader) => shader.webmcDefaults || []);
    if (!defaults.length) return;
    gl().useProgram(program);
    for (const { name, type, value } of defaults) {
      const location = gl().getUniformLocation(program, name);
      const values = uniformDefaultValues(type, value);
      if (!location || !values) continue;
      const integer = /^(int|uint|bool|[iub]vec\d)$/.test(type);
      if (type.startsWith('mat')) gl()[`uniformMatrix${Math.round(Math.sqrt(values.length))}fv`](location, false, values);
      else gl()[`uniform${values.length}${integer ? 'i' : 'f'}v`](location, values);
    }
    gl().useProgram(S.programs.get(S.program) || null);
  }
  GL.glValidateProgram = (id) => gl().validateProgram(S.programs.get(id));
  const programLog = (id) => gl().getProgramInfoLog(S.programs.get(id)) || '';
  GL.glGetProgramiv = (id, pname, out) => {
    let value;
    if (pname === GLC.INFO_LOG_LENGTH) value = programLog(id).length + 1;
    else value = Number(gl().getProgramParameter(S.programs.get(id), pname));
    writeInts(out, [value]);
  };
  GL.glGetProgrami = (id, pname) => {
    const box = new Int32Array(1);
    GL.glGetProgramiv(id, pname, box);
    return box[0];
  };
  GL.glGetProgramInfoLog = (id, maxLength, length, infoLog) => {
    const n = writeCStringAt(infoLog, programLog(id), maxLength);
    if (length !== undefined) writeInts(length, [n]);
  };
  GL.glUseProgram = (id) => {
    S.program = id;
    gl().useProgram(S.programs.get(id) || null);
  };
  // Identifiers that are reserved words in GLSL ES were renamed by the translator.
  const nameArg = (v) => (typeof v === 'string' ? v : readCString(v)).replace(/[A-Za-z_]\w*/g, esIdentifier);
  GL.glBindAttribLocation = (p, index, n) => gl().bindAttribLocation(S.programs.get(p), index, nameArg(n));
  GL.glGetAttribLocation = (p, n) => gl().getAttribLocation(S.programs.get(p), nameArg(n));
  GL.glBindFragDataLocation = () => undefined;
  GL.glGetUniformLocation = (p, n) => {
    const uniformName = nameArg(n);
    let cache = S.programUniforms.get(p);
    if (!cache) S.programUniforms.set(p, (cache = new Map()));
    if (cache.has(uniformName)) return cache.get(uniformName);
    const location = gl().getUniformLocation(S.programs.get(p), uniformName);
    let id = -1;
    if (location) {
      id = S.nextUniform++;
      S.uniforms.set(id, location);
    }
    cache.set(uniformName, id);
    return id;
  };
  GL.glGetUniformBlockIndex = (p, n) => gl().getUniformBlockIndex(S.programs.get(p), nameArg(n));
  GL.glUniformBlockBinding = (p, index, binding) => gl().uniformBlockBinding(S.programs.get(p), index, binding);
  GL.glGetActiveUniformBlockiv = (p, index, pname, out) => {
    const value = gl().getActiveUniformBlockParameter(S.programs.get(p), index, pname);
    writeInts(out, ArrayBuffer.isView(value) ? Array.from(value) : [Number(value) || 0]);
  };
  GL.glGetActiveUniformBlocki = (p, index, pname) => Number(gl().getActiveUniformBlockParameter(S.programs.get(p), index, pname)) || 0;
  GL.glGetActiveUniformBlockName = (p, index, bufSize, length, out) => {
    const blockName = (gl().getActiveUniformBlockName(S.programs.get(p), index) || '').replace(/^webmc_/, '');
    const n = writeCStringAt(out, blockName, bufSize);
    if (length !== undefined && Number(length)) writeInts(length, [n]);
  };
  const U = (id) => S.uniforms.get(id) ?? null;
  GL.glUniform1i = (l, x) => gl().uniform1i(U(l), x);
  GL.glUniform2i = (l, x, y) => gl().uniform2i(U(l), x, y);
  GL.glUniform3i = (l, x, y, z) => gl().uniform3i(U(l), x, y, z);
  GL.glUniform4i = (l, x, y, z, w) => gl().uniform4i(U(l), x, y, z, w);
  GL.glUniform1f = (l, x) => gl().uniform1f(U(l), x);
  GL.glUniform2f = (l, x, y) => gl().uniform2f(U(l), x, y);
  GL.glUniform3f = (l, x, y, z) => gl().uniform3f(U(l), x, y, z);
  GL.glUniform4f = (l, x, y, z, w) => gl().uniform4f(U(l), x, y, z, w);
  GL.glUniform1ui = (l, x) => gl().uniform1ui(U(l), x);
  const vecArgs = (count, value, size) => (isView(count) ? [count, 0, count.length] : [null, count * size, value]);
  for (const [n, size, kind] of [[1, 1, 'f'], [2, 2, 'f'], [3, 3, 'f'], [4, 4, 'f'], [1, 1, 'i'], [2, 2, 'i'], [3, 3, 'i'], [4, 4, 'i']]) {
    GL[`glUniform${n}${kind}v`] = (l, count, value) => {
      const array = isView(count) ? count : kind === 'f' ? floatView(value, count * size) : intView(value, count * size);
      gl()[`uniform${n}${kind}v`](U(l), array);
    };
  }
  for (const [n, size] of [[2, 4], [3, 9], [4, 16]]) {
    GL[`glUniformMatrix${n}fv`] = (l, count, transpose, value) => {
      if (isView(transpose)) { gl()[`uniformMatrix${n}fv`](U(l), !!count, transpose); return; } // (location, transpose, float[])
      gl()[`uniformMatrix${n}fv`](U(l), !!transpose, floatView(value, count * size));
    };
  }
  void vecArgs;

  // Framebuffers
  GL.glGenFramebuffers = genObjects(S.framebuffers, () => gl().createFramebuffer());
  GL.glDeleteFramebuffers = deleteObjects(S.framebuffers, (f) => gl().deleteFramebuffer(f), (id) => {
    if (S.drawFramebuffer === id) { S.drawFramebuffer = 0; gl().bindFramebuffer(gl().DRAW_FRAMEBUFFER, S.backbuffer.fbo); }
    if (S.readFramebuffer === id) { S.readFramebuffer = 0; gl().bindFramebuffer(gl().READ_FRAMEBUFFER, S.backbuffer.fbo); }
  });
  GL.glIsFramebuffer = (id) => S.framebuffers.has(id);
  GL.glBindFramebuffer = (target, id) => {
    if (target === GLC.FRAMEBUFFER || target === GLC.DRAW_FRAMEBUFFER) S.drawFramebuffer = id;
    if (target === GLC.FRAMEBUFFER || target === GLC.READ_FRAMEBUFFER) S.readFramebuffer = id;
    gl().bindFramebuffer(target, fbOf(id));
  };
  GL.glFramebufferTexture2D = (target, attachment, textarget, texture, level) => {
    gl().framebufferTexture2D(target, attachment, textarget, S.textures.get(texture) || null, level);
  };
  GL.glFramebufferTexture = (target, attachment, texture, level) => GL.glFramebufferTexture2D(target, attachment, GLC.TEXTURE_2D, texture, level);
  GL.glGenRenderbuffers = genObjects(S.renderbuffers, () => gl().createRenderbuffer());
  GL.glDeleteRenderbuffers = deleteObjects(S.renderbuffers, (r) => gl().deleteRenderbuffer(r));
  GL.glBindRenderbuffer = (target, id) => {
    S.renderbuffer = id;
    gl().bindRenderbuffer(target, S.renderbuffers.get(id) || null);
  };
  GL.glRenderbufferStorage = (target, ifmt, w, h) => {
    const format = ifmt === GLC.DEPTH_COMPONENT || ifmt === GLC.DEPTH_COMPONENT32 ? GLC.DEPTH_COMPONENT24 : ifmt === GLC.DEPTH_STENCIL ? GLC.DEPTH24_STENCIL8 : ifmt === GLC.RGBA ? GLC.RGBA8 : ifmt;
    gl().renderbufferStorage(target, format, w, h);
  };
  GL.glRenderbufferStorageMultisample = (target, samples, ifmt, w, h) => GL.glRenderbufferStorage(target, ifmt, w, h);
  GL.glFramebufferRenderbuffer = (target, attachment, rbTarget, rb) => {
    gl().framebufferRenderbuffer(target, attachment, rbTarget, S.renderbuffers.get(rb) || null);
  };
  GL.glCheckFramebufferStatus = (target) => gl().checkFramebufferStatus(target);
  GL.glBlitFramebuffer = (x0, y0, x1, y1, a0, b0, a1, b1, mask, filter) => gl().blitFramebuffer(x0, y0, x1, y1, a0, b0, a1, b1, mask, filter);
  const mapDrawBuffer = (b) => (b === GLC.BACK || b === GLC.FRONT || b === GLC.FRONT_AND_BACK ? GLC.COLOR_ATTACHMENT0 : b);
  GL.glDrawBuffer = (buf) => {
    const b = mapDrawBuffer(buf);
    if (S.drawFramebuffer === 0) gl().drawBuffers([b === GLC.NONE ? GLC.NONE : GLC.BACK]);
    else gl().drawBuffers([b]);
  };
  GL.glDrawBuffers = (n, bufs) => {
    const list = isView(n) ? Array.from(n) : readInts(bufs, n);
    gl().drawBuffers(S.drawFramebuffer === 0 ? [GLC.BACK] : list.map(mapDrawBuffer));
  };
  GL.glReadBuffer = (buf) => gl().readBuffer(S.readFramebuffer === 0 ? GLC.COLOR_ATTACHMENT0 : mapDrawBuffer(buf));
  GL.glGetFramebufferAttachmentParameteriv = (target, attachment, pname, out) => {
    writeInts(out, [Number(gl().getFramebufferAttachmentParameter(target, attachment, pname)) || 0]);
  };

  // Samplers
  GL.glGenSamplers = genObjects(S.samplers, () => gl().createSampler());
  GL.glDeleteSamplers = deleteObjects(S.samplers, (s) => gl().deleteSampler(s));
  GL.glBindSampler = (unit, id) => gl().bindSampler(unit, S.samplers.get(id) || null);
  GL.glSamplerParameteri = (id, pname, param) => gl().samplerParameteri(S.samplers.get(id), pname, param === GLC.CLAMP || param === GLC.CLAMP_TO_BORDER ? GLC.CLAMP_TO_EDGE : param);
  GL.glSamplerParameterf = (id, pname, param) => gl().samplerParameterf(S.samplers.get(id), pname, param);

  // Sync objects
  GL.glFenceSync = () => {
    const id = name();
    S.syncs.set(id, gl().fenceSync(GLC.SYNC_GPU_COMMANDS_COMPLETE, 0));
    return id;
  };
  GL.glDeleteSync = (id) => {
    const s = S.syncs.get(Number(id));
    if (s) { gl().deleteSync(s); S.syncs.delete(Number(id)); }
  };
  GL.glClientWaitSync = (id) => GLC.ALREADY_SIGNALED;
  GL.glWaitSync = () => undefined;
  GL.glGetSynciv = (id, pname, bufSize, length, values) => writeInts(values, [GLC.SIGNALED]);
  GL.glIsSync = (id) => S.syncs.has(Number(id));

  // Queries
  function integerState(pname) {
    const g = gl();
    switch (pname) {
      case GLC.MAJOR_VERSION: return [S.version[0]];
      case GLC.MINOR_VERSION: return [S.version[1]];
      case GLC.NUM_EXTENSIONS: return [S.extensions.length];
      case GLC.CONTEXT_PROFILE_MASK: return [S.profile === 'core' ? GLC.CONTEXT_CORE_PROFILE_BIT : GLC.CONTEXT_COMPATIBILITY_PROFILE_BIT];
      case GLC.CONTEXT_FLAGS: return [S.profile === 'core' ? GLC.CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT : 0];
      case GLC.TEXTURE_BINDING_2D: return [boundTexture(GLC.TEXTURE_2D)];
      case GLC.ACTIVE_TEXTURE: return [GLC.TEXTURE0 + S.activeUnit];
      case GLC.CURRENT_PROGRAM: return [S.program];
      case GLC.ARRAY_BUFFER_BINDING: return [S.bound[GLC.ARRAY_BUFFER] || 0];
      case GLC.ELEMENT_ARRAY_BUFFER_BINDING: return [Math.max(0, S.bound[GLC.ELEMENT_ARRAY_BUFFER] || 0)];
      case GLC.VERTEX_ARRAY_BINDING: return [S.vertexArray];
      case GLC.FRAMEBUFFER_BINDING: return [S.drawFramebuffer];
      case GLC.READ_FRAMEBUFFER_BINDING: return [S.readFramebuffer];
      case GLC.RENDERBUFFER_BINDING: return [S.renderbuffer];
      case GLC.MAX_TEXTURE_MAX_ANISOTROPY: return [S.maxAnisotropy | 0];
      case 0x0d32: return [32]; // MAX_CLIP_PLANES
      case 0x0d36: return [32]; // MAX_MODELVIEW_STACK_DEPTH
      case 0x0d38: return [4]; // MAX_PROJECTION_STACK_DEPTH
      case 0x8b4a: return [g.getParameter(g.MAX_VERTEX_UNIFORM_VECTORS) * 4]; // MAX_VERTEX_UNIFORM_COMPONENTS
      case 0x8b49: return [g.getParameter(g.MAX_FRAGMENT_UNIFORM_VECTORS) * 4]; // MAX_FRAGMENT_UNIFORM_COMPONENTS
      default: {
        let value;
        try { value = g.getParameter(pname); } catch { value = 0; }
        if (value === null || value === undefined) return [0];
        if (typeof value === 'boolean') return [value ? 1 : 0];
        if (typeof value === 'number') return [value];
        if (value.length !== undefined) return Array.from(value, (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
        return [0];
      }
    }
  }
  GL.glGetIntegerv = (pname, out) => writeInts(out, integerState(pname).map((v) => Math.trunc(v)));
  GL.glGetInteger = (pname) => integerState(pname)[0] | 0;
  GL.glGetFloatv = (pname, out) => writeFloats(out, integerState(pname));
  GL.glGetFloat = (pname) => integerState(pname)[0];
  GL.glGetBooleanv = (pname, out) => {
    const values = integerState(pname);
    if (isView(out)) { out[0] = values[0] ? 1 : 0; return; }
    sync();
    for (let i = 0; i < values.length; i++) U8[ptr(out) + i] = values[i] ? 1 : 0;
  };
  GL.glGetBoolean = (pname) => (integerState(pname)[0] ? 1 : 0);
  GL.glGetDoublev = (pname, out) => {
    const values = integerState(pname);
    sync();
    if (isView(out)) values.forEach((v, i) => { out[i] = v; });
    else values.forEach((v, i) => new DataView(U8.buffer).setFloat64(ptr(out) + i * 8, v, true));
  };
  GL.glGetInteger64v = (pname, out) => {
    const values = integerState(pname);
    if (isView(out)) { values.forEach((v, i) => { out[i] = BigInt(Math.trunc(v)); }); return; }
    sync();
    values.forEach((v, i) => new DataView(U8.buffer).setBigInt64(ptr(out) + i * 8, BigInt(Math.trunc(v)), true));
  };
  GL.glGetString = (pname) => {
    switch (pname) {
      case GLC.VENDOR: return cstring('WebGL');
      case GLC.RENDERER: return cstring(`${S.renderer} (WebGL 2)`);
      case GLC.VERSION: return cstring(`${S.version[0]}.${S.version[1]}.0 WebGL 2.0`);
      case GLC.SHADING_LANGUAGE_VERSION: return cstring(`${S.version[0]}.${S.version[1]}0`);
      case GLC.EXTENSIONS: return cstring(S.extensions.join(' '));
      default: return 0;
    }
  };
  GL.glGetStringi = (pname, index) => (pname === GLC.EXTENSIONS && index < S.extensions.length ? cstring(S.extensions[index]) : 0);

  // Timer queries (GPU timings for the profiler): WebGL 2 only has them behind an extension that
  // browsers disable, so they report the CPU time at which the command was issued.
  const queries = new Map();
  GL.glGenQueries = (n, ids) => {
    const list = [];
    for (let i = 0; i < n; i++) {
      const id = name();
      queries.set(id, { time: 0 });
      list.push(id);
    }
    writeInts(ids, list);
  };
  GL.glDeleteQueries = (n, ids) => { for (const id of readInts(ids, n)) queries.delete(id); };
  GL.glIsQuery = (id) => queries.has(id);
  GL.glQueryCounter = (id) => { const q = queries.get(id); if (q) q.time = Math.round(performance.now() * 1e6); };
  const QUERY_RESULT = 0x8866;
  const queryValue = (id, pname) => (pname === QUERY_RESULT ? queries.get(id)?.time ?? 0 : 1); // else QUERY_RESULT_AVAILABLE
  GL.glGetQueryObjectiv = (id, pname, out) => writeInts(out, [queryValue(id, pname) | 0]);
  GL.glGetQueryObjectuiv = GL.glGetQueryObjectiv;
  const writeLong = (out, value) => {
    if (isView(out)) { out[0] = BigInt(value); return; }
    sync();
    new DataView(U8.buffer).setBigInt64(ptr(out), BigInt(value), true);
  };
  GL.glGetQueryObjecti64v = (id, pname, out) => writeLong(out, queryValue(id, pname));
  GL.glGetQueryObjectui64v = GL.glGetQueryObjecti64v;

  // glClearBuffer* (GL 3.0) exist in WebGL 2 as they are.
  GL.glClearBufferfv = (buffer, drawBuffer, value) => gl().clearBufferfv(buffer, drawBuffer, floatView(value, 4));
  GL.glClearBufferiv = (buffer, drawBuffer, value) => gl().clearBufferiv(buffer, drawBuffer, Int32Array.from(readInts(value, 4)));
  GL.glClearBufferuiv = (buffer, drawBuffer, value) => gl().clearBufferuiv(buffer, drawBuffer, Uint32Array.from(readInts(value, 4), (v) => v >>> 0));
  GL.glClearBufferfi = (buffer, drawBuffer, depth, stencil) => gl().clearBufferfi(buffer, drawBuffer, depth, stencil);

  // Debug output: not advertised, accepted silently
  GL.glDebugMessageCallback = () => undefined;
  GL.glDebugMessageControl = () => undefined;
  GL.glDebugMessageInsert = () => undefined;
  GL.glObjectLabel = () => undefined;
  GL.glPushDebugGroup = () => undefined;
  GL.glPopDebugGroup = () => undefined;

  // Compatibility profile (1.13 - 1.16.5): the fixed-function pipeline, display lists, GL_QUADS.
  installFixedFunction(S, GL, { floatView, intView, bytesAt, writeFloats, writeInts, isView, warnOnce });

  // ARB/EXT entry points share the core implementation (glActiveTextureARB -> glActiveTexture).
  const implementation = (n) => GL[n] || GL[n.replace(/(ARB|EXT)$/, '')];

  // GLX/GLFW entry points for function lookup
  const lookup = (n) => defineFunction('GL', n, implementation(n) || ((...a) => warnOnce(`fn-${n}`, `OpenGL function not implemented: ${n}`)));
  const glxGetProcAddress = (namePtr) => {
    const fn = readCString(namePtr);
    return fn && fn.startsWith('gl') ? lookup(fn) : 0;
  };
  const glLibrary = {
    glXGetProcAddress: glxGetProcAddress,
    glXGetProcAddressARB: glxGetProcAddress,
    glXGetCurrentContext: () => 1,
    glXGetCurrentDisplay: () => 1,
  };
  for (const n of Object.keys(GL)) glLibrary[n] = GL[n];
  defineLibrary('GL', { aliases: ['libGL.so.1', 'libGL.so', 'libGL', 'opengl32', 'OpenGL'], impls: glLibrary, lenient: true, symbolFilter: (s) => s.startsWith('gl') });

  /** JNI natives for every org.lwjgl.opengl class. */
  function natives() {
    const N = {};
    const def = definer(N);
    for (const [className, methods] of Object.entries(LWJGL_NATIVES)) {
      if (!className.startsWith('org/lwjgl/opengl/')) continue;
      for (const method of methods) {
        const fn = method.startsWith('ngl') ? method.slice(1) : method;
        const impl = implementation(fn);
        if (impl) def(className, method, (lib, ...args) => impl(...args));
        else def(className, method, () => warnOnce(`native-${fn}`, `OpenGL function not implemented: ${className.split('/').pop()}.${method}`));
      }
    }
    return N;
  }

  return {
    S,
    GL,
    attach,
    present,
    resizeBackbuffer,
    natives,
    getProcAddress: (fn) => lookup(fn),
    setProfile(profile, version) {
      S.profile = profile;
      if (version) S.version = version;
      // What a compatibility context offers on top (implemented by ffp.js).
      if (profile !== 'core') {
        for (const ext of ['GL_ARB_texture_env_combine', 'GL_EXT_texture_env_combine', 'GL_ARB_texture_env_crossbar', 'GL_NV_fog_distance']) {
          if (!S.extensions.includes(ext)) S.extensions.push(ext);
        }
      }
    },
  };
}
