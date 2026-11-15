// md-fast driver: `node /bot/main.ts` (Node 22 strips the types). Reads every case from
// /input/cases.json, renders each one on its own with parse() and writes /output/html.json, a JSON
// array with one HTML string per case, in the cases' order. MD_FAST_INPUT / MD_FAST_OUTPUT (or the
// kit's MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR) point elsewhere when run outside the container.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir: string = process.env.MD_FAST_INPUT ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MD_FAST_OUTPUT ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases: Case[] = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
