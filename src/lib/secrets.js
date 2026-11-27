// Local heuristic secret detection. Runs entirely in the browser; nothing is transmitted.
// It cannot guarantee detection and can flag harmless values.
import { basename } from './paths.js';

const PROVIDER_PATTERNS = [
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Secret key (sk- prefix)', re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Database URL with credentials', re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@/i },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ }
];

const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',;]{8,})/i;
const PLACEHOLDER = /^(?:replace[_-]?me.*|change[_-]?me.*|your[_-].*|<.*>|x{3,}|\*{3,}|\.{3,}|example.*|placeholder.*|todo.*|process\.env.*|import\.meta.*|os\.environ.*|getenv.*|\$\{.*\}|\$[A-Z_]+|null|undefined|true|false|none|secret|password|token)$/i;
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/i;

function looksLikeCode(value) {
  return /[()[\]{}]/.test(value) || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value);
}

export function mask(value) {
  return value.length <= 8 ? '••••' : value.slice(0, 4) + '••••' + value.slice(-2);
}

/** Scan one text file. Returns [{path, line, type, preview}] (values are masked). */
export function scanContent(path, content) {
  if (typeof content !== 'string' || content.length > 1_500_000) return [];
  const findings = [];
  const template = TEMPLATE_FILE.test(basename(path));
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && findings.length < 50; i++) {
    const text = lines[i];
    if (text.length > 4000) continue;
    let hit = null;
    for (const p of PROVIDER_PATTERNS) {
      const m = p.re.exec(text);
      if (m) { hit = { type: p.name, preview: mask(m[0]) }; break; }
    }
    if (!hit && !template) {
      const m = ASSIGNMENT.exec(text);
      if (m && !PLACEHOLDER.test(m[2]) && !looksLikeCode(m[2])) hit = { type: 'Credential assignment', preview: `${m[1]} = ${mask(m[2])}` };
    }
    if (hit) findings.push({ path, line: i + 1, ...hit });
  }
  return findings;
}

/** Scan every text file in a Map(path -> content). */
export function scanAll(files) {
  const out = [];
  for (const [path, content] of files) out.push(...scanContent(path, content));
  return out;
}
