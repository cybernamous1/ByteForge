import './monaco-env.js';
import * as monaco from 'monaco-editor';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { WebContainer } from '@webcontainer/api';
import 'xterm/css/xterm.css';

import { Workspace } from './lib/workspace.js';
import { normalizePath, basename, dirname, languageFor, languageLabel, isEnvFile, shouldIgnoreImport, isSqliteBytes, decodeBytes, formatBytes, buildTree, mimeFor } from './lib/paths.js';
import { scanContent, scanAll } from './lib/secrets.js';
import { searchFiles } from './lib/search.js';
import { createShell } from './lib/shell.js';
import { buildPreview } from './lib/preview.js';
import { toFileSystemTree } from './lib/wctree.js';
import { toCsv, dumpSql, toTextTable } from './lib/sqlutil.js';
import { kvGet, kvSet, deleteEverything, storageEstimate, requestPersistence } from './lib/storage.js';
import { runJavaScript, runPython, resetPython, PYODIDE_VERSION } from './lib/runner.js';
import { toast, dialog, askInput, confirmDialog, escapeHtml, closeDialog } from './ui.js';

const $ = id => document.getElementById(id); // static ids declared in index.html only
const LEGACY_KEY = 'byteforge.workspace.v1';
const SETTINGS_KEY = 'byteforge.settings';
const MAX_IMPORT_FILE = 50 * 1024 * 1024;
const MAX_IMPORT_TOTAL = 300 * 1024 * 1024;
const MAX_IMPORT_COUNT = 5000;

const STARTER = {
  'README.md': '# ByteForge Project\n\nBuilt with ByteForge. Your project files are stored locally in this browser workspace.\n',
  'index.html': '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>My App</title>\n</head>\n<body>\n  <h1>Hello from ByteForge</h1>\n  <script src="app.js"></script>\n</body>\n</html>\n',
  'app.js': "console.log('Hello from ByteForge');\n",
  'package.json': '{\n  "name": "byteforge-project",\n  "version": "1.0.0",\n  "scripts": { "start": "vite --host 0.0.0.0" },\n  "devDependencies": { "vite": "^6.1.0" }\n}\n',
  '.env.example': 'API_KEY=replace_me\nDATABASE_URL=replace_me\n'
};
const DEFAULT_SQL = "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\nINSERT INTO notes (title) VALUES ('First note');\nSELECT * FROM notes;";
const DEFAULT_SETTINGS = { theme: 'dark', fontSize: 14, tabSize: 2, wordWrap: false, minimap: false, formatOnSave: false };

const ws = new Workspace();
const S = {
  project: 'untitled-project', open: [], active: null, side: 'explorer', bottom: 'terminal',
  collapsed: new Set(), settings: { ...DEFAULT_SETTINGS }, sqlText: DEFAULT_SQL,
  editor: null, models: new Map(), term: null, fit: null, termMode: 'lite', line: '', history: [], histIdx: -1, busy: false,
  db: null, SQL: null, lastResult: null,
  wc: null, wcShell: null, wcInput: null, serverUrl: null, syncing: false,
  secrets: new Map(), batch: false, storageOk: true, legacyPending: false, suppressModel: false, previewMode: null, previewEntry: null
};
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; };
const keyed = (fn, ms) => { const timers = new Map(); return key => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(key); }, ms)); }; };
const isBinary = p => ws.read(p) instanceof Uint8Array;

/* ───────────────────────── settings ───────────────────────── */
function loadSettings() {
  try { Object.assign(S.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* defaults */ }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* ignore */ } }
function applySettings() {
  const s = S.settings;
  document.documentElement.dataset.theme = s.theme;
  monaco.editor.setTheme(s.theme === 'light' ? 'vs' : 'vs-dark');
  S.editor?.updateOptions({ fontSize: s.fontSize, tabSize: s.tabSize, wordWrap: s.wordWrap ? 'on' : 'off', minimap: { enabled: s.minimap } });
  if (S.term) { S.term.options.theme = termTheme(); }
}
const termTheme = () => (S.settings.theme === 'light'
  ? { background: '#ffffff', foreground: '#1b2433', cursor: '#1b2433', selectionBackground: '#b8d3ff' }
  : { background: '#0e131c', foreground: '#dce6f6', cursor: '#ffffff' });

/* ───────────────────────── persistence ───────────────────────── */
function setSaveStatus(text) { $('saveStatus').textContent = text; }
async function saveWorkspace() {
  if (S.wiping) return;
  setSaveStatus('Saving…');
  try {
    await kvSet('workspace', { version: 2, project: S.project, files: [...ws.files], folders: [...ws.folders], open: S.open, active: S.active, sqlText: $('sqlInput').value, savedAt: Date.now() });
    S.storageOk = true; setSaveStatus('Saved locally');
    if (S.legacyPending) { try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ } S.legacyPending = false; }
  } catch (e) {
    setSaveStatus('NOT SAVED');
    if (S.storageOk) toast('Workspace could not be saved', `${e.message}. The browser storage may be full or disabled. Download a project backup now.`, { level: 'error', ttl: 0 });
    S.storageOk = false;
  }
}
const saveSoon = debounce(saveWorkspace, 700);
async function saveDatabase() {
  if (!S.db || S.wiping) return;
  try { await kvSet('sqlite', exportDb()); } catch (e) { toast('Database could not be saved', e.message, { level: 'error' }); }
}
const saveDbSoon = debounce(saveDatabase, 1000);

function repairLegacy(path, content) {
  // The first build wrote literal "\n" sequences into starter files; repair them.
  if (typeof content === 'string' && path in STARTER && !content.includes('\n') && content.includes('\\n')) return content.replace(/\\n/g, '\n');
  return content;
}
async function restore() {
  let data = null;
  try { data = await kvGet('workspace'); } catch (e) { S.storageOk = false; toast('Persistent storage unavailable', `${e.message}. Work in this session will not be kept after closing the tab. Export regularly.`, { level: 'warning', ttl: 0 }); }
  if (!data) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw) {
        const old = JSON.parse(raw);
        data = { project: old.project, files: (old.files || []).map(([p, c]) => [p, repairLegacy(p, c)]), folders: [], open: [], active: null };
        S.legacyPending = true;
        toast('Workspace upgraded', 'Your earlier workspace was migrated to IndexedDB storage.');
      }
    } catch { /* ignore */ }
  }
  if (data) {
    S.project = data.project || S.project;
    ws.load((data.files || []).filter(([p]) => normalizePath(p) === p), data.folders || []);
    S.open = (data.open || []).filter(p => ws.fileExists(p));
    S.active = ws.fileExists(data.active) ? data.active : null;
    if (typeof data.sqlText === 'string' && data.sqlText) S.sqlText = data.sqlText;
  }
  if (!ws.files.size && !ws.folders.size) {
    Object.entries(STARTER).forEach(([p, c]) => ws.files.set(p, c));
    S.open = ['README.md']; S.active = 'README.md';
  }
  $('projectName').textContent = S.project;
}

