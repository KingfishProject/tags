import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPull, runDeploy, runRevert } from '../src/sync.js';
import { emptyState, parseState, serializeState } from '../src/state.js';
import { loadRepoTagsStrict } from '../src/files.js';
import { fingerprint } from '../src/drift.js';
import { driftPrBody, deployReport } from '../src/report.js';
import { tmpDir, writeTags, fakeGhost } from './helpers.js';

const asState = (s) => parseState(serializeState(s));

async function release(dir, ghost, state, opts = {}) {
  const r = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v-test', ...opts });
  assert.equal(r.status, 'done', JSON.stringify(r.changes ?? r.validation ?? r.guard));
  return asState(r.newState);
}

/** A repo + Ghost that are in sync after one release. */
async function synced(tags) {
  const dir = tmpDir();
  const ghost = fakeGhost(Object.values(tags));
  writeTags(dir, tags);
  const state = await release(dir, ghost, emptyState());
  return { dir, ghost, state };
}

const NEWS = { name: 'News', slug: 'news', description: 'All the news' };
const SPORTS = { name: 'Sports', slug: 'sports' };
const INTERNAL = { name: '#featured', slug: 'hash-featured' };

test('first pull imports everything from Ghost', async () => {
  const dir = tmpDir();
  const ghost = fakeGhost([NEWS, SPORTS, INTERNAL]);
  const r = await runPull({ client: ghost, tagsDir: dir, state: emptyState() });
  assert.deepEqual(r.changes.map((c) => c.kind), ['created', 'created', 'created']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['hash-featured.yaml', 'news.yaml', 'sports.yaml']);
  assert.match(fs.readFileSync(path.join(dir, 'hash-featured.yaml'), 'utf8'), /name: "#featured"/);
  const body = driftPrBody({ ...r, state: emptyState() });
  assert.match(body, /3 created/);
  assert.match(body, /<!-- ghost-drift:/);

  // Merge the import, then release: nothing to change, state recorded.
  const d = await runDeploy({ client: ghost, tagsDir: dir, state: emptyState(), source: 'v1' });
  assert.equal(d.status, 'done');
  assert.deepEqual(d.ops, []);
  assert.equal(d.newState.tags.size, 3);
  assert.equal(ghost.calls.filter((c) => c[0] !== 'list').length, 0);
});

test('no drift right after a release', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(r.changes, []);
});

test('unreleased GitHub edits are not reported as Ghost changes', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { news: { ...NEWS, description: 'Edited in GitHub' } });
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(r.changes, []);
});

test('Ghost edit shows up, and only the edited field changes in the file', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  writeTags(dir, { sports: { ...SPORTS, meta_title: 'Unreleased GitHub edit' } });
  ghost.edit('news', { description: 'Edited in Ghost' });
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'changed');
  assert.deepEqual(r.changes[0].fields.map((f) => [f.field, f.base, f.ghost, f.conflict]), [
    ['description', 'All the news', 'Edited in Ghost', false],
  ]);
  const ours = loadRepoTagsStrict(dir);
  assert.equal(ours.get('news').description, 'Edited in Ghost');
  assert.equal(ours.get('sports').meta_title, 'Unreleased GitHub edit');
});

test('after the drift PR is merged, nothing is reported and release is allowed', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { description: 'Edited in Ghost' });
  await runPull({ client: ghost, tagsDir: dir, state }); // "merge" = keep the written files
  const again = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(again.changes, []);
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'done');
  assert.deepEqual(d.ops, []);
});

test('release is blocked while Ghost has unreviewed changes, unless forced', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { description: 'Edited in Ghost' });
  const blocked = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(blocked.status, 'blocked-drift');
  assert.equal(ghost.bySlug('news').description, 'Edited in Ghost');
  assert.match(deployReport({ title: 't', ops: blocked.ops, changes: blocked.changes, blocked: 'x' }), /Would make 1 change/);

  const forced = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2', force: true });
  assert.equal(forced.status, 'done');
  assert.equal(ghost.bySlug('news').description, 'All the news');
});

