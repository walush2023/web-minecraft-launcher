// JavaScript implementations of LWJGL's core native methods (org.lwjgl.system.*).
import {
  sync, ptr, U8, I8, U16, I16, U32, I32, F32, F64, DV,
  malloc, calloc, realloc, free, readCString, cstring, getU32, setI32,
} from './heap.js';
import {
  defineFunction, dlopen, dlsym, invoke, newGlobalRef, deleteGlobalRef, globalRefObject,
  registerClosure, unregisterClosure,
} from './registry.js';
import { LWJGL_NATIVES } from './generated/natives.js';

/** JNI short name for a native method (CheerpJ resolves natives by this name). */
export function jniName(className, method) {
  const mangle = (s) => s.replace(/_/g, '_1').replace(/\$/g, '_00024');
  return `Java_${mangle(className).replace(/\//g, '_')}_${mangle(method)}`;
}

/** Helper to fill a natives table: def('org/lwjgl/...', 'method', fn). */
export function definer(table) {
  return (className, method, fn) => {
    table[jniName(className, method)] = fn;
  };
}

// Out-parameters arrive either as heap pointers or, for LWJGL's array overloads, as typed arrays.
export function outI32(target, value) {
  if (ArrayBuffer.isView(target)) target[0] = value;
  else if (ptr(target)) setI32(target, value);
}
export function outF32(target, value) {
  if (ArrayBuffer.isView(target)) target[0] = value;
  else if (ptr(target)) {
    sync();
    F32[ptr(target) >> 2] = value;
  }
}
export function outF64(target, value) {
  if (ArrayBuffer.isView(target)) target[0] = value;
  else if (ptr(target)) {
    sync();
    DV.setFloat64(ptr(target), value, true);
  }
}
export function outPointer(target, value) {
  if (ArrayBuffer.isView(target)) target[0] = typeof target[0] === 'bigint' ? BigInt(value) : value;
  else if (ptr(target)) setI32(target, ptr(value) | 0);
}

// ---------------------------------------------------------------------------
// libc allocation, used by LibCStdlib and by function pointers handed to native code
// ---------------------------------------------------------------------------
function alignedAlloc(alignment, size) {
  const a = Math.max(8, Number(alignment));
  const raw = malloc(Number(size) + a + 8);
  if (!raw) return 0;
  const aligned = Math.ceil((raw + 8) / a) * a;
  sync();
  U32[(aligned - 8) >> 2] = raw;
  U32[(aligned - 4) >> 2] = 0x414c474e; // "ALGN"
  return aligned;
}
function alignedFree(address) {
  const p = ptr(address);
  if (!p) return;
  sync();
  if (U32[(p - 4) >> 2] === 0x414c474e) {
    U32[(p - 4) >> 2] = 0;
    free(U32[(p - 8) >> 2]);
  }
}
const LIBC = {
  malloc: (size) => malloc(Number(size)),
  calloc: (n, size) => calloc(Number(n) * Number(size)),
  realloc: (p, size) => realloc(p, Number(size)),
  free: (p) => free(p),
  aligned_alloc: (alignment, size) => alignedAlloc(alignment, size),
  aligned_free: (p) => alignedFree(p),
};

// ---------------------------------------------------------------------------
// Fake JNIEnv: LWJGL stores the current GL capabilities in a reserved slot of the
// JNI function table (ThreadLocalUtil). One shared env is enough for the browser.
// ---------------------------------------------------------------------------
let jniEnv = 0;
function threadJNIEnv() {
  if (!jniEnv) {
    const table = calloc(256 * 4);
    jniEnv = calloc(16);
    setI32(jniEnv, table);
  }
  return jniEnv;
}

