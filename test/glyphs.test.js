'use strict';

/**
 * UI glyph regression (v1.2.2, Item 6): the poker buy-in popup
 * shipped TWICE with a raw escape as its title — v1.2 swept
 * index.html for \uXXXX literals and STILL missed one written
 * as \U0001F0CF (capital U, eight digits: not a JS escape at all,
 * so browsers render it as literal text — "\U0001F0CF POKER
 * TABLE" is what players saw).
 *
 * The house rule this test enforces: client sources (public/)
 * contain NO backslash-u escape sequences in ANY case or form —
 * UI glyphs are written as the real UTF-8 characters. That is
 * a blanket, greppable invariant with no allow-list to rot:
 * if a future change needs a glyph, it pastes the glyph.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const ESCAPE_RE = /\\[uU](?:\{[0-9A-Fa-f]+\}|[0-9A-Fa-f]{2,8})/;

test('no raw backslash-u escapes anywhere in the client sources', () => {
  const files = fs.readdirSync(PUB)
    .filter(f => /\.(js|html|css)$/.test(f))
    .sort();
  assert.ok(files.length >= 10, `expected the client sources, found ${files.length} files`);
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(PUB, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = ESCAPE_RE.exec(line);
      if (m) hits.push(`${f}:${i + 1}: ${m[0]} in "${line.trim().slice(0, 80)}"`);
    });
  }
  assert.deepEqual(hits, [], 'raw \\u escapes render as literal text in UI strings — paste the real glyph instead');
});

test('the poker buy-in popup title carries the real joker glyph', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const m = /id="offerTitle"[^>]*>([^<]*)</.exec(html);
  assert.ok(m, 'offerTitle element exists');
  assert.ok(m[1].includes('🃏'), `offer title is "${m[1]}" — the joker glyph must be a real character`);
  assert.ok(m[1].includes('POKER TABLE'), 'offer title still names the table');
});
