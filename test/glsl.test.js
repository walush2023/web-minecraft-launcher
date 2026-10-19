import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateGLSL, preprocess, uniformDefaultValues, esIdentifier } from '../public/lwjgl3/glsl.js';

const body = (source, stage = 'vertex') => {
  const { code } = translateGLSL(source, { stage });
  assert.ok(code.startsWith('#version 300 es\n'));
  return code.slice(code.indexOf('\n', code.lastIndexOf('precision ')) + 1);
};
const squash = (s) => s.replace(/\s+/g, ' ').trim();

test('inserts the int -> float conversions desktop GLSL does implicitly', () => {
  const out = squash(body(`#version 150
in ivec2 UV2;
uniform sampler2D Sampler2;
float twice(float a) { return a * 2; }
void main() {
  float x = 1;
  int i = 3;
  vec2 uv = clamp(UV2 / 256.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0));
  float y = max(i, 0.5) + pow(x, 2) + twice(i);
  x *= 2;
  x = i > 2 ? 1 : 0.5;
  gl_Position = vec4(uv, textureLod(Sampler2, uv, 0).r, 1);
}`));
  assert.match(out, /return a \* 2\.0;/);
  assert.match(out, /float x = 1\.0;/);
  assert.match(out, /clamp\(vec2\(UV2\) \/ 256\.0,/);
  assert.match(out, /max\(float\(i\), 0\.5\) \+ pow\(x, 2\.0\) \+ twice\(float\(i\)\)/);
  assert.match(out, /x \*= 2\.0;/);
  assert.match(out, /x = i > 2 \? 1\.0 : 0\.5;/);
  assert.match(out, /textureLod\(Sampler2, uv, 0\.0\)/);
  // Constructors convert by themselves.
  assert.match(out, /vec4\(uv, textureLod\(Sampler2, uv, 0\.0\)\.r, 1\)/);
});

test('keeps integer arithmetic and integer built-in overloads intact', () => {
  const out = squash(body(`#version 330
uniform int Count;
void main() {
  int a = abs(Count) % 4;
  ivec2 p = ivec2(a, 2) * 3;
  uint u = 5u;
  gl_Position = vec4(float(p.x + int(u)));
}`));
  assert.match(out, /int a = abs\(Count\) % 4;/);
  assert.match(out, /ivec2 p = ivec2\(a, 2\) \* 3;/);
});

test('converts mixed matrix/vector arithmetic and int vectors in vector math', () => {
  const out = squash(body(`#version 150
in vec3 Position;
uniform ivec3 CameraBlockPos;
uniform mat4 ModelViewMat;
void main() {
  vec3 pos = Position + (CameraBlockPos - ivec3(1)) * 2;
  gl_Position = ModelViewMat * vec4(pos, 1.0) * 2;
}`));
  assert.match(out, /Position \+ vec3\(\(CameraBlockPos - ivec3\(1\)\) \* 2\)/);
  assert.match(out, /ModelViewMat \* vec4\(pos, 1\.0\) \* 2\.0/);
});

test('expands macros and resolves conditionals', () => {
  const { text } = preprocess(`#version 150
#define LIGHT (0.6)
#define SQ(x) ((x) * (x))
#ifdef MISSING
broken
#elif defined(LIGHT) && __VERSION__ >= 150
float a = LIGHT + SQ(2.0);
#else
broken
#endif
#if 0
broken
#endif`, {});
  assert.doesNotMatch(text, /broken/);
  assert.match(text, /float a = \(0\.6\) \+ \(\(2\.0\) \* \(2\.0\)\);/);
  assert.equal(text.split('\n').length, 13); // line structure is kept
  const defined = preprocess('#ifdef FLAG\nyes\n#endif', { FLAG: 1 }).text;
  assert.match(defined, /yes/);
});

test('rewrites GLSL 1.10/1.20 names for GLSL ES 3.00', () => {
  const vertex = squash(body(`#version 120
attribute vec4 Position;
varying vec2 texCoord;
void main() { texCoord = Position.xy; gl_Position = Position; }`));
  assert.match(vertex, /^in vec4 Position; out vec2 texCoord;/);
  const { code } = translateGLSL(`#version 120
uniform sampler2D DiffuseSampler;
varying vec2 texCoord;
void main() { gl_FragColor = texture2D(DiffuseSampler, texCoord); }`, { stage: 'fragment' });
  assert.match(code, /out vec4 webmc_FragColor;/);
  assert.match(code, /in vec2 texCoord;/);
  assert.match(code, /webmc_FragColor = texture\(DiffuseSampler, texCoord\);/);
});

test('drops layout qualifiers GLSL ES 3.00 does not have', () => {
  const out = squash(body(`#version 330
#extension GL_ARB_separate_shader_objects : require
layout(location = 0) in vec3 Position;
layout(location = 1) out float vertexDistance;
layout(std140, binding = 2) uniform Globals { vec2 ScreenSize; };
layout(binding = 0) uniform sampler2D Sampler0;
noperspective out vec2 uv;
void main() { vertexDistance = ScreenSize.x; uv = vec2(0); gl_Position = vec4(Position, 1); }`));
  assert.match(out, /layout\(location = 0\) in vec3 Position;/);
  assert.match(out, /^layout\(location = 0\) in vec3 Position; out float vertexDistance;/);
  assert.match(out, /layout\(std140\) uniform Globals \{ vec2 ScreenSize; \};/);
  assert.match(out, /; uniform sampler2D Sampler0; out vec2 uv;/);
  assert.doesNotMatch(out, /#extension|binding|noperspective/);
});

test('moves uniform initializers out of the shader', () => {
  const result = translateGLSL(`#version 120
uniform vec3 Gray = vec3(0.3, 0.59, 0.11);
uniform float Saturation = 1;
void main() { gl_FragColor = vec4(Gray * Saturation, 1.0); }`, { stage: 'fragment' });
  assert.match(result.code, /uniform vec3 Gray\s*;/);
  assert.match(result.code, /uniform float Saturation\s*;/);
  assert.deepEqual(result.uniformDefaults.map((d) => [d.name, d.type]), [['Gray', 'vec3'], ['Saturation', 'float']]);
  assert.deepEqual(uniformDefaultValues('vec3', result.uniformDefaults[0].value), [0.3, 0.59, 0.11]);
  assert.deepEqual(uniformDefaultValues('float', result.uniformDefaults[1].value), [1]);
  assert.deepEqual(uniformDefaultValues('vec2', 'vec2(1.0)'), [1, 1]);
  assert.deepEqual(uniformDefaultValues('mat2', 'mat2(1.0)'), [1, 0, 0, 1]);
});

test('renames identifiers that are reserved words in GLSL ES', () => {
  const out = squash(body(`#version 150
uniform float filter;
void main() { float sample = filter; float input = sample * 2.0; gl_Position = vec4(input); }`));
  assert.match(out, /uniform float webmc_filter;/);
  assert.match(out, /float webmc_sample = webmc_filter; float webmc_input = webmc_sample \* 2\.0;/);
  assert.equal(esIdentifier('filter'), 'webmc_filter');
  assert.equal(esIdentifier('ProjMat'), 'ProjMat');
});

test('turns buffer textures into 2D textures addressed by index', () => {
  const { code } = translateGLSL(`#version 330
uniform isamplerBuffer CloudFaces;
void main() { ivec4 face = texelFetch(CloudFaces, gl_VertexID / 4); gl_Position = vec4(face); }`, { stage: 'vertex' });
  assert.match(code, /ivec2 webmc_bufferCoord\(int i\) \{ return ivec2\(i % 2048, i \/ 2048\); \}/);
  assert.match(code, /uniform isampler2D CloudFaces;/);
  assert.match(code, /texelFetch\(CloudFaces, webmc_bufferCoord\(gl_VertexID \/ 4\), 0\)/);
});

test('falls back to token-level rewrites when the parser cannot follow the source', () => {
  const result = translateGLSL(`#version 150
in vec4 Position;
weird syntax here @@;
void main() { gl_Position = Position; }`, { stage: 'vertex' });
  assert.ok(result.warnings.some((w) => w.startsWith('type pass skipped')));
  assert.match(result.code, /gl_Position = Position;/);
});
