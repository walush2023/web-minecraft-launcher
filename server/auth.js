import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';

// Official sign-in chain used by the Minecraft Launcher:
// Microsoft account (OAuth 2.0) -> Xbox Live user token -> XSTS token -> Minecraft services token.
const MS_AUTHORITY = () => `https://login.microsoftonline.com/${config.azure.tenant}/oauth2/v2.0`;
const MS_SCOPE = 'XboxLive.signin offline_access';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/license';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

export class AuthError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const XSTS_ERRORS = {
  2148916227: 'This account is banned from Xbox Live.',
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at https://www.xbox.com/ to create one, then try again.',
  2148916235: 'Xbox Live is not available in the country of this account.',
  2148916236: 'This account needs adult verification on the Xbox website (South Korea).',
  2148916237: 'This account needs adult verification on the Xbox website (South Korea).',
  2148916238: 'This is a child account. An adult must add it to a Microsoft family before it can sign in.',
  2148916262: 'This account is not allowed to sign in to Xbox Live.',
};

// ---------------------------------------------------------------------------
// OAuth authorization code flow with PKCE
// ---------------------------------------------------------------------------
const pendingLogins = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function base64url(buffer) {
  return buffer.toString('base64url');
}

export function startLogin({ prompt } = {}) {
  const now = Date.now();
  for (const [state, pending] of pendingLogins) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingLogins.delete(state);
  }
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  pendingLogins.set(state, { verifier, createdAt: now });

  const params = new URLSearchParams({
    client_id: config.azure.clientId,
    response_type: 'code',
    redirect_uri: config.azure.redirectUri,
    response_mode: 'query',
    scope: MS_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: prompt || 'select_account',
  });
  return { state, url: `${MS_AUTHORITY()}/authorize?${params}` };
}

export function consumePendingLogin(state) {
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) return null;
  return pending;
}

async function postForm(url, form) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AuthError('microsoft', body.error_description?.split('\r\n')[0] || `Microsoft sign-in failed (HTTP ${response.status})`, body.error);
  }
  return body;
}

function tokenRequestBase() {
  const form = { client_id: config.azure.clientId, scope: MS_SCOPE };
  if (config.azure.clientSecret) form.client_secret = config.azure.clientSecret;
  return form;
}

export function redeemCode(code, verifier) {
  return postForm(`${MS_AUTHORITY()}/token`, {
    ...tokenRequestBase(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.azure.redirectUri,
    code_verifier: verifier,
  });
}

export function refreshMicrosoftToken(refreshToken) {
  return postForm(`${MS_AUTHORITY()}/token`, {
    ...tokenRequestBase(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

// ---------------------------------------------------------------------------
// Xbox Live + Minecraft services
// ---------------------------------------------------------------------------
async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, body };
}

async function authenticateXboxLive(msAccessToken) {
  const result = await postJson(XBL_AUTH_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!result.ok) throw new AuthError('xbox', `Xbox Live sign-in failed (HTTP ${result.status}).`, result.body);
  return { token: result.body.Token, userHash: result.body.DisplayClaims?.xui?.[0]?.uhs };
}

async function authorizeXsts(xblToken) {
  const result = await postJson(XSTS_AUTH_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!result.ok) {
    const message = XSTS_ERRORS[result.body.XErr] || `Xbox authorization failed (HTTP ${result.status}).`;
    throw new AuthError('xsts', message, result.body);
  }
  return { token: result.body.Token, userHash: result.body.DisplayClaims?.xui?.[0]?.uhs };
}

async function loginMinecraft(userHash, xstsToken) {
  const result = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${userHash};${xstsToken}` });
  if (!result.ok) {
    if (result.status === 403) {
      throw new AuthError(
        'app-not-approved',
        'Minecraft services rejected this Azure application. New Azure app IDs must be approved by Mojang before they can call the Minecraft API (https://aka.ms/mce-reviewappid).',
        result.body,
      );
    }
    throw new AuthError('minecraft', `Minecraft sign-in failed (HTTP ${result.status}).`, result.body);
  }
  return { accessToken: result.body.access_token, expiresAt: Date.now() + (result.body.expires_in || 86400) * 1000 };
}

async function getJson(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

/** Checks the account's Minecraft: Java Edition licence and loads its profile. */
export async function loadOwnership(mcAccessToken) {
  const [entitlements, profile] = await Promise.all([
    getJson(`${MC_ENTITLEMENTS_URL}?requestId=${randomUUID()}`, mcAccessToken),
    getJson(MC_PROFILE_URL, mcAccessToken),
  ]);
  const items = entitlements.ok ? entitlements.body.items || [] : [];
  const hasLicence = items.some((item) => item.name === 'product_minecraft' || item.name === 'game_minecraft');
  // Xbox Game Pass licences don't always show up as entitlements, but every owner has a profile.
  const hasProfile = profile.ok && Boolean(profile.body.id);
  return {
    owned: hasLicence || hasProfile,
    hasProfile,
    profile: hasProfile
      ? {
          id: profile.body.id,
          name: profile.body.name,
          skin: profile.body.skins?.find((s) => s.state === 'ACTIVE')?.url || null,
        }
      : null,
  };
}

/** Runs the full chain from a Microsoft access token to a Minecraft session. */
export async function signInWithMicrosoftToken(msAccessToken) {
  const xbl = await authenticateXboxLive(msAccessToken);
  const xsts = await authorizeXsts(xbl.token);
  const minecraft = await loginMinecraft(xsts.userHash || xbl.userHash, xsts.token);
  const ownership = await loadOwnership(minecraft.accessToken);
  return {
    mcAccessToken: minecraft.accessToken,
    mcExpiresAt: minecraft.expiresAt,
    xuid: null,
    ...ownership,
  };
}

/** Returns a fresh Minecraft token for a stored session, refreshing through Microsoft if needed. */
export async function ensureFreshMinecraftToken(session) {
  if (session.mcAccessToken && session.mcExpiresAt - Date.now() > 5 * 60 * 1000) return null;
  if (!session.msRefreshToken) throw new AuthError('expired', 'Your sign-in has expired. Please sign in again.');
  const ms = await refreshMicrosoftToken(session.msRefreshToken);
  const result = await signInWithMicrosoftToken(ms.access_token);
  return { ...result, msRefreshToken: ms.refresh_token || session.msRefreshToken };
}

/** Offline identity for the localhost-only development mode (same scheme as vanilla offline mode). */
export function offlineIdentity(name) {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return { name, uuid: hash.toString('hex'), accessToken: '0' };
}
