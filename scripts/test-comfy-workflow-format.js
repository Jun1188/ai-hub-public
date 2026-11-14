'use strict';
// UI(그래프) 형식 → API 형식 변환. 작은 인라인 그래프와 /object_info 조각으로만 검사한다(번들 템플릿은 저장소에 두지 않는다).
const assert = require('assert/strict');
const { isUiWorkflow, toApiPrompt } = require('../src/core/comfy-workflow-format');

const req = (order, specs) => ({ input: { required: specs }, input_order: { required: order } });
const info = {
  CheckpointLoaderSimple: req(['ckpt_name'], { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] }),
  LoraLoader: req(['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'],
    { model: ['MODEL'], clip: ['CLIP'], lora_name: [['x.safetensors'], {}], strength_model: ['FLOAT', {}], strength_clip: ['FLOAT', {}] }),
  CLIPTextEncode: req(['text', 'clip'], { text: ['STRING', { multiline: true }], clip: ['CLIP'] }),
  EmptyLatentImage: req(['width', 'height', 'batch_size'], { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }),
  KSampler: req(['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'], {
    model: ['MODEL'], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler'], {}],
    scheduler: [['normal'], {}], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', {}] }),
  VAEDecode: req(['samples', 'vae'], { samples: ['LATENT'], vae: ['VAE'] }),
  ImageInvert: req(['image'], { image: ['IMAGE'] }),
  SaveImage: req(['images', 'filename_prefix'], { images: ['IMAGE'], filename_prefix: ['STRING', {}] }),
};
const n = (id, type, inputs = [], widgets, mode = 0) => ({ id, type, mode, inputs, ...(widgets ? { widgets_values: widgets } : {}) });
const s = (name, type, link, widget) => ({ name, type, link, ...(widget ? { widget: { name } } : {}) });

// Bypassed LoRA, Reroute, PrimitiveNode into a converted seed widget, muted nodes and notes in one graph.
const graph = {
  nodes: [
    n(4, 'CheckpointLoaderSimple', [], ['a.safetensors']),
    n(10, 'LoraLoader', [s('model', 'MODEL', 20), s('clip', 'CLIP', 21)], ['x.safetensors', 1, 1], 4),
    n(15, 'Reroute', [s('', '*', 23)]),
    n(6, 'CLIPTextEncode', [s('clip', 'CLIP', 24)], ['a cat']),
    n(7, 'CLIPTextEncode', [s('clip', 'CLIP', 25)], ['blurry']),
    n(5, 'EmptyLatentImage', [], [512, 512, 1]),
    n(30, 'PrimitiveNode', [], [777, 'fixed']),
    n(3, 'KSampler', [s('model', 'MODEL', 22), s('positive', 'CONDITIONING', 26), s('negative', 'CONDITIONING', 27),
      s('latent_image', 'LATENT', 28), s('seed', 'INT', 31, true)], [42, 'randomize', 20, 7.5, 'euler', 'normal', 1]),
    n(8, 'VAEDecode', [s('samples', 'LATENT', 29), s('vae', 'VAE', 32)]),
    n(9, 'SaveImage', [s('images', 'IMAGE', 33)], ['hub']),
    n(11, 'SaveImage', [s('images', 'IMAGE', 34)], ['muted'], 2),
    n(16, 'ImageInvert', [s('image', 'IMAGE', 35)], undefined, 2),
    n(17, 'SaveImage', [s('images', 'IMAGE', 36)], ['after-muted']),
    n(12, 'Note', [], ['hello']),
    n(13, 'MarkdownNote', [], ['**hi**']),
  ],
  links: [
    [20, 4, 0, 10, 0, 'MODEL'], [21, 4, 1, 10, 1, 'CLIP'], [22, 10, 0, 3, 0, 'MODEL'], [23, 10, 1, 15, 0, 'CLIP'],
    [24, 15, 0, 6, 0, 'CLIP'], [25, 10, 1, 7, 0, 'CLIP'], [26, 6, 0, 3, 1, 'CONDITIONING'], [27, 7, 0, 3, 2, 'CONDITIONING'],
    [28, 5, 0, 3, 3, 'LATENT'], [29, 3, 0, 8, 0, 'LATENT'], [31, 30, 0, 3, 4, 'INT'], [32, 4, 2, 8, 1, 'VAE'],
    [33, 8, 0, 9, 0, 'IMAGE'], [34, 8, 0, 11, 0, 'IMAGE'], [35, 8, 0, 16, 0, 'IMAGE'], [36, 16, 0, 17, 0, 'IMAGE'],
  ],
};
const inputsOf = (prompt) => Object.fromEntries(Object.entries(prompt).map(([id, node]) => [id, node.inputs]));

assert.equal(isUiWorkflow(graph), true);
assert.equal(isUiWorkflow({ 3: { class_type: 'KSampler', inputs: {} } }), false, 'API format passes through unchanged');
assert.equal(isUiWorkflow({ prompt: { 3: { class_type: 'KSampler', inputs: {} } } }), false);

const prompt = toApiPrompt(graph, info);
assert.deepEqual(Object.keys(prompt).sort(), ['17', '3', '4', '5', '6', '7', '8', '9'], 'bypassed, muted, Reroute, Primitive and note nodes are dropped');
assert.deepEqual(inputsOf(prompt), {
  4: { ckpt_name: 'a.safetensors' },
  6: { text: 'a cat', clip: ['4', 1] }, // Reroute -> bypassed LoRA -> checkpoint CLIP
  7: { text: 'blurry', clip: ['4', 1] }, // bypass passes the input of the same type
  5: { width: 512, height: 512, batch_size: 1 },
  // 'randomize' after the seed is skipped; the PrimitiveNode value replaces the converted seed widget.
  3: { seed: 777, steps: 20, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
  8: { samples: ['3', 0], vae: ['4', 2] },
  9: { filename_prefix: 'hub', images: ['8', 0] },
  17: { filename_prefix: 'after-muted' }, // a link from a muted node is dropped, not invented
});
assert.equal(prompt[3].class_type, 'KSampler');

// Widgets are told apart by the node's slots, not by type names: LOAD_3D/COLOR are widgets, an unlinked socket keeps its slot.
const slotInfo = {
  Preview3D: { input: { required: { model_3d: ['*'], viewport_state: ['LOAD_3D', {}], width: ['INT', {}], height: ['INT', {}] },
    optional: { model_3d_info: ['LOAD3D_MODEL_INFO', {}], forced: ['INT', { forceInput: true }] } },
  input_order: { required: ['model_3d', 'viewport_state', 'width', 'height'], optional: ['model_3d_info', 'forced'] } },
  Crop: req(['width', 'pad', 'background'], { width: ['INT', {}], pad: ['FLOAT', {}], background: ['COLOR', { default: '#000000' }] }),
  Noise: req(['noise_seed', 'steps'], { noise_seed: ['INT', {}], steps: ['INT', {}] }), // legacy: no control flag
  Text: req(['text'], { text: ['STRING', {}] }),
  // A widget added after the workflow was saved (MoGeInference.refine_steps in the bundled template) gets its default.
  Moge: req(['resolution', 'refine_steps', 'mode'], { resolution: ['INT', {}], refine_steps: ['INT', { default: 3 }], mode: [['fast', 'slow'], {}] }),
  // v3 DynamicCombo (RemeshMesh in the bundled 3D template): the chosen option's widgets follow the combo value.
  Remesh: req(['mesh', 'resolution', 'sign_mode', 'band'], { mesh: ['MESH'], resolution: ['INT', {}], band: ['FLOAT', {}],
    sign_mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'udf', inputs: { required: { qef: ['BOOLEAN', {}], drop_inverted: ['BOOLEAN', {}] } } },
      { key: 'sdf', inputs: { required: { qef: ['BOOLEAN', {}], manifold: ['BOOLEAN', {}] } } }] }] }),
};
const slots = toApiPrompt({ nodes: [
  n(1, 'Crop', [], [1024, 1.1, '#ffffff']),
  n(2, 'Preview3D', [s('model_3d', '*', 1), s('model_3d_info', 'LOAD3D_MODEL_INFO', null)], ['', 1024, 768]),
  n(3, 'Noise', [], [5, 'fixed', 30]),
  { id: 4, type: 'Text', mode: 0, inputs: [], widgets_values: { text: 'by name', stale: 1 } },
  n(5, 'MissingCustomNode', [s('image', 'IMAGE', 2)], [1, 2, 3]),
  n(6, 'Remesh', [s('mesh', 'MESH', null)], [768, 'udf', true, false, 1.5]),
  n(7, 'Remesh', [s('mesh', 'MESH', null)], [512, 'sdf', false, true, 2]),
  n(8, 'Moge', [], [9]),
], links: [{ id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: '*' }, [2, 1, 0, 5, 0, 'IMAGE']] }, slotInfo);
assert.deepEqual(inputsOf(slots), {
  1: { width: 1024, pad: 1.1, background: '#ffffff' },
  2: { model_3d: ['1', 0], viewport_state: '', width: 1024, height: 768 },
  3: { noise_seed: 5, steps: 30 },
  4: { text: 'by name' },
  5: { image: ['1', 0] }, // unknown classes stay so the caller reports them as missing nodes
  6: { resolution: 768, sign_mode: 'udf', 'sign_mode.qef': true, 'sign_mode.drop_inverted': false, band: 1.5 },
  7: { resolution: 512, sign_mode: 'sdf', 'sign_mode.qef': false, 'sign_mode.manifold': true, band: 2 },
  8: { resolution: 9, refine_steps: 3, mode: 'fast' },
});

