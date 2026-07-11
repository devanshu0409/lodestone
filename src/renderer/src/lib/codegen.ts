/**
 * Code generation from cluster metadata:
 *
 *   1. mappingToJavaSpring — an index mapping → Spring Data Elasticsearch
 *      entity (@Document POJO with @Field annotations and nested classes).
 *   2. requestToJavaRestClient — any console request → Java low-level
 *      RestClient snippet.
 *   3. requestToSpringDataSearch — a _search request → Spring Data
 *      ElasticsearchOperations snippet.
 *   4. requestToJavaApiClient — a _search request → Elasticsearch Java
 *      API Client (co.elastic.clients) snippet with withJson().
 *
 * More target languages (TypeScript, Python, Go) plug in beside the Java
 * generators — keep them pure string builders with no UI dependencies.
 */

export interface MappingProperty {
  type?: string
  properties?: Record<string, MappingProperty>
  fields?: Record<string, MappingProperty>
  format?: string
  enabled?: boolean
  scaling_factor?: number
}

export interface MappingRoot {
  properties?: Record<string, MappingProperty>
}

/* ------------------------------------------------------------------ *
 * Naming helpers
 * ------------------------------------------------------------------ */

const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'record', 'var', 'yield'
])

/** "duration_ms" / "@timestamp" / "user-name" → "durationMs" / "timestamp" / "userName" */
function camelCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return 'field'
  let name = parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('')
  if (/^\d/.test(name)) name = `f${name}`
  if (JAVA_RESERVED.has(name)) name = `${name}Field`
  return name
}

