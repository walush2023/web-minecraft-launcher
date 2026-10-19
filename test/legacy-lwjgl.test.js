import test from 'node:test';
import assert from 'node:assert/strict';
import { lookUpFieldsByName, readZipEntries, storedZip } from '../public/lwjgl3/legacy.js';

// A minimal class file: class A { private static long getAddressOffset() {...}; private static long other() {...} }
function classFile() {
  const bytes = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
  const pool = [];
  const utf8 = (s) => pool.push([1, 0, s.length, ...Array.from(s, (c) => c.charCodeAt(0))]);
  utf8('A'); // 1
  pool.push([7, 0, 1]); // 2: class A
  utf8('java/lang/Object'); // 3
  pool.push([7, 0, 3]); // 4
  utf8('getAddressOffset'); // 5
  utf8('()J'); // 6
  utf8('Code'); // 7
  utf8('other'); // 8
  bytes.push(0, pool.length + 1, ...pool.flat());
  bytes.push(0, 0x21, 0, 2, 0, 4, 0, 0, 0, 0); // access, this, super, no interfaces, no fields
  const method = (name) => [0, 0x0a, 0, name, 0, 6, 0, 1, 0, 7, 0, 0, 0, 14, 0, 2, 0, 0, 0, 0, 0, 2, 0x09, 0xad, 0, 0, 0, 0];
  bytes.push(0, 2, ...method(5), ...method(8), 0, 0);
  return Uint8Array.from(bytes);
}

/** Code bytes of each method, by method index. */
function methodCodes(b) {
  const u2 = (i) => (b[i] << 8) | b[i + 1];
  const u4 = (i) => u2(i) * 65536 + u2(i + 2);
  let p = 10;
  for (let i = 1; i < u2(8); i++) {
    const tag = b[p];
    p += tag === 1 ? 3 + u2(p + 1) : tag === 7 || tag === 8 ? 3 : 5;
  }
  p += 6;
  p += 2 + u2(p) * 2;
  p += 2; // no fields
  const codes = [];
  for (let m = 0, n = u2(p), q = p + 2; m < n; m++) {
    q += 8; // one attribute each: Code
    codes.push(Array.from(b.subarray(q + 14, q + 14 + u4(q + 10))));
    q += 6 + u4(q + 2);
  }
  return codes;
}

test('replaces the LWJGL buffer offset searches with lookups by name', () => {
  const original = classFile();
  const patched = lookUpFieldsByName(original);
  assert.ok(patched);
  const [search, other] = methodCodes(patched);
  // ldc_w "address"; invokestatic webmc/lwjgl/Bridge.bufferField; lreturn
  assert.equal(search.length, 7);
  assert.equal(search[0], 0x13);
  assert.equal(search[3], 0xb8);
  assert.equal(search[6], 0xad);
  assert.deepEqual(other, [0x09, 0xad]);
  const text = new TextDecoder('latin1').decode(patched);
  for (const s of ['webmc/lwjgl/Bridge', 'bufferField', '(Ljava/lang/String;)J', 'address']) assert.ok(text.includes(s), s);
  assert.equal(lookUpFieldsByName(classWithout()), null);
});

function classWithout() {
  const b = classFile();
  // Rename getAddressOffset to getAddressOffseT: nothing to patch.
  const text = new TextDecoder('latin1').decode(b);
  b[text.indexOf('getAddressOffset') + 15] = 'T'.charCodeAt(0);
  return b;
}

test('reads back the jar it writes', async () => {
  const data = Uint8Array.from([1, 2, 3, 250]);
  const jar = storedZip([{ name: 'org/lwjgl/system/MemoryUtil.class', data }, { name: 'x.txt', data: Uint8Array.of(7) }]);
  const entries = await readZipEntries(jar, ['org/lwjgl/system/MemoryUtil.class']);
  assert.deepEqual([...entries.keys()], ['org/lwjgl/system/MemoryUtil.class']);
  assert.deepEqual(Array.from(entries.get('org/lwjgl/system/MemoryUtil.class')), [1, 2, 3, 250]);
});
