# Elasticsearch Desktop GUI — Requirements Specification

**Status:** Living document — tracks the design rationale and roadmap
**Date:** 2026-07-09
**License:** Apache 2.0 (open source)

---

## 1. Problem Statement

`elasticsearch-head` is the most-loved lightweight ES GUI, but it is unmaintained and has
structural limitations:

1. **Single-node tunnel vision** — it connects to one node URL at a time; no concept of a
   *cluster* made of multiple nodes, and no way to manage multiple clusters.
2. **No persistent request context** — every ad-hoc request requires re-entering the URL.
3. **Browser-extension constraints** — CORS, mixed-content, and no story for TLS with
   self-signed certs or modern authentication.
4. **API discoverability** — users constantly leave the tool to search Elastic docs for the
   correct endpoint/body for operations like update-by-query, reindex, or search templates.

This project builds a modern, open-source **Electron desktop app** that solves all four.

## 2. Goals

- First-class **multi-cluster** management: register many clusters, each defined by one or
  more seed nodes; switch instantly; no re-entry of URLs ever.
- **Smart node discovery & failover**: given one seed node, discover cluster topology via
  the `_nodes` API; route requests to healthy nodes automatically.
- **API catalog + REST console**: searchable-by-intent catalog of ES/OpenSearch APIs
  ("update by query" → matching endpoints with pre-filled templates, param docs, and a
  Run button), combined with Dev-Tools-style autocomplete in the console.
- Modern equivalents of the elasticsearch-head essentials: cluster overview, shard grid,
  data browser, index management.
- Safe by default: destructive-operation confirmations and per-cluster read-only mode.

## 3. Non-Goals (v1)

- Kibana-style dashboards / visualizations (Lens, TSVB, etc.)
- Alerting, ML, security administration UIs
- Log tailing / ingest pipeline builders (candidate for v2 backlog)
- Linux packaging polish (AppImage/deb — CI already builds AppImage)

## 4. Target Environments

| Dimension | Requirement |
|---|---|
| Elasticsearch | 7.x and 8.x |
| OpenSearch | 1.x and 2.x |
| Version handling | Detect distribution + version at connect time; adapt API surface/spec accordingly |
| OS | **Windows** (primary, dev/test platform), **macOS** (secondary), **Linux** (AppImage via CI) |

> Implementation note: the official `@elastic/elasticsearch` JS client rejects OpenSearch
> via product checks. We will use a thin custom HTTP transport in the Electron main
> process instead — this also gives us custom-CA/TLS control and full request visibility.

## 5. Functional Requirements

### FR-1 Connection & Cluster Management
- FR-1.1 Register unlimited named clusters; each has 1..n seed node URLs.
- FR-1.2 On connect, discover all nodes via `_nodes/http`; keep topology refreshed.
- FR-1.3 Automatic failover: if the active node is unreachable, retry against other
  discovered/seed nodes transparently; surface a non-blocking warning.
- FR-1.4 Instant cluster switcher (sidebar / command palette); all views and the console
  are always scoped to the selected cluster — no URL entry anywhere.
- FR-1.5 Per-cluster color/label tag (e.g., red "PROD") shown persistently in the UI.
- FR-1.6 Connections persisted locally; secrets stored via OS credential vault
  (Electron `safeStorage` → Windows DPAPI / macOS Keychain), never in plaintext config.

### FR-2 Authentication (pluggable)
- FR-2.1 v1 ships **basic auth** and **no auth**.
- FR-2.2 Auth is a pluggable interface (`AuthProvider`): a strategy object that decorates
  outgoing requests. Designed so API keys, bearer/service tokens, client-cert mTLS, and
  Elastic Cloud ID can be added without touching call sites. API keys are the first
  post-v1 addition (cheap to implement — likely lands in v1 anyway).
- FR-2.3 TLS options per cluster: custom CA bundle, or explicit "trust self-signed"
  toggle (with visible warning badge).

### FR-3 Cluster Overview & Shard Grid
- FR-3.1 Cluster health (status, nodes, shards, pending tasks, unassigned shards).
- FR-3.2 Node list: roles, versions, heap/disk/CPU, master indicator.
- FR-3.3 Shard allocation grid (the head signature view, modernized): indices × nodes,
  primaries/replicas, shard states (INITIALIZING / RELOCATING / UNASSIGNED) with
  explain-unassigned integration (`_cluster/allocation/explain`).
- FR-3.4 Auto-refresh with configurable interval; manual refresh.

### FR-4 Data Browser & Search
- FR-4.1 Pick an index/alias/data stream → paged, sortable document table; columns
  derived from mappings; nested/object fields expandable.
- FR-4.2 Structured filter builder (field / operator / value) that compiles to a
  `bool` query — no JSON required for common cases.
- FR-4.3 Raw query mode: edit the full request body (Monaco editor, JSON validation);
  the structured filters and raw mode round-trip where possible.
- FR-4.4 View / edit / delete individual documents (edit & delete honor guardrails, FR-7).
- FR-4.5 Export current result set (JSON / NDJSON / CSV).

### FR-5 Index Management
- FR-5.1 Index list with health, docs count, size, shard/replica counts; search/filter.
- FR-5.2 Create index (settings + mappings editor with validation).
- FR-5.3 View/edit dynamic settings; view mappings; add fields to mappings.
- FR-5.4 Alias management (add/remove, filtered aliases, write index).
- FR-5.5 Operations: open/close, force-merge, refresh, flush, clone, shrink, reindex
  (with task progress via `_tasks`), delete.

