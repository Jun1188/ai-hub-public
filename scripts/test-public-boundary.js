'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const appRoot = path.resolve(__dirname,'..');
const page=fs.readFileSync(path.join(appRoot,'ui/index.html'),'utf8');
const scripts=[...page.matchAll(/<script\s+src="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(scripts).size,scripts.length,'Each page script must load once');
for(const name of ['tabs/followup-queue.js','tabs/done-queue.js']) assert.equal(scripts.filter(src=>src===name).length,1);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'aihub-public-boundary-'));
const home = path.join(fixture,'home'), roaming = path.join(fixture,'roaming');
fs.mkdirSync(path.join(roaming,'ai-hub'),{recursive:true});
fs.mkdirSync(path.join(home,'Documents','Codex','codex-shared-context'),{recursive:true});
fs.writeFileSync(path.join(roaming,'ai-hub','config.local.json'), JSON.stringify({hub:{authToken:'SYNTHETIC-PRIVATE-TOKEN',profile:'full'},share:{enabled:true}}));
fs.mkdirSync(home,{recursive:true});
fs.writeFileSync(path.join(home,'.claude.json'), JSON.stringify({mcpServers:{private:{url:'http://example.invalid/mcp'}}}));
const privateBefore = fs.readFileSync(path.join(roaming,'ai-hub','config.local.json'));
const program = `
 (async()=>{
 const paths = require('./src/core/paths');
 const config = require('./src/core/config');
 const publicProfile = require('./src/core/public-profile');
 const cfg = config.load();
 const queues=require('./src/core/todo-done-view');
 let queueInvocations=0;
 const queueErrors=[];
 for(const action of ['view','followups']) {
   try {await queues[action]({}, {invoke:async()=>{queueInvocations++;throw Error('must not run')}});queueErrors.push(false);}
   catch(error){queueErrors.push(error.message.includes('저장소를 직접 지정'));}
 }
 process.stdout.write(JSON.stringify({
   data: paths.hubDataDir(), browser: paths.chromiumProfileDir(),
   targets: paths.detectTargets(), mcpOnly: paths.detectMcpOnlyTargets(),
   enabled: cfg.hub.enabled, profile: cfg.hub.profile, share: cfg.share.enabled,
   check: cfg.update.autoCheck, autoStart: cfg.hub.autoStart,
   preparation: cfg.localRuntimes.automaticPreparation,
   tokenWasReused: cfg.hub.authToken === 'SYNTHETIC-PRIVATE-TOKEN',
   bootstrap: require('./src/core/shared-agent-context').manifest(),
   sharedRepo: require('./src/core/shared-repo-memory').repoRoot(),
   privateRoutes: ['registrar:register','conn:register','share:syncNow','share:pickDir','update:sync','update:enroll','profile:repositoryAutoUpdateSet'].map(name=>publicProfile.allowed(name)),
   localRoutes: ['status','mem:save','mem:list','herdr:status','profile:features'].map(name=>publicProfile.allowed(name)),
   queueInvocations,queueErrors
 }));
 })().catch(error=>{console.error(error);process.exitCode=1;});
`;
const observation = JSON.parse(cp.execFileSync(process.execPath,['-e',program],{cwd:appRoot,env:{...process.env,USERPROFILE:home,HOME:home,APPDATA:roaming},encoding:'utf8'}));
assert.equal(observation.data,path.join(roaming,'ai-hub-public-lite'));
assert.equal(observation.browser,path.join(roaming,'ai-hub-public-lite','browser'));
assert.deepEqual(observation.targets,[]);
assert.deepEqual(observation.mcpOnly,[]);
for(const key of ['enabled','share','check','autoStart','preparation','tokenWasReused']) assert.equal(observation[key],false,key);
assert.equal(observation.profile,'lite');
assert.equal(observation.bootstrap,null);
assert.equal(observation.sharedRepo,null);
assert(observation.privateRoutes.every(value=>value===false));
assert(observation.localRoutes.every(value=>value===true));
assert.equal(observation.queueInvocations,0);
assert.deepEqual(observation.queueErrors,[true,true]);
assert.deepEqual(fs.readFileSync(path.join(roaming,'ai-hub','config.local.json')),privateBefore);
assert(fs.existsSync(path.join(home,'.claude.json')));
console.log(JSON.stringify({pass:true,checks:['private-profile-isolation','no-account-discovery','no-internal-repo-autodiscovery','network-and-sync-defaults-off','no-private-credential-reuse','private-deployment-routes-blocked','local-memory-and-HerdR-routes-retained','private-profile-bytes-preserved','both-queues-require-explicit-repository'],fixture,limits:'Synthetic offline boundary regression; no GUI, installed-app, fresh-Windows or real-provider claim.'},null,2));
