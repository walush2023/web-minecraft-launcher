import { mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { signInWithMicrosoftToken, offlineIdentity, startLogin, consumePendingLogin, AuthError } = await import('../server/auth.js');

const XBL = 'POST https://user.auth.xboxlive.com/user/authenticate';
const XSTS = 'POST https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN = 'POST https://api.minecraftservices.com/authentication/login_with_xbox';
const ENTITLEMENTS = 'GET https://api.minecraftservices.com/entitlements/license';
const PROFILE = 'GET https://api.minecraftservices.com/minecraft/profile';

function happyRoutes(overrides = {}) {
  return {
    [XBL]: () => [200, { Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }],
    [XSTS]: () => [200, { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }],
    [MC_LOGIN]: () => [200, { access_token: 'mc-token', expires_in: 86400 }],
    [ENTITLEMENTS]: () => [200, { items: [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] }],
    [PROFILE]: () => [200, { id: 'abcdef0123456789abcdef0123456789', name: 'Steve', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/x' }] }],
    ...overrides,
  };
}

test('runs the Microsoft -> Xbox Live -> XSTS -> Minecraft chain', async () => {
  const calls = mockFetch(happyRoutes());
  const result = await signInWithMicrosoftToken('ms-access-token');

  assert.equal(calls[0].body.Properties.RpsTicket, 'd=ms-access-token');
  assert.deepEqual(calls[1].body.Properties.UserTokens, ['xbl-token']);
  assert.equal(calls[1].body.RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(calls[2].body.identityToken, 'XBL3.0 x=user-hash;xsts-token');
  assert.equal(result.mcAccessToken, 'mc-token');
  assert.equal(result.owned, true);
  assert.deepEqual(result.profile, { id: 'abcdef0123456789abcdef0123456789', name: 'Steve', skin: 'http://textures.minecraft.net/texture/x' });
});

test('treats an account with a profile but no store entitlement (Game Pass) as an owner', async () => {
  mockFetch(happyRoutes({ [ENTITLEMENTS]: () => [200, { items: [] }] }));
  const result = await signInWithMicrosoftToken('ms');
  assert.equal(result.owned, true);
});

test('reports accounts without a licence or profile as not owning the game', async () => {
  mockFetch(happyRoutes({
    [ENTITLEMENTS]: () => [200, { items: [] }],
    [PROFILE]: () => [404, { error: 'NOT_FOUND' }],
  }));
  const result = await signInWithMicrosoftToken('ms');
  assert.equal(result.owned, false);
  assert.equal(result.profile, null);
});

test('explains XSTS errors such as a missing Xbox profile', async () => {
  mockFetch(happyRoutes({ [XSTS]: () => [401, { XErr: 2148916233 }] }));
  await assert.rejects(signInWithMicrosoftToken('ms'), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, 'xsts');
    assert.match(error.message, /Xbox profile/);
    return true;
  });
});

test('flags Azure apps that Mojang has not approved yet', async () => {
  mockFetch(happyRoutes({ [MC_LOGIN]: () => [403, { error: 'Invalid app registration' }] }));
  await assert.rejects(signInWithMicrosoftToken('ms'), (error) => error.code === 'app-not-approved');
});

test('builds a PKCE authorization request whose state can be used once', () => {
  const { state, url } = startLogin();
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'test-client-id');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('scope'), 'XboxLive.signin offline_access');
  assert.equal(params.get('state'), state);
  assert.ok(consumePendingLogin(state)?.verifier);
  assert.equal(consumePendingLogin(state), null);
});

test('derives the same offline UUID as vanilla Minecraft', () => {
  // UUID.nameUUIDFromBytes("OfflinePlayer:Notch") = b50ad385-829d-3141-a216-7e7d7539ba7f
  assert.equal(offlineIdentity('Notch').uuid, 'b50ad385829d3141a2167e7d7539ba7f');
});
