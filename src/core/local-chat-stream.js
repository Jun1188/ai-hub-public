'use strict';
const { retryAfterMs } = require('./credential-broker'); // Retry-After 해석은 HTTP 경계(브로커)에 하나만 둔다
async function chat({ url, headers = {}, body, timeoutMs = 600000, signal, fetchFn = fetch }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Invalid local inference timeout');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Local inference timed out; inspect the existing job before retrying.')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let reader;const startedAt=Date.now();
  try {
    combined.throwIfAborted();
    const res = await fetchFn(url, { method: 'POST', redirect: 'error', signal: combined,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) });
    if (!res.ok) {
      const err = new Error('Local inference HTTP ' + res.status + '; no automatic retry.');
      err.status = res.status; err.retryAfterMs = retryAfterMs(res.headers.get('retry-after')); throw err;
    }
    if (!res.body) throw new Error('Local inference response has no stream');
    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', content = '', finishReason = null, usage = {}, done = false, firstTokenAt = null;
    const line = value => {
      if (!value.startsWith('data:')) return;
      const raw = value.slice(5).trim();
      if (raw === '[DONE]') { done = true; return; }
      if (!raw) return;
      if (done) throw new Error('Unexpected data after local inference completed');
      const packet = JSON.parse(raw);
      if (packet.error) throw new Error('Local inference stream reported an error');
      const choice = packet.choices?.[0];
      const delta=choice?.delta;
      if(firstTokenAt===null && ['content','reasoning_content','reasoning'].some(k=>typeof delta?.[k]==='string'&&delta[k].length>0))firstTokenAt=Date.now();
      if (choice?.delta?.content != null) {
        if (typeof choice.delta.content !== 'string') throw new Error('Unsupported local response content');
        content += choice.delta.content;
      }
      finishReason = choice?.finish_reason || finishReason;
      if (packet.usage && typeof packet.usage === 'object') usage = packet.usage;
      if (content.length > 64000) throw new Error('Local inference output exceeds limit');
    };
    for (;;) {
      combined.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error('Local inference frame exceeds limit');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, newline).trimEnd()); pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) line(pending.trim());
    if (!done && !finishReason) throw new Error('Local inference stream ended without completion; do not resubmit automatically.');
    return { content, finishReason, usage, firstTokenMs:firstTokenAt===null?null:firstTokenAt-startedAt,
      tokensPerSecond:firstTokenAt!==null&&Number(usage.completion_tokens)>0?Number(usage.completion_tokens)/Math.max(0.001,(Date.now()-firstTokenAt)/1000):null,
      reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0 };
  } catch (err) {
    if (reader) await reader.cancel().catch(() => {});
    throw err;
  } finally { clearTimeout(timer); reader?.releaseLock(); }
}
module.exports = { chat, retryAfterMs };
