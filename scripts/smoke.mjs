// Headless smoke test of src/main.js: runs the real application modules against stub
// implementations of Monaco, xterm, sql.js, JSZip, WebContainers and a minimal DOM.
// It catches reference/type errors in startup and in the terminal, import and file flows.
// It does NOT replace testing in a real browser (see README "Verification").
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

/* ---- minimal DOM ---- */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, _attrs: {}, _listeners: {},
    classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, toggle(c, f) { const on = f ?? !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
    _text: '', value: '', checked: false, disabled: false, offsetParent: {}, scrollTop: 0, scrollHeight: 0,
    append(...n) { el.children.push(...n); }, replaceChildren() { el.children = []; }, remove() {}, focus() {}, click() {}, setAttribute(k, v) { el._attrs[k] = v; }, removeAttribute(k) { delete el._attrs[k]; }, getAttribute: k => el._attrs[k],
    addEventListener(t, f) { (el._listeners[t] ||= []).push(f); }, removeEventListener() {},
    querySelector: () => makeEl(), querySelectorAll: () => [], setSelectionRange() {}, insertRow: () => makeEl('tr'), insertCell: () => makeEl('td'), createTHead: () => makeEl(), createTBody: () => makeEl(),
    set innerHTML(v) { el._html = v; if (v === '') el.children = []; }, get innerHTML() { return el._html ?? ''; },
    set textContent(v) { el._text = String(v); if (v === '') el.children = []; }, get textContent() { return el._text + el.children.map(c => c.textContent ?? '').join(''); },
    selectionStart: 0, selectionEnd: 0, contentWindow: null
  };
  return el;
}
const byId = new Map(ids.map(id => [id, makeEl()]));
byId.get('sqlInput').value = '';
const document = {
  getElementById: id => { if (!byId.has(id)) throw new Error(`getElementById: unknown id "${id}"`); return byId.get(id); },
  createElement: makeEl, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, activeElement: null, visibilityState: 'visible',
  body: makeEl('body'), documentElement: makeEl('html')
};

/* ---- stubs for browser-only packages ---- */
const termOut = []; let termDataHandler = null;
const anyProxy = () => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : anyProxy()), apply: () => anyProxy(), construct: () => anyProxy() });
const disposable = () => ({ dispose() {} });
const stubs = {
  'monaco-editor': {
    editor: {
      create: () => ({ setModel() {}, getValue: () => '', addCommand() {}, onDidChangeCursorPosition: disposable, focus() {}, layout() {}, updateOptions() {}, revealLineInCenter() {}, setPosition() {}, getAction: () => null }),
      createModel: (value) => { let v = value; return { getValue: () => v, setValue: x => { v = x; }, onDidChangeContent: () => disposable(), dispose() {} }; },
      setTheme() {}, onDidChangeMarkers: disposable, getModelMarkers: () => []
    },
    languages: { typescript: { ScriptTarget: { ESNext: 99 }, ModuleKind: { ESNext: 99 }, ModuleResolutionKind: { NodeJs: 2 }, JsxEmit: { Preserve: 1 }, javascriptDefaults: { setCompilerOptions() {}, setDiagnosticsOptions() {} }, typescriptDefaults: { setCompilerOptions() {}, setDiagnosticsOptions() {} } } },
    KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49, Enter: 3 }, MarkerSeverity: { Warning: 4, Error: 8 }, Uri: { file: p => ({ path: p }) }
  },
  xterm: { Terminal: class { constructor() { this.cols = 80; this.rows = 24; this.options = {}; } open() {} loadAddon() {} write(s) { termOut.push(s); } clear() { termOut.length = 0; } focus() {} onData(f) { termDataHandler = f; } } },
  'xterm-addon-fit': { FitAddon: class { fit() {} } },
  jszip: { default: class JSZip { static async loadAsync() { return { files: {} }; } file() {} folder() {} async generateAsync() { return new Blob([]); } } },
  'sql.js': { default: async () => ({ Database: class { exec() { return []; } run() {} getRowsModified() { return 0; } export() { return new Uint8Array(0); } close() {} } }) },
  'sql.js/dist/sql-wasm.wasm?url': { default: '/sql-wasm.wasm' },
  '@webcontainer/api': { WebContainer: { boot: async () => { throw new Error('stub'); } } },
  'xterm/css/xterm.css': {}, './monaco-env.js': {}
};

/* ---- sandbox globals ---- */
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, performance, TextEncoder, TextDecoder, URL, Blob, File, btoa, atob, Uint8Array, Map, Set, Promise, Error, JSON, Math, Date, RegExp, Symbol,
  document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, ResizeObserver: class { observe() {} },
  Worker: class { postMessage() {} terminate() {} }, location: { reload() {} }, crossOriginIsolated: false,
  addEventListener() {}, removeEventListener() {}, open() {}
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const cache = new Map();
async function load(spec, from) {
  if (spec in stubs) {
    const key = 'stub:' + spec;
    if (!cache.has(key)) {
      const names = Object.keys(stubs[spec]);
      const m = new vm.SyntheticModule(names, function () { names.forEach(n => this.setExport(n, stubs[spec][n])); }, { context: sandbox, identifier: key });
      cache.set(key, m);
    }
    return cache.get(key);
  }
  const file = spec.startsWith('.') ? path.resolve(path.dirname(fileURLToPath(from)), spec) : null;
  if (!file) throw new Error(`Unstubbed import: ${spec}`);
  const url = pathToFileURL(file).href;
  if (!cache.has(url)) cache.set(url, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context: sandbox, identifier: url }));
  return cache.get(url);
}
const entry = await load('./src/main.js', pathToFileURL(path.join(root, 'x.js')).href);
await entry.link(async (spec, ref) => load(spec, ref.identifier));
await entry.evaluate();
await new Promise(r => setTimeout(r, 300)); // let async startup finish

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failures++; };
const type = async s => { for (const ch of s) await termDataHandler(ch); await new Promise(r => setTimeout(r, 30)); };

check('startup rendered an explorer tree', byId.get('sideContent').children.length > 0);
check('welcome hidden because a file is open', byId.get('welcome').classList.contains('hidden'));
check('terminal registered input handler', typeof termDataHandler === 'function');

termOut.length = 0;
await type('help\r');
check('terminal "help" prints commands', termOut.join('').includes('workspace shell'));
termOut.length = 0;
await type('echo hi > smoke.txt\r');
await type('cat smoke.txt\r');
check('terminal echo/cat round-trips through the workspace', termOut.join('').includes('hi'));
termOut.length = 0;
await type('ls\r');
check('terminal ls lists starter files', termOut.join('').includes('README.md') && termOut.join('').includes('smoke.txt'));
termOut.length = 0;
await type('rm smoke.txt\r');
await type('cat smoke.txt\r');
check('rm removes the file', termOut.join('').includes('No such file'));
termOut.length = 0;
await type('curl x\r');
check('unknown commands are reported, not faked', termOut.join('').includes('not found'));
termOut.length = 0;
await type('sql "select 1"\r');
check('sql command reaches the database layer', termOut.join('').length > 0 && !termOut.join('').includes('undefined'));
const toasts = byId.get('toastStack').children.map(t => t.textContent);
console.log('toasts shown:', JSON.stringify(toasts));
check('app did not report a startup failure', !toasts.some(t => /failed to start/i.test(t)));
check('no unexpected failures', failures === 0);
if (failures) process.exit(1);
console.log('smoke test passed');
process.exit(0);
