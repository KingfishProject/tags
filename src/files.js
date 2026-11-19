// Reading and writing the tag files in tags/.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fieldsToFile, fileToFields } from './fields.js';

export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Load every tags/<key>.yaml file.
 * The file name (without .yaml) is the tag's "key": a stable handle that stays
 * the same even if the slug changes, so a slug rename updates the existing Ghost
 * tag instead of deleting it and making a new one.
 *
 * Returns { tags: Map<key, {fields, file}>, problems: [{file, message}] }.
 */
export function loadRepoTags(dir) {
  const tags = new Map();
  const problems = [];
  if (!fs.existsSync(dir)) return { tags, problems };
  const entries = fs.readdirSync(dir).sort();
  for (const name of entries) {
    const file = path.join(dir, name);
    if (!/\.ya?ml$/i.test(name)) continue;
    if (!fs.statSync(file).isFile()) continue;
    const key = name.replace(/\.ya?ml$/i, '');
    if (!KEY_PATTERN.test(key)) {
      problems.push({ file, message: `file name "${name}" must be lowercase letters, numbers and hyphens, ending in .yaml` });
      continue;
    }
    if (tags.has(key)) {
      problems.push({ file, message: `two files share the name "${key}" (one .yml and one .yaml)` });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    let doc;
    try {
      const parsed = YAML.parseDocument(text);
      if (parsed.errors.length) throw parsed.errors[0];
      for (const line of unquotedHashLines(parsed, text)) {
        // In YAML an unquoted "#" starts a comment, so `color: #ff0000` silently
        // becomes an empty value. Catch that before it clears a field in Ghost.
        problems.push({
          file,
          line,
          message: `value starting with "#" must be in quotes, e.g. color: "#ff0000" or name: "#internal-tag"`,
        });
      }
      doc = parsed.toJS();
    } catch (err) {
      problems.push({ file, message: `YAML syntax error: ${String(err.message).split('\n')[0]}` });
      continue;
    }
    const { fields, problems: fieldProblems } = fileToFields(doc);
    for (const message of fieldProblems) problems.push({ file, message });
    tags.set(key, { fields, file });
  }
  return { tags, problems };
}

/** Load tags and fail loudly if any file can't be read. Returns Map<key, fields>. */
export function loadRepoTagsStrict(dir) {
  const { tags, problems } = loadRepoTags(dir);
  if (problems.length) {
    const list = problems.map((p) => `  ${p.file}${p.line ? `:${p.line}` : ''}: ${p.message}`).join('\n');
    throw new Error(`Some tag files could not be read:\n${list}`);
  }
  return new Map([...tags].map(([k, v]) => [k, v.fields]));
}

/** Line numbers of `key: #...` pairs, where the "#" turned the value into a comment. */
function unquotedHashLines(doc, text) {
  const lines = [];
  YAML.visit(doc, {
    Pair(_, pair) {
      const empty = pair.value === null || (YAML.isScalar(pair.value) && pair.value.value === null);
      if (!empty || !pair.key?.range) return;
      const start = pair.key.range[0];
      const lineEnd = text.indexOf('\n', start);
      const rest = text.slice(pair.key.range[1], lineEnd === -1 ? undefined : lineEnd);
      if (/^\s*:[ \t]+#/.test(rest)) lines.push(text.slice(0, start).split('\n').length);
    },
  });
  return lines;
}

export function tagFilePath(dir, key) {
  return path.join(dir, `${key}.yaml`);
}

export function renderTagFile(fields) {
  return YAML.stringify(fieldsToFile(fields), { lineWidth: 0 });
}

export function writeTagFile(dir, key, fields) {
  fs.mkdirSync(dir, { recursive: true });
  // Drop a .yml twin so the key maps to exactly one file.
  const yml = path.join(dir, `${key}.yml`);
  if (fs.existsSync(yml)) fs.rmSync(yml);
  fs.writeFileSync(tagFilePath(dir, key), renderTagFile(fields));
}

export function deleteTagFile(dir, key) {
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dir, `${key}.${ext}`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}
