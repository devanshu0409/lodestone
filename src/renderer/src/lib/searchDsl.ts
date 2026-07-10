/**
 * Context-aware Elasticsearch / OpenSearch query-DSL autocomplete.
 *
 * Unlike a flat keyword dump, this walks the JSON text before the cursor to
 * work out *where* you are — top-level search body, inside `query`, inside a
 * `bool` occurrence, inside a leaf query's field, inside `aggs`, etc. — and
 * offers only what's valid there. The query model is adapted from geek-fun's
 * dockit (Apache-2.0) query definitions; aggregations and the context walker
 * are our own.
 */

export type DslKind = 'query' | 'agg' | 'keyword' | 'field' | 'value'

export interface DslItem {
  label: string
  /** Text/snippet to insert (defaults to `"label"`). */
  insert: string
  /** Insert `insert` as a Monaco snippet (tab-stops with ${1:…}). */
  snippet: boolean
  detail: string
  doc?: string
  kind: DslKind
}

/* ------------------------------------------------------------------ *
 * Query definitions (name -> how to complete it)
 * ------------------------------------------------------------------ */

interface QueryDef {
  /** Snippet inserted when the query name is chosen. */
  snip: string
  doc: string
  /** Object under a `<field>` key inside this query, if it takes one. */
  fieldParams?: Record<string, string[] | null> // key -> enum values (null = free)
  /** true when the immediate child key is a field name (match/term/range/…). */
  fieldLevel?: boolean
}

