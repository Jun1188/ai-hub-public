'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const {collect} = require('./awesome-snapshot.cjs');
const {publish} = require('./awesome-publish.cjs');
const journal = require('./awesome-journal.cjs');

function start({dataDir, connections, broker}) {
  const folder = path.join(dataDir, 'club-materials');
  let busy = false, stopped = false, retryAt = 0, lockBusySince = null;
  let phase = 'config';
  const read = async name => JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
  async function tick() {
    const now = Date.now();
    if (stopped || busy || now < retryAt) return;
    busy = true;
    let release;
    try {
      phase = 'config';
      let grant;
      try { grant = await read('awesome-site.local.json'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (grant.enabled !== true) return;
      if (grant.schemaVersion !== 1 || grant.repository !== 'your-org/your-site' || grant.intervalHours !== 6 ||
          grant.windowDays !== 30 || !Array.isArray(grant.info) || !grant.scope) throw Error('snapshot_grant_invalid');
      phase = 'lock';
      release = await journal.acquire(folder);
      if (!release) {
        if (lockBusySince === null) lockBusySince = now;
        // Let a normal concurrent tick finish. Expose repeated collisions without opening a second writer.
        if (now - lockBusySince >= 10 * 60000) throw Error('snapshot_lock_busy');
        return;
      }
      lockBusySince = null;
      phase = 'config';
      const scope = require('./hub-service.cjs').scope(await read('permission.json'));
      if (JSON.stringify(scope) !== JSON.stringify(grant.scope)) throw Error('snapshot_permission_changed');
      const stateFile = path.join(folder, 'awesome-site-state.json');
      let state;
      try { state = await read('awesome-site-state.json'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state !== undefined) {
        const observedAt = typeof state?.observedAt === 'string' ? Date.parse(state.observedAt) : NaN;
        if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 ||
            !Number.isFinite(observedAt) || observedAt > now) throw new Error('snapshot_state_invalid');
      }
      const scopeDigest = crypto.createHash('sha256').update(JSON.stringify({scope, info: grant.info})).digest('hex');
      let pending = await journal.read(folder, scopeDigest);
      if (pending && state && Date.parse(state.observedAt) >= Date.parse(pending.snapshot.observedAt)) {
        await journal.clear(folder);
        pending = null;
      }
      if (!pending && state && now - Date.parse(state.observedAt) < 6 * 3600000) return;
      if (!pending) {
        const profile = connections.get('discord');
        if (profile.origin !== 'https://discord.com' || !['bot', 'header'].includes(profile.auth) ||
            profile.auth === 'header' && profile.authHeader?.toLowerCase() !== 'authorization') throw Error('snapshot_discord_scope');
        const budget = profile.maxCallsPerRun;
        if (!Number.isInteger(budget) || budget < 1 || budget > 32) throw Error('snapshot_budget_invalid');
        let calls = 0;
        const jobId = 'awesome-snapshot:' + crypto.randomUUID();
        const request = (method, route) => {
          if (++calls > budget || stopped) throw Error('snapshot_request_budget');
          return broker.request({credentialRef: 'credential:api-discord', operationId: 'api.request', jobId,
            payload: {method, route}});
        };
        phase = 'collect';
        const end = Math.floor(Date.now() / 1000) * 1000;
        const observedAt = new Date(end).toISOString();
        const links = require('./awesome-public-links.cjs').candidates();
        const snapshot = journal.snapshot(await collect({request, scope, info: grant.info, observedAt,
          periodStart: new Date(end - 30 * 86400000).toISOString(), observeLink:links.observe}));
        let linkStatus='message_content_intent_unverified', publicLinks;
        // Preserve the existing history budget. A missing/unavailable capability check cannot empty the public cards.
        let app;
        if(calls<budget){try {app=await request('GET','/api/v10/oauth2/applications/@me');} catch {/* aggregate remains usable */}}
        if(Number.isSafeInteger(app?.flags)){
          if(app.flags & ((1<<18)|(1<<19))){
            publicLinks=await links.verify(observedAt);
            linkStatus='verified';
          }else linkStatus='message_content_intent_required';
        }
        pending = {schemaVersion: 1, scopeDigest, snapshot, linkStatus, ...(publicLinks?{publicLinks}:{}), commit: null, dispatch: 'pending'};
        await journal.save(folder, pending);
      }
      // Re-read grants immediately before the only external write.
      if (stopped || JSON.stringify(await read('awesome-site.local.json')) !== JSON.stringify(grant) ||
          JSON.stringify(require('./hub-service.cjs').scope(await read('permission.json'))) !== JSON.stringify(scope))
        throw Error('snapshot_grant_changed');
      phase = 'publish';
      if (!pending.commit) {
        let result;
        try {
          result = await publish(pending.snapshot, {publicLinks:pending.publicLinks,claimDispatch: async commit => {
            if (pending.commit) return false;
            pending = {...pending, commit, dispatch: 'attempted'};
            // Persist before HTTP: an unknown outcome is recovered by cron, never by replaying dispatch.
            await journal.save(folder, pending);
            return true;
          }});
        } catch (error) {
          // A verified newer feed supersedes this local observation. Allow the next tick to collect anew.
          if (error.message === 'snapshot_remote_newer') await journal.clear(folder);
          throw error;
        }
        pending = {...pending, commit: result.commit, dispatch: result.dispatch};
        await journal.save(folder, pending);
      } else if (pending.dispatch === 'attempted') {
        pending = {...pending, dispatch: 'deferred'};
        await journal.save(folder, pending);
      }
      const bytes = JSON.stringify({schemaVersion: 1, observedAt: pending.snapshot.observedAt, ...(pending.linkStatus?{publicLinks:pending.linkStatus}:{}),
        commit: pending.commit, dispatch: pending.dispatch}) + '\n';
      await require('../atomic-file').writeAtomic(stateFile, bytes);
      await journal.clear(folder);
    } catch (error) {
      const known = /^(snapshot_[a-z_]+|bot_[a-z_]+|channel_[a-z_]+|message_history_permission_missing|invalid_message_[a-z_]+)$/;
      const reason = known.test(error.message || '') ? error.message : 'request_failed';
      await require('../atomic-file').writeAtomic(path.join(folder, 'awesome-site-attempt.json'),
        JSON.stringify({schemaVersion: 1, at: new Date().toISOString(), phase, reason})).catch(() => {});
      retryAt = Date.now() + 3600000;
      // Raw API/Git errors may contain private data. Keep the public log constant.
      console.error('[ai-hub] Awesome snapshot deferred; last successful snapshot preserved.');
    } finally {
      try { await release?.(); }
      finally { busy = false; }
    }
  }
  const first = setTimeout(tick, 60000);
  const timer = setInterval(tick, 10 * 60000);
  first.unref?.(); timer.unref?.();
  return {busy: () => busy, stop() { stopped = true; clearTimeout(first); clearInterval(timer); }};
}
module.exports = {start};
