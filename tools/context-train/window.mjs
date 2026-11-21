// The "title in context" model's input, shared by the trainer, tools/eval-context.mjs and the Node classifier. The rule
// and the code live in src/shared/context-input.js, which the extension loads too (one copy); see docs/development.md,
// "Title in context model".
import '../../src/shared/context-input.js';
export const { WINDOW, MAX_LEN, TYPES, windowText, workText } = globalThis.SBContext;

// shortcut: plain asserts instead of a test file; run `node tools/context-train/window.mjs` after changing the rule.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  assert.equal(windowText('i saw Lost', 6, 10), 'i saw <Lost>');
  const long = 'x'.repeat(150) + ' alpha beta Heat gamma delta ' + 'y'.repeat(150);
  const s = long.indexOf('Heat');
  assert.equal(windowText(long, s, s + 4), 'alpha beta <Heat> gamma delta');
  assert.equal(windowText('a\n\nb  Up\tc', 6, 8), 'a b <Up> c');
  assert.equal(workText({ groups: [['Dune', 0, 1]], types: ['book', 'movie'] }, 0), 'Dune [movie, book]');
  console.log('window ok');
}
