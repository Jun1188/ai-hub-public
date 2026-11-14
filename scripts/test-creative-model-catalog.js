'use strict';
// Model catalog records: pinned revision/hash, no machine paths, and a license whose region exclusion refuses use in KR.
const assert = require('assert/strict'), crypto = require('crypto');
const catalog = require('../src/core/creative-model-catalog');
// Hashes are computed so the fixture holds no literal hex blobs that look like secrets.
const hex = (algo, text) => crypto.createHash(algo).update(text).digest('hex');
const base = () => ({
  repo: 'fixture-org/fixture-image-model', revision: hex('sha1', 'revision'), path: 'split_files/diffusion_models/fixture.safetensors',
  size: 1024, sha256: hex('sha256', 'weights'), comfyFolder: 'diffusion_models', gated: false,
  license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0', commercial: 'yes', conditions: [], regionExcluded: [], keyDependencies: [] },
});
const withLicense = extra => { const r = base(); Object.assign(r.license, extra); return r; };

assert.ok(Array.isArray(catalog.load()), 'shipped catalog must validate');
assert.equal(catalog.USER_REGION, 'KR');

const open = catalog.admit(base());
assert.deepEqual(open, { allowed: true, commercial: 'yes', conditions: [], gated: false });

const excluded = withLicense({ name: 'Tencent Hunyuan Community', commercial: 'conditional', regionExcluded: ['GB', 'KR'] });
assert.deepEqual(catalog.admit(excluded), { allowed: false, reason: 'license_region_excluded', region: 'KR', license: 'Tencent Hunyuan Community' });
assert.equal(catalog.admit(excluded, { region: 'US' }).allowed, true);

const conditional = withLicense({ commercial: 'conditional', conditions: ['annual revenue under USD 1M'] });
assert.deepEqual(catalog.admit(conditional), { allowed: true, commercial: 'conditional', conditions: ['annual revenue under USD 1M'], gated: false });
const nonCommercialDependency = withLicense({ keyDependencies: [{ name: 'fixture-rasterizer', license: 'Source Code License (non-commercial)', url: 'https://example.com/license', commercial: 'no' }] });
assert.equal(catalog.admit(nonCommercialDependency).commercial, 'no');

const invalid = mutate => { const r = base(); mutate(r); assert.throws(() => catalog.admit(r), e => e.code === 'model_catalog_invalid'); };
invalid(r => { r.path = 'C:/Users/someone/models/fixture.safetensors'; });
invalid(r => { r.path = '/home/someone/fixture.safetensors'; });
invalid(r => { r.path = '../outside.safetensors'; });
invalid(r => { r.localPath = 'D:\\models'; });
invalid(r => { r.revision = 'main'; });
invalid(r => { r.sha256 = 'abc'; });
invalid(r => { r.license.commercial = 'maybe'; });
invalid(r => { r.license.url = 'file:///c/license.txt'; });
invalid(r => { r.license.regionExcluded = ['Korea']; });
invalid(r => { delete r.license.keyDependencies; });
assert.throws(() => catalog.load({ schemaVersion: 1, models: [base(), base()] }), /duplicate/);
assert.throws(() => catalog.load({ schemaVersion: 2, models: [] }), e => e.code === 'model_catalog_invalid');
console.log('Passed: shipped catalog validates, KR region exclusion refuses use, conditional terms and strictest key-dependency license reported, machine paths/unpinned revisions/unknown fields rejected');
