// shaderc and SPIRV-Cross (spvc) for Minecraft 26.x's shader pipeline, without SPIR-V.
//
// 26.x compiles its GLSL with shaderc into SPIR-V, reads interface variables and bindings with
// SPIRV-Cross reflection, renumbers bindings by writing the Location/Binding/DescriptorSet words
// of the SPIR-V directly (at offsets reflection tells it), and finally has SPIRV-Cross turn the
// SPIR-V back into GLSL for its OpenGL backend, renaming every resource by its slot
// (_vert_input_00, _uniform_00_03, ...). Here the "SPIR-V" is a stand-in module: a SPIR-V
// header, the id of a shader kept in JavaScript, and one word per decoration the game may
// rewrite. Reflection reads the declarations of the preprocessed GLSL, and "decompiling" emits
// that GLSL with the names SPIRV-Cross would have given it; gl.js then translates it to GLSL ES.
import { preprocess, includeNames } from './glsl.js';
import { ptr, sync, U8, U32, malloc, free, readCString, readUtf8, encodeUtf8, getU32 } from './heap.js';
import { outI32, outPointer } from './core.js';
import { defineLibrary } from './registry.js';

// spvc enums (spirv_cross_c.h)
const RESOURCE = { UNIFORM_BUFFER: 1, STAGE_INPUT: 3, STAGE_OUTPUT: 4, SAMPLED_IMAGE: 7, PUSH_CONSTANT: 9 };
const BASETYPE = { BOOLEAN: 2, INT32: 7, UINT32: 8, FP32: 13, FP64: 14, STRUCT: 15, SAMPLED_IMAGE: 17 };
// SPIR-V decorations the game reads or rewrites
const DECORATION = { FLAT: 14, LOCATION: 30, COMPONENT: 31, BINDING: 33, DESCRIPTOR_SET: 34 };
const IMAGE_DIM = { '1D': 0, '2D': 1, '3D': 2, Cube: 3, '2DRect': 4, Buffer: 5, '2DMS': 1 };

const SPIRV_MAGIC = 0x07230203;
const GENERATOR = 0x5745424d; // "WEBM"
const HEADER_WORDS = 7; // magic, version, generator, bound, schema, module, slot count

// ---------------------------------------------------------------------------
// GLSL declarations (after preprocessing)
// ---------------------------------------------------------------------------
// Directives left by the preprocessor (#line) stay with the whitespace.
const TOKEN = /(\s+|#[^\n]*)|([A-Za-z_]\w*)|(\d[\w.]*)|([^\s\w])/gy;

function lex(text) {
  const tokens = [];
  let ws = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    if (m[1] !== undefined) {
      ws += m[1];
      continue;
    }
    tokens.push({ t: m[0], k: m[2] !== undefined ? 'id' : m[3] !== undefined ? 'num' : 'op', ws });
    ws = '';
  }
  tokens.push({ t: '', k: 'eof', ws });
  return tokens;
}

const STORAGE = new Set(['in', 'out', 'uniform', 'buffer', 'const', 'shared', 'attribute', 'varying']);
const OTHER_QUALIFIERS = new Set(['flat', 'smooth', 'noperspective', 'centroid', 'sample', 'invariant', 'precise',
  'highp', 'mediump', 'lowp', 'readonly', 'writeonly', 'coherent', 'volatile', 'restrict', 'patch']);

/** Base type, vector size, columns and image dimension of a GLSL type name. */
export function glslTypeInfo(name) {
  const sampler = /^([iu]?)sampler(1D|2D|3D|Cube|2DRect|Buffer|2DMS)(Array)?(Shadow)?$/.exec(name);
  if (sampler) return { basetype: BASETYPE.SAMPLED_IMAGE, vecsize: 1, columns: 1, imageDim: IMAGE_DIM[sampler[2]] };
  const base = { '': BASETYPE.FP32, i: BASETYPE.INT32, u: BASETYPE.UINT32, b: BASETYPE.BOOLEAN, d: BASETYPE.FP64 };
  const vec = /^([iubd]?)vec([234])$/.exec(name);
  if (vec) return { basetype: base[vec[1]], vecsize: Number(vec[2]), columns: 1 };
  const mat = /^(d?)mat([234])(?:x([234]))?$/.exec(name);
  if (mat) return { basetype: base[mat[1]], vecsize: Number(mat[3] || mat[2]), columns: Number(mat[2]) };
  const scalar = { float: BASETYPE.FP32, int: BASETYPE.INT32, uint: BASETYPE.UINT32, bool: BASETYPE.BOOLEAN, double: BASETYPE.FP64 }[name];
  if (scalar) return { basetype: scalar, vecsize: 1, columns: 1 };
  return { basetype: BASETYPE.STRUCT, vecsize: 1, columns: 1 };
}

