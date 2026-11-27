// Lightweight workspace shell. It operates on the in-browser project only and is NOT a POSIX shell.
// Real Node.js shell access is provided separately by the WebContainer runtime.
import { normalizePath } from './paths.js';
import { searchFiles } from './search.js';

export function tokenize(line) {
  const args = [];
  let cur = '', quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) args.push(cur); cur = ''; has = false; }
    else if (c === '>') {
      if (cur || has) args.push(cur); cur = ''; has = false;
      if (line[i + 1] === '>') { args.push('>>'); i++; } else args.push('>');
    } else { cur += c; has = true; }
  }
  if (quote) return { args, error: 'Unterminated quote' };
  if (cur || has) args.push(cur);
  return { args };
}

export const HELP = [
  'ByteForge workspace shell (operates on this browser workspace; not a POSIX shell)',
  '  ls [path]            list files        tree [path]       show tree',
  '  cat <file>           print a file      head/tail [-n N] <file>',
  '  mkdir <dir>          create folder     touch <file>      create empty file',
  '  rm [-r] <path>       delete            mv <from> <to>    move/rename',
  '  cp <from> <to>       copy              echo text [> file | >> file]',
  '  grep [-i] <re> [paths]   search        wc <file>         count lines/words/bytes',
  '  node <file.js>       run JavaScript in an isolated worker',
  '  python <file.py>     run Python (Pyodide, downloads on first use, asks first)',
  '  sql "<statement>"    run SQL against the Database Studio database',
  '  run                  start the Node.js WebContainer runtime (real shell, npm)',
  '  sync                 copy files from the running runtime into the workspace',
  '  preview              open the static preview     clear   clear the screen'
].join('\n');

const enc = new TextEncoder();
const size = v => (typeof v === 'string' ? enc.encode(v).length : v.length);

