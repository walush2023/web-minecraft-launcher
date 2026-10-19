import express from 'express';
import path from 'node:path';
import { config, isAuthConfigured, ROOT_DIR } from './config.js';
import {
  AuthError,
  consumePendingLogin,
  ensureFreshMinecraftToken,
  offlineIdentity,
  redeemCode,
  signInWithMicrosoftToken,
  startLogin,
} from './auth.js';
import { createSession, destroySession, getSession, parseCookies, updateSession, cookieOptions } from './sessions.js';
import { ensureFile, ensureFiles } from './cache.js';
import { findNpeCatchingClasses } from './classscan.js';
import {
  assetObjectEntry,
  buildLaunchPlan,
  getAssetIndex,
  getVersionJson,
  listVersions,
  lookupFile,
} from './mojang.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

const OAUTH_STATE_COOKIE = 'mcw_oauth';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

function isLocalRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function devOfflineAllowed(req) {
  return config.devOffline && isLocalRequest(req);
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * Resolves who is playing. Only accounts that own Minecraft: Java Edition may
 * fetch game files or launch; the localhost development mode is the one exception.
 */
async function resolvePlayer(req, { refresh = false } = {}) {
  const session = getSession(req);
  if (session?.owned) {
    if (refresh) {
      const refreshed = await ensureFreshMinecraftToken(session);
      if (refreshed) {
        updateSession(session.id, refreshed);
        Object.assign(session, refreshed);
      }
      if (!session.owned) return null;
    }
    return {
      kind: 'microsoft',
      name: session.profile.name,
      uuid: session.profile.id,
      accessToken: session.mcAccessToken,
    };
  }
  if (devOfflineAllowed(req)) {
    const name = String(req.query.name || 'Player').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player';
    return { kind: 'offline', ...offlineIdentity(name) };
  }
  return null;
}

function requireOwner(req, res, next) {
  const session = getSession(req);
  if (session?.owned || devOfflineAllowed(req)) return next();
  res.status(403).type('text/plain').send('Sign in with a Microsoft account that owns Minecraft: Java Edition.');
}

// ---------------------------------------------------------------------------
// Microsoft sign-in
// ---------------------------------------------------------------------------
app.get('/auth/login', (req, res) => {
  if (!isAuthConfigured()) return res.redirect('/?error=not-configured');
  const { state, url } = startLogin({ prompt: req.query.prompt === 'login' ? 'login' : undefined });
  res.cookie(OAUTH_STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
  res.redirect(url);
});

app.get('/auth/callback', asyncRoute(async (req, res) => {
  const fail = (code, message) => {
    const params = new URLSearchParams({ error: code });
    if (message) params.set('message', message);
    res.redirect(`/?${params}`);
  };
  const { code, state, error, error_description: description } = req.query;
  const expectedState = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { ...cookieOptions(0), maxAge: undefined });
  if (error) return fail(String(error), String(description || '').split('\r\n')[0]);
  if (!code || !state || state !== expectedState) return fail('state', 'Sign-in session expired or was tampered with. Please try again.');
  const pending = consumePendingLogin(String(state));
  if (!pending) return fail('state', 'Sign-in session expired. Please try again.');

  try {
    const ms = await redeemCode(String(code), pending.verifier);
    const result = await signInWithMicrosoftToken(ms.access_token);
    destroySession(req, res);
    createSession(res, { ...result, msRefreshToken: ms.refresh_token });
    res.redirect(result.owned ? '/' : '/?error=not-owned');
  } catch (err) {
    console.error('[auth] sign-in failed:', err.code || '', err.message, err.details || '');
    fail(err instanceof AuthError ? err.code : 'unknown', err.message);
  }
}));

app.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/api/me', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const base = {
    authConfigured: isAuthConfigured(),
    devOffline: devOfflineAllowed(req),
    cheerpj: { version: config.cheerpjVersion, licenseKey: config.cheerpjLicenseKey || undefined },
  };
  const session = getSession(req);
  if (!session) return res.json({ ...base, signedIn: false });
  try {
    const refreshed = await ensureFreshMinecraftToken(session);
    if (refreshed) {
      updateSession(session.id, refreshed);
      Object.assign(session, refreshed);
    }
  } catch (err) {
    console.warn('[auth] refresh failed:', err.message);
    destroySession(req, res);
    return res.json({ ...base, signedIn: false, error: err.message });
  }
  res.json({ ...base, signedIn: true, owned: Boolean(session.owned), profile: session.profile });
}));

app.get('/api/versions', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await listVersions());
}));

app.get('/api/versions/:id/plan', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const player = await resolvePlayer(req, { refresh: true });
  if (!player) return res.status(403).json({ error: 'Sign in with a Microsoft account that owns Minecraft: Java Edition.' });
  const { entry, json } = await getVersionJson(req.params.id);
  const plan = buildLaunchPlan(entry, json, player);
  res.json({ ...plan, player: { name: player.name, uuid: player.uuid, kind: player.kind } });
}));

