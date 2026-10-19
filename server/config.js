import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const port = Number(env.PORT || 3000);
const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });

// A stable secret is needed to encrypt the session store. Generate one on first run
// so the app works out of the box, but let operators pin it through .env.
function loadSessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const secretFile = path.join(dataDir, 'session-secret');
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// Listens on this machine only unless HOST says otherwise (e.g. HOST=0.0.0.0 behind a reverse proxy).
const host = env.HOST || '127.0.0.1';
const loopbackHost = ['127.0.0.1', '::1', 'localhost'].includes(host);

const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  host,
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir,
  cacheDir: path.join(dataDir, 'cache'),
  sessionSecret: loadSessionSecret(),
  azure: {
    clientId: env.AZURE_CLIENT_ID || '',
    clientSecret: env.AZURE_CLIENT_SECRET || '',
    // Minecraft accounts are personal Microsoft accounts, so the "consumers" tenant is correct.
    tenant: env.AZURE_TENANT || 'consumers',
    redirectUri: `${publicUrl}/auth/callback`,
  },
  // Development helper: lets requests from this machine launch the game without a
  // Microsoft account. Never honoured for remote clients, and ignored unless the server
  // listens on a loopback address (behind a reverse proxy every request looks local).
  devOffline: bool(env.DEV_OFFLINE) && loopbackHost,
  devOfflineIgnored: bool(env.DEV_OFFLINE) && !loopbackHost,
  cheerpjVersion: env.CHEERPJ_VERSION || '4.3',
  cheerpjLicenseKey: env.CHEERPJ_LICENSE_KEY || '',
};

export const isAuthConfigured = () => Boolean(config.azure.clientId);
