// Decides which layout ByteForge uses. The key case is a phone browser in "desktop site" mode: it reports a
// layout width of ~980px even though the device is a phone, so a pure width media query never sees a phone.
// We therefore look at the primary pointer (coarse = touch) and the physical screen size as well.
//
// NOTE: index.html contains a tiny inline copy of the "auto" rule so the first paint is already correct.
// Keep both in sync (test/viewmode.test.js checks the inline copy).

export const COMPACT_MAX_WIDTH = 760;
export const PHONE_MAX_SCREEN = 820;

/**
 * @param env {innerWidth, screenW, screenH, coarse, ua}
 * @param pref 'auto' | 'mobile' | 'desktop'
 * @returns {{compact:boolean, touch:boolean, desktopSite:boolean, ios:boolean}}
 */
export function computeView(env, pref = 'auto') {
  const screenMin = Math.min(env.screenW || 9999, env.screenH || 9999);
  const phoneScreen = screenMin <= PHONE_MAX_SCREEN;
  const touch = !!env.coarse;
  const narrow = env.innerWidth <= COMPACT_MAX_WIDTH;
  const desktopSite = touch && phoneScreen && env.innerWidth > COMPACT_MAX_WIDTH;
  let compact;
  if (pref === 'mobile') compact = true;
  else if (pref === 'desktop') compact = false;
  else compact = narrow || (touch && phoneScreen);
  const ios = /iP(hone|ad|od)/.test(env.ua || '') || (/Macintosh/.test(env.ua || '') && touch);
  return { compact, touch, desktopSite, ios };
}

export function viewEnv(w = globalThis) {
  let coarse = false;
  try { coarse = !!w.matchMedia?.('(pointer: coarse)').matches; } catch { /* matchMedia unavailable */ }
  return { innerWidth: w.innerWidth ?? 1280, screenW: w.screen?.width, screenH: w.screen?.height, coarse, ua: w.navigator?.userAgent ?? '' };
}

/** Next/previous editor font size from the steps offered in Settings. */
export const FONT_STEPS = [10, 12, 13, 14, 16, 18, 20, 24];
export function stepFont(current, dir) {
  const i = FONT_STEPS.findIndex(n => n >= current);
  const at = i < 0 ? FONT_STEPS.length - 1 : i;
  return FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, at + dir))];
}
