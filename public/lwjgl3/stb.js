// stb_image / stb_image_write natives (LWJGL org.lwjgl.stb) for the browser.
// Minecraft 1.13+ decodes every texture through stbi_load_from_memory and writes
// screenshots / world icons through stbi_write_png_to_func. PNG is decoded exactly
// (no canvas round trip, which would premultiply alpha) using the browser's zlib.
import { sync, ptr, U8, malloc, mallocAsync, free, cstring, setI32 } from './heap.js';
import { definer, outI32 } from './core.js';
import { callJava } from './registry.js';
import { LWJGL_NATIVES } from './generated/natives.js';

let failure = null; // stbi_failure_reason() is NULL until a load fails (26.x checks this at startup)
let flipVertically = false;

async function zlib(data, mode) {
  const stream = new Blob([data]).stream().pipeThrough(mode === 'inflate' ? new DecompressionStream('deflate') : new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function pngHeader(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((v, i) => bytes[i] !== v)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = bytes[25];
  const channels = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }[colorType];
  return { width: dv.getUint32(16), height: dv.getUint32(20), bitDepth: bytes[24], colorType, interlace: bytes[28], channels };
}

/** Decodes a PNG to 8-bit samples; returns { width, height, channels, data }. */
async function decodePNG(bytes) {
  const header = pngHeader(bytes);
  if (!header) throw new Error('not a PNG (only PNG images are supported)');
  const { width, height, bitDepth, colorType, interlace } = header;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let palette = null;
  let trns = null;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const samplesPerPixel = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!samplesPerPixel) throw new Error(`unsupported PNG color type ${colorType}`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const chunk of idat) { joined.set(chunk, p); p += chunk.length; }
  const raw = await zlib(joined, 'inflate');

  const bitsPerPixel = samplesPerPixel * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  // samples[i] for each pixel, 8-bit (16-bit keeps the high byte, low depths unpacked)
  const samples = new Uint8Array(width * height * samplesPerPixel);
  let pos = 0;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < ph; row++) {
      const filter = raw[pos++];
      const line = raw.slice(pos, pos + stride);
      pos += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        switch (filter) {
          case 1: line[i] = (line[i] + a) & 0xff; break;
          case 2: line[i] = (line[i] + b) & 0xff; break;
          case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
          case 4: {
            const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
            line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
            break;
          }
          default: break;
        }
      }
      prev = line;
      const y = y0 + row * dy;
      for (let col = 0; col < pw; col++) {
        const x = x0 + col * dx;
        const out = (y * width + x) * samplesPerPixel;
        if (bitDepth === 8) {
          for (let s = 0; s < samplesPerPixel; s++) samples[out + s] = line[col * samplesPerPixel + s];
        } else if (bitDepth === 16) {
          for (let s = 0; s < samplesPerPixel; s++) samples[out + s] = line[(col * samplesPerPixel + s) * 2];
        } else {
          const bit = col * bitDepth;
          const value = (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
          samples[out] = colorType === 3 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1));
        }
      }
    }
  }

  // Expand palette / transparency like stb_image does.
  if (colorType === 3) {
    const hasAlpha = !!trns;
    const channels = hasAlpha ? 4 : 3;
    const data = new Uint8Array(width * height * channels);
    for (let i = 0; i < width * height; i++) {
      const index = samples[i];
      data[i * channels] = palette[index * 3];
      data[i * channels + 1] = palette[index * 3 + 1];
      data[i * channels + 2] = palette[index * 3 + 2];
      if (hasAlpha) data[i * channels + 3] = index < trns.length ? trns[index] : 255;
    }
    return { width, height, channels, data };
  }
  if (trns && (colorType === 0 || colorType === 2)) {
    const keyDv = new DataView(trns.buffer, trns.byteOffset, trns.byteLength);
    const scale = (v) => (bitDepth === 16 ? v >> 8 : bitDepth < 8 ? Math.round((v * 255) / ((1 << bitDepth) - 1)) : v);
    const key = colorType === 0 ? [scale(keyDv.getUint16(0))] : [scale(keyDv.getUint16(0)), scale(keyDv.getUint16(2)), scale(keyDv.getUint16(4))];
    const channels = samplesPerPixel + 1;
    const data = new Uint8Array(width * height * channels);
    for (let i = 0; i < width * height; i++) {
      let match = true;
      for (let s = 0; s < samplesPerPixel; s++) {
        data[i * channels + s] = samples[i * samplesPerPixel + s];
        if (samples[i * samplesPerPixel + s] !== key[s]) match = false;
      }
      data[i * channels + samplesPerPixel] = match ? 0 : 255;
    }
    return { width, height, channels, data };
  }
  return { width, height, channels: samplesPerPixel, data: samples };
}

