// Markdown summaries for pull requests and job summaries.
import { FIELD_BY_NAME, visibilityFor } from './fields.js';
import { fingerprintMarker } from './drift.js';

const MAX_BODY = 60000; // GitHub caps PR bodies at 65,536 characters

function label(field) {
  return FIELD_BY_NAME.get(field)?.label ?? field;
}

export function cell(value, max = 120) {
  if (value === undefined) return '_(not released yet)_';
  if (value === null) return '_empty_';
  let s = String(value);
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ⏎ ')
    .replace(/[`*_~[\]]/g, (c) => `\\${c}`);
}

function tagTitle(key, fields) {
  const name = fields?.name ? ` (${cell(fields.name, 60)})` : '';
  return `\`${key}\`${name}`;
}

function fieldsTable(fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `| ${label(k)} | ${cell(v)} |`);
  return ['| Field | Value |', '| --- | --- |', ...rows].join('\n');
}

export function describeChange(c) {
  if (c.kind === 'created') {
    const posts = c.posts ? ` It's already on ${c.posts} post${c.posts === 1 ? '' : 's'}, and Ghost will take it off ${c.posts === 1 ? 'that post' : 'them'}.` : '';
    return `### ➕ ${tagTitle(c.key, c.ghost)} was created in Ghost\n\nMerging adds \`tags/${c.key}.yaml\`. Closing **deletes it from Ghost**.${posts}\n\n${fieldsTable(c.ghost)}`;
  }
  if (c.kind === 'deleted') {
    const warn = c.conflict ? '\n\n> ⚠️ This tag was also edited in GitHub since the last release.' : '';
    return `### 🗑️ ${tagTitle(c.key, c.base)} was deleted in Ghost\n\nMerging deletes \`tags/${c.key}.yaml\`. Closing puts the tag back in Ghost, but Ghost removes a deleted tag from its posts, so you'd have to re-tag them by hand.${warn}`;
  }
  if (c.kind === 'restored') {
    return `### ♻️ ${tagTitle(c.key, c.ghost)} was edited in Ghost, but deleted in GitHub\n\nIt was deleted from this repo after the last release, and someone has since edited it in Ghost. Merging brings \`tags/${c.key}.yaml\` back with the Ghost version. Closing keeps it deleted (it'll be removed from Ghost at the next release).\n\n${fieldsTable(c.ghost)}`;
  }
  const rows = c.fields.map(
    (f) => `| ${label(f.field)} | ${cell(f.base)} | ${cell(f.ghost)} | ${cell(f.ours)}${f.conflict ? ' ⚠️' : ''} |`,
  );
  const anyConflict = c.fields.some((f) => f.conflict);
  const note = anyConflict
    ? '\n\n> ⚠️ This field was also changed in GitHub since the last release. Merging replaces the GitHub value with the Ghost one.'
    : '';
  return `### ✏️ ${tagTitle(c.key, c.ghost)} was changed in Ghost\n\n| Field | Last release | Ghost now | This repo |\n| --- | --- | --- | --- |\n${rows.join('\n')}${note}`;
}

function counts(changes) {
  const by = (k) => changes.filter((c) => c.kind === k).length;
  return [
    [by('created'), 'created'],
    [by('changed'), 'changed'],
    [by('deleted'), 'deleted'],
    [by('restored'), 'edited after being deleted here'],
  ]
    .filter(([n]) => n)
    .map(([n, w]) => `${n} ${w}`)
    .join(', ');
}

function baselineLine(state) {
  if (!state.exists) {
    return "This repo hasn't been set up yet, so every Ghost tag shows up here. Merge this PR to import them. Until it's merged, it keeps reopening.";
  }
  const when = state.deployedAt ? ` on ${state.deployedAt.slice(0, 10)}` : '';
  return `Compared with the last time Ghost and this repo were in sync (release \`${cell(state.source ?? 'unknown', 60)}\`${when}, plus any "Changes made in Ghost" PRs merged since).`;
}

/** The body of the "Changes made in Ghost" pull request. */
export function driftPrBody({ changes, state, validation }) {
  const parts = [
    `Tags were changed directly in Ghost. **${counts(changes)}.**`,
    baselineLine(state),
    [
      '**What to do**',
      '- **Merge** to keep the Ghost changes. They stay in Ghost and become part of this repo.',
      state.exists
        ? '- **Close** to throw them away. Ghost is put back the way it was at the last sync, straight away. (Edits in GitHub that are not released yet still go out at the next release.)'
        : "- **Close** does nothing until the import has been merged once, and this PR will reopen.",
      "- **Keep some, not others:** merge, then open a follow-up PR that undoes the parts you don't want. The next release sends the final version to Ghost.",
      '',
      "This PR is updated automatically while it's open. Edits pushed to this branch get overwritten, so make follow-up changes in a separate PR.",
    ].join('\n'),
  ];
  if (validation && (validation.errors.length || validation.warnings.length)) {
    const lines = [
      ...validation.errors.map((e) => `- ❌ \`${e.file}\`: ${cell(e.message, 300)}`),
      ...validation.warnings.map((w) => `- ⚠️ \`${w.file}\`: ${cell(w.message, 300)}`),
    ];
    parts.push(
      `**Checks**\n\nThe Ghost version breaks some of this repo's rules. Fix these in a follow-up PR before the next release:\n\n${lines.join('\n')}`,
    );
  }
  const marker = fingerprintMarker(changes);
  let body = parts.join('\n\n') + '\n\n---\n\n';
  const sections = changes.map(describeChange);
  let shown = 0;
  for (const s of sections) {
    if (body.length + s.length + marker.length + 500 > MAX_BODY) break;
    body += s + '\n\n';
    shown++;
  }
  if (shown < sections.length) {
    body += `_…and ${sections.length - shown} more. See the **Files changed** tab for the full list._\n\n`;
  }
  return body + marker + '\n';
}

function opLine(op) {
  if (op.op === 'create') {
    const vis = visibilityFor(op.fields) === 'internal' ? ' (internal)' : '';
    return `- ➕ Create \`${op.fields.slug}\`: ${cell(op.fields.name, 80)}${vis}`;
  }
  if (op.op === 'delete') {
    const posts =
      op.posts === null ? '' : op.posts ? ` — **removes it from ${op.posts} post${op.posts === 1 ? '' : 's'}**` : ' — not used on any posts';
    return `- 🗑️ Delete \`${op.slug}\`: ${cell(op.name, 80)}${posts}`;
  }
  const changes = op.changed
    .map((f) => (f === 'visibility' ? 'visibility' : `${label(f)}: ${cell(op.before[f], 60)} → ${cell(op.fields[f], 60)}`))
    .join('; ');
  return `- ✏️ Update \`${op.fields.slug}\`: ${changes}`;
}

/** Job summary for a deploy, revert or dry run. */
export function deployReport({ title, ops, changes = [], blocked, failed = [], dryRun, note }) {
  const out = [`## ${title}`];
  if (note) out.push(note);
  if (blocked) out.push(`> [!WARNING]\n> ${blocked.replace(/\n/g, '\n> ')}`);
  if (changes.length && dryRun) {
    out.push(
      `> [!NOTE]\n> Ghost also has changes that aren't in this repo (${counts(changes)}). A release will be blocked until the "Changes made in Ghost" pull request is merged or closed.`,
    );
  }
  if (changes.length && blocked) {
    out.push(changes.map(describeChange).join('\n\n'));
  }
  if (ops) {
    if (!ops.length) {
      out.push('Ghost already matches. Nothing to change.');
    } else {
      const verb = dryRun || blocked ? 'Would make' : 'Made';
      out.push(`${verb} ${ops.length} change${ops.length === 1 ? '' : 's'} in Ghost:\n\n${ops.map(opLine).join('\n')}`);
    }
  }
  if (failed.length) {
    out.push(
      `### ❌ ${failed.length} change${failed.length === 1 ? '' : 's'} failed\n\n${failed
        .map((f) => `- ${opLine(f.op).slice(2)}\n  - ${cell(f.error.message, 500)}`)
        .join('\n')}\n\nRe-run this job to retry. Changes that already went through will be skipped.`,
    );
  }
  return out.join('\n\n') + '\n';
}
