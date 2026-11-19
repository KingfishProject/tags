// Rules every tag file must follow before it can be released to Ghost.
import { FIELDS } from './fields.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function checkUrl(value) {
  if (value.startsWith('/')) return null; // relative to the Ghost site
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must start with https:// (or http://)';
    return null;
  } catch {
    return 'is not a valid URL';
  }
}

/**
 * Validate the loaded tags.
 * @param {Map<string, {fields, file}>} tags
 * @param {Array} loadProblems problems from loadRepoTags
 * @returns {{errors: Array<{file, message}>, warnings: Array<{file, message}>}}
 */
export function validateTags(tags, loadProblems = []) {
  const errors = [...loadProblems];
  const warnings = [];
  const slugs = new Map();
  const names = new Map();

  for (const [, { fields, file }] of tags) {
    if (!fields.name) errors.push({ file, message: 'name is required' });
    if (!fields.slug) errors.push({ file, message: 'slug is required' });

    for (const f of FIELDS) {
      const value = fields[f.ghost];
      if (value === null) continue;
      if (f.max && value.length > f.max) {
        errors.push({ file, message: `${f.label} is ${value.length} characters; the limit is ${f.max}` });
      }
      if (f.kind === 'color' && !COLOR.test(value)) {
        errors.push({ file, message: `${f.label} "${value}" must be a hex color like "#1a2b3c"` });
      }
      if (f.kind === 'url') {
        const problem = checkUrl(value);
        if (problem) errors.push({ file, message: `${f.label} ${problem}` });
      }
      if (f.kind === 'slug' && !SLUG.test(value)) {
        errors.push({ file, message: `slug "${value}" may only use lowercase letters, numbers and single hyphens` });
      }
      if (f.kind === 'text' && f.ghost !== 'description' && /[\r\n]/.test(value)) {
        warnings.push({ file, message: `${f.label} contains a line break` });
      }
    }

    if (fields.slug) {
      if (slugs.has(fields.slug)) {
        errors.push({ file, message: `slug "${fields.slug}" is also used by ${slugs.get(fields.slug)}` });
      } else {
        slugs.set(fields.slug, file);
      }
    }
    if (fields.name) {
      const n = fields.name.trim().toLowerCase();
      if (names.has(n)) {
        warnings.push({ file, message: `name "${fields.name}" is also used by ${names.get(n)}` });
      } else {
        names.set(n, file);
      }
      if (fields.name !== fields.name.trim()) {
        warnings.push({ file, message: 'name has leading or trailing spaces' });
      }
      if (fields.name.startsWith('#') && fields.slug && !fields.slug.startsWith('hash-')) {
        warnings.push({ file, message: `internal tag (name starts with "#"); Ghost normally gives these a slug starting with "hash-"` });
      }
    }
  }
  return { errors, warnings };
}
