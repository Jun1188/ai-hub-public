'use strict';

const fs = require('fs').promises;
const path = require('path');
const { scrub } = require('../secret-scrub');
const rank = { pass: 0, review: 1, block: 2 };
const worst = (a, b) => rank[a] >= rank[b] ? a : b;
const definitions = [
  ['destructive-delete', 'block', ['any'], 'Recursive deletion of a root, drive, or home directory'],
  ['remote-execution', 'block', ['any'], 'Remote content piped into an interpreter or encoded PowerShell'],
  ['persistence', 'block', ['any'], 'Autorun registry, scheduled tasks, or Startup writes'],
  ['credential-harvest', 'block', ['any'], 'Reading credentials or uploading a credential inventory'],
  ['defense-evasion', 'block', ['any'], 'Disabling defenses or machine-wide execution restrictions'],
  ['bidi-control', 'block', ['any'], 'Bidirectional text controls can disguise source'],
  ['dynamic-js', 'review', ['js'], 'Dynamic JavaScript evaluation'],
  ['encoded-python', 'review', ['py'], 'Evaluation combined with encoded Python payloads'],
  ['base64-blob', 'review', ['sh', 'ps1', 'bat', 'js', 'py', 'json', 'any'], 'Long base64-like payload'],
  ['entropy-string', 'review', ['any'], 'High entropy string literal'],
  ['child-shell', 'review', ['js'], 'Child process invocation through a shell'],
  ['npm-lifecycle', 'review', ['json'], 'npm lifecycle scripts run during installation'],
  ['local-upload', 'review', ['any'], 'Uploading local file contents'],
  ['git-hook-write', 'review', ['any'], 'Writing executable Git hooks'],
  ['privilege', 'review', ['sh', 'ps1', 'bat', 'js', 'py', 'any'], 'Privilege escalation command'],
  ['prompt-injection', 'review', ['md'], 'Instructions that redirect an AI reader'],
  ['zero-width', 'review', ['any'], 'Invisible text characters']
];
const RULES = definitions.map(([id, severity, languages, description]) => ({ id, severity, languages, description }));

function languageOf(relPath = '') {
  return ({ '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'ps1', '.bat': 'bat',
    '.cmd': 'bat', '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.py': 'py', '.md': 'md', '.json': 'json' })[path.extname(relPath).toLowerCase()] || 'any';
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) { const p = count / value.length; result -= p * Math.log2(p); }
  return result;
}