/* ───────────────────────── editor, models, tabs ───────────────────────── */
function initEditor() {
  const s = S.settings;
  S.editor = monaco.editor.create($('editor'), {
    model: null, theme: s.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout: true, minimap: { enabled: s.minimap },
    fontSize: s.fontSize, tabSize: s.tabSize, wordWrap: s.wordWrap ? 'on' : 'off', scrollBeyondLastLine: false, fixedOverflowWidgets: true
  });
  const ts = monaco.languages.typescript ?? monaco.typescript;
  if (ts) {
    const compilerOptions = { allowJs: true, allowNonTsExtensions: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.Preserve, esModuleInterop: true };
    ts.javascriptDefaults.setCompilerOptions(compilerOptions);
    ts.typescriptDefaults.setCompilerOptions(compilerOptions);
    // npm packages and Node globals are not available to the in-browser language service, so only syntax errors are reported.
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  S.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveNow());
  S.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runActive());
  S.editor.onDidChangeCursorPosition(e => { $('cursorStatus').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  monaco.editor.onDidChangeMarkers(() => renderProblems());
}
async function saveNow() {
  if (S.settings.formatOnSave && S.editor && S.active && !isBinary(S.active)) {
    try { await S.editor.getAction('editor.action.formatDocument')?.run(); } catch { /* language may not support formatting */ }
  }
  saveSoon.flush();
}
function modelFor(path) {
  let entry = S.models.get(path);
  if (entry) return entry.model;
  const model = monaco.editor.createModel(ws.read(path), languageFor(path), monaco.Uri.file('/' + path));
  const sub = model.onDidChangeContent(() => { if (!S.suppressModel) ws.update(path, model.getValue()); });
  S.models.set(path, { model, sub });
  return model;
}
function disposeModel(path) {
  const e = S.models.get(path);
  if (!e) return;
  e.sub.dispose(); e.model.dispose(); S.models.delete(path);
}
function syncModelFromWs(path) {
  const e = S.models.get(path); const v = ws.read(path);
  if (!e || typeof v !== 'string' || e.model.getValue() === v) return;
  S.suppressModel = true; try { e.model.setValue(v); } finally { S.suppressModel = false; }
}
function openFile(path, { line = null, col = 1 } = {}) {
  if (!ws.fileExists(path)) return;
  if (!S.open.includes(path)) S.open.push(path);
  setActive(path);
  if (line && S.editor && !isBinary(path)) { S.editor.revealLineInCenter(line); S.editor.setPosition({ lineNumber: line, column: col }); S.editor.focus(); }
  saveSoon();
}
function setActive(path) {
  S.active = path;
  const welcome = $('welcome'), editorEl = $('editor'), bin = $('binaryView');
  if (!path) {
    welcome.classList.remove('hidden'); editorEl.classList.add('hidden'); bin.classList.add('hidden');
    $('fileStatus').textContent = 'No file selected'; $('languageStatus').textContent = 'Plain Text'; $('cursorStatus').textContent = '';
  } else if (isBinary(path)) {
    welcome.classList.add('hidden'); editorEl.classList.add('hidden'); bin.classList.remove('hidden');
    renderBinary(path);
    $('fileStatus').textContent = path; $('languageStatus').textContent = 'Binary'; $('cursorStatus').textContent = '';
  } else {
    welcome.classList.add('hidden'); bin.classList.add('hidden'); editorEl.classList.remove('hidden');
    S.editor.setModel(modelFor(path));
    S.editor.focus();
    $('fileStatus').textContent = path; $('languageStatus').textContent = languageLabel(languageFor(path));
  }
  renderTabs(); renderExplorerIfVisible();
}
function renderBinary(path) {
  const bin = $('binaryView'); const bytes = ws.read(path);
  bin.innerHTML = '';
  const title = document.createElement('b'); title.textContent = path;
  const info = document.createElement('p'); info.className = 'muted'; info.textContent = `Binary file, ${formatBytes(bytes.length)}. ByteForge only edits text files.`;
  bin.append(title);
  if (/\.(png|jpe?g|gif|webp|ico|svg)$/i.test(path) || mimeFor(path).startsWith('image/')) {
    const img = document.createElement('img'); img.alt = path;
    img.src = URL.createObjectURL(new Blob([bytes], { type: mimeFor(path) })); img.onload = () => URL.revokeObjectURL(img.src);
    bin.append(img);
  }
  const dl = document.createElement('button'); dl.textContent = 'Download file'; dl.onclick = () => downloadFile(path);
  bin.append(info, dl);
}
function closeTab(path) {
  const i = S.open.indexOf(path); if (i < 0) return;
  S.open.splice(i, 1); disposeModel(path);
  if (S.active === path) setActive(S.open[Math.min(i, S.open.length - 1)] ?? null); else renderTabs();
  saveSoon();
}
function renderTabs() {
  const host = $('tabs'); host.innerHTML = '';
  for (const path of S.open) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === S.active ? ' active' : ''); tab.setAttribute('role', 'tab'); tab.tabIndex = 0;
    tab.setAttribute('aria-selected', String(path === S.active)); tab.title = path;
    const name = document.createElement('span'); name.textContent = basename(path);
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Close'; x.setAttribute('aria-label', `Close ${path}`);
    x.onclick = e => { e.stopPropagation(); closeTab(path); };
    tab.onclick = () => setActive(path);
    tab.onauxclick = e => { if (e.button === 1) closeTab(path); };
    tab.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(path); } };
    tab.append(name, x); host.append(tab);
  }
  const tools = document.createElement('div'); tools.className = 'tab-tools';
  const add = document.createElement('button'); add.className = 'icon-btn'; add.textContent = '＋'; add.title = 'New file'; add.setAttribute('aria-label', 'New file'); add.onclick = () => createFile();
  const focus = document.createElement('button'); focus.className = 'icon-btn'; focus.textContent = '⛶'; focus.title = 'Distraction-free editor (Esc to leave)'; focus.setAttribute('aria-label', 'Toggle distraction-free editor'); focus.onclick = toggleFocus;
  tools.append(add, focus); host.append(tools);
}
function toggleFocus() { document.body.classList.toggle('focus-mode'); S.editor?.layout(); }

/* ───────────────────────── workspace events ───────────────────────── */
const scanSoon = keyed(path => scanFile(path, true), 900);
const wcWriteSoon = keyed(async path => {
  if (!S.wc || S.syncing || !ws.fileExists(path)) return;
  try { const d = dirname(path); if (d) await S.wc.fs.mkdir(d, { recursive: true }); await S.wc.fs.writeFile(path, ws.read(path)); } catch (e) { console.warn('Runtime sync failed', path, e); }
}, 350);
const previewRefreshSoon = debounce(() => { if (S.previewMode === 'static' && !$('previewPane').classList.contains('hidden')) showStaticPreview(); }, 600);

ws.on(evt => {
  switch (evt.type) {
    case 'edit':
      saveSoon(); scanSoon(evt.path); wcWriteSoon(evt.path); previewRefreshSoon(); break;
    case 'write':
      syncModelFromWs(evt.path); scanSoon(evt.path); wcWriteSoon(evt.path); previewRefreshSoon(); saveSoon();
      if (evt.created && !S.batch) renderExplorerIfVisible();
      break;
    case 'mkdir':
      if (S.wc) S.wc.fs.mkdir(evt.path, { recursive: true }).catch(() => {});
      saveSoon(); if (!S.batch) renderExplorerIfVisible(); break;
    case 'remove':
      evt.removed.forEach(p => S.secrets.delete(p));
      for (const p of evt.removed) { if (S.open.includes(p)) closeTab(p); else disposeModel(p); }
      if (S.wc) S.wc.fs.rm(evt.path, { recursive: true, force: true }).catch(() => {});
      renderExplorerIfVisible(); renderProblems(); saveSoon(); break;
    case 'move': {
      for (const [from, to] of evt.moved) {
        const i = S.open.indexOf(from); disposeModel(from);
        if (i >= 0) S.open[i] = to;
        if (S.active === from) S.active = to;
        if (S.secrets.has(from)) { S.secrets.set(to, S.secrets.get(from).map(f => ({ ...f, path: to }))); S.secrets.delete(from); }
        wcWriteSoon(to);
      }
      if (S.wc) S.wc.fs.rm(evt.from, { recursive: true, force: true }).catch(() => {});
      if (S.active) setActive(S.active); else renderTabs();
      renderExplorerIfVisible(); renderProblems(); saveSoon(); break;
    }
    case 'reset':
      [...S.models.keys()].forEach(disposeModel); break;
  }
});

/* ───────────────────────── secrets ───────────────────────── */
function scanFile(path, notify) {
  const content = ws.read(path);
  if (typeof content !== 'string') { S.secrets.delete(path); return; }
  const before = new Set((S.secrets.get(path) || []).map(f => f.type + f.line));
  const found = scanContent(path, content);
  if (found.length) S.secrets.set(path, found); else S.secrets.delete(path);
  const fresh = found.filter(f => !before.has(f.type + f.line));
  if (notify && fresh.length) {
    toast('Potential secret detected', `${fresh[0].type} pattern in ${path}:${fresh[0].line}. Review before sharing or exporting. Detection is heuristic and may be wrong.`, { level: 'warning', action: { label: 'Review security guidance', run: showSecretHelp } });
  }
  renderProblems();
}
function scanEverything() {
  let n = 0;
  for (const p of ws.files.keys()) { scanFile(p, false); n += S.secrets.get(p)?.length ?? 0; }
  if (n) toast('Potential secrets in workspace', `${n} possible credential pattern(s) found. See the Problems panel. Review before sharing or exporting.`, { level: 'warning', action: { label: 'Open Problems', run: () => selectBottom('problems') } });
}
function showSecretHelp() {
  dialog({ title: 'Protect your credentials', html: `<p>ByteForge detected text that resembles a credential. This check runs locally and is heuristic: it can miss secrets and can flag harmless examples.</p><ul><li>Do not commit real credentials to public repositories.</li><li>Use environment variables and provider-side secret stores for deployment.</li><li>Use placeholder values in <code>.env.example</code>.</li><li>Browser storage is not encrypted. Anyone with access to this browser profile can read this workspace.</li><li>Review project exports before sharing them.</li><li>Rotate a credential if you believe it has been exposed.</li></ul><p>ByteForge never transmits detected values and does not remove them automatically.</p>` });
}

