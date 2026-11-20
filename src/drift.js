// Find changes made directly in Ghost, using a three-way comparison.
import crypto from 'node:crypto';
import { FIELD_NAMES, ghostToFields, differingFields } from './fields.js';
import { assignKeys, followRenames } from './match.js';

/**
 * Kinds of change:
 *  created  - tag exists in Ghost but not in the snapshot or the repo
 *  changed  - one or more fields differ in Ghost from the last release (and from the repo)
 *  deleted  - tag was in the last release but is gone from Ghost (and the repo still has it)
 *  restored - tag was edited in Ghost but has been deleted in the repo since the last release
 *
 * A field only counts as drift when Ghost differs from BOTH the last release and
 * the repo. So unreleased GitHub edits are not reported, and Ghost edits that
 * have already been merged into the repo stop being reported.
 */
export function computeDrift({ base, ghost, ours }) {
  const changes = [];
  const keys = [...new Set([...base.keys(), ...ghost.keys()])].sort();
  for (const key of keys) {
    const b = base.get(key);
    const g = ghost.get(key);
    const o = ours.get(key);

    if (g && !b) {
      if (!o) {
        changes.push({ key, kind: 'created', ghost: g });
      } else {
        const fields = differingFields(g, o).map((field) => ({
          field,
          base: undefined,
          ghost: g[field],
          ours: o[field],
          conflict: true,
        }));
        if (fields.length) changes.push({ key, kind: 'changed', fields, ghost: g, ours: o });
      }
    } else if (b && !g) {
      if (o) changes.push({ key, kind: 'deleted', base: b, ours: o, conflict: differingFields(b, o).length > 0 });
    } else if (b && g) {
      if (!o) {
        if (differingFields(g, b).length) changes.push({ key, kind: 'restored', base: b, ghost: g, conflict: true });
      } else {
        const fields = FIELD_NAMES.filter((f) => g[f] !== b[f] && g[f] !== o[f]).map((field) => ({
          field,
          base: b[field],
          ghost: g[field],
          ours: o[field],
          conflict: o[field] !== b[field],
        }));
        if (fields.length) changes.push({ key, kind: 'changed', fields, base: b, ghost: g, ours: o });
      }
    }
  }
  return changes;
}

/**
 * Match Ghost tags to keys and run the comparison.
 * @returns {{ changes, byKey, newKeys, ghostFields }}
 */
export function detectDrift({ ghostTags, state, ours, compareTo }) {
  const snapshot = followRenames(state.tags, ours);
  const { byKey, newKeys } = assignKeys(ghostTags, snapshot, ours);
  const ghostFields = new Map([...byKey].map(([k, t]) => [k, ghostToFields(t)]));
  const base = new Map([...snapshot].map(([k, e]) => [k, e.fields]));
  // compareTo 'base' reports every Ghost change since the last sync, merged or not.
  const changes = computeDrift({ base, ghost: ghostFields, ours: compareTo === 'base' ? base : ours });
  for (const c of changes) c.posts = byKey.get(c.key)?.count?.posts ?? null;
  return { changes, byKey, newKeys, ghostFields, snapshot, base };
}

/** Repo edits that accept the Ghost changes. Returns [{op:'write'|'delete', key, fields?}]. */
export function acceptDrift(changes, ours) {
  const ops = [];
  for (const c of changes) {
    if (c.kind === 'created' || c.kind === 'restored') {
      ops.push({ op: 'write', key: c.key, fields: { ...c.ghost } });
    } else if (c.kind === 'changed') {
      const fields = { ...ours.get(c.key) };
      for (const f of c.fields) fields[f.field] = f.ghost;
      ops.push({ op: 'write', key: c.key, fields });
    } else if (c.kind === 'deleted') {
      ops.push({ op: 'delete', key: c.key });
    }
  }
  return ops;
}

/**
 * Ghost edits that undo the drift: put Ghost back to the last release, or to
 * the repo version when the tag hasn't been released yet.
 * Returns Map<key, fields | null> where null means "delete from Ghost".
 */
export function revertTargets(changes) {
  const targets = new Map();
  for (const c of changes) {
    if (c.kind === 'created') {
      targets.set(c.key, null);
    } else if (c.kind === 'deleted' || c.kind === 'restored') {
      targets.set(c.key, { ...c.base });
    } else if (c.kind === 'changed') {
      const fields = { ...c.ghost };
      for (const f of c.fields) fields[f.field] = f.base === undefined ? f.ours : f.base;
      targets.set(c.key, fields);
    }
  }
  return targets;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

/**
 * A compact record of exactly which Ghost values a drift PR showed. Closing
 * the PR reverts only these, so a Ghost edit made after the PR was last updated
 * is not thrown away unseen.
 */
export function fingerprint(changes) {
  const items = [];
  for (const c of changes) {
    if (c.kind === 'changed') {
      for (const f of c.fields) items.push(`${c.key}|${f.field}|${hashValue(f.ghost)}`);
    } else if (c.kind === 'deleted') {
      items.push(`${c.key}|*|deleted`);
    } else {
      items.push(`${c.key}|*|${hashValue(c.ghost)}`);
    }
  }
  return items.sort();
}

/** Keep only the changes (and fields) whose current Ghost value matches the fingerprint. */
export function filterByFingerprint(changes, items) {
  const allowed = new Set(items);
  const kept = [];
  for (const c of changes) {
    if (c.kind === 'changed') {
      const fields = c.fields.filter((f) => allowed.has(`${c.key}|${f.field}|${hashValue(f.ghost)}`));
      if (fields.length) kept.push({ ...c, fields });
    } else if (c.kind === 'deleted') {
      if (allowed.has(`${c.key}|*|deleted`)) kept.push(c);
    } else if (allowed.has(`${c.key}|*|${hashValue(c.ghost)}`)) {
      kept.push(c);
    }
  }
  return kept;
}

const MARKER = /<!--\s*ghost-drift:([A-Za-z0-9+/=_-]+)\s*-->/;

export function fingerprintMarker(changes) {
  const data = Buffer.from(JSON.stringify(fingerprint(changes))).toString('base64url');
  return `<!-- ghost-drift:${data} -->`;
}

/** Returns the fingerprint list from a PR body, or null if there isn't one. */
export function readFingerprintMarker(text) {
  const m = MARKER.exec(text ?? '');
  if (!m) return null;
  try {
    const items = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return Array.isArray(items) ? items.map(String) : null;
  } catch {
    return null;
  }
}
