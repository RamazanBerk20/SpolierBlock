// The "title in context" model's input (docs/agents/contract.md, "Names the matcher is unsure about"), shared by the
// content script (classic script: globalThis.SBContext), the engine and Node (tools/context-train/window.mjs re-exports
// it). The Java port must build exactly the same two strings and the same token ids (docs/development.md).
//
// Segment A (window rule): the name's occurrence is the character span [s, e) of the text (the matcher's token offsets:
// tk.starts[h.i], tk.ends[h.i + h.n - 1]).
//   a = max(0, s - WINDOW); if a > 0, a moves forward past the first whitespace character at or after a (a word cut in
//       half is dropped), but never past s.
//   b = min(len, e + WINDOW); if b < len, b moves back to the last whitespace character before b (that character and
//       everything after it are dropped), but never before e.
//   A = text.slice(a, s) + '<' + text.slice(s, e) + '>' + text.slice(e, b), then every run of whitespace (line breaks
//       included) turned into one space, then trimmed. The marks tell the model which occurrence it is asked about.
// "Whitespace" is JavaScript's \s. The text is the post's own text only (never the OCR part after U+0001).
// Segment B: `<group label> [<types>]`, the distinct types of the group's works in TYPES order, joined by ", ".
// Tokens: [CLS] A [SEP] B [SEP], token type 0 up to and including the first [SEP], 1 after; when longer than maxLength,
// A's tokens are cut from the end (Python's truncation='only_first').
(function () {
  'use strict';
  const WINDOW = 100, MAX_LEN = 128;
  const TYPES = ['movie', 'tv', 'game', 'book', 'anime', 'manga', 'comic'];
  const WS = /\s/;

  function windowText(text, s, e) {
    let a = Math.max(0, s - WINDOW), b = Math.min(text.length, e + WINDOW);
    if (a > 0) { let i = a; while (i < s && !WS.test(text[i])) i++; a = i < s ? i + 1 : s; }
    if (b < text.length) { let i = b - 1; while (i >= e && !WS.test(text[i])) i--; b = i >= e ? i : e; }
    return (text.slice(a, s) + '<' + text.slice(s, e) + '>' + text.slice(e, b)).replace(/\s+/g, ' ').trim();
  }

  // meta: data/index.json meta ({ titles, types, groups }); g: group index
  function workText(meta, g) {
    const [label, ...ws] = meta.groups[g], have = new Set(ws.map((w) => meta.types[w]));
    return `${label} [${TYPES.filter((t) => have.has(t)).join(', ')}]`;
  }

  // ta, tb: the token ids of A and B without special tokens -> { ids, types }
  function pairIds(ta, tb, cls, sep, maxLength = MAX_LEN) {
    const ka = Math.max(0, Math.min(ta.length, maxLength - tb.length - 3));
    const ids = [cls, ...ta.slice(0, ka), sep, ...tb, sep];
    return { ids, types: ids.map((_, i) => (i < ka + 2 ? 0 : 1)) };
  }

  globalThis.SBContext = { WINDOW, MAX_LEN, TYPES, windowText, workText, pairIds };
})();
