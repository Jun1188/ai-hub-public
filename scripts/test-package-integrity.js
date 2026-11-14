#!/usr/bin/env node
// Google Drive can leave npm packages present but truncated; parse every direct dependency manifest.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let bad = 0;
for (const name of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).sort()) {
  const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  try {
    const raw = fs.readFileSync(manifest, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.name || !parsed.version) throw new Error('name/version missing');
  } catch (err) {
    bad++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}
if (!bad) console.log('모든 직접 의존성 manifest 정상');
process.exit(bad ? 1 : 0);
