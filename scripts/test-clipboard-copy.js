'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ui = path.join(__dirname,'../ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const script = file => fs.readFileSync(path.join(ui, 'tabs', file), 'utf8');
const widgets = new Map();
function widget(id) {
  if (!widgets.has(id)) widgets.set(id, {
    callbacks: {}, textContent: '', dataset: {},
    addEventListener(event, fn) { this.callbacks[event] = fn; },
    click() { return this.callbacks.click(); }
  });
  return widgets.get(id);
}
const buttons = ['ext-hub-mcp-url', 'ext-hub-health-url'].map(id => {
  assert(html.includes('id="' + id + '"') && html.includes('data-copy="' + id + '"'));
  const button = widget(id + '-button');
  button.dataset.copy = id;
  return button;
});
let deny = false, reads = [], notices = [];
const unhandled = [];
process.on('unhandledRejection', err => unhandled.push(err.name));
const api = {
  status: async () => ({hub:{url:'http://127.0.0.1:50431/mcp',running:true,requireAuth:true}}),
  localUrlList: async () => [], dsList: async () => []
};
const context = vm.createContext({
  window:{hub:api}, $:widget, URL, call:fn=>fn(), toast:(msg,err)=>notices.push(!!err),
  document:{querySelector:sel=>widget(sel), querySelectorAll:sel=>sel==='[data-copy]'?buttons:[]},
  navigator:{clipboard:{async writeText(value){if(deny)throw Error('Denied'); reads.push(value);}}}
});
(async () => {
  vm.runInContext(script('mcp.js'), context);
  vm.runInContext(script('external-connections.js'), context);
  widget('#tabs button[data-tab="settings"]').click();
  await new Promise(setImmediate);
  for (const button of buttons) await button.click();
  assert.deepEqual(reads,['http://127.0.0.1:50431/mcp','http://127.0.0.1:50431/health']);
  assert.deepEqual(notices,[false,false]);
  deny = true; notices = [];
  await buttons[0].click();
  await new Promise(setImmediate);
  const deniedReported = notices.length===1 && notices[0] && !unhandled.length;
  console.log(JSON.stringify({renderedBothConfiguredUrls:true,successCopiesUrlOnly:true,
    clipboardDenialReportedCorrectly:!!deniedReported,unhandledRejection:!!unhandled.length}));
  assert(deniedReported);
})().catch(e=>{console.error(e.message);process.exitCode=1});
