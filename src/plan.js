// Turn a desired state into a list of Ghost API calls, and run them.
import { ghostToFields, differingFields, visibilityFor } from './fields.js';

/**
 * @param {Map<string, object|null>} targets key -> desired fields, or null to delete
 * @param {Map<string, object>} byKey key -> current Ghost tag
 * @param {boolean} full when true, Ghost tags with no target are deleted (a release deploy)
 */
export function planChanges({ targets, byKey, full }) {
  const deletes = [];
  const updates = [];
  const creates = [];

  for (const [key, fields] of [...targets].sort(([a], [b]) => a.localeCompare(b))) {
    const tag = byKey.get(key);
    if (fields === null) {
      if (tag) deletes.push(deleteOp(key, tag));
      continue;
    }
    if (!tag) {
      creates.push({ op: 'create', key, fields });
      continue;
    }
    const current = ghostToFields(tag);
    const changed = differingFields(current, fields);
    if ((tag.visibility ?? 'public') !== visibilityFor(fields)) changed.push('visibility');
    if (changed.length) {
      updates.push({ op: 'update', key, id: tag.id, fields, before: current, changed });
    }
  }

  if (full) {
    for (const [key, tag] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      if (!targets.has(key)) deletes.push(deleteOp(key, tag));
    }
  }

  // Deletes first so a slug freed by a deleted tag can be reused straight away.
  return [...deletes, ...updates, ...creates];
}

function deleteOp(key, tag) {
  return { op: 'delete', key, id: tag.id, name: tag.name, slug: tag.slug, posts: tag.count?.posts ?? null };
}

/**
 * Refuse plans that look like an accident, such as an empty tags/ folder
 * wiping out every tag in Ghost. Returns a reason string, or null if it's fine.
 */
export function checkDeleteGuard(ops, ghostCount) {
  const deleteOps = ops.filter((o) => o.op === 'delete');
  const deletes = deleteOps.length;
  if (!deletes) return null;
  for (const d of deleteOps) {
    const c = ops.find((o) => o.op === 'create' && (o.fields.slug === d.slug || o.fields.name === d.name));
    if (c && d.posts !== 0) {
      return `This would delete "${d.slug}" and create "${c.fields.slug}" as a brand-new tag, which would take the tag off its posts. If you renamed a tag file, give the new file the same slug or name as before so it's treated as a rename.`;
    }
  }
  if (deletes === ghostCount && ghostCount > 0) {
    return `This would delete every tag in Ghost (${deletes}).`;
  }
  if (ghostCount >= 6 && deletes > ghostCount / 2) {
    return `This would delete ${deletes} of the ${ghostCount} tags in Ghost.`;
  }
  return null;
}

/**
 * Run the plan. Keeps going after a failure so one bad tag doesn't block the
 * rest, then reports every failure.
 * @returns {{ done: object[], failed: {op, error}[], createdIds: Map<string, string> }}
 */
export async function applyPlan(client, ops, log = () => {}) {
  const done = [];
  const failed = [];
  const createdIds = new Map();

  // Slug swaps: if one tag is taking a slug another tag in this plan is giving
  // up, move the giver to a temporary slug first. Otherwise Ghost would quietly
  // add "-2" to the slug instead of failing.
  const updates = ops.filter((o) => o.op === 'update');
  for (const holder of updates) {
    const wanted = updates.some((u) => u !== holder && u.fields.slug === holder.before.slug);
    if (!wanted || holder.fields.slug === holder.before.slug) continue;
    try {
      const temp = `${holder.before.slug}-moving-${String(holder.id).slice(-6)}`;
      await client.updateTag(holder.id, { ...holder.before, slug: temp });
      log(`moved ${holder.before.slug} to ${temp} to free the slug`);
    } catch (error) {
      log(`FAILED to free slug ${holder.before.slug}: ${error.message}`);
    }
  }

  for (const op of ops) {
    try {
      if (op.op === 'delete') {
        await client.deleteTag(op.id);
        log(`deleted ${op.slug} (${op.id})`);
      } else if (op.op === 'update') {
        await client.updateTag(op.id, op.fields);
        log(`updated ${op.fields.slug} (${op.changed.join(', ')})`);
      } else if (op.op === 'create') {
        const tag = await client.createTag(op.fields);
        createdIds.set(op.key, tag.id);
        log(`created ${tag.slug} (${tag.id})`);
      }
      done.push(op);
    } catch (error) {
      failed.push({ op, error });
      log(`FAILED to ${op.op} ${op.key}: ${error.message}`);
    }
  }
  return { done, failed, createdIds };
}

/**
 * After applying, check Ghost kept the slug and name it was sent. Ghost can
 * change a slug without failing (one that's already taken becomes "slug-2"),
 * and recording that as released would hide the problem. Other fields aren't
 * checked because Ghost may legitimately rewrite them (image URLs, for example).
 * Returns failures in the same shape as applyPlan's.
 */
export function verifyApplied(ops, idFor, ghostTags) {
  const byId = new Map(ghostTags.map((t) => [t.id, t]));
  const failed = [];
  for (const op of ops) {
    const id = op.op === 'create' ? idFor(op.key) : op.id;
    const tag = id ? byId.get(id) : undefined;
    if (op.op === 'delete') {
      if (tag) failed.push({ op, error: new Error('the tag is still in Ghost') });
      continue;
    }
    if (!tag) {
      failed.push({ op, error: new Error('the tag is missing from Ghost') });
      continue;
    }
    const off = ['slug', 'name'].filter((f) => (tag[f] ?? null) !== (op.fields[f] ?? null));
    if (off.length) {
      const detail = off.map((f) => `${f}: sent ${JSON.stringify(op.fields[f])}, Ghost has ${JSON.stringify(tag[f])}`).join('; ');
      failed.push({ op, error: new Error(`Ghost saved something different (${detail}). Another tag probably already uses that slug.`) });
    }
  }
  return failed;
}