/** std140 size and alignment of a member type (for push constant blocks). */
function std140(type, arraySize, structs) {
  let size;
  let align;
  const info = glslTypeInfo(type);
  if (info.basetype === BASETYPE.STRUCT && structs.has(type)) {
    let offset = 0;
    align = 16;
    for (const m of structs.get(type)) {
      const s = std140(m.type, m.array, structs);
      offset = Math.ceil(offset / s.align) * s.align + s.size;
    }
    size = Math.ceil(offset / 16) * 16;
  } else if (info.columns > 1) {
    align = 16;
    size = 16 * info.columns;
  } else {
    const scalar = info.basetype === BASETYPE.FP64 ? 8 : 4;
    align = scalar * (info.vecsize === 3 ? 4 : info.vecsize);
    size = scalar * info.vecsize;
  }
  if (arraySize) {
    const stride = Math.ceil(size / 16) * 16;
    return { size: stride * arraySize, align: 16 };
  }
  return { size, align };
}

/**
 * The global declarations of a preprocessed shader: stage inputs and outputs, uniform blocks,
 * samplers and push constant blocks. `memberTokens` marks tokens inside struct and block
 * bodies (field names there are not renamed).
 */
export function scanDeclarations(tokens) {
  const declarations = [];
  const structs = new Map();
  const memberTokens = new Set();
  let i = 0;
  const t = (o = 0) => tokens[Math.min(i + o, tokens.length - 1)];
  const skipBalanced = (open, close) => {
    let depth = 0;
    for (; t().k !== 'eof'; i++) {
      if (t().t === open) depth++;
      else if (t().t === close && --depth === 0) {
        i++;
        return;
      }
    }
  };
  const arraySuffix = () => {
    const dims = [];
    while (t().t === '[') {
      i++;
      let value = '';
      while (t().t !== ']' && t().k !== 'eof') value += tokens[i++].t;
      i++;
      dims.push(Number.parseInt(value, 10) || 1);
    }
    return dims;
  };
  const members = () => {
    const list = [];
    const start = i;
    i++; // {
    while (t().t !== '}' && t().k !== 'eof') {
      while (OTHER_QUALIFIERS.has(t().t) || (t().t === 'layout' && t(1).t === '(')) {
        if (t().t === 'layout') {
          i++;
          skipBalanced('(', ')');
        } else i++;
      }
      const type = tokens[i++].t;
      for (;;) {
        const name = tokens[i++].t;
        list.push({ type, name, array: arraySuffix().reduce((a, b) => a * b, 0) });
        if (t().t !== ',') break;
        i++;
      }
      if (t().t === ';') i++;
    }
    for (let k = start; k <= i; k++) memberTokens.add(k);
    i++; // }
    return list;
  };

  while (t().k !== 'eof') {
    if (t().t === ';') {
      i++;
      continue;
    }
    if (t().t === 'precision') {
      while (t().t !== ';' && t().k !== 'eof') i++;
      i++;
      continue;
    }
    // qualifiers
    const layout = new Map();
    const words = new Set();
    for (;;) {
      if (t().t === 'layout' && t(1).t === '(') {
        i += 2;
        while (t().t !== ')' && t().k !== 'eof') {
          const key = tokens[i++].t;
          let value = null;
          if (t().t === '=') {
            i++;
            value = '';
            while (t().t !== ',' && t().t !== ')' && t().k !== 'eof') value += tokens[i++].t;
          }
          layout.set(key, value === null ? true : Number.parseInt(value, 10));
          if (t().t === ',') i++;
        }
        i++;
      } else if (STORAGE.has(t().t) || OTHER_QUALIFIERS.has(t().t)) {
        words.add(tokens[i++].t);
      } else break;
    }
    if (t().t === ';') { // e.g. layout(early_fragment_tests) in;
      i++;
      continue;
    }
    if (t().t === 'struct') {
      i++;
      const name = t().k === 'id' ? tokens[i++].t : `struct#${structs.size}`;
      structs.set(name, members());
      // `struct S {...} s;` declarators are rare at global scope; skip them.
      while (t().t !== ';' && t().k !== 'eof') i++;
      i++;
      continue;
    }
    const storage = words.has('uniform') ? 'uniform' : words.has('in') || words.has('attribute') ? 'in' : words.has('out') ? 'out'
      : words.has('buffer') ? 'buffer' : null;
    if (storage && t().k === 'id' && t(1).t === '{') {
      const blockToken = i;
      const block = tokens[i++].t;
      const fields = members();
      let instance = null;
      let instanceToken = -1;
      let dims = [];
      if (t().k === 'id') {
        instanceToken = i;
        instance = tokens[i++].t;
        dims = arraySuffix();
      }
      while (t().t !== ';' && t().k !== 'eof') i++;
      i++;
      declarations.push({ storage, block, blockToken, instance, instanceToken, fields, dims, layout, flat: words.has('flat') });
      continue;
    }
    // type and declarators, or a function
    const type = tokens[i++].t;
    const typeDims = arraySuffix();
    if (t().k !== 'id') { // malformed; resynchronise
      while (t().t !== ';' && t().t !== '{' && t().k !== 'eof') i++;
      if (t().t === '{') skipBalanced('{', '}');
      else i++;
      continue;
    }
    if (t(1).t === '(') { // function prototype or definition
      i++;
      skipBalanced('(', ')');
      if (t().t === '{') skipBalanced('{', '}');
      else i++;
      continue;
    }
    for (;;) {
      const nameToken = i;
      const name = tokens[i++].t;
      const dims = [...typeDims, ...arraySuffix()];
      if (t().t === '=') { // initializer
        let depth = 0;
        for (i++; t().k !== 'eof'; i++) {
          const s = t().t;
          if (s === '(' || s === '[' || s === '{') depth++;
          else if (s === ')' || s === ']' || s === '}') depth--;
          else if (depth === 0 && (s === ',' || s === ';')) break;
        }
      }
      if (storage && !words.has('const')) {
        declarations.push({ storage, type, name, nameToken, dims, layout, flat: words.has('flat') });
      }
      if (t().t !== ',') break;
      i++;
    }
    while (t().t !== ';' && t().k !== 'eof') i++;
    i++;
  }
  return { declarations, structs, memberTokens };
}

