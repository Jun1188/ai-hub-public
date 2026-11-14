'use strict';
const assert = require('node:assert/strict');
const {collect} = require('../src/core/club-materials/awesome-snapshot.cjs');

const scope = {guild:'1231943710053240863', channel:'1263838408170536991', forum:'1537080185428377621',
  news:'1537099328823500872', threads:['1537099502698238113','1537099328823500872']};
const info = [scope.threads[0], scope.channel];
const end = Math.floor(Date.now() / 1000) * 1000 - 1000;
const observedAt = new Date(end).toISOString(), periodStart = new Date(end - 30 * 86400000).toISOString();
const cutoff = BigInt(end - 1420070400000 + 1) << 22n;

function fixture(permissions) {
  let pages = 0, messageCalls = 0;
  const request = async (method, route) => {
    assert.equal(method, 'GET');
    if (route.endsWith('/users/@me')) return {id:'1231943710053240888',bot:true};
    if (route.endsWith('/members/1231943710053240888')) return {user:{id:'1231943710053240888'},roles:[]};
    if (route.endsWith('/roles')) return [{id:scope.guild,permissions}];
    for (const id of [scope.news, ...info, scope.forum]) {
      if (route === '/api/v10/channels/' + id) return {id,guild_id:scope.guild,permission_overwrites:[],
        type:id===scope.forum?15:id===scope.channel?0:11,parent_id:scope.forum};
    }
    if (route.includes('/messages?')) {
      messageCalls++;
      if (!route.startsWith('/api/v10/channels/' + scope.news + '/messages?')) return [];
      pages++;
      if (pages === 1) return Array.from({length:100}, (_, i) => ({id:String(cutoff-BigInt(i+1)),channel_id:scope.news,
        timestamp:new Date(end-10000).toISOString(),content:'PRIVATE BODY',author:{username:'PRIVATE AUTHOR'}}));
      assert.equal(new URL('https://discord.com'+route).searchParams.get('before'), String(cutoff-100n));
      return [{id:String(cutoff-101n),channel_id:scope.news,timestamp:new Date(end-31*86400000).toISOString()}];
    }
    throw Error('Unexpected fixture route');
  };
  return {request, get messageCalls() {return messageCalls;}};
}

(async () => {
  const readable = fixture('66560'); // VIEW_CHANNEL | READ_MESSAGE_HISTORY, without Administrator.
  const snapshot = await collect({request:readable.request,scope,info,periodStart,observedAt});
  assert.equal(snapshot.categories.news.messageCount,100);
  assert.equal(snapshot.categories.info.messageCount,0);
  assert.deepEqual(snapshot.items,[]);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|123194371005324|153709932882350/);
  const denied = fixture('1024');
  await assert.rejects(collect({request:denied.request,scope,info,periodStart,observedAt}), /message_history_permission_missing/);
  assert.equal(denied.messageCalls,0); // A denied history cannot masquerade as zero messages.
  const failing = fixture('66560');
  await assert.rejects(collect({request:async(m,r)=>{
    if(r.includes('/messages?')) throw Error('request_budget');
    return failing.request(m,r);
  },scope,info,periodStart,observedAt}),/request_budget/);
  console.log('Awesome aggregate pagination/privacy/permission checks passed');
})().catch(error => {console.error(error);process.exitCode=1;});
