'use strict';
// Decides which analysis adapters (analysis-adapters.js) are usable from detected tool versions and the adapters'
// hard/soft dependencies, the way plugin loaders such as BepInEx and Reloaded-II do. Every disabled adapter keeps a reason.
const { z } = require('zod');

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const manifestRow = z.object({
  id,
  integration: z.enum(['primary', 'hub-fallback-headless','reference-candidate', 'knowledge-source', 'design-reference']),
  supportedTargets: z.array(id).min(1),
  tool: z.strictObject({ name: z.string().min(1), range: z.string().min(1) }).nullable(),
  capabilities: z.array(z.enum(['static', 'runtime'])).min(1),
  userGate: z.enum(['none', 'approval']),
  incompatibleWith: z.array(id),
  dependencies: z.strictObject({ hard: z.array(id), soft: z.array(id) }),
});

function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

// shortcut: comparator sets only (">=0.9.1 <0.10.0", "||", "*"); caret/tilde ranges throw, add them when a row needs one.
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return String(range).split('||').some(set => set.trim().split(/\s+/).every(part => {
    if (part === '*') return true;
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) throw new Error('adapter_range_unsupported: ' + range);
    const w = parseVersion(m[2]), c = v[0] - w[0] || v[1] - w[1] || v[2] - w[2];
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[m[1] || '='];
  }));
}

/** Adapter ids on hard-dependency cycles, as cycle paths. */
function cycles(byId) {
  const state = new Map(), stack = [], found = [];
  const visit = key => {
    state.set(key, 'open'); stack.push(key);
    for (const dep of byId.get(key).dependencies.hard) {
      if (!byId.has(dep)) continue;
      if (state.get(dep) === 'open') found.push(stack.slice(stack.indexOf(dep)));
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop(); state.set(key, 'done');
  };
  for (const key of byId.keys()) if (!state.has(key)) visit(key);
  return found;
}

/**
 * @param {object[]} rows typed manifest rows
 * @param {{tools?:Object<string,string|null>, target?:string}} detected installed tool versions by name; target narrows to adapters for it
 */
function resolve(rows, { tools = {}, target } = {}) {
  const list = rows.map(r => manifestRow.parse(r)), byId = new Map();
  for (const r of list) { if (byId.has(r.id)) throw new Error('adapter_duplicate_id: ' + r.id); byId.set(r.id, r); }
  const reasons = new Map(), found = cycles(byId);
  for (const cycle of found) for (const key of cycle) if (!reasons.has(key)) reasons.set(key, { code: 'dependency_cycle', cycle });
  for (const r of list) {
    if (reasons.has(r.id)) continue;
    if (target && !r.supportedTargets.includes(target)) reasons.set(r.id, { code: 'target_unsupported', target });
    else if (r.tool && !tools[r.tool.name]) reasons.set(r.id, { code: 'tool_not_found', tool: r.tool.name, range: r.tool.range });
    else if (r.tool && !satisfies(tools[r.tool.name], r.tool.range)) reasons.set(r.id, { code: 'tool_version_mismatch', tool: r.tool.name, found: String(tools[r.tool.name]), range: r.tool.range });
  }
  const propagate = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const r of list) {
        const dep = !reasons.has(r.id) && r.dependencies.hard.find(d => !byId.has(d) || reasons.has(d));
        if (dep) { reasons.set(r.id, { code: byId.has(dep) ? 'dependency_disabled' : 'dependency_missing', dependency: dep }); changed = true; }
      }
    }
  };
  propagate();
  // Decided against one snapshot so the outcome does not depend on row order; mutual exclusions disable both.
  const clashes = list.map(r => [r.id, !reasons.has(r.id) && r.incompatibleWith.find(o => byId.has(o) && !reasons.has(o))]).filter(([, o]) => o);
  for (const [key, other] of clashes) reasons.set(key, { code: 'incompatible_with', adapter: other });
  propagate();
  return {
    adapters: list.map(r => ({ id: r.id, integration: r.integration, capabilities: r.capabilities, userGate: r.userGate,
      enabled: !reasons.has(r.id), reason: reasons.get(r.id) || null,
      softMissing: r.dependencies.soft.filter(d => !byId.has(d) || reasons.has(d)) })),
    cycles: found,
  };
}

/** Adapters an MCP client may see: enabled, static only and needing no user gate. */
function forMcp(resolved) {
  return resolved.adapters.filter(a => a.enabled && !a.capabilities.includes('runtime') && a.userGate === 'none');
}

module.exports = { resolve, forMcp, satisfies };
