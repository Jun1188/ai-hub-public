'use strict';
// Only aggregates cross the local/public boundary. Never return message bodies or source IDs.
const {PermissionsBitField: P} = require('discord.js');
const snowflake = x => typeof x === 'string' && /^\d{17,20}$/.test(x);

function canRead(channel, member, roles, guild) {
  const selected = roles.filter(r => r.id === guild || member.roles.includes(r.id));
  let bits = selected.reduce((b, r) => b | BigInt(r.permissions), 0n);
  if (new P(bits).has(P.Flags.Administrator)) return true;
  const apply = rows => {
    const deny = rows.reduce((b, x) => b | BigInt(x.deny), 0n);
    const allow = rows.reduce((b, x) => b | BigInt(x.allow), 0n);
    bits = (bits & ~deny) | allow;
  };
  const overwrites = channel.permission_overwrites;
  if (!Array.isArray(overwrites)) throw Error('channel_permissions_unverified');
  apply(overwrites.filter(x => x.type === 0 && x.id === guild));
  apply(overwrites.filter(x => x.type === 0 && member.roles.includes(x.id)));
  apply(overwrites.filter(x => x.type === 1 && x.id === member.user.id));
  return new P(bits).has([P.Flags.ViewChannel, P.Flags.ReadMessageHistory]);
}

async function collect({request, scope, info, periodStart, observedAt, observeLink}) {
  if (!snowflake(scope.guild) || !snowflake(scope.news) || !Array.isArray(info) || !info.length ||
      !info.every(x => snowflake(x) && [scope.channel, ...scope.threads].includes(x)) ||
      info.includes(scope.news) || new Set(info).size !== info.length) throw Error('snapshot_scope');
  const start = Date.parse(periodStart), end = Date.parse(observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > Date.now() ||
      end - start > 31 * 86400000) throw Error('snapshot_interval');
  const get = route => request('GET', '/api/v10' + route);
  const me = await get('/users/@me');
  const member = await get('/guilds/' + scope.guild + '/members/' + me.id);
  const roles = await get('/guilds/' + scope.guild + '/roles');
  if (me.bot !== true || !snowflake(me.id) || member.user?.id !== me.id ||
      !Array.isArray(member.roles) || !Array.isArray(roles)) throw Error('bot_unverified');
  const channels = new Map();
  for (const id of [scope.news, ...info, scope.forum]) {
    if (!channels.has(id)) channels.set(id, await get('/channels/' + id));
  }
  for (const [id, channel] of channels) {
    if (channel.id !== id || channel.guild_id !== scope.guild) throw Error('channel_scope_changed');
  }
  const categories = {};
  for (const [category, ids] of [['news', [scope.news]], ['info', info]]) {
    let count = 0, last = null;
    for (const id of ids) {
      const channel = channels.get(id);
      if (![0, 5, 11].includes(channel.type) || channel.type === 11 && channel.parent_id !== scope.forum)
        throw Error('channel_type_changed');
      const parent = channel.type === 11 ? channels.get(scope.forum) : channel;
      if (channel.type === 11 && parent?.type !== 15 || !canRead(parent, member, roles, scope.guild))
        throw Error('message_history_permission_missing');
      // Bound the first page to the observation cutoff; later new messages cannot shift pagination.
      let before = ((BigInt(end - 1420070400000 + 1) << 22n)).toString();
      let complete = false;
      const seen = new Set();
      while (!complete) {
        const page = await get('/channels/' + id + '/messages?limit=100&before=' + before);
        if (!Array.isArray(page) || page.length > 100) throw Error('invalid_message_page');
        if (!page.length) break;
        let minimum = BigInt(before);
        for (const message of page) {
          const at = Date.parse(message.timestamp);
          if (!snowflake(message.id) || message.channel_id !== id || !Number.isFinite(at) ||
              BigInt(message.id) >= BigInt(before) || seen.has(message.id)) throw Error('invalid_message_metadata');
          seen.add(message.id);
          if (BigInt(message.id) < minimum) minimum = BigInt(message.id);
          if (at < start) complete = true;
          if (at >= start && at <= end) {
            count++;
            observeLink?.(category,at,message);
            if (last === null || at > Date.parse(last)) last = new Date(at).toISOString();
          }
        }
        before = minimum.toString();
        if (page.length < 100) complete = true;
      }
    }
    categories[category] = {messageCount: count, lastMessageAt: last};
  }
  const current = await get('/users/@me');
  if (current.id !== me.id || current.bot !== true) throw Error('bot_identity_changed');
  return {schemaVersion: 1, source: 'discord', status: 'snapshot', observedAt, periodStart, categories, items: []};
}
module.exports = {collect, canRead};