export function createShell(ws) {
  const out = [];
  const say = s => out.push(s);
  const norm = p => normalizePath(p);
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const text = p => {
    const n = norm(p); need(n, `Invalid path: ${p}`);
    need(ws.fileExists(n), `cat: ${p}: No such file`);
    const v = ws.read(n); need(typeof v === 'string', `${p}: binary file`);
    return v;
  };

  function treeLines(dir, prefix = '') {
    const kids = ws.list(dir);
    const lines = [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + k.name + (k.type === 'dir' ? '/' : ''));
      if (k.type === 'dir') lines.push(...treeLines(k.path, prefix + (last ? '    ' : '│   ')));
    });
    return lines;
  }

  const commands = {
    help: () => say(HELP),
    pwd: () => say('/workspace'),
    ls: a => {
      const target = a.find(x => !x.startsWith('-')) ?? '';
      const p = target ? norm(target) : '';
      need(p !== null, `ls: invalid path ${target}`);
      for (const k of ws.list(p)) say(k.name + (k.type === 'dir' ? '/' : ''));
    },
    tree: a => {
      const p = a[0] ? norm(a[0]) : '';
      need(p !== null, 'tree: invalid path');
      say(a[0] ? p : '.');
      treeLines(p).forEach(say);
    },
    cat: a => { need(a.length, 'usage: cat <file>'); a.forEach(f => say(text(f).replace(/\n$/, ''))); },
    head: a => headTail(a, true),
    tail: a => headTail(a, false),
    mkdir: a => { need(a.length, 'usage: mkdir <dir>'); a.filter(x => x !== '-p').forEach(d => ws.mkdir(d)); },
    touch: a => { need(a.length, 'usage: touch <file>'); a.forEach(f => { const n = norm(f); need(n, `Invalid path: ${f}`); if (!ws.fileExists(n)) ws.write(n, ''); }); },
    rm: a => {
      const rec = a.some(x => /^-[rf]+$/.test(x));
      const targets = a.filter(x => !x.startsWith('-')); need(targets.length, 'usage: rm [-r] <path>');
      for (const t of targets) { const n = norm(t); need(n, `Invalid path: ${t}`); need(!(ws.dirExists(n) && !ws.fileExists(n)) || rec, `rm: ${t} is a directory (use -r)`); ws.remove(n); }
    },
    mv: a => { need(a.length === 2, 'usage: mv <from> <to>'); ws.move(a[0], a[1]); },
    cp: a => { const t = a.filter(x => !x.startsWith('-')); need(t.length === 2, 'usage: cp <from> <to>'); ws.copy(t[0], t[1]); },
    wc: a => {
      need(a.length, 'usage: wc <file>');
      for (const f of a) { const v = text(f); say(`${(v.match(/\n/g) || []).length} ${v.split(/\s+/).filter(Boolean).length} ${size(v)} ${f}`); }
    },
    grep: a => {
      const flags = a.filter(x => /^-[in]+$/.test(x));
      const rest = a.filter(x => !/^-[in]+$/.test(x));
      need(rest.length, 'usage: grep [-i] <regex> [paths]');
      const [pattern, ...paths] = rest;
      const scoped = new Map();
      if (paths.length) {
        for (const p of paths) {
          const n = norm(p); need(n, `Invalid path: ${p}`);
          for (const f of ws.allFiles()) if (f === n || f.startsWith(n + '/')) scoped.set(f, ws.read(f));
        }
      } else ws.files.forEach((v, k) => scoped.set(k, v));
      const res = searchFiles(scoped, pattern, { regex: true, caseSensitive: !flags.some(f => f.includes('i')) });
      need(!res.error, `grep: ${res.error}`);
      res.results.forEach(r => say(`${r.path}:${r.line}:${r.text.trim()}`));
      if (!res.results.length) process_exit = 1;
    }
  };
  let process_exit = 0;

  function headTail(a, head) {
    let n = 10; const files = [];
    for (let i = 0; i < a.length; i++) { if (a[i] === '-n') n = Math.max(0, parseInt(a[++i], 10) || 10); else files.push(a[i]); }
    need(files.length, `usage: ${head ? 'head' : 'tail'} [-n N] <file>`);
    const lines = text(files[0]).replace(/\n$/, '').split('\n');
    (head ? lines.slice(0, n) : lines.slice(-n)).forEach(say);
  }

  /** @returns {{output:string, code:number, action?:object}} */
  function exec(line) {
    out.length = 0; process_exit = 0;
    const { args, error } = tokenize(line.trim());
    if (error) return { output: error, code: 2 };
    if (!args.length) return { output: '', code: 0 };
    let [cmd, ...rest] = args;
    try {
      if (cmd === 'clear') return { output: '', code: 0, action: { type: 'clear' } };
      if (cmd === 'run') return { output: '', code: 0, action: { type: 'boot' } };
      if (cmd === 'sync') return { output: '', code: 0, action: { type: 'sync' } };
      if (cmd === 'preview') return { output: '', code: 0, action: { type: 'preview' } };
      if (cmd === 'node' || cmd === 'python' || cmd === 'python3') {
        need(rest[0], `usage: ${cmd} <file>`);
        const n = norm(rest[0]); need(n && ws.fileExists(n), `${cmd}: ${rest[0]}: No such file`);
        return { output: '', code: 0, action: { type: cmd === 'node' ? 'node' : 'python', path: n } };
      }
      if (cmd === 'sql') { need(rest.length, 'usage: sql "<statement>"'); return { output: '', code: 0, action: { type: 'sql', query: rest.join(' ') } }; }
      if (cmd === 'echo') {
        const i = rest.findIndex(x => x === '>' || x === '>>');
        if (i === -1) { say(rest.join(' ')); return { output: out.join('\n'), code: 0 }; }
        need(rest[i + 1], 'echo: missing file after redirection');
        const n = norm(rest[i + 1]); need(n, `Invalid path: ${rest[i + 1]}`);
        const body = rest.slice(0, i).join(' ') + '\n';
        const prev = rest[i] === '>>' && ws.fileExists(n) ? ws.read(n) : '';
        need(typeof prev === 'string', 'echo: cannot append to a binary file');
        ws.write(n, prev + body);
        return { output: '', code: 0 };
      }
      const fn = commands[cmd];
      if (!fn) return { output: `${cmd}: command not found in the workspace shell. Type "help", or run "run" to start the Node.js runtime for a real shell.`, code: 127 };
      fn(rest);
      return { output: out.join('\n'), code: process_exit };
    } catch (e) {
      return { output: e.message, code: 1 };
    }
  }

  /** Path completion for the Tab key. Returns the list of candidates. */
  function complete(partial) {
    const idx = partial.lastIndexOf('/');
    const dir = idx >= 0 ? partial.slice(0, idx) : '';
    const stem = idx >= 0 ? partial.slice(idx + 1) : partial;
    try {
      return ws.list(dir).filter(k => k.name.startsWith(stem)).map(k => (dir ? dir + '/' : '') + k.name + (k.type === 'dir' ? '/' : ''));
    } catch { return []; }
  }
  return { exec, complete };
}