const Q: Record<string, QueryDef> = {
  match: {
    snip: 'match: {\n\t"${1:field}": "${2:text}"\n}',
    doc: 'Full-text match on a single field',
    fieldLevel: true,
    fieldParams: {
      query: null,
      operator: ['or', 'and'],
      fuzziness: null,
      minimum_should_match: null,
      prefix_length: null,
      max_expansions: null,
      analyzer: null,
      zero_terms_query: ['none', 'all'],
      lenient: null,
      boost: null
    }
  },
  match_phrase: {
    snip: 'match_phrase: {\n\t"${1:field}": "${2:phrase}"\n}',
    doc: 'Match an exact phrase',
    fieldLevel: true,
    fieldParams: { query: null, slop: null, analyzer: null, boost: null }
  },
  match_phrase_prefix: {
    snip: 'match_phrase_prefix: {\n\t"${1:field}": "${2:prefix}"\n}',
    doc: 'Match a phrase whose last term is a prefix',
    fieldLevel: true,
    fieldParams: { query: null, slop: null, max_expansions: null, analyzer: null, boost: null }
  },
  multi_match: {
    snip: 'multi_match: {\n\t"query": "${1:text}",\n\t"fields": [${2:fields}]\n}',
    doc: 'Match across multiple fields'
  },
  match_all: { snip: 'match_all: {}', doc: 'Match every document' },
  match_none: { snip: 'match_none: {}', doc: 'Match no documents' },
  term: {
    snip: 'term: {\n\t"${1:field}": "${2:value}"\n}',
    doc: 'Exact term match (not analyzed)',
    fieldLevel: true,
    fieldParams: { value: null, boost: null, case_insensitive: null }
  },
  terms: {
    snip: 'terms: {\n\t"${1:field}": [${2:values}]\n}',
    doc: 'Match any of several exact terms',
    fieldLevel: true
  },
  terms_set: {
    snip: 'terms_set: {\n\t"${1:field}": {\n\t\t"terms": [${2:values}],\n\t\t"minimum_should_match_field": "${3:field}"\n\t}\n}',
    doc: 'Match a minimum number of exact terms',
    fieldLevel: true,
    fieldParams: {
      terms: null,
      minimum_should_match_field: null,
      minimum_should_match_script: null,
      boost: null
    }
  },
  range: {
    snip: 'range: {\n\t"${1:field}": {\n\t\t"gte": ${2:min},\n\t\t"lte": ${3:max}\n\t}\n}',
    doc: 'Match a range of values',
    fieldLevel: true,
    fieldParams: {
      gte: null,
      gt: null,
      lte: null,
      lt: null,
      format: null,
      time_zone: null,
      relation: ['INTERSECTS', 'CONTAINS', 'WITHIN'],
      boost: null
    }
  },
  prefix: {
    snip: 'prefix: {\n\t"${1:field}": "${2:prefix}"\n}',
    doc: 'Match terms with a given prefix',
    fieldLevel: true,
    fieldParams: { value: null, rewrite: null, case_insensitive: null, boost: null }
  },
  wildcard: {
    snip: 'wildcard: {\n\t"${1:field}": "${2:pattern*}"\n}',
    doc: 'Match terms with a wildcard pattern (* and ?)',
    fieldLevel: true,
    fieldParams: { value: null, rewrite: null, case_insensitive: null, boost: null }
  },
  regexp: {
    snip: 'regexp: {\n\t"${1:field}": "${2:regex}"\n}',
    doc: 'Match terms with a regular expression',
    fieldLevel: true,
    fieldParams: {
      value: null,
      flags: null,
      case_insensitive: null,
      max_determinized_states: null,
      rewrite: null,
      boost: null
    }
  },
  fuzzy: {
    snip: 'fuzzy: {\n\t"${1:field}": {\n\t\t"value": "${2:value}",\n\t\t"fuzziness": "${3:AUTO}"\n\t}\n}',
    doc: 'Match terms similar to the given term',
    fieldLevel: true,
    fieldParams: {
      value: null,
      fuzziness: null,
      max_expansions: null,
      prefix_length: null,
      transpositions: null,
      rewrite: null,
      boost: null
    }
  },
  ids: { snip: 'ids: {\n\t"values": [${1:ids}]\n}', doc: 'Match documents by _id' },
  exists: { snip: 'exists: {\n\t"field": "${1:field}"\n}', doc: 'Match documents where a field exists' },
  bool: {
    snip: 'bool: {\n\t"must": [\n\t\t$0\n\t]\n}',
    doc: 'Combine clauses with boolean logic'
  },
  boosting: {
    snip: 'boosting: {\n\t"positive": {$1},\n\t"negative": {$2},\n\t"negative_boost": ${3:0.5}\n}',
    doc: 'Demote (not exclude) documents matching a negative query'
  },
  constant_score: {
    snip: 'constant_score: {\n\t"filter": {$1},\n\t"boost": ${2:1.0}\n}',
    doc: 'Wrap a filter and give every match a constant score'
  },
  dis_max: {
    snip: 'dis_max: {\n\t"queries": [\n\t\t$0\n\t]\n}',
    doc: 'Best-matching of several queries wins'
  },
  function_score: {
    snip: 'function_score: {\n\t"query": {$1},\n\t"functions": [\n\t\t$0\n\t]\n}',
    doc: 'Adjust scores with functions'
  },
  nested: {
    snip: 'nested: {\n\t"path": "${1:path}",\n\t"query": {\n\t\t$0\n\t}\n}',
    doc: 'Query nested objects'
  },
  has_child: {
    snip: 'has_child: {\n\t"type": "${1:type}",\n\t"query": {\n\t\t$0\n\t}\n}',
    doc: 'Parent docs with matching children'
  },
  has_parent: {
    snip: 'has_parent: {\n\t"parent_type": "${1:type}",\n\t"query": {\n\t\t$0\n\t}\n}',
    doc: 'Child docs with matching parents'
  },
  query_string: {
    snip: 'query_string: {\n\t"query": "${1:field:value AND other}"\n}',
    doc: 'Lucene query-string syntax'
  },
  simple_query_string: {
    snip: 'simple_query_string: {\n\t"query": "${1:text}"\n}',
    doc: 'Lenient query-string syntax'
  },
  geo_distance: {
    snip: 'geo_distance: {\n\t"distance": "${1:10km}",\n\t"${2:field}": { "lat": ${3:0}, "lon": ${4:0} }\n}',
    doc: 'Geo-points within a distance'
  },
  script_score: {
    snip: 'script_score: {\n\t"query": {$1},\n\t"script": { "source": "${2:_score}" }\n}',
    doc: 'Custom scoring via script'
  },
  more_like_this: {
    snip: 'more_like_this: {\n\t"fields": [${1:fields}],\n\t"like": "${2:text}"\n}',
    doc: 'Find documents similar to text/docs'
  },
  distance_feature: {
    snip: 'distance_feature: {\n\t"field": "${1:@timestamp}",\n\t"pivot": "${2:7d}",\n\t"origin": "${3:now}"\n}',
    doc: 'Boost by proximity to a date/geo origin'
  },
  knn: {
    snip: 'knn: {\n\t"field": "${1:vector}",\n\t"query_vector": [${2:0}],\n\t"k": ${3:10},\n\t"num_candidates": ${4:100}\n}',
    doc: 'k-nearest-neighbour vector search'
  }
}

