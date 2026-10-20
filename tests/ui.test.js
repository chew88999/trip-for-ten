import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('toast announces updates to screen readers', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div\b(?=[^>]*\bid="toast")(?=[^>]*\brole="status")(?=[^>]*\baria-live="polite")[^>]*>/);
});
