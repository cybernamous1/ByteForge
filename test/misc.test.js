import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview, resolveRef } from '../src/lib/preview.js';
import { searchFiles } from '../src/lib/search.js';
import { toFileSystemTree } from '../src/lib/wctree.js';
import { sqlLiteral, toCsv, dumpSql, toTextTable } from '../src/lib/sqlutil.js';

test('resolveRef handles relative, absolute and external references', () => {
  assert.equal(resolveRef('site', 'css/a.css'), 'site/css/a.css');
  assert.equal(resolveRef('site/pages', '../a.css'), 'site/a.css');
  assert.equal(resolveRef('', '/x/y.js?v=1'), 'x/y.js');
  assert.equal(resolveRef('', 'https://cdn.example.com/x.js'), null);
  assert.equal(resolveRef('', '../../escape'), null);
});
test('preview inlines css, classic scripts and images; reports missing/module assets', () => {
  const files = new Map([
    ['index.html', '<html><head><link rel="stylesheet" href="s.css"></head><body><img src="p.png"><script src="a.js"></script><script type="module" src="m.js"></script><script src="gone.js"></script></body></html>'],
    ['s.css', 'body{color:red}'], ['a.js', 'var x="</script>";'], ['m.js', 'export{}'], ['p.png', new Uint8Array([1, 2, 3])]
  ]);
  const { html, notes } = buildPreview(files, 'index.html');
  assert.match(html, /<style data-from="s\.css">body\{color:red\}<\/style>/);
  assert.match(html, /src="data:image\/png;base64,AQID"/);
  assert.ok(!html.includes('var x="</script>"'));
  assert.match(html, /<script  ?data-from="a\.js">/);
  assert.ok(html.includes('__bf'));
  assert.equal(notes.length, 2);
});
test('search supports literal, regex, case and binary skipping', () => {
  const files = new Map([['a.js', 'Foo(1)\nfoo(2)'], ['b.bin', new Uint8Array([1])]]);
  assert.equal(searchFiles(files, 'foo(').results.length, 2);
  assert.equal(searchFiles(files, 'foo(', { caseSensitive: true }).results.length, 1);
  assert.equal(searchFiles(files, 'f.o\\(\\d', { regex: true }).results.length, 2);
  assert.ok(searchFiles(files, '(', { regex: true }).error);
});
test('WebContainer tree keeps empty folders and binary contents', () => {
  const t = toFileSystemTree(new Map([['src/a.js', 'x'], ['b.bin', new Uint8Array([1])]]), ['empty/inner']);
  assert.deepEqual(t.empty.directory.inner, { directory: {} });
  assert.equal(t.src.directory['a.js'].file.contents, 'x');
  assert.ok(t['b.bin'].file.contents instanceof Uint8Array);
});
test('sql literals, csv and dump', () => {
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(new Uint8Array([255, 1])), "X'ff01'");
  assert.equal(toCsv(['a', 'b'], [[1, 'x,"y"']]), 'a,b\r\n1,"x,""y"""\r\n');
  const db = { exec(sql) {
    if (sql.includes('sqlite_master')) return [{ columns: [], values: [['table', 'notes', 'CREATE TABLE notes (id INTEGER, t TEXT)'], ['index', 'i', 'CREATE INDEX i ON notes(t)']] }];
    return [{ columns: ['id', 't'], values: [[1, "a'b"], [2, null]] }];
  } };
  const dump = dumpSql(db);
  assert.match(dump, /INSERT INTO "notes" \("id", "t"\) VALUES \(1, 'a''b'\);/);
  assert.match(dump, /VALUES \(2, NULL\);/);
  assert.ok(dump.indexOf('CREATE INDEX') > dump.indexOf('INSERT INTO'));
  assert.match(toTextTable(['a'], [[1]]), /a\n-\n1/);
});