/** "logs-app" / "my_index.v2" → "LogsApp" / "MyIndexV2" */
export function pascalCase(raw: string): string {
  const c = camelCase(raw)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

/* ------------------------------------------------------------------ *
 * 1. Mapping → Spring Data Elasticsearch entity
 * ------------------------------------------------------------------ */

interface JavaType {
  java: string
  fieldType: string | null // FieldType.X, null = handled by a dedicated annotation
  imports: string[]
  comment?: string
}

function javaTypeOf(prop: MappingProperty): JavaType {
  switch (prop.type) {
    case 'text':
      return { java: 'String', fieldType: 'Text', imports: [] }
    case 'keyword':
    case 'constant_keyword':
    case 'wildcard':
      return { java: 'String', fieldType: 'Keyword', imports: [] }
    case 'long':
      return { java: 'Long', fieldType: 'Long', imports: [] }
    case 'integer':
      return { java: 'Integer', fieldType: 'Integer', imports: [] }
    case 'short':
      return { java: 'Short', fieldType: 'Short', imports: [] }
    case 'byte':
      return { java: 'Byte', fieldType: 'Byte', imports: [] }
    case 'double':
      return { java: 'Double', fieldType: 'Double', imports: [] }
    case 'float':
      return { java: 'Float', fieldType: 'Float', imports: [] }
    case 'half_float':
      return { java: 'Float', fieldType: 'Half_Float', imports: [] }
    case 'scaled_float':
      return { java: 'Double', fieldType: 'Scaled_Float', imports: [], comment: 'scaled_float — set scalingFactor on @Field' }
    case 'unsigned_long':
      return { java: 'Long', fieldType: 'Long', imports: [], comment: 'unsigned_long — watch for overflow past Long.MAX_VALUE' }
    case 'boolean':
      return { java: 'Boolean', fieldType: 'Boolean', imports: [] }
    case 'date':
    case 'date_nanos':
      return { java: 'Instant', fieldType: 'Date', imports: ['java.time.Instant'] }
    case 'ip':
      return { java: 'String', fieldType: 'Ip', imports: [] }
    case 'binary':
      return { java: 'byte[]', fieldType: 'Binary', imports: [] }
    case 'geo_point':
      return {
        java: 'GeoPoint',
        fieldType: null, // @GeoPointField
        imports: ['org.springframework.data.elasticsearch.core.geo.GeoPoint']
      }
    case 'dense_vector':
      return { java: 'float[]', fieldType: 'Dense_Vector', imports: [] }
    case 'integer_range':
      return { java: 'String', fieldType: 'Integer_Range', imports: [], comment: 'integer_range stored as string bounds' }
    case 'float_range':
      return { java: 'String', fieldType: 'Float_Range', imports: [], comment: 'float_range stored as string bounds' }
    case 'long_range':
      return { java: 'String', fieldType: 'Long_Range', imports: [], comment: 'long_range stored as string bounds' }
    case 'double_range':
      return { java: 'String', fieldType: 'Double_Range', imports: [], comment: 'double_range stored as string bounds' }
    case 'date_range':
      return { java: 'String', fieldType: 'Date_Range', imports: [], comment: 'date_range stored as string bounds' }
    case 'ip_range':
      return { java: 'String', fieldType: 'Ip_Range', imports: [], comment: 'ip_range stored as string bounds' }
    case 'flattened':
      return { java: 'Map<String, Object>', fieldType: 'Flattened', imports: ['java.util.Map'] }
    case 'percolator':
      return { java: 'String', fieldType: 'Percolator', imports: [] }
    case 'rank_feature':
      return { java: 'Integer', fieldType: 'Rank_Feature', imports: [] }
    case 'rank_features':
      return { java: 'Map<String, Integer>', fieldType: 'Rank_Features', imports: ['java.util.Map'] }
    case 'search_as_you_type':
      return { java: 'String', fieldType: 'Search_As_You_Type', imports: [] }
    case 'token_count':
      return { java: 'Integer', fieldType: 'TokenCount', imports: [] }
    case 'completion':
      return { java: 'String', fieldType: null, imports: [], comment: 'completion — use @CompletionField' }
    case 'match_only_text':
      return { java: 'String', fieldType: 'Text', imports: [], comment: 'match_only_text mapped as Text' }
    case 'annotated_text':
      return { java: 'String', fieldType: 'Text', imports: [], comment: 'annotated_text mapped as Text' }
    case 'alias':
      return { java: 'Object', fieldType: 'Alias', imports: [], comment: 'alias type — points to another field' }
    default:
      return {
        java: 'Object',
        fieldType: 'Object',
        imports: [],
        comment: `unmapped ES type "${prop.type ?? 'unknown'}"`
      }
  }
}

interface JavaField {
  decl: string[]
}

function buildClass(
  className: string,
  props: Record<string, MappingProperty>,
  imports: Set<string>,
  innerClasses: string[],
  isRoot: boolean,
  depth: number,
  indexName?: string
): string {
  const fields: JavaField[] = []
  const pad = '    '.repeat(depth)
  imports.add('lombok.Data')

  if (isRoot) {
    imports.add('org.springframework.data.annotation.Id')
    fields.push({
      decl: [`${pad}@Id`, `${pad}private String id;`]
    })
  }

  for (const [rawName, prop] of Object.entries(props)) {
    // enabled:false → the object is indexed but not searchable; map as Map
    if (prop.enabled === false && prop.properties) {
      imports.add('java.util.Map')
      const fieldName = camelCase(rawName)
      fields.push({
        decl: [`${pad}// enabled:false — mapped as Map (not searchable)`]
      })
      fields.push({
        decl: [`${pad}private Map<String, Object> ${fieldName};`]
      })
      continue
    }

    const fieldName = camelCase(rawName)

    if (prop.properties) {
      // object / nested → dedicated inner class
      const inner = pascalCase(rawName)
      const ft = prop.type === 'nested' ? 'Nested' : 'Object'
      imports.add('org.springframework.data.elasticsearch.annotations.Field')
      imports.add('org.springframework.data.elasticsearch.annotations.FieldType')
      innerClasses.push(buildClass(inner, prop.properties, imports, innerClasses, false, depth + 1))
      fields.push({
        decl: [
          `${pad}@Field(name = "${rawName}", type = FieldType.${ft})`,
          `${pad}private ${inner} ${fieldName};`
        ]
      })

      // Multi-fields (e.g. text with .keyword sub-field) → @MultiField
      if (prop.fields) {
        const subFields = Object.entries(prop.fields).filter(([, fp]) => fp.type && !fp.properties)
        if (subFields.length > 0) {
          imports.add('org.springframework.data.elasticsearch.annotations.MultiField')
          const innerFieldLines: string[] = []
          for (const [subName, subProp] of subFields) {
            const subT = javaTypeOf(subProp)
            for (const imp of subT.imports) imports.add(imp)
            if (subT.fieldType) {
              innerFieldLines.push(
                `${pad}        @InnerField(suffix = "${subName}", type = FieldType.${subT.fieldType})`
              )
            }
          }
          if (innerFieldLines.length > 0) {
            const lastDecl = fields[fields.length - 1]
            lastDecl.decl = [
              `${pad}@MultiField(`,
              `${pad}    mainField = @Field(name = "${rawName}", type = FieldType.${ft}),`,
              ...innerFieldLines,
              `${pad})`,
              `${pad}private ${inner} ${fieldName};`
            ]
          }
        }
      }
      continue
    }

    const t = javaTypeOf(prop)
    for (const imp of t.imports) imports.add(imp)
    const decl: string[] = []
    if (t.comment) decl.push(`${pad}// ${t.comment}`)
    if (t.fieldType === null) {
      imports.add('org.springframework.data.elasticsearch.annotations.GeoPointField')
      decl.push(`${pad}@GeoPointField`)
    } else {
      imports.add('org.springframework.data.elasticsearch.annotations.Field')
      imports.add('org.springframework.data.elasticsearch.annotations.FieldType')
      if (prop.type === 'scaled_float' && typeof prop.scaling_factor === 'number') {
        decl.push(`${pad}@Field(name = "${rawName}", type = FieldType.${t.fieldType}, scalingFactor = ${prop.scaling_factor})`)
      } else {
        decl.push(`${pad}@Field(name = "${rawName}", type = FieldType.${t.fieldType})`)
      }
    }
    decl.push(`${pad}private ${t.java} ${fieldName};`)
    fields.push({ decl })

    // Multi-fields on leaf fields (e.g. text with .keyword sub-field)
    if (prop.fields && !prop.properties) {
      const subFields = Object.entries(prop.fields).filter(([, fp]) => fp.type && !fp.properties)
      if (subFields.length > 0) {
        imports.add('org.springframework.data.elasticsearch.annotations.MultiField')
        const innerFieldLines: string[] = []
        for (const [subName, subProp] of subFields) {
          const subT = javaTypeOf(subProp)
          for (const imp of subT.imports) imports.add(imp)
          if (subT.fieldType) {
            innerFieldLines.push(
              `${pad}        @InnerField(suffix = "${subName}", type = FieldType.${subT.fieldType})`
            )
          }
        }
        if (innerFieldLines.length > 0) {
          const lastDecl = fields[fields.length - 1]
          const fieldTypeAnn = t.fieldType === null
            ? `${pad}@GeoPointField`
            : (prop.type === 'scaled_float' && typeof prop.scaling_factor === 'number'
                ? `${pad}@Field(name = "${rawName}", type = FieldType.${t.fieldType}, scalingFactor = ${prop.scaling_factor})`
                : `${pad}@Field(name = "${rawName}", type = FieldType.${t.fieldType})`)
          lastDecl.decl = [
            ...(t.comment ? [`${pad}// ${t.comment}`] : []),
            `${pad}@MultiField(`,
            `${pad}    mainField = ${fieldTypeAnn.trim()},`,
            ...innerFieldLines,
            `${pad})`,
            `${pad}private ${t.java} ${fieldName};`
          ]
        }
      }
    }
  }

  const head = isRoot
    ? `@Data\n@Document(indexName = "${indexName}")\npublic class ${className} {`
    : `${pad}@Data\n${pad}public static class ${className} {`
  const body = fields.map((f) => f.decl.join('\n')).join('\n\n')

  return `${head}\n\n${body}\n${pad}}`
}

/** Generate a Spring Data Elasticsearch entity from an index mapping. */
export function mappingToJavaSpring(indexName: string, mapping: MappingRoot): string {
  const props = mapping.properties ?? {}
  const className = pascalCase(indexName)
  const imports = new Set<string>(['org.springframework.data.elasticsearch.annotations.Document'])
  const innerClasses: string[] = []
  const root = buildClass(className, props, imports, innerClasses, true, 1, indexName)

  // Inner classes are collected depth-first; splice them into the root class
  // body just before its closing brace.
  const withInners =
    innerClasses.length > 0
      ? root.replace(/\n}$/, `\n\n${innerClasses.join('\n\n')}\n}`)
      : root

  const importBlock = [...imports].sort().map((i) => `import ${i};`).join('\n')

  return `// Generated by Lodestone from the "${indexName}" mapping — adjust package to taste.
package com.example.search;

${importBlock}

/**
 * Maps documents of the "${indexName}" index.
 * Spring Data Elasticsearch: https://docs.spring.io/spring-data/elasticsearch/reference/
 */
${withInners}
`
}

