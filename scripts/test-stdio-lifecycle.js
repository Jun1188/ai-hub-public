'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {guard}=require('../electron/stdio-lifecycle');const stdout=new EventEmitter(),stderr=new EventEmitter();
guard([stdout,stderr]);guard([stdout]);
assert.equal(stdout.listenerCount('error'),1);
assert.doesNotThrow(()=>stdout.emit('error',Object.assign(Error('broken pipe'),{code:'EPIPE'})));
assert.doesNotThrow(()=>stderr.emit('error',Object.assign(Error('broken pipe'),{code:'EPIPE'})));
assert.throws(()=>stdout.emit('error',Object.assign(Error('real failure'),{code:'EIO'})),/real failure/);
console.log('GUI stdio: closed stdout/stderr pipes tolerated, other errors preserved; 4 checks passed');
