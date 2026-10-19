# Web Launcher for Minecraft: Java Edition (unofficial)

Play your own copy of **Minecraft: Java Edition** in a web browser. You sign in with
the Microsoft account that owns the game, the launcher downloads the version you pick
directly from Mojang's official servers to your own machine, and the unmodified game
files run inside [CheerpJ](https://cheerpj.com) (a JVM compiled to WebAssembly).

Supported: Alpha 1.0 up to the newest release tested (26.3). 繁體中文說明: [README.zh-TW.md](README.zh-TW.md).

![Launcher](docs/launcher.png)

> **Not an official Minecraft product. Not approved by or associated with Mojang Studios or Microsoft.**
> "Minecraft" is a trademark of Mojang Studios / Microsoft. **This repository contains no Minecraft
> files**: you need to own the game, and the game is downloaded from Mojang at run time.

## Table of contents

1. [Legal notice and disclaimer](#legal-notice-and-disclaimer)
2. [Security and privacy](#security-and-privacy)
3. [Quick start (Windows, Linux, macOS)](#quick-start)
4. [How it works](#how-it-works)
5. [Supported versions](#supported-versions)
6. [Known limitations](#known-limitations)
7. [Development](#development)
8. [Credits and third-party components](#credits-and-third-party-components)

## Legal notice and disclaimer

This is not legal advice. Rules change; read the originals and decide for yourself.

**What this repository is**

- Original source code (launcher, local server, JavaScript re-implementation of
  LWJGL 3's native layer, class-loading helpers), MIT-licensed (see [LICENSE](LICENSE)).
- A few third-party components that permit redistribution, listed with their
  licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**What this repository is not**

- It does **not** contain Minecraft: no game jar, library, asset, texture, sound,
  language file, mapping or decompiled/deobfuscated source. The `.gitignore` keeps
  downloaded files (`data/`) out of version control. Please keep it that way and
  never commit game files, either.
- It is **not** a cracked, "free" or offline-license way to play. Playing requires
  a Microsoft account that owns Minecraft: Java Edition (Game Pass included); the
  server checks ownership through Microsoft/Xbox/Minecraft services before it hands out any file.
- It does **not** decompile or reverse-engineer the game. At load time it applies
  small mechanical bytecode rewrites **in memory** so the game can run on
  CheerpJ (for example, Java 21/25 class files are lowered to Java 17, and a few JDK calls
  that CheerpJ cannot execute are redirected to replacements in `java/src/webmc/`). The
  files on disk are never modified, and the rewritten classes are never saved or distributed.
  Because of this, the game's main menu may show "(Modded)" in versions 1.13 and later.

**Rules that apply to you** (check the current versions)

- [Minecraft End User License Agreement](https://www.minecraft.net/eula) and
  [Usage Guidelines](https://www.minecraft.net/usage-guidelines): personal use of
  your own copy is what this tool is for. Do not distribute Minecraft or modified
  copies of it, do not use this project to make money from Minecraft, and do not
  present it as an official product. The launcher asks you to accept the EULA before
  each launch.
- Do **not** host this as a public service that serves Mojang's files to other
  people, and do not mirror or re-host game files. Each person should run their
  own copy so that files come from Mojang to their own machine.
- [CheerpJ](https://cheerpj.com) is proprietary software by Leaning Technologies.
  Its free Community License is for personal, non-commercial use; commercial use
  needs a paid license (set `CHEERPJ_LICENSE_KEY`). This project only loads CheerpJ from its CDN.
- Microsoft requires every Azure application that calls the Minecraft services API
  to be approved first (<https://aka.ms/mce-reviewappid>). You register and are
  responsible for your own Azure application; this project does not ship a client ID.
- Use only your own account. Do not share it, and do not use this project to evade
  bans, to play without owning the game, or to cheat on servers.
- If you use the name "Minecraft" in a fork, follow Mojang's brand and usage
  guidelines (for example: make it clear that your project is unofficial, and do not
  use Mojang's logos or artwork).

**Disclaimer of warranty and liability**

This software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)).
The authors are not responsible for lost worlds, lost or locked accounts, bans, data
loss, hardware or browser problems, or violations of third-party terms caused by the
way you use it. Worlds are stored in the browser's storage and can be lost when you clear
site data or close the tab without saving (see [Known limitations](#known-limitations)):
**back up worlds you care about.** Browsers and Minecraft change often; compatibility is best effort.

**Developer-only offline mode**

`DEV_OFFLINE=1` lets requests from the same machine start the game without signing
in. It exists for development and testing. It works only on a loopback address, is
off by default, and does not change the license: you must still own Minecraft: Java
Edition. Never enable it on a server that other people can reach.

## Security and privacy

See [SECURITY.md](SECURITY.md) for the full policy and how to report a vulnerability. In short:

- Runs on **your computer** (`127.0.0.1:3000` by default); designed for personal use,
  not hardened as a public web service.
- Sign-in is Microsoft's official OAuth 2.0 flow with PKCE. The project never sees your
  Microsoft password. The refresh token stays on the server, AES-256-GCM encrypted in
  `data/`; the browser only receives an opaque `HttpOnly` session cookie.
- Game files come only from Mojang's official hosts (allowlist in `server/cache.js`),
  are verified against Mojang's SHA-1 hashes and are served only to accounts that own the game.
- Worlds and settings stay in your browser (IndexedDB). Nothing is uploaded.
- The only third-party code the page loads at run time is the CheerpJ runtime from
  Leaning Technologies' CDN.
- **Never commit** `.env` or `data/`: they hold your Azure client secret, encryption key and encrypted tokens.
- This project does not include telemetry or analytics.

## Quick start

Requirements: [Node.js](https://nodejs.org) 20.12 or newer, a modern Chromium-based
browser (Chrome or Edge recommended; Firefox and Safari are untested), a Microsoft account that
owns Minecraft: Java Edition, and an internet connection (CheerpJ and the game files are downloaded).

Windows (PowerShell):

```powershell
git clone <this repository's URL> web-minecraft-launcher
cd web-minecraft-launcher
npm install
Copy-Item .env.example .env   # then edit .env and set AZURE_CLIENT_ID
npm start
```

Linux / macOS (bash):

```bash
git clone <this repository's URL> web-minecraft-launcher
cd web-minecraft-launcher
npm install
cp .env.example .env          # then edit .env and set AZURE_CLIENT_ID
npm start
```

Open <http://localhost:3000>, sign in, pick a version, accept the EULA and press Play.
The first launch of a version downloads its files on the server (for example about
4 MB for 1.2.5, 20 MB for 1.8.9, 47 MB for 1.12.2; cached afterwards). Reaching the main menu
the first time takes roughly 30 to 70 seconds for older versions and 1.5 minutes or more for 1.13+.

### Registering a Microsoft (Azure) application

Minecraft has no public OAuth client, so you register your own:

1. Open the [Azure portal, App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and create a registration.
   - Supported account types: **personal Microsoft accounts only** (or "any organizational directory and personal accounts").
   - Redirect URI: platform **Web**, `http://localhost:3000/auth/callback`.
2. Copy the *Application (client) ID* into `AZURE_CLIENT_ID` in `.env`. Create a client secret
   and put it in `AZURE_CLIENT_SECRET` (or choose the "Mobile and desktop" platform and rely on PKCE alone).
3. Request Minecraft API access for your app at <https://aka.ms/mce-reviewappid>.
   Until it is approved, sign-in fails with "app not approved".

Never share the client secret, and keep `.env` out of git.

### Controls

- Click the screen to capture the mouse; `Esc` releases it and opens the game menu.
- `F11` or the "Fullscreen" button toggles browser fullscreen. `F12` opens the browser's developer tools.
- Input methods (IME) work in chat and on signs (tested with Chinese).
- Browsers reserve `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Alt+Tab` and the Windows key. Sprint with
  a double tap of the forward key, or rebind it.
- Add `&debug=1` to the game's URL for verbose CheerpJ logging; the "Console" button shows Java output.

## How it works

```
Browser                                       Local Node.js server (server/)           Official services
┌──────────────────────────────┐   /auth/*   ┌────────────────────────────┐   OAuth    login.microsoftonline.com
│ Launcher page (index.html)   │────────────▶│ auth.js (PKCE, XBL, XSTS)  │──────────▶ user/xsts.auth.xboxlive.com
│ Game page (play.html)        │   /api/*    │ sessions.js (encrypted)    │            api.minecraftservices.com
│  ├ CheerpJ 4.3 (JVM in Wasm) │────────────▶│ mojang.js (versions, plan) │──────────▶ piston-meta / piston-data
│  ├ LWJGL 2.9.3 + gl4es Wasm  │  /mc/ (Range)│ cache.js (SHA-1 verified)  │            libraries.minecraft.net
│  ├ lwjgl3/ (JS native layer) │◀────────────│ owners of the game only    │            resources.download.minecraft.net
│  └ webmc-launcher.jar        │             └────────────────────────────┘
└──────────────────────────────┘
```

| Minecraft | Java runtime | LWJGL | Graphics |
| --- | --- | --- | --- |
| up to 1.12.2 | CheerpJ Java 8 | 2.9.3 (WebAssembly build from Browsercraft) | gl4es to WebGL |
| 1.13 to 1.16.5 | CheerpJ Java 17 | Mojang's LWJGL 3 jars + `public/lwjgl3/` | fixed-function emulation (`ffp.js`) on WebGL 2 |
| 1.17 to 1.21.x | CheerpJ Java 17 (Java 21 class files lowered in memory) | same | OpenGL 3.2 core on WebGL 2, GLSL translated to GLSL ES (`glsl.js`) |
| 26.x | CheerpJ Java 17 (Java 25 class files lowered in memory) | LWJGL 3.4: SDL3, shaderc and SPIRV-Cross emulated in JavaScript | OpenGL backend on WebGL 2 |

CheerpJ reads the game jar lazily with HTTP Range requests, so only the parts actually used are downloaded.
Worlds and `options.txt` live in the browser's IndexedDB (`/files/.minecraft`).

### Browser compatibility layer

`java/src/webmc/` (built into `public/webmc-launcher.jar`), `public/lwjgl3/` and `public/js/`
solve the differences between CheerpJ and the vanilla game. They are listed in detail in
[README.zh-TW.md](README.zh-TW.md) (a long table, in Chinese). The main areas:

- **Input and display**: keyboard, mouse, pointer lock, IME and fullscreen go from the page straight
  into LWJGL/GLFW/SDL3 event queues; the canvas is scaled with the pointer coordinates corrected.
- **LWJGL 3 natives in JavaScript**: GLFW and SDL3 windows, OpenGL on WebGL 2, GLSL translation,
  fixed-function pipeline emulation, stb_image, and stand-ins for shaderc/SPIRV-Cross.
- **In-memory class rewriting** (`GameClassLoader`, `ClassDowngrader`, `StandIns`, `Lambdas`,
  `Invokedynamics`, `TimeSlices`...): Java 21/25 to Java 17, replacing JDK calls CheerpJ cannot run,
  turning slow `invokedynamic` and lambdas into ordinary bytecode, cooperative time slicing, and
  small performance changes (for example fewer ambient particles and a lower mob cap on the "Smooth" preset).
- **File-system fixes** (`public/js/fs-fixes.js`, `webmc.jdk.FileStandIns`): older worlds can be
  upgraded by 26.x, and open files are saved to IndexedDB every 20 seconds.
- **Sandbox limits worked around**: no sockets (the integrated server uses a null selector),
  no external processes, no audio backend.

The jar files stay unmodified on disk. The source for everything above is in this repository.

## Supported versions

Tested in-world on Edge (render scale 75%, "Smooth" preset, 60 FPS cap). Versions up to 1.12.2 were measured on
an RTX 5060 Ti; 1.16.5 and later in headless Edge with software WebGL, so real GPUs are usually faster.

| Version | Result | FPS |
| --- | --- | --- |
| Beta 1.7.3, 1.2.5, 1.5.2, 1.6.4, 1.7.10, 1.8.9, 1.10.2, 1.12.2 | Playable | 45 to 60 |
| 1.16.5 | Playable (main menu about 1.5 min; new world about 3.5 min) | 40 to 55 |
| 1.20.1 | Playable (menu about 1.2 min; new world about 5 min) | 32 to 46 |
| 1.21.10 | Playable (menu about 1.2 min; new world about 3.7 min) | 22 to 40 |
| 26.3 | Playable (menu about 1.5 min; new world about 3.5 min; existing world about 2.5 min; 1.16.5, 1.20.1 and 1.21.10 worlds are upgraded in place in about 10 s) | 45 to 55 |

Other versions in the supported range are marked "experimental": they use the same method as a tested
neighbour but were not tried one by one.

## Known limitations

- **No sound** (there is no OpenAL backend in the browser) and **no multiplayer** (browsers cannot open TCP sockets). Singleplayer and the integrated server work.
- **Quit with "Save and Quit".** Closing the tab loses changes made since the game's last autosave (about every 5 minutes);
  chunks already saved are written to browser storage every 20 seconds.
- Clearing the site's data (or using a private window) deletes your worlds. Back them up.
- 1.13 and later are much slower than 1.12.2 and older (CheerpJ runs the game's Java code roughly 10 to 50 times
  slower than a desktop JVM): loading takes minutes, new terrain appears at about 1 to 2 chunks per second,
  and with many hostile mobs around the integrated server falls behind (peaceful mode is smoothest).
- 1.13+ main menus show "32-bit system detected" (CheerpJ is a 32-bit JVM) and "(Modded)" (the in-memory rewrite removes Mojang's jar signature).
- 26.x supports the OpenGL backend only (Vulkan is not available in a browser).
- Player skins cannot be fetched from Mojang's servers (browser CORS rules): the default skin is shown.
- Some versions show a black panorama background or thin seams between blocks (limits of the WebGL translation).
- Browser-reserved shortcuts (`Ctrl+W`, `Ctrl+T`, `Alt+Tab`, ...) cannot be captured.

## Development

```powershell
npm run dev          # restart the server when files change
npm test             # unit tests (sign-in flow, launch plan, options.txt, GLSL, SPIR-V, file-system fixes)
npm run build:java   # rebuild public/webmc-launcher.jar (needs a JDK 9+; output is Java 8 bytecode)
```

The commands are the same in Windows PowerShell and in Linux/macOS shells. On Linux/macOS set `JAVA_HOME`
with `export JAVA_HOME=/path/to/jdk` before `npm run build:java`; in PowerShell use `$env:JAVA_HOME = 'C:\path\to\jdk'`.

| Path | Purpose |
| --- | --- |
| `server/` | Express server: sign-in, sessions, Mojang version metadata and verified file cache |
| `public/index.html`, `public/js/launcher.js` | Launcher UI |
| `public/play.html`, `public/js/play.js` | Game page: progress, CheerpJ start-up, display and input |
| `public/lwjgl3/` | JavaScript implementation of LWJGL 3's native layer (GLFW, SDL3, OpenGL on WebGL 2, GLSL, fixed-function emulation) |
| `public/js/fs-fixes.js` | Fixes for CheerpJ's IndexedDB file system |
| `java/src/webmc/` | Helpers that run inside the JVM, and the in-memory class transformations |
| `data/` (git-ignored) | Download cache, encrypted sessions |

Contributions: do not add Minecraft files, screenshots of game assets used as resources, or
decompiled game code to pull requests. Keep secrets out of commits.

## Credits and third-party components

Full license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES/).

- **[Browsercraft](https://github.com/leaningtech/browsercraft)** by Leaning Technologies (Apache-2.0): the idea of running
  Minecraft through CheerpJ, and the WebAssembly LWJGL 2 runtime (`public/lwjgl/libraries/`).
- **[CheerpJ](https://cheerpj.com)** 4.3 by Leaning Technologies: the browser JVM, loaded at run time from its CDN under its own license.
- **[LWJGL](https://www.lwjgl.org)** (BSD-3-Clause): LWJGL 2.9.3 jars in `public/lwjgl/`; LWJGL 3 jars are downloaded from Mojang with the game.
- **[gl4es](https://github.com/ptitSeb/gl4es)** by Sebastien Chevalier (MIT): OpenGL to WebGL translation for the LWJGL 2 path (inside the Browsercraft build).
- **[Express](https://expressjs.com)** and npm dependencies (MIT and similar): see `package-lock.json`.
- **Minecraft** is a trademark of Mojang Studios / Microsoft. Mojang's own services are used under their terms:
  [EULA](https://www.minecraft.net/eula), [Usage Guidelines](https://www.minecraft.net/usage-guidelines).

This project's own code is released under the [MIT License](LICENSE).
