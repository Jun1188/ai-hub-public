'use strict';

const crypto = require('node:crypto');

const VERSION = 1;
const PURPOSE = 'ai-hub-device-api-key';
const TTL = 48 * 3600000;
const SUITE = 'X25519-HKDF-SHA256-AES-256-GCM-Ed25519';
const origins = Object.freeze({ discord: 'https://discord.com', gemini: 'https://generativelanguage.googleapis.com' });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const encode = bytes => bytes.toString('base64url');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const buffer = value => Buffer.from(JSON.stringify(value), 'utf8');
const publicDer = key => encode(key.export({ format: 'der', type: 'spki' }));

function check(ok, reason = 'invalid_device_key_file') {
  if (!ok) throw Error(reason);
}

function exact(object, fields) {
  check(object && typeof object === 'object' && !Array.isArray(object));
  check(Object.keys(object).length === fields.length && fields.every(key => Object.hasOwn(object, key)));
}

function bytes(value, min, max = min) {
  check(typeof value === 'string' && value.length <= Math.ceil(max * 4 / 3) && /^[a-zA-Z\d_-]+$/.test(value));
  const result = Buffer.from(value, 'base64url');
  check(result.length >= min && result.length <= max && encode(result) === value);
  return result;
}

function publicKey(encoded, type) {
  const key = crypto.createPublicKey({ format: 'der', type: 'spki', key: bytes(encoded, 44) });
  check(key.asymmetricKeyType === type && publicDer(key) === encoded);
  return key;
}

function privateKey(encoded, type) {
  const raw = bytes(encoded, 48);
  try {
    const key = crypto.createPrivateKey({ format: 'der', type: 'pkcs8', key: raw });
    check(key.asymmetricKeyType === type);
    return key;
  } finally {
    raw.fill(0);
  }
}

function generate(type) {
  const keys = crypto.generateKeyPairSync(type);
  const raw = keys.privateKey.export({ format: 'der', type: 'pkcs8' });
  try {
    return { private: encode(raw), public: publicDer(keys.publicKey) };
  } finally {
    raw.fill(0);
  }
}

function expected(value, actual) {
  check(typeof value === 'string' && /^[A-F0-9\s:-]{64,128}$/i.test(value) &&
    value.replace(/[\s:-]/g, '').toUpperCase() === actual, 'device_fingerprint_confirmation_failed');
}

function label(value) {
  check(typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u.test(value), 'invalid_device_label');
}

function checkCredential(secret) {
  check(typeof secret === 'string' && secret.length > 0 && !/[^\x21-\x7e]/.test(secret) &&
    Buffer.byteLength(secret) <= 8192, 'invalid_device_credential');
}

function bind(provider) {
  check(typeof provider === 'string' && Object.hasOwn(origins, provider), 'unsupported_device_key_provider');
  return { provider, origin: origins[provider], reference: 'credential:api-' + provider };
}

// Explicit ordered fields give the request signature, HKDF, GCM AAD and envelope signature
// the same wire representation on both PCs regardless of a JSON file's property order.
function canonicalRequest(r) {
  return [
    VERSION, PURPOSE, 'request', r.requestId, r.provider, r.origin, r.reference, r.createdAt,
    r.expiresAt, r.recipientLabel, r.recipientSigningKey, r.recipientEncryptionKey
  ];
}

function createRequest({ provider, label, signing, encryption, now }) {
  const request = {
    version: VERSION, purpose: PURPOSE, type: 'request', requestId: crypto.randomUUID(), ...bind(provider),
    createdAt: now, expiresAt: now + TTL, recipientLabel: label,
    recipientSigningKey: signing.public, recipientEncryptionKey: encryption.public
  };
  request.signature = encode(crypto.sign(null, buffer(canonicalRequest(request)), privateKey(signing.private, 'ed25519')));
  return request;
}

