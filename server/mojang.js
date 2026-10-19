import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { assertOfficialUrl, ensureFile, isSha1 } from './cache.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const RESOURCES_URL = 'https://resources.download.minecraft.net';

// The browser runtime ships a WebAssembly build of LWJGL 2.9.3 (from leaningtech/browsercraft).
// Every Mojang LWJGL 2.x dependency is swapped for these jars so Java and native code match.
export const LWJGL2_CLASSPATH = ['/app/lwjgl/lwjgl-2.9.3.jar', '/app/lwjgl/lwjgl_util-2.9.3.jar'];

// 17w43a (first 1.13 snapshot) moved the client to LWJGL 3, which runs on the JavaScript
// backend in public/lwjgl3. 24w14a (1.20.5) requires Java 21 and 26.1-snapshot-1 Java 25; both run
// downgraded to the browser JVM's Java 17.
const LWJGL3_SINCE = Date.parse('2017-10-25T00:00:00Z');
const JAVA21_SINCE = Date.parse('2024-04-03T00:00:00Z');
const JAVA25_SINCE = Date.parse('2025-12-16T00:00:00Z');

// Versions that were launched and played in a world through this project.
export const TESTED_VERSIONS = new Set(['b1.7.3', '1.2.5', '1.5.2', '1.6.4', '1.7.10', '1.8.9', '1.10.2', '1.12.2', '1.16.5', '1.20.1', '1.21.10', '26.3']);

export const GAME_DIR = '/files/.minecraft';
export const ASSETS_ROOT = '/app/mc/assets';

let manifestCache = { data: null, fetchedAt: 0 };
const manifestFile = () => path.join(config.cacheDir, 'version_manifest_v2.json');

export async function getManifest({ force = false } = {}) {
  const fresh = Date.now() - manifestCache.fetchedAt < MANIFEST_TTL_MS;
  if (manifestCache.data && fresh && !force) return manifestCache.data;
  try {
    const response = await fetch(MANIFEST_URL, { headers: { 'User-Agent': 'web-minecraft/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    manifestCache = { data, fetchedAt: Date.now() };
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(manifestFile(), JSON.stringify(data));
    return data;
  } catch (error) {
    // Offline fallback: reuse the last manifest we saw.
    if (manifestCache.data) return manifestCache.data;
    if (existsSync(manifestFile())) {
      manifestCache = { data: JSON.parse(await readFile(manifestFile(), 'utf8')), fetchedAt: Date.now() };
      return manifestCache.data;
    }
    throw new Error(`Could not load the Mojang version manifest: ${error.message}`);
  }
}

/** Quick support estimate for the version list, before the version JSON is downloaded. */
export function estimateSupport(entry) {
  const released = Date.parse(entry.releaseTime);
  if (TESTED_VERSIONS.has(entry.id)) return { level: 'tested', reason: 'Tested in this launcher' };
  if (released >= JAVA25_SINCE) {
    return { level: 'experimental', reason: 'Java 25 build (SDL3 window, Vulkan-style shaders), downgraded in memory to run on the browser\'s Java 17' };
  }
  if (released >= JAVA21_SINCE) {
    return { level: 'experimental', reason: 'Java 21 build, downgraded in memory to run on the browser\'s Java 17' };
  }
  if (released >= LWJGL3_SINCE) {
    return { level: 'experimental', reason: 'LWJGL 3 build running on the WebGL 2 backend' };
  }
  if (/^(rd-|c0\.|inf-|in-)/.test(entry.id)) {
    return { level: 'experimental', reason: 'Pre-Alpha build; may not start' };
  }
  return { level: 'experimental', reason: 'LWJGL 2 build; should run but is not individually tested' };
}

export async function listVersions() {
  const manifest = await getManifest();
  return {
    latest: manifest.latest,
    versions: manifest.versions.map((entry) => ({
      id: entry.id,
      type: entry.type,
      releaseTime: entry.releaseTime,
      support: estimateSupport(entry),
    })),
  };
}

// ---------------------------------------------------------------------------
// Registry: maps the content-addressed URLs we hand to CheerpJ back to the
// official Mojang URLs, so files can be (re)fetched on demand after a restart.
// ---------------------------------------------------------------------------
const registryFile = () => path.join(config.cacheDir, 'registry.json');
const registry = loadRegistry();
let registrySaveTimer;

function loadRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), 'utf8'));
    return { files: parsed.files || {}, assetIndexes: parsed.assetIndexes || {} };
  } catch {
    return { files: {}, assetIndexes: {} };
  }
}

function saveRegistrySoon() {
  clearTimeout(registrySaveTimer);
  registrySaveTimer = setTimeout(async () => {
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(registryFile(), JSON.stringify(registry));
  }, 250);
}

function registerFile(file) {
  registry.files[file.sha1] = { url: file.url, size: file.size, name: file.name };
  saveRegistrySoon();
}

export function lookupFile(sha1) {
  return isSha1(sha1) ? registry.files[sha1] : undefined;
}

