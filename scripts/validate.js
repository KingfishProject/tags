#!/usr/bin/env node
// Check every file in tags/ against the rules in src/validate.js.
//   node scripts/validate.js [--tags-dir tags]
import { parseArgs } from 'node:util';
import { loadRepoTags } from '../src/files.js';
import { validateTags } from '../src/validate.js';
import { annotate, main } from '../src/cli.js';

const { values } = parseArgs({ options: { 'tags-dir': { type: 'string', default: 'tags' } } });

main(() => {
  const { tags, problems } = loadRepoTags(values['tags-dir']);
  const { errors, warnings } = validateTags(tags, problems);
  for (const w of warnings) annotate('warning', w);
  for (const e of errors) annotate('error', e);
  console.log(`${tags.size} tag file(s) checked: ${errors.length} error(s), ${warnings.length} warning(s).`);
  return errors.length ? 1 : 0;
});
