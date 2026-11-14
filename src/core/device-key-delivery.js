'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./device-key-delivery-crypto');
const { check } = protocol;

const STATE_LIMIT = 512 * 1024;
const MAX_REQUESTS = 64;
const busyProfiles = new Set();

function protectedStorage() {
  const store = require('electron').safeStorage;
  check(store?.isEncryptionAvailable() && store.getSelectedStorageBackend?.() !== 'basic_text', 'device_key_storage_unavailable');
  return store;
}

function checkedPath(file, directory = false, maxBytes = Infinity) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const valid = directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes;
  check(valid && !stat.isSymbolicLink(), 'device_key_storage_unavailable');
  return true;
}

function readRecord(file) {
  return checkedPath(file, false, STATE_LIMIT) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function atomic(file, value) {
  const data = JSON.stringify(value);
  check(Buffer.byteLength(data) <= STATE_LIMIT, 'device_key_storage_unavailable');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function legacyBotHeader(profile) {
  return profile.auth === 'header' && String(profile.authHeader).toLowerCase() === 'authorization';
}

function authMatches(profile, preset) {
  if (preset.id === 'discord' && legacyBotHeader(profile)) return true;
  return profile.auth === preset.auth &&
    (preset.auth !== 'header' || String(profile.authHeader).toLowerCase() === preset.authHeader.toLowerCase());
}

function tokenFromAlias(profile, stored) {
  if (!legacyBotHeader(profile)) return stored;
  const match = /^Bot ([^\s]+)$/i.exec(stored);
  check(match, 'invalid_device_credential');
  return match[1];
}

function fingerprintSecret(key, value) {
  const bytes = Buffer.from(key, 'base64');
  try {
    return crypto.createHmac('sha256', bytes).update(value, 'utf8').digest('hex');
  } finally {
    bytes.fill(0);
  }
}

function validAlias(id) {
  return typeof id === 'string' && /^(?:discord|gemini)-[a-z0-9][a-z0-9-]{0,39}$/.test(id) && id.length <= 48;
}

function create(options = {}) {
  const root = path.resolve(options.root || require('./paths').hubDataDir());
  const directory = path.join(root, 'device-key-delivery.local');
  const profileFile = path.join(directory, 'profile.json');
  const credentials = path.join(root, 'credentials.local');
  const metadataFile = path.join(root, 'api-connections.local.json');
  const storage = options.storage || protectedStorage;
  const now = options.now || Date.now;
  const deviceLabel = options.label || os.hostname();
  const vault = () => options.vault || require('./credential-vault');
  const connections = () => options.connections || require('./api-connections').instance();
  const preset = id => require('./api-connections').PRESETS.find(p => p.id === id);

  // Every call comes from the single-instance Electron main process. Synchronous operations cannot
  // interleave across dialog callbacks. A process crash cannot strand an on-disk application lock.
  function locked(action) {
    checkedPath(root, true);
    checkedPath(directory, true);
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    const resolved = fs.realpathSync(directory);
    check(!busyProfiles.has(resolved), 'device_key_busy');
    busyProfiles.add(resolved);
    try {
      return action();
    } finally {
      busyProfiles.delete(resolved);
    }
  }

  function checkStorePaths() {
    const exists = checkedPath(credentials, true);
    checkedPath(metadataFile);
    checkedPath(metadataFile + '.tmp');
    if (!exists || checkedPath(path.join(credentials, 'key-table.v2.json'))) return;

    // The vault creates its first key table on demand. A missing table is only a fresh
    // vault if no credential still needs it. Never replace a lost table during delivery.
    for (const file of fs.readdirSync(credentials)) {
      if (!/^(?:api-[a-z][a-z0-9-]{0,47}|gemini|lmstudio|llamacpp)\.json$/.test(file)) continue;
      const record = readRecord(path.join(credentials, file));
      check(record?.version === 1 && typeof record.encrypted === 'string', 'device_key_storage_unavailable');
    }
  }

  function recordHash(id) {
    const file = path.join(credentials, 'api-' + id + '.json');
    const value = readRecord(file);
    return value ? protocol.hash(Buffer.from(JSON.stringify(value))) : null;
  }

  function revision(id, profile) {
    return protocol.hash(Buffer.from(JSON.stringify([recordHash(id), profile || null])));
  }

  function save(state) {
    const encrypted = storage().encryptString(JSON.stringify(state)).toString('base64');
    atomic(profileFile, { v: 1, encrypted });
  }

  function load() {
    const osStore = storage();
    const exists = checkedPath(profileFile);
    if (exists) {
      try {
        const record = readRecord(profileFile);
        check(record?.v === 1 && typeof record.encrypted === 'string');
        const state = JSON.parse(osStore.decryptString(Buffer.from(record.encrypted, 'base64')));
        check(state?.v === 1 && state.signing && state.requests && !Array.isArray(state.requests));
        return state;
      } catch {
        throw Error('device_key_storage_unavailable');
      }
    }
    protocol.label(deviceLabel);
    const state = { v: 1, label: deviceLabel, signing: protocol.generate('ed25519'), requests: {} };
    save(state);
    return state;
  }

  function identityOf(state) {
    return { fingerprint: protocol.hash(protocol.bytes(state.signing.public, 44)), deviceLabel: state.label };
  }

  function identity() {
    return locked(() => identityOf(load()));
  }

  function createRequest(provider) {
    protocol.bind(provider);
    return locked(() => {
      const state = load();
      const at = now();
      for (const [id, entry] of Object.entries(state.requests)) {
        if (entry.expiresAt <= at) delete state.requests[id];
      }
      check(Object.keys(state.requests).length < MAX_REQUESTS, 'device_key_request_limit');
      const pair = protocol.generate('x25519');
      const request = protocol.createRequest({ provider, now: at, label: state.label, signing: state.signing, encryption: pair });
      state.nextSequence = (state.nextSequence || 0) + 1;
      state.requests[request.requestId] = {
        private: pair.private, signature: request.signature, expiresAt: request.expiresAt, sequence: state.nextSequence
      };
      save(state);
      return request;
    });
  }

  function inspectRequest(request) {
    return protocol.inspectRequest(request, now());
  }

  function verifyDestination(state, input) {
    const info = inspectRequest(input.request);
    protocol.expected(input.expectedRecipientFingerprint, info.recipientFingerprint);
    check(input.provider === info.provider, 'device_key_provider_mismatch');
    check(info.recipientFingerprint !== identityOf(state).fingerprint, 'device_key_self_delivery');
    return info;
  }

  function eligibleAlias(state, info, profile) {
    const owner = state.aliases?.[profile.id];
    if (!validAlias(profile.id) || !profile.id.startsWith(info.provider + '-') || !profile.keyStored ||
        profile.origin !== info.origin || !authMatches(profile, preset(info.provider)) || owner && owner !== info.recipientFingerprint) return;
    const rec = revision(profile.id, profile);
    const key = vault().statusFor('api-' + profile.id);
    if (!key.stored || key.origin !== info.origin || key.invalid) return;
    return { id: profile.id, bound: owner === info.recipientFingerprint, revision: rec };
  }

  function sourceAliases(input) {
    return locked(() => {
      const state = load();
      const info = verifyDestination(state, input);
      checkStorePaths();
      return connections().list().map(profile => eligibleAlias(state, info, profile)).filter(Boolean);
    });
  }

  function seal(input) {
    return locked(() => {
      const state = load();
      const info = verifyDestination(state, input);
      checkStorePaths();

      function assign(secret) {
        protocol.checkCredential(secret);
        state.assignmentKey ||= crypto.randomBytes(32).toString('base64');
        state.assignedKeys ||= {};
        const tag = fingerprintSecret(state.assignmentKey, secret);
        const owner = state.assignedKeys[tag];
        check(!owner || owner === info.recipientFingerprint, 'device_key_assigned_elsewhere');

        // Compare only this provider's same-origin live key in its vault callback. A pasted or
        // relabelled primary key must never escape through the typed-key or saved-alias path.
        recordHash(info.provider);
        const primaryId = 'api-' + info.provider;
        const primary = vault().statusFor(primaryId);
        if (primary.stored) {
          check(!primary.invalid && primary.origin === info.origin, 'device_key_target_conflict');
          vault().use(primaryId, info.origin, active => {
            const token = info.provider === 'discord' ? active.replace(/^Bot /i, '') : active;
            check(fingerprintSecret(state.assignmentKey, token) !== tag, 'device_key_primary_forbidden');
          });
        }

        const envelope = protocol.seal({ ...input, signing: state.signing, senderLabel: state.label, now: now(), secret });
        state.assignedKeys[tag] = info.recipientFingerprint;
        if (input.sourceAlias) {
          state.aliases ||= {};
          state.aliases[input.sourceAlias] = info.recipientFingerprint;
        }
        save(state);
        return envelope;
      }

      if (input.sourceAlias === undefined) return assign(input.secret);
      check(input.secret === undefined && validAlias(input.sourceAlias), 'invalid_device_key_source_alias');
      const profile = connections().list().find(p => p.id === input.sourceAlias);
      const available = profile && eligibleAlias(state, info, profile);
      check(available, 'invalid_device_key_source_alias');
      check(input.expectedSourceRevision === available.revision, 'device_key_source_changed');
      check(available.bound || input.confirmBindAlias === true, 'device_key_alias_binding_required');
      return connections().withCredential(available.id, info.origin, stored => assign(tokenFromAlias(profile, stored)));
    });
  }

  function target(info) {
    checkStorePaths();
    // Check that the canonical credential is local before the vault reads its status or contents.
    recordHash(info.provider);
    const record = vault().statusFor('api-' + info.provider);
    const profile = connections().list().find(p => p.id === info.provider);
    const settings = preset(info.provider);
    check(settings && settings.origin === info.origin, 'device_key_target_conflict');
    check(!record.stored || record.origin === info.origin && !record.invalid, 'device_key_target_conflict');
    if (profile) check(profile.origin === info.origin && authMatches(profile, settings), 'device_key_target_conflict');
    return {
      profile, record, revision: revision(info.provider, profile),
      settings: profile || { ...settings, maxCallsPerRun: 8, allowWrite: false }
    };
  }

  function context(envelope, state) {
    const info = protocol.inspectEnvelope(envelope, now());
    check(info.recipientFingerprint === identityOf(state).fingerprint, 'device_key_wrong_recipient');
    const entry = state.requests[info.requestId];
    check(entry && entry.signature === envelope.request.signature, 'device_key_request_unknown');
    const stamp = protocol.hash(protocol.bytes(envelope.signature, 64));
    check(!entry.stamp || entry.stamp === stamp, 'device_key_request_replaced');
    const latest = state.accepted?.[info.provider] || 0;
    check(entry.done || entry.sequence > latest || entry.stamp && entry.sequence === latest, 'device_key_request_superseded');
    return { info, entry, stamp };
  }

  function inspectEnvelope(envelope) {
    return locked(() => {
      const { info, entry } = context(envelope, load());
      const t = target(info);
      return { ...info, alreadyStored: t.record.stored, alreadyReceived: entry.done === true, targetRevision: t.revision };
    });
  }

  function receive({ envelope, expectedSenderFingerprint, expectedRecipientFingerprint, provider, confirmReplace, expectedTargetRevision }) {
    return locked(() => {
      const state = load();
      const { info, entry, stamp } = context(envelope, state);
      protocol.expected(expectedSenderFingerprint, info.senderFingerprint);
      protocol.expected(expectedRecipientFingerprint, info.recipientFingerprint);
      check(provider === info.provider, 'device_key_provider_mismatch');
      const t = target(info);
      const result = { stored: t.record.stored, provider, reference: info.reference, alreadyReceived: entry.done === true };
      if (entry.done) return result;
      check(expectedTargetRevision === t.revision, 'device_key_target_changed');
      check(!t.record.stored || confirmReplace === true, 'device_key_replacement_required');

      const plain = protocol.open(envelope, entry.private);
      try {
        const token = plain.toString('utf8');
        protocol.checkCredential(token);
        const encoded = Buffer.from(token);
        try {
          check(plain.equals(encoded), 'invalid_device_credential');
        } finally {
          encoded.fill(0);
        }
        const secret = legacyBotHeader(t.settings) ? 'Bot ' + token : token;
        check(secret.length <= 8192, 'invalid_device_credential');
        let alreadyApplied = false;
        if (entry.stamp && t.record.stored) {
          // A crash after the vault write may precede the metadata and receipt writes. Retry
          // only the missing work. A later rotation must survive a retry of the old envelope.
          alreadyApplied = vault().use('api-' + provider, info.origin, stored => stored === secret);
          if (!alreadyApplied) check(entry.before === recordHash(provider), 'device_key_target_changed');
        } else if (entry.stamp) {
          // Unlink after a crash is indistinguishable from a failed initial vault write.
          // Require a fresh request instead of reviving a removed key.
          throw Error('device_key_target_changed');
        }
        if (!entry.stamp) {
          entry.stamp = stamp;
          entry.before = recordHash(provider);
          state.accepted ||= {};
          state.accepted[provider] = entry.sequence;
          save(state);
        }
        if (!alreadyApplied) connections().save(t.settings, secret);
        else if (!t.profile) connections().save(t.settings);
        state.requests[info.requestId] = { signature: entry.signature, expiresAt: entry.expiresAt, stamp, done: true };
        save(state);
        return { ...result, stored: true };
      } finally {
        plain.fill(0);
      }
    });
  }

  return { identity, createRequest, inspectRequest, sourceAliases, seal, inspectEnvelope, receive };
}

let singleton;
module.exports = { create, instance: () => singleton || (singleton = create()) };
