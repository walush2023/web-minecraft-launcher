// LWJGL 3.1 and 3.2 (Minecraft 1.13 - 1.16.5) on CheerpJ.
//
// Those versions find the Unsafe offsets of java.nio.Buffer's fields (address, capacity...) by
// reading a test buffer at offsets 8, 16, 24... until the expected value shows up. CheerpJ's
// offsets are field numbers (0, 1, 2...), so the search never ends; LWJGL 3.3 looks the fields up
// by name, which works. Before the JVM starts, the classes with the search are read from the
// LWJGL jar, the search methods get bodies that look the fields up by name
// (webmc.lwjgl.Bridge.bufferField / parentField), and the result goes into a small jar in
// CheerpJ's in-memory file system that comes before LWJGL on the class path. The downloaded jar
// stays unchanged. (Redefining the classes from Java is not enough: CheerpJ resolves class path
// classes from the jars.)

const PATCHED_CLASSES = ['org/lwjgl/system/MemoryUtil.class', 'org/lwjgl/system/MemoryAccess$MemoryAccessorUnsafe.class'];
// Search method -> the field it looks for ('att': the parent of a direct buffer, by instance).
const FIELDS = {
  getAddressOffset: 'address', getMarkOffset: 'mark', getPositionOffset: 'position',
  getLimitOffset: 'limit', getCapacityOffset: 'capacity', getParentOffset: 'att',
};

/** A jar with the patched LWJGL classes for the LWJGL core jar at `url`, or null when none apply. */
export async function legacyLwjglFix(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const entries = await readZipEntries(new Uint8Array(await response.arrayBuffer()), PATCHED_CLASSES);
  const files = [];
  for (const [name, bytes] of entries) {
    const patched = lookUpFieldsByName(bytes);
    if (patched) files.push({ name, data: patched });
  }
  return files.length ? storedZip(files) : null;
}

// ---------------------------------------------------------------------------
// Class files
// ---------------------------------------------------------------------------
const u2 = (b, i) => (b[i] << 8) | b[i + 1];
const u4 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const latin = (bytes) => new TextDecoder('latin1').decode(bytes);

