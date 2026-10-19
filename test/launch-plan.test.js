import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildLaunchPlan, estimateSupport, LWJGL2_CLASSPATH } = await import('../server/mojang.js');

const sha = (n) => String(n).padStart(40, '0');
const artifact = (path, n) => ({ downloads: { artifact: { path, sha1: sha(n), size: 10, url: `https://libraries.minecraft.net/${path}` } } });
const auth = { name: 'Steve', uuid: 'abcdef0123456789abcdef0123456789', accessToken: 'mc-token' };
const client = (n) => ({ client: { sha1: sha(n), size: 100, url: `https://piston-data.mojang.com/v1/objects/${sha(n)}/client.jar` } });

const modern = {
  id: '1.8.9',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
  assetIndex: { id: '1.8', sha1: sha(9), size: 1, url: 'https://launchermeta.mojang.com/v1/packages/x/1.8.json' },
  javaVersion: { majorVersion: 8 },
  downloads: client(1),
  libraries: [
    { name: 'com.google.guava:guava:17.0', ...artifact('com/google/guava/guava/17.0/guava-17.0.jar', 2) },
    { name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209', ...artifact('org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl.jar', 3), rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }] },
    { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209', natives: { linux: 'natives-linux' } },
    { name: 'tv.twitch:twitch-platform:6.5', natives: { linux: 'natives-linux' } },
    { name: 'ca.weblite:java-objc-bridge:1.0.0', ...artifact('ca/weblite/objc.jar', 4), rules: [{ action: 'allow', os: { name: 'osx' } }] },
  ],
};
const entry = (json) => ({ id: json.id, type: json.type, releaseTime: json.releaseTime || '2015-12-03T09:24:39+00:00' });

test('plans a 1.6+ client: libraries, WebAssembly LWJGL and substituted arguments', () => {
  const plan = buildLaunchPlan(entry(modern), modern, auth);
  assert.equal(plan.mode, 'modern');
  assert.equal(plan.mainClass, 'net.minecraft.client.main.Main');
  assert.equal(plan.lwjgl, 2);
  assert.deepEqual(plan.problems, []);
  // Native and macOS-only libraries are skipped; Mojang's LWJGL is replaced by the browser build.
  assert.deepEqual(plan.files.map((f) => f.name), ['guava-17.0.jar', '1.8.9.jar']);
  assert.deepEqual(plan.classpath, [`/app/mc/files/${sha(2)}/guava-17.0.jar`, ...LWJGL2_CLASSPATH, `/app/mc/files/${sha(1)}/1.8.9.jar`]);
  const arg = (name) => plan.args[plan.args.indexOf(name) + 1];
  assert.equal(arg('--username'), 'Steve');
  assert.equal(arg('--accessToken'), 'mc-token');
  assert.equal(arg('--gameDir'), '/files/.minecraft');
  assert.equal(arg('--assetsDir'), '/app/mc/assets');
  assert.equal(arg('--assetIndex'), '1.8');
  assert.equal(arg('--userType'), 'mojang');
  assert.equal(plan.javaVersion, 8);
  assert.equal(plan.supportsWindowArgs, true);
});

test('plans pre-1.6 clients as applets without launchwrapper', () => {
  const legacy = {
    ...modern,
    id: '1.2.5',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments: '${auth_player_name} ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}',
    libraries: [
      { name: 'net.minecraft:launchwrapper:1.5', ...artifact('net/minecraft/launchwrapper.jar', 5) },
      { name: 'net.java.jinput:jinput:2.0.5', ...artifact('net/java/jinput/jinput-2.0.5.jar', 6) },
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.0', ...artifact('org/lwjgl/lwjgl/lwjgl/2.9.0/lwjgl-2.9.0.jar', 7) },
    ],
  };
  const plan = buildLaunchPlan({ ...entry(legacy), releaseTime: '2012-03-29T22:00:00+00:00' }, legacy, auth);
  assert.equal(plan.mode, 'applet');
  assert.deepEqual(plan.args, ['Steve', 'token:mc-token:abcdef0123456789abcdef0123456789']);
  assert.ok(!plan.files.some((f) => f.name.includes('launchwrapper')));
  assert.ok(plan.files.some((f) => f.name === 'jinput-2.0.5.jar'));
});

test('uses the vanilla offline session marker in development mode', () => {
  const legacy = { ...modern, mainClass: 'net.minecraft.launchwrapper.Launch', minecraftArguments: '${auth_player_name} ${auth_session}' };
  const plan = buildLaunchPlan(entry(legacy), legacy, { name: 'Player', uuid: '0'.repeat(32), accessToken: '0' });
  assert.deepEqual(plan.args, ['Player', '-']);
});

test('plans LWJGL 3 clients for the JavaScript backend and skips native jars', () => {
  const lwjgl3 = {
    ...modern,
    id: '1.20.1',
    javaVersion: { majorVersion: 17 },
    libraries: [
      { name: 'org.lwjgl:lwjgl:3.3.1', ...artifact('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', 8) },
      { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux', ...artifact('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar', 11), rules: [{ action: 'allow', os: { name: 'linux' } }] },
    ],
  };
  const plan = buildLaunchPlan(entry(lwjgl3), lwjgl3, auth);
  assert.equal(plan.lwjgl, 3);
  assert.equal(plan.mode, 'lwjgl3');
  assert.equal(plan.javaVersion, 17);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.files.map((f) => f.name), ['lwjgl-3.3.1.jar', '1.20.1.jar']);

  // 1.13 - 1.16.5 are Java 8 builds but run on the Java 17 runtime like every LWJGL 3 version.
  const java8 = { ...lwjgl3, id: '1.16.5', javaVersion: { majorVersion: 8 } };
  const plan8 = buildLaunchPlan(entry(java8), java8, auth);
  assert.equal(plan8.javaVersion, 17);
  assert.equal(plan8.gameJava, 8);
  assert.equal(plan8.downgrade, false);
});

test('runs Java 21 and 25 clients downgraded on the Java 17 runtime, 26.x with SDL and OpenGL', () => {
  const lwjgl = [{ name: 'org.lwjgl:lwjgl:3.3.3', ...artifact('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar', 12) }];
  const java21 = { ...modern, id: '1.21.1', javaVersion: { majorVersion: 21 }, libraries: lwjgl };
  const plan21 = buildLaunchPlan(entry(java21), java21, auth);
  assert.deepEqual(plan21.problems, []);
  assert.equal(plan21.javaVersion, 17);
  assert.equal(plan21.gameJava, 21);
  assert.equal(plan21.downgrade, true);
  assert.equal(plan21.windowSystem, 'glfw');
  const sdl = [...lwjgl, { name: 'org.lwjgl:lwjgl-sdl:3.4.3', ...artifact('org/lwjgl/lwjgl-sdl/3.4.3/lwjgl-sdl-3.4.3.jar', 13) }];
  const java25 = { ...modern, id: '26.3', javaVersion: { majorVersion: 25 }, libraries: sdl };
  const plan25 = buildLaunchPlan(entry(java25), java25, auth);
  assert.deepEqual(plan25.problems, []);
  assert.equal(plan25.downgrade, true);
  assert.equal(plan25.windowSystem, 'sdl');
  assert.deepEqual(plan25.args.slice(-2), ['--graphicsBackend', 'opengl']);
  const java26 = { ...java25, id: '27.1', javaVersion: { majorVersion: 26 } };
  assert.match(buildLaunchPlan(entry(java26), java26, auth).problems[0], /Java 26/);
});

test('estimates support from the release date before the version JSON is fetched', () => {
  assert.equal(estimateSupport({ id: '1.8.9', releaseTime: '2015-12-03T09:24:39+00:00' }).level, 'tested');
  assert.equal(estimateSupport({ id: '1.11.2', releaseTime: '2016-12-21T09:29:12+00:00' }).level, 'experimental');
  assert.equal(estimateSupport({ id: '1.13', releaseTime: '2018-07-18T15:11:46+00:00' }).level, 'experimental');
  assert.equal(estimateSupport({ id: '1.20.1', releaseTime: '2023-06-12T13:25:51+00:00' }).level, 'tested');
  assert.equal(estimateSupport({ id: '1.20.6', releaseTime: '2024-04-29T12:00:00+00:00' }).level, 'experimental');
  assert.equal(estimateSupport({ id: '26.1', releaseTime: '2026-03-24T12:11:04+00:00' }).level, 'experimental');
  assert.equal(estimateSupport({ id: 'c0.30_01c', releaseTime: '2009-12-21T22:00:00+00:00' }).level, 'experimental');
});

test('refuses to plan downloads from non-Mojang hosts', () => {
  const evil = { ...modern, libraries: [{ name: 'x:y:1', downloads: { artifact: { path: 'y.jar', sha1: sha(10), size: 1, url: 'https://example.com/y.jar' } } }] };
  assert.throws(() => buildLaunchPlan(entry(evil), evil, auth), /non-official host/);
});