/* ------------------------------------------------------------------ *
 * 2 + 3. Console request → Java snippets
 * ------------------------------------------------------------------ */

/** Indent a JSON string for embedding in a Java text block. Escapes """ to prevent
 *  premature text-block termination. */
function textBlock(json: string, indent: string): string {
  const pretty = (() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2)
    } catch {
      return json
    }
  })()
  return pretty
    .replace(/"""/g, '\\"\\"\\"')
    .split('\n')
    .map((l) => indent + l)
    .join('\n')
}

/** Any request → Elasticsearch low-level RestClient (works for every endpoint). */
export function requestToJavaRestClient(method: string, path: string, body: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const lines = [
    '// Elasticsearch low-level RestClient — works for any endpoint.',
    '// import org.elasticsearch.client.Request;',
    '// import org.elasticsearch.client.Response;',
    '// import org.apache.http.util.EntityUtils;',
    '',
    `Request request = new Request("${method}", "${p}");`
  ]
  if (body.trim()) {
    lines.push('request.setJsonEntity("""', textBlock(body, '    '), '    """);')
  }
  lines.push(
    'Response response = restClient.performRequest(request);',
    'String json = EntityUtils.toString(response.getEntity());'
  )
  return lines.join('\n')
}

/** The index a search path targets, or null when it isn't a _search request. */
export function searchPathIndex(path: string): string | null {
  const m = path.trim().match(/^\/?([^/?]+)?\/?_search(\?|$)/)
  if (!m) return null
  const seg = m[1]
  return seg && !seg.startsWith('_') ? seg.split(',')[0] : null
}

/** A _search request → Spring Data ElasticsearchOperations snippet. */
export function requestToSpringDataSearch(path: string, body: string): string | null {
  const index = searchPathIndex(path)
  if (index === null && !/_search/.test(path)) return null

  let queryJson = '{ "match_all": {} }'
  let size: number | undefined
  try {
    const parsed = JSON.parse(body) as { query?: unknown; size?: number }
    if (parsed.query !== undefined) queryJson = JSON.stringify(parsed.query, null, 2)
    if (typeof parsed.size === 'number') size = parsed.size
  } catch {
    /* no/invalid body — keep match_all */
  }

  const entity = index ? pascalCase(index) : 'Document'
  const coordinates = index ? `IndexCoordinates.of("${index}")` : 'IndexCoordinates.of("my-index")'
  const lines = [
    '// Spring Data Elasticsearch — inject ElasticsearchOperations.',
    '// import org.springframework.data.elasticsearch.core.*;',
    '// import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;',
    '// import org.springframework.data.elasticsearch.core.query.StringQuery;',
    '',
    'Query query = new StringQuery("""',
    textBlock(queryJson, '    '),
    '    """);'
  ]
  if (size !== undefined) lines.push(`query.setMaxResults(${size});`)
  lines.push(
    '',
    `SearchHits<${entity}> hits = operations.search(query, ${entity}.class, ${coordinates});`,
    `hits.forEach(hit -> System.out.println(hit.getContent()));`
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 4. _search request → Elasticsearch Java API Client (co.elastic.clients)
 * ------------------------------------------------------------------ */

/** A _search request → Elasticsearch Java API Client snippet using withJson().
 *  This is the modern Spring Boot approach — the full query JSON is preserved
 *  via withJson(), so anything prototyped in the console works verbatim. */
export function requestToJavaApiClient(path: string, body: string): string | null {
  if (!/_search/.test(path)) return null
  const index = searchPathIndex(path)

  let queryJson = '{}'
  if (body.trim()) {
    try {
      queryJson = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      queryJson = body
    }
  }

  const lines = [
    '// Elasticsearch Java API Client (co.elastic.clients) — inject ElasticsearchClient.',
    '// import co.elastic.clients.elasticsearch.ElasticsearchClient;',
    '// import co.elastic.clients.elasticsearch.core.SearchResponse;',
    '// import co.elastic.clients.elasticsearch.core.search.Hit;',
    '// import java.io.StringReader;',
    '// import java.util.Map;',
    '',
    'SearchResponse<Map<String, Object>> response = client.search(s -> s'
  ]
  if (index) {
    lines.push(`    .index("${index}")`)
  }
  lines.push(
    '    .withJson(new StringReader("""',
    textBlock(queryJson, '        '),
    '        """))',
    '    , Map.class);',
    '',
    'for (Hit<Map<String, Object>> hit : response.hits().hits()) {',
    '    System.out.println(hit.source());',
    '}'
  )
  return lines.join('\n')
}