/* ───────────────────────── problems panel ───────────────────────── */
function collectProblems() {
  const items = [];
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.severity < monaco.MarkerSeverity.Warning) continue;
    items.push({ kind: m.severity >= monaco.MarkerSeverity.Error ? 'error' : 'warning', path: m.resource.path.replace(/^\//, ''), line: m.startLineNumber, col: m.startColumn, text: m.message });
  }
  for (const list of S.secrets.values()) for (const f of list) items.push({ kind: 'warning', path: f.path, line: f.line, col: 1, text: `Security: possible ${f.type.toLowerCase()} (${f.preview})` });
  return items;
}
function renderProblems() {
  const items = collectProblems();
  const badge = $('problemBadge'); badge.textContent = String(items.length); badge.classList.toggle('hidden', !items.length);
  const host = $('problemsPanel'); host.innerHTML = '';
  if (!items.length) { host.textContent = 'No problems reported. (Syntax diagnostics and local secret detection are shown here.)'; return; }
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'problem ' + it.kind; row.tabIndex = 0;
    row.textContent = `${it.kind === 'error' ? '✖' : '⚠'} ${it.path}:${it.line}  ${it.text}`;
    const go = () => openFile(it.path, { line: it.line, col: it.col });
    row.onclick = go; row.onkeydown = e => { if (e.key === 'Enter') go(); };
    host.append(row);
  }
}

/* ───────────────────────── explorer & side panels ───────────────────────── */
const SIDE_TITLES = { explorer: 'Explorer', search: 'Search', database: 'Database Studio', terminal: 'Terminal & Runtime', settings: 'Settings', help: 'Help & Resources' };
function btn(label, onClick, cls = '', title = '') {
  const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; if (title) b.title = title; b.onclick = onClick; return b;
}
function renderExplorerIfVisible() { if (S.side === 'explorer') renderSide(); }
function renderSide() {
  const host = $('sideContent'); const scroll = $('sidepanel').scrollTop;
  host.innerHTML = '';
  $('sideTitle').textContent = SIDE_TITLES[S.side];
  ({ explorer: renderExplorer, search: renderSearch, database: renderDbSide, terminal: renderTermSide, settings: renderSettings, help: renderHelp })[S.side](host);
  $('sidepanel').scrollTop = scroll;
}
function renderExplorer(host) {
  const bar = document.createElement('div'); bar.className = 'row';
  bar.append(btn('＋ File', () => createFile()), btn('＋ Folder', () => createFolder()), btn('Import', () => $('fileInput').click()), btn('Folder…', () => $('folderInput').click()));
  host.append(bar);
  const tree = buildTree(ws.allFiles(), [...ws.folders]);
  if (!tree.children.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'This project is empty. Create a file or import a project.'; host.append(p); }
  const draw = (nodes, depth) => {
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'tree-row' + (n.path === S.active ? ' selected' : ''); row.tabIndex = 0; row.style.paddingLeft = 6 + depth * 14 + 'px';
      const open = !S.collapsed.has(n.path);
      const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = n.type === 'dir' ? (open ? '▾' : '▸') : '';
      const icon = document.createElement('span'); icon.textContent = n.type === 'dir' ? '▰' : '▤'; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = n.name; name.title = n.path;
      const acts = document.createElement('span'); acts.className = 'acts';
      if (n.type === 'dir') acts.append(btn('＋', e => { e.stopPropagation(); createFile(n.path + '/'); }, '', 'New file in folder'));
      acts.append(btn('✎', e => { e.stopPropagation(); renamePath(n.path); }, '', 'Rename or move (F2)'), btn('✕', e => { e.stopPropagation(); deletePath(n.path); }, '', 'Delete (Del)'));
      row.append(caret, icon, name, acts);
      const act = () => { if (n.type === 'dir') { open ? S.collapsed.add(n.path) : S.collapsed.delete(n.path); renderSide(); } else openFile(n.path); };
      row.onclick = act;
      row.onkeydown = e => { if (e.key === 'Enter') act(); else if (e.key === 'F2') renamePath(n.path); else if (e.key === 'Delete') deletePath(n.path); };
      host.append(row);
      if (n.type === 'dir' && open) draw(n.children, depth + 1);
    }
  };
  draw(tree.children, 0);
}
function renderSearch(host) {
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Search in project…'; input.setAttribute('aria-label', 'Search in project'); input.style.width = '100%';
  const opts = document.createElement('div'); opts.className = 'row'; opts.style.marginTop = '6px';
  const mk = (label, key) => { const l = document.createElement('label'); l.className = 'check'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!S[key]; c.onchange = () => { S[key] = c.checked; go(); }; l.append(c, label); return l; };
  opts.append(mk('Aa case', 'searchCase'), mk('.* regex', 'searchRegex'));
  const out = document.createElement('div');
  const go = () => {
    out.innerHTML = ''; S.searchQuery = input.value;
    const r = searchFiles(ws.files, input.value, { regex: !!S.searchRegex, caseSensitive: !!S.searchCase });
    if (r.error) { out.textContent = `Invalid pattern: ${r.error}`; return; }
    if (input.value && !r.results.length) { out.textContent = 'No results.'; return; }
    let last = null;
    for (const hit of r.results) {
      if (hit.path !== last) { const f = document.createElement('div'); f.className = 'search-file'; f.textContent = hit.path; out.append(f); last = hit.path; }
      const row = document.createElement('div'); row.className = 'search-hit'; row.tabIndex = 0;
      const before = hit.text.slice(0, hit.col - 1), match = hit.text.slice(hit.col - 1, hit.col - 1 + hit.length), after = hit.text.slice(hit.col - 1 + hit.length);
      const m = document.createElement('mark'); m.textContent = match;
      row.append(`${hit.line}: ${before.trimStart()}`, m, after);
      const jump = () => openFile(hit.path, { line: hit.line, col: hit.col });
      row.onclick = jump; row.onkeydown = e => { if (e.key === 'Enter') jump(); };
      out.append(row);
    }
    if (r.truncated) { const t = document.createElement('p'); t.className = 'muted'; t.textContent = 'Showing the first 500 results.'; out.append(t); }
  };
  input.value = S.searchQuery || ''; input.oninput = debounce(go, 200);
  host.append(input, opts, out); if (input.value) go(); setTimeout(() => input.focus(), 0);
}
function renderDbSide(host) {
  const bar = document.createElement('div'); bar.className = 'row';
  bar.append(btn('Open Database Studio', () => selectBottom('database'), 'primary'));
  host.append(bar);
  const info = document.createElement('p'); info.className = 'muted'; info.textContent = 'SQLite (sql.js WebAssembly). The database is saved in this browser (IndexedDB) and can be exported or imported.'; host.append(info);
  const tables = listTables();
  if (!S.db) { const p = document.createElement('p'); p.textContent = 'The SQLite engine is not available.'; host.append(p); return; }
  if (!tables.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No tables yet. Run CREATE TABLE in Database Studio.'; host.append(p); }
  for (const t of tables) {
    const row = document.createElement('div'); row.className = 'table-row'; row.tabIndex = 0;
    row.innerHTML = `<span>${t.type === 'view' ? '◫' : '▤'} ${escapeHtml(t.name)}</span><span class="muted">${t.count ?? ''}</span>`;
    const go = () => { $('sqlInput').value = `SELECT * FROM "${t.name.replace(/"/g, '""')}" LIMIT 100;`; selectBottom('database'); runSql(); };
    row.onclick = go; row.onkeydown = e => { if (e.key === 'Enter') go(); };
    host.append(row);
  }
}
function renderTermSide(host) {
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = S.wc ? 'Node.js WebContainer runtime is running.' : (window.crossOriginIsolated ? 'Node.js runtime is not started.' : 'This page is not cross-origin isolated, so the Node.js runtime cannot start. Check the COOP/COEP headers of this deployment.');
  host.append(status);
  const row = document.createElement('div'); row.className = 'row';
  row.append(btn('Open Terminal', () => selectBottom('terminal')), btn(S.wc ? 'Open runtime shell' : 'Start Node.js runtime', () => bootRuntime(), 'primary'));
  if (S.wc) row.append(btn('Pull runtime files', () => syncFromRuntime(), '', 'Copy files created in the runtime (for example by npm) into the workspace'));
  host.append(row);
  const n = document.createElement('p'); n.className = 'muted';
  n.textContent = 'Starting the runtime contacts StackBlitz servers to load WebContainer, and npm install contacts the npm registry. Nothing is started automatically.';
  host.append(n);
}
function renderSettings(host) {
  const s = S.settings;
  const field = (label, control) => { const l = document.createElement('label'); l.className = 'field'; l.append(label, control); return l; };
  const sel = (opts, value, onChange) => { const e = document.createElement('select'); opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; e.append(o); }); e.value = String(value); e.onchange = () => onChange(e.value); return e; };
  const check = (label, value, onChange) => { const l = document.createElement('label'); l.className = 'check'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = value; c.onchange = () => onChange(c.checked); l.append(c, label); return l; };
  const update = (k, v) => { s[k] = v; saveSettings(); applySettings(); };
  host.append(
    field('Theme', sel([['dark', 'Dark'], ['light', 'Light']], s.theme, v => update('theme', v))),
    field('Font size', sel([12, 13, 14, 16, 18, 20].map(n => [n, `${n}px`]), s.fontSize, v => update('fontSize', +v))),
    field('Tab size', sel([2, 4, 8].map(n => [n, `${n} spaces`]), s.tabSize, v => update('tabSize', +v))),
    check('Word wrap', s.wordWrap, v => update('wordWrap', v)),
    check('Minimap', s.minimap, v => update('minimap', v)),
    check('Format document on save (Ctrl+S)', s.formatOnSave, v => update('formatOnSave', v))
  );
  const storage = document.createElement('p'); storage.className = 'muted'; storage.textContent = 'Checking storage…'; host.append(storage);
  storageEstimate().then(est => {
    if (!est) { storage.textContent = 'Storage estimate unavailable in this browser.'; return; }
    storage.textContent = `Browser storage in use: ${formatBytes(est.usage)} of about ${formatBytes(est.quota)}. Persistent storage: ${est.persisted ? 'granted' : 'not granted (the browser may evict data under storage pressure)'}.`;
  });
  const row = document.createElement('div'); row.className = 'row';
  row.append(btn('Request persistent storage', async () => { const ok = await requestPersistence(); toast(ok ? 'Persistent storage granted' : 'Persistent storage not granted', ok ? 'The browser will not evict this workspace automatically.' : 'The browser declined. Export backups regularly.'); renderSide(); }));
  host.append(row);
  const danger = document.createElement('div'); danger.className = 'row'; danger.append(btn('Delete all local data…', deleteAllData, 'danger')); host.append(danger);
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Local storage is not encrypted. Do not keep production credentials here.'; host.append(note);
}
function renderHelp(host) {
  host.innerHTML = '<div class="help-links"><b>ByteForge resources</b><a href="/docs.html" target="_blank" rel="noopener">Documentation</a><a href="/faq.html" target="_blank" rel="noopener">FAQ</a><a href="/terms.html" target="_blank" rel="noopener">Terms &amp; Conditions</a><a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a><a href="/about.html" target="_blank" rel="noopener">About ByteForge</a></div><p class="muted">Shortcuts: Ctrl+P open file · Ctrl+S save/format · Ctrl+Enter run file · Ctrl+J toggle panel · Ctrl+B toggle sidebar · F1 command palette (editor).</p>';
}
async function deleteAllData() {
  if (!await confirmDialog('Delete all local data?', '<p>This permanently deletes the project, the SQLite database, settings and the IndexedDB store from this browser. Download a backup first if you need one.</p>', { confirmLabel: 'Delete everything', danger: true })) return;
  S.wiping = true; window.removeEventListener('beforeunload', flushOnUnload);
  await deleteEverything();
  try { localStorage.removeItem(LEGACY_KEY); localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
  location.reload();
}

/* ───────────────────────── file operations ───────────────────────── */
async function createFile(prefix = '') {
  const name = await askInput('New file', 'File path (for example src/main.js):', prefix, { placeholder: 'src/main.js' });
  if (!name) return;
  try {
    const p = ws.clean(name);
    if (ws.exists(p)) { toast('Already exists', `${p} already exists.`, { level: 'warning' }); return; }
    ws.write(p, ''); openFile(p);
  } catch (e) { toast('Cannot create file', e.message, { level: 'error' }); }
}
async function createFolder() {
  const name = await askInput('New folder', 'Folder path:', '', { placeholder: 'src/components' });
  if (!name) return;
  try { ws.mkdir(name); } catch (e) { toast('Cannot create folder', e.message, { level: 'error' }); }
}
async function renamePath(path) {
  const to = await askInput('Rename or move', `New path for ${path}:`, path);
  if (!to || to === path) return;
  try { ws.move(path, to); } catch (e) { toast('Cannot rename', e.message, { level: 'error' }); }
}
async function deletePath(path) {
  const isDir = !ws.fileExists(path);
  if (!await confirmDialog(`Delete ${isDir ? 'folder' : 'file'}?`, `<p><code>${escapeHtml(path)}</code> will be permanently deleted from this workspace${isDir ? ' together with everything inside it' : ''}. This cannot be undone.</p>`, { confirmLabel: 'Delete', danger: true })) return;
  try { ws.remove(path); } catch (e) { toast('Cannot delete', e.message, { level: 'error' }); }
}
async function renameProject() {
  const name = await askInput('Project name', 'Name (used for the exported ZIP file):', S.project);
  if (!name) return;
  S.project = name.replace(/[^\w.\- ]+/g, '-').slice(0, 60) || 'project';
  $('projectName').textContent = S.project; saveSoon();
}

/* ───────────────────────── quick open ───────────────────────── */
function fuzzy(query, path) {
  const q = query.toLowerCase(), p = path.toLowerCase();
  if (!q) return 1;
  const bi = p.lastIndexOf(basename(p));
  if (p.slice(bi).startsWith(q)) return 1000 - p.length;
  if (p.includes(q)) return 500 - p.length;
  let i = 0; for (const c of p) if (c === q[i]) i++;
  return i === q.length ? 100 - p.length : -1;
}
async function quickOpen() {
  const wrap = document.createElement('div');
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Type a file name…'; input.setAttribute('aria-label', 'Open file');
  const list = document.createElement('div'); list.className = 'list'; list.style.marginTop = '8px';
  wrap.append(input, list);
  let items = [], sel = 0;
  const render = () => {
    items = ws.allFiles().map(p => [p, fuzzy(input.value, p)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).slice(0, 50).map(x => x[0]);
    sel = Math.min(sel, Math.max(0, items.length - 1)); list.innerHTML = '';
    items.forEach((p, i) => { const r = document.createElement('div'); r.className = 'quick-item' + (i === sel ? ' sel' : ''); r.textContent = p; r.onclick = () => { closeDialog(p); }; list.append(r); });
    if (!items.length) list.textContent = 'No matching files.';
  };
  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[sel]) { e.stopPropagation(); closeDialog(items[sel]); }
  };
  input.dataset.noSubmit = '1'; render();
  const choice = await dialog({ title: 'Open file', node: wrap, actions: [] });
  if (choice) openFile(choice);
}

