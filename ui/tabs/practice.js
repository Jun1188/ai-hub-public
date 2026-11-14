'use strict';

(() => {
  const el = name => document.getElementById('practice-' + name);
  const questions = {
    P1: '지금 바탕화면 바로가기를 더블클릭하면 뜨는 Hub 버전은? A 1.32.19 · B 1.32.41 · C 그보다 새 버전 · D 모르겠다',
    P2: '소스판에서 자동 갱신을 켜면 설치형 Hub를 다음에 열 때 어떻게 되나? A 아무 일 없음 · B 설치형도 갱신 시도 · C 오류 표시 · D 모르겠다',
    P3: '설정 파일이 깨진 상태에서 토글을 끄면? A 꺼진다 · B 오류가 나고 그대로 · C 파일이 지워진다 · D 모르겠다',
    P4: '갱신 도중 토글을 끄면 그 갱신은? A 즉시 멈춤 · B 끝까지 진행 · C 다음 시작부터 반영 · D 모르겠다',
    P5: '자동 갱신이 꺼졌을 때 지금 확인을 누르면 어떻게 표시돼야 하나? A 최신입니다 · B 확인하지 않음 · C 새 버전 있음 · D 모르겠다',
  };
  const text = (id, max) => {
    const s = el(id).value.trim();
    if (!s || s.length > max) throw Error('입력할 항목과 길이를 확인하세요.');
    return s;
  };
  const localDate = d => [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  let dbPromise, events = [];
  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
      const req = indexedDB.open('hub-learning-practice',1);
      req.onupgradeneeded = () => req.result.createObjectStore('events',{keyPath:['id','stage']});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }
  async function add(event) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction('events','readwrite'), store=tx.objectStore('events');
      const prior={observe:'predict',explain:'observe',retract:'predict'}[event.stage];
      const insert=() => store.add({...event,schemaVersion:1,at:new Date().toISOString()});
      if (prior) {
        const r=store.get([event.id,prior]);
        r.onsuccess=()=>{
          if(!r.result) {tx.abort();return;}
          const withdrawn=store.get([event.id,'retract']);
          withdrawn.onsuccess=()=>{if(withdrawn.result) tx.abort(); else insert();};
        };
      } else insert();
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(Error('단계를 다시 확인하세요. 같은 단계는 한 번만 저장합니다.'));
      tx.onerror=()=>{};
    });
  }
  async function load(selected) {
    const db=await open();
    events=await new Promise((resolve,reject) => {
      const req=db.transaction('events').objectStore('events').getAll();
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    const current=el('current'), id=selected || current.value;
    const withdrawn=new Set(events.filter(r=>r.stage==='retract').map(r=>r.id));
    const rows=events.filter(r=>r.stage==='predict' && !withdrawn.has(r.id)).sort((a,b)=>b.at.localeCompare(a.at));
    current.replaceChildren(...rows.map(r=>new Option(r.question,r.id)));
    if(rows.some(r=>r.id===id)) current.value=id;
    detail(); week();
  }
  function detail() {
    const rows=events.filter(r=>r.id===el('current').value);
    const p=rows.find(r=>r.stage==='predict'), o=rows.find(r=>r.stage==='observe'), x=rows.find(r=>r.stage==='explain');
    el('observe').hidden=!p || !!o; el('explain').hidden=!o || !!x;
    el('context').textContent=p ? ['예측 · '+p.prediction, o && '관찰 · '+o.observation+' ('+o.evidence+')',
      x && '설명 · '+x.explanation, x && '다음 확인 · '+x.next].filter(Boolean).join('\n') : '저장한 연습이 없습니다.';
    el('undo').hidden=!p;
    for (const id of ['o','e','match','x','next','reason']) el(id).value='';
  }
  function week() {
    const date=el('date').value;
    if(!date) {el('week').textContent='조회할 날짜를 선택하세요.';el('data').textContent='';return [];}
    const start=new Date(date+'T00:00:00');
    start.setDate(start.getDate()-((start.getDay()+6)%7));
    const end=new Date(start);end.setDate(start.getDate()+7);
    const rows=events.filter(r=>new Date(r.at)>=start && new Date(r.at)<end)
      .sort((a,b)=>a.at.localeCompare(b.at));
    const withdrawn=new Set(events.filter(r=>r.stage==='retract').map(r=>r.id));
    const active=rows.filter(r=>!withdrawn.has(r.id));
    const obs=active.filter(r=>r.stage==='observe'), judged=obs.filter(r=>r.match!==null);
    const misses=judged.filter(r=>!r.match).length, closed=active.filter(r=>r.stage==='explain').length;
    el('week').textContent=localDate(start)+' 시작 · 예측 '+active.filter(r=>r.stage==='predict').length+
      '건 · 관찰 '+obs.length+'건 · 설명 '+closed+'건 · 불일치 '+(judged.length?misses+'/'+judged.length:'판정 자료 없음')+
      ' · 판정 보류 '+(obs.length-judged.length)+'건 · 철회 '+rows.filter(r=>r.stage==='retract').length+'건';
    el('data').textContent='';
    return rows;
  }
  function s4() {
    const session=text('session',11), node=text('node',100), items=text('items',160).split(',').map(x=>x.trim());
    if(!/^\d{4}-\d{2}-\d{2}[a-z]$/.test(session) || session.slice(0,10)!==localDate(new Date()) ||
       !items.every(i=>/^[CA]\d{3,}$/.test(i))) throw Error('오늘의 S4 세션 ID와 실제 명제·사슬 ID를 확인하세요.');
    return {session,node,items:[...new Set(items)]};
  }
  // One click corresponds to one user-authored stage. A new question never
  // inherits the previous prediction, and opening the tab creates no events.
  function saveOnClick(id,fn) {
    el(id).onclick=async()=>{
      const b=el(id);b.disabled=true;
      try { await fn(); el('msg').textContent='저장했습니다.'; }
      catch(e) {el('msg').textContent=e.message;}
      finally{b.disabled=false;}
    };
  }
  el('source').onchange=()=> {
    const src=el('source').value;
    el('s4').hidden=src!=='s4';el('q').readOnly=Object.hasOwn(questions,src);
    el('q').value=questions[src] || '';el('p').value='';
  };
  saveOnClick('start',async()=>{
    const src=el('source').value,id=crypto.randomUUID();
    const event={id,stage:'predict',question:text('q',1000),prediction:text('p',1000),source:src};
    if(src==='s4') event.s4=s4();
    if(Object.hasOwn(questions,src)) {event.card='W13-C01';event.question=questions[src];}
    await add(event);el('p').value='';await load(id);
  });
  saveOnClick('save-obs',async()=>{
    const id=el('current').value, value=el('match').value;
    await add({id,stage:'observe',observation:text('o',1000),evidence:text('e',500),
      match:value==='yes'?true:value==='no'?false:null});
    await load(id);
  });
  saveOnClick('finish',async()=>{
    const id=el('current').value;
    await add({id,stage:'explain',explanation:text('x',1000),next:text('next',500)});
    await load(id);
  });
  saveOnClick('retract',async()=>{
    await add({id:el('current').value,stage:'retract',reason:text('reason',500)});
    await load();
  });
  el('current').onchange=detail;
  el('date').value=localDate(new Date());el('date').onchange=week;
  el('raw').onclick=()=>{const rows=week();el('data').textContent=JSON.stringify(rows,null,2);};
  el('s4-export').onclick=()=>{
    const lines=[];
    const withdrawn=new Set(events.filter(r=>r.stage==='retract').map(r=>r.id));
    for(const o of week().filter(r=>r.stage==='observe' && !withdrawn.has(r.id))) {
      const p=events.find(r=>r.id===o.id && r.stage==='predict');
      if(!p?.s4) continue;
      const d=new Date(p.at), at=localDate(d)+'T'+[d.getHours(),d.getMinutes()].map(n=>String(n).padStart(2,'0')).join(':');
      lines.push(JSON.stringify({...p.s4,at,kind:'predict',q:p.question,answer:p.prediction,correct:o.match}));
    }
    el('data').textContent=lines.join('\n') || '이 주에 관찰을 기록한 S4 연습이 없습니다.';
  };
  el('w13-export').onclick=()=>{
    const testWeek=week(), ids=new Set(testWeek.map(r=>r.id));
    const rows=events.filter(p=>p.card==='W13-C01' && ids.has(p.id)).map(p=>{
      const o=events.find(r=>r.id===p.id && r.stage==='observe');
      return {attemptId:p.id,card:p.card,id:p.source,userChoice:p.prediction,userChoseAt:p.at,userSeconds:null,
        actual:o?.observation??null,actualEvidence:o?.evidence??null,checkedAt:o?.at??null,
        withdrawn:events.some(r=>r.id===p.id && r.stage==='retract')};
    });
    el('data').textContent=JSON.stringify(rows,null,2);
  };
  el('panel').ontoggle=()=>{if(el('panel').open) load().catch(e=>{el('msg').textContent=e.message;});};
})();
