// Feature detection for the Node.js (WebContainer) runtime. Pure function of an environment snapshot,
// so it can be unit-tested; main.js passes the real browser values.

export function runtimeEnv(w = globalThis) {
  const nav = w.navigator ?? {};
  const match = q => { try { return !!w.matchMedia?.(q).matches; } catch { return false; } };
  return {
    crossOriginIsolated: !!w.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    userAgent: nav.userAgent ?? '',
    coarsePointer: match('(pointer: coarse)'),
    screenMin: Math.min(w.screen?.width ?? 9999, w.screen?.height ?? 9999)
  };
}

export function browserFamily(ua = '') {
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua) || /Chrome\/|CriOS\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua)) return 'safari';
  return 'unknown';
}

/**
 * @returns {{canBoot:boolean, blockers:string[], warnings:string[], browser:string, mobile:boolean}}
 * blockers make starting the runtime pointless; warnings are shown but do not stop the user from trying.
 */
export function detectRuntimeSupport(env) {
  const blockers = [], warnings = [];
  const browser = browserFamily(env.userAgent);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(env.userAgent) || (env.coarsePointer && env.screenMin <= 820);
  if (!env.webAssembly) blockers.push('WebAssembly is not available in this browser.');
  if (!env.crossOriginIsolated) blockers.push('This page is not cross-origin isolated (the host must send COOP: same-origin and COEP: require-corp, and the browser must honour them).');
  else if (!env.sharedArrayBuffer) blockers.push('SharedArrayBuffer is not available even though the page is isolated.');
  if (mobile) warnings.push('Phones and tablets are not officially supported by WebContainers. It may fail to boot, run out of memory or be very slow here.');
  if (browser === 'firefox') warnings.push('Firefox support for WebContainers is limited. A Chromium-based desktop browser is the most reliable choice.');
  if (browser === 'safari') warnings.push('Safari support for WebContainers is limited. A Chromium-based desktop browser is the most reliable choice.');
  return { canBoot: blockers.length === 0, blockers, warnings, browser, mobile };
}

/** What still works without the runtime; shown when it is unavailable. */
export const RUNTIME_FALLBACKS = [
  'Static preview of HTML/CSS/classic-script projects (Preview button).',
  'JavaScript runner (isolated Worker) and Python (Pyodide).',
  'SQLite Database Studio and the workspace shell.',
  'Download the project as a ZIP and run it on your own machine.'
];
