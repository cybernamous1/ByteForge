// Static preview builder: inlines workspace CSS/classic scripts/images into one HTML document
// that is rendered in a sandboxed iframe (no same-origin access to the workspace).
import { dirname, normalizePath, mimeFor, toBase64 } from './paths.js';

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export function resolveRef(baseDir, ref) {
  if (!ref || EXTERNAL.test(ref)) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  const joined = clean.startsWith('/') ? clean : (baseDir ? baseDir + '/' : '') + clean;
  const out = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return normalizePath(out.join('/'));
}

const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
const safeScript = s => s.replace(/<\/script/gi, '<\\/script');
const safeStyle = s => s.replace(/<\/style/gi, '<\\/style');

export const CONSOLE_BRIDGE = `<script>(function(){function s(t,a){try{parent.postMessage({__bf:1,type:t,text:a.map(function(x){try{return typeof x==='string'?x:(x instanceof Error?(x.stack||String(x)):JSON.stringify(x))}catch(e){return String(x)}}).join(' ')},'*')}catch(e){}}['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){s(k,[].slice.call(arguments));o.apply(console,arguments)}});addEventListener('error',function(e){s('error',[e.message+' ('+(e.filename||'inline')+':'+e.lineno+')'])});addEventListener('unhandledrejection',function(e){s('error',['Unhandled rejection: '+(e.reason&&e.reason.stack||e.reason)])});})();</script>`;

/**
 * @param files Map(path -> string|Uint8Array)
 * @param entry path of the HTML file to render
 * @returns {{html:string, notes:string[]}}
 */
export function buildPreview(files, entry) {
  const source = files.get(entry);
  if (typeof source !== 'string') throw new Error(`${entry} is not a text file`);
  const base = dirname(entry);
  const notes = [];
  const fileText = p => { const v = files.get(p); return typeof v === 'string' ? v : null; };

  let html = source.replace(/<link\b[^>]*>/gi, tag => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const p = resolveRef(base, attr(tag, 'href'));
    if (!p) return tag;
    const css = fileText(p);
    if (css === null) { notes.push(`Stylesheet not found: ${p}`); return tag; }
    return `<style data-from="${p}">${safeStyle(css)}</style>`;
  });

  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (whole, attrs) => {
    const src = attr(attrs, 'src');
    if (src === null) return whole;
    const p = resolveRef(base, src);
    if (!p) return whole;
    if (/type\s*=\s*["']?module/i.test(attrs)) { notes.push(`Module script ${p} is not inlined. Use the Node.js runtime dev server for ES module graphs.`); return whole; }
    const js = fileText(p);
    if (js === null) { notes.push(`Script not found: ${p}`); return whole; }
    const rest = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '').trim();
    return `<script ${rest} data-from="${p}">${safeScript(js)}</script>`;
  });

  html = html.replace(/(<(?:img|source|video|audio|link)\b[^>]*\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi, (whole, pre, q, ref) => {
    const p = resolveRef(base, ref);
    if (!p || !files.has(p)) return whole;
    const v = files.get(p);
    const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
    return `${pre}${q}data:${mimeFor(p)};base64,${toBase64(bytes)}${q}`;
  });

  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + CONSOLE_BRIDGE);
  else html = CONSOLE_BRIDGE + html;
  return { html, notes };
}
