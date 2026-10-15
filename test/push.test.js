import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { createPush, generateVapidKeys } from '../server/services/node-services.js';

function fakeSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: 'https://web.push.apple.com/QAbc123', p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

test('web push request is encrypted (aes128gcm) and VAPID-signed for Apple’s push service', () => {
  const sub = fakeSubscription();
  const keys = generateVapidKeys();
  const details = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify({ title: 'Groceries: 80% used', body: '$410 of $500' }),
    { TTL: 86400, vapidDetails: { subject: 'mailto:owner@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey } },
  );
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
  assert.match(details.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  const jwt = details.headers.Authorization.match(/t=([^,]+)/)[1];
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:owner@example.com');
  assert.ok(details.body.length > 80);
  assert.equal(details.body.includes('Groceries'), false, 'payload is not readable in transit');
});

test('push sender reports delivered, expired (404/410) and failed', async () => {
  const sub = fakeSubscription();
  const keys = generateVapidKeys();
  let mode = 'ok';
  const sender = async () => {
    if (mode === 'ok') return { statusCode: 201 };
    const e = new Error('err'); e.statusCode = mode === 'gone' ? 410 : 500; e.body = 'boom'; throw e;
  };
  const push = createPush({ ...keys, subject: 'mailto:owner@example.com', sender });
  assert.deepEqual(await push.send(sub, { title: 'x' }), { ok: true });
  mode = 'gone';
  assert.deepEqual(await push.send(sub, { title: 'x' }), { ok: false, gone: true });
  mode = 'fail';
  assert.deepEqual(await push.send(sub, { title: 'x' }), { ok: false, error: '500 boom' });
});
