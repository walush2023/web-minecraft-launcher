# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
"Report a vulnerability" button on the repository's **Security** tab (private
vulnerability reporting). Include the version/commit, what you did, and what you
expected to happen. This is a hobby project maintained on a best-effort basis:
there is no service-level agreement, but reports are appreciated and will be
looked at as time allows.

## Supported versions

Only the latest commit on the default branch.

## Intended deployment

This project is meant to run **on your own computer** (`http://localhost:3000`) for
your own use. It is **not** hardened for hosting as a public service. If you
host it for other people anyway, you are responsible for everything below.

## What the server handles

| Data | Where it lives | Protection |
| --- | --- | --- |
| Microsoft OAuth 2.0 sign-in | Browser is redirected to `login.microsoftonline.com` | Authorization-code flow with PKCE and a random `state`; the project never sees your Microsoft password |
| Microsoft refresh token and Minecraft access token | Server side only, in `data/` | AES-256-GCM encrypted at rest; the key is `SESSION_SECRET` or a random key generated into `data/session-secret` (file mode 0600) |
| Browser session | Cookie `mcw_sid` | Random opaque ID; `HttpOnly`, `SameSite=Lax`, `Secure` when `PUBLIC_URL` is `https://` |
| Minecraft game files | `data/cache/` on the server | Downloaded only from Mojang's official hosts (allowlist in `server/cache.js`), SHA-1 verified, served only to accounts verified to own the game |
| Worlds and `options.txt` | The browser's IndexedDB (`/files/.minecraft`) | Stay in your browser; the server never receives them |

Other properties:

- The server listens on `127.0.0.1` by default. Set `HOST` yourself to change that.
- Download URLs come from Mojang's own manifests, never from the browser, and are
  checked against the host allowlist again before every request (no open relay / SSRF).
- `DEV_OFFLINE=1` skips the Microsoft sign-in for requests from the same machine.
  It is a development aid, is ignored unless the server listens on a loopback
  address, and is refused for requests carrying proxy headers. **Never enable it
  on a server that other people can reach.**
- The game runs inside the browser's WebAssembly sandbox (CheerpJ). It cannot
  read your disk or open sockets.
- The page loads the CheerpJ runtime from `cjrtnc.leaningtech.com` (Leaning
  Technologies' CDN). Loading it means trusting that CDN.

## Your responsibilities

- Never commit `.env`, `data/` or anything from `data/` (they are in `.gitignore`).
  They contain your Azure client secret, encryption key and encrypted tokens.
- Keep `AZURE_CLIENT_SECRET` private. Rotate it in the Azure portal if it leaks.
- If you deploy beyond localhost: serve over HTTPS, set `PUBLIC_URL` to the
  `https://` address, keep `HOST` on a private interface behind your reverse
  proxy, and add your own rate limiting and monitoring.
- Do not sign in on a machine you do not trust.
