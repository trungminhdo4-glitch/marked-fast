// Times whole runs the way the harness does: a fresh `node main.ts` process per run, CPU time of the
// process (user + system) as Node reports it at exit, Node's own start included.
//
//   node tools/bench.mjs <kit dir> [--runs N]
//
// Runs this repository's main.ts and the kit's baseline (marked) alternately (in turns, each going
// first every other run) on the practice input,
// checks that both outputs equal the reference, and prints the median CPU time of each.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const kit = resolve(args[0] ?? '../kit-md/markdown-render-speed-02-kit');
const ri = args.indexOf('--runs');
const runs = ri === -1 ? 7 : Number(args[ri + 1]);

const work = mkdtempSync(join(tmpdir(), 'md-fast-bench-'));
const hook = join(work, 'cpu-hook.mjs');
writeFileSync(
  hook,
  "process.on('exit', () => { const u = process.cpuUsage(); process.stderr.write('CPU ' + (u.user + u.system) + '\\n'); });\n",
);
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8')).cases.map((c) => c.html);

const entries = {
  'md-fast': resolve(import.meta.dirname, '../main.ts'),
  marked: join(kit, 'baselines/main.ts'),
};

function once(main) {
  const out = mkdtempSync(join(work, 'out-'));
  const r = spawnSync(process.execPath, ['--import', 'file:///' + hook.replace(/\\/g, '/'), main], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: join(kit, 'practice/input'), MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(main + ' failed: ' + r.stderr);
  const cpu = Number(/CPU (\d+)/.exec(r.stderr)[1]) / 1000;
  const html = JSON.parse(readFileSync(join(out, 'html.json'), 'utf8'));
  const same = html.length === expected.length && html.every((h, i) => h === expected[i]);
  return { cpu, same };
}

const times = { 'md-fast': [], marked: [] };
for (let r = 0; r < runs; r++) {
  // alternate who goes first, so that a machine getting busier or quieter hits both alike
  const order = Object.entries(entries);
  if (r % 2) order.reverse();
  for (const [name, main] of order) {
    const { cpu, same } = once(main);
    if (!same) throw new Error(name + ' output differs from the reference');
    times[name].push(cpu);
  }
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const nullRun = (() => {
  const t = [];
  // the control is run as an entry is, a .ts file, so it pays Node's type stripping too
  const empty = join(work, 'empty.ts');
  writeFileSync(empty, 'export {};\n');
  for (let r = 0; r < runs; r++) {
    const res = spawnSync(process.execPath, ['--import', 'file:///' + hook.replace(/\\/g, '/'), empty], { encoding: 'utf8' });
    t.push(Number(/CPU (\d+)/.exec(res.stderr)[1]) / 1000);
  }
  return median(t);
})();
const min = (x) => Math.min(...x);
console.log(`min of ${runs} runs (ms CPU): md-fast ${min(times['md-fast']).toFixed(0)}, marked ${min(times.marked).toFixed(0)}`);
const a = median(times['md-fast']);
const b = median(times.marked);
console.log(`median of ${runs} runs (ms CPU): md-fast ${a.toFixed(0)}, marked ${b.toFixed(0)}, empty node ${nullRun.toFixed(0)}`);
console.log(`net of empty node: md-fast ${(a - nullRun).toFixed(0)}, marked ${(b - nullRun).toFixed(0)}, speedup ${((b - nullRun) / (a - nullRun)).toFixed(2)}x`);
// the harness's statistic: the mean with the 2 fastest and the 2 slowest runs dropped
const trimmed = (x) => {
  const s = [...x].sort((p, q) => p - q);
  const k = s.length >= 5 ? 2 : 0;
  const kept = s.slice(k, s.length - k);
  return kept.reduce((p, q) => p + q, 0) / kept.length;
};
console.log(`trimmed mean (ms CPU): md-fast ${trimmed(times['md-fast']).toFixed(0)}, marked ${trimmed(times.marked).toFixed(0)}`);
// Windows reports process CPU in 15.6 ms steps: compare minima and medians over many runs there
if (process.platform === 'win32') console.log('(win32: CPU times come in ~15.6 ms steps; use --runs 25 or more)');
