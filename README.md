# marked-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/trungminhdo4-glitch/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/trungminhdo4-glitch/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free drop-in for `marked.parse(markdown)` (marked 18.1.3, default options: GFM on):
`parse.js` returns the same HTML, code unit for code unit, about twice as fast in a cold one-shot
Node run.

How it gets there (see the header of `parse.js`):

- marked's grammar and tokenizer quirks are kept exactly (the regexes are composed the same way and
  checked against marked's own sources), but the lexer loop, the renderer and the data flow are new;
- inline content is rendered straight to HTML while it is lexed; a plain mode renders image alt text;
- the inline loop dispatches on the first character instead of trying every tokenizer;
- marked's hottest regex, the inline text run, is a scanner with one native stop search;
- the emphasis mask and the last possible closers are built lazily, and intraword `_` is refused
  without them;
- list items walk lines by index; paragraphs, setext headings and tables are pre-screened;
- `main.ts` turns TurboFan off for the single cold pass (Maglev only).

## Round 2

About a fifth less CPU for a whole `node main.ts` run on the practice set (local, 31 interleaved
runs: minimum 515 → 405 ms, median 609 → 484 ms), with the output unchanged:

- `parse()` flattens its result before returning it, so the concatenation trees of 720 cases do
  not age into the old generation and get flattened by the final `JSON.stringify`;
- escaping is done by native searches and replaces (marked's own regex for a loose `&`);
- below the first `[`, `` ` ``, `\` or `<` the emphasis mask equals the source, so emphasis and
  strikethrough look for their closer there first and build the mask only when the search leaves
  that part (the anchored, lazy first alternative of the closer regexes is guarded on its own);
- the mask's escape pass is skipped when it cannot change anything; fill strings are cached;
- smaller things: the setext underline search stops at the next blank line, table rows without a
  backslash split on `|` directly, ASCII tables answer the delimiter punctuation checks.

`tools/fuzz.mjs` gained a section that drives emphasis across the mask boundary.

## Round 3

A small step, measured on a busy laptop (Node 24), so take the numbers as rough:

- `main.ts` also sets `--no-regexp-tier-up`: each regex is compiled to native code once, on its
  first run, instead of to bytecode first and natively again right after. The cold spec cases
  (they run first and pay the compiles) take about a quarter less; one cold pass over the practice
  set, 20 interleaved fresh processes: median 288 → 268 ms wall, 328 → 312 ms CPU. For a whole
  `node main.ts` run (Node's start and type stripping included) the difference stays inside the
  noise of 25 interleaved runs.
- Tried and dropped (no measurable change): building the mask's span pass with an exec loop, a
  pre-screen for the reference pass, decoding entities once per text run instead of per piece,
  more V8 flags (Sparkplug eagerly, eager feedback, single-threaded GC, regex tier-up ticks).
- Tools: fuzz section 6 (emphasis among defined and undefined link references), `PARSE=<file>`
  for `check.mjs`, and `bench.mjs` uses a `.ts` control and prints the harness's trimmed mean.

## Round 4

Less work per inline step and per list line, output unchanged (practice set and six sets drawn
from own seeds: 720/720 each; fuzzing 0 differences):

- the inline loop no longer scans each source for `*`, `_`, `~` and `)` up front: a delimiter it
  stands on is in the source anyway, and the last `)` is looked up once, on the first `[`;
- pending plain text is kept as a range of the source while nothing in it is decoded, and is
  escaped only when one of `&<>"'` lies in that range (the next one is tracked);
- the emphasis mask's three passes run as exec loops that rewrite only the matches that change
  something, instead of `replace()` with a callback per match;
- the text run's stop search uses `test()`: where the match starts follows from how it ends;
- list items walk their continuation lines by index and cut a line out as a string only where a
  probe, a lazy continuation or the item's content needs it; the content is joined once;
- regex work that cannot match is skipped: unescaping without a backslash, newline replacement in
  code spans without a newline, `cleanUrl` by one native search, and emphasis whose run is
  followed by whitespace is refused before the left-delimiter regex.

Measured on a laptop that other jobs kept 40-60 % busy (Node 24), so rough: one cold pass over the
practice set in a fresh process, 50 interleaved runs, median wall 339 → 320 ms against round 3
(about 11 % in a quieter spell); warm passes 9-14 % less. Whole `node main.ts` runs stayed inside
the noise of Windows' 15.6 ms CPU steps. Tried and dropped: single-threaded GC and compilation
flags (no change); GC flags such as `--no-concurrent-marking` set at run time can abort V8.

## Round 5

Housekeeping before the resubmission, `parse.js`'s output unchanged (practice set and the six own
sets: 720/720 each; fuzzing 0 differences):

- `tools/check.mjs` prints the Node version and the set it checked next to the match count, since
  the harness runs Node 22 and local numbers here come from Node 24;
- `tools/bench.mjs` fails with a clear message when a run prints no CPU line, instead of a
  `TypeError` on the missing match;
- `package.json` carries a description and is marked private (nothing here is published to npm);
- notes in `main.ts`, `NOTICE`, `.gitattributes`, `.gitignore` and the licence headers.

## Run it

```sh
node main.ts                                   # reads /input/cases.json, writes /output/html.json
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
node tools/check.mjs <kit dir>                 # practice set: identical cases + CPU time vs marked
node tools/fuzz.mjs <kit dir> --n 50000        # differential fuzzing against marked
node tools/bench.mjs <kit dir> --runs 15       # fresh-process CPU time, md-fast vs marked
npm run check / npm run fuzz / npm run bench   # the same with the kit next to this repo
```

The tools load marked from the competition kit; nothing of marked is shipped or run by `main.ts`.

## License

MIT (`LICENSE`). A port of [marked](https://github.com/markedjs/marked) (MIT): see `NOTICE` and
`LICENSE-marked`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
