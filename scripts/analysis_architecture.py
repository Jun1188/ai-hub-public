"""Offline architecture viewer for existing Graphify JSON; no extraction or model calls."""
import argparse
import hashlib
import json
from pathlib import Path


def normalize(raw):
    nodes = raw.get('nodes', [])
    if not isinstance(nodes, list) or not nodes:
        raise ValueError('Graph has no nodes; previous architecture output preserved.')
    ids = set()
    for node in nodes:
        key = str(node.get('id', ''))
        if not key or key in ids:
            raise ValueError('Node IDs must be present and unique')
        ids.add(key)
        node['id'] = key
    edges = raw.get('edges', raw.get('links', []))
    if not isinstance(edges, list):
        raise ValueError('Graph edges must be an array')
    retained = []
    for edge in edges:
        source, target = str(edge.get('source', '')), str(edge.get('target', ''))
        if source in ids and target in ids:
            retained.append({**edge, 'source': source, 'target': target})
    return {'nodes': nodes, 'edges': retained, 'directed': raw.get('directed', False),
            'metadata': raw.get('metadata', {}),
            'warning': f'{len(edges)-len(retained)} dangling edges omitted' if len(retained) != len(edges) else ''}


HTML = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>Graphify · 구조 탐색</title><style>
:root{color-scheme:light dark;--bg:#f8f9fc;--fg:#182437;--muted:#5e6c80;--card:#fff;--line:#ccd4e0;--accent:#2260b2}
@media(prefers-color-scheme:dark){:root{--bg:#111821;--fg:#e1e9f5;--muted:#99aabd;--card:#1b2635;--line:#3a4a60;--accent:#8cbafd}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}header{padding:20px;border-bottom:1px solid var(--line)}h1{font-size:22px;margin:0 0 5px}p{margin:4px 0}button,input,select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:5px;padding:6px 10px}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--accent)}.toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px}.toolbar input{min-width:200px}main{display:grid;grid-template-columns:260px minmax(300px,1fr) 300px;height:calc(100vh - 175px);min-height:420px}aside{overflow:auto;padding:14px;border-right:1px solid var(--line)}#inspector{border:0;border-left:1px solid var(--line)}#map{overflow:auto;position:relative}.list{display:flex;flex-direction:column;gap:5px}.list button{text-align:left;word-break:break-word}.node{fill:var(--card);stroke:var(--line);stroke-width:1.5;cursor:pointer}.node:focus{stroke:var(--accent);stroke-width:3}text{fill:var(--fg);font:12px system-ui,sans-serif;pointer-events:none}.edge{stroke:var(--muted);stroke-width:1.3;fill:none}.inferred{stroke-dasharray:5 4}.ambiguous{stroke-dasharray:2 5}.hint{color:var(--muted);font-size:12px}.warning{color:#bf6b17}pre{white-space:pre-wrap;word-break:break-word;font-size:12px}#status{padding:0 20px}svg{display:block}summary{cursor:pointer}#inspector h2{font-size:18px;word-break:break-word}@media(max-width:850px){main{grid-template-columns:200px 1fr}#inspector{grid-column:1/-1;max-height:250px}main{height:auto}#map{height:550px}}
</style></head><body>
<header><h1>Graphify · 구조 탐색</h1><p class="hint">기존 그래프의 관계와 근거를 탐색합니다. 관측된 구조·추론·불확실 관계를 구분하며 실행 시 동작을 보장하지 않습니다.</p><p class="hint" id="fingerprint"></p></header>
<div class="toolbar"><input id="search" aria-label="노드 검색" placeholder="이름·소스 경로 검색"><button id="find">검색</button><button id="overview">전체 구조</button><select id="view" aria-label="관계 보기"><option value="architecture">구조</option><option value="calls">호출</option><option value="dataflow">데이터 흐름</option><option value="lifecycle">수명주기 후보</option></select><button id="upstream">상위 관계</button><button id="downstream">하위 관계</button><input id="target" aria-label="경로 도착 노드 ID" placeholder="도착 노드 ID"><button id="path">경로 찾기</button></div>
<p id="status" aria-live="polite"></p><main><aside><div id="list" class="list"></div></aside><div id="map"></div><aside id="inspector"><p>노드를 선택하면 근거와 관계가 표시됩니다.</p></aside></main>
<script type="application/json" id="graph-data">__DATA__</script>
<script>
'use strict';
(() => {
const data=JSON.parse(document.getElementById('graph-data').textContent),graph=data.graph;
const byId=new Map(graph.nodes.map(n=>[n.id,n])), byCommunity=new Map();
const el=id=>document.getElementById(id),svgNS='http://www.w3.org/2000/svg';
let focused=null,shown=[],shownEdges=[];
const label=n=>String(n.label||n.name||n.id), evidence=e=>String(e.evidence||e.confidence_type||(typeof e.confidence==='string'?e.confidence:'')||'EXTRACTED').toUpperCase();
const relation=e=>String(e.relation||e.label||e.type||'related');
const location=n=>n.source_file&&/^L?\d+(?:(?:-|:)L?\d+)?$/.test(String(n.source_location||''))?n.source_file+':'+String(n.source_location).replaceAll('L',''):String(n.source_location||n.source_file||n.binary_address||'근거 위치 미상');
const group=n=>String(n.community_name||n.community||String(n.source_file||'unassigned').split(/[\\/]/)[0]);
for(const n of graph.nodes){const key=group(n);if(!byCommunity.has(key))byCommunity.set(key,[]);byCommunity.get(key).push(n);}
el('fingerprint').textContent='graph.json SHA256: '+data.sha256+' · '+graph.nodes.length+' nodes · '+graph.edges.length+' edges · '+(graph.directed?'방향 그래프':'원본 무방향 그래프 (경로는 양방향)');
function text(tag,value,cls){const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;}
function status(value){el('status').textContent=value+(graph.warning?' · '+graph.warning:'');}
function edgeAllowed(e){const view=el('view').value,r=relation(e).toLowerCase();return view==='architecture'||(view==='calls'&&/call|invoke|dispatch/.test(r))||(view==='dataflow'&&/read|write|data|flow|produces|consumes|return/.test(r))||(view==='lifecycle'&&/lifecycle|awake|start|update|enable|destroy/.test(r));}
function inspect(n){
 focused=n.id;el('inspector').replaceChildren(text('h2',label(n)),text('pre',n.id),text('p',evidence(n),'hint'),text('p',location(n),'hint'));
 if(n.type)el('inspector').append(text('p',String(n.type)));
 if(n.binaryHash)el('inspector').append(text('pre','binary SHA256: '+n.binaryHash));
 if(n.lifecycle_candidate)el('inspector').append(text('p',n.lifecycle_candidate,'warning'));
 const incoming=graph.edges.filter(e=>e.target===n.id),outgoing=graph.edges.filter(e=>e.source===n.id);
 el('inspector').append(text('p',incoming.length+' incoming · '+outgoing.length+' outgoing'));
 for(const edge of [...incoming,...outgoing].slice(0,30)){
  const other=edge.source===n.id?edge.target:edge.source,button=text('button',relation(edge)+' → '+label(byId.get(other)||{id:other})+' · '+evidence(edge));
  button.addEventListener('click',()=>focus(other));el('inspector').append(button);
  if(edge.source_location||edge.note)el('inspector').append(text('p',String(edge.source_location||edge.note),'hint'));
 }
}
function draw(nodes,edges){
 shown=nodes.slice(0,160);const ids=new Set(shown.map(n=>n.id));shownEdges=edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).slice(0,500);
 const svg=document.createElementNS(svgNS,'svg'), width=920, height=Math.max(540,Math.ceil(shown.length/4)*100+40);svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.style.minWidth=width+'px';
 const defs=document.createElementNS(svgNS,'defs'),marker=document.createElementNS(svgNS,'marker'),tip=document.createElementNS(svgNS,'path');marker.setAttribute('id','direction');marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','7');marker.setAttribute('markerHeight','7');marker.setAttribute('orient','auto');tip.setAttribute('d','M0 0 L10 5 L0 10 z');tip.setAttribute('fill','var(--muted)');marker.append(tip);defs.append(marker);svg.append(defs);
 const positions=new Map(shown.map((n,i)=>[n.id,{x:20+(i%4)*225,y:30+Math.floor(i/4)*100}]));
 for(const edge of shownEdges){const a=positions.get(edge.source),b=positions.get(edge.target),line=document.createElementNS(svgNS,'path');line.setAttribute('d',`M${a.x+100},${a.y+45} L${b.x+100},${b.y}`);line.setAttribute('class','edge '+(evidence(edge)==='INFERRED'?'inferred':evidence(edge)==='AMBIGUOUS'?'ambiguous':''));if(graph.directed)line.setAttribute('marker-end','url(#direction)');const title=document.createElementNS(svgNS,'title');title.textContent=relation(edge)+' · '+evidence(edge);line.append(title);svg.append(line);}
 for(const n of shown){const p=positions.get(n.id),g=document.createElementNS(svgNS,'g'),rect=document.createElementNS(svgNS,'rect'),t=document.createElementNS(svgNS,'text');g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',label(n));rect.setAttribute('x',p.x);rect.setAttribute('y',p.y);rect.setAttribute('width','200');rect.setAttribute('height','48');rect.setAttribute('rx','6');rect.setAttribute('class','node');t.setAttribute('x',p.x+8);t.setAttribute('y',p.y+29);t.textContent=label(n).slice(0,25);const title=document.createElementNS(svgNS,'title');title.textContent=label(n)+' · '+location(n);g.append(rect,t,title);const action=()=>n.members?showCommunity(n.id):focus(n.id);g.addEventListener('click',action);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();action();}});svg.append(g);}
 el('map').replaceChildren(svg);el('list').replaceChildren();
 for(const n of shown){const b=text('button',label(n)+(n.members?' · '+n.members+' nodes':''));b.addEventListener('click',()=>n.members?showCommunity(n.id):focus(n.id));el('list').append(b);}
}
function overview(){
 focused=null;
 if(graph.nodes.length>5000){
  const groups=[...byCommunity.entries()].map(([id,members])=>({id,label:id,members:members.length}));
  const aggregate=new Map();for(const e of graph.edges.filter(edgeAllowed)){const source=group(byId.get(e.source)),target=group(byId.get(e.target));if(source===target)continue;const key=source+'\u0000'+target;if(!aggregate.has(key))aggregate.set(key,{source,target,relation:'community relations',evidence:evidence(e)});}
  draw(groups,[...aggregate.values()]);status('대규모 그래프: 커뮤니티 보기 · 화면 최대 160개 그룹. 검색으로 특정 노드를 찾을 수 있습니다.');
 }else{const edges=graph.edges.filter(edgeAllowed),ids=new Set(edges.flatMap(e=>[e.source,e.target]));const nodes=el('view').value==='architecture'?graph.nodes:graph.nodes.filter(n=>ids.has(n.id)||(el('view').value==='lifecycle'&&n.lifecycle_candidate));draw(nodes,edges);status(nodes.length+'개 노드 · 화면 최대 160개. 검색으로 범위를 좁히세요.');}
}
function showCommunity(id){const nodes=byCommunity.get(id)||[];draw(nodes,graph.edges.filter(edgeAllowed));status(id+' · '+nodes.length+' nodes · 화면 최대 160개');}
function focus(id){const n=byId.get(id);if(!n)return;const edges=graph.edges.filter(e=>edgeAllowed(e)&&(e.source===id||e.target===id)),ids=new Set([id,...edges.flatMap(e=>[e.source,e.target])]);draw(graph.nodes.filter(n=>ids.has(n.id)),edges);inspect(n);status('선택 노드 주변 · '+ids.size+' nodes');}
function adjacent(direction){if(!focused)return;const edges=graph.edges.filter(e=>edgeAllowed(e)&&(direction==='upstream'?e.target===focused:e.source===focused)),ids=new Set([focused,...edges.flatMap(e=>[e.source,e.target])]);draw(graph.nodes.filter(n=>ids.has(n.id)),edges);status(direction+' · '+edges.length+' relations');}
function find(){const query=el('search').value.toLocaleLowerCase().trim(),nodes=graph.nodes.filter(n=>[label(n),n.id,location(n)].some(v=>String(v).toLocaleLowerCase().includes(query)));draw(nodes,graph.edges.filter(edgeAllowed));status(nodes.length+'개 검색 결과 · 화면 최대 160개');if(nodes.length===1)inspect(nodes[0]);}
function path(){
 const target=el('target').value.trim();if(!focused||!byId.has(target)){status('출발 노드를 선택하고 도착 노드 ID를 입력하세요.');return;}
 const adjacency=new Map();for(const e of graph.edges.filter(edgeAllowed)){if(!adjacency.has(e.source))adjacency.set(e.source,[]);adjacency.get(e.source).push(e);if(!graph.directed){if(!adjacency.has(e.target))adjacency.set(e.target,[]);adjacency.get(e.target).push({...e,source:e.target,target:e.source});}}
 const previous=new Map([[focused,null]]),queue=[focused];for(let i=0;i<queue.length&&!previous.has(target);i++){for(const e of adjacency.get(queue[i])||[])if(!previous.has(e.target)){previous.set(e.target,e);queue.push(e.target);}}
 if(!previous.has(target)){status('현재 관계 필터에서 경로 없음');return;}const edges=[];let cursor=target;while(previous.get(cursor)){const e=previous.get(cursor);edges.unshift(e);cursor=e.source;}draw([focused,...edges.map(e=>e.target)].map(id=>byId.get(id)),edges);status(edges.length+'개 관계 경로 · 관계별 근거를 확인하세요.');
}
el('overview').addEventListener('click',overview);el('view').addEventListener('change',overview);el('find').addEventListener('click',find);el('search').addEventListener('keydown',e=>{if(e.key==='Enter')find();});el('upstream').addEventListener('click',()=>adjacent('upstream'));el('downstream').addEventListener('click',()=>adjacent('downstream'));el('path').addEventListener('click',path);overview();
})();
</script></body></html>'''


def render(source, destination):
    original = source.read_bytes()
    raw = json.loads(original.decode('utf-8'))
    graph = normalize(raw)
    data = json.dumps({'sha256': hashlib.sha256(original).hexdigest(), 'graph': graph}, ensure_ascii=False)
    data = data.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    output = HTML.replace('__DATA__', data)
    if '\ufffd' in output:
        raise ValueError('Unicode replacement character detected; regenerate corrupt graph first')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + '.tmp')
    temporary.write_text(output, encoding='utf-8')
    temporary.replace(destination)
    print(json.dumps({'output': str(destination), 'sha256': hashlib.sha256(original).hexdigest(),
                      'nodes': len(graph['nodes']), 'edges': len(graph['edges']),
                      'community_view': len(graph['nodes']) > 5000, 'warning': graph['warning']}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('graph', type=Path)
    parser.add_argument('--output', '-o', type=Path)
    args = parser.parse_args()
    if args.graph.stat().st_size > 128 * 1024 ** 2:
        parser.error('Graph exceeds the 128 MiB offline viewer limit')
    destination = args.output or args.graph.with_name('architecture.html')
    if destination.resolve() == args.graph.resolve():
        parser.error('Output must not overwrite source graph')
    render(args.graph, destination)


if __name__ == '__main__':
    main()
