// Compares parse.js with the practice reference case by case and times it.
//
//   node tools/check.mjs <kit dir> [--runs N] [--show N] [--set <dir>] [--case <id>]
//
// --case prints one case in full: its markdown, what parse() returns and the reference.
// --set takes another drawn instance (<dir>/input/cases.json, <dir>/reference/expected.json), such as
// one the kit's generator drew from a seed of your own, in place of the practice set.
//
// <kit dir> is the unpacked competition kit (practice/input/cases.json, practice/reference/expected.json).
// Prints how many cases match, the first differing cases with the position of the first difference,
// and the CPU time of rendering every case (best of --runs), next to marked's when the kit's
// baselines/vendor/marked/marked.esm.js is there.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const kit = resolve(args[0] ?? '../kit-md/markdown-render-speed-02-kit');
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : Number(args[i + 1]);
};
const runs = opt('--runs', 3);
const show = opt('--show', 5);

const si = args.indexOf('--set');
const set = si === -1 ? join(kit, 'practice') : resolve(args[si + 1]);
const cases = JSON.parse(readFileSync(join(set, 'input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(set, 'reference/expected.json'), 'utf8')).cases;

const { parse } = await import(pathToFileURL(resolve(import.meta.dirname, '../parse.js')).href);

let ok = 0;
const bad = [];
for (let i = 0; i < cases.length; i++) {
  let got;
  try {
    got = parse(cases[i].markdown);
  } catch (e) {
    got = 'THREW ' + e.message;
  }
  const want = expected[i].html;
  if (got === want) ok++;
  else {
    let at = 0;
    while (at < got.length && got[at] === want[at]) at++;
    bad.push({ id: cases[i].id, at, got: got.slice(Math.max(0, at - 40), at + 60), want: want.slice(Math.max(0, at - 40), at + 60) });
  }
}
console.log(`identical: ${ok}/${cases.length}`);
for (const b of bad.slice(0, show)) {
  console.log(`--- ${b.id} differs at ${b.at}`);
  console.log('  got : ' + JSON.stringify(b.got));
  console.log('  want: ' + JSON.stringify(b.want));
}
if (bad.length > show) console.log(`... and ${bad.length - show} more: ${bad.slice(show).map((b) => b.id).join(' ')}`);

const ci = args.indexOf('--case');
if (ci !== -1) {
  const i = cases.findIndex((c) => c.id === args[ci + 1]);
  if (i === -1) console.log(`no case ${args[ci + 1]}`);
  else {
    const got = parse(cases[i].markdown);
    console.log(`=== ${cases[i].id} (${got === expected[i].html ? 'identical' : 'differs'})`);
    console.log('markdown: ' + JSON.stringify(cases[i].markdown));
    console.log('got     : ' + JSON.stringify(got));
    console.log('want    : ' + JSON.stringify(expected[i].html));
  }
}

function cpuMs(fn) {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t = process.cpuUsage();
    for (const c of cases) fn(c.markdown);
    const d = process.cpuUsage(t);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best;
}

const mine = cpuMs(parse);
const markedPath = join(kit, 'baselines/vendor/marked/marked.esm.js');
if (existsSync(markedPath)) {
  const { marked } = await import(pathToFileURL(markedPath).href);
  const base = cpuMs((s) => marked.parse(s));
  console.log(`cpu best of ${runs}: md-fast ${mine.toFixed(1)} ms, marked ${base.toFixed(1)} ms, speedup ${(base / mine).toFixed(2)}x`);
} else {
  console.log(`cpu best of ${runs}: md-fast ${mine.toFixed(1)} ms`);
}
process.exitCode = bad.length ? 1 : 0;
