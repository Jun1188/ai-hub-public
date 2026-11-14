'use strict';
// 그래프 offload 단계의 inline: Hub가 작은 파일을 읽어 본문으로 넘긴다(작업자 파일 읽기 실패 대비). 모델을 부르지 않는다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inline-'));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack || e.message}`); } }
const step = require('../src/core/pipeline-offload-step');

(async () => {
  const a = path.join(scratch, 'brief.md'), b = path.join(scratch, 'notes.md');
  fs.writeFileSync(a, '\uFEFF# Brief\nline');
  fs.writeFileSync(b, 'second');
  await check('inlines files in order with their names, BOM removed', async () => {
    assert.strictEqual(await step.inlineFiles([a, b]), '### brief.md\n# Brief\nline\n\n### notes.md\nsecond');
  });
  await check('over the cap is an error, not a silent cut', async () => {
    const big = path.join(scratch, 'big.md');
    fs.writeFileSync(big, 'x'.repeat(step.INLINE_MAX + 1));
    await assert.rejects(step.inlineFiles([big]), (e) => e.code === 'inline_too_large');
  });
  await check('missing file fails the step instead of sending an empty brief', async () => {
    await assert.rejects(step.inlineFiles([path.join(scratch, 'nope.md')]));
  });
  await check('L1 proposer steps ask for inline briefs', () => {
    const g = require('../src/core/rsi/triple-loop').l1Graph({ worker: 'codex' });
    const props = g.nodes.filter((n) => n.id === 'proposeInv' || n.id === 'proposeDom');
    assert.strictEqual(props.length, 2);
    assert(props.every((n) => n.step.inline === true && n.step.files[0] === '${state.briefPath}'));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`offload 단계 inline: 통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exitCode = 1;
})();