test('closing the drift PR reverts Ghost: edits, new tags, deleted tags', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  ghost.edit('news', { description: 'Edited in Ghost', accent_color: '#123456' });
  ghost.add({ name: 'Brand new', slug: 'brand-new' });
  const oldSportsId = ghost.bySlug('sports').id;
  ghost.remove('sports');

  const scratch = tmpDir(); // the PR branch; main (dir) stays as is
  fs.cpSync(dir, scratch, { recursive: true });
  const pulled = await runPull({ client: ghost, tagsDir: scratch, state });
  assert.deepEqual(pulled.changes.map((c) => `${c.key}:${c.kind}`).sort(), ['brand-new:created', 'news:changed', 'sports:deleted']);

  const r = await runRevert({ client: ghost, tagsDir: dir, state, fingerprint: fingerprint(pulled.changes) });
  assert.equal(r.status, 'done');
  assert.equal(ghost.bySlug('news').description, 'All the news');
  assert.equal(ghost.bySlug('news').accent_color, null);
  assert.equal(ghost.bySlug('brand-new'), undefined);
  assert.ok(ghost.bySlug('sports'));
  const newState = asState(r.newState);
  assert.notEqual(newState.tags.get('sports').id, oldSportsId);
  assert.equal(newState.source, state.source);

  const after = await runPull({ client: ghost, tagsDir: dir, state: newState });
  assert.deepEqual(after.changes, []);
});

test('revert leaves alone Ghost edits made after the PR was last updated', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  ghost.edit('news', { description: 'First edit' });
  const scratch = tmpDir();
  fs.cpSync(dir, scratch, { recursive: true });
  const pulled = await runPull({ client: ghost, tagsDir: scratch, state });
  ghost.edit('sports', { description: 'Later edit nobody reviewed' });
  ghost.edit('news', { meta_title: 'Also later' });

  const r = await runRevert({ client: ghost, tagsDir: dir, state, fingerprint: fingerprint(pulled.changes) });
  assert.equal(r.status, 'done');
  assert.equal(r.skipped, 1); // sports
  assert.equal(ghost.bySlug('news').description, 'All the news');
  assert.equal(ghost.bySlug('news').meta_title, 'Also later');
  assert.equal(ghost.bySlug('sports').description, 'Later edit nobody reviewed');
});

test('revert does nothing before the first release', async () => {
  const dir = tmpDir();
  const ghost = fakeGhost([NEWS]);
  const r = await runRevert({ client: ghost, tagsDir: dir, state: emptyState() });
  assert.equal(r.status, 'no-state');
  assert.ok(ghost.bySlug('news'));
});

test('conflict: same field changed in GitHub and Ghost', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { news: { ...NEWS, description: 'GitHub version' } });
  ghost.edit('news', { description: 'Ghost version' });
  const scratch = tmpDir();
  fs.cpSync(dir, scratch, { recursive: true });
  const r = await runPull({ client: ghost, tagsDir: scratch, state });
  assert.equal(r.changes[0].fields[0].conflict, true);
  assert.match(driftPrBody({ ...r, state }), /⚠️/);

  // Close: Ghost goes back to the released value; the GitHub edit ships at the next release.
  await runRevert({ client: ghost, tagsDir: dir, state, fingerprint: fingerprint(r.changes) });
  assert.equal(ghost.bySlug('news').description, 'All the news');
  await release(dir, ghost, state);
  assert.equal(ghost.bySlug('news').description, 'GitHub version');
});

test('deleting a file deletes the tag at the next release', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  fs.rmSync(path.join(dir, 'sports.yaml'));
  const pull = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(pull.changes, []);
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'done');
  assert.deepEqual(d.ops.map((o) => o.op), ['delete']);
  assert.equal(ghost.bySlug('sports'), undefined);
  assert.equal(d.newState.tags.has('sports'), false);
});

test('tag deleted in Ghost becomes a PR that deletes the file', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  ghost.remove('sports');
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(r.changes.map((c) => c.kind), ['deleted']);
  assert.equal(fs.existsSync(path.join(dir, 'sports.yaml')), false);
});

test('renaming a slug in GitHub updates the same Ghost tag', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  const id = ghost.bySlug('news').id;
  writeTags(dir, { news: { ...NEWS, slug: 'local-news' } });
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.deepEqual(d.ops.map((o) => o.op), ['update']);
  assert.equal(ghost.bySlug('local-news').id, id);
  assert.equal(d.newState.tags.get('news').id, id);
});

