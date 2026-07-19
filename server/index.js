'use strict';
// Gotify notification channel for TREK.
//
// TREK renders every notification into the recipient's language and hands it over
// ready to send, so this plugin never touches i18n and never picks a recipient —
// the host does that, then calls send() once per person who has the channel on.
//
// The hook is HOST-initiated for an arbitrary recipient, so it runs with NO acting
// user: ctx.settings.get() returns undefined and trip reads are refused. The
// recipient's own scope:'user' settings arrive DECRYPTED as `config`. That is the
// only way to reach them, and it is why this plugin cannot read anyone's trips.
const { definePlugin } = require('trek-plugin-sdk');

const DEFAULT_PRIORITY = 5;

function baseUrl(config) {
  const raw = String(config.serverUrl || '').trim();
  if (!raw) throw new Error('No Gotify server URL configured');
  // Reject anything that isn't a plain http(s) origin before it reaches fetch.
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Gotify server URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Gotify server URL must be http(s), got ${url.protocol}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function priorityOf(config) {
  const n = Number(config.priority);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : DEFAULT_PRIORITY;
}

// The deepest message + code in an error's cause chain. undici buries the real
// failure under TypeError('fetch failed') — and multi-address connect failures
// one level deeper still, inside an AggregateError — so walk err → cause →
// errors[0] until there is nothing further down.
function deepestError(err) {
  let e = err;
  for (let hops = 0; hops < 8; hops++) {
    if (e instanceof AggregateError && e.errors.length) e = e.errors[0];
    else if (e && typeof e === 'object' && e.cause) e = e.cause;
    else break;
  }
  return e || err;
}

// Translate a failed fetch into a message the person staring at the settings
// form can act on. TREK gives a plugin no structured egress error — only the
// guard's message text — so the "egress:" matches are a deliberate coupling to
// TREK's plugin-host wording; if that wording ever drifts, we fall through to
// surfacing the raw detail, which is still strictly better than "fetch failed".
function explainFetchError(err, host) {
  const deep = deepestError(err);
  const detail = String(deep.message || deep);
  const code = deep.code;

  let hint = '';
  if (/egress: .* blocked address/.test(detail)) {
    hint = ` TREK blocks plugin access to private/LAN addresses by default — the admin must start TREK with TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on (see this plugin's README, "Self-hosting on the same machine or LAN").`;
  } else if (/egress: .*declared hosts/.test(detail)) {
    hint = ` An admin must add this host under Admin → Plugins → Gotify → Allowed hosts.`;
  } else if (err.name === 'TimeoutError' || deep.name === 'TimeoutError') {
    return new Error(`Gotify did not answer within 7 s — is ${host} reachable from the machine running TREK?`, { cause: err });
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hint = ` DNS could not resolve ${host} from where TREK runs — a LAN-only name needs the TREK container to use your LAN's DNS server.`;
  } else if (code === 'ECONNREFUSED') {
    hint = ` The connection was refused — is the port right and Gotify listening there?`;
  } else if (typeof code === 'string' && /CERT|TLS/.test(code)) {
    hint = ` TLS certificate problem at ${host} (self-signed or expired reverse-proxy cert?).`;
  }
  return new Error(`Could not reach Gotify: ${detail}.${hint}`, { cause: err });
}

async function push(config, title, message) {
  // URL first: it is the first field in the settings form, so it is the more useful
  // first complaint when a user has filled in nothing at all.
  const base = baseUrl(config);
  const endpoint = `${base}/message`;
  const token = String(config.appToken || '').trim();
  if (!token) throw new Error('No Gotify application token configured');

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Gotify's app-token header. Sent as a header, never in the query string,
        // so the token cannot leak into the server's access log.
        'X-Gotify-Key': token,
      },
      body: JSON.stringify({ title, message, priority: priorityOf(config) }),
      signal: AbortSignal.timeout(7000),
    });
  } catch (err) {
    throw explainFetchError(err, new URL(base).hostname);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Throw rather than swallow: the host logs the failure and isolates it, so a
    // dead Gotify can never stop email/in-app/other channels from being delivered.
    throw new Error(`Gotify responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

module.exports = definePlugin({
  // A button on the plugin's own settings page. USER-INITIATED, so unlike the channel
  // hook there IS an acting user — the person who clicked — and ctx.settings.get()
  // returns THEIR values. That is what makes "test MY credentials" possible.
  actions: {
    async testConnection(ctx) {
      const config = {
        serverUrl: await ctx.settings.get('serverUrl'),
        appToken: await ctx.settings.get('appToken'),
        priority: await ctx.settings.get('priority'),
      };
      await push(config, 'TREK', 'Test notification. If you can read this, your Gotify channel is working.');
      return { ok: true, message: 'Connected — check your Gotify.' };
    },
  },

  hooks: {
    notificationChannel: {
      // msg = { event, title, body, url?, tripName? } — already localized by TREK.
      async send(msg, config, ctx) {
        const body = msg.url ? `${msg.body}\n\n${msg.url}` : msg.body;
        await push(config, msg.title, body);
        ctx.log.info(`delivered ${msg.event} to Gotify`);
      },

      // Backs the "Send test" button in the user's notification settings.
      async test(config) {
        await push(config, 'TREK', 'Test notification. If you can read this, your Gotify channel is working.');
      },
    },
  },
});