export function lookupAssetIndex(id) {
  return Object.hasOwn(registry.assetIndexes, id) ? registry.assetIndexes[id] : undefined;
}

// ---------------------------------------------------------------------------
// Version JSON handling
// ---------------------------------------------------------------------------
export async function getVersionJson(id) {
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) {
    const error = new Error(`Unknown version: ${id}`);
    error.status = 404;
    throw error;
  }
  const file = await ensureFile({ sha1: entry.sha1, url: entry.url });
  return { entry, json: JSON.parse(await readFile(file, 'utf8')) };
}

// The browser runtime presents itself as an x86-64 Linux machine with an X11 display.
function rulesAllow(rules) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== 'linux') matches = false;
      if (rule.os.arch && rule.os.arch !== 'x86_64') matches = false;
    }
    if (rule.features) matches = false;
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function substitute(template, values) {
  return template.replace(/\$\{([a-z_]+)\}/g, (match, key) => (key in values ? values[key] : match));
}

const LAUNCHWRAPPER_ONLY = new Set(['net.minecraft:launchwrapper', 'org.ow2.asm:asm-all', 'net.sf.jopt-simple:jopt-simple']);

/**
 * Turns a Mojang version JSON into everything the browser needs to start the game:
 * the files to fetch, the CheerpJ classpath, the main class and its arguments.
 */
