// ComfyUI UI(그래프) 워크플로 → API(prompt) 형식 변환.
//
// 왜: 번들 템플릿과 사용자가 저장한 워크플로는 UI 형식(nodes/links)인데 /prompt는 API 형식만 받는다.
// UI 형식의 위젯 값은 이름 없이 순서로만 저장되므로 실행 중인 서버의 /object_info 입력 순서로 이름을
// 붙인다 — 노드 정의는 ComfyUI 버전마다 바뀌어서 표를 코드에 박아 두면 조용히 어긋난다.
'use strict';

// 서버에는 없고 프런트엔드만 그리는 노드. Reroute·PrimitiveNode는 연결을 풀어서 없앤다.
const FRONTEND_ONLY = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);
// 시드류 위젯 뒤에 프런트엔드가 덧붙이는 "생성 후 값 바꾸기" 위젯의 값.
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);
const MODE_MUTED = 2;
const MODE_BYPASS = 4;

const isUiWorkflow = (doc) => Boolean(doc && typeof doc === 'object' && Array.isArray(doc.nodes));
const slotName = (slot) => (slot.widget && slot.widget.name) || slot.name;

function normalizeLink(l) {
  if (Array.isArray(l)) return { id: l[0], from: l[1], fromSlot: l[2], type: l[5] };
  return { id: l.id, from: l.origin_id, fromSlot: l.origin_slot, type: l.type };
}

function inputSpecs(input = {}, order = {}) {
  const out = [];
  for (const group of ['required', 'optional']) {
    const specs = input[group] || {};
    for (const name of order[group] || Object.keys(specs)) {
      const spec = specs[name];
      if (spec) out.push({ name, type: Array.isArray(spec) ? spec[0] : spec, opts: (Array.isArray(spec) && spec[1]) || {} });
    }
  }
  return out;
}

// 위젯 판정은 타입 이름이 아니라 UI 노드의 슬롯으로 한다: 소켓 입력은 연결이 없어도 항상 슬롯이 있고,
// 위젯은 입력으로 바꿨을 때만 widget 표시와 함께 슬롯이 생긴다. COLOR·LOAD_3D처럼 위젯 타입은 계속 는다.
function widgetValues(node, def) {
  const slots = new Map((node.inputs || []).map((s) => [slotName(s), s]));
  const values = node.widgets_values;
  const byName = values && typeof values === 'object' && !Array.isArray(values);
  const list = Array.isArray(values) ? values : [];
  const out = {};
  let i = 0;
  const take = (specs, prefix) => {
    for (const { name, type, opts } of specs) {
      const id = prefix + name;
      const slot = slots.get(id);
      if (!(slot ? slot.widget : !opts.forceInput)) continue;
      if (byName ? !Object.prototype.hasOwnProperty.call(values, id) : i >= list.length) {
        // 저장 뒤에 노드에 생긴 위젯(번들 템플릿의 MoGeInference.refine_steps)은 프런트엔드처럼 기본값을 쓴다.
        const fallback = 'default' in opts ? opts.default : Array.isArray(type) ? type[0] : undefined;
        if (fallback === undefined) continue;
        out[id] = fallback;
      } else if (byName) out[id] = values[id];
      else {
        out[id] = list[i++];
        // 옛 프런트엔드는 control_after_generate 표시 없이 이름이 seed인 INT에만 붙였다.
        if ((opts.control_after_generate || /^(noise_)?seed$/.test(name)) && CONTROL_VALUES.has(list[i])) i++;
      }
      // v3 DynamicCombo: 고른 옵션의 하위 위젯 값이 바로 뒤에 오고, 서버는 "부모.자식" 이름으로 받는다.
      if (type === 'COMFY_DYNAMICCOMBO_V3') {
        const option = (opts.options || []).find((o) => o.key === out[id]);
        if (option) take(inputSpecs(option.inputs), `${id}.`);
      }
    }
  };
  take(inputSpecs(def.input, def.input_order), '');
  return out;
}

// 바이패스 노드는 출력과 같은 타입의 입력을 그대로 넘긴다(프런트엔드와 같게: 같은 번호의 입력 우선).
function bypassInput(node, link) {
  const linked = (node.inputs || []).filter((s) => s.link != null);
  const sameType = (s) => s.type === link.type || s.type === '*' || link.type === '*';
  const at = (node.inputs || [])[link.fromSlot];
  return at && at.link != null && sameType(at) ? at : linked.find(sameType);
}

function toApiPrompt(doc, objectInfo) {
  if (!isUiWorkflow(doc)) throw new Error('UI 형식 워크플로(nodes 배열)가 아닙니다.');
  if (doc.definitions && Array.isArray(doc.definitions.subgraphs) && doc.definitions.subgraphs.length) {
    const err = new Error('서브그래프가 든 UI 워크플로는 변환하지 않습니다. ComfyUI에서 API 형식으로 내보내세요.');
    err.code = 'COMFY_SUBGRAPH_UNSUPPORTED';
    throw err;
  }
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const links = new Map((doc.links || []).map(normalizeLink).map((l) => [l.id, l]));
  const resolve = (linkId, depth = 0) => {
    const link = links.get(linkId);
    const source = link && nodes.get(link.from);
    if (!source || depth > nodes.size) return undefined; // depth: Reroute 순환 방지
    if (source.type === 'Reroute') return resolve(source.inputs && source.inputs[0] && source.inputs[0].link, depth + 1);
    if (source.type === 'PrimitiveNode') return { value: (source.widgets_values || [])[0] };
    if (source.mode === MODE_MUTED) return undefined;
    if (source.mode === MODE_BYPASS) {
      const pass = bypassInput(source, link);
      return pass ? resolve(pass.link, depth + 1) : undefined;
    }
    return { link: [String(source.id), link.fromSlot] };
  };
  const prompt = {};
  for (const node of doc.nodes) {
    if (FRONTEND_ONLY.has(node.type) || node.mode === MODE_MUTED || node.mode === MODE_BYPASS) continue;
    const def = objectInfo && objectInfo[node.type];
    // 정의가 없는 노드도 남긴다: comfyWorkflow가 누락 커스텀 노드로 명시적으로 보고한다.
    const inputs = def ? widgetValues(node, def) : {};
    for (const slot of node.inputs || []) {
      if (slot.link == null) continue;
      const source = resolve(slot.link);
      if (source && source.link) inputs[slotName(slot)] = source.link;
      else if (source && source.value !== undefined) inputs[slotName(slot)] = source.value;
      // 끊긴(뮤트된) 연결은 버린다. 입력으로 바꾼 위젯이면 저장된 위젯 값이 남는다.
    }
    prompt[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title || (def && def.display_name) || node.type } };
  }
  return prompt;
}

module.exports = { isUiWorkflow, toApiPrompt, FRONTEND_ONLY };
