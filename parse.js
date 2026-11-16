// md-fast: a dependency-free Markdown renderer that returns exactly what marked 18.1.3's
// marked.parse(markdown) returns with marked's default options (gfm on, breaks off, pedantic off).
//
// This is a port of marked's algorithm (MIT, see NOTICE and LICENSE-marked): the block and inline
// grammar, their regular expressions and every quirk of marked's tokenizers are kept, because the
// output has to match marked code unit for code unit. What is new is how the work is done:
//   - one fixed configuration (gfm), no option objects, extension hooks, renderer classes or
//     token walks;
//   - inline content is rendered straight to HTML while it is lexed (no inline token trees), with a
//     second "plain" mode for image alt text instead of marked's TextRenderer;
//   - the inline loop dispatches on the first character instead of trying every tokenizer;
//   - marked's inline text regex (the hottest regex) is replaced by a hand-written scanner;
//   - the emphasis mask and closer index are computed lazily, only when emphasis is tried;
//   - list scanning walks lines by index instead of splitting the rest of the document per line;
//   - setext headings, tables and paragraphs are pre-screened before their expensive regexes run.
// Nothing is cached across calls: parse() builds all of its state per call.

// ---------------------------------------------------------------------------------------------
// Regex construction (mirrors how marked composes its grammar so the sources come out identical)

