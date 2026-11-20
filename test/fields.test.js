import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { fileToFields, fieldsToFile, toGhostPayload } from '../src/fields.js';
import { renderTagFile } from '../src/files.js';
import { fields } from './helpers.js';

test('YAML file round-trips through Ghost fields', () => {
  const f = fields({
    name: '#internal',
    slug: 'hash-internal',
    description: 'Line one\nLine two',
    accent_color: '#ff0000',
    meta_title: 'Meta',
    twitter_description: 'X desc',
    og_image: 'https://example.com/a.png',
  });
  const text = renderTagFile(f);
  assert.match(text, /name: "#internal"/);
  assert.match(text, /color: "#ff0000"/);
  const back = fileToFields(YAML.parse(text));
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.fields, f);
});

test('nested sections map to Ghost names', () => {
  const doc = fieldsToFile(fields({ name: 'A', slug: 'a', meta_title: 'M', twitter_title: 'X', og_title: 'F', canonical_url: '/c' }));
  assert.deepEqual(doc, { name: 'A', slug: 'a', meta: { title: 'M', canonical_url: '/c' }, x: { title: 'X' }, facebook: { title: 'F' } });
});

test('unknown fields are reported', () => {
  const { problems } = fileToFields({ name: 'A', slug: 'a', colour: 'red', meta: { titel: 'x' } });
  assert.equal(problems.length, 2);
});

test('internal visibility follows the # prefix', () => {
  assert.equal(toGhostPayload(fields({ name: '#x' })).visibility, 'internal');
  assert.equal(toGhostPayload(fields({ name: 'x' })).visibility, 'public');
});

test('empty strings mean unset', () => {
  assert.equal(fileToFields({ name: 'A', slug: 'a', description: '' }).fields.description, null);
});
