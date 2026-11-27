import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

for (const file of ['src/main.js', 'src/ui.js']) {
  test(`${file}: every $('id') lookup exists in index.html`, () => {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const used = new Set([...src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
    const missing = [...used].filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `ids missing from index.html: ${missing.join(', ')}`);
    assert.ok(used.size > 5);
  });
}
test('index.html ids are unique', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(all.length, new Set(all).size);
});
test('data-panel and data-bottom targets are handled', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  for (const m of html.matchAll(/data-panel="([^"]+)"/g)) assert.ok(main.includes(`${m[1]}:`), `side panel ${m[1]} has no renderer`);
  for (const m of html.matchAll(/data-bottom="([^"]+)"/g)) assert.ok(main.includes(`'${m[1]}'`), `bottom tab ${m[1]} unhandled`);
});
