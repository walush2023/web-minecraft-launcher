import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixDirectoryRenames, saveOpenFiles } from '../public/js/fs-fixes.js';

// The parts of CheerpJ's IndexedDB mount that the fix touches (see cheerpOS.js).
function fakeMount() {
  const mount = { fileCache: {}, inodeCache: [], dEntries: {}, isSplit: true };
  mount.clearCached = (name) => {
    if (!Object.prototype.hasOwnProperty.call(mount.fileCache, name)) return;
    const fileData = mount.inodeCache[mount.fileCache[name]];
    fileData.cacheRefCount -= 1;
    if (fileData.cacheRefCount === 0) delete mount.inodeCache[fileData.inodeId];
    delete mount.fileCache[name];
  };
  mount.setCached = (name, fileData) => {
    fileData.cacheRefCount += 1;
    mount.fileCache[name] = fileData.inodeId;
    mount.inodeCache[fileData.inodeId] = fileData;
  };
  mount.cache = (name, inodeId, refCount = 0, dirty = 0) => {
    const fileData = { path: name, inodeId, refCount, dirty, permType: 0x81b6, cacheRefCount: 0, saved: 0 };
    fileData.mount = { close: (data, cb) => { data.saved += 1; data.dirty = 0; cb(); } };
    mount.setCached(name, fileData);
    return fileData;
  };
  return mount;
}

// CheerpJ's own cheerpOSRenameMain: forgets only the two paths themselves.
function installFakeRename(result = 1) {
  const calls = [];
  globalThis.window = {
    cheerpOSRenameMain(mount, src, dst, cb) {
      calls.push([src, dst]);
      if (result) {
        mount.clearCached(src);
        mount.clearCached(dst);
      }
      cb(result);
    },
  };
  return calls;
}

const rename = (mount, src, dst) => new Promise((resolve) => window.cheerpOSRenameMain(mount, src, dst, resolve));

test('forgets what was cached below both paths of a directory rename', async () => {
  const calls = installFakeRename();
  assert.equal(fixDirectoryRenames(), true);
  const mount = fakeMount();
  mount.cache('/saves/W/level.dat', 11); // closed, within CheerpJ's grace time
  const lock = mount.cache('/saves/W/session.lock', 12, 1); // still open
  mount.cache('/saves/W-new/level.dat', 13);
  mount.cache('/saves/Other/level.dat', 14);
  mount.cache('/saves/World/level.dat', 15); // shares the prefix, not the directory
  mount.dEntries = { '': {}, '/saves': {}, '/saves/W': {}, '/saves/W/region': {}, '/saves/W-new': {}, '/saves/Other': {}, '/saves/World': {} };

  assert.equal(await rename(mount, '/saves/W', '/saves/W-old'), 1);
  assert.deepEqual(calls, [['/saves/W', '/saves/W-old']]);
  assert.deepEqual(Object.keys(mount.fileCache).sort(), ['/saves/Other/level.dat', '/saves/W-new/level.dat', '/saves/W-old/session.lock', '/saves/World/level.dat']);
  assert.equal(mount.inodeCache[mount.fileCache['/saves/W-old/session.lock']], lock, 'and stay cached under the new name');
  assert.deepEqual(Object.keys(mount.dEntries).sort(), ['', '/saves', '/saves/Other', '/saves/W-new', '/saves/World']);
  assert.equal(lock.path, '/saves/W-old/session.lock', 'open files follow the rename');

  assert.equal(await rename(mount, '/saves/W-new', '/saves/W'), 1);
  assert.deepEqual(Object.keys(mount.fileCache).sort(), ['/saves/Other/level.dat', '/saves/W-old/session.lock', '/saves/World/level.dat']);
  assert.deepEqual(Object.keys(mount.dEntries).sort(), ['', '/saves', '/saves/Other', '/saves/World']);
});

test('a file rename moves the open file and keeps other entries', async () => {
  installFakeRename();
  fixDirectoryRenames();
  const mount = fakeMount();
  const open = mount.cache('/saves/W/level.dat_new', 21, 1);
  mount.cache('/saves/W/icon.png', 22);
  mount.dEntries = { '/saves/W': {} };
  assert.equal(await rename(mount, '/saves/W/level.dat_new', '/saves/W/level.dat'), 1);
  assert.equal(open.path, '/saves/W/level.dat');
  assert.deepEqual(Object.keys(mount.fileCache).sort(), ['/saves/W/icon.png', '/saves/W/level.dat']);
  assert.equal(mount.inodeCache[mount.fileCache['/saves/W/level.dat']], open);
  assert.deepEqual(Object.keys(mount.dEntries), ['/saves/W']);
});

test('a failed rename changes nothing', async () => {
  installFakeRename(0);
  fixDirectoryRenames();
  const mount = fakeMount();
  const open = mount.cache('/saves/W/session.lock', 31, 1);
  mount.dEntries = { '/saves/W': {} };
  assert.equal(await rename(mount, '/saves/W', '/saves/W-old'), 0);
  assert.equal(open.path, '/saves/W/session.lock');
  assert.deepEqual(Object.keys(mount.fileCache), ['/saves/W/session.lock']);
  assert.deepEqual(Object.keys(mount.dEntries), ['/saves/W']);
});

test('installs once, and not without CheerpJ', () => {
  installFakeRename();
  assert.equal(fixDirectoryRenames(), true);
  const wrapped = window.cheerpOSRenameMain;
  assert.equal(fixDirectoryRenames(), false);
  assert.equal(window.cheerpOSRenameMain, wrapped);
  globalThis.window = {};
  assert.equal(fixDirectoryRenames(), false);
});

test('saves open files that changed, and nothing else', () => {
  const mount = fakeMount();
  const region = mount.cache('/saves/W/region/r.0.0.mca', 41, 1, 1);
  const clean = mount.cache('/saves/W/region/r.0.1.mca', 42, 1, 0);
  const closed = mount.cache('/saves/W/level.dat', 43, 0, 1); // CheerpJ saved it when it was closed
  const dir = mount.cache('/saves/W/region', 44, 1, 1);
  dir.permType = 0x41ff;
  globalThis.window = { cheerpjGetFSMountForPath: (point) => (point === '/files/' ? mount : null) };
  assert.equal(saveOpenFiles(), 1);
  assert.deepEqual([region.saved, clean.saved, closed.saved, dir.saved], [1, 0, 0, 0]);
  assert.equal(saveOpenFiles(), 0, 'unchanged since');
  region.dirty = 1;
  assert.equal(saveOpenFiles(), 1);
  assert.equal(region.saved, 2);
  globalThis.window = {};
  assert.equal(saveOpenFiles(), 0, 'without CheerpJ');
});
