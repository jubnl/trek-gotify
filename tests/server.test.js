'use strict';
// Unit tests for the Gotify notification channel, driven by the SDK's mock host.
// The mock enforces the SAME permission model as TREK, so these prove the hook
// behaves as the host expects: it reads credentials from `config` (never from
// ctx.settings, which is undefined in a userless hook), and it THROWS on failure
// so the host can log and isolate it rather than silently dropping notifications.
const test = require('node:test');
const assert = require('node:assert');
const { createMockHost } = require('trek-plugin-sdk/testing');

const plugin = require('../server/index.js');

const GRANTS = ['hook:notification-channel', 'http:outbound'];
const CONFIG = { serverUrl: 'https://gotify.example.com', appToken: 'TOKEN123' };

const MSG = {
  event: 'trip_invite',
  title: 'Alice invited you to Rome',
  body: 'Alice invited you to the trip "Rome".',
  url: 'https://trek.example.com/trips/1',
  tripName: 'Rome',
};

/** Capture outbound calls; `impl` decides the response. */
function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl ? impl() : { ok: true, status: 200, text: async () => '' };
  };
  return calls;
}

function driver() {
  return createMockHost({ grants: GRANTS }).run(plugin);
}

test('send posts the rendered message to /message with the app token in a header', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'send', MSG, CONFIG);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gotify.example.com/message');
  assert.equal(calls[0].init.method, 'POST');
  // The token goes in a header, never the query string — it must not reach an access log.
  assert.equal(calls[0].init.headers['X-Gotify-Key'], 'TOKEN123');
  assert.ok(!calls[0].url.includes('TOKEN123'));
  assert.equal(calls[0].body.title, 'Alice invited you to Rome');
  assert.equal(calls[0].body.priority, 5);
});

test('send appends the deep link to the body when the event has one', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'send', MSG, CONFIG);
  assert.ok(calls[0].body.message.endsWith('https://trek.example.com/trips/1'));
});

test('send omits the link when the event has none', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'send', { ...MSG, url: undefined }, CONFIG);
  assert.equal(calls[0].body.message, MSG.body);
});

test('a trailing slash on the server URL does not produce a double slash', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'send', MSG, { ...CONFIG, serverUrl: 'https://gotify.example.com///' });
  assert.equal(calls[0].url, 'https://gotify.example.com/message');
});

test('a custom priority is honoured; a nonsense one falls back to the default', async () => {
  let calls = stubFetch();
  await driver().hook('notificationChannel', 'send', MSG, { ...CONFIG, priority: '8' });
  assert.equal(calls[0].body.priority, 8);

  calls = stubFetch();
  await driver().hook('notificationChannel', 'send', MSG, { ...CONFIG, priority: 'banana' });
  assert.equal(calls[0].body.priority, 5);
});

test('an HTTP error THROWS, so the host logs it and other channels still deliver', async () => {
  stubFetch(() => ({ ok: false, status: 401, text: async () => 'invalid token' }));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'send', MSG, CONFIG),
    /Gotify responded 401.*invalid token/,
  );
});

test('missing credentials throw rather than posting somewhere unintended', async () => {
  const calls = stubFetch();
  await assert.rejects(() => driver().hook('notificationChannel', 'send', MSG, {}), /No Gotify server URL/);
  await assert.rejects(
    () => driver().hook('notificationChannel', 'send', MSG, { serverUrl: 'https://gotify.example.com' }),
    /No Gotify application token/,
  );
  assert.equal(calls.length, 0);
});

test('a non-http(s) server URL is refused (no file:/gopher: smuggling)', async () => {
  const calls = stubFetch();
  await assert.rejects(
    () => driver().hook('notificationChannel', 'send', MSG, { ...CONFIG, serverUrl: 'file:///etc/passwd' }),
    /must be http\(s\)/,
  );
  await assert.rejects(
    () => driver().hook('notificationChannel', 'send', MSG, { ...CONFIG, serverUrl: 'not a url' }),
    /Invalid Gotify server URL/,
  );
  assert.equal(calls.length, 0);
});

test('test() posts a fixed message, backing the "Send test" button', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'test', CONFIG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.title, 'TREK');
  assert.match(calls[0].body.message, /working/);
});
