import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGhostClient, makeAdminToken, adminApiBase } from '../src/ghost.js';

const KEY = '64f0c0ffee0000000000abcd:' + 'ab'.repeat(32);

test('admin token is a valid HS256 JWT', () => {
  const token = makeAdminToken(KEY, 1000);
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT', kid: '64f0c0ffee0000000000abcd' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: 1000, exp: 1300, aud: '/admin/' });
  const expected = crypto.createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected);
});

test('bad keys and urls are explained', () => {
  assert.throws(() => makeAdminToken('nope'), /should look like/);
  assert.throws(() => makeAdminToken('id:nothex'), /should look like/);
  assert.throws(() => adminApiBase('example.com'), /site address/);
  assert.equal(adminApiBase('https://x.com/'), 'https://x.com/ghost/api/admin');
  assert.equal(adminApiBase('https://x.com/ghost/api/admin/'), 'https://x.com/ghost/api/admin');
  assert.equal(adminApiBase('https://x.com/blog'), 'https://x.com/blog/ghost/api/admin');
});

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('client pages through tags, retries, and sends auth', async () => {
  let calls = 0;
  const seen = [];
  const s = await server((req, res) => {
    calls++;
    seen.push(req);
    const url = new URL(req.url, 'http://x');
    if (calls === 1) {
      res.writeHead(503);
      return res.end();
    }
    const page = Number(url.searchParams.get('page'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tags: [{ id: `t${page}`, slug: `s${page}`, name: `N${page}` }],
        meta: { pagination: { page, next: page < 3 ? page + 1 : null } },
      }),
    );
  });
  const { port } = s.address();
  const client = createGhostClient({ url: `http://127.0.0.1:${port}`, adminKey: KEY, sleep: async () => {} });
  const tags = await client.listTags();
  s.close();
  assert.deepEqual(tags.map((t) => t.id), ['t1', 't2', 't3']);
  assert.equal(calls, 4);
  const last = seen.at(-1);
  assert.match(last.headers.authorization, /^Ghost [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(last.headers['accept-version'], 'v5.0');
  assert.match(last.url, /^\/ghost\/api\/admin\/tags\/\?limit=100&page=3&include=count\.posts&filter=/);
});

test('POST is not retried on a server error', async () => {
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Boom', context: 'ctx' }] }));
  });
  const { port } = s.address();
  const client = createGhostClient({ url: `http://127.0.0.1:${port}`, adminKey: KEY, sleep: async () => {} });
  await assert.rejects(client.createTag({ name: 'A', slug: 'a' }), /Boom — ctx \(HTTP 500\)/);
  s.close();
  assert.equal(calls, 1);
});

test('update sends every field, clearing unset ones', async () => {
  let body;
  const s = await server((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      body = JSON.parse(data);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tags: [{ id: 'x', ...body.tags[0] }] }));
    });
  });
  const { port } = s.address();
  const client = createGhostClient({ url: `http://127.0.0.1:${port}`, adminKey: KEY });
  await client.updateTag('x', { name: 'A', slug: 'a' });
  s.close();
  assert.equal(body.tags[0].description, null);
  assert.equal(body.tags[0].visibility, 'public');
  assert.equal(Object.keys(body.tags[0]).length, 15);
});

test('a block page in front of Ghost is explained', async () => {
  const s = await server((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' });
    res.end('<html>blocked</html>');
  });
  const { port } = s.address();
  const client = createGhostClient({ url: `http://127.0.0.1:${port}`, adminKey: KEY, sleep: async () => {} });
  await assert.rejects(client.listTags(), /HTTP 403 from "cloudflare", not a response from Ghost\. .*Cloudflare bot protection/);
  s.close();
});