export function buildLaunchPlan(entry, json, auth) {
  const files = [];
  const seen = new Set();
  let lwjgl = null;

  const rawArgs = json.minecraftArguments
    ? json.minecraftArguments.split(/\s+/).filter(Boolean)
    : (json.arguments?.game || []).filter((arg) => typeof arg === 'string');

  // Launch modes:
  //  applet - clients before 1.6 (launchwrapper in Mojang's JSON). They are hosted as an applet
  //           by webmc.Launcher, like the original launcher did; this skips launchwrapper's
  //           bytecode-rewriting class loader, which is slow in a browser JVM.
  //  modern - net.minecraft.client.main.Main (1.6+), started with its normal arguments.
  //  lwjgl3 - 1.13+ (LWJGL 3): like modern, with LWJGL 3 running on the JavaScript backend.
  //  direct - any other main class (e.g. rd-132211), started without arguments.
  let mainClass = json.mainClass;
  let mode = 'modern';
  if (mainClass === 'net.minecraft.launchwrapper.Launch') {
    mainClass = 'net.minecraft.client.Minecraft';
    mode = 'applet';
  } else if (mainClass !== 'net.minecraft.client.main.Main') {
    mode = 'direct';
  }

  for (const library of json.libraries || []) {
    if (!rulesAllow(library.rules)) continue;
    if (library.natives) continue; // Native code is provided by the WebAssembly runtime instead.
    const [group, artifact, , classifier] = library.name.split(':');
    if (classifier && classifier.startsWith('natives')) continue; // 1.19+ list natives as separate jars
    if (group === 'org.lwjgl.lwjgl' && (artifact === 'lwjgl' || artifact === 'lwjgl_util')) {
      lwjgl = 2;
      continue;
    }
    if (group === 'org.lwjgl') lwjgl = 3;
    if (mode === 'applet' && LAUNCHWRAPPER_ONLY.has(`${group}:${artifact}`)) continue;
    const download = library.downloads?.artifact;
    if (!download?.url || !download.sha1) continue;
    const key = `${group}:${artifact}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      kind: group === 'org.lwjgl' ? 'lwjgl' : 'library',
      sha1: download.sha1,
      size: download.size,
      url: download.url,
      name: path.posix.basename(download.path || new URL(download.url).pathname),
    });
  }

  const client = json.downloads?.client;
  if (!client) throw new Error(`Version ${entry.id} has no client download`);
  files.push({ kind: 'client', sha1: client.sha1, size: client.size, url: client.url, name: `${entry.id}.jar` });

  if (lwjgl === 3 && mode === 'modern') mode = 'lwjgl3';
  const javaMajor = json.javaVersion?.majorVersion ?? 8;
  const problems = [];
  // The browser JVM runs Java 8 - 17. Java 18 - 25 classes (1.20.5 and later) are downgraded
  // to Java 17 in memory as they load (webmc.ClassDowngrader).
  if (javaMajor > 25) problems.push(`這個版本需要 Java ${javaMajor}，目前網頁版最高支援 Java 25 的版本。`);
  else if (javaMajor > 17 && mode !== 'lwjgl3') problems.push(`這個版本需要 Java ${javaMajor}，瀏覽器中的 JVM（CheerpJ）目前最高支援 Java 17。`);

  for (const file of files) {
    assertOfficialUrl(file.url);
    registerFile(file);
  }

  const assetIndex = json.assetIndex;
  if (assetIndex?.url && isSha1(assetIndex.sha1)) {
    assertOfficialUrl(assetIndex.url);
    registry.assetIndexes[assetIndex.id] = { sha1: assetIndex.sha1, url: assetIndex.url, size: assetIndex.size };
    saveRegistrySoon();
  }

  const values = {
    auth_player_name: auth.name,
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    auth_session: auth.accessToken === '0' ? '-' : `token:${auth.accessToken}:${auth.uuid}`,
    auth_xuid: auth.xuid || '0',
    clientid: '0',
    user_properties: '{}',
    // Pre-1.16 clients only know the legacy account types; the value is informational.
    user_type: Date.parse(entry.releaseTime) >= Date.parse('2020-11-01T00:00:00Z') ? 'msa' : 'mojang',
    version_name: entry.id,
    version_type: entry.type,
    game_directory: GAME_DIR,
    assets_root: ASSETS_ROOT,
    assets_index_name: assetIndex?.id || 'legacy',
    game_assets: assetIndex?.id === 'legacy' ? `${ASSETS_ROOT}/virtual/legacy` : ASSETS_ROOT,
  };

  // 26.x open their window with SDL3 instead of GLFW (and can render with Vulkan, which a
  // browser does not have: the OpenGL backend is selected up front).
  const windowSystem = mode === 'lwjgl3' && files.some((f) => f.kind === 'lwjgl' && f.name.startsWith('lwjgl-sdl-')) ? 'sdl' : 'glfw';
  const args = mode === 'applet' ? [auth.name, values.auth_session]
    : mode === 'direct' ? []
      : rawArgs.map((arg) => substitute(arg, values));
  if (windowSystem === 'sdl') args.push('--graphicsBackend', 'opengl');

  const filePath = (f) => `/app/mc/files/${f.sha1}/${f.name}`;
  const libraryPaths = files.filter((f) => f.kind === 'library' || f.kind === 'lwjgl').map(filePath);
  const clientPath = `/app/mc/files/${client.sha1}/${entry.id}.jar`;
  const classpath = [...libraryPaths, ...(lwjgl === 2 ? LWJGL2_CLASSPATH : []), clientPath];
  // 1.13+: LWJGL 3 stays on the JVM's own classpath (its native libraries only load from the
  // system class loader); the rest is loaded by webmc.GameClassLoader.
  const systemClasspath = mode === 'lwjgl3' ? files.filter((f) => f.kind === 'lwjgl').map(filePath) : [];

  return {
    id: entry.id,
    type: entry.type,
    releaseTime: entry.releaseTime,
    mode,
    windowSystem,
    // Java runtime the browser JVM starts; gameJava is what the version was built for. LWJGL 3
    // always runs on Java 17: CheerpJ's Java 8 sun.misc.Unsafe has no absolute-address
    // getInt(null, address) & co., which LWJGL 3.1 - 3.2 (1.13 - 1.16.5) use for all memory access.
    javaVersion: mode === 'lwjgl3' ? 17 : javaMajor <= 8 ? 8 : javaMajor <= 11 ? 11 : 17,
    gameJava: javaMajor,
    downgrade: javaMajor > 17,
    mainClass,
    classpath,
    systemClasspath,
    args,
    supportsWindowArgs: mode === 'modern' || mode === 'lwjgl3',
    gameDir: GAME_DIR,
    assetIndex: assetIndex?.id || null,
    lwjgl,
    problems,
    support: estimateSupport(entry),
    files,
    assetIndexEntry: assetIndex?.url ? { id: assetIndex.id, sha1: assetIndex.sha1, size: assetIndex.size, url: assetIndex.url } : null,
    totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
const filteredIndexes = new Map();

// The browser JVM has no OpenAL, so the sound system always falls back to silent
// mode. Dropping sound entries from the asset index stops 1.9+ clients from probing
// hundreds of sound files over HTTP while loading resources.
function isSoundAsset(key) {
  return key === 'minecraft/sounds.json' || key.startsWith('minecraft/sounds/') || key.startsWith('sounds/')
    || key.startsWith('music/') || key.startsWith('newmusic/') || key.startsWith('records/') || key.startsWith('sound/')
    || key.startsWith('sound3/') || key.startsWith('streaming/') || key === 'sounds.json';
}

/**
 * Returns the asset index without sound entries, written to disk so it can be served
 * with HTTP range support (CheerpJ reads every /app/ file with range requests).
 */
export async function getAssetIndex(id) {
  const meta = lookupAssetIndex(id);
  if (!meta) return null;
  if (filteredIndexes.has(id)) return filteredIndexes.get(id);
  const source = await ensureFile(meta);
  const index = JSON.parse(await readFile(source, 'utf8'));
  const objects = {};
  for (const [key, value] of Object.entries(index.objects || {})) {
    if (!isSoundAsset(key)) objects[key] = value;
  }
  const filtered = { ...index, objects };
  const file = path.join(config.cacheDir, 'indexes', `${meta.sha1}-nosound.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(filtered));
  const result = { index: filtered, file };
  filteredIndexes.set(id, result);
  return result;
}

export function assetObjectEntry(hash) {
  if (!isSha1(hash)) return null;
  return { sha1: hash, url: `${RESOURCES_URL}/${hash.slice(0, 2)}/${hash}` };
}
