// Work out which repo file each Ghost tag belongs to.
import { KEY_PATTERN } from './files.js';

/**
 * Give every Ghost tag a key (a tags/<key>.yaml file name).
 *
 * 1. By Ghost ID, using the last-deployed snapshot. This keeps a tag attached to
 *    its file through slug renames on either side.
 * 2. By slug, for tags the snapshot doesn't know yet (first sync, or a tag that
 *    was created in GitHub and released since the last snapshot).
 * 3. Anything left is new in Ghost and gets a key based on its slug.
 *
 * @param {object[]} ghostTags tags from the Ghost API
 * @param {Map<string, {id, fields}>} snapshot
 * @param {Map<string, object>} ours repo tags (key -> fields)
 * @returns {{ byKey: Map<string, object>, newKeys: Set<string> }}
 */
export function assignKeys(ghostTags, snapshot, ours) {
  const byKey = new Map();
  const claimed = new Set();
  const byId = new Map(ghostTags.map((t) => [t.id, t]));

  for (const [key, entry] of snapshot) {
    const tag = byId.get(entry.id);
    if (tag && !claimed.has(tag.id)) {
      byKey.set(key, tag);
      claimed.add(tag.id);
    }
  }

  const bySlug = new Map(ghostTags.map((t) => [t.slug, t]));
  const candidates = new Set([...ours.keys(), ...snapshot.keys()]);
  for (const key of [...candidates].sort()) {
    if (byKey.has(key)) continue;
    const slugs = [ours.get(key)?.slug, snapshot.get(key)?.fields.slug, key].filter(Boolean);
    for (const slug of slugs) {
      const tag = bySlug.get(slug);
      if (tag && !claimed.has(tag.id)) {
        byKey.set(key, tag);
        claimed.add(tag.id);
        break;
      }
    }
  }

  const taken = new Set([...candidates, ...byKey.keys()]);
  const newKeys = new Set();
  const leftovers = ghostTags.filter((t) => !claimed.has(t.id)).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  for (const tag of leftovers) {
    let key = KEY_PATTERN.test(tag.slug ?? '') ? tag.slug : `tag-${String(tag.id).slice(-8).toLowerCase()}`;
    if (taken.has(key)) key = `${key}-${String(tag.id).slice(-6).toLowerCase()}`;
    const base = key;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    byKey.set(key, tag);
    newKeys.add(key);
  }
  return { byKey, newKeys };
}
