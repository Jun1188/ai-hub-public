// 아래 계층(분석기·모델 제어·연결 저장소)이 위 계층(지식 그래프·작업 큐)을 직접 require하지 않게 하는 신호판.
// 1.31까지는 그 역방향 require 7곳이 33개 파일을 한 덩어리 결합으로 묶었다(structure-audit의 coupled).
// 위 계층 모듈이 로드될 때 스스로 구독·등록하므로, 로드되지 않았다면 무효화할 캐시도 바쁜 작업도 없다.
'use strict';
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);
const busyProbes = new Map();

/** 색인·그래프처럼 다른 모듈이 캐시한 파생 데이터가 바뀌었다. */
function emitChanged(what) { bus.emit('changed', what); }
function onChanged(fn) { bus.on('changed', fn); return () => bus.off('changed', fn); }

/** 이 프로세스에서 지금 일하는 작업 종류. 탐침이 던지면 바쁘지 않은 것으로 본다. */
function registerBusy(name, probe) { busyProbes.set(name, probe); }
function busy(...names) {
  return names.filter((n) => { const p = busyProbes.get(n); try { return !!(p && p()); } catch { return false; } });
}

// 입장 관문: 거버너가 "지금은 새 로컬 추론을 미뤄라"를 걸면 슬롯 예약이 잠시 기다린다.
// 관문은 상한(maxWaitMs)까지만 막는다 — 거버너 오판이 작업을 영원히 세우지 않게.
const gates = new Map();
// 지금 관문 앞에서 기다리는 호출 수 — 거버너 평가가 관문이 실제로 막은 로컬 작업이 있었는지 아는 신호(원격 offload는 관문을 지나지 않는다).
const gateWaiters = new Map();
function setGate(name, until, reason) { if (until > Date.now()) gates.set(name, { until, reason }); else gates.delete(name); }
function gate(name) { const g = gates.get(name); return g && g.until > Date.now() ? g : null; }
function gateWaiting(name) { return gateWaiters.get(name) || 0; }
async function waitGate(name, { signal, maxWaitMs = 120000, pollMs = 1000 } = {}) {
  const started = Date.now();
  if (!gate(name)) return 0;
  gateWaiters.set(name, gateWaiting(name) + 1);
  try {
    while (gate(name) && Date.now() - started < maxWaitMs) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally { gateWaiters.set(name, Math.max(0, gateWaiting(name) - 1)); }
  return Date.now() - started;
}

module.exports = { emitChanged, onChanged, registerBusy, busy, setGate, gate, waitGate, gateWaiting };
