// Isolated code runners. JavaScript runs in a throw-away Worker (killed on timeout).
// Python runs through Pyodide, which is downloaded from jsDelivr only after explicit consent.

export const PYODIDE_VERSION = '0.27.2';
export const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const JS_WORKER = `
const fmt = v => { if (typeof v === 'string') return v; if (v instanceof Error) return v.stack || String(v); try { return typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : String(v); } catch { return String(v); } };
const send = (type, args) => self.postMessage({ type, text: args.map(fmt).join(' ') });
for (const k of ['log','info','warn','error','debug']) console[k] = (...a) => send(k === 'debug' || k === 'info' ? 'log' : k, a);
self.onmessage = async e => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction(e.data.code)();
    if (result !== undefined) send('result', [result]);
  } catch (err) { send('error', [err]); }
  self.postMessage({ type: 'done' });
};`;

export function runJavaScript(code, onOutput, { timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(new Blob([JS_WORKER], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const finish = status => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(status); };
    const timer = setTimeout(() => { onOutput('error', `Execution stopped after ${timeoutMs / 1000}s (possible infinite loop).`); finish('timeout'); }, timeoutMs);
    worker.onmessage = e => { if (e.data.type === 'done') finish('ok'); else onOutput(e.data.type, e.data.text); };
    worker.onerror = e => { onOutput('error', e.message || 'Worker error'); finish('error'); };
    worker.postMessage({ code });
  });
}

const PY_WORKER = (base) => `
let pyodide = null;
const post = (type, text) => self.postMessage({ type, text });
async function boot() {
  importScripts(${JSON.stringify(base + 'pyodide.js')});
  pyodide = await loadPyodide({ indexURL: ${JSON.stringify(base)} });
  pyodide.setStdout({ batched: s => post('log', s) });
  pyodide.setStderr({ batched: s => post('error', s) });
}
self.onmessage = async e => {
  const { id, code, files } = e.data;
  try {
    if (!pyodide) { post('log', 'Loading Pyodide (first run only)…'); await boot(); }
    for (const [path, content] of files) {
      const parts = path.split('/'); let dir = '';
      for (const p of parts.slice(0, -1)) { dir += '/' + p; try { pyodide.FS.mkdir(dir); } catch {} }
      pyodide.FS.writeFile('/' + path, content);
    }
    pyodide.FS.chdir('/');
    const result = await pyodide.runPythonAsync(code);
    if (result !== undefined && result !== null) post('result', String(result));
  } catch (err) { post('error', String(err && err.message || err)); }
  self.postMessage({ type: 'done', id });
};`;

let pyWorker = null;
export function resetPython() { pyWorker?.terminate(); pyWorker = null; }

export function runPython(code, files, onOutput, { timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    if (!pyWorker) pyWorker = new Worker(URL.createObjectURL(new Blob([PY_WORKER(PYODIDE_BASE)], { type: 'text/javascript' })));
    const w = pyWorker;
    const timer = setTimeout(() => { onOutput('error', `Python run stopped after ${timeoutMs / 1000}s.`); resetPython(); resolve('timeout'); }, timeoutMs);
    w.onmessage = e => { if (e.data.type === 'done') { clearTimeout(timer); resolve('ok'); } else onOutput(e.data.type, e.data.text); };
    w.onerror = e => { clearTimeout(timer); onOutput('error', e.message || 'Python worker error'); resetPython(); resolve('error'); };
    const textFiles = [...files].filter(([, v]) => typeof v === 'string' || v instanceof Uint8Array);
    w.postMessage({ code, files: textFiles });
  });
}
