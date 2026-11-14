'use strict';

// Opt-in release CI observation. Normal launches do not enable this path.
function attach({app,window,config}) {
  const target = process.env.AIHUB_PUBLIC_VALIDATION;
  if (!target) return;
  const fs = require('node:fs');
  const path = require('node:path');
  if (!path.isAbsolute(target)) throw new Error('Validation report requires an absolute path');
  const errors=[];
  window.webContents.on('console-message',(...args)=>{
    const item=typeof args[0]==='object'&&'level' in args[0] ? args[0] : {level:args[1],message:args[2]};
    if(item.level===3||item.level==='error') errors.push(String(item.message).slice(0,300));
  });
  window.webContents.once('did-finish-load',()=>setTimeout(async()=>{
    let report;
    try {
      const cfg=config.load();
      const ui=await window.webContents.executeJavaScript(`({title:document.title,publicBanner:document.body.innerText.includes('공개 경량판'),visibleTabs:[...document.querySelectorAll('#tabs button[data-tab]')].filter(el=>!el.hidden).map(el=>el.dataset.tab),queueTabs:['done','followup'].every(id=>document.querySelectorAll('#tabs button[data-tab="'+id+'"]').length===1),dashboardReady:document.body.innerText.includes('독립 프로필')})`);
      const screenshot=await window.webContents.capturePage();
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target.replace(/\.json$/i,'')+'.png',screenshot.toPNG());
      report={version:app.getVersion(),ui,errors,defaults:{mcp:cfg.hub.enabled,share:cfg.share.enabled,update:cfg.update.autoCheck,profile:cfg.hub.profile},dataDirectoryName:path.basename(require('../src/core/paths').hubDataDir()),screenshotSize:screenshot.getSize(),environment:process.env.GITHUB_ACTIONS==='true'?'fresh-github-windows-runner':'local-windows-isolated-profile',limits:'Installed-app launch/paint observation; interactive use, real providers and physical-device behavior are separate.'};
      report.pass=ui.publicBanner&&ui.dashboardReady&&ui.queueTabs&&ui.title==='AI Hub Lite'&&errors.length===0&&cfg.hub.enabled===false&&cfg.share.enabled===false;
    } catch(error) {report={pass:false,error:error.message};}
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify(report,null,2));
    app.exit(report.pass?0:1);
  },2000));
}
module.exports={attach};