function inspectRequest(r, now) {
  exact(r, [
    'version', 'purpose', 'type', 'requestId', 'provider', 'origin', 'reference', 'createdAt', 'expiresAt',
    'recipientLabel', 'recipientSigningKey', 'recipientEncryptionKey', 'signature'
  ]);
  check(r.version === VERSION && r.purpose === PURPOSE && r.type === 'request');
  check(typeof r.requestId === 'string' && uuid.test(r.requestId));
  const destination = bind(r.provider);
  check(r.origin === destination.origin && r.reference === destination.reference);
  check(Number.isSafeInteger(r.createdAt) && r.createdAt >= 0 && Number.isSafeInteger(r.expiresAt) &&
    r.expiresAt - r.createdAt === TTL && r.createdAt <= now + 60000 && r.expiresAt > now, 'device_key_request_expired_or_invalid');
  label(r.recipientLabel);
  const signing = publicKey(r.recipientSigningKey, 'ed25519');
  publicKey(r.recipientEncryptionKey, 'x25519');
  check(crypto.verify(null, buffer(canonicalRequest(r)), signing, bytes(r.signature, 64)), 'device_key_signature_invalid');
  return {
    ...destination, recipientFingerprint: hash(bytes(r.recipientSigningKey, 44)), recipientLabel: r.recipientLabel,
    requestId: r.requestId, expiresAt: r.expiresAt
  };
}

function header(e) {
  return [
    VERSION, PURPOSE, 'envelope', SUITE, canonicalRequest(e.request), e.request.signature,
    e.senderLabel, e.senderSigningKey, e.ephemeral, e.iv
  ];
}

function signatureInput(e) {
  return buffer([header(e), e.ciphertext, e.tag]);
}

function sharedKey(local, remote, envelope) {
  const shared = crypto.diffieHellman({ privateKey: local, publicKey: remote });
  try {
    return Buffer.from(crypto.hkdfSync('sha256', shared, bytes(envelope.request.signature, 64), buffer(header(envelope)), 32));
  } finally {
    shared.fill(0);
  }
}

function seal({ request, signing, senderLabel, provider, secret, expectedRecipientFingerprint, now }) {
  const info = inspectRequest(request, now);
  expected(expectedRecipientFingerprint, info.recipientFingerprint);
  check(provider === info.provider, 'device_key_provider_mismatch');
  label(senderLabel);
  check(request.recipientSigningKey !== signing.public, 'device_key_self_delivery');
  checkCredential(secret);
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const envelope = {
    version: VERSION, purpose: PURPOSE, type: 'envelope', suite: SUITE, request, senderLabel,
    senderSigningKey: signing.public, ephemeral: publicDer(ephemeral.publicKey), iv: encode(crypto.randomBytes(12))
  };
  const key = sharedKey(ephemeral.privateKey, publicKey(request.recipientEncryptionKey, 'x25519'), envelope);
  const plain = Buffer.from(secret);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, bytes(envelope.iv, 12));
    cipher.setAAD(buffer(header(envelope)));
    envelope.ciphertext = encode(Buffer.concat([cipher.update(plain), cipher.final()]));
    envelope.tag = encode(cipher.getAuthTag());
    envelope.signature = encode(crypto.sign(null, signatureInput(envelope), privateKey(signing.private, 'ed25519')));
    return envelope;
  } finally {
    plain.fill(0);
    key.fill(0);
  }
}

function inspectEnvelope(e, now) {
  exact(e, ['version', 'purpose', 'type', 'suite', 'request', 'senderLabel', 'senderSigningKey', 'ephemeral', 'iv', 'ciphertext', 'tag', 'signature']);
  check(e.version === VERSION && e.type === 'envelope' && e.purpose === PURPOSE && e.suite === SUITE);
  const info = inspectRequest(e.request, now);
  label(e.senderLabel);
  check(e.senderSigningKey !== e.request.recipientSigningKey, 'device_key_self_delivery');
  publicKey(e.ephemeral, 'x25519');
  bytes(e.iv, 12);
  bytes(e.tag, 16);
  bytes(e.ciphertext, 1, 8192);
  const signer = publicKey(e.senderSigningKey, 'ed25519');
  check(crypto.verify(null, signatureInput(e), signer, bytes(e.signature, 64)), 'device_key_signature_invalid');
  return { ...info, senderFingerprint: hash(bytes(e.senderSigningKey, 44)), senderLabel: e.senderLabel };
}

function open(envelope, receiverPrivate) {
  const key = sharedKey(privateKey(receiverPrivate, 'x25519'), publicKey(envelope.ephemeral, 'x25519'), envelope);
  let first;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes(envelope.iv, 12));
    decipher.setAAD(buffer(header(envelope)));
    decipher.setAuthTag(bytes(envelope.tag, 16));
    first = decipher.update(bytes(envelope.ciphertext, 1, 8192));
    return Buffer.concat([first, decipher.final()]);
  } finally {
    first?.fill(0);
    key.fill(0);
  }
}

module.exports = { generate, createRequest, inspectRequest, inspectEnvelope, seal, open, hash, bytes, expected, check, label, bind, checkCredential };
