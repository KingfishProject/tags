#!/usr/bin/env node
// Send the repo's tags to Ghost, or undo Ghost-side changes from a closed PR.
//
//   node scripts/deploy.js --mode release --source v1.2.0 --state state.json --state-out new-state.json [--dry-run] [--force]
//   node scripts/deploy.js --mode revert --state state.json --state-out new-state.json [--pr-body body.md]
//   node scripts/deploy.js --mode accept --state state.json --state-out new-state.json [--pr-body body.md]
//     (accept changes nothing in Ghost; it records merged Ghost changes as the new baseline)
//
// Needs GHOST_API_URL and GHOST_ADMIN_API_KEY.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { clientFromEnv } from '../src/ghost.js';
import { loadState, saveState } from '../src/state.js';
import { runDeploy, runRevert, runAccept } from '../src/sync.js';
import { deployReport } from '../src/report.js';
import { readFingerprintMarker } from '../src/drift.js';
import { annotate, main, setOutput, writeReport } from '../src/cli.js';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'release' },
    'tags-dir': { type: 'string', default: 'tags' },
    state: { type: 'string' },
    'state-out': { type: 'string' },
    source: { type: 'string', default: 'manual' },
    'pr-body': { type: 'string' },
    report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const BLOCKED = {
  'blocked-drift':
    'Tags were changed in Ghost, and this release doesn\'t include those changes. Deal with the "Changes made in Ghost" pull request first. If you close it, re-run this job. If you merge it, publish a new release from main (this release was made before the merge, so it would undo the Ghost changes). If there is no such pull request yet, it will open within a few minutes. To overwrite Ghost anyway, run this workflow by hand with "force" ticked.',
};

main(async () => {
  const state = loadState(values.state);
  const client = clientFromEnv();
  const tagsDir = values['tags-dir'];

  let fingerprint = null;
  if (values['pr-body'] && fs.existsSync(values['pr-body'])) {
    fingerprint = readFingerprintMarker(fs.readFileSync(values['pr-body'], 'utf8'));
  }

  if (values.mode === 'accept') {
    const r = await runAccept({ client, tagsDir, state, fingerprint, source: values.source });
    setOutput('status', r.status);
    writeReport(
      values.report,
      r.status === 'done'
        ? `## Record merged Ghost changes\n\nRecorded ${r.accepted} merged change(s) as the new starting point. Ghost wasn't changed.\n`
        : '## Record merged Ghost changes\n\nNothing to record.\n',
    );
    if (r.newState && values['state-out']) saveState(values['state-out'], r.newState);
    return 0;
  }

  if (values.mode === 'revert') {
    const r = await runRevert({ client, tagsDir, state, fingerprint, source: values.source });
    setOutput('status', r.status);
    if (r.status === 'no-state') {
      writeReport(values.report, '## Revert\n\nNothing has been released to Ghost yet, so there is nothing to revert to. Ghost was left alone.\n');
      return 0;
    }
    const note =
      r.skipped > 0
        ? `${r.skipped} Ghost change(s) made after the PR was last updated were left alone. They'll show up in a new PR.`
        : undefined;
    if (r.status === 'nothing') {
      writeReport(values.report, `## Revert\n\nGhost already matches this repo. Nothing to undo.${note ? `\n\n${note}` : ''}\n`);
      return 0;
    }
    writeReport(values.report, deployReport({ title: 'Revert Ghost changes', ops: r.ops, failed: r.failed, note }));
    if (r.newState && values['state-out']) saveState(values['state-out'], r.newState);
    return r.status === 'failed' ? 1 : 0;
  }

  if (values.mode !== 'release') throw new Error(`Unknown --mode "${values.mode}" (use release, revert or accept).`);

  const r = await runDeploy({ client, tagsDir, state, source: values.source, dryRun: values['dry-run'], force: values.force });
  setOutput('status', r.status);
  const title = values['dry-run'] ? `What a release would change in Ghost` : `Deploy ${values.source} to Ghost`;

  if (r.status === 'blocked-validation') {
    for (const e of r.validation.errors) annotate('error', e);
    writeReport(values.report, `## ${title}\n\nSome tag files break the rules, so nothing was sent to Ghost. Run \`npm run validate\` to see them.\n`);
    return 1;
  }
  if (r.status === 'blocked-drift' || r.status === 'blocked-deletes') {
    const reason =
      r.status === 'blocked-drift'
        ? BLOCKED['blocked-drift']
        : `${r.guard} That looks like a mistake, so nothing was changed. If you really mean it, run this workflow by hand with "force" ticked.`;
    annotate('error', { message: reason });
    writeReport(values.report, deployReport({ title, ops: r.ops, changes: r.changes, blocked: reason }));
    return 1;
  }
  const note = r.guard && values['dry-run'] ? `⚠️ ${r.guard} A release would refuse to do this without "force".` : undefined;
  writeReport(values.report, deployReport({ title, ops: r.ops, changes: r.changes, failed: r.failed, dryRun: values['dry-run'], note }));
  if (r.newState && values['state-out']) saveState(values['state-out'], r.newState);
  return r.status === 'failed' ? 1 : 0;
});
