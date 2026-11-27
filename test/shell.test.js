import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../src/lib/workspace.js';
import { createShell, tokenize } from '../src/lib/shell.js';

const setup = () => { const ws = new Workspace(); ws.write('README.md', '# Hi\nline2\n'); ws.write('src/app.js', "console.log('x')\n"); return { ws, sh: createShell(ws) }; };

test('tokenize handles quotes and redirects', () => {
  assert.deepEqual(tokenize('echo "a b" c').args, ['echo', 'a b', 'c']);
  assert.deepEqual(tokenize('echo hi>>f.txt').args, ['echo', 'hi', '>>', 'f.txt']);
  assert.equal(tokenize('echo "oops').error, 'Unterminated quote');
  assert.deepEqual(tokenize("echo ''").args, ['echo', '']);
});
test('ls, cat, tree, wc, head operate on the workspace', () => {
  const { sh } = setup();
  assert.equal(sh.exec('ls').output, 'src/\nREADME.md');
  assert.equal(sh.exec('cat README.md').output, '# Hi\nline2');
  assert.match(sh.exec('tree').output, /src\/\n.*app\.js/s);
  assert.match(sh.exec('wc README.md').output, /^2 3 11 README\.md$/);
  assert.equal(sh.exec('head -n 1 README.md').output, '# Hi');
});
test('mutating commands really change the workspace', () => {
  const { ws, sh } = setup();
  sh.exec('mkdir docs'); assert.ok(ws.dirExists('docs'));
  sh.exec('touch docs/a.txt'); assert.ok(ws.fileExists('docs/a.txt'));
  sh.exec('echo hello > docs/a.txt'); assert.equal(ws.read('docs/a.txt'), 'hello\n');
  sh.exec('echo more >> docs/a.txt'); assert.equal(ws.read('docs/a.txt'), 'hello\nmore\n');
  sh.exec('mv docs/a.txt docs/b.txt'); assert.ok(ws.fileExists('docs/b.txt'));
  sh.exec('cp docs/b.txt c.txt'); assert.equal(ws.read('c.txt'), 'hello\nmore\n');
  assert.equal(sh.exec('rm docs').code, 1);
  assert.equal(sh.exec('rm -r docs').code, 0); assert.ok(!ws.dirExists('docs'));
});
test('traversal and unknown commands are rejected honestly', () => {
  const { sh } = setup();
  assert.equal(sh.exec('cat ../secret').code, 1);
  assert.equal(sh.exec('curl example.com').code, 127);
  assert.match(sh.exec('curl example.com').output, /not found/);
});
test('grep finds matches with file and line', () => {
  const { sh } = setup();
  assert.equal(sh.exec('grep console').output, "src/app.js:1:console.log('x')");
  assert.equal(sh.exec('grep -i HI README.md').output, 'README.md:1:# Hi');
  assert.equal(sh.exec('grep nomatch').code, 1);
});
test('runtime commands are returned as actions, never faked', () => {
  const { sh } = setup();
  assert.deepEqual(sh.exec('node src/app.js').action, { type: 'node', path: 'src/app.js' });
  assert.equal(sh.exec('node missing.js').code, 1);
  assert.equal(sh.exec('run').action.type, 'boot');
  assert.equal(sh.exec('sql "select 1"').action.query, 'select 1');
});
test('tab completion', () => {
  const { sh } = setup();
  assert.deepEqual(sh.complete('sr'), ['src/']);
  assert.deepEqual(sh.complete('src/a'), ['src/app.js']);
});
