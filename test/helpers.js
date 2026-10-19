import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Server modules read their configuration at import time; point them at a throwaway data dir.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'web-minecraft-test-'));
process.env.AZURE_CLIENT_ID = 'test-client-id';
process.env.DEV_OFFLINE = '0';

/** Replaces global fetch with a router: { 'METHOD url-prefix': (body) => [status, json] }. */
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    calls.push({ method, url: String(url), body, headers: init.headers });
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(' ');
      return m === method && String(url).startsWith(prefix);
    });
    if (!key) throw new Error(`Unexpected request ${method} ${url}`);
    const [status, json] = routes[key](body);
    const text = json === undefined ? '' : JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text || 'null'),
      text: async () => text,
    };
  };
  return calls;
}
