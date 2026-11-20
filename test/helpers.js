import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyFields, toGhostPayload } from '../src/fields.js';
import { writeTagFile } from '../src/files.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-tags-'));
}

export function fields(overrides) {
  return { ...emptyFields(), ...overrides };
}

export function writeTags(dir, tags) {
  for (const [key, f] of Object.entries(tags)) writeTagFile(dir, key, fields(f));
}

/** In-memory stand-in for the Ghost Admin API client. */
export function fakeGhost(initial = []) {
  let seq = 0;
  const tags = new Map();
  const nextId = () => `6650000000000000000${String(++seq).padStart(5, '0')}`;
  const calls = [];
  for (const t of initial) {
    const id = t.id ?? nextId();
    tags.set(id, { ...toGhostPayload(fields(t)), id, posts: t.posts ?? 0 });
  }
  const view = (t) => ({ ...t, count: { posts: t.posts } });
  // Like Ghost: a slug another tag already uses gets "-2" added, silently.
  const uniqueSlug = (slug, id) => {
    let s = slug;
    for (let n = 2; [...tags.values()].some((t) => t.slug === s && t.id !== id); n++) s = `${slug}-${n}`;
    return s;
  };
  return {
    calls,
    tags,
    bySlug: (slug) => [...tags.values()].find((t) => t.slug === slug),
    edit(slug, changes) {
      const t = [...tags.values()].find((x) => x.slug === slug);
      Object.assign(t, changes);
      if ('name' in changes) t.visibility = changes.name.startsWith('#') ? 'internal' : 'public';
    },
    add(t) {
      const id = nextId();
      tags.set(id, { ...toGhostPayload(fields(t)), id, posts: 0 });
      return id;
    },
    remove(slug) {
      const t = [...tags.values()].find((x) => x.slug === slug);
      tags.delete(t.id);
    },
    async listTags() {
      calls.push(['list']);
      return [...tags.values()].map(view);
    },
    async createTag(f) {
      calls.push(['create', f.slug]);
      const id = nextId();
      tags.set(id, { ...toGhostPayload(f), id, posts: 0 });
      tags.get(id).slug = uniqueSlug(f.slug, id);
      return view(tags.get(id));
    },
    async updateTag(id, f) {
      calls.push(['update', f.slug]);
      if (!tags.has(id)) throw new Error('not found');
      tags.set(id, { ...tags.get(id), ...toGhostPayload(f) });
      tags.get(id).slug = uniqueSlug(f.slug, id);
      return view(tags.get(id));
    },
    async deleteTag(id) {
      calls.push(['delete', tags.get(id)?.slug]);
      tags.delete(id);
    },
  };
}
