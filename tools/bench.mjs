// Times whole runs the way the harness does: a fresh `node main.ts` process per run, CPU time of the
// process (user + system) as Node reports it at exit, Node's own start included.
//
//   node tools/bench.mjs <kit dir> [--runs N]
//
// Runs this repository's main.ts and the kit's baseline (marked) alternately on the practice input,
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
  for (const [name, main] of Object.entries(entries)) {
    const { cpu, same } = once(main);
    if (!same) throw new Error(name + ' output differs from the reference');
    times[name].push(cpu);
  }
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const nullRun = (() => {
  const t = [];
  const empty = join(work, 'empty.mjs');
  writeFileSync(empty, '');
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
