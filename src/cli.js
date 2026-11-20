// Helpers shared by the scripts in scripts/.
import fs from 'node:fs';

export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

/** Write markdown to a file, or append it to the GitHub job summary. */
export function writeReport(file, markdown) {
  if (file) fs.writeFileSync(file, markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && summary !== file) fs.appendFileSync(summary, markdown + '\n');
  if (!file && !summary) console.log(markdown);
}

/** GitHub Actions annotation (shows inline on the PR's Files tab). */
export function annotate(level, { file, line, message }) {
  const where = [file && `file=${file}`, line && `line=${line}`].filter(Boolean).join(',');
  const clean = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}${where ? ' ' + where : ''}::${clean}`);
  else console.log(`${level}: ${file ?? ''}${line ? ':' + line : ''} ${message}`);
}

export async function main(fn) {
  try {
    const code = await fn();
    process.exitCode = code ?? 0;
  } catch (err) {
    annotate('error', { message: err.message });
    if (process.env.DEBUG) console.error(err);
    process.exitCode = 1;
  }
}
