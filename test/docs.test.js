import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { HELP } from '../src/lib/shell.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const pages = ['docs', 'faq', 'privacy', 'terms', 'about'];

test('every internal link in the info pages and app resolves to a file', () => {
  for (const name of pages) {
    for (const m of read(`public/${name}.html`).matchAll(/href="(\/[^"#?]*)"/g)) {
      const target = m[1] === '/' ? 'index.html' : (m[1].startsWith('/site') || m[1].endsWith('.html') ? 'public' + m[1] : null);
      if (target) assert.ok(existsSync(new URL('../' + target, import.meta.url)), `${name}.html links to missing ${m[1]}`);
    }
  }
  for (const m of read('src/main.js').matchAll(/href="(\/[a-z]+\.html)"/g)) assert.ok(existsSync(new URL('../public' + m[1], import.meta.url)), `main.js links to missing ${m[1]}`);
});
test('documented shell commands match the shell help text', () => {
  const docs = read('public/docs.html');
  const documented = /<code>help ls tree cat head tail mkdir touch rm mv cp echo grep wc node python sql run sync preview clear<\/code>/.test(docs);
  assert.ok(documented, 'docs.html command list changed');
  for (const cmd of 'ls tree cat head tail mkdir touch rm mv cp echo grep wc node python sql run sync preview clear'.split(' ')) assert.ok(new RegExp(`\\b${cmd}\\b`).test(HELP), `help text lacks ${cmd}`);
});
test('headers enable cross-origin isolation required by WebContainers', () => {
  const h = read('public/_headers');
  assert.match(h, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(h, /Cross-Origin-Embedder-Policy: require-corp/);
});
test('no external network host is hard-coded in app source except the documented ones', () => {
  const allowed = ['cdn.jsdelivr.net'];
  const src = ['src/main.js', 'src/ui.js', 'src/lib/runner.js', 'src/lib/preview.js'].map(read).join('\n');
  const hosts = new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]));
  for (const h of hosts) assert.ok(allowed.includes(h), `undocumented external host in source: ${h}`);
});
