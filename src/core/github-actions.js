'use strict';
// GitHub Actions(등록한 GitHub 연결): 워크플로·최근 실행·실행 하나의 작업(job)과 workflow_dispatch.
// 경로는 /repos/{owner}/{repo}/actions/... 만 만들고, owner·repo·워크플로·ref·입력은 여기서 검증한다.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function repo(v) {
  const [owner, name, extra] = String(v || '').split('/');
  if (extra !== undefined || !OWNER.test(owner || '') || !REPO.test(name || '') || /^\.\.?$/.test(name) || name.endsWith('.git'))
    throw Error('저장소는 owner/repo 형식입니다(영문·숫자·-·_·.).');
  return { owner, repo: name };
}
function workflow(v) {
  const s = String(v || '');
  if (/^\d{1,20}$/.test(s) || /^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(s)) return s;
  throw Error('워크플로는 파일 이름(예: deploy.yml) 또는 숫자 ID입니다.');
}
function ref(v) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(s) || /^[/-]|\/$|\.\.|\/\/|\.lock$/.test(s)) throw Error('ref는 브랜치·태그 이름입니다(예: main).');
  return s;
}
function runId(v) { if (!/^\d{1,20}$/.test(String(v || ''))) throw Error('실행 ID는 숫자입니다(/actions runs에서 확인).'); return String(v); }

const base = (r) => `/repos/${r.owner}/${r.repo}/actions`;
const routes = {
  workflows: (r) => `${base(r)}/workflows?per_page=100`,
  runs: (r, wf, n) => `${base(r)}${wf ? `/workflows/${wf}` : ''}/runs?per_page=${n}`,
  run: (r, id) => `${base(r)}/runs/${id}`,
  jobs: (r, id) => `${base(r)}/runs/${id}/jobs?per_page=50`,
  dispatch: (r, wf) => `${base(r)}/workflows/${wf}/dispatches`,
};

const runOf = (x) => ({ id: x.id, name: x.name, number: x.run_number, status: x.status, conclusion: x.conclusion, event: x.event,
  branch: x.head_branch, created: x.created_at, url: x.html_url });

/** verb: workflows | runs | run | dispatch. http(method, route, body?) → 응답 본문(오류 상태는 던진다). */
async function run(verb, a, http) {
  const r = a.repo;
  if (verb === 'workflows') {
    const b = await http('GET', routes.workflows(r));
    return { repo: `${r.owner}/${r.repo}`, total: b.total_count, workflows: (b.workflows || []).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })) };
  }
  if (verb === 'runs') {
    const b = await http('GET', routes.runs(r, a.workflow, a.limit));
    return { repo: `${r.owner}/${r.repo}`, ...(a.workflow ? { workflow: a.workflow } : {}), runs: (b.workflow_runs || []).map(runOf) };
  }
  if (verb === 'run') {
    const one = await http('GET', routes.run(r, a.run));
    const jobs = await http('GET', routes.jobs(r, a.run));
    return { repo: `${r.owner}/${r.repo}`, run: runOf(one), jobs: (jobs.jobs || []).map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
      started: j.started_at, completed: j.completed_at, failedSteps: (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name) })) };
  }
  if (verb === 'dispatch') {
    // 성공 응답은 204(본문 없음)이고 실행 ID를 주지 않는다 — /actions runs로 확인한다.
    await http('POST', routes.dispatch(r, a.workflow), { ref: a.ref, inputs: a.inputs });
    return { dispatched: true, repo: `${r.owner}/${r.repo}`, workflow: a.workflow, ref: a.ref, inputs: Object.keys(a.inputs), next: `/actions runs ${r.owner}/${r.repo} ${a.workflow}` };
  }
  throw Error('알 수 없는 Actions 명령입니다.');
}

module.exports = { run, routes, repo, workflow, ref, runId };
