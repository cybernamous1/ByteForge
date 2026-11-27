import test from 'node:test';
import assert from 'node:assert/strict';
import { scanContent } from '../src/lib/secrets.js';

const types = (p, c) => scanContent(p, c).map(f => f.type);

test('detects provider formats', () => {
  assert.ok(types('a.js', 'const k = "AKIAIOSFODNN7EXAMPLE";').includes('AWS access key ID'));
  assert.ok(types('a.js', 'x = ghp_' + 'a'.repeat(36)).includes('GitHub token'));
  assert.ok(types('k.pem', '-----BEGIN RSA PRIVATE KEY-----').includes('Private key block'));
  assert.ok(types('a.js', 'url=postgres://user:hunter22@db.example.com/app').includes('Database URL with credentials'));
  assert.ok(types('a.js', 'sk_live_' + 'a1b2c3d4e5f6g7h8i9').includes('Stripe live key'));
});
test('detects credential assignments', () => {
  assert.equal(types('.env', 'API_KEY=abcd1234efgh5678').length, 1);
  assert.equal(types('c.js', 'const password = "hunter2hunter2";').length, 1);
});
test('ignores placeholders, templates and code references', () => {
  assert.equal(types('.env.example', 'API_KEY=abcd1234efgh5678').length, 0);
  assert.equal(types('.env', 'API_KEY=replace_me_please').length, 0);
  assert.equal(types('a.js', 'const token = process.env.API_TOKEN;').length, 0);
  assert.equal(types('a.js', 'const token = getToken(user);').length, 0);
  assert.equal(types('a.js', 'password: "<your-password>"').length, 0);
});
test('findings never contain the full secret', () => {
  const f = scanContent('.env', 'SECRET_KEY=supersecretvalue123')[0];
  assert.ok(!f.preview.includes('supersecretvalue123'));
  assert.equal(f.line, 1);
});
test('non-text and oversized content is skipped safely', () => {
  assert.deepEqual(scanContent('x.bin', new Uint8Array(4)), []);
});