test('renaming a slug in Ghost edits the existing file', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { slug: 'headlines' });
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.equal(r.changes[0].key, 'news');
  assert.deepEqual(r.changes[0].fields.map((f) => f.field), ['slug']);
  assert.equal(loadRepoTagsStrict(dir).get('news').slug, 'headlines');
});

test('tags created in GitHub are created in Ghost and tracked by ID', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { opinion: { name: 'Opinion', slug: 'opinion' } });
  const s2 = await release(dir, ghost, state);
  assert.ok(s2.tags.get('opinion').id);
  assert.equal((await runPull({ client: ghost, tagsDir: dir, state: s2 })).changes.length, 0);
});

test('an empty tags folder will not wipe Ghost', async () => {
  const { dir, ghost, state } = await synced({ a: { name: 'A', slug: 'a' }, b: { name: 'B', slug: 'b' } });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'blocked-deletes');
  assert.equal(ghost.tags.size, 2);
});

test('invalid files block a release', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { news: { ...NEWS, meta_title: 'x'.repeat(80) } });
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'blocked-validation');
});

test('dry run changes nothing', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { news: { ...NEWS, description: 'new' }, extra: { name: 'Extra', slug: 'extra' } });
  const before = ghost.calls.length;
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'pr', dryRun: true });
  assert.equal(d.status, 'dry-run');
  assert.deepEqual(d.ops.map((o) => o.op), ['update', 'create']);
  assert.deepEqual(ghost.calls.slice(before), [['list']]);
});

test('renaming to a # name makes the tag internal', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  writeTags(dir, { news: { ...NEWS, name: '#news' } });
  await release(dir, ghost, state);
  assert.equal(ghost.bySlug('news').visibility, 'internal');
});

test('edited in Ghost after being deleted in GitHub', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  fs.rmSync(path.join(dir, 'sports.yaml'));
  ghost.edit('sports', { description: 'Edited in Ghost' });
  const r = await runPull({ client: ghost, tagsDir: dir, state });
  assert.deepEqual(r.changes.map((c) => c.kind), ['restored']);
  assert.equal(loadRepoTagsStrict(dir).get('sports').description, 'Edited in Ghost');
});

// --- Fixes from review ---------------------------------------------------

import { runAccept } from '../src/sync.js';

/** Pull into a copy of main, as the drift PR branch would. Returns the result and the branch dir. */
async function pullToBranch(dir, ghost, state) {
  const branch = tmpDir();
  fs.cpSync(dir, branch, { recursive: true });
  const r = await runPull({ client: ghost, tagsDir: branch, state });
  return { r, branch };
}

/** Merge the drift PR: main becomes the branch, then the accept job runs. */
async function mergeDrift(dir, ghost, state) {
  const { r, branch } = await pullToBranch(dir, ghost, state);
  fs.rmSync(dir, { recursive: true });
  fs.cpSync(branch, dir, { recursive: true });
  const a = await runAccept({ client: ghost, tagsDir: dir, state, fingerprint: fingerprint(r.changes), source: 'import' });
  return a.status === 'done' ? asState(a.newState) : state;
}

test('renaming a tag file keeps the Ghost tag and its posts', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { posts: 40 });
  const id = ghost.bySlug('news').id;
  fs.renameSync(path.join(dir, 'news.yaml'), path.join(dir, 'local-news.yaml'));
  writeTags(dir, { 'local-news': { ...NEWS, slug: 'local-news' } }); // slug changed too, name kept
  assert.deepEqual((await runPull({ client: ghost, tagsDir: dir, state })).changes, []);
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'done');
  assert.deepEqual(d.ops.map((o) => o.op), ['update']);
  assert.equal(ghost.bySlug('local-news').id, id);
  assert.equal(ghost.bySlug('local-news').posts, 40);
  assert.equal(d.newState.tags.get('local-news').id, id);
});

