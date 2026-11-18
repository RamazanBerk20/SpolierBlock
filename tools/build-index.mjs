// Node entry point for the index builder; the builder itself lives in src/shared/build-index.js so the extension's
// catalog update runs the exact same code.
import fs from 'node:fs';
import { setCommonWords } from '../src/shared/build-index.js';
try { setCommonWords(fs.readFileSync(new URL('./catalog/20k.txt', import.meta.url), 'utf8')); } catch { /* no list: rules without it */ }
export * from '../src/shared/build-index.js';
