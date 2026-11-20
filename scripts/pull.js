#!/usr/bin/env node
// Write changes made in Ghost into tags/ and produce a PR description.
//   node scripts/pull.js --state state.json --report pr-body.md
// Needs GHOST_API_URL and GHOST_ADMIN_API_KEY.
import { parseArgs } from 'node:util';
import { clientFromEnv } from '../src/ghost.js';
import { loadState } from '../src/state.js';
import { runPull } from '../src/sync.js';
import { driftPrBody } from '../src/report.js';
import { main, setOutput } from '../src/cli.js';
import fs from 'node:fs';

const { values } = parseArgs({
  options: {
    'tags-dir': { type: 'string', default: 'tags' },
    state: { type: 'string' },
    report: { type: 'string', default: 'pr-body.md' },
  },
});

main(async () => {
  const state = loadState(values.state);
  const result = await runPull({ client: clientFromEnv(), tagsDir: values['tags-dir'], state });
  console.log(`Read ${result.ghostCount} tag(s) from Ghost; ${result.changes.length} changed outside this repo.`);
  setOutput('changed', result.changes.length ? 'true' : 'false');
  if (result.changes.length) {
    fs.writeFileSync(values.report, driftPrBody({ ...result, state }));
  }
  return 0;
});
