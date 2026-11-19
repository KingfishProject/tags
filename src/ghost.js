// A small client for the parts of the Ghost Admin API this repo uses.
import crypto from 'node:crypto';
import { toGhostPayload } from './fields.js';

export class GhostApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GhostApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Build the short-lived JWT the Admin API expects.
 * The key from Ghost Admin → Settings → Integrations looks like "<id>:<secret>".
 */
export function makeAdminToken(adminKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [id, secret, extra] = String(adminKey ?? '').trim().split(':');
  if (!id || !secret || extra !== undefined || !/^[0-9a-f]+$/i.test(secret) || secret.length % 2) {
    throw new Error(
      'GHOST_ADMIN_API_KEY should look like "<id>:<secret>". Copy the Admin API key from a custom integration in Ghost Admin → Settings → Integrations.',
    );
  }
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT', kid: id });
  const payload = b64({ iat: nowSeconds, exp: nowSeconds + 5 * 60, aud: '/admin/' });
  const signature = crypto
    .createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Accepts "https://site.com", "https://site.com/", or a URL that already ends in /ghost/api/admin. */
export function adminApiBase(siteUrl) {
  let url = String(siteUrl ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('GHOST_API_URL should be your Ghost site address, like https://example.com');
  }
  url = url.replace(/\/+$/, '').replace(/\/ghost(\/api(\/admin)?)?$/i, '');
  return `${url}/ghost/api/admin`;
}

function describeGhostError(status, body, res) {
  const first = body?.errors?.[0];
  if (!first) {
    // Not a Ghost error, so something in front of Ghost answered instead.
    const server = res?.headers?.get?.('server');
    const via = server ? ` from "${server}"` : '';
    const hint =
      status === 403 || status === 503
        ? ' Something in front of Ghost (often Cloudflare bot protection or a firewall rule) is blocking the request. Let requests to /ghost/api/admin/ through for GitHub Actions.'
        : status === 404
          ? ' Check that GHOST_API_URL is the address Ghost Admin runs on, not a separate front-end site.'
          : '';
    return `HTTP ${status}${via}, not a response from Ghost.${hint}`;
  }
  return [first.message, first.context, first.help].filter(Boolean).join(' — ') + ` (HTTP ${status})`;
}

export function createGhostClient({
  url,
  adminKey,
  fetchImpl = globalThis.fetch,
  acceptVersion = 'v5.0',
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retries = 4,
}) {
  const base = adminApiBase(url);
  makeAdminToken(adminKey); // fail fast on a malformed key

  async function request(method, path, body) {
    // A POST that reached Ghost may have created the tag even if the response
    // was lost, so only retry it when Ghost explicitly said "slow down".
    const idempotent = method !== 'POST';
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Ghost ${makeAdminToken(adminKey)}`,
            'Accept-Version': acceptVersion,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        lastError = new GhostApiError(`Could not reach Ghost at ${base}: ${err.message}`);
        if (idempotent && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      if ((res.status === 429 || (idempotent && res.status >= 500)) && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return null;
      // A retried DELETE can find the tag already gone.
      if (method === 'DELETE' && res.status === 404 && attempt > 0) return null;
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        throw new GhostApiError(`${method} ${path}: ${describeGhostError(res.status, data, res)}`, {
          status: res.status,
          body: data ?? text,
        });
      }
      return data;
    }
    throw lastError;
  }

  return {
    base,

    /** Every tag, public and internal, with post counts. */
    async listTags() {
      const all = [];
      const filter = encodeURIComponent('visibility:[public,internal]');
      let page = 1;
      for (;;) {
        const data = await request('GET', `/tags/?limit=100&page=${page}&include=count.posts&filter=${filter}`);
        all.push(...(data?.tags ?? []));
        const next = data?.meta?.pagination?.next;
        if (!next || next <= page) break;
        page = next;
      }
      return all;
    },

    async createTag(fields) {
      const data = await request('POST', '/tags/', { tags: [toGhostPayload(fields)] });
      return data.tags[0];
    },

    async updateTag(id, fields) {
      const data = await request('PUT', `/tags/${encodeURIComponent(id)}/`, { tags: [toGhostPayload(fields)] });
      return data.tags[0];
    },

    async deleteTag(id) {
      await request('DELETE', `/tags/${encodeURIComponent(id)}/`);
    },
  };
}

export function clientFromEnv(env = process.env) {
  const url = env.GHOST_API_URL;
  const adminKey = env.GHOST_ADMIN_API_KEY;
  const missing = [!url && 'GHOST_API_URL', !adminKey && 'GHOST_ADMIN_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(' and ')}. Add them under Settings → Secrets and variables → Actions.`);
  }
  return createGhostClient({ url, adminKey });
}
