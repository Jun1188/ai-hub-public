// ComfyUI LoRA: 이 기기 loras 폴더의 목록, API 프롬프트에 LoraLoaderModelOnly 사슬 넣기, 실행 뒤 맞추지 못한 키 세기.
//
// 왜 모델 전용 로더: Z-Image·Anima·MOSS-Image LoRA는 확산 모델만 학습한다(MOSS CharRef 카드의 워크플로가 LoraLoaderModelOnly,
// anima_lora는 LLM 어댑터를 학습하지 않음). 텍스트 인코더 LoRA가 필요한 워크플로는 LoraLoader를 직접 넣어 보낸다.
// 왜 키 세기: ComfyUI는 다른 기반 모델의 LoRA를 받아도 오류 없이 "lora key not loaded" 경고만 남기고 LoRA 없이 그린다.
'use strict';

const fs = require('fs');
const path = require('path');
const { withTimeout } = require('./promise-timeout');

// folder_paths.supported_pt_extensions (ComfyUI 0.41)
const EXTENSIONS = new Set(['.safetensors', '.sft', '.ckpt', '.pt', '.pt2', '.pth', '.bin', '.pkl']);
// MODEL을 0번 출력으로 내는 확산 모델 로더. UnetLoaderGGUF는 ComfyUI-GGUF 커스텀 노드다.
const MODEL_LOADERS = new Set(['UNETLoader', 'CheckpointLoaderSimple', 'UnetLoaderGGUF']);
const NODE_PREFIX = 'hub_lora_';
const MAX_LORAS = 8;
const MAX_HEADER_BYTES = 16 * 1024 ** 2; // 학습 태그 빈도(ss_tag_frequency)가 든 kohya 헤더도 수백 KB다
const META_KEYS = ['modelspec.architecture', 'modelspec.title', 'modelspec.trigger_phrase', 'ss_base_model_version',
  'ss_network_module', 'ss_network_dim', 'ss_network_alpha', 'ss_output_name'];
// comfy/lora.py "lora key not loaded: <key>", comfy/sd.py "NOT LOADED <key>"
const NOT_LOADED = /(?:lora key not loaded:|NOT LOADED) (\S+)/g;

function coded(code, message, extra = {}) { return Object.assign(new Error(message), { code }, extra); }
// ComfyUI는 lora_name을 대소문자까지 목록과 비교하지만 Windows 파일 이름은 대소문자를 가리지 않는다: 찾을 때만 무시하고 목록의 이름을 보낸다.
const caseKey = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);

function relName(name) {
  const rel = path.normalize(String(name || '').trim());
  if (!rel || rel === '.' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    throw coded('COMFY_LORA_INVALID', `LoRA 이름은 loras 폴더 안의 상대 경로여야 합니다: ${name}`);
  }
  return rel;
}

// 이름은 ComfyUI가 lora_name으로 받는 상대 경로(Windows는 \)다. file은 이 모듈 밖으로 내보내지 않는다(기기 전용 경로).
async function scan(roots, maxFiles = 2000) {
  const deadline = Date.now() + 5000;
  const seen = new Set(), items = [];
  let unreadable = 0, truncated = false;
  for (const root of [...new Set(roots || [])]) {
    const top = path.join(root, 'loras');
    const stack = [top];
    while (stack.length && !truncated) {
      if (Date.now() >= deadline || items.length >= maxFiles) { truncated = true; break; }
      const dir = stack.pop();
      let entries;
      try { entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), 1000, () => new Error('lora scan timeout')); }
      catch (e) { if (e.code !== 'ENOENT') unreadable++; continue; } // 못 읽은 폴더를 "LoRA 없음"으로 보이지 않게 센다
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        if (!EXTENSIONS.has(path.extname(ent.name).toLowerCase())) continue;
        const name = path.relative(top, full);
        if (seen.has(caseKey(name))) continue; // ComfyUI도 같은 이름은 앞 폴더의 것을 쓴다
        const stat = await fs.promises.stat(full).catch(() => null);
        if (!stat) continue;
        seen.add(caseKey(name));
        items.push({ name, sizeBytes: stat.size, file: full });
      }
    }
  }
  return { items, unreadable, truncated };
}

/** safetensors 머리말: 텐서 수와 학습 도구가 남긴 메타데이터 일부. 메타데이터는 남이 쓴 글이라 짧게 자른다. */
async function header(file) {
  if (!/\.(safetensors|sft)$/i.test(file)) return null;
  const handle = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(8);
    if ((await handle.read(head, 0, 8, 0)).bytesRead < 8) return null;
    const size = Number(head.readBigUInt64LE(0));
    if (!(size >= 2 && size <= MAX_HEADER_BYTES)) return null;
    const body = Buffer.alloc(size);
    if ((await handle.read(body, 0, size, 8)).bytesRead < size) return null;
    const doc = JSON.parse(body.toString('utf8'));
    const raw = (doc && doc.__metadata__) || {}, meta = {};
    for (const key of META_KEYS) if (raw[key] != null && raw[key] !== '') meta[key] = String(raw[key]).slice(0, 200);
    return { tensors: Object.keys(doc).filter((k) => k !== '__metadata__').length, meta };
  } catch { return null; } finally { await handle.close().catch(() => {}); }
}
const headerWithin = (file) => withTimeout(header(file), 2000, () => new Error('header timeout')).catch(() => null);

