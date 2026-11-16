// Differential checks against marked itself (loaded from the kit, never bundled):
//
//   node tools/fuzz.mjs <kit dir> [--n N] [--seed S]
//
// 1. every regex parse.js composes has exactly marked's source and flags;
// 2. the hand-written inline text scanner matches marked's gfm text regex on random strings;
// 3. parse() equals marked.parse() on random markdown built from risky fragments;
// 4. the same for line soup, 5. for emphasis around the spans the emphasis mask rewrites, and
// 6. for emphasis among link references, defined and undefined.
// Deterministic for a given seed; prints the first counterexamples it finds. PARSE=<file> checks
// another copy of parse.js (to see that a known-bad version fails).

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
const { parse, internals } = await import(pathToFileURL(resolve(import.meta.dirname, process.env.PARSE ?? '../parse.js')).href);

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

// 2b. escaping, against marked's two escape regexes
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const refEsc = (s, strict) =>
  strict ? s.replace(/[&<>"']/g, (c) => ESC_MAP[c]) : s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC_MAP[c]);
const escAlphabet = ['&', '#', 'x', 'X', '1', '9', 'a', 'F', 'g', '_', ';', '<', '>', '"', "'", ' ', 'amp', '12345678', '1234567', 'é'];
for (let i = 0; i < N; i++) {
  let s = '';
  const len = Math.floor(rand() * 12);
  for (let k = 0; k < len; k++) s += pick(escAlphabet);
  for (const strict of [false, true]) {
    if (internals.esc(s, strict) !== refEsc(s, strict)) fail('esc', JSON.stringify(s) + ' strict=' + strict);
  }
}
console.log('escaping checked');

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
console.log('documents checked');

// 4. line soup: paragraphs interrupted (or not) by every kind of line start, emails, setext lines
const starts = ['', '', '', ' ', '  ', '   ', '    ', '\t', '> ', '- ', '* ', '+ ', '1. ', '1) ', '2. ', '# ', '###### ', '####### ',
  '```', '~~~', '<div>', '<span>', '<!--', '<?', '<!X', '| ', ':', '-', '--', '---', '***', '___', '===', '= =', '[x]: /u', '[ ] '];
const words = ['word', 'a@b.co', 'x', '*em*', '_u_', '`c`', '[l](u)', '|', ' | ', 'www.a.b', 'http://h', '\\*', '&#33;', '  ', 'mailto:a@b.c',
  '<b>', '**', '~~s~~', ':-:', '---|---', '1.', '#', '>'];
for (let i = 0; i < N / 10; i++) {
  let md = '';
  const lines = 1 + Math.floor(rand() * 10);
  for (let k = 0; k < lines; k++) {
    let line = pick(starts);
    const w = Math.floor(rand() * 5);
    for (let j = 0; j < w; j++) line += (j ? ' ' : '') + pick(words);
    md += line + (rand() < 0.15 ? '\n\n' : '\n');
  }
  if (rand() < 0.3) md = md.slice(0, -1);
  const want = marked.parse(md);
  const got = parse(md);
  if (want !== got) fail('lines', JSON.stringify(md) + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got));
}
console.log('line soup checked');

// 5. emphasis around the first span the mask rewrites (code, links, escapes, html): the closer
// search runs on the source up to there, then falls back to the mask. The fixed cases are ones
// where the anchored first alternative of the right regexes only matches in the mask.
const emFixed = ['*__ x* y `a_b` __', '_** x_ y `a*b` **', 'a *__ b* c `d_e` __ f', '**__ x** y `a_b` __', '~~a~~ `b` ~~c~~'];
const emBits = ['*', '**', '_', '__', '~', '~~', ' ', 'a', 'b', '.', '`x_y`', '`*`', '[t*](u)', '[r]', '\\*', '\\_', '<i>', '!', 'é'];
const emDocs = [...emFixed];
for (let i = 0; i < N / 10; i++) {
  let md = '';
  const w = 2 + Math.floor(rand() * 14);
  for (let j = 0; j < w; j++) md += pick(emBits);
  if (rand() < 0.2) md += '\n\n[r]: /u';
  emDocs.push(md);
}
for (const md of emDocs) {
  const want = marked.parse(md);
  const got = parse(md);
  if (want !== got) fail('emphasis', JSON.stringify(md) + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got));
}
console.log('emphasis boundary checked');

// 6. references: emphasis across full, collapsed and shortcut references, defined or not, with
// labels that only match after normalization (case, inner whitespace, escapes), so the mask's
// reference pass swaps some brackets and keeps others
const refLabels = ['foo', 'Foo', 'FOO', ' foo ', 'foo\n bar', 'foo  bar', 'Foo Bar', 'ß', 'SS', 'f\\]o', 'f\\[o', '1', 'x'];
const refBits = ['*', '**', '_', '~~', ' ', 'a', '`*`', '\\*', '!', '[', ']', '](u)', '[]', 'é'];
for (let i = 0; i < N / 10; i++) {
  let md = '';
  const w = 3 + Math.floor(rand() * 12);
  for (let j = 0; j < w; j++) {
    const r = rand();
    if (r < 0.25) md += '[' + pick(refLabels) + ']';
    else if (r < 0.35) md += '[' + pick(refBits) + pick(refLabels) + '][' + pick(refLabels) + ']';
    else md += pick(refBits);
  }
  const defs = Math.floor(rand() * 3);
  for (let d = 0; d < defs; d++) md += '\n\n[' + pick(refLabels).trim() + ']: /u' + d;
  const want = marked.parse(md);
  const got = parse(md);
  if (want !== got) fail('references', JSON.stringify(md) + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got));
}
console.log('references checked');

// 7. list items: continuation lines with tabs, odd blanks (nbsp, form feed), lazy lines, setext
// underlines and nested markers, for the index walk over an item's lines
const liIndents = ['', ' ', '  ', '   ', '    ', '     ', '\t', ' \t', '  \t', '\t\t', '      ', '\t '];
const liMarks = ['- ', '* ', '+ ', '1. ', '2) ', '10. ', '-\t', '- [ ] ', '- [x] ', '-', '1.', '> ', '>', ''];
const liBodies = ['a', 'b c', '*em*', '`c`', '# h', '```', '~~~', '<div>', '---', '***', '===', '--', 'x  ', ' ', '\f', '   ', '', '| a | b |', '|---|', '[r]: /u', 'text\\'];
for (let i = 0; i < N; i++) {
  const lines = [];
  const n = 1 + Math.floor(rand() * 8);
  for (let k = 0; k < n; k++) lines.push(pick(liIndents) + pick(liMarks) + pick(liBodies));
  const md = lines.join('\n') + (rand() < 0.3 ? '\n' : '');
  const want = marked.parse(md);
  const got = parse(md);
  if (want !== got) fail('lists', JSON.stringify(md) + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got));
}
console.log(`list items checked; ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
