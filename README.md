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

## Run it

```sh
node main.ts                                   # reads /input/cases.json, writes /output/html.json
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
node tools/check.mjs <kit dir>                 # practice set: identical cases + CPU time vs marked
node tools/fuzz.mjs <kit dir> --n 50000        # differential fuzzing against marked
node tools/bench.mjs <kit dir> --runs 15       # fresh-process CPU time, md-fast vs marked
```

The tools load marked from the competition kit; nothing of marked is shipped or run by `main.ts`.

## License

MIT (`LICENSE`). A port of [marked](https://github.com/markedjs/marked) (MIT): see `NOTICE` and
`LICENSE-marked`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