/** Object keys whose value is (an array of) query clauses. */
const QUERY_HOLDERS = new Set([
  'query',
  'filter',
  'must',
  'should',
  'must_not',
  'positive',
  'negative',
  'queries',
  'organic'
])

const BOOL_KEYS = ['must', 'should', 'must_not', 'filter', 'minimum_should_match', 'boost']

/* ------------------------------------------------------------------ *
 * Aggregations
 * ------------------------------------------------------------------ */

const AGG: Record<string, string> = {
  terms: 'terms: {\n\t"field": "${1:field}",\n\t"size": ${2:10}\n}',
  date_histogram:
    'date_histogram: {\n\t"field": "${1:@timestamp}",\n\t"calendar_interval": "${2:day}"\n}',
  histogram: 'histogram: {\n\t"field": "${1:field}",\n\t"interval": ${2:10}\n}',
  range: 'range: {\n\t"field": "${1:field}",\n\t"ranges": [ { "to": ${2:50} }, { "from": ${3:50} } ]\n}',
  date_range:
    'date_range: {\n\t"field": "${1:@timestamp}",\n\t"ranges": [ { "from": "${2:now-1d/d}" } ]\n}',
  filters: 'filters: {\n\t"filters": {\n\t\t"${1:name}": {$0}\n\t}\n}',
  filter: 'filter: {\n\t$0\n}',
  nested: 'nested: {\n\t"path": "${1:path}"\n}',
  composite: 'composite: {\n\t"sources": [\n\t\t{ "${1:name}": { "terms": { "field": "${2:field}" } } }\n\t]\n}',
  significant_terms: 'significant_terms: {\n\t"field": "${1:field}"\n}',
  avg: 'avg: {\n\t"field": "${1:field}"\n}',
  sum: 'sum: {\n\t"field": "${1:field}"\n}',
  min: 'min: {\n\t"field": "${1:field}"\n}',
  max: 'max: {\n\t"field": "${1:field}"\n}',
  stats: 'stats: {\n\t"field": "${1:field}"\n}',
  extended_stats: 'extended_stats: {\n\t"field": "${1:field}"\n}',
  cardinality: 'cardinality: {\n\t"field": "${1:field}"\n}',
  value_count: 'value_count: {\n\t"field": "${1:field}"\n}',
  percentiles: 'percentiles: {\n\t"field": "${1:field}"\n}',
  percentile_ranks: 'percentile_ranks: {\n\t"field": "${1:field}",\n\t"values": [${2:0}]\n}',
  top_hits: 'top_hits: {\n\t"size": ${1:3}\n}',
  missing: 'missing: {\n\t"field": "${1:field}"\n}',
  geo_bounds: 'geo_bounds: {\n\t"field": "${1:location}"\n}',
  geohash_grid: 'geohash_grid: {\n\t"field": "${1:location}",\n\t"precision": ${2:5}\n}'
}
const AGG_TYPES = new Set(Object.keys(AGG))
const AGG_BODY = [
  'field',
  'size',
  'order',
  'interval',
  'calendar_interval',
  'fixed_interval',
  'min_doc_count',
  'missing',
  'ranges',
  'format',
  'script',
  'percents',
  'aggs',
  'meta'
]

/* ------------------------------------------------------------------ *
 * Root search-body keywords
 * ------------------------------------------------------------------ */

