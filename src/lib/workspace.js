// In-memory project model (files + explicit folders) with change events.
// The editor, persistence layer, WebContainer sync and shell all go through this class.
import { normalizePath, dirname } from './paths.js';

const fail = msg => { throw new Error(msg); };

export class Workspace {
  constructor() {
    this.files = new Map();   // path -> string | Uint8Array
    this.folders = new Set(); // explicit folders (so empty folders survive)
    this.listeners = new Set();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { this.listeners.forEach(fn => { try { fn(evt); } catch (e) { console.error(e); } }); }

  clean(p) { return normalizePath(p) ?? fail(`Invalid path: ${p}`); }
  fileExists(p) { return this.files.has(p); }
  dirExists(p) {
    if (p === '') return true;
    if (this.folders.has(p)) return true;
    const pre = p + '/';
    for (const f of this.files.keys()) if (f.startsWith(pre)) return true;
    for (const d of this.folders) if (d.startsWith(pre)) return true;
    return false;
  }
  exists(p) { return this.fileExists(p) || this.dirExists(p); }
  read(p) { return this.files.get(p); }
  allFiles() { return [...this.files.keys()].sort(); }

  /** Replace the whole project (used by restore/import-replace). */
  load(files, folders = []) {
    this.files = new Map(files);
    this.folders = new Set(folders);
    this.emit({ type: 'reset' });
  }

  write(path, content) {
    const p = this.clean(path);
    if (this.dirExists(p) && !this.fileExists(p)) fail(`${p} is a directory`);
    let q = dirname(p);
    while (q) { if (this.fileExists(q)) fail(`${q} is a file, cannot create ${p}`); q = dirname(q); }
    const created = !this.files.has(p);
    this.files.set(p, content);
    this.emit({ type: 'write', path: p, created });
    return p;
  }
  /** Editor keystroke sync: no structure checks, lighter event. */
  update(p, content) {
    if (!this.files.has(p)) return;
    this.files.set(p, content);
    this.emit({ type: 'edit', path: p });
  }
  mkdir(path) {
    const p = this.clean(path);
    if (this.fileExists(p)) fail(`${p} is a file`);
    let q = dirname(p);
    while (q) { if (this.fileExists(q)) fail(`${q} is a file`); q = dirname(q); }
    this.folders.add(p);
    this.emit({ type: 'mkdir', path: p });
    return p;
  }
  remove(path) {
    const p = this.clean(path);
    if (this.fileExists(p)) {
      this.files.delete(p);
      this.emit({ type: 'remove', path: p, isDir: false, removed: [p] });
      return [p];
    }
    if (!this.dirExists(p)) fail(`No such file or directory: ${p}`);
    const pre = p + '/';
    const removed = [...this.files.keys()].filter(f => f.startsWith(pre));
    removed.forEach(f => this.files.delete(f));
    [...this.folders].filter(d => d === p || d.startsWith(pre)).forEach(d => this.folders.delete(d));
    this.emit({ type: 'remove', path: p, isDir: true, removed });
    return removed;
  }
  move(from, to) {
    const a = this.clean(from), b = this.clean(to);
    if (a === b) return [];
    if (!this.exists(a)) fail(`No such file or directory: ${a}`);
    if (this.exists(b)) fail(`Destination exists: ${b}`);
    let q = dirname(b);
    while (q) { if (this.fileExists(q)) fail(`${q} is a file`); q = dirname(q); }
    const moved = [];
    if (this.fileExists(a)) {
      this.files.set(b, this.files.get(a)); this.files.delete(a); moved.push([a, b]);
      this.emit({ type: 'move', from: a, to: b, isDir: false, moved });
      return moved;
    }
    if (b.startsWith(a + '/')) fail('Cannot move a directory into itself');
    const pre = a + '/';
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(pre)) { const nf = b + '/' + f.slice(pre.length); this.files.set(nf, this.files.get(f)); this.files.delete(f); moved.push([f, nf]); }
    }
    for (const d of [...this.folders]) {
      if (d === a || d.startsWith(pre)) { this.folders.delete(d); this.folders.add(b + d.slice(a.length)); }
    }
    this.emit({ type: 'move', from: a, to: b, isDir: true, moved });
    return moved;
  }
  copy(from, to) {
    const a = this.clean(from), b = this.clean(to);
    if (!this.exists(a)) fail(`No such file or directory: ${a}`);
    if (this.exists(b)) fail(`Destination exists: ${b}`);
    if (this.fileExists(a)) { const v = this.files.get(a); return [this.write(b, v instanceof Uint8Array ? v.slice() : v)]; }
    if (b.startsWith(a + '/')) fail('Cannot copy a directory into itself');
    const pre = a + '/', out = [];
    for (const [f, v] of [...this.files]) if (f.startsWith(pre)) out.push(this.write(b + '/' + f.slice(pre.length), v instanceof Uint8Array ? v.slice() : v));
    for (const d of [...this.folders]) if (d === a || d.startsWith(pre)) this.folders.add(b + d.slice(a.length));
    if (!out.length) this.mkdir(b);
    return out;
  }
  /** Immediate children of a directory: [{name,path,type}] */
  list(dir = '') {
    const d = dir === '' ? '' : this.clean(dir);
    if (d && this.fileExists(d)) return [{ name: d.split('/').pop(), path: d, type: 'file' }];
    if (!this.dirExists(d)) fail(`No such file or directory: ${d}`);
    const pre = d ? d + '/' : '';
    const map = new Map();
    const add = (full, isFile) => {
      if (!full.startsWith(pre) || full === d) return;
      const rest = full.slice(pre.length);
      const name = rest.split('/')[0];
      const type = isFile && !rest.includes('/') ? 'file' : 'dir';
      if (!map.has(name) || type === 'dir') map.set(name, { name, path: pre + name, type });
    };
    this.files.forEach((_, f) => add(f, true));
    this.folders.forEach(f => add(f, false));
    return [...map.values()].sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
  }
}
