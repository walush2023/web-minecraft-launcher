// Fixes for CheerpJ's IndexedDB file system (/files/), installed once cheerpjInit has loaded its
// OS layer (cheerpOS.js, whose functions are page globals called by name).

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;

// CheerpJ renames a directory in IndexedDB in one transaction, together with everything in it,
// but then forgets only the cached entries of the two paths themselves:
// - files under the old path that were opened in the last 10 seconds (CheerpJ keeps closed
//   files that long) stay cached under their old names, with their old contents;
// - the directory records it caches for lookups keep listing what the directories held before,
//   and creating a file through such a record writes that old listing back.
// 26.x swaps world folders by renaming them when it upgrades an older world: right after the
// swap the new folder seemed to have no level.dat and the upgrade failed. After each rename this
// also forgets the cached entries below both paths; files that are still open follow the rename
// (they are written back to their path) and stay cached under their new name.
export function fixDirectoryRenames() {
  const rename = window.cheerpOSRenameMain;
  if (typeof rename !== 'function' || rename.webmcFixed) return false;
  function renameMain(mount, src, dst, cb) {
    const files = cachedFilesAt(mount, src);
    return rename(mount, src, dst, (ret) => {
      if (ret) {
        const moved = [];
        for (const fileData of files) {
          const path = fileData.path;
          if (typeof path === 'string' && (path === src || path.startsWith(`${src}/`))) {
            fileData.path = dst + path.slice(src.length);
            if (fileData.refCount > 0) moved.push(fileData);
          }
        }
        forgetBelow(mount, src);
        forgetBelow(mount, dst);
        if (typeof mount.setCached === 'function') {
          for (const fileData of moved) mount.setCached(fileData.path, fileData);
        }
      }
      return cb(ret);
    });
  }
  renameMain.webmcFixed = true;
  window.cheerpOSRenameMain = renameMain;
  return true;
}

// The cached file data of the path and everything below it.
function cachedFilesAt(mount, path) {
  const files = new Set();
  const names = mount.fileCache;
  if (!names || !mount.inodeCache) return files;
  for (const name of Object.keys(names)) {
    if (name === path || name.startsWith(`${path}/`)) {
      const fileData = mount.inodeCache[names[name]];
      if (fileData) files.add(fileData);
    }
  }
  return files;
}

function forgetBelow(mount, path) {
  const below = `${path}/`;
  if (mount.fileCache && typeof mount.clearCached === 'function') {
    for (const name of Object.keys(mount.fileCache)) {
      if (name.startsWith(below)) mount.clearCached(name);
    }
  }
  const records = mount.dEntries; // IndexedDB mounts only
  if (records) {
    for (const name of Object.keys(records)) {
      if (name === path || name.startsWith(below)) delete records[name];
    }
  }
}

// CheerpJ writes a file to IndexedDB only when its last descriptor is closed: fsync and
// fdatasync do nothing ("TODO: fsync" in the console). The game keeps its region files open for
// as long as a world is loaded and counts on the system to keep what it wrote, so closing the tab
// instead of "Save and Quit" lost every chunk saved since the world was opened (new region files
// stayed empty). Open files that changed are written to IndexedDB every few seconds and when the
// page is hidden: like the game being stopped at that moment, which its files are made to survive.
export function keepOpenFilesSaved({ interval = 20000, mountPoint = '/files/' } = {}) {
  const save = () => {
    try {
      saveOpenFiles(mountPoint);
    } catch (error) {
      console.warn('[launcher] could not save open files:', error);
    }
  };
  const timer = setInterval(save, interval);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('pagehide', save);
  return () => clearInterval(timer);
}

// Starts writing every changed open file of the mount to IndexedDB; returns how many.
export function saveOpenFiles(mountPoint = '/files/') {
  const mount = typeof window.cheerpjGetFSMountForPath === 'function' ? window.cheerpjGetFSMountForPath(mountPoint) : null;
  const files = mount && mount.isSplit ? mount.inodeCache : null; // IndexedDB mounts only
  if (!files) return 0;
  let saved = 0;
  for (const key of Object.keys(files)) {
    const fileData = files[key];
    if (!fileData || !fileData.dirty || !(fileData.refCount > 0)) continue;
    if ((fileData.permType & S_IFMT) !== S_IFREG || typeof fileData.mount?.close !== 'function') continue;
    fileData.mount.close(fileData, () => {}); // CheerpJ's commit (it does not close anything)
    saved++;
  }
  return saved;
}