// ---------------------------------------------------------------------------
// libffi structures (32-bit layouts)
// ---------------------------------------------------------------------------
const FFI_TYPES = {
  void: [1, 1, 0], uint8: [1, 1, 5], sint8: [1, 1, 6], uint16: [2, 2, 7], sint16: [2, 2, 8],
  uint32: [4, 4, 9], sint32: [4, 4, 10], uint64: [8, 8, 11], sint64: [8, 8, 12], float: [4, 4, 2],
  double: [8, 8, 3], longdouble: [8, 8, 4], pointer: [4, 4, 14],
};
const FFI_ALIASES = { uchar: 'uint8', schar: 'sint8', ushort: 'uint16', sshort: 'sint16', uint: 'uint32', sint: 'sint32', ulong: 'uint32', slong: 'sint32' };
const ffiTypeAddress = new Map();
const ffiTypeKind = new Map();
function ffiType(name) {
  const key = FFI_ALIASES[name] || name;
  let address = ffiTypeAddress.get(key);
  if (!address) {
    const [size, alignment, type] = FFI_TYPES[key];
    address = calloc(12);
    sync();
    U32[address >> 2] = size;
    U16[(address + 4) >> 1] = alignment;
    U16[(address + 6) >> 1] = type;
    ffiTypeAddress.set(key, address);
    ffiTypeKind.set(address, type);
  }
  return address;
}
const CIF = { abi: 0, nargs: 4, arg_types: 8, rtype: 12, bytes: 16, flags: 20, SIZE: 24 };
const CLOSURE = { cif: 0, fun: 4, user_data: 8, SIZE: 12 };
// What LWJGL allocates per closure: its fields plus a private slot for the code address.
const CLOSURE_SIZE = 16;
let nextCode = 0x40000000;

function readFfiValue(address, kind) {
  sync();
  const p = ptr(address);
  switch (kind) {
    case 2: return F32[p >> 2];
    case 3: case 4: return DV.getFloat64(p, true);
    case 5: return U8[p];
    case 6: return I8[p];
    case 7: return U16[p >> 1];
    case 8: return I16[p >> 1];
    case 11: case 12: return DV.getBigInt64(p, true);
    case 9: return U32[p >> 2];
    default: return I32[p >> 2];
  }
}
function writeFfiValue(address, kind, value) {
  sync();
  const p = ptr(address);
  if (!p || value === undefined) return;
  switch (kind) {
    case 0: return;
    case 2: F32[p >> 2] = value; return;
    case 3: case 4: DV.setFloat64(p, value, true); return;
    case 11: case 12: DV.setBigInt64(p, BigInt(value), true); return;
    default: I32[p >> 2] = Number(value) | 0;
  }
}

