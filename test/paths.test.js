import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, languageFor, isEnvFile, buildTree, decodeBytes, isSqliteBytes, shouldIgnoreImport, formatBytes } from '../src/lib/paths.js';

test('normalizePath rejects traversal and cleans separators', () => {
  assert.equal(normalizePath('../etc/passwd'), null);
  assert.equal(normalizePath('a/../../b'), null);
  assert.equal(normalizePath('/abs/file.js'), 'abs/file.js');
  assert.equal(normalizePath('.\\src\\main.js'), 'src/main.js');
  assert.equal(normalizePath('a//b/./c'), 'a/b/c');
  assert.equal(normalizePath(''), null);
  assert.equal(normalizePath('a/\u0000b'), null);
});
test('languageFor', () => {
  assert.equal(languageFor('src/a.tsx'), 'typescript');
  assert.equal(languageFor('.env.local'), 'ini');
  assert.equal(languageFor('Dockerfile'), 'dockerfile');
  assert.equal(languageFor('noext'), 'plaintext');
});
test('isEnvFile treats templates as safe', () => {
  assert.ok(isEnvFile('.env'));
  assert.ok(isEnvFile('config/.env.production'));
  assert.ok(!isEnvFile('.env.example'));
  assert.ok(!isEnvFile('environment.js'));
});
test('buildTree sorts folders first and keeps empty folders', () => {
  const t = buildTree(['b.js', 'src/a.js', 'src/deep/x.js'], ['empty']);
  assert.deepEqual(t.children.map(c => c.name), ['empty', 'src', 'b.js']);
  assert.equal(t.children[1].children[0].name, 'deep');
});
test('decodeBytes distinguishes text from binary', () => {
  assert.equal(decodeBytes(new TextEncoder().encode('héllo')), 'héllo');
  const bin = new Uint8Array([137, 80, 78, 71, 0, 1]);
  assert.ok(decodeBytes(bin) instanceof Uint8Array);
  assert.ok(decodeBytes(new Uint8Array([0xff, 0xfe, 0xfd])) instanceof Uint8Array);
});
test('sqlite header detection, import ignores, byte formatting', () => {
  const h = new Uint8Array(32); [...'SQLite format 3\0'].forEach((c, i) => (h[i] = c.charCodeAt(0)));
  assert.ok(isSqliteBytes(h));
  assert.ok(!isSqliteBytes(new Uint8Array(32)));
  assert.ok(shouldIgnoreImport('a/node_modules/x.js'));
  assert.ok(!shouldIgnoreImport('src/x.js'));
  assert.equal(formatBytes(2048), '2.0 KB');
});
