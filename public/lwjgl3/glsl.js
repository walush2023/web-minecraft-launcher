// GLSL written for desktop OpenGL (1.10 - 4.60) -> GLSL ES 3.00 for WebGL 2.
//
// WebGL 2 only accepts GLSL ES 3.00, which is stricter than the desktop GLSL Minecraft ships:
//  * no implicit int -> float conversions (`ivec2 / 256.0`, `float x = 1;`, `pow(x, 2)`),
//  * no `noperspective`, no `layout(binding = N)`, no locations on varyings,
//  * none of the GLSL 1.10/1.20 names (`attribute`, `varying`, `texture2D`, `gl_FragColor`),
//  * more reserved words (`input`, `output`, `filter`, `sample`, ...).
// The source is preprocessed (macros expanded, conditionals resolved), parsed and type checked.
// Conversions are inserted exactly where desktop GLSL converts implicitly; everything else is
// kept token for token. If the parser meets something it does not understand, only the
// token-level rewrites are applied.

// Qualifiers that only exist from GLSL 4.00 on; in older shaders these words are identifiers.
const GLSL4_QUALIFIERS = new Set(['precise', 'sample', 'patch', 'subroutine', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly']);
const QUALIFIERS = new Set([
  'const', 'in', 'out', 'inout', 'uniform', 'attribute', 'varying', 'buffer', 'shared', 'centroid', 'flat', 'smooth',
  'noperspective', 'invariant', 'highp', 'mediump', 'lowp', ...GLSL4_QUALIFIERS,
]);
// Qualifiers that GLSL ES 3.00 does not have and that can be dropped without changing results.
const DROPPED_QUALIFIERS = new Set(['noperspective', ...GLSL4_QUALIFIERS]);
// Words reserved in GLSL ES 3.00 that desktop GLSL allows as identifiers; they get a prefix.
const ES_RESERVED = new Set([
  'input', 'output', 'filter', 'common', 'partition', 'active', 'resource', 'atomic_uint', 'superp', 'half', 'fixed',
  'long', 'short', 'unsigned', 'hvec2', 'hvec3', 'hvec4', 'fvec2', 'fvec3', 'fvec4', 'sizeof', 'cast', 'namespace',
  'using', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'goto', 'inline', 'noinline', 'public', 'static',
  'extern', 'external', 'interface', 'asm',
]);

/** The name a desktop GLSL identifier has after translation (for uniform and attribute lookups). */
export const esIdentifier = (name) => (ES_RESERVED.has(name) || GLSL4_QUALIFIERS.has(name) ? `webmc_${name}` : name);

const BASIC_TYPES = new Set(['void', 'float', 'int', 'uint', 'bool', 'double']);
const VEC_PREFIX = { float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec', double: 'dvec' };
const PREFIX_BASE = { '': 'float', i: 'int', u: 'uint', b: 'bool', d: 'double' };
for (let n = 2; n <= 4; n++) {
  for (const prefix of Object.values(VEC_PREFIX)) BASIC_TYPES.add(`${prefix}${n}`);
  BASIC_TYPES.add(`mat${n}`);
  BASIC_TYPES.add(`dmat${n}`);
  for (let m = 2; m <= 4; m++) {
    BASIC_TYPES.add(`mat${n}x${m}`);
    BASIC_TYPES.add(`dmat${n}x${m}`);
  }
}
const SAMPLER = /^([iu]?)(sampler|image)(1D|2D|3D|Cube|2DRect|Buffer|2DMS)(Array)?(Shadow)?$/;
const MAT_ALIAS = { mat2x2: 'mat2', mat3x3: 'mat3', mat4x4: 'mat4' };
const SCALAR = { f: 'float', i: 'int', u: 'uint', b: 'bool' };
const GENERIC = new Set(['F', 'I', 'U', 'B']);
// WebGL 2 has no buffer textures: they are emulated with 2D textures this many texels wide.
export const BUFFER_TEXTURE_WIDTH = 2048;
const BUFFER_SAMPLERS = { samplerBuffer: 'sampler2D', isamplerBuffer: 'isampler2D', usamplerBuffer: 'usampler2D' };

const vecType = (base, n) => (n === 1 ? base : `${VEC_PREFIX[base]}${n}`);
const matType = (cols, rows) => (cols === rows ? `mat${cols}` : `mat${cols}x${rows}`);

const infoCache = new Map();
function typeInfo(type) {
  if (!type) return null;
  let info = infoCache.get(type);
  if (info !== undefined) return info;
  info = { struct: true };
  let m;
  if (type.endsWith('[]')) info = { array: true };
  else if (type === 'float' || type === 'int' || type === 'uint' || type === 'bool' || type === 'double') info = { base: type, n: 1 };
  else if ((m = /^([iubd]?)vec([234])$/.exec(type))) info = { base: PREFIX_BASE[m[1]], n: Number(m[2]) };
  else if ((m = /^d?mat([234])(?:x([234]))?$/.exec(type))) {
    info = { base: 'float', matrix: true, cols: Number(m[1]), rows: Number(m[2] || m[1]) };
  } else if ((m = SAMPLER.exec(type))) {
    const dims = m[3] === '3D' ? 3 : m[3] === '1D' || m[3] === 'Buffer' ? 1 : 2;
    const result = m[1] === 'i' ? 'ivec4' : m[1] === 'u' ? 'uvec4' : 'vec4';
    info = { sampler: true, dims, arrayed: !!m[4], shadow: !!m[5], result, buffer: m[3] === 'Buffer' };
  } else if (type === 'void') info = { void: true };
  infoCache.set(type, info);
  return info;
}

/** 0: same type, 1: implicitly convertible (as desktop GLSL allows), -1: not convertible. */
function conversionCost(from, to) {
  if (!from || !to || from === to) return 0;
  const a = typeInfo(from);
  const b = typeInfo(to);
  if (!a || !b || !a.base || !b.base || a.matrix || b.matrix || a.n !== b.n) return -1;
  if (b.base === 'float' && (a.base === 'int' || a.base === 'uint')) return 1;
  if (b.base === 'uint' && a.base === 'int') return 1; // GLSL 4.00
  return -1;
}

// Built-in functions. 'F' = genType (float, vec2-4), 'I' = genIType, 'U' = genUType, 'B' = genBType,
// f/i/u/b = scalars, 'M' = any matrix; generic parameters of one signature share a size.
const BUILTINS = {};
const def = (names, ...sigs) => { for (const name of names.split(' ')) BUILTINS[name] = sigs.map((s) => s.split(/[:,]/)); };
def('radians degrees sin cos tan asin acos sinh cosh tanh asinh acosh atanh exp log exp2 log2 sqrt inversesqrt floor trunc round roundEven ceil fract normalize dFdx dFdy fwidth', 'F:F');
def('atan', 'F:F', 'F:F,F');
def('pow reflect', 'F:F,F');
def('abs sign', 'F:F', 'I:I');
def('mod', 'F:F,F', 'F:F,f');
def('min max', 'F:F,F', 'F:F,f', 'I:I,I', 'I:I,i', 'U:U,U', 'U:U,u');
def('clamp', 'F:F,F,F', 'F:F,f,f', 'I:I,I,I', 'I:I,i,i', 'U:U,U,U', 'U:U,u,u');
def('mix', 'F:F,F,F', 'F:F,F,f', 'F:F,F,B');
def('step', 'F:F,F', 'F:f,F');
def('smoothstep', 'F:F,F,F', 'F:f,f,F');
def('fma', 'F:F,F,F');
def('isnan isinf', 'B:F');
def('floatBitsToInt', 'I:F');
def('floatBitsToUint', 'U:F');
def('intBitsToFloat', 'F:I');
def('uintBitsToFloat', 'F:U');
def('packSnorm2x16 packUnorm2x16 packHalf2x16', 'u:vec2');
def('unpackSnorm2x16 unpackUnorm2x16 unpackHalf2x16', 'vec2:u');
def('length', 'f:F');
def('distance dot', 'f:F,F');
def('cross', 'vec3:vec3,vec3');
def('faceforward', 'F:F,F,F');
def('refract', 'F:F,F,f');
def('matrixCompMult', 'M:M,M');
def('inverse', 'M:M');
def('determinant', 'f:M');
def('lessThan lessThanEqual greaterThan greaterThanEqual', 'B:F,F', 'B:I,I', 'B:U,U');
def('equal notEqual', 'B:F,F', 'B:I,I', 'B:U,U', 'B:B,B');
def('any all', 'b:B');
def('not', 'B:B');
const TEXTURE_FUNCTIONS = new Set([
  'texture', 'textureProj', 'textureLod', 'textureOffset', 'textureProjOffset', 'textureLodOffset', 'textureProjLod',
  'textureProjLodOffset', 'textureGrad', 'textureGradOffset', 'textureProjGrad', 'textureProjGradOffset', 'texelFetch',
  'texelFetchOffset', 'textureSize',
]);
// Desktop GLSL 1.10/1.20 texture functions and their GLSL 1.30+ names.
const LEGACY_TEXTURE = {
  texture1D: 'texture', texture2D: 'texture', texture3D: 'texture', textureCube: 'texture', shadow2D: 'texture',
  texture2DLod: 'textureLod', texture3DLod: 'textureLod', textureCubeLod: 'textureLod', shadow2DLod: 'textureLod',
  texture2DProj: 'textureProj', texture2DProjLod: 'textureProjLod', texture2DGradARB: 'textureGrad', texture2DLodEXT: 'textureLod',
  // EXT_gpu_shader4 names
  texture2DLodOffset: 'textureLodOffset', texture2DOffset: 'textureOffset', texture2DGrad: 'textureGrad', texelFetch2D: 'texelFetch',
};

const BUILTIN_VARIABLES = {
  vertex: { gl_Position: 'vec4', gl_PointSize: 'float', gl_VertexID: 'int', gl_InstanceID: 'int' },
  fragment: { gl_FragCoord: 'vec4', gl_FrontFacing: 'bool', gl_PointCoord: 'vec2', gl_FragDepth: 'float', webmc_FragColor: 'vec4' },
};

// ---------------------------------------------------------------------------
// Preprocessor
// ---------------------------------------------------------------------------
const PP_TOKEN = /[A-Za-z_]\w*|\.?[0-9](?:[eE][+-]|[\w.])*|##|&&|\|\||==|!=|<=|>=|<<|>>|\s+|[^\s]/g;
const ppLex = (text) => text.match(PP_TOKEN) || [];
const isSpace = (t) => /^\s/.test(t);

function trimTokens(list) {
  let a = 0;
  let b = list.length;
  while (a < b && isSpace(list[a])) a++;
  while (b > a && isSpace(list[b - 1])) b--;
  return list.slice(a, b);
}

function pasteTokens(list) {
  if (!list.includes('##')) return list;
  const out = [];
  for (let k = 0; k < list.length; k++) {
    if (list[k] !== '##') { out.push(list[k]); continue; }
    while (out.length && isSpace(out[out.length - 1])) out.pop();
    let j = k + 1;
    while (j < list.length && isSpace(list[j])) j++;
    if (out.length && j < list.length) out[out.length - 1] += list[j];
    k = j;
  }
  return out;
}

function expandTokens(tokens, macros, hide, depth = 0) {
  if (depth > 64) return tokens;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const macro = !hide.has(t) && /^[A-Za-z_]/.test(t) ? macros.get(t) : undefined;
    if (!macro) {
      out.push(t);
      continue;
    }
    if (!macro.params) {
      out.push(...expandTokens(macro.body, macros, new Set(hide).add(t), depth + 1));
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && isSpace(tokens[j])) j++;
    if (tokens[j] !== '(') {
      out.push(t);
      continue;
    }
    const args = [];
    let current = [];
    let level = 0;
    let k = j + 1;
    for (; k < tokens.length; k++) {
      const a = tokens[k];
      if (a === '(') level++;
      else if (a === ')') {
        if (level === 0) break;
        level--;
      } else if (a === ',' && level === 0) {
        args.push(current);
        current = [];
        continue;
      }
      current.push(a);
    }
    if (k >= tokens.length) {
      out.push(t);
      continue;
    }
    args.push(current);
    const values = args.map((a) => expandTokens(trimTokens(a), macros, hide, depth + 1));
    const body = macro.body.flatMap((b) => {
      const p = macro.params.indexOf(b);
      return p >= 0 ? values[p] || [] : [b];
    });
    out.push(...expandTokens(pasteTokens(body), macros, new Set(hide).add(t), depth + 1));
    i = k;
  }
  return out;
}

function evalCondition(expression, macros) {
  const replaced = expression.replace(/\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g, (m, a, b) => (macros.has(a || b) ? ' 1 ' : ' 0 '));
  const tokens = expandTokens(ppLex(replaced), macros, new Set()).filter((t) => !isSpace(t));
  let p = 0;
  const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  const value = (t) => {
    if (t === undefined) return 0;
    if (/^[A-Za-z_]/.test(t)) return t === 'true' ? 1 : 0;
    const m = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/.exec(t);
    if (!m) return 0;
    return /^0[xX]/.test(m[1]) ? parseInt(m[1], 16) : m[1].length > 1 && m[1][0] === '0' ? parseInt(m[1], 8) : Number(m[1]);
  };
  const unary = () => {
    const t = tokens[p++];
    if (t === '(') {
      const v = binary(0);
      p++;
      return v;
    }
    if (t === '!') return unary() ? 0 : 1;
    if (t === '-') return -unary();
    if (t === '+') return unary();
    if (t === '~') return ~unary();
    return value(t);
  };
  const apply = (op, a, b) => {
    switch (op) {
      case '||': return a || b ? 1 : 0;
      case '&&': return a && b ? 1 : 0;
      case '|': return a | b;
      case '^': return a ^ b;
      case '&': return a & b;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '<<': return a << b;
      case '>>': return a >> b;
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b ? Math.trunc(a / b) : 0;
      default: return b ? a % b : 0;
    }
  };
  function binary(min) {
    let left = unary();
    for (;;) {
      const op = tokens[p];
      const prec = PREC[op];
      if (prec === undefined || prec < min) break;
      p++;
      left = apply(op, left, binary(prec + 1));
    }
    if (min === 0 && tokens[p] === '?') {
      p++;
      const a = binary(0);
      p++;
      const b = binary(0);
      return left ? a : b;
    }
    return left;
  }
  return binary(0) !== 0;
}

// Line continuations and comments go first (a comment may span lines).
const stripComments = (source) => source.replace(/\r\n?/g, '\n').replace(/\\\n/g, '')
  .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m[1] === '/' ? '' : m.replace(/[^\n]/g, '') || ' '));