function scanText(text, { path: relPath = '' } = {}) {
  text = String(text);
  const lang = languageOf(relPath);
  const findings = [];
  const add = (id, index) => {
    const rule = RULES.find(r => r.id === id);
    const start = text.lastIndexOf('\n', index - 1) + 1;
    const end = text.indexOf('\n', index);
    findings.push({ rule: id, severity: rule.severity, line: text.slice(0, index).split('\n').length,
      excerpt: scrub(text.slice(start, end < 0 ? text.length : end)).slice(0, 160), why: rule.description });
  };
  const match = (id, re) => { for (const m of text.matchAll(re)) add(id, m.index); };
  match('destructive-delete', /\brm\s+(?=[^\n;&|]*-[a-z]*r)(?=[^\n;&|]*-[a-z]*f)(?:-[a-z]+\s+)+(?:--\s+)?["']?(?:\/\*{0,2}|(?:~|\$HOME|\$\{HOME\})(?:\/\*{0,2})?)["']?(?=\s|$|[;&|])/gim);
  match('destructive-delete', /\bRemove-Item\b(?=[^\n;]*-(?:Recurse|r)\b)[^\n;]*?(?:["']?[a-z]:\\["']?(?=\s|$|;)|["']?(?:\$env:USERPROFILE|~)["']?(?=\s|$|;))/gim);
  match('destructive-delete', /\b(?:rd|rmdir)\s+(?=[^\n]*\/s\b)(?=[^\n]*\/q\b)[^\n]*?["']?[a-z]:\\["']?(?=\s|$)|\bformat\s+[a-z]:(?=\s|$)/gim);
  match('remote-execution', /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:(?:sudo|env)\s+)?(?:sh|bash|iex|Invoke-Expression)\b|\b(?:iex|Invoke-Expression)\s*\(?\s*\(?New-Object\s+(?:Net\.)?WebClient\)?\s*\)?\.DownloadString\b|\bpowershell(?:\.exe)?\s+[^\n]*?-(?:enc|EncodedCommand)\s+[A-Za-z0-9+/=]{4,}/gim);
  match('persistence', /\b(?:HKCU|HKLM|HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE)[\\:][^\n]*?\\CurrentVersion\\Run(?:Once)?\b|\bschtasks(?:\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b/gim);
  for (const m of text.matchAll(/[^\n]*(?:Startup|Start Menu[\\/]Programs[\\/]Startup)[^\n]*/gi)) {
    if (/\b(?:copy|move|writeFile|Set-Content|Out-File|Copy-Item|Move-Item|New-Item)\b|>>?/.test(m[0])) add('persistence', m.index);
  }
  for (const m of text.matchAll(/[^\n]*(?:\.ssh[\\/]id_[\w*.-]+|\.aws[\\/]credentials|Login Data|\bCookies\b|\.codex[\\/]auth\.json|\.claude[\\/]\.credentials(?:\.json)?|config\.local\.json|credentials\.local[\\/]|key-table\.v2\.json)[^\n]*/gi)) {
    if (/\b(?:cat|type|Get-Content|readFile(?:Sync)?|open|copy|cp|Copy-Item|sqlite3|curl|wget)\b/i.test(m[0])) add('credential-harvest', m.index);
  }
  match('credential-harvest', /\bgit\s+credential\s+fill\b/gi);
  if (/\bcurl\b[^\n]*(?:--(?:data(?:-binary)?|form|upload-file)\b|-[FT]\s)|\bInvoke-WebRequest\b[^\n]*-(?:InFile|Method\s+Post)\b|\bmethod\s*:\s*["']POST["']/i.test(text)) match('credential-harvest', /\bcmdkey(?:\.exe)?\s+\/list\b/gi);
  match('defense-evasion', /\bAdd-MpPreference\s+[^\n]*?-Exclusion\w*\b|\bSet-MpPreference\s+[^\n]*?-Disable\w*\b|\bSet-ExecutionPolicy\b(?=[^\n]*(?:Bypass|Unrestricted)\b)(?=[^\n]*-Scope\s+LocalMachine\b)[^\n]*/gi);
  match('bidi-control', /[\u202a-\u202e\u2066-\u2069]/g);
  if (lang === 'js') {
    match('dynamic-js', /\b(?:eval\s*\(|new\s+Function\s*\()/g);
    if (/\bchild_process\b/.test(text)) match('child-shell', /\bshell\s*:\s*true\b/g);
  }
  if (lang === 'py' && /\b(?:base64|zlib|marshal)\b/.test(text)) match('encoded-python', /\b(?:exec|eval)\s*\(/g);
  if (lang !== 'md') match('base64-blob', /(?<![\w+/])[A-Za-z0-9+/]{200,}={0,2}(?![\w+/])/g);
  for (const m of text.matchAll(/["'\x60]([^"'\x60\r\n]{120,})["'\x60]/g)) {
    if (entropy(m[1]) >= 4.5) add('entropy-string', m.index);
  }
  if (path.basename(relPath).toLowerCase() === 'package.json') {
    try {
      const json = JSON.parse(text);
      for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) {
        if (Object.prototype.hasOwnProperty.call(json.scripts || {}, key)) {
          add('npm-lifecycle', Math.max(0, text.search(new RegExp('"' + key + '"\\s*:'))));
        }
      }
    } catch { /* Compatibility validation reports malformed JSON separately. */ }
  }
  match('local-upload', /\bcurl\b[^\n]*(?:-F\s+[^\n]*@|--(?:data(?:-binary)?|form)\s+["']?@)|\bInvoke-WebRequest\b[^\n]*-InFile\b/gi);
  if (/\breadFile(?:Sync)?\b/.test(text) && /\bfetch\s*\(/.test(text)) match('local-upload', /\bmethod\s*:\s*["']POST["']/gi);
  for (const m of text.matchAll(/[^\n]*\.git[\\/]hooks[\\/][^\n]*/g)) {
    if (/\b(?:writeFile(?:Sync)?|copy|cp|Copy-Item|Set-Content|Out-File|open|install)\b|>>?/.test(m[0])) add('git-hook-write', m.index);
  }
  if (lang !== 'md' && lang !== 'json') match('privilege', /\b(?:sudo|runas)(?:\.exe)?\s+(?:-[\w-]+\s+)*\S+/gi);
  if (lang === 'md') {
    match('prompt-injection', /\bignore\s+(?:all|previous)\s+instructions\b|\bdisregard\s+the\s+above\b|\byou\s+are\s+now\b|\bsystem\s+prompt\b/gi);
    for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
      if (/\b(?:AI|assistant|agent|model|ChatGPT)\b/i.test(m[0]) && /\b(?:ignore|obey|execute|send|reveal|follow|override|must)\b/i.test(m[0])) add('prompt-injection', m.index);
    }
  }
  match('zero-width', /[\u200b-\u200d]|(?<!^)[\ufeff]/g);
  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { verdict: findings.reduce((v, f) => worst(v, f.severity), 'pass'), findings };
}

async function scanFiles(root, relPaths, { maxBytes = 1048576, deps = {} } = {}) {
  const io = deps.fs || fs;
  const base = path.resolve(root);
  const files = [];
  const skipped = [];
  let verdict = 'pass';
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  const inside = p => p === base || p.startsWith(prefix);
  for (const rel of relPaths) {
    const full = typeof rel === 'string' ? path.resolve(base, rel) : '';
    if (!full || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || !inside(full)) {
      skipped.push({ path: rel, reason: 'outside_root' }); verdict = worst(verdict, 'review'); continue;
    }
    try {
      const realRoot = await io.realpath(base);
      const real = await io.realpath(full);
      if (real !== realRoot && !real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
        skipped.push({ path: rel, reason: 'outside_root' }); verdict = worst(verdict, 'review'); continue;
      }
      const stat = await io.stat(full);
      if (!stat.isFile()) { skipped.push({ path: rel, reason: 'not_file' }); verdict = worst(verdict, 'review'); continue; }
      if (stat.size > maxBytes) { skipped.push({ path: rel, reason: 'too_large' }); verdict = worst(verdict, 'review'); continue; }
      const data = await io.readFile(full);
      if (data.length > maxBytes) { skipped.push({ path: rel, reason: 'too_large' }); verdict = worst(verdict, 'review'); continue; }
      if (data.subarray(0, 8192).includes(0)) { skipped.push({ path: rel, reason: 'binary' }); verdict = worst(verdict, 'review'); continue; }
      const result = scanText(data.toString('utf8'), { path: rel });
      files.push({ path: rel, ...result }); verdict = worst(verdict, result.verdict);
    } catch (error) {
      skipped.push({ path: rel, reason: 'read_failed', error: scrub(error.code || 'read_failed') });
      verdict = worst(verdict, 'review');
    }
  }
  return { verdict, files, skipped };
}

module.exports = { RULES, languageOf, scanText, scanFiles };
