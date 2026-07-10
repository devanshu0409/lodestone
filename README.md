# Lodestone

An open-source desktop GUI for **Elasticsearch** (7.x / 8.x) and **OpenSearch** (1.x / 2.x),
built with Electron. A modern successor to the spirit of `elasticsearch-head` — without its
limits.

> Status: **early development (through M4)** — multi-cluster management with node discovery
> and failover, cluster overview, shard allocation grid, index management, a data browser
> with inline document editing and search, and a multi-tab REST console with context-aware
> query-DSL autocomplete. See [REQUIREMENTS.md](REQUIREMENTS.md) for the full spec and roadmap.

## Why another ES GUI?

- **Multi-cluster, multi-node.** Register any number of clusters, each from one or more
  seed URLs. The rest of the topology is discovered via `_nodes`, and requests fail over
  to healthy nodes automatically.
- **No URL re-typing, ever.** Everything is scoped to the selected cluster.
- **Works with secured clusters.** Basic auth today (API keys and mTLS on the roadmap via
  a pluggable auth interface), self-signed TLS supported. Being a desktop app, there is no
  CORS wall. Passwords are stored in the OS credential vault (DPAPI / Keychain), never in
  plaintext.
- **Safe on production.** Destructive operations require confirmation, and any connection
  can be flagged read-only — writes are blocked in the main process, not just hidden in
  the UI.
- **Light and dark themes**, minimalist instrument-panel design, fully offline-friendly.

Coming next (M5): hardening and an OpenSearch test matrix. Windows, macOS, and Linux
installers are already built via CI on every `v*` tag.

## Features so far

- **Clusters** — register any number, each from one or more seed nodes; discovery +
  failover. Organize connections into named folders with drag-and-drop, or collapse the
  sidebar to an icon strip with per-cluster status LEDs. Clone existing connections.
- **Overview** — health, node table with heap/RAM/CPU/disk meters and elected-master marker.
- **Shards** — indices × nodes allocation grid with primary/replica/relocating/initializing
  states; click an unassigned shard for a `_cluster/allocation/explain` breakdown.
- **Indices** — list, create (settings + mappings), edit dynamic settings, view mappings,
  manage aliases, refresh/flush/force-merge/open/close, delete (type-to-confirm).
- **Search** — index/alias picker, mapping-driven filter builder that compiles to a `bool`
  query, raw JSON mode (Monaco) with context-aware query-DSL autocomplete (query types,
  aggregations, field names, and enum values suggested based on cursor position),
  sortable paged results, inline document editing with validation and confirm-before-
  overwrite, document delete, export to JSON / NDJSON / CSV.
- **Console** — a Dev-Tools-style REST console with multiple parallel request tabs,
  backed by a searchable API catalog: find an operation by intent ("update by query",
  "reindex") and get a documented, pre-filled template. Path autocomplete from the
  catalog and live index names, field-aware body autocomplete, request history and
  saved requests (per cluster), a response pane with status/timing, and copy-as-cURL.
- **Themes** — light, dark, and follow-system theme switching from the sidebar.
- **Guardrails** — per-cluster read-only mode enforced in the main process; destructive
  actions require confirmation.

## Development

```bash
npm install
npm run dev        # launch the app with hot reload
npm run typecheck  # strict TS across main + renderer
npm run build      # production bundles
```

Renderer-only UI preview in a plain browser (mock data, no cluster access):

```bash
npm run dev -- --rendererOnly
```

> Behind a TLS-inspecting corporate proxy, the Electron binary download may fail with
> `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Fix: `NODE_OPTIONS=--use-system-ca npm install`.

## Building installers

```bash
npm run make-icons   # regenerate icons from build/icon.svg (uses the Electron binary)
npm run dist:win     # Windows: NSIS installer + zip  -> dist/
npm run dist:mac     # macOS: dmg + zip (x64 + arm64) -> dist/
npm run pack:dir     # unpacked app for quick local testing (no installer)
```

Builds are unsigned by default; supply electron-builder's standard signing env
vars to sign and (on macOS) notarize. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Platform notes**

- macOS packaging must run on macOS (dmg uses `hdiutil`). CI covers this: the
  [release workflow](.github/workflows/release.yml) builds Windows, macOS
  (Intel + Apple Silicon) and Linux on every `v*` tag, and can be run manually
  from the Actions tab.
- Opening an **unsigned** macOS build: Gatekeeper will block the first launch —
  right-click the app → Open (or clear the quarantine flag with
  `xattr -cr /Applications/Lodestone.app`).
- Unsigned Windows builds trigger SmartScreen — “More info → Run anyway”.

## Architecture

- **Main process** owns all cluster traffic: a version-adaptive HTTP transport
  ([src/main/transport.ts](src/main/transport.ts)) with node discovery and failover,
  connection storage with `safeStorage`-encrypted secrets, and the read-only guard.
- **Renderer** (React + TypeScript) talks to it only through a typed IPC bridge
  (`contextIsolation` on, no node integration).

## License

[Apache 2.0](LICENSE)