// ---------------------------------------------------------------------------
// The natives table
// ---------------------------------------------------------------------------
/** lwjglVersion: e.g. 3.3 or 3.4 (from the game's LWJGL jar); a few struct queries differ. */
export function coreNatives({ bridgeClass, lwjglVersion = 3.3 }) {
  const lwjgl34 = lwjglVersion >= 3.4;
  const N = {};
  const def = definer(N);

  // MemoryAccessJNI: raw accessors and allocator entry points
  const MA = 'org/lwjgl/system/MemoryAccessJNI';
  def(MA, 'getPointerSize', () => 4);
  for (const name of Object.keys(LIBC)) def(MA, name, () => defineFunction('libc', name, LIBC[name]));
  def(MA, 'ngetByte', (lib, a) => (sync(), I8[ptr(a)]));
  def(MA, 'ngetShort', (lib, a) => (sync(), I16[ptr(a) >> 1]));
  def(MA, 'ngetInt', (lib, a) => (sync(), I32[ptr(a) >> 2]));
  def(MA, 'ngetLong', (lib, a) => (sync(), Number(DV.getBigInt64(ptr(a), true))));
  def(MA, 'ngetFloat', (lib, a) => (sync(), F32[ptr(a) >> 2]));
  def(MA, 'ngetDouble', (lib, a) => (sync(), DV.getFloat64(ptr(a), true)));
  def(MA, 'ngetAddress', (lib, a) => getU32(a));
  def(MA, 'nputByte', (lib, a, v) => { sync(); I8[ptr(a)] = v; });
  def(MA, 'nputShort', (lib, a, v) => { sync(); I16[ptr(a) >> 1] = v; });
  def(MA, 'nputInt', (lib, a, v) => { sync(); I32[ptr(a) >> 2] = v; });
  def(MA, 'nputLong', (lib, a, v) => { sync(); DV.setBigInt64(ptr(a), BigInt(v), true); });
  def(MA, 'nputFloat', (lib, a, v) => { sync(); F32[ptr(a) >> 2] = v; });
  def(MA, 'nputDouble', (lib, a, v) => { sync(); DV.setFloat64(ptr(a), v, true); });
  def(MA, 'nputAddress', (lib, a, v) => setI32(a, ptr(v) | 0));

  // MemoryUtil
  const MU = 'org/lwjgl/system/MemoryUtil';
  def(MU, 'memGlobalRefToObject', (lib, ref) => globalRefObject(ref));
  def(MU, 'ngetPageSize', () => 4096);
  def(MU, 'ngetCacheLineSize', () => 64);

  // ThreadLocalUtil
  const TL = 'org/lwjgl/system/ThreadLocalUtil';
  def(TL, 'getThreadJNIEnv', () => threadJNIEnv());
  def(TL, 'setThreadJNIEnv', () => undefined);
  def(TL, 'getFunctionMissingAbort', () => defineFunction('lwjgl', 'functionMissingAbort', () => {
    throw new Error('[lwjgl-web] called an OpenGL function that is not available');
  }));
  def(TL, 'nsetupEnvData', (lib, count) => calloc(Math.max(256, count) * 4));
  def(TL, 'setupEnvData', (lib, count) => calloc(Math.max(256, count || 0) * 4));
  def(TL, 'jvmtiGetJNIFunctionTable', (lib, ...args) => {
    const out = args.find((a) => typeof a === 'bigint');
    if (out !== undefined) setI32(out, getU32(threadJNIEnv()));
    return 0;
  });
  def(TL, 'jvmtiDeallocate', () => 0);

  // JNINativeInterface
  const JN = 'org/lwjgl/system/jni/JNINativeInterface';
  def(JN, 'GetVersion', () => 0x00010008);
  def(JN, 'NewGlobalRef', (lib, o) => newGlobalRef(o));
  def(JN, 'NewWeakGlobalRef', (lib, o) => newGlobalRef(o));
  def(JN, 'nDeleteGlobalRef', (lib, ref) => deleteGlobalRef(ref));
  def(JN, 'nDeleteWeakGlobalRef', (lib, ref) => deleteGlobalRef(ref));
  def(JN, 'GetObjectRefType', () => 2);
  def(JN, 'nNewDirectByteBuffer', async (lib, address, capacity) => {
    const Bridge = await bridgeClass(lib);
    return Bridge.newDirectByteBuffer(ptr(address), Number(capacity));
  });
  def(JN, 'GetDirectBufferAddress', async (lib, buffer) => {
    const Bridge = await bridgeClass(lib);
    return Number(await Bridge.directBufferAddress(buffer));
  });
  def(JN, 'nGetJavaVM', (lib, out) => (setI32(out, threadJNIEnv()), 0));
  def(JN, 'FromReflectedMethod', () => 0);
  def(JN, 'FromReflectedField', () => 0);
  def(JN, 'UnregisterNatives', () => 0);
  const arrayElementHelpers = (kind) => {
    def(JN, `nGet${kind}ArrayElements`, (lib, array, isCopy) => {
      const bytes = array.byteLength;
      const address = malloc(Math.max(1, bytes));
      sync();
      U8.set(new Uint8Array(array.buffer, array.byteOffset, bytes), address);
      if (ptr(isCopy)) U8[ptr(isCopy)] = 1;
      return address;
    });
    def(JN, `nRelease${kind}ArrayElements`, (lib, array, elems, mode) => {
      const p = ptr(elems);
      if (mode !== 2) {
        sync();
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(U8.subarray(p, p + array.byteLength));
      }
      if (mode !== 1) free(p);
    });
    def(JN, `nGet${kind}ArrayRegion`, (lib, array, start, len, buf) => {
      const size = array.BYTES_PER_ELEMENT;
      sync();
      U8.set(new Uint8Array(array.buffer, array.byteOffset + start * size, len * size), ptr(buf));
    });
    def(JN, `nSet${kind}ArrayRegion`, (lib, array, start, len, buf) => {
      const size = array.BYTES_PER_ELEMENT;
      const p = ptr(buf);
      sync();
      new Uint8Array(array.buffer, array.byteOffset + start * size, len * size).set(U8.subarray(p, p + len * size));
    });
  };
  ['Boolean', 'Byte', 'Char', 'Short', 'Int', 'Long', 'Float', 'Double'].forEach(arrayElementHelpers);

  // Dynamic linking
  for (const os of ['linux', 'freebsd', 'macosx']) {
    const DL = `org/lwjgl/system/${os}/DynamicLinkLoader`;
    def(DL, 'ndlopen', (lib, filename) => dlopen(readCString(filename)));
    def(DL, 'ndlsym', (lib, handle, name) => dlsym(Number(handle), readCString(name)));
    def(DL, 'ndlerror', () => cstring('library not available in the browser'));
    def(DL, 'ndlclose', () => 0);
  }
  const DY = 'org/lwjgl/system/dyncall/DynLoad';
  def(DY, 'ndlLoadLibrary', (lib, path) => dlopen(readCString(path)));
  def(DY, 'ndlFindSymbol', (lib, handle, name) => dlsym(Number(handle), readCString(name)));
  def(DY, 'ndlFreeLibrary', () => undefined);
  def(DY, 'ndlGetLibraryPath', () => 0);
  def(DY, 'ndlSymsInit', () => 0);
  def(DY, 'ndlSymsCount', () => 0);

  // Callbacks via dyncall (LWJGL 3.1 / 3.2)
  const DCB = 'org/lwjgl/system/dyncall/DynCallback';
  const dcbUserData = new Map();
  def(DCB, 'ndcbNewCallback', (lib, signature, handler, userData) => {
    const code = nextCode;
    nextCode += 16;
    dcbUserData.set(code, Number(userData));
    registerClosure(code, userData);
    return code;
  });
  def(DCB, 'ndcbInitCallback', (lib, pcb, signature, handler, userData) => {
    dcbUserData.set(Number(pcb), Number(userData));
    registerClosure(pcb, userData);
  });
  def(DCB, 'ndcbFreeCallback', (lib, pcb) => {
    dcbUserData.delete(Number(pcb));
    unregisterClosure(pcb);
  });
  def(DCB, 'ndcbGetUserData', (lib, pcb) => dcbUserData.get(Number(pcb)) || 0);

  // Callbacks via libffi (LWJGL 3.3+)
  const FFI = 'org/lwjgl/system/libffi/LibFFI';
  const constants = {
    FFI_TYPE_DOUBLE: 3, FFI_WIN64: 1, FFI_GNUW64: 2, FFI_UNIX64: 2, FFI_EFI64: 1, FFI_SYSV: 1,
    FFI_STDCALL: 2, FFI_THISCALL: 3, FFI_FASTCALL: 4, FFI_MS_CDECL: 5, FFI_PASCAL: 6, FFI_REGISTER: 7,
    FFI_VFP: 2, FFI_FIRST_ABI: 0, FFI_LAST_ABI: 8, FFI_DEFAULT_ABI: 2,
  };
  for (const [name, value] of Object.entries(constants)) def(FFI, name, () => value);
  for (const name of [...Object.keys(FFI_TYPES), ...Object.keys(FFI_ALIASES)]) def(FFI, `nffi_type_${name}`, () => ffiType(name));
  const prepCif = (lib, cif, abi, ...rest) => {
    const atypes = rest.pop();
    const rtype = rest.pop();
    const nargs = rest.pop();
    const c = ptr(cif);
    sync();
    U32[(c + CIF.abi) >> 2] = abi;
    U32[(c + CIF.nargs) >> 2] = nargs;
    U32[(c + CIF.arg_types) >> 2] = ptr(atypes);
    U32[(c + CIF.rtype) >> 2] = ptr(rtype);
    return 0; // FFI_OK
  };
  def(FFI, 'nffi_prep_cif', prepCif);
  def(FFI, 'nffi_prep_cif_var', (lib, cif, abi, nfixed, ntotal, rtype, atypes) => prepCif(lib, cif, abi, ntotal, rtype, atypes));
  def(FFI, 'nffi_closure_alloc', (lib, size, codeOut) => {
    const closure = calloc(Math.max(CLOSURE.SIZE, Number(size)));
    const code = nextCode;
    nextCode += 16;
    sync();
    U32[(closure + 12) >> 2] = code; // remember our code address (beyond LWJGL's fields)
    setI32(codeOut, code);
    return closure;
  });
  def(FFI, 'nffi_prep_closure_loc', (lib, closure, cif, fun, userData, codeloc) => {
    const c = ptr(closure);
    sync();
    U32[(c + CLOSURE.cif) >> 2] = ptr(cif);
    U32[(c + CLOSURE.fun) >> 2] = ptr(fun);
    U32[(c + CLOSURE.user_data) >> 2] = ptr(userData);
    registerClosure(codeloc, userData);
    return 0;
  });
  def(FFI, 'nffi_closure_free', (lib, closure) => {
    sync();
    unregisterClosure(U32[(ptr(closure) + 12) >> 2]);
    free(closure);
  });
  def(FFI, 'nffi_call', (lib, cif, fn, rvalue, avalues) => {
    const c = ptr(cif);
    sync();
    const nargs = U32[(c + CIF.nargs) >> 2];
    const types = U32[(c + CIF.arg_types) >> 2];
    const args = [];
    for (let i = 0; i < nargs; i++) {
      sync();
      const typeAddress = U32[(types >> 2) + i];
      const valueAddress = U32[(ptr(avalues) >> 2) + i];
      args.push(readFfiValue(valueAddress, ffiTypeKind.get(typeAddress) ?? 14));
    }
    const result = invoke(fn, args);
    sync();
    writeFfiValue(rvalue, ffiTypeKind.get(U32[(c + CIF.rtype) >> 2]) ?? 14, result);
  });
  // LWJGL 3.4 also asks for the struct alignment, after the field offsets.
  def('org/lwjgl/system/libffi/FFICIF', 'offsets', (lib, buffer) => {
    const b = ptr(buffer);
    sync();
    [CIF.abi, CIF.nargs, CIF.arg_types, CIF.rtype, CIF.bytes, CIF.flags, ...(lwjgl34 ? [4] : [])].forEach((o, i) => { I32[(b >> 2) + i] = o; });
    return CIF.SIZE;
  });
  def('org/lwjgl/system/libffi/FFIClosure', 'offsets', (lib, buffer) => {
    const b = ptr(buffer);
    sync();
    [CLOSURE.cif, CLOSURE.fun, CLOSURE.user_data, ...(lwjgl34 ? [4] : [])].forEach((o, i) => { I32[(b >> 2) + i] = o; });
    return CLOSURE_SIZE;
  });
  def(FFI, 'ffi_get_closure_size', () => CLOSURE_SIZE);

  // Callback handler entry points (only passed back to closure preparation); LWJGL 3.4 moved
  // them to org.lwjgl.system.Upcalls.
  const CB = 'org/lwjgl/system/Callback';
  const callbackHandler = () => defineFunction('lwjgl', 'callbackHandler', () => 0);
  def(CB, 'getCallbackHandler', callbackHandler);
  def('org/lwjgl/system/Upcalls', 'getCallbackHandler', callbackHandler);
  def('org/lwjgl/system/Upcalls', 'shutdown', () => undefined);
  def(CB, 'getNativeCallbacks', (lib, methods, out) => {
    const p = ptr(out);
    sync();
    const count = methods?.length ?? 9;
    for (let i = 0; i < count; i++) U32[(p >> 2) + i] = defineFunction('lwjgl', `nativeCallback${i}`, () => 0);
  });

  // libc
  const STR = 'org/lwjgl/system/libc/LibCString';
  def(STR, 'nmemset', (lib, dst, value, bytes) => {
    if (ArrayBuffer.isView(dst)) {
      new Uint8Array(dst.buffer, dst.byteOffset, Number(bytes)).fill(value & 0xff);
      return 0;
    }
    sync();
    U8.fill(value & 0xff, ptr(dst), ptr(dst) + Number(bytes));
    return Number(ptr(dst));
  });
  const copy = (lib, dst, src, bytes) => {
    const n = Number(bytes);
    if (ArrayBuffer.isView(dst) || ArrayBuffer.isView(src)) {
      sync();
      const from = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, n) : U8.subarray(ptr(src), ptr(src) + n);
      const to = ArrayBuffer.isView(dst) ? new Uint8Array(dst.buffer, dst.byteOffset, n) : U8.subarray(ptr(dst), ptr(dst) + n);
      to.set(from.slice());
      return 0;
    }
    sync();
    U8.copyWithin(ptr(dst), ptr(src), ptr(src) + n);
    return ptr(dst);
  };
  def(STR, 'nmemcpy', copy);
  def(STR, 'nmemmove', copy);
  def(STR, 'nstrlen', (lib, s) => {
    const p = ptr(s);
    sync();
    let e = p;
    while (U8[e]) e++;
    return e - p;
  });
  def(STR, 'nstrerror', () => cstring('error'));
  const STD = 'org/lwjgl/system/libc/LibCStdlib';
  def(STD, 'nmalloc', (lib, size) => LIBC.malloc(size));
  def(STD, 'ncalloc', (lib, n, size) => LIBC.calloc(n, size));
  def(STD, 'nrealloc', (lib, p, size) => LIBC.realloc(p, size));
  def(STD, 'nfree', (lib, p) => LIBC.free(p));
  def(STD, 'naligned_alloc', (lib, alignment, size) => LIBC.aligned_alloc(alignment, size));
  def(STD, 'naligned_free', (lib, p) => LIBC.aligned_free(p));
  def('org/lwjgl/system/SharedLibraryUtil', 'getLibraryPath', () => 0);

  // JNI.invoke*/call*: the last argument is always the function address
  for (const name of LWJGL_NATIVES['org/lwjgl/system/JNI'] || []) {
    def('org/lwjgl/system/JNI', name, (lib, ...args) => {
      const address = args.pop();
      return invoke(address, args);
    });
  }
  return N;
}
