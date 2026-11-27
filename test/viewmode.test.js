import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeView, stepFont, FONT_STEPS } from '../src/lib/viewmode.js';
import { detectRuntimeSupport, browserFamily } from '../src/lib/support.js';

const phoneUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

test('phone in normal mode and phone in "desktop site" mode both get the compact touch layout', () => {
  const normal = computeView({ innerWidth: 412, screenW: 412, screenH: 915, coarse: true, ua: phoneUA });
  assert.deepEqual([normal.compact, normal.touch, normal.desktopSite], [true, true, false]);
  const desktopSite = computeView({ innerWidth: 980, screenW: 412, screenH: 915, coarse: true, ua: desktopUA });
  assert.deepEqual([desktopSite.compact, desktopSite.touch, desktopSite.desktopSite], [true, true, true]);
});
test('real desktops, narrow desktop windows and large tablets', () => {
  assert.equal(computeView({ innerWidth: 1440, screenW: 1920, screenH: 1080, coarse: false, ua: desktopUA }).compact, false);
  assert.equal(computeView({ innerWidth: 700, screenW: 1920, screenH: 1080, coarse: false, ua: desktopUA }).compact, true, 'narrow window still compact');
  const tablet = computeView({ innerWidth: 1180, screenW: 1180, screenH: 820 + 40, coarse: true, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605' });
  assert.equal(tablet.compact, false); assert.equal(tablet.touch, true); assert.equal(tablet.ios, true);
});
test('the user override wins in both directions', () => {
  const desk = { innerWidth: 1440, screenW: 1920, screenH: 1080, coarse: false, ua: desktopUA };
  const phone = { innerWidth: 412, screenW: 412, screenH: 915, coarse: true, ua: phoneUA };
  assert.equal(computeView(desk, 'mobile').compact, true);
  assert.equal(computeView(phone, 'desktop').compact, false);
});
test('index.html first-paint script mirrors the auto rule (same thresholds and settings key)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<=820/); assert.match(html, /innerWidth<=760/); assert.match(html, /byteforge\.settings/); assert.match(html, /\(pointer: coarse\)/);
  const vp = /<meta name="viewport" content="([^"]*)"/.exec(html)[1];
  assert.ok(!/user-scalable\s*=\s*(no|0)/i.test(vp) && !/maximum-scale/i.test(vp), 'zooming must never be disabled');
  assert.match(vp, /width=device-width/);
});
test('stepFont walks the offered sizes and clamps', () => {
  assert.equal(stepFont(14, 1), 16); assert.equal(stepFont(14, -1), 13);
  assert.equal(stepFont(FONT_STEPS.at(-1), 1), FONT_STEPS.at(-1)); assert.equal(stepFont(FONT_STEPS[0], -1), FONT_STEPS[0]);
  assert.equal(stepFont(15, 1), 18, 'off-grid sizes snap up first');
});

test('runtime support: blockers vs warnings per environment', () => {
  const ok = { crossOriginIsolated: true, sharedArrayBuffer: true, webAssembly: true, userAgent: desktopUA, coarsePointer: false, screenMin: 1080 };
  let r = detectRuntimeSupport(ok); assert.ok(r.canBoot); assert.deepEqual(r.blockers, []); assert.deepEqual(r.warnings, []);
  r = detectRuntimeSupport({ ...ok, crossOriginIsolated: false }); assert.ok(!r.canBoot); assert.match(r.blockers[0], /cross-origin isolated/);
  r = detectRuntimeSupport({ ...ok, sharedArrayBuffer: false }); assert.ok(!r.canBoot); assert.match(r.blockers[0], /SharedArrayBuffer/);
  r = detectRuntimeSupport({ ...ok, webAssembly: false }); assert.ok(!r.canBoot);
  r = detectRuntimeSupport({ ...ok, userAgent: phoneUA, coarsePointer: true, screenMin: 412 }); assert.ok(r.canBoot && r.mobile); assert.match(r.warnings[0], /not officially supported/);
  r = detectRuntimeSupport({ ...ok, userAgent: desktopUA.replace('Chrome/130.0 ', '').replace('Safari', 'Firefox/130.0 Safari'), coarsePointer: false });
  assert.equal(browserFamily('Mozilla/5.0 Firefox/130.0'), 'firefox'); assert.equal(browserFamily('Mozilla/5.0 (Macintosh) Version/17 Safari/605.1.15'), 'safari');
});
