// Project-wide text search over a Map(path -> string|Uint8Array). Binary files are skipped.
export function searchFiles(files, query, { regex = false, caseSensitive = false, maxResults = 500 } = {}) {
  if (!query) return { results: [], truncated: false, error: null };
  let re;
  try {
    const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(src, caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { results: [], truncated: false, error: e.message };
  }
  const results = [];
  for (const path of [...files.keys()].sort()) {
    const content = files.get(path);
    if (typeof content !== 'string') continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m && m[0].length) {
        results.push({ path, line: i + 1, col: m.index + 1, length: m[0].length, text: lines[i].slice(0, 300) });
        if (results.length >= maxResults) return { results, truncated: true, error: null };
      }
    }
  }
  return { results, truncated: false, error: null };
}
