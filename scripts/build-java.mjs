// Rebuilds public/webmc-launcher.jar from java/src (needs a JDK 9+; output targets Java 8).
// Usage: npm run build:java   (uses JAVA_HOME/bin or javac/jar on PATH)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = (name) => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name);

// LWJGL is only needed at compile time (webmc.lwjgl.HeapAllocator implements its allocator
// interface, webmc.lwjgl.Stb uses stb's callback structs); at run time the game's own LWJGL
// jars are used.
const LWJGL_JARS = ['lwjgl', 'lwjgl-stb'].map((name) => ({
  file: path.join(root, 'java', 'lib', `${name}-3.3.1.jar`),
  url: `https://repo1.maven.org/maven2/org/lwjgl/${name}/3.3.1/${name}-3.3.1.jar`,
}));

function listJava(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listJava(full);
    return full.endsWith('.java') ? [full] : [];
  });
}

for (const { file, url } of LWJGL_JARS) {
  if (existsSync(file)) continue;
  mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

const out = path.join(root, 'java', 'build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const sources = listJava(path.join(root, 'java', 'src'));
const lwjglSources = sources.filter((f) => f.includes(`${path.sep}lwjgl${path.sep}`));
const plainSources = sources.filter((f) => !lwjglSources.includes(f));

// Pass 1: everything that only needs the Java 8 API.
execFileSync(tool('javac'), ['--release', '8', '-Xlint:-options', '-d', out, ...plainSources], { stdio: 'inherit' });
// Pass 2: classes using sun.misc.Unsafe and LWJGL (hidden by --release); they avoid any API newer than Java 8.
execFileSync(tool('javac'), ['-source', '8', '-target', '8', '-Xlint:-options', '-nowarn', '-cp', [out, ...LWJGL_JARS.map((j) => j.file)].join(path.delimiter), '-d', out, ...lwjglSources], { stdio: 'inherit' });
// Pass 3 (java/src17): stand-ins for Java 18+ methods that need the Java 11 - 17 API; they are
// only referenced by downgraded game classes, which run on the Java 17 runtime.
const java17Sources = listJava(path.join(root, 'java', 'src17'));
execFileSync(tool('javac'), ['--release', '17', '-Xlint:-options', '-cp', out, '-d', out, ...java17Sources], { stdio: 'inherit' });

const resources = path.join(root, 'java', 'resources');
if (existsSync(resources)) cpSync(resources, out, { recursive: true });
execFileSync(tool('jar'), ['--create', '--file', path.join(root, 'public', 'webmc-launcher.jar'), '--date=2026-01-01T00:00:00Z', '-C', out, '.'], { stdio: 'inherit' });
console.log('Built public/webmc-launcher.jar');
