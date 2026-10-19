import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseMemoryImport } from '../public/lwjgl3/heap.js';

// A module that only imports "i"."memory" with CheerpJ's runtime heap limits (18 to 4096 pages).
function runtimeLikeModule(min = 18, maxLeb = [0x80, 0x20]) {
  const name = (s) => [s.length, ...Buffer.from(s)];
  const entry = [...name('i'), ...name('memory'), 0x02, 0x01, min, ...maxLeb];
  const section = [0x01, ...entry];
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, section.length, ...section]).buffer;
}

const link = (bytes, maximum) => new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  i: { memory: new WebAssembly.Memory({ initial: 18, maximum }) },
});

test('raises the runtime heap limit declared by the module', () => {
  const original = runtimeLikeModule();
  assert.throws(() => link(original, 16368), /maximum/);
  const raised = raiseMemoryImport(original, 16368);
  assert.notEqual(raised, original);
  assert.doesNotThrow(() => link(raised, 16368));
  assert.doesNotThrow(() => link(original, 4096), 'the input stays unchanged');
});

test('leaves other modules alone', () => {
  const other = runtimeLikeModule(17);
  assert.equal(raiseMemoryImport(other, 16368), other);
  const larger = runtimeLikeModule(18, [0x80, 0x40]); // 8192 pages
  assert.equal(raiseMemoryImport(larger, 16368), larger);
});
