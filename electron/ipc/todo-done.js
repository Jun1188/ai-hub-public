'use strict';
function register(ctx) {
  const done = () => require('../../src/core/todo-done-view');
  ctx.handle('todoDone:view', options => done().view(options));
  ctx.handle('todoDone:followups', options => done().followups(options));
  ctx.handle('todoDone:plan', payload => done().plan(payload));
  ctx.handle('todoDone:open', payload => done().open(payload, { beforeOpen: () => require('./device-key-delivery').assertFrame() }));
}
module.exports = { register };
