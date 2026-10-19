import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModule, moduleWords, parseWords, emitGLSL, glslTypeInfo } from '../public/lwjgl3/spirv.js';
import { preprocess, translateGLSL } from '../public/lwjgl3/glsl.js';

const RESOURCE = { UBO: 1, INPUT: 3, OUTPUT: 4, SAMPLER: 7, PUSH: 9 };
const VERTEX = `#version 330
#extension GL_ARB_separate_shader_objects : require
layout(std140) uniform Globals {
    vec3 CameraOffset;
    float GameTime;
};
struct Light { vec3 Position; };
uniform sampler2D Sampler2;
layout(location = 0) in vec3 Position;
layout(location = 3) in ivec2 UV2;
layout(location = 1) flat out vec4 vertexColor;
float shade(vec3 Position) { return Position.y; }
void main() {
    Light l;
    l.Position = Position;
    vertexColor = texelFetch(Sampler2, UV2, 0) * shade(Position + CameraOffset);
    gl_Position = vec4(float(gl_VertexIndex), GameTime, 0.0, 1.0);
}`;

test('reflects stage variables, uniform blocks and samplers of a shader', () => {
  const { module } = buildModule(preprocess(VERTEX).text, 'vertex');
  const byName = Object.fromEntries(module.resources.map((r) => [r.name, r]));
  assert.equal(byName.Globals.kind, RESOURCE.UBO);
  assert.equal(byName.Sampler2.kind, RESOURCE.SAMPLER);
  assert.equal(byName.Position.kind, RESOURCE.INPUT);
  assert.equal(byName.vertexColor.kind, RESOURCE.OUTPUT);
  assert.equal(byName.vertexColor.flat, true);
  assert.equal(module.slots[byName.UV2.location], 3);
  assert.deepEqual(glslTypeInfo('ivec2'), { basetype: 7, vecsize: 2, columns: 1 });
  assert.equal(glslTypeInfo('isamplerBuffer').imageDim, 5);
  assert.ok(!module.resources.some((r) => r.name === 'Light' || r.name === 'shade'));
});

test('round-trips the stand-in SPIR-V with rewritten decorations and renames like SPIRV-Cross', () => {
  const { key, module } = buildModule(preprocess(VERTEX).text, 'vertex');
  const words = moduleWords(key, module);
  assert.equal(words[0], 0x07230203);
  const byName = Object.fromEntries(module.resources.map((r) => [r.name, r]));
  // The game rewrites bindings in place (PipelineBuilder) before the GL backend decompiles.
  words[7 + byName.Sampler2.binding] = 4;
  const ir = parseWords(words);
  assert.equal(ir.slots[byName.Sampler2.binding], 4);
  const names = new Map([
    [byName.Globals.blockId, '_uniform_00_00'],
    [byName.Sampler2.id, `_uniform_00_0${ir.slots[byName.Sampler2.binding]}`],
    [byName.Position.id, '_vert_input_00'],
    [byName.UV2.id, '_vert_input_03'],
    [byName.vertexColor.id, '_interface_variable_01'],
  ]);
  const glsl = emitGLSL(ir.module, ir.slots, names);
  assert.match(glsl, /^#version 330 core/);
  assert.match(glsl, /uniform _uniform_00_00 \{/);
  assert.match(glsl, /uniform sampler2D _uniform_00_04;/);
  assert.match(glsl, /in vec3 _vert_input_00;/);
  // struct fields and member accesses keep their names; uses of the globals follow the renames
  assert.match(glsl, /struct Light \{ vec3 Position; \}/);
  assert.match(glsl, /l\.Position = _vert_input_00;/);
  assert.match(glsl, /texelFetch\(_uniform_00_04, _vert_input_03, 0\)/);
  assert.match(glsl, /float\(gl_VertexID\)/);
  // and the result is valid input for the GLSL ES translation
  const es = translateGLSL(glsl, { stage: 'vertex' });
  assert.deepEqual(es.warnings.filter((w) => !/^ignored #/.test(w)), []);
});

test('includes files only from active branches, with include guards', () => {
  const files = {
    'a.glsl': '#ifndef A\n#define A\nfloat a() { return 1.0; }\n#include <b.glsl>\n#endif',
    'b.glsl': '#ifndef B\n#define B\n#include <a.glsl>\nfloat b() { return 2.0; }\n#endif',
  };
  const include = (name) => files[name] ?? null;
  const out = preprocess('#include <a.glsl>\n#include <b.glsl>\n#ifdef NEVER\n#include <missing.glsl>\n#endif\nvoid main() {}', {}, { include });
  assert.equal((out.text.match(/float a\(\)/g) || []).length, 1);
  assert.equal((out.text.match(/float b\(\)/g) || []).length, 1);
  assert.deepEqual(out.warnings, []);
  assert.match(preprocess('#include <missing.glsl>', {}, { include }).warnings[0], /#error cannot include/);
});

test('writes fragment output arrays through constant indices', () => {
  const { code } = translateGLSL(`#version 330
layout(location = 0) out vec4 _frag_output_00[2];
void main() {
    for (int i = 0; i < 2; i++) _frag_output_00[i] = vec4(float(i));
}`, { stage: 'fragment' });
  assert.match(code, /vec4 webmc_out_frag_output_00\[2\];/);
  assert.match(code, /void webmc_main\(\)/);
  assert.match(code, /_frag_output_00\[1\] = webmc_out_frag_output_00\[1\];/);
  assert.doesNotMatch(code, /__/);
});
