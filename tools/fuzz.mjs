// Differential checks against marked itself (loaded from the kit, never bundled):
//
//   node tools/fuzz.mjs <kit dir> [--n N] [--seed S]
//
// 1. every regex parse.js composes has exactly marked's source and flags;
// 2. the hand-written inline text scanner matches marked's gfm text regex on random strings;
// 3. parse() equals marked.parse() on random markdown built from risky fragments.
// Deterministic for a given seed; prints the first counterexamples it finds.

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const kit = resolve(args[0] ?? '../kit-md/markdown-render-speed-02-kit');
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : Number(args[i + 1]);
};
const N = opt('--n', 20000);
let seed = opt('--seed', 1) >>> 0;
const rand = () => {
  // xorshift32
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];

const { marked } = await import(pathToFileURL(join(kit, 'baselines/vendor/marked/marked.esm.js')).href);
const { parse, internals } = await import(pathToFileURL(resolve(import.meta.dirname, '../parse.js')).href);

let failures = 0;
const fail = (what, detail) => {
  failures++;
  if (failures <= 10) console.log('FAIL ' + what + ': ' + detail);
};

// 1. regex parity
const rules = marked.Lexer.rules;
for (const level of ['block', 'inline']) {
  for (const [name, re] of Object.entries(internals.regexes[level])) {
    const ref = rules[level].gfm[name];
    if (!ref) {
      fail('regex', `${level}.${name} has no counterpart`);
      continue;
    }
    if (ref.source !== re.source || ref.flags !== re.flags) fail('regex', `${level}.${name} differs`);
  }
}
console.log('regex parity checked');

// 2. text scanner
const textRe = rules.inline.gfm.text;
const textAlphabet = [
  'a', 'b', 'Z', '9', ' ', ' ', '  ', '\n', '@', '.', '-', '_', '*', '~', '`', '!', '[', '<', '\\', '(', ')',
  'http', 'HTTPS', 'ftp://', 'www.', 'mailto:', 'xmpp:', 'w', 'h', 'f', 'm', 'x', '#', '%', "'", '|', ' ', 'é',
  '\t', '&#', ';', 'user@host.com', '::',
];
for (let i = 0; i < N; i++) {
  let s = '';
  const len = 1 + Math.floor(rand() * 14);
  for (let k = 0; k < len; k++) s += pick(textAlphabet);
  const want = textRe.exec(s)?.[0].length ?? 0;
  const got = internals.textRunLength(s);
  if (want !== got) fail('text', JSON.stringify(s) + ` want ${want} got ${got}`);
}
console.log('text scanner checked');

// 3. whole documents
const blocks = [
  '# head', '## head ##', 'Setext\n===', 'Setext\n---', '---', '***', '- item', '* item', '+ item', '1. item', '2) item',
  '   - nested', '    code', '\tcode', '```js\ncode\n```', '~~~\nx\n~~~', '> quote', '> > deep', '>lazy', '<div>\nhtml\n</div>',
  '<!-- c -->', '| a | b |\n|---|:-:|\n| 1 | 2 |', 'a | b\n-- | --', '[ref]: /url "title"', '[ref]', '- [ ] task', '- [x] done',
  'para *em* **strong** ~~del~~ `code`', 'text  \nbreak', 'a\\\nb', '<http://a.b>', 'www.example.com', 'me@x.io',
  'https://x.y/z?q=(1)', '[link](/u "t")', '![img](/i.png)', '[a [b](c)](d)', '***x***', '_a_b_', '*a **b** c*', '&copy; &#35;',
  '<a href="x">', '</a>', '<pre>', '</pre>', 'line', '', '', '\n', '  ', '1\\. no', '*', '_', '~~', '[', ']', '(', ')',
];
const inlineBits = ['*', '**', '_', '__', '~', '~~', '`', '[', '](', ')', '!', '<', '>', ' ', 'a', 'b', '\\', '@', 'www.', 'http://', '&amp;', '"'];
for (let i = 0; i < N / 10; i++) {
  let md = '';
  const parts = 1 + Math.floor(rand() * 8);
  for (let k = 0; k < parts; k++) {
    if (rand() < 0.3) {
      let line = '';
      const w = 1 + Math.floor(rand() * 10);
      for (let j = 0; j < w; j++) line += pick(inlineBits);
      md += line;
    } else md += pick(blocks);
    md += pick(['\n', '\n', '\n\n', ' ', '\r\n']);
  }
  let want;
  try {
    want = marked.parse(md);
  } catch (e) {
    want = 'THREW';
  }
  let got;
  try {
    got = parse(md);
  } catch (e) {
    got = 'THREW';
  }
  if (want !== got) fail('doc', JSON.stringify(md) + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got));
}
console.log(`documents checked; ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