/** comfy_lora_list: 이름·크기와 (있으면) 텐서 수·학습 메타데이터. 폴더 경로는 싣지 않는다. */
async function list(roots) {
  const { items, unreadable, truncated } = await scan(roots);
  const loras = [];
  for (const item of items) {
    const head = await headerWithin(item.file);
    loras.push({ name: item.name, sizeBytes: item.sizeBytes, ...(head ? { tensors: head.tensors, ...(Object.keys(head.meta).length ? { meta: head.meta } : {}) } : {}) });
  }
  return { loras, ...(unreadable ? { unreadable } : {}), ...(truncated ? { truncated: true } : {}) };
}

/** 요청한 LoRA를 목록의 이름·크기로 바꾼다. 없는 이름은 실행 전에 거절한다(ComfyUI 검증은 GPU 슬롯을 잡은 뒤라 늦다). */
async function resolve(requested, roots) {
  if (!Array.isArray(requested) || !requested.length) return [];
  if (requested.length > MAX_LORAS) throw coded('COMFY_LORA_INVALID', `LoRA는 한 번에 ${MAX_LORAS}개까지입니다.`);
  const { items } = await scan(roots);
  const byKey = new Map(items.map((x) => [caseKey(x.name), x]));
  const out = [];
  for (const want of requested) {
    const strength = want && want.strength !== undefined ? Number(want.strength) : 1;
    if (!Number.isFinite(strength)) throw coded('COMFY_LORA_INVALID', `LoRA 강도가 숫자가 아닙니다: ${want && want.name}`);
    const hit = byKey.get(caseKey(relName(want && want.name)));
    if (!hit) {
      throw coded('COMFY_LORA_NOT_FOUND', `LoRA를 찾지 못했습니다: ${want.name} (comfy_lora_list로 이름을 확인하세요)`,
        { available: items.slice(0, 50).map((x) => x.name) });
    }
    const head = await headerWithin(hit.file);
    out.push({ name: hit.name, strength, sizeBytes: hit.sizeBytes, tensors: head ? head.tensors : null });
  }
  return out;
}

/** 확산 모델 로더의 MODEL 출력 뒤에 LoraLoaderModelOnly를 차례로 잇고, 그 출력을 쓰던 입력을 사슬 끝으로 옮긴다. */
function inject(prompt, loras, target) {
  if (!loras || !loras.length) return prompt;
  const ids = target != null && target !== ''
    ? [String(target)]
    : Object.keys(prompt).filter((id) => MODEL_LOADERS.has(prompt[id] && prompt[id].class_type));
  if (ids.length !== 1 || !prompt[ids[0]]) {
    throw coded('COMFY_LORA_TARGET', target != null && target !== '' ? `lora_target 노드가 없습니다: ${target}`
      : `LoRA를 붙일 확산 모델 로더를 하나로 정하지 못했습니다(후보 ${ids.length}개${ids.length ? `: ${ids.join(', ')}` : ''}). lora_target에 MODEL을 0번 출력으로 내는 노드 id를 주세요.`);
  }
  if (Object.keys(prompt).some((id) => id.startsWith(NODE_PREFIX))) throw coded('COMFY_LORA_TARGET', `워크플로에 이미 ${NODE_PREFIX} 노드가 있습니다.`);
  const source = ids[0], out = structuredClone(prompt);
  const consumers = Object.values(out).filter((node) => node && node.inputs);
  let model = [source, 0];
  loras.forEach((lora, i) => {
    const id = NODE_PREFIX + (i + 1);
    out[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: lora.name, strength_model: lora.strength }, _meta: { title: `LoRA ${lora.name}` } };
    model = [id, 0];
  });
  let moved = 0;
  for (const node of consumers) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === source && Number(value[1]) === 0) { node.inputs[field] = model; moved++; }
    }
  }
  // 아무도 받지 않는 LoRA 노드는 ComfyUI가 실행하지 않는다: 조용히 LoRA 없이 그리게 두지 않는다.
  if (!moved) throw coded('COMFY_LORA_TARGET', `노드 ${source}의 MODEL 출력(0번)을 쓰는 노드가 없습니다.`);
  return out;
}

/** 실행 전 로그 버퍼(GET /internal/logs/raw의 entries)의 마지막 항목. 실행 뒤에는 그 다음 항목만 센다. */
const logMarker = (entries) => (Array.isArray(entries) && entries.length ? entries[entries.length - 1] : null);

/**
 * 실행 중 ComfyUI가 모델에 맞추지 못한 LoRA 키. tensors는 넣은 LoRA들의 텐서 수 합(모르면 null).
 * 같은 LoRA 노드가 ComfyUI 캐시에서 나오면 경고가 다시 찍히지 않는다 — Hub는 실행마다 /free로 캐시를 비운다.
 */
function notLoadedSince(entries, marker, tensors) {
  const at = marker ? entries.findIndex((e) => e && e.t === marker.t && e.m === marker.m) : -1;
  // 버퍼는 300줄이라 실행 중에 표시가 밀려날 수 있다: 그때는 남은 전부를 세고 하한으로 표시한다.
  const text = entries.slice(at + 1).map((e) => String((e && e.m) || '')).join('');
  const keys = [...text.matchAll(NOT_LOADED)].map((m) => m[1]);
  const verdict = !keys.length ? 'all-keys-loaded' : tensors > 0 && keys.length >= tensors ? 'none-loaded' : 'some-not-loaded';
  return { checked: true, verdict, notLoadedKeys: keys.length, ...(keys.length ? { sample: keys.slice(0, 3) } : {}),
    ...(marker && at < 0 ? { lowerBound: true } : {}) };
}

module.exports = { list, resolve, inject, logMarker, notLoadedSince, MODEL_LOADERS, MAX_LORAS, _internals: { scan, header, relName } };
