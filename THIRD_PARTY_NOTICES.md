# Third-party notices

This repository contains the following third-party components. Each keeps its
own license. The original code of this project is under the MIT License (see
`LICENSE`).

**Minecraft is not included.** No Mojang or Microsoft game file, asset, library,
texture, sound, mapping, or decompiled/deobfuscated source is stored in this
repository. See "Minecraft" below.

## Bundled in this repository

| Path | Component | License | Source |
| --- | --- | --- | --- |
| `public/lwjgl/lwjgl-2.9.3.jar`, `public/lwjgl/lwjgl_util-2.9.3.jar` | LWJGL 2.9.3 (unmodified release jars) | BSD-3-Clause | <https://github.com/LWJGL/lwjgl>, <https://www.lwjgl.org> |
| `public/lwjgl/libraries/liblwjgl.so`, `public/lwjgl/libraries/gl4es.wasm`, `public/lwjgl/libraries/lwjgl.js` | WebAssembly build of LWJGL 2 natives and gl4es, from Browsercraft by Leaning Technologies | Apache-2.0 (Browsercraft); BSD-3-Clause (LWJGL); MIT (gl4es) | <https://github.com/leaningtech/browsercraft>, <https://github.com/ptitSeb/gl4es> |

The Apache License 2.0 text is in `LICENSES/Apache-2.0.txt`.

## Used at run time, not stored here

| Component | License / terms | Notes |
| --- | --- | --- |
| [CheerpJ](https://cheerpj.com) 4.3 by Leaning Technologies | Proprietary; free Community License for personal, non-commercial use, commercial license otherwise | Loaded by the browser from Leaning Technologies' CDN (`cjrtnc.leaningtech.com`). Not redistributed here. Check CheerpJ's current license terms before any commercial or public hosted use. |
| LWJGL 3 jars (Minecraft 1.13 and later) | BSD-3-Clause | Downloaded from Mojang's official servers together with the game. `public/lwjgl3/` is an independent JavaScript re-implementation of the native layer; `public/lwjgl3/generated/natives.js` lists only native method names, produced by `scripts/gen-lwjgl-tables.mjs` from the official LWJGL 3 jars. |
| [Express](https://expressjs.com) and its dependencies | MIT and similar | Installed from npm (`npm install`); see `package-lock.json`. |

## Minecraft

Minecraft is a trademark and copyright of Mojang Studios / Microsoft. This
project is not affiliated with, endorsed by, or approved by Mojang Studios or
Microsoft. The game files are downloaded at run time, by the user's own
installation, from Mojang's official servers after the signed-in account has
been verified to own the game, are checked against the SHA-1 hashes published
by Mojang, and are never modified on disk.

- Minecraft EULA: <https://www.minecraft.net/eula>
- Usage Guidelines: <https://www.minecraft.net/usage-guidelines>

## Inspiration and credits

- [Browsercraft](https://github.com/leaningtech/browsercraft) (Leaning Technologies, Apache-2.0) showed that Minecraft Java Edition can run in a browser through CheerpJ, and supplies the LWJGL 2 WebAssembly runtime used for Minecraft up to 1.12.2.
- The behaviour described as "fdlibm" in `java/src/webmc/jdk/MathStandIns.java` follows the published fdlibm algorithms for `log1p`, `sinh` and `cosh`.

## License texts

### LWJGL (BSD-3-Clause)

LWJGL 2.9.3 is Copyright (c) 2002-2011 Lightweight Java Game Library Project;
LWJGL 3 is Copyright (c) 2012-present Lightweight Java Game Library. All rights reserved.

```
Copyright (c) Lightweight Java Game Library (Project)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

- Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.

- Neither the name Lightweight Java Game Library nor the names of
  its contributors may be used to endorse or promote products derived
  from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### gl4es (MIT)

```
Copyright (c) 2016-2018 Sebastien Chevalier
Copyright (c) 2013-2016 Ryan Hileman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```

### Browsercraft (Apache-2.0)

See `LICENSES/Apache-2.0.txt`. Browsercraft is by Leaning Technologies (see its repository for the copyright notice).
