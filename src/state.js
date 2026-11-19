// The "last deployed" snapshot.
//
// After every release deploy, CI records exactly what Ghost looked like, plus
// each tag's Ghost ID, on the `ghost-state` branch. That snapshot is the common
// ancestor for a three-way comparison:
//
//   snapshot (last release) vs Ghost (now) vs repo (main)
//
// It lets the sync tell "someone edited this in Ghost" apart from "this was
// edited in GitHub and hasn't been released yet".
import fs from 'node:fs';
import { FIELD_NAMES, emptyFields, normalizeValue } from './fields.js';

export const STATE_VERSION = 1;

export function emptyState() {
  return { exists: false, source: null, deployedAt: null, tags: new Map() };
}

export function parseState(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || raw.version !== STATE_VERSION || typeof raw.tags !== 'object') {
    throw new Error(`Unrecognised state file (expected version ${STATE_VERSION}).`);
  }
  const tags = new Map();
  for (const key of Object.keys(raw.tags).sort()) {
    const entry = raw.tags[key];
    const fields = emptyFields();
    for (const n of FIELD_NAMES) fields[n] = normalizeValue(entry.fields?.[n]);
    tags.set(key, { id: String(entry.id), fields });
  }
  return { exists: true, source: raw.source ?? null, deployedAt: raw.deployed_at ?? null, tags };
}

/** Missing file (nothing deployed yet) gives an empty state. */
export function loadState(file) {
  if (!file || !fs.existsSync(file)) return emptyState();
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return emptyState();
  return parseState(text);
}

export function serializeState({ source, deployedAt, tags }) {
  const out = { version: STATE_VERSION, source, deployed_at: deployedAt, tags: {} };
  for (const key of [...tags.keys()].sort()) {
    const { id, fields } = tags.get(key);
    out.tags[key] = { id, fields: Object.fromEntries(FIELD_NAMES.map((n) => [n, fields[n] ?? null])) };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

export function saveState(file, state) {
  fs.writeFileSync(file, serializeState(state));
}