// ---------------------------------------------------------------------------
// Modules: what shaderc_compile_into_spv produced
// ---------------------------------------------------------------------------
const modules = [];
const types = new Map(); // type handle -> { basetype, vecsize, columns, dims, imageDim, size }
let nextType = 0x100;

function newType(info) {
  const handle = nextType++;
  types.set(handle, info);
  return handle;
}

/**
 * Builds the module for preprocessed GLSL `text` of `stage`: its resources (with ids, types and
 * the decoration slots the stand-in SPIR-V carries) and the initial slot values.
 */
export function buildModule(text, stage) {
  const tokens = lex(text);
  const { declarations, structs, memberTokens } = scanDeclarations(tokens);
  const resources = [];
  const slots = [];
  let nextId = 1;
  let nextBinding = 0;
  const slot = (value) => slots.push(value | 0) - 1;
  for (const d of declarations) {
    if (d.storage === 'in' || d.storage === 'out') {
      if (d.block) continue; // interface blocks are not used by the game's shaders
      const info = glslTypeInfo(d.type);
      const base = newType({ ...info, dims: [] });
      resources.push({
        kind: d.storage === 'in' ? RESOURCE.STAGE_INPUT : RESOURCE.STAGE_OUTPUT,
        id: nextId++, name: d.name, tokens: [d.nameToken], flat: d.flat,
        typeId: d.dims.length ? newType({ ...info, dims: d.dims }) : base, baseTypeId: base,
        location: slot(d.layout.get('location') ?? 0),
      });
    } else if (d.storage === 'uniform' && d.block) {
      const pushConstant = d.layout.get('push_constant') === true;
      let size = 0;
      for (const f of d.fields) {
        const s = std140(f.type, f.array, structs);
        size = Math.ceil(size / s.align) * s.align + s.size;
      }
      const base = newType({ basetype: BASETYPE.STRUCT, vecsize: 1, columns: 1, dims: [], size: Math.ceil(size / 16) * 16 });
      const resource = {
        kind: pushConstant ? RESOURCE.PUSH_CONSTANT : RESOURCE.UNIFORM_BUFFER,
        id: nextId++, blockId: nextId++, name: d.block, instance: d.instance, flat: false,
        tokens: [d.blockToken], instanceTokens: d.instanceToken >= 0 ? [d.instanceToken] : [],
        typeId: d.dims.length ? newType({ ...types.get(base), dims: d.dims }) : base, baseTypeId: base,
      };
      if (!pushConstant) {
        resource.set = slot(d.layout.get('set') ?? 0);
        resource.binding = slot(d.layout.get('binding') ?? nextBinding++);
      }
      resources.push(resource);
    } else if (d.storage === 'uniform') {
      const info = glslTypeInfo(d.type);
      if (info.basetype !== BASETYPE.SAMPLED_IMAGE) continue; // plain uniforms are not part of the game's shaders
      const base = newType({ ...info, dims: [] });
      resources.push({
        kind: RESOURCE.SAMPLED_IMAGE,
        id: nextId++, name: d.name, tokens: [d.nameToken], flat: false,
        typeId: d.dims.length ? newType({ ...info, dims: d.dims }) : base, baseTypeId: base,
        set: slot(d.layout.get('set') ?? 0),
        binding: slot(d.layout.get('binding') ?? nextBinding++),
      });
    }
  }
  // Every other mention of a renamed global (its uses in functions) is renamed with it.
  const byName = new Map();
  for (const r of resources) {
    byName.set(r.name, r);
    if (r.instance) byName.set(`instance:${r.instance}`, r);
  }
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.k !== 'id' || memberTokens.has(k) || (k > 0 && tokens[k - 1].t === '.')) continue;
    const r = byName.get(token.t);
    if (r && r.kind !== RESOURCE.UNIFORM_BUFFER && r.kind !== RESOURCE.PUSH_CONSTANT && !r.tokens.includes(k)) r.tokens.push(k);
    const block = byName.get(`instance:${token.t}`);
    if (block && !block.instanceTokens.includes(k)) block.instanceTokens.push(k);
  }
  const module = { stage, tokens, resources, slots, ids: new Map(resources.flatMap((r) => [[r.id, r], ...(r.blockId ? [[r.blockId, r]] : [])])) };
  modules.push(module);
  return { key: modules.length, module };
}

