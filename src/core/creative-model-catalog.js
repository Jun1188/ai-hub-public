'use strict';
// Image and 3D model records shared across PCs. A model is used only through a record that pins its Hugging Face
// revision and file hash and carries its license terms; records hold no machine paths (the folder comes from ComfyUI).
const { z } = require('zod');

// Hub runs in Korea, and some model licenses (e.g. Tencent Hunyuan Community) do not apply there.
const USER_REGION = 'KR';
const COMMERCIAL = ['yes', 'conditional', 'no'];

const https = z.url({ protocol: /^https$/ });
const commercial = z.enum(COMMERCIAL);
const repoFile = z.string().min(1)
  .refine(p => !p.startsWith('/') && !/[\\:]/.test(p) && !p.split('/').includes('..'), 'must be a file path inside the repository');
const record = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  revision: z.string().regex(/^[0-9a-f]{40}$/, 'must be a pinned commit'),
  path: repoFile,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  comfyFolder: z.string().regex(/^[a-z0-9_]+$/),
  license: z.strictObject({
    name: z.string().min(1),
    url: https,
    commercial,
    conditions: z.array(z.string().min(1)),
    regionExcluded: z.array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')),
    keyDependencies: z.array(z.strictObject({ name: z.string().min(1), license: z.string().min(1), url: https, commercial })),
  }),
  gated: z.boolean(),
});
const catalog = z.strictObject({ schemaVersion: z.literal(1), models: z.array(record) })
  .refine(doc => new Set(doc.models.map(m => m.repo + '/' + m.path)).size === doc.models.length, 'duplicate repo/path record');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new Error('model_catalog_invalid: ' + result.error.issues.map(i => (i.path.join('.') || '(root)') + ' ' + i.message).join('; '));
  error.code = 'model_catalog_invalid';
  throw error;
}

function load(doc = require('./creative-model-catalog.json')) { return parse(catalog, doc).models; }

/** Whether this record may be used here. Commercial use is the strictest of the model and its key dependencies. */
function admit(value, { region = USER_REGION } = {}) {
  const model = parse(record, value), license = model.license;
  if (license.regionExcluded.includes(region)) return { allowed: false, reason: 'license_region_excluded', region, license: license.name };
  const strictest = [license, ...license.keyDependencies].reduce((worst, x) => COMMERCIAL.indexOf(x.commercial) > COMMERCIAL.indexOf(worst) ? x.commercial : worst, 'yes');
  return { allowed: true, commercial: strictest, conditions: license.conditions, gated: model.gated };
}

module.exports = { load, admit, USER_REGION };
