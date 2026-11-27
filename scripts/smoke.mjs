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
    set textContent(v) { el._text = String(v); if (v === '') el.children = []; }, get textContent() { return el._text + el.children.map(c => (typeof c === 'string' ? c : c.textContent ?? '')).join(''); },
    selectionStart: 0, selectionEnd: 0, contentWindow: null
  };
  return el;
}
const byId = new Map(ids.map(id => [id, makeEl()]));
const activityBtns = ['explorer', 'search', 'database', 'terminal', 'settings', 'help'].map(p => { const b = makeEl('button'); b.dataset.panel = p; return b; });
byId.get('sqlInput').value = '';
const document = {
  getElementById: id => { if (!byId.has(id)) throw new Error(`getElementById: unknown id "${id}"`); return byId.get(id); },
  createElement: makeEl, querySelectorAll: sel => (sel === '.activity' ? activityBtns : []), addEventListener() {}, removeEventListener() {}, activeElement: null, visibilityState: 'visible',
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
  Worker: class { postMessage() {} terminate() {} }, ReadableStream, WritableStream, location: { reload() {} }, crossOriginIsolated: false,
  addEventListener() {}, removeEventListener() {}, open(u) { sandbox.__opened.push(u); return {}; }, __opened: []
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

/* ---- runtime fallback, multi-server preview and managed processes (fake WebContainer) ---- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const allText = el => (typeof el === 'string' ? el : (el._text ?? '') + (el.children || []).map(allText).join(''));
const walk = (el, fn) => { fn(el); (el.children || []).forEach(c => typeof c !== 'string' && walk(c, fn)); };
const findBtn = (root, label) => { let hit = null; walk(root, e => { if (!hit && e.tagName === 'BUTTON' && e._text === label) hit = e; }); return hit; };
const clickModal = async label => { await sleep(20); const b = byId.get('modalActions').children.find(x => x._text === label); if (!b) throw new Error('modal button not found: ' + label); b.onclick(); await sleep(20); };

// 1. unsupported browser: clear explanation + fallbacks, nothing pretends to work
sandbox.crossOriginIsolated = false;
termOut.length = 0;
await type('run\r');
check('runtime unavailable is explained with fallbacks', termOut.join('').includes('unavailable') && termOut.join('').includes('static preview'));
check('fallback toast offers the static preview', byId.get('toastStack').children.some(t => allText(t).includes('Open static preview')));

// 2. supported browser with a controllable fake WebContainer
const handlers = {}; const spawned = []; const shellWrites = [];
const fakeProc = name => { let ctrl, fin; const exit = new Promise(r => { fin = r; }); const output = new ReadableStream({ start(c) { ctrl = c; } });
  return { name, output, exit, killed: 0, kill() { this.killed++; try { ctrl.close(); } catch {} fin(130); }, say: t => ctrl.enqueue(t), input: { getWriter: () => ({ write: d => shellWrites.push(d) }) }, resize() {} }; };
stubs['@webcontainer/api'].WebContainer.boot = async () => ({
  mount: async () => {}, on: (ev, fn) => { handlers[ev] = fn; },
  spawn: async (cmd, args) => { const p = fakeProc(cmd + ' ' + (Array.isArray(args) ? args : []).join(' ')); spawned.push(p); return p; },
  fs: { readdir: async () => [], mkdir: async () => {}, writeFile: async () => {}, rm: async () => {}, readFile: async () => new Uint8Array() }
});
sandbox.crossOriginIsolated = true;
termOut.length = 0; byId.get('toastStack').children.length = 0;
await type('run\r');
await clickModal('Start runtime'); await sleep(50);
check('runtime boots and attaches a shell', termOut.join('').includes('Real Node.js shell attached'));
check('runtime status updated', byId.get('runtimeStatus').textContent.includes('Ready'));

termOut.length = 0;
handlers['port'](5173, 'open', 'https://a.test/'); handlers['server-ready'](5173, 'https://a.test/');
check('server-ready names the SANDBOX localhost', termOut.join('').includes('sandbox localhost:5173') && termOut.join('').includes("not your device"));
check('preview pane opens on the server URL', !byId.get('previewPane').classList.contains('hidden') && byId.get('previewFrame').src === 'https://a.test/');
check('origin badge distinguishes sandbox localhost', byId.get('previewOrigin').textContent === 'sandbox localhost:5173');
check('address bar and stop button shown for runtime previews', !byId.get('previewUrlBar').classList.contains('hidden') && !byId.get('previewStop').classList.contains('hidden'));

handlers['server-ready'](3000, 'https://b.test/');
check('second server is tracked (multi-server) and badge counts both', byId.get('serverBadge').textContent === '2');
check('selector lists both servers', byId.get('previewServer').children.filter(o => /sandbox localhost/.test(o.textContent)).length === 2);
byId.get('previewServer').onchange({ target: { value: '5173' } });
check('switching servers loads the other URL', byId.get('previewFrame').src === 'https://a.test/');
byId.get('previewPath').value = 'localhost:5173/docs'; byId.get('previewGo').onclick();
check('address bar navigates inside the sandbox origin', byId.get('previewFrame').src === 'https://a.test/docs');
const toastsBefore = byId.get('toastStack').children.length;
byId.get('previewPath').value = 'https://evil.test/'; byId.get('previewGo').onclick();
check('foreign origins are refused', byId.get('previewFrame').src === 'https://a.test/docs' && byId.get('toastStack').children.length > toastsBefore);
byId.get('previewExternal').onclick();
check('open-in-new-tab opens the runtime URL', sandbox.__opened.includes('https://a.test/docs'));
byId.get('previewStop').onclick();
check('stopping a shell-started server sends Ctrl+C to the shell, with an honest toast', shellWrites.includes('\x03'));
handlers['port'](5173, 'close'); handlers['port'](3000, 'close');
check('closed ports are removed and preview shows stopped state', byId.get('serverBadge').classList.contains('hidden') && byId.get('previewFrame').srcdoc.includes('is not running'));

// 3. Start button -> managed process -> ownership -> real stop/restart
activityBtns[3].onclick();                                   // opens "Terminal & Runtime"
const side = byId.get('sideContent');
const startBtn = findBtn(side, '▶ Start');
check('side panel lists package.json scripts with Start buttons', !!startBtn);
await startBtn.onclick(); await sleep(30);
const npm = spawned.find(p => p.name.startsWith('npm run'));
check('Start spawns "npm run <script>" as a managed process', !!npm && /npm run (start|dev)/.test(npm.name));
npm.say('Local: http://localhost:4000\n'); await sleep(20);
check('process output lands in the Servers log', allText(byId.get('serversPanel')).includes('Local: http://localhost:4000'));
handlers['server-ready'](4000, 'https://c.test/');
const owned = findBtn(byId.get('sideContent'), 'Restart');
check('managed server offers Restart (ownership detected)', !!owned);
findBtn(byId.get('sideContent'), 'Stop').onclick(); await sleep(30);
check('Stop kills the real process', npm.killed === 1);
check('stopped process drops its server from the list', byId.get('serverBadge').classList.contains('hidden'));

// 4. new tab for static previews is a sandboxed wrapper (blob URL created, window opened)
let blobCount = 0; const origCreate = URL.createObjectURL; URL.createObjectURL = b => { blobCount++; return 'blob:test/' + blobCount; };
byId.get('previewServer').onchange({ target: { value: 'static' } });
byId.get('previewExternal').onclick();
check('static preview opens in its own tab via a blob wrapper', sandbox.__opened.some(u => String(u).startsWith('blob:test/')));
URL.createObjectURL = origCreate;
check('no unexpected failures', failures === 0);
if (failures) process.exit(1);
console.log('smoke test passed');
process.exit(0);
