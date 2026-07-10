import type { Distribution, HttpMethod } from '@shared/types'

/**
 * Curated, intent-searchable catalog of the Elasticsearch / OpenSearch APIs
 * people reach for day to day. This is deliberately hand-authored rather than
 * generated from the full machine spec: the value here is the *intent* mapping
 * ("insert a document", "update by query") to the right endpoint with a
 * ready-to-run template — the thing you'd otherwise leave the app to look up.
 *
 * Bundled with the app, so it works fully offline (NFR-3).
 */

export type ApiCategory =
  | 'Documents'
  | 'Search'
  | 'Indices'
  | 'Mapping'
  | 'Aliases'
  | 'Cluster'
  | 'Cat'
  | 'Reindex & update'
  | 'Templates'
  | 'Ingest'
  | 'Tasks'
  | 'Snapshot'

export interface ApiEntry {
  id: string
  name: string
  method: HttpMethod
  /** Path template; {placeholders} are highlighted and selectable in the console. */
  path: string
  summary: string
  category: ApiCategory
  /** Extra terms people might search by intent — not shown, only matched. */
  keywords: string[]
  /** Which distributions expose this API. */
  distribution: 'both' | Distribution
  /** Relative docs path appended to the distribution's docs base. */
  docPath?: { es?: string; opensearch?: string }
  /** Optional request body template inserted into the console. */
  body?: string
}

const ES_DOCS = 'https://www.elastic.co/guide/en/elasticsearch/reference/current/'
const OS_DOCS = 'https://opensearch.org/docs/latest/'

export function docUrl(entry: ApiEntry, distribution: Distribution): string | undefined {
  const p = distribution === 'opensearch' ? entry.docPath?.opensearch : entry.docPath?.es
  if (!p) return undefined
  return (distribution === 'opensearch' ? OS_DOCS : ES_DOCS) + p
}

