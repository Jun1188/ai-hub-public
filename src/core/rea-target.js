'use strict';
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { decode } = require('./console-text');
const sourceTargets = require('./rea-source-target');
const probeFile = path.join(__dirname, '../../scripts/rea-target.ps1');
const run = promisify(execFile);

async function probe(mode, args = []) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', probeFile, '-Mode', mode, ...args], { windowsHide: true, timeout: 12000, maxBuffer: 4 << 20, encoding: 'buffer' });
  return JSON.parse(decode(stdout).replace(/^\uFEFF/, ''));
}

async function localFile(file, probeSystem) {
  if (typeof file !== 'string' || !/^[a-z]:[\\/]/i.test(file) || /[:*?"<>|\x00-\x1f]/.test(file.slice(2))) {
    throw new Error('드라이브 문자로 시작하는 로컬 파일·폴더를 선택하세요.');
  }
  const parts = file.slice(3).split(/[\\/]/);
  if (parts.some(p => !p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('지원하지 않는 로컬 경로입니다.');
  const current = path.win32.normalize(file);
  try {
    const metadata = await probeSystem('file', ['-LiteralFile', current]);
    return { path: current, version: metadata.version || null };
  } catch {
    throw new Error('파일 접근을 확인할 수 없습니다. 로컬 드라이브의 실제 파일을 선택하세요. 원격·정션·클라우드 재분석 지점은 제외합니다.');
  }
}

async function imageInfo(file,{fingerprint=true}={}) {
  const stat = await fs.promises.stat(file);
  if (stat.isDirectory()) return sourceTargets.codebaseInfo(file);
  if (!stat.isFile()) throw new Error('일반 파일 또는 로컬 폴더를 선택하세요.');
  if (stat.size > 512 * 1024 ** 2) throw new Error('단일 바이너리·ASAR 파일은 512 MiB 이하로 선택하세요.');
  const ext = path.extname(file).toLowerCase();
  let format = 'javascript', structure;
  if (sourceTargets.sourceFile(file)) {
    if (stat.size > 1024**2) throw new Error('소스 파일은 1 MiB 이하로 선택하세요. 더 작은 모듈로 범위를 좁혀 주세요.');
    const body = await sourceTargets.readSource(path.dirname(file),file);
    sourceTargets.validateText(body);
    format = 'source';
    structure = { kind:'source-file', sourceFiles:1, language:ext, file:path.basename(file) };
  } else if (ext !== '.asar') {
    const handle = await fs.promises.open(file, 'r');
    try {
      const dos = Buffer.alloc(64), pe = Buffer.alloc(264);
      if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE() !== 0x5a4d) {
        throw new Error('Windows PE(EXE·DLL·SYS·OCX 등), ASAR 또는 C/C++·C#·JS/TS·Python 소스를 선택하세요. 이 파일 형식의 분석기는 연결되어 있지 않습니다.');
      }
      const at = dos.readUInt32LE(60);
      const n = (await handle.read(pe, 0, pe.length, at)).bytesRead;
      const magic = n >= 26 ? pe.readUInt16LE(24) : 0;
      if (pe.readUInt32LE() !== 0x4550 || ![0x10b,0x20b].includes(magic)) throw new Error('지원하는 Windows PE 형식이 아닙니다.');
      const directory = magic === 0x20b ? 136 : 120;
      const clr = directory + 14 * 8;
      const count = pe.readUInt16LE(6), optional = pe.readUInt16LE(20);
      if (!count || count > 96 || optional < directory - 24 || at + 24 + optional + count * 40 > stat.size) throw new Error('PE 섹션 표가 손상되었습니다.');
      const sections = Buffer.alloc(count * 40);
      if ((await handle.read(sections, 0, sections.length, at + 24 + optional)).bytesRead !== sections.length) throw new Error('PE 섹션을 읽지 못했습니다.');
      const list = Array.from({length:count}, (_,i) => {
        const off = i * 40;
        return { name: sections.subarray(off,off+8).toString('ascii').replace(/\0.*$/, ''),
          rva: sections.readUInt32LE(off+12), offset: sections.readUInt32LE(off+20), bytes: sections.readUInt32LE(off+16) };
      });
      if (list.some(section => section.bytes && (section.offset > stat.size || section.bytes > stat.size - section.offset))) {
        throw new Error('PE 섹션이 입력 파일 범위를 벗어납니다.');
      }
      format = n >= clr + 8 && pe.readUInt16LE(20) >= clr + 8 - 24 && pe.readUInt32LE(directory - 4) > 14 &&
        pe.readUInt32LE(clr) !== 0 && pe.readUInt32LE(clr + 4) !== 0 ? 'managed' : 'native';
      if (format === 'managed') {
        const rva = pe.readUInt32LE(clr), sec = list.find(s => rva >= s.rva && rva - s.rva + 20 <= s.bytes);
        const header = Buffer.alloc(20);
        const declared = pe.readUInt32LE(clr + 4);
        if (!sec || declared < 72 || rva - sec.rva + declared > sec.bytes ||
            (await handle.read(header,0,20,sec.offset + rva - sec.rva)).bytesRead !== 20 ||
            header.readUInt32LE() < 72 || header.readUInt32LE() > declared) throw new Error('CLR 형식을 확인할 수 없습니다.');
        if (!(header.readUInt32LE(16) & 1)) format = 'mixed';
      }
      structure = { machine: '0x' + pe.readUInt16LE(4).toString(16), sections: list };
    } finally { await handle.close(); }
  } else {
    const fileHandle = await fs.promises.open(file, 'r');
    try {
      const header = Buffer.alloc(16);
      if ((await fileHandle.read(header,0,16,0)).bytesRead !== 16 || header.readUInt32LE() !== 4) throw new Error('ASAR 헤더가 없습니다.');
      const size = header.readUInt32LE(12), pickle = header.readUInt32LE(4);
      if (!size || size > 8 * 1024 ** 2 || pickle < size + 8 || pickle > stat.size - 8 || header.readUInt32LE(8) !== pickle - 4) throw new Error('지원하지 않는 ASAR 헤더입니다.');
      const json = Buffer.alloc(size);
      if ((await fileHandle.read(json,0,size,16)).bytesRead !== size) throw new Error('ASAR 헤더를 읽지 못했습니다.');
      const entries = JSON.parse(json.toString('utf8')).files;
      if (!entries || Array.isArray(entries) || typeof entries !== 'object') throw new Error('ASAR 파일 표가 없습니다.');
      const payload = stat.size - 8 - pickle;
      const pending = Object.values(entries);
      for (let i = 0; i < pending.length; i++) {
        if (pending.length > 20000) throw new Error('ASAR 항목 수가 분석 한도를 넘습니다.');
        const entry = pending[i];
        if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error('ASAR 항목 형식이 잘못되었습니다.');
        if (entry.files !== undefined) {
          if (!entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files) || entry.offset !== undefined || entry.link !== undefined) throw new Error('ASAR 폴더 항목이 손상되었습니다.');
          for (const child of Object.values(entry.files)) pending.push(child);
        } else if (entry.link !== undefined) {
          if (typeof entry.link !== 'string' || entry.offset !== undefined) throw new Error('ASAR 링크 항목이 손상되었습니다.');
        } else {
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('ASAR 파일 크기가 잘못되었습니다.');
          if (!entry.unpacked) {
            const offset = Number(entry.offset);
            if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset) || !Number.isSafeInteger(offset) ||
                offset > payload || entry.size > payload - offset) throw new Error('ASAR 항목이 입력 파일 범위를 벗어납니다.');
          }
        }
      }
      structure = { topLevelCount:Object.keys(entries).length, topLevel:Object.keys(entries).slice(0,64) };
    } finally { await fileHandle.close(); }
  }
  let sha256;
  if (fingerprint) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    sha256=digest.digest('hex');
  }
  return { path: file, format, bytes: stat.size, modifiedMs: stat.mtimeMs, ...(sha256?{sha256}:{}), structure };
}

