'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A local submission receipt preserves the author's choice until the authorized review-PR publisher runs.
function localReceipts(root) {
  if (!path.isAbsolute(root)) throw Error('outbox_path_required');
  return {
    async checkAudience(scope) {
      if (scope !== 'members') throw Error('public_disabled');
    },
    async submit(entry, asset) {
      if (entry.scope !== 'members' || !/^[a-f0-9]{32}$/.test(entry.id)) throw Error('invalid_submission');
      if (asset && (!Buffer.isBuffer(asset) || asset.length > 45 * 1024 || hash(asset) !== entry.attachment?.sha256)) throw Error('hub_body_limit');
      if (Boolean(entry.attachment) !== Boolean(asset)) throw Error('invalid_submission');
      const bytes = Buffer.from(JSON.stringify({schemaVersion:1, repository:'your-org/your-site', audience:'private-review-pr',
        entry, attachmentBase64:asset ? asset.toString('base64') : null}) + '\n', 'utf8');
      const receipt = hash(bytes);
      await fs.mkdir(root,{recursive:true, mode:0o700});
      const pending = path.join(root, receipt + '.json');
      if ((await fs.lstat(root)).isSymbolicLink()) throw Error('outbox_path_required');
      const temporary = path.join(root, '.' + randomUUID() + '.tmp');
      const staging = await fs.open(temporary, 'wx', 0o600);
      // Staging and publishing stay on the same local volume; competing identical writes can share one receipt.
      try {
        await staging.writeFile(bytes); await staging.sync(); await staging.close();
        try { await fs.link(temporary,pending); }
        catch (err) {
          if (err.code !== 'EEXIST' || !(await fs.readFile(pending)).equals(bytes)) throw err;
        }
      } finally { await staging.close(); await fs.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
      return '이 PC에 접수했습니다. 비공개 검토 PR 게시 대기 · ' + receipt.slice(0,12);
    }
  };
}
module.exports={localReceipts};