export const API_CATALOG: ApiEntry[] = [
  // ---------- Documents ----------
  {
    id: 'doc-index',
    name: 'Index (insert/replace) a document',
    method: 'PUT',
    path: '/{index}/_doc/{id}',
    summary: 'Create or fully replace a document with a known id.',
    category: 'Documents',
    keywords: ['insert', 'add', 'create', 'put', 'upsert', 'write', 'store', 'save', 'replace'],
    distribution: 'both',
    docPath: { es: 'docs-index_.html', opensearch: 'api-reference/document-apis/index-document/' },
    body: `{
  "field": "value"
}`
  },
  {
    id: 'doc-create-auto',
    name: 'Index a document with auto-generated id',
    method: 'POST',
    path: '/{index}/_doc',
    summary: 'Create a new document and let the cluster assign the id.',
    category: 'Documents',
    keywords: ['insert', 'add', 'create', 'append', 'new document', 'auto id'],
    distribution: 'both',
    docPath: { es: 'docs-index_.html' },
    body: `{
  "field": "value"
}`
  },
  {
    id: 'doc-get',
    name: 'Get a document by id',
    method: 'GET',
    path: '/{index}/_doc/{id}',
    summary: 'Retrieve a single document, including its _source.',
    category: 'Documents',
    keywords: ['read', 'fetch', 'lookup', 'retrieve', 'by id'],
    distribution: 'both',
    docPath: { es: 'docs-get.html' }
  },
  {
    id: 'doc-update',
    name: 'Update a document (partial)',
    method: 'POST',
    path: '/{index}/_update/{id}',
    summary: 'Partially update a document, or run a script against it.',
    category: 'Documents',
    keywords: ['modify', 'change', 'edit', 'partial', 'patch', 'script', 'increment'],
    distribution: 'both',
    docPath: { es: 'docs-update.html', opensearch: 'api-reference/document-apis/update-document/' },
    body: `{
  "doc": {
    "field": "new value"
  }
}`
  },
  {
    id: 'doc-delete',
    name: 'Delete a document by id',
    method: 'DELETE',
    path: '/{index}/_doc/{id}',
    summary: 'Remove a single document.',
    category: 'Documents',
    keywords: ['remove', 'drop', 'erase'],
    distribution: 'both',
    docPath: { es: 'docs-delete.html' }
  },
  {
    id: 'doc-bulk',
    name: 'Bulk index / update / delete',
    method: 'POST',
    path: '/_bulk',
    summary: 'Perform many document operations in one request (NDJSON body).',
    category: 'Documents',
    keywords: ['batch', 'many', 'import', 'load', 'ingest', 'ndjson', 'mass'],
    distribution: 'both',
    docPath: { es: 'docs-bulk.html', opensearch: 'api-reference/document-apis/bulk/' },
    // NDJSON: each action line is followed by its source line (except delete).
    // The trailing newline is required by the _bulk API.
    body: `{ "index":  { "_index": "my-index", "_id": "1" } }
{ "field": "value" }
{ "create": { "_index": "my-index", "_id": "2" } }
{ "field": "value" }
{ "update": { "_index": "my-index", "_id": "1" } }
{ "doc": { "field": "new value" } }
{ "delete": { "_index": "my-index", "_id": "3" } }
`
  },
  {
    id: 'doc-mget',
    name: 'Get multiple documents (mget)',
    method: 'POST',
    path: '/_mget',
    summary: 'Fetch many documents by id in one round trip.',
    category: 'Documents',
    keywords: ['multi get', 'several', 'batch read'],
    distribution: 'both',
    docPath: { es: 'docs-multi-get.html' },
    body: `{
  "docs": [
    { "_index": "my-index", "_id": "1" },
    { "_index": "my-index", "_id": "2" }
  ]
}`
  },

  // ---------- Search ----------
  {
    id: 'search',
    name: 'Search with a query',
    method: 'POST',
    path: '/{index}/_search',
    summary: 'Run a query and return matching documents.',
    category: 'Search',
    keywords: ['query', 'find', 'match', 'filter', 'lookup', 'dsl', 'bool'],
    distribution: 'both',
    docPath: { es: 'search-search.html', opensearch: 'api-reference/search/' },
    body: `{
  "query": {
    "match": {
      "field": "value"
    }
  },
  "size": 20
}`
  },
  {
    id: 'search-all',
    name: 'Match all documents',
    method: 'POST',
    path: '/{index}/_search',
    summary: 'Return documents without filtering — useful to peek at data.',
    category: 'Search',
    keywords: ['everything', 'browse', 'sample', 'match_all', 'all docs'],
    distribution: 'both',
    body: `{
  "query": { "match_all": {} },
  "size": 20
}`
  },
  {
    id: 'count',
    name: 'Count matching documents',
    method: 'POST',
    path: '/{index}/_count',
    summary: 'Return just the number of documents matching a query.',
    category: 'Search',
    keywords: ['how many', 'total', 'number of', 'size'],
    distribution: 'both',
    docPath: { es: 'search-count.html' },
    body: `{
  "query": { "match_all": {} }
}`
  },
  {
    id: 'search-agg',
    name: 'Aggregate (group / stats)',
    method: 'POST',
    path: '/{index}/_search',
    summary: 'Bucket and compute metrics over your data with aggregations.',
    category: 'Search',
    keywords: ['aggregation', 'group by', 'stats', 'terms', 'histogram', 'sum', 'avg', 'facet'],
    distribution: 'both',
    docPath: { es: 'search-aggregations.html' },
    body: `{
  "size": 0,
  "aggs": {
    "by_field": {
      "terms": { "field": "field.keyword", "size": 10 }
    }
  }
}`
  },
  {
    id: 'explain-doc',
    name: 'Explain why a document matched',
    method: 'POST',
    path: '/{index}/_explain/{id}',
    summary: 'Return the scoring calculation for one document against a query.',
    category: 'Search',
    keywords: ['score', 'relevance', 'why matched', 'debug query'],
    distribution: 'both',
    docPath: { es: 'search-explain.html' },
    body: `{
  "query": { "match": { "field": "value" } }
}`
  },
  {
    id: 'validate-query',
    name: 'Validate a query',
    method: 'POST',
    path: '/{index}/_validate/query?explain=true',
    summary: 'Check whether a query is valid without running it.',
    category: 'Search',
    keywords: ['syntax', 'check query', 'is valid'],
    distribution: 'both',
    docPath: { es: 'search-validate.html' },
    body: `{
  "query": { "match": { "field": "value" } }
}`
  },
  {
    id: 'field-caps',
    name: 'Field capabilities',
    method: 'GET',
    path: '/{index}/_field_caps?fields=*',
    summary: 'List fields and their types/searchability across indices.',
    category: 'Search',
    keywords: ['fields', 'types', 'what fields', 'capabilities'],
    distribution: 'both',
    docPath: { es: 'search-field-caps.html' }
  },

  // ---------- Reindex & update ----------
  {
    id: 'update-by-query',
    name: 'Update by query',
    method: 'POST',
    path: '/{index}/_update_by_query',
    summary: 'Update every document matching a query, optionally with a script.',
    category: 'Reindex & update',
    keywords: ['bulk update', 'mass update', 'script update', 'modify many', 'change all'],
    distribution: 'both',
    docPath: { es: 'docs-update-by-query.html', opensearch: 'api-reference/document-apis/update-by-query/' },
    body: `{
  "query": { "term": { "status": "old" } },
  "script": {
    "source": "ctx._source.status = 'new'"
  }
}`
  },
  {
    id: 'delete-by-query',
    name: 'Delete by query',
    method: 'POST',
    path: '/{index}/_delete_by_query',
    summary: 'Delete every document matching a query.',
    category: 'Reindex & update',
    keywords: ['bulk delete', 'mass delete', 'remove many', 'purge', 'clean up'],
    distribution: 'both',
    docPath: { es: 'docs-delete-by-query.html' },
    body: `{
  "query": {
    "range": { "@timestamp": { "lt": "now-30d" } }
  }
}`
  },
  {
    id: 'reindex',
    name: 'Reindex into another index',
    method: 'POST',
    path: '/_reindex',
    summary: 'Copy documents from one index to another, optionally transforming them.',
    category: 'Reindex & update',
    keywords: ['copy', 'migrate', 'move data', 'clone data', 'transform'],
    distribution: 'both',
    docPath: { es: 'docs-reindex.html', opensearch: 'api-reference/document-apis/reindex/' },
    body: `{
  "source": { "index": "source-index" },
  "dest":   { "index": "dest-index" }
}`
  },

  // ---------- Indices ----------
  {
    id: 'index-create',
    name: 'Create an index',
    method: 'PUT',
    path: '/{index}',
    summary: 'Create an index with settings and mappings.',
    category: 'Indices',
    keywords: ['new index', 'make index', 'define'],
    distribution: 'both',
    docPath: { es: 'indices-create-index.html', opensearch: 'api-reference/index-apis/create-index/' },
    body: `{
  "settings": { "number_of_shards": 1, "number_of_replicas": 1 },
  "mappings": { "properties": { } }
}`
  },
  {
    id: 'index-delete',
    name: 'Delete an index',
    method: 'DELETE',
    path: '/{index}',
    summary: 'Permanently delete an index and its data.',
    category: 'Indices',
    keywords: ['drop index', 'remove index'],
    distribution: 'both',
    docPath: { es: 'indices-delete-index.html' }
  },
  {
    id: 'index-exists',
    name: 'Check if an index exists',
    method: 'HEAD',
    path: '/{index}',
    summary: 'Returns 200 if the index exists, 404 otherwise.',
    category: 'Indices',
    keywords: ['exists', 'is there'],
    distribution: 'both'
  },
  {
    id: 'index-get',
    name: 'Get index (settings + mappings + aliases)',
    method: 'GET',
    path: '/{index}',
    summary: 'Return everything defining an index.',
    category: 'Indices',
    keywords: ['describe index', 'show index', 'definition'],
    distribution: 'both',
    docPath: { es: 'indices-get-index.html' }
  },
  {
    id: 'index-settings-get',
    name: 'Get index settings',
    method: 'GET',
    path: '/{index}/_settings',
    summary: 'Return the settings for an index.',
    category: 'Indices',
    keywords: ['show settings', 'replicas', 'refresh interval'],
    distribution: 'both',
    docPath: { es: 'indices-get-settings.html' }
  },
  {
    id: 'index-settings-put',
    name: 'Update index settings',
    method: 'PUT',
    path: '/{index}/_settings',
    summary: 'Change dynamic settings such as replica count or refresh interval.',
    category: 'Indices',
    keywords: ['change settings', 'set replicas', 'refresh interval'],
    distribution: 'both',
    docPath: { es: 'indices-update-settings.html' },
    body: `{
  "index": {
    "number_of_replicas": 1,
    "refresh_interval": "1s"
  }
}`
  },
  {
    id: 'index-open',
    name: 'Open an index',
    method: 'POST',
    path: '/{index}/_open',
    summary: 'Reopen a closed index so it can serve requests.',
    category: 'Indices',
    keywords: ['reopen', 'enable'],
    distribution: 'both',
    docPath: { es: 'indices-open-close.html' }
  },
  {
    id: 'index-close',
    name: 'Close an index',
    method: 'POST',
    path: '/{index}/_close',
    summary: 'Close an index to free resources; it can’t be searched while closed.',
    category: 'Indices',
    keywords: ['disable', 'take offline'],
    distribution: 'both',
    docPath: { es: 'indices-open-close.html' }
  },
  {
    id: 'index-refresh',
    name: 'Refresh an index',
    method: 'POST',
    path: '/{index}/_refresh',
    summary: 'Make recent changes searchable immediately.',
    category: 'Indices',
    keywords: ['make searchable', 'flush changes'],
    distribution: 'both',
    docPath: { es: 'indices-refresh.html' }
  },
  {
    id: 'index-forcemerge',
    name: 'Force-merge an index',
    method: 'POST',
    path: '/{index}/_forcemerge?max_num_segments=1',
    summary: 'Merge segments to reduce their number (use on read-only indices).',
    category: 'Indices',
    keywords: ['optimize', 'merge segments', 'compact'],
    distribution: 'both',
    docPath: { es: 'indices-forcemerge.html' }
  },
  {
    id: 'index-stats',
    name: 'Index stats',
    method: 'GET',
    path: '/{index}/_stats',
    summary: 'Return document counts, store size, and operation stats.',
    category: 'Indices',
    keywords: ['size', 'docs count', 'metrics'],
    distribution: 'both',
    docPath: { es: 'indices-stats.html' }
  },

  // ---------- Mapping ----------
  {
    id: 'mapping-get',
    name: 'Get mappings',
    method: 'GET',
    path: '/{index}/_mapping',
    summary: 'Return the field mappings for an index.',
    category: 'Mapping',
    keywords: ['fields', 'schema', 'types', 'show mapping'],
    distribution: 'both',
    docPath: { es: 'indices-get-mapping.html' }
  },
  {
    id: 'mapping-put',
    name: 'Add fields to a mapping',
    method: 'PUT',
    path: '/{index}/_mapping',
    summary: 'Add new fields to an existing index mapping.',
    category: 'Mapping',
    keywords: ['add field', 'new field', 'schema change', 'update mapping'],
    distribution: 'both',
    docPath: { es: 'indices-put-mapping.html' },
    body: `{
  "properties": {
    "new_field": { "type": "keyword" }
  }
}`
  },
  {
    id: 'analyze',
    name: 'Analyze text',
    method: 'POST',
    path: '/{index}/_analyze',
    summary: 'See how an analyzer tokenizes text — great for debugging search.',
    category: 'Mapping',
    keywords: ['tokenize', 'analyzer', 'tokens', 'why no match'],
    distribution: 'both',
    docPath: { es: 'indices-analyze.html' },
    body: `{
  "analyzer": "standard",
  "text": "The quick brown fox"
}`
  },

  // ---------- Aliases ----------
  {
    id: 'aliases-update',
    name: 'Add / remove aliases (atomic)',
    method: 'POST',
    path: '/_aliases',
    summary: 'Atomically add and remove aliases — the safe way to swap indices.',
    category: 'Aliases',
    keywords: ['alias', 'swap', 'switch index', 'zero downtime', 'rollover pointer'],
    distribution: 'both',
    docPath: { es: 'indices-aliases.html', opensearch: 'api-reference/index-apis/alias/' },
    body: `{
  "actions": [
    { "remove": { "index": "old-index", "alias": "my-alias" } },
    { "add":    { "index": "new-index", "alias": "my-alias" } }
  ]
}`
  },
  {
    id: 'aliases-get',
    name: 'List aliases',
    method: 'GET',
    path: '/_alias',
    summary: 'Show all aliases and the indices behind them.',
    category: 'Aliases',
    keywords: ['show aliases', 'what aliases'],
    distribution: 'both',
    docPath: { es: 'indices-get-alias.html' }
  },

  // ---------- Cluster ----------
  {
    id: 'cluster-health',
    name: 'Cluster health',
    method: 'GET',
    path: '/_cluster/health',
    summary: 'Green/yellow/red status, node and shard counts.',
    category: 'Cluster',
    keywords: ['status', 'green yellow red', 'is it healthy'],
    distribution: 'both',
    docPath: { es: 'cluster-health.html', opensearch: 'api-reference/cluster-api/cluster-health/' }
  },
  {
    id: 'cluster-state',
    name: 'Cluster state',
    method: 'GET',
    path: '/_cluster/state',
    summary: 'The full internal cluster state (large).',
    category: 'Cluster',
    keywords: ['metadata', 'routing table', 'internal state'],
    distribution: 'both',
    docPath: { es: 'cluster-state.html' }
  },
  {
    id: 'cluster-stats',
    name: 'Cluster stats',
    method: 'GET',
    path: '/_cluster/stats',
    summary: 'Cluster-wide index and node statistics.',
    category: 'Cluster',
    keywords: ['metrics', 'totals', 'summary'],
    distribution: 'both',
    docPath: { es: 'cluster-stats.html' }
  },
  {
    id: 'cluster-settings-get',
    name: 'Get cluster settings',
    method: 'GET',
    path: '/_cluster/settings?include_defaults=true&flat_settings=true',
    summary: 'Persistent, transient and default cluster settings.',
    category: 'Cluster',
    keywords: ['show settings', 'watermark', 'allocation settings'],
    distribution: 'both',
    docPath: { es: 'cluster-get-settings.html' }
  },
  {
    id: 'cluster-settings-put',
    name: 'Update cluster settings',
    method: 'PUT',
    path: '/_cluster/settings',
    summary: 'Change persistent or transient cluster-wide settings.',
    category: 'Cluster',
    keywords: ['change settings', 'disk watermark', 'allocation', 'rebalance'],
    distribution: 'both',
    docPath: { es: 'cluster-update-settings.html' },
    body: `{
  "persistent": {
    "cluster.routing.allocation.enable": "all"
  }
}`
  },
  {
    id: 'allocation-explain',
    name: 'Explain shard allocation',
    method: 'POST',
    path: '/_cluster/allocation/explain',
    summary: 'Why is a shard unassigned or not moving? This tells you.',
    category: 'Cluster',
    keywords: ['unassigned shard', 'why red', 'why yellow', 'allocation problem'],
    distribution: 'both',
    docPath: { es: 'cluster-allocation-explain.html' },
    body: `{
  "index": "my-index",
  "shard": 0,
  "primary": false
}`
  },
  {
    id: 'pending-tasks',
    name: 'Pending cluster tasks',
    method: 'GET',
    path: '/_cluster/pending_tasks',
    summary: 'Tasks queued on the master, with wait times.',
    category: 'Cluster',
    keywords: ['queue', 'stuck', 'master tasks'],
    distribution: 'both',
    docPath: { es: 'cluster-pending.html' }
  },

  // ---------- Cat ----------
  {
    id: 'cat-indices',
    name: '_cat indices',
    method: 'GET',
    path: '/_cat/indices?v&s=index',
    summary: 'Human-readable table of indices.',
    category: 'Cat',
    keywords: ['list indices', 'table', 'overview'],
    distribution: 'both',
    docPath: { es: 'cat-indices.html' }
  },
  {
    id: 'cat-nodes',
    name: '_cat nodes',
    method: 'GET',
    path: '/_cat/nodes?v&h=name,node.role,master,heap.percent,ram.percent,cpu,disk.used_percent',
    summary: 'Human-readable table of nodes and their load.',
    category: 'Cat',
    keywords: ['list nodes', 'load', 'heap', 'cpu'],
    distribution: 'both',
    docPath: { es: 'cat-nodes.html' }
  },
  {
    id: 'cat-shards',
    name: '_cat shards',
    method: 'GET',
    path: '/_cat/shards?v&s=index',
    summary: 'Human-readable table of shard placement and state.',
    category: 'Cat',
    keywords: ['list shards', 'placement', 'unassigned'],
    distribution: 'both',
    docPath: { es: 'cat-shards.html' }
  },
  {
    id: 'cat-aliases',
    name: '_cat aliases',
    method: 'GET',
    path: '/_cat/aliases?v',
    summary: 'Human-readable table of aliases.',
    category: 'Cat',
    keywords: ['list aliases'],
    distribution: 'both',
    docPath: { es: 'cat-alias.html' }
  },
  {
    id: 'cat-thread-pool',
    name: '_cat thread pool',
    method: 'GET',
    path: '/_cat/thread_pool?v&h=node_name,name,active,queue,rejected',
    summary: 'Thread pool activity — spot write/search rejections.',
    category: 'Cat',
    keywords: ['rejections', 'queue', 'threads', 'bottleneck'],
    distribution: 'both',
    docPath: { es: 'cat-thread-pool.html' }
  },

  // ---------- Templates ----------
  {
    id: 'index-template-put',
    name: 'Create an index template',
    method: 'PUT',
    path: '/_index_template/{name}',
    summary: 'Apply settings/mappings automatically to new matching indices.',
    category: 'Templates',
    keywords: ['template', 'auto mapping', 'pattern', 'new indices'],
    distribution: 'both',
    docPath: { es: 'indices-put-template.html' },
    body: `{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": { "number_of_shards": 1 },
    "mappings": { "properties": { "@timestamp": { "type": "date" } } }
  }
}`
  },
  {
    id: 'index-template-get',
    name: 'List index templates',
    method: 'GET',
    path: '/_index_template',
    summary: 'Show composable index templates.',
    category: 'Templates',
    keywords: ['show templates'],
    distribution: 'both',
    docPath: { es: 'indices-get-template.html' }
  },

  // ---------- Ingest ----------
  {
    id: 'ingest-pipeline-put',
    name: 'Create an ingest pipeline',
    method: 'PUT',
    path: '/_ingest/pipeline/{name}',
    summary: 'Define processors that transform documents at index time.',
    category: 'Ingest',
    keywords: ['pipeline', 'transform', 'enrich', 'processor', 'grok'],
    distribution: 'both',
    docPath: { es: 'put-pipeline-api.html' },
    body: `{
  "description": "my pipeline",
  "processors": [
    { "set": { "field": "ingested_at", "value": "{{_ingest.timestamp}}" } }
  ]
}`
  },
  {
    id: 'ingest-simulate',
    name: 'Simulate an ingest pipeline',
    method: 'POST',
    path: '/_ingest/pipeline/_simulate',
    summary: 'Test a pipeline against sample documents before using it.',
    category: 'Ingest',
    keywords: ['test pipeline', 'try', 'dry run'],
    distribution: 'both',
    docPath: { es: 'simulate-pipeline-api.html' },
    body: `{
  "pipeline": {
    "processors": [ { "uppercase": { "field": "name" } } ]
  },
  "docs": [ { "_source": { "name": "value" } } ]
}`
  },

  // ---------- Tasks ----------
  {
    id: 'tasks-list',
    name: 'List running tasks',
    method: 'GET',
    path: '/_tasks?detailed=true&group_by=parents',
    summary: 'See running tasks (reindex, update-by-query, etc.).',
    category: 'Tasks',
    keywords: ['running', 'progress', 'long running', 'reindex progress'],
    distribution: 'both',
    docPath: { es: 'tasks.html' }
  },
  {
    id: 'task-cancel',
    name: 'Cancel a task',
    method: 'POST',
    path: '/_tasks/{task_id}/_cancel',
    summary: 'Cancel a long-running task by id.',
    category: 'Tasks',
    keywords: ['stop', 'kill', 'abort'],
    distribution: 'both',
    docPath: { es: 'tasks.html' }
  },

  // ---------- Snapshot ----------
  {
    id: 'snapshot-repos',
    name: 'List snapshot repositories',
    method: 'GET',
    path: '/_snapshot',
    summary: 'Show registered snapshot repositories.',
    category: 'Snapshot',
    keywords: ['backup', 'repository', 'restore'],
    distribution: 'both',
    docPath: { es: 'get-snapshot-repo-api.html' }
  },
  {
    id: 'snapshot-create',
    name: 'Take a snapshot',
    method: 'PUT',
    path: '/_snapshot/{repository}/{snapshot}?wait_for_completion=false',
    summary: 'Create a snapshot (backup) of indices into a repository.',
    category: 'Snapshot',
    keywords: ['backup', 'save', 'export'],
    distribution: 'both',
    docPath: { es: 'create-snapshot-api.html' },
    body: `{
  "indices": "*",
  "include_global_state": false
}`
  }
]

