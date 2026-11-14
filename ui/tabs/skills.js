'use strict';
let selectedRepositorySkill = '';
async function refreshSkills() {
  try {
    const targets = await call(window.hub.targets);
    $('skill-targets').replaceChildren(...targets.map(t => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.skillTarget = t.id; input.checked = t.exists;
      label.append(input, document.createTextNode(' ' + t.name + (t.exists ? '' : ' (미감지)'))); return label;
    }));
    await refreshInstalled();
  } catch (e) { toast(e.message, true); }
}
async function refreshInstalled() {
  try {
    const list = await call(window.hub.skillsList), host = $('skill-installed'); host.replaceChildren();
    for (const t of list) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = t.target + ' (' + t.skills.length + '개) — ' + t.skillsDir; details.append(summary); details.open = Boolean(t.skills.length);
      for (const name of t.skills) {
        const row = document.createElement('div'); row.className = 'row';
        const title = document.createElement('span'); title.textContent = name; title.style.flex = '1'; row.append(title);
        for (const action of ['미리보기','등록 제거']) {
          const button = document.createElement('button'); button.className = 'small'; button.textContent = action;
          button.addEventListener('click', async () => {
            try {
              if (action === '미리보기') {
                const text = await call(window.hub.skillsPreview, t.id, name);
                $('skill-preview').textContent = '[' + name + ']\n\n' + text; $('skill-preview').classList.remove('hidden');
              } else {
                if (!confirm(t.target + '의 "' + name + '" 등록을 제거할까요? 저장소 원본은 유지합니다.')) return;
                await call(window.hub.skillsRemove, t.id, name); await refreshInstalled();
              }
            } catch (e) { toast(e.message, true); }
          }); row.append(button);
        }
        details.append(row);
      }
      host.append(details);
    }
    const preview = document.createElement('pre'); preview.id = 'skill-preview'; preview.className = 'output small hidden'; host.append(preview);
  } catch (e) { toast(e.message, true); }
}
window.addEventListener('hub-skill-selected', e => {
  selectedRepositorySkill = e.detail.path;
  $('skill-selected').textContent = '선택: ' + e.detail.label + ' · ' + selectedRepositorySkill;
  toast('등록할 저장소 스킬을 선택했습니다. 대상 AI를 확인하세요.');
});
$('skill-refresh').addEventListener('click', refreshInstalled);
$('skill-browse').addEventListener('click', async () => { try { const p = await call(window.hub.skillsPick); if (p) { $('skill-source').value = p; selectedRepositorySkill = ''; $('skill-selected').textContent = '새 소스를 저장소에 추가한 뒤 등록합니다.'; } } catch (e) { toast(e.message, true); } });
const dz = $('dropzone');
['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => { const file = e.dataTransfer.files[0]; if (!file) return; const p = window.hub.pathForFile(file); if (p) { $('skill-source').value = p; selectedRepositorySkill = ''; $('skill-selected').textContent = '새 소스를 저장소에 추가한 뒤 등록합니다.'; } });
$('skill-source').addEventListener('input', () => { selectedRepositorySkill = ''; $('skill-selected').textContent = '새 소스를 저장소에 추가한 뒤 등록합니다.'; });
async function addRepositorySkill() {
  const source = $('skill-source').value.trim();
  if (!source) throw new Error('추가할 스킬 폴더·SKILL.md·GitHub URL을 입력하세요.');
  const options = {source, category:$('skill-category').value.trim()};
  const {preview} = await call(window.hub.repositorySkillsAdd, options);
  const dialog = document.createElement('dialog'), title = document.createElement('h3'), body = document.createElement('pre');
  title.textContent = '스킬 변경 검토';
  body.className = 'output small';
  body.textContent = [preview.origin,preview.license,...preview.warnings,
    ...preview.overlaps.map(x => '설명 겹침 · ' + x.name + ' · ' + x.words.join(', ')),preview.diff].join('\n\n');
  const buttons = document.createElement('form'); buttons.method = 'dialog';
  for (const [value,label] of [['cancel','취소'],['apply','확인한 파일 추가']]) {
    const button = document.createElement('button'); button.value=value; button.textContent=label; buttons.append(button);
  }
  dialog.append(title,body,buttons); document.body.append(dialog);
  const decision = new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
  dialog.showModal(); const accepted = await decision; dialog.remove();
  if (accepted !== 'apply') return null;
  const result = await call(window.hub.repositorySkillsAdd, {...options,reviewId:preview.reviewId});
  selectedRepositorySkill = result.path; $('skill-selected').textContent = '선택: ' + result.path;
  $('skill-result').textContent = '저장소에 추가했습니다: ' + result.path + '\n원격 게시 전 로컬 변경입니다.';
  await window.HubKnowledgeGraph.refreshSkills();
  return result;
}
$('skill-add-repository').addEventListener('click', async () => { const b = $('skill-add-repository'); b.disabled = true; try { await addRepositorySkill(); } catch (e) { $('skill-result').textContent = e.message; } finally { b.disabled = false; } });
$('skill-update-repository').addEventListener('click', async () => {
  if (!confirm('기존 저장소의 현재 브랜치를 fast-forward 방식으로 갱신할까요? 로컬 변경이 있으면 보류합니다.')) return;
  const b = $('skill-update-repository'); b.disabled = true;
  try { await call(window.hub.repositorySkillsUpdate); await window.HubKnowledgeGraph.refreshSkills(); toast('저장소를 갱신했습니다.'); }
  catch (e) { toast(e.message, true); } finally { b.disabled = false; }
});
$('skill-install').addEventListener('click', async () => {
  const targetIds = [...document.querySelectorAll('[data-skill-target]:checked')].map(c => c.dataset.skillTarget);
  if (!targetIds.length) return toast('등록할 AI를 선택하세요.', true);
  const b = $('skill-install'); b.disabled = true;
  try {
    if (!selectedRepositorySkill && !await addRepositorySkill()) return;
    $('skill-result').textContent = '저장소 스킬을 등록하는 중…';
    const results = await call(window.hub.repositorySkillsInstall, selectedRepositorySkill, targetIds);
    $('skill-result').textContent = results.map(r => r.ok ? '✔ ' + r.skill + ' → ' + r.target : '✖ ' + r.skill + ' → ' + r.target + ': ' + r.error).join('\n');
    await refreshInstalled();
  } catch (e) { $('skill-result').textContent = e.message; } finally { b.disabled = false; }
});