async function snapshot(target, evidenceDir) {
  if (!/^[a-f0-9]{64}$/.test(target.sha256)) throw new Error('파일 지문 형식을 확인하세요.');
  const dir = path.join(evidenceDir,target.sha256);
  await fs.promises.mkdir(dir, { recursive:true });
  if (target.structure.kind === 'codebase') return sourceTargets.snapshotCodebase(target,dir);
  const copy = target.format === 'source' ? path.join(dir,'source',path.basename(path.dirname(target.path)),path.basename(target.path)) :
    path.join(dir, 'input' + path.extname(target.path).toLowerCase());
  await fs.promises.mkdir(path.dirname(copy),{recursive:true});
  const pending = path.join(dir, crypto.randomUUID() + '.partial');
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(fs.createReadStream(target.path), new Transform({ transform(chunk, _, done) {
      bytes += chunk.length;
      if (bytes > target.bytes) return done(new Error('입력 파일 크기가 바뀌었습니다.'));
      digest.update(chunk); done(null,chunk);
    } }), fs.createWriteStream(pending, {flags:'wx',mode:0o600}));
    if (bytes !== target.bytes || digest.digest('hex') !== target.sha256) throw new Error('입력 파일이 바뀌었습니다. 다시 선택하세요.');
    try { await fs.promises.link(pending,copy); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    // The caller checks the installed copy's SHA before it can reach an analyzer.
    return copy;
  } finally { await fs.promises.unlink(pending).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
}

function makeTargetService({ readLink, probeSystem = probe }) {
  async function preview(input) {
    let file, process = null, shortcut = null, ignoredArguments = false;
    if (input?.kind === 'process') {
      if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || !/^\d{1,20}$/.test(input.started || '')) throw new Error('프로세스 생애를 확인할 수 없습니다. 목록에서 다시 선택하세요.');
      const [live] = await probeSystem('process', ['-TargetPid', String(input.pid)]).catch(() => []);
      if (!live || live.pid !== input.pid || live.started !== input.started) throw new Error('프로세스가 종료되었거나 바뀌었습니다.');
      const win = input.hwnd ? live.windows.find(w => w.Handle === input.hwnd) : null;
      if (input.hwnd && !win) throw new Error('선택한 창이 닫혔거나 소유자가 바뀌었습니다.');
      file = live.path;
      process = { pid: live.pid, started: live.started, hwnd: win?.Handle || '', name: live.name };
    } else if (['file','codebase'].includes(input?.kind)) file = input.path;
    else throw new Error('파일·폴더나 목록에서 대상을 선택하세요.');
    let checked = await localFile(file, probeSystem);
    if (path.extname(checked.path).toLowerCase() === '.lnk') {
      shortcut = checked.path;
      const link = readLink(shortcut);
      ignoredArguments = Boolean(link.args || link.cwd);
      checked = await localFile(link.target, probeSystem);
    }
    const stat = await fs.promises.stat(checked.path);
    if (stat.isDirectory() && input.kind !== 'codebase') return {folder:{...await sourceTargets.directoryInfo(checked.path),shortcut,ignoredArguments}};
    if (input.kind === 'codebase' && !stat.isDirectory()) throw new Error('코드베이스 폴더를 다시 선택하세요.');
    const image = await imageInfo(checked.path);
    const changedAfterStart = process ? image.modifiedMs > Number((BigInt(process.started) - 116444736000000000n)/10000n) + 1 : false;
    return { host: os.hostname(), process, shortcut, ignoredArguments, changedAfterStart, version: checked.version, ...image };
  }
  return { preview, list: () => probeSystem('list'), async verify(input, previous) {
    const fresh = await preview(input);
    if (JSON.stringify(fresh) !== JSON.stringify(previous)) throw new Error('파일 또는 프로세스가 변경되었습니다. 대상을 다시 선택하세요.');
    return fresh;
  } };
}

function analysisScope(value) {
  const scope = {};
  for (const key of ['focus','include','exclude','change','acceptance']) {
    const text = value?.[key];
    if (typeof text !== 'string' || text.length > 600 || (['focus','include','acceptance'].includes(key) && !text.trim())) {
      throw new Error('조사 목적, 분석할 부분, 검증 기준을 입력하세요. 항목당 최대 600자입니다.');
    }
    scope[key] = text.trim();
  }
  return scope;
}
module.exports = { makeTargetService, analysisScope, snapshot, imageInfo };
