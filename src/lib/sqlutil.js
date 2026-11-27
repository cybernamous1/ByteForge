// SQL helpers: literal quoting, CSV export and a SQL dump generator for sql.js databases.
export const quoteIdent = name => '"' + String(name).replace(/"/g, '""') + '"';

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return "X'" + [...v].map(b => b.toString(16).padStart(2, '0')).join('') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function toCsv(columns, rows) {
  const cell = v => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Uint8Array ? `[${v.length} bytes]` : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Plain-text table for the terminal `sql` command. */
export function toTextTable(columns, rows, maxRows = 200) {
  const shown = rows.slice(0, maxRows).map(r => r.map(v => (v === null ? 'NULL' : v instanceof Uint8Array ? `[${v.length} bytes]` : String(v))));
  const widths = columns.map((c, i) => Math.min(40, Math.max(c.length, ...shown.map(r => r[i].length))));
  const fmt = r => r.map((v, i) => (v.length > widths[i] ? v.slice(0, widths[i] - 1) + '…' : v).padEnd(widths[i])).join(' | ');
  const lines = [fmt(columns), widths.map(w => '-'.repeat(w)).join('-+-'), ...shown.map(fmt)];
  if (rows.length > maxRows) lines.push(`… ${rows.length - maxRows} more rows`);
  return lines.join('\n');
}

/** Produce a portable SQL script (schema + data) from a sql.js Database. */
export function dumpSql(db) {
  const first = sql => { const r = db.exec(sql); return r.length ? r[0].values : []; };
  const objects = first("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid");
  const out = ['-- ByteForge SQLite dump', 'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const [type, name, sql] of objects) {
    if (type !== 'table') continue;
    out.push(sql.trimEnd() + ';');
    const res = db.exec(`SELECT * FROM ${quoteIdent(name)}`);
    if (res.length) {
      const cols = res[0].columns.map(quoteIdent).join(', ');
      for (const row of res[0].values) out.push(`INSERT INTO ${quoteIdent(name)} (${cols}) VALUES (${row.map(sqlLiteral).join(', ')});`);
    }
  }
  for (const [type, , sql] of objects) if (type !== 'table') out.push(sql.trimEnd() + ';');
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}
