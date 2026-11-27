import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerRegistry, ProcessManager, parseScripts, previewUrl, pathOf, portsFromText, stripAnsi, sandboxLabel, SANDBOX_NOTE } from '../src/lib/servers.js';
import { buildStandalonePreview } from '../src/lib/preview.js';

test('previewUrl keeps navigation inside the sandbox server origin', () => {
  const base = 'https://abc.webcontainer.example/';
  assert.equal(previewUrl(base, ''), base);
  assert.equal(previewUrl(base, '/about'), base + 'about');
  assert.equal(previewUrl(base, 'about?x=1'), base + 'about?x=1');
  assert.equal(previewUrl(base, 'localhost:5173/docs'), base + 'docs');
  assert.equal(previewUrl(base, 'http://127.0.0.1:3000'), base);
  assert.equal(previewUrl(base, 'https://evil.example/x'), null);
  assert.equal(previewUrl(base, '//evil.example/x'), null);
  assert.equal(previewUrl('not a url', '/x'), null);
  assert.equal(pathOf(base + 'a/b?c=1#d'), '/a/b?c=1#d');
});

test('parseScripts ranks server scripts first and reports invalid JSON', () => {
  const r = parseScripts(JSON.stringify({ scripts: { build: 'vite build', test: 'node --test', dev: 'vite', start: 'node server.js', lint: 'eslint .' } }));
  assert.deepEqual(r.scripts.map(s => s.name), ['dev', 'start', 'build', 'lint', 'test']);
  assert.ok(r.scripts[0].server && r.scripts[1].server && !r.scripts[2].server);
  assert.deepEqual(parseScripts('{"name":"x"}').scripts, []);
  assert.match(parseScripts('{oops').error, /not valid JSON/);
  assert.equal(parseScripts('{"scripts":{"a":5}}').scripts.length, 0);
});

test('portsFromText and stripAnsi', () => {
  assert.deepEqual(portsFromText('  ➜  Local:   http://localhost:5173/\n  Network: http://0.0.0.0:5173/ and 127.0.0.1:3000'), [5173, 3000]);
  assert.deepEqual(portsFromText('port 70000 localhost:99999'), []);
  assert.equal(stripAnsi('\u001b[32mready\u001b[0m in \u001b[1m120ms\u001b[22m'), 'ready in 120ms');
  assert.match(sandboxLabel(3000), /sandbox localhost:3000/);
  assert.match(SANDBOX_NOTE, /not your device/);
});

test('ServerRegistry tracks several servers, active selection and closing', () => {
  const r = new ServerRegistry(); let changes = 0; r.onChange(() => changes++);
  r.open(5173, 'https://a/', { owner: 1 });                 // port opened, not yet ready
  assert.equal(r.active, null);
  r.open(5173, undefined, { ready: true });                   // server-ready merges into the same entry
  assert.equal(r.list().length, 1);
  assert.equal(r.active.port, 5173); assert.equal(r.get(5173).owner, 1); assert.equal(r.get(5173).url, 'https://a/');
  r.open(3000, 'https://b/', { ready: true });
  assert.deepEqual(r.list().map(s => s.port), [3000, 5173]);
  assert.equal(r.active.port, 3000, 'newest ready server becomes active');
  r.setActive(5173); assert.equal(r.active.port, 5173);
  r.close(5173); assert.equal(r.active.port, 3000, 'falls back to another ready server');
  r.close(3000); assert.equal(r.active, null);
  assert.equal(r.close(9), false);
  r.open(1, 'u', { ready: true, owner: 7 }); r.open(2, 'u2', { ready: true, owner: 8 }); r.closeOwned(7);
  assert.deepEqual(r.list().map(s => s.port), [2]);
  assert.ok(changes > 5);
});

function fakeProc() {
  let ctrl, finish; const exit = new Promise(r => { finish = r; });
  const output = new ReadableStream({ start(c) { ctrl = c; } });
  return { output, exit, killed: 0, kill() { this.killed++; try { ctrl.close(); } catch { /* already closed */ } finish(130); }, say: t => ctrl.enqueue(t), end: code => { try { ctrl.close(); } catch { /* closed */ } finish(code); } };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('ProcessManager starts, logs, attributes ports and really stops a process', async () => {
  const logs = [], changes = []; const p = fakeProc();
  const pm = new ProcessManager({ spawn: async (cmd, args) => { assert.equal(cmd, 'npm'); assert.deepEqual(args, ['run', 'dev']); return p; }, onLog: (rec, t) => logs.push(t), onChange: r => changes.push(r.status) });
  const rec = await pm.start('npm run dev', 'npm', ['run', 'dev'], { script: 'dev' });
  assert.equal(rec.status, 'running'); assert.equal(pm.running('server').length, 1);
  p.say('\u001b[32mLocal: http://localhost:5173\u001b[0m\n'); await tick();
  assert.ok(logs.join('').includes('Local: http://localhost:5173'), 'ANSI stripped, output forwarded');
  assert.equal(pm.ownerForNewPort(new Set()), rec.id);
  assert.equal(pm.ownerForNewPort(new Set([rec.id])), null, 'already-owning process is not guessed again');
  assert.equal(pm.stop(rec.id), true); await tick();
  assert.equal(p.killed, 1); assert.equal(rec.status, 'stopped');
  assert.equal(pm.stop(rec.id), false, 'cannot stop twice');
  assert.ok(changes.includes('stopped'));
  assert.equal(pm.forget(rec.id), true);
});

test('ProcessManager: ambiguous port ownership, natural exit and spawn failure', async () => {
  const a = fakeProc(), b = fakeProc(); const q = [a, b];
  const pm = new ProcessManager({ spawn: async () => q.shift() });
  await pm.start('one', 'npm', [], { script: 'a' }); const r2 = await pm.start('two', 'npm', [], { script: 'b' });
  assert.equal(pm.ownerForNewPort(new Set()), null, 'two candidates: never guess');
  b.end(1); await tick(); assert.equal(r2.status, 'exited'); assert.equal(r2.code, 1);
  const bad = new ProcessManager({ spawn: async () => { throw new Error('boom'); } });
  await assert.rejects(() => bad.start('x', 'npm', []), /boom/);
  assert.equal(bad.list()[0].status, 'failed');
});

test('standalone preview wrapper keeps project HTML in a sandboxed frame without allow-same-origin', () => {
  const out = buildStandalonePreview('<p title="a&b">"hi"</p><script>alert(1)</script>', 'My <app>');
  assert.match(out, /<title>My &lt;app><\/title>/);
  const sandbox = /sandbox="([^"]*)"/.exec(out)[1];
  assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'));
  assert.ok(out.includes('srcdoc="&lt;') === false && out.includes('&quot;hi&quot;') && out.includes('a&amp;b'));
});
