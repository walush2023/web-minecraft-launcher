// Function "pointers", shared libraries and callback closures for the LWJGL backend.
//
// LWJGL calls C functions through addresses obtained from dlsym (GLFW, OpenAL, GL entry
// points during capability detection). Here those addresses are small integer ids that map
// to JavaScript implementations. Callbacks registered by Java (GLFW key callbacks, ...) are
// libffi/dyncall closures whose user data is a JNI global reference to the Java object.

const FIRST_ID = 0x1000;
const functions = []; // id - FIRST_ID -> { name, impl }
const byKey = new Map(); // "lib:name" -> id
const libraries = new Map(); // handle -> { name, impls, lenient }
const libraryHandles = new Map(); // name -> handle
let nextHandle = 0x100;
const unimplementedWarned = new Set();

export function defineFunction(library, name, impl) {
  const key = `${library}:${name}`;
  let id = byKey.get(key);
  if (id === undefined) {
    id = FIRST_ID + functions.length;
    functions.push({ name, library, impl });
    byKey.set(key, id);
  } else if (impl) {
    functions[id - FIRST_ID].impl = impl;
  }
  return id;
}

function unimplemented(library, name) {
  return (...args) => {
    if (!unimplementedWarned.has(name)) {
      unimplementedWarned.add(name);
      console.warn(`[lwjgl-web] ${library} function not implemented: ${name}`);
    }
    return 0;
  };
}

/**
 * Registers a library under one or more file names. `impls` maps symbol names to functions.
 * With `lenient`, unknown symbols resolve to a stub that logs once (LWJGL requires every
 * function of a module to be present even if the game never calls it).
 */
export function defineLibrary(name, { aliases = [], impls = {}, lenient = true, symbolFilter = null }) {
  const handle = nextHandle++;
  const library = { name, impls, lenient, symbolFilter };
  libraries.set(handle, library);
  for (const alias of [name, ...aliases]) libraryHandles.set(alias, handle);
  return handle;
}

export function dlopen(path) {
  if (!path) return 0;
  const file = path.split('/').pop();
  for (const [alias, handle] of libraryHandles) {
    if (file === alias || file.startsWith(`${alias}.`) || file.startsWith(`lib${alias}.`) || file.startsWith(`lib${alias}-`)) return handle;
  }
  return 0;
}

export function dlsym(handle, symbol) {
  const library = libraries.get(handle);
  if (!library || !symbol) return 0;
  const impl = library.impls[symbol];
  if (!impl) {
    if (!library.lenient || (library.symbolFilter && !library.symbolFilter(symbol))) return 0;
    return defineFunction(library.name, symbol, unimplemented(library.name, symbol));
  }
  return defineFunction(library.name, symbol, impl);
}

export function functionName(id) {
  const entry = functions[Number(id) - FIRST_ID];
  return entry ? entry.name : null;
}

/** Calls the function behind `id` with the given arguments. */
export function invoke(id, args) {
  const entry = functions[Number(id) - FIRST_ID];
  if (!entry) throw new Error(`[lwjgl-web] call through unknown function pointer ${id}`);
  return entry.impl(...args);
}

// ---------------------------------------------------------------------------
// JNI global references and callback closures
// ---------------------------------------------------------------------------
const refs = new Map();
let nextRef = 0x2000;

export function newGlobalRef(object) {
  if (object === null || object === undefined) return 0;
  const id = nextRef;
  nextRef += 4;
  refs.set(id, object);
  return id;
}

export function deleteGlobalRef(id) {
  refs.delete(Number(id));
}

export function globalRefObject(id) {
  return refs.get(Number(id)) ?? null;
}

const closures = new Map(); // code address -> { userData }

export function registerClosure(codeAddress, userData) {
  closures.set(Number(codeAddress), { userData: Number(userData) });
}

export function unregisterClosure(codeAddress) {
  closures.delete(Number(codeAddress));
}

/** The Java callback object (a CallbackI) behind a closure code address, or null. */
export function callbackObject(codeAddress) {
  const closure = closures.get(Number(codeAddress));
  return closure ? globalRefObject(closure.userData) : null;
}

/**
 * Invokes the Java callback behind `codeAddress` (e.g. GLFWKeyCallbackI.invoke). Must be
 * awaited from an async native. Java `long` parameters have to be passed as numbers.
 */
export async function callJava(codeAddress, ...args) {
  const object = callbackObject(codeAddress);
  if (!object) return undefined;
  try {
    return await object.invoke(...args);
  } catch (error) {
    console.error('[lwjgl-web] callback failed:', error);
    return undefined;
  }
}
