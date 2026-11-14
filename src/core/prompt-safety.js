'use strict';
// Credentials never belong in model input, including local model input.
function assertNoSecrets(text) {
  if (/(?:apikey_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{25,}|AQ\.[a-z0-9_-]{25,}|Bearer\s+[a-z0-9_.-]{20,}|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,}|(?<![a-z0-9_-])[a-z0-9_-]{23,}\.[a-z0-9_-]{6,7}\.[a-z0-9_-]{27,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/i.test(String(text))) {
    throw new Error('Model input contains a credential; use the encrypted desktop vault');
  }
}
function assertExternal(text) {
  assertNoSecrets(text);
  if (/[A-Z]:[\\/]Users[\\/]|\/(?:home|Users)\/[^/\s]+/i.test(text)) {
    throw new Error('External worker input contains a private user path; provide portable task context');
  }
}
module.exports = { assertNoSecrets, assertExternal };