test('a delete plus a new tag with the same name is refused', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { posts: 3 });
  fs.rmSync(path.join(dir, 'news.yaml'));
  // Two new files with the old name, so which one is the rename is ambiguous.
  writeTags(dir, { a: { name: 'News', slug: 'a' }, b: { name: 'News', slug: 'b' } });
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'blocked-deletes');
  assert.match(d.guard, /brand-new tag/);
});

test('swapping two slugs works instead of Ghost adding "-2"', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS, sports: SPORTS });
  writeTags(dir, { news: { ...NEWS, slug: 'sports' }, sports: { ...SPORTS, slug: 'news' } });
  const d = await runDeploy({ client: ghost, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'done', JSON.stringify(d.failed?.map((f) => f.error.message)));
  assert.equal(ghost.bySlug('sports').name, 'News');
  assert.equal(ghost.bySlug('news').name, 'Sports');
});

test('a slug Ghost changes on save fails the deploy instead of being recorded', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  // Someone grabs the slug in Ghost between the plan and the update.
  const client = {
    ...ghost,
    async updateTag(id, f) {
      ghost.add({ name: 'Squatter', slug: f.slug });
      return ghost.updateTag(id, f);
    },
  };
  writeTags(dir, { news: { ...NEWS, slug: 'headlines' } });
  const d = await runDeploy({ client, tagsDir: dir, state, source: 'v2' });
  assert.equal(d.status, 'failed');
  assert.match(d.failed[0].error.message, /Ghost saved something different/);
  assert.equal(d.newState, undefined);
});

test('after merging a Ghost edit, editing it again in GitHub is not drift', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { description: 'Ghost edit' });
  const s2 = await mergeDrift(dir, ghost, state);
  writeTags(dir, { news: { ...NEWS, description: 'Then tweaked in GitHub' } });
  assert.deepEqual((await runPull({ client: ghost, tagsDir: dir, state: s2 })).changes, []);
  const d = await runDeploy({ client: ghost, tagsDir: dir, state: s2, source: 'v2' });
  assert.equal(d.status, 'done');
  assert.equal(ghost.bySlug('news').description, 'Then tweaked in GitHub');
});

test('a Ghost-created tag that was merged keeps its ID through a Ghost rename', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  const id = ghost.add({ name: 'Elections', slug: 'elections' });
  const s2 = await mergeDrift(dir, ghost, state);
  assert.equal(s2.tags.get('elections').id, id);
  ghost.edit('elections', { slug: 'elections-2026' });
  const { r } = await pullToBranch(dir, ghost, s2);
  assert.deepEqual(r.changes.map((c) => [c.key, c.kind]), [['elections', 'changed']]);
});

test('editing an imported tag before the first release is not drift', async () => {
  const dir = tmpDir();
  const ghost = fakeGhost([NEWS, SPORTS]);
  const s1 = await mergeDrift(dir, ghost, emptyState());
  assert.equal(s1.exists, true);
  assert.equal(s1.tags.size, 2);
  writeTags(dir, { news: { ...NEWS, description: 'Edited before first release' } });
  const d = await runDeploy({ client: ghost, tagsDir: dir, state: s1, source: 'v1' });
  assert.equal(d.status, 'done');
  assert.equal(ghost.bySlug('news').description, 'Edited before first release');
});

test('only merged changes are recorded, and Ghost is not touched', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.edit('news', { description: 'Ghost edit' });
  const before = ghost.calls.length;
  // Merge happened, then someone reverted the file on main before the accept job ran.
  const { r } = await pullToBranch(dir, ghost, state);
  const a = await runAccept({ client: ghost, tagsDir: dir, state, fingerprint: fingerprint(r.changes) });
  assert.equal(a.status, 'nothing');
  assert.deepEqual(ghost.calls.slice(before).filter((c) => c[0] !== 'list'), []);
});

test('the PR warns that closing deletes a Ghost-created tag from its posts', async () => {
  const { dir, ghost, state } = await synced({ news: NEWS });
  ghost.add({ name: 'Elections', slug: 'elections' });
  ghost.edit('elections', { posts: 7 });
  const { r } = await pullToBranch(dir, ghost, state);
  assert.match(driftPrBody({ ...r, state }), /Closing \*\*deletes it from Ghost\*\*\. It's already on 7 posts/);
});
