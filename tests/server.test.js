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

// ---------------------------------------------------------------------------
// Network-failure surfacing (issue #1). The raw strings below are copied
// VERBATIM from TREK's egress guard (plugin-host-entry.ts) — they are the only
// signal TREK gives a plugin, so the tests pin the exact shapes the host emits:
// allowlist misses arrive as a bare Error from the wrapped fetch, while the
// private-address block throws inside Socket.connect and reaches us wrapped in
// undici's `TypeError: fetch failed` with the real error on `cause`.
// ---------------------------------------------------------------------------

/** undici-shaped rejection: TypeError('fetch failed') carrying `cause`. */
function fetchFailed(cause) {
  return () => { throw new TypeError('fetch failed', { cause }); };
}

test('a blocked private IP surfaces the guard message and the operator fix', async () => {
  stubFetch(fetchFailed(new Error('egress: 192.168.1.10 is a blocked address')));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /blocked address/.test(err.message) && /TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on/.test(err.message),
  );
});

test('a hostname resolving to a private IP surfaces the same operator fix', async () => {
  stubFetch(fetchFailed(new Error('egress: gotify.lan resolves to a blocked address (10.0.0.5)')));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /resolves to a blocked address/.test(err.message) && /TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on/.test(err.message),
  );
});

test('an allowlist miss (bare, unwrapped) points the admin at Allowed hosts', async () => {
  // TREK's fetch wrapper rejects BEFORE undici runs, so there is no `cause` here.
  stubFetch(() => { throw new Error("egress: gotify.example.com is not in the plugin's declared hosts"); });
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /declared hosts/.test(err.message) && /Allowed hosts/.test(err.message),
  );
});

test('a DNS failure explains the name did not resolve from the TREK host', async () => {
  stubFetch(fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND gotify.example.com'), { code: 'ENOTFOUND' })));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /DNS/.test(err.message) && /gotify\.example\.com/.test(err.message),
  );
});

test('a refused connection (AggregateError cause) suggests checking the port', async () => {
  // undici reports multi-address connect failures as an AggregateError.
  const refused = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:8080'), { code: 'ECONNREFUSED' });
  stubFetch(fetchFailed(new AggregateError([refused], 'connect failed')));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /refused/.test(err.message) && /port/.test(err.message),
  );
});

test('a TLS certificate problem is named as such', async () => {
  stubFetch(fetchFailed(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /TLS certificate/.test(err.message),
  );
});

test('a timeout says Gotify did not answer, not "fetch failed"', async () => {
  // AbortSignal.timeout(7000) rejects the fetch with a TimeoutError-named error.
  stubFetch(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /did not answer within 7/.test(err.message),
  );
});

test('an unrecognized failure still surfaces the deepest cause, never bare "fetch failed"', async () => {
  stubFetch(fetchFailed(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => /socket hang up/.test(err.message) && /Could not reach Gotify/.test(err.message),
  );
});

test('the original error is preserved on `cause` for the host log', async () => {
  const inner = new Error('egress: 192.168.1.10 is a blocked address');
  stubFetch(fetchFailed(inner));
  await assert.rejects(
    () => driver().hook('notificationChannel', 'test', CONFIG),
    (err) => err.cause instanceof TypeError && err.cause.cause === inner,
  );
});

test('test() posts a fixed message, backing the "Send test" button', async () => {
  const calls = stubFetch();
  await driver().hook('notificationChannel', 'test', CONFIG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.title, 'TREK');
  assert.match(calls[0].body.message, /working/);
});
