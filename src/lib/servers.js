// Dev-server bookkeeping for the WebContainer runtime: a registry of listening ports, a small manager
// for processes that ByteForge starts itself (so they can be stopped/restarted), and helpers.
// Everything here is DOM-free and unit-tested; main.js wires it to the real WebContainer.

const LOCAL_HOST = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?=\/|\?|#|$)/i;

/** Label used everywhere in the UI so "localhost" is never ambiguous. */
export const sandboxLabel = port => `sandbox localhost:${port}`;

export const SANDBOX_NOTE = 'localhost here means the in-browser Node.js sandbox (WebContainer), not your device. '
  + 'Node code running in the sandbox sees the sandbox\'s localhost. JavaScript running in the preview page itself runs in your browser, '
  + 'so a request to http://localhost:PORT from it reaches your own device instead.';

/**
 * Combine a server base URL with a user-typed path. Accepts "/about", "about?x=1", or a pasted
 * "localhost:5173/about". Returns null when the input points at another origin (never navigate the
 * preview frame to arbitrary sites from this field).
 */
export function previewUrl(base, input = '') {
  let text = String(input ?? '').trim();
  let baseUrl;
  try { baseUrl = new URL(base); } catch { return null; }
  if (!text) return baseUrl.href;
  const local = LOCAL_HOST.exec(text);
  if (local) text = text.slice(local[0].length) || '/';
  try {
    const url = new URL(text, baseUrl.origin + '/');
    return url.origin === baseUrl.origin ? url.href : null;
  } catch { return null; }
}

/** Path + query + hash of a URL relative to a base, for showing in the address field. */
export function pathOf(url) {
  try { const u = new URL(url); return u.pathname + u.search + u.hash; } catch { return '/'; }
}

export const SERVER_SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'develop', 'watch'];
const SERVER_HINT = /\b(vite|next|nuxt|astro|remix|webpack(?:-dev-server| serve)|webpack-dev-server|parcel|serve|http-server|live-server|nodemon|node\s|ts-node|tsx|express|fastify|svelte-kit|sveltekit|react-scripts start|ng serve|vue-cli-service serve|eleventy|wrangler dev|json-server|browser-sync)\b/i;

/** Parse package.json text into runnable scripts, server-like ones first. */
const NOT_SERVER = /\b(build|test|tests|lint|format|typecheck|tsc|eslint|prettier|deploy|clean|install)\b/i;

export function parseScripts(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch (e) { return { scripts: [], error: `package.json is not valid JSON (${e.message})` }; }
  const raw = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const scripts = Object.entries(raw).filter(([, v]) => typeof v === 'string').map(([name, command]) => ({
    name, command,
    server: SERVER_SCRIPT_ORDER.includes(name) || (SERVER_HINT.test(command) && !NOT_SERVER.test(`${name} ${command}`))
  }));
  const rank = s => { const i = SERVER_SCRIPT_ORDER.indexOf(s.name); return s.server ? (i < 0 ? SERVER_SCRIPT_ORDER.length : i) : 100; };
  scripts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { scripts, error: null };
}

/** "localhost:5173", "http://127.0.0.1:3000" ... found in process output. */
export function portsFromText(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/gi)) {
    const n = +m[1]; if (n > 0 && n < 65536) found.add(n);
  }
  return [...found];
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = s => String(s).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');

/** Registry of listening ports (a port may be open before the HTTP server reports ready). */
export class ServerRegistry {
  constructor() { this.map = new Map(); this.activePort = null; this.listeners = new Set(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit() { for (const fn of this.listeners) { try { fn(this); } catch { /* listener errors must not break the registry */ } } }
  /** Port opened or became ready. Returns the entry. */
  open(port, url, { ready = false, owner = null } = {}) {
    const prev = this.map.get(port);
    const entry = { port, url: url ?? prev?.url ?? null, ready: ready || !!prev?.ready, owner: owner ?? prev?.owner ?? null, since: prev?.since ?? Date.now() };
    this.map.set(port, entry);
    if (ready && (this.activePort === null || !prev?.ready)) this.activePort = port;
    this.#emit();
    return entry;
  }
  close(port) {
    if (!this.map.delete(port)) return false;
    if (this.activePort === port) this.activePort = this.list().find(s => s.ready)?.port ?? null;
    this.#emit();
    return true;
  }
  closeOwned(owner) { for (const s of [...this.map.values()]) if (s.owner === owner) this.close(s.port); }
  setActive(port) { if (this.map.has(port)) { this.activePort = port; this.#emit(); } }
  get active() { return this.activePort === null ? null : this.map.get(this.activePort) ?? null; }
  get(port) { return this.map.get(port) ?? null; }
  list() { return [...this.map.values()].sort((a, b) => a.port - b.port); }
  clear() { this.map.clear(); this.activePort = null; this.#emit(); }
}

/**
 * Processes ByteForge starts itself (npm run dev, npm install ...). Each has a kill handle, so
 * "Stop" and "Restart" are real. `spawn(cmd, args)` must return { output: ReadableStream, exit: Promise<number>, kill() }
 * (this is the WebContainer process shape).
 */
export class ProcessManager {
  constructor({ spawn, onLog = () => {}, onChange = () => {} }) { this.spawn = spawn; this.onLog = onLog; this.onChange = onChange; this.procs = new Map(); this.seq = 0; }
  list() { return [...this.procs.values()]; }
  get(id) { return this.procs.get(id) ?? null; }
  running(kind) { return this.list().filter(p => p.status === 'running' && (!kind || p.kind === kind)); }
  async start(label, cmd, args = [], { kind = 'server', script = null } = {}) {
    const id = ++this.seq;
    const rec = { id, label, cmd, args, kind, script, status: 'starting', code: null, handle: null, startedAt: Date.now() };
    this.procs.set(id, rec); this.onChange(rec);
    try { rec.handle = await this.spawn(cmd, args); }
    catch (e) { rec.status = 'failed'; rec.code = -1; this.onLog(rec, `Could not start: ${e.message}\n`); this.onChange(rec); throw e; }
    rec.status = 'running'; this.onChange(rec);
    this.onLog(rec, `$ ${[cmd, ...args].join(' ')}\n`);
    rec.handle.output.pipeTo(new WritableStream({ write: chunk => this.onLog(rec, stripAnsi(chunk)) })).catch(() => {});
    rec.handle.exit.then(code => {
      rec.status = rec.stopRequested ? 'stopped' : 'exited'; rec.code = code;
      this.onLog(rec, `\n[${label}] ${rec.stopRequested ? 'stopped' : `exited with code ${code}`}\n`);
      this.onChange(rec);
    }, e => { rec.status = 'failed'; this.onLog(rec, `\n[${label}] failed: ${e?.message ?? e}\n`); this.onChange(rec); });
    return rec;
  }
  stop(id) {
    const rec = this.procs.get(id);
    if (!rec || rec.status !== 'running') return false;
    rec.stopRequested = true;
    try { rec.handle.kill(); } catch (e) { rec.stopRequested = false; this.onLog(rec, `Could not stop: ${e.message}\n`); return false; }
    return true;
  }
  /** Which running server process should own a port that just opened? Only unambiguous cases get an owner. */
  ownerForNewPort(claimedOwners) {
    const waiting = this.running('server').filter(p => !claimedOwners.has(p.id));
    return waiting.length === 1 ? waiting[0].id : null;
  }
  forget(id) { const r = this.procs.get(id); if (r && r.status !== 'running' && r.status !== 'starting') { this.procs.delete(id); return true; } return false; }
}
