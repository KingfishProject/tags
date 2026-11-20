// The tag fields this repo manages, how they're named in the YAML files,
// and how they map onto Ghost's Admin API fields.

/**
 * Each entry:
 *  ghost  - field name in the Ghost Admin API
 *  path   - where the value lives in a tag's YAML file
 *  label  - human label (matches the Ghost admin UI)
 *  max    - maximum length, enforced by `npm run validate`
 *  kind   - 'text' | 'color' | 'url'
 */
export const FIELDS = [
  { ghost: 'name', path: ['name'], label: 'Name', max: 191, kind: 'text' },
  { ghost: 'slug', path: ['slug'], label: 'Slug', max: 191, kind: 'slug' },
  { ghost: 'description', path: ['description'], label: 'Description', max: 500, kind: 'text' },
  { ghost: 'accent_color', path: ['color'], label: 'Color', kind: 'color' },
  { ghost: 'feature_image', path: ['image'], label: 'Image', max: 2000, kind: 'url' },
  { ghost: 'meta_title', path: ['meta', 'title'], label: 'Meta title', max: 70, kind: 'text' },
  { ghost: 'meta_description', path: ['meta', 'description'], label: 'Meta description', max: 156, kind: 'text' },
  { ghost: 'canonical_url', path: ['meta', 'canonical_url'], label: 'Canonical URL', max: 2000, kind: 'url' },
  { ghost: 'twitter_image', path: ['x', 'image'], label: 'X image', max: 2000, kind: 'url' },
  { ghost: 'twitter_title', path: ['x', 'title'], label: 'X title', max: 70, kind: 'text' },
  { ghost: 'twitter_description', path: ['x', 'description'], label: 'X description', max: 125, kind: 'text' },
  { ghost: 'og_image', path: ['facebook', 'image'], label: 'Facebook image', max: 2000, kind: 'url' },
  { ghost: 'og_title', path: ['facebook', 'title'], label: 'Facebook title', max: 100, kind: 'text' },
  { ghost: 'og_description', path: ['facebook', 'description'], label: 'Facebook description', max: 65, kind: 'text' },
];

export const FIELD_NAMES = FIELDS.map((f) => f.ghost);
export const FIELD_BY_NAME = new Map(FIELDS.map((f) => [f.ghost, f]));

/** Sections that group nested fields in the YAML file. */
const SECTIONS = new Set(FIELDS.filter((f) => f.path.length > 1).map((f) => f.path[0]));
const TOP_LEVEL = new Set(FIELDS.filter((f) => f.path.length === 1).map((f) => f.path[0]));

/** Empty strings and missing values all mean "not set" (null in Ghost). */
export function normalizeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

/** An object with every managed field present, unset ones as null. */
export function emptyFields() {
  return Object.fromEntries(FIELD_NAMES.map((n) => [n, null]));
}

/** Pick the managed fields out of a Ghost API tag object. */
export function ghostToFields(tag) {
  const out = emptyFields();
  for (const name of FIELD_NAMES) out[name] = normalizeValue(tag[name]);
  return out;
}

/** Ghost marks tags whose name starts with "#" as internal. */
export function visibilityFor(fields) {
  return typeof fields.name === 'string' && fields.name.startsWith('#') ? 'internal' : 'public';
}

/** The request body for creating or updating a tag in Ghost. */
export function toGhostPayload(fields) {
  const payload = {};
  for (const name of FIELD_NAMES) payload[name] = fields[name] ?? null;
  payload.visibility = visibilityFor(fields);
  return payload;
}

/**
 * Convert a parsed YAML document into managed fields.
 * Returns { fields, problems } where problems lists unknown or malformed keys.
 */
export function fileToFields(doc) {
  const fields = emptyFields();
  const problems = [];
  if (doc === null || doc === undefined) {
    problems.push('file is empty');
    return { fields, problems };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    problems.push('file must contain a YAML mapping (key: value pairs)');
    return { fields, problems };
  }
  for (const key of Object.keys(doc)) {
    if (TOP_LEVEL.has(key)) continue;
    if (SECTIONS.has(key)) {
      const section = doc[key];
      if (section === null || section === undefined) continue;
      if (typeof section !== 'object' || Array.isArray(section)) {
        problems.push(`"${key}" must be a group of fields (for example "${key}:" followed by indented "title: ...")`);
        continue;
      }
      const allowed = FIELDS.filter((f) => f.path[0] === key).map((f) => f.path[1]);
      for (const sub of Object.keys(section)) {
        if (!allowed.includes(sub)) {
          problems.push(`unknown field "${key}.${sub}" (allowed: ${allowed.join(', ')})`);
        }
      }
      continue;
    }
    problems.push(`unknown field "${key}"`);
  }
  for (const f of FIELDS) {
    let v = doc;
    for (const part of f.path) {
      v = v && typeof v === 'object' && !Array.isArray(v) ? v[part] : undefined;
    }
    if (v !== null && v !== undefined && typeof v === 'object') {
      problems.push(`"${f.path.join('.')}" must be a single value, not a list or group`);
      continue;
    }
    fields[f.ghost] = normalizeValue(v);
  }
  return { fields, problems };
}

/** Convert managed fields into the object written to a YAML file (unset fields omitted). */
export function fieldsToFile(fields) {
  const doc = {};
  for (const f of FIELDS) {
    const value = fields[f.ghost];
    if (value === null || value === undefined) continue;
    if (f.path.length === 1) {
      doc[f.path[0]] = value;
    } else {
      doc[f.path[0]] ??= {};
      doc[f.path[0]][f.path[1]] = value;
    }
  }
  return doc;
}

export function sameFields(a, b) {
  return FIELD_NAMES.every((n) => (a?.[n] ?? null) === (b?.[n] ?? null));
}

export function differingFields(a, b) {
  return FIELD_NAMES.filter((n) => (a?.[n] ?? null) !== (b?.[n] ?? null));
}