/* ───────────────────────── bottom panel ───────────────────────── */
function selectBottom(which) {
  S.bottom = which;
  document.querySelectorAll('.bottom-tab').forEach(b => { const on = b.dataset.bottom === which; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $('terminal').classList.toggle('hidden', which !== 'terminal');
  $('outputPanel').classList.toggle('hidden', which !== 'output');
  $('databasePanel').classList.toggle('hidden', which !== 'database');
  $('problemsPanel').classList.toggle('hidden', which !== 'problems');
  $('bottomPanel').classList.remove('collapsed');
  if (which === 'terminal') { fitTerminal(); S.term?.focus(); }
  if (which === 'database') refreshDbInfo();
  if (which === 'problems') renderProblems();
}
function outLog(kind, text) {
  const out = $('outputPanel');
  if (out.dataset.empty !== 'no') { out.textContent = ''; out.dataset.empty = 'no'; }
  const span = document.createElement('span');
  if (kind === 'error') span.className = 'err'; else if (kind === 'warn') span.className = 'warn';
  span.textContent = text + '\n'; out.append(span); out.scrollTop = out.scrollHeight;
}
function clearActivePanel() {
  if (S.bottom === 'output') { const o = $('outputPanel'); o.textContent = ''; o.dataset.empty = 'no'; }
  else S.term?.clear();
}

/* ───────────────────────── terminal ───────────────────────── */
const shell = createShell(ws);
function tw(text) { S.term.write(String(text).replace(/\r?\n/g, '\r\n')); }
function prompt() { S.term.write('$ '); }
function fitTerminal() {
  try { S.fit?.fit(); if (S.wcShell && S.term) S.wcShell.resize({ cols: S.term.cols, rows: S.term.rows }); } catch { /* terminal hidden */ }
}
function initTerminal() {
  S.term = new Terminal({ convertEol: true, fontSize: 12, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', cursorBlink: true, theme: termTheme() });
  S.fit = new FitAddon(); S.term.loadAddon(S.fit); S.term.open($('terminal'));
  fitTerminal();
  tw('ByteForge terminal — workspace shell (not a POSIX shell). Type "help".\n');
  tw('Type "run" to start the Node.js WebContainer runtime for a real shell with npm.\n');
  prompt();
  S.term.onData(onTerminalData);
  new ResizeObserver(() => fitTerminal()).observe($('terminal'));
}
function onTerminalData(d) {
  if (S.termMode === 'jsh') { S.wcInput?.write(d); return; }
  if (S.busy) { if (d === '\x03') tw('^C (cannot interrupt a running worker from here; it stops at its timeout)\n'); return; }
  if (d.startsWith('\x1b')) {
    if (d === '\x1b[A' && S.history.length) { S.histIdx = Math.max(0, (S.histIdx < 0 ? S.history.length : S.histIdx) - 1); replaceLine(S.history[S.histIdx]); }
    else if (d === '\x1b[B') { if (S.histIdx >= 0 && S.histIdx < S.history.length - 1) { S.histIdx++; replaceLine(S.history[S.histIdx]); } else { S.histIdx = -1; replaceLine(''); } }
    return;
  }
  for (const ch of d) {
    if (ch === '\r' || ch === '\n') { S.term.write('\r\n'); const line = S.line; S.line = ''; S.histIdx = -1; runTerminalLine(line); return; }
    else if (ch === '\x7f') { if (S.line.length) { S.line = S.line.slice(0, -1); S.term.write('\b \b'); } }
    else if (ch === '\x03') { S.term.write('^C\r\n'); S.line = ''; prompt(); }
    else if (ch === '\x0c') { S.term.clear(); S.term.write('\r'); prompt(); S.term.write(S.line); }
    else if (ch === '\t') { tabComplete(); }
    else if (ch >= ' ') { S.line += ch; S.term.write(ch); }
  }
}
function replaceLine(text) { S.term.write('\b \b'.repeat(S.line.length)); S.line = text; S.term.write(text); }
function tabComplete() {
  const m = /(\S*)$/.exec(S.line); const partial = m ? m[1] : '';
  const c = shell.complete(partial);
  if (c.length === 1) { const add = c[0].slice(partial.length); S.line += add; S.term.write(add); }
  else if (c.length > 1) {
    let common = c[0]; for (const x of c) while (!x.startsWith(common)) common = common.slice(0, -1);
    if (common.length > partial.length) { const add = common.slice(partial.length); S.line += add; S.term.write(add); }
    else { tw('\n' + c.join('  ') + '\n'); prompt(); S.term.write(S.line); }
  }
}
async function runTerminalLine(line) {
  if (line.trim()) S.history.push(line);
  S.busy = true;
  try {
    const res = shell.exec(line);
    if (res.output) tw(res.output + '\n');
    const a = res.action;
    if (a) {
      const sink = (kind, text) => { outLog(kind, text); tw((kind === 'error' ? '\x1b[31m' : '') + text + '\x1b[0m\n'); };
      if (a.type === 'clear') S.term.clear();
      else if (a.type === 'boot') await bootRuntime();
      else if (a.type === 'sync') await syncFromRuntime();
      else if (a.type === 'preview') openPreview();
      else if (a.type === 'node') await runJsFile(a.path, sink);
      else if (a.type === 'python') await runPyFile(a.path, sink);
      else if (a.type === 'sql') tw(runSqlForTerminal(a.query) + '\n');
    }
  } catch (e) { tw(`Error: ${e.message}\n`); }
  finally { S.busy = false; if (S.termMode === 'lite') prompt(); }
}

/* ───────────────────────── code runners ───────────────────────── */
async function runJsFile(path, sink) {
  const code = ws.read(path);
  if (typeof code !== 'string') { sink('error', `${path} is not a text file`); return; }
  if (/^\s*(import|export)\s[^;]*?(from\s|\{|\*|default)/m.test(code)) sink('warn', 'Note: ES module syntax (import/export) is not supported by the isolated runner. Use the Node.js runtime (run) for modules and npm packages.');
  sink('log', `▶ ${path} (isolated Web Worker, 10 s limit)`);
  const status = await runJavaScript(code, sink);
  sink('log', status === 'ok' ? '✓ finished' : `✗ ${status}`);
}
async function runPyFile(path, sink) {
  const code = ws.read(path);
  if (typeof code !== 'string') { sink('error', `${path} is not a text file`); return; }
  if (!S.pyConsent) {
    const ok = await confirmDialog('Load Python runtime?', `<p>Running Python uses <b>Pyodide ${PYODIDE_VERSION}</b> (CPython compiled to WebAssembly), downloaded once per session from <code>cdn.jsdelivr.net</code> (roughly 10 MB or more). Your code still runs in your browser, but this download contacts a third-party CDN. This feature is experimental.</p>`, { confirmLabel: 'Download and run' });
    if (!ok) { sink('warn', 'Python run cancelled.'); return; }
    S.pyConsent = true;
  }
  sink('log', `▶ ${path} (Pyodide, isolated Web Worker, 60 s limit)`);
  const textFiles = new Map([...ws.files].filter(([, v]) => typeof v === 'string' || v instanceof Uint8Array));
  const status = await runPython(code, textFiles, sink);
  if (status !== 'ok') S.pyConsent = false; // a stopped worker is discarded; ask again before re-downloading
  sink('log', status === 'ok' ? '✓ finished' : `✗ ${status}`);
}
async function runActive() {
  const path = S.active;
  if (!path || isBinary(path)) { toast('Nothing to run', 'Open a text file first.'); return; }
  const lang = languageFor(path);
  if (lang === 'javascript' && !/\.jsx$/.test(path)) { selectBottom('output'); await runJsFile(path, outLog); }
  else if (lang === 'python') { selectBottom('output'); await runPyFile(path, outLog); }
  else if (lang === 'html') openPreview(path);
  else if (lang === 'sql') { $('sqlInput').value = ws.read(path); selectBottom('database'); runSql(); }
  else toast('Cannot run this file type', `ByteForge can run JavaScript, Python, SQL and HTML files directly. For ${languageLabel(lang)} start the Node.js runtime and use its shell and npm.`);
}

/* ───────────────────────── Node.js WebContainer runtime ───────────────────────── */
async function bootRuntime() {
  if (S.wc) { startJsh(); selectBottom('terminal'); return; }
  selectBottom('terminal');
  if (!window.crossOriginIsolated) {
    tw('Runtime unavailable: this page is not cross-origin isolated (needs COOP/COEP headers and a supported browser).\n');
    toast('Runtime unavailable', 'WebContainers need cross-origin isolation. Serve the app with the included _headers file and use a supported desktop browser.', { level: 'warning' });
    return;
  }
  const ok = S.wcConsent || await confirmDialog('Start Node.js runtime?', '<p>The runtime uses <b>WebContainers</b> by StackBlitz. Starting it loads WebContainer assets from StackBlitz servers, and <code>npm install</code> downloads packages from the npm registry. Your project files are mounted into the in-browser container and are not uploaded. Review the WebContainer licensing terms before commercial use.</p>', { confirmLabel: 'Start runtime' });
  if (!ok) return;
  S.wcConsent = true;
  $('runtimeStatus').textContent = 'Booting runtime…'; tw('Booting Node.js runtime…\n');
  try {
    S.wc = await WebContainer.boot();
    await S.wc.mount(toFileSystemTree(ws.files, ws.folders));
    S.wc.on('server-ready', (port, url) => { S.serverUrl = url; tw(`\r\n[preview] server on port ${port} → ${url}\r\n`); showUrlPreview(url); });
    S.wc.on('error', e => tw(`\r\n[runtime error] ${e.message}\r\n`));
    $('runtimeStatus').textContent = 'Node.js Runtime Ready';
    startJsh();
    toast('Runtime ready', ws.fileExists('package.json') ? 'Run "npm install" and then your script, for example "npm run dev".' : 'Create a package.json, then use npm in the shell.');
    if (S.side === 'terminal') renderSide();
  } catch (e) {
    S.wc = null; $('runtimeStatus').textContent = 'Runtime unavailable';
    tw(`Runtime unavailable: ${e.message}\n`); prompt();
    toast('Runtime could not start', `${e.message}. WebContainers need a supported browser, cross-origin isolation and access to StackBlitz servers. If it failed after booting once, reload the page to retry.`, { level: 'error' });
  }
}
async function startJsh() {
  if (S.termMode === 'jsh' || !S.wc) return;
  try {
    const proc = await S.wc.spawn('jsh', { terminal: { cols: S.term.cols, rows: S.term.rows } });
    S.wcShell = proc; S.wcInput = proc.input.getWriter(); S.termMode = 'jsh'; S.line = '';
    proc.output.pipeTo(new WritableStream({ write(data) { S.term.write(data); } })).catch(() => {});
    tw('\r\n[runtime] Real Node.js shell attached. Type "exit" to return to the workspace shell.\r\n');
    proc.exit.then(() => { S.termMode = 'lite'; S.wcShell = null; S.wcInput = null; tw('\r\n[runtime] shell exited. Back in the workspace shell (type "run" to reattach).\r\n'); prompt(); });
    fitTerminal();
  } catch (e) { tw(`Could not start runtime shell: ${e.message}\n`); prompt(); }
}
async function syncFromRuntime() {
  if (!S.wc) { toast('Runtime not running', 'Start the Node.js runtime first.', { level: 'warning' }); return; }
  const SKIP = new Set(['node_modules', '.git', '.npm', '.cache', '.pnpm-store']);
  let count = 0, changed = 0, skipped = 0; S.syncing = true; S.batch = true;
  try {
    const walk = async dir => {
      const entries = await S.wc.fs.readdir(dir || '.', { withFileTypes: true }); // paths are relative to the container working directory
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const p = (dir ? dir + '/' : '') + e.name;
        if (e.isDirectory()) { if (!ws.dirExists(p)) ws.mkdir(p); await walk(p); }
        else if (e.isFile()) {
          if (++count > MAX_IMPORT_COUNT) { skipped++; continue; }
          const bytes = await S.wc.fs.readFile(p);
          if (bytes.length > MAX_IMPORT_FILE) { skipped++; continue; }
          const content = decodeBytes(bytes); const prev = ws.read(p);
          const same = typeof content === 'string' ? prev === content : prev instanceof Uint8Array && prev.length === content.length && prev.every((b, i) => b === content[i]);
          if (!same) { ws.write(p, content); changed++; }
        }
      }
    };
    await walk('');
    toast('Runtime files pulled', `${changed} file(s) added or updated${skipped ? `, ${skipped} skipped (too large or too many)` : ''}. node_modules and .git are excluded. Files deleted in the runtime are not removed from the workspace.`);
  } catch (e) { toast('Sync failed', e.message, { level: 'error' }); }
  finally { S.syncing = false; S.batch = false; renderExplorerIfVisible(); }
}

/* ───────────────────────── preview ───────────────────────── */
function pickPreviewEntry(preferred) {
  if (preferred && /\.html?$/i.test(preferred) && ws.fileExists(preferred)) return preferred;
  if (S.active && /\.html?$/i.test(S.active)) return S.active;
  if (ws.fileExists('index.html')) return 'index.html';
  return ws.allFiles().find(f => /\.html?$/i.test(f)) ?? null;
}
function openPreview(preferred) {
  if (S.serverUrl && !preferred) { showUrlPreview(S.serverUrl); return; }
  const entry = pickPreviewEntry(preferred);
  if (!entry) { toast('Nothing to preview', 'Add an HTML file (for example index.html), or start the Node.js runtime and run a dev server.', { level: 'warning' }); return; }
  S.previewEntry = entry; showStaticPreview();
}
function showStaticPreview() {
  const entry = S.previewEntry && ws.fileExists(S.previewEntry) ? S.previewEntry : pickPreviewEntry();
  if (!entry) return;
  try {
    const { html, notes } = buildPreview(ws.files, entry);
    const frame = $('previewFrame');
    frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups'); // opaque origin: no access to the workspace
    frame.removeAttribute('src'); frame.srcdoc = html;
    S.previewMode = 'static'; S.previewEntry = entry;
    $('previewTitle').textContent = `Preview · ${entry}`; $('previewPane').classList.remove('hidden');
    notes.forEach(n => outLog('warn', `[preview] ${n}`));
  } catch (e) { toast('Preview failed', e.message, { level: 'error' }); }
}
function showUrlPreview(url) {
  const frame = $('previewFrame');
  frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups allow-same-origin'); // runtime origin is separate from ByteForge
  frame.removeAttribute('srcdoc'); frame.src = url;
  S.previewMode = 'runtime'; $('previewTitle').textContent = 'Preview · Node.js runtime'; $('previewPane').classList.remove('hidden');
}
function closePreview() { $('previewPane').classList.add('hidden'); $('previewFrame').removeAttribute('srcdoc'); $('previewFrame').removeAttribute('src'); S.previewMode = null; }
window.addEventListener('message', e => {
  if (e.source !== $('previewFrame').contentWindow || !e.data || e.data.__bf !== 1) return;
  const kind = e.data.type === 'error' ? 'error' : e.data.type === 'warn' ? 'warn' : 'log';
  outLog(kind, `[preview] ${e.data.text}`);
});

/* ───────────────────────── SQLite database ───────────────────────── */
async function initDatabase() {
  $('sqlInput').value = S.sqlText;
  try {
    S.SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    let saved = null; try { saved = await kvGet('sqlite'); } catch { /* storage unavailable */ }
    try { S.db = saved instanceof Uint8Array ? new S.SQL.Database(saved) : new S.SQL.Database(); }
    catch (e) { S.db = new S.SQL.Database(); toast('Saved database could not be opened', `${e.message}. A new empty database was created; the damaged copy was left in storage until you change the database.`, { level: 'warning' }); }
    $('sqlResults').textContent = 'SQLite ready. Ctrl+Enter runs the editor contents (or the selection).';
  } catch (e) {
    $('sqlResults').textContent = `SQLite engine failed to initialize: ${e.message}`;
  }
  refreshDbInfo();
}
function exportDb() {
  const fk = (() => { try { return S.db.exec('PRAGMA foreign_keys')[0].values[0][0]; } catch { return 0; } })();
  const data = S.db.export();
  if (fk) S.db.run('PRAGMA foreign_keys = ON'); // export() resets this pragma
  return data;
}
function listTables() {
  if (!S.db) return [];
  try {
    const r = S.db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return (r[0]?.values ?? []).map(([name, type]) => {
      let count = null;
      try { count = S.db.exec(`SELECT COUNT(*) FROM "${name.replace(/"/g, '""')}"`)[0].values[0][0]; } catch { /* view may fail */ }
      return { name, type, count };
    });
  } catch { return []; }
}
function refreshDbInfo() {
  const n = listTables().length;
  $('dbInfo').textContent = S.db ? `${n} table${n === 1 ? '' : 's'}/views` : 'engine unavailable';
  if (S.side === 'database') renderSide();
}
const WRITES = /\b(create|drop|alter|insert|update|delete|replace|pragma|vacuum|attach|detach|reindex)\b/i;
function runSql() {
  if (!S.db) { toast('Database unavailable', 'The SQLite engine has not initialized.', { level: 'error' }); return; }
  const ta = $('sqlInput');
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  const sql = sel || ta.value;
  const host = $('sqlResults'); host.innerHTML = '';
  const t0 = performance.now();
  try {
    const sets = S.db.exec(sql);
    const ms = (performance.now() - t0).toFixed(1);
    S.lastResult = sets.at(-1) ?? null;
    for (const set of sets) host.append(resultTable(set));
    const note = document.createElement('div'); note.className = 'muted';
    note.textContent = `${sets.length ? `${sets.length} result set(s). ` : 'Executed successfully, no rows returned. '}Rows changed by the last statement: ${S.db.getRowsModified()}. ${ms} ms.`;
    host.append(note);
    if (WRITES.test(sql)) saveDbSoon();
  } catch (e) {
    const d = document.createElement('div'); d.className = 'err'; d.textContent = `SQL error: ${e.message}`; host.append(d);
  }
  refreshDbInfo(); saveSoon();
}
function resultTable(set) {
  const MAX = 500;
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  set.columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; head.append(th); });
  const body = table.createTBody();
  for (const row of set.values.slice(0, MAX)) {
    const tr = body.insertRow();
    row.forEach(v => { const td = tr.insertCell(); if (v === null) { td.textContent = 'NULL'; td.className = 'null'; } else td.textContent = v instanceof Uint8Array ? `[${v.length} bytes]` : String(v); });
  }
  wrap.append(table);
  if (set.values.length > MAX) { const m = document.createElement('div'); m.className = 'muted'; m.textContent = `Showing ${MAX} of ${set.values.length} rows (CSV export includes all rows of the last result).`; wrap.append(m); }
  return wrap;
}
function runSqlForTerminal(query) {
  if (!S.db) return 'SQLite engine unavailable.';
  try {
    const sets = S.db.exec(query);
    if (WRITES.test(query)) saveDbSoon();
    refreshDbInfo();
    if (!sets.length) return `OK (${S.db.getRowsModified()} row(s) changed)`;
    return sets.map(s => toTextTable(s.columns, s.values)).join('\n\n');
  } catch (e) { return `SQL error: ${e.message}`; }
}
async function importDatabaseBytes(name, bytes) {
  if (!S.SQL) { toast('Database unavailable', 'The SQLite engine has not initialized.', { level: 'error' }); return; }
  if (!await confirmDialog('Replace the database?', `<p>Load <code>${escapeHtml(name)}</code> into Database Studio? The current database will be replaced.</p>`, { confirmLabel: 'Replace database', danger: true })) return;
  try {
    const db = new S.SQL.Database(bytes); db.exec('SELECT count(*) FROM sqlite_master');
    S.db?.close(); S.db = db; await saveDatabase(); refreshDbInfo(); selectBottom('database');
    $('sqlResults').textContent = `Loaded ${name}.`; toast('Database loaded', `${name} is now the Database Studio database.`);
  } catch (e) { toast('Not a valid SQLite database', e.message, { level: 'error' }); }
}
async function importDbFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isSqliteBytes(bytes)) return importDatabaseBytes(file.name, bytes);
  const text = new TextDecoder().decode(bytes);
  if (!/\.sql$/i.test(file.name)) { toast('Unsupported file', 'Choose a SQLite database (.sqlite, .db) or a .sql script.', { level: 'warning' }); return; }
  if (!await confirmDialog('Run SQL script?', `<p>Execute <code>${escapeHtml(file.name)}</code> against the current database? Scripts can modify or delete data.</p>`, { confirmLabel: 'Run script' })) return;
  $('sqlInput').value = text; $('sqlInput').setSelectionRange(0, 0); runSql();
}
async function resetDatabase() {
  if (!S.SQL || !await confirmDialog('Reset the database?', '<p>All tables and data in Database Studio will be deleted. Export it first if you need a copy.</p>', { confirmLabel: 'Reset', danger: true })) return;
  S.db?.close(); S.db = new S.SQL.Database(); await saveDatabase(); refreshDbInfo(); $('sqlResults').textContent = 'Database reset.';
}