// stb_image's channel conversion rules.
function convertChannels(src, count, from, to) {
  if (from === to) return src;
  const out = new Uint8Array(count * to);
  const lum = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;
  for (let i = 0; i < count; i++) {
    const s = i * from;
    const o = i * to;
    let r; let g; let b; let a = 255;
    if (from === 1) { r = g = b = src[s]; }
    else if (from === 2) { r = g = b = src[s]; a = src[s + 1]; }
    else { r = src[s]; g = src[s + 1]; b = src[s + 2]; if (from === 4) a = src[s + 3]; }
    if (to === 1) out[o] = from <= 2 ? r : lum(r, g, b);
    else if (to === 2) { out[o] = from <= 2 ? r : lum(r, g, b); out[o + 1] = a; }
    else { out[o] = r; out[o + 1] = g; out[o + 2] = b; if (to === 4) out[o + 3] = a; }
  }
  return out;
}

function flipRows(data, width, height, channels) {
  const row = width * channels;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row;
    const b = (height - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
}

// ---------------------------------------------------------------------------
// PNG encoding for stbi_write_png_to_func
// ---------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function encodePNG(pixels, width, height, channels, stride) {
  const rowBytes = width * channels;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = (flipVertically ? height - 1 - y : y) * stride;
    raw[y * (rowBytes + 1)] = 0;
    raw.set(pixels.subarray(src, src + rowBytes), y * (rowBytes + 1) + 1);
  }
  const compressed = await zlib(raw, 'deflate');
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const part of parts) { png.set(part, o); o += part.length; }
  return png;
}

