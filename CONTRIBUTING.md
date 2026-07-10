# Contributing to Lodestone

Thanks for your interest in improving Lodestone! This is an open-source
(Apache 2.0) desktop GUI for Elasticsearch and OpenSearch.

## Getting started

```bash
npm install
npm run dev        # launch the app with hot reload
```

If the Electron binary download fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
(common behind a TLS-inspecting corporate proxy), install with the system CA
store trusted:

```bash
NODE_OPTIONS=--use-system-ca npm install
```

## Project layout

| Path | What lives there |
|---|---|
| `src/main` | Electron main process — ES transport, node discovery/failover, connection store (secrets via `safeStorage`), IPC handlers. All cluster traffic goes here. |
| `src/preload` | The typed IPC bridge exposed to the renderer (`window.lodestone`). |
| `src/renderer` | React + TypeScript UI. Components, Zustand stores, the API catalog, Monaco editor wrapper. |
| `src/shared` | Types shared across processes. |
| `build/` | Packaging resources. `icon.svg` is the source of truth; PNG/ICO are generated. |

## Conventions

- **TypeScript is strict.** Run `npm run typecheck` before opening a PR.
- **The renderer never talks to a cluster directly.** Everything crosses the
  typed IPC contract (`contextIsolation: true`, `nodeIntegration: false`). Add
  new cluster operations as IPC handlers in `src/main`, not `fetch` in the UI.
- **Respect the read-only guard.** Mutating requests are blocked in the main
  process for read-only connections — don't route around it.
- **Match the surrounding style.** Semantic CSS variables (see
  `src/renderer/src/styles/tokens.css`) — no hard-coded colors, so light/dark
  both work.

## Before you submit

```bash
npm run typecheck
npm run build      # ensure it packages
```

Describe what you changed and, for UI work, include a screenshot in both themes.

## Building installers

```bash
npm run make-icons     # regenerate icon rasters from build/icon.svg
npm run dist:win       # Windows NSIS installer + zip  -> dist/
npm run dist:mac       # macOS dmg + zip               -> dist/
npm run pack:dir       # unpacked app (fast, no installer) for local testing
```

Builds are unsigned by default. To sign, provide the platform certificates via
electron-builder's standard env vars (`CSC_LINK`, `CSC_KEY_PASSWORD` on macOS;
`WIN_CSC_LINK` on Windows).
