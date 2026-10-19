import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Sessions hold Microsoft refresh tokens, so they live server-side only. The browser
// gets an opaque random ID in an HttpOnly cookie; the store on disk is AES-256-GCM encrypted.
const COOKIE_NAME = 'mcw_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const storeFile = path.join(config.dataDir, 'sessions.bin');
const key = createHash('sha256').update(`session-store:${config.sessionSecret}`).digest();

const sessions = load();
let saveTimer;

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

function load() {
  try {
    const entries = JSON.parse(decrypt(readFileSync(storeFile)));
    const now = Date.now();
    return new Map(entries.filter(([, s]) => s.expiresAt > now));
  } catch {
    return new Map();
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const temp = `${storeFile}.tmp`;
    await writeFile(temp, encrypt(JSON.stringify([...sessions])), { mode: 0o600 });
    await rename(temp, storeFile);
  }, 200);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function getSession(req) {
  const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    saveSoon();
    return null;
  }
  return { id, ...session };
}

export function createSession(res, data) {
  const id = randomBytes(32).toString('base64url');
  sessions.set(id, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSoon();
  res.cookie(COOKIE_NAME, id, cookieOptions(SESSION_TTL_MS));
  return id;
}

export function updateSession(id, data) {
  const current = sessions.get(id);
  if (!current) return;
  sessions.set(id, { ...current, ...data });
  saveSoon();
}

export function destroySession(req, res) {
  const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (id && sessions.delete(id)) saveSoon();
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(0), maxAge: undefined });
}
