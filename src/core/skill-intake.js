'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const safety = require('./supply/script-safety');
const {assertNoSecrets} = require('./prompt-safety');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parse(value) {
  const text = String(value || '').trim();
  assertNoSecrets(text);
  const slug = '[a-zA-Z0-9_.-]+';
  const spec = new RegExp('^(?:npx\\s+skills\\s+add\\s+)?(?:https://github\\.com/)?(' + slug + '/' + slug + ')(?:\\s+--skill\\s+([a-z0-9][a-z0-9-]*))?$');
  const match = spec.exec(text);
  if (match && !text.startsWith('.') && (text.startsWith('npx ') || !require('node:fs').existsSync(text))) {
    return { input: 'https://github.com/' + match[1], select: match[2] || null };
  }
  if (/^npx\b/i.test(text)) throw new Error('npx skills add owner/repo [--skill 이름] 형식을 사용하세요.');
  return { input: text, select: null };
}

async function inspect(dir, relative, catalogEntry, origin, existing) {
  const files = [];
  const names = [];
  const warnings = [];
  let license = '', total = 0;
  async function walk(folder, prefix) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const item of entries.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix + item.name, p = path.join(folder, item.name);
      // These files change how a later Git add/checkout handles the reviewed directory.
      if (/^\.git(?:attributes|modules)$/i.test(item.name)) throw new Error('Git control files cannot be imported into a skill.');
      if (item.isDirectory()) { await walk(p, name + '/'); continue; }
      if (!item.isFile()) throw new Error('검사되지 않은 파일 형식: ' + name);
      assertNoSecrets(name);
      const bytes = await fs.readFile(p);
      total += bytes.length;
      if (total > 1024 * 1024 || bytes.includes(0)) throw new Error('원문 미리보기는 1 MiB 이하 텍스트만 지원합니다: ' + name);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assertNoSecrets(text);
      const verdict = safety.scanText(text, { path:name });
      if (verdict.verdict === 'block') throw new Error('안전 검사 차단: ' + name + ' · ' + verdict.findings.map(f=>f.rule).join(', '));
      for (const f of verdict.findings) warnings.push(name + ':' + f.line + ' ' + f.rule);
      if (/(^|\/)(hooks?|install|telemetry)\b|\.(?:js|cjs|mjs|py|ps1|sh|cmd|bat)$/i.test(name)) warnings.push('실행 관련 파일 ' + name);
      if (/--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|\btelemetry\b|\bfetch\s*\(/i.test(text)) warnings.push('권한·통신 설정 확인 ' + name);
      if (/^(?:licen[cs]e|copying)(?:\.|$)/i.test(item.name)) license = text.trim().slice(0, 150);
      files.push({ name, sha256: hash(bytes), text });
      names.push(name);
    }
  }
  await walk(dir, '');
  const sourceText = files.find(f => f.name === 'SKILL.md').text;
  const terms = new Set((sourceText.match(/[a-z가-힣][a-z가-힣-]{3,}/gi) || []).map(t=>t.toLowerCase()));
  const overlaps = existing.map(s => {
    const words = new Set(((s.description || '').toLowerCase().match(/[a-z가-힣][a-z가-힣-]{3,}/g) || []));
    const shared = [...words].filter(w=>terms.has(w));
    return { name:s.name, words:shared, ratio:shared.length / Math.max(1,words.size) };
  }).filter(v=>v.words.length>=3 && v.ratio>=0.3).sort((a,b)=>b.ratio-a.ratio).slice(0,5);
  const evidence = {relative,catalogEntry,origin,files:files.map(({name,sha256})=>[name,sha256])};
  return { reviewId:hash(JSON.stringify(evidence)), origin, license:license || '원본 라이선스 파일 없음', warnings, overlaps, names,
    diff:'+++ skills/CATALOG.md\n' + catalogEntry + '\n' + files.map(f=>'+++ '+relative+'/'+f.name+'\n'+f.text).join('\n') };
}

module.exports = {parse,inspect};
