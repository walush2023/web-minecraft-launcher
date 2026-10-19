// OpenGL's fixed-function pipeline (compatibility profile) on WebGL 2, for Minecraft 1.13 - 1.16.5.
//
// Those versions draw through glVertexPointer & co. (client memory or VBOs) with GL_QUADS, the
// matrix stacks, fog, alpha test, two-light lighting with colour material, texture environment
// combiners (lightmap, hurt overlay), texture coordinate generation (end portal) and, up to 1.14,
// display lists for entity models. A draw made without a user program becomes a draw with a
// generated GLSL ES program for the current state; programs are cached by a state key. User
// programs fed by legacy client arrays (the post-processing shaders) get the arrays bound to
// their attributes by name.
import { sync, ptr, U8, U16, U32, F32, F64 } from './heap.js';

const C = {
  POINTS: 0, LINES: 1, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, QUADS: 7, QUAD_STRIP: 8, POLYGON: 9,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406, DOUBLE: 0x140a, HALF_FLOAT: 0x140b,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STREAM_DRAW: 0x88e0, STATIC_DRAW: 0x88e4,
  MODELVIEW: 0x1700, PROJECTION: 0x1701, TEXTURE: 0x1702,
  MATRIX_MODE: 0x0ba0, MODELVIEW_MATRIX: 0x0ba6, PROJECTION_MATRIX: 0x0ba7, TEXTURE_MATRIX: 0x0ba8,
  MODELVIEW_STACK_DEPTH: 0x0ba3, PROJECTION_STACK_DEPTH: 0x0ba4, TEXTURE_STACK_DEPTH: 0x0ba5,
  VERTEX_ARRAY: 0x8074, NORMAL_ARRAY: 0x8075, COLOR_ARRAY: 0x8076, TEXTURE_COORD_ARRAY: 0x8078,
  TEXTURE0: 0x84c0, CLIENT_ACTIVE_TEXTURE: 0x84e1, MAX_TEXTURE_UNITS: 0x84e2, MAX_TEXTURE_COORDS: 0x8871,
  TEXTURE_2D: 0x0de1, ALPHA_TEST: 0x0bc0, FOG: 0x0b60, LIGHTING: 0x0b50, LIGHT0: 0x4000, COLOR_MATERIAL: 0x0b57,
  NORMALIZE: 0x0ba1, RESCALE_NORMAL: 0x803a, TEXTURE_GEN_S: 0x0c60, TEXTURE_GEN_Q: 0x0c63, COLOR_LOGIC_OP: 0x0bf2,
  LINE_STIPPLE: 0x0b24, POLYGON_STIPPLE: 0x0b42, INDEX_LOGIC_OP: 0x0bf1, AUTO_NORMAL: 0x0d80,
  CURRENT_COLOR: 0x0b00, CURRENT_NORMAL: 0x0b02, CURRENT_TEXTURE_COORDS: 0x0b03, SHADE_MODEL: 0x0b54,
  ALPHA_TEST_FUNC: 0x0bc1, ALPHA_TEST_REF: 0x0bc2, LIGHT_MODEL_AMBIENT: 0x0b53,
  FOG_DENSITY: 0x0b62, FOG_START: 0x0b63, FOG_END: 0x0b64, FOG_MODE: 0x0b65, FOG_COLOR: 0x0b66,
  LINEAR: 0x2601, EXP: 0x0800, EXP2: 0x0801, FOG_DISTANCE_MODE_NV: 0x855a, EYE_RADIAL_NV: 0x855b,
  EYE_PLANE_ABSOLUTE_NV: 0x855c, EYE_PLANE: 0x2502,
  AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, SPOT_DIRECTION: 0x1204,
  EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602, FLAT: 0x1d00, SMOOTH: 0x1d01,
  TEXTURE_ENV: 0x2300, TEXTURE_ENV_MODE: 0x2200, TEXTURE_ENV_COLOR: 0x2201,
  MODULATE: 0x2100, DECAL: 0x2101, BLEND: 0x0be2, ADD: 0x0104, REPLACE: 0x1e01, COMBINE: 0x8570,
  COMBINE_RGB: 0x8571, COMBINE_ALPHA: 0x8572, RGB_SCALE: 0x8573, ADD_SIGNED: 0x8574, INTERPOLATE: 0x8575,
  CONSTANT: 0x8576, PRIMARY_COLOR: 0x8577, PREVIOUS: 0x8578, SUBTRACT: 0x84e7, DOT3_RGB: 0x86ae, DOT3_RGBA: 0x86af,
  ALPHA_SCALE: 0x0d1c, SOURCE0_RGB: 0x8580, SOURCE0_ALPHA: 0x8588, OPERAND0_RGB: 0x8590, OPERAND0_ALPHA: 0x8598,
  SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
  TEXTURE_GEN_MODE: 0x2500, OBJECT_PLANE: 0x2501, OBJECT_LINEAR: 0x2401, EYE_LINEAR: 0x2400, SPHERE_MAP: 0x2402,
  S: 0x2000, Q: 0x2003, COMPILE: 0x1300, COMPILE_AND_EXECUTE: 0x1301,
  NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  ENABLE_BIT: 0x2000, LIGHTING_BIT: 0x40, CURRENT_BIT: 0x1, FOG_BIT: 0x80, TEXTURE_BIT: 0x40000, TRANSFORM_BIT: 0x1000,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
};
const UNITS = 4; // texture units the fixed-function pipeline offers
const LIGHTS = 8;
const TYPE_SIZE = { [C.BYTE]: 1, [C.UNSIGNED_BYTE]: 1, [C.SHORT]: 2, [C.UNSIGNED_SHORT]: 2, [C.INT]: 4, [C.UNSIGNED_INT]: 4, [C.FLOAT]: 4, [C.HALF_FLOAT]: 2, [C.DOUBLE]: 8 };
// Attribute locations of the generated programs.
const LOC_VERTEX = 0;
const LOC_COLOR = 1;
const LOC_NORMAL = 2;
const LOC_TEX = 3; // + unit

// ---------------------------------------------------------------------------
// 4x4 column-major matrices
// ---------------------------------------------------------------------------
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const tmp = new Float32Array(16);
function multiply(a, b, out) { // out = a * b (out may alias a)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) tmp[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  out.set(tmp);
  return out;
}
function rotation(angle, x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  x /= len; y /= len; z /= len;
  const r = (angle * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  return new Float32Array([
    x * x * t + c, y * x * t + z * s, z * x * t - y * s, 0,
    x * y * t - z * s, y * y * t + c, z * y * t + x * s, 0,
    x * z * t + y * s, y * z * t - x * s, z * z * t + c, 0,
    0, 0, 0, 1,
  ]);
}
function invert(m, out = new Float32Array(16)) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out.fill(0);
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
/** Inverse transpose of the upper 3x3 (the normal matrix), column-major. */
function normalMatrix(m, out) {
  const inv = invert(m);
  out[0] = inv[0]; out[1] = inv[4]; out[2] = inv[8];
  out[3] = inv[1]; out[4] = inv[5]; out[5] = inv[9];
  out[6] = inv[2]; out[7] = inv[6]; out[8] = inv[10];
  return out;
}
const transform4 = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);

/**
 * Installs the fixed-function entry points into GL (the object of gl.js) and wraps the draw
 * calls. `h` holds gl.js helpers: floatView, writeFloats, writeInts, isView, warnOnce.
 */