/** Replaces the bodies of the offset search methods; returns the new class or null if none. */
export function lookUpFieldsByName(b) {
  const count = u2(b, 8);
  const utf8 = [];
  let p = 10;
  for (let i = 1; i < count; i++) {
    const tag = b[p];
    if (tag === 1) {
      const length = u2(b, p + 1);
      utf8[i] = latin(b.subarray(p + 3, p + 3 + length)); // names here are ASCII
      p += 3 + length;
    } else if ([7, 8, 16, 19, 20].includes(tag)) p += 3;
    else if (tag === 15) p += 4;
    else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) p += 5;
    else if (tag === 5 || tag === 6) { p += 9; i++; }
    else throw new Error(`unknown constant pool tag ${tag}`);
  }
  const poolEnd = p;

  // New constant pool entries, appended after the existing ones.
  const added = [];
  let next = count;
  const entry = (...bytes) => { added.push(Uint8Array.from(bytes)); return next++; };
  const utf8Entry = (s) => entry(1, s.length >> 8, s.length & 255, ...Array.from(s, (c) => c.charCodeAt(0)));
  const pair = (tag, a, c) => entry(tag, a >> 8, a & 255, c >> 8, c & 255);
  let bridge = 0;
  const methodref = (name, descriptor) => {
    bridge ||= entry(7, ...split(utf8Entry('webmc/lwjgl/Bridge')));
    return pair(10, bridge, pair(12, utf8Entry(name), utf8Entry(descriptor)));
  };
  let bufferField = 0;
  let parentField = 0;
  const strings = new Map();
  const string = (s) => {
    if (!strings.has(s)) strings.set(s, entry(8, ...split(utf8Entry(s))));
    return strings.get(s);
  };

  // Members: access, this, super, interfaces, fields, then the methods we rewrite.
  let q = poolEnd + 6;
  q += 2 + u2(b, q) * 2;
  q = skipMembers(b, q);
  const methods = u2(b, q);
  const pieces = [b.subarray(poolEnd, q + 2)];
  q += 2;
  let changed = false;
  for (let m = 0; m < methods; m++) {
    const name = utf8[u2(b, q + 2)];
    const descriptor = utf8[u2(b, q + 4)];
    const field = descriptor?.endsWith(')J') && Object.hasOwn(FIELDS, name) ? FIELDS[name] : null;
    const attributes = u2(b, q + 6);
    pieces.push(b.subarray(q, q + 8));
    q += 8;
    for (let a = 0; a < attributes; a++) {
      const length = u4(b, q + 2);
      if (field && utf8[u2(b, q)] === 'Code') {
        let code;
        if (field === 'att') {
          // getParentOffset(int, T buffer, Function) -> Bridge.parentField(buffer)
          parentField ||= methodref('parentField', '(Ljava/lang/Object;)J');
          code = [0x2b /* aload_1 */, 0xb8, ...split(parentField), 0xad /* lreturn */];
        } else {
          bufferField ||= methodref('bufferField', '(Ljava/lang/String;)J');
          code = [0x13 /* ldc_w */, ...split(string(field)), 0xb8, ...split(bufferField), 0xad];
        }
        const attribute = new Uint8Array(6 + 8 + code.length + 4);
        attribute.set(b.subarray(q, q + 2)); // attribute name: "Code"
        writeU4(attribute, 2, 8 + code.length + 4);
        attribute.set([0, 2], 6); // max_stack: one long
        attribute.set(b.subarray(q + 8, q + 10), 8); // max_locals: unchanged
        writeU4(attribute, 10, code.length);
        attribute.set(code, 14); // then no exception handlers, no attributes
        pieces.push(attribute);
        changed = true;
      } else {
        pieces.push(b.subarray(q, q + 6 + length));
      }
      q += 6 + length;
    }
  }
  if (!changed) return null;
  pieces.push(b.subarray(q));
  return concat([b.subarray(0, 8), Uint8Array.of(next >> 8, next & 255), b.subarray(10, poolEnd), ...added, ...pieces]);
}

const split = (index) => [index >> 8, index & 255];

function writeU4(target, at, value) {
  target[at] = value >>> 24;
  target[at + 1] = (value >>> 16) & 255;
  target[at + 2] = (value >>> 8) & 255;
  target[at + 3] = value & 255;
}

/** Skips a fields or methods table starting at its count; returns the offset after it. */
function skipMembers(b, p) {
  const count = u2(b, p);
  p += 2;
  for (let i = 0; i < count; i++) {
    const attributes = u2(b, p + 6);
    p += 8;
    for (let a = 0; a < attributes; a++) p += 6 + u4(b, p + 2);
  }
  return p;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zip files
// ---------------------------------------------------------------------------
/** The named entries of a zip file, uncompressed: Map(name -> bytes). */
export async function readZipEntries(bytes, names) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const entries = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const found = new Map();
  for (let k = 0; k < entries && view.getUint32(p, true) === 0x02014b50; k++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (names.includes(name)) {
      const local = view.getUint32(p + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) found.set(name, data.slice());
      else if (method === 8) found.set(name, await inflateRaw(data));
      else throw new Error(`${name}: unsupported zip compression ${method}`);
    }
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return found;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip file with the given entries stored uncompressed. */
export function storedZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of files) {
    const encoded = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + encoded.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, encoded.length, true);
    local.set(encoded, 30);
    const header = new Uint8Array(46 + encoded.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 10, true);
    hv.setUint16(14, dosDate, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, encoded.length, true);
    hv.setUint32(42, offset, true);
    header.set(encoded, 46);
    parts.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, h) => sum + h.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, ...central, end]);
}

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