// Downloads everything a version needs from Mojang into the server cache, streaming progress (SSE).
app.get('/api/versions/:id/prepare', asyncRoute(async (req, res) => {
  const player = await resolvePlayer(req);
  if (!player) return res.status(403).json({ error: 'Not allowed' });
  const { entry, json } = await getVersionJson(req.params.id);
  const plan = buildLaunchPlan(entry, json, player);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (plan.problems.length) {
    send('fail', { message: plan.problems.join(' ') });
    return res.end();
  }

  const total = plan.totalSize;
  let downloaded = 0;
  let filesDone = 0;
  let lastSent = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSent < 120) return;
    lastSent = now;
    send('progress', { downloaded, total, filesDone, filesTotal: plan.files.length });
  };
  try {
    await ensureFiles(plan.files, {
      onProgress: ({ bytes, done, cached }) => {
        if (bytes) downloaded += bytes;
        if (done) {
          filesDone += 1;
          if (cached) downloaded += done.size || 0;
          report(true);
        } else report();
      },
    });
    if (plan.assetIndexEntry) await ensureFile(plan.assetIndexEntry);
    const client = plan.files.find((f) => f.kind === 'client');
    const npePatchClasses = await findNpeCatchingClasses(await ensureFile(client), client.sha1);
    send('done', { files: plan.files.length, total, npePatchClasses });
  } catch (err) {
    console.error('[prepare]', err);
    send('fail', { message: err.message });
  }
  res.end();
}));

// ---------------------------------------------------------------------------
// Game files for the browser JVM (CheerpJ reads these lazily with HTTP range requests)
// ---------------------------------------------------------------------------
const IMMUTABLE = 'private, max-age=31536000, immutable';

function sendCached(res, file, type) {
  res.type(type);
  res.sendFile(file, { headers: { 'Cache-Control': IMMUTABLE }, acceptRanges: true, cacheControl: false, dotfiles: 'allow' });
}

app.get('/mc/files/:sha1/:name', requireOwner, asyncRoute(async (req, res) => {
  const meta = lookupFile(req.params.sha1);
  if (!meta) return res.status(404).end();
  const file = await ensureFile({ sha1: req.params.sha1, ...meta });
  sendCached(res, file, req.params.name.endsWith('.jar') ? 'application/java-archive' : 'application/octet-stream');
}));

app.get('/mc/assets/indexes/:file', requireOwner, asyncRoute(async (req, res) => {
  const id = req.params.file.replace(/\.json$/, '');
  const result = await getAssetIndex(id);
  if (!result) return res.status(404).end();
  res.type('application/json');
  res.sendFile(result.file, { headers: { 'Cache-Control': 'private, no-cache' }, acceptRanges: true, cacheControl: false });
}));

app.get('/mc/assets/objects/:prefix/:hash', requireOwner, asyncRoute(async (req, res) => {
  const entry = assetObjectEntry(req.params.hash);
  if (!entry || req.params.prefix !== req.params.hash.slice(0, 2)) return res.status(404).end();
  sendCached(res, await ensureFile(entry), 'application/octet-stream');
}));

// 1.6.x reads assets from a "virtual" directory tree keyed by their original paths.
app.get('/mc/assets/virtual/:index/*asset', requireOwner, asyncRoute(async (req, res) => {
  const result = await getAssetIndex(req.params.index);
  const key = [].concat(req.params.asset).join('/');
  const object = result?.index.objects[key];
  if (!object) return res.status(404).end();
  sendCached(res, await ensureFile(assetObjectEntry(object.hash)), 'application/octet-stream');
}));

app.use('/mc', (req, res) => res.status(404).end());

// ---------------------------------------------------------------------------
// Static front-end
// ---------------------------------------------------------------------------
app.use(express.static(path.join(ROOT_DIR, 'public'), {
  extensions: ['html'],
  setHeaders(res, file) {
    if (file.includes(`${path.sep}lwjgl${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=604800');
    if (file.endsWith('.wasm') || file.endsWith('.so')) res.setHeader('Content-Type', 'application/wasm');
  },
}));

app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(config.port, config.host, () => {
  console.log(`Web Minecraft launcher running at ${config.publicUrl}`);
  if (!isAuthConfigured()) console.warn('AZURE_CLIENT_ID is not set: Microsoft sign-in is disabled. See README.md.');
  if (config.devOfflineIgnored) console.warn('DEV_OFFLINE is ignored: it only works while HOST is a loopback address (127.0.0.1).');
  if (config.devOffline) console.warn('DEV_OFFLINE is on: requests from this machine can play without signing in. Development only: you still need to own Minecraft: Java Edition.');
});
