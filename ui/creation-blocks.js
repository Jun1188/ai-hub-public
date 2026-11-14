'use strict';
window.creationBlocks={
 starter:{pages:[{name:'Home',component:{type:'wrapper',components:[
  {tagName:'header',style:{padding:'24px 7%',display:'flex','justify-content':'space-between','align-items':'center'},components:[{type:'text',tagName:'strong',content:'AWESOME'},{type:'link',content:'자료 살펴보기',attributes:{href:'#resources'}}]},
  {tagName:'section',style:{padding:'80px 7%','background-color':'#eef1e8'},components:[{type:'text',tagName:'p',content:'함께 만드는 공간'},{type:'text',tagName:'h1',content:'선택하고, 움직이고, 함께 다듬기',style:{'font-size':'48px','max-width':'720px'}},{type:'text',tagName:'p',content:'요소를 눌러 글자와 스타일을 바꾸세요. 왼쪽 블록을 끌어 놓으면 새 구성을 만들 수 있습니다.'},{type:'link',content:'새로운 소식 보기',attributes:{href:'#resources'},style:{display:'inline-block',padding:'14px 20px','background-color':'#193e37',color:'#ffffff'}}]},
  {tagName:'section',attributes:{id:'resources'},style:{padding:'40px 7%',display:'flex',gap:'24px','flex-wrap':'wrap'},components:[{tagName:'article',style:{flex:'1','min-width':'220px',padding:'24px',border:'1px solid #ccd3c9'},components:[{type:'text',tagName:'h2',content:'자료 모음'},{type:'text',tagName:'p',content:'이 카드를 선택해 구성과 간격을 직접 조정해 보세요.'}]},{tagName:'article',style:{flex:'1','min-width':'220px',padding:'24px',border:'1px solid #ccd3c9'},components:[{type:'text',tagName:'h2',content:'새로운 소식'},{type:'text',tagName:'p',content:'AI에게 이 카드만 수정하도록 지시할 수 있습니다.'}]}]}
 ]}}],styles:[],assets:[]},
 install(editor){
  const blocks=[
   ['section','섹션',{tagName:'section',style:{padding:'40px 24px'},components:[{type:'text',tagName:'h2',content:'새 섹션'}]}],
   ['columns','2열 레이아웃',{tagName:'div',style:{display:'flex',gap:'24px','flex-wrap':'wrap',padding:'24px'},components:[{tagName:'div',style:{flex:'1','min-width':'200px'},components:[{type:'text',content:'왼쪽 내용'}]},{tagName:'div',style:{flex:'1','min-width':'200px'},components:[{type:'text',content:'오른쪽 내용'}]}]}],
   ['text','텍스트',{type:'text',content:'내용을 입력하세요',style:{padding:'12px'}}],
   ['heading','제목',{type:'text',tagName:'h2',content:'새로운 제목'}],
   ['button','버튼',{type:'link',content:'버튼',attributes:{href:'#'},style:{display:'inline-block',padding:'12px 24px','background-color':'#193e37',color:'#ffffff'}}],
   ['image','이미지',{type:'image',style:{'max-width':'100%'}}],
   ['card','카드',{tagName:'article',style:{padding:'24px',border:'1px solid #d7dbd5'},components:[{type:'text',tagName:'h3',content:'카드 제목'},{type:'text',content:'카드 설명'}]}]
  ];
  for(const[id,label,content]of blocks)editor.BlockManager.add(id,{label,content,category:'구성요소'});
 }
};