/* ───────────────────────── import ───────────────────────── */
function stripCommonRoot(entries) {
  if (!entries.length) return { entries, root: null };
  const first = entries[0][0].split('/')[0];
  if (entries.every(([p]) => p.includes('/') && p.split('/')[0] === first)) return { entries: entries.map(([p, c]) => [p.slice(first.length + 1), c]), root: first };
  return { entries, root: null };
}
async function expandZip(file, report) {
  const zip = await JSZip.loadAsync(file);
  const out = []; let total = 0;
  for (const [rawPath, item] of Object.entries(zip.files)) {
    if (item.dir) continue;
    const p = normalizePath(rawPath);
    if (!p) { report.invalid++; continue; }
    if (shouldIgnoreImport(p)) { report.ignored++; continue; }
    const size = item._data?.uncompressedSize ?? 0;
    total += size;
    if (size > MAX_IMPORT_FILE || total > MAX_IMPORT_TOTAL || out.length >= MAX_IMPORT_COUNT) { report.tooLarge++; continue; }
    out.push([p, decodeBytes(await item.async('uint8array'))]);
  }
  return stripCommonRoot(out);
}
async function importFiles(items) {
  // items: File[] or [{file, path}]
  const list = [...items].map(i => (i instanceof File ? { file: i, path: i.webkitRelativePath || i.name } : i));
  if (!list.length) return;
  const report = { invalid: 0, ignored: 0, tooLarge: 0 };
  let entries = [], databases = [], zipRoot = null;
  toast('Importing…', `${list.length} item(s)`, { ttl: 2500 });
  try {
    const loose = [];
    for (const { file, path } of list) {
      if (/\.zip$/i.test(file.name)) {
        const r = await expandZip(file, report); entries.push(...r.entries); zipRoot = r.root ?? zipRoot;
        continue;
      }
      if (file.size > MAX_IMPORT_FILE) { report.tooLarge++; continue; }
      const p = normalizePath(path);
      if (!p) { report.invalid++; continue; }
      if (shouldIgnoreImport(p)) { report.ignored++; continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isSqliteBytes(bytes) && /\.(sqlite3?|db)$/i.test(file.name)) { databases.push({ name: file.name, bytes, p }); continue; }
      loose.push([p, decodeBytes(bytes)]);
    }
    const stripped = stripCommonRoot(loose);
    entries.push(...(list.some(i => i.file?.webkitRelativePath || i.path?.includes('/')) ? stripped.entries : loose));
  } catch (e) { toast('Import failed', e.message, { level: 'error' }); return; }

  const conflicts = entries.filter(([p]) => ws.fileExists(p)).length;
  let overwrite = true;
  if (conflicts) {
    const choice = await dialog({ title: 'Files already exist', html: `<p>${conflicts} imported file(s) already exist in this workspace.</p>`, actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Skip existing', value: 'skip' }, { label: 'Overwrite', primary: true, danger: true, value: 'overwrite' }] });
    if (!choice || choice === 'cancel') return;
    overwrite = choice === 'overwrite';
  }
  S.batch = true; let written = 0, failed = 0;
  try {
    for (const [p, content] of entries) {
      if (!overwrite && ws.fileExists(p)) continue;
      try { ws.write(p, content); written++; scanFile(p, false); } catch { failed++; }
    }
  } finally { S.batch = false; }
  renderExplorerIfVisible(); saveSoon();
  const findings = entries.reduce((n, [p]) => n + (S.secrets.get(p)?.length ?? 0), 0);
  const extra = [report.ignored && `${report.ignored} ignored (node_modules/.git)`, report.invalid && `${report.invalid} with unsafe paths skipped`, report.tooLarge && `${report.tooLarge} skipped as too large`, failed && `${failed} failed`, zipRoot && `top-level folder "${zipRoot}" removed`].filter(Boolean).join('; ');
  toast('Import complete', `${written} file(s) imported${extra ? ` — ${extra}` : ''}.`);
  if (findings) toast('Potential secrets imported', `${findings} possible credential pattern(s) found in imported files. See Problems.`, { level: 'warning', action: { label: 'Open Problems', run: () => selectBottom('problems') } });
  if (!S.active && S.open.length === 0 && written) { const first = entries.map(e => e[0]).find(p => /readme|index/i.test(p) && !isBinary(p)) ?? entries[0]?.[0]; if (first) openFile(first); }
  for (const d of databases) await importDatabaseBytes(d.name, d.bytes);
}
async function readDropped(dataTransfer) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file, path: prefix + entry.name }); }
    else if (entry.isDirectory) {
      const reader = entry.createReader(); let batch;
      do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); for (const child of batch) await walk(child, prefix + entry.name + '/'); } while (batch.length);
    }
  };
  const entries = [...dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e, '');
  else [...dataTransfer.files].forEach(file => out.push({ file, path: file.name }));
  return out;
}

