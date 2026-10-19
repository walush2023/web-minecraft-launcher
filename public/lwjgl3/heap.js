// Access to the memory that Java's off-heap data lives in.
//
// CheerpJ keeps sun.misc.Unsafe allocations and direct ByteBuffers in a WebAssembly.Memory.
// LWJGL passes addresses into that memory to its native methods, so the JavaScript
// implementations need to read and write it. The Memory objects are captured when CheerpJ
// creates them (installMemoryCapture must run before CheerpJ's loader), and the right one
// is identified by a marker that webmc.lwjgl.Bridge writes into a known address.

const captured = [];
let memory = null;
let buffer = null;

export let U8 = new Uint8Array(0);
export let I8 = new Int8Array(0);
export let U16 = new Uint16Array(0);
export let I16 = new Int16Array(0);
export let U32 = new Uint32Array(0);
export let I32 = new Int32Array(0);
export let F32 = new Float32Array(0);
export let F64 = new Float64Array(0);
export let DV = new DataView(new ArrayBuffer(0));

export const POINTER_SIZE = 4;

// CheerpJ's runtime heap (class metadata and bytecode) is a WebAssembly memory of 18 pages that
// may grow to 4096 pages (256 MiB); both the runtime's module and the JavaScript that creates the
// memory declare that maximum.
const RUNTIME_HEAP = { initial: 18, maximum: 4096 };

/**
 * Captures the WebAssembly memories CheerpJ creates. With `runtimeHeapPages` (at most 16383, which
 * keeps the limit's encoding the same length), the runtime heap may grow beyond 256 MiB: the
 * memory and the runtime module's memory import get the larger maximum as they are created.
 */
export function installMemoryCapture({ runtimeHeapPages = 0 } = {}) {
  if (WebAssembly.Memory.webmcCapture) return;
  const RealMemory = WebAssembly.Memory;
  const raise = runtimeHeapPages > RUNTIME_HEAP.maximum && runtimeHeapPages <= 16383;
  function CapturingMemory(descriptor) {
    let d = descriptor;
    if (raise && d && d.initial === RUNTIME_HEAP.initial && d.maximum === RUNTIME_HEAP.maximum && !d.shared) {
      d = { ...d, maximum: runtimeHeapPages };
    }
    const instance = new RealMemory(d);
    captured.push(instance);
    return instance;
  }
  CapturingMemory.prototype = RealMemory.prototype;
  CapturingMemory.webmcCapture = true;
  WebAssembly.Memory = CapturingMemory;
  if (raise) {
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = function (source, imports, ...rest) {
      if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) source = raiseMemoryImport(source, runtimeHeapPages);
      return instantiate.call(this, source, imports, ...rest);
    };
  }
}

/** A copy of the module with its 18/4096-page memory import raised to `pages`, or the input. */
export function raiseMemoryImport(source, pages) {
  const bytes = new Uint8Array(source instanceof ArrayBuffer ? source.slice(0) : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  let p = 8;
  const leb = () => {
    let value = 0;
    let shift = 0;
    let b;
    do {
      b = bytes[p++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return value;
  };
  const skipName = () => {
    const length = leb();
    p += length;
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        skipName();
        skipName();
        const kind = bytes[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; if (leb() & 1) { leb(); leb(); } else leb(); }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; leb(); }
        else if (kind === 2) {
          const flags = bytes[p++];
          const min = leb();
          const at = p;
          if (flags === 1 && min === RUNTIME_HEAP.initial && leb() === RUNTIME_HEAP.maximum && p - at === 2) {
            bytes[at] = (pages & 0x7f) | 0x80;
            bytes[at + 1] = pages >> 7;
            return bytes;
          }
          return source;
        } else return source;
      }
      return source;
    }
    p = end;
  }
  return source;
}

function refresh() {
  buffer = memory.buffer;
  U8 = new Uint8Array(buffer);
  I8 = new Int8Array(buffer);
  U16 = new Uint16Array(buffer);
  I16 = new Int16Array(buffer);
  U32 = new Uint32Array(buffer);
  I32 = new Int32Array(buffer);
  F32 = new Float32Array(buffer);
  F64 = new Float64Array(buffer);
  DV = new DataView(buffer);
}

/** Re-creates the views after the memory grew. Call before touching the heap. */
export function sync() {
  if (memory.buffer !== buffer) refresh();
}

/** Finds the captured memory that holds the marker written at `address`. */
export function bindHeap(address, magic0, magic1) {
  for (const candidate of captured) {
    const view = new Int32Array(candidate.buffer);
    if (address + 8 <= candidate.buffer.byteLength && view[address >> 2] === magic0 && view[(address >> 2) + 1] === magic1) {
      memory = candidate;
      refresh();
      return true;
    }
  }
  return false;
}