const ROOT: { label: string; snip?: string; doc: string }[] = [
  { label: 'query', snip: 'query: {\n\t$0\n}', doc: 'The query to run' },
  { label: 'aggs', snip: 'aggs: {\n\t"${1:name}": {\n\t\t$0\n\t}\n}', doc: 'Aggregations' },
  { label: 'aggregations', snip: 'aggregations: {\n\t"${1:name}": {\n\t\t$0\n\t}\n}', doc: 'Aggregations' },
  { label: 'size', snip: 'size: ${1:20}', doc: 'Number of hits to return' },
  { label: 'from', snip: 'from: ${1:0}', doc: 'Offset of the first hit' },
  { label: 'sort', snip: 'sort: [\n\t{ "${1:field}": "${2:desc}" }\n]', doc: 'Sort order' },
  { label: '_source', snip: '_source: [${1:fields}]', doc: 'Which stored fields to return' },
  { label: 'highlight', snip: 'highlight: {\n\t"fields": {\n\t\t"${1:field}": {}\n\t}\n}', doc: 'Highlight matches' },
  { label: 'track_total_hits', snip: 'track_total_hits: ${1:true}', doc: 'Count all hits accurately' },
  { label: 'collapse', snip: 'collapse: {\n\t"field": "${1:field}"\n}', doc: 'Collapse hits by field' },
  { label: 'search_after', doc: 'Deep pagination cursor' },
  { label: 'post_filter', snip: 'post_filter: {\n\t$0\n}', doc: 'Filter applied after aggregations' },
  { label: 'min_score', doc: 'Minimum _score to return' },
  { label: 'fields', doc: 'Fields to return (with formatting)' },
  { label: 'runtime_mappings', doc: 'Define runtime fields' },
  { label: 'suggest', doc: 'Term/phrase/completion suggesters' },
  { label: 'explain', doc: 'Return scoring explanation' },
  { label: 'version', doc: 'Return document versions' },
  { label: 'stored_fields', doc: 'Stored fields to return' },
  { label: 'docvalue_fields', doc: 'Doc-value fields to return' },
  { label: 'timeout', doc: 'Per-shard timeout' },
  { label: 'terminate_after', doc: 'Max docs to collect per shard' }
]

const HIGHLIGHT_KEYS = [
  'fields',
  'pre_tags',
  'post_tags',
  'fragment_size',
  'number_of_fragments',
  'type',
  'require_field_match',
  'order'
]

/** value-position enum suggestions keyed by the property name being filled. */
const VALUE_ENUMS: Record<string, string[]> = {
  operator: ['or', 'and'],
  default_operator: ['OR', 'AND'],
  zero_terms_query: ['none', 'all'],
  relation: ['INTERSECTS', 'CONTAINS', 'WITHIN'],
  order: ['asc', 'desc'],
  score_mode: ['multiply', 'sum', 'avg', 'first', 'max', 'min'],
  boost_mode: ['multiply', 'replace', 'sum', 'avg', 'max', 'min'],
  type: ['best_fields', 'most_fields', 'cross_fields', 'phrase', 'phrase_prefix']
}

/* ------------------------------------------------------------------ *
 * Context analysis — walk the JSON text before the cursor
 * ------------------------------------------------------------------ */

interface Ctx {
  frameKey: string
  parentKey: string
  position: 'key' | 'value'
  currentKey: string | null
}

interface Frame {
  brace: '{' | '['
  key: string
  curKey: string | null
  expectValue: boolean
}

function analyze(src: string): Ctx {
  const stack: Frame[] = []
  let lastString: string | null = null
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '"') {
          closed = true
          j++
          break
        }
        j++
      }
      lastString = src.slice(i + 1, closed ? j - 1 : j)
      i = j
      if (!closed) break // unterminated string == the token at the cursor
      continue
    }
    const top = stack[stack.length - 1]
    if (c === ':') {
      if (top && top.brace === '{') {
        top.curKey = lastString
        top.expectValue = true
      }
      lastString = null
    } else if (c === ',') {
      if (top) {
        top.expectValue = false
        top.curKey = null
      }
      lastString = null
    } else if (c === '{' || c === '[') {
      let key = ''
      if (top) {
        if (top.brace === '{' && top.expectValue) key = top.curKey ?? ''
        else if (top.brace === '[') key = top.key // array element inherits the array's key
        top.expectValue = false
      }
      stack.push({ brace: c, key, curKey: null, expectValue: false })
      lastString = null
    } else if (c === '}' || c === ']') {
      stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.expectValue = false
        parent.curKey = null
      }
      lastString = null
    }
    i++
  }
  const top = stack[stack.length - 1]
  const frameKey = top ? top.key : ''
  const parentKey = stack.length >= 2 ? stack[stack.length - 2].key : ''
  let position: 'key' | 'value' = 'key'
  let currentKey: string | null = null
  if (top) {
    if (top.brace === '[') {
      position = 'value'
      currentKey = top.key
    } else if (top.expectValue) {
      position = 'value'
      currentKey = top.curKey
    }
  }
  return { frameKey, parentKey, position, currentKey }
}

/* ------------------------------------------------------------------ *
 * Suggestion builders
 * ------------------------------------------------------------------ */

// Snippets are authored as `name: { … }`; the completion range starts at the
// opening quote the user typed, so turn `name: { … }` into `"name": { … }`.
const quoteSnip = (name: string, snip: string): string => `"${name}"${snip.slice(name.length)}`

