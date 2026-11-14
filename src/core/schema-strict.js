// OpenAI 구조화 출력(strict) 모양으로 JSON 스키마를 바꾼다: 모든 객체에 additionalProperties:false,
// 모든 속성을 required에 넣고 원래 선택이던 속성은 null을 허용한다. Codex --output-schema가 이 규칙을 강제해
// 선택 필드가 하나라도 있는 스키마는 400(invalid_json_schema)으로 즉시 실패했다(2026-10-22 실측).
// 받은 값에서는 null인 선택 필드를 지운 뒤 원래 스키마로 검증한다 — 호출자가 보는 값의 모양은 바뀌지 않는다.
'use strict';

function toStrict(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = Array.isArray(schema) ? schema.map(toStrict) : { ...schema };
  if (Array.isArray(schema)) return out;
  if (out.items) out.items = toStrict(out.items);
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || out.properties;
  if (isObject) {
    const props = out.properties || {};
    const required = new Set(out.required || []);
    out.properties = {};
    for (const [k, v] of Object.entries(props)) {
      const sv = toStrict(v);
      if (required.has(k)) { out.properties[k] = sv; continue; }
      // 선택 속성 → null 허용. enum이 있으면 null도 값 목록에 넣어야 한다.
      const types = sv.type === undefined ? [] : [].concat(sv.type);
      out.properties[k] = { ...sv, ...(types.length ? { type: [...new Set([...types, 'null'])] } : {}), ...(Array.isArray(sv.enum) ? { enum: [...sv.enum, null] } : {}) };
    }
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

/** strict 출력에서 null로 채워진 선택 속성을 지운다(원래 스키마 기준). */
function dropNullOptionals(value, schema) {
  if (!schema || typeof schema !== 'object' || value == null) return value;
  if (Array.isArray(value)) return schema.items ? value.map((v) => dropNullOptionals(v, schema.items)) : value;
  if (typeof value !== 'object' || !schema.properties) return value;
  const required = new Set(schema.required || []);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k)) continue;
    out[k] = schema.properties[k] ? dropNullOptionals(v, schema.properties[k]) : v;
  }
  return out;
}

module.exports = { toStrict, dropNullOptionals };