export function installFixedFunction(S, GL, h) {
  const gl = () => S.gl;
  const { floatView, writeFloats, writeInts, isView, warnOnce } = h;
  const doubles = (src, n) => {
    if (isView(src)) return Array.from(src.subarray(0, n));
    sync();
    const p = ptr(src) >> 3;
    return Array.from(F64.subarray(p, p + n));
  };
  const floats = (src, n) => Array.from(floatView(src, n));

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const newArray = () => ({ enabled: false, size: 4, type: C.FLOAT, stride: 0, pointer: 0, buffer: 0 });
  const genDefaults = () => ['s', 't', 'r', 'q'].map((c, i) => ({
    on: false, mode: C.EYE_LINEAR, object: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, 0, 0], eye: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, 0, 0],
  }));
  const envDefaults = () => ({
    mode: C.MODULATE, color: [0, 0, 0, 0], rgb: C.MODULATE, alpha: C.MODULATE,
    src: [C.TEXTURE, C.PREVIOUS, C.CONSTANT, C.TEXTURE, C.PREVIOUS, C.CONSTANT],
    op: [C.SRC_COLOR, C.SRC_COLOR, C.SRC_ALPHA, C.SRC_ALPHA, C.SRC_ALPHA, C.SRC_ALPHA],
    rgbScale: 1, alphaScale: 1,
  });
  const lightDefaults = (i) => ({
    on: false, position: [0, 0, 1, 0], ambient: [0, 0, 0, 1],
    diffuse: i === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1], specular: i === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1],
  });
  const F = {
    mode: C.MODELVIEW,
    modelview: [identity()],
    projection: [identity()],
    texture: Array.from({ length: UNITS }, () => [identity()]),
    color: [1, 1, 1, 1],
    normal: [0, 0, 1],
    texcoord: Array.from({ length: UNITS }, () => [0, 0, 0, 1]),
    clientUnit: 0,
    vertex: newArray(),
    colors: newArray(),
    normals: newArray(),
    texcoords: Array.from({ length: UNITS }, newArray),
    tex2d: new Array(UNITS).fill(false),
    texgen: Array.from({ length: UNITS }, genDefaults),
    env: Array.from({ length: UNITS }, envDefaults),
    alphaTest: false,
    alphaFunc: C.ALWAYS,
    alphaRef: 0,
    fog: false,
    fogMode: C.EXP,
    fogDensity: 1,
    fogStart: 0,
    fogEnd: 1,
    fogColor: [0, 0, 0, 0],
    fogDistance: C.EYE_PLANE_ABSOLUTE_NV,
    lighting: false,
    lights: Array.from({ length: LIGHTS }, (_, i) => lightDefaults(i)),
    lightModelAmbient: [0.2, 0.2, 0.2, 1],
    colorMaterial: false,
    colorMaterialMode: C.AMBIENT_AND_DIFFUSE,
    material: { ambient: [0.2, 0.2, 0.2, 1], diffuse: [0.8, 0.8, 0.8, 1], emission: [0, 0, 0, 1] },
    flat: false,
    logicOp: false,
    // bumped when the matching uniforms must be uploaded again
    mvVersion: 1,
    projVersion: 1,
    texVersion: new Array(UNITS).fill(1),
    paramVersion: 1,
    keyDirty: true,
  };
  const params = () => { F.paramVersion++; F.keyDirty = true; };

  // -------------------------------------------------------------------------
  // Matrices
  // -------------------------------------------------------------------------
  const stack = () => (F.mode === C.MODELVIEW ? F.modelview : F.mode === C.PROJECTION ? F.projection : F.texture[S.activeUnit] || F.texture[0]);
  const top = () => { const s = stack(); return s[s.length - 1]; };
  const changed = () => {
    if (F.mode === C.MODELVIEW) F.mvVersion++;
    else if (F.mode === C.PROJECTION) F.projVersion++;
    else F.texVersion[S.activeUnit] = (F.texVersion[S.activeUnit] || 0) + 1;
  };
  const mult = (m) => { multiply(top(), m, top()); changed(); };
  GL.glMatrixMode = (mode) => { F.mode = mode; };
  GL.glLoadIdentity = () => { top().set(identity()); changed(); };
  GL.glPushMatrix = () => { const s = stack(); s.push(new Float32Array(s[s.length - 1])); };
  GL.glPopMatrix = () => { const s = stack(); if (s.length > 1) { s.pop(); changed(); } };
  GL.glLoadMatrixf = (m) => { top().set(floats(m, 16)); changed(); };
  GL.glLoadMatrixd = (m) => { top().set(doubles(m, 16)); changed(); };
  GL.glMultMatrixf = (m) => mult(new Float32Array(floats(m, 16)));
  GL.glMultMatrixd = (m) => mult(new Float32Array(doubles(m, 16)));
  GL.glLoadTransposeMatrixf = (m) => { const a = floats(m, 16); top().set([0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => a[i])); changed(); };
  GL.glTranslatef = (x, y, z) => {
    const m = top();
    for (let r = 0; r < 4; r++) m[12 + r] += m[r] * x + m[4 + r] * y + m[8 + r] * z;
    changed();
  };
  GL.glTranslated = GL.glTranslatef;
  GL.glScalef = (x, y, z) => {
    const m = top();
    for (let r = 0; r < 4; r++) { m[r] *= x; m[4 + r] *= y; m[8 + r] *= z; }
    changed();
  };
  GL.glScaled = GL.glScalef;
  GL.glRotatef = (angle, x, y, z) => mult(rotation(angle, x, y, z));
  GL.glRotated = GL.glRotatef;
  GL.glOrtho = (l, r, b, t, n, f) => mult(new Float32Array([
    2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ]));
  GL.glFrustum = (l, r, b, t, n, f) => mult(new Float32Array([
    (2 * n) / (r - l), 0, 0, 0, 0, (2 * n) / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0,
  ]));

  // -------------------------------------------------------------------------
  // Current vertex attributes
  // -------------------------------------------------------------------------
  const ub = (v) => (v & 255) / 255;
  GL.glColor4f = (r, g, b, a) => { F.color = [r, g, b, a]; };
  GL.glColor3f = (r, g, b) => { F.color = [r, g, b, 1]; };
  GL.glColor4d = GL.glColor4f;
  GL.glColor3d = GL.glColor3f;
  GL.glColor4ub = (r, g, b, a) => { F.color = [ub(r), ub(g), ub(b), ub(a)]; };
  GL.glColor3ub = (r, g, b) => { F.color = [ub(r), ub(g), ub(b), 1]; };
  GL.glColor4fv = (v) => { F.color = floats(v, 4); };
  GL.glColor3fv = (v) => { F.color = [...floats(v, 3), 1]; };
  GL.glNormal3f = (x, y, z) => { F.normal = [x, y, z]; };
  GL.glNormal3d = GL.glNormal3f;
  GL.glNormal3b = (x, y, z) => { F.normal = [x / 127, y / 127, z / 127]; };
  GL.glTexCoord2f = (s, t) => { F.texcoord[0] = [s, t, 0, 1]; };
  GL.glTexCoord2d = GL.glTexCoord2f;
  GL.glMultiTexCoord2f = (target, s, t) => { F.texcoord[(target - C.TEXTURE0) & 3] = [s, t, 0, 1]; };
  GL.glMultiTexCoord2d = GL.glMultiTexCoord2f;

  // -------------------------------------------------------------------------
  // Client arrays
  // -------------------------------------------------------------------------
  function setArray(a, size, type, stride, pointer) {
    a.size = size;
    a.type = type;
    a.stride = stride || size * (TYPE_SIZE[type] || 4);
    a.buffer = S.bound[C.ARRAY_BUFFER] > 0 ? S.bound[C.ARRAY_BUFFER] : 0;
    a.pointer = isView(pointer) ? 0 : Number(ptr(pointer));
    if (isView(pointer)) warnOnce('array-pointer', 'Java arrays as vertex array pointers are not supported');
  }
  GL.glVertexPointer = (size, type, stride, pointer) => setArray(F.vertex, size, type, stride, pointer);
  GL.glColorPointer = (size, type, stride, pointer) => setArray(F.colors, size, type, stride, pointer);
  GL.glNormalPointer = (type, stride, pointer) => setArray(F.normals, 3, type, stride, pointer);
  GL.glTexCoordPointer = (size, type, stride, pointer) => setArray(F.texcoords[F.clientUnit], size, type, stride, pointer);
  GL.glClientActiveTexture = (unit) => { F.clientUnit = (unit - C.TEXTURE0) & 3; };
  const clientArray = (cap) => {
    switch (cap) {
      case C.VERTEX_ARRAY: return F.vertex;
      case C.COLOR_ARRAY: return F.colors;
      case C.NORMAL_ARRAY: return F.normals;
      case C.TEXTURE_COORD_ARRAY: return F.texcoords[F.clientUnit];
      default: return null;
    }
  };
  GL.glEnableClientState = (cap) => { const a = clientArray(cap); if (a) a.enabled = true; };
  GL.glDisableClientState = (cap) => { const a = clientArray(cap); if (a) a.enabled = false; };
  const anyClientArray = () => F.vertex.enabled || F.colors.enabled || F.normals.enabled || F.texcoords.some((a) => a.enabled);

  // -------------------------------------------------------------------------
  // Enables
  // -------------------------------------------------------------------------
  function fixedCap(cap, on) {
    if (cap === C.TEXTURE_2D) { F.tex2d[S.activeUnit & 3] = on; F.keyDirty = true; return true; }
    if (cap === C.ALPHA_TEST) { F.alphaTest = on; F.keyDirty = true; return true; }
    if (cap === C.FOG) { F.fog = on; F.keyDirty = true; return true; }
    if (cap === C.LIGHTING) { F.lighting = on; F.keyDirty = true; return true; }
    if (cap === C.COLOR_MATERIAL) { F.colorMaterial = on; F.keyDirty = true; return true; }
    if (cap >= C.LIGHT0 && cap < C.LIGHT0 + LIGHTS) { F.lights[cap - C.LIGHT0].on = on; F.keyDirty = true; return true; }
    if (cap >= C.TEXTURE_GEN_S && cap <= C.TEXTURE_GEN_Q) { F.texgen[S.activeUnit & 3][cap - C.TEXTURE_GEN_S].on = on; F.keyDirty = true; return true; }
    if (cap === C.COLOR_LOGIC_OP) { F.logicOp = on; return true; }
    return cap === C.NORMALIZE || cap === C.RESCALE_NORMAL || cap === C.LINE_STIPPLE || cap === C.POLYGON_STIPPLE
      || cap === C.INDEX_LOGIC_OP || cap === C.AUTO_NORMAL;
  }
  function fixedEnabled(cap) {
    if (cap === C.TEXTURE_2D) return F.tex2d[S.activeUnit & 3];
    if (cap === C.ALPHA_TEST) return F.alphaTest;
    if (cap === C.FOG) return F.fog;
    if (cap === C.LIGHTING) return F.lighting;
    if (cap === C.COLOR_MATERIAL) return F.colorMaterial;
    if (cap >= C.LIGHT0 && cap < C.LIGHT0 + LIGHTS) return F.lights[cap - C.LIGHT0].on;
    if (cap >= C.TEXTURE_GEN_S && cap <= C.TEXTURE_GEN_Q) return F.texgen[S.activeUnit & 3][cap - C.TEXTURE_GEN_S].on;
    if (cap === C.COLOR_LOGIC_OP) return F.logicOp;
    const a = clientArray(cap);
    return a ? a.enabled : undefined;
  }
  const baseEnable = GL.glEnable;
  const baseDisable = GL.glDisable;
  const baseIsEnabled = GL.glIsEnabled;
  GL.glEnable = (cap) => { if (!fixedCap(cap, true)) baseEnable(cap); };
  GL.glDisable = (cap) => { if (!fixedCap(cap, false)) baseDisable(cap); };
  GL.glIsEnabled = (cap) => { const v = fixedEnabled(cap); return v === undefined ? baseIsEnabled(cap) : v; };

  // -------------------------------------------------------------------------
  // Alpha test, shading, fog, lighting, materials
  // -------------------------------------------------------------------------
  GL.glAlphaFunc = (func, ref) => { F.alphaFunc = func; F.alphaRef = ref; params(); };
  GL.glShadeModel = (mode) => { F.flat = mode === C.FLAT; F.keyDirty = true; };
  function fog(pname, values) {
    switch (pname) {
      case C.FOG_MODE: F.fogMode = values[0]; break;
      case C.FOG_DENSITY: F.fogDensity = values[0]; break;
      case C.FOG_START: F.fogStart = values[0]; break;
      case C.FOG_END: F.fogEnd = values[0]; break;
      case C.FOG_COLOR: F.fogColor = values.slice(0, 4); break;
      case C.FOG_DISTANCE_MODE_NV: F.fogDistance = values[0]; break;
      default: return;
    }
    params();
  }
  GL.glFogf = (pname, v) => fog(pname, [v]);
  GL.glFogi = GL.glFogf;
  GL.glFogfv = (pname, v) => fog(pname, floats(v, pname === C.FOG_COLOR ? 4 : 1));
  GL.glFogiv = (pname, v) => fog(pname, Array.from(h.intView(v, pname === C.FOG_COLOR ? 4 : 1)).map((x) => (pname === C.FOG_COLOR ? x / 2147483647 : x)));
  function light(index, pname, values) {
    const l = F.lights[(index - C.LIGHT0) & 7];
    switch (pname) {
      case C.AMBIENT: l.ambient = values.slice(0, 4); break;
      case C.DIFFUSE: l.diffuse = values.slice(0, 4); break;
      case C.SPECULAR: l.specular = values.slice(0, 4); break;
      // Positions are stored in eye coordinates, transformed by the current modelview matrix.
      case C.POSITION: l.position = transform4(F.modelview[F.modelview.length - 1], values); break;
      default: return;
    }
    params();
  }
  GL.glLightfv = (index, pname, v) => light(index, pname, floats(v, 4));
  GL.glLightf = (index, pname, v) => light(index, pname, [v]);
  GL.glLighti = GL.glLightf;
  GL.glLightModelfv = (pname, v) => { if (pname === C.LIGHT_MODEL_AMBIENT) { F.lightModelAmbient = floats(v, 4); params(); } };
  GL.glLightModeli = () => undefined;
  GL.glLightModelf = () => undefined;
  function material(pname, values) {
    const m = F.material;
    if (pname === C.AMBIENT || pname === C.AMBIENT_AND_DIFFUSE) m.ambient = values.slice(0, 4);
    if (pname === C.DIFFUSE || pname === C.AMBIENT_AND_DIFFUSE) m.diffuse = values.slice(0, 4);
    if (pname === C.EMISSION) m.emission = values.slice(0, 4);
    params();
  }
  GL.glMaterialfv = (face, pname, v) => material(pname, floats(v, 4));
  GL.glMaterialf = (face, pname, v) => { if (pname !== C.SHININESS) material(pname, [v, v, v, v]); };
  GL.glColorMaterial = (face, mode) => { F.colorMaterialMode = mode; F.keyDirty = true; };

  // -------------------------------------------------------------------------
  // Texture environment and coordinate generation
  // -------------------------------------------------------------------------
  function texEnv(target, pname, values) {
    if (target !== C.TEXTURE_ENV) return; // e.g. GL_TEXTURE_FILTER_CONTROL (LOD bias)
    const e = F.env[S.activeUnit & 3];
    const v = values[0];
    if (pname === C.TEXTURE_ENV_MODE) e.mode = v;
    else if (pname === C.TEXTURE_ENV_COLOR) e.color = values.slice(0, 4);
    else if (pname === C.COMBINE_RGB) e.rgb = v;
    else if (pname === C.COMBINE_ALPHA) e.alpha = v;
    else if (pname === C.RGB_SCALE) e.rgbScale = v;
    else if (pname === C.ALPHA_SCALE) e.alphaScale = v;
    else if (pname >= C.SOURCE0_RGB && pname <= C.SOURCE0_RGB + 2) e.src[pname - C.SOURCE0_RGB] = v;
    else if (pname >= C.SOURCE0_ALPHA && pname <= C.SOURCE0_ALPHA + 2) e.src[3 + pname - C.SOURCE0_ALPHA] = v;
    else if (pname >= C.OPERAND0_RGB && pname <= C.OPERAND0_RGB + 2) e.op[pname - C.OPERAND0_RGB] = v;
    else if (pname >= C.OPERAND0_ALPHA && pname <= C.OPERAND0_ALPHA + 2) e.op[3 + pname - C.OPERAND0_ALPHA] = v;
    else return;
    params();
  }
  GL.glTexEnvi = (target, pname, v) => texEnv(target, pname, [v]);
  GL.glTexEnvf = GL.glTexEnvi;
  GL.glTexEnvfv = (target, pname, v) => texEnv(target, pname, floats(v, pname === C.TEXTURE_ENV_COLOR ? 4 : 1));
  GL.glTexEnviv = (target, pname, v) => texEnv(target, pname, Array.from(h.intView(v, pname === C.TEXTURE_ENV_COLOR ? 4 : 1)));
  function texGen(coord, pname, values) {
    const g = F.texgen[S.activeUnit & 3][(coord - C.S) & 3];
    if (pname === C.TEXTURE_GEN_MODE) g.mode = values[0];
    else if (pname === C.OBJECT_PLANE) g.object = values.slice(0, 4);
    // Eye planes are stored multiplied by the inverse of the modelview matrix at this time.
    else if (pname === C.EYE_PLANE) {
      const inv = invert(F.modelview[F.modelview.length - 1]);
      const p = values;
      g.eye = [0, 1, 2, 3].map((c) => p[0] * inv[c * 4] + p[1] * inv[c * 4 + 1] + p[2] * inv[c * 4 + 2] + p[3] * inv[c * 4 + 3]);
    } else return;
    params();
  }
  GL.glTexGeni = (coord, pname, v) => texGen(coord, pname, [v]);
  GL.glTexGenf = GL.glTexGeni;
  GL.glTexGenfv = (coord, pname, v) => texGen(coord, pname, floats(v, pname === C.TEXTURE_GEN_MODE ? 1 : 4));
  GL.glTexGendv = (coord, pname, v) => texGen(coord, pname, doubles(v, pname === C.TEXTURE_GEN_MODE ? 1 : 4));

  // Not available in WebGL; the rendering differences are minor.
  GL.glLogicOp = () => undefined;
  GL.glPolygonMode = () => undefined;
  GL.glPixelTransferf = () => undefined;
  GL.glPixelTransferi = () => undefined;
  GL.glLineStipple = () => undefined;
  GL.glPointSize = () => undefined;

  // -------------------------------------------------------------------------
  // glPushAttrib / glPopAttrib (the parts Minecraft uses: enables, lighting, colour, fog)
  // -------------------------------------------------------------------------
  const CORE_CAPS = [0x0be2 /* BLEND */, 0x0b44 /* CULL_FACE */, 0x0b71 /* DEPTH_TEST */, 0x8037 /* POLYGON_OFFSET_FILL */, 0x0c11 /* SCISSOR_TEST */, 0x0b90 /* STENCIL_TEST */];
  const attribStack = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  GL.glPushAttrib = (mask) => {
    attribStack.push({
      mask,
      core: CORE_CAPS.map((cap) => gl().isEnabled(cap)),
      F: clone({
        tex2d: F.tex2d, alphaTest: F.alphaTest, alphaFunc: F.alphaFunc, alphaRef: F.alphaRef, fog: F.fog, fogMode: F.fogMode,
        fogDensity: F.fogDensity, fogStart: F.fogStart, fogEnd: F.fogEnd, fogColor: F.fogColor, lighting: F.lighting, lights: F.lights,
        lightModelAmbient: F.lightModelAmbient, colorMaterial: F.colorMaterial, colorMaterialMode: F.colorMaterialMode,
        material: F.material, flat: F.flat, color: F.color, normal: F.normal, texgen: F.texgen, env: F.env, logicOp: F.logicOp,
      }),
    });
  };
  GL.glPopAttrib = () => {
    const saved = attribStack.pop();
    if (!saved) return;
    CORE_CAPS.forEach((cap, i) => (saved.core[i] ? gl().enable(cap) : gl().disable(cap)));
    Object.assign(F, saved.F);
    params();
  };
  GL.glPushClientAttrib = () => undefined;
  GL.glPopClientAttrib = () => undefined;

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------
  function fixedQuery(pname) {
    switch (pname) {
      case C.MODELVIEW_MATRIX: return F.modelview[F.modelview.length - 1];
      case C.PROJECTION_MATRIX: return F.projection[F.projection.length - 1];
      case C.TEXTURE_MATRIX: { const s = F.texture[S.activeUnit & 3]; return s[s.length - 1]; }
      case C.MODELVIEW_STACK_DEPTH: return [F.modelview.length];
      case C.PROJECTION_STACK_DEPTH: return [F.projection.length];
      case C.TEXTURE_STACK_DEPTH: return [F.texture[S.activeUnit & 3].length];
      case C.MATRIX_MODE: return [F.mode];
      case C.CURRENT_COLOR: return F.color;
      case C.CURRENT_NORMAL: return F.normal;
      case C.CURRENT_TEXTURE_COORDS: return F.texcoord[S.activeUnit & 3];
      case C.SHADE_MODEL: return [F.flat ? C.FLAT : C.SMOOTH];
      case C.ALPHA_TEST_FUNC: return [F.alphaFunc];
      case C.ALPHA_TEST_REF: return [F.alphaRef];
      case C.FOG_COLOR: return F.fogColor;
      case C.FOG_MODE: return [F.fogMode];
      case C.FOG_START: return [F.fogStart];
      case C.FOG_END: return [F.fogEnd];
      case C.FOG_DENSITY: return [F.fogDensity];
      case C.LIGHT_MODEL_AMBIENT: return F.lightModelAmbient;
      case C.CLIENT_ACTIVE_TEXTURE: return [C.TEXTURE0 + F.clientUnit];
      case C.MAX_TEXTURE_UNITS: case C.MAX_TEXTURE_COORDS: return [UNITS];
      default: return null;
    }
  }
  for (const [name, write] of [['glGetFloatv', writeFloats], ['glGetIntegerv', (o, v) => writeInts(o, v.map(Math.trunc))], ['glGetDoublev', null], ['glGetBooleanv', null]]) {
    const base = GL[name];
    GL[name] = (pname, out) => {
      const v = fixedQuery(pname);
      if (!v) return base(pname, out);
      if (write) return write(out, Array.from(v));
      if (name === 'glGetDoublev') {
        if (isView(out)) Array.from(v).forEach((x, i) => { out[i] = x; });
        else { sync(); Array.from(v).forEach((x, i) => { F64[(ptr(out) >> 3) + i] = x; }); }
      } else if (isView(out)) out[0] = v[0] ? 1 : 0;
      else { sync(); U8[ptr(out)] = v[0] ? 1 : 0; }
      return undefined;
    };
  }
  for (const name of ['glGetFloat', 'glGetInteger']) {
    const base = GL[name];
    GL[name] = (pname) => { const v = fixedQuery(pname); return v ? v[0] : base(pname); };
  }

  // -------------------------------------------------------------------------
  // Generated programs
  // -------------------------------------------------------------------------
  const programs = new Map();
  let stateKey = '';
  let current = null; // the program for stateKey
  const activeUnits = () => {
    const units = [];
    for (let u = 0; u < UNITS; u++) if (F.tex2d[u]) units.push(u);
    return units;
  };
  function computeKey() {
    let k = '';
    for (const u of activeUnits()) {
      const e = F.env[u];
      k += `t${u}${e.mode === C.COMBINE ? `c${e.rgb},${e.alpha},${e.src},${e.op},${e.rgbScale},${e.alphaScale}` : e.mode}`;
      const g = F.texgen[u];
      if (g.some((x) => x.on)) k += `g${g.map((x) => (x.on ? x.mode : 0))}`;
      k += ';';
    }
    if (F.alphaTest && F.alphaFunc !== C.ALWAYS) k += `a${F.alphaFunc};`;
    if (F.fog) k += `f${F.fogMode},${F.fogDistance};`;
    if (F.lighting) k += `l${F.lights.map((l) => (l.on ? 1 : 0)).join('')},${F.colorMaterial ? F.colorMaterialMode : 0};`;
    if (F.flat) k += 'flat;';
    return k;
  }

  function vertexShader(key) {
    const units = activeUnits();
    const lights = F.lighting ? F.lights.map((l, i) => (l.on ? i : -1)).filter((i) => i >= 0) : [];
    const cm = F.lighting && F.colorMaterial ? F.colorMaterialMode : 0;
    const usesNormal = F.lighting || units.some((u) => F.texgen[u].some((g) => g.on && g.mode === C.SPHERE_MAP));
    const lines = ['#version 300 es', 'precision highp float;',
      `layout(location = ${LOC_VERTEX}) in vec4 a_vertex;`, `layout(location = ${LOC_COLOR}) in vec4 a_color;`,
      'uniform mat4 u_mv;', 'uniform mat4 u_proj;', `${F.flat ? 'flat ' : ''}out vec4 v_color;`];
    if (usesNormal) lines.push(`layout(location = ${LOC_NORMAL}) in vec3 a_normal;`, 'uniform mat3 u_nm;');
    for (const u of units) {
      lines.push(`layout(location = ${LOC_TEX + u}) in vec4 a_tex${u};`, `uniform mat4 u_tm${u};`, `out vec4 v_tc${u};`);
      if (F.texgen[u].some((g) => g.on)) lines.push(`uniform vec4 u_tg${u}[4];`);
    }
    if (F.fog) lines.push('out float v_fog;');
    if (lights.length) {
      lines.push(`uniform vec4 u_lpos[${lights.length}];`, `uniform vec4 u_lamb[${lights.length}];`, `uniform vec4 u_ldif[${lights.length}];`,
        'uniform vec4 u_ambient;', 'uniform vec4 u_matAmb;', 'uniform vec4 u_matDif;', 'uniform vec4 u_matEmi;');
    }
    lines.push('void main() {', '  vec4 eye = u_mv * a_vertex;', '  gl_Position = u_proj * eye;', '  vec4 col = a_color;');
    if (usesNormal) lines.push('  vec3 n = normalize(u_nm * a_normal);');
    if (lights.length) {
      const amb = cm === C.AMBIENT_AND_DIFFUSE || cm === C.AMBIENT ? 'a_color' : 'u_matAmb';
      const dif = cm === C.AMBIENT_AND_DIFFUSE || cm === C.DIFFUSE ? 'a_color' : 'u_matDif';
      const emi = cm === C.EMISSION ? 'a_color' : 'u_matEmi';
      lines.push(`  vec3 lit = ${emi}.rgb + u_ambient.rgb * ${amb}.rgb;`);
      lights.forEach((_, i) => {
        lines.push(`  { vec3 L = u_lpos[${i}].w == 0.0 ? normalize(u_lpos[${i}].xyz) : normalize(u_lpos[${i}].xyz - eye.xyz / eye.w);`,
          `    lit += u_lamb[${i}].rgb * ${amb}.rgb + max(dot(n, L), 0.0) * u_ldif[${i}].rgb * ${dif}.rgb; }`);
      });
      lines.push(`  col = vec4(lit, ${dif}.a);`);
    }
    lines.push('  v_color = clamp(col, 0.0, 1.0);');
    for (const u of units) {
      const g = F.texgen[u];
      if (g.some((x) => x.on)) {
        lines.push(`  vec4 tc${u} = a_tex${u};`);
        if (g.some((x) => x.on && x.mode === C.SPHERE_MAP)) {
          lines.push('  vec3 sr = reflect(normalize(eye.xyz), n);', '  float sm = 2.0 * sqrt(sr.x * sr.x + sr.y * sr.y + (sr.z + 1.0) * (sr.z + 1.0));');
        }
        g.forEach((x, c) => {
          if (!x.on) return;
          const comp = 'xyzw'[c];
          if (x.mode === C.OBJECT_LINEAR) lines.push(`  tc${u}.${comp} = dot(u_tg${u}[${c}], a_vertex);`);
          else if (x.mode === C.SPHERE_MAP) lines.push(`  tc${u}.${comp} = ${c === 0 ? 'sr.x' : 'sr.y'} / sm + 0.5;`);
          else lines.push(`  tc${u}.${comp} = dot(u_tg${u}[${c}], eye);`);
        });
        lines.push(`  v_tc${u} = u_tm${u} * tc${u};`);
      } else lines.push(`  v_tc${u} = u_tm${u} * a_tex${u};`);
    }
    if (F.fog) {
      lines.push(F.fogDistance === C.EYE_RADIAL_NV ? '  v_fog = length(eye.xyz);' : F.fogDistance === C.EYE_PLANE ? '  v_fog = -eye.z;' : '  v_fog = abs(eye.z);');
    }
    lines.push('}');
    void key;
    return lines.join('\n');
  }

  function combineArg(u, i, alpha, texels) {
    const e = F.env[u];
    const src = e.src[i + (alpha ? 3 : 0)];
    const op = e.op[i + (alpha ? 3 : 0)];
    let x;
    if (src === C.TEXTURE) x = `t${u}`;
    else if (src >= C.TEXTURE0 && src < C.TEXTURE0 + UNITS) x = texels.has(src - C.TEXTURE0) ? `t${src - C.TEXTURE0}` : 'vec4(1.0)';
    else if (src === C.CONSTANT) x = `u_env${u}`;
    else if (src === C.PRIMARY_COLOR) x = 'primary';
    else x = 'prev';
    if (alpha) return op === C.ONE_MINUS_SRC_ALPHA ? `(1.0 - ${x}.a)` : `${x}.a`;
    switch (op) {
      case C.ONE_MINUS_SRC_COLOR: return `(1.0 - ${x}.rgb)`;
      case C.SRC_ALPHA: return `vec3(${x}.a)`;
      case C.ONE_MINUS_SRC_ALPHA: return `vec3(1.0 - ${x}.a)`;
      default: return `${x}.rgb`;
    }
  }
  function combine(u, alpha, texels) {
    const e = F.env[u];
    const fn = alpha ? e.alpha : e.rgb;
    const a = (i) => combineArg(u, i, alpha, texels);
    switch (fn) {
      case C.REPLACE: return a(0);
      case C.ADD: return `(${a(0)} + ${a(1)})`;
      case C.ADD_SIGNED: return `(${a(0)} + ${a(1)} - 0.5)`;
      case C.INTERPOLATE: return `mix(${a(1)}, ${a(0)}, ${a(2)})`;
      case C.SUBTRACT: return `(${a(0)} - ${a(1)})`;
      case C.DOT3_RGB: case C.DOT3_RGBA: {
        const d = `(4.0 * dot(${combineArg(u, 0, false, texels)} - 0.5, ${combineArg(u, 1, false, texels)} - 0.5))`;
        return alpha ? d : `vec3${d}`;
      }
      default: return `(${a(0)} * ${a(1)})`;
    }
  }
  function fragmentShader() {
    const units = activeUnits();
    const texels = new Set(units);
    const lines = ['#version 300 es', 'precision highp float;', `${F.flat ? 'flat ' : ''}in vec4 v_color;`, 'out vec4 o_color;'];
    for (const u of units) lines.push(`in vec4 v_tc${u};`, `uniform sampler2D u_s${u};`, `uniform vec4 u_env${u};`);
    if (F.alphaTest && F.alphaFunc !== C.ALWAYS) lines.push('uniform float u_alphaRef;');
    if (F.fog) lines.push('in float v_fog;', 'uniform vec4 u_fogColor;', 'uniform vec3 u_fog;');
    lines.push('void main() {', '  vec4 primary = v_color;', '  vec4 prev = primary;');
    for (const u of units) lines.push(`  vec4 t${u} = texture(u_s${u}, v_tc${u}.xy / v_tc${u}.w);`);
    for (const u of units) {
      const e = F.env[u];
      switch (e.mode) {
        case C.REPLACE: lines.push(`  prev = t${u};`); break;
        case C.ADD: lines.push(`  prev = vec4(prev.rgb + t${u}.rgb, prev.a * t${u}.a);`); break;
        case C.DECAL: lines.push(`  prev = vec4(mix(prev.rgb, t${u}.rgb, t${u}.a), prev.a);`); break;
        case C.BLEND: lines.push(`  prev = vec4(mix(prev.rgb, u_env${u}.rgb, t${u}.rgb), prev.a * t${u}.a);`); break;
        case C.COMBINE:
          lines.push(`  prev = clamp(vec4(${combine(u, false, texels)} * ${(+e.rgbScale || 1).toFixed(1)}, ${combine(u, true, texels)} * ${(+e.alphaScale || 1).toFixed(1)}), 0.0, 1.0);`);
          break;
        default: lines.push(`  prev = prev * t${u};`);
      }
    }
    lines.push('  vec4 c = prev;');
    if (F.fog) {
      const f = F.fogMode === C.LINEAR ? '(u_fog.y - v_fog) / max(u_fog.y - u_fog.x, 1e-5)'
        : F.fogMode === C.EXP2 ? 'exp(-(u_fog.z * v_fog) * (u_fog.z * v_fog))' : 'exp(-u_fog.z * v_fog)';
      lines.push(`  c.rgb = mix(u_fogColor.rgb, c.rgb, clamp(${f}, 0.0, 1.0));`);
    }
    if (F.alphaTest && F.alphaFunc !== C.ALWAYS) {
      const cmp = { [C.NEVER]: 'false', [C.LESS]: 'c.a < u_alphaRef', [C.EQUAL]: 'c.a == u_alphaRef', [C.LEQUAL]: 'c.a <= u_alphaRef',
        [C.GREATER]: 'c.a > u_alphaRef', [C.NOTEQUAL]: 'c.a != u_alphaRef', [C.GEQUAL]: 'c.a >= u_alphaRef' }[F.alphaFunc] || 'true';
      lines.push(`  if (!(${cmp})) discard;`);
    }
    lines.push('  o_color = c;', '}');
    return lines.join('\n');
  }

  function compile(type, source) {
    const g = gl();
    const shader = g.createShader(type);
    g.shaderSource(shader, source);
    g.compileShader(shader);
    if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) console.warn('[lwjgl-web] fixed-function shader failed:', g.getShaderInfoLog(shader), '\n', source);
    return shader;
  }
  function programFor(key) {
    let p = programs.get(key);
    if (p) return p;
    const g = gl();
    const program = g.createProgram();
    const vs = compile(g.VERTEX_SHADER, vertexShader(key));
    const fs = compile(g.FRAGMENT_SHADER, fragmentShader());
    g.attachShader(program, vs);
    g.attachShader(program, fs);
    g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) console.warn('[lwjgl-web] fixed-function program failed:', g.getProgramInfoLog(program));
    g.deleteShader(vs);
    g.deleteShader(fs);
    const units = activeUnits();
    const loc = (n) => g.getUniformLocation(program, n);
    p = {
      program,
      units,
      lights: F.lighting ? F.lights.map((l, i) => (l.on ? i : -1)).filter((i) => i >= 0) : [],
      usesNormal: F.lighting || units.some((u) => F.texgen[u].some((x) => x.on && x.mode === C.SPHERE_MAP)),
      texgen: units.filter((u) => F.texgen[u].some((x) => x.on)),
      u: {
        mv: loc('u_mv'), proj: loc('u_proj'), nm: loc('u_nm'), alphaRef: loc('u_alphaRef'), fogColor: loc('u_fogColor'), fog: loc('u_fog'),
        lpos: loc('u_lpos'), lamb: loc('u_lamb'), ldif: loc('u_ldif'), ambient: loc('u_ambient'),
        matAmb: loc('u_matAmb'), matDif: loc('u_matDif'), matEmi: loc('u_matEmi'),
        tm: units.map((u) => loc(`u_tm${u}`)), env: units.map((u) => loc(`u_env${u}`)), tg: units.map((u) => loc(`u_tg${u}`)),
      },
      mv: 0, proj: 0, tex: new Array(UNITS).fill(0), param: 0,
    };
    g.useProgram(program);
    units.forEach((u) => g.uniform1i(loc(`u_s${u}`), u));
    programs.set(key, p);
    return p;
  }

  const nm = new Float32Array(9);
  function uploadUniforms(p) {
    const g = gl();
    const u = p.u;
    if (p.mv !== F.mvVersion) {
      const mv = F.modelview[F.modelview.length - 1];
      g.uniformMatrix4fv(u.mv, false, mv);
      if (p.usesNormal) g.uniformMatrix3fv(u.nm, false, normalMatrix(mv, nm));
      p.mv = F.mvVersion;
    }
    if (p.proj !== F.projVersion) {
      g.uniformMatrix4fv(u.proj, false, F.projection[F.projection.length - 1]);
      p.proj = F.projVersion;
    }
    p.units.forEach((unit, i) => {
      if (p.tex[unit] !== F.texVersion[unit]) {
        const s = F.texture[unit];
        g.uniformMatrix4fv(u.tm[i], false, s[s.length - 1]);
        p.tex[unit] = F.texVersion[unit];
      }
    });
    if (p.param !== F.paramVersion) {
      if (u.alphaRef) g.uniform1f(u.alphaRef, F.alphaRef);
      if (u.fogColor) {
        g.uniform4fv(u.fogColor, F.fogColor);
        g.uniform3f(u.fog, F.fogStart, F.fogEnd, F.fogDensity);
      }
      if (p.lights.length) {
        g.uniform4fv(u.lpos, p.lights.flatMap((i) => F.lights[i].position));
        g.uniform4fv(u.lamb, p.lights.flatMap((i) => F.lights[i].ambient));
        g.uniform4fv(u.ldif, p.lights.flatMap((i) => F.lights[i].diffuse));
        g.uniform4fv(u.ambient, F.lightModelAmbient);
        g.uniform4fv(u.matAmb, F.material.ambient);
        g.uniform4fv(u.matDif, F.material.diffuse);
        g.uniform4fv(u.matEmi, F.material.emission);
      }
      p.units.forEach((unit, i) => {
        if (u.env[i]) g.uniform4fv(u.env[i], F.env[unit].color);
        if (u.tg[i]) g.uniform4fv(u.tg[i], F.texgen[unit].flatMap((x) => (x.mode === C.OBJECT_LINEAR ? x.object : x.eye)));
      });
      p.param = F.paramVersion;
    }
  }

  // -------------------------------------------------------------------------
  // Vertex data: client memory is copied into a streaming buffer per draw
  // -------------------------------------------------------------------------
  let vao = null;
  let stream = null;
  let streamSize = 0;
  let streamOffset = 0;
  let quadIndices = null;
  let quadCapacity = 0;
  let indexStream = null;
  let vaoElements = null; // the buffer bound to ELEMENT_ARRAY_BUFFER in our VAO
  function ensureObjects() {
    const g = gl();
    if (vao) return;
    vao = g.createVertexArray();
    stream = g.createBuffer();
    indexStream = g.createBuffer();
    quadIndices = g.createBuffer();
  }
  /** Copies [address, address + length) to the stream buffer; returns its offset there. */
  function upload(address, length) {
    const g = gl();
    g.bindBuffer(C.ARRAY_BUFFER, stream);
    const align = address & 3;
    let at = ((streamOffset + 3) & ~3) + align;
    if (at + length > streamSize) {
      streamSize = Math.max(streamSize, 8 << 20);
      while (streamSize < length + 8) streamSize *= 2;
      g.bufferData(C.ARRAY_BUFFER, streamSize, C.STREAM_DRAW);
      at = align;
    }
    sync();
    g.bufferSubData(C.ARRAY_BUFFER, at, U8, address, length);
    streamOffset = at + length;
    return at;
  }
  function bindElements(buffer) {
    if (vaoElements !== buffer) {
      gl().bindBuffer(C.ELEMENT_ARRAY_BUFFER, buffer);
      vaoElements = buffer;
    }
  }
  function ensureQuads(quads) {
    const g = gl();
    bindElements(quadIndices);
    if (quads <= quadCapacity) return;
    quadCapacity = Math.max(quads, quadCapacity * 2, 16384);
    const idx = new Uint32Array(quadCapacity * 6);
    for (let q = 0, i = 0; q < quadCapacity; q++, i += 6) {
      const v = q * 4;
      // Both triangles end on the quad's 4th vertex, its provoking vertex for flat shading.
      idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 3;
      idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }
    g.bufferData(C.ELEMENT_ARRAY_BUFFER, idx, C.STATIC_DRAW);
  }

  /**
   * Points attribute locations at the enabled arrays for vertices [first, first + count).
   * `targets` maps array -> attribute location. Returns false when there is nothing to draw.
   */
  function bindArrays(targets, first, count) {
    const g = gl();
    let lo = Infinity;
    let hi = 0;
    for (const [a] of targets) {
      if (!a.enabled || a.buffer) continue;
      const start = a.pointer + first * a.stride;
      lo = Math.min(lo, start);
      hi = Math.max(hi, start + (count - 1) * a.stride + a.size * (TYPE_SIZE[a.type] || 4));
    }
    const base = lo < hi ? upload(lo, hi - lo) : 0;
    for (const [a, loc, normalizedType] of targets) {
      if (!a.enabled) continue;
      if (a.type === C.DOUBLE) {
        warnOnce('double-array', 'GL_DOUBLE vertex arrays are not supported');
        continue;
      }
      const normalized = normalizedType && a.type !== C.FLOAT && a.type !== C.HALF_FLOAT;
      if (a.buffer) {
        g.bindBuffer(C.ARRAY_BUFFER, S.buffers.get(a.buffer) || null);
        g.vertexAttribPointer(loc, a.size, a.type, normalized, a.stride, a.pointer + first * a.stride);
      } else {
        g.bindBuffer(C.ARRAY_BUFFER, stream);
        g.vertexAttribPointer(loc, a.size, a.type, normalized, a.stride, base + (a.pointer + first * a.stride - lo));
      }
      g.enableVertexAttribArray(loc);
    }
    return true;
  }
  function restoreBindings() {
    const g = gl();
    g.bindBuffer(C.ARRAY_BUFFER, S.buffers.get(S.bound[C.ARRAY_BUFFER]) || null);
    g.bindVertexArray(S.vertexArrays.get(S.vertexArray) || null);
  }

  /** Issues the draw, turning quads, quad strips and polygons into what WebGL draws. */
  function drawPrimitive(mode, count) {
    const g = gl();
    if (mode === C.QUADS) {
      const quads = Math.floor(count / 4);
      if (!quads) return;
      ensureQuads(quads);
      g.drawElements(C.TRIANGLES, quads * 6, C.UNSIGNED_INT, 0);
    } else if (mode === C.QUAD_STRIP) g.drawArrays(C.TRIANGLE_STRIP, 0, count);
    else if (mode === C.POLYGON) g.drawArrays(C.TRIANGLE_FAN, 0, count);
    else g.drawArrays(mode, 0, count);
  }

  function fixedTargets(p) {
    const targets = [[F.vertex, LOC_VERTEX, false], [F.colors, LOC_COLOR, true]];
    if (p.usesNormal) targets.push([F.normals, LOC_NORMAL, true]);
    for (const u of p.units) targets.push([F.texcoords[u], LOC_TEX + u, false]);
    return targets;
  }
  /** Current values for attributes without an enabled array. */
  function constantAttributes(p) {
    const g = gl();
    if (!F.colors.enabled) { g.disableVertexAttribArray(LOC_COLOR); g.vertexAttrib4f(LOC_COLOR, F.color[0], F.color[1], F.color[2], F.color[3]); }
    if (p.usesNormal && !F.normals.enabled) { g.disableVertexAttribArray(LOC_NORMAL); g.vertexAttrib3f(LOC_NORMAL, F.normal[0], F.normal[1], F.normal[2]); }
    for (const u of p.units) {
      if (!F.texcoords[u].enabled) {
        const t = F.texcoord[u];
        g.disableVertexAttribArray(LOC_TEX + u);
        g.vertexAttrib4f(LOC_TEX + u, t[0], t[1], t[2], t[3]);
      }
    }
  }
  function useFixedProgram() {
    if (F.keyDirty) {
      stateKey = computeKey();
      F.keyDirty = false;
      current = null;
    }
    if (!current) current = programFor(stateKey);
    gl().useProgram(current.program);
    uploadUniforms(current);
    return current;
  }
  function fixedDraw(mode, first, count) {
    ensureObjects();
    const g = gl();
    const p = useFixedProgram();
    g.bindVertexArray(vao);
    for (let loc = 0; loc < LOC_TEX + UNITS; loc++) g.disableVertexAttribArray(loc);
    if (!F.vertex.enabled) { restoreBindings(); return; }
    bindArrays(fixedTargets(p), first, count);
    constantAttributes(p);
    drawPrimitive(mode, count);
    restoreBindings();
  }

  // User programs fed by client arrays (1.13 - 1.16 post-processing shaders): arrays are bound to
  // the program's attributes by name.
  const programAttributes = new Map();
  function attributeTargets(id) {
    let names = programAttributes.get(id);
    if (!names) {
      const g = gl();
      const program = S.programs.get(id);
      const find = (...candidates) => {
        for (const n of candidates) {
          const loc = g.getAttribLocation(program, n);
          if (loc >= 0) return loc;
        }
        return -1;
      };
      names = {
        vertex: find('Position', 'webmc_Position', 'position', 'a_position', 'Vertex'),
        color: find('Color', 'color', 'a_color'),
        normal: find('Normal', 'normal'),
        tex: [find('UV0', 'UV', 'TexCoord', 'texCoord', 'a_texCoord'), find('UV1'), find('UV2'), -1],
      };
      if (names.vertex < 0 && g.getProgramParameter(program, g.ACTIVE_ATTRIBUTES) === 1) names.vertex = g.getActiveAttrib(program, 0) ? g.getAttribLocation(program, g.getActiveAttrib(program, 0).name) : -1;
      programAttributes.set(id, names);
    }
    const targets = [];
    if (names.vertex >= 0) targets.push([F.vertex, names.vertex, false]);
    if (names.color >= 0) targets.push([F.colors, names.color, true]);
    if (names.normal >= 0) targets.push([F.normals, names.normal, true]);
    names.tex.forEach((loc, u) => { if (loc >= 0) targets.push([F.texcoords[u], loc, false]); });
    return targets;
  }
  function programClientDraw(mode, first, count) {
    ensureObjects();
    const g = gl();
    g.bindVertexArray(vao);
    for (let loc = 0; loc < 16; loc++) g.disableVertexAttribArray(loc);
    bindArrays(attributeTargets(S.program), first, count);
    drawPrimitive(mode, count);
    restoreBindings();
  }

  // -------------------------------------------------------------------------
  // Display lists: state calls are recorded, draws are snapshotted into buffers
  // -------------------------------------------------------------------------
  const lists = new Map();
  let nextList = 1;
  let listBase = 0;
  let compiling = null;
  const RECORDED = ['glMatrixMode', 'glLoadIdentity', 'glPushMatrix', 'glPopMatrix', 'glLoadMatrixf', 'glMultMatrixf', 'glTranslatef',
    'glTranslated', 'glScalef', 'glScaled', 'glRotatef', 'glRotated', 'glColor4f', 'glColor3f', 'glColor4ub', 'glColor3ub', 'glColor4fv',
    'glNormal3f', 'glNormal3b', 'glTexCoord2f', 'glMultiTexCoord2f', 'glEnable', 'glDisable', 'glBindTexture', 'glAlphaFunc',
    'glBlendFunc', 'glShadeModel', 'glDepthMask', 'glCullFace', 'glLightfv', 'glMaterialfv', 'glTexEnvi', 'glTexEnvf', 'glFogf', 'glFogi'];
  const POINTER_ARGS = { glLoadMatrixf: [0, 16], glMultMatrixf: [0, 16], glColor4fv: [0, 4], glLightfv: [2, 4], glMaterialfv: [2, 4] };
  for (const name of RECORDED) {
    const impl = GL[name];
    if (!impl) continue;
    GL[name] = (...args) => {
      if (!compiling) return impl(...args);
      const copied = args.slice();
      const pointer = POINTER_ARGS[name];
      if (pointer) copied[pointer[0]] = new Float32Array(floats(args[pointer[0]], pointer[1]));
      compiling.commands.push({ fn: impl, args: copied });
      if (compiling.mode === C.COMPILE_AND_EXECUTE) impl(...copied);
      return undefined;
    };
  }
  /** Copies the vertices of a draw out of the current arrays (client memory or VBOs). */
  function snapshot(mode, first, count) {
    const arrays = [['vertex', F.vertex], ['color', F.colors], ['normal', F.normals], ...F.texcoords.map((a, u) => [`tex${u}`, a])]
      .filter(([, a]) => a.enabled);
    if (!arrays.length || !F.vertex.enabled) return null;
    const stride = arrays[0][1].stride;
    const sameStride = arrays.every(([, a]) => a.stride === stride && !a.buffer);
    const starts = arrays.map(([, a]) => a.pointer + first * a.stride);
    const lo = Math.min(...starts);
    const interleaved = sameStride && starts.every((s) => s - lo < stride);
    const hi = interleaved ? lo + count * stride
      : Math.max(...arrays.map(([, a], i) => starts[i] + (count - 1) * a.stride + a.size * (TYPE_SIZE[a.type] || 4)));
    let bytes;
    if (arrays.some(([, a]) => a.buffer)) {
      // VBO-backed arrays in a display list: read the data back once, at compile time.
      const g = gl();
      const [, a] = arrays[0];
      bytes = new Uint8Array(count * a.stride);
      g.bindBuffer(C.ARRAY_BUFFER, S.buffers.get(a.buffer) || null);
      g.getBufferSubData(C.ARRAY_BUFFER, a.pointer + first * a.stride, bytes);
      g.bindBuffer(C.ARRAY_BUFFER, S.buffers.get(S.bound[C.ARRAY_BUFFER]) || null);
      return { mode, count, bytes, interleaved: false, layout: arrays.map(([key, x]) => ({ key, size: x.size, type: x.type, stride: x.stride, offset: x.pointer - a.pointer })) };
    }
    sync();
    bytes = U8.slice(lo, hi);
    return { mode, count, bytes, interleaved, stride, layout: arrays.map(([key, a], i) => ({ key, size: a.size, type: a.type, stride: a.stride, offset: starts[i] - lo })) };
  }
  /** Merges consecutive interleaved draws with the same layout (one model part = one draw). */
  function finishList(commands) {
    const out = [];
    for (const c of commands) {
      const last = out[out.length - 1];
      if (c.draw && last?.draw && c.draw.interleaved && last.draw.interleaved && c.draw.mode === last.draw.mode
        && (c.draw.mode === C.QUADS || c.draw.mode === C.TRIANGLES) && c.draw.stride === last.draw.stride
        && JSON.stringify(c.draw.layout) === JSON.stringify(last.draw.layout)) {
        const merged = new Uint8Array(last.draw.bytes.length + c.draw.bytes.length);
        merged.set(last.draw.bytes);
        merged.set(c.draw.bytes, last.draw.bytes.length);
        last.draw.bytes = merged;
        last.draw.count += c.draw.count;
        continue;
      }
      out.push(c);
    }
    const g = gl();
    for (const c of out) {
      if (!c.draw) continue;
      c.draw.buffer = g.createBuffer();
      g.bindBuffer(C.ARRAY_BUFFER, c.draw.buffer);
      g.bufferData(C.ARRAY_BUFFER, c.draw.bytes, C.STATIC_DRAW);
      delete c.draw.bytes;
    }
    g.bindBuffer(C.ARRAY_BUFFER, S.buffers.get(S.bound[C.ARRAY_BUFFER]) || null);
    return out;
  }
  function drawSnapshot(d) {
    ensureObjects();
    const g = gl();
    const saved = { vertex: F.vertex, colors: F.colors, normals: F.normals, texcoords: F.texcoords };
    // Present the snapshot as arrays sourced from its own buffer.
    const asArray = (key) => {
      const l = d.layout.find((x) => x.key === key);
      return l ? { enabled: true, size: l.size, type: l.type, stride: l.stride, pointer: l.offset, buffer: -1, gl: d.buffer } : { ...newArray() };
    };
    F.vertex = asArray('vertex');
    F.colors = asArray('color');
    F.normals = asArray('normal');
    F.texcoords = F.texcoords.map((_, u) => asArray(`tex${u}`));
    const p = S.program ? null : useFixedProgram();
    g.bindVertexArray(vao);
    for (let loc = 0; loc < 16; loc++) g.disableVertexAttribArray(loc);
    const targets = p ? fixedTargets(p) : attributeTargets(S.program);
    for (const [a, loc, normalizedType] of targets) {
      if (!a.enabled) continue;
      g.bindBuffer(C.ARRAY_BUFFER, a.gl);
      g.vertexAttribPointer(loc, a.size, a.type, normalizedType && a.type !== C.FLOAT, a.stride, a.pointer);
      g.enableVertexAttribArray(loc);
    }
    if (p) constantAttributes(p);
    drawPrimitive(d.mode, d.count);
    Object.assign(F, saved);
    restoreBindings();
  }
  function runList(id) {
    const list = lists.get(id);
    if (!list) return;
    for (const c of list) {
      if (c.draw) drawSnapshot(c.draw);
      else if (c.list !== undefined) runList(c.list);
      else c.fn(...c.args);
    }
  }
  GL.glGenLists = (range) => { const first = nextList; nextList += Math.max(1, range); return first; };
  GL.glIsList = (id) => lists.has(id);
  GL.glNewList = (id, mode) => { compiling = { id, mode, commands: [] }; };
  GL.glEndList = () => {
    if (!compiling) return;
    const c = compiling;
    compiling = null;
    const old = lists.get(c.id);
    if (old) for (const x of old) if (x.draw?.buffer) gl().deleteBuffer(x.draw.buffer);
    lists.set(c.id, finishList(c.commands));
  };
  GL.glCallList = (id) => {
    if (compiling) { compiling.commands.push({ list: id }); if (compiling.mode !== C.COMPILE_AND_EXECUTE) return; }
    runList(id);
  };
  GL.glListBase = (base) => { listBase = base; };
  GL.glCallLists = (n, type, ids) => {
    const values = type === C.UNSIGNED_BYTE || type === C.BYTE ? Array.from(h.bytesAt(ids, n))
      : type === C.UNSIGNED_SHORT || type === C.SHORT ? (sync(), Array.from(U16.subarray(ptr(ids) >> 1, (ptr(ids) >> 1) + n)))
        : Array.from(h.intView(ids, n));
    for (const v of values) GL.glCallList(listBase + v);
  };
  GL.glDeleteLists = (id, range) => {
    for (let i = id; i < id + range; i++) {
      const list = lists.get(i);
      if (list) for (const x of list) if (x.draw?.buffer) gl().deleteBuffer(x.draw.buffer);
      lists.delete(i);
    }
  };

  // -------------------------------------------------------------------------
  // Draw calls
  // -------------------------------------------------------------------------
  const baseDrawArrays = GL.glDrawArrays;
  const baseDrawElements = GL.glDrawElements;
  GL.glDrawArrays = (mode, first, count) => {
    if (compiling) {
      const d = snapshot(mode, first, count);
      if (d) compiling.commands.push({ draw: d });
      if (compiling.mode !== C.COMPILE_AND_EXECUTE) return;
    }
    if (count <= 0) return;
    if (!S.program) fixedDraw(mode, first, count);
    else if (anyClientArray()) programClientDraw(mode, first, count);
    else if (mode === C.QUADS || mode === C.QUAD_STRIP || mode === C.POLYGON) {
      // A user program with its own vertex attributes drawing quads: index through our buffer,
      // then give the game's vertex array object its element buffer back.
      const g = gl();
      ensureObjects();
      const previous = g.getParameter(g.ELEMENT_ARRAY_BUFFER_BINDING);
      const saved = vaoElements;
      vaoElements = null;
      if (mode === C.QUADS) {
        // The shared quad indices count from vertex 0: start at the first vertex's quad.
        const start = Math.floor(first / 4);
        ensureQuads(start + Math.floor(count / 4));
        g.drawElements(C.TRIANGLES, Math.floor(count / 4) * 6, C.UNSIGNED_INT, start * 24);
      } else g.drawArrays(mode === C.QUAD_STRIP ? C.TRIANGLE_STRIP : C.TRIANGLE_FAN, first, count);
      g.bindBuffer(C.ELEMENT_ARRAY_BUFFER, previous);
      vaoElements = saved;
      if (first % 4) warnOnce('quads-first', 'GL_QUADS starting inside a quad in a program draw');
    } else baseDrawArrays(mode, first, count);
  };
  GL.glDrawElements = (mode, count, type, indices) => {
    if (S.program && !anyClientArray() && mode !== C.QUADS) return baseDrawElements(mode, count, type, indices);
    if (count <= 0) return;
    // Fixed-function (or client-array) indexed draw: read the indices, draw the referenced range
    // as a non-indexed draw of the expanded vertices.
    const size = type === C.UNSIGNED_BYTE ? 1 : type === C.UNSIGNED_SHORT ? 2 : 4;
    let list;
    const elementBuffer = S.bound[C.ELEMENT_ARRAY_BUFFER] > 0 ? S.buffers.get(S.bound[C.ELEMENT_ARRAY_BUFFER]) : null;
    if (elementBuffer && !isView(indices)) {
      const bytes = new Uint8Array(count * size);
      gl().getBufferSubData(C.ELEMENT_ARRAY_BUFFER, Number(indices), bytes);
      list = size === 1 ? bytes : size === 2 ? new Uint16Array(bytes.buffer) : new Uint32Array(bytes.buffer);
    } else if (isView(indices)) list = indices;
    else {
      sync();
      const p = ptr(indices);
      list = size === 1 ? U8.slice(p, p + count) : size === 2 ? U16.slice(p >> 1, (p >> 1) + count) : U32.slice(p >> 2, (p >> 2) + count);
    }
    drawIndexed(mode, list);
  };

  /** Indexed draw from client arrays: the referenced vertices are copied out in index order. */
  function drawIndexed(mode, list) {
    const arrays = [F.vertex, F.colors, F.normals, ...F.texcoords].filter((a) => a.enabled);
    if (arrays.some((a) => a.buffer)) {
      warnOnce('ff-elements-vbo', 'glDrawElements with buffer-backed vertex arrays in the fixed-function pipeline is not supported');
      return;
    }
    const n = list.length;
    const blocks = arrays.map((a) => a.size * (TYPE_SIZE[a.type] || 4));
    const total = blocks.reduce((s, b) => s + ((b * n + 3) & ~3), 0);
    const staging = new Uint8Array(total);
    sync();
    const saved = arrays.map((a) => ({ a, pointer: a.pointer, stride: a.stride }));
    let at = 0;
    const offsets = [];
    arrays.forEach((a, k) => {
      const size = blocks[k];
      offsets.push(at);
      for (let i = 0; i < n; i++) {
        const src = a.pointer + list[i] * a.stride;
        staging.set(U8.subarray(src, src + size), at + i * size);
      }
      at += (size * n + 3) & ~3;
    });
    // Upload the staging copy and present each array as tightly packed data inside it.
    ensureObjects();
    const g = gl();
    g.bindBuffer(C.ARRAY_BUFFER, stream);
    let base = (streamOffset + 3) & ~3;
    if (base + total > streamSize) {
      streamSize = Math.max(streamSize, 8 << 20);
      while (streamSize < total + 8) streamSize *= 2;
      g.bufferData(C.ARRAY_BUFFER, streamSize, C.STREAM_DRAW);
      base = 0;
    }
    g.bufferSubData(C.ARRAY_BUFFER, base, staging);
    streamOffset = base + total;
    arrays.forEach((a, k) => { a.pointer = base + offsets[k]; a.stride = blocks[k]; a.buffer = -2; });
    const streamId = -2;
    S.buffers.set(streamId, stream);
    try {
      if (!S.program) fixedDraw(mode, 0, n);
      else programClientDraw(mode, 0, n);
    } finally {
      S.buffers.delete(streamId);
      for (const s of saved) { s.a.pointer = s.pointer; s.a.stride = s.stride; s.a.buffer = 0; }
    }
  }

  return { F, programs };
}
