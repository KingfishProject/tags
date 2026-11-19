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
  const deletes = ops.filter((o) => o.op === 'delete').length;
  if (!deletes) return null;
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
