// Chrome only: hosts engine.js in an offscreen document; the service worker forwards inference messages here.
// Register the listener before loading the engine (transformers.js, ~1 MB) so a message sent right after the
// document is created always has a receiver.
const engine = import('./engine.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !['img.check', 'img.ocr', 'text.classify'].includes(msg.type)) return false;
  const p = engine.then((m) => m.handle(msg));
  p.then(sendResponse, (e) => { console.error('[SpolierBlock]', msg.type, e); sendResponse({ error: String(e?.message ?? e) }); });
  return true;
});
