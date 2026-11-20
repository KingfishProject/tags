// The three jobs: pull (Ghost → PR), deploy (release → Ghost), revert (closed PR → Ghost).
import { loadRepoTags, loadRepoTagsStrict, writeTagFile, deleteTagFile } from './files.js';
import { validateTags } from './validate.js';
import { ghostToFields } from './fields.js';
import { detectDrift, acceptDrift, revertTargets, filterByFingerprint } from './drift.js';
import { planChanges, checkDeleteGuard, applyPlan, verifyApplied } from './plan.js';

/**
 * Compare Ghost with the repo and write any Ghost-side changes into tagsDir.
 * The workflow then commits them to a branch and opens a PR.
 */
export async function runPull({ client, tagsDir, state }) {
  const ours = loadRepoTagsStrict(tagsDir);
  const ghostTags = await client.listTags();
  const { changes } = detectDrift({ ghostTags, state, ours });
  for (const op of acceptDrift(changes, ours)) {
    if (op.op === 'write') writeTagFile(tagsDir, op.key, op.fields);
    else deleteTagFile(tagsDir, op.key);
  }
  let validation = null;
  if (changes.length) {
    const { tags, problems } = loadRepoTags(tagsDir);
    validation = validateTags(tags, problems);
  }
  return { changes, validation, ghostCount: ghostTags.length };
}

/** Snapshot entries for the given keys, read back from Ghost after a deploy. */
function snapshotEntries(keys, idFor, ghostTags) {
  const byId = new Map(ghostTags.map((t) => [t.id, t]));
  const out = new Map();
  for (const key of keys) {
    const tag = byId.get(idFor(key));
    if (tag) out.set(key, { id: tag.id, fields: ghostToFields(tag) });
  }
  return out;
}

/**
 * Make Ghost match the repo (a release).
 *
 * status: 'blocked-validation' | 'blocked-drift' | 'blocked-deletes' | 'dry-run' | 'failed' | 'done'
 */
export async function runDeploy({ client, tagsDir, state, source, dryRun = false, force = false, now = new Date() }) {
  const { tags, problems } = loadRepoTags(tagsDir);
  const validation = validateTags(tags, problems);
  if (validation.errors.length) {
    return { status: 'blocked-validation', validation };
  }
  const ours = new Map([...tags].map(([k, v]) => [k, v.fields]));
  const ghostTags = await client.listTags();
  const { changes, byKey } = detectDrift({ ghostTags, state, ours });
  const ops = planChanges({ targets: ours, byKey, full: true });
  const guard = checkDeleteGuard(ops, ghostTags.length);

  if (changes.length && !force && !dryRun) {
    return { status: 'blocked-drift', changes, ops };
  }
  if (guard && !force && !dryRun) {
    return { status: 'blocked-deletes', guard, changes, ops };
  }
  if (dryRun) {
    return { status: 'dry-run', changes, ops, guard };
  }

  const { failed, createdIds } = await applyPlan(client, ops, (m) => console.log(m));
  if (failed.length) {
    return { status: 'failed', changes, ops, failed };
  }
  const after = await client.listTags();
  const idFor = (key) => createdIds.get(key) ?? byKey.get(key)?.id;
  const mismatched = verifyApplied(ops, idFor, after);
  if (mismatched.length) {
    return { status: 'failed', changes, ops, failed: mismatched };
  }
  const newState = {
    source,
    deployedAt: now.toISOString(),
    tags: snapshotEntries(ours.keys(), idFor, after),
  };
  return { status: 'done', changes, ops, failed, newState };
}

/**
 * Undo the Ghost-side changes from a closed drift PR. If `fingerprint` is
 * given, only the changes shown in that PR are reverted.
 *
 * status: 'no-state' | 'nothing' | 'failed' | 'done'
 */
export async function runRevert({ client, tagsDir, state, fingerprint = null, source }) {
  if (!state.exists) return { status: 'no-state' };
  const ours = loadRepoTagsStrict(tagsDir);
  const ghostTags = await client.listTags();
  const detected = detectDrift({ ghostTags, state, ours });
  const changes = fingerprint ? filterByFingerprint(detected.changes, fingerprint) : detected.changes;
  const skipped = detected.changes.length - changes.length;
  if (!changes.length) return { status: 'nothing', skipped };

  const targets = revertTargets(changes);
  const ops = planChanges({ targets, byKey: detected.byKey, full: false });
  const { failed, createdIds } = await applyPlan(client, ops, (m) => console.log(m));
  if (failed.length) return { status: 'failed', changes, ops, failed, skipped };

  const after = await client.listTags();
  const idFor = (key) => createdIds.get(key) ?? detected.byKey.get(key)?.id;
  const mismatched = verifyApplied(ops, idFor, after);
  if (mismatched.length) return { status: 'failed', changes, ops, failed: mismatched, skipped };
  const tagsState = new Map(detected.snapshot);
  const restored = snapshotEntries(
    [...targets].filter(([, f]) => f !== null).map(([k]) => k),
    idFor,
    after,
  );
  for (const [key, entry] of restored) {
    // Keep the released field values as the baseline; only refresh the ID
    // (a re-created tag gets a new one). For tags that were never released,
    // record what's in Ghost now.
    const prev = tagsState.get(key);
    tagsState.set(key, prev ? { id: entry.id, fields: prev.fields } : entry);
  }
  for (const [key, f] of targets) if (f === null) tagsState.delete(key);
  const newState = { source: state.source, deployedAt: state.deployedAt, tags: tagsState };
  return { status: 'done', changes, ops, failed, skipped, newState, source };
}

/**
 * After a drift PR is merged: record the Ghost changes that are now in the
 * repo as the new baseline, without touching Ghost. Otherwise a later GitHub
 * edit to the same field would make the old Ghost edit look new again, and a
 * Ghost tag that was imported but not yet released would have no recorded ID.
 *
 * Only changes that match the repo (that is, the ones that were merged) are
 * recorded, and only those listed in `fingerprint` when one is given.
 *
 * status: 'nothing' | 'done'
 */
export async function runAccept({ client, tagsDir, state, fingerprint = null, source }) {
  const ours = loadRepoTagsStrict(tagsDir);
  const ghostTags = await client.listTags();
  const detected = detectDrift({ ghostTags, state, ours, compareTo: 'base' });
  let changes = fingerprint ? filterByFingerprint(detected.changes, fingerprint) : detected.changes;

  const tagsState = new Map(detected.snapshot);
  let accepted = 0;
  for (const c of changes) {
    const o = ours.get(c.key);
    const id = detected.byKey.get(c.key)?.id;
    if (c.kind === 'created') {
      if (o && id) {
        tagsState.set(c.key, { id, fields: { ...c.ghost } });
        accepted++;
      }
    } else if (c.kind === 'deleted') {
      if (!o) {
        tagsState.delete(c.key);
        accepted++;
      }
    } else if (c.kind === 'changed' && o && id) {
      const entry = tagsState.get(c.key);
      const fields = { ...entry.fields };
      for (const f of c.fields) {
        if (o[f.field] === f.ghost) {
          fields[f.field] = f.ghost;
          accepted++;
        }
      }
      tagsState.set(c.key, { id, fields });
    }
  }
  if (!accepted) return { status: 'nothing' };
  const newState = {
    source: state.exists ? state.source : source,
    deployedAt: state.deployedAt,
    tags: tagsState,
  };
  return { status: 'done', accepted, newState };
}