const CATEGORY_ORDER: ApiCategory[] = [
  'Documents',
  'Search',
  'Reindex & update',
  'Indices',
  'Mapping',
  'Aliases',
  'Cluster',
  'Cat',
  'Templates',
  'Ingest',
  'Tasks',
  'Snapshot'
]

export const CATEGORIES = CATEGORY_ORDER

/**
 * Intent-ranked search. Matches on name, summary, keywords, path and method.
 * Name/keyword hits weigh more than incidental summary matches so that
 * searching "update by query" surfaces the right entry first.
 */
export function searchCatalog(query: string, distribution: Distribution): ApiEntry[] {
  const available = API_CATALOG.filter(
    (e) => e.distribution === 'both' || e.distribution === distribution
  )
  const q = query.trim().toLowerCase()
  if (!q) return available

  const terms = q.split(/\s+/)
  const scored = available
    .map((entry) => {
      const name = entry.name.toLowerCase()
      const keywords = entry.keywords.join(' ').toLowerCase()
      const path = entry.path.toLowerCase()
      const summary = entry.summary.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (name.includes(t)) score += 6
        if (keywords.includes(t)) score += 5
        if (path.includes(t)) score += 3
        if (entry.method.toLowerCase() === t) score += 3
        if (summary.includes(t)) score += 1
      }
      // Reward matching the whole phrase in the name.
      if (name.includes(q)) score += 4
      return { entry, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.map((s) => s.entry)
}
