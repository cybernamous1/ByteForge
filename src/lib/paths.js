// Pure path / file helpers. No DOM access so they can be unit tested in Node.

export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw.length > 512) return null;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // never allow traversal (zip-slip, shell, rename)
    if (/[\u0000-\u001f]/.test(seg)) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

export const basename = p => p.split('/').pop();
export const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const joinPath = (...parts) => parts.filter(Boolean).join('/');

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', toml: 'ini', ini: 'ini', env: 'ini',
  lua: 'lua', r: 'r', dart: 'dart', txt: 'plaintext', csv: 'plaintext', lock: 'plaintext'
};
const NAME_LANG = { dockerfile: 'dockerfile', makefile: 'plaintext' };

export function languageFor(path) {
  const name = basename(path).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  return EXT_LANG[name.slice(dot + 1)] || 'plaintext';
}

const LANG_LABEL = { javascript: 'JavaScript', typescript: 'TypeScript', html: 'HTML', css: 'CSS', json: 'JSON', markdown: 'Markdown', python: 'Python', sql: 'SQL', yaml: 'YAML', plaintext: 'Plain Text', shell: 'Shell', ini: 'INI / env' };
export const languageLabel = id => LANG_LABEL[id] || id.charAt(0).toUpperCase() + id.slice(1);

/** True for real environment files (.env, .env.local ...) but not templates. */
export function isEnvFile(path) {
  const name = basename(path);
  if (!/^\.env(\..+)?$/.test(name)) return false;
  return !/\.(example|sample|template|dist)$/i.test(name);
}

const IMPORT_IGNORED = ['node_modules', '.git', '.DS_Store', '__MACOSX'];
export function shouldIgnoreImport(path) {
  return path.split('/').some(seg => IMPORT_IGNORED.includes(seg));
}

export function isSqliteBytes(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 16) return false;
  const magic = 'SQLite format 3\0';
  for (let i = 0; i < 16; i++) if (u8[i] !== magic.charCodeAt(i)) return false;
  return true;
}

/** Decode bytes as UTF-8 text when they look like text; otherwise return the bytes untouched. */
export function decodeBytes(u8) {
  const head = u8.subarray(0, 8000);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return u8;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return u8;
  }
}

export function toBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', css: 'text/css', js: 'text/javascript', json: 'application/json', html: 'text/html', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain' };
export function mimeFor(path) {
  const ext = basename(path).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Build a sorted nested tree from file paths and explicit (possibly empty) folders. */
export function buildTree(filePaths, folderPaths = []) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map([['', root]]);
  const ensureDir = path => {
    if (dirs.has(path)) return dirs.get(path);
    const parent = ensureDir(dirname(path));
    const node = { name: basename(path), path, type: 'dir', children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  folderPaths.forEach(ensureDir);
  for (const p of filePaths) ensureDir(dirname(p)).children.push({ name: basename(p), path: p, type: 'file' });
  const sort = node => {
    node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    node.children.forEach(c => c.type === 'dir' && sort(c));
  };
  sort(root);
  return root;
}