export function stbNatives() {
  const N = {};
  const def = definer(N);
  const IMG = 'org/lwjgl/stb/STBImage';
  const WRITE = 'org/lwjgl/stb/STBImageWrite';

  // Anything not implemented below reports a failure instead of crashing.
  for (const className of Object.keys(LWJGL_NATIVES).filter((c) => c.startsWith('org/lwjgl/stb/'))) {
    for (const method of LWJGL_NATIVES[className]) {
      def(className, method, () => {
        console.warn(`[lwjgl-web] stb function not implemented: ${method}`);
        return 0;
      });
    }
  }

  def(IMG, 'nstbi_load_from_memory', async (lib, buffer, length, x, y, comp, desired) => {
    try {
      sync();
      const bytes = U8.slice(ptr(buffer), ptr(buffer) + length);
      const image = await decodePNG(bytes);
      const channels = desired || image.channels;
      const data = convertChannels(image.data, image.width * image.height, image.channels, channels);
      if (flipVertically) flipRows(data, image.width, image.height, channels);
      const address = await mallocAsync(data.length);
      if (!address) throw new Error('out of memory');
      sync();
      U8.set(data, address);
      outI32(x, image.width);
      outI32(y, image.height);
      outI32(comp, image.channels);
      return address;
    } catch (error) {
      failure = error.message;
      return 0;
    }
  });
  def(IMG, 'nstbi_info_from_memory', (lib, buffer, length, x, y, comp) => {
    sync();
    const header = pngHeader(U8.subarray(ptr(buffer), ptr(buffer) + length));
    if (!header) { failure = 'unknown image type'; return 0; }
    outI32(x, header.width);
    outI32(y, header.height);
    outI32(comp, header.colorType === 3 ? 3 : header.channels);
    return 1;
  });
  // LWJGL 3.1 - 3.2 point stb at their allocator; ours is the JavaScript heap anyway.
  def('org/lwjgl/stb/LibSTB', 'setupMalloc', () => undefined);
  def(IMG, 'nstbi_is_16_bit_from_memory', (lib, buffer, length) => {
    sync();
    const header = pngHeader(U8.subarray(ptr(buffer), ptr(buffer) + length));
    return header && header.bitDepth === 16 ? 1 : 0;
  });
  def(IMG, 'nstbi_is_hdr_from_memory', () => 0);
  def(IMG, 'nstbi_image_free', (lib, address) => free(address));
  def(IMG, 'nstbi_failure_reason', () => (failure ? cstring(failure) : 0));
  def(IMG, 'nstbi_set_flip_vertically_on_load', (lib, flag) => { flipVertically = !!flag; });
  def(IMG, 'nstbi_set_unpremultiply_on_load', () => undefined);
  def(IMG, 'nstbi_set_unpremultiply_on_load_thread', () => undefined);
  def(IMG, 'nstbi_convert_iphone_png_to_rgb', () => undefined);
  def(IMG, 'nstbi_convert_iphone_png_to_rgb_thread', () => undefined);

  // Addresses of stb_image_write's global int settings.
  const globals = {};
  const intGlobal = (key, initial) => () => {
    if (!globals[key]) {
      globals[key] = malloc(4);
      setI32(globals[key], initial);
    }
    return globals[key];
  };
  def(WRITE, 'nstbi_write_png_compression_level', intGlobal('compression', 8));
  def(WRITE, 'nstbi_write_force_png_filter', intGlobal('filter', -1));
  // STBImageWrite's static initializer reads these globals too (LWJGL 3.3+); a NULL address
  // made it fail, and with it every PNG write (world icons came out empty).
  def(WRITE, 'nstbi_write_tga_with_rle', intGlobal('tgaRle', 1));
  def(WRITE, 'nstbi_zlib_compress', () => {
    if (!globals.zlib) {
      globals.zlib = malloc(8); // a function pointer; NULL selects stb's own compressor
      setI32(globals.zlib, 0);
      setI32(globals.zlib + 4, 0);
    }
    return globals.zlib;
  });
  def(WRITE, 'nstbi_flip_vertically_on_write', (lib, flag) => { flipVertically = !!flag; });
  def(WRITE, 'nstbi_write_png_to_func', async (lib, func, context, width, height, comp, data, stride) => {
    try {
      sync();
      const rowStride = stride || width * comp;
      const pixels = U8.slice(ptr(data), ptr(data) + rowStride * height);
      const png = await encodePNG(pixels, width, height, comp, rowStride);
      const address = await mallocAsync(png.length);
      sync();
      U8.set(png, address);
      await callJava(func, Number(ptr(context)), address, png.length);
      free(address);
      return 1;
    } catch (error) {
      console.warn('[lwjgl-web] PNG encoding failed:', error);
      return 0;
    }
  });
  def(WRITE, 'nstbi_write_png', () => 0);

  // stb_image_resize, as NativeImage.resizeSubRectTo uses it (world icons from screenshots):
  // each output pixel averages the input pixels it covers.
  const RESIZE = 'org/lwjgl/stb/STBImageResize';
  // stbir_pixel_layout (stb_image_resize2, LWJGL 3.4) -> channels
  const LAYOUT_CHANNELS = { 0: 3, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 2, 10: 2, 11: 4, 12: 4, 13: 4, 14: 4, 15: 2, 16: 2 };
  const resize = (input, inW, inH, inStride, output, outW, outH, outStride, channels) => {
    sync();
    const src = ptr(input);
    const dst = ptr(output);
    if (!src || !dst || !channels || inW <= 0 || inH <= 0 || outW <= 0 || outH <= 0) return false;
    const inRow = inStride || inW * channels;
    const outRow = outStride || outW * channels;
    const sum = new Float64Array(channels);
    for (let y = 0; y < outH; y++) {
      const y0 = Math.floor((y * inH) / outH);
      const y1 = Math.min(inH, Math.max(y0 + 1, Math.ceil(((y + 1) * inH) / outH)));
      for (let x = 0; x < outW; x++) {
        const x0 = Math.floor((x * inW) / outW);
        const x1 = Math.min(inW, Math.max(x0 + 1, Math.ceil(((x + 1) * inW) / outW)));
        sum.fill(0);
        for (let sy = y0; sy < y1; sy++) {
          let p = src + sy * inRow + x0 * channels;
          for (let sx = x0; sx < x1; sx++) {
            for (let c = 0; c < channels; c++) sum[c] += U8[p + c];
            p += channels;
          }
        }
        const n = (y1 - y0) * (x1 - x0);
        const q = dst + y * outRow + x * channels;
        for (let c = 0; c < channels; c++) U8[q + c] = Math.round(sum[c] / n);
      }
    }
    return true;
  };
  // LWJGL 3.4: stbir_resize_uint8_srgb/linear(..., pixel_layout) return the output pointer.
  for (const name of ['nstbir_resize_uint8_linear', 'nstbir_resize_uint8_srgb']) {
    def(RESIZE, name, (lib, input, inW, inH, inStride, output, outW, outH, outStride, layout) =>
      resize(input, inW, inH, inStride, output, outW, outH, outStride, LAYOUT_CHANNELS[layout] ?? 4) ? output : 0);
  }
  // LWJGL 3.2 - 3.3: stbir_resize_uint8(..., num_channels) returns 1 on success.
  def(RESIZE, 'nstbir_resize_uint8', (lib, input, inW, inH, inStride, output, outW, outH, outStride, channels) =>
    (resize(input, inW, inH, inStride, output, outW, outH, outStride, channels) ? 1 : 0));
  return N;
}