/** Converts a pointer argument (BigInt from Java `long`, or number) to a heap offset. */
export function ptr(value) {
  return typeof value === 'bigint' ? Number(BigInt.asUintN(32, value)) : value >>> 0;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------
const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

export function readCString(address) {
  const p = ptr(address);
  if (!p) return null;
  sync();
  let end = p;
  while (U8[end] !== 0) end++;
  return utf8Decoder.decode(U8.subarray(p, end));
}

export function readUtf8(address, length) {
  sync();
  const p = ptr(address);
  return utf8Decoder.decode(U8.subarray(p, p + length));
}

export function encodeUtf8(text) {
  return utf8Encoder.encode(text);
}

/** Writes `text` NUL-terminated at `address`, truncated to `capacity` bytes; returns bytes written (without NUL). */
export function writeCStringAt(address, text, capacity) {
  const p = ptr(address);
  if (!p || capacity <= 0) return 0;
  sync();
  const bytes = utf8Encoder.encode(text);
  const n = Math.min(bytes.length, capacity - 1);
  U8.set(bytes.subarray(0, n), p);
  U8[p + n] = 0;
  return n;
}

const interned = new Map();

/** Returns a stable NUL-terminated copy of `text` in the heap (never freed). */
export function cstring(text) {
  let address = interned.get(text);
  if (address === undefined) {
    const bytes = utf8Encoder.encode(text);
    address = malloc(bytes.length + 1);
    sync();
    U8.set(bytes, address);
    U8[address + bytes.length] = 0;
    interned.set(text, address);
  }
  return address;
}

// ---------------------------------------------------------------------------
// Allocator for memory owned by the JavaScript side (strings, structs, decoded images).
// Blocks come from Java (Unsafe.allocateMemory) so they live in the same heap.
// Small allocations use power-of-two size classes; large ones a first-fit free list.
// ---------------------------------------------------------------------------
const HEADER = 8;
const LARGE = 1 << 20;
const blocks = [];
const freeLists = new Map();
const largeFree = [];
let bump = 0;
let bumpEnd = 0;
let requestBlock = null;

export function addBlock(address, size) {
  blocks.push({ address, size });
  bump = (address + 15) & ~15;
  bumpEnd = address + size;
}

/** Sets an async function (size) => address that obtains more memory from Java. */
export function setBlockProvider(provider) {
  requestBlock = provider;
}

function sizeClass(n) {
  let c = 32;
  while (c < n) c <<= 1;
  return c;
}

function carve(total) {
  if (bump + total > bumpEnd) return 0;
  const address = bump;
  bump += total;
  return address;
}

/** Allocates `size` bytes (8-byte aligned). Returns 0 when the current blocks are full. */
export function malloc(size) {
  const n = Math.max(1, Math.ceil(size)) + HEADER;
  let base = 0;
  let total;
  if (n <= LARGE) {
    total = sizeClass(n);
    const list = freeLists.get(total);
    base = list && list.length ? list.pop() : carve(total);
  } else {
    total = (n + 0xffff) & ~0xffff;
    const index = largeFree.findIndex((r) => r.size >= total);
    if (index >= 0) {
      const range = largeFree[index];
      base = range.address;
      total = range.size;
      largeFree.splice(index, 1);
    } else {
      base = carve(total);
    }
  }
  if (!base) return 0;
  sync();
  U32[base >> 2] = total;
  U32[(base >> 2) + 1] = 0x57454243; // "WEBC"
  return base + HEADER;
}

let growing = null;

/** Like malloc, but obtains another block from Java when the current ones are full. */
export async function mallocAsync(size) {
  for (;;) {
    const address = malloc(size);
    if (address || !requestBlock) return address;
    // One request at a time; callers that arrive meanwhile retry once it is served.
    if (!growing) {
      const blockSize = Math.max(32 << 20, Math.ceil(size) + (1 << 20));
      growing = requestBlock(blockSize).then((block) => {
        if (block) addBlock(block, blockSize);
        return block;
      }).finally(() => { growing = null; });
      if (!(await growing)) return 0;
    } else await growing;
  }
}

export function calloc(size) {
  const address = malloc(size);
  if (address) {
    sync();
    U8.fill(0, address, address + size);
  }
  return address;
}

export function free(address) {
  const p = ptr(address);
  if (!p) return;
  sync();
  const base = p - HEADER;
  if (U32[(base >> 2) + 1] !== 0x57454243) return; // not ours
  const total = U32[base >> 2];
  U32[(base >> 2) + 1] = 0;
  if (total <= LARGE) {
    let list = freeLists.get(total);
    if (!list) freeLists.set(total, (list = []));
    list.push(base);
  } else {
    largeFree.push({ address: base, size: total });
  }
}

/** Size of an allocation made by malloc (for realloc). */
export function allocationSize(address) {
  const base = ptr(address) - HEADER;
  sync();
  return U32[(base >> 2) + 1] === 0x57454243 ? U32[base >> 2] - HEADER : 0;
}

export function realloc(address, size) {
  const p = ptr(address);
  if (!p) return malloc(size);
  const old = allocationSize(p);
  if (old >= size) return p;
  const next = malloc(size);
  if (!next) return 0;
  sync();
  U8.copyWithin(next, p, p + old);
  free(p);
  return next;
}

// Typed reads/writes at byte addresses (little endian).
export const getI32 = (a) => (sync(), I32[ptr(a) >> 2]);
export const setI32 = (a, v) => {
  sync();
  I32[ptr(a) >> 2] = v;
};
export const getU32 = (a) => (sync(), U32[ptr(a) >> 2]);
export const getF32 = (a) => (sync(), F32[ptr(a) >> 2]);
export const setF32 = (a, v) => {
  sync();
  F32[ptr(a) >> 2] = v;
};
export const setF64 = (a, v) => {
  sync();
  DV.setFloat64(ptr(a), v, true);
};
export const getF64 = (a) => (sync(), DV.getFloat64(ptr(a), true));
export const getPointer = (a) => getU32(a);
export const setPointer = (a, v) => setI32(a, ptr(v) | 0);