/* ───────────────────────── export ───────────────────────── */
function downloadBlob(blob, name) {
  const a = document.createElement('a'); const url = URL.createObjectURL(blob);
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadFile(path) {
  const v = ws.read(path); if (v === undefined) return;
  downloadBlob(new Blob([v], { type: v instanceof Uint8Array ? mimeFor(path) : 'text/plain;charset=utf-8' }), basename(path));
}
async function exportProject() {
  const files = ws.allFiles();
  const envFiles = files.filter(isEnvFile);
  const findings = scanAll(ws.files);
  const hasDb = !!S.db && listTables().length > 0;
  const node = document.createElement('div');
  const esc = escapeHtml;
  node.innerHTML = `<p>${files.length} file(s) will be packaged into <code>${esc(S.project)}.zip</code> locally in your browser. Nothing is uploaded.</p>
    ${envFiles.length ? `<label class="check"><input type="checkbox" id="exEnv"> Include ${envFiles.length} environment file(s): <code>${esc(envFiles.join(', '))}</code></label><label class="check hidden" id="exAckWrap"><input type="checkbox" id="exAck"> I understand the archive may contain credentials and accept the risk.</label>` : ''}
    ${hasDb ? '<label class="check"><input type="checkbox" id="exDb" checked> Include the SQLite database (database/byteforge.sqlite)</label>' : ''}
    ${findings.length ? `<p><b>⚠ ${findings.length} possible secret pattern(s)</b> were found. Detection is heuristic. Review these before sharing:</p><div class="list">${findings.slice(0, 40).map(f => `<div class="finding">${esc(f.path)}:${f.line} — ${esc(f.type)}${isEnvFile(f.path) ? ' (env file, excluded unless included above)' : ''}</div>`).join('')}${findings.length > 40 ? `<div class="finding">… and ${findings.length - 40} more</div>` : ''}</div>` : '<p class="muted">No secret patterns found (this check is heuristic and cannot guarantee that).</p>'}`;
  const env = node.querySelector('#exEnv'), ackWrap = node.querySelector('#exAckWrap');
  if (env) env.onchange = () => ackWrap.classList.toggle('hidden', !env.checked);
  const choice = await dialog({
    title: 'Download project', node, actions: [
      { label: 'Cancel', value: null },
      { label: 'Download ZIP', primary: true, validate: b => (b.querySelector('#exEnv')?.checked && !b.querySelector('#exAck')?.checked ? 'Confirm the credentials warning to include environment files.' : null), value: b => ({ env: !!b.querySelector('#exEnv')?.checked, db: !!b.querySelector('#exDb')?.checked }) }
    ]
  });
  if (!choice) return;
  try {
    const zip = new JSZip();
    for (const d of ws.folders) zip.folder(d);
    for (const p of files) { if (!choice.env && isEnvFile(p)) continue; zip.file(p, ws.read(p)); }
    if (choice.db && S.db) zip.file('database/byteforge.sqlite', exportDb());
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `${S.project.replace(/[^\w.-]+/g, '-')}.zip`);
    toast('Project exported', `ZIP archive (${formatBytes(blob.size)}) generated locally in your browser.`);
  } catch (e) { toast('Export failed', e.message, { level: 'error' }); }
}

