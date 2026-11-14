'use strict';
const IDLE_MS = 10 * 60000;
function createLifecycle(options = {}) {
  const now = options.now || Date.now, owned = new Map();
  const busy = options.busy || (() => require('./local-inference-lease').busy() || require('./model-change-lock').busy());
  const cleanup = options.cleanup || (item => require('./model-control').cleanupOwned(item));
  let timer, pending = false;
  function register({ provider, model, serverOwned = false, instanceId = '', runtimeTtl = false, serverIdentity = null }) {
    if (!['llamacpp', 'lmstudio'].includes(provider) || typeof model !== 'string' || !model) throw new Error('Confirmed owned model required');
    const key = `${provider}:${model}`, current = owned.get(key);
    const item = { provider, model, instanceId, runtimeTtl, serverIdentity, serverOwned: serverOwned || current?.serverOwned || false, lastUsedAt: now(), state: 'owned' };
    owned.set(key, item);
    if (!options.manual && !timer) { timer = setInterval(() => tick().catch(() => {}), 30000); timer.unref(); }
    return { ...item };
  }
  function touch(provider, model) {
    for (const item of owned.values()) if ((!provider || item.provider === provider) && (!model || item.model === model)) item.lastUsedAt = now();
  }
  async function tick() {
    if (pending || busy()) return [];
    pending = true; const results = [];
    try {
      for (const [key, item] of owned) {
        if (busy()) break;
        if (item.state !== 'owned' || now() - item.lastUsedAt < IDLE_MS) continue;
        item.state = 'stopping';
        try { const outcome=await cleanup({ ...item });
          if(outcome?.retain){item.state='owned';item.lastUsedAt=now();results.push({provider:item.provider,model:item.model,state:'retained',reason:outcome.reason});}
          else{owned.delete(key);results.push({ provider: item.provider, model: item.model, state: 'stopped' });}
        }
        catch { item.state = 'unknown'; results.push({ provider: item.provider, model: item.model, state: 'unknown' }); }
      }
    } finally { pending = false; }
    return results;
  }
  return { register, touch, tick, status: () => [...owned.values()].map(item => ({ ...item })), dispose: () => { if (timer) clearInterval(timer); timer = null; } };
}
let singleton;
const instance = () => singleton || (singleton = createLifecycle());
module.exports = { IDLE_MS, createLifecycle, instance };
