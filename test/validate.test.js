import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRepoTags } from '../src/files.js';
import { validateTags } from '../src/validate.js';
import { tmpDir, writeTags } from './helpers.js';

function check(dir) {
  const { tags, problems } = loadRepoTags(dir);
  return validateTags(tags, problems);
}

test('a good tag passes', () => {
  const dir = tmpDir();
  writeTags(dir, { news: { name: 'News', slug: 'news', accent_color: '#AABBCC', feature_image: 'https://x.com/i.png' } });
  assert.deepEqual(check(dir).errors, []);
});

test('character limits', () => {
  const dir = tmpDir();
  writeTags(dir, {
    a: { name: 'A', slug: 'a', meta_title: 'x'.repeat(71), og_description: 'y'.repeat(66), description: 'z'.repeat(501) },
  });
  const msgs = check(dir).errors.map((e) => e.message);
  assert.equal(msgs.length, 3);
  assert.ok(msgs.some((m) => m.includes('Meta title is 71')));
  assert.ok(msgs.some((m) => m.includes('Facebook description is 66')));
});

test('limits at exactly the max pass', () => {
  const dir = tmpDir();
  writeTags(dir, { a: { name: 'A', slug: 'a', meta_title: 'x'.repeat(70), twitter_description: 'y'.repeat(125) } });
  assert.deepEqual(check(dir).errors, []);
});

test('unquoted # is caught', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'name: A\nslug: a\ncolor: #ff0000\n');
  const errors = check(dir).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /must be in quotes/);
  assert.equal(errors[0].line, 3);
});

test('duplicate slugs, bad colors, bad urls, missing fields', () => {
  const dir = tmpDir();
  writeTags(dir, {
    a: { name: 'A', slug: 'same', accent_color: 'red' },
    b: { name: 'B', slug: 'same', canonical_url: 'not a url' },
    c: { slug: 'c' },
  });
  const msgs = check(dir).errors.map((e) => e.message).join('\n');
  assert.match(msgs, /also used by/);
  assert.match(msgs, /hex color/);
  assert.match(msgs, /not a valid URL/);
  assert.match(msgs, /name is required/);
});

test('bad file names and YAML errors', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'Bad Name.yaml'), 'name: x\n');
  fs.writeFileSync(path.join(dir, 'broken.yaml'), 'name: [\n');
  const msgs = check(dir).errors.map((e) => e.message).join('\n');
  assert.match(msgs, /file name/);
  assert.match(msgs, /YAML syntax error/);
});

test('a "#" inside a multi-line description is fine', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'name: A\nslug: a\ndescription: |-\n  Follow us: #news\n  more\nmeta:\n  title: #oops\n');
  const errors = check(dir).errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 7);
});

test('relative URLs are refused, underscores in slugs are fine', () => {
  const dir = tmpDir();
  writeTags(dir, { a_b: { name: 'A', slug: 'a_b', canonical_url: '/tag/a/' } });
  const msgs = check(dir).errors.map((e) => e.message);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /full address/);
});