/* ───────────────────────── menu & wiring ───────────────────────── */
async function openMenu() {
  const node = document.createElement('div');
  node.innerHTML = '<p class="muted">Workspace data is stored locally in this browser (IndexedDB). Export your project regularly to keep an independent backup.</p>';
  const list = document.createElement('div'); list.className = 'row'; list.style.display = 'flex'; list.style.flexWrap = 'wrap'; list.style.gap = '8px';
  const add = (label, fn) => list.append(btn(label, () => { closeDialog(null); setTimeout(fn, 0); }));
  add('Open file…', quickOpen);
  add('Download current file', () => (S.active ? downloadFile(S.active) : toast('No file open', '', { level: 'warning' })));
  add('Import ZIP…', () => $('zipInput').click());
  add('Import files…', () => $('fileInput').click());
  add('Import folder…', () => $('folderInput').click());
  add('Pull runtime files', syncFromRuntime);
  add('Rename project…', renameProject);
  add('Toggle theme', () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applySettings(); renderSide(); });
  node.append(list);
  const links = document.createElement('p');
  links.innerHTML = '<a href="/docs.html" target="_blank" rel="noopener">Documentation</a> · <a href="/faq.html" target="_blank" rel="noopener">FAQ</a> · <a href="/terms.html" target="_blank" rel="noopener">Terms &amp; Conditions</a> · <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a> · <a href="/about.html" target="_blank" rel="noopener">About</a>';
  node.append(links);
  await dialog({ title: 'Workspace options', node, actions: [{ label: 'Close', value: null }] });
}
function setSide(panel) {
  const side = $('sidepanel');
  if (S.side === panel && !side.classList.contains('collapsed')) { side.classList.add('collapsed'); return; }
  side.classList.remove('collapsed'); S.side = panel;
  document.querySelectorAll('.activity').forEach(x => x.classList.toggle('active', x.dataset.panel === panel));
  renderSide();
  if (panel === 'terminal') selectBottom('terminal');
}
function wire() {
  document.querySelectorAll('.activity').forEach(b => { b.onclick = () => setSide(b.dataset.panel); });
  $('collapseSide').onclick = () => $('sidepanel').classList.add('collapsed');
  document.querySelectorAll('.bottom-tab').forEach(b => { b.onclick = () => selectBottom(b.dataset.bottom); });
  $('collapseBottom').onclick = () => { $('bottomPanel').classList.toggle('collapsed'); setTimeout(fitTerminal, 50); };
  $('clearTerminal').onclick = clearActivePanel;
  $('welcomeNew').onclick = () => createFile();
  $('importBtn').onclick = () => $('zipInput').click();
  $('quickOpenBtn').onclick = quickOpen;
  $('projectNameBtn').onclick = renameProject;
  $('zipInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('fileInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('folderInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('dbInput').onchange = e => { if (e.target.files[0]) importDbFile(e.target.files[0]); e.target.value = ''; };
  $('downloadBtn').onclick = exportProject;
  $('runBtn').onclick = runActive;
  $('previewBtn').onclick = () => openPreview();
  $('previewRefresh').onclick = () => { if (S.previewMode === 'runtime') $('previewFrame').src = S.serverUrl; else showStaticPreview(); };
  $('previewExternal').onclick = () => { if (S.previewMode === 'runtime' && S.serverUrl) window.open(S.serverUrl, '_blank', 'noopener'); else toast('Static preview stays inside ByteForge', 'It runs in a sandboxed frame so imported code cannot read your workspace. Start a dev server in the Node.js runtime to get a URL that can open in its own tab.'); };
  $('previewClose').onclick = closePreview;
  $('runSql').onclick = runSql;
  $('sqlInput').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });
  $('sqlInput').addEventListener('input', () => saveSoon());
  $('exportSql').onclick = () => { if (!S.db) return toast('Database unavailable', '', { level: 'error' }); downloadBlob(new Blob([exportDb()], { type: 'application/vnd.sqlite3' }), 'byteforge.sqlite'); };
  $('dumpSqlBtn').onclick = () => { if (!S.db) return toast('Database unavailable', '', { level: 'error' }); downloadBlob(new Blob([dumpSql(S.db)], { type: 'text/plain;charset=utf-8' }), 'byteforge-dump.sql'); };
  $('csvSql').onclick = () => { if (!S.lastResult) return toast('No result to export', 'Run a SELECT query first.', { level: 'warning' }); downloadBlob(new Blob([toCsv(S.lastResult.columns, S.lastResult.values)], { type: 'text/csv;charset=utf-8' }), 'result.csv'); };
  $('importSqlBtn').onclick = () => $('dbInput').click();
  $('resetSql').onclick = resetDatabase;
  $('menuBtn').onclick = openMenu;

  window.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); quickOpen(); }
    else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); $('bottomPanel').classList.toggle('collapsed'); setTimeout(fitTerminal, 50); }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('sidepanel').classList.toggle('collapsed'); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
    else if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) toggleFocus();
  });
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropOverlay').classList.remove('hidden'); } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('dropOverlay').classList.add('hidden');
    importFiles(await readDropped(e.dataTransfer));
  });
  // Warn when the same workspace is open in several tabs (last write wins).
  try {
    const bc = new BroadcastChannel('byteforge-tabs'); let warned = false;
    const warn = () => { if (!warned) { warned = true; toast('Workspace open in another tab', 'ByteForge saves whole-workspace snapshots. Editing in two tabs can overwrite each other (last save wins). Use one tab at a time.', { level: 'warning', ttl: 15000 }); } };
    bc.onmessage = e => { if (e.data === 'hello') { bc.postMessage('present'); warn(); } else if (e.data === 'present') warn(); };
    bc.postMessage('hello');
  } catch { /* BroadcastChannel unavailable */ }
  window.addEventListener('beforeunload', flushOnUnload);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveSoon.flush(); saveDbSoon.flush(); } });
  window.addEventListener('resize', fitTerminal);
}
function flushOnUnload() { saveSoon.flush(); saveDbSoon.flush(); }

/* ───────────────────────── startup ───────────────────────── */
async function main() {
  loadSettings();
  document.documentElement.dataset.theme = S.settings.theme;
  await restore();
  initEditor();
  applySettings();
  wire();
  initTerminal();
  renderSide(); renderTabs();
  if (S.active) setActive(S.active); else if (S.open.length) setActive(S.open[0]); else setActive(null);
  scanEverything(); renderProblems();
  await initDatabase();
  if (S.storageOk) { saveSoon(); estimateWarning(); }
  if (!window.crossOriginIsolated) $('runtimeStatus').textContent = 'Workspace Ready (runtime needs COOP/COEP)';
}
async function estimateWarning() {
  const est = await storageEstimate();
  if (est && est.quota && est.usage / est.quota > 0.8) toast('Browser storage almost full', `Using ${formatBytes(est.usage)} of ${formatBytes(est.quota)}. Export a backup and remove large files.`, { level: 'warning' });
}
main().catch(e => { console.error(e); toast('ByteForge failed to start', e.message, { level: 'error', ttl: 0 }); });