/** The stand-in SPIR-V words for a module (header, module key, decoration slots). */
export function moduleWords(key, module) {
  return Uint32Array.from([SPIRV_MAGIC, 0x00010500, GENERATOR, 0x1000, 0, key, module.slots.length, ...module.slots]);
}

/** Reads stand-in SPIR-V words back: the module and the current slot values. */
export function parseWords(words) {
  if (words.length < HEADER_WORDS || words[0] !== SPIRV_MAGIC || words[2] !== GENERATOR) return null;
  const module = modules[words[5] - 1];
  if (!module) return null;
  return { module, slots: Int32Array.from(words.subarray(HEADER_WORDS, HEADER_WORDS + words[6])) };
}

/**
 * GLSL for a module with the given slot values and the names set through spvc (by id), in the
 * form SPIRV-Cross would emit for GL 3.3 (with Vulkan built-ins mapped to GL ones).
 */
export function emitGLSL(module, slots, names) {
  const out = module.tokens.map((token) => ({ ...token }));
  for (const r of module.resources) {
    const name = names.get(r.kind === RESOURCE.UNIFORM_BUFFER || r.kind === RESOURCE.PUSH_CONSTANT ? r.blockId : r.id);
    if (name) for (const k of r.tokens) out[k].t = name;
    const instance = r.blockId ? names.get(r.id) : null;
    if (instance && r.instance) for (const k of r.instanceTokens) out[k].t = instance;
  }
  for (let k = 0; k < out.length; k++) {
    const token = out[k];
    if (token.k !== 'id') continue;
    if (token.t === 'gl_VertexIndex') token.t = 'gl_VertexID';
    else if (token.t === 'gl_InstanceIndex') token.t = 'gl_InstanceID';
    else if (token.t === 'layout' && out[k + 1]?.t === '(') {
      // Vulkan-only layout items: descriptor sets, and push constants (emitted as a std140 block).
      let end = k + 2;
      while (end < out.length && out[end].t !== ')') end++;
      const items = [];
      let item = [];
      for (let j = k + 2; j <= end; j++) {
        if (out[j].t === ',' || j === end) {
          if (item.length) items.push(item);
          item = [];
        } else item.push(out[j].t);
      }
      const kept = items.filter((it) => it[0] !== 'set').map((it) => (it[0] === 'push_constant' ? ['std140'] : it).join(' '));
      for (let j = k + 1; j <= end; j++) out[j].t = '';
      token.t = kept.length ? `layout(${kept.join(', ')})` : '';
    }
  }
  void slots;
  return `#version 330 core\n${out.map((token) => token.ws + token.t).join('')}`;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------
const handles = new Map();
let nextHandle = 0x7000;
const newHandle = (object) => {
  const handle = nextHandle++;
  handles.set(handle, object);
  return handle;
};
const get = (handle) => handles.get(ptr(handle));

function heapCopy(bytes) {
  const address = malloc(bytes.length + 1);
  sync();
  U8.set(bytes, address);
  U8[address + bytes.length] = 0;
  return address;
}

// ---------------------------------------------------------------------------
// shaderc
// ---------------------------------------------------------------------------
const INCLUDE_RESULT = { sourceName: 0, sourceNameLength: 4, content: 8, contentLength: 12 };

/**
 * The #include files a source still needs: everything its includes reach (in any branch), minus
 * what the game already supplied. The preprocessor later splices in the ones its active branches
 * include, so include guards work as in shaderc.
 */
function missingIncludes(source, files) {
  const missing = [];
  const queue = includeNames(source);
  const seen = new Set(queue);
  while (queue.length) {
    const name = queue.shift();
    if (!files.has(name)) {
      missing.push(name);
      continue;
    }
    for (const next of includeNames(files.get(name) || '')) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return missing;
}

/** Reads a shaderc_include_result: the file's text, or null for a failed include. */
function readIncludeResult(result) {
  const p = ptr(result);
  if (!p) return null;
  sync();
  const w = p >> 2;
  const sourceName = readUtf8(U32[w + INCLUDE_RESULT.sourceName / 4], U32[w + INCLUDE_RESULT.sourceNameLength / 4]);
  // An empty source name means failure; the content is then the error message.
  return sourceName ? readUtf8(U32[w + INCLUDE_RESULT.content / 4], U32[w + INCLUDE_RESULT.contentLength / 4]) : null;
}

function compileIntoSpv(compiler, sourcePtr, sourceSize, kind, fileNamePtr, entryPointPtr, optionsHandle) {
  const options = get(optionsHandle) || { macros: {}, files: new Map() };
  const fileName = readCString(fileNamePtr) || 'shader';
  const stage = kind === 1 ? 'fragment' : 'vertex';
  const result = { status: 0, bytes: 0, length: 0, error: 0 };
  try {
    const source = readUtf8(sourcePtr, Number(sourceSize));
    const pre = preprocess(source, options.macros, { include: (name) => options.files.get(name) ?? null });
    const errors = pre.warnings.filter((w) => w.startsWith('#error'));
    if (errors.length) throw new Error(errors.join('; '));
    const { key, module } = buildModule(pre.text, stage);
    const words = moduleWords(key, module);
    result.length = words.length * 4;
    result.bytes = malloc(result.length);
    sync();
    U32.set(words, result.bytes >> 2);
  } catch (error) {
    result.status = 3; // shaderc_compilation_status_compilation_error
    result.error = heapCopy(encodeUtf8(`${fileName}: ${error.message}`));
    console.warn('[lwjgl-web] shader compile failed:', fileName, error);
  }
  return newHandle(result);
}

/**
 * JNI natives of webmc.lwjgl.Shaders, which resolves a compile's #include files in Java before
 * calling compile (a native that called the game's include callback itself would lose its
 * result in CheerpJ).
 */
export function shaderNatives() {
  const S = 'Java_webmc_lwjgl_Shaders_';
  return {
    [`${S}nextInclude`]: (lib, optionsHandle, source, length) => {
      const options = get(optionsHandle);
      if (!options) return 0;
      const name = missingIncludes(readUtf8(source, length), options.files)[0];
      if (name === undefined) return 0;
      const request = heapCopy(encodeUtf8(name));
      options.requests.push(request);
      return request;
    },
    [`${S}includeResolved`]: (lib, optionsHandle, request, result) => {
      const options = get(optionsHandle);
      if (options) options.files.set(readCString(request), readIncludeResult(result));
    },
    [`${S}includeResolver`]: (lib, optionsHandle) => get(optionsHandle)?.resolver || 0,
    [`${S}includeUserData`]: (lib, optionsHandle) => get(optionsHandle)?.userData || 0,
    [`${S}compile`]: (lib, compiler, source, length, kind, fileName, entryPoint, optionsHandle) => compileIntoSpv(compiler, source, length, kind, fileName, entryPoint, optionsHandle),
  };
}

function shadercLibrary() {
  const options = () => newHandle({ macros: {}, resolver: 0, releaser: 0, userData: 0, files: new Map(), requests: [] });
  const impls = {
    shaderc_compiler_initialize: () => newHandle({ compiler: true }),
    shaderc_compiler_release: (handle) => { handles.delete(ptr(handle)); },
    shaderc_compile_options_initialize: options,
    shaderc_compile_options_clone: (handle) => newHandle({ ...get(handle), macros: { ...get(handle)?.macros }, files: new Map(get(handle)?.files), requests: [] }),
    shaderc_compile_options_release: (handle) => {
      for (const request of get(handle)?.requests || []) free(request);
      handles.delete(ptr(handle));
    },
    shaderc_compile_options_add_macro_definition: (handle, name, nameLength, value, valueLength) => {
      const o = get(handle);
      if (!o) return;
      const key = readUtf8(name, Number(nameLength));
      o.macros[key] = ptr(value) ? readUtf8(value, Number(valueLength)) : '';
    },
    shaderc_compile_options_set_include_callbacks: (handle, resolver, releaser, userData) => {
      const o = get(handle);
      if (o) Object.assign(o, { resolver: ptr(resolver), releaser: ptr(releaser), userData: ptr(userData) });
    },
    shaderc_compile_into_spv: compileIntoSpv,
    shaderc_result_get_compilation_status: (handle) => get(handle)?.status ?? 1,
    shaderc_result_get_error_message: (handle) => get(handle)?.error || 0,
    shaderc_result_get_bytes: (handle) => get(handle)?.bytes || 0,
    shaderc_result_get_length: (handle) => get(handle)?.length || 0,
    shaderc_result_get_num_warnings: () => 0,
    shaderc_result_get_num_errors: (handle) => (get(handle)?.status ? 1 : 0),
    shaderc_result_release: (handle) => {
      const r = get(handle);
      if (!r) return;
      free(r.bytes);
      free(r.error);
      handles.delete(ptr(handle));
    },
  };
  // Settings that only matter to a real SPIR-V compiler.
  for (const name of ['set_target_env', 'set_target_spirv', 'set_auto_bind_uniforms', 'set_preserve_bindings', 'set_generate_debug_info',
    'set_optimization_level', 'set_source_language', 'set_forced_version_profile', 'set_suppress_warnings', 'set_warnings_as_errors',
    'set_auto_map_locations', 'set_auto_combined_image_sampler', 'set_hlsl_io_mapping', 'set_invert_y', 'set_nan_clamp', 'set_vulkan_rules_relaxed']) {
    impls[`shaderc_compile_options_${name}`] = () => undefined;
  }
  return impls;
}

// ---------------------------------------------------------------------------
// SPIRV-Cross
// ---------------------------------------------------------------------------
const SUCCESS = 0;
const INVALID_SPIRV = -1;
const typeOf = (handle) => types.get(ptr(handle));

function spvcLibrary() {
  const owned = (context, address) => {
    context.allocations.push(address);
    return address;
  };
  const contextOf = (handle) => get(handle)?.context;
  const impls = {
    spvc_get_version: (major, minor, patch) => { outI32(major, 0); outI32(minor, 66); outI32(patch, 0); },
    spvc_get_commit_revision_and_timestamp: () => 0,
    spvc_context_create: (out) => {
      const context = { allocations: [], error: 0 };
      context.context = context;
      outPointer(out, newHandle(context));
      return SUCCESS;
    },
    spvc_context_destroy: (handle) => {
      const context = get(handle);
      if (!context) return;
      for (const address of context.allocations) free(address);
      handles.delete(ptr(handle));
    },
    spvc_context_release_allocations: (handle) => {
      const context = get(handle);
      if (!context) return;
      for (const address of context.allocations.splice(0)) free(address);
    },
    spvc_context_get_last_error_string: (handle) => get(handle)?.error || 0,
    spvc_context_set_error_callback: () => undefined,
    spvc_context_parse_spirv: (handle, spirv, wordCount, out) => {
      const context = get(handle);
      sync();
      const words = U32.subarray(ptr(spirv) >> 2, (ptr(spirv) >> 2) + Number(wordCount));
      const ir = parseWords(words);
      if (!ir) return INVALID_SPIRV;
      outPointer(out, newHandle({ ...ir, context }));
      return SUCCESS;
    },
    spvc_context_create_compiler: (handle, backend, irHandle, captureMode, out) => {
      const ir = get(irHandle);
      if (!ir) return INVALID_SPIRV;
      outPointer(out, newHandle({ ir, context: get(handle), names: new Map(), backend }));
      return SUCCESS;
    },
    spvc_compiler_create_compiler_options: (compiler, out) => {
      outPointer(out, newHandle({ context: contextOf(compiler), values: new Map() }));
      return SUCCESS;
    },
    spvc_compiler_options_set_bool: (options, option, value) => { get(options)?.values.set(option, !!value); return SUCCESS; },
    spvc_compiler_options_set_uint: (options, option, value) => { get(options)?.values.set(option, value); return SUCCESS; },
    spvc_compiler_install_compiler_options: () => SUCCESS,
    spvc_compiler_set_entry_point: () => SUCCESS,
    spvc_compiler_create_shader_resources: (compiler, out) => {
      outPointer(out, newHandle({ compiler: get(compiler), context: contextOf(compiler), lists: new Map() }));
      return SUCCESS;
    },
    spvc_resources_get_resource_list_for_type: (handle, type, listOut, countOut) => {
      const resources = get(handle);
      const { module } = resources.compiler.ir;
      const list = module.resources.filter((r) => r.kind === type);
      let address = 0;
      if (list.length) {
        address = owned(resources.context, malloc(list.length * 16));
        sync();
        list.forEach((r, k) => {
          const p = (address >> 2) + k * 4;
          U32[p] = r.id;
          U32[p + 1] = r.blockId || r.baseTypeId;
          U32[p + 2] = r.blockId ? r.typeId : r.typeId;
          U32[p + 3] = owned(resources.context, heapCopy(encodeUtf8(r.name)));
        });
      }
      outPointer(listOut, address);
      outPointer(countOut, list.length);
      return SUCCESS;
    },
    spvc_compiler_get_decoration: (compiler, id, decoration) => {
      const { ir } = get(compiler);
      const r = ir.module.ids.get(id);
      if (!r) return 0;
      switch (decoration) {
        case DECORATION.LOCATION: return r.location !== undefined ? ir.slots[r.location] : 0;
        case DECORATION.BINDING: return r.binding !== undefined ? ir.slots[r.binding] : 0;
        case DECORATION.DESCRIPTOR_SET: return r.set !== undefined ? ir.slots[r.set] : 0;
        case DECORATION.FLAT: return r.flat ? 1 : 0;
        default: return 0;
      }
    },
    spvc_compiler_has_decoration: (compiler, id, decoration) => {
      const r = get(compiler).ir.module.ids.get(id);
      if (!r) return 0;
      if (decoration === DECORATION.FLAT) return r.flat ? 1 : 0;
      if (decoration === DECORATION.LOCATION) return r.location !== undefined ? 1 : 0;
      if (decoration === DECORATION.BINDING || decoration === DECORATION.DESCRIPTOR_SET) return r.binding !== undefined ? 1 : 0;
      return 0;
    },
    spvc_compiler_get_binary_offset_for_decoration: (compiler, id, decoration, out) => {
      const r = get(compiler).ir.module.ids.get(id);
      const index = !r ? undefined : decoration === DECORATION.LOCATION ? r.location
        : decoration === DECORATION.BINDING ? r.binding : decoration === DECORATION.DESCRIPTOR_SET ? r.set : undefined;
      if (index === undefined) return 0;
      outI32(out, HEADER_WORDS + index);
      return 1;
    },
    spvc_compiler_set_name: (compiler, id, name) => { get(compiler).names.set(id, readCString(name)); },
    spvc_compiler_get_name: (compiler, id) => {
      const c = get(compiler);
      const r = c.ir.module.ids.get(id);
      const name = c.names.get(id) ?? (r ? (id === r.blockId || !r.blockId ? r.name : r.instance || '') : '');
      return owned(c.context, heapCopy(encodeUtf8(name)));
    },
    // spvc_type is a pointer type: handles come back from Java as BigInt.
    spvc_compiler_get_type_handle: (compiler, typeId) => (types.has(typeId) ? typeId : 0),
    spvc_type_get_basetype: (type) => typeOf(type)?.basetype ?? 0,
    spvc_type_get_vector_size: (type) => typeOf(type)?.vecsize ?? 1,
    spvc_type_get_columns: (type) => typeOf(type)?.columns ?? 1,
    spvc_type_get_num_array_dimensions: (type) => typeOf(type)?.dims.length ?? 0,
    spvc_type_get_array_dimension: (type, dimension) => typeOf(type)?.dims[dimension] ?? 0,
    spvc_type_array_dimension_is_literal: () => 1,
    spvc_type_get_image_dimension: (type) => typeOf(type)?.imageDim ?? 0,
    spvc_type_get_image_arrayed: () => 0,
    spvc_type_get_image_multisampled: () => 0,
    spvc_type_get_image_is_depth: () => 0,
    spvc_type_get_bit_width: () => 32,
    spvc_compiler_get_declared_struct_size: (compiler, type, out) => {
      outPointer(out, typeOf(type)?.size ?? 0);
      return SUCCESS;
    },
    spvc_compiler_compile: (compiler, out) => {
      const c = get(compiler);
      const glsl = emitGLSL(c.ir.module, c.ir.slots, c.names);
      outPointer(out, owned(c.context, heapCopy(encodeUtf8(glsl))));
      return SUCCESS;
    },
  };
  return impls;
}

export function defineShaderTools() {
  defineLibrary('shaderc', { aliases: ['libshaderc.so', 'libshaderc_shared.so', 'shaderc_shared'], impls: shadercLibrary(), lenient: true });
  defineLibrary('spirv-cross', { aliases: ['libspirv-cross.so', 'libspirv-cross-c-shared.so', 'spirv-cross-c-shared'], impls: spvcLibrary(), lenient: true });
}

void getU32;