const kw = (label: string, doc: string, insert?: string): DslItem => ({
  label,
  insert: insert ?? `"${label}"`,
  snippet: insert !== undefined,
  detail: 'keyword',
  doc,
  kind: 'keyword'
})

const QUERY_ITEMS: DslItem[] = Object.entries(Q).map(([name, def]) => ({
  label: name,
  insert: quoteSnip(name, def.snip),
  snippet: true,
  detail: 'query',
  doc: def.doc,
  kind: 'query'
}))

const AGG_ITEMS: DslItem[] = Object.entries(AGG).map(([name, snip]) => ({
  label: name,
  insert: quoteSnip(name, snip),
  snippet: true,
  detail: 'aggregation',
  doc: 'aggregation',
  kind: 'agg'
}))

const fieldItems = (fields: string[]): DslItem[] =>
  fields.map((f) => ({
    label: f,
    insert: `"${f}"`,
    snippet: false,
    detail: 'field',
    kind: 'field' as const
  }))

const valueItems = (values: string[]): DslItem[] =>
  values.map((v) => ({
    label: v,
    insert: `"${v}"`,
    snippet: false,
    detail: 'value',
    kind: 'value' as const
  }))

/**
 * The context-aware suggestion set for a cursor sitting after `textBefore`.
 * `fields` are the mapped field names for the index in the request path.
 */
export function dslSuggest(textBefore: string, fields: string[]): DslItem[] {
  const { frameKey, parentKey, position, currentKey } = analyze(textBefore)

  // ---- value position: only a few high-value cases ----
  if (position === 'value') {
    if (currentKey && VALUE_ENUMS[currentKey]) return valueItems(VALUE_ENUMS[currentKey])
    if (
      currentKey === 'field' ||
      currentKey === 'path' ||
      currentKey === 'default_field' ||
      currentKey === 'fields' ||
      frameKey === '_source' ||
      frameKey === 'sort' ||
      frameKey === 'fields'
    ) {
      return fieldItems(fields)
    }
    return []
  }

  // ---- key position ----
  // Top of the search body.
  if (frameKey === '') {
    return ROOT.map((r) => kw(r.label, r.doc, r.snip ? quoteSnip(r.label, r.snip) : undefined))
  }

  // Inside `query` or any object/array that holds query clauses.
  if (QUERY_HOLDERS.has(frameKey)) return QUERY_ITEMS

  // Inside `bool`.
  if (frameKey === 'bool') return BOOL_KEYS.map((k) => kw(k, 'bool occurrence'))

  // A leaf query whose child key is a field name (match/term/range/…).
  if (Q[frameKey]?.fieldLevel) {
    if (frameKey === 'exists') return [kw('field', 'Field name', '"field": "${1:field}"')]
    if (frameKey === 'ids') return [kw('values', 'Document ids')]
    return fieldItems(fields)
  }

  // The params object under a `<field>` of a leaf query (range -> gte/lte, match -> query/operator…).
  if (Q[parentKey]?.fieldParams) {
    const params = Q[parentKey].fieldParams as Record<string, string[] | null>
    return Object.keys(params).map((p) => kw(p, `${parentKey} option`))
  }

  // Aggregations: `aggs` holds arbitrary names; the object under a name holds agg types.
  if (frameKey === 'aggs' || frameKey === 'aggregations') {
    return [] // the key here is a user-chosen bucket name — nothing to suggest
  }
  if (parentKey === 'aggs' || parentKey === 'aggregations') {
    return [
      ...AGG_ITEMS,
      kw('aggs', 'sub-aggregations', '"aggs": {\n\t"${1:name}": {\n\t\t$0\n\t}\n}'),
      kw('meta', 'aggregation metadata')
    ]
  }
  if (AGG_TYPES.has(frameKey)) {
    return AGG_BODY.map((b) =>
      b === 'field'
        ? kw('field', 'Field to aggregate', '"field": "${1:field}"')
        : kw(b, `${frameKey} option`)
    )
  }

  // Special objects.
  if (frameKey === '_source') return [kw('includes', 'Fields to include'), kw('excludes', 'Fields to exclude')]
  if (frameKey === 'highlight') return HIGHLIGHT_KEYS.map((k) => kw(k, 'highlight option'))
  if (frameKey === 'sort') return [...fieldItems(fields), kw('order', 'asc | desc')]

  // Fallback: offer query clauses plus field names.
  return [...QUERY_ITEMS, ...fieldItems(fields)]
}
