import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const dir = '.github/workflows';

// In a plain (unquoted, non-block) YAML value, " #" starts a comment, which
// silently cuts a shell command short. An odd number of quotes is the symptom.
test('every workflow run command has balanced quotes', () => {
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const doc = YAML.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const code = step.run
          .split('\n')
          .filter((line) => !/^\s*#/.test(line)) // shell comments
          .join('\n');
        const doubles = (code.match(/"/g) ?? []).length;
        const singles = (code.replace(/"[^"]*"/g, '').match(/'/g) ?? []).length;
        assert.equal(doubles % 2, 0, `${name} › ${jobName}: unbalanced " in: ${step.run}`);
        assert.equal(singles % 2, 0, `${name} › ${jobName}: unbalanced ' in: ${step.run}`);
      }
    }
  }
});
