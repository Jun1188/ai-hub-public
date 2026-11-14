'use strict';
// Discord 봇(등록한 Discord 연결)으로 서버·채널·최근 메시지를 읽고 채널에 보낸다. 경로는 여기서만, 검증한 snowflake로만 만든다.
// 응답은 맥락에 넣기 좋게 필요한 필드만 남긴다. 호출·가림·회로 차단(429·버킷 소진)·60초 상한은 http(=callApi)가 한다.
const API = '/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const CHANNEL_TYPES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };

const routes = {
  guilds: () => `${API}/users/@me/guilds`,
  channels: (guild) => `${API}/guilds/${guild}/channels`,
  messages: (channel, limit) => `${API}/channels/${channel}/messages?limit=${limit}`,
  send: (channel) => `${API}/channels/${channel}/messages`,
};

function snowflake(v, label) {
  if (!SNOWFLAKE.test(String(v || ''))) throw Error(`${label}는 Discord ID(숫자 17–20자리)입니다. 개발자 모드에서 「ID 복사」로 얻습니다.`);
  return String(v);
}
const list = (v) => { if (!Array.isArray(v)) throw Error('Discord 응답 형식이 예상과 다릅니다.'); return v; };

/** verb: guilds | channels | messages | send. http(method, route, body?) → 응답 본문(오류 상태는 던진다). */
async function run(verb, args, http) {
  if (verb === 'guilds') return { guilds: list(await http('GET', routes.guilds())).map((g) => ({ id: g.id, name: g.name })) };
  if (verb === 'channels') {
    return { guild: args.guild, channels: list(await http('GET', routes.channels(args.guild)))
      .map((c) => ({ id: c.id, name: c.name, type: CHANNEL_TYPES[c.type] || String(c.type), ...(c.parent_id ? { parent: c.parent_id } : {}) })) };
  }
  if (verb === 'messages') {
    // Discord는 최신 메시지부터 준다.
    return { channel: args.channel, order: 'newest-first', messages: list(await http('GET', routes.messages(args.channel, args.limit)))
      .map((m) => ({ id: m.id, author: m.author && (m.author.global_name || m.author.username), content: m.content, at: m.timestamp,
        ...(m.attachments && m.attachments.length ? { attachments: m.attachments.length } : {}) })) };
  }
  if (verb === 'send') {
    // 멘션은 끈다 — AI가 만든 글이 @everyone·역할을 호출하지 않게.
    const m = await http('POST', routes.send(args.channel), { content: args.content, allowed_mentions: { parse: [] } });
    return { sent: { id: m && m.id, channel: args.channel, chars: args.content.length } };
  }
  throw Error('알 수 없는 Discord 명령입니다.');
}

module.exports = { run, routes, snowflake, SNOWFLAKE };
