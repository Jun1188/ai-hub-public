// What backed the hard faults in a kernel trace: pagefile, image, mapped file or unknown, per process.
// Reads the text of `xperf -i hf.etl -o hf.txt -a dumper`; recording the trace needs an elevated shell and is the user's step:
//   xperf -on PROC_THREAD+LOADER+HARD_FAULTS      (reproduce the slowdown)      xperf -d hf.etl
// Usage: node scripts/analyze-hardfaults.js hf.txt
'use strict';
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/analyze-hardfaults.js <dumper text file>'); process.exit(2); }
const result = require('../src/core/debugging/hardfault-trace').analyze(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify(result, null, 1));
if (result.missing.length) { console.error('이 덤프에 없는 항목: ' + result.missing.join(', ')); process.exit(1); }
