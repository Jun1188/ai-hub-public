// Per-tool MCP usage: calls, errors, time, response bytes returned to the calling agent (bytes ≈ the main agent's
// token cost of using the Hub) and calls per MCP client. Feeds the live delegation map; persisted per day, device-only,
// never shared.
'use strict';
const fs = require('fs');
const path = require('path');
const caller = require('./caller');

const STARTED = Date.now();
const stats = new Map(); // tool -> { calls, errors, ms, bytes, last, clients } since process start (live map)
let daily = new Map(), day = null; // the same, for the current UTC day only (persisted)
// agy 1.4.4+ puts the top-level conversation id in tools/call _meta (the same value from nested subagents). It is kept as an
// attribution key only — which agy conversation called which Hub tools how often; arguments and results are never stored.
const ROOT_CONVERSATION = 'antigravity.google/root_conversation_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONVERSATIONS = 200; // per day and process; later ones only raise conversationsDropped
let conversations = new Map(), conversationsDropped = 0; // id -> { client, calls, errors, tools, first, last } for the current day
let dirty = false, timer = null;
// One file per process: a single <day>.json was rewritten by whichever process flushed last, so a Hub restart erased
// the earlier process's counts for that day.
const fileFor = (d) => path.join(require('./paths').hubDataDir(), 'tool-usage.local', d, `${process.pid}-${STARTED}.json`);

function bump(map, name, ms, bytes, ok, client) {
  const s = map.get(name) || { calls: 0, errors: 0, ms: 0, bytes: 0, last: 0, clients: {} };
  s.calls++; s.ms += ms; s.bytes += bytes; s.last = Date.now(); if (!ok) s.errors++;
  if (client) s.clients[client] = (s.clients[client] || 0) + 1;
  map.set(name, s);
}

function bumpConversation(id, name, ok, client) {
  const now = new Date().toISOString();
  let c = conversations.get(id);
  if (!c) {
    if (conversations.size >= MAX_CONVERSATIONS) { conversationsDropped++; return; }
    c = { client: client || '', calls: 0, errors: 0, tools: {}, first: now, last: now };
    conversations.set(id, c);
  }
  c.calls++; if (!ok) c.errors++; c.tools[name] = (c.tools[name] || 0) + 1; c.last = now;
}

function record(name, ms, bytes, ok, client, conversation) {
  const today = new Date().toISOString().slice(0, 10);
  // A Hub left running past midnight starts the new day at zero instead of carrying yesterday's counts into it.
  if (today !== day) { flush(); daily = new Map(); conversations = new Map(); conversationsDropped = 0; day = today; }
  bump(stats, name, ms, bytes, ok, client); bump(daily, name, ms, bytes, ok, client);
  if (conversation) bumpConversation(conversation, name, ok, client);
  dirty = true;
  if (!timer) { timer = setInterval(flush, 60000); timer.unref(); }
}

function flush() {
  if (!dirty) return Promise.resolve();
  dirty = false;
  // Serialized now, not in the promise chain: the day can roll over before the write runs.
  const target = fileFor(day), tmp = `${target}.tmp`;
  const body = JSON.stringify({ schema: 'tool-usage/2', pid: process.pid, startedAt: new Date(STARTED).toISOString(), day, tools: Object.fromEntries(daily),
    ...(conversations.size ? { conversations: Object.fromEntries(conversations) } : {}), ...(conversationsDropped ? { conversationsDropped } : {}) });
  return fs.promises.mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, body, 'utf8'))
    .then(() => fs.promises.rename(tmp, target)).catch(() => {});
}

// Modern (2026-07-28) requests and stdio sessions carry clientInfo. Legacy stateless HTTP serves every POST on a fresh
// server that never saw initialize, so there only the User-Agent product (no version or OS comment) is left.
function clientOf(server, ctx) {
  const info = server.server?.getClientVersion?.()?.name;
  const ua = !info && /^[^\s/;()]+/.exec(ctx?.http?.req?.headers?.get('user-agent') || '')?.[0];
  return info ? String(info).slice(0, 64) : ua ? `ua:${ua.slice(0, 61)}` : undefined;
}

// SDK 2 hands request _meta to tool handlers as ctx.mcpReq._meta (SDK 1: extra._meta). Only UUID-shaped ids are kept.
function conversationOf(ctx) {
  const id = (ctx?.mcpReq?._meta || ctx?._meta || {})[ROOT_CONVERSATION];
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined;
}

/** Wraps registerTool so every handler is measured and its delegations attributed; the handler's behavior is unchanged. */
// 이 프로세스에 등록된 도구 처리기. 도구 경로 실행기(toolroute/route-executor)가 MCP 왕복 없이 같은 도구를 부른다.
const handlers = new Map();
function invokeTool(name, args = {}) {
  const h = handlers.get(name);
  if (!h) throw Object.assign(new Error(`tool ${name} is not registered in this process`), { code: 'tool_not_available' });
  return h(args, {});
}

function instrument(server) {
  const original = server.registerTool.bind(server);
  server.registerTool = (name, options, handler) => { handlers.set(name, handler); return original(name, options, async (...args) => {
    const started = Date.now();
    const client = clientOf(server, args[args.length - 1]);
    const conversation = conversationOf(args[args.length - 1]);
    let ok = false, bytes = 0;
    try {
      const result = await caller.run({ via: 'mcp', ...(client ? { client } : {}), ...(conversation ? { conversation } : {}) }, () => handler(...args));
      ok = !result?.isError;
      bytes = Buffer.byteLength(JSON.stringify(result?.content ?? ''));
      return result;
    } finally { record(name, Date.now() - started, bytes, ok, client, conversation); }
  }); };
  return server;
}

const snapshot = () => Object.fromEntries([...stats].map(([k, v]) => [k, { ...v, clients: { ...v.clients } }]));

module.exports = { invokeTool, instrument, snapshot, record, flush };
