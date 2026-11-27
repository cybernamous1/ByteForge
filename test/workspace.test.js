import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../src/lib/workspace.js';

const mk = () => { const w = new Workspace(); w.write('a.txt', 'A'); w.write('src/b.js', 'B'); w.write('src/deep/c.js', 'C'); w.mkdir('empty'); return w; };

test('write/read/list', () => {
  const w = mk();
  assert.equal(w.read('src/b.js'), 'B');
  assert.deepEqual(w.list('').map(e => e.name), ['empty', 'src', 'a.txt']);
  assert.deepEqual(w.list('src').map(e => e.name), ['deep', 'b.js']);
});
test('rejects traversal and file/dir conflicts', () => {
  const w = mk();
  assert.throws(() => w.write('../x', '1'));
  assert.throws(() => w.write('src', '1'), /directory/);
  assert.throws(() => w.write('a.txt/inner', '1'), /is a file/);
  assert.throws(() => w.mkdir('a.txt'));
});
test('remove directory is recursive and emits removed paths', () => {
  const w = mk(); const ev = [];
  w.on(e => ev.push(e));
  const removed = w.remove('src');
  assert.deepEqual(removed.sort(), ['src/b.js', 'src/deep/c.js']);
  assert.ok(!w.dirExists('src'));
  assert.equal(ev.at(-1).isDir, true);
});
test('move file, move directory with empty folders, guard collisions', () => {
  const w = mk(); w.mkdir('src/emptyinner');
  w.move('a.txt', 'z.txt'); assert.ok(w.fileExists('z.txt') && !w.fileExists('a.txt'));
  const moved = w.move('src', 'lib');
  assert.equal(moved.length, 2);
  assert.ok(w.fileExists('lib/deep/c.js') && w.folders.has('lib/emptyinner'));
  assert.throws(() => w.move('lib', 'z.txt'), /exists/);
  assert.throws(() => w.move('lib', 'lib/inner'), /itself/);
});
test('copy duplicates binary data rather than aliasing it', () => {
  const w = new Workspace(); const bytes = new Uint8Array([1, 2, 3]);
  w.write('x.bin', bytes); w.copy('x.bin', 'y.bin');
  w.read('y.bin')[0] = 9;
  assert.equal(w.read('x.bin')[0], 1);
});
test('update is a no-op for unknown files', () => {
  const w = mk(); w.update('nope', 'x'); assert.ok(!w.fileExists('nope'));
  w.update('a.txt', 'new'); assert.equal(w.read('a.txt'), 'new');
});
