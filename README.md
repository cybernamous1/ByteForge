# ByteForge

**Build freely. Develop locally.** ByteForge is a client-first browser development workstation: a Monaco editor, project file tree, terminal, sandboxed JavaScript/Python runners, an optional real Node.js runtime (WebContainers), a SQLite database studio, static and runtime previews, and portable ZIP import/export. Everything runs in your browser; there are no accounts, paid APIs, AI services or cloud databases.

## Quick start

```bash
npm install        # also generates package-lock.json: commit it
npm run dev        # http://localhost:5173 (served with COOP/COEP for WebContainers)
npm run verify     # unit tests + headless smoke test + production build
npm run build      # outputs ./dist
```

Requirements: Node.js 20+, npm, a modern browser. The Node.js runtime additionally needs cross-origin isolation (already configured for `vite dev`, `vite preview` and Cloudflare Workers via `public/_headers`) and a WebContainers-compatible desktop browser.

## Deploy (Cloudflare Workers)

1. `npm run build`
2. `npx wrangler deploy` (or `npm run deploy`), which serves `dist/` as static assets per `wrangler.jsonc`, or connect the repo in Workers Builds with build command `npm run build` and deploy command `npx wrangler deploy`.
3. `public/_headers` is copied into `dist/` and sets COOP/COEP/CORP, `nosniff`, a referrer policy, a permissions policy, frame protection and long-lived caching for hashed assets. After deploying, open the browser console and confirm `crossOriginIsolated === true` (needed for the Node.js runtime).

No server code, database or secrets are required: the site is fully static. sql.js's WebAssembly file and Monaco's workers are bundled and served from your own origin, so the app itself makes no third-party requests.

Before a public launch: edit the **Operator contact** section of `public/about.html`, have `terms.html` and `privacy.html` reviewed for your jurisdiction, and review the licenses below (especially WebContainers for commercial use).

## What is implemented

| Area | Implementation |
|---|---|
| Editor | Monaco, multi-file tabs, folders, rename/move/delete, quick open (Ctrl+P), project-wide search (literal/regex), syntax diagnostics in the Problems panel, light/dark themes, font/tab/wrap/minimap/format-on-save settings |
| Storage | Workspace and SQLite database in IndexedDB (debounced autosave + flush on hide/close), preferences in localStorage, persistent-storage request, usage estimate, save-failure warnings, multi-tab warning, delete-all-data control, automatic migration (with repair) of the v1 localStorage workspace |
| Files | Text and binary files preserved, folder/ZIP/file import with drag and drop, zip-slip protection, size/count limits, ignore of `node_modules`/`.git`, single-root unwrapping, overwrite prompt, ZIP export with env-file opt-in |
| Terminal | Real workspace shell (`ls tree cat head tail mkdir touch rm mv cp echo grep wc node python sql run sync preview clear`) with history, Tab completion, redirection; real `jsh` shell attached after the Node.js runtime starts |
| Runtimes | JavaScript in an isolated Worker (10 s limit); Python via Pyodide, loaded on demand after consent (experimental); Node.js + npm via WebContainers after consent, with workspace-to-container sync and a pull-back command |
| Preview | Sandboxed static preview (inlines CSS, classic scripts and images, forwards console output, live refresh) and automatic runtime preview when a dev server starts |
| Database | sql.js SQLite: multi-statement execution, result tables, table browser, persistence, `.sqlite` export/import, `.sql` dump/import, CSV export, reset, terminal `sql` command |
| Security | Local secret detection (private keys, cloud/provider tokens, JWTs, DB URLs, generic assignments) shown in Problems, on import and in the export dialog with masked values; preview frames have an opaque origin; no external hosts hard-coded except the documented Pyodide CDN |
| Accessibility | Keyboard-operable tree/tabs/dialogs, focus trapping and restoration in dialogs, ARIA roles/labels/live regions, visible focus, skip link, reduced-motion support, responsive layout |
| Docs | `docs.html`, `faq.html`, `privacy.html`, `terms.html`, `about.html` describe the actual behavior, dependencies, network requests and limits |

## Known limitations (also stated in the in-app docs)

- Not a replacement for desktop VS Code: no debugger, extensions, Git integration or access to the local file system.
- The pre-runtime terminal is a small workspace shell, not POSIX (no pipes, globs, env vars).
- JS/TS diagnostics are syntax-only; npm types and Node globals are unavailable to Monaco's in-browser language service.
- The JavaScript runner does not support `import`/`export` or `require`; use the Node.js runtime for modules and packages.
- Static preview does not inline ES module graphs; it opens no external tab (sandbox by design). Use a dev server in the runtime for those.
- WebContainers: desktop, supported browsers only, requires cross-origin isolation, contacts StackBlitz servers and the npm registry when used, and has its own licensing. Files deleted inside the runtime are not removed from the workspace when pulling back.
- Python (Pyodide) is experimental, standard distribution only, no `pip`.
- Only SQLite is provided. PostgreSQL/PGlite, DuckDB and other engines are not included.
- No service worker yet: the page must be loaded online once per visit.
- Storage is unencrypted; secret detection is heuristic and cannot guarantee detection.
- `xterm` / `xterm-addon-fit` are the older, deprecated package names kept to avoid a migration; moving to `@xterm/xterm` and `@xterm/addon-fit` is a drop-in change when convenient.

## Verification status (read this)

This build was produced in a sandbox **without network access**, so `npm install`, `vite build`, and browser testing could **not** be run there. What was verified:

| Check | Result |
|---|---|
| `node --test` — 37 unit/consistency tests: path safety, workspace operations, shell commands, secret detection, search, preview builder, SQL helpers/dump, WebContainer tree, docs↔code consistency, DOM-id consistency between `index.html` and the scripts | Pass |
| `npm run test:smoke` — real `main.js` executed headless against stubbed Monaco/xterm/sql.js/JSZip/WebContainers and a minimal DOM: startup, explorer render, terminal input, file create/read/delete, unknown commands, `sql` command | Pass |
| `node --check` on every source file | Pass |

Not verified here, and therefore the first things to check after `npm install`: `npm run build` (Vite bundling of Monaco workers, the sql.js wasm `?url` import), real-browser behavior (IndexedDB persistence, Monaco, drag/drop, preview iframes), WebContainers boot/sync/`jsh`, Pyodide, and Cloudflare Workers header behavior. `npm run verify` runs everything that can be automated; the browser-only items need a manual pass. If the Vite build reports a problem with the sql.js import path, adjust `sqlWasmUrl` in `src/main.js`.

## Changes from the initial build

Defects fixed: `main.js` did not parse (invalid regular expression in the export code); terminal Enter/Backspace never matched (double-escaped sequences) and shell tokenization was broken; starter files contained literal `\n`; top-level `await` with the default Vite target; sql.js wasm loaded from a CDN, which cross-origin isolation blocks, and which leaked requests to a third party; database was never persisted; Monaco workers were not configured; the info pages and stylesheet were empty files; `npm install` ran automatically on runtime start.
Added: everything in the table above that was listed as "future work" in v1, except engines other than SQLite.

## Licensing

Review the licenses and terms of Monaco Editor (MIT), xterm.js (MIT), sql.js (MIT), JSZip (MIT or GPL-3.0), Vite (MIT), Pyodide (MPL-2.0, loaded on demand), WebContainers (`@webcontainer/api`, StackBlitz terms; commercial use may require a license) and all transitive dependencies before public or commercial distribution.

## Security

Do not use ByteForge as a secret vault. Browser storage is not encrypted; use your provider's secret store for production credentials, and review exports before sharing.