// A Reroute loop must end instead of hanging.
const loop = toApiPrompt({ nodes: [n(1, 'Reroute', [s('', '*', 2)]), n(2, 'Reroute', [s('', '*', 1)]), n(3, 'SaveImage', [s('images', 'IMAGE', 3)], ['x'])],
  links: [[1, 2, 0, 1, 0, '*'], [2, 1, 0, 2, 0, '*'], [3, 1, 0, 3, 0, 'IMAGE']] }, info);
assert.deepEqual(loop[3].inputs, { filename_prefix: 'x' });

assert.throws(() => toApiPrompt({ nodes: [], links: [], definitions: { subgraphs: [{ id: 'sg' }] } }, info), (e) => e.code === 'COMFY_SUBGRAPH_UNSUPPORTED');
assert.throws(() => toApiPrompt({ 3: {} }, info), /UI 형식/);
console.log('Passed: links and widget order from object_info, control_after_generate skipped (flag and legacy seed names), Reroute/PrimitiveNode resolved, bypass passes by type, muted links dropped, notes dropped, slot-based widget detection (LOAD_3D/COLOR/forceInput), v3 DynamicCombo sub-widgets, defaults for widgets added after saving, dict widgets_values, object links, unknown nodes kept, Reroute loop ends, subgraphs rejected');
