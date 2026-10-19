import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchOptions, mergeOptions } from '../public/js/options.js';

const plan = (releaseTime) => ({ releaseTime });

test('keeps unrelated options and replaces or appends managed ones', () => {
  const merged = mergeOptions('invertYMouse:false\nrenderDistance:12\nkey_key.jump:57\n', { renderDistance: 4, fboEnable: false });
  assert.equal(merged, 'invertYMouse:false\nrenderDistance:4\nkey_key.jump:57\nfboEnable:false\n');
});

test('creates options.txt content when none exists', () => {
  assert.equal(mergeOptions(null, { a: 1 }), 'a:1\n');
});

test('uses a boolean ambient-occlusion value before 1.6 and a level after', () => {
  assert.equal(launchOptions('quality', plan('2012-03-29T22:00:00+00:00')).ao, true);
  assert.equal(launchOptions('quality', plan('2015-12-03T09:24:39+00:00')).ao, 2);
  assert.equal(launchOptions('smooth', plan('2012-03-29T22:00:00+00:00')).ao, false);
});

test('always applies the settings the browser runtime needs, even with "keep"', () => {
  const kept = launchOptions('keep', plan('2017-09-18T08:39:46+00:00'));
  assert.equal(kept.fboEnable, false);
  assert.equal(kept.soundCategory_master, 0);
  assert.equal(kept.renderDistance, undefined);
  const smooth = launchOptions('smooth', plan('2017-09-18T08:39:46+00:00'));
  assert.equal(smooth.renderDistance, 4);
  assert.equal(smooth.fboEnable, false);
});