### FR-6 API Catalog + REST Console (the differentiator)
- FR-6.1 Bundle the machine-readable Elasticsearch API specification (from
  `elastic/elasticsearch-specification` / Kibana console spec files) and the OpenSearch
  API spec; select the right spec set for the connected cluster's distribution+version.
- FR-6.2 **Catalog**: full-text search over API names, descriptions, and aliases by
  intent ("insert document", "update by query", "reindex") → result cards with:
  endpoint + method, summary, parameter docs, link to official docs, and an
  **Open in console** button that inserts a pre-filled request template.
- FR-6.3 **Console**: multi-request editor (Dev-Tools style `METHOD /path` + JSON body),
  autocomplete for paths / query params / body fields driven by the same spec, plus
  index-name completion from the live cluster.
- FR-6.4 Request history (per cluster, persisted) and saved/named requests.
- FR-6.5 Response pane: pretty JSON, collapsible nodes, took/status, copy as cURL.

### FR-7 Safety Guardrails
- FR-7.1 Destructive operations (delete index, delete-by-query, close index, delete
  document, etc.) require a confirmation; index deletion requires typing the index name.
- FR-7.2 Per-cluster **read-only flag**: when set, all mutating requests (non-GET/HEAD,
  minus safe POST searches) are blocked client-side with a clear message. Intended for
  production clusters.
- FR-7.3 Read-only/prod state is visually loud (badge + accent color) at all times.

### FR-8 UI & Visual Design
- FR-8.1 **Modern, minimalist design language** — a purpose-built developer-tool
  aesthetic, not a generic template look. Explicitly banned: stock component-library
  defaults left unstyled, purple-gradient "AI product" styling, decorative clutter.
  Direction: flat surfaces, restrained borders, one accent color, generous data density
  with clear typographic hierarchy (think Linear / TablePlus, not Bootstrap).
- FR-8.2 **Light and dark themes**, both first-class (designed together, not one
  auto-inverted). Follows OS theme by default with a manual override toggle; choice
  persisted. Theme implemented via semantic design tokens (CSS variables) so all
  components — including Monaco editors, tables, and the shard grid — switch cleanly.
- FR-8.3 Typography: a quality UI sans for chrome + a proper monospace for JSON/console
  (bundled, offline-safe per NFR-3); tabular numerals for metric columns.
- FR-8.4 Cluster color tags, health statuses (green/yellow/red), and read-only badges
  must remain accessible (WCAG AA contrast) in **both** themes.
- FR-8.5 Keyboard-first affordances: command palette (cluster switch, API catalog
  search), consistent shortcuts, visible focus states.

## 6. Non-Functional Requirements

- **NFR-1 Performance:** UI responsive with clusters of 1000+ indices / 10k+ shards
  (virtualized tables/grids); no polling storms (single scheduler per cluster).
- **NFR-2 Security:** secrets in OS vault (FR-1.6); no telemetry; renderer process has
  no direct network/node access — all ES traffic goes through the main process over a
  typed IPC contract (`contextIsolation: true`, `nodeIntegration: false`).
- **NFR-3 Offline-friendly:** app and bundled API specs work with no internet access;
  only the clusters themselves are contacted.
- **NFR-4 OSS hygiene:** Apache 2.0 license, CONTRIBUTING.md, CI (typecheck,
  package builds for Windows + macOS + Linux). Tests planned but not yet wired up.

## 7. Technical Stack (agreed)

| Layer | Choice |
|---|---|
| Shell | Electron (electron-builder for packaging; NSIS installer for Windows, dmg/zip for macOS) |
| UI | React + TypeScript + Vite |
| Styling | Custom design system: semantic CSS-variable tokens (light/dark), hand-rolled components over Radix UI primitives (accessible, unstyled base) — no off-the-shelf themed kit |
| Editor | Monaco (console + JSON editors, custom themes matching both app themes) |
| Data/tables | Hand-rolled virtualized tables (no external table library) |
| State | Zustand (lightweight) |
| ES transport | Custom fetch-based transport in main process (version/distribution adaptive, custom TLS) |
| Secrets | Electron `safeStorage` |
| Tests | Planned: Vitest + Playwright (not yet wired up; CI runs typecheck only) |

## 8. Milestones

1. **M1 — Skeleton & connections:** Electron+React scaffold, design system + theme
   tokens (light/dark) established up front, connection manager, node discovery,
   failover, secure storage, cluster switcher. *(FR-1, FR-2 basic, FR-8 foundation)*
2. **M2 — Head parity:** cluster overview, node list, shard grid. *(FR-3)*
3. **M3 — Data & indices:** data browser, filter builder, index management. *(FR-4, FR-5)*
4. **M4 — Differentiator:** API catalog + console with spec-driven autocomplete,
   history, saved requests. *(FR-6)*
5. **M5 — Hardening & release:** guardrails polish, OpenSearch matrix testing,
   packaging/signing, docs, v1.0 on GitHub. *(FR-7, NFRs)*

## 9. Backlog (post-v1 candidates)

- API key / mTLS / Cloud ID auth providers; SSO
- Linux packaging (AppImage/deb)
- Snapshot & restore management UI
- Multi-cluster side-by-side comparison view
- cat-API quick views (`_cat/*` as sortable tables)
- Ingest pipeline tester (`_ingest/pipeline/_simulate`)
- Query profiler visualization (`"profile": true`)
- i18n