const CARET = /(^|[^\[])\^/g;

function grammar(base, flags = '') {
  let src = typeof base === 'string' ? base : base.source;
  const g = {
    put(name, value) {
      let v = typeof value === 'string' ? value : value.source;
      v = v.replace(CARET, '$1');
      src = src.replace(name, v);
      return g;
    },
    make() {
      return new RegExp(src, flags);
    },
  };
  return g;
}

// ---- shared pieces
const HTML_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const P_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const P_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const P_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const P_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const P_HEADING_START = ' {0,3}#{1,6}(?:\\s|$)';
const P_FENCE_START = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const P_HTML_START =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const PARA_BASE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

// ---- block grammar (gfm)
const B_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const B_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const B_FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const B_HR = P_HR;
const B_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const B_LHEADING = grammar(
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
)
  .put(/bull/g, P_BULLET)
  .put(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .put(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .put(/blockquote/g, / {0,3}>/)
  .put(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .put(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .put(/html/g, / {0,3}<[^\n>]+>\n/)
  .put(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .make();
const B_DEF = grammar(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .put('label', P_LABEL)
  .put('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .make();
const B_LIST = grammar(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).put(/bull/g, P_BULLET).make();
const B_HTML = grammar(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .put('comment', P_COMMENT)
  .put('tag', HTML_TAGS)
  .put('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .make();
const B_TABLE = grammar(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .put('hr', P_HR)
  .put('heading', P_HEADING_START)
  .put('blockquote', ' {0,3}>')
  .put('code', '(?: {4}| {0,3}\t)[^\\n]')
  .put('fences', P_FENCE_START)
  .put('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .put('html', P_HTML_START)
  .put('tag', HTML_TAGS)
  .make();
const B_PARAGRAPH = grammar(PARA_BASE)
  .put('hr', P_HR)
  .put('heading', P_HEADING_START)
  .put('|lheading', '')
  .put('table', B_TABLE)
  .put('blockquote', ' {0,3}>')
  .put('fences', P_FENCE_START)
  .put('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .put('html', P_HTML_START)
  .put('tag', HTML_TAGS)
  .make();
// The paragraph used inside block quotes (marked's normal, non-gfm paragraph with a looser list).
const BQ_PARAGRAPH = grammar(PARA_BASE)
  .put('hr', P_HR)
  .put('heading', P_HEADING_START)
  .put('|lheading', '')
  .put('|table', '')
  .put('blockquote', ' {0,3}>')
  .put('fences', P_FENCE_START)
  .put('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .put('html', P_HTML_START)
  .put('tag', HTML_TAGS)
  .make();
const B_BLOCKQUOTE = grammar(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .put('paragraph', BQ_PARAGRAPH)
  .make();
const B_TEXT = /^[^\n]+/;

// What may interrupt a gfm paragraph at the start of its next line: the negative lookahead of
// B_PARAGRAPH, cut out of its source so it stays exactly marked's, used as a sticky probe.
const PARA_INTERRUPT = (() => {
  const src = B_PARAGRAPH.source;
  const head = '^([^\\n]+(?:\\n(?!';
  const tail = ')[^\\n]+)*)';
  if (!src.startsWith(head) || !src.endsWith(tail)) throw new Error('paragraph grammar changed');
  return new RegExp('(?:' + src.slice(head.length, src.length - tail.length) + ')', 'y');
})();
// A setext underline: where an lheading can end (B_LHEADING's tail) ...
const SETEXT_UNDERLINE = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/g;
// ... and a blank line, which no lheading can cross.
const BLANK_LINE_BREAK = /\n[ \t]*\n/g;
// first characters (after up to three spaces) of every paragraph interruption except the table one
const CH_PARA_STOP = new Uint8Array(128);
for (const ch of ' \t-_*#>`~<+1') CH_PARA_STOP[ch.charCodeAt(0)] = 1;

// ---- inline grammar (gfm)
const U_PUNCT = /[\p{P}\p{S}]/u;
const U_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const U_NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const U_PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const U_PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const U_NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const I_PUNCTUATION = grammar(/^((?![*_])punctSpace)/, 'u').put(/punctSpace/g, U_PUNCT_SPACE).make();
const I_BLOCK_SKIP = grammar(/link|precode-code|html/, 'g')
  .put('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .put('precode-', '(?<!`)()')
  .put('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .put('html', /<(?! )[^<>]*?>/)
  .make();
const I_EM_LEFT = grammar(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .put(/punct/g, U_PUNCT_NO_TILDE)
  .make();
const I_EM_RIGHT_AST = grammar(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
  'gu',
)
  .put(/notPunctSpace/g, U_NOT_PUNCT_SPACE_OR_TILDE)
  .put(/punctSpace/g, U_PUNCT_SPACE_NO_TILDE)
  .put(/punct/g, U_PUNCT_NO_TILDE)
  .make();
const I_EM_RIGHT_UND = grammar(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
  'gu',
)
  .put(/notPunctSpace/g, U_NOT_PUNCT_SPACE)
  .put(/punctSpace/g, U_PUNCT_SPACE)
  .put(/punct/g, U_PUNCT)
  .make();
const I_DEL_LEFT = grammar(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').put(/punct/g, U_PUNCT).make();
const I_DEL_RIGHT = grammar(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
  'gu',
)
  .put(/notPunctSpace/g, U_NOT_PUNCT_SPACE)
  .put(/punctSpace/g, U_PUNCT_SPACE)
  .put(/punct/g, U_PUNCT)
  .make();
const I_ANY_PUNCT = grammar(/\\(punct)/, 'gu').put(/punct/g, U_PUNCT).make();
const I_ANY_PUNCT_OUTSIDE_CODE = grammar(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .put(/punct/g, U_PUNCT)
  .make();
const I_AUTOLINK = grammar(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .put('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .put(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .make();
const I_TAG = grammar(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .put('comment', grammar(P_COMMENT).put('(?:-->|$)', '-->').make())
  .put('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .make();
const P_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const P_LINK_LABEL = grammar(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .put('brackets', P_BRACKETS)
  .make();
const I_LINK = grammar(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .put('label', P_LINK_LABEL)
  .put('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .put('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .make();
const I_REFLINK = grammar(/^!?\[(label)\]\[(ref)\]/).put('label', P_LINK_LABEL).put('ref', P_LABEL).make();
const I_NOLINK = grammar(/^!?\[(ref)\](?:\[\])?/).put('ref', P_LABEL).make();
const P_SEARCH_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const P_SEARCH_LABEL = grammar(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .put('brackets', P_BRACKETS)
  .make();
const I_REFLINK_SEARCH = grammar('reflink|nolink(?!\\()', 'g')
  .put('reflink', grammar(/^!?\[(label)\]\[(ref)\]/).put('label', P_SEARCH_LABEL).put('ref', P_SEARCH_REF).make())
  .put('nolink', grammar(/^!?\[(ref)\](?:\[\])?/).put('ref', P_SEARCH_REF).make())
  .make();
const P_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const P_URL_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const I_URL = grammar(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .put('emailProtocol', grammar(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).put(/email/g, P_URL_EMAIL).make())
  .put('protocol', P_PROTOCOL)
  .put('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .make();
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// ---- small helpers marked keeps in its "other" table
const R_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const R_LINK_TEXT_BRACKETS = /\\([\[\]])/g;
const R_FENCE_INDENT = /^(\s+)(?:```)/;
const R_LEADING_WS = /^\s+/;
const R_LEADING_SPACE_TAB = /^[ \t]+/;
const R_NON_SPACE = /[^ ]/;
const R_BLANK_LINE = /^[ \t]*$/;
const R_BQ_START = /^ {0,3}>/;
const R_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const R_BQ_MARKER = /^ {0,3}>[ \t]?/gm;
const R_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const R_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const R_TASK = /^\[[ xX]\][ \t]+/;
const R_TASK_BOX = /\[[ xX]\]/;
const R_ANY_LINE = /\n.*\n/;
const R_HREF_BRACKETS = /^<(.*)>$/;
const R_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const R_TABLE_ROW_BLANK = /\n[ \t]*$/;
const R_ALIGN_RIGHT = /^ *-+: *$/;
const R_ALIGN_CENTER = /^ *:-+: *$/;
const R_ALIGN_LEFT = /^ *:-+ *$/;
const R_START_A = /^<a /i;
const R_END_A = /^<\/a>/i;
const R_START_RAW = /^<(pre|code|kbd|script)(\s|>)/i;
const R_END_RAW = /^<\/(pre|code|kbd|script)(\s|>)/i;
const R_ALNUM_UNICODE = /[\p{L}\p{N}]/u;
const R_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const R_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const R_CRLF = /\r\n|\r/g;
const R_WS_RUN = /\s+/g;
const R_LIST_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
// The emphasis mask hides a link, code span or html tag as '[' + 'a' * (length - 2) + ']'; the
// fill strings are made once per length.
const FILLS = [];
function blockFill(all) {
  const n = all.length;
  let f = FILLS[n];
  if (f === undefined) f = FILLS[n] = '[' + 'a'.repeat(n - 2) + ']';
  return f;
}

const PLUSES = '+++';
const AS = 'a'.repeat(1024);

/**
 * `s.replace(I_ANY_PUNCT_OUTSIDE_CODE, (all, ticks, esc) => esc ? '+'.repeat(all.length) : ticks ?
 * ticks + all.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : all)` without the
 * callback: only the matches that change something are rewritten.
 */
function maskEscapes(s) {
  const re = I_ANY_PUNCT_OUTSIDE_CODE;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const all = m[0];
    let rep;
    if (m[2] !== undefined) rep = PLUSES.slice(0, all.length);
    else {
      const ticks = m[1];
      if (ticks === undefined) continue;
      const t = ticks.length;
      // a code span whose body holds no backtick stays as it is
      if (all.indexOf('`', t) >= all.length - t) continue;
      rep = ticks + all.slice(t, -t).replace(/`/g, '+') + ticks;
    }
    out += s.slice(last, m.index) + rep;
    last = m.index + all.length;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** `s.replace(I_BLOCK_SKIP, blockFill)` without the callback. */
function maskSpans(s) {
  const re = I_BLOCK_SKIP;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = m[0].length;
    out += s.slice(last, m.index) + (n - 2 <= AS.length ? '[' + AS.slice(0, n - 2) + ']' : blockFill(m[0]));
    last = m.index + n;
  }
  return last === 0 ? s : out + s.slice(last);
}

// emphasis fast path: where a span of the mask can start, the delimiters the right regexes look for,
// and the answer of a closer search that left the part where the source equals the mask
const R_MASK_START = /[\[`\\<]/;
const R_EM_DELIM = /[_*]/g;
const UNSURE = { unsure: true };

// Line-start probes used by list items, one per indentation 0..3 (marked builds them on demand).
const listProbes = [];
for (let n = 0; n < 4; n++) {
  listProbes.push({
    bullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
    hr: new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
    fences: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
    heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
    html: new RegExp(
      `^ {0,${n}}(?:</?(?:${HTML_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
    blockquote: new RegExp(`^ {0,${n}}>`),
  });
}
function probesFor(indent) {
  return listProbes[Math.max(0, Math.min(3, indent - 1))];
}
const itemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const ITEM_DASH = itemRegex('\\-');
const ITEM_STAR = itemRegex('\\*');
const ITEM_PLUS = itemRegex('\\+');
const ITEM_DOT = itemRegex('\\d{1,9}\\.');
const ITEM_PAREN = itemRegex('\\d{1,9}\\)');

// ---------------------------------------------------------------------------------------------
// String helpers

/**
 * marked's escape(): `strict` escapes every &, otherwise an & that starts an entity or a numeric
 * reference (`&(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`) is kept. Without TurboFan a JS character
 * loop is slow, so the work is left to native searches and replaces.
 */
const R_ESC_ANY = /[&<>"']/;
const R_ESC_NEXT = /[&<>"']/g;
function esc(s, strict) {
  const first = s.search(R_ESC_ANY);
  if (first === -1) return s;
  // one native replace per character that occurs (& first): flat results, no JS loop, no callback
  let out = s;
  if (out.indexOf('&', first) !== -1) out = out.replace(strict ? R_AMP : R_AMP_LOOSE, '&amp;');
  if (out.indexOf('<', first) !== -1) out = out.replace(R_LT, '&lt;');
  if (out.indexOf('>', first) !== -1) out = out.replace(R_GT, '&gt;');
  if (out.indexOf('"', first) !== -1) out = out.replace(R_QUOT, '&quot;');
  if (out.indexOf("'", first) !== -1) out = out.replace(R_APOS, '&#39;');
  return out;
}
// marked's own: in loose mode an & that starts an entity or a numeric reference stays
const R_AMP_LOOSE = /&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const R_AMP = /&/g;
const R_LT = /</g;
const R_GT = />/g;
const R_QUOT = /"/g;
const R_APOS = /'/g;

/** `s.replace(I_ANY_PUNCT, '$1')`: backslash escapes of punctuation dropped (none without a backslash) */
function unescapePunct(s) {
  return s.includes('\\') ? s.replace(I_ANY_PUNCT, '$1') : s;
}

/** Decodes numeric character references in inline text (and turns stray & into &amp; then). */
function decodeNumeric(s) {
  if (s.indexOf('&#') === -1 || !R_NUM_REF.test(s)) return s;
  return s.replace(R_NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return cp === 38 ? '&amp;' : String.fromCodePoint(cp);
  });
}

// characters encodeURI() leaves alone, plus '%' (which marked's %25 -> % undo turns back into itself)
const CH_URI_SAFE = new Uint8Array(128);
for (let c = 0; c < 128; c++) if (CH_ALNUM_INIT(c)) CH_URI_SAFE[c] = 1;
for (const ch of "-_.!~*'();/?:@&=+$,#%") CH_URI_SAFE[ch.charCodeAt(0)] = 1;
function CH_ALNUM_INIT(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// the complement of CH_URI_SAFE, for one native search instead of a character loop
const R_URI_UNSAFE = /[^A-Za-z0-9\-_.!~*'();/?:@&=+$,#%]/;
for (let c = 0; c < 128; c++) {
  if (R_URI_UNSAFE.test(String.fromCharCode(c)) !== (CH_URI_SAFE[c] !== 1)) throw new Error('uri tables differ');
}

function cleanUrl(href) {
  if (!R_URI_UNSAFE.test(href)) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Removes a run of `ch` from the end of `s` (marked's rtrim). */
function trimEndChar(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Drops trailing blank lines from a code or html block, as marked does (one is kept as is). */
function trimBlankTail(s) {
  let k = s.length - 1;
  while (k >= 0) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9 && c !== 10) break;
    k--;
  }
  let newlines = 0;
  for (let i = k + 1; i < s.length; i++) if (s.charCodeAt(i) === 10) newlines++;
  if (k < 0) return newlines === 0 ? s : '';
  if (newlines <= 1) return s;
  const cut = s.indexOf('\n', k + 1);
  return s.slice(0, cut);
}

function normalizeLabel(s) {
  return s.trim().replace(R_WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function expandTabs(s, col = 0) {
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** `s.replace(/^[ \t]+/, (v) => expandTabs(v, col))` without the regex: spaces alone stay as they are. */
function expandLeading(s, col) {
  let i = 0;
  let tab = false;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 9) tab = true;
    else if (c !== 32) break;
    i++;
  }
  return tab ? expandTabs(s.slice(0, i), col) + s.slice(i) : s;
}

/** `s.search(/[^ ]/)` */
function firstNonSpace(s) {
  const n = s.length;
  for (let i = 0; i < n; i++) if (s.charCodeAt(i) !== 32) return i;
  return -1;
}

// first characters (after up to three spaces) that can start a fence, heading, html block,
// block quote, list bullet or thematic break: the list item probes need one of them
const CH_PROBE = new Uint8Array(128);
for (const ch of '`~#<>*+-_0123456789') CH_PROBE[ch.charCodeAt(0)] = 1;

/** Could any of the list item probes (all `^ {0,n}X`) match `line`? */
function probeCandidate(line) {
  let k = 0;
  while (k < 4 && line.charCodeAt(k) === 32) k++;
  if (k > 3) return false;
  const c = line.charCodeAt(k);
  return c < 128 && CH_PROBE[c] === 1;
}

/**
 * End of the gfm paragraph that starts at 0: what B_PARAGRAPH would match. Lines are taken one at
 * a time; only a line that could start an interruption runs the (exact) interruption probe.
 */
function paragraphEnd(src) {
  const n = src.length;
  let pos = src.indexOf('\n');
  if (pos === -1) return n;
  for (;;) {
    const ls = pos + 1;
    if (ls >= n) return pos;
    const c = src.charCodeAt(ls);
    if (c === 10) return pos;
    let next = src.indexOf('\n', ls);
    if (next === -1) next = n;
    let quick = c >= 128 || CH_PARA_STOP[c] !== 1;
    if (quick && next < n) {
      // the table interruption needs the line after this one to open a delimiter row
      let k = next + 1;
      let sp = 0;
      while (sp < 3 && src.charCodeAt(k) === 32) {
        k++;
        sp++;
      }
      const d = src.charCodeAt(k);
      if (d === 124 || d === 58 || d === 45) quick = false;
    }
    if (!quick) {
      PARA_INTERRUPT.lastIndex = ls;
      if (PARA_INTERRUPT.test(src)) return pos;
    }
    if (next >= n) return n;
    pos = next;
  }
}

/** Last code point of the (at most) two code units before `l`, as `[...s.slice(l - 2, l)].at(-1)`. */
function codePointBefore(s, l) {
  if (l <= 0) return '';
  const lo = s.charCodeAt(l - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && l >= 2) {
    const hi = s.charCodeAt(l - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(l - 2, l);
  }
  return s[l - 1];
}

// ASCII answers of I_PUNCTUATION and R_ALNUM_UNICODE, taken from the regexes themselves; the
// emphasis checks ask them about one character at a time, mostly ASCII.
const CH_PUNCT = new Uint8Array(128);
const CH_LN = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  CH_PUNCT[c] = I_PUNCTUATION.test(ch) ? 1 : 0;
  CH_LN[c] = R_ALNUM_UNICODE.test(ch) ? 1 : 0;
}

/** `!!I_PUNCTUATION.exec(s)`: the first code point is whitespace, punctuation or a symbol, not * or _ */
function isPunct(s) {
  if (s.length === 0) return false;
  const c = s.charCodeAt(0);
  return c < 128 ? CH_PUNCT[c] === 1 : I_PUNCTUATION.exec(s) !== null;
}

/** `!!s.match(R_ALNUM_UNICODE)` */
function hasAlnum(s) {
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    if (c < 128) return CH_LN[c] === 1;
  }
  return R_ALNUM_UNICODE.test(s);
}

/** `[...s][0].length` for a non-empty `s` */
function firstCodePointLength(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) {
    const d = s.charCodeAt(1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

/** `[...s].at(-1).length` for a non-empty `s` */
function lastCodePointLength(s) {
  const n = s.length;
  const c = s.charCodeAt(n - 1);
  if (c >= 0xdc00 && c <= 0xdfff && n > 1) {
    const d = s.charCodeAt(n - 2);
    if (d >= 0xd800 && d <= 0xdbff) return 2;
  }
  return 1;
}

function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** Index of the bracket closing an unbalanced run, -1 when balanced, -2 when left open. */
function findClosing(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let level = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === open) level++;
    else if (ch === close) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

/** True when the last char of `s` (after trailing blanks) closes a blank line: /\n[ \t]*\n[ \t]*$/ */
function endsWithBlankLine(s) {
  let i = s.length - 1;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  if (i < 0 || s.charCodeAt(i) !== 10) return false;
  i--;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  return i >= 0 && s.charCodeAt(i) === 10;
}

function splitCells(row, count) {
  const slash = row.includes('\\');
  // without a backslash every pipe becomes ' |' and the split takes each of them: a plain split
  const cells = slash
    ? row
        .replace(/\|/g, (m, at, str) => {
          let escaped = false;
          let p = at;
          while (--p >= 0 && str[p] === '\\') escaped = !escaped;
          return escaped ? '|' : ' |';
        })
        .split(/ \|/)
    : row.split('|');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  if (slash) for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  else for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
  return cells;
}

function fenceIndent(raw, text) {
  const m = raw.match(R_FENCE_INDENT);
  if (m === null) return text;
  const indent = m[1].length;
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(R_LEADING_WS);
      return lead === null ? line : line.slice(Math.min(lead[0].length, indent));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Character classes for the inline scanner

const CH_ALNUM = new Uint8Array(128);
const CH_EMAIL = new Uint8Array(128); // [a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]
const CH_STOP = new Uint8Array(128); // [\\<!\[`*~_]
const CH_URL_START = new Uint8Array(128); // [A-Za-z0-9._+-]
for (let c = 48; c <= 57; c++) CH_ALNUM[c] = 1;
for (let c = 65; c <= 90; c++) CH_ALNUM[c] = 1;
for (let c = 97; c <= 122; c++) CH_ALNUM[c] = 1;
for (let c = 0; c < 128; c++) {
  if (CH_ALNUM[c]) CH_EMAIL[c] = CH_URL_START[c] = 1;
}
for (const ch of ".!#$%&'*+/=?_`{|}~-") CH_EMAIL[ch.charCodeAt(0)] = 1;
for (const ch of '\\<![`*~_') CH_STOP[ch.charCodeAt(0)] = 1;
for (const ch of '._+-') CH_URL_START[ch.charCodeAt(0)] = 1;

function isJsSpace(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

const isAlnum = (c) => c < 128 && CH_ALNUM[c] === 1;
const isEmailChar = (c) => c < 128 && CH_EMAIL[c] === 1;

/** ` {2,}\n` at i */
function hardBreakAt(s, i) {
  let j = i;
  while (s.charCodeAt(j) === 32) j++;
  return j - i >= 2 && s.charCodeAt(j) === 10;
}

/** `[email chars]+@` at i */
function emailAt(s, i) {
  let j = i;
  const n = s.length;
  while (j < n && isEmailChar(s.charCodeAt(j))) j++;
  return j > i && s.charCodeAt(j) === 64;
}

function mailSchemeAt(s, i) {
  return s.startsWith('mailto:', i) || s.startsWith('xmpp:', i);
}

function httpAt(s, i) {
  return (
    (s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 116 && (s.charCodeAt(i + 3) | 32) === 112
  );
}

function ftpAt(s, i) {
  return (s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 112 && s.startsWith('://', i + 3);
}

/**
 * Length of the plain-text run at the start of `s`: exactly what marked's gfm inline text regex
 * matches, written as a scanner (it is the hottest regex of all, and this one never backtracks).
 */
//
// The regex's lazy part stops at the first position q (from `pos` on) where one of these holds:
//   d1  s[q] is one of \ < ! [ ` * ~ _, or "http"/"ftp://" (any case) or "www." after [\s*_~(] starts
//   d2  s[q] is not a space and is followed by two or more spaces and a newline     -> ends at q + 1
//   d3  s[q] is not alphanumeric and is followed by "mailto:" or "xmpp:"           -> ends at q + 1
//   d4  s[q] is not an email char and is followed by `[email chars]+@`             -> ends at q + 1
// Every firing position ends the run at q or q + 1, so the earliest end over all four is the answer.
// d1-d3 are found by one native search (TEXT_STOP: each match index is where the run ends); d4 only
// depends on where the '@' signs are.
const TEXT_STOP =
  /[\\<!\[`*~_]|[hH][tT][tT][pP]|[fF][tT][pP]:\/\/|(?<=[\s*_~(])www\.|(?<=[^ ]) {2,}\n|(?<=[^a-zA-Z0-9])(?:mailto|xmpp):/g;

/**
 * Length of the plain-text run at the start of `s`: exactly what marked's gfm inline text regex
 * matches. `at` is the index of the first '@' in `s` at or after 1 (-1: none), which the caller
 * tracks so that long paragraphs are not searched again for every run.
 */
function textRunLength(s, at = s.indexOf('@', 1)) {
  const n = s.length;
  let c = s.charCodeAt(0);
  if (!isAlnum(c) && mailSchemeAt(s, 1)) return 1;
  let pos = 1;
  if (c === 96 || c === 126) while (pos < n && s.charCodeAt(pos) === c) pos++;
  if (pos >= n) return n;
  c = s.charCodeAt(pos);
  if (c === 96 || c === 126) return pos;
  if (c === 32 && hardBreakAt(s, pos)) return pos;
  if (at !== -1 && at < pos) at = s.indexOf('@', pos);
  if (at > pos && emailRunStart(s, at, pos) === pos) return pos; // `(?=[email]+@)` right at pos

  let end = n;
  TEXT_STOP.lastIndex = pos;
  // test() instead of exec(): no match array; where the match starts follows from how it ends
  while (TEXT_STOP.test(s)) {
    const e = TEXT_STOP.lastIndex;
    const z = s.charCodeAt(e - 1);
    let st;
    if (z === 10) {
      // ` {2,}\n` after a non-space: from the first space of the run
      st = e - 1;
      while (s.charCodeAt(st - 1) === 32) st--;
    } else if (z === 58) {
      // "mailto:" or "xmpp:"; right at pos it would be d3 for pos - 1, which the lazy part never looks at
      st = e >= 7 && s.startsWith('mailto:', e - 7) ? e - 7 : e - 5;
      if (st === pos) continue;
    } else if (z === 46 || z === 112 || z === 80) st = e - 4; // "www.", "http"
    else if (z === 47) st = e - 6; // "ftp://"
    else st = e - 1; // one of \ < ! [ ` * ~ _
    end = st;
    break;
  }
  TEXT_STOP.lastIndex = 0;

  // d4: walk the '@' signs while they can still end the run earlier
  let lo = pos;
  while (at !== -1 && lo < end) {
    const rs = emailRunStart(s, at, lo);
    if (rs < at) {
      if (rs > lo) return rs < end ? rs : end;
      if (lo > pos) return lo < end ? lo : end;
    }
    lo = at + 1;
    at = s.indexOf('@', lo);
  }
  return end;
}

/** Start of the run of email characters that ends at `at`, not going below `lo`. */
function emailRunStart(s, at, lo) {
  let k = at;
  while (k > lo && isEmailChar(s.charCodeAt(k - 1))) k--;
  return k;
}

/** Can the gfm url tokenizer match at the start of `s`? (necessary conditions only) */
function urlPossible(s) {
  const c = s.charCodeAt(0);
  if (c >= 128 || CH_URL_START[c] !== 1) return false;
  const l = c | 32;
  if (l === 104 || l === 102 || l === 109 || l === 120) return true;
  if (l === 119 && s.startsWith('ww.', 1)) return true;
  // otherwise only an email: its '@' ends the run of [A-Za-z0-9._+-] that starts here
  let j = 1;
  const n = s.length;
  while (j < n) {
    const d = s.charCodeAt(j);
    if (d >= 128 || CH_URL_START[d] !== 1) break;
    j++;
  }
  return s.charCodeAt(j) === 64;
}

// ---------------------------------------------------------------------------------------------
// The renderer state for one parse() call

class Md {
  constructor() {
    this.links = Object.create(null);
    this.defs = 0;
    this.queue = [];
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.top = true;
  }

  inline(src) {
    const entry = { src, html: '' };
    this.queue.push(entry);
    return entry;
  }

  // ------------------------------------------------------------------ block level

  blockTokens(src, tokens, clipped) {
    const links = this.links;
    // positions (in `whole`) of the next setext underline and the next blank line, kept lazily
    const whole = src;
    let underlineAt = -1;
    let blankAt = -1;
    while (src) {
      let tok;
      let m;
      const c0 = src.charCodeAt(0);

      // leading spaces decide which block starts are possible at all
      let ind = 0;
      while (ind < 4 && src.charCodeAt(ind) === 32) ind++;
      const fc = ind < 4 ? src.charCodeAt(ind) : 0;

      if ((c0 === 32 || c0 === 9 || c0 === 10) && (m = B_NEWLINE.exec(src)) && m[0].length > 0) {
        src = src.substring(m[0].length);
        const last = tokens[tokens.length - 1];
        if (m[0].length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push({ type: 'space', raw: m[0] });
        continue;
      }

      if ((c0 === 32 || c0 === 9) && (m = B_CODE.exec(src))) {
        const raw = trimBlankTail(m[0]);
        const text = raw.replace(R_CODE_INDENT, '');
        src = src.substring(raw.length);
        const last = tokens[tokens.length - 1];
        if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + text;
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          tokens.push({ type: 'code', raw, lang: undefined, text });
        }
        continue;
      }

      if (fc === 96 || fc === 126) {
        if ((m = B_FENCES.exec(src))) {
          const raw = m[0];
          src = src.substring(raw.length);
          const lang = m[2] ? unescapePunct(m[2].trim()) : m[2];
          tokens.push({ type: 'code', raw, lang, text: fenceIndent(raw, m[3] || '') });
          continue;
        }
      }

      if (fc === 35 && (m = B_HEADING.exec(src))) {
        let text = m[2].trim();
        if (text.endsWith('#')) {
          const t = trimEndChar(text, '#');
          if (!t || t.endsWith(' ') || t.endsWith('\t')) text = t.trim();
        }
        const raw = trimEndChar(m[0], '\n');
        src = src.substring(raw.length);
        tokens.push({ type: 'heading', raw, depth: m[1].length, entry: this.inline(text) });
        continue;
      }

      if ((fc === 45 || fc === 95 || fc === 42) && (m = B_HR.exec(src))) {
        const raw = trimEndChar(m[0], '\n');
        src = src.substring(raw.length);
        tokens.push({ type: 'hr', raw });
        continue;
      }

      if (fc === 62 && (tok = this.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && (tok = this.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (fc === 60 && (m = B_HTML.exec(src))) {
        const raw = trimBlankTail(m[0]);
        src = src.substring(raw.length);
        tokens.push({ type: 'html', raw, text: raw });
        continue;
      }

      if (fc === 91 && (tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          if (!links[tok.tag]) {
            links[tok.tag] = { href: tok.href, title: tok.title };
            this.defs++;
          }
          tokens.push(tok);
        }
        continue;
      }

      if (tableCandidate(src) && (tok = this.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      // an lheading needs an underline before the first blank line
      const off = whole.length - src.length;
      if (blankAt !== Infinity && blankAt < off) {
        BLANK_LINE_BREAK.lastIndex = off;
        const b = BLANK_LINE_BREAK.exec(whole);
        blankAt = b ? b.index : Infinity;
      }
      if (underlineAt !== Infinity && underlineAt < off) {
        // Only an underline before the blank line counts, so the search stops there: one that starts
        // before blankAt ends at the latest with its '\n', and the slice ends right after that '\n',
        // where `$` cannot match an underline. underlineAt = blankAt means "none before blankAt".
        const hay = blankAt === Infinity ? whole : whole.slice(0, blankAt + 1);
        SETEXT_UNDERLINE.lastIndex = off;
        const u = SETEXT_UNDERLINE.exec(hay);
        underlineAt = u ? u.index : blankAt;
      }
      const setext = underlineAt < blankAt;

      if (setext && (m = B_LHEADING.exec(src))) {
        const raw = trimEndChar(m[0], '\n');
        src = src.substring(raw.length);
        const text = m[1].trim();
        tokens.push({ type: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, entry: this.inline(text) });
        continue;
      }

      if (this.top && c0 !== 10) {
        const end = paragraphEnd(src);
        const raw = end === src.length ? src : src.slice(0, end);
        const text = raw;
        const tk = { type: 'paragraph', raw, text, entry: this.inline(text) };
        const last = tokens[tokens.length - 1];
        if (clipped && last !== undefined && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          tokens.push(tk);
        }
        clipped = false;
        src = src.substring(raw.length);
        continue;
      }

      if ((m = B_TEXT.exec(src))) {
        const raw = m[0];
        src = src.substring(raw.length);
        const tk = { type: 'text', raw, text: raw, entry: this.inline(raw) };
        const last = tokens[tokens.length - 1];
        if (last !== undefined && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          tokens.push(tk);
        }
        continue;
      }

      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.top = true;
    return tokens;
  }

  blockquote(src) {
    const m = B_BLOCKQUOTE.exec(src);
    if (!m) return undefined;
    let lines = trimEndChar(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R_BQ_START.test(lines[p])) {
          chunk.push(lines[p]);
          inQuote = true;
        } else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const inner = chunkRaw
        .replace(R_BQ_MARKER_WS, (all, mark, ws) => mark + expandTabs(ws, mark.length))
        .replace(R_BQ_SETEXT, '\n    $1')
        .replace(R_BQ_MARKER, '');
      raw = raw ? `${raw}\n${chunkRaw}` : chunkRaw;
      text = text ? `${text}\n${inner}` : inner;
      const top = this.top;
      this.top = true;
      this.blockTokens(inner, tokens, true);
      this.top = top;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      const lt = last?.type;
      if (lt === 'code' || lt === 'heading' || lt === 'hr' || lt === 'html' || lt === 'table') break;
      if (lt === 'blockquote') {
        const rest = lines.join('\n');
        const joined = last.raw + '\n' + rest.replace(R_BQ_MARKER, '');
        const again = this.blockquote(joined);
        tokens[tokens.length - 1] = again;
        const tail = joined.substring(again.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const used = tailLines ? lines.slice(0, -tailLines) : lines;
        if (used.length > 0) raw = `${raw}\n${used.join('\n')}`;
        text = text.substring(0, text.length - last.text.length) + again.text;
        lines = lines.slice(used.length);
        if (lines.length > 0 && R_BQ_START.test(lines[0])) continue;
        break;
      } else if (lt === 'list') {
        const joined = last.raw + '\n' + lines.join('\n');
        const again = this.list(joined);
        tokens[tokens.length - 1] = again;
        const taken =
          again.raw.length > last.raw.length ? joined.slice(last.raw.length + 1, again.raw.length).split('\n').length : 0;
        if (taken > 0) {
          const add = lines.slice(0, taken).join('\n');
          raw = `${raw}\n${add}`;
          text = `${text}\n${add}`;
        }
        lines = lines.slice(taken);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    let cap = B_LIST.exec(src);
    if (!cap) return undefined;
    const whole = src;
    let bull = cap[1].trim();
    const ordered = bull.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
    let itemRe;
    if (ordered) itemRe = bull.endsWith('.') ? ITEM_DOT : ITEM_PAREN;
    else itemRe = bull === '-' ? ITEM_DASH : bull === '*' ? ITEM_STAR : ITEM_PLUS;
    let endsWithBlank = false;

    while (src) {
      let endEarly = false;
      let content = '';
      if (!(cap = itemRe.exec(src)) || B_HR.test(src)) break;
      const start = whole.length - src.length;
      src = src.substring(cap[0].length);
      const first = firstLine(cap[2]);
      const markerWidth = cap[1].length;
      let line = expandLeading(first, markerWidth);
      let nextLine = firstLine(src);
      let blank = !line.trim();
      let indent;
      if (blank) {
        indent = markerWidth + 1;
      } else {
        indent = line.search(R_NON_SPACE);
        indent = indent > 4 ? 1 : indent;
        content = line.slice(indent);
        indent += markerWidth;
      }
      if (blank && R_BLANK_LINE.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        // The item's further lines, walked by index in `whole` (marked takes them one at a time
        // off the rest of the source). Each line is cut out as a string only where a probe, a
        // lazy continuation or the item's content needs it.
        const pr = probesFor(indent);
        const n = whole.length;
        let p = n - src.length;
        const parts = [content];
        // `line` is the previous line, expanded and without the item's indentation; after the
        // first line it is built only when a lazy continuation asks for it
        let lineStr = line;
        let prevP = 0;
        let prevSp = 0;
        let prevLe = 0;
        let prevTab = false;
        while (p < n) {
          const nl = whole.indexOf('\n', p);
          const le = nl === -1 ? n : nl;
          // the run of spaces and tabs at the start of the line (what expandLeading expands)
          let sp = p;
          let tab = false;
          for (;;) {
            const c = whole.charCodeAt(sp);
            if (c === 32) sp++;
            else if (c === 9) {
              tab = true;
              sp++;
            } else break;
          }
          // probeCandidate: up to three spaces, then a character a probe could start with
          let k = 0;
          while (k < 4 && whole.charCodeAt(p + k) === 32) k++;
          if (k < 4) {
            const c = whole.charCodeAt(p + k);
            if (c < 128 && CH_PROBE[c] === 1) {
              const probe = whole.slice(p, le);
              if (
                pr.fences.test(probe) ||
                pr.heading.test(probe) ||
                pr.html.test(probe) ||
                pr.blockquote.test(probe) ||
                pr.bullet.test(probe) ||
                pr.hr.test(probe)
              )
                break;
            }
          }
          // firstNonSpace of the expanded line (-1: nothing but blanks), and `!line.trim()`
          const expanded = tab ? expandTabs(whole.slice(p, sp), 0) + whole.slice(sp, le) : null;
          const width = sp >= le ? -1 : tab ? expanded.length - (le - sp) : sp - p;
          let isBlank = sp >= le;
          if (!isBlank && isJsSpace(whole.charCodeAt(sp))) {
            let j = sp;
            while (j < le && isJsSpace(whole.charCodeAt(j))) j++;
            isBlank = j === le;
          }
          if (width >= indent || isBlank) {
            parts.push(tab ? expanded.slice(indent) : whole.slice(p + indent, le));
          } else {
            if (lineStr === null) {
              const prev = prevTab
                ? expandTabs(whole.slice(prevP, prevSp), 0) + whole.slice(prevSp, prevLe)
                : whole.slice(prevP, prevLe);
              lineStr = prev.slice(indent);
            }
            const line = lineStr;
            if (
              blank ||
              line.replace(/\t/g, '    ').search(R_NON_SPACE) >= 4 ||
              pr.fences.test(line) ||
              pr.heading.test(line) ||
              pr.html.test(line) ||
              pr.hr.test(line)
            )
              break;
            const nextLine = whole.slice(p, le);
            const add =
              R_LIST_SETEXT_LINE.test(nextLine) && B_LHEADING.test(`${line}\n${nextLine}`)
                ? `    ${(tab ? expanded : nextLine).replace(/^ {0,3}/, '')}`
                : nextLine;
            parts.push(add);
          }
          blank = isBlank;
          lineStr = null;
          prevP = p;
          prevSp = sp;
          prevLe = le;
          prevTab = tab;
          p = le + 1;
        }
        if (parts.length > 1) content = parts.join('\n');
        src = p >= n ? '' : whole.substring(p);
      }
      const itemRaw = whole.slice(start, whole.length - src.length);
      if (!list.loose) {
        if (endsWithBlank) list.loose = true;
        else if (endsWithBlankLine(itemRaw)) endsWithBlank = true;
      }
      list.items.push({ raw: itemRaw, task: R_IS_TASK.test(content), checked: undefined, text: content, tokens: [] });
    }

    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = whole.slice(0, whole.length - src.length).trimEnd();

    for (const item of list.items) {
      this.top = false;
      item.tokens = this.blockTokens(item.text, [], false);
      if (!list.loose) {
        let loose = false;
        for (const t of item.tokens) if (t.type === 'space' && R_ANY_LINE.test(t.raw)) loose = true;
        list.loose = loose;
      }
    }

    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && first !== undefined && (first.type === 'text' || first.type === 'paragraph')) {
        const q = this.queue;
        for (let g = q.length - 1; g >= 0; g--) {
          if (R_IS_TASK.test(q[g].src)) {
            q[g].src = q[g].src.replace(R_TASK, '');
            break;
          }
        }
        const box = R_TASK_BOX.exec(item.raw);
        if (box) {
          const checked = box[0] !== '[ ]';
          item.checked = checked;
          // marked puts a checkbox token in front of the item's first paragraph or text
          first.checkbox = checked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ';
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    if (list.loose) {
      for (const item of list.items) for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
    return list;
  }

  def(src) {
    const m = B_DEF.exec(src);
    if (!m) return undefined;
    if (!m[2].startsWith('<') && findClosing(m[2], '(', ')') !== -1) return undefined;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? unescapePunct(m[2].replace(R_HREF_BRACKETS, '$1')) : '';
    const title = m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : m[3];
    return { type: 'def', tag, raw: trimEndChar(m[0], '\n'), href, title };
  }

  table(src) {
    const m = B_TABLE.exec(src);
    if (!m || !/[:|]/.test(m[2])) return undefined;
    const head = splitCells(m[1]);
    const aligns = m[2].replace(R_TABLE_ALIGN_CHARS, '').split('|');
    const rows = m[3]?.trim() ? m[3].replace(R_TABLE_ROW_BLANK, '').split('\n') : [];
    if (head.length !== aligns.length) return undefined;
    const tok = { type: 'table', raw: trimEndChar(m[0], '\n'), align: [], header: [], rows: [] };
    for (const a of aligns) {
      if (R_ALIGN_RIGHT.test(a)) tok.align.push('right');
      else if (R_ALIGN_CENTER.test(a)) tok.align.push('center');
      else if (R_ALIGN_LEFT.test(a)) tok.align.push('left');
      else tok.align.push(null);
    }
    for (let i = 0; i < head.length; i++) tok.header.push(this.inline(head[i]));
    for (const row of rows) {
      const cells = splitCells(row, tok.header.length);
      const out = [];
      for (let i = 0; i < cells.length; i++) out.push(this.inline(cells[i]));
      tok.rows.push(out);
    }
    return tok;
  }

  // ------------------------------------------------------------------ inline level

  /** marked's emphasis mask: link texts, escapes and code spans hidden from the delimiter search. */
  mask(src) {
    let out = src;
    const links = this.links;
    // with no definitions every reference keeps its text; the other two only touch what they match
    if (this.defs > 0 && src.includes('[')) {
      const swap = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(I_REFLINK_SEARCH, swap) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      // `out.replace(I_REFLINK_SEARCH, swap)`, calling back only for the defined references; swap's
      // own searches (a replace, matchAll) start from lastIndex 0, as inside a replace callback
      const re = I_REFLINK_SEARCH;
      re.lastIndex = 0;
      let acc = '';
      let last = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const r = m[0];
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) continue;
        const next = re.lastIndex;
        re.lastIndex = 0;
        const rep = swap(r);
        re.lastIndex = next;
        acc += src.slice(last, m.index) + rep;
        last = m.index + r.length;
      }
      if (last !== 0) out = acc + src.slice(last);
    }
    // This pass only rewrites escapes and backticks inside code spans. With single-tick fences a
    // code span holds no backtick (the lazy body would have ended at a lone one), so without a
    // backslash and without '``' it changes nothing.
    if (out.includes('\\') || out.includes('``')) out = maskEscapes(out);
    if (out.includes('](') || out.includes('`') || out.includes('<')) out = maskSpans(out);
    return out;
  }

  linkInText(s) {
    if (!s.includes('[')) return false;
    for (const m of s.matchAll(I_BLOCK_SKIP)) {
      if (I_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of s.matchAll(I_REFLINK_SEARCH)) {
      const r = m[0];
      const o = r.lastIndexOf('[');
      if (!(r.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(r.slice(o + 1, -1)))) && !(o > 1 && this.linkInText(r.slice(1, o - 1))))
        return true;
    }
    return false;
  }

  /** Lexes and renders inline markdown; `plain` renders the text-only form used for alt text. */
  inlineTokens(src, plain) {
    return this.inlineLoop(src, plain);
  }

  inlineLoop(src, plain) {
    const whole = src;
    const ctx = { whole, masked: null, closers: null, at: 0, amp: -2, safe: -2 };
    // An inline link needs a ')' after its '[': the last one in the source, looked up on first use.
    let parenAt = -2;
    let out = '';
    // Pending plain text, escaped when the next token (or the end) comes. While it is the source
    // itself (no reference was decoded in it), it is kept as the range pendStart..here of `whole`.
    let pend = '';
    let pendOn = false;
    let pendRaw = false;
    let pendLazy = false;
    let pendStart = 0;
    // the next character esc() would rewrite, at or after the pending range (-2: not looked up)
    let escAt = -2;
    let prevText = false;
    let prevChar = '';

    while (src) {
      if (!prevText) prevChar = '';
      prevText = false;
      const c = src.charCodeAt(0);
      let m;
      let html; // rendered piece of a non-text token
      let len = 0;

      switch (c) {
        case 92: // \
          if ((m = I_ESCAPE.exec(src))) {
            len = m[0].length;
            html = plain ? m[1] : esc(m[1]);
          } else if ((m = I_BR.exec(src))) {
            len = m[0].length;
            html = plain ? '' : '<br>';
          }
          break;
        case 60: // <
          if ((m = I_TAG.exec(src))) {
            const raw = m[0];
            if (!this.inLink && R_START_A.test(raw)) this.inLink = true;
            else if (this.inLink && R_END_A.test(raw)) this.inLink = false;
            if (!this.inRawBlock && R_START_RAW.test(raw)) this.inRawBlock = true;
            else if (this.inRawBlock && R_END_RAW.test(raw)) this.inRawBlock = false;
            len = raw.length;
            html = raw;
          } else if ((m = I_AUTOLINK.exec(src))) {
            const text = m[1];
            const href = m[2] === '@' ? 'mailto:' + text : text;
            len = m[0].length;
            html = plain ? text : this.renderLink(href, null, esc(text, true), true);
          }
          break;
        case 33: // !
        case 91: {
          // [
          if (parenAt === -2) parenAt = whole.lastIndexOf(')');
          let r = parenAt > whole.length - src.length ? this.link(src, plain) : undefined;
          if (r === undefined) {
            r = this.reflink(src, plain);
            if (r !== undefined && r.text !== undefined) {
              // an unresolved reference: its bracket (the source's own character) is plain text
              if (!pendOn) {
                pendOn = true;
                pendRaw = false;
                pendLazy = true;
                pendStart = whole.length - src.length;
              } else if (!pendLazy) pend += r.text;
              src = src.substring(1);
              continue;
            }
          }
          if (r !== undefined) {
            len = r.len;
            html = r.html;
          }
          break;
        }
        case 42: // *
        case 95: {
          // _
          const r = this.emStrong(src, ctx, prevChar, plain);
          if (r !== undefined) {
            len = r.len;
            html = r.html;
          } else if (c === 95 && !this.inLink && urlPossible(src)) {
            const u = this.url(src, plain);
            if (u !== undefined) {
              len = u.len;
              html = u.html;
            }
          }
          break;
        }
        case 96: // `
          if ((m = I_CODE.exec(src))) {
            let text = m[2];
            if (text.includes('\n')) text = text.replace(/\n/g, ' ');
            if (text.startsWith(' ') && text.endsWith(' ') && R_NON_SPACE.test(text)) text = text.substring(1, text.length - 1);
            len = m[0].length;
            html = plain ? text : `<code>${esc(text, true)}</code>`;
          }
          break;
        case 32: // space (a hard break needs at least two)
          if (src.charCodeAt(1) === 32 && (m = I_BR.exec(src))) {
            len = m[0].length;
            html = plain ? '' : '<br>';
          }
          break;
        case 126: {
          // ~
          const r = this.del(src, ctx, prevChar, plain);
          if (r !== undefined) {
            len = r.len;
            html = r.html;
          }
          break;
        }
        default:
          if (!this.inLink && urlPossible(src)) {
            const u = this.url(src, plain);
            if (u !== undefined) {
              len = u.len;
              html = u.html;
            }
          }
      }

      if (html !== undefined) {
        if (pendOn) {
          if (pendLazy) {
            const end = whole.length - src.length;
            if (escAt !== -1 && escAt < pendStart) {
              R_ESC_NEXT.lastIndex = pendStart;
              escAt = R_ESC_NEXT.test(whole) ? R_ESC_NEXT.lastIndex - 1 : -1;
            }
            const p = whole.slice(pendStart, end);
            out += plain || pendRaw || escAt === -1 || escAt >= end ? p : esc(p);
          } else out += plain || pendRaw ? pend : esc(pend);
          pendOn = false;
        }
        out += html;
        src = src.substring(len);
        continue;
      }

      // plain text up to the next possible token
      const off = whole.length - src.length;
      let at = ctx.at;
      if (at !== -1 && at < off + 1) at = ctx.at = whole.indexOf('@', off + 1);
      len = textRunLength(src, at === -1 ? -1 : at - off);
      const last = src.charAt(len - 1);
      if (last !== '_') prevChar = last;
      prevText = true;
      // a numeric reference to decode needs its '&#' inside the run (the next one is tracked)
      let amp = ctx.amp;
      if (amp !== -1 && amp < off) amp = ctx.amp = whole.indexOf('&#', off);
      let raw;
      let text;
      if (amp === -1 || amp + 1 >= off + len || this.inRawBlock) text = raw = null;
      else {
        raw = len === src.length ? src : src.slice(0, len);
        text = decodeNumeric(raw);
      }
      src = src.substring(len);
      if (text === raw) {
        // the run is the source itself
        if (!pendOn) {
          pendOn = true;
          pendRaw = this.inRawBlock;
          pendLazy = true;
          pendStart = off;
        } else if (!pendLazy) pend += whole.slice(off, off + len);
      } else if (!pendOn) {
        pend = text;
        pendOn = true;
        pendRaw = this.inRawBlock;
        pendLazy = false;
      } else if (pendLazy) {
        pend = whole.slice(pendStart, off) + text;
        pendLazy = false;
      } else pend += text;
    }
    if (pendOn) {
      if (pendLazy) {
        if (escAt !== -1 && escAt < pendStart) {
          R_ESC_NEXT.lastIndex = pendStart;
          escAt = R_ESC_NEXT.test(whole) ? R_ESC_NEXT.lastIndex - 1 : -1;
        }
        const p = pendStart === 0 ? whole : whole.slice(pendStart);
        out += plain || pendRaw || escAt === -1 ? p : esc(p);
      } else out += plain || pendRaw ? pend : esc(pend);
    }
    R_ESC_NEXT.lastIndex = 0;
    return out;
  }

  /** marked's guard: an html tag or autolink that starts inside a link label but ends past it. */
  labelSpillsHtml(src, label, offset) {
    if (!label.includes('<')) return false;
    for (let s = 0; s < label.length; s++) {
      const ch = label[s];
      if (ch === '\\') {
        s++;
        continue;
      }
      if (ch === '`') {
        const m = I_CODE.exec(label.slice(s));
        if (m) {
          s += m[0].length - 1;
          continue;
        }
      }
      if (ch !== '<') continue;
      const rest = src.slice(offset + s);
      const m = I_TAG.exec(rest) || I_AUTOLINK.exec(rest);
      if (m) {
        if (m[0].length > label.length - s) return true;
        s += m[0].length - 1;
      }
    }
    return false;
  }

  link(src, plain) {
    const m = I_LINK.exec(src);
    if (!m) return undefined;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.labelSpillsHtml(src, m[1], off)) return undefined;
    let raw = m[0];
    let href = m[2];
    let title = m[3];
    const trimmed = href.trim();
    if (trimmed.startsWith('<')) {
      if (!trimmed.endsWith('>')) return undefined;
      const t = trimEndChar(trimmed.slice(0, -1), '\\');
      if ((trimmed.length - t.length) % 2 === 0) return undefined;
    } else {
      const close = findClosing(href, '(', ')');
      if (close === -2) return undefined;
      if (close > -1) {
        const end = (raw.indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        href = href.substring(0, close);
        raw = raw.substring(0, end).trim();
        title = '';
      }
    }
    const t = trimEndChar(raw.slice(0, -1), '\\');
    if ((raw.length - t.length) % 2 === 0) return undefined;
    title = title ? title.slice(1, -1) : '';
    href = href.trim();
    if (href.startsWith('<')) href = href.slice(1, -1);
    return this.emitLink(
      m[1],
      raw,
      href && unescapePunct(href),
      title && unescapePunct(title),
      plain,
    );
  }

  reflink(src, plain) {
    let m = I_REFLINK.exec(src);
    if (!m) m = I_NOLINK.exec(src);
    if (!m) return undefined;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.labelSpillsHtml(src, m[1], off)) return undefined;
    const def = this.links[normalizeLabel(m[2] || m[1])];
    if (!def) return { text: m[0].charAt(0) };
    return this.emitLink(m[1], m[0], def.href, def.title, plain);
  }

  /** marked's outputLink(): lexes the label, refuses links that contain links. */
  emitLink(label, raw, href, title, plain) {
    title = title || null;
    const text = label.includes('\\') ? label.replace(R_LINK_TEXT_BRACKETS, '$1') : label;
    const image = raw.charAt(0) === '!';
    const inLink = this.inLink;
    const emitted = this.linkEmitted;
    const rawBlock = this.inRawBlock;
    this.inLink = true;
    this.linkEmitted = false;
    const inner = this.inlineTokens(text, image || plain);
    const innerEmitted = this.linkEmitted;
    this.linkEmitted = emitted;
    this.inLink = inLink;
    if (!image) {
      if (innerEmitted) {
        this.inRawBlock = rawBlock;
        return undefined;
      }
      this.linkEmitted = true;
    }
    let html;
    if (plain) html = inner;
    else if (image) {
      const url = cleanUrl(href);
      if (url === null) html = esc(inner);
      else {
        html = `<img src="${esc(url)}" alt="${esc(inner)}"`;
        if (title) html += ` title="${esc(title)}"`;
        html += '>';
      }
    } else html = this.renderLink(href, title, inner, false);
    return { len: raw.length, html };
  }

  renderLink(href, title, inner, strict) {
    const url = cleanUrl(href);
    if (url === null) return inner;
    let html = '<a href="' + esc(url, strict) + '"';
    if (title) html += ' title="' + esc(title) + '"';
    return html + '>' + inner + '</a>';
  }

  url(src, plain) {
    const m = I_URL.exec(src);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let before;
      do {
        before = m[0];
        m[0] = I_BACKPEDAL.exec(m[0])?.[0] ?? '';
      } while (before !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { len: m[0].length, html: plain ? text : this.renderLink(href, null, esc(text, true), true) };
  }

  /** The emphasis mask and the last possible closer of each delimiter, built on first use. */
  closersOf(ctx) {
    if (ctx.closers === null) {
      const masked = this.mask(ctx.whole);
      ctx.masked = masked;
      ctx.closers = { '*': lastCloserRun(masked, '*'), _: lastCloserRun(masked, '_'), '~': lastCloserRun(masked, '~') };
    }
    return ctx.closers;
  }

  emStrong(src, ctx, prevChar, plain) {
    // I_EM_LEFT captures nothing (a refusal) when its run is followed by whitespace or the end
    const c0 = src.charCodeAt(0);
    let r = 1;
    while (src.charCodeAt(r) === c0) r++;
    if (r >= src.length || isJsSpace(src.charCodeAt(r))) return undefined;
    let m = I_EM_LEFT.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const ch = m[0][0];
    let prev = prevChar;
    const sameAsPrev = prev === ch;
    const whole = ctx.whole; // the mask has the same length as the source
    const here = whole.length - src.length;
    if (here === 0 || whole.charCodeAt(here - 1) !== ch.charCodeAt(0)) {
      // The mask never creates delimiter characters, so no run of `ch` ends right before here and
      // marked's early refusals only depend on the previous character: decide them without the mask.
      if (m[4] && hasAlnum(prev)) return undefined;
      if ((m[1] || m[3]) && prev && !isPunct(prev)) return undefined;
    }
    const lLen = m[0].length - lastCodePointLength(m[0]);
    const from = here + lLen;
    // Fast path: below ctx.safe the mask equals the source, so it is not built while the left side
    // and the closer search stay there (see emScan); the left side only reads before `here`.
    let fast = ctx.closers === null && here < this.safeOf(ctx);
    if (fast) {
      // the right regex's first alternative is anchored and lazy: it can read far ahead, so it must
      // fail at the first delimiter character, inside the safe part, in both strings
      R_EM_DELIM.lastIndex = from;
      if (R_EM_DELIM.test(whole)) {
        const k = R_EM_DELIM.lastIndex - 1;
        R_EM_DELIM.lastIndex = 0;
        const pair = ch === '*' ? 95 : 42; // __ for *, ** for _
        if (k + 2 > ctx.safe || (whole.charCodeAt(k) === pair && whole.charCodeAt(k + 1) === pair)) fast = false;
      }
    }
    const mask = fast ? whole : (this.closersOf(ctx), ctx.masked);
    let l = here;
    while (l > 0 && mask[l - 1] === ch) l--;
    const before = codePointBefore(mask, l);
    const beforeIsPunct = before === '*' || before === '_' || isPunct(before);
    if (l < here) prev = before;
    const prevPunct = l < here ? beforeIsPunct : isPunct(prev);
    if (m[4] && hasAlnum(prev)) return undefined;
    const leftPunct = m[1] || m[3] || '';
    if (leftPunct && prev && !prevPunct) return undefined;
    const runBefore = here - l + lLen;
    const checkMod3 = !!before.trim() && (!!leftPunct || (ch === '*' && !beforeIsPunct));
    if (ch !== '*' && ch !== '_') return undefined;
    const right = ch === '*' ? I_EM_RIGHT_AST : I_EM_RIGHT_UND;
    if (fast) {
      const r = this.emScan(src, whole.slice(from), from, Infinity, ctx.safe, right, lLen, runBefore, checkMod3, sameAsPrev, plain);
      if (r !== UNSURE) return r;
      this.closersOf(ctx);
    }
    const lastCloser = ctx.closers[ch];
    if (lastCloser < from) return undefined;
    return this.emScan(src, ctx.masked.slice(from), from, lastCloser - from, Infinity, right, lLen, runBefore, checkMod3, sameAsPrev, plain);
  }

  /**
   * marked's closer search of emStrong over `tail` (the mask after the left delimiter). With a finite
   * `safe` the tail is the source, exact only below `safe`: a match whose text or lookahead reaches
   * past it, or a search that runs off the end, answers UNSURE.
   */
  emScan(src, tail, from, limit, safe, right, lLen, runBefore, checkMod3, sameAsPrev, plain) {
    let need = lLen;
    let skipped = 0;
    let m;
    right.lastIndex = 0;
    while ((m = right.exec(tail)) !== null) {
      if (from + m.index + m[0].length + 2 > safe) return UNSURE;
      if (m.index > limit) break;
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let rLen = run.length; // a run of one ASCII delimiter
      if (m[3] || m[4]) {
        need += rLen;
        continue;
      } else if (m[5] || m[6] || checkMod3) {
        if (sameAsPrev && (m[5] || m[6])) break;
        if (runBefore % 3 && !((runBefore + rLen) % 3)) {
          skipped += rLen;
          continue;
        }
      }
      need -= rLen;
      if (need > 0) continue;
      rLen = Math.min(rLen, rLen + need + skipped);
      const lead = firstCodePointLength(m[0]);
      const raw = src.slice(0, lLen + m.index + lead + rLen);
      if (Math.min(lLen, rLen) % 2) {
        const inner = this.inlineTokens(raw.slice(1, -1), plain);
        return { len: raw.length, html: plain ? inner : `<em>${inner}</em>` };
      }
      const inner = this.inlineTokens(raw.slice(2, -2), plain);
      return { len: raw.length, html: plain ? inner : `<strong>${inner}</strong>` };
    }
    return m === null && safe !== Infinity ? UNSURE : undefined;
  }

  /**
   * Below ctx.safe the emphasis mask equals the source: every span the mask rewrites starts at one
   * of [ ` \ < or at the ! right before a [. Infinity: the mask is the source itself.
   */
  safeOf(ctx) {
    if (ctx.safe === -2) {
      const k = ctx.whole.search(R_MASK_START);
      ctx.safe = k === -1 ? Infinity : k - 1;
    }
    return ctx.safe;
  }

  del(src, ctx, prevChar, plain) {
    let m = I_DEL_LEFT.exec(src);
    if (!m) return undefined;
    const leftPunct = m[1] || '';
    if (leftPunct && prevChar && !isPunct(prevChar)) return undefined;
    const lLen = m[0].length - lastCodePointLength(m[0]);
    const here = ctx.whole.length - src.length;
    const from = here + lLen;
    // fast path as in emStrong; I_DEL_RIGHT has no lazy alternative that could read past its match
    if (ctx.closers === null && here < this.safeOf(ctx)) {
      const r = this.delScan(src, ctx.whole.slice(from), from, Infinity, ctx.safe, lLen, plain);
      if (r !== UNSURE) return r;
    }
    const lastCloser = this.closersOf(ctx)['~'];
    if (lastCloser < from) return undefined;
    return this.delScan(src, ctx.masked.slice(from), from, lastCloser - from, Infinity, lLen, plain);
  }

  /** del's closer search, as emScan */
  delScan(src, tail, from, limit, safe, lLen, plain) {
    let need = lLen;
    let m;
    const right = I_DEL_RIGHT;
    right.lastIndex = 0;
    while ((m = right.exec(tail)) !== null) {
      if (from + m.index + m[0].length + 2 > safe) return UNSURE;
      if (m.index > limit) break;
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let rLen = run.length; // a run of one ASCII delimiter
      if (rLen !== lLen) continue;
      if (m[3] || m[4]) {
        need += rLen;
        continue;
      }
      need -= rLen;
      if (need > 0) continue;
      rLen = Math.min(rLen, rLen + need);
      const lead = firstCodePointLength(m[0]);
      const raw = src.slice(0, lLen + m.index + lead + rLen);
      const inner = this.inlineTokens(raw.slice(lLen, -lLen), plain);
      return { len: raw.length, html: plain ? inner : `<del>${inner}</del>` };
    }
    return m === null && safe !== Infinity ? UNSURE : undefined;
  }

  // ------------------------------------------------------------------ output

  render(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      switch (t.type) {
        case 'space':
        case 'def':
          break;
        case 'paragraph':
          out += '<p>' + (t.checkbox || '') + t.entry.html + '</p>\n';
          break;
        case 'text':
          out += (t.checkbox || '') + t.entry.html;
          break;
        case 'heading':
          out += `<h${t.depth}>${t.entry.html}</h${t.depth}>\n`;
          break;
        case 'code': {
          const lang = (t.lang || '').match(/^\S*/)?.[0];
          const body = t.text ? t.text.replace(/\n$/, '') + '\n' : '';
          out += lang
            ? '<pre><code class="language-' + esc(lang) + '">' + esc(body, true) + '</code></pre>\n'
            : '<pre><code>' + esc(body, true) + '</code></pre>\n';
          break;
        }
        case 'hr':
          out += '<hr>\n';
          break;
        case 'html':
          out += t.text;
          break;
        case 'blockquote':
          out += '<blockquote>\n' + this.render(t.tokens) + '</blockquote>\n';
          break;
        case 'list': {
          const tag = t.ordered ? 'ol' : 'ul';
          out += '<' + tag + (t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '') + '>\n';
          for (const item of t.items) out += '<li>' + this.render(item.tokens) + '</li>\n';
          out += '</' + tag + '>\n';
          break;
        }
        case 'table': {
          let head = '';
          for (let j = 0; j < t.header.length; j++) head += cell('th', t.align[j], t.header[j].html);
          let body = '';
          for (const row of t.rows) {
            let cells = '';
            for (let j = 0; j < row.length; j++) cells += cell('td', t.align[j], row[j].html);
            body += '<tr>\n' + cells + '</tr>\n';
          }
          if (body) body = '<tbody>' + body + '</tbody>';
          out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
          break;
        }
        default:
          throw new Error('Token with "' + t.type + '" type was not found.');
      }
    }
    return out;
  }
}

/**
 * Start of the last maximal run of `ch` in `s` that does not follow whitespace (or -1): the last
 * place an emphasis or strikethrough could close. Searched from the end instead of scanning all.
 */
function lastCloserRun(s, ch) {
  let k = s.lastIndexOf(ch);
  while (k !== -1) {
    let st = k;
    while (st > 0 && s[st - 1] === ch) st--;
    if (st === 0) return -1; // a run at the very start follows the implied newline
    const b = s[st - 1];
    if (b !== ' ' && b !== '\t' && b !== '\n' && b !== '\r' && b !== '\f') return st;
    k = s.lastIndexOf(ch, st - 1);
  }
  return -1;
}

/** B_TABLE needs a second line that opens with a delimiter row character after up to 3 spaces. */
function tableCandidate(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let k = nl + 1;
  let sp = 0;
  while (sp < 3 && src.charCodeAt(k) === 32) {
    k++;
    sp++;
  }
  const d = src.charCodeAt(k);
  return d === 124 || d === 58 || d === 45;
}

function cell(tag, align, html) {
  return (align ? `<${tag} align="${align}">` : `<${tag}>`) + html + `</${tag}>\n`;
}

/** The HTML marked 18.1.3 renders for `markdown` with its default options. */
export function parse(markdown) {
  const md = new Md();
  const src = markdown.replace(R_CRLF, '\n');
  const tokens = md.blockTokens(src, [], false);
  const q = md.queue;
  for (let i = 0; i < q.length; i++) {
    md.inRawBlock = false;
    q[i].html = md.inlineTokens(q[i].src, false);
  }
  const html = md.render(tokens);
  // The result is a deep tree of concatenations. Flattening it now (charCodeAt in the middle does
  // that), while its parts are young and in cache, is much cheaper than letting the trees of every
  // case age into the old generation and be flattened by the caller's JSON.stringify at the end.
  html.charCodeAt(html.length >> 1);
  return html;
}

// exported for the repository's own regex and scanner checks (tools/)
export const internals = {
  textRunLength,
  esc,
  regexes: {
    block: {
      newline: B_NEWLINE, code: B_CODE, fences: B_FENCES, hr: B_HR, heading: B_HEADING, lheading: B_LHEADING,
      def: B_DEF, list: B_LIST, html: B_HTML, table: B_TABLE, paragraph: B_PARAGRAPH, blockquote: B_BLOCKQUOTE,
      text: B_TEXT,
    },
    inline: {
      escape: I_ESCAPE, code: I_CODE, br: I_BR, punctuation: I_PUNCTUATION, blockSkip: I_BLOCK_SKIP,
      emStrongLDelim: I_EM_LEFT, emStrongRDelimAst: I_EM_RIGHT_AST, emStrongRDelimUnd: I_EM_RIGHT_UND,
      delLDelim: I_DEL_LEFT, delRDelim: I_DEL_RIGHT, anyPunctuation: I_ANY_PUNCT,
      anyPunctuationOutsideCode: I_ANY_PUNCT_OUTSIDE_CODE, autolink: I_AUTOLINK, tag: I_TAG, link: I_LINK,
      reflink: I_REFLINK, nolink: I_NOLINK, reflinkSearch: I_REFLINK_SEARCH, url: I_URL, _backpedal: I_BACKPEDAL,
    },
  },
};
