import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

// Only Mojang's official distribution hosts may ever be fetched. URLs come from
// Mojang's own manifests, never from the browser, but the allowlist is enforced
// here as well so the proxy can't be turned into an open relay.
export const OFFICIAL_HOSTS = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
]);

const SHA1_RE = /^[0-9a-f]{40}$/;
const inflight = new Map();

export function isSha1(value) {
  return typeof value === 'string' && SHA1_RE.test(value);
}

export function assertOfficialUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !OFFICIAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to download from non-official host: ${parsed.hostname}`);
  }
  return parsed;
}

export function objectPath(sha1) {
  return path.join(config.cacheDir, 'objects', sha1.slice(0, 2), sha1);
}

async function fileSize(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

export async function isCached(sha1) {
  return (await fileSize(objectPath(sha1))) >= 0;
}

async function download({ sha1, url, size }, onProgress) {
  assertOfficialUrl(url);
  const target = objectPath(sha1);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.part`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'web-minecraft/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const hash = createHash('sha1');
      let received = 0;
      const body = Readable.fromWeb(response.body);
      body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(chunk.length);
      });
      await pipeline(body, createWriteStream(temp));
      const digest = hash.digest('hex');
      if (digest !== sha1) throw new Error(`SHA-1 mismatch for ${url}: expected ${sha1}, got ${digest}`);
      if (size && received !== size) throw new Error(`Size mismatch for ${url}: expected ${size}, got ${received}`);
      await rename(temp, target);
      return target;
    } catch (error) {
      lastError = error;
      await rm(temp, { force: true });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

/**
 * Makes sure an official file is present in the local cache, verifying its SHA-1.
 * Concurrent requests for the same object share one download.
 */
export async function ensureFile(entry, onProgress) {
  if (!isSha1(entry.sha1)) throw new Error(`Invalid SHA-1 for ${entry.url}`);
  const target = objectPath(entry.sha1);
  if ((await fileSize(target)) >= 0) return target;

  let job = inflight.get(entry.sha1);
  if (!job) {
    job = download(entry, onProgress).finally(() => inflight.delete(entry.sha1));
    inflight.set(entry.sha1, job);
  }
  return job;
}

/** Downloads a list of files with bounded concurrency, reporting byte progress. */
export async function ensureFiles(entries, { concurrency = 6, onProgress } = {}) {
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      const alreadyCached = await isCached(entry.sha1);
      await ensureFile(entry, (bytes) => onProgress?.({ bytes, entry }));
      onProgress?.({ done: entry, cached: alreadyCached });
    }
  });
  await Promise.all(workers);
}
