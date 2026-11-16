// md-fast driver: `node /bot/main.ts` (Node 22 strips the types). Reads every case from
// /input/cases.json, renders each one on its own with parse() and writes /output/html.json, a JSON
// array with one HTML string per case, in the cases' order. MD_FAST_INPUT / MD_FAST_OUTPUT (or the
// kit's MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR) point elsewhere when run outside the container.

import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// One run renders the set once, cold: TurboFan's compile time never pays for itself here, while
// Maglev (tiered up a little earlier than by default) does. Set before parse.js is compiled; each
// flag on its own, so a V8 that does not know one still takes the others. Measured again in round
// 2 against TurboFan variants, single-threaded and lazy compilation, semi-space sizes: still best.
for (const flag of ['--no-opt', '--invocation-count-for-maglev=100']) {
  try {
    setFlagsFromString(flag);
  } catch {
    // an unknown flag only costs its speedup
  }
}

const { parse } = (await import('./parse.js')) as { parse: (markdown: string) => string };

type Case = { id: string; markdown: string };

const inputDir: string = process.env.MD_FAST_INPUT ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MD_FAST_OUTPUT ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases: Case[] = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
