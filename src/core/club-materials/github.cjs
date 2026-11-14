'use strict';
const {sha}=require('./files.cjs');
const repo='your-org/your-site', base='main';
const status=(error,code)=>error?.status===code;
function rest(token,fetchApi=fetch){
  if(!token)throw Error('github_not_configured');
  return async(method,path,body)=>{
    const response=await fetchApi('https://api.github.com/repos/'+repo+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'club-material-submissions',
        ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok)throw Object.assign(Error('github_request_failed'),{status:response.status});
    return response.json();
  };
}
function github(api){
  async function optional(path){
    try{return await api('GET',path);}catch(e){if(status(e,404))return null;throw e;}
  }
  async function recordAt(directory,ref){
    const content=await optional('/contents/'+directory+'/entry.json?ref='+ref);
    if(!content)return null;
    if(content.type!=='file'||content.encoding!=='base64'||content.size>16384)throw Error('invalid_stored_record');
    const bytes=Buffer.from(content.content,'base64');
    return {text:bytes.toString('utf8'),sha:content.sha,entry:JSON.parse(bytes)};
  }
  async function treeFor(parent,dir,old,entry,bytes,assetBytes){
    const tree=[{path:dir+'/entry.json',type:'blob',mode:'100644',content:bytes.toString('utf8')}];
    const previous=old?.entry?.attachment?.name;
    if(previous&&!['file.png','file.txt','file.pdf'].includes(previous))throw Error('invalid_stored_record');
    if(previous&&previous!==entry.attachment?.name)tree.push({path:dir+'/'+previous,mode:'100644',type:'blob',sha:null});
    if(entry.attachment){
      if(!Buffer.isBuffer(assetBytes)||sha(assetBytes)!==entry.attachment.sha256)throw Error('attachment_digest');
      const blob=await api('POST','/git/blobs',{content:assetBytes.toString('base64'),encoding:'base64'});
      tree.push({path:dir+'/'+entry.attachment.name,mode:'100644',type:'blob',sha:blob.sha});
    }
    return (await api('POST','/git/trees',{base_tree:parent.tree.sha,tree})).sha;
  }
  async function existingPr(branch){
    const pulls=await api('GET','/pulls?state=all&base='+base+'&head='+encodeURIComponent('Jun1188:'+branch));
    const pr=pulls.find(p=>p.head?.repo?.full_name?.toLowerCase()===repo.toLowerCase()&&p.head?.ref===branch&&p.base?.ref===base);
    if(!pr)return null;
    if(!Number.isSafeInteger(pr.number)||pr.number<1)throw Error('invalid_pr');
    if(pr.state==='closed'&&!pr.merged_at)throw Error('closed');
    return '검토 기록 https://github.com/'+repo+'/pull/'+pr.number;
  }
  return {
    async checkAudience(scope){
      const r=await api('GET','');
      if(r.full_name?.toLowerCase()!==repo.toLowerCase()||r.default_branch!==base)throw Error('unexpected_repository');
      if(scope==='members'&&r.private!==true)throw Error('private_required');
    },
    async submit(entry,assetBytes){
      if(!/^[a-f0-9]{32}$/.test(entry.id)||!['public','members'].includes(entry.scope))throw Error('invalid_entry');
      const dir=(entry.scope==='public'?'site/materials/entries/':'private-materials/entries/')+entry.id;
      const bytes=Buffer.from(JSON.stringify(entry,null,2)+'\n');
      const main=(await api('GET','/git/ref/heads/'+base)).object.sha;
      if(entry.scope==='members'&&await recordAt('site/materials/entries/'+entry.id,main))throw Error('public_exists');
      const old=await recordAt(dir,main);
      if(old?.text===bytes.toString('utf8'))return '이 내용은 이미 기준 브랜치에 반영됐습니다.';
      const branch='materials/'+entry.id+'-'+sha(Buffer.concat([Buffer.from(old?.sha||'new'),bytes])).slice(0,24);
      const refPath='/git/ref/heads/'+branch;
      const tracked=await existingPr(branch);
      let ref=await optional(refPath);
      if(!ref){
        if(tracked)throw Error('branch_unavailable');
        const parent=await api('GET','/git/commits/'+main);
        const tree=await treeFor(parent,dir,old,entry,bytes,assetBytes);
        const commit=await api('POST','/git/commits',{message:'Submit club material '+entry.id,tree,parents:[main]});
        try{await api('POST','/git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});}
        catch(e){if(!status(e,422)&&!status(e,409))throw e;}
        ref=await optional(refPath);
      }
      if(!ref?.object?.sha)throw Error('branch_unavailable');
      const head=await api('GET','/git/commits/'+ref.object.sha);
      if(head.parents?.length!==1)throw Error('unexpected_branch');
      const parentSha=head.parents[0].sha;
      if(parentSha!==main){
        const ancestry=await api('GET','/compare/'+parentSha+'...'+main);
        if(!['ahead','identical'].includes(ancestry.status))throw Error('unexpected_branch');
      }
      const prior=await recordAt(dir,parentSha);
      if((old?.sha||null)!==(prior?.sha||null))throw Error('stale_submission');
      const parent=await api('GET','/git/commits/'+parentSha);
      if(head.tree?.sha!==await treeFor(parent,dir,prior,entry,bytes,assetBytes))throw Error('unexpected_branch');
      const known=tracked||await existingPr(branch);
      if(known)return known;
      try{await api('POST','/pulls',{base,head:branch,draft:true,title:'소모임 자료 검토 '+entry.id,
        body:'제출자가 선택한 범위와 첨부물을 검토하세요. 공개 사이트는 승인된 site/materials 자료만 표시합니다.'});}
      catch(e){if(!status(e,422))throw e;}
      const created=await existingPr(branch);
      if(!created)throw Error('draft_unavailable');
      return created;
    }
  };
}
module.exports={repo,rest,github};
