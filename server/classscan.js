import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// Finds classes in a jar that catch java.lang.NullPointerException.
//
// CheerpJ 4.3 does not deliver the implicit NullPointerException raised by reading a field
// of a null reference (getfield) to a matching catch block. Minecraft 1.8 - 1.12.2 relies on
// exactly that in ModelBlock.checkModelHierarchy (obfuscated name differs per version), so
// the game crashes while loading models. webmc.NpePatcher rewrites such methods in the
// browser JVM; this scan tells it which classes to look at.

function* classEntries(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeader = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith('.class') || name.includes('/')) continue; // obfuscated game classes live in the root package
    const dataStart = localHeader + 30 + buffer.readUInt16LE(localHeader + 26) + buffer.readUInt16LE(localHeader + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    yield { name: name.slice(0, -'.class'.length), bytes: method === 8 ? inflateRawSync(data) : data };
  }
}

function catchesNullPointer(bytes) {
  if (bytes.readUInt32BE(0) !== 0xcafebabe) return false;
  let p = 8;
  const poolCount = bytes.readUInt16BE(p);
  p += 2;
  const utf8 = new Map();
  const classRefs = new Map();
  for (let i = 1; i < poolCount; i++) {
    const tag = bytes[p++];
    if (tag === 1) {
      const length = bytes.readUInt16BE(p);
      utf8.set(i, bytes.toString('utf8', p + 2, p + 2 + length));
      p += 2 + length;
    } else if (tag === 7) {
      classRefs.set(i, bytes.readUInt16BE(p));
      p += 2;
    } else if (tag === 8 || tag === 16 || tag === 19 || tag === 20) p += 2;
    else if (tag === 15) p += 3;
    else if (tag === 5 || tag === 6) {
      p += 8;
      i++;
    } else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) p += 4;
    else return false;
  }
  const npeClass = [...classRefs].find(([, nameIndex]) => utf8.get(nameIndex) === 'java/lang/NullPointerException')?.[0];
  if (!npeClass) return false;

  p += 6;
  p += 2 + bytes.readUInt16BE(p) * 2; // interfaces
  const skipMembers = (inspect) => {
    const count = bytes.readUInt16BE(p);
    p += 2;
    let found = false;
    for (let i = 0; i < count; i++) {
      const attributes = bytes.readUInt16BE(p + 6);
      p += 8;
      for (let a = 0; a < attributes; a++) {
        const name = utf8.get(bytes.readUInt16BE(p));
        const length = bytes.readUInt32BE(p + 2);
        if (inspect && name === 'Code') {
          const codeLength = bytes.readUInt32BE(p + 10);
          let q = p + 14 + codeLength;
          const handlers = bytes.readUInt16BE(q);
          q += 2;
          for (let h = 0; h < handlers; h++, q += 8) {
            if (bytes.readUInt16BE(q + 6) === npeClass) found = true;
          }
        }
        p += 6 + length;
      }
    }
    return found;
  };
  skipMembers(false); // fields
  return skipMembers(true); // methods
}

const cache = new Map();

/** Root-package classes of a client jar that contain a catch (NullPointerException). */
export async function findNpeCatchingClasses(jarPath, sha1) {
  if (cache.has(sha1)) return cache.get(sha1);
  const buffer = await readFile(jarPath);
  const classes = [];
  for (const entry of classEntries(buffer)) {
    try {
      if (catchesNullPointer(entry.bytes)) classes.push(entry.name);
    } catch {
      // Not a parseable class file; ignore.
    }
  }
  cache.set(sha1, classes);
  return classes;
}