/** The names in a source's #include directives (in any branch). */
export function includeNames(source) {
  return [...stripComments(source).matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\n]*)[>"]/gm)].map((m) => m[1]);
}

/**
 * Resolves directives; returns the expanded text with the same line structure (included files
 * add their lines). `include(name)` returns the text of an #include target, or null.
 */
export function preprocess(source, defines = {}, { include = null } = {}) {
  const text = stripComments(source);
  const macros = new Map();
  const define = (name, value) => macros.set(name, { params: null, body: ppLex(String(value)) });
  for (const [name, value] of Object.entries(defines)) define(name, value);
  define('__FILE__', 0);
  define('__LINE__', 0);
  let version = 110;
  let profile = '';
  const extensions = [];
  const warnings = [];
  const out = [];
  let pending = [];
  const stack = [];
  const active = () => stack.every((s) => s.active);
  const flush = () => {
    if (pending.length) out.push(expandTokens(ppLex(pending.join('\n')), macros, new Set()).join(''));
    pending = [];
  };
  const lines = text.split('\n');
  let includes = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const m = /^\s*#\s*(\w*)\s*(.*?)\s*$/.exec(line);
    if (!m) {
      pending.push(active() ? line : '');
      continue;
    }
    const [, directive, rest] = m;
    if (directive === 'include' && include && active()) {
      // The included lines are processed next, as if they stood here (include guards work as usual).
      const target = /^[<"]([^>"]*)[>"]/.exec(rest);
      const content = target && includes < 256 ? include(target[1]) : null;
      if (content === null || content === undefined) warnings.push(`#error cannot include ${rest}`);
      else {
        includes++;
        lines.splice(li + 1, 0, ...stripComments(content).split('\n'));
      }
      pending.push('');
      continue;
    }
    const on = active();
    switch (directive) {
      case 'if':
        stack.push({ active: on && evalCondition(rest, macros), taken: false });
        stack[stack.length - 1].taken = stack[stack.length - 1].active || !on;
        break;
      case 'ifdef':
      case 'ifndef': {
        const name = rest.split(/\s/)[0];
        const value = on && macros.has(name) === (directive === 'ifdef');
        stack.push({ active: value, taken: value || !on });
        break;
      }
      case 'elif': {
        const top = stack[stack.length - 1];
        if (!top) break;
        stack.pop();
        const parent = active();
        if (top.taken) top.active = false;
        else {
          top.active = parent && evalCondition(rest, macros);
          top.taken = top.active;
        }
        stack.push(top);
        break;
      }
      case 'else': {
        const top = stack[stack.length - 1];
        if (top) {
          top.active = !top.taken;
          top.taken = true;
        }
        break;
      }
      case 'endif':
        stack.pop();
        break;
      default:
        if (!on) break;
        if (directive === 'define' || directive === 'undef') {
          flush();
          const d = /^([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*(.*)$/.exec(rest);
          if (!d) break;
          if (directive === 'undef') macros.delete(d[1]);
          else {
            const params = d[2] === undefined ? null : d[2].split(',').map((s) => s.trim()).filter(Boolean);
            macros.set(d[1], { params, body: ppLex(d[3]) });
          }
        } else if (directive === 'version') {
          const v = /^(\d+)\s*(\w*)/.exec(rest);
          if (v) {
            version = Number(v[1]);
            profile = v[2] || '';
            define('__VERSION__', version);
            if (profile === 'core') define('GL_core_profile', 1);
            if (profile === 'compatibility') define('GL_compatibility_profile', 1);
          }
        } else if (directive === 'extension') {
          extensions.push(rest);
        } else if (directive === 'line') {
          pending.push(`#line ${rest}`);
          continue;
        } else if (directive === 'error') {
          warnings.push(`#error ${rest}`);
        } else if (directive) {
          warnings.push(`ignored #${directive}`);
        }
    }
    pending.push('');
  }
  flush();
  return { text: out.join('\n'), version, profile, extensions, warnings };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const TOKEN = /(\s+|#[^\n]*)|([A-Za-z_]\w*)|(0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?(?:[fF]|lf|LF)?|\d+[eE][+-]?\d+(?:[fF]|lf|LF)?|\d+(?:[uU]|[fF]|lf|LF)?)|(<<=|>>=|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\^\^|[-+*/%&|^]=|[-+*/%<>=!~&|^?:;,.(){}[\]])|([^])/gy;

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
    const token = { t: m[0], k: 'op', ws, pre: '', post: '' };
    ws = '';
    if (m[2] !== undefined) token.k = 'id';
    else if (m[3] !== undefined) {
      token.k = 'num';
      let t = m[3];
      if (/(lf|LF)$/.test(t)) t = t.slice(0, -2);
      if (/^\d+[fF]$/.test(t)) t = `${t.slice(0, -1)}.0`; // `1f` is not valid GLSL, though desktop drivers accept it
      token.t = t;
      token.type = /^0[xX]/.test(t) ? (/[uU]$/.test(t) ? 'uint' : 'int') : /[.eEfF]/.test(t) ? 'float' : /[uU]$/.test(t) ? 'uint' : 'int';
    }
    tokens.push(token);
  }
  tokens.push({ t: '', k: 'eof', ws, pre: '', post: '' });
  return tokens;
}

const emit = (tokens) => tokens.map((t) => t.ws + t.pre + t.t + t.post).join('');

// ---------------------------------------------------------------------------
// Parser and type checker
// ---------------------------------------------------------------------------
class GLSLSyntaxError extends Error {}

function analyze(tokens, stage) {
  let i = 0;
  const text = (o = 0) => tokens[Math.min(i + o, tokens.length - 1)].t;
  const peek = (o = 0) => tokens[Math.min(i + o, tokens.length - 1)];
  const next = () => {
    const token = tokens[i];
    if (token.k === 'eof') throw new GLSLSyntaxError('unexpected end of shader');
    i++;
    return token;
  };
  const accept = (s) => (tokens[i].t === s ? tokens[i++] : null);
  const expect = (s) => {
    if (tokens[i].t !== s) throw new GLSLSyntaxError(`expected '${s}' but found '${tokens[i].t}' near "${context()}"`);
    return tokens[i++];
  };
  const context = () => tokens.slice(Math.max(0, i - 6), i + 4).map((t) => t.t).join(' ');

  const structs = new Map();
  const functions = new Map();
  const uniformDefaults = [];
  const outputArrays = [];
  let usesBufferTextures = false;
  const scopes =[new Map(Object.entries(BUILTIN_VARIABLES[stage]))];
  let returnType = null;
  const isTypeName = (s) => BASIC_TYPES.has(s) || SAMPLER.test(s) || structs.has(s);
  const lookup = (name) => {
    for (let s = scopes.length - 1; s >= 0; s--) {
      const type = scopes[s].get(name);
      if (type !== undefined) return type;
    }
    return null;
  };
  const declare = (name, type) => scopes[scopes.length - 1].set(name, type);

  // -- conversions ----------------------------------------------------------
  function convert(node, to) {
    if (!node || !to || !node.type || node.type === to || conversionCost(node.type, to) !== 1) return;
    if (node.literal !== undefined && node.literal !== null) {
      const token = tokens[node.literal];
      if (/^(0|[1-9]\d*)$/.test(token.t)) {
        token.t += to === 'float' ? '.0' : 'u';
        node.type = to;
        return;
      }
    }
    tokens[node.start].pre = `${to}(${tokens[node.start].pre}`;
    tokens[node.end].post += ')';
    node.type = to;
  }
  function toFloat(node) {
    const info = typeInfo(node?.type);
    if (info && (info.base === 'int' || info.base === 'uint') && !info.matrix) convert(node, vecType('float', info.n));
  }
  function unifyBase(left, right) {
    const a = typeInfo(left.type);
    const b = typeInfo(right.type);
    if (a.base === b.base) return a.base;
    if (a.base === 'float' && (b.base === 'int' || b.base === 'uint')) convert(right, vecType('float', b.n));
    else if (b.base === 'float' && (a.base === 'int' || a.base === 'uint')) convert(left, vecType('float', a.n));
    else if (a.base === 'uint' && b.base === 'int') convert(right, vecType('uint', b.n));
    else if (b.base === 'uint' && a.base === 'int') convert(left, vecType('uint', a.n));
    else return a.base;
    return typeInfo(left.type).base;
  }
  function binaryType(op, left, right) {
    if (op === '&&' || op === '||' || op === '^^') return 'bool';
    const comparison = op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=';
    const a = typeInfo(left.type);
    const b = typeInfo(right.type);
    if (!a || !b || !a.base || !b.base) return comparison ? 'bool' : null;
    if (op === '<<' || op === '>>') return left.type;
    if (comparison) {
      if (!a.matrix && !b.matrix) unifyBase(left, right);
      return 'bool';
    }
    if (a.matrix || b.matrix) {
      if (!a.matrix) toFloat(left);
      if (!b.matrix) toFloat(right);
      if (op === '*') {
        if (a.matrix && b.matrix) return matType(b.cols, a.rows);
        if (a.matrix && b.n > 1) return vecType('float', a.rows);
        if (b.matrix && a.n > 1) return vecType('float', b.cols);
      }
      return a.matrix ? left.type : right.type;
    }
    const base = unifyBase(left, right);
    const n = a.n === b.n ? a.n : a.n === 1 ? b.n : b.n === 1 ? a.n : 0;
    return n ? vecType(base, n) : null;
  }
  function unifyBranches(a, b) {
    if (a.type === b.type) return a.type;
    if (conversionCost(b.type, a.type) === 1) {
      convert(b, a.type);
      return a.type;
    }
    if (conversionCost(a.type, b.type) === 1) {
      convert(a, b.type);
      return b.type;
    }
    return a.type || b.type;
  }
  function indexType(type) {
    if (!type) return null;
    if (type.endsWith('[]')) return type.slice(0, -2);
    const info = typeInfo(type);
    if (info?.matrix) return vecType('float', info.rows);
    if (info?.base && info.n > 1) return info.base;
    return null;
  }
  function fieldType(type, field) {
    const info = typeInfo(type);
    if (!info) return null;
    if (info.struct) return structs.get(type)?.get(field) ?? null;
    if (info.base && !info.matrix && /^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(field)) return vecType(info.base, field.length);
    return null;
  }

  function matchSignature(sig, args) {
    const [ret, ...params] = sig;
    if (params.length !== args.length) return null;
    let size = null;
    let matrix = null;
    for (let k = 0; k < args.length; k++) {
      const info = typeInfo(args[k].type);
      if (!info) continue;
      if (GENERIC.has(params[k])) {
        if (!info.base || info.matrix) return null;
        if (size === null) size = info.n;
        else if (size !== info.n) return null;
      } else if (params[k] === 'M') {
        if (!info.matrix) return null;
        if (matrix === null) matrix = args[k].type;
        else if (matrix !== args[k].type) return null;
      }
    }
    const concrete = (p) => {
      switch (p) {
        case 'F': return vecType('float', size || 1);
        case 'I': return vecType('int', size || 1);
        case 'U': return vecType('uint', size || 1);
        case 'B': return vecType('bool', size || 1);
        case 'M': return matrix;
        default: return SCALAR[p] || p;
      }
    };
    let cost = 0;
    const targets = [];
    for (let k = 0; k < args.length; k++) {
      const want = concrete(params[k]);
      const c = args[k].type && want ? conversionCost(args[k].type, want) : 0;
      if (c < 0) return null;
      cost += c;
      targets.push(c > 0 ? want : null);
    }
    return { cost, targets, ret: concrete(ret) };
  }
  function callBuiltin(name, args) {
    if (TEXTURE_FUNCTIONS.has(name)) {
      const sampler = typeInfo(args[0]?.type);
      if (!sampler?.sampler) return null;
      if (name === 'textureSize') return vecType('int', sampler.dims + (sampler.arrayed ? 1 : 0));
      if (sampler.buffer && name === 'texelFetch' && args.length === 2) {
        // Buffer textures become 2D textures BUFFER_TEXTURE_WIDTH texels wide (see gl.js).
        tokens[args[1].start].pre = `webmc_bufferCoord(${tokens[args[1].start].pre}`;
        tokens[args[1].end].post += '), 0';
        usesBufferTextures = true;
        return sampler.result;
      }
      if (name === 'texelFetch' || name === 'texelFetchOffset') return sampler.result;
      toFloat(args[1]);
      if (/Lod/.test(name) || ((name === 'texture' || name === 'textureProj') && args.length === 3)) toFloat(args[2]);
      if (/Grad/.test(name)) {
        toFloat(args[2]);
        toFloat(args[3]);
      }
      return sampler.shadow ? 'float' : sampler.result;
    }
    if (name === 'transpose') {
      const info = typeInfo(args[0]?.type);
      return info?.matrix ? matType(info.rows, info.cols) : null;
    }
    if (name === 'outerProduct') {
      const c = typeInfo(args[0]?.type);
      const r = typeInfo(args[1]?.type);
      return c && r ? matType(r.n, c.n) : null;
    }
    const sigs = BUILTINS[name];
    if (!sigs) return null;
    let best = null;
    for (const sig of sigs) {
      const match = matchSignature(sig, args);
      if (match && (!best || match.cost < best.cost)) best = match;
    }
    if (!best) return null;
    best.targets.forEach((target, k) => target && convert(args[k], target));
    return best.ret;
  }
  function callUser(name, args) {
    let best = null;
    for (const f of functions.get(name)) {
      if (f.params.length !== args.length) continue;
      let cost = 0;
      for (let k = 0; k < args.length && cost >= 0; k++) {
        const c = conversionCost(args[k].type, f.params[k]);
        cost = c < 0 ? -1 : cost + c;
      }
      if (cost >= 0 && (!best || cost < best.cost)) best = { f, cost };
    }
    if (!best) return functions.get(name)[0]?.ret ?? null;
    best.f.params.forEach((p, k) => convert(args[k], p));
    return best.f.ret;
  }

  // -- expressions ----------------------------------------------------------
  const BINARY = { '||': 1, '^^': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '<': 8, '>': 8, '<=': 8, '>=': 8, '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11 };
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);

  function parseExpression() {
    let e = parseAssignment();
    while (accept(',')) {
      const r = parseAssignment();
      e = { start: e.start, end: r.end, type: r.type };
    }
    return e;
  }
  function parseAssignment() {
    const left = parseConditional();
    if (peek().k !== 'op' || !ASSIGN.has(text())) return left;
    const op = next().t;
    const right = parseAssignment();
    if (op === '=') convert(right, left.type);
    else if (op === '+=' || op === '-=' || op === '*=' || op === '/=') {
      const a = typeInfo(left.type);
      const b = typeInfo(right.type);
      if (a?.base && b?.base && !b.matrix) {
        if (a.base === 'float' && (b.base === 'int' || b.base === 'uint')) convert(right, vecType('float', b.n));
        else if (a.base === 'uint' && b.base === 'int') convert(right, vecType('uint', b.n));
      }
    }
    return { start: left.start, end: right.end, type: left.type };
  }
  function parseConditional() {
    const condition = parseBinary(1);
    if (!accept('?')) return condition;
    const a = parseExpression();
    expect(':');
    const b = parseAssignment();
    return { start: condition.start, end: b.end, type: unifyBranches(a, b) };
  }
  function parseBinary(min) {
    let left = parseUnary();
    for (;;) {
      const op = text();
      const prec = peek().k === 'op' ? BINARY[op] : undefined;
      if (prec === undefined || prec < min) return left;
      next();
      const right = parseBinary(prec + 1);
      left = { start: left.start, end: right.end, type: binaryType(op, left, right) };
    }
  }
  function parseUnary() {
    const op = text();
    if (peek().k === 'op' && (op === '++' || op === '--' || op === '-' || op === '+' || op === '!' || op === '~')) {
      const start = i;
      next();
      const operand = parseUnary();
      return { start, end: operand.end, type: op === '!' ? 'bool' : operand.type, literal: op === '-' || op === '+' ? operand.literal : null };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      if (accept('[')) {
        parseExpression();
        expect(']');
        e = { start: e.start, end: i - 1, type: indexType(e.type) };
      } else if (accept('.')) {
        const field = next();
        if (field.t === 'length' && accept('(')) {
          expect(')');
          e = { start: e.start, end: i - 1, type: 'int' };
        } else e = { start: e.start, end: i - 1, type: fieldType(e.type, field.t) };
      } else if (text() === '++' || text() === '--') {
        next();
        e = { start: e.start, end: i - 1, type: e.type };
      } else return e;
    }
  }
  function parsePrimary() {
    const token = peek();
    const start = i;
    if (token.t === '(' && token.k === 'op') {
      next();
      const e = parseExpression();
      expect(')');
      return { start, end: i - 1, type: e.type, literal: e.literal };
    }
    if (token.k === 'num') {
      next();
      return { start, end: start, type: token.type, literal: token.type === 'int' ? start : null };
    }
    if (token.k !== 'id') throw new GLSLSyntaxError(`unexpected '${token.t}' near "${context()}"`);
    next();
    if (token.t === 'true' || token.t === 'false') return { start, end: start, type: 'bool' };
    if (isTypeName(token.t)) {
      let type = MAT_ALIAS[token.t] || token.t;
      if (text() === '[') type += parseArraySuffix();
      return parseCall(start, type, true);
    }
    if (text() === '(') return parseCall(start, token.t, false);
    return { start, end: start, type: lookup(token.t) };
  }
  function parseCall(start, callee, constructor) {
    expect('(');
    const args = [];
    if (text() === 'void' && text(1) === ')') next();
    if (!accept(')')) {
      do args.push(parseAssignment());
      while (accept(','));
      expect(')');
    }
    const node = { start, end: i - 1, type: null };
    if (constructor) {
      node.type = callee;
      if (callee.endsWith('[]')) {
        for (const a of args) convert(a, callee.slice(0, -2));
      } else if (structs.has(callee)) {
        const fields = [...structs.get(callee).values()];
        args.forEach((a, k) => convert(a, fields[k]));
      }
    } else if (functions.has(callee)) node.type = callUser(callee, args);
    else node.type = callBuiltin(callee, args);
    return node;
  }

  // -- declarations ---------------------------------------------------------
  function parseArraySuffix() {
    let suffix = '';
    while (accept('[')) {
      if (!accept(']')) {
        parseExpression();
        expect(']');
      }
      suffix += '[]';
    }
    return suffix;
  }
  function parseQualifiers() {
    const quals = { words: new Set(), layouts: [] };
    for (;;) {
      const word = text();
      if (word === 'layout' && text(1) === '(') {
        const layout = { start: i, items: [] };
        next();
        next();
        while (!accept(')')) {
          const itemStart = i;
          next();
          if (accept('=')) parseConditional();
          layout.items.push({ start: itemStart, end: i - 1, name: tokens[itemStart].t });
          accept(',');
        }
        layout.end = i - 1;
        quals.layouts.push(layout);
      } else if (QUALIFIERS.has(word)) {
        quals.words.add(word);
        if (DROPPED_QUALIFIERS.has(word)) tokens[i].t = '';
        next();
      } else return quals;
    }
  }
  // ES 3.00 allows layout(location) only on vertex inputs and fragment outputs, and has no
  // binding/index/offset layout qualifiers.
  function fixLayouts(quals) {
    const varying = (stage === 'vertex' && quals.words.has('out')) || (stage === 'fragment' && quals.words.has('in'));
    for (const layout of quals.layouts) {
      const keep = layout.items.filter((item) => !(item.name === 'binding' || item.name === 'index' || item.name === 'offset'
        || item.name === 'component' || (item.name === 'location' && varying)));
      if (keep.length === layout.items.length) continue;
      const kept = keep.map((item) => tokens.slice(item.start, item.end + 1).map((t) => t.t).join(' '));
      for (let k = layout.start; k <= layout.end; k++) tokens[k].t = '';
      if (kept.length) tokens[layout.start].t = `layout(${kept.join(', ')})`;
    }
  }
  function parseTypeSpecifier() {
    while (text() === 'highp' || text() === 'mediump' || text() === 'lowp') next();
    if (text() === 'struct') return parseStruct();
    const token = next();
    if (!isTypeName(token.t)) throw new GLSLSyntaxError(`unknown type '${token.t}' near "${context()}"`);
    let type = MAT_ALIAS[token.t] || token.t;
    if (text() === '[') type += parseArraySuffix();
    return type;
  }
  function parseStruct() {
    expect('struct');
    const name = peek().k === 'id' ? next().t : `struct#${structs.size}`;
    expect('{');
    const fields = new Map();
    structs.set(name, fields);
    parseMembers(fields);
    return name;
  }
  function parseMembers(fields) {
    while (!accept('}')) {
      fixLayouts(parseQualifiers());
      const type = parseTypeSpecifier();
      do {
        const field = next().t;
        fields.set(field, text() === '[' ? type + parseArraySuffix() : type);
      } while (accept(','));
      expect(';');
    }
  }
  function parseDeclarators(type, nameToken, uniform = false) {
    let token = nameToken;
    for (;;) {
      if (token.k !== 'id') throw new GLSLSyntaxError(`identifier expected near "${context()}"`);
      const t = text() === '[' ? type + parseArraySuffix() : type;
      const assign = i;
      if (accept('=')) {
        const init = parseAssignment();
        convert(init, t);
        if (uniform) {
          // GLSL ES has no uniform initializers: the value is set after linking instead.
          uniformDefaults.push({ name: token.t, type: t, value: tokens.slice(init.start, init.end + 1).map((x) => x.pre + x.t + x.post).join(' ') });
          for (let k = assign; k <= init.end; k++) tokens[k].t = tokens[k].pre = tokens[k].post = '';
        }
      }
      declare(token.t, t);
      if (!accept(',')) break;
      token = next();
    }
    expect(';');
  }
  function parseDeclaration(global) {
    if (text() === 'precision') {
      while (next().t !== ';');
      return;
    }
    const quals = parseQualifiers();
    fixLayouts(quals);
    if (accept(';')) return; // e.g. layout(early_fragment_tests) in;
    if (peek().k === 'id' && !isTypeName(text()) && text(1) === ';') {
      next(); // invariant gl_Position;
      next();
      return;
    }
    if (global && peek().k === 'id' && !isTypeName(text()) && text(1) === '{') {
      const block = next().t;
      next();
      const members = new Map();
      parseMembers(members);
      if (peek().k === 'id') {
        const type = `block#${block}`;
        structs.set(type, members);
        const instance = next().t;
        declare(instance, text() === '[' ? type + parseArraySuffix() : type);
      } else {
        for (const [name, type] of members) declare(name, type);
      }
      expect(';');
      return;
    }
    const type = parseTypeSpecifier();
    if (accept(';')) return;
    const name = next();
    if (global && text() === '(') {
      parseFunction(type, name.t);
      return;
    }
    // Fragment output arrays (see translateGLSL): `out vec4 name[N];` with a literal size.
    const outputArray = global && stage === 'fragment' && quals.words.has('out') && text() === '[' && tokens[i + 1].k === 'num' && tokens[i + 2].t === ']'
      ? { name: name.t, nameIndex: i - 1, base: type, size: Number.parseInt(tokens[i + 1].t, 10) } : null;
    parseDeclarators(type, name, global && quals.words.has('uniform'));
    if (outputArray) outputArrays.push({ ...outputArray, endIndex: i - 1 });
  }
  function parseFunction(ret, name) {
    expect('(');
    const params = [];
    const names = [];
    if (text() === 'void' && text(1) === ')') next();
    while (!accept(')')) {
      parseQualifiers();
      let type = parseTypeSpecifier();
      let paramName = null;
      if (peek().k === 'id') {
        paramName = next().t;
        if (text() === '[') type += parseArraySuffix();
      }
      params.push(type);
      names.push(paramName);
      accept(',');
    }
    const overloads = functions.get(name) || [];
    if (!overloads.some((f) => f.params.join() === params.join())) overloads.push({ ret, params });
    functions.set(name, overloads);
    if (accept(';')) return;
    scopes.push(new Map(names.map((n, k) => [n, params[k]]).filter(([n]) => n)));
    returnType = ret;
    parseCompound(false);
    returnType = null;
    scopes.pop();
  }

  // -- statements -----------------------------------------------------------
  function isDeclarationStart() {
    const word = text();
    if (peek().k !== 'id') return false;
    if (word === 'struct' || word === 'precision' || QUALIFIERS.has(word) || (word === 'layout' && text(1) === '(')) return true;
    if (!isTypeName(word)) return false;
    let k = 1;
    while (text(k) === '[') {
      let depth = 0;
      for (;; k++) {
        if (peek(k).k === 'eof') return false;
        if (text(k) === '[') depth++;
        else if (text(k) === ']' && --depth === 0) break;
      }
      k++;
    }
    return peek(k).k === 'id';
  }
  function parseCompound(scope = true) {
    expect('{');
    if (scope) scopes.push(new Map());
    while (!accept('}')) parseStatement();
    if (scope) scopes.pop();
  }
  function parseStatement() {
    switch (text()) {
      case '{':
        parseCompound();
        return;
      case ';':
        next();
        return;
      case 'if':
        next();
        expect('(');
        parseExpression();
        expect(')');
        parseStatement();
        if (accept('else')) parseStatement();
        return;
      case 'while':
        next();
        expect('(');
        parseExpression();
        expect(')');
        parseStatement();
        return;
      case 'do':
        next();
        parseStatement();
        expect('while');
        expect('(');
        parseExpression();
        expect(')');
        expect(';');
        return;
      case 'for':
        next();
        expect('(');
        scopes.push(new Map());
        if (!accept(';')) {
          if (isDeclarationStart()) parseDeclaration(false);
          else {
            parseExpression();
            expect(';');
          }
        }
        if (text() !== ';') parseExpression();
        expect(';');
        if (text() !== ')') parseExpression();
        expect(')');
        parseStatement();
        scopes.pop();
        return;
      case 'switch':
        next();
        expect('(');
        parseExpression();
        expect(')');
        expect('{');
        scopes.push(new Map());
        while (!accept('}')) {
          if (accept('case')) {
            parseExpression();
            expect(':');
          } else if (accept('default')) expect(':');
          else parseStatement();
        }
        scopes.pop();
        return;
      case 'return':
        next();
        if (!accept(';')) {
          const value = parseExpression();
          convert(value, returnType);
          expect(';');
        }
        return;
      case 'break':
      case 'continue':
      case 'discard':
        next();
        expect(';');
        return;
      default:
        if (isDeclarationStart()) parseDeclaration(false);
        else {
          parseExpression();
          expect(';');
        }
    }
  }

  while (peek().k !== 'eof') {
    if (!accept(';')) parseDeclaration(true);
  }
  return { uniformDefaults, usesBufferTextures, outputArrays };
}

/**
 * GLSL ES 3.00 only indexes fragment output arrays with constants (desktop GLSL also takes loop
 * indices, as 26.x's transparency shaders do). The shader writes a plain array instead, and a new
 * main() copies it to the outputs element by element after the original one returns.
 */
function constantIndexedOutputs(tokens, outputArrays) {
  if (!outputArrays.length) return '';
  // (GLSL ES reserves names with "__": _frag_output_00 becomes webmc_out_frag_output_00.)
  const temp = (name) => `webmc_out_${name.replace(/^_+/, '').replace(/__+/g, '_')}`;
  for (const o of outputArrays) {
    const declaration = tokens[o.nameIndex];
    for (const token of tokens) {
      if (token.k === 'id' && token.t === o.name && token !== declaration) token.t = temp(o.name);
    }
    tokens[o.endIndex].post += `\n${o.base} ${temp(o.name)}[${o.size}];`;
  }
  for (let k = 1; k < tokens.length - 1; k++) {
    if (tokens[k].t === 'main' && tokens[k + 1].t === '(' && tokens[k - 1].t === 'void') tokens[k].t = 'webmc_main';
  }
  const copies = outputArrays.flatMap((o) => Array.from({ length: o.size }, (_, n) => `  ${o.name}[${n}] = ${temp(o.name)}[${n}];`));
  return `\nvoid main() {\n  webmc_main();\n${copies.join('\n')}\n}\n`;
}

/**
 * Values of a constant uniform initializer such as `vec3(0.3, 0.59, 0.11)` or `1.0`, as the flat
 * list of components glUniform* takes (null when the expression is not that simple).
 */
export function uniformDefaultValues(type, value) {
  const info = typeInfo(type);
  if (!info?.base) return null;
  const literals = value.replace(/\b(?!true\b|false\b)[A-Za-z_]\w*/g, ' ');
  const numbers = (literals.match(/true|false|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [])
    .map((n) => (n === 'true' ? 1 : n === 'false' ? 0 : Number(n)));
  const count = info.matrix ? info.cols * info.rows : info.n;
  if (numbers.length === count) return numbers;
  if (numbers.length !== 1) return null;
  if (!info.matrix) return new Array(count).fill(numbers[0]);
  return Array.from({ length: count }, (_, k) => (k % (info.rows + 1) === 0 ? numbers[0] : 0));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const PRECISION_HEADER = [
  'precision highp float;',
  'precision highp int;',
  ...['sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow',
    'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DArray', 'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray']
    .map((s) => `precision highp ${s};`),
].join('\n');

/**
 * @param {string} source desktop GLSL source
 * @param {{stage: 'vertex'|'fragment', defines?: object}} options
 * @returns {{code: string, version: number, warnings: string[]}}
 */
export function translateGLSL(source, { stage, defines = {} } = {}) {
  const pre = preprocess(source, defines);
  const warnings = [...pre.warnings];
  const tokens = lex(pre.text);
  let needsColorOutput = false;
  // Token-level rewrites: GLSL 1.10/1.20 names, ES reserved words, gl_FragColor/gl_FragData[0].
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.k !== 'id') continue;
    const t = token.t;
    if (t === 'attribute') token.t = 'in';
    else if (t === 'varying') token.t = stage === 'vertex' ? 'out' : 'in';
    else if (LEGACY_TEXTURE[t] && tokens[k + 1]?.t === '(') token.t = LEGACY_TEXTURE[t];
    else if (stage === 'fragment' && t === 'gl_FragColor') {
      token.t = 'webmc_FragColor';
      needsColorOutput = true;
    } else if (stage === 'fragment' && t === 'gl_FragData' && tokens[k + 1]?.t === '[' && tokens[k + 2]?.t === '0' && tokens[k + 3]?.t === ']') {
      token.t = 'webmc_FragColor';
      tokens[k + 1].t = tokens[k + 2].t = tokens[k + 3].t = '';
      needsColorOutput = true;
    } else if (ES_RESERVED.has(t) || (pre.version < 400 && GLSL4_QUALIFIERS.has(t))) token.t = `webmc_${t}`;
  }
  let uniformDefaults = [];
  let usesBufferTextures = false;
  let outputWrapper = '';
  try {
    let outputArrays;
    ({ uniformDefaults, usesBufferTextures, outputArrays } = analyze(tokens, stage));
    outputWrapper = constantIndexedOutputs(tokens, outputArrays);
  } catch (error) {
    if (!(error instanceof GLSLSyntaxError)) throw error;
    warnings.push(`type pass skipped: ${error.message}`);
    // The token-level rewrites still apply; drop what the parser would have fixed in layouts.
    for (const token of tokens) {
      if (token.k === 'id' && DROPPED_QUALIFIERS.has(token.t)) token.t = '';
    }
  }
  for (const token of tokens) {
    if (token.k === 'id' && BUFFER_SAMPLERS[token.t]) token.t = BUFFER_SAMPLERS[token.t];
  }
  const bufferHelper = usesBufferTextures
    ? `ivec2 webmc_bufferCoord(int i) { return ivec2(i % ${BUFFER_TEXTURE_WIDTH}, i / ${BUFFER_TEXTURE_WIDTH}); }\n` : '';
  const header = `#version 300 es\n${PRECISION_HEADER}\n${bufferHelper}${needsColorOutput ? 'out vec4 webmc_FragColor;\n' : ''}`;
  let code = header + emit(tokens) + outputWrapper;
  if (warnings.some((w) => w.startsWith('type pass skipped'))) code = code.replace(/\blayout\s*\(\s*binding\s*=\s*\d+\s*\)/g, '');
  return { code, version: pre.version, warnings, uniformDefaults };
}
